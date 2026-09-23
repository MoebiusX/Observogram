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
  buildDefineModel, buildCompileModel, summarizeWarnings, buildClauseChecklist,
  placeholdersRemaining, groupTodos, buildVerifyModel, reachableSliKeys, retargetSlis, splitBuildErrors, isStale, resolveBuiltins,
  buildStackModel, sliCandidates, artefactSymbol, todoLayer, clauseGhostLabel, clauseSubgroup, slabState, isDetailArtefact, CLAUSE_GHOSTS,
  todoFocusSuffix, focusFallbackSelectors, enterStep, stepAfterInstantiate,
  buildDefinitionModel, buildSheetModel, rolodexItems, addSliSelection, paramLayer, paramSubgroup, sectionClauses, sectionDrops, sectionNotes, sectionSwitch, sheetLists,
  sheetModeFor, stackExpanded, sheetFocusSuffix, LAYER_QUESTIONS, LAYER_SWITCHES,
} from '../studio/build-model.mjs';
import {
  loadLibrary as loadLibraryApi, loadRequirements, loadTargets, instantiate, compilePreview, registerBuiltPack,
} from '../studio/build-api.mjs';
import { defaultBuildState, BUILD_PERSIST_FIELDS } from '../studio/state.mjs';
import { LAYER_DEFS, L4_SUBGROUPS } from '../studio/constants.mjs';
import { renderBuildDefine } from '../studio/build-define-view.mjs';
import { renderBuildCompile } from '../studio/build-compile-view.mjs';
import { renderBuildVerify } from '../studio/build-verify-view.mjs';
import { renderBuildStack, buildStackHtml, wireBuildStack } from '../studio/build-stack-view.mjs';
import { renderBuildDefinition, buildDefinitionHtml, wireBuildDefinition, summaryHtml } from '../studio/build-definition-view.mjs';
import { renderBuildSheet, buildSheetHtml, wireBuildSheet, wireRolodex, paramReadHtml, SMOOTH_SCROLL_GRACE_MS } from '../studio/build-sheet-view.mjs';
import { artefactCardHtml } from '../studio/card-html.mjs';
import { revealTodo, clauseRowHtml, switchHtml, evidenceDot } from '../studio/build-atoms.mjs';
import { installDialogFocusTrap, TRAPPED_DIALOGS } from '../studio/util.mjs';

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
  // The input lives in the definition column now: its value is escaped there too.
  const def = stubContainer();
  renderBuildDefinition(def, buildDefinitionModel({ build: draft({ name: payload }), library: LIBRARY, requirements: REQUIREMENTS }), { build: {} });
  assert.ok(!def.innerHTML.includes('<img'));
  assert.ok(def.innerHTML.includes(`value="${'1&lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;'}"`), 'the input value is escaped too');
  assert.ok(def.innerHTML.includes('Still needed: a service name that slugs'), 'the column says what is still needed');
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
  // The definition column's summary says so.
  const def = buildDefinitionModel({ build: bad, library: LIBRARY, requirements: REQUIREMENTS });
  assert.equal(def.summary.stale, true);
  assert.equal(def.summary.ready, true);
  assert.equal(def.summary.statusKind, 'error');
  assert.deepEqual(Object.keys(def.error.byParam), ['kafka.bootstrap']);
  assert.ok(quote.endsWith(def.error.byParam['kafka.bootstrap']), 'the reason is the engine\'s, after the `param <key>: ` prefix');
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
  assert.ok(define.includes(`${lead}on its layer sheet (L2 · L4 · L5)</div>`), 'DEFINE: the params live on the layer sheets');
  const compile = render(renderBuildCompile, buildCompileModel({ build: stale, library: LIBRARY, clauses: T2 }));
  assert.ok(compile.includes(`${lead}on its layer sheet (L2 · L4 · L5) and under its todo on Verify</div>`), 'COMPILE: the row is on the sheet, and under the todo on Verify');
  const verify = render(renderBuildVerify, buildVerifyModel({ build: stale, library: LIBRARY, clauses: T2, targets: TARGETS }));
  assert.ok(verify.includes(`${lead}below, under its todo</div>`), 'VERIFY: the row is under the todo');
  // Two rejected values pluralise the whole phrase.
  const two = draft({ error: ['param kafka.bootstrap: a value may not contain a double quote', 'param remote_write_url: a value may not contain a backslash'] });
  assert.ok(render(renderBuildCompile, buildCompileModel({ build: two, library: LIBRARY, clauses: T2 })).includes('2 parameter values rejected — marked on their rows on its layer sheet'));
  // The sheet that carries the rejected value says so, and its row carries the reason.
  const l5 = buildSheetHtml(buildSheetModel({ layerId: 'L5', build: stale, library: LIBRARY, requirements: T2, mode: 'edit' }));
  assert.ok(l5.includes('1 parameter value on this layer rejected by the last compilation — the pack shown is the previous one'));
  assert.ok(l5.includes('<span class="build-param-error" role="alert">a value may not contain a double quote</span>'));
  assert.equal(buildSheetModel({ layerId: 'L2', build: stale, library: LIBRARY, requirements: T2, mode: 'edit' }).rejected, 0, 'kafka.bootstrap is an L5 param (the canary’s address), not an L2 one');
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

test('the definition column’s summary carries the counts the rail used to print', () => {
  const s = buildDefinitionModel({ build: draft(), library: LIBRARY, requirements: REQUIREMENTS }).summary;
  assert.equal(s.tier, 'tier-2');
  assert.equal(s.todoCount, 21);
  assert.equal(s.warningCount, 0);
  assert.equal(s.blockingWarnings, 0);
  assert.equal(s.placeholdersRemaining, 17);
  assert.equal(s.ready, true);
  assert.equal(s.statusKind, 'ok');
  assert.equal(s.status, 'conformant at tier-2');
  assert.equal(s.counts.placeholder, 4);
  assert.equal(s.onPlaceholder, 4);
  const cold = buildDefinitionModel({ build: defaultBuildState(), library: LIBRARY, requirements: REQUIREMENTS }).summary;
  assert.equal(cold.ready, false);
  assert.equal(cold.statusKind, 'idle');
  assert.equal(cold.status, 'complete the definition to evaluate');
  assert.equal(cold.counts.pending, 16);
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
  for (const k of ['result', 'preview', 'error', 'pending', 'stackOpen', 'sheetOpen', 'rolodexAll', 'wantedStep']) assert.ok(!BUILD_PERSIST_FIELDS.includes(k), `${k} must not persist`);
  assert.equal(b.sheetOpen, null, 'no sheet open on a fresh draft');
  assert.equal(b.rolodexAll, false);
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
  assert.ok(s.slabs.every(x => !('accent' in x)), 'no colour in the model: a slab\'s colour is its layer token (.section[data-layer]) in the stylesheet');
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

test('the maturity number says the split: the pass share, then the share that passes only on a placeholder — never one green number', () => {
  const rowOf = (html, id) => html.match(new RegExp(`<div class="build-maturity-row" data-layer="${id}"[\\s\\S]*?<span class="build-maturity-pct">([\\s\\S]*?)</span>\\s*</div>`));
  const render = (b) => { const c = stubContainer(); renderBuildVerify(c, buildVerifyModel({ build: b, library: LIBRARY, clauses: T2, targets: TARGETS }), { build: {} }); return c.innerHTML; };
  const html = render(draft());
  // L5: 0 of 2 pass without a placeholder — the text says 0%, not 100%.
  assert.equal(rowOf(html, 'L5')[1], '0% <span class="build-maturity-ph" title="pass on a placeholder">+100% ◐</span>');
  assert.equal(rowOf(html, 'L2')[1], '60% <span class="build-maturity-ph" title="pass on a placeholder">+40% ◐</span>');
  assert.equal(rowOf(html, 'L1')[1], '100%', 'all pass: one number, no placeholder share');
  assert.ok(!/build-maturity-pct">100% <span/.test(html), 'a placeholder share is never printed beside a 100% pass');
  // The bar carries the counts for a screen reader (the segments are empty spans).
  assert.ok(html.includes('<span class="build-maturity-bar" role="img" aria-label="L5 Validation: 0 pass, 2 on a placeholder, 0 fail of 2 clauses">'));
  assert.ok(html.includes('aria-label="L2 Telemetry: 3 pass, 2 on a placeholder, 0 fail of 5 clauses"'));
  // Dashboards off: L3 reads 50% (2 of 4 pass), the failing half is the red segment.
  const off = render(draft({ result: { ...draft().result, summary: DASHBOARDS_OFF_SUMMARY } }));
  assert.equal(rowOf(off, 'L3')[1], '50%');
  assert.ok(off.includes('aria-label="L3 Insight: 2 pass, 0 on a placeholder, 2 fail of 4 clauses"'));
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
  assert.ok(html.includes('class="section build-slab is-pass" data-layer="L1">'), 'the layer token does the colouring: no inline style on a slab');
  assert.ok(!html.includes('style="--slab'));
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

test('the slab verdict reads at WCAG AA in both themes: each state colour the rules name, on the surface the pill sits on', () => {
  const tokensOf = (block) => { const m = CSS_TEXT.match(new RegExp(`(?:^|\\n)${block}\\s*\\{([\\s\\S]*?)\\n\\}`)); assert.ok(m, `${block} token block`); return Object.fromEntries([...m[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map(t => [t[1], t[2]])); };
  const themes = { light: tokensOf(':root'), dark: tokensOf('\\[data-theme="dark"\\]') };
  const lum = (hex) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  // The pill's surface and each state's colour, read from the rules themselves.
  const pill = cssRule('.build-slab-verdict');
  const surface = pill.match(/background:\s*var\(--([\w-]+)\)/)?.[1];
  assert.equal(surface, 'card', 'the verdict sits on the card surface, not on the layer tint');
  assert.match(pill, /font:\s*600 11px/, 'small bold text: the 4.5:1 threshold applies');
  for (const state of ['pass', 'placeholder', 'fail', 'pending', 'neutral']) {
    const token = cssRule(`.build-slab-verdict.is-${state}`)?.match(/color:\s*var\(--([\w-]+)\)/)?.[1];
    assert.ok(token, `.is-${state} names a token`);
    for (const [name, t] of Object.entries(themes)) {
      assert.ok(t[token] && t[surface], `${name}: --${token} and --${surface} are hex tokens`);
      const ratio = contrast(t[token], t[surface]);
      assert.ok(ratio >= 4.5, `${name}: ${state} (--${token} ${t[token]}) on --${surface} ${t[surface]} is ${ratio.toFixed(2)}:1, below 4.5`);
    }
  }
  // The ratio the review measured, for the record: the old pending grey on the light L5 tint fails.
  assert.ok(contrast(themes.light['ink-5'], themes.light['L5-tint']) < 3);
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

// ---------------------------------------------------------------------------
// The axis (docs/BUILD_JOURNEY.md "The axis"): the definition column and the layer sheet
// ---------------------------------------------------------------------------

// A container whose queries answer from a map of selector → elements (the handlers, without a DOM).
function fakeContainer(map = {}) {
  return {
    innerHTML: '',
    querySelectorAll: (sel) => map[sel] || [],
    querySelector: (sel) => (map[sel] || [])[0] || null,
  };
}
const fakeEl = (dataset = {}, extra = {}) => {
  const handlers = {};
  return {
    dataset, disabled: false, ...extra,
    addEventListener: (t, fn) => { handlers[t] = fn; },
    fire: (t, ev = {}) => handlers[t]?.({ preventDefault() {}, stopPropagation() {}, currentTarget: null, ...ev }),
    getAttribute: (k) => (k === 'aria-checked' ? extra.checked : null),
  };
};

test('buildDefinitionModel: the fields, the tier segments with their counts, the entries as chips, the summary — and what is still needed', () => {
  const m = buildDefinitionModel({ build: draft(), library: LIBRARY, requirements: REQUIREMENTS });
  assert.equal(m.name, 'orders-api');
  assert.equal(m.slug, 'orders-api');
  assert.deepEqual(m.ownerList, ['team-orders']);
  assert.equal(m.environment, 'prod');
  assert.equal(m.tier, 'tier-2');
  assert.equal(m.tierIndex, 1, 'the thumb sits on the middle segment');
  assert.deepEqual(m.tiers.map(t => [t.id, t.index, t.must, t.should, t.selected, t.loaded]), [['tier-3', 0, 9, 0, false, true], ['tier-2', 1, 15, 1, true, true], ['tier-1', 2, 25, 5, false, true]]);
  assert.equal(m.tierBlurb, 'A latency SLO, logs and traces backends, a chaos experiment in staging, a remediation.');
  assert.equal(m.products.length, 8);
  assert.equal(m.archetypes.length, 2);
  const kafka = m.products.find(c => c.id === 'kafka');
  assert.deepEqual([kafka.selected, kafka.evidence.status, kafka.evidence.word, kafka.sliCountAtTier, kafka.placeholderParams, kafka.gaps], [true, 'recorded-live', 'recorded live', 5, 5, 2]);
  assert.equal(m.products.find(c => c.id === 'ibm-mq').selected, false);
  assert.equal(m.archetypes.find(c => c.id === 'http-service').evidence.status, 'semconv');
  assert.equal(m.selectedCount, 2);
  assert.deepEqual(m.selectedTitles, ['Apache Kafka', 'HTTP service (OTel semconv)']);
  assert.equal(m.valid, true);
  assert.deepEqual(m.summary.counts, { pass: 12, placeholder: 4, fail: 0, pending: 0, total: 16, must: { total: 15, pass: 15, fail: 0 }, should: { total: 1, pass: 1, fail: 0 } });
  assert.deepEqual(m.summary.failing, []);
  // Requirements not loaded: the segments say so, the column stays valid.
  const cold = buildDefinitionModel({ build: draft(), library: LIBRARY, requirements: {} });
  assert.equal(cold.tiers[1].must, null);
  assert.equal(cold.tiers[1].loaded, false);
  assert.equal(cold.valid, true);
  // Dashboards off: the summary names the failing clauses (the red edges) and says how many MUST fail.
  const off = buildDefinitionModel({ build: draft({ result: { ...draft().result, summary: DASHBOARDS_OFF_SUMMARY } }), library: LIBRARY, requirements: REQUIREMENTS });
  assert.equal(off.summary.statusKind, 'fail');
  assert.equal(off.summary.status, '2 MUST clauses failing');
  assert.deepEqual(off.summary.failing.map(i => i.id), ['L3.MUST.service_overview_dashboard', 'L3.MUST.slo_burn_dashboard']);
  // A caller's checklist is used as given (the shell computes it once for the column and the sheet).
  const withCheck = buildDefinitionModel({ build: draft(), library: LIBRARY, requirements: REQUIREMENTS, checklist: buildClauseChecklist(T2, DASHBOARDS_OFF_SUMMARY) });
  assert.equal(withCheck.summary.counts.fail, 2);
  // Pending, error and idle states.
  assert.equal(buildDefinitionModel({ build: draft({ pending: true }), library: LIBRARY, requirements: REQUIREMENTS }).summary.status, 'checking…');
  const stale = buildDefinitionModel({ build: draft({ error: ['param x: no'] }), library: LIBRARY, requirements: REQUIREMENTS });
  assert.equal(stale.summary.statusKind, 'error');
  assert.equal(stale.summary.status, 'the last compilation failed — showing the previous pack');
  assert.equal(stale.stale, true);
  const empty = buildDefinitionModel({ build: defaultBuildState(), library: LIBRARY, requirements: REQUIREMENTS });
  assert.equal(empty.valid, false);
  assert.deepEqual(empty.errors, ['a service name', 'at least one library entry']);
  assert.equal(empty.selectedCount, 0);
});

test('renderBuildDefinition draws the segmented control, the chips and the summary headlessly, with their ARIA', () => {
  const c = stubContainer();
  renderBuildDefinition(c, buildDefinitionModel({ build: draft(), library: LIBRARY, requirements: REQUIREMENTS }), { build: {} });
  const html = c.innerHTML;
  assert.ok(html.includes('<div class="build-seg" role="radiogroup" aria-label="Criticality tier" style="--seg-index:1">'));
  assert.equal((html.match(/role="radio"/g) || []).length, 3);
  assert.ok(html.includes('data-tier="tier-2" aria-checked="true" tabindex="0"'));
  assert.ok(html.includes('data-tier="tier-1" aria-checked="false" tabindex="-1"'));
  assert.ok(html.includes('<span class="build-seg-name">tier-2</span>') && html.includes('aria-label="15 MUST, 1 SHOULD"><b>15 MUST</b><b>1 SHOULD</b></span>'), 'the counts stack, MUST over SHOULD');
  assert.ok(html.includes('aria-label="9 MUST"><b>9 MUST</b></span>'), 'tier-3 has no SHOULD: the count reads MUST only');
  assert.ok(html.includes('<p class="build-seg-blurb"><b>tier-2</b> A latency SLO'));
  assert.ok(html.includes('data-entry="kafka" aria-pressed="true"') && html.includes('data-entry="ibm-mq" aria-pressed="false"'));
  assert.ok(html.includes('<span class="build-chip-slis">5 SLIs at this tier</span>'));
  assert.ok(html.includes('class="build-evidence-dot build-evidence-recorded-live" title="recorded live · verified 2026-09-22" role="img" aria-label="evidence: recorded live · verified 2026-09-22"'));
  assert.ok(html.includes('id="build-name"') && html.includes('data-focus-key="name"') && html.includes('data-focus-key="owners"') && html.includes('data-focus-key="environment"'));
  assert.ok(html.includes('class="build-summary is-ok"') && html.includes('conformant at tier-2'));
  assert.ok(html.includes('12 pass') && html.includes('4 on a placeholder') && html.includes('0 fail'));
  assert.ok(!html.includes('build-summary-failing'), 'nothing fails: no failing block');
  assert.ok(html.includes('<b>21</b> todos') && html.includes('<b>17</b> placeholders left'));
  // Dashboards off: the failing block lists the two clauses with the shared clause row.
  const off = summaryHtml(buildDefinitionModel({ build: draft({ result: { ...draft().result, summary: DASHBOARDS_OFF_SUMMARY } }), library: LIBRARY, requirements: REQUIREMENTS }).summary);
  assert.ok(off.includes('class="build-summary is-fail"') && off.includes('build-summary-failing'));
  assert.equal((off.match(/L3\.MUST\.\w+_dashboard — fails/g) || []).length, 2);
  // Two-column html: the exit bar, the column and the main are the shell's; the column alone has no step head.
  assert.ok(!buildDefinitionHtml(buildDefinitionModel({ build: draft(), library: LIBRARY, requirements: REQUIREMENTS })).includes('build-step-head'));
  // The wiring: a segment click sets the tier, arrow keys move within the group, a chip toggles its entry.
  const calls = [];
  const segs = ['tier-3', 'tier-2', 'tier-1'].map(t => fakeEl({ tier: t }, { focus() { calls.push(['focus', t]); } }));
  const chip = fakeEl({ entry: 'ibm-mq' });
  wireBuildDefinition(fakeContainer({ '.build-seg-btn': segs, '.build-chip': [chip] }), {}, { build: { setTier: (t) => calls.push(['tier', t]), toggleEntry: (id) => calls.push(['entry', id]), update() {} } });
  segs[0].fire('click');
  segs[1].fire('keydown', { key: 'ArrowRight' });
  segs[2].fire('keydown', { key: 'ArrowRight' });
  chip.fire('click');
  assert.deepEqual(calls, [['tier', 'tier-3'], ['focus', 'tier-1'], ['tier', 'tier-1'], ['focus', 'tier-3'], ['tier', 'tier-3'], ['entry', 'ibm-mq']]);
  // Focus survives the re-render each of those causes: the segments and the chips carry a focus key
  // (rerenderBuild restores focus by [data-focus-key]), and the key the wiring focused exists in the
  // next render — the checked segment after setTier, the same chip after toggleEntry.
  assert.ok(html.includes('data-tier="tier-2" aria-checked="true" tabindex="0" data-focus-key="tier:tier-2"'));
  assert.ok(html.includes('data-entry="ibm-mq" aria-pressed="false" data-focus-key="entry:ibm-mq"'));
  const after = buildDefinitionHtml(buildDefinitionModel({ build: draft({ tier: 'tier-1', entries: ['kafka', 'http-service', 'ibm-mq'] }), library: LIBRARY, requirements: REQUIREMENTS }));
  assert.ok(after.includes('data-tier="tier-1" aria-checked="true" tabindex="0" data-focus-key="tier:tier-1"'), 'the segment the arrow key focused is the checked one after the re-render, same key');
  assert.ok(after.includes('data-entry="ibm-mq" aria-pressed="true" data-focus-key="entry:ibm-mq"'), 'the toggled chip keeps its key');
  assert.deepEqual(focusFallbackSelectors('tier:tier-1'), ['.build-seg-btn[aria-checked="true"]'], 'a tier key that vanished falls to the checked segment');
  assert.deepEqual(focusFallbackSelectors('entry:ibm-mq'), ['.build-chip[data-entry="ibm-mq"]', '.build-chip']);
  assert.deepEqual(focusFallbackSelectors('entry:<x>'), [], 'an id that is not a slug is not interpolated into a selector');
});

test('rolodexItems: the selected entries’ SLIs with the objective at the tier, above-tier ones disabled with the reason, every product behind the filter', () => {
  const items = rolodexItems({ build: draft(), library: LIBRARY });
  assert.equal(items.length, 10, 'kafka 6 + http-service 4, in selection order');
  assert.deepEqual(items.slice(0, 6).map(i => i.entry), Array(6).fill('kafka'));
  const ba = items.find(i => i.id === 'broker_availability');
  assert.deepEqual([ba.key, ba.entryTitle, ba.entrySelected, ba.type, ba.evidence, ba.metrics, ba.reachable, ba.selected, ba.disabled, ba.reason, ba.objectiveLabel, ba.window, ba.focusKey],
    ['kafka_broker_availability', 'Apache Kafka', true, 'ratio', 'recorded-live', ['up'], true, true, false, null, '99.9%', '30d', 'sli:kafka:broker_availability']);
  assert.deepEqual(ba.tiers.map(t => [t.tier, t.current, t.reachable, t.objectiveLabel, t.window]), [['tier-3', false, true, '99%', '30d'], ['tier-2', true, true, '99.9%', '30d'], ['tier-1', false, true, '99.9%', '30d']]);
  const ce = items.find(i => i.id === 'controller_election_rate');
  assert.deepEqual([ce.reachable, ce.selected, ce.disabled, ce.reason, ce.objectiveLabel, ce.objective, ce.window], [false, false, true, 'needs tier-1', 'needs tier-1', null, null]);
  assert.deepEqual(ce.tiers.map(t => t.reachable), [false, false, true]);
  // At tier-1 the same SLI is reachable and, with the defaults, in the pack.
  const t1 = rolodexItems({ build: draft({ tier: 'tier-1' }), library: LIBRARY }).find(i => i.id === 'controller_election_rate');
  assert.deepEqual([t1.reachable, t1.selected, t1.objectiveLabel, t1.window], [true, true, '99%', '7d']);
  // An explicit list: only its keys are selected.
  const explicit = rolodexItems({ build: draft({ slis: ['kafka_broker_availability'] }), library: LIBRARY });
  assert.deepEqual(explicit.filter(i => i.selected).map(i => i.key), ['kafka_broker_availability']);
  // The filter: every product's SLIs follow, not selected, keyed for the composition they would join.
  const all = rolodexItems({ build: draft(), library: LIBRARY, all: true });
  assert.equal(all.length, 56, 'every SLI of the ten entries');
  const mq = all.find(i => i.entry === 'ibm-mq' && i.id === 'qmgr_process_up');
  assert.deepEqual([mq.entrySelected, mq.selected, mq.key, mq.reachable], [false, false, 'ibm_mq_qmgr_process_up', true]);
  assert.ok(all.findIndex(i => i.entry === 'ibm-mq') > all.findIndex(i => i.entry === 'http-service'), 'the selected entries come first');
  // One entry alone: bare keys; a foreign SLI's key is the composed one it would get.
  const single = rolodexItems({ build: draft({ entries: ['kafka'] }), library: LIBRARY, all: true });
  assert.equal(single.find(i => i.entry === 'kafka' && i.id === 'broker_availability').key, 'broker_availability');
  assert.equal(single.find(i => i.entry === 'http-service' && i.id === 'availability').key, 'http_service_availability');
  assert.deepEqual(rolodexItems({ build: defaultBuildState(), library: LIBRARY }), []);
});

test('addSliSelection (the pure part of addSli): a product not yet selected joins with that one SLI, the rest of the selection kept and re-keyed', () => {
  // The drive: kafka + http-service at tier-2, defaults; add an IBM MQ SLI.
  const r = addSliSelection({ build: draft(), library: LIBRARY }, 'ibm-mq', 'qmgr_process_up');
  assert.equal(r.changed, true);
  assert.deepEqual(r.entries, ['kafka', 'http-service', 'ibm-mq'], 'the entry joins at the end');
  assert.deepEqual(r.slis, [...FIXTURE.provenance.toggles.slis, 'ibm_mq_qmgr_process_up'], 'the seven that were in the pack, plus the one added — not every MQ SLI');
  assert.equal(reachableSliKeys({ ...draft(), entries: r.entries }, LIBRARY).length, 13, 'six MQ SLIs are reachable at tier-2; only one was asked for');
  // From one entry to two: every key is re-keyed for the composition.
  const one = addSliSelection({ build: draft({ entries: ['kafka'], slis: null }), library: LIBRARY }, 'http-service', 'availability');
  assert.deepEqual(one.entries, ['kafka', 'http-service']);
  assert.deepEqual(one.slis, ['kafka_broker_availability', 'kafka_consumer_group_lag_seconds', 'kafka_partition_replica_health', 'kafka_produce_latency_p99', 'kafka_fetch_latency_p99', 'http_service_availability']);
  // An SLI of an entry already selected: the key is ticked; completing the defaults collapses to null.
  const partial = draft({ slis: FIXTURE.provenance.toggles.slis.filter(k => k !== 'kafka_fetch_latency_p99') });
  const back = addSliSelection({ build: partial, library: LIBRARY }, 'kafka', 'fetch_latency_p99');
  assert.deepEqual(back.entries, ['kafka', 'http-service']);
  assert.equal(back.slis, null, 'every reachable SLI ticked again: the defaults');
  const again = addSliSelection({ build: draft(), library: LIBRARY }, 'kafka', 'broker_availability');
  assert.equal(again.slis, null, 'already in: nothing changes in the list');
  // Above the tier: refused with the reason, nothing changes.
  const above = addSliSelection({ build: draft(), library: LIBRARY }, 'kafka', 'controller_election_rate');
  assert.deepEqual([above.changed, above.reason, above.entries, above.slis], [false, 'needs tier-1', ['kafka', 'http-service'], null]);
  assert.deepEqual(addSliSelection({ build: draft(), library: LIBRARY }, 'nope', 'x').changed, false);
  assert.deepEqual(addSliSelection({ build: draft(), library: LIBRARY }, 'kafka', 'nope').changed, false);
  // Pure: the draft passed in is untouched.
  const b = draft();
  addSliSelection({ build: b, library: LIBRARY }, 'ibm-mq', 'qmgr_process_up');
  assert.deepEqual(b.entries, ['kafka', 'http-service']);
  assert.equal(b.slis, null);
});

test('paramLayer places every param of the drive on one sheet; sectionClauses names exactly what a section off drops', () => {
  const rows = paramRows({ build: draft(), library: LIBRARY });
  const byLayer = Object.fromEntries(['L2', 'L4', 'L5'].map(L => [L, rows.filter(p => paramLayer(p) === L).map(p => p.key)]));
  assert.deepEqual(byLayer.L4, ['oncall_channel', 'team_channel', 'pager_service', 'pager_service_low', 'runbook_dir']);
  assert.deepEqual(byLayer.L5, ['chaos_target', 'probe_target', 'kafka.bootstrap', 'kafka.broker_workload', 'kafka.consumer_workload', 'http-service.health_url']);
  assert.deepEqual(byLayer.L2, ['metrics_endpoint', 'remote_write_url', 'logs_endpoint', 'logs_otlp_endpoint', 'traces_endpoint', 'traces_otlp_endpoint', 'prometheus_version', 'loki_version', 'tempo_version', 'kafka.broker_job', 'kafka.broker_targets', 'kafka.exporter_job', 'kafka.exporter_target', 'http-service.job', 'http-service.duration_metric']);
  assert.equal(byLayer.L2.length + byLayer.L4.length + byLayer.L5.length, rows.length, 'every param has a sheet');
  assert.deepEqual(rows.filter(p => paramSubgroup(p) === 'alerting').map(p => p.key), ['oncall_channel', 'team_channel', 'pager_service', 'pager_service_low']);
  assert.deepEqual(rows.filter(p => paramSubgroup(p) === 'healing').map(p => p.key), ['runbook_dir']);
  assert.equal(paramLayer(null), 'L2');
  // What each section holds up at tier-2 — the consequence a switch states.
  const ids = (s, req = T2) => sectionClauses(s, req).map(c => c.id);
  // SLOs off: the L1 clauses and the chaos in staging (its steady-state hypothesis is an SLO) — not the burn-alert clause, which is quantified per SLO and holds with none.
  assert.deepEqual(ids('slos'), ['L1.MUST.availability_slo', 'L1.MUST.latency_slo', 'L1.MUST.sli_covered_by_slo', 'L5.MUST.tier2_chaos_staging']);
  assert.deepEqual(ids('slos', REQUIREMENTS['tier-3']), ['L1.MUST.availability_slo', 'L1.MUST.sli_covered_by_slo']);
  assert.deepEqual(ids('slos', REQUIREMENTS['tier-1']), ['L1.MUST.availability_slo', 'L1.MUST.latency_slo', 'L1.SHOULD.domain_slo', 'L1.MUST.sli_covered_by_slo', 'L4.SHOULD.forecast_on_availability', 'L5.MUST.tier2_chaos_staging', 'L5.MUST.tier1_weekly_prod_chaos'], 'tier-1: the forecast and the weekly chaos too; chaos-per-SLO holds with no SLO');
  assert.deepEqual(ids('policy'), ['L4.MUST.multi_window_burn_rate']);
  assert.deepEqual(ids('routes'), [], 'no route clause below tier-1 (the SEV1 voice route is tier-1)');
  assert.deepEqual(ids('dashboards'), ['L3.MUST.service_overview_dashboard', 'L3.MUST.slo_burn_dashboard'], 'the recording rules and the derived view stay when dashboards go');
  assert.deepEqual(ids('validation'), ['L5.MUST.synthetic_probe', 'L5.MUST.tier2_chaos_staging']);
  assert.deepEqual(ids('dashboards'), DASHBOARDS_OFF_SUMMARY.failing.map(f => f.id), 'what the switch says it drops is what the engine reports failing');
  assert.equal(sectionClauses('routes', REQUIREMENTS['tier-1']).map(c => c.id).join(), 'L4.MUST.tier1_voice_route');
  assert.deepEqual(sectionClauses('nope', T2), []);
  // The switch model: state, the consequence in one line (an expectation while on), disabled when meaningless.
  const on = defaultBuildState();
  const slos = sectionSwitch('slos', on, T2);
  assert.deepEqual([slos.id, slos.label, slos.on, slos.disabled, slos.measured, slos.focusKey], ['slos', 'SLOs', true, false, false, 'toggle:slos']);
  assert.equal(slos.consequence, 'off is expected to drop 4 clauses of the tier: availability SLO, latency SLO, every SLI under an SLO, chaos in staging');
  assert.deepEqual(slos.expected, slos.drops);
  assert.equal(sectionSwitch('dashboards', on, T2).consequence, 'off is expected to drop 2 clauses of the tier: service overview board, SLO burn board');
  assert.equal(sectionSwitch('routes', on, T2).consequence, 'no clause of the tier rests on it — the section is still absent from the pack when off');
  const noSlos = { ...on, toggles: { ...on.toggles, slos: false } };
  assert.deepEqual([sectionSwitch('policy', noSlos, T2).disabled, sectionSwitch('policy', noSlos, T2).consequence], [true, 'meaningless without SLOs — dropped with them']);
  const dashOff = { ...on, toggles: { ...on.toggles, dashboards: false } };
  const pendingOff = sectionSwitch('dashboards', dashOff, T2);
  assert.deepEqual([pendingOff.on, pendingOff.measured, pendingOff.consequence], [false, false, 'off — expected to drop 2 clauses of the tier: service overview board, SLO burn board'], 'off before the engine answered: still an expectation');
  const measuredOff = sectionSwitch('dashboards', dashOff, buildClauseChecklist(T2, DASHBOARDS_OFF_SUMMARY).items.map(i => ({ ...T2.find(c => c.id === i.id), state: i.state })));
  assert.deepEqual([measuredOff.measured, measuredOff.consequence], [true, 'off — 2 clauses fail with it: service overview board, SLO burn board'], 'off and evaluated: the engine\'s set');
  assert.equal(sectionSwitch('routes', { ...on, toggles: { ...on.toggles, routes: false } }, buildClauseChecklist(T2, FIXTURE.summary).items.map(i => ({ ...T2.find(c => c.id === i.id), state: i.state }))).consequence, 'off — no clause of the tier fails with it; the section is absent from the pack');
});

// The engine with one section off at a time: what the switch says it drops must be what
// tools/lib/conformance.mjs actually fails — the same in-process instantiation the fixture uses.
test('a section switched off says exactly what the engine fails — every section at tier-2, SLOs at every tier; L5 says "no SLO to test"', () => {
  const engineFailing = (tier, section) => instantiateInProcess({ ...INPUTS, tier, toggles: { [section]: false } }).summary.failing.map(f => f.id).sort();
  const stackWith = (tier, section, res) => {
    const req = REQUIREMENTS[tier];
    const toggles = { ...defaultBuildState().toggles, [section]: false };
    return buildStackModel({ adapted: res.adapted, requirements: req, checklist: buildClauseChecklist(req, res.summary), todos: res.todos, params: [], mode: 'compile', toggles });
  };
  for (const section of SECTION_TOGGLES.map(t => t.id)) {
    const res = instantiateInProcess({ ...INPUTS, toggles: { [section]: false } });
    const failing = res.summary.failing.map(f => f.id).sort();
    assert.deepEqual(sectionClauses(section, T2).map(c => c.id).sort(), failing, `${section}: the expectation stated while on is the engine's failing set`);
    const stack = stackWith('tier-2', section, res);
    const tierClauses = stack.slabs.flatMap(s => s.clauses);
    const sw = sectionSwitch(section, { toggles: { [section]: false } }, tierClauses);
    assert.deepEqual([sw.on, sw.measured], [false, true]);
    assert.deepEqual(sw.drops.map(d => d.id).sort(), failing, `${section}: the consequence stated while off is the engine's failing set`);
    assert.deepEqual(sectionDrops(section, tierClauses).map(c => c.id).sort(), failing);
  }
  // SLOs off in detail: the burn-alert clause keeps passing (quantified per SLO), L5's chaos in staging fails; the switch, the slab chip and the sheet say so.
  const res = instantiateInProcess({ ...INPUTS, toggles: { slos: false } });
  const failing = res.summary.failing.map(f => f.id);
  assert.deepEqual(failing, ['L1.MUST.availability_slo', 'L1.MUST.latency_slo', 'L1.MUST.sli_covered_by_slo', 'L5.MUST.tier2_chaos_staging']);
  assert.ok(res.summary.passing.includes('L4.MUST.multi_window_burn_rate'), 'the engine passes the burn-alert clause with no SLO to alert on');
  const stack = stackWith('tier-2', 'slos', res);
  const tierClauses = stack.slabs.flatMap(s => s.clauses);
  const sw = sectionSwitch('slos', { toggles: { ...defaultBuildState().toggles, slos: false } }, tierClauses);
  assert.equal(sw.consequence, 'off — 4 clauses fail with it: availability SLO, latency SLO, every SLI under an SLO, chaos in staging');
  assert.ok(!sw.drops.some(d => d.id === 'L4.MUST.multi_window_burn_rate'));
  const by = Object.fromEntries(stack.slabs.map(s => [s.id, s]));
  assert.deepEqual([by.L1.dimmed, by.L1.offSections, by.L1.state], [true, ['slos'], 'fail']);
  assert.deepEqual([by.L4.dimmed, by.L4.offSections, by.L4.state, by.L4.notes], [true, ['slos'], 'pass', []], 'L4 dims with the policy; its clause holds vacuously');
  assert.deepEqual([by.L5.dimmed, by.L5.offSections, by.L5.state], [false, [], 'fail']);
  assert.deepEqual(by.L5.notes, [{ section: 'slos', text: 'no SLO to test', why: 'SLOs off — chaos in staging fails without it' }], 'the L5 head explains a failure that stems from SLOs off');
  assert.deepEqual(sectionNotes(by.L5.clauses, { slos: true }), [], 'no note while SLOs are on');
  assert.deepEqual(sectionNotes(by.L5.clauses, { slos: false, validation: false }, ['validation']), [{ section: 'slos', text: 'no SLO to test', why: 'SLOs off — chaos in staging fails without it' }], 'a section that already dims the slab is not repeated as a note');
  const stackHtml = buildStackHtml(stack);
  assert.ok(stackHtml.includes('<span class="build-slab-off build-slab-note" title="SLOs off — chaos in staging fails without it">no SLO to test</span>'));
  assert.equal((stackHtml.match(/build-slab-note/g) || []).length, 1, 'the note is on L5 only');
  const b = draft({ toggles: { ...defaultBuildState().toggles, slos: false }, result: { ...draft().result, summary: res.summary, adapted: res.adapted, todos: res.todos } });
  const l5 = buildSheetModel({ layerId: 'L5', build: b, library: LIBRARY, requirements: T2, stack, mode: 'edit' });
  assert.deepEqual(l5.notes, by.L5.notes);
  assert.ok(buildSheetHtml(l5).includes('title="SLOs off — chaos in staging fails without it">no SLO to test</span>'));
  const l1 = buildSheetModel({ layerId: 'L1', build: b, library: LIBRARY, requirements: T2, stack, mode: 'edit' });
  assert.equal(l1.switches[0].consequence, sw.consequence);
  assert.ok(buildSheetHtml(l1).includes('<span class="build-switch-consequence is-off">off — 4 clauses fail with it: availability SLO, latency SLO, every SLI under an SLO, chaos in staging</span>'));
  // SLOs at the other tiers: the expectation is the engine's set there too.
  for (const tier of ['tier-3', 'tier-1']) assert.deepEqual(sectionClauses('slos', REQUIREMENTS[tier]).map(c => c.id).sort(), engineFailing(tier, 'slos'), `slos at ${tier}`);
});

test('buildSheetModel: per layer the title and its question, the clauses with their state, the switches, the params, the lists read from the pack', () => {
  const sheet = (layerId, over = {}, b = draft()) => buildSheetModel({ layerId, build: b, library: LIBRARY, requirements: T2, mode: 'edit', ...over });
  for (const d of LAYER_DEFS) {
    const m = sheet(d.id);
    assert.equal(m.title, `${d.num} · ${d.name}`);
    assert.equal(m.question, LAYER_QUESTIONS[d.id]);
    assert.ok(m.question.endsWith('?'), `${d.id} asks a question`);
    assert.deepEqual(m.switches.map(s => s.id), LAYER_SWITCHES[d.id] || []);
  }
  assert.deepEqual(Object.values(LAYER_QUESTIONS).slice(0, 7), ['What should we measure?', 'Where does the telemetry flow?', 'What else do we collect?', 'How do we see it?', 'What happens when it breaks?', 'How do we prove it?', 'Who owns it?']);
  // L1: the clauses at the tier, the rolodex, the SLOs switch, the SLOs list.
  const l1 = sheet('L1');
  assert.deepEqual([l1.mode, l1.readOnly, l1.compose, l1.state, l1.stateText], ['edit', false, false, 'pass', '3 of 3 clauses pass']);
  assert.deepEqual(l1.clauses.map(c => [c.id, c.state]), [['L1.MUST.availability_slo', 'pass'], ['L1.MUST.latency_slo', 'pass'], ['L1.MUST.sli_covered_by_slo', 'pass']]);
  assert.equal(l1.rolodex.items.length, 10);
  assert.deepEqual(l1.rolodex.counts, { total: 10, selected: 7, selectable: 7, aboveTier: 3, library: 10, chosen: 2 });
  assert.deepEqual(l1.rolodex.allKeys, FIXTURE.provenance.toggles.slis);
  assert.equal(l1.rolodex.filterAll, false);
  assert.equal(sheet('L1', {}, draft({ rolodexAll: true })).rolodex.items.length, 56);
  assert.deepEqual(l1.switches.map(s => [s.id, s.on]), [['slos', true]]);
  assert.deepEqual(l1.lists.map(l => [l.id, l.items.length]), [['slos', 7]]);
  assert.equal(l1.lists[0].items[0].title, 'kafka_broker_availability_99_9');
  assert.deepEqual(l1.paramGroups, []);
  assert.equal(l1.todoCount, 0);
  // L2: no switch; the scrape jobs (from the prometheus receiver), the backends, exporters, storage; two param groups.
  const l2 = sheet('L2');
  assert.deepEqual([l2.state, l2.switches], ['placeholder', []]);
  assert.deepEqual(l2.lists.map(l => [l.id, l.items.length]), [['jobs', 2], ['receivers', 1], ['backends', 3], ['exporters', 3], ['storage', 3], ['otel', 1]]);
  assert.deepEqual(l2.lists[0].items.map(i => [i.title, i.desc, i.meta, i.scaffold]), [['kafka-broker', 'kafka-broker.kafka:9404', ['every 30s'], true], ['kafka-exporter', 'kafka-exporter.kafka:9308', ['every 30s'], true]]);
  assert.deepEqual(l2.lists[2].items[0], { id: 'BAK-01', title: 'metrics-prom', desc: 'prometheus 3.14 (metrics)', meta: ['declared 3.14', 'min 2.53', 'gating warn', 'http://prometheus:9090'], scaffold: true, symbol: 'telemetry.backends.metrics-prom' });
  assert.deepEqual(l2.paramGroups.map(g => [g.id, g.rows.length]), [['targets', 6], ['endpoints', 9]]);
  assert.equal(l2.todoCount, 10);
  assert.deepEqual(l2.todos, [], 'edit mode draws no todo (they are filled on Verify)');
  // L3: the Dashboards switch and its consequence; boards, views, rules.
  const l3 = sheet('L3');
  assert.deepEqual(l3.switches.map(s => [s.id, s.on, s.consequence]), [['dashboards', true, 'off is expected to drop 2 clauses of the tier: service overview board, SLO burn board']]);
  assert.deepEqual(l3.lists.map(l => [l.id, l.items.length]), [['boards', 4], ['views', 5], ['rules', 7]]);
  assert.deepEqual(l3.lists[0].items.map(i => i.title), ['orders-api-overview', 'orders-api-slo-burn', 'kafka-kafka-consumer-lag', 'kafka-kafka-throughput']);
  assert.deepEqual(l3.lists[0].items[0].meta, ['14 bindings']);
  // Dashboards off: the switch is off, the state is red, the slab is dimmed, the boards list is empty with the reason.
  const off = sheet('L3', {}, draft({ toggles: { ...defaultBuildState().toggles, dashboards: false }, result: { ...draft().result, summary: DASHBOARDS_OFF_SUMMARY } }));
  assert.deepEqual([off.switches[0].on, off.state, off.dimmed, off.offSections], [false, 'fail', true, ['dashboards']]);
  assert.deepEqual(off.clauses.filter(c => c.state === 'fail').map(c => c.id), ['L3.MUST.service_overview_dashboard', 'L3.MUST.slo_burn_dashboard']);
  // L4: Policy and Routes switches; the burn windows per SLO, the routes with their channels, the remediation; channel and runbook params.
  const l4 = sheet('L4');
  assert.deepEqual(l4.switches.map(s => [s.id, s.on, s.disabled]), [['policy', true, false], ['routes', true, false]]);
  assert.deepEqual(l4.lists.map(l => [l.id, l.items.length]), [['policy', 7], ['forecasts', 0], ['routes', 3], ['healing', 2]]);
  assert.deepEqual(l4.lists[0].items[0].meta, ['14× 5m/1h SEV1', '6× 30m/6h SEV2']);
  assert.deepEqual(l4.lists[2].items.map(i => [i.title, i.meta, i.scaffold]), [['SEV1 routes', ['msteams #orders-api-oncall', 'voice pagerduty://orders-api'], true], ['SEV2 routes', ['msteams #orders-api-oncall'], true], ['SEV3 routes', ['msteams #orders-api-team'], true]]);
  assert.deepEqual(l4.lists[3].items[0].meta, ['file://runbooks/broker-down.md', 'argo-workflow://restart-broker-with-quorum-check']);
  assert.deepEqual(l4.paramGroups.map(g => [g.id, g.rows.map(r => r.key)]), [['channels', ['oncall_channel', 'team_channel', 'pager_service', 'pager_service_low']], ['runbooks', ['runbook_dir']]]);
  const noSlos = sheet('L4', {}, draft({ toggles: { ...defaultBuildState().toggles, slos: false } }));
  assert.deepEqual([noSlos.switches[0].disabled, noSlos.switches[0].on], [true, false], 'policy is meaningless without SLOs: disabled, and off with them');
  // L5: the Validation switch; probes, chaos, baselines; the target params.
  const l5 = sheet('L5');
  assert.deepEqual(l5.switches.map(s => [s.id, s.consequence]), [['validation', 'off is expected to drop 2 clauses of the tier: synthetic probe, chaos in staging']]);
  assert.deepEqual(l5.lists.map(l => [l.id, l.items.length]), [['probes', 3], ['chaos', 2], ['baselines', 1]]);
  assert.deepEqual(l5.lists[0].items[0].meta, ['k6', 'kafka.kafka:9092', 'every 1m', 'SEV2']);
  assert.deepEqual(l5.lists[1].items[0].meta, ['chaos-mesh', 'on kafka-broker', 'pod-failure', 'monthly', 'staging', 'MTTD 90s']);
  assert.deepEqual(l5.paramGroups.map(g => [g.id, g.rows.map(r => r.key)]), [['targets', ['chaos_target', 'probe_target', 'kafka.bootstrap', 'kafka.broker_workload', 'kafka.consumer_workload', 'http-service.health_url']]]);
  // GOV: owners and imports, no switch, no param.
  const gov = sheet('GOV');
  assert.deepEqual([gov.state, gov.switches, gov.paramGroups, gov.owners], ['neutral', [], [], ['team-orders']]);
  assert.deepEqual(gov.lists.map(l => [l.id, l.items.map(i => i.title)]), [['imports', ['platform/std-budget-policy@2.1']]]);
  // Before the first result: the lists are empty and say why; nothing is invented.
  const cold = sheet('L2', {}, draft({ result: null }));
  assert.equal(cold.compiled, false);
  assert.ok(cold.lists.every(l => l.items.length === 0 && l.empty === 'compiled on the first instantiation — nothing to list yet'));
  assert.equal(cold.state, 'pending');
  // The step's stack, when given, is what the sheet reads (no second computation).
  const stack = buildCompileModel({ build: draft(), library: LIBRARY, clauses: T2 }).stack;
  assert.deepEqual(sheet('L2', { stack }).clauses, stack.slabs.find(s => s.id === 'L2').clauses);
  // A layer without a slab (L2X on a tier with no L2X clause and no artefact) still answers.
  const noX = buildSheetModel({ layerId: 'L2X', build: draft(), library: LIBRARY, requirements: T2.filter(c => c.dimension !== 'L2X'), mode: 'edit' });
  assert.deepEqual([noX.title, noX.state, noX.clauses, noX.lists[0].items], ['L2X · Extended', 'neutral', [], []]);
  // sheetLists on its own, and the modes.
  assert.equal(sheetLists('L1', null).length, 1);
  assert.deepEqual(['define', 'compile', 'verify', 'other'].map(sheetModeFor), ['preview', 'edit', 'verify', 'edit']);
});

test('the sheet is one component on the three steps: a preview on DEFINE (Compose in Compile →), editable on COMPILE, read-only with the todos on VERIFY', () => {
  const preview = buildSheetModel({ layerId: 'L1', build: draft({ step: 'define' }), library: LIBRARY, requirements: T2, mode: 'preview' });
  assert.deepEqual([preview.mode, preview.readOnly, preview.compose, preview.todos], ['preview', true, true, []]);
  assert.equal(preview.rolodex.items.length, 10, 'the candidates are the same items');
  const edit = buildSheetModel({ layerId: 'L4', build: draft({ step: 'compile' }), library: LIBRARY, requirements: T2, mode: 'edit' });
  assert.deepEqual([edit.readOnly, edit.compose, edit.todos, edit.todoCount], [false, false, [], 5]);
  const verify = buildSheetModel({ layerId: 'L4', build: draft({ step: 'verify' }), library: LIBRARY, requirements: T2, mode: 'verify' });
  assert.deepEqual([verify.readOnly, verify.compose], [true, false]);
  assert.deepEqual(verify.todos.map(t => t.path), ['alerting.routes[0]', 'alerting.routes[1]', 'alerting.routes[2]', 'remediation[0]', 'remediation[1]']);
  assert.deepEqual(verify.todos[0].params.map(p => p.key), ['oncall_channel', 'pager_service']);
  assert.equal(verify.todos[3].manual, true, 'a runbook to write: no param fills it');
  const l2v = buildSheetModel({ layerId: 'L2', build: draft(), library: LIBRARY, requirements: T2, mode: 'verify' });
  assert.equal(l2v.todos.length, 10);
  assert.ok(l2v.todos.some(t => t.path === 'telemetry.backends.metrics-prom' && t.params.map(p => p.key).join() === 'prometheus_version,metrics_endpoint'));
  // Filling a placeholder takes its todo away on the sheet as on the slab.
  const filled = draft({ result: { ...draft().result, todos: FIXTURE.todos.filter(t => t.path !== 'alerting.routes[2]') } });
  assert.equal(buildSheetModel({ layerId: 'L4', build: filled, library: LIBRARY, requirements: T2, mode: 'verify' }).todos.length, 4);
});

test('renderBuildSheet draws the dialog headlessly: the ARIA, the title and question, the clause rows, the rolodex cards, the switches, the params, the todos — per mode', () => {
  const html = (layerId, mode = 'edit', b = draft()) => { const c = stubContainer(); renderBuildSheet(c, buildSheetModel({ layerId, build: b, library: LIBRARY, requirements: T2, mode }), { build: {} }); return c.innerHTML; };
  const l1 = html('L1');
  assert.ok(l1.includes('<div class="build-sheet-scrim" data-close aria-hidden="true"></div>'));
  assert.ok(l1.includes('<aside class="build-sheet is-edit is-pass" role="dialog" aria-modal="false" aria-labelledby="build-sheet-title" aria-describedby="build-sheet-question" data-layer="L1" data-mode="edit" tabindex="-1">'));
  assert.ok(l1.includes('<h2 class="build-sheet-title" id="build-sheet-title">L1 · Contract</h2>'));
  assert.ok(l1.includes('<p class="build-sheet-question" id="build-sheet-question">What should we measure?</p>'));
  assert.ok(l1.includes('class="build-sheet-close" data-close aria-label="Close the layer sheet (Esc)"'));
  assert.ok(l1.includes('Clauses at tier-2 <span class="build-sheet-count">3</span>'));
  assert.equal((l1.match(/<li class="build-rail-clause is-pass"/g) || []).length, 3, 'the clause rows are the shared atom');
  // The rolodex: ten cards, the current-tier objective large, the other tiers muted, a switch each; the above-tier one disabled with the reason.
  assert.equal((l1.match(/class="build-rolo-card/g) || []).length, 10);
  assert.ok(l1.includes('<div class="build-rolodex-track" role="group" aria-roledescription="carousel" aria-label="SLI cards — arrow keys move" tabindex="0" data-scroll-key="rolodex:L1">'));
  // The scroll offsets rerenderBuild preserves are keyed per layer: what L1's body scrolled to is not
  // restored on L3's body, so a newly opened layer starts at its top (measured: it opened pre-scrolled).
  const scrollKeys = (h) => [...h.matchAll(/data-scroll-key="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(scrollKeys(l1), ['sheet:L1', 'rolodex:L1']);
  assert.deepEqual(scrollKeys(html('L3')), ['sheet:L3']);
  assert.ok(!scrollKeys(l1).some(k => scrollKeys(html('L3')).includes(k)), 'no scroll key shared between two layers\' sheets');
  assert.deepEqual(scrollKeys(html('L1', 'preview')), ['sheet:L1', 'rolodex:L1'], 'the same layer keeps its key across modes and re-renders');
  assert.ok(l1.includes('<span class="build-rolo-id">broker_availability</span>') && l1.includes('<code>up</code>'));
  assert.ok(l1.includes('<b>99.9%</b><span>over 30d · at tier-2</span>'));
  assert.ok(l1.includes('class="is-muted" title="tier-3: 99% over 30d">tier-3 <b>99%</b> 30d</span>'));
  assert.ok(l1.includes('role="switch" class="build-switch" aria-checked="true" aria-label="broker_availability of Apache Kafka — remove from the pack" data-focus-key="sli:kafka:broker_availability" data-sli="kafka_broker_availability" data-entry="kafka" data-sli-id="broker_availability" data-selected="1" data-entry-selected="1"'));
  assert.ok(l1.includes('aria-label="controller_election_rate of Apache Kafka — needs tier-1" disabled aria-disabled="true" title="needs tier-1 — this SLI is above the tier"'));
  assert.ok(l1.includes('<b class="build-rolo-needs">needs tier-1</b><span>this SLI is above the tier — switch the tier to add it</span>'));
  assert.ok(l1.includes('data-rolodex-all="0"') && l1.includes('show every product'));
  assert.ok(l1.includes('1 / 10'));
  // The SLOs switch with its consequence in one line.
  assert.ok(l1.includes('role="switch" class="build-switch" aria-checked="true" aria-label="SLOs section" data-focus-key="toggle:slos" data-toggle="slos"'));
  assert.ok(l1.includes('off is expected to drop 4 clauses of the tier: availability SLO, latency SLO, every SLI under an SLO, chaos in staging'));
  assert.ok(!l1.includes('data-compose'), 'no compose action on COMPILE');
  // Every product: a foreign card is dashed, its switch says it selects the product.
  const all = html('L1', 'edit', draft({ rolodexAll: true }));
  assert.equal((all.match(/class="build-rolo-card/g) || []).length, 56);
  assert.ok(all.includes('aria-label="qmgr_process_up of IBM MQ — add to the pack (selects IBM MQ too)" data-focus-key="sli:ibm-mq:qmgr_process_up" data-sli="ibm_mq_qmgr_process_up" data-entry="ibm-mq" data-sli-id="qmgr_process_up" data-selected="0" data-entry-selected="0"'));
  assert.ok(all.includes('class="build-rolo-card is-foreign"') && all.includes('not selected yet'));
  // L2: no switch, the param inputs editable with sheet focus keys, the lists.
  const l2 = html('L2');
  assert.ok(!l2.includes('role="switch"'));
  assert.ok(l2.includes('data-focus-key="param:kafka.broker_targets@L2/sheet"') && l2.includes('data-focus-key="param:prometheus_version@L2/sheet"'));
  assert.ok(l2.includes('Scrape jobs <span class="build-sheet-count">2</span>') && l2.includes('<span class="build-sheet-item-title">kafka-broker</span>') && l2.includes('<span class="build-sheet-item-desc">kafka-broker.kafka:9404</span>'));
  assert.ok(l2.includes('<span class="build-sheet-scaffold">scaffold</span>'));
  assert.ok(l2.includes('10 todos on this layer — the placeholders are filled on Verify'));
  // L3 with dashboards off: the switch reads off and the consequence is red.
  const off = html('L3', 'edit', draft({ toggles: { ...defaultBuildState().toggles, dashboards: false }, result: { ...draft().result, summary: DASHBOARDS_OFF_SUMMARY } }));
  assert.ok(off.includes('class="build-sheet is-edit is-fail is-dimmed"') && off.includes('<span class="build-slab-off">dashboards off</span>'));
  assert.ok(off.includes('aria-checked="false" aria-label="Dashboards section"'));
  assert.ok(off.includes('<span class="build-switch-consequence is-off">off — 2 clauses fail with it: service overview board, SLO burn board</span>'), 'off and evaluated: the engine\'s failing set, not a prediction');
  assert.equal((off.match(/<li class="build-rail-clause is-fail"/g) || []).length, 2);
  // L4: two switches, the channel params, the routes list.
  const l4 = html('L4');
  assert.ok(l4.includes('data-toggle="policy"') && l4.includes('data-toggle="routes"'));
  assert.ok(l4.includes('Channels <span class="build-sheet-count">4</span>') && l4.includes('data-focus-key="param:oncall_channel@L4/sheet"'));
  assert.ok(l4.includes('<span class="build-sheet-item-title">SEV1 routes</span>') && l4.includes('<span>voice pagerduty://orders-api</span>'));
  // Preview (DEFINE): every switch disabled, the params read-only, the compose action present.
  const pv = html('L1', 'preview');
  assert.ok(pv.includes('data-mode="preview"') && pv.includes('<button type="button" class="mcp-refresh-btn build-sheet-compose-btn" data-compose>Compose in Compile'));
  // Every add / remove and section switch is disabled; only the "show every product" filter (browsing) stays live.
  assert.equal((pv.match(/role="switch"/g) || []).length - 1, (pv.match(/role="switch"[^>]*\bdisabled\b/g) || []).length, 'nothing flips in a preview');
  assert.ok(!/data-rolodex-all="0"[^>]*\bdisabled\b/.test(pv) && !/\bdisabled\b[^>]*data-rolodex-all/.test(pv), 'the filter stays live');
  const pv2 = html('L2', 'preview');
  assert.ok(pv2.includes('class="build-param build-param-read is-placeholder" data-param="kafka.broker_targets"') && pv2.includes('<code class="build-param-value">kafka-broker.kafka:9404</code>'));
  assert.ok(!pv2.includes('build-param-input'), 'a preview has no input');
  // Verify: read-only options, the todos with their inline inputs keyed by sheet and todo path.
  const vf = html('L4', 'verify');
  assert.ok(vf.includes('data-mode="verify"') && vf.includes('Read-only on Verify'));
  assert.ok(vf.includes('Todos on this layer <span class="build-sheet-count">5</span>'));
  assert.ok(vf.includes('data-todo="alerting.routes[0]"') && vf.includes('data-focus-key="param:oncall_channel@L4/sheet/alerting.routes[0]"'));
  assert.ok(vf.includes('no parameter fills this one'));
  assert.ok(!vf.includes('data-compose'));
  // GOV: owners and imports, read-only, no switch.
  const gov = html('GOV');
  assert.ok(gov.includes('L2X') === false && gov.includes('GOV · Governance') && gov.includes('Who owns it?') && gov.includes('<div class="build-sheet-owners"><span>team-orders</span></div>') && gov.includes('platform/std-budget-policy@2.1'));
  assert.ok(!gov.includes('role="switch"'));
  // Escaping at the seam: a hostile clause description and owner never become markup.
  const hostile = [{ id: 'L1.MUST.x', dimension: 'L1', severity: 'MUST', minTier: 'tier-3', description: 'a <img src=x onerror="1"> clause' }];
  const hh = buildSheetHtml(buildSheetModel({ layerId: 'L1', build: draft({ owners: '<b>x</b>', result: null }), library: LIBRARY, requirements: hostile, mode: 'edit' }));
  assert.ok(!hh.includes('<img') && hh.includes('a &lt;img src=x onerror=&quot;1&quot;&gt; clause'));
  assert.ok(!buildSheetHtml(buildSheetModel({ layerId: 'GOV', build: draft({ owners: '<b>x</b>' }), library: LIBRARY, requirements: T2, mode: 'edit' })).includes('<b>x</b>'));
  // The atoms on their own.
  assert.equal(switchHtml({ on: false, label: 'x', focusKey: 'k', data: { a: '1' } }), '<button type="button" role="switch" class="build-switch" aria-checked="false" aria-label="x" data-focus-key="k" data-a="1"><span class="build-switch-knob" aria-hidden="true"></span></button>');
  assert.ok(switchHtml({ on: true, disabled: true, reason: 'why', label: 'x' }).includes(' disabled aria-disabled="true" title="why"'));
  assert.equal(evidenceDot(null), '');
  assert.ok(paramReadHtml({ key: 'k', label: 'K', effective: 'v', placeholder: true, atDefault: false }).includes('placeholder filled'));
});

test('the sheet’s handlers write through the existing actions: close (button, scrim, Esc), compose, the section switches, the rolodex switches, the filter', () => {
  const calls = [];
  const act = {
    closeSheet: () => calls.push(['close']), setStep: (s, o) => calls.push(['step', s, o]), setToggle: (id, on) => calls.push(['toggle', id, on]),
    setSli: (k, on, all) => calls.push(['sli', k, on, all.length]), addSli: (e, s) => calls.push(['add', e, s]), update: (p, o) => calls.push(['update', p, o]), setParam() {},
  };
  const model = buildSheetModel({ layerId: 'L1', build: draft(), library: LIBRARY, requirements: T2, mode: 'edit' });
  const closeBtn = fakeEl({}), scrim = fakeEl({}), sheet = fakeEl({}), compose = fakeEl({});
  const slosSwitch = fakeEl({ toggle: 'slos' }, { checked: 'true' });
  const disabledSwitch = fakeEl({ toggle: 'policy' }, { checked: 'false', disabled: true });
  const remove = fakeEl({ sli: 'kafka_broker_availability', entry: 'kafka', sliId: 'broker_availability', selected: '1', entrySelected: '1' });
  const add = fakeEl({ sli: 'kafka_fetch_latency_p99', entry: 'kafka', sliId: 'fetch_latency_p99', selected: '0', entrySelected: '1' });
  const foreign = fakeEl({ sli: 'ibm_mq_qmgr_process_up', entry: 'ibm-mq', sliId: 'qmgr_process_up', selected: '0', entrySelected: '0' });
  const above = fakeEl({ sli: 'kafka_controller_election_rate', entry: 'kafka', sliId: 'controller_election_rate', selected: '0', entrySelected: '1' }, { disabled: true });
  const filter = fakeEl({ rolodexAll: '0' });
  wireBuildSheet(fakeContainer({
    '[data-close]': [closeBtn, scrim], '.build-sheet': [sheet], '[data-compose]': [compose],
    '.build-switch[data-toggle]': [slosSwitch, disabledSwitch], '.build-switch[data-sli]': [remove, add, foreign, above], '.build-switch[data-rolodex-all]': [filter],
  }), model, { build: act });
  closeBtn.fire('click'); scrim.fire('click');
  sheet.fire('keydown', { key: 'Escape' }); sheet.fire('keydown', { key: 'Enter' });
  compose.fire('click');
  slosSwitch.fire('click'); disabledSwitch.fire('click');
  remove.fire('click'); add.fire('click'); foreign.fire('click'); above.fire('click');
  filter.fire('click', { currentTarget: filter });
  assert.deepEqual(calls, [
    ['close'], ['close'], ['close'],
    ['step', 'compile', { sheet: 'L1' }],
    ['toggle', 'slos', false],
    ['sli', 'kafka_broker_availability', false, 7], ['sli', 'kafka_fetch_latency_p99', true, 7], ['add', 'ibm-mq', 'qmgr_process_up'],
    ['update', { rolodexAll: true }, { rerender: true, reinstantiate: false }],
  ], 'a disabled switch does nothing; a foreign SLI goes through addSli; Enter is not Esc');
});

test('the slab head opens the layer’s sheet: aria-haspopup, the "+" affordance, the open layer marked; the inline clause list is gone', () => {
  const html = buildStackHtml(stackOf());
  assert.ok(html.includes('class="build-slab-edge" data-slab="L1" aria-haspopup="dialog" aria-expanded="false"'));
  assert.ok(html.includes('class="build-slab-add" data-slab="L1" aria-haspopup="dialog" aria-expanded="false" aria-label="Open L1 · Contract — What should we measure?"'));
  assert.ok(html.includes('<span class="build-slab-toggle">What should we measure?</span>'), 'the head invites with the question; the clause count is in the section count');
  assert.ok(!html.includes('build-slab-clauses'), 'the clauses live on the sheet');
  const open = buildStackHtml(stackOf({ expanded: { L2: true } }));
  assert.ok(open.includes('class="section build-slab is-placeholder is-expanded" data-layer="L2"') && open.includes('data-slab="L2" aria-haspopup="dialog" aria-expanded="true"'));
  // stackExpanded: the detail folds plus the open sheet's layer.
  assert.deepEqual(stackExpanded({ stackOpen: { 'L3/detail': true }, sheetOpen: 'L4' }), { 'L3/detail': true, L4: true });
  assert.deepEqual(stackExpanded({}), {});
  assert.equal(buildCompileModel({ build: draft({ sheetOpen: 'L5' }), library: LIBRARY, clauses: T2 }).stack.slabs.find(s => s.id === 'L5').expanded, true);
  // The handlers: a head or a '+' asks the controller to open that layer; the detail toggle keeps only the folds.
  const calls = [];
  const head = fakeEl({ slab: 'L2' }), plus = fakeEl({ slab: 'L5' }), detail = fakeEl({ detail: 'L3' });
  const m = stackOf();
  wireBuildStack(fakeContainer({ '.build-slab-edge, .build-slab-add': [head, plus], '.build-slab-detail': [detail] }), m, { build: { openSheet: (l) => calls.push(['open', l]), update: (p, o) => calls.push(['update', p, o]) } });
  head.fire('click'); plus.fire('click'); detail.fire('click');
  assert.deepEqual(calls, [['open', 'L2'], ['open', 'L5'], ['update', { stackOpen: { 'L3/detail': true } }, { rerender: true, reinstantiate: false }]]);
  // Focus keys on a sheet fall back to the sheet first, then the slab.
  assert.deepEqual(sheetFocusSuffix('L4'), 'L4/sheet');
  assert.deepEqual(sheetFocusSuffix('L4', 'alerting.routes[0]'), 'L4/sheet/alerting.routes[0]');
  assert.deepEqual(focusFallbackSelectors('param:oncall_channel@L4/sheet'), ['.build-sheet .build-param-input', '.build-sheet-close', '.build-slab[data-layer="L4"] .build-param-input', '.build-slab[data-layer="L4"] .build-slab-edge']);
  assert.deepEqual(focusFallbackSelectors('param:oncall_channel@L4/sheet/alerting.routes[0]')[0], '.build-sheet .build-param-input');
  assert.deepEqual(focusFallbackSelectors('param:oncall_channel@L4/alerting.routes[0]'), ['.build-slab[data-layer="L4"] .build-param-input', '.build-slab[data-layer="L4"] .build-slab-edge'], 'a slab input is unchanged');
});

test('the summary and the sheet draw the same clause row: one function, so a failing clause reads alike in both', () => {
  const rowOf = (html, id) => { const m = html.match(new RegExp(`<li class="build-rail-clause is-\\w+" title="${id.replace(/\./g, '\\.')}[^"]*">[\\s\\S]*?</li>`)); return m && m[0]; };
  const offDraft = draft({ result: { ...draft().result, summary: DASHBOARDS_OFF_SUMMARY } });
  const summary = summaryHtml(buildDefinitionModel({ build: offDraft, library: LIBRARY, requirements: REQUIREMENTS }).summary);
  const sheet = buildSheetHtml(buildSheetModel({ layerId: 'L3', build: offDraft, library: LIBRARY, requirements: T2, mode: 'edit' }));
  for (const id of ['L3.MUST.service_overview_dashboard', 'L3.MUST.slo_burn_dashboard']) {
    const a = rowOf(summary, id), b = rowOf(sheet, id);
    assert.ok(a && b, `${id} drawn on both`);
    assert.equal(a, b, `${id}: the summary's row is the sheet's row`);
    assert.match(a, /is-fail/);
  }
  const l2 = buildSheetHtml(buildSheetModel({ layerId: 'L2', build: draft(), library: LIBRARY, requirements: T2, mode: 'edit' }));
  const ph = rowOf(l2, 'L2.MUST.metrics_exporter');
  assert.match(ph, /is-placeholder/);
  assert.match(ph, /<em>on \d+ placeholders?: [^<]+<\/em>/, 'a placeholder pass names its todos');
  // The one function, on its own: a failing clause with todos names them; escaping at the seam.
  const withTodos = clauseRowHtml({ id: 'L4.MUST.x', state: 'fail', severity: 'MUST', description: 'd', todos: ['alerting.routes[0]', 'a <b>'] });
  assert.ok(withTodos.includes('<em>alerting.routes[0], a &lt;b&gt;</em>') && !withTodos.includes('<b>'));
  assert.ok(!clauseRowHtml({ id: 'L1.MUST.y', state: 'pass', severity: 'MUST', description: 'd', todos: [] }).includes('<em>'));
});

test('the stylesheet carries the language: the translucent sheet with a solid fallback, the switch and thumb motion, reduced motion respected, both themes through tokens', () => {
  const sheet = cssRule('.build-sheet');
  assert.ok(sheet && /backdrop-filter:\s*blur\(20px\) saturate\(140%\)/.test(sheet), 'the sheet surface is translucent');
  assert.ok(/border-radius:\s*16px/.test(sheet), '16 px radius on the sheet');
  assert.ok(/color-mix\(in srgb, var\(--card\)/.test(sheet), 'the surface is the card colour, mixed — no new colour');
  assert.ok(/@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\) \{ \.build-sheet \{ background: var\(--card\); \} \}/.test(CSS_TEXT), 'a solid fallback where unsupported');
  assert.ok(/\.build-sheet\[data-layer="L4"\]\s*\{ --accent: var\(--L4\)/.test(CSS_TEXT), 'one accent per layer: the layer token');
  assert.match(cssRule('.build-seg-thumb'), /transition:\s*transform 200ms/, 'the thumb slides');
  assert.match(cssRule('.build-switch-knob'), /transition:\s*transform 200ms/, 'the knob slides');
  assert.ok(/\.build-switch\[aria-checked="true"\]\s*\{ background: var\(--accent, var\(--BLD\)\); \}/.test(CSS_TEXT), 'the on state is the layer accent');
  assert.match(cssRule('.build-rolodex-track'), /scroll-snap-type:\s*x mandatory/, 'the rolodex snaps');
  assert.match(cssRule('.build-rolo-card'), /scroll-snap-align:\s*center/);
  const reduced = CSS_TEXT.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g)?.find(b => b.includes('.build-sheet'));
  assert.ok(reduced, 'a reduced-motion block for the Build controls');
  for (const sel of ['.build-seg-thumb', '.build-switch-knob', '.build-rolo-card', '.build-sheet']) assert.ok(reduced.includes(sel), `${sel} respects reduced motion`);
  assert.ok(reduced.includes('scroll-behavior: auto'));
  // No colour literal beyond the theme tokens and the shadows' neutral rgba in the new block (both themes follow).
  const axis = CSS_TEXT.slice(CSS_TEXT.indexOf('==== The axis'));
  const literals = [...axis.matchAll(/#[0-9a-fA-F]{3,6}\b/g)].map(m => m[0]).filter(h => !['#fff', '#64748B', '#0891b2', '#db2777', '#0d9488'].includes(h));
  assert.deepEqual(literals, [], 'the axis styles use the tokens (white knobs, the Scaffold grey and the step accents\' fallbacks aside)');
  assert.ok(/\[data-theme="dark"\] \.build-sheet \{/.test(axis) && /\[data-theme="dark"\] \.build-chip\.is-selected/.test(axis), 'the dark theme adjusts the shadows and the chip fill');
});

// A document with only what the Tab trap reads: the dialogs (matched by attribute selector,
// [attr="v"] and :not([attr]) / :not([attr="v"]) only), the active element, one keydown listener.
function fakeDocument(dialogs) {
  const handlers = {};
  const matches = (el, sel) => (sel.match(/:not\(\[[^\]]+\]\)|\[[^\]]+\]/g) || []).every(part => {
    const neg = part.startsWith(':not(');
    const [, attr, , val] = /\[([\w-]+)(="([^"]*)")?\]/.exec(part);
    const has = el.attrs[attr] !== undefined && (val === undefined || el.attrs[attr] === val);
    return neg ? !has : has;
  });
  const doc = {
    activeElement: null,
    addEventListener: (t, fn) => { handlers[t] = fn; },
    querySelectorAll: (sel) => dialogs.filter(d => matches(d, sel)),
    tab: (shiftKey = false) => { let prevented = false; handlers.keydown({ key: 'Tab', shiftKey, preventDefault() { prevented = true; } }); return prevented; },
  };
  const focusable = (name) => ({ name, offsetParent: {}, focus() { doc.activeElement = this; } });
  const dialog = (attrs, names) => { const items = names.map(focusable); return { attrs, items, querySelectorAll: () => items, contains: (el) => items.includes(el), focus() { doc.activeElement = this; } }; };
  return { doc, dialog, focusable };
}

test('the Tab trap skips the non-modal layer sheet: Tab from the definition column walks on while a sheet is open, and a modal dialog still traps', () => {
  assert.equal(TRAPPED_DIALOGS, '[role="dialog"]:not([hidden]):not([aria-modal="false"])');
  // The sheet as the view draws it: role=dialog, aria-modal=false (the markup is asserted in the render test).
  const dialogs = [];
  const { doc, dialog, focusable } = fakeDocument(dialogs);
  const sheet = dialog({ role: 'dialog', 'aria-modal': 'false' }, ['Close the layer sheet (Esc)', 'SLOs section']);
  const about = dialog({ role: 'dialog', 'aria-modal': 'true' }, ['about-close', 'about-link']);
  const hiddenModal = dialog({ role: 'dialog', 'aria-modal': 'true', hidden: '' }, ['deploy-close']);
  dialogs.push(hiddenModal, sheet);
  installDialogFocusTrap(doc);
  const nameField = focusable('#build-name');
  doc.activeElement = nameField;
  assert.equal(doc.tab(), false, 'Tab from #build-name is not hijacked while only the sheet is open');
  assert.equal(doc.activeElement, nameField, 'focus stays where the browser will move it next (Owners)');
  doc.activeElement = sheet.items[1];
  assert.equal(doc.tab(), false, 'Tab from the sheet\'s last control leaves the sheet (to the slab heads)');
  assert.equal(doc.tab(true), false, 'Shift+Tab is not wrapped either');
  // A modal dialog (the About card) is still trapped: focus is pulled in and wraps.
  dialogs.push(about);
  doc.activeElement = nameField;
  assert.equal(doc.tab(), true);
  assert.equal(doc.activeElement, about.items[0], 'Tab from outside lands on the first focusable of the modal');
  doc.activeElement = about.items[1];
  assert.equal(doc.tab(), true);
  assert.equal(doc.activeElement, about.items[0], 'Tab from the last wraps to the first');
  doc.activeElement = about.items[0];
  assert.equal(doc.tab(true), true);
  assert.equal(doc.activeElement, about.items[1], 'Shift+Tab from the first wraps to the last');
  // A hidden modal (the deploy modal while closed) never traps.
  dialogs.pop();
  doc.activeElement = nameField;
  assert.equal(doc.tab(), false);
});

// A rolodex track with three cards: `smooth` says whether a smooth scrollTo moves it (host
// Chrome) or is cancelled (the desktop app's embedded pane, measured: every smooth scroll on
// the snap track ended at 0 while an instant one worked).
function fakeTrack({ smooth }) {
  const card = (i) => ({ offsetWidth: 340, offsetLeft: i * 352, classList: { toggle() {} }, setAttribute() {}, removeAttribute() {} });
  const cards = [0, 1, 2].map(card);
  const calls = [];
  const track = {
    scrollLeft: 0, clientWidth: 600, scrollWidth: 3 * 352, style: {}, handlers: {},
    addEventListener(t, fn) { this.handlers[t] = fn; },
    querySelectorAll: () => cards,
    scrollTo(o) { calls.push(o); if (smooth) this.scrollLeft = o.left; },
  };
  const nav = fakeEl({ nav: '1' });
  const counter = { textContent: '' };
  const container = { querySelector: (sel) => (sel === '.build-rolodex-track' ? track : sel === '.build-rolodex-counter' ? counter : null), querySelectorAll: (sel) => (sel === '.build-rolodex-nav' ? [nav] : []) };
  return { track, nav, counter, calls, container };
}

test('the rolodex moves one card by the buttons and the arrow keys — instantly, as a fallback, where the smooth scroll is cancelled', async () => {
  const wait = () => new Promise(r => setTimeout(r, SMOOTH_SCROLL_GRACE_MS + 60));
  // Host Chrome: the smooth scroll moves the track; nothing else is touched.
  const ok = fakeTrack({ smooth: true });
  wireRolodex(ok.container);
  ok.nav.fire('click');
  assert.deepEqual(ok.calls, [{ left: 352, behavior: 'smooth' }], 'one card = the card width plus the 12 px gap');
  await wait();
  assert.equal(ok.track.scrollLeft, 352);
  assert.deepEqual(Object.keys(ok.track.style), [], 'no instant override when the smooth scroll moved');
  ok.track.handlers.keydown({ key: 'ArrowRight', target: ok.track, preventDefault() {} });
  assert.equal(ok.track.scrollLeft, 704);
  ok.track.handlers.keydown({ key: 'Home', target: ok.track, preventDefault() {} });
  assert.equal(ok.track.scrollLeft, 0);
  ok.track.handlers.keydown({ key: 'End', target: ok.track, preventDefault() {} });
  assert.equal(ok.track.scrollLeft, ok.track.scrollWidth);
  ok.track.handlers.keydown({ key: 'ArrowRight', target: {}, preventDefault() {} });
  assert.equal(ok.calls.length, 4, 'a key pressed on a switch inside the track is the switch\'s');
  // The embedded pane: the smooth scroll is cancelled; after the grace period the track is set instantly with scroll-behavior auto, then restored.
  const stuck = fakeTrack({ smooth: false });
  wireRolodex(stuck.container);
  stuck.nav.fire('click');
  assert.equal(stuck.track.scrollLeft, 0, 'the smooth scroll did nothing');
  await wait();
  assert.equal(stuck.track.scrollLeft, 352, 'the fallback moved it one card');
  assert.equal(stuck.track.style.scrollBehavior, '', 'scroll-behavior was forced to auto for the write and restored');
  stuck.track.handlers.keydown({ key: 'ArrowLeft', target: stuck.track, preventDefault() {} });
  await wait();
  assert.equal(stuck.track.scrollLeft, 0);
  stuck.track.handlers.keydown({ key: 'ArrowLeft', target: stuck.track, preventDefault() {} });
  await wait();
  assert.equal(stuck.track.scrollLeft, 0, 'never below zero, and no write when the target is where the track already is');
  assert.equal(stuck.calls.length, 2, 'a scroll to the current offset is not issued');
});
