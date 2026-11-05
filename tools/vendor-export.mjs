#!/usr/bin/env node
// tools/vendor-export.mjs — the files a downstream copies from one commit,
// and the proof that a copy holds exactly those files.
//
//   node tools/vendor-export.mjs [--ref <ref>] [--out <dir>]
//       Writes the export of <ref> (default HEAD) into <dir> (default
//       vendor-export/, which must not exist or be empty): every file of the
//       commit's tree but the ones `.gitattributes` marks `export-ignore`, the
//       same files `git archive <ref>` and GitHub's source tarballs carry,
//       written byte for byte from the committed blobs, plus VENDOR-TREE.json.
//   node tools/vendor-export.mjs --tree [--ref <ref>]
//       Prints that VENDOR-TREE.json and writes nothing.
//   node tools/vendor-export.mjs --check <dir> [--patch-marker <text>] [--json]
//       Proves <dir> against the VENDOR-TREE.json at its root. Every listed
//       file is `ok`, `changed`, `local patch` (changed, and carrying the
//       `LOCAL DEVIATION` marker or --patch-marker's text), `line endings
//       only` or `missing`; a file the list does not name is `extra`
//       (`node_modules/` and `.git/` are never read). Exit 0 only when every
//       file is ok and nothing is extra. Needs no git.
//
// VENDOR-TREE.json: { format: 1, commit, date (the committer date), version
// (package.json at the commit), excluded: [path], files: [{ path, sha256,
// bytes }] }, paths sorted by code point, one file per line. The same commit
// always gives the same bytes. Export and --tree read git and run in an
// upstream checkout; docs/DOWNSTREAM_REFRESH.md is the workflow.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VENDOR_TREE_FILE = 'VENDOR-TREE.json';
export const VENDOR_TREE_FORMAT = 1;
export const DEFAULT_MARKER = 'LOCAL DEVIATION';
const NEVER_READ = new Set(['node_modules', '.git']);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function git(repo, args, { input, env } = {}) {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], {
    input, env: { ...process.env, GIT_ATTR_NOSYSTEM: '1', ...env }, maxBuffer: 1 << 30,
  });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${String(r.stderr).trim() || `exit ${r.status}`}`);
  return r.stdout;
}

const nulFields = (buf) => buf.toString('utf8').split('\0').filter((s, i, all) => i < all.length - 1 || s !== '');

/** The export of `ref`: { tree (the VENDOR-TREE.json object), blobs: Map<path, Buffer> }. */
export function exportOf(ref = 'HEAD', { repo = REPO } = {}) {
  const top = resolve(String(git(repo, ['rev-parse', '--show-toplevel'])).trim());
  if (top.toLowerCase() !== resolve(repo).toLowerCase()) throw new Error(`${repo} is not the top of a git checkout; run the export in an upstream checkout`);
  const commit = String(git(repo, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  const date = String(git(repo, ['show', '-s', '--format=%cI', commit])).trim();
  const version = JSON.parse(String(git(repo, ['show', `${commit}:package.json`]))).version ?? null;
  // The commit's own tree in a scratch index, so its .gitattributes decide
  // and nothing in the working tree or the real index does.
  const scratch = mkdtempSync(join(tmpdir(), 'observogram-vendor-export-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    git(repo, ['read-tree', commit], { env });
    const entries = nulFields(git(repo, ['ls-files', '-s', '-z'], { env })).map((line) => {
      const tab = line.indexOf('\t');
      const [mode, oid] = line.slice(0, tab).split(' ');
      return { mode, oid, path: line.slice(tab + 1) };
    }).filter((e) => e.mode !== '160000');
    const attrs = nulFields(git(repo, ['-c', 'core.attributesFile=', 'check-attr', '--cached', '-z', '--stdin', 'export-ignore'], { env, input: entries.map((e) => `${e.path}\0`).join('') }));
    const ignored = new Set();
    for (let i = 0; i + 2 < attrs.length; i += 3) if (attrs[i + 2] === 'set') ignored.add(attrs[i]);
    const kept = entries.filter((e) => !ignored.has(e.path)).sort((a, b) => byCodePoint(a.path, b.path));
    const blobs = readBlobs(repo, kept);
    const files = kept.map((e) => ({ path: e.path, sha256: sha256(blobs.get(e.path)), bytes: blobs.get(e.path).length }));
    const tree = { format: VENDOR_TREE_FORMAT, commit, date, version, excluded: [...ignored].sort(byCodePoint), files };
    return { tree, blobs };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Every blob in one `git cat-file --batch`: `<oid> blob <size>\n<bytes>\n` each.
function readBlobs(repo, entries) {
  const out = git(repo, ['cat-file', '--batch'], { input: entries.map((e) => e.oid).join('\n') + '\n' });
  const blobs = new Map();
  let at = 0;
  for (const e of entries) {
    const nl = out.indexOf(0x0a, at);
    const [oid, type, size] = out.subarray(at, nl).toString('utf8').split(' ');
    if (oid !== e.oid || type !== 'blob') throw new Error(`git cat-file: expected blob ${e.oid} for ${e.path}, read ${oid} ${type}`);
    const start = nl + 1;
    blobs.set(e.path, Buffer.from(out.subarray(start, start + Number(size))));
    at = start + Number(size) + 1;
  }
  return blobs;
}

/** VENDOR-TREE.json's text: the header fields, then one file per line. */
export function renderVendorTree(tree) {
  const head = JSON.stringify({ format: tree.format, commit: tree.commit, date: tree.date, version: tree.version, excluded: tree.excluded }, null, 2).slice(0, -2);
  const files = tree.files.map((f) => `    ${JSON.stringify({ path: f.path, sha256: f.sha256, bytes: f.bytes })}`).join(',\n');
  return `${head},\n  "files": [\n${files}\n  ]\n}\n`;
}

/** Writes the export of `ref` into `out`; returns its VENDOR-TREE.json object. */
export function writeExport(ref, out, { repo = REPO } = {}) {
  if (existsSync(out) && readdirSync(out).length) throw new Error(`--out ${out} exists and is not empty`);
  const { tree, blobs } = exportOf(ref, { repo });
  for (const f of tree.files) {
    const target = join(out, ...f.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, blobs.get(f.path));
  }
  writeFileSync(join(out, VENDOR_TREE_FILE), renderVendorTree(tree));
  return tree;
}

function walk(root, dir = root, found = []) {
  for (const name of readdirSync(dir).sort(byCodePoint)) {
    if (NEVER_READ.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(root, full, found);
    else found.push(relative(root, full).split(sep).join('/'));
  }
  return found;
}

/** Proves `dir` against its VENDOR-TREE.json: { commit, version, ok, changed, marked, lineEndings, missing, extra }. */
export function checkCopy(dir, { markers = [DEFAULT_MARKER] } = {}) {
  const file = join(dir, VENDOR_TREE_FILE);
  if (!existsSync(file)) throw new Error(`${file}: not found; an export writes it at the copy's root`);
  let tree;
  try { tree = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file}: ${e.message}`, { cause: e }); }
  if (tree?.format !== VENDOR_TREE_FORMAT || !Array.isArray(tree.files)) throw new Error(`${file}: not a VENDOR-TREE.json of format ${VENDOR_TREE_FORMAT}`);
  const result = { commit: tree.commit, version: tree.version, ok: 0, changed: [], marked: [], lineEndings: [], missing: [], extra: [] };
  const listed = new Set();
  for (const f of tree.files) {
    listed.add(f.path);
    const target = join(dir, ...f.path.split('/'));
    if (!existsSync(target)) { result.missing.push(f.path); continue; }
    const buf = readFileSync(target);
    if (sha256(buf) === f.sha256) { result.ok += 1; continue; }
    const text = buf.toString('utf8');
    if (text.includes('\r\n') && sha256(Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8')) === f.sha256) result.lineEndings.push(f.path);
    else if (markers.some((m) => text.includes(m))) result.marked.push(f.path);
    else result.changed.push(f.path);
  }
  for (const path of walk(dir)) if (path !== VENDOR_TREE_FILE && !listed.has(path)) result.extra.push(path);
  return result;
}

const clean = (r) => !r.changed.length && !r.marked.length && !r.lineEndings.length && !r.missing.length && !r.extra.length;

function printCheck(dir, r) {
  const lines = [
    ...r.changed.map((p) => `changed      ${p}`),
    ...r.marked.map((p) => `local patch  ${p}`),
    ...r.lineEndings.map((p) => `line endings ${p} (only the line endings differ: a checkout or copy setting, not a patch)`),
    ...r.missing.map((p) => `missing      ${p}`),
    ...r.extra.map((p) => `extra        ${p}`),
  ];
  for (const l of lines) process.stdout.write(`${l}\n`);
  const total = r.ok + r.changed.length + r.marked.length + r.lineEndings.length + r.missing.length;
  const of = `${String(r.commit).slice(0, 12)}${r.version ? `, ${r.version}` : ''}`;
  process.stdout.write(clean(r)
    ? `${dir}: all ${total} files match ${VENDOR_TREE_FILE} (${of})\n`
    : `${dir}: ${r.ok} of ${total} files match ${VENDOR_TREE_FILE} (${of}); ${r.changed.length} changed, ${r.marked.length} local patch, ${r.lineEndings.length} line endings, ${r.missing.length} missing, ${r.extra.length} extra\n`);
}

function main(argv) {
  const args = [...argv];
  const take = (flag) => { const i = args.indexOf(flag); if (i < 0) return undefined; const v = args[i + 1]; if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`); args.splice(i, 2); return v; };
  const has = (flag) => { const i = args.indexOf(flag); if (i < 0) return false; args.splice(i, 1); return true; };
  const check = take('--check');
  const marker = take('--patch-marker');
  const ref = take('--ref');
  const out = take('--out');
  const json = has('--json');
  const treeOnly = has('--tree');
  if (args.length) throw new Error(`unknown argument ${args[0]}`);
  if (check !== undefined) {
    if (ref || out || treeOnly) throw new Error('--check takes only --patch-marker and --json');
    const r = checkCopy(resolve(check), { markers: marker ? [DEFAULT_MARKER, marker] : [DEFAULT_MARKER] });
    if (json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); else printCheck(check, r);
    return clean(r) ? 0 : 1;
  }
  if (marker || json) throw new Error('--patch-marker and --json go with --check');
  if (treeOnly) {
    if (out) throw new Error('--tree writes nothing; drop --out');
    process.stdout.write(renderVendorTree(exportOf(ref ?? 'HEAD').tree));
    return 0;
  }
  const dir = resolve(out ?? 'vendor-export');
  const tree = writeExport(ref ?? 'HEAD', dir);
  process.stdout.write(`wrote ${dir}: ${tree.files.length} files of ${tree.commit.slice(0, 12)}${tree.version ? ` (${tree.version})` : ''}, ${tree.excluded.length} left out by export-ignore, and ${VENDOR_TREE_FILE}\n`);
  return 0;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`vendor-export: ${e.message}\n`); process.exitCode = 2; }
}
