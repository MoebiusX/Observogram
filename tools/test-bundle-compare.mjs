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
// A flat suite of top-level test( calls. Every CLI spawn gets serve-child's
// stripped env (childEnv), so a developer shell bakes nothing.
//
// Run: node --test tools/test-bundle-compare.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  DEFAULT_ROOT, LICENCES_ID, inlineJson, licenceBlockText, pointerComment, readOwnNotices, verifyBundleNotices,
} from './build-studio-bundle.mjs';
import { childEnv } from '../server/fixtures/serve-child.mjs';

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
