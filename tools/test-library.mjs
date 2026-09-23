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
 * Then the seed and the copies (docs/BUILD_JOURNEY.md "The seed and the copies"): any SLI at any
 * tier with the per-tier walk, overrides over the library's SLIs (the SLO id follows the objective,
 * an edited expression drops the evidence, the usage errors and the warning), custom SLIs in every
 * section the scaffold derives, and the rubric counting them like any SLI.
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
import { compileBurnRules } from './lib/burn-rules.mjs';
import {
  parseLibraryEntry, validateLibraryEntry, libraryIndex, tierRequirements, defaultToggles, instantiatePack,
  validationSummary, symbolOf, todosFromAnnotations, hasLibraryTodos, sloIdFor, TIERS, SECTION_TOGGLES, SCAFFOLD_PARAMS, EVIDENCE_STATUSES, MAX_PARAM_LENGTH,
  OVERRIDE_FIELDS, CUSTOM_FIELDS, DEFAULT_BURN_PROFILE, BURN_PROFILES, SLI_KEY_RE, CUSTOM_ID_RE,
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
const byPath = (a, b) => a.path.localeCompare(b.path);

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
  const declaredTrigger = JSON.parse(JSON.stringify(ok));
  declaredTrigger.slis[0].remediation.trigger = 'alert:kafka-broker-down';   // the reference pack's symptom alert: no library pack compiles it
  assert.ok(validateLibraryEntry(declaredTrigger).some(e => e.includes('remediation.trigger: not a template field')));
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
    // the burn-rule generator's warnings reach the caller, and no entry ships a leg the generator has to guard or rewrite
    const burn = warnings.filter(w => w.kind === 'burn-rules').map(w => w.message);
    assert.deepEqual(burn, compileBurnRules(canonical).warnings, `${id}: the burn-rules warnings are the generator's own`);
    assert.deepEqual(burn.filter(m => /derived by arithmetic|rewritten to bool/.test(m)), [], `${id}: good legs guarded (or vector(0)) and comparisons bool`);
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
    // every remediation trigger and every chaos expected_alert names an alert the compiled rules carry, verbatim
    const compiledAlerts = new Set([...compile(canonical, 'prometheus-rules').content.matchAll(/^\s*-\s*alert:\s*(\S+)\s*$/gm)].map(m => m[1]));
    for (const r of canonical.spec.remediation || []) assert.ok(compiledAlerts.has(r.trigger.replace(/^alert:/, '')), `${id}: remediation trigger ${r.trigger} is an alert the pack compiles (${[...compiledAlerts].join(', ')})`);
    for (const c of canonical.spec.validation?.chaos_experiments || []) for (const a of c.expected_alerts) assert.ok(compiledAlerts.has(a), `${id}: chaos ${c.id} expects ${a}, compiled: ${[...compiledAlerts].join(', ')}`);
    if (tier === 'tier-1') assert.ok((canonical.spec.remediation || []).length >= 1, `${id}: at least one remediation at tier-1 (L4.MUST.tier1_at_least_one_automation)`);

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
    // the todos are recoverable from the pack alone — what /api/validate and the register hand-off feed
    // validationSummary with: todosFromAnnotations rebuilds { path, fields, what, clause, clauses, params }
    // from the library.todo.* annotations, the clauses derived from the pack (clausesFor), sorted by path
    assert.deepEqual(todosFromAnnotations(canonical), [...todos].sort(byPath), `${id}: todosFromAnnotations rebuilds the engine's todo list`);
    assert.equal(hasLibraryTodos(canonical), todos.length > 0, `${id}: hasLibraryTodos`);

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

test('SLI selection: a subset, an unknown id; an SLI above the tier is simply selected — the tier is a seed, not a gate', () => {
  const sub = build(byId.prometheus, 'tier-2', { toggles: { slis: ['scrape_success_ratio', 'query_latency_p99'] } });
  assert.deepEqual(sub.canonical.spec.slis.map(s => s.id), ['scrape_success_ratio', 'query_latency_p99']);
  assert.deepEqual(validateCanonical(sub.canonical, SCHEMA), []);
  assert.deepEqual(failingMust(sub.canonical), []);
  assert.equal(sub.canonical.metadata.annotations['library.slis'], 'scrape_success_ratio,query_latency_p99');
  // a board that bound only dropped SLIs is gone; the query-engine board binds query_latency_p99 and stays
  assert.ok(sub.canonical.spec.dashboards.some(d => d.id === 'prometheus-query-engine'));
  assert.ok(!sub.canonical.spec.dashboards.some(d => d.id === 'prometheus-tsdb-health'));
  assert.throws(() => build(byId.prometheus, 'tier-3', { toggles: { slis: ['nope'] } }), /unknown SLI nope/);
  // a tier-1 SLI in a tier-3 pack: in the pack with its own profile's objective, an SLO, no warning, no exclusion
  const above = build(byId.prometheus, 'tier-3', { toggles: { slis: ['scrape_success_ratio', 'wal_corruption_freshness'] } });
  assert.deepEqual(above.canonical.spec.slis.map(s => s.id), ['scrape_success_ratio', 'wal_corruption_freshness']);
  assert.equal(above.canonical.metadata.annotations['library.slis'], 'scrape_success_ratio,wal_corruption_freshness');
  assert.deepEqual(above.warnings.filter(w => w.kind === 'sli-excluded'), [], 'the kind is retired: nothing is excluded');
  const wal = byId.prometheus.slis.find(x => x.id === 'wal_corruption_freshness');
  const walObjective = typeof wal.slo.objective === 'number' ? wal.slo.objective : wal.slo.objective['tier-1'];
  assert.deepEqual(above.canonical.spec.slos.find(x => x.sli === 'wal_corruption_freshness'), { id: sloIdFor('wal_corruption_freshness', walObjective), sli: 'wal_corruption_freshness', objective: walObjective, window: typeof wal.slo.window === 'string' ? wal.slo.window : wal.slo.window['tier-1'], error_budget_policy: 'ref:platform/std-budget-policy' });
  assert.deepEqual(above.provenance.slis.wal_corruption_freshness.aboveTier, true);
  assert.equal(above.provenance.slis.wal_corruption_freshness.profileTier, 'tier-1');
  assert.equal(above.provenance.slis.scrape_success_ratio.aboveTier, false);
  assert.deepEqual(validateCanonical(above.canonical, SCHEMA), []);
  assert.deepEqual(failingMust(above.canonical), [], 'the rubric still grades at tier-3; the extra SLI simply counts');
  // the SLI's own tier features keep their gating against the pack's tier: no tier-1 forecast in a tier-3 pack
  assert.ok(!(above.canonical.spec.policy.forecasts || []).length, 'a forecast is a tier feature, not the SLI');
  // the one fatal case: nothing selected and nothing custom
  assert.throws(() => build(byId.prometheus, 'tier-3', { toggles: { slis: [] } }), /at least one SLI must stay selected \(or a custom SLI added\)/);
  assert.throws(() => instantiatePack(byId.kafka, { name: 'x', tier: 'tier-4' }), /unknown tier/);
  assert.throws(() => instantiatePack(byId.kafka, { tier: 'tier-3' }), /service name/);
  // defaultToggles is unchanged by the seed: the tier's own SLIs, nothing above it
  assert.deepEqual(defaultToggles(byId.prometheus, 'tier-3').slis, byId.prometheus.slis.filter(x => x.minTier === 'tier-3').map(x => x.id));
});

test('the per-tier walk: a value declared for the stricter tiers only is what a lower tier starts with', () => {
  const walk = JSON.parse(JSON.stringify(byId.kafka));
  const prh = walk.slis.find(x => x.id === 'partition_replica_health');   // minTier tier-2
  prh.slo.objective = { 'tier-1': 0.9999, 'tier-2': 0.9995 };             // nothing for tier-3: allowed below the minTier
  prh.slo.window = { 'tier-1': '7d', 'tier-2': '28d' };
  assert.deepEqual(validateLibraryEntry(walk), [], 'a per-tier map may leave out a tier below the SLI\'s minTier');
  // tier-3 adds the tier-2 SLI: it takes tier-2's value (the first declared walking towards the stricter tiers)
  const t3 = instantiatePack(walk, { name: 'orders', tier: 'tier-3', toggles: { slis: ['broker_availability', 'partition_replica_health'] } });
  assert.deepEqual(t3.canonical.spec.slos.find(x => x.sli === 'partition_replica_health'), { id: 'partition_replica_health_99_95', sli: 'partition_replica_health', objective: 0.9995, window: '28d', error_budget_policy: 'ref:platform/std-budget-policy' });
  assert.deepEqual(libraryIndex([walk])[0].slis.find(x => x.id === 'partition_replica_health').objectives, { 'tier-3': 0.9995, 'tier-2': 0.9995, 'tier-1': 0.9999 }, 'the index reads through the walk too');
  // declared for tier-1 only: a tier-2 pack starts with the tier-1 objective
  prh.slo.objective = { 'tier-1': 0.9999 };
  prh.minTier = 'tier-1';
  assert.deepEqual(validateLibraryEntry(walk), []);
  const t2 = instantiatePack(walk, { name: 'orders', tier: 'tier-2', toggles: { slis: ['broker_availability', 'produce_latency_p99', 'partition_replica_health'] } });
  assert.equal(t2.canonical.spec.slos.find(x => x.sli === 'partition_replica_health').objective, 0.9999);
  assert.equal(t2.canonical.spec.slos.find(x => x.sli === 'partition_replica_health').id, 'partition_replica_health_99_99');
  // a map that leaves out a tier the SLI reaches is still an entry error
  prh.minTier = 'tier-2';
  assert.ok(validateLibraryEntry(walk).some(e => /slo\.objective\[tier-2\]: required/.test(e)));
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
  // the error is bounded: at most ten unknown keys are echoed (200,000 bogus keys once made a 1.7 MB 400 body) …
  const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`p${i}`, '1']));
  const echoed = (() => { try { build(byId.kafka, 'tier-2', { params: many }); } catch (e) { return e.message; } })();
  assert.match(echoed, /^unknown param p0, p1, p2, p3, p4, p5, p6, p7, p8, p9 and 190 more \(known: /);
  assert.ok(!echoed.includes('p10,') && echoed.length < 2000, `the echo is capped (${echoed.length} chars)`);
  // … and a value is bounded by MAX_PARAM_LENGTH (a 3 MB value was accepted and spliced into a 9 MB pack)
  assert.throws(() => build(byId.kafka, 'tier-2', { params: { broker_job: 'x'.repeat(MAX_PARAM_LENGTH + 1) } }), new RegExp(`param broker_job: a value may not exceed ${MAX_PARAM_LENGTH} characters \\(${MAX_PARAM_LENGTH + 1} given\\)`));
  assert.match(build(byId.kafka, 'tier-2', { params: { broker_job: 'x'.repeat(MAX_PARAM_LENGTH) } }).canonical.spec.slis[0].good, /job="x{4096}"/, 'exactly the bound is accepted');
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

test('warnings: the burn-rule generator\'s direction warning on a ratio-unit threshold is surfaced, and none when the SLOs are off', () => {
  // queue_depth_headroom is depth / MAXDEPTH with an upper bound of 0.8 — the direction is right, and the generator's
  // "unit ratio suggests a floor" heuristic cannot know that: the warning is the generator's and the caller must see it
  const mq = build(byId['ibm-mq'], 'tier-2');
  assert.ok(mq.warnings.some(w => w.kind === 'burn-rules' && /queue_depth_headroom.*upper bound/.test(w.message)), JSON.stringify(mq.warnings));
  assert.deepEqual(build(byId['ibm-mq'], 'tier-2', { toggles: { slos: false } }).warnings.filter(w => w.kind === 'burn-rules'), []);
  const prom = build(byId.prometheus, 'tier-1');
  assert.deepEqual(prom.warnings.filter(w => w.kind === 'burn-rules' && /rule_evaluation_success_ratio|notification_success_ratio|tsdb_compaction_success_ratio|wal_corruption_freshness|scrape_success_ratio/.test(w.message)), [], 'the prometheus legs are guarded');
});

test('queue-consumer filters the receive operation on messaging.operation.type, the semconv enum, never on messaging.operation.name', () => {
  // semconv v1.27.0: messaging.operation.type ∈ { publish, create, receive, process, settle }; messaging.operation.name is the
  // system-specific operation name (poll, ack, send), so a filter on it selects nothing under the standard the entry cites
  const receive = build(byId['queue-consumer'], 'tier-1').canonical.spec.slis.find(s => s.id === 'receive_duration_p99');
  assert.match(receive.query, /messaging_operation_type="receive"/);
  for (const en of entries) for (const s of en.slis) for (const f of ['good', 'total', 'query']) if (s[f]) assert.doesNotMatch(String(s[f]), /messaging_operation_name/, `${en.id}.${s.id}.${f}`);
});

test('remediation triggers are the SLO\'s fast burn alert, derived from the profile, at both tiers that carry one', () => {
  const t2 = build(byId.kafka, 'tier-2').canonical.spec.remediation.map(r => r.trigger);
  assert.deepEqual(t2, ['alert:broker_availability_99_9_burn_14x_5m_1h', 'alert:partition_replica_health_99_95_burn_14x_5m_1h']);
  const t1 = build(byId.kafka, 'tier-1').canonical.spec.remediation.map(r => r.trigger);
  assert.ok(t1.includes('alert:consumer_group_lag_seconds_99_burn_10x_10m_1h'), 'the saturation profile: 10x over 10m/1h');
  assert.ok(t1.includes('alert:controller_election_rate_99_burn_8x_15m_2h'), 'the slow profile: 8x over 15m/2h');
  // an entry with no remediation template at tier-1 gets the generic manual-only one, on its first SLO's fast alert
  const generic = build(byId['http-service'], 'tier-1').canonical.spec.remediation;
  assert.equal(generic.length, 1);
  assert.equal(generic[0].trigger, `alert:${build(byId['http-service'], 'tier-1').canonical.spec.slos[0].id}_burn_14x_5m_1h`);
  assert.equal(generic[0].automation, 'manual-only');
});

test('the backend versions are placeholders: a todo on each backend and storage entry until the team states them', () => {
  const dflt = build(byId.kafka, 'tier-1');
  for (const [backend, storage, param] of [['metrics-prom', 'metrics', 'prometheus_version'], ['logs-loki', 'logs', 'loki_version'], ['traces-tempo', 'traces', 'tempo_version']]) {
    const b = dflt.todos.find(t => t.path === `telemetry.backends.${backend}`);
    assert.ok(b && b.fields.includes('version.declared') && b.params.includes(param), `${backend}: ${JSON.stringify(b)}`);
    const s = dflt.todos.find(t => t.path === `storage.${storage}`);
    assert.ok(s && s.fields.includes('version') && s.params.includes(param), `storage.${storage}: ${JSON.stringify(s)}`);
  }
  const set = build(byId.kafka, 'tier-1', { params: { prometheus_version: '3.5', loki_version: '3.4', tempo_version: '2.8' } });
  assert.equal(set.canonical.spec.telemetry.backends[0].version.declared, '3.5');
  assert.equal(set.canonical.spec.telemetry.backends[0].version.min, '2.53', 'min is the scaffold floor, not a parameter');
  assert.equal(set.canonical.spec.storage.traces.version, '2.8');
  assert.ok(!set.todos.some(t => t.params.some(p => /_version$/.test(p))));
  assert.ok(!set.todos.some(t => t.path === 'storage.logs' || t.path === 'storage.traces'), 'nothing else is a placeholder on those two');
  assert.deepEqual(validateCanonical(set.canonical, SCHEMA), []);
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
  // a composed pack's todos (prefixed artefact ids, namespaced params) are recoverable from its annotations too
  assert.deepEqual(todosFromAnnotations(canonical), [...todos].sort(byPath));
  assert.ok(todosFromAnnotations(canonical).some(t => t.params.includes('kafka.bootstrap')), 'a namespaced param survives the round trip');
  assert.throws(() => instantiatePack([byId.kafka, byId.kafka], { name: 'x', tier: 'tier-3' }), /same entry twice/);
});

test('todosFromAnnotations: the tier-1 baseline todo holds up the release gate on both paths; a plain pack has no library todos', () => {
  const { canonical, todos } = build(byId.kafka, 'tier-1');
  assert.deepEqual(todos.find(t => t.path === 'baselines').clauses, ['L5.SHOULD.tier1_release_gate'], 'the scaffold\'s one non-derivable clause');
  assert.deepEqual(todosFromAnnotations(canonical).find(t => t.path === 'baselines').clauses, ['L5.SHOULD.tier1_release_gate']);
  assert.equal(todosFromAnnotations(canonical).find(t => t.path === 'baselines').clause, 'L5.SHOULD.tier1_release_gate');
  // the tier is read from library.tier and, without it, from the declared criticality
  const noTierAnn = JSON.parse(JSON.stringify(canonical));
  delete noTierAnn.metadata.annotations['library.tier'];
  assert.deepEqual(todosFromAnnotations(noTierAnn).find(t => t.path === 'baselines').clauses, ['L5.SHOULD.tier1_release_gate']);
  // the summary the hand-off computes from the annotations is the summary a fresh instantiation gives
  assert.deepEqual(validationSummary(canonical, todosFromAnnotations(canonical)), validationSummary(canonical, todos));
  // a pack without library.todo.* annotations (hand-written, crawled) has none — /api/validate attaches no summary
  const plain = parseYaml(readFileSync(resolve(ROOT, 'vendor/observability-pack-spec', `v${SPEC_VERSION}`, 'examples/payment-service.pack.yaml'), 'utf8'));
  assert.equal(hasLibraryTodos(plain), false);
  assert.deepEqual(todosFromAnnotations(plain), []);
  assert.equal(hasLibraryTodos({}), false);
  assert.deepEqual(todosFromAnnotations(null), []);
});

// ---------------------------------------------------------------------------
// The copies: overrides over the library's SLIs, custom SLIs (docs/BUILD_JOURNEY.md "The seed and the copies").
// ---------------------------------------------------------------------------
const composed = () => [byId.kafka, byId['http-service']];
const orders = (extra = {}) => instantiatePack(composed(), { name: 'orders-api', tier: 'tier-2', environment: 'prod', owners: ['team-orders'], promql: lezer, ...extra });
const CUSTOM_RATIO = { id: 'checkout_success', type: 'ratio', good: 'sum(rate(checkout_ok_total[5m]))', total: 'sum(rate(checkout_total[5m]))', objective: 0.999, window: '30d' };
const CUSTOM_THRESHOLD = { id: 'checkout_p99', type: 'threshold', query: 'histogram_quantile(0.99, sum by (le)(rate(checkout_seconds_bucket[5m])))', threshold: 0.3, objective: 0.99, window: '7d', unit: 'seconds', description: 'Checkout p99' };

test('overrides: the objective changes the SLO id, the burn alerts and the bindings; the window the SLO; the threshold the SLI — the evidence stays the library\'s', () => {
  const dflt = orders();
  const set = orders({ overrides: { kafka_produce_latency_p99: { objective: 0.995, window: '7d', threshold: 0.25 }, http_service_availability: { objective: 0.9999 } } });
  assert.deepEqual(validateCanonical(set.canonical, SCHEMA), []);
  assert.deepEqual(failingMust(set.canonical), []);
  assert.deepEqual(set.warnings, []);
  const slo = set.canonical.spec.slos.find(x => x.sli === 'kafka_produce_latency_p99');
  assert.deepEqual(slo, { id: 'kafka_produce_latency_p99_99_5', sli: 'kafka_produce_latency_p99', objective: 0.995, window: '7d', error_budget_policy: 'ref:platform/std-budget-policy' });
  assert.equal(set.canonical.spec.slis.find(x => x.id === 'kafka_produce_latency_p99').threshold, 0.25);
  assert.equal(dflt.canonical.spec.slis.find(x => x.id === 'kafka_produce_latency_p99').threshold, 0.1, 'the library default, untouched elsewhere');
  assert.equal(set.canonical.spec.slos.find(x => x.sli === 'http_service_availability').id, 'http_service_availability_99_99');
  // the policy and the boards follow the new SLO id; the old id is nowhere
  assert.ok(set.canonical.spec.policy.burn_rate_alerts.some(a => a.slo === 'kafka_produce_latency_p99_99_5'));
  assert.ok(!JSON.stringify(set.canonical.spec).includes('kafka_produce_latency_p99_99"'));
  assert.ok(set.canonical.spec.dashboards[0].panel_bindings.some(p => p.binds_to === 'slos.kafka_produce_latency_p99_99_5'));
  assert.ok(set.canonical.spec.dashboards.find(d => d.id === 'orders-api-slo-burn').params.slos.includes('kafka_produce_latency_p99_99_5'));
  const compiledAlerts = compile(set.canonical, 'prometheus-rules').content;
  assert.match(compiledAlerts, /kafka_produce_latency_p99_99_5_burn_14x_5m_1h/);
  assert.deepEqual(checkBindings(set.canonical, genericBoards(set.canonical)), []);
  // provenance: what was customised, the library evidence kept (the expression is still the library's)
  const p = set.provenance.slis.kafka_produce_latency_p99;
  assert.deepEqual([p.library.source, p.library.entry, p.library.sli, p.customised, p.custom, p.evidence.status], ['kafka@1.0.0', 'kafka', 'produce_latency_p99', ['objective', 'window', 'threshold'], false, 'recorded-live']);
  assert.deepEqual(set.provenance.overrides, { kafka_produce_latency_p99: { objective: 0.995, window: '7d', threshold: 0.25 }, http_service_availability: { objective: 0.9999 } });
  assert.equal(set.canonical.metadata.annotations['library.customised.slis.kafka_produce_latency_p99'], 'objective,window,threshold');
  assert.deepEqual(JSON.parse(set.canonical.metadata.annotations['library.overrides']), set.provenance.overrides);
  assert.equal(set.canonical.metadata.annotations['library.evidence.slis.kafka_produce_latency_p99'], dflt.canonical.metadata.annotations['library.evidence.slis.kafka_produce_latency_p99']);
  assert.equal(dflt.provenance.slis.kafka_produce_latency_p99.customised.length, 0);
  assert.ok(!('library.overrides' in dflt.canonical.metadata.annotations) && !('library.custom' in dflt.canonical.metadata.annotations), 'nothing customised: no annotation');
  // a description and a unit are copies too
  const words = orders({ overrides: { kafka_produce_latency_p99: { description: 'Produce ack latency, p99', unit: 's' } } });
  assert.deepEqual([words.canonical.spec.slis.find(x => x.id === 'kafka_produce_latency_p99').description, words.canonical.spec.slis.find(x => x.id === 'kafka_produce_latency_p99').unit], ['Produce ack latency, p99', 's']);
  // an above-tier SLI can be customised like any other
  const aboveOv = orders({ toggles: { slis: [...defaultToggles(composed(), 'tier-2').slis, 'kafka_controller_election_rate'] }, overrides: { kafka_controller_election_rate: { objective: 0.95 } } });
  assert.equal(aboveOv.canonical.spec.slos.find(x => x.sli === 'kafka_controller_election_rate').id, 'kafka_controller_election_rate_95');
  assert.deepEqual(validateCanonical(aboveOv.canonical, SCHEMA), []);
  // todosFromAnnotations still rebuilds the same todo list on a customised pack
  assert.deepEqual(todosFromAnnotations(set.canonical), [...set.todos].sort(byPath));
});

test('overrides: an edited expression replaces the library\'s PromQL and drops its evidence to custom, honestly', () => {
  const q = orders({ overrides: { kafka_produce_latency_p99: { query: 'histogram_quantile(0.99, sum by (le)(rate(produce_seconds_bucket[5m])))' }, http_service_availability: { good: 'sum(rate(http_ok_total[5m]))', total: 'sum(rate(http_total[5m]))' } } });
  assert.deepEqual(validateCanonical(q.canonical, SCHEMA), []);
  assert.deepEqual(q.warnings.filter(w => w.kind === 'promql'), []);
  assert.equal(q.canonical.spec.slis.find(x => x.id === 'kafka_produce_latency_p99').query, 'histogram_quantile(0.99, sum by (le)(rate(produce_seconds_bucket[5m])))');
  const av = q.canonical.spec.slis.find(x => x.id === 'http_service_availability');
  assert.deepEqual([av.good, av.total], ['sum(rate(http_ok_total[5m]))', 'sum(rate(http_total[5m]))']);
  assert.ok(!('semconv_metric' in av), 'the semconv claim was the template\'s expression\'s: dropped with it');
  assert.deepEqual(q.provenance.slis.kafka_produce_latency_p99.evidence, { status: 'custom', source: 'edited in the studio', note: 'the library evidence no longer applies' });
  assert.deepEqual(q.provenance.slis.kafka_produce_latency_p99.customised, ['query']);
  assert.deepEqual(q.provenance.slis.http_service_availability.customised, ['good', 'total']);
  assert.equal(q.canonical.metadata.annotations['library.evidence.slis.kafka_produce_latency_p99'], 'custom: edited in the studio — the library evidence no longer applies');
  assert.equal(q.provenance.slis.kafka_broker_availability.evidence.status, 'recorded-live', 'the others keep theirs');
  // a broken override is a promql warning like a broken param (the grammar runs on the pack as written)
  const bad = orders({ overrides: { kafka_produce_latency_p99: { query: 'sum(rate(x[5m])' } } });
  assert.ok(bad.warnings.some(w => w.kind === 'promql' && w.sli === 'kafka_produce_latency_p99' && w.field === 'query'), JSON.stringify(bad.warnings));
  // a threshold whose unit reads as a ratio still draws the generator's own warning
  assert.ok(orders({ overrides: { kafka_produce_latency_p99: { unit: 'ratio', threshold: 1 } } }).warnings.some(w => w.kind === 'burn-rules' && /kafka_produce_latency_p99/.test(w.message)));
});

test('overrides: the usage errors name the field, and an override for an SLI not in the pack is a warning', () => {
  const err = (overrides) => { try { orders({ overrides }); } catch (e) { return e.message; } return null; };
  assert.match(err({ kafka_produce_latency_p99: { nope: 1 } }), /^override kafka_produce_latency_p99\.nope: unknown field \(the fields are objective, window, threshold, query, good, total, description, unit\)$/);
  assert.match(err({ kafka_produce_latency_p99: { window: '30x' } }), /^override kafka_produce_latency_p99\.window: the window is one of 7d \| 28d \| 30d \| 90d \(the schema's SLO windows\), got "30x"$/);
  assert.match(err({ kafka_produce_latency_p99: { window: '14d' } }), /the schema's SLO windows/, 'the schema\'s enum, not any duration');
  assert.match(err({ kafka_produce_latency_p99: { objective: 1 } }), /^override kafka_produce_latency_p99\.objective: the objective is a number in \(0, 1\)/);
  assert.match(err({ kafka_produce_latency_p99: { objective: '0.99' } }), /the objective is a number/);
  assert.match(err({ kafka_produce_latency_p99: { threshold: 'x' } }), /^override kafka_produce_latency_p99\.threshold: the threshold is a finite number/);
  assert.match(err({ kafka_produce_latency_p99: { threshold: Infinity } }), /finite number/);
  assert.match(err({ kafka_broker_availability: { threshold: 1 } }), /^override kafka_broker_availability\.threshold: a ratio SLI has no threshold/);
  assert.match(err({ kafka_broker_availability: { query: 'up' } }), /^override kafka_broker_availability\.query: a ratio SLI has good and total, not a query$/);
  assert.match(err({ kafka_produce_latency_p99: { good: 'up' } }), /^override kafka_produce_latency_p99\.good: a threshold SLI has a query, not good$/);
  assert.match(err({ kafka_produce_latency_p99: { query: '' } }), /the PromQL must be a non-empty string/);
  assert.match(err({ kafka_produce_latency_p99: { query: 'up{job="${job}"}' } }), /^override kafka_produce_latency_p99\.query: the PromQL may not carry a \$\{…\} placeholder \(\$\{job\}\)/);
  assert.match(err({ kafka_produce_latency_p99: { query: 'x'.repeat(MAX_PARAM_LENGTH + 1) } }), new RegExp(`may not exceed ${MAX_PARAM_LENGTH} characters \\(${MAX_PARAM_LENGTH + 1} given\\)`));
  assert.match(err({ kafka_produce_latency_p99: { unit: 'x'.repeat(65) } }), /the unit may not exceed 64 characters/);
  assert.match(err({ kafka_produce_latency_p99: { comparison: '<' } }), /^override kafka_produce_latency_p99\.comparison: not a field: an ObservabilityPack v1\.2 threshold is an upper bound/);
  assert.match(err({ kafka_produce_latency_p99: 'x' }), /^override kafka_produce_latency_p99: expected an object of fields, got string$/);
  assert.match(err({ kafka_produce_latency_p99: null }), /got null/);
  assert.match(err('x'), /overrides must be an object/);
  assert.match(err(['x']), /overrides must be an object/);
  // prototype pollution: the polluting keys are refused as keys and as fields, and nothing is read through the chain
  assert.match(err(JSON.parse('{"__proto__": {"objective": 0.5}}')), /^override __proto__: not an SLI id/);
  assert.match(err({ constructor: { objective: 0.5 } }), /^override constructor: not an SLI id/);
  assert.match(err({ prototype: { objective: 0.5 } }), /^override prototype: not an SLI id/);
  assert.match(err({ 'Kafka-Produce': { objective: 0.5 } }), /not an SLI id/);
  assert.match(err({ kafka_produce_latency_p99: JSON.parse('{"__proto__": {"objective": 0.5}}') }), /^override kafka_produce_latency_p99\.__proto__: refused$/);
  assert.equal(SLI_KEY_RE.test('a'.repeat(64)), true);
  assert.equal(SLI_KEY_RE.test('a'.repeat(65)), false);
  assert.deepEqual(OVERRIDE_FIELDS, ['objective', 'window', 'threshold', 'query', 'good', 'total', 'description', 'unit']);
  // not in the pack: a warning of kind override, the rest builds unchanged
  const w = orders({ overrides: { nope_sli: { objective: 0.5 }, kafka_controller_election_rate: { objective: 0.5 }, kafka_produce_latency_p99: {} } });
  assert.deepEqual(w.warnings.map(x => [x.kind, x.sli]), [['override', 'nope_sli'], ['override', 'kafka_controller_election_rate']]);
  assert.match(w.warnings[0].message, /^override nope_sli: the SLI is not in the pack \(unknown\)/);
  assert.match(w.warnings[1].message, /not in the pack \(not selected\)/);
  assert.deepEqual(w.provenance.overrides, {}, 'an empty override and the warned ones apply nothing');
  assert.deepEqual(w.canonical.spec.slos, orders().canonical.spec.slos);
  // Object.hasOwn semantics: a key inherited by the overrides object is never applied
  const inherited = Object.create({ kafka_produce_latency_p99: { objective: 0.5 } });
  assert.equal(orders({ overrides: inherited }).canonical.spec.slos.find(x => x.sli === 'kafka_produce_latency_p99').objective, 0.99);
});

test('custom SLIs: a ratio and a threshold one land in slis, slos, the recording rules, the policy, the bindings; the schema and the rubric count them like any SLI', () => {
  const c = orders({ custom: [CUSTOM_RATIO, CUSTOM_THRESHOLD] });
  assert.deepEqual(validateCanonical(c.canonical, SCHEMA), []);
  assert.deepEqual(c.warnings, []);
  assert.deepEqual(failingMust(c.canonical), []);
  const ids = c.canonical.spec.slis.map(x => x.id);
  assert.deepEqual(ids.slice(-2), ['checkout_success', 'checkout_p99'], 'after the library SLIs');
  assert.equal(c.canonical.spec.slis.length, 9);
  assert.deepEqual(c.canonical.spec.slis.find(x => x.id === 'checkout_success'), { id: 'checkout_success', type: 'ratio', description: 'custom ratio SLI — written in the studio', good: CUSTOM_RATIO.good, total: CUSTOM_RATIO.total });
  assert.deepEqual(c.canonical.spec.slis.find(x => x.id === 'checkout_p99'), { id: 'checkout_p99', type: 'threshold', description: 'Checkout p99', query: CUSTOM_THRESHOLD.query, threshold: 0.3, unit: 'seconds' });
  assert.deepEqual(c.canonical.spec.slos.find(x => x.sli === 'checkout_success'), { id: 'checkout_success_99_9', sli: 'checkout_success', objective: 0.999, window: '30d', error_budget_policy: 'ref:platform/std-budget-policy' });
  assert.deepEqual(c.canonical.spec.slos.find(x => x.sli === 'checkout_p99'), { id: 'checkout_p99_99', sli: 'checkout_p99', objective: 0.99, window: '7d', error_budget_policy: 'ref:platform/std-budget-policy' });
  assert.deepEqual(c.canonical.spec.queries.recording_rules.slice(-2), [{ name: 'orders_api:checkout_success:ratio_5m', expr: 'ref:slis.checkout_success', interval: '30s' }, { name: 'orders_api:checkout_p99:value_5m', expr: 'ref:slis.checkout_p99', interval: '30s' }]);
  // the burn alerts from the default profile: availability for a ratio, latency for a threshold (the profile a template without `burn` takes)
  assert.deepEqual(DEFAULT_BURN_PROFILE, { ratio: 'availability', threshold: 'latency' });
  assert.deepEqual(c.canonical.spec.policy.burn_rate_alerts.find(a => a.slo === 'checkout_success_99_9').windows, BURN_PROFILES.availability);
  assert.deepEqual(c.canonical.spec.policy.burn_rate_alerts.find(a => a.slo === 'checkout_p99_99').windows, BURN_PROFILES.latency);
  const overview = c.canonical.spec.dashboards[0];
  for (const b of ['slis.checkout_success', 'slis.checkout_p99', 'slos.checkout_success_99_9', 'slos.checkout_p99_99']) assert.ok(overview.panel_bindings.some(p => p.binds_to === b), b);
  assert.ok(c.canonical.spec.dashboards.find(d => d.id === 'orders-api-slo-burn').params.slos.includes('checkout_p99_99'));
  assert.deepEqual(checkBindings(c.canonical, genericBoards(c.canonical)), []);
  for (const target of Object.keys(TARGETS)) assert.ok(compile(c.canonical, target).content.length > 0, target);
  assert.match(compile(c.canonical, 'prometheus-rules').content, /checkout_success_99_9_burn_14x_5m_1h/);
  // provenance and annotations
  assert.deepEqual(c.provenance.slis.checkout_success, { library: { source: 'custom', entry: null, sli: null }, evidence: { status: 'custom', source: 'written in the studio' }, customised: [], custom: true, aboveTier: false });
  assert.deepEqual(c.provenance.custom, ['checkout_success', 'checkout_p99']);
  assert.equal(c.canonical.metadata.annotations['library.custom'], 'checkout_success,checkout_p99');
  assert.equal(c.canonical.metadata.annotations['library.evidence.slis.checkout_success'], 'custom: written in the studio');
  assert.equal(c.canonical.metadata.annotations['library.slis'], defaultToggles(composed(), 'tier-2').slis.join(','), 'library.slis stays the library selection');
  assert.equal(c.canonical.metadata.labels['library.entries'], 'kafka,http-service', 'the custom fragment is no entry');
  assert.equal(c.canonical.metadata.annotations['library.source'], 'kafka@1.0.0,http-service@1.0.0');
  // the rubric is not bent: a pack of one custom ratio SLI and nothing else from the library fails the latency clause at tier-2, like any pack without a threshold SLI
  const only = orders({ toggles: { slis: [] }, custom: [CUSTOM_RATIO] });
  assert.deepEqual(only.canonical.spec.slis.map(x => x.id), ['checkout_success']);
  assert.deepEqual(failingMust(only.canonical), ['L1.MUST.latency_slo']);
  assert.deepEqual(validateCanonical(only.canonical, SCHEMA), []);
  // at tier-1 a custom ratio SLI can carry the forecast and the generic remediation like any first SLO
  const t1 = instantiatePack(byId['http-service'], { name: 'checkout', tier: 'tier-1', toggles: { slis: [] }, custom: [CUSTOM_RATIO, CUSTOM_THRESHOLD] });
  assert.equal(t1.canonical.spec.policy.forecasts[0].slo, 'checkout_success_99_9');
  assert.deepEqual(validateCanonical(t1.canonical, SCHEMA), []);
  assert.deepEqual(failingMust(t1.canonical), []);
  assert.deepEqual(todosFromAnnotations(c.canonical), [...c.todos].sort(byPath));
});

test('custom SLIs: the usage errors — a duplicate or clashing id, a missing field, a bad type, an unknown field, comparison', () => {
  const err = (custom) => { try { orders({ custom }); } catch (e) { return e.message; } return null; };
  assert.match(err([CUSTOM_RATIO, CUSTOM_RATIO]), /^custom checkout_success\.id: declared twice in custom$/);
  assert.match(err([{ ...CUSTOM_RATIO, id: 'kafka_broker_availability' }]), /^custom kafka_broker_availability\.id: clashes with the library SLI kafka_broker_availability of kafka in the pack/);
  // a library id of the entries is owned even un-ticked: it would clash the moment it is ticked (and the studio would draw two cards with one key)
  const shadow = (() => { try { orders({ toggles: { slis: ['kafka_produce_latency_p99'] }, custom: [{ ...CUSTOM_RATIO, id: 'kafka_broker_availability' }] }); } catch (e) { return e.message; } return null; })();
  assert.match(shadow, /^custom kafka_broker_availability\.id: shadows the library SLI kafka_broker_availability of kafka \(not in the pack now — it would clash the moment it is ticked\) — pick another id$/);
  assert.equal(orders({ toggles: { slis: ['kafka_produce_latency_p99'] }, custom: [{ ...CUSTOM_RATIO, id: 'broker_availability' }] }).canonical.spec.slis.length, 2, 'the bare id is nobody\'s in a composed pack');
  assert.match(err([{ ...CUSTOM_RATIO, id: 'A' }]), /^custom\[0\]\.id: a slug of 2 to 63 characters is required/);
  assert.match(err([{ ...CUSTOM_RATIO, id: 'a' }]), /a slug of 2 to 63 characters/);
  assert.match(err([{ ...CUSTOM_RATIO, id: 'errorbudget' }]), /reserved policy-record segment/);
  assert.match(err([{ ...CUSTOM_RATIO, id: '__proto__' }]), /^custom\[0\]\.id: a slug/);
  assert.match(err([{ ...CUSTOM_RATIO, type: 'distribution' }]), /^custom checkout_success\.type: expected ratio \| threshold/);
  const { window: _w, ...noWindow } = CUSTOM_RATIO;
  assert.match(err([noWindow]), /^custom checkout_success\.window: required for a ratio SLI$/);
  const { objective: _o, ...noObjective } = CUSTOM_THRESHOLD;
  assert.match(err([noObjective]), /^custom checkout_p99\.objective: required for a threshold SLI$/);
  const { total: _t, ...noTotal } = CUSTOM_RATIO;
  assert.match(err([noTotal]), /^custom checkout_success\.total: required for a ratio SLI$/);
  const { threshold: _th, ...noThreshold } = CUSTOM_THRESHOLD;
  assert.match(err([noThreshold]), /^custom checkout_p99\.threshold: required for a threshold SLI$/);
  assert.match(err([{ ...CUSTOM_RATIO, query: 'up' }]), /^custom checkout_success\.query: a ratio SLI has good and total, not a query$/);
  assert.match(err([{ ...CUSTOM_THRESHOLD, comparison: '<' }]), /^custom checkout_p99\.comparison: not a field: an ObservabilityPack v1\.2 threshold is an upper bound/);
  assert.match(err([{ ...CUSTOM_RATIO, nope: 1 }]), /^custom checkout_success\.nope: unknown field \(the fields are id, type, objective, window, threshold, query, good, total, description, unit\)$/);
  assert.match(err([{ ...CUSTOM_RATIO, window: '30x' }]), /^custom checkout_success\.window: the window is one of 7d \| 28d \| 30d \| 90d/);
  assert.match(err([{ ...CUSTOM_RATIO, good: 'sum(${x})' }]), /may not carry a \$\{…\} placeholder/);
  assert.match(err(['x']), /^custom\[0\]: expected an object, got string$/);
  assert.match(err({ id: 'x' }), /custom must be a list/);
  assert.equal(CUSTOM_ID_RE.test('checkout_success'), true);
  assert.deepEqual(CUSTOM_FIELDS, ['id', 'type', ...OVERRIDE_FIELDS]);
  // a custom SLI's PromQL is parsed like any other: a broken one is a promql warning, not a usage error
  assert.ok(orders({ custom: [{ ...CUSTOM_RATIO, good: 'sum(rate(x[5m])' }] }).warnings.some(w => w.kind === 'promql' && w.sli === 'checkout_success' && w.field === 'good'));
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
test('packc init builds a pack: YAML on stdout, todos on stderr, exit 0; a section off or a failing MUST exits 1; usage errors exit 2', () => {
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
  // schema-valid, but a MUST of the tier fails (no latency SLO at tier-2): exit 1, so CI can tell MUST 14/15 from 15/15
  const noLatency = cli('--entry', 'kafka', '--tier', 'tier-2', '--name', 'orders', '--slis', 'broker_availability');
  assert.equal(noLatency.status, 1, noLatency.stderr);
  assert.match(noLatency.stderr, /MUST 14\/15/);
  assert.match(noLatency.stderr, /L1\.MUST\.latency_slo/);
  assert.match(noLatency.stderr, /schema: valid/);
  assert.match(noLatency.stderr, /^conformance: 1 MUST clause\(s\) fail at tier-2/m);
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
  // --slis (or --sli) accepts any SLI of the chosen entries: a tier-1 SLI in a tier-3 pack is in it, no warning
  const above = cli('--entry', 'prometheus', '--tier', 'tier-3', '--name', 'prom', '--slis', 'scrape_success_ratio,wal_corruption_freshness');
  assert.equal(above.status, 0, above.stderr);
  assert.doesNotMatch(above.stderr, /sli-excluded/);
  assert.match(above.stderr, /2 SLI\(s\)/);
  assert.ok(parseYaml(above.stdout).spec.slis.some(x => x.id === 'wal_corruption_freshness'));
  const alias = cli('--entry', 'prometheus', '--tier', 'tier-3', '--name', 'prom', '--sli', 'scrape_success_ratio', '--sli', 'wal_corruption_freshness');
  assert.equal(alias.status, 0, alias.stderr);
  assert.match(alias.stderr, /2 SLI\(s\)/);
  // --override <sli>.<field>=<value>: objective, window, threshold (queries are edited in the studio or the pack file)
  const ov = cli('--entry', 'kafka', '--tier', 'tier-2', '--name', 'orders', '--override', 'produce_latency_p99.objective=0.995', '--override', 'produce_latency_p99.window=7d', '--override', 'produce_latency_p99.threshold=0.25');
  assert.equal(ov.status, 0, ov.stderr);
  const ovPack = parseYaml(ov.stdout);
  assert.deepEqual(ovPack.spec.slos.find(x => x.sli === 'produce_latency_p99'), { id: 'produce_latency_p99_99_5', sli: 'produce_latency_p99', objective: 0.995, window: '7d', error_budget_policy: 'ref:platform/std-budget-policy' });
  assert.equal(ovPack.spec.slis.find(x => x.id === 'produce_latency_p99').threshold, 0.25);
  assert.equal(ovPack.metadata.annotations['library.customised.slis.produce_latency_p99'], 'objective,window,threshold');
  assert.match(ov.stderr, /1 customised/);
  assert.equal(cli('--entry', 'kafka', '--tier', 'tier-2', '--name', 'orders', '--override', 'produce_latency_p99.query=up').status, 2, 'a query is not a CLI override');
  assert.match(cli('--entry', 'kafka', '--tier', 'tier-2', '--name', 'orders', '--override', 'produce_latency_p99.query=up').stderr, /--override takes objective, window or threshold/);
  assert.equal(cli('--entry', 'kafka', '--tier', 'tier-2', '--name', 'orders', '--override', 'produce_latency_p99.objective=abc').status, 2, 'a number is required');
  assert.equal(cli('--entry', 'kafka', '--tier', 'tier-2', '--name', 'orders', '--override', 'produce_latency_p99.window=30x').status, 2, 'the engine\'s usage error is exit 2');
  assert.match(cli('--entry', 'kafka', '--tier', 'tier-2', '--name', 'orders', '--override', 'produce_latency_p99.window=30x').stderr, /override produce_latency_p99\.window: the window is one of 7d \| 28d \| 30d \| 90d/);
  assert.equal(cli('--entry', 'kafka', '--tier', 'tier-2', '--name', 'orders', '--override', 'nodot=1').status, 2);
  const absent = cli('--entry', 'kafka', '--tier', 'tier-2', '--name', 'orders', '--override', 'controller_election_rate.objective=0.5');
  assert.equal(absent.status, 0, 'an override for an SLI not in the pack is a warning');
  assert.match(absent.stderr, /warning \[override\]: override controller_election_rate: the SLI is not in the pack \(not selected\)/);
  const json = cli('--entry', 'http-service', '--tier', 'tier-3', '--name', 'checkout-api', '--json', '--param', 'health_url=https://checkout.example.internal/health');
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.deepEqual(payload.schemaErrors, []);
  assert.deepEqual(payload.warnings.filter(w => w.kind === 'promql'), []);
  assert.equal(payload.summary.must.passed, 9);
  assert.ok(!payload.todos.some(t => t.params.includes('health_url')));
});

test('findEntry; a missing library root is an error that names it; the package ships library/', () => {
  assert.equal(findEntry(library, 'kafka').id, 'kafka');
  assert.equal(findEntry(library, 'nope'), null);
  const missing = loadLibrary({ root: resolve(ROOT, 'tools/fixtures/does-not-exist') });
  assert.deepEqual(missing.entries, []);
  assert.equal(missing.errors.length, 1);
  assert.equal(missing.errors[0].file, missing.root);
  assert.match(missing.errors[0].errors[0], /library root not found: .*does-not-exist/);
  const r = cli('--library', 'tools/fixtures/does-not-exist', '--entry', 'kafka', '--tier', 'tier-2', '--name', 'orders');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /library root not found/);
  assert.match(cli('--library', 'tools/fixtures/does-not-exist', '--list').stderr, /library root not found/);
  // an installed `packc init` is only its entries: library/ must be in the npm files list (it was not; --list printed an empty table)
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('library/'), `package.json files: ${pkg.files.join(', ')}`);
});
