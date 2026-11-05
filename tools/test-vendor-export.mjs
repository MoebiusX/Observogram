#!/usr/bin/env node
// tools/test-vendor-export.mjs — the export a downstream copies, and the
// check that proves a copy (tools/vendor-export.mjs, docs/DOWNSTREAM_REFRESH.md).
//
// The export of HEAD must be the files `git archive HEAD` writes, byte for
// byte, with the repository's own operation (.github/, .claude/, AGENTS.md)
// left out by `.gitattributes`; two exports of one commit must be identical;
// and --check must pass on an export and name every way a copy can differ.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCopy, EXPORT_COPY_SKIP, exportOf, isExportCopy, renderVendorTree, VENDOR_TREE_FILE, writeExport } from './vendor-export.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TOOL = join(ROOT, 'tools', 'vendor-export.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'observogram-test-vendor-export-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0;
const fresh = () => join(TMP, `out-${++n}`);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const git = (...args) => {
  const r = spawnSync('git', ['-C', ROOT, ...args], { maxBuffer: 1 << 30 });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
};
const cli = (...args) => {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

// A `git archive` tar → Map<path, Buffer> of its files (directories and the
// pax global header skipped; a pax `path` record names the entry after it).
function tarFiles(buf) {
  const files = new Map();
  let at = 0;
  let paxPath = null;
  while (at + 512 <= buf.length) {
    const h = buf.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const field = (from, len) => h.subarray(from, from + len).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 0x30);
    const body = buf.subarray(at + 512, at + 512 + size);
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      paxPath = m ? m[1] : null;
    } else if (type === '0' || type === '\0') {
      files.set(paxPath ?? name, Buffer.from(body));
      paxPath = null;
    } else {
      paxPath = null;   // 'g' (the commit id comment), '5' (a directory)
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

// Inside an export copy there is no checkout of this repository to export:
// each test skips there, saying so (tools/vendor-export.mjs isExportCopy).
const IN_COPY = { skip: isExportCopy(ROOT) && EXPORT_COPY_SKIP.checkout };

const BOUNDARY = (path) => path === 'AGENTS.md' || path.startsWith('.github/') || path.startsWith('.claude/');

test('the export of HEAD is its tree minus export-ignore: the files and bytes `git archive` writes, the repository\'s own operation left out, VENDOR-TREE.json naming the commit, its date and its version', IN_COPY, () => {
  const out = fresh();
  const tree = writeExport('HEAD', out);
  assert.equal(tree.format, 1);
  assert.equal(tree.commit, String(git('rev-parse', 'HEAD')).trim());
  assert.equal(tree.date, String(git('show', '-s', '--format=%cI', 'HEAD')).trim());
  assert.equal(tree.version, JSON.parse(String(git('show', 'HEAD:package.json'))).version);
  // The boundary .gitattributes draws, and nothing else.
  for (const p of ['AGENTS.md', '.claude/launch.json', '.github/workflows/ci.yml', '.github/copilot-instructions.md']) assert.ok(tree.excluded.includes(p), `${p} is left out`);
  assert.ok(tree.excluded.every(BOUNDARY), `only the boundary is left out: ${tree.excluded.join(', ')}`);
  assert.ok(!tree.files.some((f) => BOUNDARY(f.path)));
  for (const p of ['.github', '.claude', 'AGENTS.md']) assert.ok(!existsSync(join(out, p)), `${p} is not written`);
  for (const p of ['.gitattributes', '.gitignore', 'package.json', 'package-lock.json', 'tools/vendor-export.mjs', 'docs/DOWNSTREAM_REFRESH.md']) assert.ok(tree.files.some((f) => f.path === p), `${p} ships`);
  // `git archive` (and so GitHub's source tarball) carries the same files, byte for byte.
  const archived = tarFiles(git('archive', '--format=tar', 'HEAD'));
  assert.deepEqual([...archived.keys()].sort(), tree.files.map((f) => f.path).sort());
  for (const f of tree.files) {
    const written = readFileSync(join(out, ...f.path.split('/')));
    assert.equal(sha256(written), f.sha256, f.path);
    assert.equal(written.length, f.bytes, f.path);
    assert.equal(sha256(archived.get(f.path)), f.sha256, `${f.path}: git archive's bytes`);
  }
  assert.deepEqual(tree.files.map((f) => f.path), [...tree.files.map((f) => f.path)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'sorted by code point');
  assert.throws(() => writeExport('HEAD', out), { message: `--out ${out} exists and is not empty` });
});

test('two exports of one commit are byte-identical: VENDOR-TREE.json, written one file per line, and every file', IN_COPY, () => {
  const a = fresh();
  const b = fresh();
  writeExport('HEAD', a);
  const r = cli('--out', b);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^wrote .+: \d+ files of [0-9a-f]{12}( \([^)]+\))?, \d+ left out by export-ignore, and VENDOR-TREE\.json\n$/);
  const treeA = readFileSync(join(a, VENDOR_TREE_FILE), 'utf8');
  assert.equal(readFileSync(join(b, VENDOR_TREE_FILE), 'utf8'), treeA);
  assert.equal(cli('--tree').stdout, treeA, '--tree prints the same text and writes nothing');
  const parsed = JSON.parse(treeA);
  assert.equal(treeA, renderVendorTree(parsed));
  assert.deepEqual(parsed, exportOf('HEAD').tree);
  const lines = treeA.split('\n');
  assert.equal(lines.filter((l) => l.startsWith('    {"path":')).length, parsed.files.length, 'one file per line');
  assert.ok(treeA.endsWith('}\n') && !treeA.startsWith('﻿') && !treeA.includes('\r'), 'LF, no BOM');
  for (const f of parsed.files) assert.equal(sha256(readFileSync(join(b, ...f.path.split('/')))), f.sha256, f.path);
});

test('--check passes on an export and names every way a copy can differ: a 1-byte change, a marked local patch, line endings, a missing file, an extra one; node_modules is never read; the exit codes', IN_COPY, () => {
  const out = fresh();
  writeExport('HEAD', out);
  const ok = cli('--check', out);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /: all \d+ files match VENDOR-TREE\.json \([0-9a-f]{12}/);
  mkdirSync(join(out, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(out, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  assert.equal(cli('--check', out).status, 0, 'node_modules is never read');

  const pkg = join(out, 'package.json');
  const one = readFileSync(pkg);
  one[1] = one[1] === 0x20 ? 0x09 : 0x20;   // one byte
  writeFileSync(pkg, one);
  appendFileSync(join(out, 'tools', 'lib', 'adapter.mjs'), '// LOCAL DEVIATION (ORG DEMO): a marked downstream line\n');
  appendFileSync(join(out, 'tools', 'lib', 'diff.mjs'), '// ORG-PATCH: a line marked in the downstream\'s own words\n');
  writeFileSync(join(out, 'README.md'), readFileSync(join(out, 'README.md'), 'utf8').replace(/\n/g, '\r\n'));
  unlinkSync(join(out, 'LICENSE'));
  writeFileSync(join(out, 'extra.txt'), 'not upstream\n');

  const r = checkCopy(out);
  assert.deepEqual(r.changed, ['package.json', 'tools/lib/diff.mjs']);
  assert.deepEqual(r.marked, ['tools/lib/adapter.mjs']);
  assert.deepEqual(r.lineEndings, ['README.md']);
  assert.deepEqual(r.missing, ['LICENSE']);
  assert.deepEqual(r.extra, ['extra.txt']);
  assert.deepEqual(checkCopy(out, { markers: ['LOCAL DEVIATION', 'ORG-PATCH'] }).marked, ['tools/lib/adapter.mjs', 'tools/lib/diff.mjs'], '--patch-marker names the downstream\'s own words');

  const bad = cli('--check', out);
  assert.equal(bad.status, 1);
  const lines = bad.stdout.split('\n');
  for (const line of ['changed      package.json', 'local patch  tools/lib/adapter.mjs', 'missing      LICENSE', 'extra        extra.txt']) {
    assert.ok(lines.includes(line), `prints ${JSON.stringify(line)}: ${bad.stdout}`);
  }
  assert.ok(lines.some((l) => l.startsWith('line endings README.md ')), bad.stdout);
  assert.match(bad.stdout, /; 2 changed, 1 local patch, 1 line endings, 1 missing, 1 extra\n$/);
  const marked = JSON.parse(cli('--check', out, '--patch-marker', 'ORG-PATCH', '--json').stdout);
  assert.deepEqual(marked.marked, ['tools/lib/adapter.mjs', 'tools/lib/diff.mjs']);
  assert.equal(marked.commit, String(git('rev-parse', 'HEAD')).trim());

  // Usage and input errors exit 2 and say why.
  const empty = fresh();
  mkdirSync(empty);
  for (const [args, message] of [
    [['--check'], '--check needs a value'],
    [['--check', out, '--ref', 'HEAD'], '--check takes only --patch-marker and --json'],
    [['--nope'], 'unknown argument --nope'],
    [['--json'], '--patch-marker and --json go with --check'],
    [['--tree', '--out', empty], '--tree writes nothing; drop --out'],
    [['--check', empty], `${join(empty, VENDOR_TREE_FILE)}: not found; an export writes it at the copy's root`],
  ]) {
    const e = cli(...args);
    assert.equal(e.status, 2, args.join(' '));
    assert.equal(e.stderr, `vendor-export: ${message}\n`);
  }
});
