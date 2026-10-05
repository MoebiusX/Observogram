#!/usr/bin/env node
/**
 * tools/test-audit-report.mjs — the service audit report (GAP batch 2 B3.5,
 * tools/lib/audit-report.mjs) and its CLI (tools/audit-report.mjs).
 *
 * The model: the vendoring guard, CLAUSE_FAMILIES over every rubric id, the
 * walk every artefact count shares, determinism, the honest texts (none
 * recorded / not recorded by this build), the sections over real packs and
 * synthesised inputs, the escaping over a hostile input, the goldens:
 *
 *   tools/fixtures/golden/audit-report/<name>.audit-report.golden.{json,html}
 *
 * for payment-service (the vendored example), http-service.tier-3 (a
 * library build at tier-3: placeholders, L2X families absent and never
 * missing), edge-hostile-names (the compiler's hostile fixture) and
 * payment-service.branded (the acme brand). Unstamped (generatedAt null)
 * and generator-less, so the bytes depend on the inputs alone.
 *
 * To update after an INTENDED output change:
 *   node tools/test-audit-report.mjs --update
 * then review `git diff tools/fixtures/golden/audit-report/`.
 *
 * The CLI: the --no-timestamp document against the golden, the HTML, --out,
 * every flag, every refusal and the flag-documentation pin.
 *
 * Run: node --test tools/test-audit-report.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { SPEC_DIR } from './lib/validator.mjs';
import { adapt, overlaidCanonical } from './lib/adapter.mjs';
import { RUBRIC, evaluateConformance } from './lib/conformance.mjs';
import { FAMILIES } from './lib/artefact-classify.mjs';
import { buildDependencyGraph, graphShape } from './lib/traceability-graph.mjs';
import { normalizeBrand } from './lib/brand.mjs';
import { applyWaiversToConformance, normalizeWaiver } from './lib/waivers.mjs';
import {
  AUDIT_REPORT_VERSION, CLAUSE_FAMILIES, COVERAGE_STATUSES, DEFAULT_RISK_TOP, L4_SUBGROUPS, LAYER_ORDER, REPORT_CSS, RISK_TOP_MAX,
  VERDICT_STATES, WAIVER_STATUSES, assessmentSummary, auditReportFilename, buildAuditReport, coverageByFamily, flattenArtefacts,
  goesBlindRisks, placeholdersOf, renderAuditReportHtml, responsePath, splitClauses, waiverSummary,
} from './lib/audit-report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => resolve(ROOT, p);
const read = (p) => readFileSync(rel(p), 'utf8');
const GOLDEN_DIR = 'tools/fixtures/golden/audit-report';
const UPDATE = process.argv.includes('--update');

const load = (p) => (p.endsWith('.json') ? JSON.parse(read(p)) : parseYaml(read(p)));
const PAYMENT = `${SPEC_DIR}/examples/payment-service.pack.yaml`;
const HTTP3 = 'tools/fixtures/library/http-service.tier-3.pack.yaml';
const HOSTILE = 'tools/fixtures/compile/edge-hostile-names.pack.yaml';
const ACME = normalizeBrand(JSON.parse(read('tools/fixtures/brand/acme.json')));
const STYLES = `${read('studio/design-tokens.css')}\n${read('studio/design-kit.css')}`;

// A report's inputs over a pack file, graded as declared (the CLI's and a catalogue pack's reading).
function inputsFor(path, over = {}) {
  const canonical = load(path);
  const adapted = adapt(canonical);
  return { pack: { id: over.id ?? path.split('/').pop().replace(/\.pack\.(yaml|json)$/, ''), label: null, source: null }, canonical, adapted, conformance: evaluateConformance(canonical), graph: graphShape(buildDependencyGraph(adapted)), verdicts: over.verdicts ?? null, waivers: over.waivers ?? null, environment: null, generatedAt: null, generator: null, ...over };
}
const build = (path, over) => buildAuditReport(inputsFor(path, over));

const NOW = '2026-10-05T12:00:00.000Z';
const IN_30D = '2026-11-04T12:00:00.000Z';
const PAST = '2026-01-01T00:00:00.000Z';

// ---------- 1. the module ----------

test('vendoring: the module imports only its five listed siblings, no node:*, no DOM, no clock; it is a listed module; the constants', () => {
  const src = read('tools/lib/audit-report.mjs');
  const imports = [...src.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./artefact-classify.mjs', './blast-radius.mjs', './brand.mjs', './pack-conformance.mjs', './remediation-flow.mjs']);
  assert.ok(!/from '\.\/traceability-graph\.mjs'/.test(src), 'the graph arrives as a shape: the parser-bound module is never imported');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/node:|\b(?:process|document|window|navigator)\s*[.[]|Date\.now|new Date\(/.test(code), 'browser-safe and clock-free');
  assert.ok(JSON.parse(read('VENDOR-MANIFEST.json')).modules['tools/lib/audit-report.mjs'], 'listed in VENDOR-MANIFEST.json');
  assert.equal(AUDIT_REPORT_VERSION, 1);
  assert.deepEqual([...VERDICT_STATES], ['unreviewed', 'trusted', 'suspect', 'failed']);
  assert.deepEqual([...WAIVER_STATUSES], ['active', 'expired', 'revoked', 'unknown']);
  assert.deepEqual([...COVERAGE_STATUSES], ['present', 'absent', 'missing']);
  assert.deepEqual([DEFAULT_RISK_TOP, RISK_TOP_MAX], [10, 100]);
  assert.ok(/^\.ar-/m.test(REPORT_CSS) && !/(?:^|,\s*)\.og-/m.test(REPORT_CSS), 'the report styles its own .ar-* zone and redefines no kit class (a kit class appears only qualified under .ar-*)');
});

test('CLAUSE_FAMILIES names every rubric clause, exactly once, with known families; the referential L2X clause names none', () => {
  assert.deepEqual(Object.keys(CLAUSE_FAMILIES).sort(), RUBRIC.map((c) => c.id).sort());
  for (const [id, fams] of Object.entries(CLAUSE_FAMILIES)) for (const f of fams) assert.ok(FAMILIES.includes(f) && f !== 'unknown', `${id}: ${f} is a family`);
  assert.deepEqual(CLAUSE_FAMILIES['L2X.MUST.extended_backend_refs_resolve'], []);
  assert.deepEqual(CLAUSE_FAMILIES['L5.MUST.tier1_chaos_for_each_slo'], ['chaos']);
});

test('flattenArtefacts walks the board\'s layers and the L4 subgroups — 84 over payment-service, the walk server/verdict-admin.mjs and studio/static-backend.mjs inline (text-pinned)', () => {
  const flat = flattenArtefacts(adapt(load(PAYMENT)));
  assert.equal(flat.length, 84);
  assert.equal(flat[0].key, 'L1/SLI-01');
  assert.ok(flat.some((x) => x.sub === 'alerting' && x.key.startsWith('L4/alerting/')));
  assert.deepEqual([...LAYER_ORDER], ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV']);
  assert.deepEqual([...L4_SUBGROUPS], ['policy', 'alerting', 'healing']);
  for (const f of ['server/verdict-admin.mjs', 'studio/static-backend.mjs']) {
    const src = read(f);
    assert.ok(src.includes(`['${LAYER_ORDER.join("', '")}']`), `${f} walks the same layers`);
    assert.ok(src.includes(`['${L4_SUBGROUPS.join("', '")}']`), `${f} walks the same L4 subgroups`);
  }
  assert.deepEqual(flattenArtefacts(null), []);
  assert.deepEqual(flattenArtefacts({ layers: { L4: { policy: [{ id: 'POL-01' }] } } }).map((x) => x.key), ['L4/policy/POL-01']);
});

test('determinism: two builds over the same inputs are the same JSON and the same HTML bytes; the inputs are not mutated; the document keys are in the stated order', () => {
  const inputs = inputsFor(PAYMENT);
  const before = JSON.stringify(inputs);
  const a = buildAuditReport(inputs);
  const b = buildAuditReport(inputsFor(PAYMENT));
  assert.deepEqual(a, b);
  assert.equal(renderAuditReportHtml(a, { styles: STYLES }), renderAuditReportHtml(b, { styles: STYLES }));
  assert.equal(JSON.stringify(inputs), before, 'inputs untouched');
  assert.deepEqual(Object.keys(a), ['reportVersion', 'generator', 'generatedAt', 'pack', 'tier', 'conformance', 'placeholders', 'assessments', 'waivers', 'coverage', 'goesBlind', 'responsePath']);
  assert.deepEqual([a.reportVersion, a.generator, a.generatedAt], [1, null, null]);
  assert.deepEqual(a.pack, { id: 'payment-service', label: null, source: null, name: 'payment-service', version: '1.5.0', service: 'payment-service', environment: null, environments: ['prod', 'staging'], criticality: 'tier-1', artefacts: 84, sources: { Declared: 84, Verified: 0, Scaffold: 0 } });
  assert.deepEqual(a.tier, { graded: 'tier-1', pack: 'tier-1', from: 'pack', service: null, environment: null, mismatch: false });
  const stamped = buildAuditReport({ ...inputsFor(PAYMENT), generatedAt: NOW, generator: { name: 'packc audit-report', version: '0.0.0' } });
  assert.deepEqual([stamped.generatedAt, stamped.generator], [NOW, { name: 'packc audit-report', version: '0.0.0' }]);
});

test('conformance: the engine\'s numbers headline, the clauses split (payment-service: 4 blocking, 26 passed); with a waivers overlay the waived clause leaves blocking and `effective` sits beside the numbers, which do not move', () => {
  const canonical = load(PAYMENT);
  const bare = evaluateConformance(canonical);
  const c = splitClauses(bare);
  assert.deepEqual([c.declaredTier, c.conformant, c.must, c.should, c.scorePercent, c.mustPercent, c.effective], ['tier-1', false, { passed: 21, total: 25 }, { passed: 5, total: 5 }, 85, 84, null]);
  assert.deepEqual(c.counts, { blocking: 4, waived: 0, recommended: 0, passed: 26, notApplicable: 0 });
  assert.deepEqual(c.clauses.blocking.map((r) => r.id), ['L3.MUST.recording_rule_per_slo', 'L4.MUST.multi_window_burn_rate', 'L5.MUST.tier1_chaos_for_each_slo', 'L5.MUST.tier1_weekly_prod_chaos']);
  assert.deepEqual(c.clauses.blocking[0].families, ['recording_rule']);
  assert.ok(!('waiver' in c.clauses.blocking[0]), 'no waiver key without an overlay');
  assert.equal(c.onPlaceholder, null);
  const waivers = [normalizeWaiver({ ruleId: 'L5.MUST.tier1_weekly_prod_chaos', reason: 'chaos day is scheduled for Q1', expiresAt: IN_30D, author: 'oscar', createdAt: NOW, id: 7 })];
  const overlaid = applyWaiversToConformance(bare, waivers, { now: NOW, canonical });
  const w = splitClauses(overlaid);
  assert.deepEqual([w.must, w.scorePercent, w.conformant], [c.must, c.scorePercent, false], 'the engine\'s numbers headline');
  assert.deepEqual(w.counts, { blocking: 3, waived: 1, recommended: 0, passed: 26, notApplicable: 0 });
  assert.deepEqual(w.clauses.waived[0].waiver, { status: 'waived', subjects: null, waivers: [{ id: 7, artefactKey: null, rule: 'L5.MUST.tier1_weekly_prod_chaos', reason: 'chaos day is scheduled for Q1', expiresAt: IN_30D, at: NOW, by: 'oscar', status: 'active' }] });
  assert.deepEqual([w.effective.must, w.effective.conformant], [{ passed: 22, total: 25 }, false]);
  assert.deepEqual(Object.keys(w.effective.byDimension), Object.keys(bare.byDimension));
  // A malformed body: empty groups, nothing thrown.
  assert.deepEqual(splitClauses(null).counts, { blocking: 0, waived: 0, recommended: 0, passed: 0, notApplicable: 0 });
  assert.deepEqual(splitClauses({ onPlaceholder: ['L1.MUST.availability_slo', { id: 'L2.MUST.otlp_receiver' }] }).onPlaceholder, ['L1.MUST.availability_slo', 'L2.MUST.otlp_receiver']);
});

test('placeholders: packConformance\'s rows and counts beside the Conformance view\'s two template counts — none for the vendored example, 19 rows / 15 todos / 14 Scaffold artefacts for the tier-3 library build', () => {
  const none = placeholdersOf(load(PAYMENT), adapt(load(PAYMENT)));
  assert.deepEqual([none.conformant, none.markers, none.counts.rows, none.templates, none.rows], [true, 0, 0, { todos: 0, scaffolds: 0 }, []]);
  const c = load(HTTP3);
  const some = placeholdersOf(c, adapt(c));
  assert.deepEqual([some.conformant, some.counts.rows, some.templates], [false, 19, { todos: 15, scaffolds: 14 }]);
  assert.deepEqual(Object.keys(some.rows[0]), ['symbol', 'path', 'field', 'needs', 'source', 'hint', 'state', 'marker', 'writer', 'rule']);
  assert.ok(some.rows.every((r) => r.state === 'placeholder' && r.writer === 'library'));
  assert.deepEqual(placeholdersOf(null, null).counts.rows, 0);
});

test('assessments: null rows → not available; [] → every artefact unreviewed; rows are read field by field (the API view\'s names or the report\'s), sorted by artefact, an orphan counted apart', () => {
  const adapted = adapt(load(PAYMENT));
  const off = assessmentSummary(null, adapted);
  assert.deepEqual(off, { available: false, artefacts: 84, counts: { unreviewed: 84, trusted: 0, suspect: 0, failed: 0 }, orphaned: 0, verdicts: [] });
  const empty = assessmentSummary([], adapted);
  assert.deepEqual([empty.available, empty.counts.unreviewed, empty.verdicts], [true, 84, []]);
  const rows = assessmentSummary([
    { artefact: 'SLO-01', key: 'L1/SLO-01', family: 'slo', title: 'x', status: 'failed', reason: 'r', actor: 'ada', setAt: NOW, carriedFrom: null },
    { artefactKey: 'SLI-01', state: 'trusted', by: 'oscar', at: NOW },
    { artefactKey: 'SLI-99', state: 'suspect' },
    { artefactKey: 'SLI-02', state: 'bogus' },
  ], adapted);
  assert.deepEqual(rows.counts, { unreviewed: 81, trusted: 1, suspect: 0, failed: 1 });
  assert.equal(rows.orphaned, 1);
  assert.deepEqual(rows.verdicts.map((v) => [v.artefactKey, v.state, v.by]), [['SLI-01', 'trusted', 'oscar'], ['SLI-02', 'unreviewed', null], ['SLI-99', 'suspect', null], ['SLO-01', 'failed', 'ada']]);
  assert.deepEqual(Object.keys(rows.verdicts[0]), ['artefactKey', 'key', 'family', 'title', 'state', 'reason', 'at', 'by']);
});

test('waivers: null → not available; rows by state then newest, a revoked row never active, an unreadable state `unknown`; the view\'s names or the report\'s', () => {
  assert.deepEqual(waiverSummary(null), { available: false, counts: { active: 0, expired: 0, revoked: 0, unknown: 0 }, waivers: [] });
  assert.deepEqual(waiverSummary([]).counts, { active: 0, expired: 0, revoked: 0, unknown: 0 });
  const w = waiverSummary([
    { id: 1, ruleId: 'L5.MUST.tier1_chaos_for_each_slo', artefactId: null, reason: 'a', expiresAt: PAST, author: 'oscar', createdAt: '2026-01-01T00:00:00.000Z', state: 'expired' },
    { id: 2, ruleId: 'L3.MUST.recording_rule_per_slo', artefactId: 'slos.consumer_success_99_95', reason: 'b', expiresAt: IN_30D, author: 'ada', createdAt: NOW, state: 'active', revokedAt: null },
    { id: 3, rule: 'L4.MUST.multi_window_burn_rate', artefactKey: 'slos.x', reason: 'c', expiresAt: IN_30D, by: 'olive', at: '2026-09-01T00:00:00.000Z', status: 'revoked', revokedAt: NOW, revokedBy: 'ada', revokeReason: 'done' },
    { id: 4, ruleId: 'L1.MUST.latency_slo', reason: 'd', expiresAt: IN_30D, author: 'bob', createdAt: '2026-10-01T00:00:00.000Z', state: 'active' },
    { id: 5, ruleId: 'L1.MUST.latency_slo', reason: 'e', state: 'weird' },
  ]);
  assert.deepEqual(w.counts, { active: 2, expired: 1, revoked: 1, unknown: 1 });
  assert.deepEqual(w.waivers.map((x) => [x.id, x.status]), [[2, 'active'], [4, 'active'], [1, 'expired'], [3, 'revoked'], [5, 'unknown']]);
  assert.deepEqual(w.waivers[3], { id: 3, artefactKey: 'slos.x', rule: 'L4.MUST.multi_window_burn_rate', reason: 'c', expiresAt: IN_30D, at: '2026-09-01T00:00:00.000Z', by: 'olive', status: 'revoked', revokedAt: NOW, revokedBy: 'ada', revokeReason: 'done' });
  assert.ok(!('revokedAt' in w.waivers[0]), 'no revoke fields on a live row');
});

test('coverage: every family once, present / absent / missing — the tier-3 library build reports the five L2X families absent, never missing; a synthesised applicable chaos clause over a pack without chaos is missing', () => {
  const c3 = load(HTTP3);
  const cov = coverageByFamily(adapt(c3), evaluateConformance(c3));
  assert.deepEqual(cov.families.map((f) => f.family), FAMILIES.filter((f) => f !== 'unknown'), 'every family, no unknown when the pack has none');
  for (const f of ['profiling', 'network', 'policy_engine', 'mesh', 'collection']) {
    const row = cov.families.find((x) => x.family === f);
    assert.deepEqual([row.status, row.required, row.clauses, row.count, row.layer], ['absent', false, [], 0, 'L2X'], f);
  }
  assert.deepEqual(cov.counts, { present: 20, absent: 12, missing: 0 });
  const sli = cov.families.find((x) => x.family === 'sli');
  assert.deepEqual([sli.status, sli.required, sli.label, sli.layer, sli.group], ['present', true, 'Service level indicator', 'L1', 'sli']);
  assert.ok(sli.clauses.includes('L1.MUST.availability_slo') && !sli.clauses.includes('L1.MUST.latency_slo'), 'named by the clauses that apply at tier-3 only');
  assert.equal(sli.count, sli.declared + sli.verified + sli.scaffold);
  // Payment-service at tier-1: every family a tier-1 clause names is present.
  const pay = coverageByFamily(adapt(load(PAYMENT)), evaluateConformance(load(PAYMENT)));
  assert.deepEqual(pay.counts, { present: 30, absent: 2, missing: 0 });
  // A synthesised missing: a tier-1 chaos clause applies, the hostile fixture declares no chaos.
  const miss = coverageByFamily(adapt(load(HOSTILE)), { clauses: [{ id: 'L5.MUST.tier1_chaos_for_each_slo', applies: true, pass: false }, { id: 'L5.MUST.tier1_weekly_prod_chaos', applies: false }] });
  const chaos = miss.families.find((x) => x.family === 'chaos');
  assert.deepEqual([chaos.status, chaos.clauses, miss.counts.missing], ['missing', ['L5.MUST.tier1_chaos_for_each_slo'], 1]);
  // An unknown family appears only when an artefact lands in it.
  const odd = coverageByFamily({ layers: { L1: [{ id: 'ZZZ-01' }] } }, {});
  assert.deepEqual(odd.families.at(-1).family, 'unknown');
  assert.equal(odd.families.at(-1).count, 1);
});

test('goes-blind: null shape → not computed; payment-service\'s top risks are the prometheus metrics backend and the remotewrite exporter (46 each), sorted by total, SLOs, alerts, key; `top` clamps to 1..100; unprotected entries carry labels', () => {
  const off = goesBlindRisks(null);
  assert.deepEqual(off, { available: false, top: 10, nodes: 0, edges: 0, sloBlindingNodes: 0, risks: [] });
  const adapted = adapt(load(PAYMENT));
  const shape = graphShape(buildDependencyGraph(adapted));
  const g = goesBlindRisks(shape, { top: 2 });
  assert.deepEqual([g.available, g.top, g.nodes, g.edges, g.sloBlindingNodes, g.risks.length], [true, 2, 94, 72, 29, 2]);
  assert.deepEqual(g.risks.map((r) => [r.kind, r.summary.total]), [['backend', 46], ['pipeline_exporter_metrics', 46]]);
  assert.deepEqual(Object.keys(g.risks[0]), ['key', 'kind', 'label', 'summary', 'weight', 'byKind', 'unprotected']);
  const all = goesBlindRisks(shape, { top: 1000 });
  assert.equal(all.top, 100);
  assert.equal(goesBlindRisks(shape, { top: 0 }).top, 1);
  assert.equal(goesBlindRisks(shape, { top: 'x' }).top, 10);
  for (let i = 1; i < all.risks.length; i++) assert.ok(all.risks[i - 1].summary.total >= all.risks[i].summary.total, 'sorted by what goes blind');
  assert.ok(all.risks.every((r) => r.summary.total > 0), 'a node that blinds nothing is not a risk');
  // A route's death leaves its alert unprotected: the listing names the alert.
  const route = all.risks.find((r) => r.kind === 'alert_route');
  assert.ok(route && route.unprotected.alerts.length > 0 && route.unprotected.alerts.every((x) => typeof x.label === 'string' && typeof x.key === 'string'), JSON.stringify(route));
});

test('response path: tools/lib/remediation-flow.mjs over the adapted pack alone — payment-service 3 remediations, 8 alerts, 0 linked, 3 unresolved, each with its annotation to name the alert; a pack without a remediation is unconfigured; compared is false by construction', () => {
  const rp = responsePath(adapt(load(PAYMENT)));
  assert.deepEqual([rp.configured, rp.compared], [true, false]);
  assert.deepEqual(rp.counts, { remediations: 3, alerts: 8, linked: 0, unresolved: 3, uncovered: 8, blocked: 0, suggestions: 1, placeholder: 0 });
  assert.deepEqual(rp.unresolved.map((u) => [u.remediation.symbol, u.annotation]), [['remediation[0]', 'observogram.remediates.remediation[0]'], ['remediation[1]', 'observogram.remediates.remediation[1]'], ['remediation[2]', 'observogram.remediates.remediation[2]']]);
  assert.equal(rp.uncovered.length, 8);
  assert.deepEqual(Object.keys(rp.uncovered[0]), ['id', 'symbol', 'identityKey', 'family', 'title', 'source', 'state']);
  const off = responsePath(adapt(load(HOSTILE)));
  assert.deepEqual([off.configured, off.counts.remediations, off.links, off.unresolved, off.uncovered, off.families], [false, 0, [], [], [], []]);
  assert.deepEqual(responsePath(null).configured, false);
});

test('the HTML: one document, no script, light theme, the kit and the report zone in one <style>, brand tokens only when the brand sets any; the honest texts; a synthesised hostile input is escaped everywhere and a "</style" stylesheet is refused', () => {
  const plain = renderAuditReportHtml(build(PAYMENT), { styles: STYLES });
  assert.ok(plain.startsWith('<!doctype html>\n<html lang="en" data-theme="light">'));
  assert.ok(!/<script/i.test(plain), 'no script');
  assert.equal((plain.match(/<\/style>/g) || []).length, 1, 'one style element without brand tokens');
  assert.ok(plain.includes('.og-stat {') && plain.includes('.ar-page {'), 'the kit and the report zone are inlined');
  assert.ok(plain.includes('Not recorded by this build'), 'verdicts and waivers not given: the CLI\'s text');
  assert.ok(plain.includes('None recorded: every artefact is unreviewed.') === false, 'not "none recorded" when the source was not given');
  const empty = renderAuditReportHtml(build(PAYMENT, { verdicts: [], waivers: [] }), { styles: STYLES });
  assert.ok(empty.includes('None recorded: every artefact is unreviewed.') && empty.includes('None recorded: no finding is waived.'));
  assert.ok(!empty.includes('Not recorded by this build'));
  assert.ok(empty.includes('The pack declares no remediation.') === false && plain.includes('7. Response path'));
  assert.ok(renderAuditReportHtml(build(HOSTILE), { styles: STYLES }).includes('The pack declares no remediation.'));
  assert.ok(renderAuditReportHtml({ ...build(PAYMENT), goesBlind: goesBlindRisks(null) }).includes('Not computed by this build'));
  // Branded: the acme footer strings, escaped, and the tokens element.
  const branded = renderAuditReportHtml(build(PAYMENT), { brand: ACME, styles: STYLES });
  assert.ok(branded.includes('<style id="brand-tokens">') && branded.includes('--og-accent:#b3261e;'));
  assert.ok(branded.includes('Acme Watch · a product of Acme Corp') && branded.includes('status &lt;live&gt;') && branded.includes('tier=&quot;gold&quot;'));
  const body = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '');
  assert.ok(!body(branded).includes('Observogram'), 'a branded report names its own product only (the kit\'s header comment aside)');
  assert.ok(plain.includes('Observogram · the Observability Compiler') && !plain.includes('brand-tokens'));
  // Hostile: a pack name, a clause description, a reason, a waiver author, a label.
  const hostile = '<img src=x onerror=alert(1)>&"q"</style><script>';
  const inputs = inputsFor(PAYMENT, {
    id: hostile,
    verdicts: [{ artefactKey: 'SLI-01', state: 'failed', reason: hostile, by: hostile, at: NOW }],
    waivers: [{ id: 1, ruleId: hostile, artefactId: hostile, reason: hostile, expiresAt: IN_30D, author: hostile, createdAt: NOW, state: 'active' }],
  });
  inputs.canonical = { ...inputs.canonical, metadata: { ...inputs.canonical.metadata, name: hostile } };
  inputs.conformance = { ...inputs.conformance, clauses: inputs.conformance.clauses.map((c, i) => (i === 0 ? { ...c, pass: false, description: hostile } : c)) };
  inputs.graph = { ...inputs.graph, nodes: inputs.graph.nodes.map((n, i) => (i === 0 ? { ...n, label: hostile } : n)) };
  const out = renderAuditReportHtml(buildAuditReport(inputs), { styles: STYLES });
  assert.ok(!out.includes('<img') && !out.includes('<script') && !out.includes('</style><'), 'nothing raw');
  assert.equal((out.match(/<\/style>/g) || []).length, 1, 'the hostile text never closes the style element');
  assert.ok(out.split('&lt;img src=x onerror=alert(1)&gt;&amp;&quot;q&quot;&lt;/style&gt;&lt;script&gt;').length > 8, 'the hostile text appears escaped in every section it reaches');
  assert.throws(() => renderAuditReportHtml(build(PAYMENT), { styles: 'body{} </style><script>1</script>' }), /cannot be inlined/);
  assert.equal(auditReportFilename('uploaded-payment-service-1a2b3c4d', 'html'), 'uploaded-payment-service-1a2b3c4d.audit-report.html');
  assert.equal(auditReportFilename('../a b/c', 'json'), 'a_b_c.audit-report.json');
  assert.equal(auditReportFilename(null), 'pack.audit-report.json');
});

// ---------- 2. goldens ----------

const GOLDENS = [
  { name: 'payment-service', path: PAYMENT },
  { name: 'http-service.tier-3', path: HTTP3 },
  { name: 'edge-hostile-names', path: HOSTILE },
  { name: 'payment-service.branded', path: PAYMENT, brand: ACME },
];

test('goldens: the JSON document and the HTML of the four inputs are byte-identical to the committed files (unstamped, generator-less; --update rewrites them)', () => {
  mkdirSync(rel(GOLDEN_DIR), { recursive: true });
  const problems = [];
  for (const g of GOLDENS) {
    const report = build(g.path, { id: g.name.replace(/\.branded$/, '') });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const html = renderAuditReportHtml(report, { brand: g.brand, styles: STYLES });
    for (const [ext, text] of [['json', json], ['html', html]]) {
      const file = `${GOLDEN_DIR}/${g.name}.audit-report.golden.${ext}`;
      if (UPDATE || !existsSync(rel(file))) { writeFileSync(rel(file), text); continue; }
      if (read(file) !== text) problems.push(file);
    }
  }
  assert.deepEqual(problems, [], 'an intended change regenerates the goldens in the same commit: node tools/test-audit-report.mjs --update');
  assert.ok(existsSync(rel(`${GOLDEN_DIR}/payment-service.branded.audit-report.golden.html`)));
  const branded = read(`${GOLDEN_DIR}/payment-service.branded.audit-report.golden.json`);
  const plain = read(`${GOLDEN_DIR}/payment-service.audit-report.golden.json`);
  assert.equal(branded, plain, 'the brand changes the HTML only; the document is the same');
});

// ---------- 3. the CLI ----------

const CLI = rel('tools/audit-report.mjs');
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, OBSERVOGRAM_BRAND_NAME: 'Zed' } });
const PAY_FILE = rel(PAYMENT);
const cliDoc = (...args) => {
  const r = run(PAY_FILE, '--no-timestamp', ...args);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const unstamp = (doc) => ({ ...doc, generator: null, pack: { ...doc.pack, source: null } });

test('the CLI: --no-timestamp JSON is the golden document (the generator and the file source aside), the HTML is the renderer\'s over the studio\'s styles, --out writes a file or a directory\'s pair; OBSERVOGRAM_BRAND_* is never read', () => {
  const doc = cliDoc();
  assert.deepEqual([doc.generator.name, doc.generatedAt, doc.pack.source], ['packc audit-report', null, 'file']);
  assert.equal(`${JSON.stringify(unstamp(doc), null, 2)}\n`, read(`${GOLDEN_DIR}/payment-service.audit-report.golden.json`), 'the CLI document is the golden');
  const html = run(PAY_FILE, '--no-timestamp', '--format', 'html');
  assert.equal(html.status, 0, html.stderr);
  assert.equal(html.stdout, renderAuditReportHtml(doc, { styles: STYLES }));
  assert.ok(html.stdout.includes('Observogram · the Observability Compiler') && !html.stdout.includes('Zed'), 'the environment brand is not read');
  const dir = mkdtempSync(join(tmpdir(), 'audit-report-cli-'));
  try {
    const both = run(PAY_FILE, '--no-timestamp', '--format', 'both', '--out', dir);
    assert.equal(both.status, 0, both.stderr);
    assert.deepEqual(both.stderr.trim().split('\n'), [`wrote ${join(dir, 'payment-service.audit-report.json')}`, `wrote ${join(dir, 'payment-service.audit-report.html')}`]);
    assert.equal(both.stdout, '');
    assert.equal(readFileSync(join(dir, 'payment-service.audit-report.json'), 'utf8'), `${JSON.stringify(doc, null, 2)}\n`);
    assert.equal(readFileSync(join(dir, 'payment-service.audit-report.html'), 'utf8'), html.stdout);
    const one = run(PAY_FILE, '--no-timestamp', '--format', 'html', '--out', join(dir, 'r.html'));
    assert.equal(one.status, 0, one.stderr);
    assert.equal(readFileSync(join(dir, 'r.html'), 'utf8'), html.stdout);
    const stamped = run(PAY_FILE, '--out', join(dir, 'stamped.json'));
    assert.equal(stamped.status, 0, stamped.stderr);
    assert.match(JSON.parse(readFileSync(join(dir, 'stamped.json'), 'utf8')).generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'the clock by default');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI flags: --env grades the environment and names it, --generated-at normalises the stamp, --top sizes the listing, --brand brands the HTML, --taxonomy binds the coverage classifier, --verdicts and --waivers feed the two sections (the rubric overlay too)', () => {
  const staging = cliDoc('--env', 'staging');
  assert.deepEqual([staging.pack.environment, staging.conformance.declaredTier], ['staging', evaluateConformance(overlaidCanonical(load(PAYMENT), 'staging').canonical).declaredTier]);
  assert.notDeepEqual(staging.conformance, cliDoc().conformance, 'the overlay grades differently');
  assert.equal(JSON.parse(run(PAY_FILE, '--generated-at', '2026-10-05T12:00:00Z').stdout).generatedAt, NOW);
  assert.equal(cliDoc('--top', '2').goesBlind.risks.length, 2);
  const branded = run(PAY_FILE, '--no-timestamp', '--format', 'html', '--brand', rel('tools/fixtures/brand/acme.json'));
  assert.equal(branded.status, 0, branded.stderr);
  assert.ok(branded.stdout.includes('<style id="brand-tokens">') && branded.stdout.includes('Acme Watch · a product of Acme Corp'));
  // The typed-canonical fixture under the taxonomy override: POL-01 moves from burn_rate (id) to alert_rule (type) — the board golden's move.
  const typed = rel('tools/fixtures/taxonomy/typed-canonical.pack.json');
  const count = (doc, f) => doc.coverage.families.find((x) => x.family === f).count;
  const plain = JSON.parse(run(typed, '--no-timestamp').stdout);
  const mapped = JSON.parse(run(typed, '--no-timestamp', '--taxonomy', rel('tools/fixtures/taxonomy/taxonomy.json')).stdout);
  assert.deepEqual([count(mapped, 'alert_rule'), count(mapped, 'burn_rate'), mapped.pack.artefacts], [count(plain, 'alert_rule') + 1, count(plain, 'burn_rate') - 1, plain.pack.artefacts]);
  const dir = mkdtempSync(join(tmpdir(), 'audit-report-cli-rows-'));
  try {
    const vfile = join(dir, 'verdicts.json');
    writeFileSync(vfile, JSON.stringify({ ok: true, pack: 'payment-service', verdicts: [{ artefact: 'SLI-01', key: 'L1/SLI-01', family: 'sli', title: 'api_availability', status: 'suspect', reason: 'short window', actor: 'oscar', setAt: NOW, carriedFrom: null }], summary: {} }));
    const wfile = join(dir, 'waivers.json');
    writeFileSync(wfile, JSON.stringify({ version: 1, waivers: [
      { ruleId: 'L5.MUST.tier1_weekly_prod_chaos', reason: 'chaos day is scheduled for Q1', expiresAt: '2099-01-01T00:00:00.000Z', author: 'oscar', createdAt: NOW },
      { ruleId: 'L3.MUST.recording_rule_per_slo', artefactId: 'slos.consumer_success_99_95', reason: 'lapsed', expiresAt: PAST, author: 'ada', createdAt: '2025-12-01T00:00:00.000Z' },
    ] }));
    const doc = cliDoc('--verdicts', vfile, '--waivers', wfile);
    assert.deepEqual([doc.assessments.available, doc.assessments.counts.suspect, doc.assessments.verdicts[0]], [true, 1, { artefactKey: 'SLI-01', key: 'L1/SLI-01', family: 'sli', title: 'api_availability', state: 'suspect', reason: 'short window', at: NOW, by: 'oscar' }]);
    assert.deepEqual([doc.waivers.available, doc.waivers.counts], [true, { active: 1, expired: 1, revoked: 0, unknown: 0 }]);
    assert.deepEqual(doc.waivers.waivers.map((w) => [w.rule, w.status]), [['L5.MUST.tier1_weekly_prod_chaos', 'active'], ['L3.MUST.recording_rule_per_slo', 'expired']]);
    assert.deepEqual(doc.conformance.clauses.waived.map((c) => c.id), ['L5.MUST.tier1_weekly_prod_chaos']);
    assert.deepEqual([doc.conformance.must, doc.conformance.effective.must], [{ passed: 21, total: 25 }, { passed: 22, total: 25 }]);
    // An array of views is a verdicts file too; the bare document without rows reads "none recorded".
    writeFileSync(vfile, '[]');
    const none = cliDoc('--verdicts', vfile);
    assert.deepEqual([none.assessments.available, none.assessments.counts.unreviewed], [true, 84]);
    assert.ok(renderAuditReportHtml(none).includes('None recorded: every artefact is unreviewed.'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI refusals: usage is exit 2 naming the problem (no pack, two packs, an unknown flag, a bad --format / --top / --generated-at, an undeclared --env, an unreadable --waivers / --verdicts / --brand / --taxonomy file, --format both without --out); an unreadable, layered or invalid pack is exit 1 with the way out', () => {
  const usage = (r, text) => { assert.equal(r.status, 2, r.stderr); assert.ok(r.stderr.startsWith(text), r.stderr.split('\n')[0]); assert.equal(r.stdout, ''); };
  usage(run(), 'no pack given');
  usage(run(PAY_FILE, PAY_FILE), 'one pack at a time');
  usage(run(PAY_FILE, '--bogus'), 'unknown flag: --bogus');
  usage(run(PAY_FILE, '--format', 'pdf'), '--format must be one of json, html, both');
  usage(run(PAY_FILE, '--format'), '--format needs a value');
  usage(run(PAY_FILE, '--top', '0'), '--top must be an integer from 1 to 100');
  usage(run(PAY_FILE, '--top', '101'), '--top must be an integer from 1 to 100');
  usage(run(PAY_FILE, '--generated-at', 'yesterday'), '--generated-at is not a date: yesterday');
  usage(run(PAY_FILE, '--env', 'nope'), '--env nope: the pack declares prod, staging');
  usage(run(PAY_FILE, '--waivers', rel('tools/fixtures/no-such.json')), `--waivers ${rel('tools/fixtures/no-such.json')}: file not found`);
  usage(run(PAY_FILE, '--verdicts', PAY_FILE), `--verdicts ${PAY_FILE}:`);
  usage(run(PAY_FILE, '--brand', PAY_FILE), `--brand ${PAY_FILE}:`);
  usage(run(PAY_FILE, '--taxonomy', rel('tools/fixtures/taxonomy/typed.pack.json')), 'taxonomy:');
  usage(run(PAY_FILE, '--format', 'both'), '--format both needs --out <directory>');
  const dir = mkdtempSync(join(tmpdir(), 'audit-report-cli-bad-'));
  try {
    writeFileSync(join(dir, 'v.json'), '{"ok":true}');
    usage(run(PAY_FILE, '--verdicts', join(dir, 'v.json')), 'expected the GET /api/packs/:id/verdicts document');
    usage(run(PAY_FILE, '--format', 'both', '--out', join(dir, 'file.json')), `--out ${join(dir, 'file.json')}: --format both needs an existing directory`);
    const invalid = join(dir, 'invalid.pack.json');
    writeFileSync(invalid, JSON.stringify({ ...load(PAYMENT), spec: { ...load(PAYMENT).spec, slis: [] } }));
    let r = run(invalid);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /^✗ .*invalid\.pack\.json: not a valid manifest \(\d+ error\(s\)\) — npm run validate-pack -- /);
    r = run(rel('examples/legacy/demo-skeleton.json'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /previous-format \(layered JSON\) pack — upconvert it first/);
    r = run(join(dir, 'missing.pack.yaml'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /file not found/);
    const help = run('--help');
    assert.equal(help.status, 0);
    assert.ok(help.stdout.startsWith('usage: node tools/audit-report.mjs'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI: every flag it accepts is in its usage, the packc help line, the README synopsis and the CHANGELOG entry; the CLI resolves paths through fileURLToPath and never .pathname', () => {
  const src = read('tools/audit-report.mjs');
  const flags = [...new Set([...src.matchAll(/'(--[a-z][a-z-]*)'/g)].map((m) => m[1]))].filter((f) => f !== '--help');
  assert.ok(flags.length >= 11, flags.join(' '));
  const usage = src.match(/^const USAGE = `([^`]*)`/m)[1];
  const helpLine = read('tools/cli.mjs').split('\n').find((l) => /^\s+packc audit-report /.test(l));
  const readme = read('README.md');
  const synopsis = readme.slice(readme.indexOf('### Export A Service Audit Report'), readme.indexOf('### Serve The Studio Without The Server'));
  const changelog = read('docs/CHANGELOG.md').split('\n').filter((l) => l.includes('`tools/audit-report.mjs`')).join('\n');
  assert.ok(usage && helpLine && synopsis && changelog, 'the four documented places exist');
  // A flag is documented as `[--flag]`, `[--flag <value>]`, `[--flag a|b]` or after a `|` (`| --no-timestamp]`).
  const documented = (text, f) => new RegExp(`(?:\\[|\\| )${f}(?:\\]| )`).test(text);
  for (const f of flags) {
    for (const [name, text] of [['usage', usage], ['packc help line', helpLine], ['README synopsis', synopsis], ['CHANGELOG entry', changelog]]) {
      assert.ok(documented(text, f), `${f} is documented in the ${name}`);
    }
  }
  assert.ok(/fileURLToPath\(import\.meta\.url\)/.test(src) && !/\.pathname/.test(src));
  assert.ok(/case 'audit-report':\s*\n\s*delegate\('tools\/audit-report\.mjs', rest\)/.test(read('tools/cli.mjs')), 'packc dispatches it');
  assert.equal(JSON.parse(read('package.json')).scripts['audit-report'], 'node tools/audit-report.mjs');
});
