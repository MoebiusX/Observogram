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
import { adapt, applyEnvironmentOverlay } from './lib/adapter.mjs';
import { listTargets } from './lib/compile.mjs';
import { instantiatePack, libraryIndex, tierRequirements, validationSummary, SCAFFOLD_PARAMS, TIERS as ENGINE_TIERS } from './lib/library.mjs';
import { loadLibrary, findEntry } from '../server/library.mjs';
import { parsePromqlDependencies as lezer } from './lib/promql-lezer.mjs';
import {
  BUILD_STEPS, TIERS, SECTION_TOGGLES, MAX_SERVICE_SLUG, LONGEST_DERIVED_SUFFIX, serviceSlug, isValidServiceName, parseOwners, sliKey, paramKey,
  defineValid, buildStepReachability, clampStep, paramRows, effectiveParams, instantiateBody,
  buildDefineModel, buildCompileModel, summarizeWarnings, buildClauseChecklist, buildRailModel,
  placeholdersRemaining, groupTodos, buildVerifyModel, reachableSliKeys, retargetSlis, splitBuildErrors, isStale, resolveBuiltins,
  buildStackModel, sliCandidates, artefactSymbol, todoLayer, clauseGhostLabel, clauseSubgroup, slabState, isDetailArtefact, CLAUSE_GHOSTS,
  todoFocusSuffix, focusFallbackSelectors, enterStep, stepAfterInstantiate,
} from '../studio/build-model.mjs';
import {
  loadLibrary as loadLibraryApi, loadRequirements, loadTargets, instantiate, compilePreview, registerBuiltPack,
} from '../studio/build-api.mjs';
import { defaultBuildState, BUILD_PERSIST_FIELDS } from '../studio/state.mjs';
import { LAYER_DEFS, L4_SUBGROUPS } from '../studio/constants.mjs';
import { renderBuildDefine, renderClauseRail } from '../studio/build-define-view.mjs';
import { renderBuildCompile } from '../studio/build-compile-view.mjs';
import { renderBuildVerify } from '../studio/build-verify-view.mjs';
import { renderBuildStack, buildStackHtml, wireBuildStack } from '../studio/build-stack-view.mjs';
import { artefactCardHtml } from '../studio/card-html.mjs';
import { revealTodo, clauseRowHtml } from '../studio/build-atoms.mjs';

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
  // The adapter's projection of the env-overlaid canonical, as /api/validate returns it (the
  // route serialises it, so the fixture and the comparison below are its JSON shape).
  const adapted = JSON.parse(JSON.stringify(adapt(canonical, { environment: provenance.environment })));
  const canonicalYaml = `# ObservabilityPack ${canonical.metadata.name} — built from the library (${provenance.source}) at ${provenance.tier}\n# Todos: ${todos.length} (metadata.annotations library.todo.*). Spec v${SPEC_VERSION}.\n` + emitYaml(canonical);
  return { ok: true, canonical, canonicalYaml, todos, provenance, warnings, schemaErrors, summary, conformance, adapted };
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
  result: { canonical: FIXTURE.canonical, canonicalYaml: FIXTURE.canonicalYaml, todos: FIXTURE.todos, warnings: FIXTURE.warnings, summary: FIXTURE.summary, conformance: FIXTURE.conformance, schemaErrors: FIXTURE.schemaErrors, provenance: FIXTURE.provenance, adapted: FIXTURE.adapted },
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
  // `adapted` is the adapter's own projection — what Discover draws for the same canonical.
  assert.deepEqual(fresh.adapted, FIXTURE.adapted, 'adapted drifted — the adapter changed, or the canonical did');
  assert.deepEqual(FIXTURE.adapted, JSON.parse(JSON.stringify(adapt(FIXTURE.canonical, { environment: 'prod' }))));
  assert.equal(FIXTURE.adapted.meta.environment, 'prod');
  assert.equal(FIXTURE.adapted.meta.criticality, 'tier-2');
  assert.equal(FIXTURE.adapted.layers.L1.length, 14, '7 SLIs + 7 SLOs');
  assert.deepEqual(FIXTURE.adapted.layers.L2X, []);
  assert.equal(FIXTURE.adapted.layers.L4.alerting.length, 3);
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

test('a reload on VERIFY resumes on VERIFY: the demoted step is kept as wantedStep and honoured once the pack is back', () => {
  // The reload: the persisted step is 'verify', the result is not persisted, so the clamp lands on 'compile'.
  const restored = { ...draft({ result: null }), step: 'verify' };
  const entered = { ...restored, ...enterStep(restored, restored.step) };
  assert.equal(entered.step, 'compile');
  assert.equal(entered.wantedStep, 'verify', 'the step asked for is remembered');
  // The re-instantiation answers with a pack: the wanted step is honoured, once.
  const answered = { ...entered, result: draft().result };
  const settled = { ...answered, ...stepAfterInstantiate(answered) };
  assert.equal(settled.step, 'verify');
  assert.equal(settled.wantedStep, null, 'spent');
  // A later instantiation (an edit on VERIFY) keeps the step as before: no want pending, the step clamped.
  assert.deepEqual(stepAfterInstantiate(settled), { step: 'verify', wantedStep: null });
  // The answer is a usage error and no pack exists: the want is spent, the step stays where it is reachable.
  assert.deepEqual(stepAfterInstantiate({ ...entered, error: ['instantiatePack: at least one SLI must stay selected'] }), { step: 'compile', wantedStep: null });
  // A legacy id is wanted under its current name; a step that is reachable at once wants nothing; nonsense wants nothing.
  assert.deepEqual(enterStep(restored, 'validate'), { step: 'compile', wantedStep: 'verify' });
  assert.deepEqual(enterStep(draft(), 'verify'), { step: 'verify', wantedStep: null });
  assert.deepEqual(enterStep(defaultBuildState(), 'nonsense'), { step: 'define', wantedStep: null });
  assert.deepEqual(enterStep({ ...draft({ result: null }), step: 'compile' }, undefined), { step: 'compile', wantedStep: null }, 'no step asked: the draft\'s own, clamped, nothing wanted');
  assert.deepEqual(enterStep({ ...draft({ result: null }), step: 'verify' }, undefined), { step: 'compile', wantedStep: 'verify' }, 'no step asked, the draft\'s own unreachable: wanted');
  // wantedStep is UI state on the draft, never persisted (the persisted step is the wanted one).
  assert.equal(defaultBuildState().wantedStep, null);
  assert.ok(!BUILD_PERSIST_FIELDS.includes('wantedStep'));
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
  const el = { addEventListener() {}, disabled: false, querySelector: () => el, querySelectorAll: () => [] };
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

test('the stale note on each step says where the rejected value is marked, in one sentence', () => {
  const stale = draft({ error: ['param kafka.bootstrap: a value may not contain a double quote'] });
  const render = (fn, model) => { const c = stubContainer(); fn(c, model, { build: {} }); return c.innerHTML; };
  const lead = 'The last compilation failed — the pack shown is the previous one.</strong> 1 parameter value rejected — marked on its row ';
  const define = render(renderBuildDefine, buildDefineModel({ build: stale, library: LIBRARY, requirements: REQUIREMENTS }));
  assert.ok(define.includes(`${lead}below</div>`), 'DEFINE: the rows are on this step');
  const compile = render(renderBuildCompile, buildCompileModel({ build: stale, library: LIBRARY, clauses: T2 }));
  assert.ok(compile.includes(`${lead}on Define and Verify (this step has no parameter inputs)</div>`), 'COMPILE: the rows are on the other two steps');
  const verify = render(renderBuildVerify, buildVerifyModel({ build: stale, library: LIBRARY, clauses: T2, targets: TARGETS }));
  assert.ok(verify.includes(`${lead}below, under its todo</div>`), 'VERIFY: the row is under the todo');
  // Two rejected values pluralise the whole phrase.
  const two = draft({ error: ['param kafka.bootstrap: a value may not contain a double quote', 'param remote_write_url: a value may not contain a backslash'] });
  assert.ok(render(renderBuildCompile, buildCompileModel({ build: two, library: LIBRARY, clauses: T2 })).includes('2 parameter values rejected — marked on their rows on Define and Verify'));
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

// ---------------------------------------------------------------------------
// The layer stack (docs/BUILD_JOURNEY.md "The scan")
// ---------------------------------------------------------------------------

const T2 = REQUIREMENTS['tier-2'];
// The stack of the drive's pack, as VERIFY builds it unless told otherwise.
const stackOf = (over = {}, b = draft()) => buildStackModel({
  adapted: b.result?.adapted || null, requirements: T2, checklist: buildClauseChecklist(T2, b.result?.summary || null),
  todos: b.result?.todos || [], params: paramRows({ build: b, library: LIBRARY }), mode: 'verify', toggles: b.toggles, ...over,
});
// The drive's dashboards-off summary (the two L3 dashboard clauses fail, nothing else moves).
const DASHBOARDS_OFF_SUMMARY = {
  ...FIXTURE.summary, conformant: false, must: { passed: 13, total: 15 },
  passing: FIXTURE.summary.passing.filter(id => !/dashboard/.test(id)),
  failing: [
    { id: 'L3.MUST.service_overview_dashboard', severity: 'MUST', description: 'At least one dashboard declared (service overview).', todos: [] },
    { id: 'L3.MUST.slo_burn_dashboard', severity: 'MUST', description: 'A second dashboard (SLO burn) on top of service overview.', todos: [] },
  ],
};
const flatL4 = (l4) => L4_SUBGROUPS.flatMap(sg => l4?.[sg.key] || []);
const idsOf = (list) => list.map(a => [a.id, a.title, a.source]);

test('buildStackModel: the slabs are LAYER_DEFS in order, L2X only with an artefact or a clause, GOV neutral', () => {
  const s = stackOf();
  assert.deepEqual(s.slabs.map(x => x.id), LAYER_DEFS.map(d => d.id), 'tier-2 has an L2X clause, so every layer is a slab');
  assert.deepEqual(s.slabs.map(x => [x.num, x.name]), LAYER_DEFS.map(d => [d.num, d.name]), 'the names are the canonical layer names');
  assert.ok(s.slabs.every(x => /^#[0-9a-f]{6}$/i.test(x.accent)), 'the accents are the Discover slab accents');
  assert.equal(s.compiled, true);
  assert.equal(s.counts.slabs, 7);
  // No L2X clause and no L2X artefact: no L2X slab.
  const noX = stackOf({ requirements: T2.filter(c => c.dimension !== 'L2X'), checklist: buildClauseChecklist(T2.filter(c => c.dimension !== 'L2X'), FIXTURE.summary) });
  assert.deepEqual(noX.slabs.map(x => x.id), ['L1', 'L2', 'L3', 'L4', 'L5', 'GOV']);
  // An L2X artefact brings the slab back even without a clause.
  const withX = stackOf({
    requirements: T2.filter(c => c.dimension !== 'L2X'), checklist: buildClauseChecklist(T2.filter(c => c.dimension !== 'L2X'), FIXTURE.summary),
    adapted: { ...FIXTURE.adapted, layers: { ...FIXTURE.adapted.layers, L2X: [{ id: 'PROF-01', title: 'profiling: pyroscope', desc: '', tool: 'pyroscope', tags: ['profiling'], source: 'Declared' }] } },
  });
  assert.ok(withX.slabs.some(x => x.id === 'L2X' && x.state === 'neutral' && x.artefacts.length === 1));
  // GOV: no clause applies — neutral, no maturity, the imports as its artefacts.
  const gov = s.slabs.find(x => x.id === 'GOV');
  assert.equal(gov.state, 'neutral');
  assert.equal(gov.stateText, 'no clause applies');
  assert.deepEqual(gov.clauses, []);
  assert.equal(gov.maturity.total, 0);
  assert.equal(gov.maturity.pct, null);
  assert.deepEqual(gov.artefacts.map(a => a.id), ['IMP-01']);
  assert.deepEqual(gov.ghosts, []);
  // slabState on its own: fail > pending > placeholder > pass; neutral when empty.
  assert.equal(slabState([]), 'neutral');
  assert.equal(slabState([{ state: 'pass' }, { state: 'placeholder' }, { state: 'fail' }, { state: 'pending' }]), 'fail');
  assert.equal(slabState([{ state: 'pass' }, { state: 'pending' }, { state: 'placeholder' }]), 'pending');
  assert.equal(slabState([{ state: 'pass' }, { state: 'placeholder' }]), 'placeholder');
  assert.equal(slabState([{ state: 'pass' }]), 'pass');
});

test('buildStackModel: the edge states are the checklist\'s per dimension, and a red or amber edge says which clause and why', () => {
  const s = stackOf();
  assert.deepEqual(Object.fromEntries(s.slabs.map(x => [x.id, x.state])), { L1: 'pass', L2: 'placeholder', L2X: 'pass', L3: 'pass', L4: 'pass', L5: 'placeholder', GOV: 'neutral' });
  const l2 = s.slabs.find(x => x.id === 'L2');
  assert.equal(l2.stateText, '5 of 5 pass · 2 on a placeholder');
  assert.deepEqual(l2.why, [
    'L2.MUST.metrics_exporter — passes on 1 placeholder: pipelines.exporters.metrics',
    'L2.MUST.metrics_logs_traces_backends — passes on 3 placeholders: telemetry.backends.logs-loki, telemetry.backends.metrics-prom, telemetry.backends.traces-tempo',
  ]);
  assert.equal(s.slabs.find(x => x.id === 'L1').stateText, '3 of 3 clauses pass');
  assert.equal(s.slabs.find(x => x.id === 'L2X').stateText, '1 of 1 clause pass');
  assert.deepEqual(s.slabs.find(x => x.id === 'L1').ghosts, [], 'every L1 clause passes: no ghost on a compiled pack');
  assert.deepEqual(s.counts.clauses, { total: 16, pass: 12, placeholder: 4, fail: 0, pending: 0 });
  // Dashboards off: L3 goes red, names both clauses, and the two unmet clauses come back as Missing ghosts.
  const off = stackOf({ checklist: buildClauseChecklist(T2, DASHBOARDS_OFF_SUMMARY), toggles: { ...defaultBuildState().toggles, dashboards: false } });
  const l3 = off.slabs.find(x => x.id === 'L3');
  assert.equal(l3.state, 'fail');
  assert.equal(l3.stateText, '2 of 4 clauses fail');
  assert.deepEqual(l3.why, [
    'L3.MUST.service_overview_dashboard — At least one dashboard declared (service overview).',
    'L3.MUST.slo_burn_dashboard — A second dashboard (SLO burn) on top of service overview.',
  ]);
  assert.deepEqual(l3.ghosts.map(g => [g.kind, g.clauseId, g.title, g.source, g.state]), [
    ['clause', 'L3.MUST.service_overview_dashboard', 'service overview board', 'Missing', 'fail'],
    ['clause', 'L3.MUST.slo_burn_dashboard', 'SLO burn board', 'Missing', 'fail'],
  ]);
  assert.equal(l3.dimmed, true);
  assert.deepEqual(l3.offSections, ['dashboards']);
  assert.ok(off.slabs.filter(x => x.id !== 'L3').every(x => !x.dimmed && x.ghosts.length === 0), 'nothing else moves');
  // Before the first result: every clause pending, every slab grey, every clause a Required ghost.
  const cold = stackOf({ adapted: null, checklist: buildClauseChecklist(T2, null), todos: [] });
  assert.equal(cold.compiled, false);
  assert.ok(cold.slabs.filter(x => x.id !== 'GOV').every(x => x.state === 'pending'));
  assert.equal(cold.slabs.find(x => x.id === 'L2').stateText, '5 clauses to evaluate');
  assert.equal(cold.counts.ghosts, 16);
  assert.ok(cold.slabs.flatMap(x => x.ghosts).every(g => g.source === 'Required' && g.state === 'pending'));
  assert.equal(cold.counts.artefacts, 0);
});

test('the silhouette (DEFINE): one ghost per clause of the tier in its dimension, reshaping with the tier; the entries\' SLIs and SLOs on L1', () => {
  const define = (tier) => buildDefineModel({ build: draft({ tier, result: null }), library: LIBRARY, requirements: REQUIREMENTS }).stack;
  const t2 = define('tier-2');
  assert.equal(t2.mode, 'define');
  assert.equal(t2.counts.artefacts, 0, 'a silhouette has no artefact');
  const clauseGhosts = (s, id) => s.slabs.find(x => x.id === id).ghosts.filter(g => g.kind === 'clause').map(g => g.title);
  assert.deepEqual(clauseGhosts(t2, 'L1'), ['availability SLO', 'latency SLO', 'every SLI under an SLO']);
  assert.deepEqual(clauseGhosts(t2, 'L2'), ['otlp receiver', 'service.name required', 'SemConv ≥ 1.26.0', 'metrics exporter', 'metrics + logs + traces backends']);
  assert.deepEqual(clauseGhosts(t2, 'L2X'), ['extended backend refs resolve']);
  assert.deepEqual(clauseGhosts(t2, 'L3'), ['recording rule per SLO', 'derived view', 'service overview board', 'SLO burn board']);
  assert.deepEqual(clauseGhosts(t2, 'L4'), ['multi-window burn alerts']);
  assert.deepEqual(clauseGhosts(t2, 'L5'), ['synthetic probe', 'chaos in staging']);
  assert.deepEqual(clauseGhosts(t2, 'GOV'), []);
  assert.ok(t2.slabs.flatMap(x => x.ghosts).filter(g => g.kind === 'clause').every(g => g.source === 'Required' && g.desc && g.tool === g.clauseId && g.tags[0] === g.severity));
  // The desc is the rubric's description, verbatim.
  assert.equal(t2.slabs.find(x => x.id === 'L1').ghosts.find(g => g.clauseId === 'L1.MUST.latency_slo').desc, T2.find(c => c.id === 'L1.MUST.latency_slo').description);
  // tier-1 adds its clauses; tier-3 takes them away.
  const t1 = define('tier-1');
  assert.deepEqual(clauseGhosts(t1, 'L2').slice(-8), ['SemConv 1.27.0', '5+ resource attributes', 'log correlation', 'metrics exporter', 'logs + traces exporters', 'tail sampling', 'metrics + logs + traces backends', 'backend gating: enforce']);
  assert.deepEqual(clauseGhosts(t1, 'L4'), ['multi-window burn alerts', 'forecast on availability', 'SEV1 voice route', 'self-healing remediation']);
  assert.deepEqual(clauseGhosts(t1, 'L5'), ['release gate', 'synthetic probe', 'chaos per SLO', 'chaos in staging', 'weekly prod chaos']);
  assert.deepEqual(clauseGhosts(t1, 'L1'), ['availability SLO', 'latency SLO', 'domain SLO', 'every SLI under an SLO']);
  const t3 = define('tier-3');
  assert.deepEqual(clauseGhosts(t3, 'L1'), ['availability SLO', 'every SLI under an SLO']);
  assert.deepEqual(clauseGhosts(t3, 'L4'), [], 'no L4 clause at tier-3: the slab stays, empty');
  assert.deepEqual(t3.slabs.map(x => x.id), LAYER_DEFS.map(d => d.id));
  assert.deepEqual([t3, t2, t1].map(s => s.counts.clauses.total), [9, 16, 30]);
  // The selection's SLIs at the tier land on L1 as SLI + SLO candidate ghosts, read-only.
  const l1 = t2.slabs.find(x => x.id === 'L1');
  const cands = sliCandidates({ build: draft({ tier: 'tier-2' }), library: LIBRARY });
  assert.equal(cands.length, 7);
  assert.deepEqual(l1.ghosts.filter(g => g.kind === 'sli').map(g => g.title), cands.map(c => c.key));
  const ba = l1.ghosts.find(g => g.key === 'slo:kafka_broker_availability');
  assert.equal(ba.title, 'SLO on kafka_broker_availability');
  assert.equal(ba.desc, '99.9% over 30d');
  assert.equal(ba.source, 'Candidate');
  assert.equal(l1.ghosts.find(g => g.key === 'sli:kafka_broker_availability').evidence, 'recorded-live');
  assert.equal(l1.ghosts.find(g => g.key === 'sli:http_service_availability').evidence, 'semconv');
  assert.equal(l1.ghosts.length, 7 * 2 + 3);
  assert.equal(define('tier-3').slabs.find(x => x.id === 'L1').ghosts.filter(g => g.kind === 'sli').length, 3);
  assert.equal(define('tier-1').slabs.find(x => x.id === 'L1').ghosts.filter(g => g.kind === 'sli').length, 10);
  assert.equal(buildDefineModel({ build: draft({ entries: [], result: null }), library: LIBRARY, requirements: REQUIREMENTS }).stack.slabs.find(x => x.id === 'L1').ghosts.filter(g => g.kind !== 'clause').length, 0, 'no entry, no candidate');
  // The silhouette keeps its edges once a pack exists (the draft compiled on DEFINE).
  const lit = buildDefineModel({ build: draft(), library: LIBRARY, requirements: REQUIREMENTS }).stack;
  assert.equal(lit.slabs.find(x => x.id === 'L2').state, 'placeholder');
  assert.equal(lit.counts.artefacts, 0, 'still a silhouette: the artefacts wait for COMPILE');
  assert.equal(lit.slabs.find(x => x.id === 'L2').ghosts.find(g => g.clauseId === 'L2.MUST.metrics_exporter').state, 'placeholder');
  // Every clause the rubric ships has a ghost label; an unknown id is humanised.
  for (const t of TIERS) for (const c of REQUIREMENTS[t]) assert.equal(clauseGhostLabel(c.id), CLAUSE_GHOSTS[c.id].label, c.id);
  assert.equal(clauseGhostLabel('L9.MUST.slo_per_otlp_thing'), 'SLO per OTLP thing');
  assert.equal(clauseSubgroup('L4.MUST.tier1_voice_route'), 'alerting');
  assert.equal(clauseSubgroup('L4.MUST.some_new_runbook_rule'), 'healing');
  assert.equal(clauseSubgroup('L4.MUST.some_new_rule'), 'policy');
});

test('todo pinning: each todo lands on the slab of its path family — and on the Scaffold card the adapter minted for it', () => {
  const s = stackOf();
  assert.deepEqual(Object.fromEntries(s.slabs.map(x => [x.id, x.counts.todos])), { L1: 0, L2: 10, L2X: 0, L3: 0, L4: 5, L5: 6, GOV: 0 });
  assert.equal(s.counts.todos, 21);
  const l4 = s.slabs.find(x => x.id === 'L4');
  assert.deepEqual(l4.subgroups.map(sg => [sg.key, sg.todos.map(t => t.path)]), [
    ['policy', []],
    ['alerting', ['alerting.routes[0]', 'alerting.routes[1]', 'alerting.routes[2]']],
    ['healing', ['remediation[0]', 'remediation[1]']],
  ]);
  assert.deepEqual(s.slabs.find(x => x.id === 'L5').todos.map(t => t.path), ['baselines', 'validation.chaos_experiments.kafka-broker-network-partition', 'validation.chaos_experiments.kafka-broker-pod-kill', 'validation.synthetic_checks.http-service-health-probe', 'validation.synthetic_checks.kafka-consumer-group-health', 'validation.synthetic_checks.kafka-produce-consume-canary']);
  // A pinned todo keeps its param rows (the inline inputs) and its manual flag, as groupTodos gives them.
  const route0 = l4.subgroups[1].todos[0];
  assert.deepEqual(route0.params.map(p => p.key), ['oncall_channel', 'pager_service']);
  assert.equal(route0.params[0].label, 'Chat channel for SEV1/SEV2');
  assert.equal(route0.manual, false);
  assert.equal(l4.subgroups[2].todos[0].manual, true, 'a runbook to write');
  // Every todo finds its card, every Scaffold card has its todo: the engine's symbols and the adapter's ids agree.
  const allTodos = s.slabs.flatMap(x => x.todos);
  assert.equal(allTodos.length, 21);
  assert.ok(allTodos.every(t => t.artefactId), `unpinned: ${allTodos.filter(t => !t.artefactId).map(t => t.path)}`);
  const scaffold = s.slabs.flatMap(x => x.artefacts).filter(a => a.source === 'Scaffold');
  assert.equal(scaffold.length, 21);
  assert.ok(scaffold.every(a => a.todoPath), `scaffold without a todo: ${scaffold.filter(a => !a.todoPath).map(a => a.id)}`);
  assert.deepEqual(new Set(scaffold.map(a => a.todoPath)), new Set(allTodos.map(t => t.path)));
  assert.ok(s.slabs.flatMap(x => x.artefacts).filter(a => a.source !== 'Scaffold').every(a => !a.todoPath), 'a Declared artefact carries no todo');
  assert.equal(allTodos.find(t => t.path === 'alerting.routes[0]').artefactId, 'ALR-01');
  assert.equal(allTodos.find(t => t.path === 'pipelines.receivers[1]').artefactId, 'PIP-RCV-02');
  // The synthetic checks keep the canonical's order (the canary is first), so the id is read from the adapter, not assumed.
  assert.equal(allTodos.find(t => t.path === 'validation.synthetic_checks.kafka-produce-consume-canary').artefactId, FIXTURE.adapted.layers.L5.find(a => a.title === 'kafka-produce-consume-canary').id);
  assert.equal(allTodos.find(t => t.path === 'validation.synthetic_checks.kafka-produce-consume-canary').artefactId, 'SYN-01');
  assert.equal(allTodos.find(t => t.path === 'telemetry.backends.logs-loki').artefactId, 'BAK-02');
  // The family rule on its own, incl. the paths this fixture does not carry.
  assert.deepEqual(todoLayer('metadata.owners'), { layer: 'GOV', subgroup: null });
  assert.deepEqual(todoLayer('policy.forecasts[0]'), { layer: 'L4', subgroup: 'policy' });
  assert.deepEqual(todoLayer('remediation[3]'), { layer: 'L4', subgroup: 'healing' });
  assert.deepEqual(todoLayer('slis.x'), { layer: 'L1', subgroup: null });
  assert.deepEqual(todoLayer('queries.recording_rules[0]'), { layer: 'L3', subgroup: null });
  assert.deepEqual(todoLayer('dashboards.x'), { layer: 'L3', subgroup: null });
  assert.deepEqual(todoLayer('profiling'), { layer: 'L2X', subgroup: null });
  assert.deepEqual(todoLayer('otel'), { layer: 'L2', subgroup: null });
  assert.deepEqual(todoLayer('something.else'), { layer: 'GOV', subgroup: null });
  // The adapter symbol rebuilt from the id scheme, or read from `defines`.
  assert.equal(artefactSymbol({ id: 'PIP-RCV-02' }), 'pipelines.receivers[1]');
  assert.equal(artefactSymbol({ id: 'PIP-PRC-03' }), 'pipelines.processors[2]');
  assert.equal(artefactSymbol({ id: 'PIP-EXP-MET' }), 'pipelines.exporters.metrics');
  assert.equal(artefactSymbol({ id: 'STO-LOG-01' }), 'storage.logs');
  assert.equal(artefactSymbol({ id: 'ALR-01' }), 'alerting.routes[0]');
  assert.equal(artefactSymbol({ id: 'HEAL-02' }), 'remediation[1]');
  assert.equal(artefactSymbol({ id: 'POL-03' }), 'policy.burn_rate_alerts[2]');
  assert.equal(artefactSymbol({ id: 'FCST-01' }), 'policy.forecasts[0]');
  assert.equal(artefactSymbol({ id: 'QRY-01' }), 'queries.recording_rules[0]');
  assert.equal(artefactSymbol({ id: 'BASE-01' }), 'baselines');
  assert.equal(artefactSymbol({ id: 'OTEL-01' }), 'otel');
  assert.equal(artefactSymbol({ id: 'SYN-01', title: 'health-probe' }), 'validation.synthetic_checks.health-probe');
  assert.equal(artefactSymbol({ id: 'CHAOS-02', title: 'pod-kill' }), 'validation.chaos_experiments.pod-kill');
  assert.equal(artefactSymbol({ id: 'BAK-01', defines: 'telemetry.backends.metrics-prom' }), 'telemetry.backends.metrics-prom');
  assert.equal(artefactSymbol({ id: 'PANEL-01', title: 'p', parent: 'dashboards.x' }), 'dashboards.x.panels.p');
  assert.equal(artefactSymbol({ id: 'METRIC-01' }), null);
  assert.equal(artefactSymbol(null), null);
});

test('L4 carries its subgroups; the maturity is the clause counts with pass-on-placeholder its own segment', () => {
  const s = stackOf();
  const l4 = s.slabs.find(x => x.id === 'L4');
  assert.deepEqual(l4.subgroups.map(sg => [sg.key, sg.label, sg.artefacts.length]), [['policy', 'Policy', 7], ['alerting', 'Alerting', 3], ['healing', 'Self-healing', 2]]);
  assert.equal(l4.artefacts.length, 12, 'the slab\'s artefacts are the subgroups\' in order');
  assert.deepEqual(l4.artefacts.map(a => a.id), flatL4(FIXTURE.adapted.layers.L4).map(a => a.id));
  assert.equal(l4.counts.scaffold, 5);
  // tier-1 silhouette: the four L4 clauses fall into their subgroups.
  const t1 = buildDefineModel({ build: draft({ tier: 'tier-1', result: null }), library: LIBRARY, requirements: REQUIREMENTS }).stack.slabs.find(x => x.id === 'L4');
  assert.deepEqual(t1.subgroups.map(sg => [sg.key, sg.ghosts.map(g => g.title)]), [
    ['policy', ['multi-window burn alerts', 'forecast on availability']],
    ['alerting', ['SEV1 voice route']],
    ['healing', ['self-healing remediation']],
  ]);
  // Maturity per slab.
  const m = Object.fromEntries(s.slabs.map(x => [x.id, x.maturity]));
  assert.deepEqual(m.L2, { total: 5, pass: 3, placeholder: 2, fail: 0, pending: 0, pct: 100, passPct: 60, placeholderPct: 40, failPct: 0, pendingPct: 0 });
  assert.deepEqual(m.L5, { total: 2, pass: 0, placeholder: 2, fail: 0, pending: 0, pct: 100, passPct: 0, placeholderPct: 100, failPct: 0, pendingPct: 0 });
  assert.deepEqual(m.L1, { total: 3, pass: 3, placeholder: 0, fail: 0, pending: 0, pct: 100, passPct: 100, placeholderPct: 0, failPct: 0, pendingPct: 0 });
  assert.equal(m.GOV.pct, null);
  const off = stackOf({ checklist: buildClauseChecklist(T2, DASHBOARDS_OFF_SUMMARY) }).slabs.find(x => x.id === 'L3').maturity;
  assert.deepEqual([off.total, off.pass, off.fail, off.pct, off.passPct, off.failPct], [4, 2, 2, 50, 50, 50]);
  // The verify model's bars: one row per slab that has a clause (GOV has none), with the slab's state.
  const v = buildVerifyModel({ build: draft(), library: LIBRARY, clauses: T2, targets: TARGETS });
  assert.deepEqual(v.maturity.map(r => [r.id, r.state, r.pct, r.placeholderPct]), [['L1', 'pass', 100, 0], ['L2', 'placeholder', 100, 40], ['L2X', 'pass', 100, 0], ['L3', 'pass', 100, 0], ['L4', 'pass', 100, 0], ['L5', 'placeholder', 100, 100]]);
  assert.equal(v.stack.mode, 'verify');
  assert.equal(v.stack.counts.todos, 21);
});

test('a section switched off dims the slab it feeds (L4 per subgroup); the open slabs come from `expanded`', () => {
  const on = defaultBuildState().toggles;
  const dim = (toggles) => Object.fromEntries(stackOf({ toggles }).slabs.filter(x => x.dimmed).map(x => [x.id, x.offSections]));
  assert.deepEqual(dim(on), {});
  assert.deepEqual(dim({ ...on, dashboards: false }), { L3: ['dashboards'] });
  assert.deepEqual(dim({ ...on, validation: false }), { L5: ['validation'] });
  assert.deepEqual(dim({ ...on, routes: false }), { L4: ['routes'] });
  assert.deepEqual(dim({ ...on, slos: false }), { L1: ['slos'], L4: ['slos'] });
  assert.deepEqual(dim({ ...on, policy: false }), { L4: ['policy'] });
  const l4 = stackOf({ toggles: { ...on, routes: false } }).slabs.find(x => x.id === 'L4');
  assert.deepEqual(l4.subgroups.map(sg => [sg.key, sg.offSections]), [['policy', []], ['alerting', ['routes']], ['healing', []]]);
  const l4b = stackOf({ toggles: { ...on, slos: false } }).slabs.find(x => x.id === 'L4');
  assert.deepEqual(l4b.subgroups.map(sg => [sg.key, sg.offSections]), [['policy', ['slos']], ['alerting', []], ['healing', []]]);
  const open = stackOf({ expanded: { L2: true, 'L3/detail': true } });
  assert.deepEqual(open.slabs.map(x => [x.id, x.expanded, x.detailOpen]).filter(r => r[1] || r[2]), [['L2', true, false], ['L3', false, true]]);
  // The compile model reads the draft's stackOpen; a compiled draft's stack is the live one.
  const c = buildCompileModel({ build: draft({ stackOpen: { L5: true } }), library: LIBRARY, clauses: T2 });
  assert.equal(c.stack.mode, 'compile');
  assert.equal(c.stack.slabs.find(x => x.id === 'L5').expanded, true);
  assert.equal(c.stack.counts.artefacts, 82);
  assert.equal(buildCompileModel({ build: draft(), library: LIBRARY }).stack.counts.clauses.total, 0, 'without the tier\'s clauses the edges are neutral and no ghost is drawn');
});

test('the artefacts on the stack are the adapter\'s for the same canonical — what Discover shows, id for id', () => {
  const adapted = JSON.parse(JSON.stringify(adapt(FIXTURE.canonical, { environment: 'prod' })));
  assert.deepEqual(adapted, FIXTURE.adapted, 'the fixture carries the adapter\'s projection');
  const s = stackOf({ adapted, mode: 'compile' });
  for (const id of ['L1', 'L2', 'L2X', 'L3', 'L5', 'GOV']) {
    assert.deepEqual(idsOf(s.slabs.find(x => x.id === id).artefacts), idsOf(adapted.layers[id]), id);
  }
  assert.deepEqual(idsOf(s.slabs.find(x => x.id === 'L4').artefacts), idsOf(flatL4(adapted.layers.L4)));
  for (const sg of L4_SUBGROUPS) assert.deepEqual(idsOf(s.slabs.find(x => x.id === 'L4').subgroups.find(g => g.key === sg.key).artefacts), idsOf(adapted.layers.L4[sg.key]), sg.key);
  assert.equal(s.counts.artefacts, 14 + 15 + 0 + 34 + 12 + 6 + 1);
  // Nothing is added, renamed or dropped: every field of the adapter's artefact survives on the slab.
  const bak = s.slabs.find(x => x.id === 'L2').artefacts.find(a => a.id === 'BAK-01');
  for (const k of Object.keys(adapted.layers.L2[1])) assert.deepEqual(bak[k], adapted.layers.L2[1][k], k);
  assert.equal(bak.symbol, 'telemetry.backends.metrics-prom');
  // The detail artefacts Discover folds behind Expand fold here too: L3's panels, recording rules and derived views.
  const l3 = s.slabs.find(x => x.id === 'L3');
  assert.equal(l3.counts.detail, 18 + 7 + 5);
  assert.deepEqual(l3.artefacts.filter(a => !a.detail).map(a => a.id), ['DASH-01', 'DASH-02', 'DASH-03', 'DASH-04']);
  assert.equal(s.slabs.find(x => x.id === 'L2').counts.detail, 0);
  assert.equal(isDetailArtefact({ expand: true }, 'L2'), true);
  assert.equal(isDetailArtefact({ tags: ['recording'] }, 'L3'), true);
  assert.equal(isDetailArtefact({ tags: ['recording'] }, 'L2'), false);
  assert.equal(isDetailArtefact({ tags: ['dashboard'] }, 'L3'), false);
});

test('renderBuildStack draws the slabs headlessly in Discover\'s card markup: the edge class, the cards, the ghosts, the pins and the inline params', () => {
  const s = stackOf();
  const container = stubContainer();
  renderBuildStack(container, s, { build: {} });
  const html = container.innerHTML;
  assert.ok(html.includes('<div class="build-stack" data-mode="verify">'));
  for (const d of LAYER_DEFS) assert.ok(html.includes(`data-layer="${d.id}"`), d.id);
  assert.ok(html.includes('class="section build-slab is-pass" data-layer="L1"'));
  assert.ok(html.includes('class="section build-slab is-placeholder" data-layer="L2"'));
  assert.ok(html.includes('class="section build-slab is-neutral is-empty" data-layer="GOV"') || html.includes('class="section build-slab is-neutral" data-layer="GOV"'));
  // Discover's card body: the same head / title / foot classes, the source pill, the gating chip on a backend.
  assert.ok(html.includes('<span class="card-id">SLI-01</span>'));
  assert.ok(html.includes('<div class="card-title">kafka_broker_availability</div>'));
  assert.ok(html.includes('data-source="Scaffold">Scaffold</span>'));
  assert.ok(html.includes('class="gating-chip" data-gating="warn"'));
  assert.ok(html.includes('class="card is-scaffold has-todo" data-artefact="ALR-01" data-symbol="alerting.routes[0]"'));
  assert.ok(!html.includes('benchmark-cta'), 'no benchmark action in Build');
  // The todos on their slab, with the same param inputs as before (focus keys distinct per todo: slab + todo path).
  assert.ok(html.includes('data-todo="alerting.routes[0]"'));
  assert.ok(html.includes('data-focus-key="param:oncall_channel@L4/alerting.routes[0]"'));
  const l5Bootstrap = s.slabs.find(x => x.id === 'L5').todos.find(t => t.params.some(p => p.key === 'kafka.bootstrap'));
  assert.ok(html.includes(`data-focus-key="param:kafka.bootstrap@L5/${l5Bootstrap.path}"`));
  assert.ok(html.includes('class="build-card-pin" data-todo-path="alerting.routes[0]"'));
  assert.ok(html.includes('<span class="build-todo-card" title="the artefact card this todo belongs to">ALR-01</span>'));
  assert.ok(html.includes('L4.alerting · Alerting'));
  // Folded detail: the DASH cards are drawn, the panels are not; the toggle says how many.
  assert.ok(html.includes('data-artefact="DASH-01"') && !html.includes('data-artefact="PANEL-01"'));
  assert.ok(html.includes('Expand detail <span class="section-expand-count">30</span>'));
  assert.ok(buildStackHtml(stackOf({ expanded: { 'L3/detail': true } })).includes('data-artefact="PANEL-01"'));
  // COMPILE draws no todo block; DEFINE draws Required ghosts and Candidates.
  const compile = buildStackHtml(stackOf({ mode: 'compile' }));
  assert.ok(!compile.includes('build-slab-todos') && compile.includes('data-artefact="ALR-01"'));
  const define = buildStackHtml(buildDefineModel({ build: draft({ result: null }), library: LIBRARY, requirements: REQUIREMENTS }).stack);
  assert.ok(define.includes('data-source="Required">Required</span>') && define.includes('data-source="Candidate">Candidate</span>'));
  assert.ok(define.includes('<div class="card-title">SLO on kafka_broker_availability</div>') && define.includes('99.9% over 30d'));
  assert.ok(!define.includes('data-artefact='), 'a silhouette draws no real card');
  // Dashboards off: the L3 edge is red and the unmet clauses are Missing ghosts; the slab is dimmed.
  const off = buildStackHtml(stackOf({ checklist: buildClauseChecklist(T2, DASHBOARDS_OFF_SUMMARY), toggles: { ...defaultBuildState().toggles, dashboards: false } }));
  assert.ok(off.includes('class="section build-slab is-fail is-dimmed" data-layer="L3"'));
  assert.ok(off.includes('data-source="Missing">Missing</span>') && off.includes('<div class="card-title">service overview board</div>'));
  assert.ok(off.includes('<span class="build-slab-off">dashboards off</span>'));
  // The clause text is escaped at the seam.
  const hostile = [{ id: 'L1.MUST.x', dimension: 'L1', severity: 'MUST', minTier: 'tier-3', description: 'a <img src=x onerror="1"> clause' }];
  const hh = buildStackHtml(buildStackModel({ requirements: hostile, checklist: buildClauseChecklist(hostile, null), mode: 'define' }));
  assert.ok(!hh.includes('<img') && hh.includes('a &lt;img src=x onerror=&quot;1&quot;&gt; clause'));
});

test('a card\'s todo pin reveals its todo on VERIFY and, where the todos are not drawn, jumps to Verify on that todo', () => {
  // COMPILE draws the pin as a jump (its todo lives on VERIFY); VERIFY draws it plain.
  const compile = buildStackHtml(stackOf({ mode: 'compile' }));
  assert.ok(compile.includes('class="build-card-pin" data-todo-path="alerting.routes[0]" data-jump="verify" title="todo: alerting.routes[0] — a placeholder value the team must fill, on Verify"'));
  const verify = buildStackHtml(stackOf());
  assert.ok(verify.includes('class="build-card-pin" data-todo-path="alerting.routes[0]" title="todo: alerting.routes[0] — a placeholder value the team must fill"'));
  assert.ok(!verify.includes('data-jump='), 'no jump where the todos are on the page');
  // The handler, through a container that has one pin and (VERIFY) its todo or (COMPILE) none.
  globalThis.CSS ??= { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };
  const fakePin = (jump) => { const h = {}; return { dataset: { todoPath: 'alerting.routes[0]', ...(jump ? { jump: 'verify' } : {}) }, addEventListener: (t, fn) => { h[t] = fn; }, fire: () => h.click({ stopPropagation() {} }) }; };
  const fakeTodo = () => { const cls = new Set(); let focused = false; return { classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), has: (c) => cls.has(c) }, scrollIntoView() {}, querySelector: () => ({ focus() { focused = true; } }), get focused() { return focused; } }; };
  const container = (pin, todo) => ({ querySelectorAll: (sel) => (sel === '.build-card-pin' ? [pin] : []), querySelector: (sel) => (sel.startsWith('[data-todo=') ? todo : null) });
  const calls = [];
  const host = { build: { setStep: (...a) => calls.push(a), update() {} } };
  const onVerify = fakePin(false), todo = fakeTodo();
  wireBuildStack(container(onVerify, todo), stackOf(), host);
  onVerify.fire();
  assert.ok(todo.classList.has('is-flash') && todo.focused, 'VERIFY: the todo is flashed and its input focused');
  assert.deepEqual(calls, [], 'VERIFY: no step change');
  const onCompile = fakePin(true);
  wireBuildStack(container(onCompile, null), stackOf({ mode: 'compile' }), host);
  onCompile.fire();
  assert.deepEqual(calls, [['verify', { todo: 'alerting.routes[0]' }]], 'COMPILE: the click goes to Verify, on that todo');
  // revealTodo on its own: false with nothing to reveal, so the caller falls back to the top of the step.
  assert.equal(revealTodo(null), false);
});

test('focus across a re-render: a todo\'s input keys by slab and path, so a filled todo takes only its own keys away; a vanished key falls back to its slab', () => {
  assert.equal(todoFocusSuffix('L4', 'alerting.routes[0]'), 'L4/alerting.routes[0]');
  const keysOf = (html) => [...html.matchAll(/data-focus-key="([^"]+)"/g)].map(m => m[1]);
  const before = keysOf(buildStackHtml(stackOf()));
  assert.equal(new Set(before).size, before.length, 'every input has its own key');
  // Fill the first L2 todo: it disappears with its inputs — every other key is unchanged.
  const gone = stackOf().slabs.find(x => x.id === 'L2').todos[0];
  const after = keysOf(buildStackHtml(stackOf({ todos: FIXTURE.todos.filter(t => t.path !== gone.path) })));
  const removed = before.filter(k => !after.includes(k));
  assert.ok(removed.length >= 1 && removed.every(k => k.endsWith(`@L2/${gone.path}`)), `only the filled todo's keys go: ${removed.join(', ')}`);
  assert.deepEqual(after, before.filter(k => !removed.includes(k)), 'the survivors keep their keys, in order');
  // Where the controller sends focus when the key it held is gone: the same slab's first input, then its edge.
  assert.deepEqual(focusFallbackSelectors(`param:${gone.params[0].key}@L2/${gone.path}`), ['.build-slab[data-layer="L2"] .build-param-input', '.build-slab[data-layer="L2"] .build-slab-edge']);
  assert.deepEqual(focusFallbackSelectors('param:oncall_channel@L4/alerting.routes[0]'), ['.build-slab[data-layer="L4"] .build-param-input', '.build-slab[data-layer="L4"] .build-slab-edge']);
  assert.deepEqual(focusFallbackSelectors('param:kafka.bootstrap'), [], 'a DEFINE param input has no slab');
  assert.deepEqual(focusFallbackSelectors('name'), []);
  assert.deepEqual(focusFallbackSelectors(null), []);
});

// The stylesheet, for the rules the stack relies on (the repo has no browser harness: these read the text).
const CSS_TEXT = readFileSync(resolve(ROOT, 'studio/app.css'), 'utf8');
const cssRule = (selector) => { const m = CSS_TEXT.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)); return m ? m[1] : null; };

test('a Scaffold card keeps its focus ring: the dashed frame is an outline, so a later :focus-visible rule must restore the accent ring', () => {
  const focusRing = cssRule('.card:focus-visible');
  assert.ok(focusRing && /outline:\s*2px solid var\(--accent\)/.test(focusRing), 'the card focus ring is an outline in the accent');
  // Every card flag this branch draws with an outline (same specificity as .card:focus-visible, declared later, so it wins) restores the ring.
  for (const flag of ['is-scaffold']) {
    const frame = cssRule(`.card.${flag}`);
    assert.ok(frame && /outline:/.test(frame), `.card.${flag} draws with an outline`);
    const restored = cssRule(`.card.${flag}:focus-visible`);
    assert.ok(restored, `.card.${flag}:focus-visible exists`);
    assert.equal(restored.replace(/\s+/g, ' ').trim(), focusRing.replace(/\s+/g, ' ').trim(), `.card.${flag}:focus-visible is the card focus ring`);
    assert.ok(CSS_TEXT.indexOf(`.card.${flag}:focus-visible`) > CSS_TEXT.indexOf(`.card.${flag} {`), 'declared after the frame, so it wins the cascade');
  }
});

test('artefactCardHtml is the one card body: Discover\'s head, chip, pill, title, desc, foot — and the flags only the caller knows', () => {
  const bak = FIXTURE.adapted.layers.L2.find(a => a.id === 'BAK-01');
  const plain = artefactCardHtml(bak);
  assert.ok(plain.includes('<span class="card-id">BAK-01</span>'));
  assert.ok(plain.includes('<span class="gating-chip" data-gating="warn"'));
  assert.ok(plain.includes('<span class="card-source" data-source="Scaffold">Scaffold</span>'));
  assert.ok(plain.includes(`<div class="card-title">${bak.title}</div>`));
  assert.ok(plain.includes('<span class="tool">prometheus</span>'));
  assert.ok(!plain.includes('ref-indicator') && !plain.includes('benchmark-cta'));
  const flagged = artefactCardHtml(bak, { broken: 2, benchmark: { slug: 'prometheus', refPackId: 'prometheus-reference', label: 'Prometheus' } });
  assert.ok(flagged.includes('title="2 unresolved reference(s)">⚠</span>'));
  assert.ok(flagged.includes('class="benchmark-cta"') && flagged.includes('data-ref-pack="prometheus-reference"') && flagged.includes('Benchmark vs Prometheus'));
  assert.equal((artefactCardHtml({ id: 'X', title: 'x', tags: ['a', 'b', 'c', 'd', 'e', 'f'] }).match(/class="tag"/g) || []).length, 4, 'four tags, as Discover shows');
  const hostile = artefactCardHtml({ id: 'X', title: '<img src=x>', desc: '"q"', source: 'Declared', tags: ['<b>'] });
  assert.ok(!hostile.includes('<img') && !hostile.includes('<b>') && hostile.includes('&lt;img src=x&gt;'));
});

test('the compact rail: the failing and the placeholder clauses folded out, the full list behind "all clauses", its open state on the draft', () => {
  const r = buildRailModel({ build: draft(), clauses: T2 });
  assert.deepEqual(r.failing, []);
  assert.deepEqual(r.onPlaceholder.map(i => i.id), ['L2.MUST.metrics_exporter', 'L2.MUST.metrics_logs_traces_backends', 'L5.MUST.synthetic_probe', 'L5.MUST.tier2_chaos_staging']);
  assert.equal(r.expanded, false);
  assert.equal(buildRailModel({ build: draft({ railOpen: true }), clauses: T2 }).expanded, true);
  const off = buildRailModel({ build: draft({ result: { ...draft().result, summary: DASHBOARDS_OFF_SUMMARY } }), clauses: T2 });
  assert.deepEqual(off.failing.map(i => i.id), ['L3.MUST.service_overview_dashboard', 'L3.MUST.slo_burn_dashboard']);
  const container = stubContainer();
  renderClauseRail(container, off, { build: {} });
  assert.ok(container.innerHTML.includes('the red edges on the stack'));
  assert.ok(container.innerHTML.includes('<details class="build-rail-all">') && container.innerHTML.includes('all 16 clauses by layer'));
  assert.ok(container.innerHTML.includes('4 clauses pass only on a placeholder'));
  renderClauseRail(container, buildRailModel({ build: draft({ railOpen: true }), clauses: T2 }), { build: {} });
  assert.ok(container.innerHTML.includes('<details class="build-rail-all" open>'));
  assert.ok(!container.innerHTML.includes('build-rail-failing'), 'nothing fails: no failing block');
  // stackOpen and railOpen are UI state on the draft, never persisted.
  const b = defaultBuildState();
  assert.deepEqual(b.stackOpen, {});
  assert.equal(b.railOpen, false);
  for (const k of ['stackOpen', 'railOpen']) assert.ok(!BUILD_PERSIST_FIELDS.includes(k), `${k} must not persist`);
});

test('the rail and a slab draw the same clause row: one function, so a placeholder\'s todos and a failing clause\'s read alike in both', () => {
  const rowOf = (html, id) => { const m = html.match(new RegExp(`<li class="build-rail-clause is-\\w+" title="${id.replace(/\./g, '\\.')}[^"]*">[\\s\\S]*?</li>`)); return m && m[0]; };
  const rail = stubContainer();
  renderClauseRail(rail, buildRailModel({ build: draft(), clauses: T2 }), { build: {} });
  const stack = buildStackHtml(stackOf());
  for (const id of ['L2.MUST.metrics_exporter', 'L5.MUST.synthetic_probe', 'L1.MUST.availability_slo']) {
    const r = rowOf(rail.innerHTML, id), s = rowOf(stack, id);
    assert.ok(r && s, `${id} drawn on both`);
    assert.equal(r, s, `${id}: the rail's row is the slab's row`);
  }
  const ph = rowOf(stack, 'L2.MUST.metrics_exporter');
  assert.match(ph, /is-placeholder/);
  assert.match(ph, /<em>on \d+ placeholders?: [^<]+<\/em>/, 'a placeholder pass names its todos');
  // A failing clause: the rail's failing block and the slab's list, the same row.
  const off = stubContainer();
  renderClauseRail(off, buildRailModel({ build: draft({ result: { ...draft().result, summary: DASHBOARDS_OFF_SUMMARY } }), clauses: T2 }), { build: {} });
  const offStack = buildStackHtml(stackOf({ checklist: buildClauseChecklist(T2, DASHBOARDS_OFF_SUMMARY) }));
  const failRail = rowOf(off.innerHTML, 'L3.MUST.service_overview_dashboard'), failSlab = rowOf(offStack, 'L3.MUST.service_overview_dashboard');
  assert.ok(failRail && failSlab && failRail === failSlab);
  assert.match(failRail, /is-fail/);
  assert.equal((off.innerHTML.match(/L3\.MUST\.service_overview_dashboard — fails/g) || []).length, 2, 'listed under failing and under all clauses, the same row');
  // The one function, on its own: a failing clause with todos names them; escaping at the seam.
  const withTodos = clauseRowHtml({ id: 'L4.MUST.x', state: 'fail', severity: 'MUST', description: 'd', todos: ['alerting.routes[0]', 'a <b>'] });
  assert.ok(withTodos.includes('<em>alerting.routes[0], a &lt;b&gt;</em>') && !withTodos.includes('<b>'));
  assert.ok(!clauseRowHtml({ id: 'L1.MUST.y', state: 'pass', severity: 'MUST', description: 'd', todos: [] }).includes('<em>'));
});
