#!/usr/bin/env node
// tools/build-studio-bundle.mjs — the studio as ONE static HTML file
// (docs/DOWNSTREAM.md, "Embedding the studio"; README, "Serve The Studio
// Without The Server").
//
//   node tools/build-studio-bundle.mjs [--pack <file> [--id <id>] [--label <text>] [--description <text>]]…
//        [--pack-url <url> [--id <id>] [--label <text>]]… [--out dist/studio/index.html]
//        [--no-remote-fonts] [--check] [--json]
//
// --pack is parsed (YAML or .json) and validated against the spec schema at
// build time; its canonical is inlined. --pack-url is fetched by the page at
// its first catalogue read (the host must answer CORS); a URL carrying
// userinfo or a credential query parameter is refused — the file is
// distributed, and --json prints URLs in their stripped form only.
// --check builds in memory and writes nothing. --no-remote-fonts drops the
// Google Fonts links (the fallback stacks apply). Without --pack the bundle
// boots with an empty catalogue and the notice.
//
// A downstream that serves the studio behind its own static host gets the
// whole studio — every module, every stylesheet, the packs it names — in one
// file that assumes no server: studio/static-backend.mjs answers the
// read-only pack routes in the browser and says "no backend" for the rest.
//
// How the modules are inlined: an inline `<script type="importmap">` whose
// keys are bare specifiers (`studio/<file>.mjs`, `lib/<path>.mjs` for
// tools/lib) and whose addresses are `data:text/javascript;base64,…` of each
// module, with ONLY the import-specifier strings rewritten to those keys.
// Native ESM semantics stay untouched — live bindings, cycles, `import()`
// with `.catch`, re-exports — because no module's syntax is transformed.
// (Nested data: URLs cannot resolve relative specifiers; blob: URLs need a
// runtime step before the import map; a concatenation registry means
// rewriting import/export syntax by hand.) Cost: base64 ×1.33, and stack
// traces name data: URLs. A page whose Content-Security-Policy forbids
// `data:` in script-src needs a directory form (`--split`), a follow-up.
//
// Zero dependencies beyond Node: fs, path, this repo's tools/lib. No bundler.
// Exit 0 built · 1 a pack fails the schema, a specifier cannot be inlined, a
// file is missing · 2 usage.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, posix, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_SCHEMA_PATH } from './lib/validator.mjs';
import { stripMcpUrl } from './lib/mcp-url-safety.mjs';
import { fileSlug } from './lib/slug.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(HERE, '..');
export const ENTRIES = ['studio/app.mjs', 'studio/static-backend.mjs'];
export const CONFIG_ID = 'observogram-static-config';
export const DEFAULT_OUT = 'dist/studio/index.html';
const NOTICE_CSS = 'static-backend.css';
const usage = `usage: build-studio-bundle.mjs [--pack <file> [--id <id>] [--label <text>] [--description <text>]]… [--pack-url <url> [--id <id>] [--label <text>]]… [--out ${DEFAULT_OUT}] [--no-remote-fonts] [--check] [--json]`;

// ---------- the module graph ----------

// Comments out, so a specifier in a comment is neither collected nor
// asserted against (server/test-authz.mjs's approach).
export function withoutComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

// The three forms a specifier takes; each regex names the quote (`q`) and
// the specifier (`spec`), so a rewrite keeps the quote.
//   import … from 'x' · export … from 'x'      (over any number of lines)
//   import 'x'                                  (a side-effect import — at a
//                                                statement start, so a string
//                                                ending in "import" is not one)
//   import('x')                                 (a dynamic import)
const QUOTED = `(?<q>['"])(?<spec>[^'"\\n]+)\\k<q>`;
const FROM_RE = new RegExp(`\\b(?:import|export)\\b[^;'"\`]*?\\bfrom\\s*${QUOTED}`, 'g');
const SIDE_RE = new RegExp(`(?<=^|[;{}])[ \\t]*import\\s*${QUOTED}`, 'gm');
const DYNAMIC_RE = new RegExp(`\\bimport\\s*\\(\\s*${QUOTED}\\s*\\)`, 'g');
const SPECIFIER_RES = [FROM_RE, SIDE_RE, DYNAMIC_RE];

// A root-relative path → its import-map key, or null outside the two trees.
export function keyOf(relPath) {
  if (relPath.startsWith('tools/lib/')) return `lib/${relPath.slice('tools/lib/'.length)}`;
  if (relPath.startsWith('studio/')) return relPath;
  return null;
}
// The reverse: a key → the root-relative path.
export function pathOf(key) {
  return key.startsWith('lib/') ? `tools/lib/${key.slice(4)}` : key;
}

// Where a specifier points, as a root-relative path: `/lib/x` is tools/lib/x
// (the server's /lib mount, server/index.mjs; `.mjs` added when the
// specifier has no extension, as that mount does), `./` and `../` are
// relative to the importing file. Anything else — a bare package, node:*,
// an http URL — is null: the bundle cannot inline it.
export function resolveSpecifier(spec, fromRelPath) {
  let rel;
  if (spec.startsWith('/lib/')) rel = `tools${spec}`;
  else if (spec.startsWith('./') || spec.startsWith('../')) rel = posix.normalize(posix.join(posix.dirname(fromRelPath), spec));
  else return null;
  if (!extname(rel)) rel += '.mjs';
  return rel;
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

// Every module reachable from the entries: Map<key, { path, src, imports }>.
// Throws naming file:line for a specifier that cannot be inlined, a module
// outside studio/ and tools/lib, or a file that is not there.
export function collectModuleGraph(root = DEFAULT_ROOT, entries = ENTRIES, { read } = {}) {
  const readFile = read || ((rel) => {
    const abs = resolve(root, rel);
    if (!existsSync(abs)) throw new Error(`module file missing: ${rel}`);
    return readFileSync(abs, 'utf8');
  });
  const graph = new Map();
  const queue = [];
  const enqueue = (rel, from) => {
    const key = keyOf(rel);
    if (!key) throw new Error(`${from}: ${rel} is outside studio/ and tools/lib/ — the bundle inlines those two trees only`);
    if (!graph.has(key)) { graph.set(key, null); queue.push(key); }
    return key;
  };
  for (const e of entries) enqueue(e, 'entry');
  while (queue.length) {
    const key = queue.shift();
    const path = pathOf(key);
    const src = readFile(path);
    const stripped = withoutComments(src);
    const imports = [];
    for (const re of SPECIFIER_RES) {
      for (const m of stripped.matchAll(re)) {
        const spec = m.groups.spec;
        const target = resolveSpecifier(spec, path);
        if (!target) {
          throw new Error(`${path}:${lineOf(stripped, m.index)}: cannot inline the specifier '${spec}' — only ./, ../ and /lib/ paths into studio/ and tools/lib/ are bundled (a bare package or node:* module cannot be)`);
        }
        imports.push({ spec, key: enqueue(target, `${path}:${lineOf(stripped, m.index)}`) });
      }
    }
    graph.set(key, { path, src, imports });
  }
  return graph;
}

// The source with every inlinable specifier replaced by its key — nothing
// else touched. A specifier that does not resolve stays as it is.
export function rewriteSpecifiers(src, fromKey) {
  const fromPath = pathOf(fromKey);
  let out = src;
  for (const re of SPECIFIER_RES) {
    out = out.replace(re, (whole, ...rest) => {
      const { q: quote, spec } = rest[rest.length - 1];
      const target = resolveSpecifier(spec, fromPath);
      const key = target && keyOf(target);
      if (!key) return whole;
      const at = whole.lastIndexOf(`${quote}${spec}${quote}`);
      return `${whole.slice(0, at)}${quote}${key}${quote}${whole.slice(at + spec.length + 2)}`;
    });
  }
  return out;
}

// After the rewrite no module may still name a path specifier (comments aside).
const LEFTOVER_RE = /\b(?:from|import)\s*\(?\s*['"](?:\.{1,2}\/|\/lib\/)/;
export function assertRewritten(rewritten, key) {
  const stripped = withoutComments(rewritten);
  const m = LEFTOVER_RE.exec(stripped);
  if (m) throw new Error(`${pathOf(key)}:${lineOf(stripped, m.index)}: a path specifier survived the rewrite: ${stripped.slice(m.index, m.index + 60).split('\n')[0]}`);
}

// ---------- the HTML ----------

// JSON inside a <script>: `<` can never start `</script` or `<!--`, and the
// two line terminators JSON allows raw are escaped (both stay valid JSON).
export function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// A stylesheet as an inline <style>: the one sequence that ends a style
// element's text is "</style", and nothing can escape it — such a sheet
// fails the build rather than being inlined cut short.
export function styleBlock(name, css) {
  if (/<\/style/i.test(css)) throw new Error(`studio/${name} contains "</style" and cannot be inlined`);
  return `<style data-src="${name}">\n${css}\n</style>`;
}

const STYLESHEET_RE = /^([ \t]*)<link rel="stylesheet" href="\/([\w.-]+\.css)">[ \t]*$/gm;
const FONT_LINE_RE = /^[ \t]*<link [^>\n]*fonts\.g(?:oogleapis|static)\.com[^>\n]*>[ \t]*\n/gm;
const APP_SCRIPT = '<script type="module" src="/app.mjs"></script>';

function toBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

// { html, modules: [{ key, bytes }], stylesheets: [names], config, bytes }
export function buildStudioBundle({ root = DEFAULT_ROOT, packs = [], remoteFonts = true, version, builtAt = new Date().toISOString() } = {}) {
  const readRel = (rel) => readFileSync(resolve(root, rel), 'utf8');
  const pkgVersion = version ?? JSON.parse(readRel('package.json')).version;
  const schema = JSON.parse(readRel(SPEC_SCHEMA_PATH));

  // The modules.
  const graph = collectModuleGraph(root, ENTRIES);
  const imports = {};
  const modules = [];
  for (const [key, mod] of graph) {
    const rewritten = rewriteSpecifiers(mod.src, key);
    assertRewritten(rewritten, key);
    imports[key] = `data:text/javascript;base64,${toBase64(rewritten)}`;
    modules.push({ key, bytes: Buffer.byteLength(rewritten, 'utf8') });
  }

  // The config the page reads: the packs with their canonical, the schema.
  const config = {
    version: pkgVersion,
    builtAt,
    schema,
    packs: packs.map((p) => (p.url
      ? { id: p.id, label: p.label, ...(p.description ? { description: p.description } : {}), url: p.url }
      : { id: p.id, label: p.label, ...(p.description ? { description: p.description } : {}), source: 'bundle', canonical: p.canonical })),
  };

  // The page: studio/index.html with its stylesheets, fonts and script replaced.
  let html = readRel('studio/index.html');
  const stylesheets = [];
  const inlineCss = (name) => {
    const block = styleBlock(name, readRel(`studio/${name}`));
    stylesheets.push(name);
    return block;
  };
  html = html.replace(STYLESHEET_RE, (whole, indent, name) => `${indent}${inlineCss(name)}`);
  if (!stylesheets.length) throw new Error('studio/index.html: no <link rel="stylesheet" href="/…css"> to inline');
  // The notice's stylesheet, after the adapter (reskin.css) — the live studio never links it.
  const lastStyle = `<style data-src="${stylesheets[stylesheets.length - 1]}">`;
  const lastAt = html.indexOf(lastStyle);
  const lastEnd = html.indexOf('</style>', lastAt) + '</style>'.length;
  html = `${html.slice(0, lastEnd)}\n${inlineCss(NOTICE_CSS)}${html.slice(lastEnd)}`;
  if (!remoteFonts) html = html.replace(FONT_LINE_RE, '');

  const scriptAt = html.indexOf(APP_SCRIPT);
  if (scriptAt < 0 || html.indexOf(APP_SCRIPT, scriptAt + 1) >= 0) throw new Error(`studio/index.html: expected exactly one ${APP_SCRIPT}`);
  const scripts = [
    `<script type="application/json" id="${CONFIG_ID}">${inlineJson(config)}</script>`,
    `<script type="importmap">${inlineJson({ imports })}</script>`,
    `<script type="module">import { installStaticBackend } from 'studio/static-backend.mjs'; installStaticBackend(JSON.parse(document.getElementById('${CONFIG_ID}').textContent));</script>`,
    `<script type="module">import 'studio/app.mjs';</script>`,
  ];
  html = html.replace(APP_SCRIPT, scripts.join('\n'));
  html = html.replace('<body>\n', '<body>\n<noscript><p class="no-backend-notice">This studio is a static bundle: it needs JavaScript and a browser with import maps (Chrome 89, Firefox 108, Safari 16.4 or newer).</p></noscript>\n');

  const leftover = /(?:href|src)="\/[^"]*"/.exec(html);
  if (leftover) throw new Error(`the bundle still references the server: ${leftover[0]}`);

  return { html, modules, stylesheets, config, bytes: Buffer.byteLength(html, 'utf8') };
}

// ---------- the packs ----------

const PACK_EXT_RE = /\.(?:pack\.)?(?:ya?ml|json)$/i;

export function defaultPackId(fileOrUrlPath) {
  return fileSlug(basename(fileOrUrlPath).replace(PACK_EXT_RE, ''), 'pack') || 'pack';
}

// A --pack file: parsed as server/index.mjs loadPackFile does, validated
// against the spec schema. Throws with the validator's texts.
export function loadPackFile(file, schema, { cwd = process.cwd() } = {}) {
  const abs = resolve(cwd, file);
  if (!existsSync(abs)) throw new Error(`pack file missing: ${file}`);
  const text = readFileSync(abs, 'utf8');
  const canonical = extname(abs).toLowerCase() === '.json' ? JSON.parse(text) : parseYaml(text);
  const errors = validateCanonical(canonical, schema);
  if (errors.length) throw new Error(`${file} fails the ObservabilityPack schema:\n  - ${errors.join('\n  - ')}`);
  return canonical;
}

// A --pack-url: http(s), no userinfo, no credential-bearing query (the rule
// of tools/lib/mcp-url-safety.mjs stripMcpUrl) — the URL is baked into a
// file that gets distributed and printed by --json. Returns the URL as given.
export function checkPackUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`--pack-url ${JSON.stringify(raw)} is not a URL`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`--pack-url must be http(s): ${url.protocol}`);
  const { safe, dropped } = stripMcpUrl(raw);
  if (url.username || url.password) throw new Error(`--pack-url carries credentials (userinfo) — a pack URL is baked into the bundle, which is distributed; use ${safe}`);
  if (dropped.length) throw new Error(`--pack-url carries a credential in its query (${dropped.join(', ')}) — a pack URL is baked into the bundle, which is distributed; use ${safe}`);
  return url.href;
}

// ---------- the CLI ----------

export function parseArgs(argv) {
  const opts = { packs: [], out: DEFAULT_OUT, remoteFonts: true, check: false, json: false, help: false };
  const need = (i, a) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value\n${usage}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--check') { opts.check = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--no-remote-fonts') { opts.remoteFonts = false; continue; }
    if (a === '--out') { opts.out = need(++i, a); continue; }
    if (a === '--pack') { opts.packs.push({ file: need(++i, a) }); continue; }
    if (a === '--pack-url') { opts.packs.push({ url: need(++i, a) }); continue; }
    if (a === '--id' || a === '--label' || a === '--description') {
      const last = opts.packs[opts.packs.length - 1];
      if (!last) throw new Error(`${a} must follow a --pack or --pack-url\n${usage}`);
      last[a.slice(2)] = need(++i, a);
      continue;
    }
    throw new Error(`unknown argument ${a}\n${usage}`);
  }
  return opts;
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), root = DEFAULT_ROOT } = {}) {
  let opts;
  try { opts = parseArgs(argv); }
  catch (e) { stderr.write(`${e.message}\n`); return 2; }
  if (opts.help) { stdout.write(`${usage}\n`); return 0; }
  try {
    const schema = JSON.parse(readFileSync(resolve(root, SPEC_SCHEMA_PATH), 'utf8'));
    const packs = [];
    const ids = new Set();
    for (const p of opts.packs) {
      let entry;
      if (p.url) {
        const href = checkPackUrl(p.url);
        const id = p.id || defaultPackId(new URL(href).pathname);
        entry = { id, label: p.label || id, description: p.description, url: href };
      } else {
        const canonical = loadPackFile(p.file, schema, { cwd });
        const id = p.id || defaultPackId(p.file);
        entry = { id, label: p.label || canonical.metadata?.name || id, description: p.description, canonical };
      }
      if (ids.has(entry.id)) throw new Error(`two packs share the id ${JSON.stringify(entry.id)} — give one an --id`);
      ids.add(entry.id);
      packs.push(entry);
    }
    const built = buildStudioBundle({ root, packs, remoteFonts: opts.remoteFonts });
    const out = resolve(cwd, opts.out);
    if (!opts.check) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, built.html);
    }
    const summary = `${built.modules.length} modules · ${built.stylesheets.length} stylesheets · ${built.bytes} bytes · ${packs.length} pack${packs.length === 1 ? '' : 's'}`;
    if (opts.json) {
      stdout.write(`${JSON.stringify({
        ok: true,
        out: opts.check ? null : out,
        check: opts.check,
        bytes: built.bytes,
        modules: built.modules.length,
        stylesheets: built.stylesheets,
        remoteFonts: opts.remoteFonts,
        packs: packs.map((p) => ({ id: p.id, label: p.label, source: p.url ? 'url' : 'file', ...(p.url ? { url: stripMcpUrl(p.url).safe } : {}) })),
      }, null, 2)}\n`);
    } else {
      stdout.write(opts.check ? `ok (not written): ${summary}\n` : `wrote ${out} — ${summary}\n`);
    }
    return 0;
  } catch (e) {
    if (opts.json) stdout.write(`${JSON.stringify({ ok: false, error: e.message })}\n`);
    stderr.write(`${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(await main());
}
