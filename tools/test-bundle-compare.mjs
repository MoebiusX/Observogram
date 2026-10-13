#!/usr/bin/env node
// tools/test-bundle-compare.mjs — Compare in the static bundle, and what the
// bundle carries with it (follow-up compare-in-bundle; docs/DOWNSTREAM.md §10).
//
// C2 the licence block: a two-pack bundle built through the CLI carries one
// `<script type="text/plain" id="observogram-licenses">` element at the end
// of <head> — Observogram's LICENSE verbatim, the spec's provenance from
// vendor/observability-pack-spec/VERSIONS.json — and one pointer comment
// right after the doctype, worded for a file that carries no third-party
// package; no path of the build machine; verifyBundleNotices accepts the file
// and names each problem of a damaged one (the element removed, doubled or
// moved to <body>, the MIT grant or disclaimer gone, a section for a package
// the import map does not carry, a package without its section, File: line
// or licence text, a pointer comment worded for the other case), and accepts
// what a minifier does (comments stripped, attributes reordered). The
// package-section format is rendered from a synthetic package. The tree's
// refusals: no LICENSE, a licence text that cannot be embedded, no
// VERSIONS.json provenance.
//
// C1b the npm packages a bundle may carry, over synthetic roots (a
// package-lock.json, a VENDOR-MANIFEST.json and a node_modules tree of small
// ES modules in a tmpdir): a closure that builds — breadth-first through
// dependencies and peerDependencies, each entry file's bytes as installed,
// its licence and NOTICE files, its distinct copyright lines, its source
// repository normalised — two nested copies that do not change what the
// closure loads (under an unrelated package, under a dev-only one), and every
// refusal's exact text: L-a … L-n and L-p, L-q here (L-o, Observogram's own
// licence, is C2's), R-a and R-b through collectModuleGraph's read and npmOf
// seams, and the three this build adds where the design left a hole (no
// licence id, an unparsable package.json, an entry file missing).
//
// C6 retrofeed, the one non-GET the shim answers, against a child server
// (serve(ws, { env: { OBSERVOGRAM_AUTH: 'off' } })) over the same packs under
// the server's ids: "equal" is the same status, reason phrase, content type,
// Cache-Control, X-Content-Type-Options and raw body text — the computed
// answers once the shim's clock is pinned to the adoptedAt the server
// stamped (payment-service → the live snapshot, the golden crawl →
// production-curated, compare-modes a → b, each with and without `keys`;
// scoped-all, whose pack annotates scopeMode, as A: retrofeed has no
// annotation fallback), the two 404s, and each body rule of the server's
// parsers (JSON empty, blank, null, a number, a string, an array, after
// whitespace, malformed, a refused charset, any case; text/json and
// application/vnd.api+json not parsed; text and no Content-Type; a form —
// computed, keys once and repeated, __proto__ and an empty name, a bracketed
// name, an iso-8859-1 escape, a refused charset; over 1000 parameters, over
// 64 KiB, JSON over 16 MiB; multipart). Then what only the shim can meet: a
// --pack-url pack that failed to load, an engine import that fails once and
// is retried, a baked taxonomy the classifier does not hold.
//
// A flat suite of top-level test( calls. Every CLI spawn gets serve-child's
// stripped env (childEnv), so a developer shell bakes nothing.
//
// Run: node --test tools/test-bundle-compare.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  DEFAULT_ROOT, LICENCES_ID, inlineJson, licenceBlockText, pointerComment, readOwnNotices, verifyBundleNotices,
  collectBundledPackages, collectModuleGraph, sourceUrlOf, packageNameOf,
} from './build-studio-bundle.mjs';
import { childEnv, serve } from '../server/fixtures/serve-child.mjs';
import { createStaticBackend } from '../studio/static-backend.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { adapt } from './lib/adapter.mjs';
import { diffPacks } from './lib/diff.mjs';
import { SPEC_SCHEMA_PATH } from './lib/validator.mjs';

const ROOT = DEFAULT_ROOT;
const TOOL = resolve(ROOT, 'tools/build-studio-bundle.mjs');
const PAYMENT = 'vendor/observability-pack-spec/v1.4/examples/payment-service.pack.yaml';
const GOLDEN = 'tools/fixtures/golden-crawl.pack.json';
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
const VERSION = JSON.parse(read('package.json')).version;
const LICENSE = read('LICENSE');
const UPSTREAM = JSON.parse(read('vendor/observability-pack-spec/VERSIONS.json')).upstream;
const OPEN = `<script type="text/plain" id="${LICENCES_ID}">`;
const TMP = mkdtempSync(join(tmpdir(), 'observogram-bundle-compare-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const cli = (args, cwd = TMP, extraEnv = {}) => spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf8', env: childEnv(null, extraEnv) });
// The element's text, as the page's textContent reads it (the element opens with a newline the builder writes).
const blockOf = (html) => {
  const at = html.indexOf(`${OPEN}\n`);
  assert.ok(at >= 0, 'the licence element is in the file');
  return html.slice(at + OPEN.length + 1, html.indexOf('</script>', at));
};
const problemsOf = (html) => verifyBundleNotices(html).problems;

test('C2 the licence block: one text/plain element ending <head> with Observogram\'s LICENSE verbatim and the spec\'s provenance, the pointer comment after the doctype, no build-machine path; verifyBundleNotices accepts the file, names every damage and survives a minifier; the package section\'s format; the tree\'s refusals', () => {
  const out = join(TMP, 'c2', 'index.html');
  const built = cli(['--pack', resolve(ROOT, PAYMENT), '--pack', resolve(ROOT, GOLDEN), '--id', 'golden', '--out', out, '--no-remote-fonts']);
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /^wrote .* — \d+ modules · 16 stylesheets · \d+ bytes · 2 packs\n$/, 'the human line is unchanged');
  const html = readFileSync(out, 'utf8');

  // Where: one element, the last thing in <head>; one pointer comment, right after the doctype.
  assert.equal(html.split(`${OPEN}\n`).length - 1, 1, 'exactly one element');
  const at = html.indexOf(`${OPEN}\n`);
  assert.ok(at > html.indexOf('<head>') && html.indexOf('</script>\n</head>', at) === html.indexOf('</script>', at), 'the element closes right before </head>');
  assert.ok(html.startsWith(`<!doctype html>\n${pointerComment(false)}\n<html`), 'the pointer comment is the line after the doctype');
  assert.equal(pointerComment(false), `<!-- Licence: this file contains Observogram (MIT) and no third-party package; its full text is in the ${OPEN} element in the head. -->`);
  assert.equal(html.split('<!-- Licence').length - 1, 1, 'one pointer comment');

  // What: the preamble for a file with no package, Observogram's LICENSE verbatim, the spec's provenance — exactly.
  const block = blockOf(html);
  assert.equal(block, [
    `This file is a build of the Observogram studio, version ${VERSION} (tools/build-studio-bundle.mjs).`,
    "It contains Observogram's code and no third-party package.",
    '',
    `==== Observogram ${VERSION} — MIT ====`,
    `${LICENSE.endsWith('\n') ? LICENSE.slice(0, -1) : LICENSE}`,
    '',
    '==== The ObservabilityPack spec ====',
    "The spec schema embedded in this file (and any pack built in from the spec's examples) comes",
    `from ${UPSTREAM.repo} at commit ${UPSTREAM.commit}; that`,
    'repository publishes no licence file.',
    '',
  ].join('\n'));
  assert.ok(block.includes(LICENSE), 'LICENSE verbatim');
  assert.equal(UPSTREAM.repo, 'MoebiusX/otel-observability-pack');
  assert.match(UPSTREAM.commit, /^[0-9a-f]{40}$/);
  assert.ok(!block.includes('npm ci installed it'), 'no package, so no paragraph about how packages are embedded');
  assert.ok(!html.includes(ROOT) && !html.includes(TMP), 'no path of the build machine in the file');

  // The checker accepts the file as built.
  assert.deepEqual(verifyBundleNotices(html), { ok: true, packages: [], problems: [] });

  // …and names each damage.
  const element = html.slice(at, html.indexOf('</script>', at) + '</script>'.length);
  const noBlock = html.replace(`${element}\n`, '');
  assert.deepEqual(problemsOf(noBlock), [`the file has no ${OPEN} element — the licences are not embedded`]);
  assert.deepEqual(problemsOf(html.replace('</head>', `${element}\n</head>`)), [`the file has 2 #${LICENCES_ID} elements; it must have exactly one`]);
  assert.deepEqual(problemsOf(noBlock.replace('</body>', `${element}\n</body>`)), [`#${LICENCES_ID} is not in <head>`]);
  assert.deepEqual(problemsOf(html.replace(`${OPEN}\n`, `<script type="module" id="${LICENCES_ID}">\n`)), [`#${LICENCES_ID} is not type="text/plain"`]);
  assert.deepEqual(problemsOf(html.replace('Permission is hereby granted', 'Permission is granted')), ['the Observogram section does not hold the MIT licence\'s grant ("Permission is hereby granted")']);
  assert.deepEqual(problemsOf(html.replace('THE SOFTWARE IS PROVIDED "AS IS"', 'THE SOFTWARE IS PROVIDED')), ['the Observogram section does not hold the MIT licence\'s warranty disclaimer']);
  assert.deepEqual(problemsOf(html.replace(`==== Observogram ${VERSION} — MIT ====`, '==== Observogram ====')), ['no "Observogram <version> — MIT" section']);
  const stray = html.replace('==== The ObservabilityPack spec ====', '==== left-pad 1.3.0 — WTFPL ====\nFile: index.js (import-map entry "left-pad"), as installed.\n---- LICENSE ----\ntext\n\n==== The ObservabilityPack spec ====');
  assert.deepEqual(problemsOf(stray), ['left-pad: a licence section for a package the import map does not carry']);
  assert.equal(verifyBundleNotices(html.replace(/<script type="importmap">/, '<script type="importmap-x">')).problems[0], 'the file has no import map');

  // What a minifier does is not damage: the comment stripped, the attributes reordered and unquoted.
  const minified = html.replace(`${pointerComment(false)}\n`, '').replace(OPEN, `<script id=${LICENCES_ID} type=text/plain>`);
  assert.deepEqual(verifyBundleNotices(minified), { ok: true, packages: [], problems: [] });

  // The package section, rendered from a synthetic package: the preamble for a file with packages, the header (name,
  // version, SPDX id), File:, Source:, the copyright lines, each licence and NOTICE file under its own heading — in
  // code-point order of the package name.
  const own = readOwnNotices(ROOT, VERSION);
  assert.equal(own.licence, LICENSE);
  assert.deepEqual(own.spec, { repo: UPSTREAM.repo, commit: UPSTREAM.commit });
  const pkg = (name, extra = {}) => ({ name, version: '1.2.3', license: 'Apache-2.0', entry: 'dist/index.es.js', source: `https://example.com/${name}`, copyright: null, licenceFiles: [{ name: 'LICENSE', text: `${name} licence text\n` }], notice: null, ...extra });
  const withPackages = licenceBlockText({ ...own, version: VERSION, packages: [pkg('zz-last', { copyright: 'Copyright Z · Copyright Y', notice: [{ name: 'NOTICE', text: 'zz notice' }] }), pkg('@scope/first', { source: null, license: 'MIT', entry: 'dist/index.js' })] });
  assert.ok(withPackages.startsWith([
    `This file is a build of the Observogram studio, version ${VERSION} (tools/build-studio-bundle.mjs).`,
    "It contains Observogram's code and the third-party packages listed below, each with its",
    "licence in full. Each package's file is one entry of this file's import map, embedded as",
    'npm ci installed it from package-lock.json: this build changes nothing in it, and does not',
    'compare it with the package the registry publishes. Licence and NOTICE files are the ones',
    'the published package contains.',
    '',
    `==== Observogram ${VERSION} — MIT ====`,
  ].join('\n')), withPackages.slice(0, 700));
  assert.ok(withPackages.includes([
    '==== @scope/first 1.2.3 — MIT ====',
    'File: dist/index.js (import-map entry "@scope/first"), as installed.',
    '---- LICENSE ----',
    '@scope/first licence text',
    '',
    '==== zz-last 1.2.3 — Apache-2.0 ====',
    'File: dist/index.es.js (import-map entry "zz-last"), as installed.',
    'Source: https://example.com/zz-last',
    'Copyright lines in the file: Copyright Z · Copyright Y',
    '---- LICENSE ----',
    'zz-last licence text',
    '---- NOTICE ----',
    'zz notice',
    '',
    '==== The ObservabilityPack spec ====',
  ].join('\n')), withPackages);
  // The same file carrying those two packages in its import map: accepted with the matching pointer comment, refused
  // with the other one, and each missing part named.
  const imports = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]).imports;
  const withMap = (h, names) => h.replace(/<script type="importmap">[\s\S]*?<\/script>/, () => `<script type="importmap">${inlineJson({ imports: { ...imports, ...Object.fromEntries(names.map((n) => [n, 'data:text/javascript;base64,'])) } })}</script>`);
  const carrying = withMap(html.replace(block, withPackages), ['zz-last', '@scope/first']).replace(pointerComment(false), pointerComment(true));
  assert.deepEqual(verifyBundleNotices(carrying), { ok: true, packages: ['@scope/first', 'zz-last'], problems: [] });
  assert.deepEqual(problemsOf(carrying.replace(pointerComment(true), pointerComment(false))), ['the licence pointer comment is worded for no third-party package; the import map carries @scope/first, zz-last']);
  assert.deepEqual(problemsOf(withMap(html, ['zz-last'])), [
    'zz-last: no licence section (==== zz-last <version> — <licence id> ====)',
    'the licence pointer comment is worded for no third-party package; the import map carries zz-last',
  ]);
  assert.deepEqual(problemsOf(carrying.replace('File: dist/index.js (import-map entry "@scope/first"), as installed.\n', '')), ['@scope/first: its section has no File: line naming the import-map entry "@scope/first"']);
  assert.deepEqual(problemsOf(carrying.replace('---- LICENSE ----\n@scope/first licence text\n', '---- LICENSE ----\n\n')), ['@scope/first: its section holds no licence text (---- LICENSE ---- and the text)']);
  assert.deepEqual(problemsOf(carrying.replace('==== zz-last 1.2.3 — Apache-2.0 ====', '==== zz-last 1.2.3 — Apache-2.0 ====\n\n==== zz-last 1.2.3 — Apache-2.0 ====')), ['zz-last: 2 licence sections; one per package']);

  // The tree's refusals: no LICENSE; a LICENSE that would end the element or open a comment; no spec provenance.
  const tree = (files) => {
    const dir = mkdtempSync(join(TMP, 'tree-'));
    for (const [rel, text] of Object.entries(files)) { mkdirSync(join(dir, ...rel.split('/').slice(0, -1)), { recursive: true }); writeFileSync(join(dir, ...rel.split('/')), text); }
    return dir;
  };
  const versions = JSON.stringify({ upstream: { repo: 'acme/spec', commit: 'abc123' } });
  const bare = tree({ 'vendor/observability-pack-spec/VERSIONS.json': versions });
  assert.throws(() => readOwnNotices(bare, '9.9.9'), { message: `LICENSE is missing from ${bare} — every bundle carries Observogram's licence; copy LICENSE with the tree` });
  assert.throws(() => readOwnNotices(tree({ LICENSE: 'MIT\n</SCRIPT>\n', 'vendor/observability-pack-spec/VERSIONS.json': versions }), '9.9.9'), { message: 'Observogram 9.9.9: LICENSE contains "</script" and cannot be embedded in the bundle\'s licence block' });
  assert.throws(() => readOwnNotices(tree({ LICENSE: 'MIT <!-- x -->\n', 'vendor/observability-pack-spec/VERSIONS.json': versions }), '9.9.9'), { message: 'Observogram 9.9.9: LICENSE contains "<!--" and cannot be embedded in the bundle\'s licence block' });
  const noSpec = tree({ LICENSE: 'MIT\n' });
  assert.throws(() => readOwnNotices(noSpec, '9.9.9'), { message: `vendor/observability-pack-spec/VERSIONS.json is missing from ${noSpec} or names no upstream repo and commit — copy vendor/observability-pack-spec/ with the tree: every bundle embeds the spec's schema and says where it comes from` });
  assert.deepEqual(readOwnNotices(tree({ LICENSE: 'MIT\n', 'vendor/observability-pack-spec/VERSIONS.json': versions }), '9.9.9'), { licence: 'MIT\n', spec: { repo: 'acme/spec', commit: 'abc123' } });
});

// ---------- C1b the npm packages, over synthetic roots ----------

// A tree in a fresh tmpdir: { 'rel/path': text | object (written as JSON) }.
const writeTree = (files) => {
  const dir = mkdtempSync(join(TMP, 'root-'));
  for (const [rel, body] of Object.entries(files)) {
    const file = join(dir, ...rel.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return dir;
};
const MIT = 'MIT License\n\nCopyright (c) 2020 Acme\n\nPermission is hereby granted, free of charge…\n';
const APACHE = '                                 Apache License\n                           Version 2.0, January 2004\n';
// The good tree: @acme/parser (Apache-2.0, the root) imports its two peers; @acme/hl imports @acme/core; @acme/core
// imports nothing. Two nested copies of @acme/core that change nothing the closure loads: under an unrelated package
// and under a dev-only one.
const goodTree = () => ({
  'package-lock.json': {
    name: 'synthetic', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'synthetic', dependencies: { '@acme/parser': '^1.0.0' } },
      'node_modules/@acme/parser': { version: '1.0.0', license: 'Apache-2.0', peerDependencies: { '@acme/hl': '^1.0.0', '@acme/core': '^2.0.0' } },
      'node_modules/@acme/hl': { version: '1.1.0', license: 'MIT', dependencies: { '@acme/core': '^2.0.0' } },
      'node_modules/@acme/core': { version: '2.0.0', license: 'MIT' },
      'node_modules/unrelated': { version: '3.0.0', license: 'MIT' },
      'node_modules/unrelated/node_modules/@acme/core': { version: '1.0.0', license: 'MIT' },
      'node_modules/devtool': { version: '0.1.0', license: 'MIT', dev: true },
      'node_modules/devtool/node_modules/@acme/core': { version: '0.9.0', license: 'MIT', dev: true },
    },
  },
  'VENDOR-MANIFEST.json': { modules: { 'tools/lib/uses.mjs': { npm: ['@acme/parser'] } } },
  'node_modules/@acme/parser/package.json': {
    name: '@acme/parser', version: '1.0.0', license: 'Apache-2.0', type: 'module',
    exports: { types: './dist/index.d.ts', import: './dist/index.es.js', require: './dist/index.cjs' },
    repository: { type: 'git', url: 'git+https://example.com/acme/parser.git' },
    peerDependencies: { '@acme/hl': '^1.0.0', '@acme/core': '^2.0.0' },
  },
  'node_modules/@acme/parser/dist/index.es.js': "import { hl } from '@acme/hl';\nimport { core } from '@acme/core';\n// Copyright The Acme Authors\nexport const parser = [hl, core];\n/* Copyright The Acme Authors */\n/**\n * copyright 2020 Someone Else\n */\n",
  'node_modules/@acme/parser/dist/index.cjs': "module.exports = require('./other.cjs');\n",
  'node_modules/@acme/parser/LICENSE': APACHE,
  'node_modules/@acme/parser/NOTICE': 'Acme Parser\nCopyright 2020 The Acme Authors\n',
  'node_modules/@acme/parser/README.md': '# parser\n',
  'node_modules/@acme/hl/package.json': {
    name: '@acme/hl', version: '1.1.0', license: 'MIT', type: 'module',
    exports: { '.': { import: { types: './dist/index.d.ts', default: './dist/index.js' }, require: './dist/index.cjs' } },
    repository: 'git://example.com/acme/hl.git', dependencies: { '@acme/core': '^2.0.0' },
  },
  'node_modules/@acme/hl/dist/index.js': "export { core as hl } from '@acme/core';\n",
  'node_modules/@acme/hl/LICENCE.md': MIT,
  'node_modules/@acme/hl/COPYING': 'The same terms, again.\n',
  'node_modules/@acme/core/package.json': { name: '@acme/core', version: '2.0.0', license: 'MIT', type: 'module', exports: { import: './dist/index.js' }, repository: { type: 'git', url: 'ssh://git@example.com/acme/core.git' } },
  'node_modules/@acme/core/dist/index.js': 'export const core = 1;\n',
  'node_modules/@acme/core/LICENSE': MIT,
});
// The good tree with `edit(files)` applied.
const treeWith = (edit) => { const files = goodTree(); edit(files); return writeTree(files); };
const lockOf = (files) => files['package-lock.json'].packages;

test('C1b the npm packages a bundle may carry, over synthetic roots: a closure that builds (bytes as installed, licence and NOTICE files, copyright lines, source), nested copies that change nothing build, and every refusal\'s exact text', () => {
  // The closure that builds.
  const root = writeTree(goodTree());
  const closure = collectBundledPackages(root, new Map([['@acme/parser', 'tools/lib/uses.mjs']]));
  assert.deepEqual([...closure.keys()], ['@acme/core', '@acme/hl', '@acme/parser'], 'the root and what it imports, in code-point order');
  const parser = closure.get('@acme/parser');
  const parserBytes = readFileSync(join(root, 'node_modules', '@acme', 'parser', 'dist', 'index.es.js'));
  assert.ok(Buffer.isBuffer(parser.src) && parser.src.equals(parserBytes), 'the entry file\'s bytes, as installed');
  const { src: _src, ...parserFields } = parser;
  assert.deepEqual(parserFields, {
    name: '@acme/parser', version: '1.0.0', license: 'Apache-2.0', entry: 'dist/index.es.js', bytes: parserBytes.length, imports: ['@acme/core', '@acme/hl'],
    licenceFiles: [{ name: 'LICENSE', text: APACHE }], notice: [{ name: 'NOTICE', text: 'Acme Parser\nCopyright 2020 The Acme Authors\n' }],
    copyright: 'Copyright The Acme Authors · copyright 2020 Someone Else', source: 'https://example.com/acme/parser',
  });
  const { src: _hlSrc, ...hl } = closure.get('@acme/hl');
  assert.deepEqual(hl, {
    name: '@acme/hl', version: '1.1.0', license: 'MIT', entry: 'dist/index.js', bytes: Buffer.byteLength("export { core as hl } from '@acme/core';\n"), imports: ['@acme/core'],
    licenceFiles: [{ name: 'COPYING', text: 'The same terms, again.\n' }, { name: 'LICENCE.md', text: MIT }], notice: null, copyright: null, source: 'https://example.com/acme/hl',
  });
  assert.equal(closure.get('@acme/core').source, null, 'an ssh:// repository is not printed');
  assert.deepEqual(collectBundledPackages(root, ['@acme/parser']), closure, 'roots as names');
  assert.deepEqual(collectBundledPackages(join(TMP, 'nowhere'), []), new Map(), 'no root: nothing read');
  // The repository URL and the package name rules.
  assert.equal(sourceUrlOf('https://github.com/lezer-parser/common.git'), 'https://github.com/lezer-parser/common');
  assert.equal(sourceUrlOf({ url: 'git+https://code.haverbeke.berlin/lezer/lr.git' }), 'https://code.haverbeke.berlin/lezer/lr');
  assert.equal(sourceUrlOf('https://user:pw@example.com/x.git'), null, 'no userinfo');
  assert.equal(sourceUrlOf('github:acme/x'), null, 'a shorthand is not a URL a reader can open');
  assert.equal(sourceUrlOf(undefined), null);
  assert.equal(packageNameOf('@acme/parser/dist/x.js'), '@acme/parser');
  assert.equal(packageNameOf('left-pad/index.js'), 'left-pad');

  // Every refusal, exactly.
  const refuses = (dir, roots, message) => assert.throws(() => collectBundledPackages(dir, roots), { message: message.replaceAll('<root>', dir) });
  const parserRoot = new Map([['@acme/parser', 'tools/lib/uses.mjs']]);
  const FIX = '(npm ci --omit=dev on a build machine that needs no dev tools)';
  refuses(treeWith((f) => { delete f['package-lock.json']; }), parserRoot, 'package-lock.json is missing from <root> — the bundle inlines @acme/parser and the packages they need at the versions the committed lockfile pins: copy package-lock.json with the tree, then run npm ci there');
  refuses(treeWith((f) => { f['package-lock.json'].lockfileVersion = 1; }), parserRoot, 'package-lock.json is lockfileVersion 1; the bundle reads version 2 or 3 (npm 7 or newer)');
  refuses(treeWith((f) => { delete lockOf(f)['node_modules/@acme/parser']; }), parserRoot, '@acme/parser: package-lock.json has no node_modules/@acme/parser entry — tools/lib/uses.mjs needs it; install it (npm install) and commit the lockfile');
  refuses(treeWith((f) => { delete lockOf(f)['node_modules/@acme/hl']; }), parserRoot, '@acme/hl: package-lock.json has no node_modules/@acme/hl entry — @acme/parser needs it; install it (npm install) and commit the lockfile');
  refuses(treeWith((f) => { lockOf(f)['node_modules/@acme/hl/node_modules/@acme/core'] = { version: '1.0.0', license: 'MIT' }; }), parserRoot, '@acme/core: package-lock.json installs a second copy at node_modules/@acme/hl/node_modules/@acme/core, which @acme/hl loads instead of node_modules/@acme/core — the bundle carries one copy of each package under its own name. Make one version serve every importer: add "overrides": { "@acme/core": "2.0.0" } to package.json (npm 8.3 or newer), run npm install, and commit the lockfile');
  refuses(treeWith((f) => { delete f['node_modules/@acme/core/package.json']; }), parserRoot, `@acme/core: not installed (node_modules/@acme/core/package.json is missing in <root>) — run npm ci there ${FIX}`);
  refuses(treeWith((f) => { f['node_modules/@acme/core/package.json'].version = '2.0.1'; }), parserRoot, `@acme/core: installed 2.0.1, package-lock.json pins 2.0.0 — run npm ci there, so the bundle is built from the committed lockfile ${FIX}`);
  refuses(treeWith((f) => { f['node_modules/@acme/core/package.json'].license = 'ISC'; }), parserRoot, `@acme/core 2.0.0: package.json declares the licence ISC, package-lock.json MIT — run npm ci there ${FIX}`);
  refuses(treeWith((f) => { f['node_modules/@acme/core/package.json'].exports = { require: './dist/index.cjs' }; }), parserRoot, '@acme/core 2.0.0: package.json exports no ES module entry (exports.import or exports["."].import) — the bundle inlines ES modules only');
  refuses(treeWith((f) => { f['node_modules/@acme/parser/dist/index.es.js'] += "export { x } from '@acme/undeclared';\n"; }), parserRoot, "@acme/parser/dist/index.es.js:9: imports '@acme/undeclared', which @acme/parser does not declare in dependencies or peerDependencies");
  refuses(treeWith((f) => { f['node_modules/@acme/hl/dist/index.js'] = "import './side.js';\nexport const hl = 1;\n"; }), parserRoot, "@acme/hl/dist/index.js:1: imports './side.js' — the bundle inlines one file per package, so a package that imports a file (its own or another package's) cannot be bundled");
  refuses(treeWith((f) => { f['node_modules/@acme/hl/dist/index.js'] = "export { core as hl } from '@acme/core/dist/index.js';\n"; }), parserRoot, "@acme/hl/dist/index.js:1: imports '@acme/core/dist/index.js' — the bundle inlines one file per package, so a package that imports a file (its own or another package's) cannot be bundled");
  refuses(treeWith((f) => { f['node_modules/@acme/core/dist/index.js'] = "import { readFileSync } from 'node:fs';\nexport const core = readFileSync;\n"; }), parserRoot, "@acme/core/dist/index.js:1: imports 'node:fs' — a node:* module cannot run in a browser");
  refuses(treeWith((f) => { f['node_modules/@acme/core/LICENSE'] = 'MIT\n</script><script>alert(1)</script>\n'; }), parserRoot, '@acme/core 2.0.0: LICENSE contains "</script" and cannot be embedded in the bundle\'s licence block');
  refuses(treeWith((f) => { f['node_modules/@acme/parser/NOTICE'] = 'Acme <!-- hidden -->\n'; }), parserRoot, '@acme/parser 1.0.0: NOTICE contains "<!--" and cannot be embedded in the bundle\'s licence block');
  refuses(treeWith((f) => { delete f['node_modules/@acme/core/LICENSE']; }), parserRoot, '@acme/core 2.0.0 ships no licence file (LICENSE, LICENCE or COPYING at its root) — the bundle redistributes it and must carry its licence; review the dependency before bundling it');
  refuses(treeWith((f) => { lockOf(f)['node_modules/lib'] = { version: '1.0.0', license: 'MIT' }; }), ['lib'], 'lib: a package named lib or studio collides with the bundle\'s own import-map keys');
  // The three holes the design's list leaves, each with a fix.
  refuses(treeWith((f) => { delete f['node_modules/@acme/core/package.json'].license; delete lockOf(f)['node_modules/@acme/core'].license; }), parserRoot, '@acme/core 2.0.0 declares no licence (a "license" SPDX id in its package.json) — the bundle redistributes it and must name its licence; review the dependency before bundling it');
  refuses(treeWith((f) => { f['node_modules/@acme/core/package.json'] = '{ not json'; }), parserRoot, `@acme/core: node_modules/@acme/core/package.json does not parse (${(() => { try { JSON.parse('{ not json'); } catch (e) { return e.message; } return ''; })()}) — run npm ci there ${FIX}`);
  refuses(treeWith((f) => { delete f['node_modules/@acme/core/dist/index.js']; }), parserRoot, `@acme/core 2.0.0: its entry dist/index.js is not installed (node_modules/@acme/core/dist/index.js is missing in <root>) — run npm ci there ${FIX}`);

  // R-a, R-b and the manifest's refusals (L-p, L-q) through collectModuleGraph: a tools/lib module's bare import is read
  // against VENDOR-MANIFEST.json's npm field, which is read at the first bare import met.
  const sources = { 'studio/app.mjs': "import { p } from '../tools/lib/uses.mjs';\nexport const a = p;\n", 'tools/lib/uses.mjs': "import { parser } from '@acme/parser';\nexport const p = parser;\n" };
  const read = (rel) => { if (!(rel in sources)) throw new Error(`module file missing: ${rel}`); return sources[rel]; };
  const graph = collectModuleGraph(root, ['studio/app.mjs'], { read });
  assert.deepEqual([...graph.packages], ['@acme/parser'], 'the manifest lists it: accepted');
  const noManifest = treeWith((f) => { delete f['VENDOR-MANIFEST.json']; });
  assert.throws(() => collectModuleGraph(noManifest, ['studio/app.mjs'], { read }), { message: `VENDOR-MANIFEST.json is missing from ${noManifest} — copy it with the tree: it names the npm packages each tools/lib module may import, which the bundle inlines` });
  assert.equal(collectModuleGraph(noManifest, ['studio/app.mjs'], { read: (rel) => (rel === 'studio/app.mjs' ? 'export const a = 1;\n' : read(rel)) }).packages.size, 0, 'no bare import, no manifest read');
  const badManifest = treeWith((f) => { f['VENDOR-MANIFEST.json'] = '{'; });
  assert.throws(() => collectModuleGraph(badManifest, ['studio/app.mjs'], { read }), (e) => e.message.startsWith(`VENDOR-MANIFEST.json in ${badManifest} does not parse (`) && e.message.endsWith(') — restore it from the same upstream commit as the tree, or regenerate it there (npm run vendor-manifest)'));
  assert.throws(() => collectModuleGraph(root, ['studio/app.mjs'], { read, npmOf: () => [] }), { message: "tools/lib/uses.mjs:1: cannot inline the specifier '@acme/parser' — a package is bundled only when VENDOR-MANIFEST.json lists it in this module's npm field (a package.json dependency; npm run vendor-manifest)" });
  sources['tools/lib/uses.mjs'] = "import { parser } from '@acme/parser/dist/index.es.js';\nexport const p = parser;\n";
  assert.throws(() => collectModuleGraph(root, ['studio/app.mjs'], { read }), { message: "tools/lib/uses.mjs:1: cannot inline the specifier '@acme/parser/dist/index.es.js' — a package is bundled by its own name (@acme/parser), never a file inside it" });
});

// ---------- C6 retrofeed in the shim ----------

test('C6 retrofeed in the shim: the server\'s answer for computed pairs with and without keys (the clock pinned), the two 404s and every body rule of its parsers — status, reason phrase, content type, Cache-Control, nosniff and raw text; a failed --pack-url pack, an engine import retried, a baked taxonomy not bound', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'observogram-bundle-retrofeed-'));
  const child = await serve(ws, { env: { OBSERVOGRAM_AUTH: 'off' } });
  t.after(async () => { await child.stop(); rmSync(ws, { recursive: true, force: true }); });
  const schema = JSON.parse(read(SPEC_SCHEMA_PATH));
  const register = async (body, contentType, source = '') => {
    const r = await fetch(`${child.base}/api/validate${source ? `?source=${encodeURIComponent(source)}` : ''}`, { method: 'POST', headers: { 'Content-Type': contentType }, body }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    return r.registered.id;
  };
  const payment = parseYaml(read(PAYMENT));
  const snapshot = JSON.parse(read('tools/fixtures/golden/snapshot/snapshot.pack.json'));
  const golden = JSON.parse(read(GOLDEN));
  const modesA = read('tools/fixtures/compare-modes/a.pack.yaml');
  const modesB = read('tools/fixtures/compare-modes/b.pack.yaml');
  const scopedAll = { ...payment, metadata: { ...payment.metadata, name: 'scoped-all', annotations: { ...(payment.metadata.annotations || {}), 'observogram.diff.scopeMode': 'all' } } };
  const ids = {
    payment: 'payment-service',
    curated: 'production-curated',
    snapshot: await register(JSON.stringify(snapshot), 'application/json'),
    golden: await register(JSON.stringify(golden), 'application/json'),
    modesA: await register(modesA, 'text/yaml', 'compare-modes-a.pack.yaml'),
    modesB: await register(modesB, 'text/yaml', 'compare-modes-b.pack.yaml'),
    scopedAll: await register(JSON.stringify(scopedAll), 'application/json'),
  };
  let now = '2026-01-01T00:00:00.000Z';
  const backend = createStaticBackend({
    version: VERSION, schema,
    packs: [
      { id: ids.payment, label: 'payment', canonical: payment },
      { id: ids.curated, label: 'curated', canonical: parseYaml(read('examples/production-curated.pack.yaml')) },
      { id: ids.snapshot, label: 'snapshot', canonical: snapshot },
      { id: ids.golden, label: 'golden', canonical: golden },
      { id: ids.modesA, label: 'a', canonical: parseYaml(modesA) },
      { id: ids.modesB, label: 'b', canonical: parseYaml(modesB) },
      { id: ids.scopedAll, label: 'scoped-all', canonical: scopedAll },
    ],
  }, { clock: () => now });
  const answer = async (r) => ({ status: r.status, statusText: r.statusText, type: r.headers.get('content-type'), cacheControl: r.headers.get('cache-control'), nosniff: r.headers.get('x-content-type-options'), text: await r.text() });
  // The timestamp the server stamped, read from its raw JSON text (an ISO instant: no quote, no escaped newline).
  const ADOPTED_AT = /observogram\.retrofeed\.adoptedAt: '?(\d{4}-\d\d-\d\dT[\d:.]+Z)/;
  // One request to both sides: the server's answer first, whose adoptedAt (if it stamped one) the shim's clock takes.
  const same = async (label, path, init) => {
    const server = await answer(await fetch(`${child.base}${path}`, init));
    now = ADOPTED_AT.exec(server.text)?.[1] ?? now;
    const shim = await answer(await backend.handle(path, init));
    assert.deepEqual(shim, server, label);
    return server;
  };
  const post = (body, headers = {}) => ({ method: 'POST', headers, body });
  const JSON_HEADERS = { 'Content-Type': 'application/json' };
  const rf = (id) => `/api/packs/${encodeURIComponent(id)}/retrofeed`;

  // Computed: three pairs, with and without keys (the base identity matches a suffixed key).
  for (const [a, b] of [[ids.payment, ids.snapshot], [ids.golden, ids.curated], [ids.modesA, ids.modesB]]) {
    const full = await same(`${a} → ${b}`, rf(a), post(JSON.stringify({ packBId: b }), JSON_HEADERS));
    const summary = JSON.parse(full.text).summary;
    assert.equal(full.status, 200);
    const byId = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
    const canonicalOf = { payment, snapshot, golden, curated: parseYaml(read('examples/production-curated.pack.yaml')), modesA: parseYaml(modesA), modesB: parseYaml(modesB) };
    const onlyInB = Object.values(diffPacks(adapt(canonicalOf[byId[a]]), adapt(canonicalOf[byId[b]]), {}).layers || {}).flatMap((l) => l.onlyInB || []);
    assert.equal(summary.candidates, onlyInB.length, `${a} → ${b}: the server's candidates are the diff's onlyInB`);
    if (!onlyInB.length) continue;
    const keyed = await same(`${a} → ${b} keys`, rf(a), post(JSON.stringify({ packBId: b, keys: [onlyInB[0].key, `${onlyInB[0].key.replace(/#\d+$/, '')}#7`] }), JSON_HEADERS));
    assert.ok(JSON.parse(keyed.text).summary.candidates >= 1 && JSON.parse(keyed.text).summary.candidates < summary.candidates || onlyInB.length === 1, `${a} → ${b}: keys narrow the candidates`);
  }
  assert.ok(ADOPTED_AT.test((await answer(await backend.handle(rf(ids.payment), post(JSON.stringify({ packBId: ids.snapshot }), JSON_HEADERS)))).text), 'payment-service → the snapshot adopts, so the pinned clock is what made the texts equal');
  // No annotation fallback: scoped-all annotates scopeMode all, and without a scopeMode in the body the diff is the
  // default scope's (fewer candidates than with scopeMode: 'all' — the case bites).
  const unscoped = JSON.parse((await same('scoped-all → snapshot, no scopeMode', rf(ids.scopedAll), post(JSON.stringify({ packBId: ids.snapshot }), JSON_HEADERS))).text);
  const scopedAllAnswer = JSON.parse((await same('scoped-all → snapshot, scopeMode all', rf(ids.scopedAll), post(JSON.stringify({ packBId: ids.snapshot, scopeMode: 'all' }), JSON_HEADERS))).text);
  assert.ok(unscoped.summary.candidates < scopedAllAnswer.summary.candidates, `no fallback to the annotation (${unscoped.summary.candidates} < ${scopedAllAnswer.summary.candidates})`);
  await same('environments and a service', rf(ids.payment), post(JSON.stringify({ packBId: ids.snapshot, aEnv: 'prod', bEnv: '', scopeMode: 'family', service: 'payment-service' }), JSON_HEADERS));

  // The two 404s, and the body read before the pack is looked up (the parsers run before any route).
  await same('unknown A', rf('nope'), post(JSON.stringify({ packBId: ids.snapshot }), JSON_HEADERS));
  await same('unknown B', rf(ids.payment), post(JSON.stringify({ packBId: 'nope' }), JSON_HEADERS));
  await same('unknown B, an object id', rf(ids.payment), post(JSON.stringify({ packBId: { x: 1 } }), JSON_HEADERS));
  await same('unknown A, a malformed body', rf('nope'), post('null', JSON_HEADERS));

  // The body rules, case by case.
  const B = JSON.stringify({ packBId: ids.snapshot });
  for (const [label, body, headers] of [
    ['JSON empty → {}', '', JSON_HEADERS],
    ['JSON blank → 400', '   ', JSON_HEADERS],
    ['JSON null → 400 (strict)', 'null', JSON_HEADERS],
    ['JSON 5 → 400 (strict)', '5', JSON_HEADERS],
    ['JSON "x" → 400 (strict)', '"x"', JSON_HEADERS],
    ['JSON [1] → an array reaches the handler', '[1]', JSON_HEADERS],
    ['JSON after whitespace', ` \t\r\n${B}`, JSON_HEADERS],
    ['JSON malformed → 400', '{"packBId":', JSON_HEADERS],
    ['JSON latin1 → 415', B, { 'Content-Type': 'application/json; charset=latin1' }],
    ['JSON any case', B, { 'Content-Type': 'APPLICATION/JSON; charset=utf-8' }],
    ['text/json is not parsed', B, { 'Content-Type': 'text/json' }],
    ['application/vnd.api+json is not parsed', B, { 'Content-Type': 'application/vnd.api+json' }],
    ['text/plain is a string', B, { 'Content-Type': 'text/plain' }],
    ['no Content-Type: fetch says text/plain', B, {}],
    ['a form computes', `packBId=${encodeURIComponent(ids.snapshot)}&scopeMode=all`, { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['a form, keys once (a string: no filter)', `packBId=${encodeURIComponent(ids.snapshot)}&keys=x`, { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['a form, keys repeated (an array)', `packBId=${encodeURIComponent(ids.snapshot)}&keys=x&keys=y`, { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['a form, __proto__ and an empty name dropped', `__proto__=x&=y&packBId=${encodeURIComponent(ids.snapshot)}`, { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['a form, a bracketed name', `%5BpackBId%5D=${encodeURIComponent(ids.snapshot)}`, { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['a form, packBId repeated', 'packBId=a&packBId=b', { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['a form, a malformed escape kept', 'packBId=%E0%A4%A+x', { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['a form in iso-8859-1', 'packBId=pay%E9', { 'Content-Type': 'application/x-www-form-urlencoded; charset=iso-8859-1' }],
    ['a form in koi8-r → 415', 'packBId=x', { 'Content-Type': 'application/x-www-form-urlencoded; charset=koi8-r' }],
    ['a form over 1000 parameters → 413', Array.from({ length: 1001 }, (_, i) => `k${i}=1`).join('&'), { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['a form over 64 KiB → 413', `packBId=${'x'.repeat(64 * 1024)}`, { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['text over 4 MiB → 413', 'x'.repeat(4 * 1024 * 1024 + 1), { 'Content-Type': 'text/yaml' }],
    ['JSON over 16 MiB → 413', ' '.repeat(16 * 1024 * 1024 + 1), JSON_HEADERS],
  ]) await same(label, rf(ids.payment), post(body, headers));
  const form = new FormData();
  form.set('packBId', ids.snapshot);
  await same('multipart/form-data is not parsed', rf(ids.payment), { method: 'POST', body: form });

  // What only the shim meets. A --pack-url pack that failed to load: 500 with its message.
  const failing = createStaticBackend({ version: VERSION, schema, packs: [{ id: 'p', label: 'P', canonical: payment }, { id: 'remote', label: 'R', url: 'https://packs.example/r.pack.yaml' }] }, {
    origin: 'https://studio.example', fetchImpl: async () => new Response('nope', { status: 404, statusText: 'Not Found' }),
  });
  await failing.handle('/api/packs');
  const failed = await failing.handle(rf('p'), post(JSON.stringify({ packBId: 'remote' }), JSON_HEADERS));
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { ok: false, error: '404 Not Found fetching https://packs.example/r.pack.yaml' });
  // An engine import that fails once: 500 with its message, and the next call imports again and answers.
  let attempts = 0;
  const flaky = createStaticBackend({ version: VERSION, schema, packs: [{ id: 'p', label: 'P', canonical: payment }] }, {
    importRetrofeedEngines: () => (++attempts === 1 ? Promise.reject(new Error('Failed to fetch dynamically imported module')) : Promise.all([import('./lib/diff.mjs'), import('./lib/retrofeed.mjs')])),
  });
  const first = await flaky.handle(rf('p'), post(JSON.stringify({ packBId: 'p' }), JSON_HEADERS));
  assert.equal(first.status, 500);
  assert.deepEqual(await first.json(), { ok: false, error: 'Failed to fetch dynamically imported module' });
  const second = await flaky.handle(rf('p'), post(JSON.stringify({ packBId: 'p' }), JSON_HEADERS));
  assert.equal(second.status, 200, 'a failed import is not kept');
  assert.equal(attempts, 2);
  // A baked taxonomy the classifier does not hold (the studio's bind failed in this page): 500 naming it, before any
  // computation — an answer classified by the default families would not be the server's.
  const taxonomy = JSON.parse(read('tools/fixtures/taxonomy/taxonomy.json'));
  const unbound = createStaticBackend({ version: VERSION, schema, taxonomy, packs: [{ id: 'p', label: 'P', canonical: payment }] });
  const guarded = await unbound.handle(rf('p'), post(JSON.stringify({ packBId: 'p' }), JSON_HEADERS));
  assert.equal(guarded.status, 500);
  assert.deepEqual(await guarded.json(), { ok: false, error: 'the artefact taxonomy built into this bundle did not bind in this page, so this answer would not be the one a server with that taxonomy gives — open the file in a Chromium-based browser, where it is proven to bind, or ask whoever built it for a build whose taxonomy this browser compiles' });
});
