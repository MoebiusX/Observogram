#!/usr/bin/env node
// tools/test-vendor-manifest.mjs — VENDOR-MANIFEST.json is the update contract downstreams vendor by.
//
// docs/DOWNSTREAM.md: a downstream copies the listed tools/lib modules verbatim and upgrades by diffing the
// manifest. These tests hold the committed manifest to the tree (stale → regenerate), the listed modules to the
// purity rule (no node:*, no process, no DOM, import graph inside the set), the static export extraction to the
// real module namespaces, and every export change since the last release to a `## Unreleased` CHANGELOG entry
// that names the module — the breaking-change notice downstreams read. The last test proves the manifest is
// inert: nothing under server/, studio/ or tools/lib reads it.
//
// Run: node --test tools/test-vendor-manifest.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXCLUDED, PURITY_RULES, MANIFEST_FILE, staticExports, tokenize, importSpecifiers, relativeImports, bareImports, purityViolations,
  walkModules, buildVendorManifest, renderManifest, diffManifests, changelogUnreleasedSection, mentionsModule,
  validManifestPath, verifyVendoredTree, smokeVendoredTree, STALE_MESSAGE,
} from './gen-vendor-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
const committedText = read(MANIFEST_FILE).replace(/\r\n/g, '\n');
const committed = JSON.parse(committedText);
const pkg = JSON.parse(read('package.json'));

// The vendorable set, pinned like EXPECTED_TOOL_SURFACE in test-contract-guard.mjs: a purity rule that grows a
// false positive, or a module that leaves the set, fails here by name instead of quietly shrinking the manifest.
const EXPECTED_MODULES = [
  'tools/lib/adapter.mjs', 'tools/lib/alert-routes.mjs', 'tools/lib/artefact-classify.mjs', 'tools/lib/artefact-model.mjs',
  'tools/lib/assurance-rules.mjs', 'tools/lib/audit-report.mjs',
  'tools/lib/backend-products.mjs', 'tools/lib/blast-radius.mjs', 'tools/lib/brand.mjs', 'tools/lib/burn-rules.mjs', 'tools/lib/chain-history.mjs',
  'tools/lib/compile.mjs', 'tools/lib/conformance.mjs', 'tools/lib/contracts/mcp-capabilities.mjs',
  'tools/lib/contracts/response-shapes.mjs', 'tools/lib/contracts/stack-self-metrics.mjs', 'tools/lib/crawler.mjs',
  'tools/lib/dashboards/generic.mjs', 'tools/lib/dashboards/lib.mjs', 'tools/lib/diff.mjs', 'tools/lib/good-when.mjs', 'tools/lib/identity-modes.mjs',
  'tools/lib/inventory-coverage.mjs', 'tools/lib/journey-notify.mjs', 'tools/lib/l2x.mjs', 'tools/lib/legacy.mjs',
  'tools/lib/library.mjs', 'tools/lib/live-fetch.mjs', 'tools/lib/mcp-client.mjs', 'tools/lib/mcp-server-settings.mjs', 'tools/lib/mcp-url-safety.mjs', 'tools/lib/mini-yaml.mjs', 'tools/lib/neuron-model.mjs',
  'tools/lib/pack-conformance.mjs', 'tools/lib/profiles.mjs', 'tools/lib/promql-canon.mjs', 'tools/lib/promql-lezer.mjs', 'tools/lib/promql.mjs',
  'tools/lib/protocols.mjs', 'tools/lib/remediation-flow.mjs', 'tools/lib/schedule-snippets.mjs', 'tools/lib/schedule.mjs', 'tools/lib/service-keys.mjs',
  'tools/lib/site/derive.mjs', 'tools/lib/site/expected.mjs', 'tools/lib/site/inventory.mjs', 'tools/lib/site/run.mjs',
  'tools/lib/site/timing.mjs', 'tools/lib/sli-inference.mjs', 'tools/lib/slug.mjs', 'tools/lib/stack-evidence.mjs',
  'tools/lib/svg-charts.mjs', 'tools/lib/traceability-graph.mjs', 'tools/lib/traceability.mjs', 'tools/lib/validator.mjs',
  'tools/lib/waivers.mjs', 'tools/lib/zip.mjs',
];
const EXPECTED_EXCLUDED = ['tools/lib/brand-env.mjs', 'tools/lib/grafana-mcp-bridge.mjs', 'tools/lib/harness.mjs', 'tools/lib/journey.mjs', 'tools/lib/retrofeed.mjs'];
const EXPECTED_DATA = ['tools/lib/site/inventory.schema.json'];

test('VENDOR-MANIFEST.json is in sync with tools/lib (built from the committed manifest as its own baseline)', () => {
  const fresh = buildVendorManifest({ repoRoot: ROOT, previous: committed, pkg });
  const diff = diffManifests(committed, fresh);
  assert.equal(renderManifest(fresh), committedText, `${STALE_MESSAGE}\n  ${diff.join('\n  ')}`);
  assert.equal(committed.version, pkg.version, 'the manifest carries the package version');
  assert.equal(committed.manifestVersion, 1);
  assert.equal(committed.root, 'tools/lib');
  assert.ok(!('specVersion' in committed), 'the spec version is validator.mjs\'s business, not the manifest\'s');
});

test('every .mjs under tools/lib is listed or excluded, never both, and the sets are the pinned ones', () => {
  const tree = walkModules(ROOT);
  assert.equal(tree.modules.length, EXPECTED_MODULES.length + EXPECTED_EXCLUDED.length, 'one decision per module under tools/lib');
  assert.deepEqual(Object.keys(committed.modules), EXPECTED_MODULES, 'the vendorable set changed: update EXPECTED_MODULES in the same commit and say why in the CHANGELOG');
  assert.deepEqual(Object.keys(EXCLUDED).sort(), EXPECTED_EXCLUDED, 'the excluded set changed: update EXPECTED_EXCLUDED and the reason text');
  assert.deepEqual(Object.keys(committed.excluded).sort(), EXPECTED_EXCLUDED);
  assert.deepEqual(Object.keys(committed.data), EXPECTED_DATA);
  for (const p of tree.modules) {
    const listed = p in committed.modules; const excluded = p in EXCLUDED;
    assert.ok(listed !== excluded, `${p} is neither in ${MANIFEST_FILE} nor in EXCLUDED (tools/gen-vendor-manifest.mjs) — decide and say why`);
  }
  for (const [p, reason] of Object.entries(EXCLUDED)) {
    assert.ok(fs.existsSync(path.join(ROOT, p)), `${p} is excluded but gone — remove the stale exclusion`);
    assert.ok(reason.length > 20, `${p}: the exclusion reason is published in the manifest — say why`);
    assert.equal(committed.excluded[p], reason);
  }
});

test('listed modules are pure; the excluded impure ones break at least one rule; template prose is not a hit', () => {
  for (const p of Object.keys(committed.modules)) assert.deepEqual(purityViolations(read(p)), [], `${p} is listed but impure`);
  for (const p of ['tools/lib/journey.mjs', 'tools/lib/brand-env.mjs', 'tools/lib/grafana-mcp-bridge.mjs', 'tools/lib/harness.mjs']) {
    assert.ok(purityViolations(read(p)).length >= 1, `${p} should break a purity rule — the rules have gone soft`);
  }
  // retrofeed.mjs is pure by the rules; it is out because its import graph leaves tools/lib.
  assert.deepEqual(purityViolations(read('tools/lib/retrofeed.mjs')), []);
  assert.deepEqual(relativeImports(read('tools/lib/retrofeed.mjs')), ['../../studio/verify-deploy.mjs']);
  // The three modules whose template literals say "window." or ".slo.window[" in prose must stay in.
  for (const p of ['tools/lib/compile.mjs', 'tools/lib/burn-rules.mjs', 'tools/lib/library.mjs']) {
    assert.ok(p in committed.modules, `${p} must be vendorable`);
    assert.match(read(p), /window[.[]/, `${p} is the regression case for the DOM rule`);
  }
  assert.equal(PURITY_RULES.length, 5);
  assert.deepEqual(PURITY_RULES.map(r => r.kind).sort(), ['code', 'code', 'code', 'code', 'specifier']);
});

test('the import closure stays inside the manifest; bare imports are declared dependencies', () => {
  const listed = new Set(Object.keys(committed.modules));
  for (const [p, entry] of Object.entries(committed.modules)) {
    for (const dep of entry.imports) assert.ok(listed.has(dep), `${p} imports ${dep}, which is not a vendorable module`);
    for (const name of entry.npm) assert.ok(name in pkg.dependencies, `${p} needs ${name}, which package.json does not declare`);
    assert.ok(!entry.imports.includes(p), `${p} lists itself`);
  }
  assert.ok(committed.modules['tools/lib/compile.mjs'].imports.includes('tools/lib/dashboards/generic.mjs'), 'compile pulls the dashboard generator');
  assert.deepEqual(committed.modules['tools/lib/promql-lezer.mjs'].npm, ['@prometheus-io/lezer-promql']);
  assert.deepEqual(Object.entries(committed.modules).filter(([, e]) => e.npm.length).map(([p]) => p), ['tools/lib/promql-lezer.mjs'], 'one npm-dependent module');
  assert.deepEqual(bareImports(read('tools/lib/promql-lezer.mjs')), ['@prometheus-io/lezer-promql']);
  // Dynamic specifiers are read too: journey.mjs's `await import('../fetch-live-pack.mjs')` leaves tools/lib.
  const journey = relativeImports(read('tools/lib/journey.mjs'));
  assert.ok(journey.includes('../fetch-live-pack.mjs'), 'dynamic import() specifiers are extracted');
  assert.ok(journey.includes('../../studio/diagnostic-grade.mjs'));
  assert.deepEqual(bareImports(read('tools/lib/journey.mjs')), ['node:fs', 'node:path', 'node:url']);
});

test('static exports equal the real module namespace for every listed module', async () => {
  for (const [p, entry] of Object.entries(committed.modules)) {
    const ns = await import(new URL(`../${p}`, import.meta.url).href);
    assert.deepEqual(entry.exports, Object.keys(ns).sort(), `${p}: the extractor and the module disagree`);
    assert.deepEqual(entry.exports, staticExports(read(p), p));
    assert.ok(entry.exports.length >= 1, `${p} exports nothing`);
  }
});

test('staticExports reads every export form in the tree and refuses the ones it does not', () => {
  const src = [
    'export const A = 1;', 'export let B = 2;', 'export var C = 3;',
    'export function f() {}', 'export async function g() {}', 'export function* h() {}', 'export class K {}',
    'export { x as y, z };', "export { w } from './w.mjs';", 'export {', '  multi,', '  line as aliased,', '};',
    '// export function dead() {}', '/* export const alsoDead = 1; */',
    "const s = 'export const inString = 1';", 'const t = `export function inTemplate() {}`;',
    'const r = /export const inRegex/;',
  ].join('\n');
  assert.deepEqual(staticExports(src), ['A', 'B', 'C', 'K', 'aliased', 'f', 'g', 'h', 'multi', 'w', 'y', 'z']);
  assert.throws(() => staticExports('export const a = 1;\nexport default a;', 'x.mjs'), /^Error: x\.mjs:2: export form not supported by the manifest extractor \(export default \/ export \*\) — extend staticExports deliberately$/);
  assert.throws(() => staticExports("export * from './y.mjs';", 'x.mjs'), /x\.mjs:1: export form not supported/);
  assert.throws(() => staticExports('export * as ns from "./y.mjs";', 'x.mjs'), /not supported/);
});

test('the tokenizer: comments, strings, templates with nested ${} and regex literals are not code', () => {
  // The compile.mjs patterns that break regex stripping: `/*` inside a `//` comment, `/* … */` inside a template.
  const src = [
    '// under provisioning/alerting/*.yaml',
    'export const a = 1;',
    'parts.push(`/* === ${id} === */`);',
    'export const b = 2;',
    'const d = `the ${short} window.`;',
    'const e = `${at}.slo.window[${t}]: expected`;',
    "if (/[\\s\"\\\\]/.test(v)) throw e('x');",
    "const q = s.replace(/''/g, \"'\");",
    'const nested = `a ${ `b ${ c } d` } e`;',
    'export const f = 3;',
  ].join('\n');
  const { code } = tokenize(src);
  assert.equal(code.length, src.length, 'positions are preserved');
  assert.equal(code.split('\n').length, src.split('\n').length, 'newlines are preserved');
  assert.deepEqual(staticExports(src), ['a', 'b', 'f'], 'export inside a template after an unmatched /* still counts');
  assert.ok(!/window/.test(code), 'template prose is blanked');
  assert.ok(/\bid\b/.test(code) && /\bshort\b/.test(code) && /\bat\b/.test(code), '${} expressions stay code');
  assert.ok(/\bc\b/.test(code), 'nested template expressions stay code');
  assert.ok(!/alerting/.test(code) && !/===/.test(code), 'comment and template text are gone');
  assert.deepEqual(purityViolations(src), []);
  // The tightened DOM rule: prose in a template is not a hit, identifier access is.
  assert.deepEqual(purityViolations('const s = `in the ${short} window.`;'), []);
  assert.deepEqual(purityViolations("const s = `${at}.slo.window[${t}]: expected ${X.join('|')}`;"), []);
  assert.deepEqual(purityViolations('const w = window.innerWidth;'), [{ line: 1, rule: PURITY_RULES[2].rule }]);
  assert.deepEqual(purityViolations("const w = localStorage['k'];"), [{ line: 1, rule: PURITY_RULES[2].rule }]);
  assert.deepEqual(purityViolations('const t = `${process.env.X}`;'), [{ line: 1, rule: PURITY_RULES[1].rule }]);
  assert.deepEqual(purityViolations("// process.env is fine in a comment\nconst s = 'process.env too';"), []);
  assert.deepEqual(purityViolations("import fs from 'node:fs';\nconst m = import.meta.url;"), [{ line: 1, rule: PURITY_RULES[0].rule }, { line: 2, rule: PURITY_RULES[3].rule }]);
  assert.deepEqual(purityViolations("const x = require('x');"), [{ line: 1, rule: PURITY_RULES[4].rule }]);
  // Import specifiers: static, re-export, side-effect, dynamic — never from a plain string.
  const imports = "import a from './a.mjs';\nimport { b } from \"../b.mjs\";\nexport { c } from './c.mjs';\nimport 'side-effect';\nconst d = await import('./d.mjs');\nconst notOne = 'from ./nope.mjs';\nconst s = './also-nope.mjs';";
  assert.deepEqual(importSpecifiers(imports).map(s => s.spec), ['./a.mjs', '../b.mjs', './c.mjs', 'side-effect', './d.mjs']);
  assert.deepEqual(relativeImports(imports), ['./a.mjs', '../b.mjs', './c.mjs', './d.mjs']);
  assert.deepEqual(bareImports(imports), ['side-effect']);
});

test('changedSinceRelease is computed from the last release baseline, carried across regenerations', () => {
  const build = (previous) => buildVendorManifest({ repoRoot: ROOT, previous, pkg });
  const P = 'tools/lib/slug.mjs';
  // Fixtures start from a release-reset manifest (nothing flagged) and derive from the module's
  // current export list, never a literal copy of it: a real export rename must fail only the
  // sync/namespace tests and the CHANGELOG guard, not these — before and after the CHANGELOG entry.
  const pristine = build(null);
  const pristineText = renderManifest(pristine);
  const prevFrom = (mutate) => { const prev = JSON.parse(pristineText); mutate(prev); return prev; };
  const live = pristine.modules[P].exports;
  assert.ok(live.length >= 2, `${P} needs at least two exports for this fixture`);
  const renamedAway = live[live.length - 1];
  const baseline = [...live.slice(0, -1), 'oldName'].sort();
  // (a) same exports → false, no releasedExports.
  const same = build(pristine);
  assert.equal(same.modules[P].changedSinceRelease, false);
  assert.ok(!('releasedExports' in same.modules[P]));
  // (b) a renamed export → true, releasedExports = the baseline.
  const renamed = prevFrom(p => { p.modules[P].exports = baseline; });
  const b = build(renamed);
  assert.equal(b.modules[P].changedSinceRelease, true);
  assert.deepEqual(b.modules[P].releasedExports, baseline);
  // (c) rename then revert across two regenerations → false again (the baseline was carried, not replaced).
  const c1 = build(b);
  assert.deepEqual(c1.modules[P].releasedExports, baseline, 'the baseline is carried');
  const reverted = prevFrom(p => { p.modules[P].changedSinceRelease = true; p.modules[P].releasedExports = live; p.modules[P].exports = live.slice(0, 1); });
  const c2 = build(reverted);
  assert.equal(c2.modules[P].changedSinceRelease, false);
  assert.ok(!('releasedExports' in c2.modules[P]));
  // (d) a new module → true, releasedExports: null; (h) and it stays so across consecutive regenerations.
  const without = prevFrom(p => { delete p.modules[P]; });
  const d = build(without);
  assert.equal(d.modules[P].changedSinceRelease, true);
  assert.equal(d.modules[P].releasedExports, null);
  const h = build(d);
  assert.equal(h.modules[P].changedSinceRelease, true, 'a new module stays flagged until the release');
  assert.equal(h.modules[P].releasedExports, null);
  assert.equal(renderManifest(build(h)), renderManifest(h), 'regeneration is idempotent');
  // (e) a removed module → removedSinceRelease, carried forward; one that comes back leaves the list.
  const extra = prevFrom(p => { p.modules['tools/lib/gone.mjs'] = { sha256: '0', bytes: 0, exports: ['x'], imports: [], npm: [], changedSinceRelease: false }; });
  const e = build(extra);
  assert.deepEqual(e.removedSinceRelease, ['tools/lib/gone.mjs']);
  assert.deepEqual(build(e).removedSinceRelease, ['tools/lib/gone.mjs'], 'carried forward');
  const neverReleased = prevFrom(p => { p.modules['tools/lib/gone.mjs'] = { sha256: '0', bytes: 0, exports: ['x'], imports: [], npm: [], changedSinceRelease: true, releasedExports: null }; });
  assert.deepEqual(build(neverReleased).removedSinceRelease, [], 'a module added and removed inside one release window was never promised');
  const back = prevFrom(p => { delete p.modules[P]; p.removedSinceRelease = [P]; });
  assert.deepEqual(build(back).removedSinceRelease, [], 'a module that returns is no longer removed');
  // (f) another version → full reset.
  const released = prevFrom(p => { p.version = '0.0.1'; p.modules[P].exports = ['other']; p.modules['tools/lib/gone.mjs'] = { exports: ['x'] }; p.removedSinceRelease = ['tools/lib/old.mjs']; });
  const f = build(released);
  assert.equal(f.modules[P].changedSinceRelease, false);
  assert.deepEqual(f.removedSinceRelease, []);
  assert.ok(Object.values(f.modules).every(m => m.changedSinceRelease === false && !('releasedExports' in m)));
  // No previous manifest at all is the same baseline.
  assert.equal(renderManifest(build(null)), renderManifest(f));
  // (g) a hash-only change never flags.
  const rehashed = prevFrom(p => { p.modules[P].sha256 = 'deadbeef'; p.modules[P].bytes = 1; });
  assert.equal(build(rehashed).modules[P].changedSinceRelease, false);
  assert.ok(diffManifests(rehashed, build(rehashed)).some(l => l === `~ ${P} body changed (sha256), exports unchanged`));
  assert.ok(diffManifests(renamed, b).some(l => l === `~ ${P} exports: -oldName +${renamedAway}`), 'the --check diff names the export delta');
});

/** The guard's rule, as the live test applies it: every message is a failure. */
function changelogProblems(manifest, md) {
  const section = changelogUnreleasedSection(md);
  const flagged = Object.entries(manifest.modules).filter(([, e]) => e.changedSinceRelease).map(([p]) => p);
  const problems = [];
  if ((flagged.length || manifest.removedSinceRelease.length) && section === null) {
    return [`docs/CHANGELOG.md has no "## Unreleased" heading — add a \`## Unreleased\` entry naming ${[...flagged, ...manifest.removedSinceRelease].join(', ')}`];
  }
  for (const p of flagged) {
    if (mentionsModule(section, p)) continue;
    const e = manifest.modules[p];
    const base = p.split('/').pop();
    const delta = e.releasedExports === null ? 'new module since the release' : `exports since v${manifest.version}: ${JSON.stringify(e.releasedExports)} → now ${JSON.stringify(e.exports)}`;
    problems.push(`${p} changed its exports since v${manifest.version} — name it under "## Unreleased" in docs/CHANGELOG.md (downstreams read that entry as the breaking-change notice). Checked: no line under "## Unreleased" names ${p} or \`${base}\`. ${delta}. The mention check is a heuristic; the manifest diff in the PR is the review.`);
  }
  for (const p of manifest.removedSinceRelease) {
    if (mentionsModule(section, p)) continue;
    problems.push(`${p} was removed from the vendorable set since v${manifest.version} — name it under "## Unreleased" in docs/CHANGELOG.md. Checked: no line under "## Unreleased" names ${p} or \`${p.split('/').pop()}\`.`);
  }
  return problems;
}

test('the CHANGELOG names every module whose exports changed since the release', () => {
  const md = '# Changelog\n\n## Unreleased\n\n### Things\n- `diff.mjs` grew `bucketsOf`; `tools/lib/slug.mjs` lost `oldName`.\n- the diff view\n\n## 0.5.0 — 2026-10-01\n- `tools/lib/compile.mjs` renamed everything\n';
  const section = changelogUnreleasedSection(md);
  assert.equal(section, '\n### Things\n- `diff.mjs` grew `bucketsOf`; `tools/lib/slug.mjs` lost `oldName`.\n- the diff view\n');
  assert.equal(mentionsModule(section, 'tools/lib/diff.mjs'), true, 'the backticked basename');
  assert.equal(mentionsModule(section, 'tools/lib/slug.mjs'), true, 'the repo-relative path');
  assert.equal(mentionsModule(section, 'tools/lib/compile.mjs'), false, 'a mention under a released version does not count');
  assert.equal(mentionsModule(section, 'tools/lib/view.mjs'), false, 'the bare word "view" is not a mention');
  assert.equal(mentionsModule(null, 'tools/lib/diff.mjs'), false);
  assert.equal(changelogUnreleasedSection('# Changelog\n\n## 0.5.0\n- x\n'), null);
  assert.equal(changelogUnreleasedSection('## Unreleased\n- only\n'), '- only\n');
  assert.equal(changelogUnreleasedSection('## Unreleased\r\n- crlf\r\n## 0.1\r\n'), '- crlf');

  const synthetic = {
    version: '0.5.0', removedSinceRelease: ['tools/lib/gone.mjs'],
    modules: {
      'tools/lib/diff.mjs': { exports: ['a', 'bucketsOf'], changedSinceRelease: true, releasedExports: ['a'] },
      'tools/lib/slug.mjs': { exports: ['fileSlug'], changedSinceRelease: true, releasedExports: ['fileSlug', 'oldName'] },
      'tools/lib/fresh.mjs': { exports: ['x'], changedSinceRelease: true, releasedExports: null },
      'tools/lib/compile.mjs': { exports: ['c'], changedSinceRelease: false },
    },
  };
  const problems = changelogProblems(synthetic, md);
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(problems[0], /^tools\/lib\/fresh\.mjs changed its exports since v0\.5\.0 — name it under "## Unreleased" in docs\/CHANGELOG\.md \(downstreams read that entry as the breaking-change notice\)\. Checked: no line under "## Unreleased" names tools\/lib\/fresh\.mjs or `fresh\.mjs`\. new module since the release\./);
  assert.match(problems[1], /^tools\/lib\/gone\.mjs was removed from the vendorable set since v0\.5\.0 — name it under "## Unreleased" in docs\/CHANGELOG\.md\. Checked: no line under "## Unreleased" names tools\/lib\/gone\.mjs or `gone\.mjs`\.$/);
  const flaggedNoHeading = changelogProblems(synthetic, '# Changelog\n\n## 0.5.0\n- `fresh.mjs` `gone.mjs` `diff.mjs` `slug.mjs`\n');
  assert.deepEqual(flaggedNoHeading, ['docs/CHANGELOG.md has no "## Unreleased" heading — add a `## Unreleased` entry naming tools/lib/diff.mjs, tools/lib/slug.mjs, tools/lib/fresh.mjs, tools/lib/gone.mjs']);
  assert.deepEqual(changelogProblems({ version: '0.5.0', removedSinceRelease: [], modules: { 'tools/lib/a.mjs': { exports: [], changedSinceRelease: false } } }, '# nothing'), [], 'nothing flagged needs no heading');
  const withDelta = changelogProblems({ version: '0.5.0', removedSinceRelease: [], modules: { 'tools/lib/slug.mjs': { exports: ['fileSlug'], changedSinceRelease: true, releasedExports: ['fileSlug', 'oldName'] } } }, '## Unreleased\n- nothing relevant\n');
  assert.match(withDelta[0], /exports since v0\.5\.0: \["fileSlug","oldName"\] → now \["fileSlug"\]/, 'reviewers see the export delta');

  // The live assertion over the committed manifest and docs/CHANGELOG.md.
  const live = changelogProblems(committed, read('docs/CHANGELOG.md'));
  assert.deepEqual(live, [], live.join('\n\n'));
});

test('--verify and --smoke run a vendored copy against its manifest, with manifest paths validated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-manifest-'));
  try {
    const subset = (paths) => ({ ...committed, modules: Object.fromEntries(paths.map(p => [p, committed.modules[p]])), data: {} });
    const copy = (p) => { const dst = path.join(dir, ...p.split('/')); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(ROOT, ...p.split('/')), dst); return dst; };
    const writeManifest = (doc) => fs.writeFileSync(path.join(dir, MANIFEST_FILE), renderManifest(doc));
    const three = ['tools/lib/slug.mjs', 'tools/lib/good-when.mjs', 'tools/lib/protocols.mjs'];
    for (const p of three) copy(p);
    writeManifest({ ...subset(three), data: committed.data });
    copy('tools/lib/site/inventory.schema.json');
    assert.deepEqual(verifyVendoredTree(dir), [...three, 'tools/lib/site/inventory.schema.json'].map(p => ({ path: p, status: 'ok' })));
    // Drift: one byte flipped. A CRLF copy is drift with a hint.
    const slug = path.join(dir, 'tools', 'lib', 'slug.mjs');
    const original = fs.readFileSync(slug, 'utf8');
    fs.writeFileSync(slug, original.replace('fallback', 'fallbak'));
    assert.deepEqual(verifyVendoredTree(dir).find(r => r.path === 'tools/lib/slug.mjs'), { path: 'tools/lib/slug.mjs', status: 'drift' });
    fs.writeFileSync(slug, original.replace(/\n/g, '\r\n'));
    assert.deepEqual(verifyVendoredTree(dir).find(r => r.path === 'tools/lib/slug.mjs'), { path: 'tools/lib/slug.mjs', status: 'drift', hint: 'line endings differ (CRLF) — copy the bytes verbatim' });
    fs.writeFileSync(slug, original);
    // Missing: a file not copied.
    fs.unlinkSync(path.join(dir, 'tools', 'lib', 'protocols.mjs'));
    assert.deepEqual(verifyVendoredTree(dir).map(r => r.status), ['ok', 'ok', 'missing', 'ok']);
    // Smoke: the two zero-import modules import with the listed exports.
    writeManifest(subset(['tools/lib/slug.mjs', 'tools/lib/good-when.mjs']));
    assert.deepEqual(await smokeVendoredTree(dir), [{ path: 'tools/lib/slug.mjs', status: 'ok' }, { path: 'tools/lib/good-when.mjs', status: 'ok' }]);
    // alert-routes.mjs without artefact-model.mjs fails on the import; a manifest whose exports lie fails on the comparison.
    copy('tools/lib/alert-routes.mjs');
    const lying = subset(['tools/lib/alert-routes.mjs', 'tools/lib/slug.mjs']);
    const slugExports = committed.modules['tools/lib/slug.mjs'].exports;
    const lie = slugExports.slice(0, 1);
    lying.modules['tools/lib/slug.mjs'] = { ...lying.modules['tools/lib/slug.mjs'], exports: lie };
    writeManifest(lying);
    const smoke = await smokeVendoredTree(dir);
    assert.equal(smoke[0].status, 'fail');
    assert.match(smoke[0].error, /artefact-model\.mjs|Cannot find module/, 'the missing dependency is named');
    assert.equal(smoke[1].status, 'fail');
    assert.equal(smoke[1].error, `exports differ: manifest ${JSON.stringify(lie)}, module ${JSON.stringify(slugExports)}`);
    // Paths: every key must stay under root.
    for (const bad of ['tools/lib/../../etc/passwd', '/tools/lib/x.mjs', 'tools\\lib\\x.mjs', 'studio/app.mjs', 'tools/lib//x.mjs', 'tools/lib/./x.mjs']) {
      assert.equal(validManifestPath(bad, 'tools/lib'), false, bad);
      writeManifest({ ...subset([]), modules: { [bad]: { sha256: '0', bytes: 0, exports: [] } } });
      assert.throws(() => verifyVendoredTree(dir), new RegExp(`^Error: VENDOR-MANIFEST\\.json: invalid path ${JSON.stringify(bad).replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')} — every entry must be a relative POSIX path under tools/lib/ with no "\\.\\.", leading "/" or backslash$`));
      await assert.rejects(() => smokeVendoredTree(dir), /invalid path/);
    }
    assert.equal(validManifestPath('tools/lib/site/run.mjs', 'tools/lib'), true);
    assert.ok(Object.keys(committed.modules).concat(Object.keys(committed.data)).every(p => validManifestPath(p, committed.root)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inert by default: no runtime file reads the manifest, and the generator imports nothing from tools/lib', () => {
  const walk = (dir, out = []) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (!/node_modules|fixtures/.test(ent.name)) walk(p, out); } else if (/\.(mjs|html|css)$/.test(ent.name)) out.push(p);
    }
    return out;
  };
  const runtime = [...walk(path.join(ROOT, 'server')), ...walk(path.join(ROOT, 'studio')), ...walk(path.join(ROOT, 'tools', 'lib'))];
  assert.ok(runtime.length > 100, 'the runtime tree was walked');
  for (const f of runtime) assert.ok(!fs.readFileSync(f, 'utf8').includes('VENDOR-MANIFEST'), `${path.relative(ROOT, f)} reads the manifest — it is a contract for downstreams, not runtime input`);
  const gen = read('tools/gen-vendor-manifest.mjs');
  assert.ok(!/from\s+['"]\.\/lib\//.test(gen) && !/import\(\s*['"]\.\/lib\//.test(gen), 'the generator is self-contained so a downstream can copy it beside the manifest');
  assert.deepEqual(bareImports(gen), ['node:fs', 'node:path', 'node:crypto', 'node:url'], 'node built-ins only');
  assert.ok(pkg.files.includes('VENDOR-MANIFEST.json'), 'the manifest ships with the package');
  assert.equal(pkg.scripts['vendor-manifest'], 'node tools/gen-vendor-manifest.mjs --write');
  assert.equal(pkg.scripts['vendor-manifest:check'], 'node tools/gen-vendor-manifest.mjs --check');
  assert.ok(pkg.scripts.test.split(' ').includes('tools/test-vendor-manifest.mjs'), 'this suite runs under npm test');
});
