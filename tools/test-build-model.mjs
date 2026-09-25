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
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit as emitYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_VERSION } from './lib/validator.mjs';
import { evaluateConformance } from './lib/conformance.mjs';
import { adapt, applyEnvironmentOverlay } from './lib/adapter.mjs';
import { listTargets } from './lib/compile.mjs';
import { instantiatePack, libraryIndex, tierRequirements, validationSummary, SCAFFOLD_PARAMS, TIERS as ENGINE_TIERS, sloIdFor as engineSloIdFor } from './lib/library.mjs';
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
  sheetModeFor, stackExpanded, sheetFocusSuffix, LAYER_QUESTIONS, LAYER_SWITCHES, buildStatusLine,
  isSeeded, allSliKeys, selectedSliKeys, retargetOverrides, retargetSlisForEntries, effectiveOverrides, seedCardModel, customisedMap, WARNING_KINDS, SEEDED_NOTE,
  LEGACY_STEP, restoreBuildDraft, buildEditorModel, stackCardActions, BUILD_TABS, tabName,
} from '../studio/build-model.mjs';
import {
  OVERRIDE_FIELDS, SLO_WINDOWS, PROMQL_FIELDS, overrideFor, customisedFields, promqlEdited, effectiveSli, effectiveId, customEffective, slugifySliId,
  normalizeDraft, customFormModel, customDefFromDraft, sloIdFor,
} from '../studio/build-copies-model.mjs';
import {
  loadLibrary as loadLibraryApi, loadRequirements, loadTargets, instantiate, compilePreview, registerBuiltPack,
} from '../studio/build-api.mjs';
import { defaultBuildState, BUILD_PERSIST_FIELDS } from '../studio/state.mjs';
import { LAYER_DEFS, L4_SUBGROUPS } from '../studio/constants.mjs';
import { renderBuildDefine, rejectedCopies, instantiateErrorHtml } from '../studio/build-define-view.mjs';
import { renderBuildCompile } from '../studio/build-compile-view.mjs';
import { renderBuildVerify } from '../studio/build-verify-view.mjs';
import { warningKey, warningSli, buildReadiness, schemaErrorLayer } from '../studio/build-model.mjs';
import { renderBuildStack, buildStackHtml, wireBuildStack } from '../studio/build-stack-view.mjs';
import { renderBuildDefinition, buildDefinitionHtml, wireBuildDefinition, summaryHtml, seedCardHtml } from '../studio/build-definition-view.mjs';
import { renderBuildSheet, buildSheetHtml, wireBuildSheet, wireRolodex, SMOOTH_SCROLL_GRACE_MS } from '../studio/build-sheet-view.mjs';
import { artefactCardHtml } from '../studio/card-html.mjs';
import { revealTodo, clauseRowHtml, switchHtml, evidenceDot, paramRowHtml, paramLabelHtml } from '../studio/build-atoms.mjs';
import { installDialogFocusTrap, TRAPPED_DIALOGS } from '../studio/util.mjs';
import * as studioDirection from '../studio/sli-direction.mjs';
import * as engineDirection from './lib/good-when.mjs';

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
  name: 'orders-api', owners: 'team-orders', environment: 'prod', tier: 'tier-2', entries: ['kafka', 'http-service'], seeded: true,
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
  // The seed and the copies on the fixture: nothing customised, every SLI from its entry, none above the tier.
  assert.deepEqual(Object.keys(FIXTURE.provenance.slis), FIXTURE.canonical.spec.slis.map(x => x.id));
  assert.ok(Object.values(FIXTURE.provenance.slis).every(p => p.customised.length === 0 && p.custom === false && p.aboveTier === false));
  assert.deepEqual([FIXTURE.provenance.overrides, FIXTURE.provenance.custom], [{}, []]);
  assert.equal(FIXTURE.provenance.slis.kafka_broker_availability.library.source, 'kafka@1.0.0');
  assert.deepEqual(customisedMap(FIXTURE), {});
  // The index carries the templates the Customise face shows as the defaults.
  const kafkaRow = INDEX.entries.find(e => e.id === 'kafka');
  assert.equal(kafkaRow.slis.find(x => x.id === 'produce_latency_p99').threshold, 0.1);
  assert.match(kafkaRow.slis.find(x => x.id === 'produce_latency_p99').query, /^max\(kafka_network_requestmetrics_totaltimems/);
  assert.match(kafkaRow.slis.find(x => x.id === 'broker_availability').good, /\$\{broker_job\}/, 'the template, params unresolved');
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

test('a step is reachable when the previous step\'s inputs are valid — and COMPILE only once the pack is seeded', () => {
  const empty = defaultBuildState();
  assert.equal(defineValid(empty), false);
  assert.equal(empty.seeded, false, 'a fresh draft is not seeded');
  assert.deepEqual(buildStepReachability(empty), { define: true, compile: false, verify: false });
  const selected = draft({ result: null });
  assert.equal(defineValid(selected), true);
  assert.deepEqual(buildStepReachability(selected), { define: true, compile: true, verify: false }, 'no result yet: Verify stays locked');
  // The seed: a valid definition that was not seeded keeps COMPILE locked (the wizard stage), with or without a pack.
  assert.deepEqual(buildStepReachability(draft({ seeded: false })), { define: true, compile: false, verify: false }, 'not seeded: COMPILE locked even with a pack');
  assert.equal(clampStep(draft({ seeded: false }), 'verify'), 'define');
  assert.equal(isSeeded(draft()), true);
  assert.equal(isSeeded(draft({ seeded: false })), false);
  assert.equal(isSeeded(null), false);
  // A draft persisted before the seed existed (no field) on COMPILE or VERIFY counts as seeded; on DEFINE it does not.
  const legacy = (step) => { const b = draft({ step }); delete b.seeded; return b; };
  assert.equal(isSeeded(legacy('compile')), true);
  assert.equal(isSeeded(legacy('verify')), true);
  assert.equal(isSeeded(legacy('validate')), true, 'a legacy step id counts too');
  assert.equal(isSeeded(legacy('define')), false);
  assert.deepEqual(buildStepReachability(legacy('verify')), { define: true, compile: true, verify: true });
  assert.equal(clampStep(legacy('verify'), 'verify'), 'verify', 'clampStep tolerates the missing field');
  assert.equal(clampStep(legacy('compile'), 'compile'), 'compile');
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
    overrides: {}, custom: [],
  });
  // The copies: the overrides' edited fields (own, non-empty), filtered to the selection when the library is known; the custom SLIs copied.
  const ov = { kafka_produce_latency_p99: { objective: 0.995, window: '' }, kafka_controller_election_rate: { objective: 0.9 }, nope: { window: '7d' } };
  const def = { id: 'checkout_success', type: 'ratio', good: 'a', total: 'b', objective: 0.999, window: '30d' };
  assert.deepEqual(effectiveOverrides(draft({ overrides: ov })), { kafka_produce_latency_p99: { objective: 0.995 }, kafka_controller_election_rate: { objective: 0.9 }, nope: { window: '7d' } }, 'without the library: every override with a value');
  assert.deepEqual(effectiveOverrides(draft({ overrides: ov }), LIBRARY), { kafka_produce_latency_p99: { objective: 0.995 } }, 'with the library: the selection only (the tier-1 SLI is not in the pack at tier-2 defaults; nope is no SLI)');
  assert.deepEqual(effectiveOverrides(draft({ overrides: ov, slis: [...FIXTURE.provenance.toggles.slis, 'kafka_controller_election_rate'] }), LIBRARY), { kafka_produce_latency_p99: { objective: 0.995 }, kafka_controller_election_rate: { objective: 0.9 } }, 'an above-tier SLI in the explicit list takes its override along');
  const withCopies = instantiateBody(draft({ overrides: ov, custom: [def] }), LIBRARY);
  assert.deepEqual(withCopies.overrides, { kafka_produce_latency_p99: { objective: 0.995 } });
  assert.deepEqual(withCopies.custom, [def]);
  assert.notEqual(withCopies.custom[0], def, 'a copy, not the draft\'s object');
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
  // The input lives on the step's Service substep (the 2026-09 UX review moved the form out of the column): its value is escaped there too.
  assert.ok(container.innerHTML.includes(`value="${'1&lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;'}"`), 'the input value is escaped too');
  // The column is the progress summary: it says what is still needed, the name escaped.
  const def = stubContainer();
  renderBuildDefinition(def, buildDefinitionModel({ build: draft({ name: payload }), library: LIBRARY, requirements: REQUIREMENTS }), { build: {} });
  assert.ok(!def.innerHTML.includes('<img'));
  assert.ok(def.innerHTML.includes('Still needed: a service name that slugs'), 'the column says what is still needed');
});

// ---------------------------------------------------------------------------
// COMPILE
// ---------------------------------------------------------------------------

test('buildCompileModel: an SLI above the tier is not a default but stays selectable, with the objective of its own profile; objective and window per tier; composed keys', () => {
  const m = buildCompileModel({ build: draft(), library: LIBRARY });
  assert.equal(m.composed, true);
  assert.deepEqual(m.groups.map(g => g.id), ['kafka', 'http-service']);
  const kafka = m.groups[0];
  assert.deepEqual(kafka.slis.map(s => s.key), ['kafka_broker_availability', 'kafka_consumer_group_lag_seconds', 'kafka_partition_replica_health', 'kafka_produce_latency_p99', 'kafka_fetch_latency_p99', 'kafka_controller_election_rate']);
  const election = kafka.slis.find(s => s.id === 'controller_election_rate');
  assert.equal(election.reachable, false, 'not a default at tier-2');
  assert.equal(election.aboveTier, true);
  assert.equal(election.checked, false, 'the defaults do not include it');
  assert.equal(election.minTier, 'tier-1');
  assert.equal(election.objectiveLabel, '99%', 'the objective it would start with — the tier-1 profile\'s, never "needs tier-1"');
  assert.equal(election.objective, 0.99);
  assert.equal(election.window, '7d');
  const ba = kafka.slis.find(s => s.id === 'broker_availability');
  assert.equal(ba.checked, true);
  assert.equal(ba.objective, 0.999);
  assert.equal(ba.objectiveLabel, '99.9%');
  assert.equal(ba.window, '30d');
  const lag = kafka.slis.find(s => s.id === 'consumer_group_lag_seconds');
  assert.equal(lag.objectiveLabel, '99%');
  assert.equal(lag.window, '7d');
  assert.deepEqual(m.counts, { total: 10, reachable: 7, checked: 7, aboveTier: 0, custom: 0, customised: 0 });
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
  assert.equal(t3.groups[0].slis.find(s => s.id === 'partition_replica_health').objectiveLabel, '99.9%', 'above tier-3, yet the library declares a tier-3 value for it (0.999): that is what it starts with — the walk only steps up where nothing is declared');
  assert.equal(t3.groups[0].slis.find(s => s.id === 'partition_replica_health').aboveTier, true);
  assert.deepEqual(t3.counts, { total: 10, reachable: 3, checked: 3, aboveTier: 0, custom: 0, customised: 0 });
  const t1 = buildCompileModel({ build: draft({ tier: 'tier-1' }), library: LIBRARY });
  assert.equal(t1.groups[0].slis.find(s => s.id === 'controller_election_rate').reachable, true);
  assert.deepEqual(t1.counts, { total: 10, reachable: 10, checked: 10, aboveTier: 0, custom: 0, customised: 0 });

  // An explicit selection unticks — and may tick an SLI above the tier: it counts, as "from a higher tier".
  const partial = buildCompileModel({ build: draft({ slis: ['kafka_broker_availability', 'kafka_controller_election_rate'] }), library: LIBRARY });
  assert.deepEqual(partial.counts, { total: 10, reachable: 7, checked: 2, aboveTier: 1, custom: 0, customised: 0 });
  assert.equal(partial.groups[0].slis.find(s => s.id === 'controller_election_rate').checked, true, 'above the tier and asked for: in the pack');
  // An override shows on the row; a custom SLI counts and keeps the pack non-empty on its own.
  const ov = buildCompileModel({ build: draft({ overrides: { kafka_produce_latency_p99: { objective: 0.995, window: '7d' } } }), library: LIBRARY });
  const pl = ov.groups[0].slis.find(s => s.id === 'produce_latency_p99');
  assert.deepEqual([pl.objectiveLabel, pl.window, pl.customised, ov.counts.customised], ['99.5%', '7d', ['objective', 'window'], 1]);
  const onlyCustom = buildCompileModel({ build: draft({ slis: [], custom: [{ id: 'checkout_success', type: 'ratio', good: 'a', total: 'b', objective: 0.999, window: '30d' }] }), library: LIBRARY });
  assert.deepEqual([onlyCustom.atLeastOne, onlyCustom.counts.custom, onlyCustom.counts.checked], [true, 1, 0]);
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

test('retargetSlis: an explicit SLI list keeps every SLI of the selected entries across a tier change (the tier is a seed), takes in what the new tier unlocks, drops a deselected entry\'s keys, never collapses to null', () => {
  const all1 = reachableSliKeys(draft({ tier: 'tier-1' }), LIBRARY);
  const all2 = reachableSliKeys(draft({ tier: 'tier-2' }), LIBRARY);
  assert.equal(all1.length, 10);
  assert.equal(all2.length, 7);
  assert.ok(all1.includes('kafka_controller_election_rate') && !all2.includes('kafka_controller_election_rate'));
  assert.deepEqual(reachableSliKeys(draft({ tier: 'tier-3', entries: ['kafka'] }), LIBRARY), ['broker_availability', 'consumer_group_lag_seconds'], 'a single entry keeps bare ids');
  assert.deepEqual(allSliKeys(draft(), LIBRARY), all1, 'every SLI of the two entries: the tier-1 set, at any tier');
  assert.deepEqual(selectedSliKeys(draft(), LIBRARY), all2, 'the defaults at tier-2');
  assert.deepEqual(selectedSliKeys(draft({ slis: ['kafka_controller_election_rate', 'nope'] }), LIBRARY), ['kafka_controller_election_rate'], 'an explicit list, known keys only');
  // tier-1, partition_replica_health unticked: an explicit list of 9 that includes controller_election_rate (a tier-1 SLI)
  const untick = all1.filter(k => k !== 'kafka_partition_replica_health');
  // lowering to tier-2 keeps controller_election_rate (the user has it; it now reads "from the tier-1 profile") and keeps the untick
  const lowered = retargetSlis(draft({ tier: 'tier-2', slis: untick }), LIBRARY, 'tier-1');
  assert.deepEqual([...lowered].sort(), [...untick].sort(), 'nothing the user has is dropped by a tier change');
  assert.ok(lowered.includes('kafka_controller_election_rate'));
  assert.deepEqual(instantiateBody(draft({ tier: 'tier-2', slis: lowered })).toggles.slis, lowered, 'the body carries it: the engine takes any SLI at any tier');
  // raising back to tier-1: nothing new to unlock (every key is already there), the untick still stands
  const raised = retargetSlis(draft({ tier: 'tier-1', slis: lowered }), LIBRARY, 'tier-2');
  assert.deepEqual([...raised].sort(), [...untick].sort());
  // what the new tier unlocks comes in ticked: from tier-2 defaults minus one, raising to tier-1 adds the three tier-1 SLIs
  const raisedFromDefaults = retargetSlis(draft({ tier: 'tier-1', slis: all2.filter(k => k !== 'kafka_partition_replica_health') }), LIBRARY, 'tier-2');
  assert.deepEqual([...raisedFromDefaults].sort(), all1.filter(k => k !== 'kafka_partition_replica_health').sort());
  // an explicit list stays explicit, even when it equals the new tier's defaults: collapsed to null at tier-1, a
  // round trip tier-2 → tier-1 → tier-2 lost the above-tier pick (the tier-2 defaults have no controller_election_rate)
  assert.deepEqual([...retargetSlis(draft({ tier: 'tier-1', slis: [...lowered, 'kafka_partition_replica_health'] }), LIBRARY, 'tier-2')].sort(), [...all1].sort());
  const picked = [...all2, 'kafka_controller_election_rate'];
  const up = retargetSlis(draft({ tier: 'tier-1', slis: picked }), LIBRARY, 'tier-2');
  assert.deepEqual([...up].sort(), [...all1].sort(), 'raised: the three tier-1 SLIs are in (one was already picked)');
  const down = retargetSlis(draft({ tier: 'tier-2', slis: up }), LIBRARY, 'tier-1');
  assert.ok(down.includes('kafka_controller_election_rate'), 'lowered again: the pick is still there');
  assert.deepEqual([...down].sort(), [...all1].sort(), 'and so are the tier-1 defaults that came in — from the tier-1 profile now; the user switches them off if unwanted');
  assert.equal(retargetSlis(draft({ slis: null }), LIBRARY, 'tier-1'), null, 'the defaults stay the defaults (they follow the tier by themselves)');
  // no previous tier (a draft restored from an older session): a key of a deselected entry is dropped, an above-tier key stays, nothing is added
  assert.deepEqual(retargetSlis(draft({ tier: 'tier-2', slis: ['kafka_broker_availability', 'kafka_controller_election_rate', 'ibm_mq_qmgr_process_up'] }), LIBRARY), ['kafka_broker_availability', 'kafka_controller_election_rate']);
  assert.deepEqual(retargetSlis(draft({ entries: ['kafka'], slis: ['kafka_broker_availability', 'http_service_availability'] }), LIBRARY), [], 'the keys of a composition that is gone are not this composition\'s (re-keyed by the caller)');
});

test('retargetSlisForEntries: toggling an entry keeps the other entries\' picks — an above-tier add and an un-tick survive an entry leaving and coming back; a joining entry brings its defaults; nulling only when nothing user-made is left', () => {
  const all2 = reachableSliKeys(draft({ tier: 'tier-2' }), LIBRARY);
  // The measured case: kafka + http-service, controller_election_rate (tier-1) picked on kafka, http_service_latency_p99 un-ticked.
  const picks = [...all2.filter(k => k !== 'http_service_latency_p99'), 'kafka_controller_election_rate'];
  // http-service leaves: kafka's picks stay, re-keyed to the bare ids; http-service's go with it.
  const kafkaOnly = retargetSlisForEntries({ build: draft({ entries: ['kafka'], slis: picks }), library: LIBRARY }, ['kafka', 'http-service']);
  assert.deepEqual(kafkaOnly, ['broker_availability', 'consumer_group_lag_seconds', 'partition_replica_health', 'produce_latency_p99', 'fetch_latency_p99', 'controller_election_rate'], 'the above-tier pick survives; the keys are bare');
  // http-service comes back: it brings the tier's defaults of its own (both SLIs — the un-tick was its and left with it), kafka's pick is still there.
  const back = retargetSlisForEntries({ build: draft({ entries: ['kafka', 'http-service'], slis: kafkaOnly }), library: LIBRARY }, ['kafka']);
  assert.deepEqual([...back].sort(), [...all2, 'kafka_controller_election_rate'].sort());
  // A third entry joins with the picks in place: the pick and the un-tick on the other two survive, the newcomer's defaults come in.
  const three = retargetSlisForEntries({ build: draft({ entries: ['kafka', 'http-service', 'prometheus'], slis: picks }), library: LIBRARY }, ['kafka', 'http-service']);
  assert.ok(three.includes('kafka_controller_election_rate') && !three.includes('http_service_latency_p99'), 'A\'s picks survive B joining');
  const promDefaults = reachableSliKeys(draft({ entries: ['prometheus'] }), LIBRARY).map(k => `prometheus_${k}`);
  assert.ok(promDefaults.length >= 2 && promDefaults.every(k => three.includes(k)), 'the joining entry\'s tier defaults are ticked');
  assert.ok(!three.some(k => k.startsWith('prometheus_') && !promDefaults.includes(k)), 'and only those');
  // The third entry leaves again: back to exactly the picks.
  assert.deepEqual([...retargetSlisForEntries({ build: draft({ entries: ['kafka', 'http-service'], slis: three }), library: LIBRARY }, ['kafka', 'http-service', 'prometheus'])].sort(), [...picks].sort());
  // Nothing user-made left: the list collapses to the defaults (null); a never-edited list stays null.
  assert.equal(retargetSlisForEntries({ build: draft({ entries: ['kafka', 'http-service'], slis: ['broker_availability', 'consumer_group_lag_seconds', 'partition_replica_health', 'produce_latency_p99', 'fetch_latency_p99'] }), library: LIBRARY }, ['kafka']), null, 'kafka\'s defaults plus http-service\'s defaults = the defaults');
  assert.equal(retargetSlisForEntries({ build: draft({ entries: ['kafka'], slis: null }), library: LIBRARY }, ['kafka', 'http-service']), null);
  // Pure.
  const b = draft({ entries: ['kafka'], slis: picks });
  retargetSlisForEntries({ build: b, library: LIBRARY }, ['kafka', 'http-service']);
  assert.deepEqual(b.slis, picks);
});

test('retargetOverrides: an override follows its SLI across a composition change — re-keyed when a second entry joins, dropped with an entry that leaves, an unknown key kept', () => {
  // one entry → two: the bare key is prefixed
  const one = draft({ entries: ['kafka'], overrides: { broker_availability: { objective: 0.9999 }, produce_latency_p99: { window: '7d' } } });
  const two = { ...one, entries: ['kafka', 'http-service'] };
  assert.deepEqual(retargetOverrides({ build: two, library: LIBRARY }, ['kafka']), { kafka_broker_availability: { objective: 0.9999 }, kafka_produce_latency_p99: { window: '7d' } });
  // two → one: back to the bare key; the leaving entry's overrides go with it
  const both = draft({ overrides: { kafka_broker_availability: { objective: 0.9999 }, http_service_availability: { objective: 0.95 }, checkout_success: { objective: 0.9 } } });
  const kafkaOnly = { ...both, entries: ['kafka'] };
  assert.deepEqual(retargetOverrides({ build: kafkaOnly, library: LIBRARY }, ['kafka', 'http-service']), { broker_availability: { objective: 0.9999 }, checkout_success: { objective: 0.9 } }, 'the http-service override is dropped; a key of no entry (a custom SLI\'s) is kept as it is');
  // the same composition: unchanged
  assert.deepEqual(retargetOverrides({ build: both, library: LIBRARY }, ['kafka', 'http-service']), both.overrides);
  assert.deepEqual(retargetOverrides({ build: draft({ overrides: {} }), library: LIBRARY }, ['kafka']), {});
  // pure
  const before = JSON.stringify(both.overrides);
  retargetOverrides({ build: kafkaOnly, library: LIBRARY }, ['kafka', 'http-service']);
  assert.equal(JSON.stringify(both.overrides), before);
});

test('a usage error keeps the previous pack: the error is split per param, the row carries it, the views read stale, the hand-off is blocked', () => {
  const quote = 'param kafka.bootstrap: a value may not contain a double quote, a backslash or a control character (it is spliced verbatim into PromQL label matchers, scrape targets and endpoints)';
  const unknown = 'unknown param nope (known: bootstrap, broker_job)';
  assert.deepEqual(splitBuildErrors([quote, unknown]), {
    byParam: { 'kafka.bootstrap': 'a value may not contain a double quote, a backslash or a control character (it is spliced verbatim into PromQL label matchers, scrape targets and endpoints)' },
    byOverride: {}, byCustom: {},
    general: [unknown], paramCount: 1, count: 2,
  });
  assert.deepEqual(splitBuildErrors(null), { byParam: {}, byOverride: {}, byCustom: {}, general: [], paramCount: 0, count: 0 });
  // The copies' errors are keyed for their cards: `override <sli>.<field>: …` per field, `custom <id>[.<field>]: …`, `custom[i]…` under ''.
  const copies = splitBuildErrors(['override kafka_produce_latency_p99.window: the window is one of 7d | 28d | 30d | 90d', 'override kafka_produce_latency_p99.objective: the objective is a number in (0, 1)', 'custom checkout_success.good: the PromQL must be a non-empty string', 'custom checkout_success.id: declared twice in custom', 'custom[0].id: a slug of 2 to 63 characters is required', 'unknown SLI nope']);
  assert.deepEqual(copies.byOverride, { kafka_produce_latency_p99: { window: 'the window is one of 7d | 28d | 30d | 90d', objective: 'the objective is a number in (0, 1)' } });
  assert.deepEqual(copies.byCustom, { checkout_success: { good: 'the PromQL must be a non-empty string', id: 'declared twice in custom' }, '': { id: 'a slug of 2 to 63 characters is required' } });
  assert.deepEqual(copies.general, ['unknown SLI nope']);
  assert.equal(copies.count, 6);
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
  // A rejected customised value is named with the card to open — with the face closed, and with the sheet closed (the note said only "the last compilation failed"; measured live).
  const winErr = 'override kafka_produce_latency_p99.window: the window is one of 7d | 28d | 30d | 90d (the schema\'s SLO windows), got "30x"';
  const closed = copiesDraft({ error: [winErr], overrides: { kafka_produce_latency_p99: { objective: 0.995, window: '30x' } } });
  const compileNote = render(renderBuildCompile, buildCompileModel({ build: closed, library: LIBRARY, clauses: T2 }));
  assert.ok(compileNote.includes('The last compilation failed — the pack shown is the previous one.</strong> 1 customised value rejected — kafka_produce_latency_p99.window: open its card on L1 (the stack or the sheet), the field carries the reason</div>'), compileNote.match(/build-note-err[^<]*<strong>[^<]*<\/strong>[^<]*/)?.[0]);
  assert.ok(render(renderBuildDefine, buildDefineModel({ build: closed, library: LIBRARY, requirements: REQUIREMENTS })).includes('1 customised value rejected — kafka_produce_latency_p99.window: open its card'), 'DEFINE names it too');
  assert.deepEqual(rejectedCopies(splitBuildErrors([winErr, 'override kafka_produce_latency_p99.objective: x', 'custom checkout_success.good: y', 'custom checkout_success: z', 'custom[0].id: w'])), ['kafka_produce_latency_p99.window', 'kafka_produce_latency_p99.objective', 'custom checkout_success.good', 'custom checkout_success'], 'per field; a whole-SLI error once; the form\'s own (custom[i]) errors are the form\'s, not a card\'s');
  assert.ok(render(renderBuildCompile, buildCompileModel({ build: copiesDraft({ error: [winErr, 'override kafka_produce_latency_p99.objective: the objective is a number in (0, 1)'] }), library: LIBRARY, clauses: T2 })).includes('2 customised values rejected — kafka_produce_latency_p99.window, kafka_produce_latency_p99.objective: open their cards on L1 (the stack or the sheet)'));
  // The card carries the mark whether or not its face is open: is-error and a 'rejected: window' chip with the reason in its title.
  const closedItems = rolodexItems({ build: closed, library: LIBRARY });
  assert.deepEqual([closedItems.find(i => i.key === 'kafka_produce_latency_p99').errorFields, closedItems.find(i => i.key === 'kafka_produce_latency_p99').errors, closedItems.find(i => i.key === 'kafka_broker_availability').errorFields], [['window'], { window: 'the window is one of 7d | 28d | 30d | 90d (the schema\'s SLO windows), got "30x"' }, []]);
  const closedSheet = buildSheetHtml(buildSheetModel({ layerId: 'L1', build: closed, library: LIBRARY, requirements: T2, mode: 'edit' }));
  assert.ok(closedSheet.includes('class="build-rolo-card is-selected is-customised is-error" data-snap-card data-sli="kafka_produce_latency_p99"'), 'the face is closed: the card is still marked');
  assert.ok(closedSheet.includes('<span class="build-rolo-chip is-error" title="window: the window is one of 7d | 28d | 30d | 90d (the schema&#39;s SLO windows), got &quot;30x&quot;">rejected: window</span>') || closedSheet.includes('<span class="build-rolo-chip is-error" title="window: the window is one of 7d | 28d | 30d | 90d (the schema\'s SLO windows), got &quot;30x&quot;">rejected: window</span>'));
  const customErr = copiesDraft({ error: ['custom checkout_success.good: the PromQL must be a non-empty string'] });
  assert.ok(buildSheetHtml(buildSheetModel({ layerId: 'L1', build: customErr, library: LIBRARY, requirements: T2, mode: 'edit' })).includes('class="build-rolo-card is-selected is-custom is-error" data-snap-card data-sli="checkout_success"'), 'a custom SLI\'s card too');
  assert.ok(!buildSheetHtml(buildSheetModel({ layerId: 'L1', build: copiesDraft(), library: LIBRARY, requirements: T2, mode: 'edit' })).includes('is-error'), 'no error: no mark');
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
  assert.equal(s.status, 'meets the tier-2 rubric', 'the plain words for conformant (the 2026-09 review §4)');
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
  // The review's §1: Verify leads to "Open pack in Discover", and says the pack becomes the same kind of pack Discover inspects.
  assert.equal(m.continueLabel, 'Open pack in Discover with visible gaps');
  assert.match(m.readyText, /^The generated pack becomes the same kind of pack you inspect and improve in Discover\. Its 17 placeholder values travel with it as visible gaps/);
  const filled = buildVerifyModel({ build: draft({ result: { ...draft().result, provenance: { ...draft().result.provenance, placeholders: [] } } }), library: LIBRARY, clauses: REQUIREMENTS['tier-2'], targets: TARGETS });
  assert.equal(filled.gaps, 0);
  assert.equal(filled.continueLabel, 'Open pack in Discover');
  assert.match(filled.readyText, /No placeholder value remains/);
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

// The 2026-09 UX review, "Build / Verify" (P0) and "Build / Compile": the result first, the readiness states apart.
const THRESHOLD_WARNING = { kind: 'burn-rules', message: 'threshold SLI kafka_produce_latency_p99: the policy reads threshold 0.8 as a ceiling (bad = samples above it); unit ratio looks like a floor — declare good_when: above (or good_when: below to state the ceiling)' };
const SAMPLING_WARNING = { kind: 'burn-rules', message: 'SLI http_service_availability: no job="..." matcher names one of the pack\'s scrape jobs (a, b), which are scraped at different intervals (15s, 30s); sampling at 30s' };
// The fixture with every value filled, no todo left and no clause resting on a placeholder.
const doneResult = () => ({
  ...draft().result, todos: [], provenance: { ...FIXTURE.provenance, placeholders: [] },
  summary: { ...FIXTURE.summary, onPlaceholder: [], passing: [...FIXTURE.summary.passing, ...FIXTURE.summary.onPlaceholder.map(c => c.id)] },
});

test('VERIFY shows four readiness states apart — "meets the tier rubric" never masks a placeholder: the fixture is ready for team completion, not for deployment', () => {
  const verify = (over) => buildVerifyModel({ build: draft(over), library: LIBRARY, clauses: REQUIREMENTS['tier-2'], targets: TARGETS });
  const m = verify();
  assert.deepEqual(m.states.map(s => [s.id, s.label, s.value, s.tone]), [
    ['schema', 'Schema valid', 'Yes', 'ok'], ['rubric', 'Meets tier rubric', 'Yes', 'warn'],
    ['implementation', 'Implementation', 'Incomplete', 'warn'], ['deployment', 'Deployment ready', 'No', 'warn'],
  ]);
  assert.equal(m.states[1].note, 'MUST 15/15 at tier-2 · 4 only on placeholders', 'conformant, and it says how many MUST clauses rest on a placeholder');
  assert.deepEqual(m.readiness.reasons, ['17 values to fill', '4 clauses pass only on placeholders', '3 items to write or measure outside the studio']);
  assert.deepEqual([m.decision.sentence, m.decision.word, m.decision.tone], ['Ready for team completion; not ready for deployment.', 'Incomplete', 'warn']);
  assert.deepEqual([m.next.primary.label, m.next.primary.action, m.next.secondary.map(s => s.label)], ['Complete required values', 'complete-values', ['Open in Discover with visible gaps']]);
  // The smallest actionable list: the clauses on placeholders, the values by the layer each shapes, what no value fills.
  assert.deepEqual(m.remains.counts, { blocking: 0, warnings: 0, accepted: 0, clauses: 4, values: 17, manual: 3 });
  assert.deepEqual(m.remains.values.groups.map(g => [g.layer, g.items.length]), [['L2', 11], ['L4', 3], ['L5', 3]]);
  assert.deepEqual(m.remains.values.groups.find(g => g.layer === 'L4').items.find(v => v.key === 'oncall_channel').todos, ['alerting.routes[0]', 'alerting.routes[1]']);
  assert.deepEqual(m.remains.clauses.find(c => c.id === 'L2.MUST.metrics_exporter').todos, ['pipelines.exporters.metrics']);
  assert.deepEqual(m.remains.manual.map(t => t.path), ['baselines', 'remediation[0]', 'remediation[1]']);
  // Every value real: all four say yes, and the one primary action is the hand-off.
  const ready = verify({ result: doneResult() });
  assert.deepEqual(ready.states.map(s => s.value), ['Yes', 'Yes', 'Complete', 'Yes']);
  assert.equal(ready.readiness.deployable, true);
  assert.match(ready.decision.sentence, /^Ready for deployment: valid, meets the tier-2 rubric on real values/);
  assert.deepEqual([ready.next.primary.label, ready.next.primary.action, ready.next.secondary], ['Open pack in Discover', 'open-discover', []]);
  assert.equal(ready.remains.empty, true);
  // A non-blocking warning holds deployment back until it is accepted with a reason (per session, on the draft).
  const warned = verify({ result: { ...doneResult(), warnings: [THRESHOLD_WARNING] } });
  assert.equal(warned.readiness.deployable, false);
  assert.equal(warned.decision.sentence, 'Complete for tier-2; one warning needs review before deployment.');
  const item = warned.remains.warnings[0];
  assert.deepEqual([item.sli, item.impact, item.acceptable, item.fix], ['kafka_produce_latency_p99', 'SLI-04 · kafka_produce_latency_p99', true, { kind: 'editor', key: 'kafka_produce_latency_p99', custom: false, focus: 'good_when', layer: 'L1' }]);
  assert.match(item.suggestion, /Good when/);
  const accepted = verify({ result: { ...doneResult(), warnings: [THRESHOLD_WARNING] }, accepted: { [warningKey(THRESHOLD_WARNING)]: { reason: 'a ceiling on purpose' } } });
  assert.equal(accepted.readiness.deployable, true);
  assert.deepEqual([accepted.remains.counts.warnings, accepted.remains.counts.accepted, accepted.remains.accepted[0].accepted.reason], [0, 1, 'a ceiling on purpose']);
  // A blocking warning is never accepted away: the hand-off stays blocked and the primary action fixes it.
  const promql = { kind: 'promql', sli: 'http_service_availability', field: 'good', message: 'SLI http_service_availability.good is not valid PromQL after parameter substitution' };
  const blocked = verify({ result: { ...doneResult(), warnings: [promql] }, accepted: { [warningKey(promql)]: { reason: 'x' } } });
  assert.deepEqual([blocked.decision.word, blocked.decision.tone, blocked.readiness.deployable, blocked.canRegister], ['Blocked', 'fail', false, false]);
  assert.deepEqual([blocked.next.primary.action, blocked.remains.blocking[0].acceptable, blocked.remains.blocking[0].fix.focus], ['fix-first', false, 'good']);
  // A schema error blocks too, and points at the layer its section lives on.
  const invalid = verify({ result: { ...doneResult(), schemaErrors: ['$.spec.dashboards: missing required key'] } });
  assert.deepEqual([invalid.states[0].value, invalid.decision.word, invalid.remains.blocking[0].fix], ['No', 'Blocked', { kind: 'sheet', layer: 'L3' }]);
  assert.equal(schemaErrorLayer('$.spec: missing required key \'dashboards\''), 'L1');
  // A failing MUST clause: the rubric says no and the primary action resolves it (back on Compile).
  const failing = verify({ result: { ...draft().result, summary: DASHBOARDS_OFF_SUMMARY } });
  assert.deepEqual([failing.states[1].value, failing.decision.word, failing.next.primary.action], ['No', 'Below tier', 'resolve-failing']);
  assert.equal(buildReadiness({ result: null }), null);
  assert.deepEqual([warningSli(THRESHOLD_WARNING), warningSli(SAMPLING_WARNING), warningSli({ kind: 'burn-rules', message: 'no SLI here' })], ['kafka_produce_latency_p99', 'http_service_availability', null]);
});

test('the VERIFY screen renders the grammar: the step question, the verdict sentence, the four states, "What remains" with Fix now, the hand-off named explicitly', () => {
  const render = (over) => { const c = stubContainer(); renderBuildVerify(c, buildVerifyModel({ build: draft(over), library: LIBRARY, clauses: REQUIREMENTS['tier-2'], targets: TARGETS }), { build: {} }); return c.innerHTML; };
  const html = render();
  assert.ok(html.includes('What is ready, and what remains?'));
  assert.ok(html.includes('Ready for team completion; not ready for deployment.'));
  assert.ok(html.includes('id="build-verify-complete"') && html.includes('>Complete required values</button>'), 'one primary action at the gate');
  assert.ok(html.includes('title="Conformant: Every MUST clause for the tier is satisfied'), '"Meets tier rubric" carries the formal word and its limit on hover');
  assert.ok(!/>\s*conformant\s*</.test(html), 'the bare word "conformant" is never the verdict');
  assert.ok(html.includes('id="build-remains"') && html.includes('Values to fill') && html.includes('data-ux-action="fix" data-key="value:oncall_channel"'));
  assert.ok(html.includes('Requirement represented; real value still needed'));
  assert.ok(html.includes('The generated pack becomes the same kind of pack you inspect and improve in Discover.'), 'the hand-off is explicit');
  assert.ok(html.includes('id="build-open"') && html.includes('Open pack in Discover with visible gaps'));
  // A warning offers "Accept with reason"; its open form says the acknowledgement is per session and not in the pack.
  const key = warningKey(THRESHOLD_WARNING);
  const warned = render({ result: { ...doneResult(), warnings: [THRESHOLD_WARNING] } });
  assert.ok(warned.includes('data-ux-action="accept-open"') && warned.includes('Suggested correction'));
  const form = render({ result: { ...doneResult(), warnings: [THRESHOLD_WARNING] }, accepting: key, acceptDraft: { key, text: 'on <purpose>' } });
  assert.ok(form.includes('value="on &lt;purpose&gt;"') && form.includes('Kept for this session only — not saved, and not written into the pack.'));
  assert.ok(render({ result: doneResult() }).includes('>Open pack in Discover</button>'), 'every value filled: the hand-off is the primary action');
});

test('COMPILE leads with a result: one sentence, three states apart, the action queue, what was produced by layer and type, which selection produced which artefact', () => {
  const compile = (over) => buildCompileModel({ build: draft(over), library: LIBRARY, clauses: REQUIREMENTS['tier-2'] });
  const c = compile();
  assert.equal(c.decision.sentence, 'Pack compiled. No warning needs review; 17 values remain placeholders.');
  assert.deepEqual(c.states.map(s => [s.id, s.label, s.value]), [['generated', 'Generated', 'Yes'], ['tier', 'Complete for this tier', 'On placeholders'], ['deploy', 'Ready to deploy', 'No']]);
  assert.deepEqual(c.queue.map(i => [i.kind, i.fix]), [['placeholders', { kind: 'step', step: 'verify' }]]);
  assert.deepEqual(c.context.map(x => x.value), ['orders-api', 'prod', 'tier-2', 'kafka + http-service']);
  // Two warnings: counted in the sentence, first in the queue with the artefact each impacts and a correction.
  const two = compile({ result: { ...draft().result, warnings: [THRESHOLD_WARNING, SAMPLING_WARNING] } });
  assert.equal(two.decision.sentence, 'Pack compiled. Two warnings need review; 17 values remain placeholders.');
  assert.deepEqual(two.queue.map(i => [i.kind, i.impact]), [['burn-rules', 'SLI-04 · kafka_produce_latency_p99'], ['burn-rules', 'SLI-06 · http_service_availability'], ['placeholders', '21 Scaffold artefacts · 21 todos']]);
  // What was produced: per layer, by type with its purpose; the counts add up to the stack's.
  assert.deepEqual(c.produced.find(l => l.id === 'L1').types.map(t => [t.type, t.count]), [['SLIs', 7], ['SLOs', 7]]);
  assert.deepEqual(c.produced.find(l => l.id === 'L4').types.map(t => [t.type, t.count]), [['Burn-rate alerts', 7], ['Alert routes', 3], ['Remediations', 2]]);
  assert.equal(c.produced.reduce((n, l) => n + l.artefacts, 0), c.stack.counts.artefacts);
  // Changes since Define: each selection's artefacts, the rest the tier's scaffold — every artefact attributed once.
  assert.deepEqual(c.origins.groups.map(g => [g.id, g.count]), [['kafka', 34], ['http-service', 11], ['scaffold', 37]]);
  assert.equal(c.origins.groups.reduce((n, g) => n + g.count, 0), c.stack.counts.artefacts);
  assert.deepEqual(c.origins.groups.find(g => g.id === 'http-service').slis, ['http_service_availability', 'http_service_latency_p99']);
  assert.deepEqual(compile({ params: { oncall_channel: '#x' }, toggles: { ...defaultBuildState().toggles, dashboards: false } }).origins.edits.map(e => e.kind), ['params', 'off']);
  // Layers expand only when selected; the sheet's layer is drawn too, so focus returns to a slab head that exists.
  assert.deepEqual(c.expandedLayers, []);
  assert.deepEqual(compile({ compileView: ['L3'], sheetOpen: 'L1' }).expandedLayers, ['L1', 'L3']);
  assert.equal(compile({ compileView: 'all' }).expandedLayers.length, c.stack.slabs.length);
  // Headless: the result sentence first, the overview without a slab until one is selected.
  const render = (over) => { const el = stubContainer(); renderBuildCompile(el, compile(over), { build: {} }); return el.innerHTML; };
  const html = render();
  assert.ok(html.includes('What did the pack produce?') && html.includes('Pack compiled. No warning needs review; 17 values remain placeholders.'));
  assert.ok(html.includes('What the pack produced') && html.includes('Changes since Define'));
  assert.ok(!html.includes('class="section build-slab'), 'no slab drawn in the overview');
  assert.ok(render({ compileView: ['L1'] }).includes('class="section build-slab is-pass'), 'a selected layer draws its slab');
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
  // Restoring a draft (the controller's restoreBuildDraft is this pure function over defaultBuildState()).
  const restore = (saved) => restoreBuildDraft(saved, defaultBuildState(), BUILD_PERSIST_FIELDS);
  const full = { step: 'verify', name: 'orders-api', owners: 'team-orders', environment: 'prod', tier: 'tier-1', entries: ['kafka', 7], params: { a: '1' }, slis: ['x', null], toggles: { slos: false }, overrides: { kafka_produce_latency_p99: { objective: 0.995, nope: 1 }, 'Bad-Key': { objective: 0.5 }, dropped: 'x' }, custom: [{ id: 'c1', type: 'ratio' }, { type: 'ratio' }, 'x'], seeded: true, registeredId: 'r1', result: { canonical: {} }, error: ['e'] };
  const got = restore(full);
  assert.deepEqual([got.step, got.name, got.owners, got.environment, got.tier, got.entries, got.params, got.slis, got.toggles.slos, got.toggles.policy, got.overrides, got.custom, got.seeded, got.registeredId, got.result, got.error],
    ['verify', 'orders-api', 'team-orders', 'prod', 'tier-1', ['kafka'], { a: '1' }, ['x'], false, true, { kafka_produce_latency_p99: { objective: 0.995 } }, [{ id: 'c1', type: 'ratio' }], true, 'r1', null, null], 'typed, filtered to the known fields and SLI keys; the result and the error never restored');
  assert.deepEqual(Object.keys(restore({ overrides: JSON.parse('{"__proto__": {"objective": 0.5}}') }).overrides), [], 'a polluting key is not an SLI key');
  // A legacy step id resumes on its current step — it used to be dropped by the step check, so a 'validate' draft landed on DEFINE with seeded=true and no seed card (measured live).
  assert.deepEqual(LEGACY_STEP, { select: 'define', generate: 'compile', validate: 'verify' });
  for (const [legacy, step, seeded] of [['validate', 'verify', true], ['generate', 'compile', true], ['select', 'define', false], ['compile', 'compile', true], ['verify', 'verify', true], ['define', 'define', false]]) {
    const r = restore({ step: legacy, name: 'orders-api', entries: ['kafka'] });
    assert.deepEqual([r.step, r.seeded], [step, seeded], `${legacy} → ${step}, seeded ${seeded} (a pre-seed draft past DEFINE was seeded in all but name)`);
  }
  assert.deepEqual([restore({ step: 'nonsense' }).step, restore({ step: 'compile', seeded: false }).seeded, restore({ tier: 'tier-9' }).tier, restore(null).step], ['define', false, 'tier-2', 'define'], 'an unknown step or tier falls to the default; an explicit seeded=false is kept; no draft is the defaults');
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
  // The placeholder share is titled in the review's words (§4: "Pass on a placeholder" → "Requirement represented; real value still needed").
  assert.equal(rowOf(html, 'L5')[1], '0% <span class="build-maturity-ph" title="requirement represented; real value still needed">+100% ◐</span>');
  assert.equal(rowOf(html, 'L2')[1], '60% <span class="build-maturity-ph" title="requirement represented; real value still needed">+40% ◐</span>');
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
  assert.match(pill, /font:\s*600 13px/, 'small bold text (under 14 px): the 4.5:1 threshold applies');
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
  // The subtitle the adapter gives an SLI (its bound with its direction) sits under the title; a card without one draws no line.
  const lat = FIXTURE.adapted.layers.L1.find(a => a.title === 'kafka_produce_latency_p99');
  assert.equal(lat.subtitle, '≤ 0.1 seconds', 'the fixture\'s threshold SLI carries its bound as a subtitle');
  assert.ok(artefactCardHtml(lat).includes('<div class="card-title">kafka_produce_latency_p99</div>\n    <div class="card-sub">≤ 0.1 seconds</div>'));
  assert.ok(!artefactCardHtml(bak).includes('card-sub') && !plain.includes('card-sub'));
  assert.ok(artefactCardHtml({ id: 'X', title: 'x', subtitle: '≥ 2 <b>' }).includes('<div class="card-sub">≥ 2 &lt;b&gt;</div>'), 'escaped at the seam');
  assert.ok(FIXTURE.adapted.layers.L1.filter(a => /^SLI-/.test(a.id) && a.spec?.type === 'ratio').every(a => !('subtitle' in a)), 'ratio SLIs carry none');
});

test('the studio\'s direction helper is the engine\'s, input for input: goodWhen, hasDirection, boundGlyph, boundText (the browser copy the drawer, the cards and the editor read)', () => {
  const inputs = [
    undefined, null, {}, { good_when: 'below' }, { good_when: 'above' }, { good_when: 'sideways' }, { good_when: null },
    { type: 'threshold', threshold: 0.5, unit: 'seconds' }, { type: 'threshold', good_when: 'above', threshold: 2, unit: 'consumers' },
    { type: 'threshold', good_when: 'above', threshold: -1.5 }, { type: 'threshold', threshold: 0 }, { type: 'threshold', threshold: '' },
    { type: 'distribution', good_when: 'above', threshold: 1, unit: 'ratio', percentile: 0.99 }, { type: 'ratio', threshold: 3 },
  ];
  for (const s of inputs) {
    assert.equal(studioDirection.goodWhen(s), engineDirection.goodWhen(s), JSON.stringify(s));
    assert.equal(studioDirection.boundGlyph(s), engineDirection.boundGlyph(s), JSON.stringify(s));
    assert.equal(studioDirection.boundText(s), engineDirection.boundText(s), JSON.stringify(s));
    assert.equal(studioDirection.hasDirection(s?.type), engineDirection.hasDirection(s?.type), JSON.stringify(s));
  }
  assert.deepEqual([studioDirection.GOOD_WHEN, studioDirection.DEFAULT_GOOD_WHEN, studioDirection.DIRECTED_TYPES], [[...engineDirection.GOOD_WHEN], engineDirection.DEFAULT_GOOD_WHEN, [...engineDirection.DIRECTED_TYPES]]);
  assert.deepEqual([engineDirection.goodWhen({}), engineDirection.boundText({ type: 'threshold', threshold: 0.5, unit: 'seconds' }), engineDirection.boundText({ good_when: 'above', threshold: 2, unit: 'consumers' })], ['below', '≤ 0.5 seconds', '≥ 2 consumers']);
  // Each copy's header names the other and this test (the one place a reader is sent to for the twin): a header that
  // names another module or another test sends them to the wrong file.
  const header = (rel) => readFileSync(resolve(ROOT, rel), 'utf8').split('\n').filter(l => l.startsWith('//')).join('\n');
  const engineHeader = header('tools/lib/good-when.mjs'), studioHeader = header('studio/sli-direction.mjs');
  assert.ok(engineHeader.includes('studio/sli-direction.mjs') && engineHeader.includes('tools/test-build-model.mjs'), 'the engine helper names its browser copy and this test');
  assert.ok(!/build-copies-model\.mjs|test-build-editor\.mjs/.test(engineHeader), 'the engine helper names no other module as the copy or the guard');
  assert.ok(studioHeader.includes('tools/lib/good-when.mjs') && studioHeader.includes('tools/test-build-model.mjs'), 'the browser copy names the engine helper and this test');
});

test('absent means below is decided in the two helpers alone: no other module compares good_when with a literal side', () => {
  // A raw `x.good_when === 'above'` is right only while something upstream has already normalised the field; the
  // helpers are the one place that decides. Enum checks (`GOOD_WHEN.includes(v)`, `!== undefined`) are not comparisons
  // with a side and pass; the two helper bodies and the tests are the allowed sites.
  const walk = (dir, out = []) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) { if (!/node_modules|fixtures|assets/.test(n)) walk(p, out); } else out.push(p); } return out; };
  const raw = /good_when\s*(?:===|!==|==|!=)\s*['"]|['"](?:above|below)['"]\s*(?:===|!==|==|!=)\s*[\w.?]*good_when/;
  const helpers = new Set(['tools/lib/good-when.mjs', 'studio/sli-direction.mjs']);
  const offenders = [];
  for (const dir of ['tools', 'server', 'studio']) {
    for (const file of walk(resolve(ROOT, dir)).filter(p => /\.mjs$/.test(p))) {
      const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
      if (helpers.has(rel) || /(^|\/)test-[^/]*\.mjs$/.test(rel)) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => { if (raw.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`); });
    }
  }
  assert.deepEqual(offenders, [], 'every reader and writer asks goodWhen(sli); only the helpers read the raw field');
  assert.ok(raw.test("if (d.good_when === 'above') def.good_when = 'above';") && !raw.test("if (goodWhen(d) === 'above') def.good_when = 'above';") && !raw.test('if (s.good_when !== undefined) e(1)'), 'the scan catches the raw comparison, not the helper call or an enum check');
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

// ---------------------------------------------------------------------------
// DEFINE in four substeps (the 2026-09 UX review, "Build / Define")
// ---------------------------------------------------------------------------

test('DEFINE substeps: which one shows, what each holds, what the tier asks of the pack (from the rubric), what an entry adds, the suggestions grouped by technology', async () => {
  const bm = await import('../studio/build-model.mjs');
  // The four substeps, in order; the one shown is the draft's (UI state) or the first still needing input.
  assert.deepEqual(bm.DEFINE_SUBSTEPS.map(s => s.id), ['service', 'criticality', 'technology', 'review']);
  const full = bm.buildDefineModel({ build: draft(), library: LIBRARY, requirements: REQUIREMENTS });
  assert.equal(full.substep, 'review', 'a complete definition opens on the review');
  assert.deepEqual(full.substeps.map(s => [s.id, s.status, s.value]), [
    ['service', 'complete', 'orders-api · team-orders · prod'], ['criticality', 'complete', 'tier-2 · important'],
    ['technology', 'complete', 'Apache Kafka, HTTP service (OTel semconv)'], ['review', 'current', '7 SLIs in the pack'],
  ]);
  assert.equal(full.substepsDone, 4);
  const fresh = bm.buildDefineModel({ build: defaultBuildState(), library: LIBRARY, requirements: REQUIREMENTS });
  assert.deepEqual([fresh.substep, fresh.substeps.map(s => s.status)], ['service', ['current', 'complete', 'todo', 'todo']], 'a fresh draft starts on the service; the tier has a default');
  assert.equal(fresh.substeps[0].value, 'not named yet');
  assert.equal(bm.buildDefineModel({ build: draft({ entries: [] }), library: LIBRARY, requirements: REQUIREMENTS }).substep, 'technology');
  assert.equal(bm.buildDefineModel({ build: draft({ defineSub: 'criticality' }), library: LIBRARY, requirements: REQUIREMENTS }).substep, 'criticality', 'the draft remembers the one shown');
  assert.equal(bm.buildDefineModel({ build: draft({ defineSub: 'nonsense' }), library: LIBRARY, requirements: REQUIREMENTS }).substep, 'review');
  assert.equal(bm.serviceLine({ name: 'Orders API', owners: 'a, b', environment: 'staging' }), 'orders-api · a, b · staging');
  // The column's progress reads the same substeps.
  assert.deepEqual(buildDefinitionModel({ build: draft({ defineSub: 'technology' }), library: LIBRARY, requirements: REQUIREMENTS }).substeps.map(s => s.status), ['complete', 'complete', 'current', 'complete']);
  // What each tier asks of the pack, read from its rubric clauses: the review's "Tier 2: availability and latency objectives; logs and traces; alerting requirements".
  const t2 = full.tiers.find(t => t.id === 'tier-2').consequences;
  assert.equal(t2.derived, true);
  assert.equal(t2.sentence, 'availability and latency objectives; metrics, logs and traces; burn-rate alerts; a service overview and an SLO burn board; a synthetic probe and chaos in staging');
  assert.deepEqual(t2.rows.map(r => r.label), ['Objectives', 'Signals', 'Alerting', 'Dashboards', 'Validation']);
  assert.ok(t2.rows.find(r => r.id === 'alerting').clauses.includes('L4.MUST.multi_window_burn_rate'), 'each row names the clauses behind it');
  const t3 = full.tiers.find(t => t.id === 'tier-3').consequences;
  assert.equal(t3.sentence, 'an availability objective; an OTLP pipeline; a service overview; a synthetic probe', 'tier-3 asks for no alerting and no latency objective');
  const t1 = full.tiers.find(t => t.id === 'tier-1').consequences;
  assert.deepEqual([t1.rows[0].text, t1.rows[0].recommended], ['availability and latency objectives', 'a domain objective'], 'a SHOULD is said as recommended, never as required');
  assert.match(t1.rows.find(r => r.id === 'alerting').text, /voice paging and self-healing/);
  // Not loaded yet: the tier's static blurb, no rows.
  const cold = bm.tierConsequences(null, 'tier-2');
  assert.deepEqual([cold.derived, cold.rows, cold.sentence], [false, [], 'A latency SLO, logs and traces backends, a chaos experiment in staging, a remediation.']);
  // A product card says what it adds at the tier, the SLIs named, before it is picked.
  const mq = full.products.find(p => p.id === 'ibm-mq');
  assert.equal(mq.selected, false);
  assert.deepEqual(mq.suggested.map(s => s.name), ['Queue manager process up', 'Queue manager reachability', 'Queue depth headroom', 'Oldest message age', 'DLQ depth', 'Canary success']);
  assert.deepEqual([mq.suggested.length, mq.sliCountAtTier, mq.optional], [6, 6, 2]);
  // The suggestions, grouped by technology, the recommended ones ticked; "Select recommended" adds them to the selection.
  const s = full.suggestions;
  assert.deepEqual(s.groups.map(g => [g.id, g.counts.selected, g.counts.total]), [['kafka', 5, 6], ['http-service', 2, 4]]);
  const election = s.groups[0].items.find(i => i.id === 'controller_election_rate');
  assert.deepEqual([election.checked, election.recommended, election.profileTier, election.name, election.meta], [false, false, 'tier-1', 'Controller election rate', '≤ 1 events_per_hour · 99% over 7d']);
  assert.equal(s.groups[0].items.find(i => i.id === 'broker_availability').meta, 'good ÷ total events · 99.9% over 30d');
  assert.deepEqual([s.counts, s.allRecommended, s.recommendedSlis], [{ selected: 7, total: 10, recommended: 7, recommendedSelected: 7, custom: 0 }, true, null]);
  // An explicit list without some recommended SLIs, with an optional one: Select recommended keeps the optional one and adds the rest back.
  const partial = bm.defineSuggestions({ build: draft({ slis: ['kafka_broker_availability', 'kafka_controller_election_rate'] }), library: LIBRARY });
  assert.equal(partial.allRecommended, false);
  assert.deepEqual(partial.allKeys, ['kafka_broker_availability', 'kafka_controller_election_rate']);
  assert.ok(partial.recommendedSlis.includes('kafka_controller_election_rate') && partial.recommendedSlis.includes('http_service_latency_p99') && partial.recommendedSlis.length === 8);
  // Exactly the recommended set collapses to null (the tier's defaults).
  assert.equal(bm.defineSuggestions({ build: draft({ slis: ['kafka_broker_availability'] }), library: LIBRARY }).recommendedSlis, null);
  // The custom SLIs are their own group, always in the pack.
  const withCustom = bm.defineSuggestions({ build: draft({ custom: [{ id: 'checkout_success', type: 'ratio', good: 'a', total: 'b', objective: 0.999, window: '30d' }] }), library: LIBRARY });
  assert.deepEqual(withCustom.custom.map(c => [c.key, c.name, c.meta]), [['checkout_success', 'Checkout success', 'good ÷ total events · 99.9% over 30d']]);
  // "Why these suggestions?": the rubric clauses, themed, then the ones no theme names.
  assert.deepEqual([full.why.must, full.why.should, full.why.themes.length], [15, 1, 5]);
  assert.ok(full.why.also.some(c => c.id === 'L1.MUST.sli_covered_by_slo'));
  assert.equal(full.why.themes.flatMap(t => t.clauses).length + full.why.also.length, 16, 'every clause of the tier, once');
  // A vanished suggestion hands the focus on.
  assert.deepEqual(focusFallbackSelectors('sugg:kafka_broker_availability'), ['.bd-sugg-box', '[data-focus-key="dpanel:review"]']);
});

test('DEFINE substeps render: the indicator with aria-current, one panel shown, Back / Continue, the tier cards and entry cards, the review with its disclosures and the stack inside Advanced review; the column is a progress summary', async () => {
  const define = (b) => { const c = stubContainer(); renderBuildDefine(c, buildDefineModel({ build: b, library: LIBRARY, requirements: REQUIREMENTS }), { build: {} }); return c.innerHTML; };
  const html = define(draft());
  assert.ok(html.includes('<nav class="bd-substeps" aria-label="Define in four steps">'));
  assert.ok(html.includes('data-define-sub="review" data-focus-key="dsub:review" aria-current="step">'));
  assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
  // Every panel is drawn (their fields keep their focus keys), only the current one visible.
  assert.ok(html.includes('<section class="bd-panel" id="bd-panel-service" data-panel="service" aria-labelledby="bd-h-service" hidden>'));
  assert.ok(html.includes('<section class="bd-panel" id="bd-panel-review" data-panel="review" aria-labelledby="bd-h-review">'));
  assert.ok(html.includes('<h3 class="bd-panel-title" id="bd-h-review" tabindex="-1" data-focus-key="dpanel:review"><span class="bd-panel-n">4</span> What should the pack measure?</h3>'));
  assert.ok(html.includes('<button type="button" class="ux-secondary-btn" data-define-sub="technology"><span aria-hidden="true">←</span> Back to Technology</button>'));
  assert.ok(html.includes('<button type="button" class="ux-primary-btn" data-define-sub="criticality">Continue to Criticality <span aria-hidden="true">→</span></button>'));
  // The opening copy is short and task-oriented: no seed, silhouette or ghost cards before a selection.
  const lede = html.match(/<p class="build-lede">([^<]*)<\/p>/)[1];
  assert.ok(!/silhouette|ghost|rubric|L1/.test(lede), lede);
  // The review: grouped suggestions with individual checkboxes, Select recommended, the requirement line, the two disclosures.
  assert.ok(html.includes('<input type="checkbox" class="bd-sugg-box" id="bd-sugg-kafka_broker_availability" data-sugg-sli="kafka_broker_availability" data-focus-key="sugg:kafka_broker_availability" checked aria-describedby="bd-sugg-kafka_broker_availability-meta">'));
  assert.ok(html.includes('<label class="bd-sugg-label" for="bd-sugg-kafka_broker_availability"><span class="bd-sugg-name">Broker availability</span><span class="bd-tag is-rec">Recommended</span></label>'));
  assert.ok(html.includes('<legend class="bd-sugg-legend">Apache Kafka <span class="bd-sugg-legend-count">5 of 6 selected</span></legend>'));
  assert.ok(html.includes('data-sugg-recommended data-focus-key="sugg:recommended" disabled>All recommended selected</button>'));
  assert.ok(html.includes('<p class="bd-requirements"><span class="bd-requirements-key">tier-2 also requires</span> availability and latency objectives; metrics, logs and traces;'));
  assert.ok(html.includes('<details class="ux-disclosure bd-fold" data-define-fold="why"><summary>Why these suggestions?</summary>'));
  assert.ok(html.includes('<details class="ux-disclosure bd-fold" data-define-fold="advanced"><summary>Advanced review: the pack layer by layer</summary>'));
  const advanced = html.slice(html.indexOf('data-define-fold="advanced"'));
  assert.ok(advanced.includes('<div class="build-stack" data-mode="define">') && advanced.includes('silhouette'), 'the layer mechanics and the stack live in Advanced review');
  assert.ok(html.slice(html.indexOf('data-define-fold="why"')).includes('<code>L1.MUST.latency_slo</code>'), 'the rubric clauses live in Why these suggestions?');
  // A fold the user opened stays open; a rejected value opens Advanced review by itself unless it was closed.
  assert.ok(define(draft({ defineFolds: { why: true, 'preview:ibm-mq': true } })).includes('data-define-fold="why" open>') && define(draft({ defineFolds: { 'preview:ibm-mq': true } })).includes('data-define-fold="preview:ibm-mq" open>'));
  const rejected = draft({ error: ['param kafka.bootstrap: a value may not contain a double quote'] });
  assert.ok(define(rejected).includes('data-define-fold="advanced" open>') && !define({ ...rejected, defineFolds: { advanced: false } }).includes('data-define-fold="advanced" open>'));
  // No technology yet: an empty state that says what was checked and offers the way there.
  const empty = define(draft({ entries: [], defineSub: 'review' }));
  assert.ok(empty.includes('<p class="ux-empty-title">No suggestions yet</p>') && empty.includes('data-define-sub="technology">Pick a technology</button>'));
  // One primary action: Seed the pack is primary on the review, secondary before it.
  assert.ok(html.includes('class="mcp-refresh-btn build-next" id="build-next"') && define(draft({ defineSub: 'service' })).includes('class="ctrl-btn build-next" id="build-next"'));
  // The column on DEFINE: the progress summary, one button per substep with what it holds, no form, no scroller of its own.
  const col = stubContainer();
  renderBuildDefinition(col, buildDefinitionModel({ build: draft({ defineSub: 'criticality' }), library: LIBRARY, requirements: REQUIREMENTS }), { build: {} });
  assert.ok(col.innerHTML.includes('<div class="build-def-inner is-progress">'));
  assert.ok(col.innerHTML.includes('data-define-sub="criticality" data-focus-key="dprog:criticality" aria-current="step">') && col.innerHTML.includes('<span class="bd-progress-val" data-progress-val="criticality">tier-2 · important</span>'));
  assert.ok(col.innerHTML.includes('<span class="bd-progress-label">Service<span class="sr-text"> — done</span></span>'));
  const css = readFileSync(resolve(ROOT, 'studio/ux-build-define.css'), 'utf8');
  assert.match(css, /\.build-def \{\s*overflow: visible; max-height: none;/, 'the column does not scroll on its own');
  const page = readFileSync(resolve(ROOT, 'studio/index.html'), 'utf8');
  assert.ok(page.indexOf('/ux-build-define.css') > page.indexOf('/app.css'), 'loaded after app.css, so it wins');
});

test('DEFINE substep handlers: a substep button moves (focus on its heading), a checkbox puts its SLI in or out, Select recommended, Edit and Add a custom SLI open the editor, a fold is remembered; the service line repaints as typed', async () => {
  const { wireSuggestions } = await import('../studio/build-define-view.mjs');
  const calls = [];
  const act = { update: (p, o) => calls.push(['update', p, o]), setSli: (k, on, all) => calls.push(['sli', k, on, all]), openEditor: (o) => calls.push(['editor', o]) };
  // The substep buttons (the indicator, Back / Continue, the column's progress) through wireBuildDefinition.
  const sub = fakeEl({ defineSub: 'technology' });
  wireBuildDefinition(fakeContainer({ '[data-define-sub]': [sub] }), {}, { build: act });
  sub.fire('click');
  assert.deepEqual(calls.pop(), ['update', { defineSub: 'technology' }, { rerender: true, reinstantiate: false, focus: 'dpanel:technology' }]);
  // The service line of the progress summary follows the name as typed, before any re-render.
  const val = { textContent: '' };
  const name = { ...fakeEl({}), value: 'Orders API' };
  const c = { ...fakeContainer({ '#build-name': [name] }), ownerDocument: { querySelectorAll: (sel) => (sel === '[data-progress-val="service"]' ? [val] : []) } };
  wireBuildDefinition(c, { owners: 'team-orders', environment: 'prod' }, { build: act });
  name.fire('input', { target: name });
  assert.deepEqual([calls.pop(), val.textContent], [['update', { name: 'Orders API' }, undefined], 'orders-api · team-orders · prod']);
  // The substep shown is pinned on the first render, so a later re-render (the first technology picked) never moves the user on by itself.
  const pins = [];
  const pinHost = { build: { update: (p, o) => pins.push([p, o]) } };
  renderBuildDefine(stubContainer(), buildDefineModel({ build: draft({ entries: [] }), library: LIBRARY, requirements: REQUIREMENTS }), pinHost);
  renderBuildDefine(stubContainer(), buildDefineModel({ build: draft({ entries: [], defineSub: 'technology' }), library: LIBRARY, requirements: REQUIREMENTS }), pinHost);
  renderBuildDefine(stubContainer(), buildDefineModel({ build: draft({ defineSub: 'technology' }), library: LIBRARY, requirements: REQUIREMENTS }), pinHost);
  assert.deepEqual(pins, [[{ defineSub: 'technology' }, { rerender: false, reinstantiate: false }]], 'pinned once; with an entry picked it stays on technology');
  // The review's handlers.
  const m = buildDefineModel({ build: draft({ slis: ['kafka_broker_availability'] }), library: LIBRARY, requirements: REQUIREMENTS });
  const box = { ...fakeEl({ suggSli: 'kafka_fetch_latency_p99' }), checked: true };
  const rec = fakeEl({});
  const edit = fakeEl({ suggEdit: 'kafka_broker_availability', focusKey: 'sugg-edit:kafka_broker_availability' });
  const editCustom = fakeEl({ suggEdit: 'checkout_success', suggCustom: '1', focusKey: 'sugg:custom:checkout_success' });
  const create = fakeEl({});
  const fold = { ...fakeEl({ defineFold: 'why' }), open: true };
  wireSuggestions(fakeContainer({ '[data-sugg-sli]': [box], '[data-sugg-recommended]': [rec], '[data-sugg-edit]': [edit, editCustom], '[data-sugg-create]': [create], 'details[data-define-fold]': [fold] }), m, act);
  box.fire('change');
  assert.deepEqual(calls.pop(), ['sli', 'kafka_fetch_latency_p99', true, ['kafka_broker_availability']], 'the explicit list starts from the SLIs in the pack');
  rec.fire('click');
  assert.deepEqual(calls.pop(), ['update', { slis: null }, { rerender: true, delay: 0, focus: 'dpanel:review' }], 'every recommended SLI selected: exactly the defaults, so null');
  edit.fire('click'); editCustom.fire('click'); create.fire('click');
  assert.deepEqual(calls.splice(-3), [
    ['editor', { key: 'kafka_broker_availability', custom: false, opener: 'sugg-edit:kafka_broker_availability' }],
    ['editor', { key: 'checkout_success', custom: true, opener: 'sugg:custom:checkout_success' }],
    ['editor', { create: true, opener: 'sugg:create' }],
  ]);
  fold.fire('toggle');
  assert.deepEqual(calls.pop(), ['update', { defineFolds: { why: true } }, { rerender: false, reinstantiate: false }]);
  fold.fire('toggle');
  assert.equal(calls.length, 0, 'a toggle that changes nothing writes nothing');
});

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
  assert.deepEqual([kafka.selected, kafka.evidence, kafka.sliCountAtTier, kafka.placeholderParams, kafka.gaps], [true, { status: 'recorded-live', verifiedOn: '2026-09-22' }, 5, 5, 2]);
  // The word for a status is the evidence atom's vocabulary, spelled once there (not a second table on the model).
  assert.ok(evidenceDot(kafka.evidence.status, kafka.evidence.verifiedOn).includes('recorded live · verified 2026-09-22'));
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
  // The tier cards, the technology cards and the fields are on the DEFINE step's substeps now (the 2026-09 UX
  // review); the column is the progress summary and the conformance summary. Both are drawn headlessly here.
  const step = stubContainer();
  renderBuildDefine(step, buildDefineModel({ build: draft(), library: LIBRARY, requirements: REQUIREMENTS }), { build: {} });
  const form = step.innerHTML;
  const c = stubContainer();
  renderBuildDefinition(c, buildDefinitionModel({ build: draft(), library: LIBRARY, requirements: REQUIREMENTS }), { build: {} });
  const html = c.innerHTML;
  assert.ok(form.includes('<div class="bd-tiers" role="radiogroup" aria-label="Criticality tier">'));
  assert.equal((form.match(/role="radio"/g) || []).length, 3);
  assert.ok(form.includes('data-tier="tier-2" aria-checked="true" tabindex="0"'));
  assert.ok(form.includes('data-tier="tier-1" aria-checked="false" tabindex="-1"'));
  assert.ok(form.includes('<span class="build-seg-name">tier-2</span>') && form.includes('aria-label="15 MUST, 1 SHOULD"><b>15 MUST</b><b>1 SHOULD</b></span>'), 'the counts stack, MUST over SHOULD');
  assert.ok(form.includes('aria-label="9 MUST"><b>9 MUST</b></span>'), 'tier-3 has no SHOULD: the count reads MUST only');
  // Each tier card says what it asks of the pack, read from the rubric — the radio named by the tier, described by its counts and consequences.
  assert.ok(form.includes('aria-label="Tier 2, important" aria-describedby="bd-tier-tier-2-counts bd-tier-tier-2-what"'));
  assert.ok(form.includes('<span class="bd-tier-row"><span class="bd-tier-key">Objectives</span><span class="bd-tier-val">availability and latency objectives</span></span>'));
  assert.ok(form.includes('<span class="bd-tier-key">Signals</span><span class="bd-tier-val">metrics, logs and traces</span>') && form.includes('<span class="bd-tier-key">Alerting</span><span class="bd-tier-val">burn-rate alerts</span>'));
  assert.ok(form.includes('data-entry="kafka" aria-pressed="true"') && form.includes('data-entry="ibm-mq" aria-pressed="false"'));
  // A technology card says what it adds, with its SLIs previewable before it is picked.
  assert.ok(form.includes('<span class="build-chip-slis" id="bd-entry-kafka-adds">Adds 5 suggested SLIs</span>'));
  assert.ok(form.includes('<details class="bd-entry-preview" data-define-fold="preview:ibm-mq">') && form.includes('<li>Queue depth headroom <span class="bd-entry-sli-type">threshold</span></li>'));
  assert.ok(form.includes('class="build-evidence-dot build-evidence-recorded-live" title="recorded live · verified 2026-09-22" role="img" aria-label="evidence: recorded live · verified 2026-09-22"'));
  assert.ok(form.includes('id="build-name"') && form.includes('data-focus-key="name"') && form.includes('data-focus-key="owners"') && form.includes('data-focus-key="environment"'));
  assert.ok(!html.includes('id="build-name"') && !html.includes('role="radiogroup"'), 'the column holds no form');
  assert.ok(html.includes('class="build-summary is-ok"') && html.includes('meets the tier-2 rubric'));
  // The summary is rebuilt on every re-render, so it is not a live region itself: the status goes to one
  // persistent role=status node outside the view (#build-status in index.html), as one settled line.
  assert.ok(!html.includes('aria-live'), 'no live region inside the re-rendered column');
  const page = readFileSync(resolve(ROOT, 'studio/index.html'), 'utf8');
  assert.ok(page.includes('<div id="build-status" class="sr-text" role="status" aria-live="polite"></div>'));
  assert.ok(page.indexOf('id="build-status"') > page.indexOf('</main>'), 'outside #layer-view, which renderMainView empties');
  assert.match(cssRule('.sr-text'), /clip-path:\s*inset\(50%\)/, 'visually hidden, still read');
  const okModel = buildDefinitionModel({ build: draft(), library: LIBRARY, requirements: REQUIREMENTS });
  assert.equal(buildStatusLine(okModel.summary), 'meets the tier-2 rubric · 12 pass · 4 need real values · 0 fail');
  assert.equal(buildStatusLine(buildDefinitionModel({ build: draft({ result: { ...draft().result, summary: DASHBOARDS_OFF_SUMMARY } }), library: LIBRARY, requirements: REQUIREMENTS }).summary), '2 MUST clauses failing · 10 pass · 4 need real values · 2 fail');
  assert.equal(buildStatusLine(buildDefinitionModel({ build: draft({ pending: true }), library: LIBRARY, requirements: REQUIREMENTS }).summary), null, 'nothing announced while the engine answers');
  assert.equal(buildStatusLine(buildDefinitionModel({ build: defaultBuildState(), library: LIBRARY, requirements: REQUIREMENTS }).summary), null, 'nothing announced before the first result');
  assert.equal(buildStatusLine(null), null);
  assert.ok(html.includes('12 pass') && html.includes('4 need real values') && html.includes('0 fail'));
  assert.ok(html.includes('title="Conformant: Every MUST clause for the tier is satisfied'), 'the formal term and its meaning on the label, the plain words shown');
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
  assert.ok(form.includes('data-tier="tier-2" aria-checked="true" tabindex="0" data-focus-key="tier:tier-2"'));
  assert.ok(form.includes('data-entry="ibm-mq" aria-pressed="false" data-focus-key="entry:ibm-mq"'));
  const afterStep = stubContainer();
  renderBuildDefine(afterStep, buildDefineModel({ build: draft({ tier: 'tier-1', entries: ['kafka', 'http-service', 'ibm-mq'] }), library: LIBRARY, requirements: REQUIREMENTS }), { build: {} });
  const after = afterStep.innerHTML;
  assert.ok(after.includes('data-tier="tier-1" aria-checked="true" tabindex="0" data-focus-key="tier:tier-1"'), 'the segment the arrow key focused is the checked one after the re-render, same key');
  assert.ok(after.includes('data-entry="ibm-mq" aria-pressed="true" data-focus-key="entry:ibm-mq"'), 'the toggled chip keeps its key');
  assert.deepEqual(focusFallbackSelectors('tier:tier-1'), ['.build-seg-btn[aria-checked="true"]'], 'a tier key that vanished falls to the checked segment');
  assert.deepEqual(focusFallbackSelectors('entry:ibm-mq'), ['.build-chip[data-entry="ibm-mq"]', '.build-chip']);
  assert.deepEqual(focusFallbackSelectors('entry:<x>'), [], 'an id that is not a slug is not interpolated into a selector');
});

test('rolodexItems: the selected entries’ SLIs with the objective they start with, an above-tier one informational (never disabled), every product behind the filter', () => {
  const items = rolodexItems({ build: draft(), library: LIBRARY });
  assert.equal(items.length, 10, 'kafka 6 + http-service 4, in selection order');
  assert.deepEqual(items.slice(0, 6).map(i => i.entry), Array(6).fill('kafka'));
  const ba = items.find(i => i.id === 'broker_availability');
  assert.deepEqual([ba.key, ba.entryTitle, ba.entrySelected, ba.type, ba.evidence, ba.metrics, ba.reachable, ba.selected, ba.disabled, ba.reason, ba.objectiveLabel, ba.window, ba.focusKey],
    ['kafka_broker_availability', 'Apache Kafka', true, 'ratio', 'recorded-live', ['up'], true, true, false, null, '99.9%', '30d', 'sli:kafka:broker_availability']);
  assert.deepEqual([ba.aboveTier, ba.note, ba.customised, ba.custom, ba.effectiveId, ba.promqlWarning, ba.evidenceNote], [false, null, [], false, 'kafka_broker_availability', null, null]);
  assert.deepEqual(ba.tiers.map(t => [t.tier, t.current, t.reachable, t.objectiveLabel, t.window]), [['tier-3', false, true, '99%', '30d'], ['tier-2', true, true, '99.9%', '30d'], ['tier-1', false, true, '99.9%', '30d']]);
  // Above the tier: never disabled, no reason — an informational note, and the objective of its own profile (the engine's walk).
  const ce = items.find(i => i.id === 'controller_election_rate');
  assert.deepEqual([ce.reachable, ce.aboveTier, ce.selected, ce.disabled, ce.reason, ce.note, ce.profileTier, ce.objectiveLabel, ce.objective, ce.window], [false, true, false, false, null, 'from the tier-1 profile', 'tier-1', '99%', 0.99, '7d']);
  assert.deepEqual(ce.tiers.map(t => t.reachable), [false, false, true]);
  assert.ok(items.every(i => i.disabled === false && i.reason === null), 'nothing in the rolodex is disabled');
  // Asked for at tier-2: selected, still above the tier.
  const asked = rolodexItems({ build: draft({ slis: [...FIXTURE.provenance.toggles.slis, 'kafka_controller_election_rate'] }), library: LIBRARY }).find(i => i.id === 'controller_election_rate');
  assert.deepEqual([asked.selected, asked.aboveTier, asked.note], [true, true, 'from the tier-1 profile']);
  // At tier-1 the same SLI is a default and, with the defaults, in the pack.
  const t1 = rolodexItems({ build: draft({ tier: 'tier-1' }), library: LIBRARY }).find(i => i.id === 'controller_election_rate');
  assert.deepEqual([t1.reachable, t1.aboveTier, t1.selected, t1.objectiveLabel, t1.window, t1.note], [true, false, true, '99%', '7d', null]);
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

// The drive's copies: an objective and window override, an edited query, a custom SLI — and the engine's answer to them.
const COPIES = {
  overrides: { kafka_produce_latency_p99: { objective: 0.995, window: '7d' }, http_service_latency_p99: { query: 'histogram_quantile(0.99, sum by (le)(rate(http_seconds_bucket[5m])))' } },
  custom: [{ id: 'checkout_success', type: 'ratio', good: 'sum(rate(checkout_ok_total[5m]))', total: 'sum(rate(checkout_total[5m]))', objective: 0.999, window: '30d', description: 'Checkouts that succeed' }],
};
const copiesResult = () => instantiateInProcess({ ...INPUTS, ...COPIES });
const copiesDraft = (over = {}) => { const r = copiesResult(); return draft({ ...COPIES, result: { canonical: r.canonical, canonicalYaml: r.canonicalYaml, todos: r.todos, warnings: r.warnings, summary: r.summary, conformance: r.conformance, schemaErrors: r.schemaErrors, provenance: r.provenance, adapted: r.adapted }, ...over }); };

test('rolodexItems with the copies: the effective values and the customised fields, the evidence turned custom by an edited query, the custom SLI as a card of its own, the engine\'s promql warning on its card', () => {
  const b = copiesDraft();
  const items = rolodexItems({ build: b, library: LIBRARY });
  assert.equal(items.length, 11, 'ten library SLIs, then the custom one');
  const pl = items.find(i => i.key === 'kafka_produce_latency_p99');
  assert.deepEqual([pl.objective, pl.objectiveLabel, pl.window, pl.customised, pl.customisedLabel, pl.evidence, pl.evidenceNote], [0.995, '99.5%', '7d', ['objective', 'window'], 'customised: objective, window', 'recorded-live', null]);
  assert.deepEqual([pl.defaults.objective, pl.defaults.window, pl.defaults.threshold, pl.effective.threshold], [0.99, '30d', 0.1, 0.1], 'the library defaults beside the effective values; the bound untouched');
  assert.deepEqual(pl.override, { objective: 0.995, window: '7d' });
  const lp = items.find(i => i.key === 'http_service_latency_p99');
  assert.deepEqual([lp.evidence, lp.libraryEvidence, lp.evidenceNote, lp.customised], ['custom', 'semconv', 'edited — the library’s evidence no longer applies', ['query']]);
  assert.equal(lp.effective.query, COPIES.overrides.http_service_latency_p99.query);
  assert.match(lp.defaults.query, /^histogram_quantile\(0\.99,/, 'the library template stays available as the default');
  const cu = items.find(i => i.key === 'checkout_success');
  assert.deepEqual([cu.custom, cu.selected, cu.entrySelected, cu.entryTitle, cu.entryKind, cu.type, cu.evidence, cu.evidenceNote, cu.objectiveLabel, cu.window, cu.description, cu.tiers, cu.focusKey, cu.customised, cu.aboveTier],
    [true, true, true, 'Custom SLI', 'custom', 'ratio', 'custom', 'written in the studio — no library evidence', '99.9%', '30d', 'Checkouts that succeed', [], 'sli:custom:checkout_success', [], false]);
  assert.deepEqual(cu.def, COPIES.custom[0]);
  assert.equal(items.findIndex(i => i.custom), 10, 'after the selected entries\' SLIs');
  assert.equal(rolodexItems({ build: b, library: LIBRARY, all: true }).findIndex(i => !i.entrySelected), 11, 'the foreign SLIs come after the custom one');
  // The engine's promql warning for an SLI lands on its card — and only its card.
  const broken = draft({ ...COPIES, result: { ...b.result, warnings: [{ kind: 'promql', sli: 'checkout_success', field: 'good', message: 'SLI checkout_success.good is not valid PromQL' }] } });
  const withWarn = rolodexItems({ build: broken, library: LIBRARY });
  assert.equal(withWarn.find(i => i.key === 'checkout_success').promqlWarning, 'SLI checkout_success.good is not valid PromQL');
  assert.ok(withWarn.filter(i => i.promqlWarning).length === 1);
  // An open card (UI state, never persisted).
  // A renamed SLI: the card shows the id the pack carries, its key stays the library's (the override and the switch address it so).
  const renamedItems = rolodexItems({ build: draft({ overrides: { kafka_produce_latency_p99: { id: 'produce_p99' } } }), library: LIBRARY });
  assert.deepEqual([renamedItems.find(i => i.key === 'kafka_produce_latency_p99').effectiveId, renamedItems.find(i => i.key === 'kafka_produce_latency_p99').customised, effectiveId('k', { id: 'x' }), effectiveId('k', {}), effectiveId('k', { id: '' })], ['produce_p99', ['id'], 'x', 'k', 'k']);
  assert.ok(items.every(i => i.effectiveId === i.key), 'no rename: the id the pack carries is the key');
  assert.ok(!BUILD_PERSIST_FIELDS.includes('editor') && !BUILD_PERSIST_FIELDS.includes('editorDirty') && !BUILD_PERSIST_FIELDS.includes('customDraft') && !BUILD_PERSIST_FIELDS.includes('customDraftErrors'));
  assert.ok(!('open' in items[0]) && !('customOpen' in defaultBuildState()), 'no per-card open set: the editor is one dialog on the draft');
  // An override is read by own key only.
  assert.deepEqual(overrideFor({ overrides: Object.create({ kafka_produce_latency_p99: { objective: 0.5 } }) }, 'kafka_produce_latency_p99'), {});
  assert.deepEqual(overrideFor({ overrides: { kafka_produce_latency_p99: { objective: 0.5, window: '', nope: 1 } } }, 'kafka_produce_latency_p99'), { objective: 0.5 }, 'known fields with a value only');
  assert.deepEqual([customisedFields({ window: '7d', objective: 0.5 }), promqlEdited({ objective: 0.5 }), promqlEdited({ good: 'x' })], [['objective', 'window'], false, true]);
  assert.deepEqual(effectiveSli(INDEX.entries.find(e => e.id === 'kafka').slis.find(x => x.id === 'produce_latency_p99'), 'tier-2', { threshold: 0.2 }).threshold, 0.2);
  assert.deepEqual(customEffective(COPIES.custom[0]).good, COPIES.custom[0].good);
  assert.deepEqual([OVERRIDE_FIELDS, SLO_WINDOWS, PROMQL_FIELDS], [['id', 'objective', 'window', 'threshold', 'good_when', 'query', 'good', 'total', 'description', 'unit', 'semconv_metric'], ['7d', '28d', '30d', '90d'], ['query', 'good', 'total']], 'the engine\'s list, spelled once for the browser (tools/test-library.mjs pins the engine\'s)');
  // spec 1.3: the index rows carry the direction of a threshold SLI's bound, normalised (below where the template says nothing); the effective values read it under an override.
  const produce = INDEX.entries.find(e => e.id === 'kafka').slis.find(x => x.id === 'produce_latency_p99');
  assert.equal(produce.good_when, 'below');
  assert.ok(INDEX.entries.flatMap(e => e.slis).filter(s => s.type === 'threshold').every(s => s.good_when === 'below') && INDEX.entries.flatMap(e => e.slis).filter(s => s.type === 'ratio').every(s => !('good_when' in s)));
  assert.deepEqual([effectiveSli(produce, 'tier-2', {}).good_when, effectiveSli(produce, 'tier-2', { good_when: 'above' }).good_when, customEffective({ type: 'threshold', threshold: 2 }).good_when, customEffective({ type: 'threshold', threshold: 2, good_when: 'above' }).good_when], ['below', 'above', null, 'above']);
  assert.deepEqual(customisedFields({ good_when: 'above', objective: 0.5 }), ['objective', 'good_when']);
  // The engine's answer to the drive's copies, for the record: the SLO ids follow the objectives, the evidence dropped where the query was edited, the custom SLI in every section.
  const r = b.result;
  assert.equal(r.canonical.spec.slos.find(x => x.sli === 'kafka_produce_latency_p99').id, 'kafka_produce_latency_p99_99_5');
  assert.equal(r.provenance.slis.http_service_latency_p99.evidence.status, 'custom');
  assert.ok(r.canonical.spec.policy.burn_rate_alerts.some(a => a.slo === 'checkout_success_99_9'));
  assert.deepEqual(r.schemaErrors, []);
  assert.deepEqual(customisedMap(r), { kafka_produce_latency_p99: { fields: ['objective', 'window'], custom: false, evidence: 'recorded-live' }, http_service_latency_p99: { fields: ['query'], custom: false, evidence: 'custom' }, checkout_success: { fields: [], custom: true, evidence: 'custom' } });
  // DEFINE's L1 candidates carry the copies too: the custom SLI as a candidate, the above-tier and customised tags.
  const cands = sliCandidates({ build: draft({ ...COPIES, slis: [...FIXTURE.provenance.toggles.slis, 'kafka_controller_election_rate'] }), library: LIBRARY });
  assert.equal(cands.length, 9);
  assert.deepEqual(cands.at(-1).key, 'checkout_success');
  const ghosts = buildDefineModel({ build: draft({ ...COPIES, slis: [...FIXTURE.provenance.toggles.slis, 'kafka_controller_election_rate'], result: null }), library: LIBRARY, requirements: REQUIREMENTS }).stack.slabs.find(x => x.id === 'L1').ghosts;
  assert.deepEqual(ghosts.find(g => g.key === 'sli:kafka_controller_election_rate').tags, ['sli', 'threshold', 'kafka', 'from tier-1']);
  assert.deepEqual(ghosts.find(g => g.key === 'sli:kafka_produce_latency_p99').tags, ['sli', 'threshold', 'kafka', 'customised']);
  assert.deepEqual(ghosts.find(g => g.key === 'sli:checkout_success').tags, ['sli', 'ratio', 'custom']);
  assert.equal(ghosts.find(g => g.key === 'slo:kafka_produce_latency_p99').desc, '99.5% over 7d');
  // A threshold candidate's ghost prints its bound with its direction under the title (the adapter's card will, once the pack exists); a ratio one nothing.
  assert.equal(ghosts.find(g => g.key === 'sli:kafka_produce_latency_p99').subtitle, '≤ 0.1 seconds');
  assert.ok(!('subtitle' in ghosts.find(g => g.key === 'sli:checkout_success')));
  const floorGhosts = buildDefineModel({ build: draft({ ...COPIES, overrides: { ...COPIES.overrides, kafka_produce_latency_p99: { ...COPIES.overrides.kafka_produce_latency_p99, good_when: 'above' } }, result: null }), library: LIBRARY, requirements: REQUIREMENTS }).stack.slabs.find(x => x.id === 'L1').ghosts;
  assert.equal(floorGhosts.find(g => g.key === 'sli:kafka_produce_latency_p99').subtitle, '≥ 0.1 seconds');
  assert.ok(buildStackHtml(buildDefineModel({ build: draft({ ...COPIES, result: null }), library: LIBRARY, requirements: REQUIREMENTS }).stack).includes('<div class="card-sub">≤ 0.1 seconds</div>'));
});

test('the custom-form model: the id slugged from the name until it is typed, the fields per type, the clash with an SLI of the pack, the engine\'s errors inline, the definition the engine takes', () => {
  assert.deepEqual(['Checkout success', 'HTTP 5xx rate!', '9 lives', '__x', 'a'.repeat(70)].map(slugifySliId), ['checkout_success', 'http_5xx_rate', 'lives', 'x', 'a'.repeat(63)]);
  const empty = customFormModel(null);
  assert.deepEqual([empty.draft.type, empty.draft.objective, empty.draft.window, empty.draft.id, empty.canSubmit, empty.addLabel, empty.focusKey], ['ratio', '99.9', '30d', '', false, 'Add to the pack', 'cf:add']);
  assert.deepEqual(empty.fields.map(f => f.id), ['name', 'id', 'type', 'description', 'objective', 'window', 'semconv_metric', 'good', 'total'], 'the editor\'s reading order: identity, objective, metric, PromQL');
  assert.deepEqual(empty.fields.map(f => f.focusKey), ['cf:name', 'cf:id', 'cf:type', 'cf:description', 'cf:objective', 'cf:window', 'cf:semconv_metric', 'cf:good', 'cf:total']);
  assert.deepEqual(empty.required, ['objective', 'window', 'good', 'total']);
  const typed = customFormModel({ name: 'Checkout success', good: 'sum(rate(checkout_ok_total[5m]))', total: 'sum(rate(checkout_total[5m]))' });
  assert.deepEqual([typed.draft.id, typed.canSubmit, typed.idClash, typed.fields.find(f => f.id === 'name').hint], ['checkout_success', true, null, 'id checkout_success']);
  const threshold = customFormModel({ name: 'Checkout p99', type: 'threshold', query: 'x', threshold: '0.3' });
  assert.deepEqual(threshold.fields.map(f => f.id), ['name', 'id', 'type', 'description', 'objective', 'window', 'threshold', 'good_when', 'unit', 'semconv_metric', 'query']);
  assert.deepEqual([threshold.required, threshold.canSubmit, threshold.draft.good_when], [['objective', 'window', 'query', 'threshold'], true, 'below'], 'the direction is not required: below is the default');
  assert.equal(customFormModel({ name: 'Checkout p99', type: 'threshold', query: 'x' }).canSubmit, false, 'the bound is required');
  // A typed id sticks; a clash with an SLI of the pack is said before the engine is asked.
  const own = customFormModel({ name: 'Checkout success', id: 'checkout_ok', idTouched: true, good: 'a', total: 'b' });
  assert.equal(own.draft.id, 'checkout_ok');
  const clash = customFormModel({ name: 'kafka broker availability', good: 'a', total: 'b' }, { existingKeys: ['kafka_broker_availability'] });
  assert.deepEqual([clash.draft.id, clash.canSubmit, clash.fields.find(f => f.id === 'id').error], ['kafka_broker_availability', false, 'kafka_broker_availability is already an SLI of the pack or of a selected product — pick another name']);
  assert.deepEqual([clash.existingKeys, clash.existingSloIds], [['kafka_broker_availability'], []], 'the inputs come back, so the wiring rebuilds the same model as the user types');
  const oneLetter = customFormModel({ name: 'x', good: 'a', total: 'b' });
  assert.deepEqual([oneLetter.canSubmit, oneLetter.fields.find(f => f.id === 'id').error], [false, 'an id is a slug of 2 to 63 characters: a letter, then letters, digits or _'], 'a one-letter id is not a slug the engine takes');
  // An SLO id the pack already carries is said on the id field before the engine refuses it (sloIdFor mirrors the engine's).
  assert.deepEqual([sloIdFor('broker_availability', 0.9999), sloIdFor('checkout_success', 0.999), sloIdFor('x', 0.09)], [engineSloIdFor('broker_availability', 0.9999), engineSloIdFor('checkout_success', 0.999), engineSloIdFor('x', 0.09)]);
  const sloClash = customFormModel({ name: 'kafka broker availability 99', good: 'a', total: 'b', objective: '99' }, { existingSloIds: ['kafka_broker_availability_99_99'] });
  assert.deepEqual([sloClash.draft.id, sloClash.sloClash, sloClash.canSubmit, sloClash.fields.find(f => f.id === 'id').error], ['kafka_broker_availability_99', 'kafka_broker_availability_99 at 99 % would share the SLO id kafka_broker_availability_99_99 with an SLI of the pack — pick another id or objective', false, 'kafka_broker_availability_99 at 99 % would share the SLO id kafka_broker_availability_99_99 with an SLI of the pack — pick another id or objective']);
  assert.equal(customFormModel({ name: 'kafka broker availability 99', good: 'a', total: 'b', objective: '99.9' }, { existingSloIds: ['kafka_broker_availability_99_99'] }).canSubmit, true, 'another objective: another SLO id');
  const withSlos = buildEditorModel({ build: copiesDraft({ editor: { create: true }, customDraft: { name: 'kafka produce latency p99 99', good: 'a', total: 'b', objective: '5' } }), library: LIBRARY, mode: 'edit' }).form;
  assert.ok(withSlos.existingSloIds.includes('kafka_produce_latency_p99_99_5') && withSlos.sloClash && !withSlos.canSubmit, 'the editor model hands the pack\'s SLO ids in');
  // The metric is optional on the form and travels only when typed.
  assert.equal(customDefFromDraft({ name: 'X', good: 'a', total: 'b', semconv_metric: ' checkout.success ' }).semconv_metric, 'checkout.success');
  assert.ok(!('semconv_metric' in customDefFromDraft({ name: 'X', good: 'a', total: 'b' })));
  // The engine's usage errors of the last attempt, keyed by field (from the 400).
  const errs = splitBuildErrors(['custom checkout_success.window: the window is one of 7d | 28d | 30d | 90d (the schema\'s SLO windows), got "30x"']).byCustom;
  const withErr = customFormModel({ name: 'Checkout success', good: 'a', total: 'b', window: '30x' }, { errors: errs });
  assert.equal(withErr.fields.find(f => f.id === 'window').error, 'the window is one of 7d | 28d | 30d | 90d (the schema\'s SLO windows), got "30x"');
  assert.equal(withErr.generalError, null);
  const general = customFormModel({ name: 'Checkout success', good: 'a', total: 'b' }, { errors: splitBuildErrors(['custom checkout_success: something']).byCustom });
  assert.equal(general.generalError, 'something');
  // The definition the engine takes: the percent → the ratio, the bound a number, empty fields left out.
  assert.deepEqual(customDefFromDraft({ name: 'Checkout success', good: 'a', total: 'b', objective: '99.9', window: '30d', description: ' ' }), { id: 'checkout_success', type: 'ratio', objective: 0.999, window: '30d', good: 'a', total: 'b' });
  assert.deepEqual(customDefFromDraft({ name: 'Checkout p99', type: 'threshold', query: 'q', threshold: '0.3', unit: 'seconds', objective: '99', window: '7d', description: 'p99' }), { id: 'checkout_p99', type: 'threshold', objective: 0.99, window: '7d', query: 'q', threshold: 0.3, unit: 'seconds', description: 'p99' });
  assert.equal(normalizeDraft({ type: 'nope' }).type, 'ratio');
  // The definition the form makes is one the engine accepts.
  const made = instantiateInProcess({ ...INPUTS, custom: [customDefFromDraft({ name: 'Checkout success', good: 'sum(rate(checkout_ok_total[5m]))', total: 'sum(rate(checkout_total[5m]))' })] });
  assert.ok(made.canonical.spec.slos.some(x => x.id === 'checkout_success_99_9') && made.schemaErrors.length === 0);
  // The kinds the studio warns about: override joined, sli-excluded retired.
  assert.ok(WARNING_KINDS.override && !WARNING_KINDS['sli-excluded']);
  assert.equal(summarizeWarnings([{ kind: 'override', sli: 'x', message: 'm' }])[0].label, 'Override kept aside');
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
  // Above the tier: added like any other — the tier is a seed, not a gate.
  const above = addSliSelection({ build: draft(), library: LIBRARY }, 'kafka', 'controller_election_rate');
  assert.deepEqual([above.changed, above.reason, above.entries, above.slis], [true, null, ['kafka', 'http-service'], [...FIXTURE.provenance.toggles.slis.slice(0, 5), 'kafka_controller_election_rate', ...FIXTURE.provenance.toggles.slis.slice(5)]], 'the seven plus the tier-1 one, in the entries\' order');
  const aboveForeign = addSliSelection({ build: draft(), library: LIBRARY }, 'ibm-mq', 'canary_roundtrip_p99');   // an MQ tier-1 SLI, at tier-2
  assert.ok(aboveForeign.changed && aboveForeign.entries.includes('ibm-mq') && aboveForeign.slis.includes('ibm_mq_canary_roundtrip_p99'), JSON.stringify(aboveForeign));
  assert.equal(aboveForeign.slis.filter(k => k.startsWith('ibm_mq_')).length, 1, 'only the one asked for; the MQ defaults do not pour in');
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
  assert.deepEqual([l1.mode, l1.readOnly, l1.state, l1.stateText], ['edit', false, 'pass', '3 of 3 clauses pass']);
  assert.deepEqual(l1.clauses.map(c => [c.id, c.state]), [['L1.MUST.availability_slo', 'pass'], ['L1.MUST.latency_slo', 'pass'], ['L1.MUST.sli_covered_by_slo', 'pass']]);
  assert.equal(l1.rolodex.items.length, 10);
  assert.deepEqual(l1.rolodex.counts, { total: 10, selected: 7, selectable: 10, aboveTier: 0, customised: 0, custom: 0, library: 10, chosen: 2 }, 'aboveTier counts the SLIs in the pack from a higher tier — informational, none by default');
  assert.deepEqual(l1.rolodex.allKeys, FIXTURE.provenance.toggles.slis);
  assert.equal(l1.rolodex.filterAll, false);
  assert.ok(l1.rolodex.create && l1.rolodex.editLabel === 'Edit', 'the + Custom SLI card and Edit while composing');
  assert.equal(sheet('L1', {}, draft({ rolodexAll: true })).rolodex.items.length, 56);
  assert.ok(l1.rolodex.items.every(i => !('face' in i) && !('open' in i)), 'no face, no open set: the editor is a dialog of its own (tools/test-build-editor.mjs)');
  // The copies on the sheet: the counts; Verify's View; no create card off the composing mode.
  const withCopies = sheet('L1', {}, copiesDraft({ slis: [...FIXTURE.provenance.toggles.slis, 'kafka_controller_election_rate'] }));
  assert.deepEqual(withCopies.rolodex.counts, { total: 11, selected: 9, selectable: 10, aboveTier: 1, customised: 2, custom: 1, library: 10, chosen: 2 });
  const verifyCopies = buildSheetModel({ layerId: 'L1', build: copiesDraft(), library: LIBRARY, requirements: T2, mode: 'verify' });
  assert.deepEqual([verifyCopies.rolodex.create, verifyCopies.rolodex.editLabel], [false, 'View']);
  assert.equal(buildSheetModel({ layerId: 'L1', build: draft({ step: 'define' }), library: LIBRARY, requirements: T2, mode: sheetModeFor('define') }).rolodex.create, true, 'the create card on DEFINE too: the sheet is live there');
  // The engine's error on an override marks its card (the editor's field carries it when the editor is open).
  const errSheet = sheet('L1', {}, copiesDraft({ error: ['override kafka_produce_latency_p99.window: the window is one of 7d | 28d | 30d | 90d'] }));
  assert.deepEqual(errSheet.rolodex.items.find(i => i.key === 'kafka_produce_latency_p99').errorFields, ['window']);
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
  assert.deepEqual(['define', 'compile', 'verify', 'other'].map(sheetModeFor), ['edit', 'edit', 'verify', 'edit'], 'live on Define and Compile, read-only on Verify — the preview mode is retired');
});

test('the sheet is one component on the three steps: live on DEFINE (its pack is instantiated already) and COMPILE, read-only with the todos on VERIFY; no preview, no "Compose in Compile"', () => {
  const define = buildSheetModel({ layerId: 'L1', build: draft({ step: 'define' }), library: LIBRARY, requirements: T2, mode: sheetModeFor('define') });
  assert.deepEqual([define.mode, define.readOnly, define.todos, define.rolodex.create, define.rolodex.editLabel], ['edit', false, [], true, 'Edit'], 'the same live sheet on DEFINE');
  assert.ok(!('compose' in define), 'no compose action anywhere');
  assert.equal(define.rolodex.items.length, 10, 'the candidates are the same items');
  const edit = buildSheetModel({ layerId: 'L4', build: draft({ step: 'compile' }), library: LIBRARY, requirements: T2, mode: 'edit' });
  assert.deepEqual([edit.readOnly, edit.todos, edit.todoCount], [false, [], 5]);
  const verify = buildSheetModel({ layerId: 'L4', build: draft({ step: 'verify' }), library: LIBRARY, requirements: T2, mode: 'verify' });
  assert.deepEqual([verify.readOnly, 'compose' in verify], [true, false]);
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
  // The entrance plays on the opening render only: `entering` (the controller's one-shot) adds is-entering to the
  // scrim and the panel; a model built without it — every re-render while the sheet stays open — carries no class.
  const entering = buildSheetHtml(buildSheetModel({ layerId: 'L1', build: draft(), library: LIBRARY, requirements: T2, mode: 'edit', entering: true }));
  assert.ok(entering.includes('<div class="build-sheet-scrim is-entering" data-close') && entering.includes('<aside class="build-sheet is-edit is-pass is-entering" role="dialog"'));
  assert.equal(buildSheetModel({ layerId: 'L1', build: draft(), library: LIBRARY, requirements: T2, mode: 'edit' }).entering, false, 'off by default: a re-render never replays the entrance');
  assert.ok(!l1.includes('is-entering'));
  assert.ok(l1.includes('<h2 class="build-sheet-title" id="build-sheet-title">L1 · Contract</h2>'));
  assert.ok(l1.includes('<p class="build-sheet-question" id="build-sheet-question">What should we measure?</p>'));
  assert.ok(l1.includes('class="build-sheet-close" data-close aria-label="Close the layer sheet (Esc)"'));
  assert.ok(l1.includes('Clauses at tier-2 <span class="build-sheet-count">3</span>'));
  assert.equal((l1.match(/<li class="build-rail-clause is-pass"/g) || []).length, 3, 'the clause rows are the shared atom');
  // The rolodex: ten SLI cards and the '+ Custom SLI' card, the objective each starts with large, the other tiers muted, a switch each; the above-tier one addable with its note.
  assert.equal((l1.match(/class="build-rolo-card/g) || []).length, 11);
  assert.equal((l1.match(/class="build-rolo-card build-rolo-create"/g) || []).length, 1, 'the last card opens the editor in create mode');
  assert.ok(l1.includes('<div class="build-rolodex-track" role="group" aria-roledescription="carousel" aria-label="SLI cards — arrow keys move" tabindex="0" data-scroll-key="rolodex:L1">'));
  // The scroll offsets rerenderBuild preserves are keyed per layer: what L1's body scrolled to is not
  // restored on L3's body, so a newly opened layer starts at its top (measured: it opened pre-scrolled).
  const scrollKeys = (h) => [...h.matchAll(/data-scroll-key="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(scrollKeys(l1), ['sheet:L1', 'rolodex:L1']);
  assert.deepEqual(scrollKeys(html('L3')), ['sheet:L3']);
  assert.ok(!scrollKeys(l1).some(k => scrollKeys(html('L3')).includes(k)), 'no scroll key shared between two layers\' sheets');
  assert.deepEqual(scrollKeys(html('L1', 'edit', draft({ step: 'define' }))), ['sheet:L1', 'rolodex:L1'], 'the same layer keeps its key across steps and re-renders');
  assert.ok(l1.includes('<span class="build-rolo-id">broker_availability</span>') && l1.includes('<code>up</code>'));
  assert.ok(l1.includes('<b>99.9%</b><span>over 30d · at tier-2</span>'));
  assert.ok(l1.includes('class="is-muted" title="tier-3: 99% over 30d">tier-3 <b>99%</b> 30d</span>'));
  assert.ok(l1.includes('role="switch" class="build-switch" aria-checked="true" aria-label="broker_availability of Apache Kafka — remove from the pack" data-focus-key="sli:kafka:broker_availability" data-sli="kafka_broker_availability" data-entry="kafka" data-sli-id="broker_availability" data-selected="1" data-entry-selected="1"'));
  // Above the tier: no disabled switch, no "needs tier-1" — an informational chip, the profile it starts from, the switch live.
  assert.ok(l1.includes('aria-label="controller_election_rate of Apache Kafka — add to the pack (from the tier-1 profile)" data-focus-key="sli:kafka:controller_election_rate" data-sli="kafka_controller_election_rate" data-entry="kafka" data-sli-id="controller_election_rate" data-selected="0" data-entry-selected="1"'), 'the above-tier switch is live');
  assert.ok(!/aria-label="controller_election_rate[^"]*"[^>]*\bdisabled\b/.test(l1) && !l1.includes('build-rolo-needs') && !l1.includes('needs tier-1'));
  assert.ok(l1.includes('<span class="build-rolo-chip is-above" title="this SLI&#39;s own tier is tier-1: it starts from that profile&#39;s objective and window — add it if you need it, the tier is a seed, not a gate">from the tier-1 profile</span>'));
  assert.ok(l1.includes('<b>99%</b><span>over 7d · the tier-1 profile</span>'));
  assert.equal((l1.match(/build-rolo-chip is-above/g) || []).length, 3, 'the three tier-1 SLIs of the selection');
  assert.ok(l1.includes('data-edit-sli="kafka_broker_availability" data-focus-key="edit:kafka_broker_availability" aria-haspopup="dialog" aria-label="Edit broker_availability"') && l1.includes('>Edit</button>'), 'a card of a selected entry has Edit, which opens the pop-up editor');
  assert.ok(l1.includes('data-edit-sli="kafka_controller_election_rate"'), 'an SLI not in the pack is editable too: its edits wait with it');
  assert.ok(!l1.includes('id="build-window-options"') && !l1.includes('data-customise') && !l1.includes('build-edit-face'), 'the window datalist, the face and the form live in the editor now');
  assert.ok(l1.includes('data-rolodex-all="0"') && l1.includes('show every product'));
  assert.ok(l1.includes('1 / 11'));
  assert.ok(l1.includes('7 in the pack · 10 in the library'));
  // The SLOs switch with its consequence in one line.
  assert.ok(l1.includes('role="switch" class="build-switch" aria-checked="true" aria-label="SLOs section" data-focus-key="toggle:slos" data-toggle="slos"'));
  assert.ok(l1.includes('off is expected to drop 4 clauses of the tier: availability SLO, latency SLO, every SLI under an SLO, chaos in staging'));
  assert.ok(!l1.includes('data-compose'), 'no compose action on COMPILE');
  // Every product: a foreign card is dashed, its switch says it selects the product.
  const all = html('L1', 'edit', draft({ rolodexAll: true }));
  assert.equal((all.match(/class="build-rolo-card/g) || []).length, 57);
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
  // DEFINE: the same live sheet — Edit on every card, the create card, live switches and params; no compose action, no preview.
  const df = html('L1', sheetModeFor('define'), draft({ step: 'define' }));
  assert.ok(df.includes('data-mode="edit"') && !df.includes('data-compose') && !df.includes('preview'));
  assert.ok(df.includes('data-edit-sli="kafka_broker_availability"') && df.includes('build-rolo-create') && (df.match(/class="build-rolo-card/g) || []).length === 11);
  assert.ok(!/role="switch"[^>]*\bdisabled\b/.test(df.replace(/data-toggle="policy"[^>]*/, '')), 'the switches flip on DEFINE');
  const df2 = html('L2', sheetModeFor('define'), draft({ step: 'define' }));
  assert.ok(df2.includes('build-param-input') && df2.includes('data-focus-key="param:kafka.broker_targets@L2/sheet"'), 'the params are editable on DEFINE');
  // Read-only params (Verify) draw the value as a code span, never an input.
  const ro2 = html('L2', 'verify');
  assert.ok(ro2.includes('class="build-param build-param-read is-placeholder" data-param="kafka.broker_targets"') && ro2.includes('<code class="build-param-value">kafka-broker.kafka:9404</code>'));
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
  // The read-only param row is the one atom's other face: the same label block (name, key, scaffold mark, the
  // placeholder flag with its title), the value as a code span, no input, no description.
  const p = { key: 'k', label: 'K', effective: 'v', value: '', placeholder: true, atDefault: false, description: 'd' };
  const read = paramRowHtml(p, { readOnly: true }), edit = paramRowHtml(p);
  assert.ok(read.includes('class="build-param build-param-read is-placeholder is-set"') && read.includes('<code class="build-param-value">v</code>') && !read.includes('<input') && !read.includes('build-param-desc'));
  assert.ok(read.includes('<span class="build-param-flag" title="left at its default this value is written into the pack AND reported as a todo">placeholder filled</span>'), 'the flag keeps its title in the read-only row');
  assert.equal(read.match(/<span class="build-param-label">([\s\S]*?)<\/span>\s*<code/)[1], edit.match(/<label class="build-param-label" for="bp-k">([\s\S]*?)<\/label>/)[1], 'one label block for both faces');
  assert.equal(paramLabelHtml(p), `<span class="build-param-label">${paramLabelHtml(p, 'x').match(/for="x">([\s\S]*)<\/label>$/)[1]}</span>`);
  assert.ok(paramRowHtml({ ...p, error: 'no' }, { readOnly: true }).includes('<span class="build-param-flag is-error">rejected</span>') && paramRowHtml({ ...p, error: 'no' }, { readOnly: true }).includes('role="alert">no</span>'));
});

test('the rolodex carries Edit (View on Verify) and the + Custom SLI card in place of the face and the form; a renamed SLI shows the id the pack carries; the stack\'s L1 cards keep the customised note; the focus fallbacks know the editor', () => {
  const html = buildSheetHtml(buildSheetModel({ layerId: 'L1', build: copiesDraft(), library: LIBRARY, requirements: T2, mode: 'edit' }));
  // A renamed SLI shows the id the pack carries; the key stays the library's on the card and its switch.
  const renamed = buildSheetHtml(buildSheetModel({ layerId: 'L1', build: copiesDraft({ overrides: { ...COPIES.overrides, http_service_availability: { id: 'http_availability' } } }), library: LIBRARY, requirements: T2, mode: 'edit' }));
  assert.ok(renamed.includes('<span class="build-rolo-id">http_availability</span>') && renamed.includes('data-sli="http_service_availability" data-entry="http-service" data-sli-id="availability"'));
  assert.ok(renamed.includes('data-edit-sli="http_service_availability" data-focus-key="edit:http_service_availability" aria-haspopup="dialog" aria-label="Edit http_availability"'));
  // Every card of a selected entry has Edit (in the pack or not); a custom card's says so; no face, no form, no Customise.
  assert.ok(html.includes('data-edit-sli="kafka_produce_latency_p99" data-focus-key="edit:kafka_produce_latency_p99" aria-haspopup="dialog" aria-label="Edit produce_latency_p99"') && html.includes('>Edit</button>'));
  assert.ok(html.includes('data-edit-sli="kafka_controller_election_rate"'), 'an SLI not in the pack is editable too — its edits wait with it');
  assert.ok(html.includes('data-edit-sli="checkout_success" data-edit-custom="1" data-focus-key="edit:checkout_success"'));
  assert.ok(!html.includes('build-edit-face') && !html.includes('data-customise') && !html.includes('build-custom-form') && !html.includes('<textarea'), 'the in-card face and the form card are gone');
  assert.ok(html.includes('<button type="button" class="build-rolo-card build-rolo-create" data-snap-card data-edit-create data-focus-key="edit:create" aria-haspopup="dialog" aria-label="Add a custom SLI — opens the editor">'));
  assert.ok(html.includes('<span class="build-rolo-chip is-customised" title="customised: objective, window">customised</span>') && html.includes('<b>99.5%</b><span>over 7d · customised</span>'));
  // A threshold card prints its bound with the side that is good (spec 1.3): ≤ a ceiling (the library's every bound), ≥ once overridden to a floor; a ratio card prints none.
  assert.ok(html.includes('<div class="build-rolo-bound" title="the bound, and the side of it that is good (≤ a ceiling, ≥ a floor)">≤ 0.1 seconds</div>'));
  const floorCard = buildSheetHtml(buildSheetModel({ layerId: 'L1', build: copiesDraft({ overrides: { ...COPIES.overrides, kafka_produce_latency_p99: { ...COPIES.overrides.kafka_produce_latency_p99, good_when: 'above' } } }), library: LIBRARY, requirements: T2, mode: 'edit' }));
  assert.ok(floorCard.includes('≥ 0.1 seconds</div>') && floorCard.includes('title="customised: objective, window, good_when"'));
  assert.equal((html.match(/class="build-rolo-bound"/g) || []).length, rolodexItems({ build: copiesDraft(), library: LIBRARY }).filter(i => i.type === 'threshold').length, 'one bound line per threshold card, none on a ratio card');
  assert.ok(html.includes('<div class="build-rolo-evidence-note">edited — the library’s evidence no longer applies</div>'));
  assert.ok(html.includes('<span class="build-rolo-chip is-custom" title="written in the studio — not a library SLI">custom</span>'));
  // A foreign card (its product not selected) has no Edit: adding it selects the product first.
  const all = buildSheetHtml(buildSheetModel({ layerId: 'L1', build: copiesDraft({ rolodexAll: true }), library: LIBRARY, requirements: T2, mode: 'edit' }));
  assert.ok(!/data-edit-sli="ibm_mq_/.test(all) && all.includes('data-sli="ibm_mq_qmgr_process_up"'));
  // VERIFY: View opens the read-only editor; no create card.
  const verify = buildSheetHtml(buildSheetModel({ layerId: 'L1', build: copiesDraft(), library: LIBRARY, requirements: T2, mode: 'verify' }));
  assert.ok(verify.includes('aria-label="View produce_latency_p99"') && verify.includes('>View</button>') && !verify.includes('data-edit-create'));
  assert.ok(!verify.includes('build-edit-face') && !verify.includes('<textarea'));
  // The rejected chip stays on the card whether or not the editor is open, and the compile note names the field and the card.
  const errHtml = buildSheetHtml(buildSheetModel({ layerId: 'L1', build: copiesDraft({ error: ['override kafka_produce_latency_p99.window: the window is one of 7d | 28d | 30d | 90d'] }), library: LIBRARY, requirements: T2, mode: 'edit' }));
  assert.ok(errHtml.includes('class="build-rolo-card is-selected is-customised is-error"') && errHtml.includes('rejected: window</span>'));
  assert.match(instantiateErrorHtml(splitBuildErrors(['override kafka_produce_latency_p99.window: no']), { where: 'x' }), /1 customised value rejected — kafka_produce_latency_p99\.window: open its card on L1/);
  // Escaping at the seam: a hostile override never becomes markup.
  const hostile = draft({ overrides: { kafka_produce_latency_p99: { description: '<img src=x onerror="1">' } } });
  assert.ok(!buildSheetHtml(buildSheetModel({ layerId: 'L1', build: hostile, library: LIBRARY, requirements: T2, mode: 'edit' })).includes('<img'));
  // The VERIFY stack: an L1 SLI card whose provenance says customised carries the note (the shared card body's optional note).
  const stackHtml = buildStackHtml(buildVerifyModel({ build: copiesDraft(), library: LIBRARY, clauses: T2, targets: TARGETS }).stack);
  assert.ok(stackHtml.includes('<span class="card-note">customised: objective, window</span>') && stackHtml.includes('<span class="card-note">customised: query</span>') && stackHtml.includes('<span class="card-note">custom — written in the studio</span>'));
  assert.equal((stackHtml.match(/class="card-note"/g) || []).length, 3, 'the SLI cards only, never the SLO cards');
  assert.ok(!artefactCardHtml({ id: 'X', title: 'x' }).includes('card-note') && artefactCardHtml({ id: 'X', title: 'x' }, { note: 'a <b>' }).includes('<span class="card-note">a &lt;b&gt;</span>'));
  const verifyStack = buildVerifyModel({ build: copiesDraft(), library: LIBRARY, clauses: T2, targets: TARGETS }).stack;
  assert.deepEqual(verifyStack.slabs.find(x => x.id === 'L1').artefacts.filter(a => a.customised || a.custom).map(a => [a.title, a.customNote]), [['kafka_produce_latency_p99', 'customised: objective, window'], ['http_service_latency_p99', 'customised: query'], ['checkout_success', 'custom — written in the studio']]);
  // DEFINE's candidate ghost names a renamed SLI as the pack will carry it; its key stays the library's.
  const ghosts = buildDefineModel({ build: draft({ overrides: { kafka_broker_availability: { id: 'brokers_up' } }, result: null }), library: LIBRARY, requirements: REQUIREMENTS }).stack.slabs.find(x => x.id === 'L1').ghosts;
  assert.deepEqual([ghosts.find(g => g.key === 'sli:kafka_broker_availability')?.title, ghosts.find(g => g.key === 'slo:kafka_broker_availability')?.title], ['brokers_up', 'SLO on brokers_up']);
  // Focus fallbacks: an editor key stays in the editor, then the sheet; Edit and a switch land on the sheet; a stack card on the L1 head.
  assert.deepEqual(focusFallbackSelectors('ov:kafka_produce_latency_p99:objective'), ['.build-editor .build-edit-input', '.build-editor [data-editor-done]', '.build-editor [data-editor-close]', '.build-sheet .build-rolo-card [data-edit-sli]', '.build-sheet-close']);
  assert.equal(focusFallbackSelectors('cf:name')[0], '.build-editor .build-edit-input');
  assert.deepEqual(focusFallbackSelectors('ov:kafka_produce_latency_p99:window:reset'), ['[data-focus-key="ov:kafka_produce_latency_p99:window"]', '.build-editor .build-edit-input', '.build-editor [data-editor-done]', '.build-editor [data-editor-close]']);
  assert.deepEqual(focusFallbackSelectors('edit:checkout_success'), ['.build-sheet .build-rolo-card [data-edit-sli]', '.build-sheet .build-param-input', '.build-sheet-close']);
  assert.deepEqual(focusFallbackSelectors('sli:custom:checkout_success'), ['.build-sheet .build-rolo-card [data-edit-sli]', '.build-sheet .build-param-input', '.build-sheet-close']);
  assert.deepEqual(focusFallbackSelectors('card:SLI-01'), ['.build-slab[data-layer="L1"] .build-slab-edge']);
  // The editor's own controls (Reset all vanishes once nothing is customised): Done, then the create button, then the esc button, then a field.
  assert.deepEqual(focusFallbackSelectors('editor:reset-all'), ['.build-editor [data-editor-done]', '.build-editor [data-editor-submit]', '.build-editor [data-editor-close]', '.build-editor .build-edit-input']);
  assert.equal(focusFallbackSelectors('editor:done')[0], '.build-editor [data-editor-done]');
});

test('the rolodex’s handlers write through the actions: Edit → openEditor with the card’s key and its focus key as the opener, + Custom SLI → openEditor create, a custom switch → removeCustom, an above-tier switch → setSli', () => {
  const calls = [];
  const act = { openEditor: (o) => calls.push(['open', o]), removeCustom: (id) => calls.push(['remove', id]), setSli: (k, on) => calls.push(['sli', k, on]), addSli: (e, s) => calls.push(['addSli', e, s]), update() {}, closeSheet() {}, setToggle() {}, setParam() {} };
  const model = buildSheetModel({ layerId: 'L1', build: copiesDraft(), library: LIBRARY, requirements: T2, mode: 'edit' });
  const edit = fakeEl({ editSli: 'kafka_produce_latency_p99', focusKey: 'edit:kafka_produce_latency_p99' });
  const editCustom = fakeEl({ editSli: 'checkout_success', editCustom: '1', focusKey: 'edit:checkout_success' });
  const create = fakeEl({ editCreate: '', focusKey: 'edit:create' });
  const customSwitch = fakeEl({ sli: 'checkout_success', entry: '', sliId: 'checkout_success', selected: '1', entrySelected: '1', custom: '1' });
  const aboveSwitch = fakeEl({ sli: 'kafka_controller_election_rate', entry: 'kafka', sliId: 'controller_election_rate', selected: '0', entrySelected: '1' });
  wireBuildSheet(fakeContainer({ '[data-edit-sli]': [edit, editCustom], '[data-edit-create]': [create], '.build-switch[data-sli]': [customSwitch, aboveSwitch] }), model, { build: act });
  edit.fire('click'); editCustom.fire('click'); create.fire('click', { currentTarget: create });
  customSwitch.fire('click'); aboveSwitch.fire('click');
  assert.deepEqual(calls, [
    ['open', { key: 'kafka_produce_latency_p99', custom: false, opener: 'edit:kafka_produce_latency_p99' }],
    ['open', { key: 'checkout_success', custom: true, opener: 'edit:checkout_success' }],
    ['open', { create: true, opener: 'edit:create' }],
    ['remove', 'checkout_success'], ['sli', 'kafka_controller_election_rate', true],
  ]);
});

test('the definition column is a wizard stage: the live form on DEFINE (with the seeded note once seeded), the recessed seed card with "Change seed →" on COMPILE and VERIFY, the summary live under both', () => {
  // The models.
  const define = buildDefinitionModel({ build: draft({ step: 'define' }), library: LIBRARY, requirements: REQUIREMENTS });
  assert.deepEqual([define.mode, define.seeded, define.seededNote], ['form', true, SEEDED_NOTE]);
  assert.equal(SEEDED_NOTE, 'Seeded. Changing the tier re-grades the pack and refreshes library defaults; your customisations stay. Removing a product drops its SLIs.');
  const fresh = buildDefinitionModel({ build: draft({ step: 'define', seeded: false }), library: LIBRARY, requirements: REQUIREMENTS });
  assert.deepEqual([fresh.mode, fresh.seeded, fresh.seededNote], ['form', false, null]);
  const compile = buildDefinitionModel({ build: draft({ step: 'compile' }), library: LIBRARY, requirements: REQUIREMENTS });
  assert.equal(compile.mode, 'seed');
  assert.deepEqual(compile.seedCard, {
    name: 'orders-api', slug: 'orders-api', owners: ['team-orders'], environment: 'prod', tier: 'tier-2', must: 15, should: 1,
    tierChip: 'seeded at tier-2 · 15 MUST · 1 SHOULD',
    entries: [{ id: 'kafka', title: 'Apache Kafka', kind: 'product' }, { id: 'http-service', title: 'HTTP service (OTel semconv)', kind: 'archetype' }],
    counts: { slis: 7, aboveTier: 0, customised: 0, custom: 0 }, changeLabel: 'Change seed',
  });
  assert.equal(compile.summary.status, 'meets the tier-2 rubric', 'the summary is live on the seed card\'s step');
  assert.equal(buildDefinitionModel({ build: draft({ step: 'verify' }), library: LIBRARY, requirements: REQUIREMENTS }).mode, 'seed');
  const cold = seedCardModel(draft({ step: 'compile' }), LIBRARY, {});
  assert.deepEqual([cold.must, cold.should, cold.tierChip], [null, null, 'seeded at tier-2']);
  assert.deepEqual(seedCardModel(copiesDraft({ slis: [...FIXTURE.provenance.toggles.slis, 'kafka_controller_election_rate'] }), LIBRARY, REQUIREMENTS).counts, { slis: 9, aboveTier: 1, customised: 2, custom: 1 });
  assert.equal(seedCardModel(draft({ owners: '' }), LIBRARY, REQUIREMENTS).owners.length, 0);
  // DEFINE's primary action.
  assert.deepEqual([buildDefineModel({ build: draft({ seeded: false }), library: LIBRARY, requirements: REQUIREMENTS }).nextLabel, buildDefineModel({ build: draft(), library: LIBRARY, requirements: REQUIREMENTS }).nextLabel], ['Seed the pack', 'Continue to Compile']);
  // The renders.
  const render = (b) => { const c = stubContainer(); renderBuildDefinition(c, buildDefinitionModel({ build: b, library: LIBRARY, requirements: REQUIREMENTS }), { build: {} }); return c.innerHTML; };
  // On DEFINE the column is the progress summary of the four substeps (the form itself is on the step — the 2026-09 UX review).
  const formHtml = render(draft({ step: 'define' }));
  assert.ok(formHtml.includes('<p class="build-def-seeded" role="note">Seeded. Changing the tier re-grades the pack') && formHtml.includes('<nav class="build-def-group bd-progress" aria-label="Define progress">') && !formHtml.includes('build-seed"'));
  assert.ok(formHtml.includes('data-define-sub="service" data-focus-key="dprog:service">') && formHtml.includes('<span class="bd-progress-val" data-progress-val="service">orders-api · team-orders · prod</span>'));
  assert.ok(formHtml.includes('data-define-sub="review" data-focus-key="dprog:review" aria-current="step">'), 'a complete definition lands on the review substep');
  assert.ok(!formHtml.includes('id="build-name"') && !formHtml.includes('role="radiogroup"'), 'no form in the column');
  assert.ok(!render(draft({ step: 'define', seeded: false })).includes('build-def-seeded'), 'no note before the seed');
  const seedHtml = render(draft({ step: 'compile' }));
  assert.ok(seedHtml.includes('<div class="build-def-inner is-seeded">') && seedHtml.includes('<section class="build-seed" aria-label="Seed">') && seedHtml.includes('<div class="build-seed-eyebrow">Seed</div>'));
  assert.ok(!seedHtml.includes('<input') && !seedHtml.includes('role="radiogroup"') && !seedHtml.includes('build-chip"'), 'read-only: no input, no segmented control, no chips to press');
  assert.ok(seedHtml.includes('<dt>Service</dt><dd><code>orders-api</code></dd>') && seedHtml.includes('<dt>Owners</dt><dd><span>team-orders</span></dd>') && seedHtml.includes('<dt>Environment</dt><dd>prod</dd>'));
  assert.ok(seedHtml.includes('<span class="build-seed-chip is-tier" data-tier="tier-2">seeded at tier-2 · 15 MUST · 1 SHOULD</span>'));
  assert.ok(seedHtml.includes('<button type="button" class="build-seed-chip is-entry" data-seed-entry="kafka" data-focus-key="seed:kafka" aria-haspopup="dialog" title="product — open the L1 sheet on its SLIs">Apache Kafka</button>') && seedHtml.includes('data-seed-entry="http-service" data-focus-key="seed:http-service" aria-haspopup="dialog" title="archetype — open the L1 sheet on its SLIs">HTTP service (OTel semconv)</button>'), 'a product chip opens the L1 sheet on its SLIs');
  assert.ok(seedHtml.includes('<div class="build-seed-from">7 SLIs in the pack</div>'));
  assert.ok(seedHtml.includes('<button type="button" class="build-seed-change" data-change-seed data-focus-key="seed:change">Change seed <span aria-hidden="true">→</span></button>'));
  assert.ok(seedHtml.includes('class="build-summary is-ok"') && seedHtml.includes('meets the tier-2 rubric'), 'the summary stays live under the seed card');
  assert.ok(render(draft({ step: 'compile', owners: '' })).includes('<dd><em>none — a todo</em></dd>'));
  assert.ok(seedCardHtml(seedCardModel(copiesDraft({ slis: [...FIXTURE.provenance.toggles.slis, 'kafka_controller_election_rate'] }), LIBRARY, REQUIREMENTS)).includes('9 SLIs in the pack · 1 from a higher tier · 2 customised · 1 custom'));
  assert.ok(!seedCardHtml(seedCardModel(draft({ name: '<b>x</b>' }), LIBRARY, REQUIREMENTS)).includes('<b>x</b>'), 'escaped at the seam');
  // The wiring: "Change seed →" goes back to DEFINE; a product chip opens the L1 sheet on that product.
  const calls = [];
  const change = fakeEl({});
  const chip = fakeEl({ seedEntry: 'http-service' });
  wireBuildDefinition(fakeContainer({ '[data-change-seed]': [change], '[data-seed-entry]': [chip] }), {}, { build: { setStep: (s) => calls.push(['step', s]), openSheet: (l, o) => calls.push(['sheet', l, o]), update() {}, setTier() {}, toggleEntry() {} } });
  change.fire('click'); chip.fire('click');
  assert.deepEqual(calls, [['step', 'define'], ['sheet', 'L1', { entry: 'http-service' }]]);
  // DEFINE's render: the primary action reads the seed, and calls seed().
  const seedCalls = [];
  const c = stubContainer();
  const next = fakeEl({});
  c.querySelector = (sel) => (sel === '#build-next' ? next : { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
  renderBuildDefine(c, buildDefineModel({ build: draft({ seeded: false }), library: LIBRARY, requirements: REQUIREMENTS }), { build: { seed: () => seedCalls.push('seed'), setStep: (s) => seedCalls.push(s) } });
  assert.ok(c.innerHTML.includes('id="build-next" >Seed the pack <span aria-hidden="true">→</span></button>'));
  assert.ok(c.innerHTML.includes('seeding the pack opens Compile, where the artefacts are.'));
  next.fire('click');
  assert.deepEqual(seedCalls, ['seed']);
  const c2 = stubContainer();
  renderBuildDefine(c2, buildDefineModel({ build: draft(), library: LIBRARY, requirements: REQUIREMENTS }), { build: {} });
  assert.ok(c2.innerHTML.includes('>Continue to Compile <span aria-hidden="true">→</span></button>') && c2.innerHTML.includes('Seeded —'));
  // The sheet and the editor are live on DEFINE: the status never says the edits wait on Compile or that Compile is where one composes.
  for (const html of [c.innerHTML, c2.innerHTML]) assert.ok(!/wait on Compile|where you compose/.test(html), 'no stale copy about composing on Compile');
  assert.ok(c2.innerHTML.includes('your edits are already in the pack — Compile shows its artefacts.'));
  // The persisted shape carries the copies and the seed.
  for (const k of ['overrides', 'custom', 'seeded']) assert.ok(BUILD_PERSIST_FIELDS.includes(k), k);
  const fresh2 = defaultBuildState();
  assert.deepEqual([fresh2.overrides, fresh2.custom, fresh2.seeded, fresh2.editor, fresh2.editorDirty, fresh2.customDraft, fresh2.customDraftErrors], [{}, [], false, null, false, null, null]);
});

test('the sheet’s handlers write through the existing actions: close (button, scrim, Esc), the section switches, the rolodex switches, the filter', () => {
  const calls = [];
  const act = {
    closeSheet: () => calls.push(['close']), setStep: (s, o) => calls.push(['step', s, o]), setToggle: (id, on) => calls.push(['toggle', id, on]),
    setSli: (k, on, all) => calls.push(['sli', k, on, all.length]), addSli: (e, s) => calls.push(['add', e, s]), update: (p, o) => calls.push(['update', p, o]), setParam() {},
  };
  const model = buildSheetModel({ layerId: 'L1', build: draft(), library: LIBRARY, requirements: T2, mode: 'edit' });
  const closeBtn = fakeEl({}), scrim = fakeEl({}), sheet = fakeEl({});
  const slosSwitch = fakeEl({ toggle: 'slos' }, { checked: 'true' });
  const disabledSwitch = fakeEl({ toggle: 'policy' }, { checked: 'false', disabled: true });
  const remove = fakeEl({ sli: 'kafka_broker_availability', entry: 'kafka', sliId: 'broker_availability', selected: '1', entrySelected: '1' });
  const add = fakeEl({ sli: 'kafka_fetch_latency_p99', entry: 'kafka', sliId: 'fetch_latency_p99', selected: '0', entrySelected: '1' });
  const foreign = fakeEl({ sli: 'ibm_mq_qmgr_process_up', entry: 'ibm-mq', sliId: 'qmgr_process_up', selected: '0', entrySelected: '0' });
  const above = fakeEl({ sli: 'kafka_controller_election_rate', entry: 'kafka', sliId: 'controller_election_rate', selected: '0', entrySelected: '1' });
  const filter = fakeEl({ rolodexAll: '0' });
  wireBuildSheet(fakeContainer({
    '[data-close]': [closeBtn, scrim], '.build-sheet': [sheet],
    '.build-switch[data-toggle]': [slosSwitch, disabledSwitch], '.build-switch[data-sli]': [remove, add, foreign, above], '.build-switch[data-rolodex-all]': [filter],
  }), model, { build: act });
  closeBtn.fire('click'); scrim.fire('click');
  sheet.fire('keydown', { key: 'Escape' }); sheet.fire('keydown', { key: 'Enter' });
  // Esc anywhere on the sheet closes it (the fields that once needed a two-step Esc live in the editor now, which has its own).
  const plainButton = { tagName: 'BUTTON', closest: () => null };
  sheet.fire('keydown', { key: 'Escape', target: plainButton });
  slosSwitch.fire('click'); disabledSwitch.fire('click');
  remove.fire('click'); add.fire('click'); foreign.fire('click'); above.fire('click');
  filter.fire('click', { currentTarget: filter });
  assert.deepEqual(calls, [
    ['close'], ['close'], ['close'], ['close'],
    ['toggle', 'slos', false],
    ['sli', 'kafka_broker_availability', false, 7], ['sli', 'kafka_fetch_latency_p99', true, 7], ['add', 'ibm-mq', 'qmgr_process_up'], ['sli', 'kafka_controller_election_rate', true, 7],
    ['update', { rolodexAll: true }, { rerender: true, reinstantiate: false }],
  ], 'a disabled switch does nothing; a foreign SLI goes through addSli; an above-tier one flips like any other; Enter is not Esc; Esc on any control closes');
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

test('an L1 SLI or SLO card on the stack is a control that opens the SLI’s editor — a focusable role=button with aria-haspopup, Enter and Space, an SLO card landing on the objective, a candidate ghost on DEFINE too; the header tab names read the step word', () => {
  // The pure part: which editor each L1 card opens, by the id the pack carries (a rename, a custom SLI).
  const actions = stackCardActions({ build: copiesDraft({ overrides: { ...COPIES.overrides, http_service_availability: { id: 'http_availability' } } }), library: LIBRARY });
  assert.deepEqual([actions.kafka_broker_availability, actions.http_availability, actions.http_service_availability, actions.checkout_success], [{ key: 'kafka_broker_availability', custom: false }, { key: 'http_service_availability', custom: false }, undefined, { key: 'checkout_success', custom: true }]);
  // COMPILE: the real cards carry the action — SLI-01 opens kafka_broker_availability, SLO-01 the same SLI on the objective; no other card does.
  const compile = buildCompileModel({ build: copiesDraft(), library: LIBRARY, clauses: T2 }).stack;
  const l1 = compile.slabs.find(s => s.id === 'L1');
  assert.deepEqual(l1.artefacts.find(a => a.id === 'SLI-01').edit, { key: 'kafka_broker_availability', custom: false, focus: null });
  assert.deepEqual(l1.artefacts.find(a => a.id === 'SLO-01').edit, { key: 'kafka_broker_availability', custom: false, focus: 'objective' });
  assert.deepEqual(l1.artefacts.find(a => a.title === 'checkout_success').edit, { key: 'checkout_success', custom: true, focus: null });
  assert.ok(compile.slabs.filter(s => s.id !== 'L1').every(s => s.artefacts.every(a => !a.edit)), 'only L1 cards open an editor');
  const html = buildStackHtml(compile);
  assert.ok(html.includes('<div class="card is-editable" data-artefact="SLI-01" data-symbol="slis.kafka_broker_availability" role="button" tabindex="0" aria-haspopup="dialog" data-edit-sli="kafka_broker_availability" data-focus-key="card:SLI-01" aria-label="Edit kafka_broker_availability — ratio SLI" title="open the editor — the objective, the window, the id, the PromQL as it runs">'));
  assert.ok(html.includes('data-artefact="SLO-01" data-symbol="slos.kafka_broker_availability_99_9" role="button" tabindex="0" aria-haspopup="dialog" data-edit-sli="kafka_broker_availability" data-edit-focus="objective" data-focus-key="card:SLO-01" aria-label="Edit the SLO kafka_broker_availability_99_9 — its SLI&#39;s objective"'));
  assert.ok(/data-edit-sli="checkout_success" data-edit-custom="1"/.test(html));
  assert.ok(!/data-artefact="PIP-[^"]*"[^>]*role="button"/.test(html), 'an L2 card is not a control');
  // VERIFY: the same cards open the editor (read-only there, the controller's mode); the accessible name and the title say View, as the rolodex's button does (it read "Edit …" beside a title saying "as compiled"; measured).
  const verifyHtml = buildStackHtml(buildVerifyModel({ build: copiesDraft(), library: LIBRARY, clauses: T2, targets: TARGETS }).stack);
  assert.ok(verifyHtml.includes('data-focus-key="card:SLI-01" aria-label="View kafka_broker_availability — ratio SLI (as compiled)" title="open the SLI as compiled"'));
  assert.ok(verifyHtml.includes('aria-label="View the SLO kafka_broker_availability_99_9 — its SLI&#39;s objective (as compiled)"') && !/aria-label="Edit /.test(verifyHtml), 'no card says Edit on Verify');
  // DEFINE: the candidate ghosts carry the action with the library key; a renamed one still opens by its key.
  const define = buildDefineModel({ build: draft({ result: null, overrides: { kafka_broker_availability: { id: 'brokers_up' } } }), library: LIBRARY, requirements: REQUIREMENTS }).stack;
  const ghosts = define.slabs.find(s => s.id === 'L1').ghosts;
  assert.deepEqual([ghosts.find(g => g.key === 'sli:kafka_broker_availability').edit, ghosts.find(g => g.key === 'slo:kafka_broker_availability').edit, ghosts.find(g => g.kind === 'clause').edit], [{ key: 'kafka_broker_availability', custom: false, focus: null }, { key: 'kafka_broker_availability', custom: false, focus: 'objective' }, undefined]);
  const dh = buildStackHtml(define);
  assert.ok(dh.includes('class="card card-ghost is-sli is-editable" data-ghost="sli:kafka_broker_availability" title="an SLI of the selection at this tier, with the SLO it gets — ticked on Compile — open the editor" role="button" tabindex="0" aria-haspopup="dialog" data-edit-sli="kafka_broker_availability" data-focus-key="ghost:sli:kafka_broker_availability" aria-label="Edit brokers_up — ratio SLI"'));
  assert.ok(dh.includes('data-ghost="slo:kafka_broker_availability"') && dh.includes('data-edit-focus="objective" data-focus-key="ghost:slo:kafka_broker_availability" aria-label="Edit the SLO on brokers_up — its SLI&#39;s objective"'));
  assert.ok(!/data-ghost="clause:[^"]*"[^>]*role="button"/.test(dh), 'a clause ghost is not a control');
  // The handlers: a click, Enter or Space on the card opens the editor with the key, the custom flag, the focus and the card's focus key; a key on a control inside the card is that control's.
  const calls = [];
  const sli = fakeEl({ editSli: 'kafka_broker_availability', focusKey: 'card:SLI-01' });
  const slo = fakeEl({ editSli: 'kafka_broker_availability', editFocus: 'objective', focusKey: 'card:SLO-01' });
  const custom = fakeEl({ editSli: 'checkout_success', editCustom: '1', focusKey: 'card:SLI-08' });
  wireBuildStack(fakeContainer({ '.build-stack [data-edit-sli]': [sli, slo, custom] }), compile, { build: { openEditor: (o) => calls.push(o), openSheet() {}, update() {}, setParam() {} } });
  sli.fire('click');
  slo.fire('keydown', { key: 'Enter', target: slo });
  custom.fire('keydown', { key: ' ', target: custom });
  sli.fire('keydown', { key: 'Enter', target: {} });
  sli.fire('keydown', { key: 'a', target: sli });
  assert.deepEqual(calls, [
    { key: 'kafka_broker_availability', custom: false, focus: null, opener: 'card:SLI-01' },
    { key: 'kafka_broker_availability', custom: false, focus: 'objective', opener: 'card:SLO-01' },
    { key: 'checkout_success', custom: true, focus: null, opener: 'card:SLI-08' },
  ]);
  // The header tabs: the step word and its tagline are the tab's name (measured: the title read "Library — …").
  assert.deepEqual(BUILD_TABS.map(t => [t.id, t.sub, t.techName, t.label, tabName(t)]), [
    ['define', 'Define', 'Define', 'What Are We Building For?', 'Define — Choose a service, tier, and starting point'],
    ['compile', 'Compile', 'Compile', 'What Did the Pack Produce?', 'Compile — Build SLIs, alerts, dashboards, and checks'],
    ['verify', 'Verify', 'Verify', 'What Is Ready, and What Remains?', 'Verify — Review coverage and resolve gaps'],
  ]);
  assert.ok(BUILD_TABS.every(t => !/Library|Instantiate|Conformance —/.test(tabName(t))));
  // Each step's heading is its question in sentence case (the tab label is the same question in title case).
  for (const [view, step, title] of [['build-define-view.mjs', 'define', 'What are we building for?'], ['build-compile-view.mjs', 'compile', 'What did the pack produce?'], ['build-verify-view.mjs', 'verify', 'What is ready, and what remains?']]) {
    assert.ok(readFileSync(join(ROOT, 'studio', view), 'utf8').includes(`stepHeadHtml('${step}', '${title}'`), `${view} heads its step "${title}"`);
  }
  // The stylesheet: the editable card has a hover and a focus ring.
  assert.match(cssRule('.build-slab .card.is-editable'), /cursor:\s*pointer/);
  assert.match(cssRule('.build-slab .card.is-editable:focus-visible'), /outline:\s*2px solid var\(--L1\)/);
  assert.match(cssRule('.build-seed-chip.is-entry'), /cursor:\s*pointer/);
  assert.equal(cssRule('.build-sheet-compose'), null, 'the compose block is gone');
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
  // The entrance animation lives on the opening render's class only, so a re-render while the sheet is open cannot replay it.
  assert.ok(!/animation:/.test(sheet) && !/animation:/.test(cssRule('.build-sheet-scrim')), 'no animation on the bare sheet or scrim');
  assert.match(cssRule('.build-sheet.is-entering'), /animation:\s*build-sheet-in 200ms ease-out/, 'the entrance is the is-entering render\'s');
  assert.match(cssRule('.build-sheet-scrim.is-entering'), /animation:\s*build-fade 200ms ease-out/);
  const reduced = CSS_TEXT.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g)?.find(b => b.includes('.build-sheet'));
  assert.ok(reduced, 'a reduced-motion block for the Build controls');
  for (const sel of ['.build-seg-thumb', '.build-switch-knob', '.build-rolo-card', '.build-sheet.is-entering', '.build-sheet-scrim.is-entering']) assert.ok(reduced.includes(sel), `${sel} respects reduced motion`);
  assert.ok(reduced.includes('scroll-behavior: auto'));
  // No colour literal beyond the theme tokens and the shadows' neutral rgba in the new block (both themes follow).
  const axis = CSS_TEXT.slice(CSS_TEXT.indexOf('==== The axis'));
  const literals = [...axis.matchAll(/#[0-9a-fA-F]{3,6}\b/g)].map(m => m[0]).filter(h => !['#fff', '#0891b2', '#db2777', '#0d9488'].includes(h));
  assert.deepEqual(literals, [], 'the axis styles use the tokens (white knobs and the step accents\' fallbacks aside)');
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

test('the sheet and the definition column read at WCAG AA in both themes: every text colour of the axis block against its surface, the accent mixed towards ink for text', () => {
  const tokensOf = (block) => { const m = CSS_TEXT.match(new RegExp(`(?:^|\\n)${block}\\s*\\{([\\s\\S]*?)\\n\\}`)); assert.ok(m, `${block} token block`); return Object.fromEntries([...m[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map(t => [t[1], t[2]])); };
  const themes = {
    light: { ...tokensOf(':root'), chrome: tokensOf('html\\[data-theme="light"\\] body\\.chrome-observa')['obs-bg'] },
    dark: { ...tokensOf('\\[data-theme="dark"\\]'), chrome: tokensOf('body\\.chrome-observa')['obs-bg'] },
  };
  const lum = (hex) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  // color-mix(in srgb, A p%, B): a per-channel blend of the gamma-encoded values.
  const mix = (a, b, p) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * p + parseInt(b.slice(i, i + 2), 16) * (1 - p)).toString(16).padStart(2, '0')).join('');
  const LAYERS = ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV'];
  const axis = CSS_TEXT.slice(CSS_TEXT.indexOf('==== The axis'));
  const rules = [...axis.matchAll(/(?:^|\n)([^@{}\n][^{}]*?)\s*\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }));
  assert.ok(rules.length > 100, `the axis block parsed (${rules.length} rules)`);
  const sizeOf = (body) => { const m = body.match(/font(?:-size)?:[^;]*?(\d+(?:\.\d+)?)px/); return m ? Number(m[1]) : null; };
  const weightOf = (body) => Number(body.match(/font:\s*(?:italic\s+)?(\d{3})\s/)?.[1] || 400);
  const large = (body) => { const s = sizeOf(body); return s != null && (s >= 18.66 || (s >= 14 && weightOf(body) >= 700)); };
  const offenders = [];
  for (const r of rules) {
    if (/\.build-evidence-dot/.test(r.sel)) continue;                 // a dot: its color feeds the currentColor halo, not text
    if (/\.build-slab-add|\.build-rolodex-nav/.test(r.sel)) continue; // glyph buttons (+ ‹ ›), not text
    const min = large(r.body) ? 3 : 4.5;
    const check = (label, colour, surface, name) => { const ratio = contrast(colour, surface); if (ratio < min) offenders.push(`${r.sel}: ${label} ${ratio.toFixed(2)}:1 (${name}, needs ${min})`); };
    const tok = r.body.match(/(?:^|[;{\s])color:\s*var\(--(ink-[1-5]|accent|accent-text|warn|fail-border|pass-border|crit-tier-[1-3]|BLD-text)\)/)?.[1];
    const mixed = r.body.match(/(?:^|[;{\s])color:\s*color-mix\(in srgb, var\(--([\w-]+)\) (\d+)%, var\(--ink\)\)/);
    if (!tok && !mixed) continue;
    for (const [name, t] of Object.entries(themes)) {
      if (mixed) { check(`mix(--${mixed[1]})`, mix(t[mixed[1]], t.ink, Number(mixed[2]) / 100), t.card, name); continue; }
      if (tok === 'accent' || tok === 'accent-text') { for (const L of LAYERS) check(`${tok} ${L}`, tok === 'accent' ? t[L] : mix(t[L], t.ink, 0.65), t.card, name); continue; }
      // The neutrals sit on the card (the sheet, the chips, the summary), the chrome (the column) and --line-2 (the segmented control).
      const surfaces = /^ink-/.test(tok) ? { card: t.card, chrome: t.chrome, 'line-2': t['line-2'] } : { card: t.card };
      for (const [s, hex] of Object.entries(surfaces)) check(`--${tok} on ${s}`, t[tok], hex, name);
    }
  }
  assert.deepEqual(offenders, [], 'every text colour the axis block names clears AA on its surface');
  const reduced = CSS_TEXT.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g)?.find(b => b.includes('.build-sheet')) || '';
  // The accent as text is the 65 % mix (the raw light L1 amber is 3.4:1 on the card); the eyebrow, the ids and a selected card's state use it.
  assert.ok(/\.build-slab, \.build-sheet \{ --accent-text: color-mix\(in srgb, var\(--accent\) 65%, var\(--ink\)\); \}/.test(axis));
  for (const sel of ['.build-sheet-eyebrow', '.build-sheet-item-id', '.build-rolo-type', '.build-rolo-card.is-selected .build-rolo-state']) assert.match(cssRule(sel), /color:\s*var\(--accent-text\)/, `${sel} is accent text`);
  assert.ok(contrast(themes.light.L1, themes.light.card) < 4.5 && contrast(themes.dark['ink-4'], themes.dark.card) < 4.5, 'the ratios the review measured, for the record');
  // The shared rows the sheet draws (the clause row, the param rows, the todos) hold the same bar.
  assert.match(cssRule('.build-rail-id'), /font:\s*13px[^;]*;\s*color:\s*var\(--ink-3\)/, 'the clause id is 13 px --ink-3 (the readable floor), not 9.5 px --ink-5');
  for (const sel of ['.build-param-key', '.build-param-desc', '.build-todo-manual', '.build-slab-todos-head', '.build-rail-clause.is-pending .build-rail-glyph', '.build-rail-clause.is-pending .build-rail-desc']) assert.match(cssRule(sel), /color:\s*var\(--ink-3\)/, `${sel} is --ink-3`);
  assert.match(cssRule('.build-todo-card'), /color:\s*var\(--accent-text, var\(--ink-3\)\)/);
  assert.ok(!/color:\s*var\(--ink-5\)/.test(axis.replace(/\.build-evidence-dot[^\n]*/g, '')), '--ink-5 is never a text colour on the axis (the dot aside)');
  // The seed, the copies and the editor live in the same block, so the scan above covered them: the seed card's muted text is --ink-3, the editor's fields and lines use the tokens.
  assert.ok(axis.includes('The seed and the copies') && axis.includes('The editor'), 'the new rules are inside the axis block the scan reads');
  for (const sel of ['.build-seed', '.build-seed-eyebrow', '.build-seed-dl dt', '.build-seed-from', '.build-def-seeded', '.build-rolo-chip', '.build-edit-hint', '.build-edit-default', '.build-rolo-evidence-note', '.build-editor-params', '.build-editor-provenance', '.build-editor-status', '.build-editor-switch-text', '.build-editor-close']) assert.match(cssRule(sel), /color:\s*var\(--ink-3\)/, `${sel} is --ink-3`);
  assert.match(cssRule('.build-seed'), /border:\s*1px solid var\(--line-2\)/, 'a thin border, recessed');
  assert.match(cssRule('.build-edit-input'), /font:\s*13\.5px\/1\.45 var\(--mono\)/, 'monospace PromQL');
  assert.ok(!cssRule('.build-rolo-card.is-open') && !cssRule('.build-rolo-customise') && !cssRule('.build-edit-face'), 'the in-card face and its rules are gone');
  assert.ok(reduced.includes('.build-seed-change') && reduced.includes('.build-rolo-edit') && reduced.includes('.build-edit-reset') && reduced.includes('.build-editor,'), 'the new transitions and the editor\'s entrance respect reduced motion');
  assert.match(cssRule('.build-evidence-custom'), /color:\s*var\(--ink-2\)/, 'the custom evidence badge is ink on a tint, not a colour literal');
});
