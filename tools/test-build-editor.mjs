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
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit as emitYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_VERSION } from './lib/validator.mjs';
import { evaluateConformance } from './lib/conformance.mjs';
import { adapt, applyEnvironmentOverlay } from './lib/adapter.mjs';
import { instantiatePack, validationSummary } from './lib/library.mjs';
import { loadLibrary, findEntry } from '../server/library.mjs';
import { parsePromqlDependencies as lezer } from './lib/promql-lezer.mjs';
import { rolodexItems, buildEditorModel, editorModeFor, EDITOR_MODES, splitBuildErrors } from '../studio/build-model.mjs';
import {
  sliEditorModel, checkEditorId, existingSliIds, resolveTemplate, templateParams, fieldsForType, effectiveId, percentText, ratioOf,
  fieldValueFor, numberOrText, customDefFromDraft, OVERRIDE_FIELDS,
} from '../studio/build-copies-model.mjs';
import { buildEditorHtml, renderBuildEditor, wireBuildEditor, paintFieldMessage, paintIdState, growTextarea, PROMQL_MAX_HEIGHT } from '../studio/build-editor-view.mjs';
import { defaultBuildState } from '../studio/state.mjs';
import { installDialogFocusTrap, TRAPPED_DIALOGS } from '../studio/util.mjs';

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
  assert.deepEqual(fieldsForType('threshold'), ['id', 'description', 'objective', 'window', 'threshold', 'unit', 'semconv_metric', 'query']);
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
  assert.deepEqual([m.resetAll, m.customised, m.doneLabel, m.typeHint], [false, [], 'Done', 'fixed — a different shape is a new custom SLI (+ Custom SLI on the L1 sheet)']);
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
  assert.deepEqual([off.status, off.switch.on], [{ kind: 'off', text: 'not in the pack — switch it on below; your edits wait with it' }, false]);
  // The two-entry pack: the composed key, the entry-namespaced parameter keys behind the bare names.
  const two = draftWith({ entries: ['kafka', 'http-service'] });
  const m2 = modelOf(two, 'http_service_availability');
  assert.deepEqual([m2.key, m2.id, field(m2, 'good').value.includes('job="orders-api"'), m2.parameters.values.map(v => v.key)], ['http_service_availability', 'http_service_availability', true, ['http-service.duration_metric', 'http-service.job']]);
  assert.equal(m2.status.text, 'applied · SLO http_service_availability_99_5 · 2 burn alerts · rule orders_api:http_service_availability:ratio_5m');
});

test('a threshold SLI with a unit: Bound and Unit fields with their defaults, the query resolved; an above-tier SLI: the chip and its own profile’s objective, addable from the editor', () => {
  const b = draftWith({ entries: ['kafka', 'http-service'] });
  const m = modelOf(b, 'kafka_produce_latency_p99');
  assert.deepEqual(m.fields.map(f => f.id), ['id', 'description', 'objective', 'window', 'threshold', 'unit', 'semconv_metric', 'query']);
  assert.deepEqual([field(m, 'threshold').value, field(m, 'threshold').kind, field(m, 'threshold').default, field(m, 'unit').value, field(m, 'unit').kind], ['0.1', 'number', '0.1', 'seconds', 'unit']);
  assert.match(field(m, 'threshold').hint, /an upper bound in the SLI’s unit \(spec v1\.2 has no direction: a floor is a ratio SLI\)/);
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
  assert.deepEqual(threshold.fields.map(f => f.id), ['name', 'id', 'type', 'description', 'objective', 'window', 'threshold', 'unit', 'semconv_metric', 'query']);
  assert.equal(threshold.submit.enabled, true);
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
  assert.deepEqual(OVERRIDE_FIELDS, ['id', 'objective', 'window', 'threshold', 'query', 'good', 'total', 'description', 'unit', 'semconv_metric']);
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
  assert.deepEqual([...html.matchAll(/class="build-editor-cell is-([a-z_]+)/g)].map(m => m[1]), ['id', 'description', 'objective', 'window', 'semconv_metric', 'type', 'good', 'total']);
  assert.ok(html.includes('<label class="build-edit-label" for="build-editor-id"><span>Id</span></label>') && html.includes('data-focus-key="ov:availability:id" data-override-field="id" data-sli="availability" value="availability"'));
  assert.ok(html.includes('id="build-editor-description"') && html.includes('value="Fraction of HTTP requests not answered with a 5xx status'), 'the description is prefilled');
  assert.ok(html.includes('<div class="build-edit-field is-overridden" data-field="objective">') && html.includes('<span class="build-edit-default" id="build-editor-objective-default">library <code>99.5</code></span>'));
  assert.ok(html.includes('data-reset="objective" data-sli="availability" data-focus-key="ov:availability:objective:reset" title="back to the library default (99.5)" aria-label="Objective: back to the library default"'));
  assert.ok(html.includes('<textarea class="build-edit-input" id="build-editor-good" data-focus-key="ov:availability:good" data-override-field="good" data-sli="availability" rows="2" spellcheck="false" autocomplete="off" aria-describedby="build-editor-good-default build-editor-good-hint">sum(rate(http_server_request_duration_seconds_count{job=&quot;orders-api&quot;,http_response_status_code!~&quot;5..&quot;}[5m]))</textarea>'));
  assert.ok(!html.includes('${'), 'no unresolved parameter anywhere');
  const described = [...html.matchAll(/aria-describedby="([^"]+)"/g)].flatMap(m => m[1].split(' '));
  assert.ok(described.length >= 8 && described.every(id => html.includes(`id="${id}"`)), 'every aria-describedby id resolves');
  assert.ok(!/<label class="build-edit-label"[^>]*>(?:(?!<\/label>)[\s\S])*<button/.test(html), 'no button inside any label');
  assert.ok(html.includes('<div class="build-edit-field is-read" data-field="type">') && html.includes('<code class="build-edit-value">ratio</code>') && html.includes('fixed — a different shape is a new custom SLI (+ Custom SLI on the L1 sheet)'));
  assert.ok(html.includes('<p class="build-editor-params">parameters: duration_metric=http_server_request_duration_seconds, job=orders-api — edit them in L2</p>'));
  assert.ok(html.includes('<div class="build-editor-evidence"><span class="build-evidence build-evidence-semconv" title="semconv">semconv</span><span class="build-edit-evidence-note">the library’s evidence — its expression is what runs</span></div>'));
  assert.ok(html.includes('<div class="build-editor-status is-applied" id="build-editor-status" role="status" aria-live="polite">applied · SLO availability_99_9 · 2 burn alerts · rule orders_api:availability:ratio_5m</div>'));
  assert.ok(html.includes('<span class="build-editor-switch-text">in the pack</span><button type="button" role="switch" class="build-switch" aria-checked="true" aria-label="availability of HTTP service (OTel semconv) — remove from the pack" data-focus-key="sli:http-service:availability@editor" data-sli="availability"'));
  assert.ok(html.includes('data-editor-reset-all') && html.includes('<button type="button" class="mcp-refresh-btn build-editor-done" data-editor-done data-editor-close>Done</button>'));
  assert.ok(html.includes('<datalist id="build-window-options">'), 'the window datalist lives here');
  // The threshold shape: Bound · Unit before the metric, one wide Query cell.
  const t = renderHtml(dialogOf(draftWith({ entries: ['kafka', 'http-service'], editor: { key: 'kafka_produce_latency_p99', custom: false } })));
  assert.deepEqual([...t.matchAll(/class="build-editor-cell is-([a-z_]+)( is-wide)?/g)].map(m => m[1] + (m[2] || '')), ['id', 'description', 'objective', 'window', 'threshold', 'unit', 'semconv_metric', 'type', 'query is-wide']);
  assert.ok(t.includes('data-override-field="threshold" data-sli="kafka_produce_latency_p99" value="0.1"') && t.includes('<span>Bound</span>') && t.includes('<span>Unit</span>'));
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
  assert.ok(ro.includes('class="build-editor-status is-readonly"') && ro.includes('>as compiled · SLO availability_99_9 ') && ro.includes('data-editor-done data-editor-close>Close</button>'));
  const cr = renderHtml(dialogOf({ ...b, editor: { create: true }, customDraft: { name: 'Checkout success' } }));
  assert.ok(cr.includes('class="build-editor is-create is-custom" role="dialog" aria-modal="true"') && cr.includes('L1 · Contract · a new SLI') && cr.includes('<h2 class="build-editor-title" id="build-editor-title">checkout_success</h2>'));
  assert.ok(cr.includes('<label class="build-edit-label" for="build-custom-name"><span>Name</span></label>') && cr.includes('data-focus-key="cf:name" data-custom-draft="name" value="Checkout success"'));
  assert.ok(cr.includes('<select class="build-edit-input" id="build-custom-type" data-focus-key="cf:type" data-custom-draft="type"') && !cr.includes('data-field="type">\n        <div class="build-edit-label-row"><span class="build-edit-label">'), 'the real select, not the fixed cell');
  assert.ok(cr.includes('data-custom-draft="good" required rows="2"') && cr.includes('data-custom-draft="semconv_metric"') && !cr.includes('data-custom-draft="query"'));
  assert.ok(cr.includes('<button type="button" class="ctrl-btn build-editor-cancel" data-editor-close>Cancel</button><button type="button" class="mcp-refresh-btn build-editor-submit" data-editor-submit data-focus-key="cf:add" disabled>Add to the pack'));
  assert.ok(cr.includes('class="build-editor-status is-idle"') && !cr.includes('role="switch"') && !cr.includes('build-editor-params'));
  const ready = renderHtml(dialogOf({ ...b, editor: { create: true }, customDraft: { name: 'Checkout success', good: 'a', total: 'b' } }));
  assert.ok(ready.includes('data-editor-submit data-focus-key="cf:add">Add to the pack') && ready.includes('class="build-editor-status is-ready"'));
});

test('the handlers: every field but the id commits on input through setOverride with the field’s key and live (three quick characters, none lost, the status says applying… only when something changed); a change after the input is not a second commit; the id is pre-checked on every keystroke and committed on change — ten keystrokes send nothing, a clash stays in the field with its message, a valid one goes once, the key itself clears; ↺ and Reset all → clearOverride; the switch; Esc leaves the field then closes; the scrim and Done close', () => {
  const b = draftWith({ overrides: { availability: { objective: 0.999 } }, editor: { key: 'availability', custom: false } });
  const model = dialogOf(b);
  const calls = [];
  const act = { setOverride: (k, f, v, o) => calls.push(['override', k, f, v, o]), clearOverride: (k, f) => calls.push(['clear', k, f]), closeEditor: () => calls.push(['close']), setSli: (k, on, all) => calls.push(['sli', k, on, all]), addSli: (e, s) => calls.push(['addSli', e, s]), removeCustom: (id) => calls.push(['remove', id]), updateCustom: (id, f, v, o) => calls.push(['custom', id, f, v, o]) };
  const dialog = fakeEl({});
  const closeBtn = fakeEl({}), scrim = fakeEl({}), done = fakeEl({});
  const status = { textContent: '', className: '' };
  const objective = { ...fakeEl({ overrideField: 'objective', sli: 'availability' }), value: '99.9', tagName: 'INPUT', blurred: 0, blur() { this.blurred++; } };
  const idInput = { ...fakeEl({ overrideField: 'id', sli: 'availability' }), value: 'availability', tagName: 'INPUT', blur() {} };
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
    '.build-editor': [dialog], '[data-editor-close]': [closeBtn, scrim, done], '#build-editor-status': [status],
    '.build-editor .build-edit-input': [objective, idInput, good], '[data-reset]': [reset], '[data-editor-reset-all]': [resetAll], '.build-editor .build-switch[data-sli]': [sw],
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
  const idHint = model.fields.find(f => f.id === 'id').hint;
  let typed = '';
  for (const ch of 'error_rate') { typed += ch; idInput.value = typed; idInput.fire('input'); }
  assert.deepEqual(calls, [], 'ten keystrokes: nothing sent — no prefix becomes a rename');
  assert.deepEqual([msg.className, msg.id, msg.textContent, msgAttrs.role, cls.has('is-error'), inpAttrs['aria-invalid'], inpAttrs['aria-errormessage'], inpAttrs['aria-describedby'], status.textContent, status.className],
    ['build-edit-error', 'build-editor-id-error', 'error_rate is already an SLI of the pack or of a selected product — pick another id', 'alert', true, 'true', 'build-editor-id-error', 'build-editor-id-default build-editor-id-error', 'not applied — error_rate is already an SLI of the pack or of a selected product — pick another id', 'build-editor-status is-error']);
  idInput.fire('change');
  assert.deepEqual(calls, [], 'leaving the field with a clashing id sends nothing; the message stays');
  assert.equal(msg.className, 'build-edit-error');
  // A valid id while typing: the message clears, the status says how to apply it; the change commits it once.
  idInput.value = 'http_availability'; idInput.fire('input');
  assert.deepEqual([calls, msg.className, msg.textContent, cls.has('is-error'), 'aria-invalid' in inpAttrs, inpAttrs['aria-describedby'], status.textContent, status.className],
    [[], 'build-edit-hint', idHint, false, false, 'build-editor-id-default build-editor-id-hint', 'rename to http_availability — Enter, Tab or Esc applies it', 'build-editor-status is-pending']);
  idInput.fire('change');
  assert.deepEqual(calls, [['override', 'availability', 'id', 'http_availability', { live: true }]]);
  assert.deepEqual([status.textContent, status.className], ['applying…', 'build-editor-status is-pending']);
  idInput.fire('change');
  assert.equal(calls.length, 1, 'a second change with the same text is not a second rename');
  // Cleared: the text means the key, which this (un-renamed) model already carries — the status is the model's again;
  // the change still clears the rename typed before it (the controller removes the override).
  idInput.value = ''; idInput.fire('input');
  assert.equal(status.textContent, model.status.text);
  idInput.fire('change');
  assert.deepEqual(calls.at(-1), ['override', 'availability', 'id', '', { live: true }], 'an empty id clears the rename (the controller removes the override)');
  // The key itself typed back (' availability ', 'availability') is no rename: what goes out clears the override — never
  // `{ id: 'availability' }`, which the studio then showed as "customised: id" while the engine treated it as no rename (measured).
  calls.length = 0;
  idInput.value = ' availability '; idInput.fire('input'); idInput.fire('change');
  idInput.value = 'availability'; idInput.fire('input');
  assert.deepEqual([status.textContent, status.className], [model.status.text, `build-editor-status is-${model.status.kind}`], 'the id the pack carries: the status is the model\'s again');
  idInput.fire('change');
  assert.ok(calls.length >= 1 && calls.every(c => c[3] === ''), `typing the key back sends a clear, not the key: ${JSON.stringify(calls)}`);
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
  // ↺ on a field, Reset all, the switch.
  calls.length = 0;
  reset.fire('click'); resetAll.fire('click'); sw.fire('click');
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
  const cSw = fakeEl({ sli: 'checkout_success', entry: '', sliId: 'checkout_success', selected: '1', entrySelected: '1', custom: '1' });
  calls.length = 0;
  wireBuildEditor(fakeContainer({ '.build-editor': [fakeEl({})], '.build-editor .build-edit-input': [cGood], '.build-editor .build-switch[data-sli]': [cSw], '#build-editor-status': [status] }), dialogOf(cb), { build: act });
  cGood.value = 'sum(rate(ok[5m]))'; cGood.fire('input'); cSw.fire('click');
  assert.deepEqual(calls, [['custom', 'checkout_success', 'good', 'sum(rate(ok[5m]))', { live: true }], ['remove', 'checkout_success']]);
  const ab = draftWith({ entries: ['kafka', 'http-service'], editor: { key: 'kafka_controller_election_rate', custom: false } });
  const aSw = fakeEl({ sli: 'kafka_controller_election_rate', entry: 'kafka', sliId: 'controller_election_rate', selected: '0', entrySelected: '1' });
  calls.length = 0;
  wireBuildEditor(fakeContainer({ '.build-editor': [fakeEl({})], '.build-editor .build-switch[data-sli]': [aSw] }), dialogOf(ab), { build: act });
  aSw.fire('click');
  assert.deepEqual(calls[0].slice(0, 3), ['sli', 'kafka_controller_election_rate', true]);
  // Read-only: only close is wired.
  calls.length = 0;
  const roInput = { ...fakeEl({ overrideField: 'objective', sli: 'availability' }), value: '1', tagName: 'INPUT' };
  wireBuildEditor(fakeContainer({ '.build-editor': [fakeEl({})], '.build-editor .build-edit-input': [roInput] }), dialogOf(b, 'readonly'), { build: act });
  roInput.fire('input');
  assert.deepEqual(calls, []);
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
    '.build-editor': [dialog], '[data-editor-close]': [cancel], '.build-editor [data-custom-draft]': [name, id, type, desc, obj, win, metric, good, total],
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
  assert.match(editor, /z-index:\s*91/);
  assert.match(cssRule('.build-editor-scrim'), /position:\s*fixed;\s*inset:\s*0;\s*z-index:\s*90/);
  assert.ok(Number(/z-index:\s*(\d+)/.exec(cssRule('.build-sheet'))[1]) < 90, 'the editor sits above the sheet (z 61)');
  assert.match(editor, /--accent:\s*var\(--L1\)/);
  assert.match(editor, /max-height:\s*calc\(100dvh - 40px\)/, 'never taller than the viewport');
  assert.match(cssRule('.build-editor-body'), /overflow:\s*auto;\s*overscroll-behavior:\s*contain/, 'scrolls inside, never the page');
  assert.match(cssRule('.build-editor-grid'), /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(cssRule('.build-editor-cell.is-wide'), /grid-column:\s*1 \/ -1/);
  assert.match(editor, /animation:\s*build-editor-in 160ms ease-out/);
  const reduced = CSS_TEXT.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g)?.find(b => b.includes('.build-editor')) || '';
  assert.ok(reduced.includes('.build-editor, .build-editor-scrim { animation: none; }') || /\.build-editor-scrim \{ animation: none; \}/.test(reduced), 'the entrance respects reduced motion');
  assert.ok(reduced.includes('.build-rolo-edit') && reduced.includes('.build-editor-close'));
  const block = CSS_TEXT.slice(CSS_TEXT.indexOf('---- The editor'), CSS_TEXT.indexOf('@media (max-width: 760px)', CSS_TEXT.indexOf('---- The editor')));
  assert.deepEqual([...block.matchAll(/#[0-9a-fA-F]{3,6}\b/g)].map(m => m[0]), [], 'the tokens only — both themes follow');
  assert.ok(/\[data-theme="dark"\] \.build-editor \{/.test(block), 'the dark theme adjusts the shadow');
  assert.match(cssRule('.build-rolo-edit'), /cursor:\s*pointer/);
  assert.match(cssRule('.build-rolo-create'), /appearance:\s*none;\s*cursor:\s*pointer;\s*text-align:\s*left/);
  assert.match(CSS_TEXT.match(/@media \(max-width: 760px\) \{[\s\S]*?\n\}/g).find(b => b.includes('.build-editor')), /\.build-editor-grid \{ grid-template-columns: 1fr; \}/, 'one column on a narrow screen');
});
