#!/usr/bin/env node
// tools/test-bundle-compare.mjs — Compare in the static bundle, and what the
// bundle carries with it (follow-up compare-in-bundle; docs/DOWNSTREAM.md §10).
//
// C1 the closure on the real tree: the bundle's graph has one package root,
// @prometheus-io/lezer-promql (VENDOR-MANIFEST.json's npm field for
// tools/lib/promql-lezer.mjs, which tools/lib/traceability-graph.mjs imports
// and the shim's Compare route loads); its closure is the four packages, each
// at the lockfile's version, each embedded byte for byte as installed (the
// entry file, and the import-map address a build writes for it), each with
// its normalised source repository; and the licence pin — THIRD_PARTY below,
// each package's SPDX id, the sha256 of each licence file and its NOTICE
// files — equals what is installed, so a licence change fails here until
// someone reviews it (a synthetic root with one byte of one LICENSE changed
// shows the pin bites).
//
// C2 the licence block: a two-pack bundle built through the CLI carries one
// `<script type="text/plain" id="observogram-licenses">` element at the end
// of <head> — the preamble, Observogram's LICENSE verbatim, one section per
// bundled package (name, version, SPDX id, File:, Source:, the copyright line
// lezer-promql's file carries, each licence file as installed), the spec's
// provenance from vendor/observability-pack-spec/VERSIONS.json — and one
// pointer comment right after the doctype, worded for a file that carries
// third-party packages; no path of the build machine; verifyBundleNotices
// accepts the file and names each problem of a damaged one (the element
// removed, doubled or moved to <body>, the MIT grant or disclaimer gone, a
// package's section removed, a section for a package the import map does
// not carry, a package without its File: line or licence text, a pointer
// comment worded for the other case), and accepts what a minifier does
// (comments stripped, attributes reordered). The tree's refusals: no
// LICENSE, a licence text that cannot be embedded, no VERSIONS.json
// provenance.
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
// C3 GET /api/diff from the source, body for body, against a child server
// (serve(ws, { env: { OBSERVOGRAM_AUTH: 'off' } })) over the same packs under
// the server's ids — its six, and nine registered through POST /api/validate
// (the golden crawl, the two compare-modes packs, the library-built orders
// pack, the live snapshot, krystaline, and two derived from payment-service
// that annotate a scope mode: scoped-all in observogram.diff.scopeMode,
// scoped-legacy in the legacy tomograph.diff.scopeMode). "Equal" is the same
// status, reason phrase, content type, Cache-Control, Content-Disposition,
// X-Content-Type-Options and raw body text. M2 every scopeMode spelling ×
// four service values on four pairs (an empty scopeMode falls back to the
// annotation, a repeated one is absent); M3 the environments; M4 every
// refusal (the 400s, A's 404 before B's, an encoded id, a malformed escape);
// M5 the largest answers (krystaline) and a live pack (the snapshot), both
// ways. M1 — every ordered pair of ten packs in each scope mode the studio
// sends — is tools/test-bundle-compare-pairs.mjs, so it runs beside this
// file. Then what only the shim can meet: a --pack-url pack that failed to
// load (500, its message), one that fails the schema but adapts (diffed: the
// server's route validates nothing), an engine import that fails once (500,
// then retried).
//
// C3b the taxonomy: a child started with OBSERVOGRAM_TAXONOMY and this
// process bound to the same document through studio/taxonomy.mjs answer the
// typed canonical against itself and against payment-service, both ways,
// equally (and differently from the default families: the bind is what the
// answers rest on); a shim whose baked taxonomy the classifier does not hold
// refuses the diff and retrofeed with the guard's 500, naming why it did not
// compile when it does not.
//
// C4 Pair by: over the compare-modes pair, the studio's re-key
// (studio/compare-identity.mjs viewDiffFor, the same engines it loads) over
// the shim's /api/packs/:id and /api/diff bodies equals the re-key over the
// server's, by name and by id — 5/15/5, 4/16/4, 3/17/3 (only in A, in both,
// only in B), the counts the live studio draws.
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
// C8 the bundle in Chromium (skips like tools/test-studio-bundle.mjs T7 when
// Playwright or its browser is missing, unless OBSERVOGRAM_BUNDLE_SMOKE=require;
// OBSERVOGRAM_PLAYWRIGHT names Playwright's index.mjs): a CLI-built bundle
// carrying payment-service, the live snapshot (payment-live), the
// compare-modes pair, production-curated and payment-linked (payment-service
// with a remediation linked to its burn-rate alert — no example pack links
// one, and without a link the response path draws no deploy button), served
// from a loopback host. The in-page fetch('/api/diff?…') text equals the
// child server's for six queries under the browser locales en-US, cs-CZ and
// et-EE, each page shown to collate by its locale; Compare on the
// compare-modes pair draws 5/15/5, Pair by name 4/16/4 and id 3/17/3;
// Diagnose → Assessment → Comparison over payment-service and the live pack
// draws the drift drill's deploy aria-disabled with the reason, and a click
// explains it and opens no modal; its retrofeed downloads the updated pack a
// server returns for the request the page sent; Remediate draws its decision
// header's deploy and the response path's per-SLO button the same way; rows
// 4 (a one-pack bundle), 6, 11 and 12 render as written, and the rendered
// Compare, Diagnose, Traceability and Remediate hold no phrase S4 holds the
// studio's source to; the Conformance view's HTML anchor downloads the report
// with its goes-blind section, and the in-page JSON and HTML are the
// server's but for C5's declared fields; the notice, exactly; no page error
// or console.error, no request off the loopback, each static host asked for
// / only.
//
// C9 the built file, in Node: a bundle built through the CLI (the six server
// packs and the compare-modes pair); its import map read from the file and
// applied by a module.register resolve hook (each key, asked for by a data:
// module, → its data: address); studio/static-backend.mjs imported from its
// data: address with the file's config. Against the child server: twelve
// /api/diff queries and one retrofeed, equal — so the artifact links (the map
// carries every package, each address decodes to the installed bytes, the
// shim's dynamic imports are literal) and answers as the server does.
//
// A flat suite of top-level test( calls. Every CLI spawn gets serve-child's
// stripped env (childEnv), so a developer shell bakes nothing.
//
// Run: node --test tools/test-bundle-compare.mjs
//
// `document` and `window` are named only inside page.evaluate callbacks, which run in the browser.
/* global document, window */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  DEFAULT_ROOT, ENTRIES, CONFIG_ID, LICENCES_ID, inlineJson, licenceBlockText, pointerComment, readOwnNotices, verifyBundleNotices,
  collectBundledPackages, collectModuleGraph, sourceUrlOf, packageNameOf, buildStudioBundle,
} from './build-studio-bundle.mjs';
import { childEnv, serve } from '../server/fixtures/serve-child.mjs';
import { createStaticBackend, bundleStyles, noticeText } from '../studio/static-backend.mjs';
import { serverNeeded, staticRemedy } from '../studio/static-remedies.mjs';
import { viewDiffFor } from '../studio/compare-identity.mjs';
import { bindTaxonomy } from '../studio/taxonomy.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { adapt } from './lib/adapter.mjs';
import { renderAuditReportHtml } from './lib/audit-report.mjs';
import { DEFAULT_BRAND, normalizeBrand } from './lib/brand.mjs';
import * as artefactClassify from './lib/artefact-classify.mjs';
import * as diffLib from './lib/diff.mjs';
import * as identityLib from './lib/identity-modes.mjs';
import { comparePackBranches } from './lib/traceability-graph.mjs';
import { SPEC_SCHEMA_PATH } from './lib/validator.mjs';

const { diffPacks } = diffLib;

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

// ---------- C1 the closure, on the real tree ----------

// The packages a bundle carries — the closure of the one root the bundle's graph imports — with the measured entry
// file and the source repository each package.json publishes.
const PACKAGES = {
  '@lezer/common': { entry: 'dist/index.js', source: 'https://github.com/lezer-parser/common' },
  '@lezer/highlight': { entry: 'dist/index.js', source: 'https://github.com/lezer-parser/highlight' },
  '@lezer/lr': { entry: 'dist/index.js', source: 'https://code.haverbeke.berlin/lezer/lr' },
  '@prometheus-io/lezer-promql': { entry: 'dist/index.es.js', source: 'https://github.com/prometheus/prometheus' },
};
const FOUR = Object.keys(PACKAGES);
// The licence pin (decision Q7 (a)): each bundled package's SPDX id, the sha256 of each licence file at its root and of
// each NOTICE file it ships (none does). A change of any of them fails C1 until someone reviews it and updates this
// table; a version bump that changes no licence text passes (the lockfile's own review covers it).
const MIT_LEZER = '568902fb66eaf1f11750e966b33fd7b5d7c618e65af09f35ef843635bcf5f1ba';
const THIRD_PARTY = {
  '@lezer/common': { license: 'MIT', files: { LICENSE: MIT_LEZER }, notice: null },
  '@lezer/highlight': { license: 'MIT', files: { LICENSE: MIT_LEZER }, notice: null },
  '@lezer/lr': { license: 'MIT', files: { LICENSE: MIT_LEZER }, notice: null },
  '@prometheus-io/lezer-promql': { license: 'Apache-2.0', files: { LICENSE: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4' }, notice: null },
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const packageDir = (root, name) => join(root, 'node_modules', ...name.split('/'));
// What `root` has installed for each package of a closure, in THIRD_PARTY's shape: the licence and NOTICE files'
// bytes as they are on disk.
const licencesOf = (root, closure) => Object.fromEntries([...closure.values()].map((p) => [p.name, {
  license: p.license,
  files: Object.fromEntries(p.licenceFiles.map((f) => [f.name, sha256(readFileSync(join(packageDir(root, p.name), f.name)))])),
  notice: p.notice ? Object.fromEntries(p.notice.map((f) => [f.name, sha256(readFileSync(join(packageDir(root, p.name), f.name)))])) : null,
}]));
// The entries of two pins that differ, one sentence each.
const pinChanges = (pinned, installed) => [...new Set([...Object.keys(pinned), ...Object.keys(installed)])].sort()
  .filter((name) => JSON.stringify(pinned[name] ?? null) !== JSON.stringify(installed[name] ?? null))
  .map((name) => `${name}: pinned ${JSON.stringify(pinned[name] ?? null)}, installed ${JSON.stringify(installed[name] ?? null)}`);
const pinMessage = (changes) => `the bundled packages' licences changed (${changes.join('; ')}) — review the change, then update THIRD_PARTY in tools/test-bundle-compare.mjs`;
const importMapOf = (html) => JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]).imports;
const DATA_JS = 'data:text/javascript;base64,';
const decode = (address) => { assert.ok(address.startsWith(DATA_JS), address.slice(0, 40)); return Buffer.from(address.slice(DATA_JS.length), 'base64'); };

test('C1 the closure on the real tree: the graph\'s one package root, the four packages at the lockfile\'s versions, each embedded byte for byte as installed, each source; the licence pin, which a changed LICENSE byte fails', () => {
  const graph = collectModuleGraph(ROOT, ENTRIES);
  assert.deepEqual([...graph.packages], ['@prometheus-io/lezer-promql'], 'one root: tools/lib/promql-lezer.mjs\'s npm field');
  assert.deepEqual(graph.get('lib/promql-lezer.mjs').imports.filter((i) => i.package), [{ spec: '@prometheus-io/lezer-promql', key: '@prometheus-io/lezer-promql', package: '@prometheus-io/lezer-promql' }]);
  const closure = collectBundledPackages(ROOT, graph.packages);
  assert.deepEqual([...closure.keys()], FOUR, 'the root and what it imports, in code-point order');
  const lock = JSON.parse(read('package-lock.json')).packages;
  const built = buildStudioBundle({ root: ROOT, packs: [], builtAt: 'x' });
  const imports = importMapOf(built.html);
  assert.deepEqual(Object.keys(imports).slice(-4), FOUR, 'the four, last in the import map, under their own names');
  for (const [name, p] of closure) {
    assert.equal(p.version, lock[`node_modules/${name}`].version, `${name}: the lockfile's version`);
    assert.equal(p.entry, PACKAGES[name].entry, `${name}: its ES module entry`);
    const installed = readFileSync(join(packageDir(ROOT, name), ...p.entry.split('/')));
    assert.ok(p.src.equals(installed), `${name}: the entry file's bytes as installed`);
    assert.ok(decode(imports[name]).equals(installed), `${name}: the import-map address decodes to the installed bytes — the build changes nothing`);
    assert.equal(p.source, PACKAGES[name].source, `${name}: its source repository, normalised`);
  }
  assert.deepEqual(closure.get('@prometheus-io/lezer-promql').imports, ['@lezer/highlight', '@lezer/lr']);
  assert.deepEqual(closure.get('@lezer/lr').imports, ['@lezer/common']);
  assert.deepEqual(built.thirdParty.map((p) => p.name), FOUR);

  // The licence pin.
  const changes = pinChanges(THIRD_PARTY, licencesOf(ROOT, closure));
  assert.deepEqual(changes, [], pinMessage(changes));
  // It bites: the same four installed in a synthetic root, one byte of @lezer/lr's LICENSE changed.
  const root = mkdtempSync(join(TMP, 'pin-'));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: Object.fromEntries(FOUR.map((n) => [`node_modules/${n}`, lock[`node_modules/${n}`]])) }));
  for (const name of FOUR) cpSync(packageDir(ROOT, name), packageDir(root, name), { recursive: true, dereference: true });
  const licence = join(packageDir(root, '@lezer/lr'), 'LICENSE');
  writeFileSync(licence, readFileSync(licence, 'utf8').replace('Permission', 'permission'));
  const changed = pinChanges(THIRD_PARTY, licencesOf(root, collectBundledPackages(root, ['@prometheus-io/lezer-promql'])));
  assert.equal(changed.length, 1);
  assert.match(changed[0], /^@lezer\/lr: pinned \{"license":"MIT","files":\{"LICENSE":"568902fb[0-9a-f]+"\},"notice":null\}, installed \{"license":"MIT","files":\{"LICENSE":"(?!568902fb)[0-9a-f]{64}"\},"notice":null\}$/);
  assert.match(pinMessage(changed), /^the bundled packages' licences changed \(@lezer\/lr: .*\) — review the change, then update THIRD_PARTY in tools\/test-bundle-compare\.mjs$/);
});

// ---------- C2 the licence block ----------

test('C2 the licence block: one text/plain element ending <head> — the preamble, Observogram\'s LICENSE verbatim, the four packages\' sections with their licence files as installed, the spec\'s provenance — the pointer comment after the doctype, no build-machine path; verifyBundleNotices accepts the file, names every damage and survives a minifier; the tree\'s refusals', () => {
  const out = join(TMP, 'c2', 'index.html');
  const built = cli(['--pack', resolve(ROOT, PAYMENT), '--pack', resolve(ROOT, GOLDEN), '--id', 'golden', '--out', out, '--no-remote-fonts']);
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /^wrote .* — \d+ modules · 16 stylesheets · \d+ bytes · 2 packs\n$/, 'the human line is unchanged');
  const html = readFileSync(out, 'utf8');

  // Where: one element, the last thing in <head>; one pointer comment, right after the doctype, worded for packages.
  assert.equal(html.split(`${OPEN}\n`).length - 1, 1, 'exactly one element');
  const at = html.indexOf(`${OPEN}\n`);
  assert.ok(at > html.indexOf('<head>') && html.indexOf('</script>\n</head>', at) === html.indexOf('</script>', at), 'the element closes right before </head>');
  assert.ok(html.startsWith(`<!doctype html>\n${pointerComment(true)}\n<html`), 'the pointer comment is the line after the doctype');
  assert.equal(pointerComment(true), `<!-- Licences: this file contains Observogram (MIT) and third-party packages; their full texts are in the ${OPEN} element in the head. -->`);
  assert.equal(pointerComment(false), `<!-- Licence: this file contains Observogram (MIT) and no third-party package; its full text is in the ${OPEN} element in the head. -->`);
  assert.equal(html.split('<!-- Licence').length - 1, 1, 'one pointer comment');

  // What: the preamble for a file with packages, Observogram's LICENSE verbatim, each package's section — its version
  // the lockfile's, each licence file as installed, the copyright line lezer-promql's file carries (the @lezer files
  // carry none) — and the spec's provenance; exactly.
  const block = blockOf(html);
  const lock = JSON.parse(read('package-lock.json')).packages;
  const installedText = (name, file) => readFileSync(join(packageDir(ROOT, name), file), 'utf8');
  const withEnd = (t) => (t.endsWith('\n') ? t : `${t}\n`);
  const section = (name, license, copyright) => [
    `==== ${name} ${lock[`node_modules/${name}`].version} — ${license} ====`,
    `File: ${PACKAGES[name].entry} (import-map entry "${name}"), as installed.`,
    `Source: ${PACKAGES[name].source}`,
    ...(copyright ? [`Copyright lines in the file: ${copyright}`] : []),
    '---- LICENSE ----',
    withEnd(installedText(name, 'LICENSE')),
  ].join('\n');
  assert.equal(block, [
    `This file is a build of the Observogram studio, version ${VERSION} (tools/build-studio-bundle.mjs).`,
    "It contains Observogram's code and the third-party packages listed below, each with its",
    "licence in full. Each package's file is one entry of this file's import map, embedded as",
    'npm ci installed it from package-lock.json: this build changes nothing in it, and does not',
    'compare it with the package the registry publishes. Licence and NOTICE files are the ones',
    'the published package contains.',
    '',
    `==== Observogram ${VERSION} — MIT ====`,
    withEnd(LICENSE),
    section('@lezer/common', 'MIT'),
    section('@lezer/highlight', 'MIT'),
    section('@lezer/lr', 'MIT'),
    section('@prometheus-io/lezer-promql', 'Apache-2.0', 'Copyright The Prometheus Authors'),
    '==== The ObservabilityPack spec ====',
    "The spec schema embedded in this file (and any pack built in from the spec's examples) comes",
    `from ${UPSTREAM.repo} at commit ${UPSTREAM.commit}; that`,
    'repository publishes no licence file.',
    '',
  ].join('\n'));
  assert.ok(block.includes(LICENSE), 'LICENSE verbatim');
  for (const name of FOUR) assert.ok(block.includes(installedText(name, 'LICENSE')), `${name}'s LICENSE verbatim`);
  assert.ok(block.includes('Apache License') && block.includes('Version 2.0, January 2004'), 'the Apache-2.0 terms, for lezer-promql');
  assert.equal(block.split('Copyright lines in the file:').length - 1, 1, 'a copyright line for lezer-promql only');
  assert.equal(UPSTREAM.repo, 'MoebiusX/otel-observability-pack');
  assert.match(UPSTREAM.commit, /^[0-9a-f]{40}$/);
  assert.ok(!html.includes(ROOT) && !html.includes(TMP), 'no path of the build machine in the file');

  // The checker accepts the file as built.
  assert.deepEqual(verifyBundleNotices(html), { ok: true, packages: FOUR, problems: [] });

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
  const highlight = section('@lezer/highlight', 'MIT');
  assert.ok(html.includes(`${highlight}\n`));
  assert.deepEqual(problemsOf(html.replace(`${highlight}\n`, '')), ['@lezer/highlight: no licence section (==== @lezer/highlight <version> — <licence id> ====)'], 'a package\'s section removed');
  const stray = html.replace('==== The ObservabilityPack spec ====', '==== left-pad 1.3.0 — WTFPL ====\nFile: index.js (import-map entry "left-pad"), as installed.\n---- LICENSE ----\ntext\n\n==== The ObservabilityPack spec ====');
  assert.deepEqual(problemsOf(stray), ['left-pad: a licence section for a package the import map does not carry']);
  assert.deepEqual(problemsOf(html.replace(pointerComment(true), pointerComment(false))), [`the licence pointer comment is worded for no third-party package; the import map carries ${FOUR.join(', ')}`], 'the no-package comment on a file with packages');
  assert.equal(verifyBundleNotices(html.replace(/<script type="importmap">/, '<script type="importmap-x">')).problems[0], 'the file has no import map');

  // What a minifier does is not damage: the comment stripped, the attributes reordered and unquoted.
  const minified = html.replace(`${pointerComment(true)}\n`, '').replace(OPEN, `<script id=${LICENCES_ID} type=text/plain>`);
  assert.deepEqual(verifyBundleNotices(minified), { ok: true, packages: FOUR, problems: [] });

  // The package section's parts, over a synthetic package pair on the same file stripped of its four: the header
  // (name, version, SPDX id), File:, Source:, the copyright lines, each licence and NOTICE file under its own heading —
  // in code-point order of the package name.
  const own = readOwnNotices(ROOT, VERSION);
  assert.equal(own.licence, LICENSE);
  assert.deepEqual(own.spec, { repo: UPSTREAM.repo, commit: UPSTREAM.commit });
  const imports = importMapOf(html);
  const withMap = (h, names) => h.replace(/<script type="importmap">[\s\S]*?<\/script>/, () => `<script type="importmap">${inlineJson({ imports: { ...Object.fromEntries(Object.entries(imports).filter(([k]) => k.startsWith('studio/') || k.startsWith('lib/'))), ...Object.fromEntries(names.map((n) => [n, DATA_JS])) } })}</script>`);
  const bare = withMap(html.replace(block, licenceBlockText({ ...own, version: VERSION, packages: [] })), []).replace(pointerComment(true), pointerComment(false));
  assert.deepEqual(verifyBundleNotices(bare), { ok: true, packages: [], problems: [] }, 'the file without its packages, as a no-package build writes it');
  const pkg = (name, extra = {}) => ({ name, version: '1.2.3', license: 'Apache-2.0', entry: 'dist/index.es.js', source: `https://example.com/${name}`, copyright: null, licenceFiles: [{ name: 'LICENSE', text: `${name} licence text\n` }], notice: null, ...extra });
  const withPackages = licenceBlockText({ ...own, version: VERSION, packages: [pkg('zz-last', { copyright: 'Copyright Z · Copyright Y', notice: [{ name: 'NOTICE', text: 'zz notice' }] }), pkg('@scope/first', { source: null, license: 'MIT', entry: 'dist/index.js' })] });
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
  const bareBlock = blockOf(bare);
  const carrying = withMap(bare.replace(bareBlock, withPackages), ['zz-last', '@scope/first']).replace(pointerComment(false), pointerComment(true));
  assert.deepEqual(verifyBundleNotices(carrying), { ok: true, packages: ['@scope/first', 'zz-last'], problems: [] });
  assert.deepEqual(problemsOf(withMap(bare, ['zz-last'])), [
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
  const noLicence = tree({ 'vendor/observability-pack-spec/VERSIONS.json': versions });
  assert.throws(() => readOwnNotices(noLicence, '9.9.9'), { message: `LICENSE is missing from ${noLicence} — every bundle carries Observogram's licence; copy LICENSE with the tree` });
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

// ---------- the packs on both sides, for C3, C4 and C9 ----------

// The six packs a server serves by id, from the files it reads them from (server/index.mjs EXAMPLE_PACKS and
// REFERENCE_PACKS).
const SERVER_PACKS = [
  ['payment-service', PAYMENT],
  ['target-advanced', 'examples/target-advanced.pack.yaml'],
  ['production-curated', 'examples/production-curated.pack.yaml'],
  ['kafka-reference', 'reference-packs/kafka.pack.yaml'],
  ['prometheus-reference', 'reference-packs/prometheus.pack.yaml'],
  ['grafana-reference', 'reference-packs/grafana.pack.yaml'],
];
const packFile = (rel) => (rel.endsWith('.json') ? JSON.parse(read(rel)) : parseYaml(read(rel)));
// What "equal" compares: the status, the reason phrase, the headers either side sets on the answer, the raw text.
const HEADERS = ['content-type', 'cache-control', 'content-disposition', 'x-content-type-options'];
const answerOf = async (r) => ({ status: r.status, statusText: r.statusText, headers: Object.fromEntries(HEADERS.map((h) => [h, r.headers.get(h)])), text: await r.text() });
// '' when the two answers are equal, else what differs — in a sentence, since a body can be a megabyte.
function difference(server, shim) {
  const out = [];
  for (const k of ['status', 'statusText']) if (server[k] !== shim[k]) out.push(`${k} ${server[k]} ≠ ${shim[k]}`);
  for (const h of HEADERS) if (server.headers[h] !== shim.headers[h]) out.push(`${h} ${server.headers[h]} ≠ ${shim.headers[h]}`);
  if (server.text !== shim.text) {
    let i = 0;
    while (i < server.text.length && server.text[i] === shim.text[i]) i++;
    out.push(`the body differs at ${i} (${server.text.length} / ${shim.text.length} chars): …${server.text.slice(Math.max(0, i - 40), i + 40)}… ≠ …${shim.text.slice(Math.max(0, i - 40), i + 40)}…`);
  }
  return out.join('; ');
}
// A /api/diff query: each value a string (once), an array (repeated) or undefined (absent), in this key order.
const diffQuery = (q) => {
  const params = new URLSearchParams();
  for (const key of ['a', 'b', 'aEnv', 'bEnv', 'scopeMode', 'service']) for (const v of [].concat(q[key] ?? [])) params.append(key, v);
  const s = params.toString();
  return s ? `/api/diff?${s}` : '/api/diff';
};
// The audit report's declared differences (follow-up compare-in-bundle, docs/DOWNSTREAM.md §10): the server's
// document with the fields a bundle answers otherwise replaced by the shim's — `generator` (`<product> static
// bundle`), `pack.source` (`bundle`), `assessments` and `waivers` (no store: the server's section with `available:
// false`) and, for a pack the server registered, `tier.service`/`tier.environment` (no registry: null). `problems`
// names each declared field whose shim value is not the declared one; `masked` is what the shim's text must equal.
const STATIC_GENERATOR = { name: 'Observogram static bundle', version: VERSION };
function maskAudit(serverDoc, shimDoc, { registered = false, generator = STATIC_GENERATOR } = {}) {
  const problems = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(shimDoc.generator, generator)) problems.push(`generator ${JSON.stringify(shimDoc.generator)} ≠ ${JSON.stringify(generator)}`);
  if (shimDoc.pack?.source !== 'bundle') problems.push(`pack.source ${shimDoc.pack?.source} ≠ bundle`);
  for (const k of ['assessments', 'waivers']) if (!same(shimDoc[k], { ...serverDoc[k], available: false })) problems.push(`${k} ${JSON.stringify(shimDoc[k])} is not the server's section, not recorded`);
  if (registered && (shimDoc.tier?.service !== null || shimDoc.tier?.environment !== null)) problems.push(`tier ${JSON.stringify(shimDoc.tier)} names a service record`);
  const masked = {
    ...serverDoc,
    generator: shimDoc.generator,
    pack: { ...serverDoc.pack, source: shimDoc.pack?.source },
    tier: registered ? { ...serverDoc.tier, service: null, environment: null } : serverDoc.tier,
    assessments: shimDoc.assessments,
    waivers: shimDoc.waivers,
  };
  return { masked, problems };
}
// The studio's design kit as the server reads it for the report's HTML (server/index.mjs: tokens, a newline, kit).
const REPORT_STYLES = `${read('studio/design-tokens.css')}\n${read('studio/design-kit.css')}`;
// The `Generated` line of a report's HTML.
const generatedOf = (html) => /<li><b>Generated<\/b> ([^<]+)<\/li>/.exec(html)?.[1];
// One audit report to both sides, as JSON and as HTML: `problems` gains a sentence for each difference — the status,
// reason phrase and headers exactly (no-store on the report), the JSON text after maskAudit with the shim's clock
// pinned to the server's generatedAt, the server's HTML the renderer's over its own JSON, the shim's the renderer's
// over the masked JSON with the same brand and design kit.
async function auditBothWays({ base, shim, setNow, path, problems, registered = false, brand = DEFAULT_BRAND, generator = STATIC_GENERATOR, html = true }) {
  const label = path;
  const server = await answerOf(await fetch(`${base}${path}`));
  if (server.status !== 200) { problems.push(`${label}: the server answered ${server.status} ${server.text.slice(0, 200)}`); return null; }
  const serverDoc = JSON.parse(server.text);
  if (JSON.stringify(serverDoc) !== server.text) problems.push(`${label}: the server's text is not JSON.stringify's`);
  setNow(serverDoc.generatedAt);
  const shimJson = await answerOf(await shim.handle(path));
  const headersOnly = (a) => ({ ...a, text: '' });
  const jsonHeaders = difference(headersOnly(server), headersOnly(shimJson));
  if (jsonHeaders) problems.push(`${label}: ${jsonHeaders}`);
  if (shimJson.headers['cache-control'] !== 'no-store') problems.push(`${label}: no no-store on the report`);
  if (shimJson.status !== 200) { problems.push(`${label}: the shim answered ${shimJson.status} ${shimJson.text.slice(0, 200)}`); return null; }
  const shimDoc = JSON.parse(shimJson.text);
  const { masked, problems: declared } = maskAudit(serverDoc, shimDoc, { registered, generator });
  for (const d of declared) problems.push(`${label}: ${d}`);
  const text = JSON.stringify(masked);
  if (shimJson.text !== text) problems.push(`${label}: ${difference({ ...headersOnly(shimJson), text }, shimJson)}`);
  if (!html) return { serverDoc, shimDoc };
  const htmlPath = `${path}${path.includes('?') ? '&' : '?'}format=html`;
  const serverHtml = await answerOf(await fetch(`${base}${htmlPath}`));
  const at = generatedOf(serverHtml.text);
  if (serverHtml.text !== renderAuditReportHtml({ ...serverDoc, generatedAt: at }, { brand, styles: REPORT_STYLES })) problems.push(`${htmlPath}: the server's HTML is not the renderer's over its JSON`);
  setNow(serverDoc.generatedAt);
  const shimHtml = await answerOf(await shim.handle(htmlPath));
  const htmlHeaders = difference(headersOnly(serverHtml), headersOnly(shimHtml));
  if (htmlHeaders) problems.push(`${htmlPath}: ${htmlHeaders}`);
  const expected = renderAuditReportHtml(masked, { brand, styles: REPORT_STYLES });
  if (shimHtml.text !== expected) problems.push(`${htmlPath}: ${difference({ ...headersOnly(shimHtml), text: expected }, shimHtml)}`);
  return { serverDoc, shimDoc, html: shimHtml.text };
}

// The label a server gives each pack it serves (its catalogue, examples and references), so a shim over the same packs
// labels them as the server does (the audit report prints it).
async function serverLabels(base) {
  const lists = await Promise.all([['/api/packs', 'packs'], ['/api/examples', 'examples'], ['/api/references', 'references']].map(async ([path, key]) => (await (await fetch(`${base}${path}`)).json())[key]));
  return Object.fromEntries(lists.flat().map((p) => [p.id, p.label]));
}

// One child server for C3, C4, C5 and C9, with the uploads registered: { child, ids, labels, packs, canonicalOf, backend,
// compare } — the shim's packs under the server's ids and labels.
async function startParity() {
  const ws = mkdtempSync(join(tmpdir(), 'observogram-bundle-diff-'));
  const child = await serve(ws, { env: { OBSERVOGRAM_AUTH: 'off' } });
  const register = async (body, contentType, source = '') => {
    const r = await fetch(`${child.base}/api/validate${source ? `?source=${encodeURIComponent(source)}` : ''}`, { method: 'POST', headers: { 'Content-Type': contentType }, body }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    return r.registered.id;
  };
  const payment = parseYaml(read(PAYMENT));
  const annotated = (name, key, value) => ({ ...payment, metadata: { ...payment.metadata, name, annotations: { ...(payment.metadata.annotations || {}), [key]: value } } });
  const uploads = {
    golden: { canonical: JSON.parse(read(GOLDEN)) },
    modesA: { text: read('tools/fixtures/compare-modes/a.pack.yaml'), source: 'compare-modes-a.pack.yaml' },
    modesB: { text: read('tools/fixtures/compare-modes/b.pack.yaml'), source: 'compare-modes-b.pack.yaml' },
    orders: { canonical: JSON.parse(read('tools/fixtures/build/orders-api.tier-2.instantiate.json')).canonical },
    snapshot: { canonical: JSON.parse(read('tools/fixtures/golden/snapshot/snapshot.pack.json')) },
    krystaline: { text: read('examples/krystaline-repo-carlos.pack.yaml'), source: 'krystaline-repo-carlos.pack.yaml' },
    scopedAll: { canonical: annotated('scoped-all', 'observogram.diff.scopeMode', 'all') },
    scopedLegacy: { canonical: annotated('scoped-legacy', 'tomograph.diff.scopeMode', 'family') },
  };
  const ids = Object.fromEntries(SERVER_PACKS.map(([id]) => [id, id]));
  const canonicalOf = Object.fromEntries(SERVER_PACKS.map(([id, rel]) => [id, packFile(rel)]));
  for (const [name, u] of Object.entries(uploads)) {
    const id = u.text ? await register(u.text, 'text/yaml', u.source) : await register(JSON.stringify(u.canonical), 'application/json');
    ids[name] = id;
    canonicalOf[id] = u.canonical ?? parseYaml(u.text);
  }
  const schema = JSON.parse(read(SPEC_SCHEMA_PATH));
  const labels = await serverLabels(child.base);
  const packs = Object.entries(canonicalOf).map(([id, canonical]) => ({ id, label: labels[id], canonical }));
  assert.ok(packs.every((p) => typeof p.label === 'string'), 'the server labels every pack');
  const backend = createStaticBackend({ version: VERSION, schema, packs });
  // One path to both sides: { server, shim, problem } — problem '' when equal.
  const compare = async (path, init, shimBackend = backend) => {
    const server = await answerOf(await fetch(`${child.base}${path}`, init));
    const shim = await answerOf(await shimBackend.handle(path, init));
    return { server, shim, problem: difference(server, shim) };
  };
  return { child, ws, ids, labels, packs, canonicalOf, schema, backend, compare, stop: async () => { await child.stop(); rmSync(ws, { recursive: true, force: true }); } };
}
let parityStarted = null;
const parity = () => (parityStarted ??= startParity());
test.after(async () => { if (parityStarted) await (await parityStarted).stop(); });

// ---------- C3 GET /api/diff from the source ----------

test('C3 GET /api/diff from the source, body for body: every scopeMode spelling × service on four pairs (the annotation fallback, both namespaces), the environments, every refusal, the largest and the live answers; a failed --pack-url pack, one that fails the schema, an engine import retried', async () => {
  const { ids, schema, canonicalOf, compare } = await parity();
  const problems = [];
  const texts = new Map();
  let queries = 0;
  const check = async (q) => {
    const path = typeof q === 'string' ? q : diffQuery(q);
    const r = await compare(path);
    queries++;
    if (r.problem) problems.push(`${path}: ${r.problem}`);
    texts.set(path, r.server.text);
    return r.server;
  };

  // M2: every scopeMode spelling (absent, empty, the three, their aliases, any case, padded, unknown, repeated) × four
  // service values, on four pairs — two of them annotate a scope mode.
  const SCOPES = [undefined, '', 'service', 'family', 'all', 'legacy', 'off', 'none', 'strict', 'ALL', ' all ', 'zzz', ['all', 'family']];
  const SERVICES = [undefined, '', 'payment-service', 'nope'];
  const M2 = [['payment-service', 'production-curated'], [ids.modesA, ids.modesB], [ids.scopedAll, 'production-curated'], [ids.scopedLegacy, 'payment-service']];
  for (const [a, b] of M2) for (const scopeMode of SCOPES) for (const service of SERVICES) await check({ a, b, scopeMode, service });
  assert.equal(queries, 4 * 13 * 4);
  const m2 = (a, b, scopeMode) => texts.get(diffQuery({ a, b, scopeMode }));
  // The fallbacks bite: an empty or repeated scopeMode reads Pack A's annotation — observogram.diff.scopeMode, then
  // the legacy tomograph.diff.scopeMode — and an unannotated pack's default is service.
  assert.equal(m2(ids.scopedAll, 'production-curated', ''), m2(ids.scopedAll, 'production-curated', 'all'), 'scopeMode= on scoped-all is its annotation, all');
  assert.equal(m2(ids.scopedAll, 'production-curated', ['all', 'family']), m2(ids.scopedAll, 'production-curated', 'all'), 'a repeated scopeMode is absent');
  assert.notEqual(m2(ids.scopedAll, 'production-curated', 'all'), m2(ids.scopedAll, 'production-curated', 'service'), 'all and service answer differently there');
  assert.equal(m2(ids.scopedLegacy, 'payment-service', undefined), m2(ids.scopedLegacy, 'payment-service', 'family'), 'the legacy annotation, family');
  assert.notEqual(m2(ids.scopedLegacy, 'payment-service', 'family'), m2(ids.scopedLegacy, 'payment-service', 'service'));
  assert.equal(m2('payment-service', 'production-curated', ''), m2('payment-service', 'production-curated', 'service'), 'no annotation: service');

  // M3: the environments — each side in prod, staging, an unknown one, empty, repeated; and across packs.
  const ENVS = ['prod', 'staging', 'nope', '', ['prod', 'staging']];
  for (const aEnv of ENVS) for (const bEnv of ENVS) await check({ a: 'payment-service', b: 'payment-service', aEnv, bEnv, scopeMode: 'service' });
  await check({ a: 'payment-service', b: 'production-curated', aEnv: 'prod', scopeMode: 'service' });
  await check({ a: 'production-curated', b: 'payment-service', bEnv: 'staging', scopeMode: 'service' });
  await check({ a: 'payment-service', b: 'target-advanced', aEnv: 'prod', bEnv: 'prod', scopeMode: 'service' });

  // M4: every refusal — the 400 (absent, empty or repeated a / b), A's 404 before B's, an encoded id, a malformed escape.
  const M4 = {
    '/api/diff': 400,
    '/api/diff?a=payment-service': 400,
    '/api/diff?b=payment-service': 400,
    '/api/diff?a=&b=payment-service': 400,
    '/api/diff?a=payment-service&a=production-curated&b=payment-service': 400,
    '/api/diff?a=nope&b=nope2': 404,
    '/api/diff?a=payment-service&b=nope': 404,
    '/api/diff?a=nope&b=payment-service': 404,
    '/api/diff?a=payment%20service&b=production-curated': 404,
    '/api/diff?a=%E0%A4%A&b=payment-service': 404,
  };
  for (const [path, status] of Object.entries(M4)) assert.equal((await check(path)).status, status, path);
  assert.equal(texts.get('/api/diff?a=nope&b=nope2'), '{"error":"unknown pack: nope"}', 'both unknown: A\'s 404');
  assert.equal(texts.get('/api/diff?a=payment-service&a=production-curated&b=payment-service'), '{"error":"query params `a` and `b` (pack ids) required"}');

  // M5: the largest answers (krystaline, both ways) and a live pack (the snapshot: the drift mode's diff), both ways.
  for (const [a, b] of [[ids.krystaline, 'production-curated'], ['production-curated', ids.krystaline], ['payment-service', ids.snapshot], [ids.snapshot, 'payment-service']]) {
    const r = await check({ a, b, scopeMode: 'service' });
    assert.equal(r.status, 200, `${a} × ${b}`);
    assert.ok(JSON.parse(r.text).traceabilityGraph, `${a} × ${b} carries the graph`);
  }
  assert.ok(texts.get(diffQuery({ a: ids.krystaline, b: 'production-curated', scopeMode: 'service' })).length > 300_000, 'krystaline is a large answer');
  assert.deepEqual(problems, [], `${problems.length} of ${queries} answers differ from the server's`);

  // What only the shim meets. A --pack-url pack that failed to load: 500 with its message, either side.
  const payment = canonicalOf['payment-service'];
  const invalid = { ...payment, spec: { ...payment.spec, bogus: 1 } };
  const remote = createStaticBackend({ version: VERSION, schema, packs: [{ id: 'p', label: 'P', canonical: payment }, { id: 'down', label: 'D', url: 'https://packs.example/down.pack.yaml' }, { id: 'invalid', label: 'I', url: 'https://packs.example/invalid.pack.json' }] }, {
    origin: 'https://studio.example',
    fetchImpl: async (u) => (String(u).endsWith('invalid.pack.json') ? new Response(JSON.stringify(invalid), { status: 200 }) : new Response('nope', { status: 404, statusText: 'Not Found' })),
  });
  for (const path of ['/api/diff?a=p&b=down', '/api/diff?a=down&b=p']) {
    const r = await remote.handle(path);
    assert.equal(r.status, 500, path);
    assert.equal(r.statusText, 'Internal Server Error');
    assert.deepEqual(await r.json(), { error: '404 Not Found fetching https://packs.example/down.pack.yaml' }, path);
  }
  // One that fails the schema but adapts: diffed, as the server's route diffs what it holds (GET /api/packs/:id is
  // where the schema speaks).
  assert.equal((await remote.handle('/api/packs/invalid')).status, 500, 'the layered pack refuses it');
  const diffed = await remote.handle('/api/diff?a=invalid&b=p&scopeMode=service');
  assert.equal(diffed.status, 200);
  const [aL, bL] = [adapt(invalid), adapt(payment)];
  assert.equal(await diffed.text(), JSON.stringify({ ...diffPacks(aL, bL, { scopeMode: 'service' }), traceabilityGraph: comparePackBranches(aL, bL) }), 'the diff of what it holds, unvalidated');
  // An engine import that fails once: 500 with its message, and the next call imports again and answers.
  let attempts = 0;
  const flaky = createStaticBackend({ version: VERSION, schema, packs: [{ id: 'p', label: 'P', canonical: payment }] }, {
    importDiffEngines: () => (++attempts === 1 ? Promise.reject(new Error('Failed to fetch dynamically imported module')) : Promise.all([import('./lib/diff.mjs'), import('./lib/traceability-graph.mjs')])),
  });
  const first = await flaky.handle('/api/diff?a=p&b=p&scopeMode=service');
  assert.equal(first.status, 500);
  assert.deepEqual(await first.json(), { error: 'Failed to fetch dynamically imported module' });
  const second = await flaky.handle('/api/diff?a=p&b=p&scopeMode=service');
  assert.equal(second.status, 200, 'a failed import is not kept');
  assert.ok((await second.json()).traceabilityGraph);
  assert.equal(attempts, 2);
});

// ---------- C3b the taxonomy ----------

test('C3b the taxonomy: a server started with OBSERVOGRAM_TAXONOMY and a shim over the bound document answer the typed canonical both ways equally, and not as the default families do — the diff, and the audit report\'s coverage; a baked taxonomy the classifier does not hold refuses the diff, retrofeed and the audit report', async (t) => {
  const TAX = resolve(ROOT, 'tools/fixtures/taxonomy/taxonomy.json');
  const taxonomy = JSON.parse(read('tools/fixtures/taxonomy/taxonomy.json'));
  const ws = mkdtempSync(join(tmpdir(), 'observogram-bundle-taxonomy-'));
  const child = await serve(ws, { env: { OBSERVOGRAM_AUTH: 'off', OBSERVOGRAM_TAXONOMY: TAX } });
  t.after(async () => { bindTaxonomy(artefactClassify, null); await child.stop(); rmSync(ws, { recursive: true, force: true }); });
  const typed = JSON.parse(read('tools/fixtures/taxonomy/typed-canonical.pack.json'));
  const registered = await fetch(`${child.base}/api/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(typed) }).then((r) => r.json());
  assert.equal(registered.ok, true, JSON.stringify(registered.errors));
  const typedId = registered.registered.id;
  const payment = parseYaml(read(PAYMENT));
  const schema = JSON.parse(read(SPEC_SCHEMA_PATH));
  const pairs = [[typedId, typedId], [typedId, 'payment-service'], ['payment-service', typedId]];
  const path = ([a, b]) => `/api/diff?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&scopeMode=service`;
  const labels = await serverLabels(child.base);
  const config = { version: VERSION, schema, taxonomy, packs: [{ id: typedId, label: labels[typedId], canonical: typed }, { id: 'payment-service', label: labels['payment-service'], canonical: payment }] };
  // The default families' answers, before the bind (the classifier is this process's one instance).
  assert.equal(artefactClassify.activeTaxonomy(), null);
  const unbound = await Promise.all(pairs.map(async (p) => (await createStaticBackend({ ...config, taxonomy: undefined }).handle(path(p))).text()));
  const auditPath = `/api/packs/${encodeURIComponent(typedId)}/audit-report`;
  const unboundAudit = await (await createStaticBackend({ ...config, taxonomy: undefined }).handle(auditPath)).json();
  bindTaxonomy(artefactClassify, taxonomy);
  assert.ok(artefactClassify.activeTaxonomy(), 'the document is bound, as the studio binds what /api/taxonomy serves');
  const backend = createStaticBackend(config);
  for (const [i, p] of pairs.entries()) {
    const server = await answerOf(await fetch(`${child.base}${path(p)}`));
    const shim = await answerOf(await backend.handle(path(p)));
    assert.equal(server.status, 200);
    assert.equal(difference(server, shim), '', `${p.join(' × ')} equal`);
    assert.notEqual(server.text, unbound[i], `${p.join(' × ')}: the taxonomy changes the answer, so the bind is what parity rests on`);
  }
  // The audit report under the bound document: the server's (registered, so its service record named there), its
  // declared fields aside; the coverage section classifies by the taxonomy (POL-01 by its declared type).
  let now = null;
  const auditProblems = [];
  const audit = await auditBothWays({ base: child.base, shim: createStaticBackend(config, { clock: () => now }), setNow: (v) => { now = v; }, path: auditPath, problems: auditProblems, registered: true, html: false });
  assert.deepEqual(auditProblems, []);
  assert.notDeepEqual(audit.shimDoc.coverage, unboundAudit.coverage, 'the taxonomy moves the coverage section');

  // The guard: a baked taxonomy the classifier does not hold (the studio's bind failed in this page) — 500 on both
  // computing routes, before any computation; with the reason when the document does not compile here.
  bindTaxonomy(artefactClassify, null);
  const GUARD = (why = '') => `the artefact taxonomy built into this bundle did not bind in this page${why}, so this answer would not be the one a server with that taxonomy gives — open the file in a Chromium-based browser, where it is proven to bind, or ask whoever built it for a build whose taxonomy this browser compiles`;
  const refused = createStaticBackend(config);
  const d = await refused.handle(path(pairs[0]));
  assert.equal(d.status, 500);
  assert.deepEqual(await d.json(), { error: GUARD() });
  const rf = await refused.handle(`/api/packs/${encodeURIComponent(typedId)}/retrofeed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packBId: 'payment-service' }) });
  assert.equal(rf.status, 500);
  assert.deepEqual(await rf.json(), { ok: false, error: GUARD() });
  for (const q of ['', '?format=html']) {
    const ar = await refused.handle(`${auditPath}${q}`);
    assert.equal(ar.status, 500, `the audit report${q}`);
    assert.equal(ar.headers.get('cache-control'), null, 'a refusal, not a report');
    assert.deepEqual(await ar.json(), { error: GUARD() });
  }
  const broken = { ...taxonomy, version: 99 };
  let why = '';
  try { artefactClassify.compileTaxonomy(broken, { timed: false }); } catch (e) { why = e.message; }
  assert.ok(why, 'the broken document does not compile');
  const named = await createStaticBackend({ ...config, taxonomy: broken }).handle(path(pairs[0]));
  assert.deepEqual(await named.json(), { error: GUARD(` (${why})`) });
  assert.equal((await createStaticBackend({ ...config, taxonomy: undefined }).handle(path(pairs[0]))).status, 200, 'no baked taxonomy: no guard');
});

// ---------- C4 Pair by ----------

test('C4 Pair by: the studio\'s re-key over the shim\'s /api/packs/:id and /api/diff bodies equals the re-key over the server\'s, by name and by id — 5/15/5, 4/16/4, 3/17/3', async () => {
  const { ids, child, backend } = await parity();
  const engine = { identity: identityLib, diff: diffLib };
  const sides = {
    server: async (path) => (await fetch(`${child.base}${path}`)).json(),
    shim: async (path) => (await backend.handle(path)).json(),
  };
  const views = {};
  for (const [side, get] of Object.entries(sides)) {
    const pack = await get(`/api/packs/${encodeURIComponent(ids.modesA)}`);
    const packB = await get(`/api/packs/${encodeURIComponent(ids.modesB)}`);
    // The answer as the studio holds it: stamped with the selection it was asked for (compare-view.mjs loadDiff).
    const diff = { ...(await get(`/api/diff?a=${encodeURIComponent(ids.modesA)}&b=${encodeURIComponent(ids.modesB)}&scopeMode=service`)), __for: { a: ids.modesA, b: ids.modesB, aEnv: null, bEnv: null, scopeMode: 'service', service: null } };
    views[side] = Object.fromEntries(['behaviour', 'name', 'id'].map((mode) => [mode, viewDiffFor({ engine, diff, pack, packB, mode })]));
  }
  const counts = (v) => [v.diff.summary.onlyInA, v.diff.summary.inBoth, v.diff.summary.onlyInB];
  for (const [mode, expected] of [['behaviour', [5, 15, 5]], ['name', [4, 16, 4]], ['id', [3, 17, 3]]]) {
    const { server, shim } = { server: views.server[mode], shim: views.shim[mode] };
    assert.equal(shim.mode, mode, `${mode}: shown`);
    assert.equal(shim.unavailable, '', `${mode}: available`);
    assert.deepEqual(shim.diff, server.diff, `${mode}: the shim's re-key is the server's`);
    assert.deepEqual(counts(shim), expected, `${mode}: only in A, in both, only in B`);
    assert.ok(shim.diff.traceabilityGraph, `${mode}: the received graph is kept`);
  }
});

// ---------- C5 the audit report ----------

test('C5 the audit report: the server\'s JSON and HTML but for the declared fields — payment-service under no env, prod and staging, download=1, top, a registered pack, a branded server against the same brand — every refusal equal, headers included (no Cache-Control on them, no-store on every report); the design kit read from the page, a missing sheet a 500, an engine import retried, a failed --pack-url pack', async (t) => {
  const { ids, child, packs, schema, compare } = await parity();
  let now = null;
  const setNow = (v) => { now = v; };
  const backend = createStaticBackend({ version: VERSION, schema, packs }, { clock: () => now, styles: REPORT_STYLES });
  const problems = [];
  const docs = {};
  for (const path of ['', '?env=prod', '?env=staging', '?download=1&env=prod', '?top=3']) {
    docs[path] = await auditBothWays({ base: child.base, shim: backend, setNow, path: `/api/packs/payment-service/audit-report${path}`, problems });
  }
  // A pack the server registered (POST /api/validate): its service record named in `tier` there, null here.
  const orders = await auditBothWays({ base: child.base, shim: backend, setNow, path: `/api/packs/${encodeURIComponent(ids.orders)}/audit-report`, problems, registered: true });
  // A repeated format is the default, json (the server reads a string only).
  await auditBothWays({ base: child.base, shim: backend, setNow, path: '/api/packs/payment-service/audit-report?format=json&format=html', problems, html: false });
  assert.deepEqual(problems, []);
  // The cases bite: the environments, the listing size and the registration each move the document.
  const plain = docs[''].shimDoc;
  assert.equal(plain.goesBlind.available, true, 'the goes-blind section is computed in the bundle');
  assert.ok(plain.goesBlind.nodes > 0 && plain.goesBlind.top === 10 && plain.goesBlind.risks.length > 3, 'the graph\'s nodes, the default listing');
  assert.equal(docs['?top=3'].shimDoc.goesBlind.top, 3);
  assert.notDeepEqual(docs['?env=prod'].shimDoc.conformance, docs['?env=staging'].shimDoc.conformance, 'prod and staging grade differently');
  assert.notEqual(orders.serverDoc.tier.service, null, 'the server names the registered pack\'s service record');
  assert.equal(orders.serverDoc.pack.source, 'uploaded');
  assert.equal(docs[''].serverDoc.assessments.available, true, 'a server has a store: none recorded');
  assert.equal(plain.assessments.available, false);
  assert.match(docs[''].html, /Not recorded by this build/);
  assert.ok(!docs[''].html.includes('Not computed by this build'));
  assert.match(docs[''].html, /<meta name="generator" content="Observogram static bundle /);

  // The refusals, equal on both sides, headers included: neither sends Cache-Control on them.
  for (const q of ['format=xml', 'format=', 'top=0', 'top=101', 'top=1.5', 'top=', 'top=5&top=6', 'format=html&top=x']) {
    const r = await compare(`/api/packs/payment-service/audit-report?${q}`, undefined, backend);
    assert.equal(r.server.status, 400, q);
    assert.equal(r.problem, '', `${q}: ${r.problem}`);
    assert.equal(r.shim.headers['cache-control'], null, `${q}: no Cache-Control`);
  }
  const unknown = await compare('/api/packs/nope/audit-report?format=html', undefined, backend);
  assert.equal(unknown.server.status, 404);
  assert.equal(unknown.problem, '');
  assert.equal(unknown.server.text, '{"error":"unknown pack: nope"}');

  // A branded server against a shim given the same normalised brand: the HTML wears it, equal after the masking.
  const ws = mkdtempSync(join(tmpdir(), 'observogram-bundle-audit-brand-'));
  const branded = await serve(ws, { env: { OBSERVOGRAM_AUTH: 'off', OBSERVOGRAM_BRAND_FILE: resolve(ROOT, 'tools/fixtures/brand/acme-static.json') } });
  t.after(async () => { await branded.stop(); rmSync(ws, { recursive: true, force: true }); });
  const acme = normalizeBrand(JSON.parse(read('tools/fixtures/brand/acme-static.json')));
  const brandedShim = createStaticBackend({ version: VERSION, schema, packs }, { clock: () => now, brand: acme, styles: REPORT_STYLES });
  const brandedProblems = [];
  const acmeReport = await auditBothWays({ base: branded.base, shim: brandedShim, setNow, path: '/api/packs/payment-service/audit-report', problems: brandedProblems, brand: acme, generator: { name: 'Acme Watch static bundle', version: VERSION } });
  assert.deepEqual(brandedProblems, []);
  assert.equal(acmeReport.serverDoc.generator.name, 'Acme Watch server');
  assert.ok(acmeReport.html.includes('Acme Watch · a product of Acme Corp') && acmeReport.html.includes('<style id="brand-tokens">'), 'the brand\'s chrome and tokens');
  assert.ok(!acmeReport.html.replace(/<style[\s\S]*?<\/style>/g, '').includes('Observogram'), 'a branded report names its own product only');

  // The design kit as the page carries it: bundleStyles strips exactly the newline styleBlock adds on each side, so the
  // inlined sheets give the server's text; a sheet the page lacks is a 500 for the HTML (never an unstyled report),
  // read again at the next request; the JSON needs no stylesheet.
  const inlined = (name) => `\n${read(`studio/${name}`)}\n`;
  assert.equal(bundleStyles(inlined), REPORT_STYLES);
  assert.equal(bundleStyles((name) => `\n\n${name}\n\n`), '\ndesign-tokens.css\n\n\ndesign-kit.css\n', 'one newline each side, no more');
  let sheets = {};
  const kitless = createStaticBackend({ version: VERSION, schema, packs }, { styles: () => bundleStyles((name) => sheets[name]) });
  const missing = await kitless.handle('/api/packs/payment-service/audit-report?format=html');
  assert.equal(missing.status, 500);
  assert.equal(missing.statusText, 'Internal Server Error');
  assert.deepEqual(await missing.json(), { error: 'the bundle\'s design kit is missing (design-tokens.css)' });
  assert.equal((await kitless.handle('/api/packs/payment-service/audit-report')).status, 200, 'the JSON reads no stylesheet');
  sheets = { 'design-tokens.css': inlined('design-tokens.css'), 'design-kit.css': inlined('design-kit.css') };
  const styled = await kitless.handle('/api/packs/payment-service/audit-report?format=html');
  assert.equal(styled.status, 200, 'a failed read is not kept');
  assert.ok((await styled.text()).includes(REPORT_STYLES));

  // What only the shim meets: an engine import that fails once (500 with its message, then retried) and a --pack-url
  // pack that failed to load (500 with its message, after the query is read).
  let attempts = 0;
  const flaky = createStaticBackend({ version: VERSION, schema, packs }, {
    importAuditEngines: () => (++attempts === 1 ? Promise.reject(new Error('Failed to fetch dynamically imported module')) : Promise.all([import('./lib/audit-report.mjs'), import('./lib/traceability-graph.mjs')])),
  });
  const first = await flaky.handle('/api/packs/payment-service/audit-report');
  assert.equal(first.status, 500);
  assert.deepEqual(await first.json(), { error: 'Failed to fetch dynamically imported module' });
  assert.equal((await flaky.handle('/api/packs/payment-service/audit-report')).status, 200, 'a failed import is not kept');
  assert.equal(attempts, 2);
  const remote = createStaticBackend({ version: VERSION, schema, packs: [{ id: 'down', label: 'D', url: 'https://packs.example/down.pack.yaml' }] }, {
    origin: 'https://studio.example', fetchImpl: async () => new Response('nope', { status: 404, statusText: 'Not Found' }),
  });
  assert.equal((await remote.handle('/api/packs/down/audit-report?top=0')).status, 400, 'the query first, as the server reads it before the pack');
  const down = await remote.handle('/api/packs/down/audit-report');
  assert.equal(down.status, 500);
  assert.deepEqual(await down.json(), { error: '404 Not Found fetching https://packs.example/down.pack.yaml' });
  // A --pack-url pack's source is the config's word for it.
  const urlPack = createStaticBackend({ version: VERSION, schema, packs: [{ id: 'u', label: 'U', url: 'https://packs.example/u.pack.json' }] }, {
    origin: 'https://studio.example', fetchImpl: async () => new Response(JSON.stringify(packs.find((p) => p.id === 'payment-service').canonical), { status: 200 }),
  });
  assert.equal((await (await urlPack.handle('/api/packs/u/audit-report')).json()).pack.source, 'url');
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

// ---------- C8 the bundle in Chromium ----------

// Playwright as tools/test-studio-bundle.mjs T7 loads it: OBSERVOGRAM_PLAYWRIGHT names its index.mjs, else the bare
// 'playwright'.
async function loadPlaywright() {
  const spec = process.env.OBSERVOGRAM_PLAYWRIGHT || 'playwright';
  try { return { pw: await import(spec) }; }
  catch (e) { return { error: `cannot import ${spec}: ${e.message.split('\n')[0]}` }; }
}
// S4's pattern (tools/test-static-remedies.mjs, which holds every studio line it matches to a disposition): a server
// action a reader of a bundle cannot take, or the deploy review a bundle never opens. C8 holds the rendered views to it.
const SERVER_ACTION = /\b(re-?scan|rescan|scan (?:live|a repo(?:sitory)?)|connect mcp|from (?:its |a live )?mcp|redraft|re-?upload|refresh(?:es|ing)? (?:the )?live|refresh live evidence|capture a live draft|live draft again|deploy what is missing|deploy the repository|deploy review|review (?:of |the )?destination|after a review|then deploy|confirmed separately)\b/i;

test('C8 the bundle in Chromium: the in-page /api/diff text equals a server\'s under en-US, cs-CZ and et-EE; Compare and Pair by on the compare-modes pair; the drift drill\'s deploy drawn unavailable and explained, its retrofeed downloading the server\'s updated pack; Remediate\'s deploy controls; the static texts and no server action rendered; the audit report downloaded and fetched as the server\'s; the notice; no page error, nothing off the loopback', async (t) => {
  const required = process.env.OBSERVOGRAM_BUNDLE_SMOKE === 'require';
  const skip = (why) => { if (required) assert.fail(`OBSERVOGRAM_BUNDLE_SMOKE=require: ${why}`); t.skip(why); };
  const { pw, error } = await loadPlaywright();
  if (!pw) return skip(error);
  let browser;
  try { browser = await pw.chromium.launch(); }
  catch (e) { return skip(`chromium.launch failed: ${e.message.split('\n')[0]}`); }
  t.after(() => browser.close());
  assert.ok(read('tools/test-static-remedies.mjs').includes(`const SERVER_ACTION = ${SERVER_ACTION};`), 'the pattern S4 holds the studio\'s source to');

  const { child, ids, labels } = await parity();
  const product = DEFAULT_BRAND.name;
  const DEPLOY = serverNeeded('Deploy', product);
  const T = 30_000;
  // The bundle's packs under the ids its reader sees, each with its id on the server (an upload's is the server's
  // own) and the server's label, so the audit report names each pack as the server does. payment-linked is
  // payment-service with its first remediation's trigger naming its own burn-rate alert (as
  // tools/test-remediation-flow-view.mjs packA's does): no example pack's response path links a remediation to an
  // alert, and this one, compared with the live pack (which lacks that alert), draws a per-SLO deploy button.
  const linkedFile = join(TMP, 'c8-linked.pack.json');
  const linked = parseYaml(read(PAYMENT));
  linked.spec.remediation[0].trigger = 'alert:api_availability_99_9_burn_14x_5m_1h';
  writeFileSync(linkedFile, JSON.stringify(linked));
  const BUNDLED = [
    { id: 'payment-service', file: PAYMENT, onServer: 'payment-service' },
    { id: 'payment-live', file: 'tools/fixtures/golden/snapshot/snapshot.pack.json', onServer: ids.snapshot },
    { id: 'modes-a', file: 'tools/fixtures/compare-modes/a.pack.yaml', onServer: ids.modesA },
    { id: 'modes-b', file: 'tools/fixtures/compare-modes/b.pack.yaml', onServer: ids.modesB },
    { id: 'production-curated', file: 'examples/production-curated.pack.yaml', onServer: 'production-curated' },
    { id: 'payment-linked', file: linkedFile, label: 'Payment service (remediation triggers linked)' },
  ];
  const serverId = Object.fromEntries(BUNDLED.filter((p) => p.onServer).map((p) => [p.id, p.onServer]));
  const bundleOf = (dir, packs) => {
    const out = join(TMP, dir, 'index.html');
    const built = cli([...packs.flatMap((p) => ['--pack', resolve(ROOT, p.file), '--id', p.id, '--label', p.label ?? labels[p.onServer]]), '--out', out, '--no-remote-fonts']);
    assert.equal(built.status, 0, built.stderr);
    return readFileSync(out);
  };
  // Each bundle from its own loopback host, which records every path a browser asks of it.
  const asked = [];
  const host = async (html) => {
    const srv = createServer((req, res) => {
      asked.push(req.url);
      if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return; }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => srv.close(r)));
    return `http://127.0.0.1:${srv.address().port}`;
  };
  const base = await host(bundleOf('c8', BUNDLED));
  // Row 4 is what Compare says when no other pack loads: a bundle of one pack.
  const oneBase = await host(bundleOf('c8-one', BUNDLED.filter((p) => p.id === 'production-curated')));

  const problems = [];
  const offLoopback = [];
  // A fresh context per scenario, its browser locale set and the studio's state seeded once (a reload keeps what the
  // page itself stored); every request that is not the bundle's host is refused and recorded.
  const open = async (at, seed, { locale = 'en-US' } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale, acceptDownloads: true });
    await ctx.addInitScript((s) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      if (s) localStorage.setItem('studioState.v1', JSON.stringify(s));
    }, seed);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${locale} pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`${locale} console.error: ${m.text()}`); });
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(at)) return route.continue();
      offLoopback.push(u);
      return route.abort();
    });
    await page.goto(`${at}/`);
    return { page, ctx };
  };
  const booted = (page) => page.waitForSelector('.svc-gate-card', { state: 'attached', timeout: T });
  // Paths fetched from the page, in order: what "equal" compares (answerOf's fields).
  const fetchInPage = (page, paths) => page.evaluate(async ({ paths, headers }) => {
    const out = [];
    for (const path of paths) {
      const r = await fetch(path);
      out.push({ status: r.status, statusText: r.statusText, headers: Object.fromEntries(headers.map((h) => [h, r.headers.get(h)])), text: await r.text() });
    }
    return out;
  }, { paths, headers: HEADERS });
  const viewText = (page) => page.evaluate(() => document.querySelector('#layer-view')?.innerText || '');
  const noServerAction = async (page, where) => {
    const hits = [...new Set([...(await viewText(page)).matchAll(new RegExp(SERVER_ACTION.source, 'gi'))].map((m) => m[0]))];
    assert.deepEqual(hits, [], `${where}: the static posture names no server action the reader cannot take`);
  };
  // A control drawn unavailable: aria-disabled, the reason beside it, no title saying what it would open; a click
  // explains it (the toast) and opens nothing.
  const drawnUnavailable = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((el) => ({ aria: el.getAttribute('aria-disabled'), why: el.querySelector('.svc-why')?.textContent ?? null, title: el.getAttribute('title') })), sel);
  const clickExplains = async (page, sel) => {
    await page.evaluate(() => { const el = document.getElementById('toast'); el.hidden = true; el.textContent = ''; });
    await page.click(sel, { force: true });       // an aria-disabled control still takes a click; Playwright would wait for it to enable
    await page.waitForFunction(() => !document.getElementById('toast').hidden || !document.getElementById('deploy-modal').hidden, null, { timeout: T }).catch(() => {});
    const after = await page.evaluate(() => ({ toast: document.getElementById('toast').hidden ? null : document.getElementById('toast').textContent, modalOpen: !document.getElementById('deploy-modal').hidden }));
    assert.deepEqual(after, { toast: DEPLOY, modalOpen: false }, `${sel}: a click explains the reason and opens no modal`);
  };
  // A filled button drawn unavailable is drawn without its fill — at rest and under the pointer, where the reskin's
  // hover paints it again unless the zone's rule outranks it — so its reason reads on the card, not on the accent.
  const fillOf = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((el) => { const cs = window.getComputedStyle(el); return { background: cs.backgroundColor, filter: cs.filter }; }), sel);
  const drawnUnfilled = async (page, sel) => {
    const rest = await fillOf(page, sel);
    assert.ok(rest.length > 0, sel);
    await page.hover(`${sel} >> nth=0`, { force: true });
    const hovered = (await fillOf(page, sel))[0];
    await page.mouse.move(0, 0);
    const none = { background: 'rgba(0, 0, 0, 0)', filter: 'none' };
    assert.deepEqual({ rest, hovered }, { rest: rest.map(() => none), hovered: none }, `${sel}: drawn without its fill, under the pointer too`);
  };

  // (i) The in-page /api/diff text, byte for byte the server's, under three browser locales — two that tailor ASCII
  // (Czech sorts ch after h, Estonian z between s and t), so a sort that followed the reader's locale would show.
  const QUERIES = [
    { a: 'payment-service', b: 'production-curated', scopeMode: 'service' },
    { a: 'production-curated', b: 'payment-service', bEnv: 'staging', scopeMode: 'family' },
    { a: 'modes-a', b: 'modes-b', scopeMode: 'all' },
    { a: 'payment-service', b: 'payment-live', scopeMode: 'service' },
    { a: 'payment-live', b: 'production-curated', scopeMode: 'all' },
    { a: 'nope', b: 'payment-service', scopeMode: 'service' },
  ];
  const onServer = (q) => ({ ...q, a: serverId[q.a] ?? q.a, b: serverId[q.b] ?? q.b });
  const serverDiffs = [];
  for (const q of QUERIES) serverDiffs.push(await answerOf(await fetch(`${child.base}${diffQuery(onServer(q))}`)));
  assert.deepEqual(serverDiffs.map((a) => a.status), [200, 200, 200, 200, 200, 404]);
  const SAMPLE = ['ch', 'h', 'i', 's', 't', 'z'];
  const enOrder = [...SAMPLE].sort(new Intl.Collator('en').compare).join(' ');
  for (const locale of ['en-US', 'cs-CZ', 'et-EE']) {
    const { page, ctx } = await open(base, null, { locale });
    await booted(page);
    const order = await page.evaluate((s) => [navigator.language, [...s].sort((x, y) => x.localeCompare(y)).join(' ')], SAMPLE);
    assert.deepEqual(order, [locale, [...SAMPLE].sort(new Intl.Collator(locale).compare).join(' ')], `${locale}: the page collates by its locale`);
    if (locale !== 'en-US') assert.notEqual(order[1], enOrder, `${locale} tailors the sample`);
    const answers = await fetchInPage(page, QUERIES.map(diffQuery));
    const differ = QUERIES.map((q, i) => difference(serverDiffs[i], answers[i]) && `${locale} ${diffQuery(q)}: ${difference(serverDiffs[i], answers[i])}`).filter(Boolean);
    assert.deepEqual(differ, [], `${locale}: the in-page diff is the server's`);
    // (v) The notice, exactly: Compare among what the packs answer.
    if (locale === 'en-US') assert.equal(await page.textContent('.no-backend-notice-text'), noticeText(BUNDLED.length));
    await ctx.close();
  }

  // (ii) Compare on the compare-modes pair, then Pair by name and by id: the counts the live studio draws
  // (server/test-live-studio.mjs), the stat bar and the cards' per-column counts.
  {
    const { page, ctx } = await open(base, { selectedPackId: 'modes-a', selectedEnv: 'prod', compareBId: 'modes-b', compareBEnv: 'prod', view: 'compare' });
    const counts = () => page.evaluate(() => {
      const cell = (c) => Number(document.querySelector(`.compare-summary .compare-cell.${c} .c-val`)?.textContent);
      const sum = (sel) => [...document.querySelectorAll(sel)].reduce((n, el) => n + Number(el.textContent), 0);
      return {
        bar: { onlyInA: cell('c-a'), inBoth: cell('c-both'), onlyInB: cell('c-b') },
        cards: {
          onlyInA: sum('.compare-layer-col-a .compare-col-group.is-only .compare-col-group-n'),
          inBothA: sum('.compare-layer-col-a .compare-col-group.is-both .compare-col-group-n'),
          inBothB: sum('.compare-layer-col-b .compare-col-group.is-both .compare-col-group-n'),
          onlyInB: sum('.compare-layer-col-b .compare-col-group.is-only .compare-col-group-n'),
        },
        checked: document.querySelector('.compare-identity input:checked')?.value,
      };
    });
    const expectMode = async (mode, [onlyInA, inBoth, onlyInB]) => {
      await page.waitForFunction((m) => document.querySelector('.compare-summary .c-mode .c-val')?.textContent === m, mode, { timeout: T });
      assert.deepEqual(await counts(), { bar: { onlyInA, inBoth, onlyInB }, cards: { onlyInA, inBothA: inBoth, inBothB: inBoth, onlyInB }, checked: mode }, `Pair by ${mode}`);
    };
    await page.waitForSelector('.diag-subtab[data-sub="compare"]', { timeout: T });
    await page.click('.diag-subtab[data-sub="compare"]');
    await page.waitForSelector('.compare-summary .c-mode', { timeout: T });
    await expectMode('behaviour', [5, 15, 5]);
    await page.waitForSelector('.compare-identity input[value="name"]:not([disabled])', { timeout: T });
    await page.click('.compare-identity input[value="name"]');
    await expectMode('name', [4, 16, 4]);
    await page.click('.compare-identity input[value="id"]');
    await expectMode('id', [3, 17, 3]);
    await noServerAction(page, 'Compare');
    await ctx.close();
  }

  // (iii) payment-service against the live pack built in: Diagnose → Assessment → Comparison.
  {
    const { page, ctx } = await open(base, { selectedPackId: 'payment-service', compareBId: 'payment-live', view: 'compare', diagnoseSub: 'grade' });
    await page.waitForSelector('.diag-subtab[data-sub="grade"]', { timeout: T });
    await page.click('.diag-subtab[data-sub="grade"]');
    await page.waitForSelector('#diag-compare #drift-deploy-missing', { state: 'attached', timeout: T });
    assert.deepEqual(await drawnUnavailable(page, '#drift-deploy-missing'), [{ aria: 'true', why: DEPLOY, title: null }], 'the drift drill\'s deploy is drawn unavailable with the reason');
    await clickExplains(page, '#drift-deploy-missing');
    // Row 12: the drift-free blocker's fix keeps what the reader can do here.
    assert.ok((await viewText(page)).includes(staticRemedy('drift-free-fix', { product })), 'row 12');
    await noServerAction(page, 'Diagnose (with the live pack)');
    // Update repository from live: the request the page sends, answered in the page — the download is the updated
    // pack a server returns for the same request, its adoptedAt stamp aside.
    await page.evaluate(() => {
      const upstream = window.fetch;
      window.retrofeedSent = [];
      window.fetch = (input, init) => { if (String(input?.url ?? input).includes('/retrofeed')) window.retrofeedSent.push(init?.body); return upstream(input, init); };
    });
    await page.click('#drift-retrofeed');
    await page.waitForSelector('.drift-retrofeed-dl a[download$=".pack.yaml"]', { timeout: T });
    assert.equal(await page.textContent('.drift-retrofeed-note'), staticRemedy('retrofeed-result', { product }), 'row 11');
    const [saved] = await Promise.all([page.waitForEvent('download', { timeout: T }), page.click('.drift-retrofeed-dl a[download$=".pack.yaml"]')]);
    assert.equal(saved.suggestedFilename(), 'payment-service.pack.yaml');
    const updated = readFileSync(await saved.path(), 'utf8');
    const sent = JSON.parse((await page.evaluate(() => window.retrofeedSent))[0]);
    assert.equal(sent.packBId, 'payment-live');
    const server = await (await fetch(`${child.base}/api/packs/payment-service/retrofeed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...sent, packBId: serverId[sent.packBId] }) })).json();
    const STAMP = /observogram\.retrofeed\.adoptedAt: '?(\d{4}-\d\d-\d\dT[\d:.]+Z)/;
    assert.ok(server.summary.adopted > 0 && STAMP.test(updated), 'an updated pack with its provenance');
    assert.equal(updated, server.updatedPackYaml.replaceAll(STAMP.exec(server.updatedPackYaml)[1], STAMP.exec(updated)[1]), 'the download is the server\'s updated pack');
    await ctx.close();
  }

  // (iii) Remediate, payment-linked against the live pack: the decision header's deploy and the response path's per-SLO
  // button, each drawn unavailable with the reason and explained on click; the decision's filled button without its fill.
  {
    const { page, ctx } = await open(base, { selectedPackId: 'payment-linked', compareBId: 'payment-live', view: 'compile' });
    await page.waitForSelector('[data-ux-action="rm-deploy"]', { state: 'attached', timeout: T });
    await page.waitForSelector('.rflow-deploy', { state: 'attached', timeout: T });
    await drawnUnfilled(page, '.ux-rm-actions .remediate-deploy-btn');   // before a click's toast can cover it
    for (const sel of ['[data-ux-action="rm-deploy"]', '.rflow-deploy']) {
      const drawn = await drawnUnavailable(page, sel);
      assert.ok(drawn.length > 0, sel);
      assert.deepEqual(drawn, drawn.map(() => ({ aria: 'true', why: DEPLOY, title: null })), `${sel}: every one drawn unavailable with the reason`);
      await clickExplains(page, `${sel} >> nth=0`);
    }
    // Rows 20 and 26: the deploy action's hint and the rows' hint say deploying needs a server, over boxes drawn disabled.
    const rm = await page.evaluate(() => ({
      hint: document.querySelector('.ux-rm-actions [data-ux-action="rm-deploy"]')?.closest('.ux-rm-action')?.querySelector('.remediate-action-hint')?.textContent ?? null,
      rows: document.querySelector('.ux-rm-changes-hint')?.textContent ?? null,
      boxes: [...document.querySelectorAll('.remediate-item input[type=checkbox]')].map((b) => b.disabled),
    }));
    assert.deepEqual({ ...rm, boxes: [...new Set(rm.boxes)] }, { hint: `Changes live systems ${staticRemedy('remediate-deploy-hint', { product })}`, rows: staticRemedy('remediate-rows-hint', { product }), boxes: [true] }, 'Remediate\'s deploy hints, and the boxes disabled');
    await noServerAction(page, 'Remediate');
    await ctx.close();
  }
  // Remediate in a bundle of one pack, no Pack B: the decision's Review and deploy repository artefacts — the deploy
  // control a reader reaches without a live pack — drawn unavailable with the reason, without its fill, and explained.
  {
    const { page, ctx } = await open(oneBase, { selectedPackId: 'production-curated', view: 'compile' });
    const sel = '.ux-rm-actions [data-ux-action="rm-deploy-all"]';
    await page.waitForSelector(sel, { state: 'attached', timeout: T });
    assert.deepEqual(await drawnUnavailable(page, sel), [{ aria: 'true', why: DEPLOY, title: null }], `${sel}: drawn unavailable with the reason`);
    await drawnUnfilled(page, sel);
    await clickExplains(page, sel);
    await ctx.close();
  }

  // Traceability over payment-service and the live pack; then (iv) the Conformance view's audit report: the HTML
  // anchor downloads the report built in the page, its goes-blind section computed from the graph, and the in-page
  // JSON and HTML are the server's but for the declared fields (C5's masking), with the design kit the page extracts
  // from its own stylesheets.
  {
    const { page, ctx } = await open(base, { selectedPackId: 'payment-service', compareBId: 'payment-live', view: 'traceability' });
    await page.waitForSelector('.trace-view', { timeout: T });
    await noServerAction(page, 'Traceability');
    await page.click('.observa-adv-toggle');
    await page.click('.observa-adv-item[data-view="conformance"]');
    await page.waitForSelector('.conf-exports a[download]', { timeout: T });
    const href = await page.getAttribute('.conf-exports a[download]', 'href');
    assert.match(href, /^\/api\/packs\/payment-service\/audit-report\?format=html&download=1/);
    const env = new URL(href, base).searchParams.get('env');
    const jsonPath = `/api/packs/payment-service/audit-report${env ? `?env=${encodeURIComponent(env)}` : ''}`;
    const htmlPath = `${jsonPath}${env ? '&' : '?'}format=html`;
    const [report] = await Promise.all([page.waitForEvent('download', { timeout: T }), page.click('.conf-exports a[download]')]);
    assert.equal(report.suggestedFilename(), 'payment-service.audit-report.html');
    const reportHtml = readFileSync(await report.path(), 'utf8');
    assert.ok(reportHtml.includes('6. Goes-blind risks') && !reportHtml.includes('Not computed by this build'), 'the goes-blind section, computed in the page');
    const [pageJson, pageHtml] = await fetchInPage(page, [jsonPath, htmlPath]);
    const serverJson = await answerOf(await fetch(`${child.base}${jsonPath}`));
    const serverHtml = await answerOf(await fetch(`${child.base}${htmlPath}`));
    const headersOnly = (x) => ({ ...x, text: '' });
    assert.equal(difference(headersOnly(serverJson), headersOnly(pageJson)), '', 'the JSON report\'s status and headers');
    assert.equal(difference(headersOnly(serverHtml), headersOnly(pageHtml)), '', 'the HTML report\'s status and headers');
    const shimDoc = JSON.parse(pageJson.text);
    const { masked, problems: declared } = maskAudit(JSON.parse(serverJson.text), shimDoc);
    assert.deepEqual(declared, [], 'the declared fields read as declared');
    assert.equal(pageJson.text, JSON.stringify({ ...masked, generatedAt: shimDoc.generatedAt }), 'the in-page JSON, the page\'s clock aside');
    const rendered = (text) => renderAuditReportHtml({ ...masked, generatedAt: generatedOf(text) }, { brand: DEFAULT_BRAND, styles: REPORT_STYLES });
    assert.equal(pageHtml.text, rendered(pageHtml.text), 'the in-page HTML');
    assert.equal(reportHtml, rendered(reportHtml), 'the download: the server\'s numbers, the graph\'s included');
    await ctx.close();
  }

  // Row 6: production-curated as A, nothing live compared — the Assessment points at the live pack built in.
  {
    const { page, ctx } = await open(base, { selectedPackId: 'production-curated', view: 'compare', diagnoseSub: 'grade' });
    await page.waitForSelector('.diag-subtab[data-sub="grade"]', { timeout: T });
    await page.click('.diag-subtab[data-sub="grade"]');
    await page.waitForSelector('#diag-summary', { timeout: T });
    const row6 = staticRemedy('drift-free-no-live', { product, liveBuiltIn: true });
    await page.waitForFunction((want) => (document.querySelector('#layer-view')?.innerText || '').includes(want), row6, { timeout: 5_000 }).catch(() => {});
    assert.ok((await viewText(page)).includes(row6), `row 6: ${row6}`);
    await noServerAction(page, 'Diagnose (nothing live compared)');
    await ctx.close();
  }

  // Row 4: a bundle of one pack — nothing to compare it with.
  {
    const { page, ctx } = await open(oneBase, { selectedPackId: 'production-curated', view: 'compare' });
    await page.waitForSelector('.diag-subtab[data-sub="compare"]', { timeout: T });
    await page.click('.diag-subtab[data-sub="compare"]');
    await page.waitForSelector('.compare-digest .ux-empty-body', { timeout: T });
    assert.equal(await page.textContent('.compare-digest .ux-empty-body'), staticRemedy('compare-one-pack', { product }), 'row 4');
    assert.equal(await page.textContent('.no-backend-notice-text'), noticeText(1));
    await noServerAction(page, 'Compare (one pack)');
    await ctx.close();
  }

  // (vi) No page error, no console.error, nothing off the loopback; each host served the page and nothing else.
  assert.deepEqual(problems, [], 'no page error and no console.error');
  assert.deepEqual(offLoopback, [], 'no request left the loopback');
  assert.deepEqual([...new Set(asked)], ['/'], 'the static hosts were asked for the page only');
});

// ---------- C9 the built file, in Node ----------

// The import map's resolution, for modules that came out of the file: a data: module asking for a key gets that
// key's data: address; nothing else is touched (this suite's own imports are file: modules, and resolve as ever).
const RESOLVE_HOOK = `let map = {};
export async function initialize(data) { map = data.imports; }
export async function resolve(specifier, context, next) {
  if (context.parentURL && context.parentURL.startsWith('data:') && Object.hasOwn(map, specifier)) return { url: map[specifier], shortCircuit: true };
  return next(specifier, context);
}`;

test('C9 the built file, in Node: the shim imported from the CLI-built bundle\'s own data: address, through its import map, answers twelve /api/diff queries, a retrofeed and the audit report in JSON and HTML (its design kit read from the file\'s own stylesheets) as the server does — the map carries every package as installed, the dynamic imports are literal', async () => {
  const { ids, labels, canonicalOf, child } = await parity();
  // The six server packs and the compare-modes pair, under the server's ids and labels.
  const out = join(TMP, 'c9', 'index.html');
  const packArgs = [...SERVER_PACKS, [ids.modesA, 'tools/fixtures/compare-modes/a.pack.yaml'], [ids.modesB, 'tools/fixtures/compare-modes/b.pack.yaml']].flatMap(([id, rel]) => ['--pack', resolve(ROOT, rel), '--id', id, '--label', labels[id]]);
  const built = cli([...packArgs, '--out', out, '--no-remote-fonts']);
  assert.equal(built.status, 0, built.stderr);
  const html = readFileSync(out, 'utf8');
  const imports = importMapOf(html);
  const config = JSON.parse(new RegExp(`<script type="application/json" id="${CONFIG_ID}">([\\s\\S]*?)</script>`).exec(html)[1]);
  assert.deepEqual(config.packs.map((p) => p.id), [...SERVER_PACKS.map(([id]) => id), ids.modesA, ids.modesB]);
  assert.deepEqual(config.packs.map((p) => p.canonical), config.packs.map((p) => canonicalOf[p.id]), 'the file carries the packs the server holds');
  // The map carries every package, each address the installed entry file's bytes.
  for (const name of FOUR) assert.ok(decode(imports[name]).equals(readFileSync(join(packageDir(ROOT, name), ...PACKAGES[name].entry.split('/')))), `${name} as installed`);

  register(`data:text/javascript,${encodeURIComponent(RESOLVE_HOOK)}`, { data: { imports } });
  const shimUrl = imports['studio/static-backend.mjs'];
  assert.ok(shimUrl.startsWith(DATA_JS));
  const { createStaticBackend: fromFile, bundleStyles: stylesFromFile } = await import(shimUrl);
  assert.notEqual(fromFile, createStaticBackend, 'the file\'s shim, not the source\'s');
  // The audit report's design kit, as the page reads it: each inlined sheet's text (a <style> is raw text, so its
  // textContent is what the file holds between the tags), through the file's own bundleStyles.
  const sheetOf = (name) => {
    const open = `<style data-src="${name}">`;
    const at = html.indexOf(open);
    return at < 0 ? undefined : html.slice(at + open.length, html.indexOf('</style>', at));
  };
  let now = '2026-01-01T00:00:00.000Z';
  const backend = fromFile(config, { clock: () => now, styles: () => stylesFromFile(sheetOf) });

  const problems = [];
  const same = async (path, init) => {
    const server = await answerOf(await fetch(`${child.base}${path}`, init));
    now = /observogram\.retrofeed\.adoptedAt: '?(\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(server.text)?.[1] ?? now;
    const shim = await answerOf(await backend.handle(path, init));
    const problem = difference(server, shim);
    if (problem) problems.push(`${path}: ${problem}`);
    return server;
  };
  // Three pairs × the three scope modes the studio sends, an environment pair, A's 404, the 400.
  let graphs = 0;
  for (const [a, b] of [['payment-service', 'production-curated'], [ids.modesA, ids.modesB], ['grafana-reference', 'prometheus-reference']]) {
    for (const scopeMode of ['service', 'family', 'all']) {
      const r = await same(diffQuery({ a, b, scopeMode }));
      assert.equal(r.status, 200, `${a} × ${b} ${scopeMode}`);
      if (JSON.parse(r.text).traceabilityGraph) graphs++;
    }
  }
  assert.equal(graphs, 9, 'every answer carries the graph: the parser linked from the file');
  assert.equal((await same(diffQuery({ a: 'payment-service', b: 'target-advanced', aEnv: 'prod', bEnv: 'staging', scopeMode: 'service' }))).status, 200);
  assert.equal((await same(diffQuery({ a: 'nope', b: 'payment-service', scopeMode: 'service' }))).status, 404);
  assert.equal((await same(diffQuery({ b: 'payment-service' }))).status, 400);
  // Retrofeed, computed (compare-modes a → b adopts), the clock pinned to the server's stamp.
  const rf = await same(`/api/packs/${encodeURIComponent(ids.modesA)}/retrofeed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packBId: ids.modesB, scopeMode: 'service' }) });
  assert.equal(rf.status, 200);
  assert.ok(JSON.parse(rf.text).summary.candidates > 0, 'a computed update');
  // The audit report, JSON and HTML, its declared fields aside: the goes-blind section from the file's parser, the
  // HTML over the file's own stylesheets.
  const audit = await auditBothWays({ base: child.base, shim: backend, setNow: (v) => { now = v; }, path: '/api/packs/payment-service/audit-report?env=prod', problems });
  assert.deepEqual(problems, []);
  assert.equal(audit.shimDoc.goesBlind.available, true, 'the graph\'s shape, from the file');
  assert.ok(audit.html.includes(REPORT_STYLES), 'the design kit as the server reads it, extracted from the file');
});
