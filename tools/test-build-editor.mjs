#!/usr/bin/env node
/**
 * tools/test-build-editor.mjs — the pop-up SLI editor (docs/BUILD_JOURNEY.md "The editor"), headless under node:test:
 * the pure model (studio/build-copies-model.mjs sliEditorModel and its helpers) over the fixtures — a library ratio
 * SLI, a threshold SLI with a unit, an above-tier one, a customised one, a renamed one, a custom one, create mode —
 * the renders of studio/build-editor-view.mjs in edit / read-only / create modes (the dialog ARIA, the labels and
 * describedby ids, no input on Verify), its handlers through fake elements (input → setOverride live with the field's
 * key, three quick characters, the id pre-checked, ↺, Reset all, the switch, Esc committing then closing), the focus /
 * caret / text kept across a re-render, buildEditorModel / editorModeFor, the Tab trap with the non-modal sheet
 * underneath, and the stylesheet's modal rules. The fixtures are tools/fixtures/build/ (tools/test-build-model.mjs
 * keeps them stable); the drafts with copies are instantiated in process exactly as the route does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit as emitYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_VERSION } from './lib/validator.mjs';
import { evaluateConformance } from './lib/conformance.mjs';
import { adapt, applyEnvironmentOverlay } from './lib/adapter.mjs';
import { instantiatePack, validationSummary } from './lib/library.mjs';
import { loadLibrary, findEntry } from '../server/library.mjs';
import { parsePromqlDependencies as lezer } from './lib/promql-lezer.mjs';
import { rolodexItems, buildEditorModel, editorModeFor, editorDirtyAfterAnswer, EDITOR_MODES, splitBuildErrors } from '../studio/build-model.mjs';
import {
  sliEditorModel, checkEditorId, existingSliIds, resolveTemplate, templateParams, fieldsForType, effectiveId, percentText, ratioOf,
  fieldValueFor, numberOrText, customDefFromDraft, OVERRIDE_FIELDS,
  sliSummarySentence, sliRelationshipChecks, sliName, windowText, generatedOutputs, createFormStatus, customFormModel,
} from '../studio/build-copies-model.mjs';
import { buildEditorHtml, renderBuildEditor, wireBuildEditor, paintFieldMessage, paintIdState, paintDirection, growTextarea, PROMQL_MAX_HEIGHT, editorGroups, editorFieldOrder, liveCheck, jumpToField } from '../studio/build-editor-view.mjs';
import { fieldHelp } from '../studio/build-atoms.mjs';
import { defaultBuildState } from '../studio/state.mjs';
import { installDialogFocusTrap, TRAPPED_DIALOGS } from '../studio/util.mjs';
import { editFieldHtml } from '../studio/build-atoms.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = resolve(ROOT, 'tools/fixtures/build');
const SCHEMA = JSON.parse(readFileSync(resolve(ROOT, 'vendor/observability-pack-spec', `v${SPEC_VERSION}`, 'observability-pack.schema.json'), 'utf8'));
const read = (name) => JSON.parse(readFileSync(resolve(FIX, name), 'utf8'));
const INDEX = read('library.index.json');
const LIBRARY = { entries: INDEX.entries, scaffoldParams: INDEX.scaffoldParams, errors: INDEX.errors };
const CSS_TEXT = readFileSync(resolve(ROOT, 'studio/app.css'), 'utf8');
const cssRule = (selector) => { const m = CSS_TEXT.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)); return m ? m[1] : null; };

// The same computation POST /api/library/instantiate performs, in process (tools/test-build-model.mjs instantiateInProcess).
function instantiateInProcess(inputs) {
  const library = loadLibrary();
  const entries = inputs.entries.map(id => findEntry(library, id));
  const { canonical, todos, provenance, warnings } = instantiatePack(entries, { ...inputs, promql: lezer });
  const schemaErrors = validateCanonical(canonical, SCHEMA);
  const summary = validationSummary(canonical, todos);
  const { spec, effective } = applyEnvironmentOverlay(canonical.spec, provenance.environment);
  const overlaid = { ...canonical, spec, metadata: { ...canonical.metadata, bindings: { ...canonical.metadata.bindings, ...(effective.criticality ? { criticality: effective.criticality } : {}) } } };
  const conformance = evaluateConformance(overlaid);
  const adapted = JSON.parse(JSON.stringify(adapt(canonical, { environment: provenance.environment })));
  const canonicalYaml = `# ObservabilityPack ${canonical.metadata.name}\n` + emitYaml(canonical);
  return { canonical, canonicalYaml, todos, provenance, warnings, schemaErrors, summary, conformance, adapted };
}
// A draft plus the pack its inputs make: the drive's single-entry HTTP service (bare keys, `${job}` / `${duration_metric}` in the PromQL) and the two-entry orders-api.
const draftWith = (over = {}) => {
  const b = { ...defaultBuildState(), name: 'orders-api', owners: 'team-orders', environment: 'prod', tier: 'tier-2', entries: ['http-service'], seeded: true, ...over };
  b.result = instantiateInProcess({ entries: b.entries, name: b.name, tier: b.tier, environment: b.environment, owners: ['team-orders'], params: b.params || {}, toggles: Array.isArray(b.slis) ? { slis: b.slis } : {}, overrides: b.overrides || {}, custom: b.custom || [] });
  return b;
};
const itemOf = (b, key) => rolodexItems({ build: b, library: LIBRARY, all: true }).find(i => i.key === key);
const modelOf = (b, key, extra = {}) => sliEditorModel({ item: itemOf(b, key), result: b.result, library: LIBRARY, build: b, ...extra });
const field = (m, id) => m.fields.find(f => f.id === id);

// Fakes: a container answering from a map of selector → elements, an element recording its handlers (as tools/test-build-model.mjs).
function fakeContainer(map = {}) {
  return { innerHTML: '', querySelectorAll: (sel) => map[sel] || [], querySelector: (sel) => (map[sel] || [])[0] || null };
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
function stubContainer() {
  const el = { addEventListener() {}, disabled: false, querySelector: () => el, querySelectorAll: () => [] };
  return { innerHTML: '', querySelector: () => el, querySelectorAll: () => [] };
}
const renderHtml = (model) => { const c = stubContainer(); renderBuildEditor(c, model, { build: {} }); return c.innerHTML; };
const dialogOf = (b, mode = 'edit') => buildEditorModel({ build: b, library: LIBRARY, mode });

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

test('a library ratio SLI: the fields in reading order, the description prefilled, the objective as a percent, the PromQL resolved from the pack (no ${…}), the parameters line, the status applied · SLO …', () => {
  const b = draftWith();
  const m = modelOf(b, 'availability');
  assert.deepEqual([m.create, m.custom, m.readOnly, m.mode, m.key, m.id, m.type, m.renamed], [false, false, false, 'edit', 'availability', 'availability', 'ratio', false]);
  assert.deepEqual(m.fields.map(f => f.id), ['id', 'description', 'objective', 'window', 'semconv_metric', 'good', 'total']);
  assert.deepEqual(fieldsForType('threshold'), ['id', 'description', 'objective', 'window', 'threshold', 'good_when', 'unit', 'semconv_metric', 'query']);
  assert.deepEqual(m.title, { id: 'availability', product: 'HTTP service (OTel semconv)', evidence: 'semconv', sliEvidence: 'semconv', type: 'ratio', chips: [] });
  const id = field(m, 'id');
  assert.deepEqual([id.kind, id.value, id.default, id.overridden, id.resettable, id.focusKey, id.inputId, id.error], ['slug', 'availability', 'availability', false, false, 'ov:availability:id', 'build-editor-id', null]);
  const desc = field(m, 'description');
  assert.match(desc.value, /^Fraction of HTTP requests not answered with a 5xx status/, 'prefilled with the library default (it read empty under a "library default" label — measured)');
  assert.equal(desc.default, desc.value);
  assert.deepEqual([field(m, 'objective').value, field(m, 'objective').kind, field(m, 'window').value, field(m, 'window').options], ['99.5', 'percent', '30d', ['7d', '28d', '30d', '90d']]);
  assert.deepEqual([field(m, 'semconv_metric').value, field(m, 'semconv_metric').default, field(m, 'semconv_metric').placeholder], ['http.server.request.duration', 'http.server.request.duration', 'http.server.request.duration']);
  // The PromQL as it runs — the parameters in, read from the instantiated pack — never the template.
  const good = field(m, 'good'), total = field(m, 'total');
  assert.equal(good.kind, 'promql');
  assert.equal(good.value, 'sum(rate(http_server_request_duration_seconds_count{job="orders-api",http_response_status_code!~"5.."}[5m]))');
  assert.equal(total.value, 'sum(rate(http_server_request_duration_seconds_count{job="orders-api"}[5m]))');
  assert.ok(!m.fields.some(f => /\$\{/.test(String(f.value))), 'no ${…} anywhere in the editor');
  assert.deepEqual([good.default, good.defaultLabel, good.overridden, good.resettable], [good.value, 'the library’s expression, the parameters in', false, false]);
  assert.equal(good.value, b.result.canonical.spec.slis.find(s => s.id === 'availability').good, 'exactly what the pack carries');
  assert.deepEqual(m.parameters.names, ['duration_metric', 'job']);
  assert.equal(m.parameters.text, 'parameters: duration_metric=http_server_request_duration_seconds, job=orders-api — edit them in L2');
  assert.deepEqual(m.parameters.values, [{ name: 'duration_metric', key: 'duration_metric', value: 'http_server_request_duration_seconds' }, { name: 'job', key: 'job', value: 'orders-api' }]);
  assert.deepEqual(m.evidence, { status: 'semconv', note: 'the library’s evidence — its expression is what runs' });
  assert.equal(m.provenance, 'HTTP service (OTel semconv)’s defaults');
  assert.deepEqual(m.status, { kind: 'applied', text: 'applied · SLO availability_99_5 · 2 burn alerts · rule orders_api:availability:ratio_5m' });
  // The final action is Save SLI (it checks, then closes — the edits apply as typed); inclusion is its own named control.
  assert.deepEqual([m.resetAll, m.customised, m.doneLabel, m.typeHint], [false, [], 'Save SLI', 'fixed — a different shape is a new custom SLI (+ Custom SLI on the L1 sheet)']);
  assert.deepEqual(m.inclusion, { kind: 'include', label: 'Include in this pack', on: true, help: 'Untick to leave it out: your edits stay with the draft and return when you include it again.' });
  assert.equal(m.saveHelp, 'Changes apply as you type; Save SLI checks them and closes the editor.');
  // The opening sentence in real units; the generated names; nothing to fix.
  assert.equal(m.summary, 'Availability is the share of good events among all events; target 99.5% good over 30 days.');
  assert.deepEqual(m.outputs, { slo: 'availability_99_5', burns: 2, rule: 'orders_api:availability:ratio_5m', compiled: true });
  assert.deepEqual([m.checks, m.errorList], [{}, []]);
  assert.deepEqual(m.switch, { on: true, label: 'availability of HTTP service (OTel semconv) — remove from the pack', focusKey: 'sli:http-service:availability@editor', data: { sli: 'availability', entry: 'http-service', 'sli-id': 'availability', selected: '1', 'entry-selected': '1' } });
  assert.deepEqual(m.existingIds.sort(), ['error_rate', 'in_flight_saturation', 'latency_p99'], 'every other id of the selected entries, ticked or not; its own left out');
  // Before the engine has answered: the template resolved from the last provenance, else left as it is and said so.
  const noResult = sliEditorModel({ item: itemOf(b, 'availability'), result: null, library: LIBRARY, build: { ...b, result: null } });
  assert.match(field(noResult, 'good').value, /\$\{duration_metric\}_count\{job="\$\{job\}"/);
  assert.equal(noResult.parameters.text, 'parameters: duration_metric, job — resolved on the first compilation; edit them in L2');
  assert.deepEqual(noResult.status, { kind: 'pending', text: 'compiling…' });
  // The flags on the draft: applying while dirty or pending, stale when another field failed, not in the pack when switched off.
  assert.deepEqual(modelOf({ ...b, editorDirty: true }, 'availability').status, { kind: 'pending', text: 'applying…' });
  assert.deepEqual(modelOf({ ...b, pending: true }, 'availability').status, { kind: 'pending', text: 'applying…' });
  assert.deepEqual(modelOf({ ...b, error: ['param job: no'] }, 'availability').status, { kind: 'stale', text: 'the last compilation failed elsewhere — the pack shown is the previous one' });
  const off = modelOf({ ...b, slis: ['latency_p99'] }, 'availability');
  assert.deepEqual([off.status, off.switch.on, off.inclusion.on], [{ kind: 'off', text: 'not in the pack — tick Include in this pack below; your edits wait with it' }, false, false]);
  assert.equal(off.inclusion.help, 'Not in the pack. Save SLI keeps your edits with the draft; tick to include it.', 'saving an excluded SLI is supported — the help says so');
  // The two-entry pack: the composed key, the entry-namespaced parameter keys behind the bare names.
  const two = draftWith({ entries: ['kafka', 'http-service'] });
  const m2 = modelOf(two, 'http_service_availability');
  assert.deepEqual([m2.key, m2.id, field(m2, 'good').value.includes('job="orders-api"'), m2.parameters.values.map(v => v.key)], ['http_service_availability', 'http_service_availability', true, ['http-service.duration_metric', 'http-service.job']]);
  assert.equal(m2.status.text, 'applied · SLO http_service_availability_99_5 · 2 burn alerts · rule orders_api:http_service_availability:ratio_5m');
});

test('a threshold SLI with a unit: Bound and Unit fields with their defaults, the query resolved; an above-tier SLI: the chip and its own profile’s objective, addable from the editor', () => {
  const b = draftWith({ entries: ['kafka', 'http-service'] });
  const m = modelOf(b, 'kafka_produce_latency_p99');
  assert.deepEqual(m.fields.map(f => f.id), ['id', 'description', 'objective', 'window', 'threshold', 'good_when', 'unit', 'semconv_metric', 'query']);
  assert.deepEqual([field(m, 'threshold').value, field(m, 'threshold').kind, field(m, 'threshold').default, field(m, 'unit').value, field(m, 'unit').kind], ['0.1', 'number', '0.1', 'seconds', 'unit']);
  assert.equal(field(m, 'threshold').hint, 'the bound in the SLI’s unit; good when below (a ceiling: latency, lag) or above (a floor: replicas, consumers)');
  // spec 1.3: the direction of the bound as a field of its own — 'below' when the library says nothing (absent means below), the two sides as options, the library's side the default.
  const dir = field(m, 'good_when');
  assert.deepEqual([dir.value, dir.kind, dir.options, dir.default, dir.overridden, dir.resettable, dir.focusKey, dir.inputId], ['below', 'direction', ['below', 'above'], 'below', false, false, 'ov:kafka_produce_latency_p99:good_when', 'build-editor-good_when']);
  assert.match(dir.hint, /^below: a ceiling — samples above the bound are bad .* · above: a floor — samples under it are bad .*; the bound itself is good either way$/);
  const flipped = modelOf(draftWith({ entries: ['kafka', 'http-service'], overrides: { kafka_produce_latency_p99: { good_when: 'above' } } }), 'kafka_produce_latency_p99');
  assert.deepEqual([field(flipped, 'good_when').value, field(flipped, 'good_when').default, field(flipped, 'good_when').overridden, field(flipped, 'good_when').resettable, flipped.customised, flipped.title.chips.map(c => c.text)], ['above', 'below', true, true, ['good_when'], ['customised']]);
  assert.equal(flipped.status.text, 'applied · SLO kafka_produce_latency_p99_99 · 2 burn alerts · rule orders_api:kafka_produce_latency_p99:value_5m', 'the engine took the floor');
  assert.equal(field(flipped, 'query').value, field(m, 'query').value, 'the direction is not a PromQL edit: the library expression and its evidence stay');
  assert.equal(flipped.evidence.status, 'recorded-live');
  assert.equal(field(m, 'query').value, b.result.canonical.spec.slis.find(s => s.id === 'kafka_produce_latency_p99').query);
  assert.ok(!/\$\{/.test(field(m, 'query').value) && /kafka_network_requestmetrics_totaltimems|kafka/.test(field(m, 'query').value));
  assert.equal(m.title.type, 'threshold');
  // Above the tier: not in the pack, the chip says which profile it starts from, the switch adds it.
  const above = modelOf(b, 'kafka_controller_election_rate');
  assert.deepEqual(above.title.chips, [{ kind: 'above', text: 'from the tier-1 profile', title: "this SLI's own tier is tier-1: it starts from that profile's objective and window — the tier is a seed, not a gate" }]);
  assert.deepEqual([field(above, 'objective').value, field(above, 'window').value, above.switch.on, above.status.kind], ['99', '7d', false, 'off']);
  assert.match(field(above, 'query').value, /kafka/, 'resolved from the template and the provenance params even though the pack does not carry it yet');
  assert.ok(!/\$\{/.test(field(above, 'query').value));
});

test('a customised SLI: overridden fields resettable with the library default beside them, the chip and Reset all; an edited PromQL drops the evidence; a rename: the title is the new id, the "was <key>" chip, the id default is the key, the override stays keyed by the library; the engine’s error on its field and in the status', () => {
  const b = draftWith({ entries: ['kafka', 'http-service'], overrides: { kafka_produce_latency_p99: { objective: 0.995, window: '7d' }, http_service_latency_p99: { query: 'histogram_quantile(0.99, sum by (le)(rate(http_seconds_bucket[5m])))' }, http_service_availability: { id: 'http_availability', semconv_metric: 'http.server.request.duration' } } });
  const m = modelOf(b, 'kafka_produce_latency_p99');
  const obj = field(m, 'objective');
  assert.deepEqual([obj.value, obj.default, obj.overridden, obj.resettable], ['99.5', '99', true, true]);
  assert.deepEqual([field(m, 'window').value, field(m, 'window').default, field(m, 'window').overridden, field(m, 'threshold').overridden], ['7d', '30d', true, false]);
  assert.deepEqual([m.customised, m.resetAll, m.title.chips], [['objective', 'window'], true, [{ kind: 'customised', text: 'customised', title: 'customised: objective, window' }]]);
  assert.equal(m.provenance, 'customised: objective, window — the rest is Apache Kafka’s');
  assert.equal(m.status.text, 'applied · SLO kafka_produce_latency_p99_99_5 · 2 burn alerts · rule orders_api:kafka_produce_latency_p99:value_5m');
  // The edited query: the field is the override, the default the resolved library expression, the evidence custom.
  const q = modelOf(b, 'http_service_latency_p99');
  assert.deepEqual([field(q, 'query').value, field(q, 'query').overridden, field(q, 'query').resettable], ['histogram_quantile(0.99, sum by (le)(rate(http_seconds_bucket[5m])))', true, true]);
  assert.match(field(q, 'query').default, /^histogram_quantile\(0\.99,\s+sum by \(le\)\(rate\(http_server_request_duration_seconds_bucket\{job="orders-api"\}\[5m\]\)\)\)$/, 'the library expression with the parameters in, to go back to');
  assert.deepEqual(q.evidence, { status: 'custom', note: 'edited — the library’s evidence no longer applies' });
  assert.equal(q.title.sliEvidence, 'custom');
  // The rename: the pack carries http_availability, the override is keyed by the library's id, the SLO and the rule followed.
  const r = modelOf(b, 'http_service_availability');
  assert.deepEqual([r.key, r.id, r.renamed, r.title.id, field(r, 'id').value, field(r, 'id').default, field(r, 'id').overridden, field(r, 'id').focusKey], ['http_service_availability', 'http_availability', true, 'http_availability', 'http_availability', 'http_service_availability', true, 'ov:http_service_availability:id']);
  assert.deepEqual(r.title.chips, [{ kind: 'customised', text: 'customised', title: 'customised: id, semconv_metric' }, { kind: 'renamed', text: 'was http_service_availability', title: 'the library gives this SLI the id http_service_availability; the pack carries http_availability' }]);
  assert.equal(r.status.text, 'applied · SLO http_availability_99_5 · 2 burn alerts · rule orders_api:http_availability:ratio_5m');
  assert.equal(field(r, 'good').value, b.result.canonical.spec.slis.find(s => s.id === 'http_availability').good, 'the resolved PromQL is looked up by the id the pack carries');
  assert.equal(r.evidence.status, 'semconv', 'a rename keeps the library evidence');
  assert.ok(!r.existingIds.includes('http_service_availability') && !r.existingIds.includes('http_availability') && r.existingIds.includes('kafka_broker_availability'));
  assert.equal(r.switch.data.sli, 'http_service_availability', 'the switch addresses the library key');
  // A rename the engine has not answered yet reads applying…; the engine's error lands on its field and in the status.
  const pendingRename = modelOf({ ...b, overrides: { ...b.overrides, kafka_broker_availability: { id: 'brokers_up' } } }, 'kafka_broker_availability');
  assert.deepEqual([pendingRename.id, pendingRename.status], ['brokers_up', { kind: 'pending', text: 'applying…' }]);
  const errs = splitBuildErrors(['override kafka_produce_latency_p99.window: the window is one of 7d | 28d | 30d | 90d']).byOverride.kafka_produce_latency_p99;
  const withErr = modelOf(b, 'kafka_produce_latency_p99', { errors: errs });
  assert.deepEqual([field(withErr, 'window').error, withErr.status], ['the window is one of 7d | 28d | 30d | 90d', { kind: 'error', text: 'rejected — window: the window is one of 7d | 28d | 30d | 90d' }]);
  assert.equal(modelOf(b, 'kafka_produce_latency_p99', { errors: { '': 'nope' } }).generalError, 'nope');
  // A typed value that is not a number stays as typed beside the error — never blank, never NaN.
  const typedBad = modelOf({ ...b, overrides: { ...b.overrides, kafka_produce_latency_p99: { objective: 'abc' } } }, 'kafka_produce_latency_p99', { errors: { objective: 'the objective is a number in (0, 1), got "abc"' } });
  assert.deepEqual([field(typedBad, 'objective').value, field(typedBad, 'objective').error], ['abc', 'the objective is a number in (0, 1), got "abc"']);
});

test('a custom SLI: no defaults, cu: keys, the custom chip and evidence, its id field editable; read-only mode: no reset, no switch, the provenance, the status as compiled; buildEditorModel finds the SLI the draft names and returns null when it is gone; editorModeFor per step', () => {
  const custom = { id: 'checkout_success', type: 'ratio', good: 'sum(rate(checkout_ok_total[5m]))', total: 'sum(rate(checkout_total[5m]))', objective: 0.999, window: '30d', description: 'Checkouts that succeed' };
  const b = draftWith({ custom: [custom], editor: { key: 'checkout_success', custom: true } });
  const m = dialogOf(b);
  assert.deepEqual([m.custom, m.key, m.id, m.type, m.title.product, m.title.chips], [true, 'checkout_success', 'checkout_success', 'ratio', 'Custom SLI', [{ kind: 'custom', text: 'custom', title: 'written in the studio — not a library SLI' }]]);
  assert.ok(m.fields.every(f => f.default === null && !f.overridden && !f.resettable && f.focusKey.startsWith('cu:checkout_success:')));
  assert.deepEqual([field(m, 'id').value, field(m, 'description').value, field(m, 'objective').value, field(m, 'good').value, field(m, 'semconv_metric').value], ['checkout_success', 'Checkouts that succeed', '99.9', custom.good, '']);
  assert.match(field(m, 'id').hint, /your SLI’s id/);
  assert.deepEqual([m.evidence, m.provenance, m.resetAll, m.parameters], [{ status: 'custom', note: 'written in the studio — no library evidence' }, 'custom — written in the studio', false, null]);
  assert.equal(m.status.text, 'applied · SLO checkout_success_99_9 · 2 burn alerts · rule orders_api:checkout_success:ratio_5m');
  assert.deepEqual(m.switch.data, { sli: 'checkout_success', entry: '', 'sli-id': 'checkout_success', selected: '1', 'entry-selected': '1', custom: '1' });
  // Read-only (Verify): the same fields read-only, nothing to reset, no switch, the provenance line, the status as compiled.
  const ro = dialogOf({ ...b, overrides: { availability: { objective: 0.999 } }, editor: { key: 'availability', custom: false } }, 'readonly');
  assert.deepEqual([ro.readOnly, ro.mode, ro.switch, ro.resetAll, ro.doneLabel], [true, 'readonly', null, false, 'Close']);
  assert.ok(ro.fields.every(f => f.readOnly && !f.resettable) && field(ro, 'objective').overridden);
  assert.equal(ro.status.kind, 'readonly');
  assert.match(ro.status.text, /^as compiled · SLO availability_99_5 /);
  // buildEditorModel: the draft's editor names the SLI (key + custom); a closed editor or a gone SLI is null; the errors are split per SLI.
  assert.equal(buildEditorModel({ build: { ...b, editor: null }, library: LIBRARY }), null);
  assert.equal(buildEditorModel({ build: { ...b, editor: { key: 'nope', custom: false } }, library: LIBRARY }), null);
  assert.equal(buildEditorModel({ build: { ...b, custom: [], editor: { key: 'checkout_success', custom: true } }, library: LIBRARY }), null, 'a removed custom SLI: the controller closes the editor');
  const withErr = buildEditorModel({ build: { ...b, editor: { key: 'availability', custom: false }, error: ['override availability.objective: no', 'custom checkout_success.good: bad'] }, library: LIBRARY });
  assert.deepEqual([field(withErr, 'objective').error, withErr.status.kind, withErr.allKeys], ['no', 'error', ['availability', 'latency_p99']]);
  assert.equal(field(buildEditorModel({ build: { ...b, error: ['custom checkout_success.good: bad'] }, library: LIBRARY }), 'good').error, 'bad');
  assert.deepEqual([EDITOR_MODES, editorModeFor('define'), editorModeFor('compile'), editorModeFor('verify'), editorModeFor('nope')], [{ define: 'edit', compile: 'edit', verify: 'readonly' }, 'edit', 'edit', 'readonly', 'edit']);
  // An SLI of a product not yet selected opens too (from the rolodex behind the filter) — its status says adding selects the product.
  const foreign = buildEditorModel({ build: { ...b, editor: { key: 'alertmanager_availability', custom: false } }, library: LIBRARY });
  assert.deepEqual([foreign.key, foreign.status.kind, foreign.status.text], ['alertmanager_availability', 'off', 'not in the pack — adding it selects Alertmanager too']);
});

test('the status stays applying… while a newer edit waits on the debounce: an older request answering does not clear editorDirty (the controller applies editorDirtyAfterAnswer at the answer site)', () => {
  const b = draftWith();
  // Keystroke A → request A in flight → keystroke B (dirty, the timer restarted) → A answers: still dirty, still applying…
  assert.equal(editorDirtyAfterAnswer(true, true), true);
  assert.deepEqual(modelOf({ ...b, editorDirty: editorDirtyAfterAnswer(true, true) }, 'availability').status, { kind: 'pending', text: 'applying…' }, 'the stale result is not reported as applied');
  // No debounce pending: the answer is to the last edit — answered.
  assert.equal(editorDirtyAfterAnswer(true, false), false);
  assert.deepEqual(modelOf({ ...b, editorDirty: editorDirtyAfterAnswer(true, false) }, 'availability').status.kind, 'applied');
  assert.deepEqual([editorDirtyAfterAnswer(false, true), editorDirtyAfterAnswer(undefined, true), editorDirtyAfterAnswer(false, false)], [false, false, false]);
  // The controller reads the flag through it where the answer lands (an inlined `b.editorDirty = false` was the bug).
  const app = readFileSync(resolve(ROOT, 'studio/app.mjs'), 'utf8');
  assert.match(app, /b\.editorDirty = editorDirtyAfterAnswer\(b\.editorDirty, !!buildTimer\)/);
  assert.ok(!/b\.pending = false;\s*\n\s*b\.editorDirty = false/.test(app), 'the answer site never clears the flag outright');
});

test('create mode: the same dialog over the form — Name → id, Type, the fields per type, Add to the pack from canSubmit, the id clash said before the engine is asked; the engine’s 400 inline', () => {
  const b = draftWith({ editor: { create: true } });
  const empty = dialogOf(b);
  assert.deepEqual([empty.create, empty.mode, empty.key, empty.id, empty.type, empty.title.id, empty.title.product, empty.doneLabel, empty.switch], [true, 'create', null, null, 'ratio', 'new SLI', 'Custom SLI', 'Cancel', null]);
  assert.deepEqual(empty.fields.map(f => f.id), ['name', 'id', 'type', 'description', 'objective', 'window', 'semconv_metric', 'good', 'total']);
  assert.deepEqual(empty.submit, { label: 'Add to the pack', enabled: false, focusKey: 'cf:add' });
  assert.deepEqual(empty.status, { kind: 'idle', text: 'fill the required fields: objective, window, good, total — and a name' });
  assert.ok(empty.fields.every(f => f.default === null && !f.resettable && f.focusKey.startsWith('cf:')));
  const typed = dialogOf({ ...b, customDraft: { name: 'Checkout success', good: 'sum(rate(ok[5m]))', total: 'sum(rate(all[5m]))' } });
  assert.deepEqual([typed.id, typed.title.id, typed.submit.enabled, typed.status.kind, field(typed, 'name').hint], ['checkout_success', 'checkout_success', true, 'ready', 'id checkout_success']);
  const threshold = dialogOf({ ...b, customDraft: { name: 'Checkout p99', type: 'threshold', query: 'x', threshold: '0.3' } });
  assert.deepEqual(threshold.fields.map(f => f.id), ['name', 'id', 'type', 'description', 'objective', 'window', 'threshold', 'good_when', 'unit', 'semconv_metric', 'query']);
  assert.equal(threshold.submit.enabled, true);
  // The direction defaults to below and is written only as a floor; the type hint names both sides.
  assert.deepEqual([field(threshold, 'good_when').value, field(threshold, 'good_when').kind, field(threshold, 'good_when').options, field(threshold, 'type').hint, threshold.typeHint], ['below', 'direction', ['below', 'above'], 'ratio: good over total events · threshold: a value against a bound — good when below (a ceiling) or above (a floor)', 'ratio: good over total events · threshold: a value against a bound — good when below (a ceiling) or above (a floor)']);
  assert.ok(!('good_when' in customDefFromDraft(threshold.form.draft)), 'below is the default: nothing written');
  assert.equal(customDefFromDraft({ ...threshold.form.draft, good_when: 'above' }).good_when, 'above');
  assert.equal(customDefFromDraft({ ...threshold.form.draft, good_when: 'sideways' }).good_when, undefined, 'a value that is not a side reads as below');
  // A clash with a library SLI of the selected entry (ticked or not) or with a rename, said on the id field.
  const clash = dialogOf({ ...b, customDraft: { name: 'latency p99', good: 'a', total: 'b' } });
  assert.deepEqual([clash.submit.enabled, field(clash, 'id').error], [false, 'latency_p99 is already an SLI of the pack or of a selected product — pick another name']);
  const clashRename = dialogOf({ ...b, overrides: { availability: { id: 'http_availability' } }, customDraft: { name: 'http availability', good: 'a', total: 'b' } });
  assert.equal(clashRename.submit.enabled, false);
  // The engine's usage errors of the last attempt (customDraftErrors) land on their fields.
  const bad = dialogOf({ ...b, customDraft: { name: 'Checkout success', good: 'a', total: 'b', window: '30x' }, customDraftErrors: ['custom checkout_success.window: the window is one of 7d | 28d | 30d | 90d (the schema\'s SLO windows), got "30x"'] });
  assert.match(field(bad, 'window').error, /^the window is one of 7d/);
  assert.equal(dialogOf({ ...b, customDraft: { name: 'Checkout success', good: 'a', total: 'b' }, customDraftErrors: ['custom checkout_success: something'] }).generalError, 'something');
  // The form the model wraps is customFormModel's (its rule, once).
  assert.equal(typed.form.canSubmit, true);
  assert.deepEqual(customDefFromDraft(typed.form.draft), { id: 'checkout_success', type: 'ratio', objective: 0.999, window: '30d', good: 'sum(rate(ok[5m]))', total: 'sum(rate(all[5m]))' });
});

test('the helpers: checkEditorId, existingSliIds, resolveTemplate / templateParams, effectiveId, the conversions the editor and the controller share', () => {
  const ids = ['latency_p99', 'checkout_success'];
  assert.deepEqual(checkEditorId('', { key: 'availability', existingIds: ids }), { ok: true, id: null, message: null }, 'cleared: the key stands');
  assert.deepEqual(checkEditorId(' availability ', { key: 'availability', existingIds: ids }), { ok: true, id: null, message: null }, 'the key itself is no rename');
  assert.deepEqual(checkEditorId('http_availability', { key: 'availability', existingIds: ids }), { ok: true, id: 'http_availability', message: null });
  assert.deepEqual(checkEditorId('latency_p99', { key: 'availability', existingIds: ids }), { ok: false, id: 'latency_p99', message: 'latency_p99 is already an SLI of the pack or of a selected product — pick another id' });
  assert.deepEqual(checkEditorId('A', { key: 'availability', existingIds: ids }), { ok: false, id: 'A', message: 'an id is a slug of 2 to 63 characters: a letter, then letters, digits or _' });
  assert.equal(checkEditorId('h', {}).ok, false);
  assert.equal(checkEditorId('errorbudget', {}).message, 'errorbudget is the compiler’s reserved policy-record segment — pick another id');
  assert.equal(checkEditorId('http-availability', {}).ok, false, 'a dash is not in the slug');
  const b = { entries: ['kafka', 'http-service'], overrides: { http_service_availability: { id: 'http_availability' }, kafka_broker_availability: { objective: 0.5 } }, custom: [{ id: 'checkout_success' }] };
  const ex = existingSliIds({ build: b, library: LIBRARY });
  assert.ok(ex.includes('kafka_broker_availability') && ex.includes('kafka_controller_election_rate') && ex.includes('http_service_availability') && ex.includes('http_availability') && ex.includes('checkout_success'), 'every library key of the selected entries (ticked or not), the renames, the custom ids');
  assert.ok(!existingSliIds({ build: b, library: LIBRARY, except: ['http_service_availability', 'http_availability'] }).includes('http_availability'));
  assert.deepEqual(existingSliIds({ build: { entries: ['http-service'] }, library: LIBRARY }).sort(), ['availability', 'error_rate', 'in_flight_saturation', 'latency_p99'], 'bare keys for one entry');
  assert.deepEqual(existingSliIds({}), []);
  const params = { 'http-service.job': 'orders-api', 'http-service.duration_metric': 'http_server_request_duration_seconds', job: 'bare' };
  const res = resolveTemplate('sum(rate(${duration_metric}_count{job="${job}"}[5m])) / ${job}', params, 'http-service');
  assert.deepEqual(res, { text: 'sum(rate(http_server_request_duration_seconds_count{job="orders-api"}[5m])) / orders-api', used: [{ name: 'duration_metric', key: 'http-service.duration_metric', value: 'http_server_request_duration_seconds' }, { name: 'job', key: 'http-service.job', value: 'orders-api' }], unresolved: [], resolved: true }, 'the entry-namespaced key first, once per name');
  assert.deepEqual(resolveTemplate('up{job="${job}"}', params, null), { text: 'up{job="bare"}', used: [{ name: 'job', key: 'job', value: 'bare' }], unresolved: [], resolved: true });
  assert.deepEqual(resolveTemplate('up{job="${job}",x="${nope}"}', params, null), { text: 'up{job="bare",x="${nope}"}', used: [{ name: 'job', key: 'job', value: 'bare' }], unresolved: ['nope'], resolved: false });
  assert.deepEqual(resolveTemplate('${a}', null), { text: '${a}', used: [], unresolved: ['a'], resolved: false });
  assert.deepEqual(templateParams('${b} ${a} ${b}'), ['b', 'a']);
  assert.deepEqual([effectiveId('k', { id: 'x' }), effectiveId('k', {}), effectiveId('k', { id: '' }), effectiveId('k', { id: 3 })], ['x', 'k', 'k', 'k']);
  // The conversions.
  assert.deepEqual([percentText(0.995), percentText(0.9999), percentText(0.99), percentText(null)], ['99.5', '99.99', '99', '']);
  assert.deepEqual([ratioOf('99.5'), ratioOf('99.5 %'), ratioOf('abc')], [0.995, 0.995, NaN]);
  assert.deepEqual([fieldValueFor('objective', '99.5'), fieldValueFor('threshold', '0.25'), fieldValueFor('window', ' 7d '), fieldValueFor('query', 'up'), fieldValueFor('objective', ''), fieldValueFor('id', ' http_availability '), fieldValueFor('semconv_metric', ' a.b '), fieldValueFor('id', '')], [0.995, 0.25, '7d', 'up', null, 'http_availability', 'a.b', null]);
  assert.deepEqual([fieldValueFor('threshold', 'x'), fieldValueFor('objective', 'abc'), fieldValueFor('objective', ' 99,5 '), numberOrText('threshold', 'abc'), numberOrText('objective', '99.5')], ['x', 'abc', '99,5', 'abc', 0.995], 'text that is not a number stays text — the engine names it, never NaN → null');
  assert.deepEqual(customDefFromDraft({ name: 'X', good: 'a', total: 'b', objective: 'abc', window: '30d' }).objective, 'abc');
  assert.deepEqual(OVERRIDE_FIELDS, ['id', 'objective', 'window', 'threshold', 'good_when', 'query', 'good', 'total', 'description', 'unit', 'semconv_metric']);
  assert.deepEqual([fieldValueFor('good_when', ' above '), fieldValueFor('good_when', ''), fieldValueFor('good_when', 'below')], ['above', null, 'below']);
});

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

test('the dialog headless in edit mode: role=dialog aria-modal=true labelled by the id, the title row, a label per field with every describedby id resolving, the PromQL as two-row textareas showing the resolved expression, the fixed type, the parameters line, the status, the switch and Done; the create-mode datalist', () => {
  const b = draftWith({ overrides: { availability: { objective: 0.999 } }, editor: { key: 'availability', custom: false } });
  const html = renderHtml(dialogOf(b));
  assert.ok(html.startsWith('\n    <div class="build-editor-scrim" data-editor-close aria-hidden="true"></div>'));
  assert.ok(html.includes('<div class="build-editor is-edit" role="dialog" aria-modal="true" aria-labelledby="build-editor-title" aria-describedby="build-editor-status" data-editor-key="availability" data-editor-mode="edit" tabindex="-1">'));
  assert.ok(html.includes('<div class="build-editor-eyebrow">L1 · Contract · edit · ratio SLI</div>'));
  assert.ok(html.includes('<h2 class="build-editor-title" id="build-editor-title">availability</h2>'));
  assert.ok(html.includes('<span class="build-editor-product">HTTP service (OTel semconv) <span class="build-evidence build-evidence-semconv" title="semconv">semconv</span></span>') && html.includes('<span class="type-pill build-rolo-type">ratio</span>'));
  assert.ok(html.includes('<span class="build-rolo-chip is-customised" title="customised: objective">customised</span>'));
  assert.ok(html.includes('class="build-editor-close" data-editor-close aria-label="Close the editor (Esc)"'));
  // The grid: id · description, objective · window, metric · type, good | total; each input labelled, described by its default / hint / error, all ids resolving.
  // The four groups (Behavior · Objective · Data source · Generated outputs): the id is a generated output now, last.
  assert.deepEqual([...html.matchAll(/class="build-editor-cell is-([a-z_]+)/g)].map(m => m[1]), ['description', 'objective', 'window', 'semconv_metric', 'type', 'good', 'total', 'id']);
  assert.ok(html.includes('<label class="build-edit-label" for="build-editor-id"><span>Id</span></label>') && html.includes('data-focus-key="ov:availability:id" data-override-field="id" data-sli="availability" value="availability"'));
  assert.ok(html.includes('id="build-editor-description"') && html.includes('value="Fraction of HTTP requests not answered with a 5xx status'), 'the description is prefilled');
  assert.ok(html.includes('<div class="build-edit-field is-overridden" data-field="objective">') && html.includes('<span class="build-edit-default" id="build-editor-objective-default">library <code>99.5</code></span>'));
  assert.ok(html.includes('data-reset="objective" data-sli="availability" data-focus-key="ov:availability:objective:reset" title="back to the library default (99.5)" aria-label="Objective: back to the library default"'));
  assert.ok(html.includes('<textarea class="build-edit-input" id="build-editor-good" data-focus-key="ov:availability:good" data-override-field="good" data-sli="availability" rows="2" spellcheck="false" autocomplete="off" aria-describedby="build-editor-good-default build-editor-good-hint">sum(rate(http_server_request_duration_seconds_count{job=&quot;orders-api&quot;,http_response_status_code!~&quot;5..&quot;}[5m]))</textarea>'));
  assert.ok(!html.includes('${'), 'no unresolved parameter anywhere');
  const described = [...html.matchAll(/aria-describedby="([^"]+)"/g)].flatMap(m => m[1].split(' '));
  assert.ok(described.length >= 8 && described.every(id => html.includes(`id="${id}"`)), 'every aria-describedby id resolves');
  assert.ok(!/<label class="build-edit-label"[^>]*>(?:(?!<\/label>)[\s\S])*<button/.test(html), 'no button inside any label');
  // The fixed Type cell is the atom's read-only row with its hint shown (one shape for every field, nothing hand-written), nothing reads it back (no data attribute).
  const typeCell = editFieldHtml({ id: 'type', label: 'Type', kind: 'text', value: 'ratio', hint: 'fixed — a different shape is a new custom SLI (+ Custom SLI on the L1 sheet)', inputId: 'build-editor-type', focusKey: '' }, { readOnly: true, showHint: true, dataAttr: null });
  assert.ok(html.includes(`<div class="build-editor-cell is-type">${typeCell}</div>`), 'the type cell is rendered through editFieldHtml');
  assert.ok(typeCell.includes('<span class="build-edit-hint" id="build-editor-type-hint">fixed — ') && !/data-(override|custom)-/.test(typeCell) && !typeCell.includes('<label'), 'read-only with the hint, no field data attribute, no label for');
  assert.ok(!editFieldHtml({ id: 'type', label: 'Type', kind: 'text', value: 'ratio', hint: 'h', inputId: 'x', focusKey: '' }, { readOnly: true }).includes('build-edit-hint'), 'read-only hides the hint unless asked');
  assert.ok(html.includes('<div class="build-edit-field is-read" data-field="type">') && html.includes('<code class="build-edit-value">ratio</code>') && html.includes('fixed — a different shape is a new custom SLI (+ Custom SLI on the L1 sheet)'));
  assert.ok(html.includes('<p class="build-editor-params">parameters: duration_metric=http_server_request_duration_seconds, job=orders-api — edit them in L2</p>'));
  assert.ok(html.includes('<div class="build-editor-evidence"><span class="build-evidence build-evidence-semconv" title="semconv">semconv</span><span class="build-edit-evidence-note">the library’s evidence — its expression is what runs</span></div>'));
  assert.ok(html.includes('<div class="build-editor-status is-applied" id="build-editor-status" role="status" aria-live="polite">applied · SLO availability_99_9 · 2 burn alerts · rule orders_api:availability:ratio_5m</div>'));
  // Inclusion is a named checkbox, apart from saving; its help says what unticking keeps.
  assert.ok(html.includes('<label class="build-editor-switch"><input type="checkbox" class="build-editor-include-box" data-editor-include data-sli="availability" data-entry="http-service" data-sli-id="availability" data-selected="1" data-entry-selected="1" data-focus-key="sli:http-service:availability@editor" checked aria-describedby="build-editor-include-help"><span class="build-editor-switch-text">Include in this pack</span></label><span class="build-editor-include-help" id="build-editor-include-help">Untick to leave it out'));
  assert.ok(!html.includes('role="switch"'), 'no IN THE PACK switch');
  // The dialog's own controls carry focus keys, so the focus survives a re-render on them too (the pack answering while Done had it once dropped the focus to <body>; measured).
  assert.ok(html.includes('data-editor-reset-all data-focus-key="editor:reset-all"') && html.includes('<button type="button" class="mcp-refresh-btn build-editor-done" data-editor-done data-editor-save data-focus-key="editor:done" aria-describedby="build-editor-save-help">Save SLI</button>'), 'Save SLI checks before it closes: no data-editor-close on it');
  assert.ok(html.includes('<span class="build-editor-save-help" id="build-editor-save-help">Changes apply as you type; Save SLI checks them and closes the editor.</span>'));
  assert.ok(html.includes('title="Close (Esc)" data-focus-key="editor:close">'));
  assert.ok(html.includes('<datalist id="build-window-options">'), 'the window datalist lives here');
  // The threshold shape: Bound · Unit before the metric, one wide Query cell.
  const t = renderHtml(dialogOf(draftWith({ entries: ['kafka', 'http-service'], editor: { key: 'kafka_produce_latency_p99', custom: false } })));
  assert.deepEqual([...t.matchAll(/class="build-editor-cell is-([a-z_]+)( is-wide)?/g)].map(m => m[1] + (m[2] || '')), ['description is-wide', 'threshold', 'unit', 'objective', 'window', 'semconv_metric', 'type', 'query is-wide', 'id']);
  assert.ok(t.includes('data-override-field="threshold" data-sli="kafka_produce_latency_p99" value="0.1"') && t.includes('<span>Bound</span>') && t.includes('<span>Unit</span>'));
  // The Bound cell carries the direction control (spec 1.3 good_when): a radiogroup labelled 'Good when' and described by its
  // default and hint, one radio per side with the chosen one checked and in the tab order, each with a focus key of its own,
  // the group with the data attribute the wiring reads back; no cell of its own.
  assert.ok(t.includes('<div class="build-editor-cell is-threshold has-direction">'));
  assert.ok(t.includes('<div class="build-edit-field build-edit-direction" data-field="good_when">'));
  assert.ok(t.includes('<span class="build-edit-label" id="build-editor-good_when-label"><span>Good when</span></span><span class="build-edit-default" id="build-editor-good_when-default">library default</span>'));
  assert.ok(t.includes('<div class="build-edit-dir" role="radiogroup" aria-labelledby="build-editor-good_when-label" aria-describedby="build-editor-good_when-default build-editor-good_when-hint" data-dir-group="good_when" data-override-field="good_when" data-sli="kafka_produce_latency_p99" style="--dir-index:0"><span class="build-edit-dir-thumb" aria-hidden="true"></span>'));
  assert.ok(t.includes('<button type="button" role="radio" class="build-edit-dir-btn" data-dir="below" aria-checked="true" tabindex="0" data-focus-key="ov:kafka_produce_latency_p99:good_when:below">below</button>'));
  assert.ok(t.includes('<button type="button" role="radio" class="build-edit-dir-btn" data-dir="above" aria-checked="false" tabindex="-1" data-focus-key="ov:kafka_produce_latency_p99:good_when:above">above</button>'));
  assert.ok(t.includes('<span class="build-edit-hint" id="build-editor-good_when-hint">below: a ceiling'));
  assert.ok(!/<label[^>]*for="build-editor-good_when"/.test(t) && !t.includes('is-good_when'), 'no input and no cell of its own');
  const tDescribed = [...t.matchAll(/aria-describedby="([^"]+)"/g)].flatMap(m => m[1].split(' '));
  assert.ok(tDescribed.every(id => t.includes(`id="${id}"`)), 'every aria-describedby id of the threshold dialog resolves');
  // A floor: the other segment checked, the thumb on it, the override ring and ↺ beside the label with the library's side.
  const floor = renderHtml(dialogOf(draftWith({ entries: ['kafka', 'http-service'], overrides: { kafka_produce_latency_p99: { good_when: 'above' } }, editor: { key: 'kafka_produce_latency_p99', custom: false } })));
  assert.ok(floor.includes('<div class="build-edit-field build-edit-direction is-overridden" data-field="good_when">') && floor.includes('style="--dir-index:1"'));
  assert.ok(floor.includes('data-dir="above" aria-checked="true" tabindex="0"') && floor.includes('data-dir="below" aria-checked="false" tabindex="-1"'));
  assert.ok(floor.includes('<span class="build-edit-default" id="build-editor-good_when-default">library <code>below</code></span><button type="button" class="build-edit-reset" data-reset="good_when" data-sli="kafka_produce_latency_p99" data-focus-key="ov:kafka_produce_latency_p99:good_when:reset" title="back to the library default (below)" aria-label="Good when: back to the library default">'));
  // Read-only (Verify): the side as a code span, no radiogroup.
  const ro = renderHtml(sliEditorModel({ item: itemOf(draftWith({ entries: ['kafka', 'http-service'], overrides: { kafka_produce_latency_p99: { good_when: 'above' } } }), 'kafka_produce_latency_p99'), result: draftWith({ entries: ['kafka', 'http-service'] }).result, library: LIBRARY, build: draftWith({ entries: ['kafka', 'http-service'] }), mode: 'readonly' }));
  assert.ok(ro.includes('<div class="build-edit-field build-edit-direction is-overridden is-read" data-field="good_when">') && ro.includes('<code class="build-edit-value">above</code>') && !ro.includes('role="radiogroup"'));
  // The create dialog's threshold form carries the same control on the draft.
  const cr = renderHtml(dialogOf(draftWith({ editor: { create: true }, customDraft: { name: 'Settlement consumers', type: 'threshold', query: 'min(members)', threshold: '2', good_when: 'above', unit: 'consumers' } })));
  assert.ok(cr.includes('data-dir-group="good_when" data-custom-draft="good_when" style="--dir-index:1"') && cr.includes('data-dir="above" aria-checked="true" tabindex="0" data-focus-key="cf:good_when:above"') && !cr.includes('data-sli="'));
  // The engine's error under its field, aria-invalid, and in the status.
  const e = renderHtml(buildEditorModel({ build: { ...b, error: ['override availability.objective: the objective is a number in (0, 1), got "abc"'] }, library: LIBRARY }));
  assert.ok(e.includes('<span class="build-edit-error" id="build-editor-objective-error" role="alert">the objective is a number in (0, 1), got &quot;abc&quot;</span>') && e.includes('aria-invalid="true"') && e.includes('class="build-editor-status is-error"'));
  // Escaping at the seam: a hostile override never becomes markup.
  assert.ok(!renderHtml(dialogOf({ ...b, overrides: { availability: { description: '<img src=x onerror="1">' } } })).includes('<img'));
});

test('the dialog headless in read-only mode (Verify): no input, the values as spans, the provenance, no reset, no switch, Close; and in create mode: the type select, Name → id, the submit disabled until the model allows, Cancel', () => {
  const b = draftWith({ overrides: { availability: { objective: 0.999 } }, editor: { key: 'availability', custom: false } });
  const ro = renderHtml(dialogOf(b, 'readonly'));
  assert.ok(ro.includes('class="build-editor is-readonly" role="dialog" aria-modal="true"') && ro.includes('L1 · Contract · as compiled · ratio SLI'));
  assert.ok(!ro.includes('<input') && !ro.includes('<textarea') && !ro.includes('<select') && !ro.includes('role="switch"') && !ro.includes('data-reset') && !ro.includes('data-editor-reset-all'), 'no input on Verify — a value is a value, not a disabled field');
  assert.ok(ro.includes('<code class="build-edit-value" data-override-field="objective" data-sli="availability">99.9</code>') && ro.includes('<div class="build-edit-field is-overridden is-read" data-field="objective">'));
  assert.ok(ro.includes('<span class="build-editor-provenance">customised: objective — the rest is HTTP service (OTel semconv)’s</span>'));
  assert.ok(ro.includes('class="build-editor-status is-readonly"') && ro.includes('>as compiled · SLO availability_99_9 ') && ro.includes('data-editor-done data-editor-close data-focus-key="editor:done">Close</button>'));
  const cr = renderHtml(dialogOf({ ...b, editor: { create: true }, customDraft: { name: 'Checkout success' } }));
  assert.ok(cr.includes('class="build-editor is-create is-custom" role="dialog" aria-modal="true"') && cr.includes('L1 · Contract · a new SLI') && cr.includes('<h2 class="build-editor-title" id="build-editor-title">checkout_success</h2>'));
  assert.ok(cr.includes('<label class="build-edit-label" for="build-custom-name"><span>Name</span></label>') && cr.includes('data-focus-key="cf:name" data-custom-draft="name" value="Checkout success"'));
  assert.ok(cr.includes('<select class="build-edit-input" id="build-custom-type" data-focus-key="cf:type" data-custom-draft="type"') && !cr.includes('data-field="type">\n        <div class="build-edit-label-row"><span class="build-edit-label">'), 'the real select, not the fixed cell');
  assert.ok(cr.includes('data-custom-draft="good" required rows="2"') && cr.includes('data-custom-draft="semconv_metric"') && !cr.includes('data-custom-draft="query"'));
  assert.ok(cr.includes('<button type="button" class="ctrl-btn build-editor-cancel" data-editor-close data-focus-key="editor:cancel">Cancel</button><button type="button" class="mcp-refresh-btn build-editor-submit" data-editor-submit data-focus-key="cf:add" disabled>Add to the pack'));
  assert.ok(cr.includes('class="build-editor-status is-idle"') && !cr.includes('role="switch"') && !cr.includes('build-editor-params'));
  const ready = renderHtml(dialogOf({ ...b, editor: { create: true }, customDraft: { name: 'Checkout success', good: 'a', total: 'b' } }));
  assert.ok(ready.includes('data-editor-submit data-focus-key="cf:add">Add to the pack') && ready.includes('class="build-editor-status is-ready"'));
});

test('the handlers: every field but the id commits on input through setOverride with the field’s key and live (three quick characters, none lost, the status says applying… only when something changed); a change after the input is not a second commit; the id is pre-checked on every keystroke and committed on change, after the browser’s focus move — ten keystrokes send nothing, a clash stays in the field with its message, a valid one goes once, the key itself clears, a field left by Enter gets the focus back; ↺ and Reset all → clearOverride; the switch; Esc leaves the field then closes; the scrim and Done close', async () => {
  const tick = () => new Promise(r => setTimeout(r, 0));
  const b = draftWith({ overrides: { availability: { objective: 0.999 } }, editor: { key: 'availability', custom: false } });
  const model = dialogOf(b);
  const calls = [];
  const act = { setOverride: (k, f, v, o) => calls.push(['override', k, f, v, o]), clearOverride: (k, f) => calls.push(['clear', k, f]), closeEditor: () => calls.push(['close']), setSli: (k, on, all) => calls.push(['sli', k, on, all]), addSli: (e, s) => calls.push(['addSli', e, s]), removeCustom: (id) => calls.push(['remove', id]), updateCustom: (id, f, v, o) => calls.push(['custom', id, f, v, o]) };
  const dialog = fakeEl({});
  const closeBtn = fakeEl({}), scrim = fakeEl({}), done = fakeEl({});
  const status = { textContent: '', className: '' };
  const objective = { ...fakeEl({ overrideField: 'objective', sli: 'availability' }), value: '99.9', tagName: 'INPUT', blurred: 0, blur() { this.blurred++; } };
  const idInput = { ...fakeEl({ overrideField: 'id', sli: 'availability', focusKey: 'ov:availability:id' }), value: 'availability', tagName: 'INPUT', blur() {} };
  const good = { ...fakeEl({ overrideField: 'good', sli: 'availability' }), value: 'x', tagName: 'TEXTAREA', style: {}, scrollHeight: 40 };
  const reset = fakeEl({ reset: 'objective', sli: 'availability' });
  const resetAll = fakeEl({});
  const sw = fakeEl({ sli: 'availability', entry: 'http-service', sliId: 'availability', selected: '1', entrySelected: '1' });
  const msgAttrs = {}, inpAttrs = {};
  const msg = { className: 'build-edit-hint', id: 'build-editor-id-hint', textContent: '', setAttribute: (k, v) => { msgAttrs[k] = v; }, removeAttribute: (k) => { delete msgAttrs[k]; } };
  const idBoxInput = { id: 'build-editor-id', setAttribute: (k, v) => { inpAttrs[k] = v; }, removeAttribute: (k) => { delete inpAttrs[k]; } };
  const cls = new Set();
  const idBox = { classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); } }, querySelector: (sel) => (sel === '.build-edit-input' ? idBoxInput : sel === '.build-edit-default' ? { id: 'build-editor-id-default' } : msg) };
  const container = fakeContainer({
    '.build-editor': [dialog], '.build-editor [data-editor-close]': [closeBtn, done], '.build-editor-scrim': [scrim], '#build-editor-status': [status],
    '.build-editor .build-edit-input': [objective, idInput, good], '[data-reset]': [reset], '[data-editor-reset-all]': [resetAll], '.build-editor [data-editor-include]': [sw],
    '.build-editor [data-field="id"]': [idBox],
  });
  wireBuildEditor(container, model, { build: act });
  // Three characters quickly: three live commits with the text as typed, the status applying.
  for (const v of ['9', '99', '99.']) { objective.value = v; objective.fire('input'); }
  assert.deepEqual(calls, [['override', 'availability', 'objective', '9', { live: true }], ['override', 'availability', 'objective', '99', { live: true }], ['override', 'availability', 'objective', '99.', { live: true }]]);
  assert.deepEqual([status.textContent, status.className], ['applying…', 'build-editor-status is-pending']);
  objective.fire('change');
  assert.equal(calls.length, 3, 'the change that follows the input (Enter, blur, a datalist pick of the same text) is not a second commit');
  objective.fire('keydown', { key: 'Enter' });
  assert.equal(objective.blurred, 1, 'Enter leaves a one-line input');
  // A textarea grows on input and commits like any field.
  good.value = 'sum(rate(ok[5m]))'; good.fire('input');
  assert.deepEqual(calls.at(-1), ['override', 'availability', 'good', 'sum(rate(ok[5m]))', { live: true }]);
  assert.equal(good.style.height, '40px');
  // The id is a rename: pre-checked on every input (the message under the field, the status), committed on CHANGE
  // (Enter, Tab, Esc, a click away) — never per keystroke. Typing error_rate key by key once renamed the SLI to every
  // valid prefix and left it 'error_rat' when the final 'error_rate' clashed (measured).
  calls.length = 0;
  const idHint = model.fields.find(f => f.id === 'id').help;   // the short help line under the field (the long hint is behind its '?')
  let typed = '';
  for (const ch of 'error_rate') { typed += ch; idInput.value = typed; idInput.fire('input'); }
  assert.deepEqual(calls, [], 'ten keystrokes: nothing sent — no prefix becomes a rename');
  assert.deepEqual([msg.className, msg.id, msg.textContent, msgAttrs.role, cls.has('is-error'), inpAttrs['aria-invalid'], inpAttrs['aria-errormessage'], inpAttrs['aria-describedby'], status.textContent, status.className],
    ['build-edit-error', 'build-editor-id-error', 'error_rate is already an SLI of the pack or of a selected product — pick another id', 'alert', true, 'true', 'build-editor-id-error', 'build-editor-id-default build-editor-id-error', 'not applied — error_rate is already an SLI of the pack or of a selected product — pick another id', 'build-editor-status is-error']);
  idInput.fire('change'); await tick();
  assert.deepEqual(calls, [], 'leaving the field with a clashing id sends nothing; the message stays');
  assert.equal(msg.className, 'build-edit-error');
  // A valid id while typing: the message clears, the status says how to apply it; the change commits it once — after
  // the browser's own focus move (a Tab computed from a field the synchronous render had replaced landed nowhere; measured).
  idInput.value = 'http_availability'; idInput.fire('input');
  assert.deepEqual([calls, msg.className, msg.textContent, cls.has('is-error'), 'aria-invalid' in inpAttrs, inpAttrs['aria-describedby'], status.textContent, status.className],
    [[], 'build-edit-hint', idHint, false, false, 'build-editor-id-default build-editor-id-hint', 'rename to http_availability — Enter, Tab or Esc applies it', 'build-editor-status is-pending']);
  idInput.fire('change');
  assert.deepEqual(calls, [], 'the commit waits for the focus move (a task)');
  await tick();
  assert.deepEqual(calls, [['override', 'availability', 'id', 'http_availability', { live: true }]]);
  assert.deepEqual([status.textContent, status.className], ['applying…', 'build-editor-status is-pending']);
  idInput.fire('change'); await tick();
  assert.equal(calls.length, 1, 'a second change with the same text is not a second rename');
  // Cleared: the text means the key, which this (un-renamed) model already carries — the status is the model's again;
  // the change still clears the rename typed before it (the controller removes the override).
  idInput.value = ''; idInput.fire('input');
  assert.equal(status.textContent, model.status.text);
  idInput.fire('change'); await tick();
  assert.deepEqual(calls.at(-1), ['override', 'availability', 'id', '', { live: true }], 'an empty id clears the rename (the controller removes the override)');
  // The key itself typed back (' availability ', 'availability') is no rename: what goes out clears the override — never
  // `{ id: 'availability' }`, which the studio then showed as "customised: id" while the engine treated it as no rename (measured).
  calls.length = 0;
  idInput.value = ' availability '; idInput.fire('input'); idInput.fire('change'); await tick();
  idInput.value = 'availability'; idInput.fire('input');
  assert.deepEqual([status.textContent, status.className], [model.status.text, `build-editor-status is-${model.status.kind}`], 'the id the pack carries: the status is the model\'s again');
  idInput.fire('change'); await tick();
  assert.ok(calls.length >= 1 && calls.every(c => c[3] === ''), `typing the key back sends a clear, not the key: ${JSON.stringify(calls)}`);
  // Enter left the field (blur → change) with <body> active: after the commit the fresh id field gets the focus back.
  const body = {};
  let refocused = 0;
  const freshId = { focus: () => { refocused++; } };
  const containerWithFresh = fakeContainer({ '.build-editor': [dialog], '.build-editor .build-edit-input': [idInput], '#build-editor-status': [status], '.build-editor [data-field="id"]': [idBox], '[data-focus-key="ov:availability:id"]': [freshId] });
  wireBuildEditor(containerWithFresh, model, { build: act });
  globalThis.document = { body, activeElement: body };
  try {
    idInput.value = 'http_avail'; idInput.fire('input'); idInput.fire('change'); await tick();
    assert.deepEqual([calls.at(-1)[3], refocused], ['http_avail', 1], 'the field left by Enter is focused again');
    globalThis.document.activeElement = { tagName: 'INPUT' };
    idInput.value = 'http_avail2'; idInput.fire('input'); idInput.fire('change'); await tick();
    assert.equal(refocused, 1, 'something else has the focus (Tab): left alone');
  } finally { delete globalThis.document; }
  // paintIdState on its own, for the render that restores a typed id: the check comes back with the message painted.
  assert.equal(paintIdState(container, model, 'latency_p99').ok, false);
  assert.equal(msg.textContent, 'latency_p99 is already an SLI of the pack or of a selected product — pick another id');
  assert.deepEqual(paintIdState(container, model, 'availability'), { ok: true, id: null, message: null });
  assert.equal(msg.className, 'build-edit-hint');
  // The action says whether anything changed: a text that means the committed value (99.90 for 0.999, a detour and back)
  // sends nothing, and the status stays what the model says — never 'applying…' with no request behind it (measured: 4 s later, still applying).
  const unchanged = { ...act, setOverride: (...a) => { calls.push(['override', ...a]); return false; } };
  const status2 = { textContent: '', className: '' };
  const obj2 = { ...fakeEl({ overrideField: 'objective', sli: 'availability' }), value: '99.9', tagName: 'INPUT' };
  wireBuildEditor(fakeContainer({ '.build-editor': [fakeEl({})], '.build-editor .build-edit-input': [obj2], '#build-editor-status': [status2] }), model, { build: unchanged });
  obj2.value = '99.90'; obj2.fire('input');
  assert.deepEqual([status2.textContent, status2.className], [model.status.text, `build-editor-status is-${model.status.kind}`], 'no change: the status is the model\'s, not applying…');
  const changed = { ...act, setOverride: (...a) => { calls.push(['override', ...a]); return true; } };
  wireBuildEditor(fakeContainer({ '.build-editor': [fakeEl({})], '.build-editor .build-edit-input': [obj2], '#build-editor-status': [status2] }), model, { build: changed });
  obj2.value = '99.95'; obj2.fire('input');
  assert.deepEqual([status2.textContent, status2.className], ['applying…', 'build-editor-status is-pending']);
  // ↺ on a field, Reset all, the inclusion checkbox (a change, as a checkbox fires).
  calls.length = 0;
  reset.fire('click'); resetAll.fire('click'); sw.fire('change');
  assert.deepEqual(calls, [['clear', 'availability', 'objective'], ['clear', 'availability', null], ['sli', 'availability', false, ['availability', 'latency_p99']]]);
  // Esc on a field leaves it (its change commits) and closes; Esc elsewhere closes; the scrim, the esc button and Done close.
  calls.length = 0;
  let stopped = 0;
  dialog.fire('keydown', { key: 'Escape', target: objective, stopPropagation() { stopped++; } });
  assert.deepEqual([objective.blurred, calls, stopped], [2, [['close']], 1]);
  dialog.fire('keydown', { key: 'Enter', target: objective });
  dialog.fire('keydown', { key: 'Escape', target: { tagName: 'BUTTON' } });
  closeBtn.fire('click'); scrim.fire('click'); done.fire('click');
  assert.deepEqual(calls, [['close'], ['close'], ['close'], ['close'], ['close']]);
  // A custom SLI's fields go through updateCustom; the custom switch through removeCustom; an above-tier switch adds.
  const cb = draftWith({ custom: [{ id: 'checkout_success', type: 'ratio', good: 'a', total: 'b', objective: 0.999, window: '30d' }], editor: { key: 'checkout_success', custom: true } });
  const cGood = { ...fakeEl({ customField: 'good', sli: 'checkout_success' }), value: 'a', tagName: 'TEXTAREA', style: {}, scrollHeight: 30 };
  const cSw = fakeEl({ sli: 'checkout_success' });   // a custom SLI's Remove SLI
  calls.length = 0;
  wireBuildEditor(fakeContainer({ '.build-editor': [fakeEl({})], '.build-editor .build-edit-input': [cGood], '.build-editor [data-editor-remove]': [cSw], '#build-editor-status': [status] }), dialogOf(cb), { build: act });
  cGood.value = 'sum(rate(ok[5m]))'; cGood.fire('input'); cSw.fire('click');
  assert.deepEqual(calls, [['custom', 'checkout_success', 'good', 'sum(rate(ok[5m]))', { live: true }], ['remove', 'checkout_success']]);
  const ab = draftWith({ entries: ['kafka', 'http-service'], editor: { key: 'kafka_controller_election_rate', custom: false } });
  const aSw = fakeEl({ sli: 'kafka_controller_election_rate', entry: 'kafka', sliId: 'controller_election_rate', selected: '0', entrySelected: '1' });
  calls.length = 0;
  wireBuildEditor(fakeContainer({ '.build-editor': [fakeEl({})], '.build-editor [data-editor-include]': [aSw] }), dialogOf(ab), { build: act });
  aSw.fire('change');
  assert.deepEqual(calls[0].slice(0, 3), ['sli', 'kafka_controller_election_rate', true]);
  // Read-only: only close is wired.
  calls.length = 0;
  const roInput = { ...fakeEl({ overrideField: 'objective', sli: 'availability' }), value: '1', tagName: 'INPUT' };
  wireBuildEditor(fakeContainer({ '.build-editor': [fakeEl({})], '.build-editor .build-edit-input': [roInput] }), dialogOf(b, 'readonly'), { build: act });
  roInput.fire('input');
  assert.deepEqual(calls, []);
  // Esc with the focus on <body> (a re-render once dropped it there) closes the editor through a document listener —
  // bound once per host, inert while no dialog is mounted, deferring to the dialog's own handler and to a modal on top.
  const docHandlers = {};
  const escDialog = { ...fakeEl({}), contains: (el) => el === roInput };
  let dialogs = [escDialog];
  globalThis.document = { body: {}, addEventListener: (t, fn) => { docHandlers[t] = fn; }, querySelectorAll: () => dialogs };
  try {
    const escHost = fakeContainer({ '.build-editor': [escDialog], '.build-editor .build-edit-input': [] });
    calls.length = 0;
    wireBuildEditor(escHost, model, { build: act });
    let prevented = 0;
    const esc = (target) => docHandlers.keydown({ key: 'Escape', target, preventDefault() { prevented++; } });
    esc(globalThis.document.body);
    assert.deepEqual([calls, prevented], [[['close']], 1], 'Esc from <body> closes');
    esc(roInput);
    assert.equal(calls.length, 1, 'Esc from inside the dialog is the dialog\'s own');
    dialogs = [escDialog, { other: true }];
    esc(globalThis.document.body);
    assert.equal(calls.length, 1, 'another modal on top: its Esc');
    dialogs = [escDialog];
    docHandlers.keydown({ key: 'Enter', target: globalThis.document.body, preventDefault() {} });
    assert.equal(calls.length, 1);
    // Wired again (a re-render) with another host: one listener, the latest host.
    const late = [];
    wireBuildEditor(escHost, model, { build: { ...act, closeEditor: () => late.push('close') } });
    esc(globalThis.document.body);
    assert.deepEqual([calls.length, late], [1, ['close']]);
    // Closed (no dialog mounted): inert.
    escHost.querySelector = () => null;
    esc(globalThis.document.body);
    assert.deepEqual(late, ['close']);
  } finally {
    delete globalThis.document;
  }
});

test('the render keeps the focused field’s text, focus and caret across a re-render (typing "99." is not rewritten to the stored "99"), lands on the requested field when opening with the caret at the end, and grows the textareas', () => {
  const b = draftWith({ overrides: { availability: { objective: 0.99 } }, editor: { key: 'availability', custom: false } });
  const model = dialogOf(b);
  const log = [];
  const active = { dataset: { focusKey: 'ov:availability:objective' }, value: '99.', selectionStart: 3, selectionEnd: 3 };
  const fresh = { tagName: 'INPUT', value: '99', dataset: { focusKey: 'ov:availability:objective' }, focus: (o) => log.push(['focus', o]), setSelectionRange: (a, c) => log.push(['sel', a, c]) };
  const ta = { tagName: 'TEXTAREA', style: {}, scrollHeight: 300 };
  const idInput = { tagName: 'INPUT', value: 'availability', dataset: { focusKey: 'ov:availability:id' }, focus: (o) => log.push(['focus-id', o]), setSelectionRange: (a, c) => log.push(['sel-id', a, c]) };
  const dialogEl = { addEventListener() {}, focus: (o) => log.push(['focus-dialog', o]) };
  const container = {
    innerHTML: '', contains: (el) => el === active,
    querySelector: (sel) => (sel === '[data-focus-key="ov:availability:objective"]' ? fresh : sel === '.build-editor' ? dialogEl : sel === '.build-editor [data-field="id"] .build-edit-input' ? idInput : null),
    querySelectorAll: (sel) => (sel === 'textarea.build-edit-input' ? [ta] : []),
  };
  globalThis.document = { activeElement: active, body: {} };
  try {
    renderBuildEditor(container, model, { build: {} });
    assert.ok(container.innerHTML.includes('role="dialog"'), 'rendered');
    assert.deepEqual([fresh.value, log], ['99.', [['focus', { preventScroll: true }], ['sel', 3, 3]]], 'the typed text, the focus and the caret survive; the model\'s "99" does not overwrite "99."');
    assert.deepEqual([ta.style.height, ta.style.overflowY], [`${PROMQL_MAX_HEIGHT}px`, 'auto'], 'a long expression grows to the cap, then scrolls inside');
    // Opening on a field: the caret at the end, nothing kept.
    log.length = 0;
    globalThis.document.activeElement = globalThis.document.body;
    renderBuildEditor(container, model, { build: {} }, { focus: 'id' });
    assert.deepEqual(log, [['focus-id', { preventScroll: true }], ['sel-id', 12, 12]]);
    log.length = 0;
    renderBuildEditor(container, model, { build: {} }, { focus: 'dialog' });
    assert.deepEqual(log, [['focus-dialog', { preventScroll: true }]]);
    // The active element outside the editor (a sheet input): nothing touched.
    log.length = 0;
    globalThis.document.activeElement = { dataset: { focusKey: 'param:job@L2/sheet' }, value: 'x' };
    renderBuildEditor(container, model, { build: {} });
    assert.deepEqual(log, []);
    // A typed id the model does not carry (a clash, not committed) is kept AND its message and status are painted
    // again: the model-driven render has no error for it and once wiped the clash message under the field (measured).
    const typedId = { dataset: { focusKey: 'ov:availability:id', overrideField: 'id' }, value: 'error_rate', selectionStart: 10, selectionEnd: 10 };
    const freshId = { tagName: 'INPUT', value: 'availability', dataset: { focusKey: 'ov:availability:id', overrideField: 'id' }, id: 'build-editor-id', focus: (o) => log.push(['focus-id', o]), setSelectionRange: (a, c) => log.push(['sel-id', a, c]), attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
    const idMsg = { className: 'build-edit-hint', id: 'build-editor-id-hint', textContent: '', setAttribute() {}, removeAttribute() {} };
    const idBox = { classList: { toggle() {} }, querySelector: (sel) => (sel === '.build-edit-input' ? freshId : sel === '.build-edit-default' ? null : idMsg) };
    const statusEl = { textContent: '', className: '' };
    const c2 = {
      ...container, contains: (el) => el === typedId,
      querySelector: (sel) => (sel === '[data-focus-key="ov:availability:id"]' ? freshId : sel === '.build-editor [data-field="id"]' ? idBox : sel === '#build-editor-status' ? statusEl : sel === '.build-editor' ? dialogEl : null),
    };
    globalThis.document.activeElement = typedId;
    log.length = 0;
    renderBuildEditor(c2, model, { build: {} });
    assert.deepEqual([freshId.value, log, idMsg.className, idMsg.textContent, freshId.attrs['aria-invalid'], statusEl.textContent, statusEl.className],
      ['error_rate', [['focus-id', { preventScroll: true }], ['sel-id', 10, 10]], 'build-edit-error', 'error_rate is already an SLI of the pack or of a selected product — pick another id', 'true', 'not applied — error_rate is already an SLI of the pack or of a selected product — pick another id', 'build-editor-status is-error']);
    // A valid rename typed but not yet committed: the status says how to apply it.
    typedId.value = 'http_availability'; freshId.value = 'availability';
    renderBuildEditor(c2, model, { build: {} });
    assert.deepEqual([freshId.value, statusEl.textContent, idMsg.className], ['http_availability', 'rename to http_availability — Enter, Tab or Esc applies it', 'build-edit-hint']);
    // A CUSTOM SLI renamed under the focused field: its keys carry the id (cu:checkout_ok:id → cu:checkout_okx:id), so
    // the old key finds nothing — the focus once dropped to <body> after the first keystroke and every following one was
    // lost (measured). The same dialog's kept key is re-keyed; a field whose key is gone altogether is found by its name.
    const renamedModel = dialogOf(draftWith({ custom: [{ id: 'checkout_okx', type: 'ratio', good: 'a', total: 'b', objective: 0.999, window: '30d' }], editor: { key: 'checkout_okx', custom: true } }));
    const oldId = { dataset: { focusKey: 'cu:checkout_ok:id', customField: 'id' }, value: 'checkout_okx', selectionStart: 12, selectionEnd: 12 };
    const newId = { tagName: 'INPUT', value: 'checkout_okx', dataset: { focusKey: 'cu:checkout_okx:id', customField: 'id' }, focus: (o) => log.push(['focus-new-id', o]), setSelectionRange: (a, c) => log.push(['sel-new-id', a, c]) };
    const newDesc = { tagName: 'INPUT', value: '', dataset: { focusKey: 'cu:checkout_okx:description', customField: 'description' }, focus: (o) => log.push(['focus-new-desc', o]), setSelectionRange: (a, c) => log.push(['sel-new-desc', a, c]) };
    const mountedOld = { dataset: { editorKey: 'checkout_ok', editorMode: 'edit' }, addEventListener() {}, focus() {} };
    const c3 = {
      innerHTML: '', contains: (el) => el === oldId || el === oldDesc, querySelectorAll: () => [],
      querySelector: (sel) => (sel === '.build-editor' ? mountedOld : sel === '[data-focus-key="cu:checkout_okx:id"]' ? newId : sel === '.build-editor [data-field="description"] .build-edit-input' ? newDesc : null),
    };
    const oldDesc = { dataset: { focusKey: 'cu:checkout_ok:description', customField: 'description' }, value: 'Checkouts', selectionStart: 2, selectionEnd: 2 };
    globalThis.document.activeElement = oldId;
    log.length = 0;
    renderBuildEditor(c3, renamedModel, { build: {} });
    assert.deepEqual([newId.value, log], ['checkout_okx', [['focus-new-id', { preventScroll: true }], ['sel-new-id', 12, 12]]], 'the kept key is re-keyed to the renamed editor');
    globalThis.document.activeElement = oldDesc;
    log.length = 0;
    renderBuildEditor(c3, renamedModel, { build: {} });
    assert.deepEqual([newDesc.value, log], ['Checkouts', [['focus-new-desc', { preventScroll: true }], ['sel-new-desc', 2, 2]]], 'a field found by its name when its key is gone');
    // ANOTHER editor rendered while a field of the old one had the focus: nothing is kept (the controller lands the focus).
    globalThis.document.activeElement = { dataset: { focusKey: 'ov:availability:description', overrideField: 'description' }, value: 'x' };
    log.length = 0;
    renderBuildEditor({ ...c3, contains: () => true, querySelector: (sel) => (sel === '.build-editor' ? { dataset: { editorKey: 'availability', editorMode: 'edit' }, addEventListener() {} } : sel === '.build-editor [data-field="description"] .build-edit-input' ? newDesc : null) }, renamedModel, { build: {} });
    assert.deepEqual(log, [], 'a different editor: the old field\'s text is not written into it');
    // Done (a control without a field) keeps the focus across the pack's answer.
    const doneBtn = { tagName: 'BUTTON', dataset: { focusKey: 'editor:done' }, focus: (o) => log.push(['focus-done', o]) };
    globalThis.document.activeElement = { dataset: { focusKey: 'editor:done' } };
    log.length = 0;
    renderBuildEditor({ ...container, contains: () => true, querySelector: (sel) => (sel === '[data-focus-key="editor:done"]' ? doneBtn : sel === '.build-editor' ? dialogEl : null) }, model, { build: {} });
    assert.deepEqual(log, [['focus-done', { preventScroll: true }]]);
    // The SAME editor already mounted (key and mode) is redrawn in place: the head, the body and the actions are
    // replaced, the dialog node, the scrim and the status node (the polite live region) stay — assistive technology
    // announces a text change in an existing live region, not the initial text of a freshly inserted one (the
    // 'applied · …' answer once arrived by replacing the whole dialog's innerHTML; measured). Another key, or another
    // mode: the dialog is rendered whole.
    const part = () => ({ innerHTML: '' });
    const status = { textContent: 'applying…', className: 'build-editor-status is-pending' };
    const parts = { '.build-editor-head': part(), '.build-editor-body': part(), '.build-editor-actions': part(), '#build-editor-status': status };
    const mountedSame = { className: 'build-editor is-edit', dataset: { editorKey: 'availability', editorMode: 'edit' }, addEventListener: () => log.push(['dialog-listener']), querySelector: (sel) => parts[sel] || null };
    const scrim = { addEventListener: () => log.push(['scrim-listener']) };
    const c4 = { innerHTML: 'UNTOUCHED', contains: () => false, querySelectorAll: () => [], querySelector: (sel) => (sel === '.build-editor' ? mountedSame : sel === '.build-editor-scrim' ? scrim : sel === '#build-editor-status' ? status : null) };
    globalThis.document.activeElement = globalThis.document.body;
    log.length = 0;
    renderBuildEditor(c4, model, { build: {} });
    assert.equal(c4.innerHTML, 'UNTOUCHED', 'the container is not replaced');
    assert.deepEqual(log, [], 'the scrim and the dialog keep their listeners (no second binding)');
    assert.ok(parts['.build-editor-head'].innerHTML.includes('<h2 class="build-editor-title" id="build-editor-title">availability</h2>'));
    assert.ok(parts['.build-editor-body'].innerHTML.includes('id="build-editor-objective"') && parts['.build-editor-actions'].innerHTML.includes('data-editor-done'));
    assert.deepEqual([status.textContent, status.className, mountedSame.dataset.editorKey], [model.status.text, `build-editor-status is-${model.status.kind}`, 'availability'], 'the same status node carries the answer');
    const untouched = status;
    renderBuildEditor(c4, dialogOf({ ...b, overrides: { availability: { objective: 0.999 } } }), { build: {} });
    assert.equal(parts['#build-editor-status'], untouched, 'the second render of the same key reuses the status node');
    // Another editor over the same host: rendered whole.
    const c5 = { ...c4, innerHTML: 'UNTOUCHED' };
    renderBuildEditor(c5, dialogOf(draftWith({ editor: { key: 'latency_p99', custom: false } })), { build: {} });
    assert.ok(c5.innerHTML !== 'UNTOUCHED' && c5.innerHTML.includes('data-editor-key="latency_p99"'), 'another key: the dialog is rendered whole');
    const c6 = { ...c4, innerHTML: 'UNTOUCHED' };
    renderBuildEditor(c6, dialogOf(b, 'readonly'), { build: {} });
    assert.ok(c6.innerHTML.includes('data-editor-mode="readonly"'), 'another mode: rendered whole');
  } finally {
    delete globalThis.document;
  }
  // growTextarea on its own: the height follows the text up to the cap; nothing without a style.
  const small = { style: {}, scrollHeight: 60 };
  growTextarea(small);
  assert.deepEqual([small.style.height, small.style.overflowY], ['60px', 'hidden']);
  growTextarea(null);
  growTextarea({});
  // Headless (no document): the render is plain and the requested field's focus is a no-op on a stub.
  assert.ok(renderHtml(model).includes('data-editor-key="availability"'));
});

test('create mode handlers: typing the name slugs the id (a typed id sticks), the id / name messages and the submit follow the model as typed, the title follows the id, Add → addCustom with the engine’s definition, the type re-renders the fields, Esc and Cancel close', () => {
  const b = draftWith({ editor: { create: true } });
  const model = dialogOf(b);
  const calls = [];
  let lastDraft = null;   // what the state holds: every input writes the draft as typed (the model of the next render is built from it)
  const act = { update: (p, o) => { if (p.customDraft) lastDraft = p.customDraft; calls.push(['update', p.customDraft?.id, p.customDraft?.idTouched, o]); }, addCustom: (def, d) => calls.push(['add', def, d.id]), closeEditor: () => calls.push(['close']) };
  const el = (field, value = '') => ({ ...fakeEl({ customDraft: field }), value, tagName: field === 'good' || field === 'total' ? 'TEXTAREA' : field === 'type' ? 'SELECT' : 'INPUT', style: {}, scrollHeight: 20 });
  const name = el('name'), id = el('id'), type = el('type', 'ratio'), desc = el('description'), obj = el('objective', '99.9'), win = el('window', '30d'), metric = el('semconv_metric'), good = el('good'), total = el('total');
  const submit = { ...fakeEl({}), disabled: true, click: () => calls.push(['submit-click']) };
  const status = { textContent: '', className: '' };
  const title = { textContent: '' };
  const paint = (fid) => {
    const attrs = {};
    const msg = { className: 'build-edit-hint', id: `build-custom-${fid}-hint`, textContent: '', setAttribute: (k, v) => { attrs[`msg.${k}`] = v; }, removeAttribute: (k) => { delete attrs[`msg.${k}`]; } };
    const inp = { id: `build-custom-${fid}`, setAttribute: (k, v) => { attrs[`inp.${k}`] = v; }, removeAttribute: (k) => { delete attrs[`inp.${k}`]; } };
    const cls = new Set();
    return { box: { classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); } }, querySelector: (sel) => (sel === '.build-edit-input' ? inp : sel === '.build-edit-default' ? null : msg) }, msg, attrs, cls };
  };
  const idPaint = paint('id'), namePaint = paint('name');
  const dialog = fakeEl({});
  const cancel = fakeEl({});
  wireBuildEditor(fakeContainer({
    '.build-editor': [dialog], '.build-editor [data-editor-close]': [cancel], '.build-editor [data-custom-draft]': [name, id, type, desc, obj, win, metric, good, total],
    '[data-editor-submit]': [submit], '#build-editor-status': [status], '#build-editor-title': [title],
    '.build-editor [data-field="id"]': [idPaint.box], '.build-editor [data-field="name"]': [namePaint.box],
  }), model, { build: act });
  name.value = 'Checkout Success'; name.fire('input');
  assert.deepEqual([id.value, title.textContent, submit.disabled, calls.at(-1)], ['checkout_success', 'checkout_success', true, ['update', 'checkout_success', false, { rerender: false, reinstantiate: false }]], 'the id follows the name without a re-render');
  assert.deepEqual([namePaint.msg.textContent, status.className], ['id checkout_success', 'build-editor-status is-idle']);
  good.value = 'sum(rate(checkout_ok_total[5m]))'; good.fire('input');
  total.value = 'sum(rate(checkout_total[5m]))'; total.fire('input');
  assert.deepEqual([submit.disabled, status.className, good.style.height], [false, 'build-editor-status is-ready', '20px'], 'the required fields are filled: the button wakes, the status says ready');
  // A typed id sticks and is what Add sends; a clash is said on the field while typing and the button sleeps again.
  id.value = 'latency_p99'; id.fire('input');
  assert.deepEqual([idPaint.msg.className, idPaint.msg.textContent, idPaint.cls.has('is-error'), idPaint.attrs['inp.aria-invalid'], submit.disabled, title.textContent], ['build-edit-error', 'latency_p99 is already an SLI of the pack or of a selected product — pick another name', true, 'true', true, 'latency_p99']);
  id.value = 'my_checkout_id'; id.fire('input');
  name.value = 'Checkout Success!'; name.fire('input');
  assert.deepEqual([id.value, submit.disabled, idPaint.msg.className, calls.at(-1).slice(0, 3)], ['my_checkout_id', false, 'build-edit-hint', ['update', 'my_checkout_id', true]], 'the typed id is not overwritten by the name\'s slug');
  metric.value = ' checkout.success '; metric.fire('input');
  win.fire('keydown', { key: 'Enter' });
  assert.deepEqual(calls.at(-1), ['submit-click'], 'Enter on a one-line input submits when the button is awake');
  // Add sends the engine's definition from the draft as typed — on a re-render (the type changed, the pack answered) the next wiring starts from the state's draft, the typed id kept.
  const submitEl = fakeEl({});
  submitEl.disabled = false;
  assert.deepEqual([lastDraft.id, lastDraft.idTouched], ['my_checkout_id', true]);
  wireBuildEditor(fakeContainer({ '.build-editor': [fakeEl({})], '.build-editor [data-custom-draft]': [name, id, type, desc, obj, win, metric, good, total], '[data-editor-submit]': [submitEl], '#build-editor-status': [status], '#build-editor-title': [title] }), dialogOf({ ...b, customDraft: lastDraft }), { build: act });
  submitEl.fire('click');
  assert.deepEqual(calls.at(-1), ['add', { id: 'my_checkout_id', type: 'ratio', objective: 0.999, window: '30d', good: 'sum(rate(checkout_ok_total[5m]))', total: 'sum(rate(checkout_total[5m]))', semconv_metric: 'checkout.success' }, 'my_checkout_id']);
  // The type select re-renders (it changes the fields); Cancel and Esc close.
  type.value = 'threshold'; type.fire('change');
  assert.deepEqual(calls.at(-1)[3], { rerender: true, reinstantiate: false });
  cancel.fire('click');
  dialog.fire('keydown', { key: 'Escape', target: { tagName: 'BUTTON' } });
  assert.deepEqual(calls.slice(-2), [['close'], ['close']]);
  // paintFieldMessage on its own: nothing without a box.
  paintFieldMessage(fakeContainer({}), 'id', 'x', 'y');
});

test('the direction control’s handlers: a click or an arrow key picks the other side and commits it live through setOverride (the library’s own side clears the override instead) or updateCustom; in create mode the pick lands in the draft and a floor reaches the engine’s definition; the segments repaint without a re-render', () => {
  const dirGroup = (dataset, checked) => {
    const attrs = {};
    const btn = (side) => {
      const a = { 'aria-checked': side === checked ? 'true' : 'false', tabindex: side === checked ? '0' : '-1' };
      const handlers = {};
      return {
        dataset: { dir: side, focusKey: `k:${side}` }, focused: 0, attrs: a,
        addEventListener: (t, fn) => { handlers[t] = fn; }, fire: (t, ev = {}) => handlers[t]?.({ preventDefault() {}, ...ev }),
        getAttribute: (k) => a[k] ?? null, setAttribute: (k, v) => { a[k] = v; }, focus() { this.focused++; },
      };
    };
    const btns = [btn('below'), btn('above')];
    return { dataset, style: { setProperty: (k, v) => { attrs[k] = v; } }, attrs, btns, querySelectorAll: (sel) => (sel === '[data-dir]' ? btns : []) };
  };
  const state = (g) => [g.btns.map(b => `${b.dataset.dir}:${b.attrs['aria-checked']}/${b.attrs.tabindex}`).join(' '), g.attrs['--dir-index']];
  // A library SLI whose template says below: picking above is an override, picking below again clears it (the library's side is no customisation).
  const b = draftWith({ entries: ['kafka', 'http-service'], editor: { key: 'kafka_produce_latency_p99', custom: false } });
  const calls = [];
  const act = { setOverride: (k, f, v, o) => { calls.push(['override', k, f, v, o]); return true; }, clearOverride: (k, f) => calls.push(['clear', k, f]), updateCustom: (id, f, v, o) => { calls.push(['custom', id, f, v, o]); return true; }, closeEditor: () => {} };
  const status = { textContent: '', className: '' };
  const g = dirGroup({ dirGroup: 'good_when', overrideField: 'good_when', sli: 'kafka_produce_latency_p99' }, 'below');
  wireBuildEditor(fakeContainer({ '.build-editor': [fakeEl({})], '#build-editor-status': [status], '.build-editor .build-edit-dir[data-dir-group]': [g] }), dialogOf(b), { build: act });
  g.btns[0].fire('click');
  assert.deepEqual(calls, [], 'the side already chosen: nothing sent');
  g.btns[1].fire('click');
  assert.deepEqual(calls, [['override', 'kafka_produce_latency_p99', 'good_when', 'above', { live: true }]]);
  assert.deepEqual([state(g), status.textContent, status.className], [['below:false/-1 above:true/0', '1'], 'applying…', 'build-editor-status is-pending'], 'the segments and the thumb repaint at once');
  g.btns[1].fire('keydown', { key: 'ArrowLeft' });
  assert.deepEqual([calls.at(-1), g.btns[0].focused, state(g)], [['clear', 'kafka_produce_latency_p99', 'good_when'], 1, ['below:true/0 above:false/-1', '0']], 'ArrowLeft moves to below — the library\'s side — and clears the override');
  g.btns[0].fire('keydown', { key: 'ArrowDown' });
  assert.deepEqual([calls.at(-1), g.btns[1].focused], [['override', 'kafka_produce_latency_p99', 'good_when', 'above', { live: true }], 1], 'ArrowDown wraps to above and commits it');
  g.btns[1].fire('keydown', { key: 'Enter' });
  assert.equal(calls.length, 3, 'other keys do nothing');
  // An override whose library side is above: below is the customisation, above clears.
  const bAbove = draftWith({ entries: ['kafka', 'http-service'], editor: { key: 'kafka_produce_latency_p99', custom: false } });
  const modelAbove = { ...dialogOf(bAbove), fields: dialogOf(bAbove).fields.map(f => (f.id === 'good_when' ? { ...f, default: 'above', value: 'above' } : f)) };
  const g2 = dirGroup({ dirGroup: 'good_when', overrideField: 'good_when', sli: 'kafka_produce_latency_p99' }, 'above');
  calls.length = 0;
  wireBuildEditor(fakeContainer({ '.build-editor': [fakeEl({})], '#build-editor-status': [status], '.build-editor .build-edit-dir[data-dir-group]': [g2] }), modelAbove, { build: act });
  g2.btns[0].fire('click'); g2.btns[1].fire('click');
  assert.deepEqual(calls, [['override', 'kafka_produce_latency_p99', 'good_when', 'below', { live: true }], ['clear', 'kafka_produce_latency_p99', 'good_when']]);
  // A custom SLI: every pick goes through updateCustom (it has no library side).
  const custom = { id: 'settlement_consumers', type: 'threshold', query: 'min(members)', threshold: 2, good_when: 'above', unit: 'consumers', objective: 0.999, window: '30d' };
  const bc = draftWith({ custom: [custom], editor: { key: 'settlement_consumers', custom: true } });
  const mc = dialogOf(bc);
  assert.deepEqual([mc.custom, field(mc, 'good_when').value, field(mc, 'good_when').default, field(mc, 'good_when').focusKey], [true, 'above', null, 'cu:settlement_consumers:good_when']);
  const g3 = dirGroup({ dirGroup: 'good_when', customField: 'good_when', sli: 'settlement_consumers' }, 'above');
  calls.length = 0;
  wireBuildEditor(fakeContainer({ '.build-editor': [fakeEl({})], '#build-editor-status': [status], '.build-editor .build-edit-dir[data-dir-group]': [g3] }), mc, { build: act });
  g3.btns[0].fire('click'); g3.btns[0].fire('keydown', { key: 'ArrowRight' }); g3.btns[1].fire('keydown', { key: 'ArrowUp' });
  assert.deepEqual(calls, [['custom', 'settlement_consumers', 'good_when', 'below', { live: true }], ['custom', 'settlement_consumers', 'good_when', 'above', { live: true }], ['custom', 'settlement_consumers', 'good_when', 'below', { live: true }]]);
  // Create mode: the pick lands in the draft without a re-render; Add sends a floor's direction and nothing for below.
  const bCreate = draftWith({ editor: { create: true }, customDraft: { name: 'Settlement consumers', type: 'threshold', query: 'min(members)', threshold: '2', unit: 'consumers' } });
  const cCalls = [];
  let lastDraft = null;
  const cAct = { update: (p, o) => { if (p.customDraft) lastDraft = p.customDraft; cCalls.push(['update', p.customDraft?.good_when, o]); }, addCustom: (def, d) => cCalls.push(['add', def, d.good_when]), closeEditor: () => {} };
  const g4 = dirGroup({ dirGroup: 'good_when', customDraft: 'good_when' }, 'below');
  const inputs = [{ ...fakeEl({ customDraft: 'name' }), value: 'Settlement consumers', tagName: 'INPUT' }, { ...fakeEl({ customDraft: 'threshold' }), value: '2', tagName: 'INPUT' }, { ...fakeEl({ customDraft: 'query' }), value: 'min(members)', tagName: 'TEXTAREA', style: {}, scrollHeight: 20 }];
  const submit = { ...fakeEl({}), disabled: false };
  const cStatus = { textContent: '', className: '' };
  wireBuildEditor(fakeContainer({ '.build-editor': [fakeEl({})], '.build-editor [data-custom-draft]': [...inputs, g4], '[data-editor-submit]': [submit], '#build-editor-status': [cStatus], '#build-editor-title': [{ textContent: '' }], '.build-editor .build-edit-dir[data-dir-group]': [g4] }), dialogOf(bCreate), { build: cAct });
  g4.btns[1].fire('click');
  assert.deepEqual([cCalls.at(-1), lastDraft.good_when, state(g4)], [['update', 'above', { rerender: false, reinstantiate: false }], 'above', ['below:false/-1 above:true/0', '1']]);
  submit.fire('click');
  assert.deepEqual(cCalls.at(-1)[1], { id: 'settlement_consumers', type: 'threshold', objective: 0.999, window: '30d', query: 'min(members)', threshold: 2, good_when: 'above', unit: 'consumers' });
  g4.btns[1].fire('keydown', { key: 'ArrowRight' });
  submit.fire('click');
  assert.ok(!('good_when' in cCalls.at(-1)[1]) && lastDraft.good_when === 'below', 'back to below: the default, not written');
  inputs[0].value = 'Settlement consumers live'; inputs[0].fire('input');
  assert.equal(lastDraft.good_when, 'below', 'a typed input does not lose the picked side (the group has no value to read back)');
  // paintDirection on its own is what a pick does to the DOM.
  const g5 = dirGroup({}, 'below');
  paintDirection(g5, 'above');
  assert.deepEqual(state(g5), ['below:false/-1 above:true/0', '1']);
});

// A document with only what the Tab trap reads (tools/test-build-model.mjs fakeDocument).
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

test('the Tab trap covers the editor (aria-modal=true) alone while the non-modal layer sheet is open underneath: Tab wraps inside the editor and never reaches the sheet; without the editor the sheet stays untrapped', () => {
  assert.equal(TRAPPED_DIALOGS, '[role="dialog"]:not([hidden]):not([aria-modal="false"])');
  const dialogs = [];
  const { doc, dialog, focusable } = fakeDocument(dialogs);
  const sheet = dialog({ role: 'dialog', 'aria-modal': 'false' }, ['Close the layer sheet (Esc)', 'Edit availability']);
  const editor = dialog({ role: 'dialog', 'aria-modal': 'true' }, ['build-editor-id', 'build-editor-description', 'Done']);
  dialogs.push(sheet);
  installDialogFocusTrap(doc);
  doc.activeElement = sheet.items[1];
  assert.equal(doc.tab(), false, 'the sheet alone: Tab walks on to the page');
  // The editor opens over the sheet (it is the last dialog in document order: its host sits at the end of <body>).
  dialogs.push(editor);
  doc.activeElement = sheet.items[1];
  assert.equal(doc.tab(), true);
  assert.equal(doc.activeElement, editor.items[0], 'Tab from the sheet is pulled into the editor\'s first field');
  doc.activeElement = editor.items[2];
  assert.equal(doc.tab(), true);
  assert.equal(doc.activeElement, editor.items[0], 'Tab from Done wraps to the first field');
  doc.activeElement = editor.items[0];
  assert.equal(doc.tab(true), true);
  assert.equal(doc.activeElement, editor.items[2], 'Shift+Tab from the first wraps to Done');
  doc.activeElement = editor.items[1];
  assert.equal(doc.tab(), false, 'inside the editor, between fields, Tab is the browser\'s');
  // The editor closes: the sheet is untrapped again.
  dialogs.pop();
  doc.activeElement = focusable('#build-name');
  assert.equal(doc.tab(), false);
  // The rendered dialog carries exactly those attributes.
  const html = buildEditorHtml(dialogOf(draftWith({ editor: { key: 'availability', custom: false } })));
  assert.match(html, /<div class="build-editor is-edit" role="dialog" aria-modal="true"/);
});

test('the stylesheet: one centered fixed modal above the sheet with the L1 accent through the tokens, a scrim over everything, the two-column grid, the entrance and the reduced-motion block; the rolodex’s Edit button and create card', () => {
  const editor = cssRule('.build-editor');
  assert.ok(editor && /position:\s*fixed/.test(editor) && /top:\s*50%;\s*left:\s*50%;\s*transform:\s*translate\(-50%, -50%\)/.test(editor), 'centered');
  // The stacking: above the sheet (z 61), the sticky header (z 100 — at 1366×768 the title row of every threshold /
  // create editor sat behind it and the header's buttons took the clicks meant for the dialog; measured) and the
  // toast (z 100); below the drop overlay and the Advanced menu (z 200), which are the chrome's own layers.
  const z = (sel) => Number(/z-index:\s*(\d+)/.exec(cssRule(sel))[1]);
  assert.match(editor, /z-index:\s*151/);
  assert.match(cssRule('.build-editor-scrim'), /position:\s*fixed;\s*inset:\s*0;\s*z-index:\s*150/);
  assert.ok(z('.build-sheet') < z('.build-editor-scrim') && z('.build-editor-scrim') < z('.build-editor'), 'the scrim covers the sheet, the editor the scrim');
  assert.ok(z('.observa-hdr') < z('.build-editor-scrim') && z('.toast') < z('.build-editor-scrim'), 'the scrim covers the sticky header and the toast');
  assert.ok(z('.build-editor') < z('.drop-overlay') && z('.build-editor') < z('.observa-adv-menu'), 'below the drop overlay and the Advanced menu');
  assert.match(editor, /--accent:\s*var\(--L1\)/);
  assert.match(editor, /max-height:\s*calc\(100dvh - 40px\)/, 'never taller than the viewport');
  assert.match(cssRule('.build-editor-body'), /overflow:\s*auto;\s*overscroll-behavior:\s*contain/, 'scrolls inside, never the page');
  assert.match(cssRule('.build-editor-grid'), /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(cssRule('.build-editor-cell.is-wide'), /grid-column:\s*1 \/ -1/);
  assert.match(editor, /animation:\s*build-editor-in 160ms ease-out/);
  const reduced = CSS_TEXT.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g)?.find(b => b.includes('.build-editor')) || '';
  assert.ok(reduced.includes('.build-editor, .build-editor-scrim { animation: none; }') || /\.build-editor-scrim \{ animation: none; \}/.test(reduced), 'the entrance respects reduced motion');
  assert.ok(reduced.includes('.build-rolo-edit') && reduced.includes('.build-editor-close'));
  // Every transition the editor slice added is in the reduced-motion list: the rolodex's Edit and create card, the esc and
  // ↺ buttons, the stack's editable card and the seed card's product chips (the last two were left out; colour-only, still a promise).
  for (const sel of ['.build-rolo-edit', '.build-edit-reset', '.build-editor-close', '.build-slab .card.is-editable', '.build-seed-chip.is-entry']) assert.match(cssRule(sel) || '', /transition:/, `${sel} transitions`);
  for (const sel of ['.build-rolo-edit', '.build-rolo-create', '.build-edit-reset', '.build-editor-close', '.build-slab .card.is-editable', '.build-seed-chip.is-entry']) assert.ok(reduced.includes(sel), `${sel} is in the reduced-motion transition: none list`);
  const block = CSS_TEXT.slice(CSS_TEXT.indexOf('---- The editor'), CSS_TEXT.indexOf('@media (max-width: 760px)', CSS_TEXT.indexOf('---- The editor')));
  assert.deepEqual([...block.matchAll(/#[0-9a-fA-F]{3,6}\b/g)].map(m => m[0]), [], 'the tokens only — both themes follow');
  // No dead rule: every .build-edit* / .build-editor* / .build-rolo* class the stylesheet names has a user in a studio module
  // (`.build-rolo-objective b.build-rolo-needs` outlived the 'needs tier-N' chip by two slices).
  const studioSrc = readdirSync(resolve(ROOT, 'studio')).filter(f => f.endsWith('.mjs')).map(f => readFileSync(resolve(ROOT, 'studio', f), 'utf8')).join('\n');
  const named = [...new Set([...CSS_TEXT.matchAll(/\.(build-(?:edit|editor|rolo)[a-z0-9-]*)/g)].map(m => m[1]))];
  assert.ok(named.length > 40, `the sweep sees the editor's classes (${named.length})`);
  assert.deepEqual(named.filter(c => !studioSrc.includes(c)), [], 'every editor / rolodex class in the stylesheet is used by a studio module');
  assert.ok(/\[data-theme="dark"\] \.build-editor \{/.test(block), 'the dark theme adjusts the shadow');
  assert.match(cssRule('.build-rolo-edit'), /cursor:\s*pointer/);
  assert.match(cssRule('.build-rolo-create'), /appearance:\s*none;\s*cursor:\s*pointer;\s*text-align:\s*left/);
  assert.match(CSS_TEXT.match(/@media \(max-width: 760px\) \{[\s\S]*?\n\}/g).find(b => b.includes('.build-editor')), /\.build-editor-grid \{ grid-template-columns: 1fr; \}/, 'one column on a narrow screen');
  // The direction control (spec 1.3 good_when): the Bound cell splits for it, the two-segment group with a sliding thumb in the
  // tier control's idiom, the tokens only, the accent ring when overridden, its transitions in the reduced-motion list, one column narrow.
  assert.match(cssRule('.build-editor-cell.is-threshold.has-direction'), /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/, 'two tracks that both shrink: an auto track let the direction hint squeeze the Bound input (measured)');
  assert.match(cssRule('.build-edit-dir'), /display:\s*grid;\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);.*background:\s*var\(--line-2\)/);
  assert.match(cssRule('.build-edit-dir-thumb'), /width:\s*calc\(\(100% - 6px\) \/ 2\)[\s\S]*transform:\s*translateX\(calc\(var\(--dir-index, 0\) \* 100%\)\)[\s\S]*transition:\s*transform/);
  assert.match(cssRule('.build-edit-dir-btn'), /color:\s*var\(--ink-3\)[\s\S]*transition:\s*color/);
  assert.match(cssRule('.build-edit-dir-btn[aria-checked="true"]'), /color:\s*var\(--ink\)/);
  assert.match(cssRule('.build-edit-dir-btn:focus-visible'), /outline:\s*2px solid var\(--accent\)/);
  assert.match(cssRule('.build-edit-direction.is-overridden .build-edit-dir'), /var\(--accent\)/);
  for (const sel of ['.build-edit-dir-thumb', '.build-edit-dir-btn']) assert.ok(reduced.includes(sel), `${sel} is in the reduced-motion transition: none list`);
  assert.match(CSS_TEXT.match(/@media \(max-width: 760px\) \{[\s\S]*?\n\}/g).find(b => b.includes('.build-editor')), /\.build-editor-cell\.is-threshold\.has-direction \{ grid-template-columns: 1fr; \}/);
  assert.match(cssRule('.build-rolo-bound'), /color:\s*var\(--ink-2\)/, 'the rolodex prints the bound in ink');
});

// ---------------------------------------------------------------------------
// The 2026-09 UX review, "Build / SLI editor": one sentence in real units, the fields in four groups, short help
// with the long explanation on demand, the relationships checked as typed with a linked summary, Save SLI apart
// from "Include in this pack"
// ---------------------------------------------------------------------------

test('the plain words: an id as a name, a window in days, the opening sentence in real units; the relationship checks (direction, bound, unit, objective, window); the short help and the long explanation', () => {
  assert.deepEqual([sliName('queue_depth_headroom'), sliName('http_service_availability'), sliName('dlq_depth'), sliName('qmgr_process_up'), sliName('')], ['Queue depth headroom', 'HTTP service availability', 'DLQ depth', 'Queue manager process up', '']);
  assert.deepEqual([windowText('30d'), windowText('1d'), windowText('7d'), windowText(''), windowText('2w')], ['30 days', '1 day', '7 days', '', '2w']);
  // The review's own example, word for word but for the bound being good at the bound itself (spec 1.3).
  assert.equal(sliSummarySentence({ id: 'queue_depth_headroom', type: 'threshold', objective: '99.9', window: '30d', threshold: '0.8', good_when: 'below', unit: 'ratio' }), 'Queue depth headroom is healthy when its ratio is at or below 0.8; target 99.9% of the time over 30 days.');
  assert.equal(sliSummarySentence({ id: 'settlement_consumers', type: 'threshold', objective: 99, window: '7d', threshold: 2, good_when: 'above', unit: 'consumers' }), 'Settlement consumers is healthy when it is at or above 2 consumers; target 99% of the time over 7 days.');
  assert.equal(sliSummarySentence({ id: 'notification_failures', type: 'threshold', objective: '99', window: '7d', threshold: 0, unit: 'per_second' }), 'Notification failures is healthy when it is at or below 0 per second; target 99% of the time over 7 days.');
  assert.equal(sliSummarySentence({ id: 'availability', type: 'ratio', objective: '99.5', window: '30d' }), 'Availability is the share of good events among all events; target 99.5% good over 30 days.');
  assert.equal(sliSummarySentence({ id: 'x_y', name: 'Checkout success', type: 'threshold', objective: 'abc', window: '30d', threshold: '' }), 'Checkout success is healthy when it stays within a bound that is not set yet; no objective set yet.', 'a value missing or not a number is said, not guessed');
  // The relationships.
  assert.deepEqual(sliRelationshipChecks({ type: 'threshold', objective: '99.9', window: '30d', threshold: '0.8', good_when: 'below', unit: 'ratio' }), {});
  assert.deepEqual(sliRelationshipChecks({ type: 'threshold', objective: '100', window: '31d', threshold: '80', unit: 'ratio' }), {
    objective: 'The objective is a percent above 0 and below 100, like 99.9', window: 'The window is one of 7d, 28d, 30d or 90d', threshold: 'A ratio bound is between 0 and 1 — for 80%, enter 0.8',
  });
  assert.deepEqual(sliRelationshipChecks({ type: 'threshold', threshold: '-1', unit: 'seconds' }), { threshold: 'A bound in seconds cannot be negative' });
  assert.deepEqual(sliRelationshipChecks({ type: 'threshold', threshold: '0', unit: 'per_second', good_when: 'above' }), { good_when: 'Good when above 0 makes every sample good — raise the bound or choose below' });
  assert.deepEqual(sliRelationshipChecks({ type: 'threshold', threshold: '1', unit: 'ratio', good_when: 'below' }), { good_when: 'Good when below 1 makes every ratio good — lower the bound or choose above' });
  assert.deepEqual(sliRelationshipChecks({ type: 'threshold', threshold: 'abc', unit: 'events per hour' }), { threshold: 'Enter the bound as a number, like 0.8' }, 'any unit text the engine takes is taken');
  assert.deepEqual(sliRelationshipChecks({ type: 'threshold', threshold: '1', unit: 'x'.repeat(65) }), { unit: 'A unit is at most 64 characters, like seconds, ratio or per_second' }, 'the engine’s own limit on a unit');
  // Nothing the engine accepts is refused for its own sake: any unit text, and a negative bound in a unit that can be negative.
  for (const [unit, threshold, good_when] of [['µs', '250', 'below'], ['requests per second', '5', 'above'], ['celsius', '-18', 'below'], ['dBm', '-70', 'above'], ['celsius', '0', 'above']]) {
    assert.deepEqual(sliRelationshipChecks({ type: 'threshold', objective: '99.9', window: '30d', threshold, good_when, unit }), {}, `${threshold} ${unit} good when ${good_when}`);
    assert.equal(customFormModel({ name: 'Cold room', type: 'threshold', objective: '99.9', window: '30d', query: 'up', threshold, good_when, unit }).canSubmit, true, `Add is open for ${threshold} ${unit}`);
  }
  // A unit that cannot go below zero keeps its sign rule, spelled with spaces or underscores.
  assert.deepEqual(sliRelationshipChecks({ type: 'threshold', threshold: '-1', unit: 'requests per second' }), { threshold: 'A bound in requests per second cannot be negative' });
  assert.deepEqual(sliRelationshipChecks({ type: 'threshold', threshold: '-5', unit: 'ms' }), { threshold: 'A bound in ms cannot be negative' });
  assert.deepEqual(sliRelationshipChecks({ type: 'threshold', threshold: '150', unit: 'percent' }), { threshold: 'A percent bound is between 0 and 100' });
  assert.deepEqual(sliRelationshipChecks({ type: 'ratio', objective: 'abc', threshold: '80', unit: 'ratio' }), { objective: 'Enter the objective as a percent, like 99.9' }, 'a ratio SLI carries no bound to check');
  assert.deepEqual(sliRelationshipChecks({ type: 'threshold', objective: '', window: '', threshold: '' }), {}, 'empty is not checked here: the library default in the editor, the required list in the form');
  // No library default is flagged, at any tier.
  for (const e of INDEX.entries) for (const sli of e.slis) for (const t of ['tier-3', 'tier-2', 'tier-1']) {
    assert.deepEqual(sliRelationshipChecks({ type: sli.type, objective: percentText(sli.objectives?.[t]), window: sli.windows?.[t], threshold: sli.threshold, good_when: sli.good_when, unit: sli.unit }), {}, `${e.id}.${sli.id} at ${t}`);
  }
  // A field's help: the short line under it, the longer explanation behind its '?'.
  assert.deepEqual(fieldHelp({ help: 'short', hint: 'long' }), { line: 'short', more: 'long' });
  assert.deepEqual(fieldHelp({ hint: 'only' }), { line: 'only', more: null });
  assert.equal(createFormStatus(customFormModel({ name: 'X y', type: 'ratio', good: 'a', total: 'b', objective: '100' })).text, 'one value needs attention — listed at the top');
});

test('the model: a relationship problem lands on its field and in the linked list, the engine’s word wins; the generated outputs; inclusion per kind; create mode checks the form and blocks Add', () => {
  const ratioBound = 'A ratio bound is between 0 and 1 — for 80%, enter 0.8';
  const b = draftWith({ entries: ['kafka', 'http-service'], overrides: { kafka_produce_latency_p99: { threshold: 80, unit: 'ratio' } } });
  const m = modelOf(b, 'kafka_produce_latency_p99');
  assert.deepEqual([field(m, 'threshold').check, field(m, 'threshold').error, field(m, 'threshold').engineError, field(m, 'threshold').value], [ratioBound, ratioBound, null, '80'], 'the value stays as entered');
  assert.deepEqual(m.errorList, [{ field: 'threshold', label: 'Bound', message: ratioBound, inputId: 'build-editor-threshold' }]);
  assert.equal(m.summary, 'Kafka produce latency p99 is healthy when its ratio is at or below 80; target 99% of the time over 30 days.');
  const withEngine = modelOf(b, 'kafka_produce_latency_p99', { errors: { threshold: 'engine says no' } });
  assert.deepEqual([field(withEngine, 'threshold').error, field(withEngine, 'threshold').check], ['engine says no', ratioBound], 'the engine is the authority');
  // Read-only (Verify): nothing re-checked, nothing to include or save.
  const ro = modelOf(b, 'kafka_produce_latency_p99', { mode: 'readonly' });
  assert.deepEqual([ro.checks, ro.errorList, ro.inclusion, ro.saveHelp, ro.doneLabel], [{}, [], null, null, 'Close']);
  // What the pack generated from the SLI (the folded details), and an SLI the pack does not carry yet.
  assert.deepEqual(m.outputs, { slo: 'kafka_produce_latency_p99_99', burns: 2, rule: 'orders_api:kafka_produce_latency_p99:value_5m', compiled: true });
  assert.deepEqual(generatedOutputs(null, 'x'), { slo: null, burns: 0, rule: null });
  const above = modelOf(b, 'kafka_controller_election_rate');
  assert.deepEqual([above.outputs.compiled, above.inclusion.on, above.inclusion.help], [false, false, 'Not in the pack. Save SLI keeps your edits with the draft; tick to include it.']);
  // A custom SLI exists only in the pack: its control removes it; an SLI of a product not selected says it selects the product.
  const cb = draftWith({ custom: [{ id: 'checkout_success', type: 'ratio', good: 'a', total: 'b', objective: 0.999, window: '30d' }], editor: { key: 'checkout_success', custom: true } });
  assert.deepEqual(dialogOf(cb).inclusion, { kind: 'remove', label: 'Remove SLI', help: 'A custom SLI is always in the pack; removing it deletes it.' });
  assert.equal(buildEditorModel({ build: { ...cb, editor: { key: 'alertmanager_availability', custom: false } }, library: LIBRARY }).inclusion.help, 'Not in the pack. Ticking also selects Alertmanager; your edits are kept either way.');
  // Create mode: the same checks on the form, Add blocked while one stands, the sentence from the typed name.
  const create = draftWith({ editor: { create: true }, customDraft: { name: 'Queue headroom', type: 'threshold', query: 'max(x)', threshold: '80', unit: 'ratio' } });
  const cm = dialogOf(create);
  assert.deepEqual([cm.submit.enabled, field(cm, 'threshold').error, cm.status], [false, ratioBound, { kind: 'error', text: 'one value needs attention — listed at the top' }]);
  assert.equal(cm.summary, 'Queue headroom is healthy when its ratio is at or below 80; target 99.9% of the time over 30 days.');
  assert.deepEqual(cm.errorList.map(e => e.field), ['threshold']);
  const fixed = dialogOf({ ...create, customDraft: { ...create.customDraft, threshold: '0.8' } });
  assert.deepEqual([fixed.submit.enabled, fixed.status.kind], [true, 'ready']);
});

test('the dialog in four groups: Behavior · Objective · Data source · Generated outputs; the PromQL and the generated names folded under Advanced (open when an error sits there, and in create mode); the sentence at the top; the linked error summary; a ? per field', () => {
  const b = draftWith({ entries: ['kafka', 'http-service'], overrides: { kafka_produce_latency_p99: { threshold: 80, unit: 'ratio' } }, editor: { key: 'kafka_produce_latency_p99', custom: false } });
  const model = dialogOf(b);
  assert.deepEqual(editorGroups(model).map(g => [g.id, g.cells, g.advanced]), [['behavior', ['description', 'threshold', 'unit'], []], ['objective', ['objective', 'window'], []], ['source', ['semconv_metric', '@type'], ['query']], ['outputs', ['id'], []]]);
  assert.deepEqual(editorFieldOrder(model).map(f => f.id), ['description', 'threshold', 'good_when', 'unit', 'objective', 'window', 'semconv_metric', 'query', 'id']);
  const html = renderHtml(model);
  assert.deepEqual([...html.matchAll(/<h3 class="build-editor-group-title" id="build-editor-g-([a-z]+)">([^<]+)/g)].map(m => [m[1], m[2].trim()]), [['behavior', 'Behavior'], ['objective', 'Objective'], ['source', 'Data source'], ['outputs', 'Generated outputs']]);
  assert.ok(html.includes('<p class="build-editor-summary" id="build-editor-summary">Kafka produce latency p99 is healthy when its ratio is at or below 80; target 99% of the time over 30 days.</p>'));
  assert.ok(html.includes('<div class="build-editor-errors" id="build-editor-errors" tabindex="-1" aria-labelledby="build-editor-errors-title"><p class="build-editor-errors-title" id="build-editor-errors-title">One value needs attention</p><ul class="build-editor-errors-list"><li><a href="#build-editor-threshold" data-editor-jump="threshold">Bound: A ratio bound is between 0 and 1 — for 80%, enter 0.8</a></li></ul></div>'));
  assert.ok(html.indexOf('id="build-editor-errors"') < html.indexOf('build-editor-group'), 'the summary is at the top of the body');
  assert.ok(html.includes('<span class="build-edit-error" id="build-editor-threshold-error" role="alert">A ratio bound is between 0 and 1 — for 80%, enter 0.8</span>') && html.includes('data-override-field="threshold" data-sli="kafka_produce_latency_p99" aria-invalid="true" value="80"'), 'beside its field, the value kept as entered');
  assert.ok(html.includes('<details class="build-editor-advanced" data-editor-fold="promql"><summary>Advanced: PromQL as it runs</summary>'), 'the PromQL folded');
  assert.ok(html.includes('<details class="build-editor-advanced" data-editor-fold="outputs"><summary>Advanced: generated rule details</summary>') && html.includes('<dt>SLO</dt><dd><code>kafka_produce_latency_p99_99</code></dd>'));
  assert.ok(html.includes('<button type="button" class="build-edit-more-btn" data-more="build-editor-threshold" aria-expanded="false" aria-controls="build-editor-threshold-more" data-focus-key="ov:kafka_produce_latency_p99:threshold:more" title="About Bound" aria-label="About Bound"><span aria-hidden="true">?</span></button>'));
  assert.ok(html.includes('<p class="build-edit-more" id="build-editor-threshold-more" hidden>the bound in the SLI’s unit;'));
  assert.ok(html.includes('<span class="build-edit-hint" id="build-editor-objective-hint">How often it must be good, e.g. 99.9</span>'), 'short help under the field');
  // No problem: the summary is drawn hidden (the live check fills it as the user types).
  assert.ok(renderHtml(dialogOf(draftWith({ editor: { key: 'availability', custom: false } }))).includes('<div class="build-editor-errors" id="build-editor-errors" tabindex="-1" aria-labelledby="build-editor-errors-title" hidden>'));
  // An error on the PromQL opens its fold (and keeps it open across a redraw); create mode has it open — the PromQL is required there.
  assert.ok(renderHtml(buildEditorModel({ build: { ...b, error: ['override kafka_produce_latency_p99.query: does not parse'] }, library: LIBRARY })).includes('data-editor-fold="promql" open data-fold-required>'));
  const cr = renderHtml(dialogOf(draftWith({ editor: { create: true } })));
  assert.ok(cr.includes('data-editor-fold="promql" open data-fold-required><summary>Advanced: PromQL</summary>') && !cr.includes('data-editor-fold="outputs"'));
});

test('the handlers: the live check repaints the field, the linked summary and the sentence as typed; Save SLI moves the focus to the summary while a problem stands and closes once none does; a ? opens its explanation; a summary link opens the fold and focuses the field; a redraw keeps the folds and the explanations open', () => {
  const b = draftWith({ entries: ['kafka', 'http-service'], editor: { key: 'kafka_produce_latency_p99', custom: false } });
  const model = dialogOf(b);
  assert.deepEqual(model.errorList, []);
  const calls = [];
  const act = { closeEditor: () => calls.push(['close']), setOverride: (k, f, v) => { calls.push(['override', k, f, v]); return true; }, clearOverride: () => {} };
  const attrs = {}, cls = new Set();
  const msg = { className: 'build-edit-hint', id: 'build-editor-threshold-hint', textContent: '', setAttribute() {}, removeAttribute() {} };
  let focused = null;
  const thr = { ...fakeEl({ overrideField: 'threshold', sli: 'kafka_produce_latency_p99' }), id: 'build-editor-threshold', value: '0.1', tagName: 'INPUT', focus() { focused = 'threshold'; }, setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; } };
  const unit = { ...fakeEl({ overrideField: 'unit', sli: 'kafka_produce_latency_p99' }), value: 'seconds', tagName: 'INPUT' };
  const fold = { open: false };
  const thrBox = { classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) }, closest: () => fold, querySelector: (sel) => (sel === '.build-edit-input' ? thr : sel === '.build-edit-default' ? { id: 'build-editor-threshold-default' } : sel === '.build-edit-error, .build-edit-hint' ? msg : null) };
  const errBox = { ...fakeEl({}), innerHTML: '', hidden: true, focused: 0, focus() { this.focused++; } };
  const sentence = { textContent: model.summary };
  const status = { textContent: '', className: '' };
  const save = fakeEl({});
  const moreAttrs = { 'aria-expanded': 'false' };
  const more = { ...fakeEl({ more: 'build-editor-threshold' }), getAttribute: (k) => moreAttrs[k], setAttribute: (k, v) => { moreAttrs[k] = v; } };
  const moreText = { hidden: true };
  const container = fakeContainer({
    '.build-editor': [fakeEl({})], '.build-editor .build-edit-input': [thr, unit], '#build-editor-status': [status],
    '.build-editor [data-field="threshold"]': [thrBox], '.build-editor [data-field="threshold"] .build-edit-input': [thr], '.build-editor [data-field="unit"] .build-edit-input': [unit],
    '#build-editor-errors': [errBox], '#build-editor-summary': [sentence], '.build-editor [data-editor-save]': [save],
    '.build-editor [data-more]': [more], '#build-editor-threshold-more': [moreText],
  });
  wireBuildEditor(container, model, { build: act });
  // The unit becomes a ratio, then 80 is typed for the bound: committed live (the value kept), the problem said at once.
  unit.value = 'ratio'; unit.fire('input');
  thr.value = '80'; thr.fire('input');
  assert.deepEqual(calls, [['override', 'kafka_produce_latency_p99', 'unit', 'ratio'], ['override', 'kafka_produce_latency_p99', 'threshold', '80']]);
  assert.deepEqual([msg.className, msg.textContent, attrs['aria-invalid'], cls.has('is-error')], ['build-edit-error', 'A ratio bound is between 0 and 1 — for 80%, enter 0.8', 'true', true]);
  assert.ok(!errBox.hidden && errBox.innerHTML.includes('<a href="#build-editor-threshold" data-editor-jump="threshold">Bound: A ratio bound is between 0 and 1 — for 80%, enter 0.8</a>'));
  assert.equal(sentence.textContent, 'Kafka produce latency p99 is healthy when its ratio is at or below 80; target 99% of the time over 30 days.');
  // Save SLI with the problem standing: not closed, the focus on the summary, the status says why.
  calls.length = 0;
  save.fire('click');
  assert.deepEqual([calls, errBox.focused, status.textContent, status.className], [[], 1, 'not closed — one value needs attention, listed at the top', 'build-editor-status is-error']);
  // A summary link: the fold the field sits in opens, the field takes the focus.
  errBox.fire('click', { target: { closest: () => ({ dataset: { editorJump: 'threshold' } }) } });
  assert.deepEqual([fold.open, focused], [true, 'threshold']);
  assert.equal(jumpToField(fakeContainer({}), 'nope'), false);
  // Fixed: the message goes back to the help line, the summary hides, Save SLI closes.
  thr.value = '0.8'; thr.fire('input');
  assert.deepEqual([msg.className, msg.textContent, 'aria-invalid' in attrs, errBox.hidden], ['build-edit-hint', 'The limit in the unit, e.g. 0.8', false, true]);
  assert.equal(liveCheck(container, model).length, 0);
  save.fire('click');
  assert.deepEqual(calls.at(-1), ['close']);
  // The '?' opens (and closes) the field's longer explanation.
  more.fire('click');
  assert.deepEqual([moreAttrs['aria-expanded'], moreText.hidden], ['true', false]);
  more.fire('click');
  assert.deepEqual([moreAttrs['aria-expanded'], moreText.hidden], ['false', true]);
  // Read-only: no live check.
  assert.equal(liveCheck(container, dialogOf(b, 'readonly')), null);
  // A redraw of the same editor keeps the folds and the '?' explanations the user opened.
  const oldFold = { dataset: { editorFold: 'promql' }, open: true, hasAttribute: () => false };
  const newFold = { dataset: { editorFold: 'promql' }, open: false, hasAttribute: () => false };
  const newMore = { dataset: { more: 'build-editor-objective' }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const newMoreText = { hidden: true };
  const body = {
    swapped: false, html: '', set innerHTML(v) { this.html = v; this.swapped = true; }, get innerHTML() { return this.html; },
    querySelectorAll(sel) { if (sel === 'details[data-editor-fold]') return [this.swapped ? newFold : oldFold]; if (sel === '[data-more][aria-expanded="true"]') return this.swapped ? [] : [{ dataset: { more: 'build-editor-objective' } }]; return []; },
    querySelector(sel) { return sel === '[data-more="build-editor-objective"]' ? newMore : sel === '#build-editor-objective-more' ? newMoreText : null; },
  };
  const parts = { '.build-editor-head': { innerHTML: '' }, '.build-editor-body': body, '.build-editor-actions': { innerHTML: '' }, '#build-editor-status': { textContent: '', className: '' } };
  const mounted = { className: '', dataset: { editorKey: 'kafka_produce_latency_p99', editorMode: 'edit' }, addEventListener() {}, querySelector: (sel) => parts[sel] || null };
  globalThis.document = { activeElement: {}, body: {} };
  try {
    renderBuildEditor({ innerHTML: '', contains: () => false, querySelectorAll: () => [], querySelector: (sel) => (sel === '.build-editor' ? mounted : null) }, model, { build: {} });
  } finally { delete globalThis.document; }
  assert.ok(body.swapped && body.html.includes('build-editor-group'), 'the body was redrawn');
  assert.deepEqual([newFold.open, newMore.attrs['aria-expanded'], newMoreText.hidden], [true, 'true', false]);
});
