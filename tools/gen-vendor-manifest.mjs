#!/usr/bin/env node
// tools/gen-vendor-manifest.mjs — VENDOR-MANIFEST.json: the update contract
// for downstreams that vendor Observogram's pure libraries.
//
// A downstream distribution copies selected tools/lib modules verbatim and
// upgrades by re-copying them. This script lists which modules it may copy
// (the pure, DOM-free, node-free ones whose import graph stays inside
// tools/lib), with each module's sha256, byte size, exported symbols,
// intra-set imports and npm dependencies, plus the package version the
// snapshot belongs to. tools/test-vendor-manifest.mjs fails when the
// committed manifest is stale or when a listed module's exports change
// without a `## Unreleased` CHANGELOG entry naming it — that entry is the
// downstream breaking-change notice. docs/DOWNSTREAM.md is the workflow.
//
//   node tools/gen-vendor-manifest.mjs                  print the manifest
//   node tools/gen-vendor-manifest.mjs --write          rewrite VENDOR-MANIFEST.json
//   node tools/gen-vendor-manifest.mjs --check          exit 1 when the committed file is stale
//   node tools/gen-vendor-manifest.mjs --verify <dir>   hash a vendored copy against its manifest
//   node tools/gen-vendor-manifest.mjs --smoke <dir>    import each vendored module, compare exports
//
// This file imports nothing from tools/lib on purpose: a downstream copies it
// next to the manifest and runs --verify / --smoke on its own tree.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MANIFEST_FILE = 'VENDOR-MANIFEST.json';
export const MANIFEST_VERSION = 1;
export const DEFAULT_ROOT = 'tools/lib';

/** Modules under tools/lib that are not vendorable, path → why. Authoritative: every .mjs under the root is listed XOR here. */
export const EXCLUDED = Object.freeze({
  'tools/lib/journey.mjs': 'node:fs/path/url imports, import-time schema read, imports ../../studio/diagnostic-grade.mjs and ../../studio/verify-deploy.mjs, dynamic import of ../fetch-live-pack.mjs; the server-side journey runner, the documented browser-safety exception',
  'tools/lib/brand-env.mjs': 'node:fs/path imports and process.env reads; server-side brand/env resolution, not a library',
  'tools/lib/grafana-mcp-bridge.mjs': 'node:http server and network fetch at call time; a bridge process, not a library',
  'tools/lib/harness.mjs': 'process.stdout/process.exit; the repo\'s own test harness, not product code',
  'tools/lib/retrofeed.mjs': 'imports ../../studio/verify-deploy.mjs — its import graph leaves tools/lib',
});

// ---------------------------------------------------------------------------
// Tokenizer. Comments, string bodies, template text and regex bodies are not
// code: an `export` or `window.` inside them means nothing, and a `/*` inside
// a `//` comment or a template literal must not swallow real code (both occur
// in tools/lib/compile.mjs). The scanner walks the source once and blanks
// every non-code character to a space, keeping newlines so line numbers hold
// and keeping string delimiters so `x['k']` still reads as a bracket access.
// Template `${ … }` expressions are code and stay.
// ---------------------------------------------------------------------------

const REGEX_PREV_CHARS = new Set('(,=:[!&|?{};+-*%<>~^}'.split(''));
const REGEX_PREV_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'instanceof', 'new', 'delete', 'void', 'throw', 'else', 'do', 'yield', 'await']);

/** { code, strings } — code: the source with non-code blanked; strings: every string literal [{ start, end, value }] (end exclusive, delimiters included). */
export function tokenize(src) {
  const s = String(src);
  const n = s.length;
  const out = s.split('');
  const strings = [];
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };

  const regexAllowedAt = (i) => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(out[j])) j--;
    if (j < 0) return true;
    const ch = out[j];
    if (REGEX_PREV_CHARS.has(ch)) return true;
    if (/[A-Za-z_$0-9]/.test(ch)) {
      let k = j;
      while (k >= 0 && /[A-Za-z_$0-9]/.test(out[k])) k--;
      return REGEX_PREV_WORDS.has(s.slice(k + 1, j + 1));
    }
    return false;
  };

  const scanString = (i, quote) => {
    const start = i;
    i++;
    while (i < n && s[i] !== quote && s[i] !== '\n') { if (s[i] === '\\') i++; i++; }
    const end = Math.min(n, i + 1);
    blank(start + 1, Math.min(i, n));
    strings.push({ start, end, value: s.slice(start + 1, Math.min(i, n)) });
    return end;
  };

  const scanRegex = (i) => {
    const start = i;
    i++;
    let inClass = false;
    while (i < n && s[i] !== '\n') {
      const c = s[i];
      if (c === '\\') { i += 2; continue; }
      if (inClass) { if (c === ']') inClass = false; }
      else if (c === '[') inClass = true;
      else if (c === '/') break;
      i++;
    }
    i++;
    while (i < n && /[a-z]/.test(s[i])) i++;
    blank(start, Math.min(i, n));
    return i;
  };

  const scanTemplate = (i) => {
    let k = i + 1;
    let segStart = k;
    while (k < n) {
      const c = s[k];
      if (c === '\\') { k += 2; continue; }
      if (c === '`') { blank(segStart, k); return k + 1; }
      if (c === '$' && s[k + 1] === '{') {
        blank(segStart, k + 2);
        k = scanCode(k + 2, true);
        segStart = k;
        continue;
      }
      k++;
    }
    blank(segStart, n);
    return n;
  };

  // Walks code; with untilBrace it returns the index just past the `}` that closes a template expression.
  const scanCode = (i, untilBrace) => {
    let depth = 0;
    while (i < n) {
      const c = s[i];
      if (c === '/' && s[i + 1] === '/') { let k = s.indexOf('\n', i); if (k < 0) k = n; blank(i, k); i = k; continue; }
      if (c === '/' && s[i + 1] === '*') { let k = s.indexOf('*/', i + 2); k = k < 0 ? n : k + 2; blank(i, k); i = k; continue; }
      if (c === '\'' || c === '"') { i = scanString(i, c); continue; }
      if (c === '`') { i = scanTemplate(i); continue; }
      if (c === '/' && regexAllowedAt(i)) { i = scanRegex(i); continue; }
      if (untilBrace) {
        if (c === '{') depth++;
        else if (c === '}') { if (depth === 0) { out[i] = ' '; return i + 1; } depth--; }
      }
      i++;
    }
    return n;
  };

  scanCode(0, false);
  return { code: out.join(''), strings };
}

export const lineOf = (src, index) => String(src).slice(0, index).split('\n').length;

/** Every import specifier in the module: static `import … from`, `export … from`, side-effect `import 'x'`, dynamic `import('x')`. [{ spec, index }] */
export function importSpecifiers(src) {
  const { code, strings } = tokenize(src);
  const out = [];
  for (const st of strings) {
    const before = code.slice(Math.max(0, st.start - 64), st.start).replace(/\s+$/, '');
    if (/\bfrom$/.test(before) || /\bimport\s*\($/.test(before) || /(?:^|[\n;])\s*import$/.test(before)) {
      out.push({ spec: st.value, index: st.start });
    }
  }
  return out;
}

/** Relative specifiers (`./x.mjs`, `../y.mjs`), as written. */
export const relativeImports = (src) => importSpecifiers(src).map(s => s.spec).filter(s => s.startsWith('.'));
/** Everything else: bare package specifiers and `node:` modules. */
export const bareImports = (src) => importSpecifiers(src).map(s => s.spec).filter(s => !s.startsWith('.'));

const UNSUPPORTED_EXPORT = /^[ \t]*export\s+(default\b|\*)/m;
const EXPORT_DECL = /^[ \t]*export\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s*([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST = /^[ \t]*export\s*\{([^}]*)\}/gm;

/** The module's exported names, from the source text alone, code-point sorted. Throws on export forms the extractor does not read. */
export function staticExports(src, file = '<source>') {
  const { code } = tokenize(src);
  const bad = UNSUPPORTED_EXPORT.exec(code);
  if (bad) throw new Error(`${file}:${lineOf(code, bad.index)}: export form not supported by the manifest extractor (export default / export *) — extend staticExports deliberately`);
  const names = new Set();
  for (const m of code.matchAll(EXPORT_DECL)) names.add(m[1]);
  for (const m of code.matchAll(EXPORT_LIST)) {
    for (const part of m[1].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const as = p.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// Purity. A vendorable module runs anywhere a browser or a bare Node would
// run it: no node:* module, no process, no DOM, no import.meta, no require.
// Rules of kind `specifier` see import specifiers; rules of kind `code` see
// the tokenized code (never a comment or a string body).
// ---------------------------------------------------------------------------

export const PURITY_RULES = Object.freeze([
  { rule: 'import a node:* module', kind: 'specifier', re: /^node:/ },
  { rule: 'read `process`', kind: 'code', re: /\bprocess\s*(?:\.\s*[A-Za-z_$]|\[\s*['"])/ },
  { rule: 'touch the DOM or web storage (document, window, navigator, localStorage, sessionStorage)', kind: 'code', re: /\b(?:document|window|navigator|localStorage|sessionStorage)\s*(?:\.\s*[A-Za-z_$]|\[\s*['"])/ },
  { rule: 'read `import.meta`', kind: 'code', re: /\bimport\s*\.\s*meta\b/ },
  { rule: 'call `require()`', kind: 'code', re: /\brequire\s*\(/ },
]);

/** [{ line, rule }] — every purity rule the source breaks. */
export function purityViolations(src) {
  const out = [];
  const { code } = tokenize(src);
  for (const r of PURITY_RULES) {
    if (r.kind === 'specifier') {
      for (const s of importSpecifiers(src)) if (r.re.test(s.spec)) out.push({ line: lineOf(src, s.index), rule: r.rule });
    } else {
      const m = r.re.exec(code);
      if (m) out.push({ line: lineOf(code, m.index), rule: r.rule });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------
// The tree and the manifest.
// ---------------------------------------------------------------------------

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const posix = (p) => p.split(path.sep).join('/');

/** Every file under <repoRoot>/<root>, repo-relative POSIX paths, sorted: { modules: ['tools/lib/x.mjs', …], data: [other files] }. */
export function walkModules(repoRoot, root = DEFAULT_ROOT) {
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else files.push(posix(path.relative(repoRoot, p)));
    }
  };
  walk(path.join(repoRoot, ...root.split('/')));
  files.sort();
  return { modules: files.filter(f => f.endsWith('.mjs')), data: files.filter(f => !f.endsWith('.mjs')) };
}

const resolveSpec = (fromFile, spec) => posix(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec)));

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The manifest document. Reads the tree under <repoRoot>/<root>; `previous` is the committed manifest (or null —
 * a missing previous manifest is the release baseline); `pkg` the parsed package.json (read from repoRoot when absent).
 * Throws with file:line on an impure listed module, an import that leaves the set, an undeclared bare import, an
 * unsupported export form, a stale EXCLUDED path.
 */
export function buildVendorManifest({ repoRoot, root = DEFAULT_ROOT, previous = null, pkg = null, excluded = EXCLUDED } = {}) {
  pkg = pkg || JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const tree = walkModules(repoRoot, root);
  const listed = tree.modules.filter(p => !(p in excluded));
  const listedSet = new Set(listed);
  for (const p of Object.keys(excluded)) {
    if (!tree.modules.includes(p)) throw new Error(`${p} is in EXCLUDED (tools/gen-vendor-manifest.mjs) but does not exist under ${root} — remove the stale exclusion`);
  }
  const deps = new Set(Object.keys(pkg.dependencies || {}));
  const read = (p) => fs.readFileSync(path.join(repoRoot, ...p.split('/')));

  const modules = {};
  for (const p of listed) {
    const buf = read(p);
    const src = buf.toString('utf8');
    for (const v of purityViolations(src)) throw new Error(`${p}:${v.line}: vendorable modules must not ${v.rule} (listed in ${MANIFEST_FILE}) — fix it or add the module to EXCLUDED with a reason`);
    const imports = [];
    const npm = [];
    for (const { spec, index } of importSpecifiers(src)) {
      if (spec.startsWith('.')) {
        const target = resolveSpec(p, spec);
        if (!listedSet.has(target)) throw new Error(`${p}:${lineOf(src, index)}: imports ${spec}, which is not a vendorable module`);
        if (!imports.includes(target)) imports.push(target);
      } else {
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (!deps.has(name)) throw new Error(`${p}:${lineOf(src, index)}: imports ${spec}, which is not a package.json dependency`);
        if (!npm.includes(name)) npm.push(name);
      }
    }
    modules[p] = { sha256: sha256(buf), bytes: buf.length, exports: staticExports(src, p), imports: imports.sort(), npm: npm.sort() };
  }

  const data = {};
  for (const p of tree.data) { const buf = read(p); data[p] = { sha256: sha256(buf), bytes: buf.length }; }

  // The breaking-change signal, against the last release. `releasedExports: null` means "new since the release"
  // and is carried forward; a previous manifest from another version, or none, is the baseline.
  const sameRelease = previous && previous.version === pkg.version && previous.modules && typeof previous.modules === 'object';
  const removed = new Set();
  if (sameRelease) {
    for (const r of previous.removedSinceRelease || []) removed.add(r);
    for (const p of Object.keys(modules)) {
      const prev = previous.modules[p];
      const entry = modules[p];
      removed.delete(p);
      let baseline;
      if (!prev) baseline = null;
      else if ('releasedExports' in prev) baseline = prev.releasedExports;
      else baseline = prev.exports;
      if (baseline === null || baseline === undefined) {
        entry.changedSinceRelease = true;
        entry.releasedExports = null;
      } else if (sameList(baseline, entry.exports)) {
        entry.changedSinceRelease = false;
      } else {
        entry.changedSinceRelease = true;
        entry.releasedExports = baseline;
      }
    }
    for (const p of Object.keys(previous.modules)) {
      if (p in modules) continue;
      const prev = previous.modules[p];
      const wasReleased = !('releasedExports' in prev) || prev.releasedExports !== null;
      if (wasReleased) removed.add(p);
    }
  } else {
    for (const entry of Object.values(modules)) entry.changedSinceRelease = false;
  }

  const sortedKeys = (o) => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
  return {
    $comment: `Generated by tools/gen-vendor-manifest.mjs. Do not edit: run \`npm run vendor-manifest\`. docs/DOWNSTREAM.md explains the fields.`,
    manifestVersion: MANIFEST_VERSION,
    package: pkg.name,
    version: pkg.version,
    root,
    modules: sortedKeys(modules),
    data: sortedKeys(data),
    excluded: sortedKeys({ ...excluded }),
    removedSinceRelease: [...removed].sort(),
  };
}

/** The exact bytes of the file: 2-space JSON, LF, trailing newline. */
export const renderManifest = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

/** Human-readable differences between two manifests' module/data sections, one line each. */
export function diffManifests(committed, fresh) {
  const lines = [];
  const a = committed?.modules || {}; const b = fresh.modules || {};
  for (const p of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (!(p in a)) { lines.push(`+ ${p} (new module)`); continue; }
    if (!(p in b)) { lines.push(`- ${p} (no longer listed)`); continue; }
    const added = b[p].exports.filter(x => !a[p].exports.includes(x));
    const gone = a[p].exports.filter(x => !b[p].exports.includes(x));
    if (added.length || gone.length) lines.push(`~ ${p} exports: ${gone.map(x => `-${x}`).concat(added.map(x => `+${x}`)).join(' ')}`);
    else if (a[p].sha256 !== b[p].sha256) lines.push(`~ ${p} body changed (sha256), exports unchanged`);
    else if (!sameList(a[p].imports, b[p].imports) || !sameList(a[p].npm, b[p].npm)) lines.push(`~ ${p} imports changed`);
    else if (a[p].changedSinceRelease !== b[p].changedSinceRelease) lines.push(`~ ${p} changedSinceRelease ${a[p].changedSinceRelease} → ${b[p].changedSinceRelease}`);
  }
  const da = committed?.data || {}; const db = fresh.data || {};
  for (const p of [...new Set([...Object.keys(da), ...Object.keys(db)])].sort()) {
    if (!(p in da)) lines.push(`+ ${p} (new data file)`);
    else if (!(p in db)) lines.push(`- ${p} (data file gone)`);
    else if (da[p].sha256 !== db[p].sha256) lines.push(`~ ${p} changed (sha256)`);
  }
  for (const k of ['version', 'package', 'root', 'manifestVersion']) if (committed?.[k] !== fresh[k]) lines.push(`~ ${k}: ${JSON.stringify(committed?.[k])} → ${JSON.stringify(fresh[k])}`);
  if (!sameList(committed?.removedSinceRelease || [], fresh.removedSinceRelease)) lines.push(`~ removedSinceRelease: ${JSON.stringify(fresh.removedSinceRelease)}`);
  const ea = committed?.excluded || {}; const eb = fresh.excluded || {};
  for (const p of [...new Set([...Object.keys(ea), ...Object.keys(eb)])].sort()) if (ea[p] !== eb[p]) lines.push(`~ excluded ${p}`);
  return lines;
}

// ---------------------------------------------------------------------------
// The CHANGELOG rule.
// ---------------------------------------------------------------------------

/** The text under `## Unreleased` up to the next `## ` heading, or null when there is no such heading. */
export function changelogUnreleasedSection(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(l => /^## Unreleased\s*$/.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  return lines.slice(start + 1, end).join('\n');
}

/** Whether the section names the module: its repo-relative path, or its backticked basename (`x.mjs`). */
export function mentionsModule(section, modulePath) {
  if (!section) return false;
  const base = modulePath.split('/').pop();
  return section.includes(modulePath) || section.includes(`\`${base}\``);
}

// ---------------------------------------------------------------------------
// Downstream checks over a vendored tree.
// ---------------------------------------------------------------------------

/** A manifest key must be a POSIX path under root: no leading slash, no backslash, no `.`/`..`/empty segment. */
export function validManifestPath(key, root) {
  if (typeof key !== 'string' || !key.startsWith(`${root}/`)) return false;
  if (key.includes('\\') || key.startsWith('/')) return false;
  return key.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..');
}

function readVendoredManifest(dir) {
  const file = path.join(dir, MANIFEST_FILE);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const root = typeof doc.root === 'string' && doc.root ? doc.root : DEFAULT_ROOT;
  for (const key of [...Object.keys(doc.modules || {}), ...Object.keys(doc.data || {})]) {
    if (!validManifestPath(key, root)) throw new Error(`${MANIFEST_FILE}: invalid path ${JSON.stringify(key)} — every entry must be a relative POSIX path under ${root}/ with no "..", leading "/" or backslash`);
  }
  return doc;
}

/** [{ path, status: 'ok' | 'drift' | 'missing', hint? }] — each listed module and data file under <dir> against its sha256. */
export function verifyVendoredTree(dir) {
  const doc = readVendoredManifest(dir);
  const out = [];
  for (const [p, entry] of [...Object.entries(doc.modules || {}), ...Object.entries(doc.data || {})]) {
    const file = path.join(dir, ...p.split('/'));
    if (!fs.existsSync(file)) { out.push({ path: p, status: 'missing' }); continue; }
    const buf = fs.readFileSync(file);
    if (sha256(buf) === entry.sha256) { out.push({ path: p, status: 'ok' }); continue; }
    const row = { path: p, status: 'drift' };
    if (sha256(Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'))) === entry.sha256) row.hint = 'line endings differ (CRLF) — copy the bytes verbatim';
    out.push(row);
  }
  return out;
}

/** [{ path, status: 'ok' | 'fail', error? }] — dynamic-imports each listed module from <dir> and compares its export names. */
export async function smokeVendoredTree(dir) {
  const doc = readVendoredManifest(dir);
  const out = [];
  for (const [p, entry] of Object.entries(doc.modules || {})) {
    const file = path.join(dir, ...p.split('/'));
    try {
      const ns = await import(pathToFileURL(file).href);
      const got = Object.keys(ns).sort();
      if (sameList(got, entry.exports)) out.push({ path: p, status: 'ok' });
      else out.push({ path: p, status: 'fail', error: `exports differ: manifest ${JSON.stringify(entry.exports)}, module ${JSON.stringify(got)}` });
    } catch (e) {
      out.push({ path: p, status: 'fail', error: String(e && e.message || e).split('\n')[0] });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

export const STALE_MESSAGE = `${MANIFEST_FILE} is stale: run \`npm run vendor-manifest\` and commit it with the change`;

export function readCommittedManifest(repoRoot) {
  const file = path.join(repoRoot, MANIFEST_FILE);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

async function main(argv) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const flagDir = (flag) => {
    const i = argv.indexOf(flag);
    const dir = argv[i + 1];
    if (!dir || dir.startsWith('--')) { process.stderr.write(`${flag} needs a directory\n`); process.exit(2); }
    return path.resolve(dir);
  };
  if (argv.includes('--verify')) {
    const rows = verifyVendoredTree(flagDir('--verify'));
    for (const r of rows) process.stdout.write(`${r.status.padEnd(7)} ${r.path}${r.hint ? ` (${r.hint})` : ''}\n`);
    const bad = rows.filter(r => r.status !== 'ok').length;
    process.stdout.write(bad ? `${bad} of ${rows.length} file(s) differ from the manifest\n` : `${rows.length} file(s) match the manifest\n`);
    process.exit(bad ? 1 : 0);
  }
  if (argv.includes('--smoke')) {
    const rows = await smokeVendoredTree(flagDir('--smoke'));
    for (const r of rows) process.stdout.write(`${r.status.padEnd(7)} ${r.path}${r.error ? `: ${r.error}` : ''}\n`);
    const bad = rows.filter(r => r.status !== 'ok').length;
    process.stdout.write(bad ? `${bad} of ${rows.length} module(s) failed\n` : `${rows.length} module(s) import with the listed exports\n`);
    process.exit(bad ? 1 : 0);
  }
  const previous = readCommittedManifest(repoRoot);
  const fresh = buildVendorManifest({ repoRoot, previous });
  const text = renderManifest(fresh);
  if (argv.includes('--check')) {
    const committed = fs.existsSync(path.join(repoRoot, MANIFEST_FILE)) ? fs.readFileSync(path.join(repoRoot, MANIFEST_FILE), 'utf8').replace(/\r\n/g, '\n') : '';
    if (committed === text) { process.stdout.write(`${MANIFEST_FILE} is in sync (${Object.keys(fresh.modules).length} modules)\n`); return; }
    process.stderr.write(`${STALE_MESSAGE}\n`);
    for (const l of diffManifests(previous, fresh)) process.stderr.write(`  ${l}\n`);
    process.exit(1);
  }
  if (argv.includes('--write')) {
    fs.writeFileSync(path.join(repoRoot, MANIFEST_FILE), text);
    process.stdout.write(`wrote ${MANIFEST_FILE} (${Object.keys(fresh.modules).length} modules, ${Object.keys(fresh.data).length} data file(s), ${Object.keys(fresh.excluded).length} excluded)\n`);
    return;
  }
  process.stdout.write(text);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('gen-vendor-manifest.mjs')) {
  main(process.argv.slice(2)).catch(e => { process.stderr.write(`${e.message}\n`); process.exit(1); });
}
