#!/usr/bin/env node
/**
 * tools/test-live-snapshot.mjs
 *
 * The true-snapshot live pack (rebadge batch 3, C1). This commit's part: the
 * contract module tools/lib/live-fetch.mjs — the stage ids and their order,
 * the plan a ping's mapped inventory implies (`run`, `gap`, or `unknown` when
 * tools/list was not read whole — never a claimed gap), the scope's syntax
 * and limits, the annotations that record a scope, and the verdict and
 * reason the diff reads back. The fetch in snapshot mode and its mock-MCP
 * golden join this suite with the fetcher's snapshot mode.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_STAGES, LIVE_KINDS, STAGE_STATES, SCOPE_LIMITS, SNAPSHOT_LIMITS, SCOPE_FAMILIES,
  stagesFor, stageNoun, fetchPlan, normalizeScope, scopeIsEmpty, scopeAnnotations, scopeOf, inScope, scopeReason, folderUidOf,
} from './lib/live-fetch.mjs';
import { CAPABILITIES, capabilityInventory, probeCandidates } from './lib/contracts/mcp-capabilities.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Every candidate tool name of some capabilities: an MCP that advertises them.
const namesOf = (...ids) => ids.flatMap((id) => probeCandidates(id).map((c) => (typeof c === 'string' ? c : c.name)));

test('the stages: ids in fetch order, the draft alone reads the stack signals, every capability a registry id, frozen; stagesFor refuses an unknown kind', () => {
  assert.deepEqual(LIVE_STAGES.map((s) => s.id), ['connect', 'services', 'backends', 'metric_names', 'recording_rules', 'alert_rules', 'dashboards', 'scrape_targets', 'alerting_routes', 'signals', 'build', 'register']);
  assert.deepEqual([...LIVE_KINDS], ['snapshot', 'draft']);
  assert.deepEqual([...STAGE_STATES], ['pending', 'running', 'done', 'failed', 'skipped']);
  assert.deepEqual(stagesFor('draft').map((s) => s.id), LIVE_STAGES.map((s) => s.id));
  assert.deepEqual(stagesFor('snapshot').map((s) => s.id), LIVE_STAGES.map((s) => s.id).filter((id) => id !== 'signals'));
  for (const stage of LIVE_STAGES) {
    for (const id of stage.capabilities) assert.ok(Object.hasOwn(CAPABILITIES, id), `${stage.id}: ${id} is a capability id`);
    assert.ok(Object.isFrozen(stage) && Object.isFrozen(stage.capabilities) && Object.isFrozen(stage.kinds));
  }
  assert.ok(Object.isFrozen(LIVE_STAGES));
  assert.throws(() => stagesFor('scaffold'), /unknown live fetch kind "scaffold" \(snapshot or draft\)/);
  assert.throws(() => stagesFor(undefined), TypeError);
  assert.equal(stageNoun(LIVE_STAGES[1]), 'services');
  assert.equal(stageNoun(LIVE_STAGES[7]), 'scrape targets');
  assert.deepEqual(SCOPE_LIMITS, { prefixes: 32, prefixLength: 100, folders: 32, uidLength: 40 });
  assert.deepEqual(SNAPSHOT_LIMITS, { metricNames: 20000, packBytes: 16777216, messageChars: 300 });
});

test('fetchPlan over a complete listing: a stage runs when any candidate of any of its capabilities is advertised, else it is a gap that says which tool is missing; the stages without capabilities always run', () => {
  const { capabilities } = capabilityInventory([...namesOf('system_health', 'system_topology', 'metric_names', 'dashboards'), 'something_else']);
  const plan = fetchPlan(capabilities, { kind: 'snapshot' });
  assert.deepEqual(plan.map((p) => [p.stage, p.will]), [
    ['connect', 'run'], ['services', 'run'], ['backends', 'gap'], ['metric_names', 'run'], ['recording_rules', 'gap'], ['alert_rules', 'gap'],
    ['dashboards', 'run'], ['scrape_targets', 'gap'], ['alerting_routes', 'gap'], ['build', 'run'], ['register', 'run'],
  ]);
  assert.equal(plan.find((p) => p.stage === 'scrape_targets').reason, 'this MCP offers no scrape targets tool');
  assert.equal(plan.find((p) => p.stage === 'backends').reason, 'this MCP offers no backends and versions tool');
  assert.ok(plan.filter((p) => p.will === 'run').every((p) => p.reason === null));
  // One candidate of a multi-capability stage is enough.
  const onlyDetail = fetchPlan(capabilityInventory(namesOf('dashboard_detail')).capabilities, { kind: 'draft' });
  assert.equal(onlyDetail.find((p) => p.stage === 'dashboards').will, 'run');
  assert.equal(onlyDetail.find((p) => p.stage === 'signals').will, 'run');
  // Every capability advertised: nothing but runs.
  const all = fetchPlan(capabilityInventory(namesOf(...Object.keys(CAPABILITIES))).capabilities, { kind: 'snapshot' });
  assert.ok(all.every((p) => p.will === 'run'));
});

test('fetchPlan over an incomplete or absent listing: a missing capability is unknown with the reason, never a gap; an empty list under a capability is not an offer', () => {
  const { capabilities } = capabilityInventory(namesOf('metric_names'));
  const partial = fetchPlan(capabilities, { kind: 'snapshot', complete: false });
  assert.equal(partial.find((p) => p.stage === 'metric_names').will, 'run');
  const rules = partial.find((p) => p.stage === 'alert_rules');
  assert.deepEqual(rules, { stage: 'alert_rules', will: 'unknown', reason: 'tools/list did not list every tool (a page was left), so whether this MCP offers an alert rules tool is not known' });
  assert.ok(!partial.some((p) => p.will === 'gap'));
  const none = fetchPlan(null, { kind: 'draft' });
  assert.ok(none.filter((p) => p.will !== 'run').every((p) => p.will === 'unknown' && /^tools\/list was not read/.test(p.reason)));
  assert.deepEqual(none.filter((p) => p.will === 'run').map((p) => p.stage), ['connect', 'signals', 'build', 'register']);
  assert.equal(fetchPlan({ metric_names: [] }, { kind: 'snapshot' }).find((p) => p.stage === 'metric_names').will, 'gap');
  assert.throws(() => fetchPlan({}, {}), /unknown live fetch kind/);
});

test('normalizeScope: arrays or comma lists, trimmed and deduplicated in order; nothing is an empty scope', () => {
  assert.deepEqual(normalizeScope(undefined), { scope: { metricPrefixes: [], folderUids: [], datasourceUid: null }, errors: [] });
  assert.deepEqual(normalizeScope({}), { scope: { metricPrefixes: [], folderUids: [], datasourceUid: null }, errors: [] });
  assert.deepEqual(normalizeScope({ metricPrefixes: ['payments_', ' checkout_', 'payments_', 'ns:job:'], folderUids: 'ab12, cd-34,,', datasourceUid: ' prom_1 ' }), {
    scope: { metricPrefixes: ['payments_', 'checkout_', 'ns:job:'], folderUids: ['ab12', 'cd-34'], datasourceUid: 'prom_1' },
    errors: [],
  });
  assert.ok(scopeIsEmpty(normalizeScope(null).scope));
  assert.ok(!scopeIsEmpty({ metricPrefixes: [], folderUids: [], datasourceUid: 'x' }));
  assert.ok(scopeIsEmpty(null));
});

test('normalizeScope refuses by field and rule: a prefix starting with a digit, a uid with a space, an over-long value, too many entries, a non-string, an unknown field, a non-object — a pasted blob is quoted cut', () => {
  const { scope, errors } = normalizeScope({ metricPrefixes: ['ok_', 'x', '1bad'], folderUids: ['x y', 'a'.repeat(41)], datasourceUid: 'p q', extra: 1 });
  assert.deepEqual(errors, [
    'scope.extra is not a scope field (metricPrefixes, folderUids, datasourceUid)',
    'scope.metricPrefixes[2] "1bad" is not a metric-name prefix (letters, digits, _ and :, not starting with a digit)',
    'scope.folderUids[0] "x y" is not a folder uid (1–40 letters, digits, _ and -)',
    `scope.folderUids[1] "${'a'.repeat(41)}" is not a folder uid (1–40 letters, digits, _ and -)`,
    'scope.datasourceUid "p q" is not a datasource uid (1–40 letters, digits, _ and -)',
  ]);
  assert.deepEqual(scope, { metricPrefixes: ['ok_', 'x'], folderUids: [], datasourceUid: null }, 'only what passed is kept');
  const long = normalizeScope({ metricPrefixes: ['a'.repeat(101)] });
  assert.deepEqual(long.errors, [`scope.metricPrefixes[0] "${'a'.repeat(60)}…" is longer than 100 characters`]);
  const many = normalizeScope({ folderUids: Array.from({ length: 33 }, (_, i) => `f${i}`) });
  assert.deepEqual(many.errors, ['scope.folderUids has 33 entries; at most 32']);
  assert.equal(many.scope.folderUids.length, 32);
  assert.deepEqual(normalizeScope({ metricPrefixes: [7] }).errors, ['scope.metricPrefixes[0] is not a string']);
  assert.deepEqual(normalizeScope({ metricPrefixes: { a: 1 } }).errors, ['scope.metricPrefixes is not a list']);
  assert.deepEqual(normalizeScope({ datasourceUid: 5 }).errors, ['scope.datasourceUid is not a string']);
  assert.deepEqual(normalizeScope(['a']).errors, ['scope is not an object (metricPrefixes, folderUids, datasourceUid)']);
  assert.deepEqual(normalizeScope('payments_').errors, ['scope is not an object (metricPrefixes, folderUids, datasourceUid)']);
  assert.deepEqual(normalizeScope({ metricPrefixes: [''] }).errors, ['scope.metricPrefixes[0] "" is not a metric-name prefix (letters, digits, _ and :, not starting with a digit)']);
});

test('scopeAnnotations: the live scope always, with appliesTo; a family\'s scope only where it was applied; folder titles from the search, cut at 100; scopeOf reads them back', () => {
  const scope = { metricPrefixes: ['payments_', 'checkout_'], folderUids: ['ab12', 'zz9'], datasourceUid: null };
  const ann = scopeAnnotations(scope, { folderTitles: { ab12: 'Payments', zz9: 'T'.repeat(120) } });
  assert.deepEqual(Object.keys(ann), ['observogram.live.scope', 'observogram.scope.metric', 'observogram.scope.dashboard']);
  assert.deepEqual(JSON.parse(ann['observogram.live.scope']), {
    metricPrefixes: ['payments_', 'checkout_'], folderUids: ['ab12', 'zz9'], datasourceUid: null,
    appliesTo: { metricPrefixes: ['metric'], folderUids: ['dashboard'] },
  });
  assert.equal(ann['observogram.scope.metric'], '{"by":"prefix","values":["payments_","checkout_"]}');
  assert.deepEqual(JSON.parse(ann['observogram.scope.dashboard']), { by: 'folder', values: [{ uid: 'ab12', title: 'Payments' }, { uid: 'zz9', title: 'T'.repeat(100) }] });
  // The fetcher applied the folders to alert rules too (every rule named its folder), not to recording rules.
  const rules = scopeAnnotations(scope, { applied: ['metric', 'dashboard', 'alert_rule'] });
  assert.deepEqual(Object.keys(rules).sort(), ['observogram.live.scope', 'observogram.scope.alert_rule', 'observogram.scope.dashboard', 'observogram.scope.metric']);
  assert.deepEqual(JSON.parse(rules['observogram.live.scope']).appliesTo, { metricPrefixes: ['metric'], folderUids: ['dashboard', 'alert_rule'] });
  assert.deepEqual(JSON.parse(rules['observogram.scope.alert_rule']).values, [{ uid: 'ab12', title: null }, { uid: 'zz9', title: null }]);
  // An unscoped snapshot says so, and parks nothing.
  const none = scopeAnnotations({ metricPrefixes: [], folderUids: [], datasourceUid: null });
  assert.deepEqual(none, { 'observogram.live.scope': '{"metricPrefixes":[],"folderUids":[],"datasourceUid":null,"appliesTo":{"metricPrefixes":[],"folderUids":[]}}' });
  assert.equal(scopeOf(none).size, 0);
  // Read back.
  const back = scopeOf({ ...ann, 'observogram.unobserved.dashboard': 'x', 'mcp.url': 'https://mcp.test' });
  assert.deepEqual([...back.keys()], ['metric', 'dashboard']);
  assert.deepEqual(back.get('metric'), { by: 'prefix', values: ['payments_', 'checkout_'] });
  assert.equal(back.get('dashboard').values[0].title, 'Payments');
  assert.deepEqual(SCOPE_FAMILIES.folderUids, ['dashboard', 'alert_rule', 'recording_rule']);
});

test('scopeOf ignores what does not parse or holds no value — a family is then compared unscoped, never parked on a guess', () => {
  const back = scopeOf({
    'observogram.scope.metric': '{not json',
    'observogram.scope.dashboard': '{"by":"folder","values":[]}',
    'observogram.scope.alert_rule': '{"by":"guess","values":["x"]}',
    'observogram.scope.recording_rule': '{"by":"folder","values":["ab12",{"uid":""},null,{"uid":"cd","title":7}]}',
    'observogram.scope.': '{"by":"prefix","values":["a"]}',
    'observogram.scope.scrape_job': '{"by":"prefix"}',
  });
  assert.deepEqual([...back.entries()], [['recording_rule', { by: 'folder', values: [{ uid: 'ab12', title: null }, { uid: 'cd', title: null }] }]]);
  assert.equal(scopeOf(null).size, 0);
  assert.equal(scopeOf('x').size, 0);
});

test('inScope: a metric by any of its names against the prefixes, a folded family by its series; a folder by uid; null when the artefact does not say; no entry is inside', () => {
  const prefix = { by: 'prefix', values: ['payments_', 'checkout_'] };
  assert.equal(inScope('metric', { spec: { name: 'payments_total' } }, prefix), true);
  assert.equal(inScope('metric', { spec: { name: 'orders_total' } }, prefix), false);
  assert.equal(inScope('metric', { title: 'checkout_latency', spec: {} }, prefix), true);
  assert.equal(inScope('metric', { spec: { name: 'req' }, series: ['checkout_req_bucket'] }, prefix), true);
  assert.equal(inScope('metric', { spec: {} }, prefix), null);
  assert.equal(inScope('metric', { spec: { name: 'Payments_total' } }, prefix), false, 'metric names are case-sensitive, as the fetch filters them');
  const folder = { by: 'folder', values: [{ uid: 'ab12', title: 'Payments' }] };
  assert.equal(inScope('dashboard', { spec: { params: { folderUid: 'ab12' } } }, folder), true);
  assert.equal(inScope('dashboard', { spec: { params: { folderUid: 'cd34' } } }, folder), false);
  assert.equal(inScope('dashboard', { spec: { folder: 'payments', params: { uid: 'x', title: 'X' } } }, folder), null, 'a crawled dashboard names a folder, not a folder uid');
  assert.equal(inScope('alert_rule', { spec: { folderUid: 'ab12' } }, folder), true);
  assert.equal(inScope('dashboard', { spec: {} }, null), true);
  assert.equal(inScope('dashboard', { spec: {} }, { by: 'other', values: ['x'] }), null);
  assert.equal(folderUidOf({ spec: { folder_uid: 'f1' } }), 'f1');
  assert.equal(folderUidOf(null), null);
});

test('scopeReason states only what is known: "outside" for false, the folders read and what the holder does not say for null, nothing for true', () => {
  const prefix = { by: 'prefix', values: ['payments_', 'checkout_'] };
  const folder = { by: 'folder', values: [{ uid: 'ab12', title: 'Payments' }, { uid: 'zz9', title: null }] };
  assert.equal(scopeReason('metric', false, prefix), "outside the snapshot's metric scope (prefixes payments_, checkout_)");
  assert.equal(scopeReason('metric', null, prefix), 'the snapshot read only metrics with the prefixes payments_, checkout_; Pack A gives this metric no name, so it was not checked');
  assert.equal(scopeReason('dashboard', false, folder), "outside the snapshot's dashboard folders (Payments, zz9)");
  assert.equal(scopeReason('dashboard', null, folder), 'the snapshot read only the folders Payments, zz9; Pack A does not say which folder this dashboard is in, so it was not checked');
  assert.equal(scopeReason('alert_rule', null, folder, { holder: 'b' }), 'the snapshot read only the folders Payments, zz9; Pack B does not say which folder this alert rule is in, so it was not checked');
  assert.equal(scopeReason('recording_rule', false, folder), "outside the snapshot's recording rule folders (Payments, zz9)");
  assert.equal(scopeReason('dashboard', true, folder), null);
  assert.equal(scopeReason('dashboard', false, null), null);
});

test('the module is pure and browser-safe: no import, no process, no node: specifier', () => {
  const src = readFileSync(resolve(__dirname, 'lib', 'live-fetch.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /\bprocess\./);
  assert.doesNotMatch(src, /node:/);
});
