#!/usr/bin/env node
/**
 * tools/test-library.mjs — the BUILD journey engine (docs/BUILD_JOURNEY.md), proven per tier.
 *
 * Loads every entry under library/, then for every entry × every tier with default toggles:
 * the produced pack validates against the v1.2 schema, compiles through every compile.mjs
 * target without throwing, the generic dashboard generator builds its boards with no unknown
 * binding, conformance at that tier reports every applicable MUST passing or failing only
 * because of a listed todo (failing MUST ids ⊆ clauses the todos name, both sets printed on
 * failure), every SHOULD passes at tier-1, the provenance annotations are present and the
 * todos are exactly the library.todo.* annotations. Then the toggles (dashboards off → exactly
 * the dashboard clauses fail; policy off → exactly the burn-rate clause), composition, SLI
 * selection, param overrides, the adapter parking placeholders as Scaffold, the CLI, and three
 * goldens under tools/fixtures/library/ (regenerate: `node tools/test-library.mjs --update`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml, emit as emitYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_VERSION } from './lib/validator.mjs';
import { compile, TARGETS } from './lib/compile.mjs';
import { genericBoards, checkBindings } from './lib/dashboards/generic.mjs';
import { evaluateConformance, RUBRIC } from './lib/conformance.mjs';
import { adapt } from './lib/adapter.mjs';
import {
  parseLibraryEntry, validateLibraryEntry, libraryIndex, tierRequirements, defaultToggles, instantiatePack,
  validationSummary, symbolOf, TIERS, SECTION_TOGGLES, SCAFFOLD_PARAMS, EVIDENCE_STATUSES,
} from './lib/library.mjs';
import { loadLibrary, findEntry } from '../server/library.mjs';
import { parsePromqlDependencies as lezer } from './lib/promql-lezer.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_DIR = resolve(ROOT, 'tools/fixtures/library');
const UPDATE = process.argv.includes('--update');
const SCHEMA = JSON.parse(readFileSync(resolve(ROOT, 'vendor/observability-pack-spec', `v${SPEC_VERSION}`, 'observability-pack.schema.json'), 'utf8'));

const EXPECTED_ENTRIES = ['alertmanager', 'grafana', 'http-service', 'ibm-mq', 'kafka', 'loki', 'otel-collector', 'prometheus', 'queue-consumer', 'tempo'];
const library = loadLibrary();
const entries = library.entries;
const byId = Object.fromEntries(entries.map(e => [e.id, e]));
// Every build in this suite runs the Lezer grammar over the resolved SLI expressions (what packc init does).
const build = (entry, tier, extra = {}) => instantiatePack(entry, { name: `svc-${Array.isArray(entry) ? 'composed' : entry.id}`, tier, environment: 'prod', promql: lezer, ...extra });
const failingMust = (canonical) => evaluateConformance(canonical).clauses.filter(c => c.applies && c.severity === 'MUST' && !c.pass).map(c => c.id).sort();

test('the library loads: ten entries, no errors', () => {
  assert.deepEqual(library.errors, []);
  assert.deepEqual(entries.map(e => e.id).sort(), EXPECTED_ENTRIES);
  for (const e of entries) {
    assert.deepEqual(validateLibraryEntry(e), [], e.id);
    assert.ok(EVIDENCE_STATUSES.includes(e.evidence.status), `${e.id} evidence status`);
    assert.ok(e.evidence.sources.every(s => typeof s === 'string'), `${e.id} evidence sources are strings (a plain list item with ': ' parses as a mapping)`);
  }
});

test('validateLibraryEntry names what is wrong', () => {
  const ok = JSON.parse(JSON.stringify(byId.kafka));
  assert.deepEqual(validateLibraryEntry(ok), []);
  const noEvidence = { ...ok, evidence: undefined };
  assert.ok(validateLibraryEntry(noEvidence).some(e => e.startsWith('evidence:')));
  const undeclared = JSON.parse(JSON.stringify(ok));
  undeclared.slis[0].good = 'sum(up{job="${nope}"})';
  assert.ok(validateLibraryEntry(undeclared).some(e => e.includes('${nope}')));
  const wrongMetric = JSON.parse(JSON.stringify(ok));
  wrongMetric.slis[0].metrics = ['kafka_made_up_metric'];
  assert.ok(validateLibraryEntry(wrongMetric).some(e => e.includes('kafka_made_up_metric') && e.includes('does not appear')));
  const noRatio = JSON.parse(JSON.stringify(ok));
  for (const s of noRatio.slis) if (s.type === 'ratio') s.minTier = 'tier-1';
  assert.ok(validateLibraryEntry(noRatio).some(e => e.includes('ratio SLI with minTier tier-3')));
  const scaffoldClash = JSON.parse(JSON.stringify(ok));
  scaffoldClash.params.push({ id: 'chaos_target', label: 'x', default: 'y', description: 'z' });
  assert.ok(validateLibraryEntry(scaffoldClash).some(e => e.includes('scaffold or built-in')));
  const reserved = JSON.parse(JSON.stringify(ok));
  reserved.slis[0].id = 'errorbudget';   // the compiler's <svc>:errorbudget:burn_* policy records
  assert.ok(validateLibraryEntry(reserved).some(e => e.includes("slis[0].id: 'errorbudget'") && e.includes('reserved')));
  for (const en of entries) for (const s of en.slis) assert.notEqual(s.id, 'errorbudget', `${en.id}.${s.id}`);
  assert.equal(typeof parseLibraryEntry('library: v1\nid: x\n').id, 'string');
  assert.throws(() => parseLibraryEntry(42));
});

test('libraryIndex lists products first, with SLIs per tier that grow with the tier', () => {
  const idx = libraryIndex(entries);
  assert.equal(idx.length, entries.length);
  const kinds = idx.map(r => r.kind);
  assert.equal(kinds.lastIndexOf('product') < kinds.indexOf('archetype'), true);
  for (const r of idx) {
    assert.ok(r.sliCountByTier['tier-3'] >= 1 && r.sliCountByTier['tier-2'] >= r.sliCountByTier['tier-3'] && r.sliCountByTier['tier-1'] >= r.sliCountByTier['tier-2'], r.id);
    assert.deepEqual(r.tiers, TIERS);
    assert.ok(r.slis.every(s => TIERS.includes(s.minTier) && EVIDENCE_STATUSES.includes(s.evidence) && s.metrics.length), r.id);
    assert.ok(Array.isArray(r.evidence.sources) && r.evidence.sources.length >= 1 && r.evidence.sources.every(x => typeof x === 'string'), `${r.id}: evidence.sources is the list of citations, not a count`);
  }
  assert.equal(idx.find(r => r.id === 'kafka').product, 'kafka');
  assert.equal(idx.find(r => r.id === 'http-service').product, null);
});

test('tierRequirements is the conformance rubric filtered by minTier: 9/0, 15/1, 25/5', () => {
  const count = (tier) => { const c = tierRequirements(tier); return [c.filter(x => x.severity === 'MUST').length, c.filter(x => x.severity === 'SHOULD').length]; };
  assert.deepEqual(count('tier-3'), [9, 0]);
  assert.deepEqual(count('tier-2'), [15, 1]);
  assert.deepEqual(count('tier-1'), [25, 5]);
  assert.equal(tierRequirements('tier-1').length, RUBRIC.length);
  assert.ok(tierRequirements('tier-3').every(c => RUBRIC.some(r => r.id === c.id && r.minTier === 'tier-3')));
  assert.throws(() => tierRequirements('tier-9'), /unknown tier/);
});

test('defaultToggles: every section on, the SLIs the tier reaches', () => {
  const t3 = defaultToggles(byId.kafka, 'tier-3'), t1 = defaultToggles(byId.kafka, 'tier-1');
  assert.deepEqual(t3.slis, ['broker_availability', 'consumer_group_lag_seconds']);
  assert.equal(t1.slis.length, byId.kafka.slis.length);
  for (const k of SECTION_TOGGLES) assert.equal(t3[k], true);
  assert.deepEqual(defaultToggles([byId.kafka, byId['http-service']], 'tier-3').slis, ['kafka_broker_availability', 'kafka_consumer_group_lag_seconds', 'http_service_availability']);
});

// ---------------------------------------------------------------------------
// The proof: every entry × every tier, default toggles.
// ---------------------------------------------------------------------------
for (const entry of entries) for (const tier of TIERS) {
  test(`${entry.id} @ ${tier}: validates, compiles on every target, boards bind, conformance holds, provenance and todos agree`, () => {
    const { canonical, todos, provenance, warnings } = build(entry, tier);
    const id = `${entry.id}@${tier}`;

    // schema, and every SLI expression parses under the Lezer grammar with the defaults in
    assert.deepEqual(validateCanonical(canonical, SCHEMA), [], `${id} schema`);
    assert.deepEqual(warnings.filter(w => w.kind === 'promql'), [], `${id}: every resolved SLI expression is valid PromQL`);
    assert.equal(canonical.metadata.bindings.criticality, tier);
    assert.ok(canonical.spec.slis.length >= 1 && canonical.spec.slos.length === canonical.spec.slis.length, `${id} one SLO per SLI`);

    // every compile target
    for (const target of Object.keys(TARGETS)) {
      const out = compile(canonical, target);
      assert.ok(typeof out.content === 'string' && out.content.length > 0, `${id} compiles ${target}`);
    }
    for (const d of canonical.spec.dashboards) {
      const json = compile(canonical, 'grafana-dashboard', { dashboardId: d.id });
      assert.equal(JSON.parse(json.content).uid, d.id, `${id} board ${d.id}`);
    }

    // boards
    const boards = genericBoards(canonical);
    assert.deepEqual(checkBindings(canonical, boards), [], `${id} bindings`);
    assert.equal(boards.length, canonical.spec.dashboards.length + 1, `${id} one board per declared dashboard plus the unified board`);

    // conformance: failing MUST ⊆ clauses named by todos (with defaults: none fail)
    const report = evaluateConformance(canonical);
    assert.equal(report.declaredTier, tier);
    const failing = failingMust(canonical);
    const named = new Set(todos.flatMap(t => t.clauses));
    const uncovered = failing.filter(c => !named.has(c));
    assert.deepEqual(uncovered, [], `${id}: failing MUST clauses ${JSON.stringify(failing)} not all named by todos ${JSON.stringify([...named].sort())}`);
    assert.deepEqual(failing, [], `${id}: with default toggles every applicable MUST passes (failing: ${JSON.stringify(failing)}; todo clauses: ${JSON.stringify([...named].sort())})`);
    assert.equal(report.conformant, true, `${id} conformant`);
    if (tier === 'tier-1') assert.equal(report.should.passed, report.should.total, `${id}: every SHOULD passes at tier-1`);
    const summary = validationSummary(canonical, todos);
    assert.deepEqual(summary.failing, []);
    assert.ok(summary.onPlaceholder.length >= 1, `${id}: at least the synthetic probe passes on a placeholder`);

    // provenance
    const ann = canonical.metadata.annotations;
    assert.equal(ann['library.source'], `${entry.id}@${entry.version}`);
    assert.equal(ann['library.tier'], tier);
    assert.equal(ann['library.toggles'], SECTION_TOGGLES.join(','));
    assert.equal(canonical.metadata.labels.source, 'library');
    assert.equal(provenance.entry, entry.id);
    for (const s of canonical.spec.slis) assert.ok(ann[`library.evidence.slis.${s.id}`], `${id} evidence annotation for ${s.id}`);

    // todos are exactly the library.todo.* annotations
    const todoKeys = Object.keys(ann).filter(k => k.startsWith('library.todo.')).map(k => k.slice('library.todo.'.length)).sort();
    assert.deepEqual(todoKeys, todos.map(t => t.path).sort());
    assert.equal(ann['library.todoCount'], String(todos.length));
    assert.ok(todos.every(t => t.what && Array.isArray(t.clauses)));
    // every placeholder param left at its default is a todo somewhere
    for (const key of provenance.placeholders) assert.ok(todos.some(t => t.params.includes(key)), `${id}: placeholder ${key} is a todo`);

    // the studio path: the adapter projects placeholder artefacts as Scaffold, SLIs as Declared
    const layered = adapt(canonical);
    const all = Object.values(layered.layers || {}).flat();
    assert.ok(all.some(a => a.source === 'Scaffold'), `${id}: at least one Scaffold artefact`);
    assert.ok(all.filter(a => a.source === 'Scaffold').length < all.length, `${id}: not everything is Scaffold`);
  });
}

// ---------------------------------------------------------------------------
// Toggles: exactly the clauses of the section switched off fail.
// ---------------------------------------------------------------------------
const DASHBOARD_CLAUSES = { 'tier-3': ['L3.MUST.service_overview_dashboard'], 'tier-2': ['L3.MUST.service_overview_dashboard', 'L3.MUST.slo_burn_dashboard'], 'tier-1': ['L3.MUST.service_overview_dashboard', 'L3.MUST.slo_burn_dashboard', 'L3.MUST.tier1_dashboards'] };
const POLICY_CLAUSES = { 'tier-3': [], 'tier-2': ['L4.MUST.multi_window_burn_rate'], 'tier-1': ['L4.MUST.multi_window_burn_rate'] };
for (const entry of entries) for (const tier of TIERS) {
  test(`${entry.id} @ ${tier}: dashboards off fails exactly the dashboard clauses, policy off exactly the burn-rate clause`, () => {
    const noBoards = build(entry, tier, { toggles: { dashboards: false } });
    assert.equal('dashboards' in noBoards.canonical.spec, false);
    assert.deepEqual(failingMust(noBoards.canonical), [...DASHBOARD_CLAUSES[tier]].sort());
    assert.ok(validateCanonical(noBoards.canonical, SCHEMA).some(e => /dashboards/.test(e)), 'the schema reports the gap too');
    assert.equal(noBoards.canonical.metadata.annotations['library.toggles'], SECTION_TOGGLES.filter(s => s !== 'dashboards').join(','));
    const noPolicy = build(entry, tier, { toggles: { policy: false } });
    assert.equal('policy' in noPolicy.canonical.spec, false);
    assert.ok(noPolicy.canonical.spec.slos.length >= 1, 'SLOs stay');
    assert.deepEqual(failingMust(noPolicy.canonical), [...POLICY_CLAUSES[tier]].sort());
    assert.ok(validateCanonical(noPolicy.canonical, SCHEMA).some(e => /policy/.test(e)));
  });
}

test('routes and validation off: absent sections, the rubric says what is missing', () => {
  const noRoutes = build(byId.grafana, 'tier-1', { toggles: { routes: false } });
  assert.equal('alerting' in noRoutes.canonical.spec, false);
  assert.deepEqual(failingMust(noRoutes.canonical), ['L4.MUST.tier1_voice_route']);
  const noValidation = build(byId.grafana, 'tier-1', { toggles: { validation: false } });
  assert.equal('validation' in noValidation.canonical.spec, false);
  assert.deepEqual(failingMust(noValidation.canonical), ['L5.MUST.synthetic_probe', 'L5.MUST.tier1_chaos_for_each_slo', 'L5.MUST.tier1_weekly_prod_chaos', 'L5.MUST.tier2_chaos_staging']);
  const noSlos = build(byId.grafana, 'tier-2', { toggles: { slos: false } });
  assert.equal('slos' in noSlos.canonical.spec, false);
  assert.equal('policy' in noSlos.canonical.spec, false);
  assert.ok(failingMust(noSlos.canonical).includes('L1.MUST.availability_slo'));
});

test('SLI selection: a subset, an unknown id, an SLI above the tier is excluded and reported', () => {
  const sub = build(byId.prometheus, 'tier-2', { toggles: { slis: ['scrape_success_ratio', 'query_latency_p99'] } });
  assert.deepEqual(sub.canonical.spec.slis.map(s => s.id), ['scrape_success_ratio', 'query_latency_p99']);
  assert.deepEqual(validateCanonical(sub.canonical, SCHEMA), []);
  assert.deepEqual(failingMust(sub.canonical), []);
  assert.equal(sub.canonical.metadata.annotations['library.slis'], 'scrape_success_ratio,query_latency_p99');
  // a board that bound only dropped SLIs is gone; the query-engine board binds query_latency_p99 and stays
  assert.ok(sub.canonical.spec.dashboards.some(d => d.id === 'prometheus-query-engine'));
  assert.ok(!sub.canonical.spec.dashboards.some(d => d.id === 'prometheus-tsdb-health'));
  assert.throws(() => build(byId.prometheus, 'tier-3', { toggles: { slis: ['nope'] } }), /unknown SLI nope/);
  // the tier dropped after the SLIs were ticked: the tier-1 SLI is excluded, the rest builds, the warning says which
  const above = build(byId.prometheus, 'tier-3', { toggles: { slis: ['scrape_success_ratio', 'wal_corruption_freshness'] } });
  assert.deepEqual(above.canonical.spec.slis.map(s => s.id), ['scrape_success_ratio']);
  assert.equal(above.canonical.metadata.annotations['library.slis'], 'scrape_success_ratio');
  assert.deepEqual(above.warnings.filter(w => w.kind === 'sli-excluded').map(w => w.sli), ['wal_corruption_freshness']);
  assert.match(above.warnings.find(w => w.kind === 'sli-excluded').message, /needs tier-1 and the pack is tier-3: excluded/);
  assert.deepEqual(validateCanonical(above.canonical, SCHEMA), []);
  // nothing left after the exclusion is the one fatal case
  assert.throws(() => build(byId.prometheus, 'tier-3', { toggles: { slis: ['wal_corruption_freshness'] } }), /at least one SLI must stay selected \(wal_corruption_freshness: above tier-3\)/);
  assert.throws(() => build(byId.prometheus, 'tier-3', { toggles: { slis: [] } }), /at least one SLI/);
  assert.throws(() => instantiatePack(byId.kafka, { name: 'x', tier: 'tier-4' }), /unknown tier/);
  assert.throws(() => instantiatePack(byId.kafka, { tier: 'tier-3' }), /service name/);
});

test('params: an override removes the todo and is recorded; a placeholder default is a todo at the artefact it landed on', () => {
  const dflt = build(byId.kafka, 'tier-2');
  assert.ok(dflt.todos.some(t => t.path === 'alerting.routes[0]' && t.params.includes('pager_service')));
  assert.ok(dflt.todos.some(t => t.path === 'validation.synthetic_checks.produce-consume-canary' && t.params.includes('bootstrap')));
  const set = build(byId.kafka, 'tier-2', { params: { pager_service: 'pagerduty://orders', bootstrap: 'kafka-0.prod:9092', oncall_channel: '#orders-oncall', team_channel: '#orders', broker_job: 'brokers' } });
  assert.ok(!set.todos.some(t => t.params.includes('pager_service') || t.params.includes('bootstrap') || t.params.includes('oncall_channel')));
  assert.equal(set.canonical.spec.alerting.routes[0].channels[1].voice, 'pagerduty://orders');
  assert.equal(set.canonical.spec.validation.synthetic_checks[0].target, 'kafka-0.prod:9092');
  assert.match(set.canonical.spec.slis[0].good, /job="brokers"/);
  assert.equal(set.canonical.spec.pipelines.receivers[1].scrape_configs[0].job_name, 'brokers');
  assert.deepEqual(JSON.parse(set.canonical.metadata.annotations['library.params']), { pager_service: 'pagerduty://orders', bootstrap: 'kafka-0.prod:9092', oncall_channel: '#orders-oncall', team_channel: '#orders', broker_job: 'brokers' });
  assert.equal(set.provenance.params.broker_job, 'brokers');
  assert.ok(SCAFFOLD_PARAMS.every(p => p.id in set.provenance.params));
});

test('params: an unknown key or a non-scalar value is an error, never a silent drop', () => {
  assert.throws(() => build(byId.kafka, 'tier-2', { params: { pager_servce: 'pagerduty://x' } }), /unknown param pager_servce \(known: .*pager_service/);
  assert.throws(() => build(byId.kafka, 'tier-2', { params: { nope: 1 } }), /unknown param nope/);
  assert.throws(() => build(byId.kafka, 'tier-2', { params: { exporter_job: { a: 1 } } }), /param exporter_job: expected a string, number or boolean, got object/);
  assert.throws(() => build(byId.kafka, 'tier-2', { params: { exporter_job: ['a'] } }), /got array/);
  assert.throws(() => build(byId.kafka, 'tier-2', { params: { exporter_job: null } }), /got null/);
  assert.throws(() => build(byId.kafka, 'tier-2', { params: ['a'] }), /params must be an object/);
  // numbers and booleans are the scalars an entry may declare as defaults: accepted, stringified, recorded
  const num = build(byId.kafka, 'tier-2', { params: { broker_job: 42 } });
  assert.match(num.canonical.spec.slis[0].good, /job="42"/);
  assert.deepEqual(JSON.parse(num.canonical.metadata.annotations['library.params']), { broker_job: '42' });
  // composed: `<entry>.<param>` reaches one entry, a bare entry param every entry that declares it, and nothing else exists
  const composed = instantiatePack([byId.kafka, byId['http-service']], { name: 'orders', tier: 'tier-3', params: { 'kafka.broker_job': 'b', job: 'api' } });
  assert.deepEqual(JSON.parse(composed.canonical.metadata.annotations['library.params']), { 'kafka.broker_job': 'b', 'http-service.job': 'api' });
  assert.throws(() => instantiatePack([byId.kafka, byId['http-service']], { name: 'orders', tier: 'tier-3', params: { 'http-service.broker_job': 'b' } }), /unknown param http-service\.broker_job/);
});

test('params: a value cannot break the PromQL it is spliced into', () => {
  // the characters that end or escape a label matcher are refused at the source (the API throws, the CLI exits 2)
  assert.throws(() => build(byId.kafka, 'tier-3', { params: { broker_job: 'brokers"}' } }), /param broker_job: a value may not contain a double quote/);
  assert.throws(() => build(byId.kafka, 'tier-3', { params: { broker_job: 'a\\b' } }), /param broker_job: a value may not contain/);
  assert.throws(() => build(byId.kafka, 'tier-3', { params: { broker_job: 'a\nb' } }), /param broker_job: a value may not contain/);
  // a value that lands outside a matcher (the collector's counter-name suffix) is caught by the grammar: one `promql` warning per broken expression
  const broken = build(byId['otel-collector'], 'tier-2', { params: { suffix: ')' } });
  const bad = broken.warnings.filter(w => w.kind === 'promql');
  assert.ok(bad.length >= 1, JSON.stringify(broken.warnings));
  assert.ok(bad.every(w => w.sli && w.field && /is not valid PromQL after parameter substitution \(near /.test(w.message)), JSON.stringify(bad));
  assert.deepEqual(build(byId['otel-collector'], 'tier-2', { params: { suffix: '_total' } }).warnings.filter(w => w.kind === 'promql'), [], 'the documented value parses');
  // without a parser the engine cannot check the grammar and says nothing about it (the browser-safe default)
  assert.deepEqual(instantiatePack(byId['otel-collector'], { name: 'col', tier: 'tier-2', params: { suffix: ')' } }).warnings.filter(w => w.kind === 'promql'), []);
});

test('symbolOf maps pack paths to the adapter\'s artefact ids', () => {
  const root = { spec: { validation: { synthetic_checks: [{ id: 'probe' }] }, telemetry: { backends: [{ id: 'metrics-prom' }] } } };
  assert.deepEqual(symbolOf(['spec', 'alerting', 'routes', 0, 'channels', 1, 'voice'], root), { symbol: 'alerting.routes[0]', field: 'channels.1.voice' });
  assert.deepEqual(symbolOf(['spec', 'validation', 'synthetic_checks', 0, 'target'], root), { symbol: 'validation.synthetic_checks.probe', field: 'target' });
  assert.deepEqual(symbolOf(['spec', 'telemetry', 'backends', 0, 'endpoints', 0], root), { symbol: 'telemetry.backends.metrics-prom', field: 'endpoints.0' });
  assert.deepEqual(symbolOf(['spec', 'pipelines', 'exporters', 'metrics', 'endpoint'], root), { symbol: 'pipelines.exporters.metrics', field: 'endpoint' });
  assert.deepEqual(symbolOf(['spec', 'baselines', 'mttd_target_p50'], root), { symbol: 'baselines', field: 'mttd_target_p50' });
  assert.deepEqual(symbolOf(['metadata', 'owners', 0], root), { symbol: 'metadata.owners', field: '0' });
});

test('composition: kafka + http-service in one tier-2 pack, ids prefixed, params namespaced', () => {
  const { canonical, todos, provenance } = instantiatePack([byId.kafka, byId['http-service']], { name: 'orders', tier: 'tier-2', owners: ['team-orders'], params: { 'kafka.broker_job': 'brokers', job: 'orders-api' } });
  assert.deepEqual(validateCanonical(canonical, SCHEMA), []);
  const ids = canonical.spec.slis.map(s => s.id);
  assert.ok(ids.includes('kafka_broker_availability') && ids.includes('http_service_availability') && ids.includes('http_service_latency_p99'));
  assert.match(canonical.spec.slis.find(s => s.id === 'kafka_broker_availability').good, /job="brokers"/);
  assert.match(canonical.spec.slis.find(s => s.id === 'http_service_availability').total, /job="orders-api"/);
  assert.deepEqual(failingMust(canonical), []);
  assert.deepEqual(checkBindings(canonical, genericBoards(canonical)), []);
  assert.equal(canonical.metadata.annotations['library.source'], `kafka@${byId.kafka.version},http-service@${byId['http-service'].version}`);
  assert.deepEqual(provenance.entry, ['kafka', 'http-service']);
  assert.ok(canonical.spec.dashboards.some(d => d.id === 'kafka-kafka-consumer-lag'));
  assert.ok(!todos.some(t => t.path === 'metadata.owners'));
  assert.throws(() => instantiatePack([byId.kafka, byId.kafka], { name: 'x', tier: 'tier-3' }), /same entry twice/);
});

// ---------------------------------------------------------------------------
// Goldens: three packs byte-stable (node tools/test-library.mjs --update regenerates them).
// ---------------------------------------------------------------------------
const GOLDENS = [
  { entry: 'kafka', tier: 'tier-2', name: 'orders-kafka', opts: {} },
  { entry: 'ibm-mq', tier: 'tier-1', name: 'payments-mq', opts: { owners: ['team-payments'] } },
  { entry: 'http-service', tier: 'tier-3', name: 'checkout-api', opts: {} },
];
for (const g of GOLDENS) {
  test(`golden ${g.entry}.${g.tier}.pack.yaml`, () => {
    const { canonical } = instantiatePack(byId[g.entry], { name: g.name, tier: g.tier, environment: 'prod', ...g.opts });
    const actual = emitYaml(canonical);
    const file = resolve(GOLDEN_DIR, `${g.entry}.${g.tier}.pack.yaml`);
    if (UPDATE) { mkdirSync(GOLDEN_DIR, { recursive: true }); writeFileSync(file, actual); return; }
    assert.ok(existsSync(file), `golden file exists (run \`node tools/test-library.mjs --update\` to create it)`);
    const golden = readFileSync(file, 'utf8');
    if (actual !== golden) {
      const a = actual.split('\n'), b = golden.split('\n');
      let line = 0;
      while (line < Math.min(a.length, b.length) && a[line] === b[line]) line++;
      assert.fail(`output drifted from the golden at line ${line + 1}: expected ${JSON.stringify(b[line])}, got ${JSON.stringify(a[line])} — if intended, regenerate with --update and review the golden diff in the same commit`);
    }
    // the golden round-trips through the parser to a pack that validates
    assert.deepEqual(validateCanonical(parseYaml(golden), SCHEMA), []);
  });
}

// ---------------------------------------------------------------------------
// The CLI (tools/pack-init.mjs): exit codes 0 ok · 1 invalid pack · 2 usage.
// ---------------------------------------------------------------------------
const cli = (...args) => spawnSync(process.execPath, [resolve(ROOT, 'tools/pack-init.mjs'), ...args], { encoding: 'utf8', cwd: ROOT });
test('packc init --list and --show', () => {
  const list = cli('--list');
  assert.equal(list.status, 0, list.stderr);
  for (const id of EXPECTED_ENTRIES) assert.match(list.stdout, new RegExp(`^${id} `, 'm'));
  const show = cli('--show', 'kafka');
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /broker_availability/);
  assert.match(show.stdout, /recorded-live/);
  assert.match(show.stdout, /\[placeholder → todo\]/);
});
test('packc init builds a pack: YAML on stdout, todos on stderr, exit 0; a section off exits 1; usage errors exit 2', () => {
  const ok = cli('--entry', 'kafka', '--tier', 'tier-2', '--name', 'orders-kafka');
  assert.equal(ok.status, 0, ok.stderr);
  const pack = parseYaml(ok.stdout);
  assert.deepEqual(validateCanonical(pack, SCHEMA), []);
  assert.equal(pack.metadata.annotations['library.source'], `kafka@${byId.kafka.version}`);
  assert.match(ok.stderr, /conformance @ tier-2: MUST 15\/15, SHOULD 1\/1/);
  assert.match(ok.stderr, /todos \(\d+\)/);
  assert.match(ok.stderr, /schema: valid/);
  const off = cli('--entry', 'kafka', '--tier', 'tier-2', '--name', 'orders-kafka', '--no-dashboards');
  assert.equal(off.status, 1);
  assert.match(off.stderr, /L3\.MUST\.service_overview_dashboard/);
  assert.match(off.stderr, /schema: the produced pack does not validate/);
  assert.equal(cli('--entry', 'nope', '--tier', 'tier-2', '--name', 'x').status, 2);
  assert.equal(cli('--entry', 'kafka', '--tier', 'tier-9', '--name', 'x').status, 2);
  assert.equal(cli('--entry', 'kafka', '--tier', 'tier-2').status, 2);
  assert.equal(cli('--bogus').status, 2);
  const typo = cli('--entry', 'kafka', '--tier', 'tier-2', '--name', 'orders', '--param', 'pager_servce=pagerduty://x', '--param', 'nope=1');
  assert.equal(typo.status, 2, 'a mistyped --param key is a usage error');
  assert.match(typo.stderr, /unknown param pager_servce, nope \(known: /);
  const quoted = cli('--entry', 'kafka', '--tier', 'tier-3', '--name', 'orders', '--param', 'broker_job=brokers"}');
  assert.equal(quoted.status, 2, 'a quote in a --param value is a usage error');
  assert.match(quoted.stderr, /param broker_job: a value may not contain a double quote/);
  const grammar = cli('--entry', 'otel-collector', '--tier', 'tier-2', '--name', 'col', '--param', 'suffix=)');
  assert.equal(grammar.status, 1, 'an SLI that does not parse once the values are in is an invalid pack');
  assert.match(grammar.stderr, /warning \[promql\]: SLI \S+ is not valid PromQL after parameter substitution/);
  assert.match(grammar.stderr, /^promql: \d+ SLI expression\(s\) do not parse/m);
  const above = cli('--entry', 'prometheus', '--tier', 'tier-3', '--name', 'prom', '--slis', 'scrape_success_ratio,wal_corruption_freshness');
  assert.equal(above.status, 0, above.stderr);
  assert.match(above.stderr, /warning \[sli-excluded\]: SLI wal_corruption_freshness needs tier-1 and the pack is tier-3/);
  assert.match(above.stderr, /1 SLI\(s\)/);
  const json = cli('--entry', 'http-service', '--tier', 'tier-3', '--name', 'checkout-api', '--json', '--param', 'health_url=https://checkout.example.internal/health');
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.deepEqual(payload.schemaErrors, []);
  assert.deepEqual(payload.warnings.filter(w => w.kind === 'promql'), []);
  assert.equal(payload.summary.must.passed, 9);
  assert.ok(!payload.todos.some(t => t.params.includes('health_url')));
});

test('findEntry and an unknown library root', () => {
  assert.equal(findEntry(library, 'kafka').id, 'kafka');
  assert.equal(findEntry(library, 'nope'), null);
  const empty = loadLibrary({ root: resolve(ROOT, 'tools/fixtures/does-not-exist') });
  assert.deepEqual(empty.entries, []);
  assert.deepEqual(empty.errors, []);
});
