#!/usr/bin/env node
/**
 * tools/test-update-model.mjs — the UPDATE journey's studio models and renderers (docs/UPDATE_JOURNEY.md;
 * studio/update-model.mjs, studio/update-view.mjs), under node:test with stub containers.
 *
 * The Open decision over every kind of reopen answer (exact → open with the notice; Build would write values
 * differently → the panel with "Open with Build's values"; things Build did not write → read in as additions or
 * the pack is left as it is; a scan, a live draft, an example → what they are and no action; a newer version →
 * open it; unsaved work in Build → continue or discard; a rank that cannot write), the draft a reopen opens Build
 * with and the snapshot it compares against, "Changes since v0.1.0" (one row per thing the user did, each row's
 * undo restoring exactly what it changed), Verify's review (the numbers, the rows the changes explain, "Also
 * changes", what may still be live, Save as the primary only when the hand-off would be), the add forms (prefill,
 * the errors as typed, the addition they yield), the catalogue helpers (which packs update, the picker's version
 * rows) and the hand-off sentence. Then buildVerifyModel in update mode and the renderers' HTML.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextVersionOf, additionLabel, sloIdFor, defaultBurnWindows, draftFromReopen, openedSnapshot, openDecision, draftIsBusy, changesSince,
  reviewModel, handoffSentence, addDraft, addFormModel, toAddition, updatablePacks, pickerRows, openContext,
} from '../studio/update-model.mjs';
import { openPanelHtml, definitionExtrasHtml, addEditorHtml, reviewHtml, homeUpdateListHtml } from '../studio/update-view.mjs';
import { buildVerifyModel, instantiateBody, restoreBuildDraft } from '../studio/build-model.mjs';
import { defaultBuildState, BUILD_PERSIST_FIELDS } from '../studio/state.mjs';

const REOPEN = {
  ok: true, id: 'uploaded-checkout-aaaa0000', name: 'checkout', version: '0.1.0', label: 'checkout', source: 'library:http-service@tier-2', environment: 'prod',
  origin: 'build', originSentence: null, head: null, earlier: [], exact: true,
  inputs: { entries: [{ id: 'http-service', version: '1.0.0' }], name: 'checkout', owners: ['team-a'], environment: 'prod', tier: 'tier-2', toggles: { slos: true, policy: true, routes: true, dashboards: true, validation: true, slis: ['availability', 'latency_p99'] }, params: { oncall_channel: '#checkout-oncall' }, overrides: { availability: { objective: 0.999 } } },
  notes: [], additions: [], refused: [], differences: [], foreign: [], missing: [], errors: [], adoptable: { additions: [], leftover: [] },
  canonical: { metadata: { name: 'checkout', version: '0.1.0' }, spec: {} },
};
const SLO_ADD = { kind: 'slo', slo: { id: 'availability_99_95', sli: 'availability', objective: 0.9995, window: '30d' }, burn_rate: { windows: defaultBurnWindows('ratio', 'tier-2') } };
const ROUTE_ADD = { kind: 'route', route: { severity: 'SEV2', channels: [{ webhook: 'https://hooks.example/x' }] } };
const RESULT = {
  canonical: { metadata: { name: 'checkout', version: '0.1.0' }, spec: { slis: [{ id: 'availability', type: 'ratio' }, { id: 'latency_p99', type: 'threshold' }], slos: [{ id: 'availability_99_9', sli: 'availability' }], alerting: { rules: [{ name: 'Taken', expr: 'x' }] } } },
  summary: { conformant: true, tier: 'tier-2' },
  review: {
    base: { id: REOPEN.id, version: '0.1.0', name: 'checkout' },
    onlyInSaved: [{ key: 'slo:availability_99_9', label: 'SLO availability_99_9' }, { key: 'burn_rate:availability_99_9', label: 'burn-rate alert on availability_99_9' }],
    onlyInNext: [{ key: 'slo:availability_99_95', label: 'SLO availability_99_95' }, { key: 'burn_rate:availability_99_95', label: 'burn-rate alert on availability_99_95' }, { key: 'route:SEV2#2', label: 'route SEV2 → webhook https://hooks.example/x' }],
    changed: [{ key: 'dashboard:checkout-slo-burn', label: 'dashboard checkout-slo-burn', fields: [{ field: 'panels', a: 'x', b: 'y' }] }, { key: 'section:pipelines', label: 'the pipelines section', fields: [{ field: 'exporters', a: 1, b: 2 }] }],
    same: 30,
  },
};

const opened = () => ({ ...defaultBuildState(), ...draftFromReopen(REOPEN, { from: 'pack' }) });

test('the engine rules restated: the next version, an addition\'s label, the SLO id, the default windows', () => {
  assert.equal(nextVersionOf('0.1.0'), '0.2.0');
  assert.equal(nextVersionOf('2.7.9-rc1'), '2.8.0');
  assert.equal(nextVersionOf(''), '0.2.0');
  assert.equal(additionLabel(SLO_ADD), 'SLO availability_99_95 99.95% on availability, with its burn-rate alert');
  assert.equal(additionLabel({ kind: 'slo', slo: { sli: 'availability', objective: 0.9995 } }), 'SLO availability_99_95 99.95% on availability, with its burn-rate alert');
  assert.equal(additionLabel(ROUTE_ADD), 'route SEV2 → webhook https://hooks.example/x');
  assert.equal(additionLabel({ kind: 'alert_rule', rule: { name: 'Q', severity: 'SEV3' } }), 'alert rule Q (SEV3)');
  assert.equal(sloIdFor('availability', 0.9995), 'availability_99_95');
  assert.deepEqual(defaultBurnWindows('threshold', 'tier-3').map(w => w.severity), ['SEV3', 'SEV3']);
});

test('draftFromReopen: Build opened on the pack\'s own definition, seeded, on Compile, with the pack it updates and the snapshot it compares against', () => {
  const d = draftFromReopen(REOPEN, { additions: [SLO_ADD], from: 'home' });
  assert.equal(d.name, 'checkout');
  assert.equal(d.owners, 'team-a');
  assert.equal(d.tier, 'tier-2');
  assert.deepEqual(d.entries, ['http-service']);
  assert.deepEqual(d.slis, ['availability', 'latency_p99']);
  assert.deepEqual(d.toggles, { slos: true, policy: true, routes: true, dashboards: true, validation: true });
  assert.deepEqual(d.overrides, { availability: { objective: 0.999 } });
  assert.deepEqual(d.params, { oncall_channel: '#checkout-oncall' });
  assert.deepEqual(d.additions, [SLO_ADD]);
  assert.equal(d.seeded, true);
  assert.equal(d.step, 'compile');
  assert.equal(d.registeredId, null);
  assert.deepEqual(d.update, { id: REOPEN.id, name: 'checkout', version: '0.1.0', label: 'checkout', environment: 'prod', from: 'home' });
  assert.deepEqual(d.opened, openedSnapshot(d));
  assert.deepEqual(d.opened.additions, [SLO_ADD]);
  // The draft survives a reload through the persisted fields: the additions, the pack updated and the snapshot included.
  const saved = Object.fromEntries(BUILD_PERSIST_FIELDS.map(k => [k, d[k]]));
  const restored = restoreBuildDraft(saved, defaultBuildState(), BUILD_PERSIST_FIELDS);
  assert.deepEqual(restored.additions, [SLO_ADD]);
  assert.deepEqual(restored.update, d.update);
  assert.deepEqual(restored.opened, d.opened);
  assert.deepEqual(restoreBuildDraft({ additions: [{ nope: 1 }, 'x', SLO_ADD], update: { name: 'no id' }, opened: 'x' }, defaultBuildState(), BUILD_PERSIST_FIELDS).additions, [SLO_ADD]);
  assert.equal(restoreBuildDraft({ update: { name: 'no id' } }, defaultBuildState(), BUILD_PERSIST_FIELDS).update, null);
  // The instantiate body carries the additions and the base the server compares with.
  const body = instantiateBody({ ...defaultBuildState(), ...d });
  assert.deepEqual(body.additions, [SLO_ADD]);
  assert.equal(body.base, REOPEN.id);
  assert.equal('additions' in instantiateBody(defaultBuildState()), false);
  assert.equal('base' in instantiateBody(defaultBuildState()), false);
});

test('openDecision: exact → open, with the notice; adoptable hand-added artefacts are read in and said', () => {
  const d = openDecision({ reopen: REOPEN, draft: defaultBuildState() });
  assert.equal(d.kind, 'open');
  assert.equal(d.notice, 'Opened checkout v0.1.0. Build rebuilt it from its own definition and got the same pack.');
  assert.deepEqual(d.context, openContext(REOPEN));
  assert.deepEqual(d.context.map(c => c.value), ['checkout', 'prod', 'v0.1.0', 'made in Build']);
  const withForeign = openDecision({ reopen: { ...REOPEN, exact: false, foreign: [{ key: 'route:SEV4' }], adoptable: { additions: [{ kind: 'route', route: { severity: 'SEV4', channels: [{ email: 'a@b.c' }] } }], leftover: [] } } });
  assert.equal(withForeign.kind, 'open');
  assert.match(withForeign.notice, /1 thing added by hand was read in as additions: route SEV4 → email a@b\.c\./);
});

test('openDecision: every panel — differs, foreign, origin, superseded, busy, error, unavailable', () => {
  const differs = openDecision({ reopen: { ...REOPEN, exact: false, differences: [{ key: 'slo:availability_99_5', fields: [{ field: 'window', a: '90d', b: '30d' }] }], missing: [{ key: 'dashboard:checkout-slo-burn' }], notes: [{ field: 'x', note: 'assumed y' }] } });
  assert.equal(differs.kind, 'differs');
  assert.equal(differs.sentence, 'Build would write 2 values differently today.');
  assert.deepEqual(differs.items, ['slo availability_99_5: window 90d → 30d', 'dashboard checkout-slo-burn: in Build’s output, not in the pack']);
  assert.deepEqual(differs.notes, ['assumed y']);
  assert.deepEqual(differs.actions.map(a => a.id), ['open-with-build-values', 'leave']);
  assert.equal(differs.actions[0].primary, true);
  const foreign = openDecision({ reopen: { ...REOPEN, exact: false, adoptable: { additions: [ROUTE_ADD], leftover: [{ key: 'dashboard:extra', reason: 'a dashboard Build did not write cannot be opened here yet (by file until slice 3)' }] } } });
  assert.equal(foreign.kind, 'foreign');
  assert.equal(foreign.sentence, 'This pack holds 1 thing Build did not write.');
  assert.deepEqual(foreign.items, ['dashboard extra — a dashboard Build did not write cannot be opened here yet (by file until slice 3)']);
  assert.match(foreign.can[0], /1 other could be read in as additions: route SEV2/);
  assert.deepEqual(foreign.actions.map(a => a.id), ['leave']);
  for (const [origin, re] of [['scan', /reading of the repository/], ['live', /live system reported/], ['hand', /no definition to reopen/], ['example', /read-only/]]) {
    const sentence = { scan: 'This is a reading of the repository. The next scan replaces it.', live: 'This is what the live system reported.', hand: 'Build did not make this pack, so it has no definition to reopen.', example: 'It ships with the studio and is read-only.' }[origin];
    const d = openDecision({ reopen: { ...REOPEN, origin, originSentence: sentence, inputs: null } });
    assert.equal(d.kind, 'origin');
    assert.match(d.sentence, re);
    assert.deepEqual(d.actions.map(a => a.id), ['leave']);
  }
  const superseded = openDecision({ reopen: { ...REOPEN, head: { id: 'uploaded-checkout-bbbb0000', version: '0.2.0' } } });
  assert.equal(superseded.kind, 'superseded');
  assert.equal(superseded.sentence, 'checkout was saved as v0.2.0 since v0.1.0 — the newer version is the one to update.');
  assert.deepEqual(superseded.actions.map(a => [a.id, a.label]), [['open-head', 'Open checkout v0.2.0'], ['leave', 'Leave it']]);
  const busyNew = openDecision({ reopen: REOPEN, draft: { ...defaultBuildState(), name: 'orders', entries: ['kafka'], seeded: true } });
  assert.equal(busyNew.kind, 'busy');
  assert.equal(busyNew.sentence, 'You are building orders (not saved).');
  assert.deepEqual(busyNew.actions.map(a => a.id), ['continue', 'discard']);
  const other = { ...opened(), update: { ...opened().update, id: 'uploaded-orders-cccc0000', name: 'orders' }, tier: 'tier-1' };
  const busyUpdate = openDecision({ reopen: REOPEN, draft: other });
  assert.equal(busyUpdate.sentence, 'You are updating orders (1 change, not saved).');
  assert.deepEqual(busyUpdate.items, ['Tier tier-2 → tier-1']);
  // The same pack already open resumes; a saved draft has nothing to lose.
  assert.equal(draftIsBusy(opened(), REOPEN.id), false);
  assert.equal(draftIsBusy({ ...other, registeredId: 'x' }, REOPEN.id), false);
  assert.equal(draftIsBusy(other, REOPEN.id), true);
  assert.equal(openDecision({ reopen: { ...REOPEN, errors: ['the library has no entry nope'] } }).kind, 'error');
  assert.equal(openDecision({ reopen: { ok: false, errors: ['no pack x'] } }).sentence, 'no pack x');
  const un = openDecision({ reopen: REOPEN, access: { canWrite: false, reason: 'needs the operator role in acme' } });
  assert.equal(un.kind, 'unavailable');
  assert.equal(un.sentence, 'Updating a pack needs the operator role in acme.');
});

test('changesSince: one row per thing the user did, in their terms; each undo restores exactly what the row changed', () => {
  const b = opened();
  assert.deepEqual(changesSince(b), { rows: [], count: 0 });
  assert.deepEqual(changesSince({ ...b, opened: null }), { rows: [], count: 0 });
  const edited = {
    ...b, tier: 'tier-1', entries: ['http-service', 'kafka'], slis: ['availability'], toggles: { ...b.toggles, dashboards: false },
    params: { oncall_channel: '#checkout-oncall', team_channel: '#team' },
    overrides: { availability: { objective: 0.9995, description: 'tighter' }, latency_p99: { threshold: 0.3 } },
    custom: [{ id: 'rate', type: 'ratio' }], additions: [SLO_ADD, ROUTE_ADD], owners: 'team-a, team-b',
  };
  const c = changesSince(edited);
  assert.deepEqual(c.rows.map(r => r.text), [
    'Tier tier-2 → tier-1',
    'Added kafka',
    'Removed SLI latency_p99',
    'Section dashboards switched off',
    'Filled team_channel → #team',
    'availability: objective 99.9% → 99.95%',
    'availability: description library’s → tighter',
    'latency_p99: threshold library’s → 0.3',
    'Added custom SLI rate',
    'Added SLO availability_99_95 99.95% on availability, with its burn-rate alert',
    'Added route SEV2 → webhook https://hooks.example/x',
    'Owners team-a → team-a, team-b',
  ]);
  assert.equal(c.count, 12);
  // Undo one at a time, the list recomputed after each (as the screen does): twelve undos land back on the opened definition.
  let cur = edited;
  let steps = 0;
  while (changesSince(cur).count && steps < 20) { cur = { ...cur, ...changesSince(cur).rows[0].restore }; steps++; }
  assert.equal(steps, 12);
  assert.deepEqual(openedSnapshot(cur), b.opened);
  // A single undo touches only its row: the objective back, the description kept.
  const one = { ...edited, ...c.rows.find(r => r.key === 'override:availability.objective').restore };
  assert.deepEqual(one.overrides, { availability: { objective: 0.999, description: 'tighter' }, latency_p99: { threshold: 0.3 } });
  const undoAdd = { ...edited, ...c.rows.find(r => r.key === 'addition:0').restore };
  assert.deepEqual(undoAdd.additions, [ROUTE_ADD]);
  // A removed addition reads as a removal and its undo puts it back.
  const removed = { ...b, additions: [], opened: { ...b.opened, additions: [ROUTE_ADD] } };
  assert.deepEqual(changesSince(removed).rows.map(r => r.text), ['Removed route SEV2 → webhook https://hooks.example/x']);
  assert.deepEqual({ ...removed, ...changesSince(removed).rows[0].restore }.additions, [ROUTE_ADD]);
  // A cleared value and a changed one.
  assert.deepEqual(changesSince({ ...b, params: {} }).rows.map(r => r.text), ['Cleared oncall_channel (was #checkout-oncall)']);
  assert.deepEqual(changesSince({ ...b, params: { oncall_channel: '#x' } }).rows.map(r => r.text), ['Changed oncall_channel #checkout-oncall → #x']);
  assert.deepEqual(changesSince({ ...b, overrides: {} }).rows.map(r => r.text), ['availability: objective 99.9% → library’s']);
});

test('reviewModel: the numbers, the rows the changes explain, "Also changes", what may still be live, the sentence, the actions', () => {
  const b = { ...opened(), additions: [SLO_ADD, ROUTE_ADD], overrides: {} };   // the objective override dropped: the generated SLO changes id
  const rv = reviewModel({ build: b, result: RESULT });
  assert.deepEqual(rv.base, { id: REOPEN.id, version: '0.1.0', name: 'checkout', count: 34 });
  assert.deepEqual(rv.next, { version: '0.2.0', count: 35 });
  assert.deepEqual(rv.numbers, { onlySaved: 2, changed: 2, onlyNext: 3, both: 32 });
  assert.equal(rv.sentence, '7 changes: 3 artefacts added, 2 changed, 2 removed. The pack still meets tier-2.');
  assert.deepEqual(rv.rows.map(r => [r.kind, r.key, r.why]), [
    ['added', 'slo:availability_99_95', 'Added SLO availability_99_95 99.95% on availability, with its burn-rate alert'],
    ['added', 'burn_rate:availability_99_95', 'Added SLO availability_99_95 99.95% on availability, with its burn-rate alert'],
    ['added', 'route:SEV2#2', 'Added route SEV2 → webhook https://hooks.example/x'],
    ['removed', 'slo:availability_99_9', 'availability: objective 99.9% → library’s'],
    ['removed', 'burn_rate:availability_99_9', 'availability: objective 99.9% → library’s'],
  ]);
  assert.deepEqual(rv.also.map(r => r.key), ['dashboard:checkout-slo-burn', 'section:pipelines']);
  assert.deepEqual(rv.gone.map(r => r.key), ['slo:availability_99_9', 'burn_rate:availability_99_9']);
  assert.deepEqual(rv.primary, { id: 'build-save-update', label: 'Save as checkout v0.2.0', action: 'save-update' });
  assert.equal(rv.secondary[0].action, 'open-discover');
  assert.match(rv.live.text, /Not checked here/);
  assert.equal(rv.unchanged, false);
  // Not an update: no review. An update whose answer carries no review yet: the line says so. A viewer: no Save.
  assert.equal(reviewModel({ build: defaultBuildState(), result: RESULT }), null);
  assert.match(reviewModel({ build: b, result: { ...RESULT, review: null } }).error, /not compared yet/);
  assert.equal(reviewModel({ build: b, result: RESULT, access: { canWrite: false } }).primary, null);
  // No change: Save waits.
  const same = reviewModel({ build: opened(), result: { ...RESULT, review: { ...RESULT.review, onlyInSaved: [], onlyInNext: [], changed: [], same: 34 } } });
  assert.equal(same.unchanged, true);
  assert.equal(same.primary, null);
  assert.equal(same.sentence, 'No change against the saved version yet.');
  // A refused Save travels on the model.
  const refused = reviewModel({ build: { ...b, saveError: { errors: ['moved'], newer: { id: 'n', version: '0.2.0' } } }, result: RESULT });
  assert.deepEqual(refused.saveError, { errors: ['moved'], newer: { id: 'n', version: '0.2.0' } });
  assert.equal(handoffSentence({ name: 'checkout', version: '0.2.0', previousVersion: '0.1.0', changes: 3 }), 'Saved checkout v0.2.0 — 3 changes. v0.1.0 is kept under it. No deploy of the new version is recorded here. Export it for the repository: routes, pipelines and backend values leave by export; rules and dashboards also by deploy.');
});

test('buildVerifyModel in update mode: Save as the primary where the hand-off would be, Save as a new pack beside it; the context names the versions', () => {
  const b = { ...opened(), additions: [SLO_ADD], result: { ...RESULT, provenance: { environment: 'prod', tier: 'tier-2', entries: [{ id: 'http-service' }] }, todos: [], warnings: [], schemaErrors: [], adapted: { layers: {} }, canonical: { ...RESULT.canonical, spec: { ...RESULT.canonical.spec, slis: RESULT.canonical.spec.slis } } } };
  const m = buildVerifyModel({ build: b, library: { entries: [] }, clauses: [], targets: [] });
  assert.ok(m.review);
  assert.equal(m.update.id, REOPEN.id);
  assert.ok(m.context.some(c => c.key === 'Updating' && c.value === 'v0.1.0 → saves as v0.2.0'));
  assert.equal(m.continueLabel, 'Save as a new pack');
  assert.match(m.readyText, /Save registers checkout v0\.2\.0 as the next version of v0\.1\.0/);
  // Whatever the gate, Save as a new pack is offered and the hand-off's own exit never is; Save as the next version is at least a secondary.
  const actions = [m.next.primary?.action, ...m.next.secondary.map(s => s.action)].filter(Boolean);
  assert.ok(actions.includes('save-update') && actions.includes('open-discover'), JSON.stringify(m.next));
  assert.equal(m.next.secondary.filter(s => s.action === 'open-discover').length, 1);
  const plain = buildVerifyModel({ build: { ...defaultBuildState(), result: b.result }, library: { entries: [] }, clauses: [], targets: [] });
  assert.equal(plain.review, null);
  assert.ok(!plain.context.some(c => c.key === 'Updating'));
});

test('the add forms: prefilled from the pack, the errors as typed, the addition they yield', () => {
  const ctx = { build: { tier: 'tier-2' }, result: RESULT };
  const slo = addDraft('slo', ctx);
  assert.deepEqual(slo, { kind: 'slo', sli: 'availability', objective: '99.95', window: '30d', windows: defaultBurnWindows('ratio', 'tier-2') });
  const m = addFormModel(slo, ctx);
  assert.equal(m.ok, true);
  assert.equal(m.id, 'availability_99_95');
  assert.deepEqual(toAddition(slo, ctx), { kind: 'slo', slo: { id: 'availability_99_95', sli: 'availability', objective: 0.9995, window: '30d' }, burn_rate: { windows: defaultBurnWindows('ratio', 'tier-2') } });
  const taken = addFormModel({ ...slo, objective: '99.9' }, ctx);
  assert.equal(taken.errors.objective, 'the pack already has the SLO availability_99_9');
  assert.equal(toAddition({ ...slo, objective: '99.9' }, ctx), null);
  assert.equal(addFormModel({ ...slo, objective: '100' }, ctx).errors.objective, 'a percentage between 0 and 100 (99.95)');
  assert.equal(addFormModel({ ...slo, sli: 'nope' }, ctx).errors.sli, 'pick an SLI of the pack');
  assert.equal(addFormModel({ ...slo, windows: [slo.windows[0]] }, ctx).errors.windows, 'two windows at least');
  assert.equal(addFormModel({ ...slo, windows: [{ ...slo.windows[0], short: 'five' }, slo.windows[1]] }, ctx).errors['windows.0.short'], 'a duration (5m)');
  const route = addDraft('route', ctx);
  assert.deepEqual(route, { kind: 'route', severity: 'SEV2', channels: [{ kind: 'webhook', address: '' }] });
  assert.equal(addFormModel(route, ctx).errors['channels.0.address'], 'an address');
  assert.equal(addFormModel({ ...route, channels: [{ kind: 'webhook', address: 'nope' }] }, ctx).errors['channels.0.address'], 'an http(s) URL');
  assert.deepEqual(toAddition({ ...route, channels: [{ kind: 'webhook', address: ' https://hooks.example/x ' }, { kind: 'msteams', address: '#x' }] }, ctx), { kind: 'route', route: { severity: 'SEV2', channels: [{ webhook: 'https://hooks.example/x' }, { msteams: '#x' }] } });
  const rule = addDraft('alert_rule', ctx);
  assert.deepEqual(rule, { kind: 'alert_rule', name: '', expr: '', severity: 'SEV3', for: '5m', engine: '' });
  assert.deepEqual(Object.keys(addFormModel(rule, ctx).errors), ['name', 'expr']);
  assert.equal(addFormModel({ ...rule, name: 'Taken', expr: 'x' }, ctx).errors.name, 'the pack already has an alert rule named Taken');
  assert.deepEqual(toAddition({ ...rule, name: 'QueueDepthHigh', expr: ' queue_depth > 1000 ', severity: '', for: '', engine: 'loki' }, ctx), { kind: 'alert_rule', rule: { name: 'QueueDepthHigh', expr: 'queue_depth > 1000', engine: 'loki' } });
  assert.equal(addFormModel({ ...rule, name: 'Q', expr: 'x', for: 'soon' }, ctx).errors.for, 'a duration (5m)');
});

test('the catalogue: which packs update (made in Build, current version, newest first) and the picker\'s version rows', () => {
  const catalog = [
    { id: 'a1', label: 'checkout', name: 'checkout', version: '0.1.0', source: 'uploaded', description: 'Uploaded pack — library:http-service@tier-2', ok: true, superseded: true, head: 'a2' },
    { id: 's1', label: 'repo (scanned)', name: 'repo', version: '0.1.0', source: 'uploaded', description: 'Uploaded pack — repo (scanned)', ok: true },
    { id: 'a2', label: 'checkout', name: 'checkout', version: '0.2.0', source: 'uploaded', description: 'Uploaded pack — library:http-service@tier-2', ok: true, previous: 'a1' },
    { id: 'b1', label: 'orders', name: 'orders', version: '0.1.0', source: 'uploaded', description: 'Uploaded pack — library:kafka@tier-1', ok: true },
    { id: 'ex', label: 'payment-service', name: 'payment-service', version: '1.0.0', ok: true },
  ];
  assert.deepEqual(updatablePacks(catalog), [
    { id: 'b1', label: 'orders', name: 'orders', version: '0.1.0', origin: 'made in Build', earlier: 0 },
    { id: 'a2', label: 'checkout', name: 'checkout', version: '0.2.0', origin: 'made in Build', earlier: 1 },
  ]);
  assert.deepEqual(pickerRows(catalog).map(p => [p.id, p.earlier]), [['s1', false], ['a2', false], ['a1', true], ['b1', false], ['ex', false]]);
  // An earlier version whose head is not in the list (filtered out by the service) stays a row of its own.
  assert.deepEqual(pickerRows([catalog[0]]).map(p => [p.id, p.earlier]), [['a1', false]]);
  assert.deepEqual(updatablePacks([]), []);
});

test('the renderers: the Open panel, the definition extras, the add editor, the review and the home list as HTML', () => {
  const panel = openPanelHtml(openDecision({ reopen: { ...REOPEN, exact: false, differences: [{ key: 'slo:availability_99_5', fields: [{ field: 'window', a: '90d', b: '30d' }] }] } }));
  assert.match(panel, /Build would write 1 value differently today\./);
  assert.match(panel, /data-ux-action="open:open-with-build-values"/);
  assert.match(panel, /Can be changed here/);
  assert.match(panel, /Cannot be changed here yet/);
  const b = { ...opened(), additions: [SLO_ADD] };
  const extras = definitionExtrasHtml({ build: b, changes: changesSince(b) });
  assert.match(extras, /data-upd-add="slo"/);
  assert.match(extras, /Changes since v0\.1\.0/);
  assert.match(extras, /Added SLO availability_99_95/);
  assert.match(extras, /data-upd-undo="addition:0"/);
  assert.ok(!definitionExtrasHtml({ build: b, changes: changesSince(b), readOnly: true }).includes('data-upd-undo'));
  assert.match(definitionExtrasHtml({ build: opened(), changes: { rows: [], count: 0 } }), /Save waits for a change/);
  assert.ok(!definitionExtrasHtml({ build: defaultBuildState(), changes: { rows: [], count: 0 } }).includes('Changes since'));
  const ctx = { build: { tier: 'tier-2' }, result: RESULT };
  const editor = addEditorHtml({ ...addFormModel(addDraft('slo', ctx), ctx), serverError: null });
  assert.match(editor, /class="build-editor upd-editor"/);
  assert.match(editor, /Add an SLO/);
  assert.match(editor, /data-upd-field="windows\.1\.severity"/);
  assert.match(editor, /Ready to add/);
  const routeEditor = addEditorHtml({ ...addFormModel(addDraft('route', ctx), ctx), serverError: null });
  assert.match(routeEditor, /1 field to complete\./);
  assert.match(routeEditor, /data-upd-submit[^>]*disabled/);
  const review = reviewHtml(reviewModel({ build: { ...b, additions: [SLO_ADD, ROUTE_ADD], overrides: {} }, result: RESULT }));
  assert.match(review, /only in saved <b>2<\/b>/);
  assert.match(review, /Also changes <span class="build-count">2<\/span>/);
  assert.match(review, /No longer in the pack, possibly still live/);
  assert.match(reviewHtml(reviewModel({ build: { ...b, saveError: { errors: ['moved'], newer: { id: 'n', version: '0.2.0' } } }, result: RESULT })), /data-ux-action="open-newer" data-id="n"/);
  assert.equal(reviewHtml(null), '');
  assert.match(homeUpdateListHtml([]), /No pack made in Build/);
  assert.match(homeUpdateListHtml(updatablePacks([{ id: 'b1', label: 'orders', name: 'orders', version: '0.1.0', source: 'uploaded', description: 'Uploaded pack — library:kafka@tier-1', ok: true }])), /data-upd-open="b1"[\s\S]*orders[\s\S]*v0\.1\.0 · made in Build/);
});
