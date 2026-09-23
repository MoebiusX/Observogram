#!/usr/bin/env node
/**
 * tools/test-build-model.mjs — the BUILD journey's studio models (studio/build-model.mjs) and
 * loaders (studio/build-api.mjs), headless under node:test (docs/UI_CONVENTIONS.md §2: the model
 * layer is the testable layer; the repo has no DOM harness).
 *
 * The inputs are real API responses captured once from the running server into
 * tools/fixtures/build/ (GET /api/library, GET /api/library/requirements/:tier, GET
 * /api/compile/targets, POST /api/library/instantiate for orders-api = kafka + http-service at
 * tier-2, env prod, owner team-orders). The instantiate fixture is asserted stable against a fresh
 * in-process instantiation of the same inputs, so a change in the engine or the library shows up
 * here first; regenerate with `node tools/test-build-model.mjs --update` (in-process, the same
 * computation the route performs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit as emitYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_VERSION } from './lib/validator.mjs';
import { evaluateConformance } from './lib/conformance.mjs';
import { applyEnvironmentOverlay } from './lib/adapter.mjs';
import { listTargets } from './lib/compile.mjs';
import { instantiatePack, libraryIndex, tierRequirements, validationSummary, SCAFFOLD_PARAMS, TIERS as ENGINE_TIERS } from './lib/library.mjs';
import { loadLibrary, findEntry } from '../server/library.mjs';
import { parsePromqlDependencies as lezer } from './lib/promql-lezer.mjs';
import {
  BUILD_STEPS, TIERS, SECTION_TOGGLES, MAX_SERVICE_SLUG, LONGEST_DERIVED_SUFFIX, serviceSlug, isValidServiceName, parseOwners, sliKey, paramKey,
  defineValid, buildStepReachability, clampStep, paramRows, effectiveParams, instantiateBody,
  buildDefineModel, buildCompileModel, summarizeWarnings, buildClauseChecklist, buildRailModel,
  placeholdersRemaining, groupTodos, buildVerifyModel, reachableSliKeys, retargetSlis, splitBuildErrors, isStale, resolveBuiltins,
} from '../studio/build-model.mjs';
import {
  loadLibrary as loadLibraryApi, loadRequirements, loadTargets, instantiate, compilePreview, registerBuiltPack,
} from '../studio/build-api.mjs';
import { defaultBuildState, BUILD_PERSIST_FIELDS } from '../studio/state.mjs';
import { renderBuildDefine } from '../studio/build-define-view.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = resolve(ROOT, 'tools/fixtures/build');
const SCHEMA = JSON.parse(readFileSync(resolve(ROOT, 'vendor/observability-pack-spec', `v${SPEC_VERSION}`, 'observability-pack.schema.json'), 'utf8'));
const UPDATE = process.argv.includes('--update');
const read = (name) => JSON.parse(readFileSync(resolve(FIX, name), 'utf8'));

// The captured inputs of the instantiate fixture (what the DEFINE step sends for the drive).
const INPUTS = { entries: ['kafka', 'http-service'], name: 'orders-api', tier: 'tier-2', environment: 'prod', owners: ['team-orders'], params: {}, toggles: {} };

// The same computation POST /api/library/instantiate performs, in process.
function instantiateInProcess(inputs) {
  const library = loadLibrary();
  const entries = inputs.entries.map(id => findEntry(library, id));
  const { canonical, todos, provenance, warnings } = instantiatePack(entries, { ...inputs, promql: lezer });
  const schemaErrors = validateCanonical(canonical, SCHEMA);
  const summary = validationSummary(canonical, todos);
  const { spec, effective } = applyEnvironmentOverlay(canonical.spec, provenance.environment);
  const overlaid = { ...canonical, spec, metadata: { ...canonical.metadata, bindings: { ...canonical.metadata.bindings, ...(effective.criticality ? { criticality: effective.criticality } : {}) } } };
  const conformance = evaluateConformance(overlaid);
  const canonicalYaml = `# ObservabilityPack ${canonical.metadata.name} — built from the library (${provenance.source}) at ${provenance.tier}\n# Todos: ${todos.length} (metadata.annotations library.todo.*). Spec v${SPEC_VERSION}.\n` + emitYaml(canonical);
  return { ok: true, canonical, canonicalYaml, todos, provenance, warnings, schemaErrors, summary, conformance };
}

if (UPDATE) {
  const library = loadLibrary();
  writeFileSync(resolve(FIX, 'orders-api.tier-2.instantiate.json'), JSON.stringify(instantiateInProcess(INPUTS), null, 2) + '\n');
  writeFileSync(resolve(FIX, 'library.index.json'), JSON.stringify({ ok: true, entries: libraryIndex(library.entries), scaffoldParams: SCAFFOLD_PARAMS, errors: library.errors }, null, 2) + '\n');
  for (const t of ENGINE_TIERS) writeFileSync(resolve(FIX, `requirements.${t}.json`), JSON.stringify({ ok: true, tier: t, clauses: tierRequirements(t) }, null, 2) + '\n');
  writeFileSync(resolve(FIX, 'compile.targets.json'), JSON.stringify({ targets: listTargets() }, null, 2) + '\n');
  console.log('fixtures regenerated under tools/fixtures/build/');
}

const FIXTURE = read('orders-api.tier-2.instantiate.json');
const INDEX = read('library.index.json');
const LIBRARY = { entries: INDEX.entries, scaffoldParams: INDEX.scaffoldParams, errors: INDEX.errors };
const REQUIREMENTS = Object.fromEntries(TIERS.map(t => [t, read(`requirements.${t}.json`).clauses]));
const TARGETS = read('compile.targets.json').targets;

// The draft after the drive's DEFINE step, with the fixture as its result.
const draft = (over = {}) => ({
  ...defaultBuildState(),
  name: 'orders-api', owners: 'team-orders', environment: 'prod', tier: 'tier-2', entries: ['kafka', 'http-service'],
  result: { canonical: FIXTURE.canonical, canonicalYaml: FIXTURE.canonicalYaml, todos: FIXTURE.todos, warnings: FIXTURE.warnings, summary: FIXTURE.summary, conformance: FIXTURE.conformance, schemaErrors: FIXTURE.schemaErrors, provenance: FIXTURE.provenance },
  ...over,
});

// ---------------------------------------------------------------------------
// The fixture is what the engine produces today
// ---------------------------------------------------------------------------

test('the instantiate fixture is stable: a fresh in-process instantiation of the same inputs matches it', () => {
  const fresh = instantiateInProcess(INPUTS);
  assert.deepEqual(fresh.canonical, FIXTURE.canonical, 'canonical drifted — regenerate with --update if the engine or the library changed on purpose');
  assert.deepEqual(fresh.todos, FIXTURE.todos);
  assert.deepEqual(fresh.warnings, FIXTURE.warnings);
  assert.deepEqual(fresh.schemaErrors, FIXTURE.schemaErrors);
  assert.deepEqual(fresh.summary, FIXTURE.summary);
  assert.deepEqual(fresh.provenance, FIXTURE.provenance);
  assert.equal(fresh.conformance.mustPercent, FIXTURE.conformance.mustPercent);
  assert.equal(fresh.canonicalYaml, FIXTURE.canonicalYaml);
  // The shape VERIFY reads.
  assert.equal(FIXTURE.summary.tier, 'tier-2');
  assert.deepEqual(FIXTURE.summary.must, { passed: 15, total: 15 });
  assert.deepEqual(FIXTURE.summary.should, { passed: 1, total: 1 });
  assert.equal(FIXTURE.summary.onPlaceholder.length, 4);
  assert.equal(FIXTURE.summary.failing.length, 0);
  assert.equal(FIXTURE.todos.length, 21);
  assert.deepEqual(FIXTURE.warnings, []);
  assert.deepEqual(FIXTURE.schemaErrors, []);
  assert.equal(FIXTURE.provenance.placeholders.length, 17);
});

test('the index fixture is what libraryIndex returns and the requirements are the rubric per tier', () => {
  const library = loadLibrary();
  assert.deepEqual(INDEX.entries, libraryIndex(library.entries));
  assert.deepEqual(INDEX.scaffoldParams, SCAFFOLD_PARAMS);
  for (const t of TIERS) assert.deepEqual(REQUIREMENTS[t], tierRequirements(t), t);
  assert.deepEqual(TARGETS.map(t => t.id), listTargets().map(t => t.id));
  // The index carries what COMPILE shows read-only: the objective AND the window per tier.
  const kafka = INDEX.entries.find(e => e.id === 'kafka');
  const ba = kafka.slis.find(s => s.id === 'broker_availability');
  assert.deepEqual(ba.objectives, { 'tier-3': 0.99, 'tier-2': 0.999, 'tier-1': 0.999 });
  assert.deepEqual(ba.windows, { 'tier-3': '30d', 'tier-2': '30d', 'tier-1': '30d' });
  assert.deepEqual(kafka.slis.find(s => s.id === 'consumer_group_lag_seconds').windows, { 'tier-3': '7d', 'tier-2': '7d', 'tier-1': '7d' });
});

// ---------------------------------------------------------------------------
// Helpers — the engine's rules, spelled once
// ---------------------------------------------------------------------------

test('serviceSlug / isValidServiceName mirror the engine (fileSlug + the slug rule)', () => {
  assert.equal(serviceSlug('Orders API'), 'orders-api');
  assert.equal(serviceSlug('  --x--  '), 'x');
  assert.equal(isValidServiceName('orders-api'), true);
  assert.equal(isValidServiceName('x'), false, 'one character does not slug to a valid name (the engine refuses it)');
  assert.equal(isValidServiceName(''), false);
  assert.equal(isValidServiceName('9lives'), false);
  // The bound: the schema's 64-character Slug minus the longest suffix the scaffold appends
  // (measured: a 46-character name fails `$.spec.dashboards[2].id: length 65 > maxLength 64`).
  assert.equal(LONGEST_DERIVED_SUFFIX, '-deployment-overlay');
  assert.equal(MAX_SERVICE_SLUG, 64 - '-deployment-overlay'.length);
  assert.equal(MAX_SERVICE_SLUG, 45);
  assert.equal(isValidServiceName('a'.repeat(MAX_SERVICE_SLUG)), true, '45 once slugged is accepted');
  assert.equal(isValidServiceName('a'.repeat(MAX_SERVICE_SLUG + 1)), false, '46 is refused');
  const tooLong = buildDefineModel({ build: draft({ name: 'a'.repeat(MAX_SERVICE_SLUG + 1) }), library: LIBRARY });
  assert.equal(tooLong.valid, false);
  assert.ok(tooLong.errors.some(e => e.includes('at most 45 characters') && e.includes('is 46')), tooLong.errors.join(' | '));
  assert.deepEqual(parseOwners('team-orders, sre-platform'), ['team-orders', 'sre-platform']);
  assert.deepEqual(parseOwners(''), []);
  assert.equal(sliKey('kafka', 'broker_availability', true), 'kafka_broker_availability');
  assert.equal(sliKey('http-service', 'availability', true), 'http_service_availability');
  assert.equal(sliKey('kafka', 'broker_availability', false), 'broker_availability');
  assert.equal(paramKey('kafka', 'bootstrap', true), 'kafka.bootstrap');
  assert.equal(paramKey('kafka', 'bootstrap', false), 'bootstrap');
  assert.equal(paramKey(null, 'oncall_channel', true), 'oncall_channel', 'scaffold params are never namespaced');
  assert.deepEqual(BUILD_STEPS, ['define', 'compile', 'verify']);
  assert.deepEqual(TIERS, ENGINE_TIERS);
  assert.deepEqual(SECTION_TOGGLES.map(t => t.id), ['slos', 'policy', 'routes', 'dashboards', 'validation']);
});

// ---------------------------------------------------------------------------
// Step reachability
// ---------------------------------------------------------------------------

test('a step is reachable when the previous step\'s inputs are valid', () => {
  const empty = defaultBuildState();
  assert.equal(defineValid(empty), false);
  assert.deepEqual(buildStepReachability(empty), { define: true, compile: false, verify: false });
  const selected = draft({ result: null });
  assert.equal(defineValid(selected), true);
  assert.deepEqual(buildStepReachability(selected), { define: true, compile: true, verify: false }, 'no result yet: Verify stays locked');
  assert.deepEqual(buildStepReachability(draft()), { define: true, compile: true, verify: true });
  assert.deepEqual(buildStepReachability(draft({ error: ['instantiatePack: at least one SLI must stay selected'], result: null })), { define: true, compile: true, verify: false });
  assert.deepEqual(buildStepReachability(draft({ error: ['param kafka.bootstrap: a value may not contain a double quote'] })), { define: true, compile: true, verify: true }, 'a usage error keeps the previous pack, so Verify — where the field is — stays reachable');
  assert.equal(clampStep(draft({ error: ['param kafka.bootstrap: a value may not contain a double quote'] }), 'verify'), 'verify', 'the user is not bounced off Verify by the error');
  assert.deepEqual(buildStepReachability(draft({ name: 'x' })), { define: true, compile: false, verify: false }, 'an invalid name locks Compile even with a stale result');
  assert.deepEqual(buildStepReachability(draft({ entries: [] })), { define: true, compile: false, verify: false });
  assert.equal(clampStep(empty, 'verify'), 'define');
  assert.equal(clampStep(selected, 'verify'), 'compile');
  assert.equal(clampStep(draft(), 'verify'), 'verify');
  assert.equal(clampStep(draft(), 'nonsense'), 'define');
  // A draft persisted before the rename (select · generate · validate) resumes on the same step.
  assert.equal(clampStep(draft(), 'validate'), 'verify');
  assert.equal(clampStep(draft(), 'generate'), 'compile');
  assert.equal(clampStep(empty, 'generate'), 'define');
});

// ---------------------------------------------------------------------------
// Params and the instantiate body
// ---------------------------------------------------------------------------

test('paramRows: the scaffold params then each entry\'s, namespaced when composing; overrides and placeholders', () => {
  const rows = paramRows({ build: draft({ params: { 'kafka.bootstrap': 'kafka-0:9092', oncall_channel: '' } }), library: LIBRARY });
  assert.equal(rows.length, SCAFFOLD_PARAMS.length + 7 + 3, '16 scaffold + 7 kafka + 3 http-service');
  assert.equal(rows[0].key, 'oncall_channel');
  assert.equal(rows[0].entry, null);
  assert.equal(rows[0].atDefault, true, 'an empty override is no override');
  const boot = rows.find(r => r.key === 'kafka.bootstrap');
  assert.equal(boot.entry, 'kafka');
  assert.equal(boot.placeholder, true);
  assert.equal(boot.value, 'kafka-0:9092');
  assert.equal(boot.effective, 'kafka-0:9092');
  assert.equal(boot.atDefault, false);
  assert.equal(rows.find(r => r.key === 'http-service.job').default, '${service}');
  // The hint an input shows is the default with the engine's built-ins resolved — what the todo beside it names.
  assert.equal(rows.find(r => r.key === 'http-service.job').hint, 'orders-api');
  assert.equal(rows.find(r => r.key === 'oncall_channel').default, '#${service}-oncall', 'the raw template stays available');
  assert.equal(rows.find(r => r.key === 'oncall_channel').hint, '#orders-api-oncall');
  assert.equal(rows.find(r => r.key === 'oncall_channel').effective, '#orders-api-oncall', 'what the pack carries at the default');
  assert.equal(rows.find(r => r.key === 'pager_service').hint, 'pagerduty://orders-api');
  assert.ok(FIXTURE.todos.find(t => t.path === 'alerting.routes[0]').what.includes("'#orders-api-oncall' (param oncall_channel)"), 'the todo names the same value');
  assert.equal(paramRows({ build: draft({ name: '' }), library: LIBRARY }).find(r => r.key === 'oncall_channel').hint, '#svc-oncall', 'readable before a name is typed');
  assert.equal(resolveBuiltins('${service}-${environment}-${tier}', { service: 'a', environment: 'staging', tier: 'tier-1' }), 'a-staging-tier-1');
  assert.equal(resolveBuiltins('${bootstrap}', { service: 'a' }), '${bootstrap}', 'an entry param reference is not a built-in');
  // A single entry is not namespaced.
  const single = paramRows({ build: draft({ entries: ['kafka'] }), library: LIBRARY });
  assert.ok(single.some(r => r.key === 'bootstrap'));
  assert.ok(!single.some(r => r.key === 'kafka.bootstrap'));
});

test('instantiateBody: owners parsed, empty overrides dropped, slis only when explicit', () => {
  assert.deepEqual(effectiveParams(draft({ params: { a: '1', b: '', c: null } })), { a: '1' });
  const body = instantiateBody(draft({ params: { 'kafka.bootstrap': 'kafka-0:9092', x: '' } }));
  assert.deepEqual(body, {
    entries: ['kafka', 'http-service'], name: 'orders-api', tier: 'tier-2', environment: 'prod', owners: ['team-orders'],
    params: { 'kafka.bootstrap': 'kafka-0:9092' },
    toggles: { slos: true, policy: true, routes: true, dashboards: true, validation: true },
  });
  const explicit = instantiateBody(draft({ slis: ['kafka_broker_availability'], toggles: { ...defaultBuildState().toggles, dashboards: false } }));
  assert.deepEqual(explicit.toggles.slis, ['kafka_broker_availability']);
  assert.equal(explicit.toggles.dashboards, false);
});

// ---------------------------------------------------------------------------
// DEFINE
// ---------------------------------------------------------------------------

test('buildDefineModel: tiers with their MUST / SHOULD counts and what each adds, products first, validity', () => {
  const m = buildDefineModel({ build: draft(), library: LIBRARY, requirements: REQUIREMENTS });
  assert.equal(m.valid, true);
  assert.deepEqual(m.errors, []);
  assert.equal(m.slug, 'orders-api');
  assert.deepEqual(m.ownerList, ['team-orders']);
  assert.deepEqual(m.tiers.map(t => [t.id, t.must, t.should, t.selected]), [['tier-3', 9, 0, false], ['tier-2', 15, 1, true], ['tier-1', 25, 5, false]]);
  assert.equal(m.tiers[0].adds.length, 9, 'tier-3 requires the baseline every pack meets');
  assert.equal(m.tiers[1].adds.length, 7, 'tier-2 adds 6 MUST + 1 SHOULD');
  assert.equal(m.tiers[2].adds.length, 14, 'tier-1 adds 10 MUST + 4 SHOULD');
  assert.ok(m.tiers[1].adds.some(c => c.id === 'L1.MUST.latency_slo'));
  assert.equal(m.products.length, 8);
  assert.equal(m.archetypes.length, 2);
  assert.deepEqual(m.selectedEntries.map(e => e.id), ['kafka', 'http-service'], 'selection order, not index order');
  const kafka = m.products.find(p => p.id === 'kafka');
  assert.equal(kafka.selected, true);
  assert.equal(kafka.evidence.status, 'recorded-live');
  assert.equal(kafka.sliCountAtTier, 5);
  assert.equal(kafka.placeholderParams, 5);
  assert.equal(m.archetypes.find(p => p.id === 'http-service').evidence.status, 'semconv');
  assert.equal(m.params.length, 26);
  assert.equal(m.params.filter(p => p.placeholder && p.atDefault).length, 21, '21 placeholder params on this selection (some fill several artefacts: 17 land in the pack)');
  // What the step prints: the engine's count once a pack exists (the rail's number), the flagged count only before.
  assert.deepEqual(m.placeholders, { flagged: 21, remaining: 17 }, 'the summary counts the placeholders the engine wrote, not every flagged param of the selection');
  assert.equal(m.placeholders.remaining, placeholdersRemaining(FIXTURE), 'the same number the rail shows');
  assert.deepEqual(buildDefineModel({ build: draft({ result: null }), library: LIBRARY, requirements: REQUIREMENTS }).placeholders, { flagged: 21, remaining: null });
  // Requirements not loaded yet → counts null, adds empty, still valid.
  const cold = buildDefineModel({ build: draft(), library: LIBRARY, requirements: {} });
  assert.equal(cold.tiers[1].must, null);
  assert.equal(cold.tiers[1].loaded, false);
  // Validity errors name what is missing.
  const bad = buildDefineModel({ build: draft({ name: 'x', entries: [] }), library: LIBRARY, requirements: REQUIREMENTS });
  assert.equal(bad.valid, false);
  assert.equal(bad.errors.length, 2);
  assert.match(bad.errors[0], /slugs/);
  assert.match(bad.errors[1], /library entry/);
  assert.deepEqual(buildDefineModel({ build: defaultBuildState(), library: LIBRARY }).errors, ['a service name', 'at least one library entry']);
});

// The renderers have no DOM harness (docs/UI_CONVENTIONS.md §2), but they only need a container
// with innerHTML and the two query methods to run: enough to read what they put on the page.
function stubContainer() {
  const el = { addEventListener() {}, disabled: false };
  return { innerHTML: '', querySelector: () => el, querySelectorAll: () => [] };
}

test('renderBuildDefine escapes the typed service name: the model carries it raw in the validity error, the renderer escapes at the seam', () => {
  const payload = '1<img src=x onerror="window.__xss=1">';
  const m = buildDefineModel({ build: draft({ name: payload }), library: LIBRARY, requirements: REQUIREMENTS });
  assert.equal(m.valid, false);
  assert.ok(m.errors[0].includes(payload), 'the model states the name as typed — data, not markup');
  const container = stubContainer();
  renderBuildDefine(container, m, { build: {} });
  assert.ok(!container.innerHTML.includes('<img'), 'no element from the name reaches the page');
  assert.ok(container.innerHTML.includes('Still needed: a service name that slugs (‘1&lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;’'), 'the status line shows the name escaped');
  assert.ok(container.innerHTML.includes(`value="${'1&lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;'}"`), 'the input value is escaped too');
});

// ---------------------------------------------------------------------------
// COMPILE
// ---------------------------------------------------------------------------

test('buildCompileModel: an SLI above the tier is disabled with the tier it needs; objective and window per tier; composed keys', () => {
  const m = buildCompileModel({ build: draft(), library: LIBRARY });
  assert.equal(m.composed, true);
  assert.deepEqual(m.groups.map(g => g.id), ['kafka', 'http-service']);
  const kafka = m.groups[0];
  assert.deepEqual(kafka.slis.map(s => s.key), ['kafka_broker_availability', 'kafka_consumer_group_lag_seconds', 'kafka_partition_replica_health', 'kafka_produce_latency_p99', 'kafka_fetch_latency_p99', 'kafka_controller_election_rate']);
  const election = kafka.slis.find(s => s.id === 'controller_election_rate');
  assert.equal(election.reachable, false);
  assert.equal(election.checked, false);
  assert.equal(election.minTier, 'tier-1');
  assert.equal(election.objectiveLabel, 'needs tier-1');
  assert.equal(election.objective, null);
  const ba = kafka.slis.find(s => s.id === 'broker_availability');
  assert.equal(ba.checked, true);
  assert.equal(ba.objective, 0.999);
  assert.equal(ba.objectiveLabel, '99.9%');
  assert.equal(ba.window, '30d');
  const lag = kafka.slis.find(s => s.id === 'consumer_group_lag_seconds');
  assert.equal(lag.objectiveLabel, '99%');
  assert.equal(lag.window, '7d');
  assert.deepEqual(m.counts, { total: 10, reachable: 7, checked: 7 });
  assert.equal(m.atLeastOne, true);
  assert.equal(m.result.sliCount, 7);
  assert.equal(m.result.sloCount, 7);
  assert.equal(m.result.todoCount, 21);
  assert.equal(m.result.schemaOk, true);
  assert.equal(m.result.fileName, 'orders-api.pack.yaml');
  assert.deepEqual(m.toggles.map(t => [t.id, t.on, t.disabled]), [['slos', true, false], ['policy', true, false], ['routes', true, false], ['dashboards', true, false], ['validation', true, false]]);

  // Tier changes what an SLI gets — and what it can be.
  const t3 = buildCompileModel({ build: draft({ tier: 'tier-3' }), library: LIBRARY });
  const ba3 = t3.groups[0].slis.find(s => s.id === 'broker_availability');
  assert.equal(ba3.objectiveLabel, '99%', 'tier-3 objective is the library\'s judgement, not the reference pack\'s');
  assert.equal(t3.groups[0].slis.find(s => s.id === 'partition_replica_health').objectiveLabel, 'needs tier-2');
  assert.deepEqual(t3.counts, { total: 10, reachable: 3, checked: 3 });
  const t1 = buildCompileModel({ build: draft({ tier: 'tier-1' }), library: LIBRARY });
  assert.equal(t1.groups[0].slis.find(s => s.id === 'controller_election_rate').reachable, true);
  assert.deepEqual(t1.counts, { total: 10, reachable: 10, checked: 10 });

  // An explicit selection unticks; a stale explicit selection above the tier stays unchecked, never re-enabled.
  const partial = buildCompileModel({ build: draft({ slis: ['kafka_broker_availability', 'kafka_controller_election_rate'] }), library: LIBRARY });
  assert.deepEqual(partial.counts, { total: 10, reachable: 7, checked: 1 });
  assert.equal(partial.groups[0].slis.find(s => s.id === 'controller_election_rate').checked, false, 'above the tier: excluded by the engine, shown disabled here');
  const none = buildCompileModel({ build: draft({ slis: [] }), library: LIBRARY });
  assert.equal(none.atLeastOne, false);
  // Policy greys out when SLOs are off.
  const noSlos = buildCompileModel({ build: draft({ toggles: { ...defaultBuildState().toggles, slos: false } }), library: LIBRARY });
  assert.equal(noSlos.toggles.find(t => t.id === 'policy').disabled, true);
  // A single entry keeps bare ids.
  const single = buildCompileModel({ build: draft({ entries: ['kafka'] }), library: LIBRARY });
  assert.equal(single.composed, false);
  assert.equal(single.groups[0].slis[0].key, 'broker_availability');
});

test('retargetSlis: an explicit SLI list follows the tier — above-tier keys dropped, newly reachable keys ticked, the defaults collapse to null', () => {
  const all1 = reachableSliKeys(draft({ tier: 'tier-1' }), LIBRARY);
  const all2 = reachableSliKeys(draft({ tier: 'tier-2' }), LIBRARY);
  assert.equal(all1.length, 10);
  assert.equal(all2.length, 7);
  assert.ok(all1.includes('kafka_controller_election_rate') && !all2.includes('kafka_controller_election_rate'));
  assert.deepEqual(reachableSliKeys(draft({ tier: 'tier-3', entries: ['kafka'] }), LIBRARY), ['broker_availability', 'consumer_group_lag_seconds'], 'a single entry keeps bare ids');
  // tier-1, partition_replica_health unticked: an explicit list of 9 that includes controller_election_rate (needs tier-1)
  const untick = all1.filter(k => k !== 'kafka_partition_replica_health');
  // lowering to tier-2 drops controller_election_rate — the excluded key no longer sits in the draft, so the
  // "SLI above the tier" warning cannot come back on every regeneration — and keeps the untick
  const lowered = retargetSlis(draft({ tier: 'tier-2', slis: untick }), LIBRARY, 'tier-1');
  assert.deepEqual([...lowered].sort(), all2.filter(k => k !== 'kafka_partition_replica_health').sort());
  assert.ok(!lowered.includes('kafka_controller_election_rate'));
  assert.deepEqual(instantiateBody(draft({ tier: 'tier-2', slis: lowered })).toggles.slis, lowered, 'the body sent carries no key the tier excludes');
  // raising back to tier-1: what the tier unlocks comes in ticked, the untick still stands
  const raised = retargetSlis(draft({ tier: 'tier-1', slis: lowered }), LIBRARY, 'tier-2');
  assert.deepEqual([...raised].sort(), [...untick].sort());
  // a list equal to the tier's defaults collapses to null (the engine's defaultToggles)
  assert.equal(retargetSlis(draft({ tier: 'tier-1', slis: [...lowered, 'kafka_partition_replica_health'] }), LIBRARY, 'tier-2'), null);
  assert.equal(retargetSlis(draft({ slis: null }), LIBRARY, 'tier-1'), null, 'the defaults stay the defaults');
  // no previous tier (a draft restored from an older session): stale keys are pruned, nothing is added
  assert.deepEqual(retargetSlis(draft({ tier: 'tier-2', slis: ['kafka_broker_availability', 'kafka_controller_election_rate'] }), LIBRARY), ['kafka_broker_availability']);
});

test('a usage error keeps the previous pack: the error is split per param, the row carries it, the views read stale, the hand-off is blocked', () => {
  const quote = 'param kafka.bootstrap: a value may not contain a double quote, a backslash or a control character (it is spliced verbatim into PromQL label matchers, scrape targets and endpoints)';
  const unknown = 'unknown param nope (known: bootstrap, broker_job)';
  assert.deepEqual(splitBuildErrors([quote, unknown]), {
    byParam: { 'kafka.bootstrap': 'a value may not contain a double quote, a backslash or a control character (it is spliced verbatim into PromQL label matchers, scrape targets and endpoints)' },
    general: [unknown], paramCount: 1, count: 2,
  });
  assert.deepEqual(splitBuildErrors(null), { byParam: {}, general: [], paramCount: 0, count: 0 });
  assert.deepEqual(splitBuildErrors(['param x: expected a string, number or boolean, got object']).byParam, { x: 'expected a string, number or boolean, got object' });
  // The draft after the live case: a rejected value persisted in params, the previous result kept, the error set.
  const bad = draft({ params: { 'kafka.bootstrap': 'kafka-0.orders.svc:9092"}' }, error: [quote] });
  assert.equal(isStale(bad), true);
  assert.equal(isStale(draft()), false);
  assert.equal(isStale(draft({ error: [quote], result: null })), false, 'no pack to be stale');
  const rows = paramRows({ build: bad, library: LIBRARY });
  assert.equal(rows.find(r => r.key === 'kafka.bootstrap').error, splitBuildErrors([quote]).byParam['kafka.bootstrap']);
  assert.equal(rows.filter(r => r.error).length, 1, 'only the row the error names');
  // DEFINE shows the error and stays complete.
  const sel = buildDefineModel({ build: bad, library: LIBRARY, requirements: REQUIREMENTS });
  assert.equal(sel.valid, true);
  assert.equal(sel.error.paramCount, 1);
  assert.equal(sel.stale, true);
  assert.ok(sel.params.find(p => p.key === 'kafka.bootstrap').error);
  // COMPILE keeps the previous counts, marked stale.
  const gen = buildCompileModel({ build: bad, library: LIBRARY });
  assert.equal(gen.result.sliCount, 7);
  assert.equal(gen.stale, true);
  assert.equal(gen.error.paramCount, 1);
  // The rail says so.
  const rail = buildRailModel({ build: bad, clauses: REQUIREMENTS['tier-2'] });
  assert.equal(rail.stale, true);
  assert.equal(rail.ready, true);
  assert.deepEqual(rail.error, [quote]);
  // VERIFY keeps the verdict, marks the todo's param row, and does not hand the stale pack off.
  const val = buildVerifyModel({ build: bad, library: LIBRARY, clauses: REQUIREMENTS['tier-2'], targets: TARGETS });
  assert.equal(val.ready, true);
  assert.equal(val.verdict.conformant, true);
  assert.equal(val.stale, true);
  assert.equal(val.canRegister, false);
  assert.equal(val.handoff, 'error');
  const canary = val.todoGroups.find(g => g.id === 'validation').todos.find(t => t.path === 'validation.synthetic_checks.kafka-produce-consume-canary');
  assert.ok(canary.params[0].error, 'the todo that this param fills shows the rejection on its row');
  // The footer's other states, in priority order.
  assert.equal(buildVerifyModel({ build: draft(), library: LIBRARY, clauses: REQUIREMENTS['tier-2'], targets: TARGETS }).handoff, 'ready');
  assert.equal(buildVerifyModel({ build: draft({ registeredId: 'uploaded-x' }), library: LIBRARY, clauses: REQUIREMENTS['tier-2'], targets: TARGETS }).handoff, 'registered');
  assert.equal(buildVerifyModel({ build: draft({ result: { ...draft().result, warnings: [{ kind: 'promql', message: 'x' }] } }), library: LIBRARY, clauses: REQUIREMENTS['tier-2'], targets: TARGETS }).handoff, 'promql');
  assert.equal(buildVerifyModel({ build: draft({ result: { ...draft().result, schemaErrors: ['$.spec: missing required key'] } }), library: LIBRARY, clauses: REQUIREMENTS['tier-2'], targets: TARGETS }).handoff, 'schema');
});

test('summarizeWarnings groups by kind, blocking first', () => {
  const g = summarizeWarnings([
    { kind: 'burn-rules', message: 'b1' }, { kind: 'sli-excluded', sli: 'x', message: 'x needs tier-1' },
    { kind: 'promql', message: 'p1' }, { kind: 'burn-rules', message: 'b2' },
  ]);
  assert.deepEqual(g.map(x => [x.kind, x.items.length, x.blocking]), [['promql', 1, true], ['burn-rules', 2, false], ['sli-excluded', 1, false]]);
  assert.equal(g[0].label, 'PromQL');
  assert.deepEqual(summarizeWarnings([]), []);
});

// ---------------------------------------------------------------------------
// The clause rail: three states
// ---------------------------------------------------------------------------

test('buildClauseChecklist: pass, pass on a placeholder, fail — and pending without a summary', () => {
  const clauses = REQUIREMENTS['tier-2'];
  const c = buildClauseChecklist(clauses, FIXTURE.summary);
  assert.equal(c.items.length, 16);
  assert.deepEqual([c.counts.pass, c.counts.placeholder, c.counts.fail, c.counts.pending], [12, 4, 0, 0]);
  assert.deepEqual(c.counts.must, { total: 15, pass: 15, fail: 0 });
  assert.deepEqual(c.counts.should, { total: 1, pass: 1, fail: 0 });
  assert.equal(c.conformant, true);
  const onPh = c.items.filter(i => i.state === 'placeholder').map(i => i.id).sort();
  assert.deepEqual(onPh, ['L2.MUST.metrics_exporter', 'L2.MUST.metrics_logs_traces_backends', 'L5.MUST.synthetic_probe', 'L5.MUST.tier2_chaos_staging']);
  assert.deepEqual(c.items.find(i => i.id === 'L2.MUST.metrics_exporter').todos, ['pipelines.exporters.metrics']);
  assert.deepEqual(c.groups.map(g => g.dimension), ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5']);

  const pending = buildClauseChecklist(clauses, null);
  assert.equal(pending.counts.pending, 16);
  assert.equal(pending.conformant, null);
  assert.ok(pending.items.every(i => i.state === 'pending'));

  // Dashboards off (the drive's toggle): the two L3 dashboard clauses fail, nothing else moves.
  const failingSummary = {
    ...FIXTURE.summary, conformant: false, must: { passed: 13, total: 15 },
    passing: FIXTURE.summary.passing.filter(id => !/dashboard/.test(id)),
    failing: [
      { id: 'L3.MUST.service_overview_dashboard', severity: 'MUST', description: 'At least one dashboard declared (service overview).', todos: [] },
      { id: 'L3.MUST.slo_burn_dashboard', severity: 'MUST', description: 'A second dashboard (SLO burn) on top of service overview.', todos: [] },
    ],
  };
  const f = buildClauseChecklist(clauses, failingSummary);
  assert.deepEqual([f.counts.pass, f.counts.placeholder, f.counts.fail], [10, 4, 2]);
  assert.deepEqual(f.items.filter(i => i.state === 'fail').map(i => i.id), ['L3.MUST.service_overview_dashboard', 'L3.MUST.slo_burn_dashboard']);
  assert.equal(f.conformant, false);
  assert.equal(f.counts.must.fail, 2);
});

test('buildRailModel carries the counts the rail prints', () => {
  const r = buildRailModel({ build: draft(), clauses: REQUIREMENTS['tier-2'] });
  assert.equal(r.tier, 'tier-2');
  assert.equal(r.todoCount, 21);
  assert.equal(r.warningCount, 0);
  assert.equal(r.blockingWarnings, 0);
  assert.equal(r.placeholdersRemaining, 17);
  assert.equal(r.ready, true);
  assert.equal(r.valid, true);
  assert.equal(r.checklist.counts.placeholder, 4);
  const cold = buildRailModel({ build: defaultBuildState(), clauses: REQUIREMENTS['tier-2'] });
  assert.equal(cold.ready, false);
  assert.equal(cold.valid, false);
  assert.equal(cold.checklist.counts.pending, 16);
  assert.equal(placeholdersRemaining(null), 0);
});

// ---------------------------------------------------------------------------
// VERIFY
// ---------------------------------------------------------------------------

test('groupTodos: by artefact family, each todo with the param rows that fill it, manual ones flagged', () => {
  const params = paramRows({ build: draft(), library: LIBRARY });
  const groups = groupTodos(FIXTURE.todos, params);
  assert.deepEqual(groups.map(g => [g.id, g.todos.length]), [['alerting', 3], ['telemetry', 3], ['pipelines', 4], ['storage', 3], ['validation', 5], ['remediation', 2], ['baselines', 1]]);
  assert.equal(groups.reduce((n, g) => n + g.todos.length, 0), 21);
  const route0 = groups[0].todos.find(t => t.path === 'alerting.routes[0]');
  assert.deepEqual(route0.params.map(p => p.key), ['oncall_channel', 'pager_service']);
  assert.equal(route0.params[0].label, 'Chat channel for SEV1/SEV2');
  assert.equal(route0.manual, false);
  const canary = groups.find(g => g.id === 'validation').todos.find(t => t.path === 'validation.synthetic_checks.kafka-produce-consume-canary');
  assert.deepEqual(canary.params.map(p => p.key), ['kafka.bootstrap']);
  assert.deepEqual(canary.clauses, ['L5.MUST.synthetic_probe']);
  const runbook = groups.find(g => g.id === 'remediation').todos[0];
  assert.equal(runbook.manual, true, 'a runbook to write: no param fills it');
  assert.equal(groups.find(g => g.id === 'baselines').todos[0].manual, true);
  assert.deepEqual(groupTodos([], params), []);
});

test('buildVerifyModel: the verdict with the three states, schema, warnings, todos, artefacts, the hand-off facts', () => {
  const m = buildVerifyModel({ build: draft(), library: LIBRARY, clauses: REQUIREMENTS['tier-2'], targets: TARGETS });
  assert.equal(m.ready, true);
  assert.equal(m.tier, 'tier-2');
  assert.equal(m.verdict.conformant, true);
  assert.deepEqual(m.verdict.must, { passed: 15, total: 15 });
  assert.deepEqual([m.verdict.pass, m.verdict.placeholder, m.verdict.fail], [12, 4, 0]);
  assert.equal(m.verdict.onPlaceholder.length, 4);
  assert.equal(m.schema.ok, true);
  assert.deepEqual(m.warnings, []);
  assert.equal(m.blocking, false);
  assert.equal(m.todoCount, 21);
  assert.equal(m.placeholdersRemaining, 17);
  assert.deepEqual(m.artifacts.map(a => a.id), ['prometheus-rules', 'otel-collector', 'alertmanager', 'grafana-dashboard']);
  assert.equal(m.artifacts[0].label, 'Prometheus rules');
  assert.equal(m.fileName, 'orders-api.pack.yaml');
  assert.equal(m.packName, 'orders-api');
  assert.equal(m.source, 'kafka@1.0.0,http-service@1.0.0');
  assert.equal(m.canRegister, true);
  assert.equal(m.registeredId, null);
  // "Ready to continue?": the exit's label and text follow the placeholders that remain.
  assert.equal(m.gaps, 17);
  assert.equal(m.continueLabel, 'Continue with visible gaps');
  assert.match(m.readyText, /^Ready to continue\? 17 placeholders remain/);
  const filled = buildVerifyModel({ build: draft({ result: { ...draft().result, provenance: { ...draft().result.provenance, placeholders: [] } } }), library: LIBRARY, clauses: REQUIREMENTS['tier-2'], targets: TARGETS });
  assert.equal(filled.gaps, 0);
  assert.equal(filled.continueLabel, 'Continue to Discover');
  assert.match(filled.readyText, /No placeholder remains/);
  // A blocking warning or a schema error blocks the hand-off; nothing else does.
  const blocked = buildVerifyModel({ build: draft({ result: { ...draft().result, warnings: [{ kind: 'promql', message: 'x' }] } }), library: LIBRARY, clauses: REQUIREMENTS['tier-2'], targets: TARGETS });
  assert.equal(blocked.blocking, true);
  assert.equal(blocked.canRegister, false);
  const invalid = buildVerifyModel({ build: draft({ result: { ...draft().result, schemaErrors: ['$.spec: missing required key \'dashboards\''] } }), library: LIBRARY, clauses: REQUIREMENTS['tier-2'], targets: TARGETS });
  assert.equal(invalid.schema.ok, false);
  assert.equal(invalid.canRegister, false);
  const cold = buildVerifyModel({ build: defaultBuildState(), library: LIBRARY, clauses: REQUIREMENTS['tier-2'], targets: TARGETS });
  assert.equal(cold.ready, false);
  assert.equal(cold.verdict, null);
  assert.deepEqual(cold.todoGroups, []);
});

// ---------------------------------------------------------------------------
// The persisted shape and the loaders
// ---------------------------------------------------------------------------

test('the persisted build draft is inputs only — never the result, the preview or the error', () => {
  const b = defaultBuildState();
  for (const k of BUILD_PERSIST_FIELDS) assert.ok(k in b, k);
  for (const k of ['result', 'preview', 'error', 'pending']) assert.ok(!BUILD_PERSIST_FIELDS.includes(k), `${k} must not persist`);
  assert.equal(b.step, 'define');
  assert.equal(b.tier, 'tier-2');
  assert.equal(b.slis, null, 'null means the tier\'s defaults');
});

test('build-api loaders: the paths and bodies the six routes take, with an injected fetcher', async () => {
  const calls = [];
  const fetchFn = async (path, opts = {}) => {
    calls.push({ path, method: opts.method || 'GET', body: opts.body });
    if (path === '/api/library') return INDEX;
    if (path.startsWith('/api/library/requirements/')) return read(`requirements.${decodeURIComponent(path.split('/').pop())}.json`);
    if (path === '/api/compile/targets') return { targets: TARGETS };
    if (path === '/api/library/instantiate') return FIXTURE;
    if (path === '/api/library/compile') return { ok: true, target: opts.body.target, label: 'Prometheus rules', contentType: 'application/x-yaml', artifact: { filename: 'x.yaml', content: 'groups: []', warnings: [], profile: null } };
    if (path === '/api/library/register') return { ok: true, registered: { id: 'uploaded-orders-api-00000000', source: opts.body.source || 'library:kafka,http-service@tier-2' }, adapted: {}, conformance: {}, summary: FIXTURE.summary };
    throw new Error(`unexpected ${path}`);
  };
  const lib = await loadLibraryApi({ fetchFn, force: true });
  assert.equal(lib.entries.length, 10);
  assert.equal(lib.scaffoldParams.length, 16);
  const clauses = await loadRequirements('tier-2', { fetchFn });
  assert.equal(clauses.length, 16);
  await loadRequirements('tier-2', { fetchFn });
  assert.equal(calls.filter(c => c.path.includes('requirements')).length, 1, 'cached per tier');
  // Concurrent callers of an uncached tier (the shell, the rail and a repaint on one page load) share the request in flight.
  const [t1a, t1b] = await Promise.all([loadRequirements('tier-1', { fetchFn }), loadRequirements('tier-1', { fetchFn })]);
  assert.equal(t1a, t1b);
  assert.equal(calls.filter(c => c.path.endsWith('/tier-1')).length, 1, 'one request for two concurrent loads of the same tier');
  assert.equal((await loadTargets({ fetchFn })).length, 4);
  const res = await instantiate(draft(), { fetchFn });
  assert.equal(res.ok, true);
  const post = calls.find(c => c.path === '/api/library/instantiate');
  assert.equal(post.method, 'POST');
  assert.deepEqual(post.body, instantiateBody(draft()));
  const c = await compilePreview(FIXTURE.canonical, 'prometheus-rules', { fetchFn });
  assert.equal(c.ok, true);
  assert.deepEqual(Object.keys(calls.find(x => x.path === '/api/library/compile').body), ['canonical', 'target']);
  const r = await registerBuiltPack(FIXTURE.canonical, { fetchFn });
  assert.equal(r.registered.source, 'library:kafka,http-service@tier-2');
  assert.deepEqual(Object.keys(calls.find(x => x.path === '/api/library/register').body), ['canonical']);
});
