#!/usr/bin/env node
/**
 * tools/test-live-model.mjs — the pure models of the live MCP connection
 * (studio/live-model.mjs, rebadge batch 3): what the MCP panel draws from a
 * POST /api/mcp/ping answer (the status word per verdict, the timings, the
 * capabilities a fetch reads, the families not offered — "not among the
 * tools listed" while pages remained, never called absent —, checked and
 * notChecked passed through), and the duration sentences (from evidence,
 * else the measured range; no kind said to be faster). And the live panel
 * (C1): step 2 only after a connected ping for the target on screen (a
 * picker or auth change hides it), the kind preselected by the configured
 * scope, the scope fields both ways, the plan's sentences, the gate log
 * folded by stage in fetch order, a finished job's sentence, the pickers'
 * scaffold / snapshot suffix and Compare's chip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pingResultModel, durationText, rebuildNoteText, capabilityLabel, INVENTORY_FAMILIES, MEASURED_RANGE,
  liveTargetKey, stepTwoVisible, preselectedKind, scopeFormModel, scopeFromForm, planModel, gateLogModel, STAGE_WORDS, STAGE_ICONS,
  elapsedText, liveResultModel, LIVE_JOB_GONE_TEXT, liveKindSuffix, liveChipText,
} from '../studio/live-model.mjs';
import { stagesFor, fetchPlan } from './lib/live-fetch.mjs';
import { capabilityInventory, probeCandidates } from './lib/contracts/mcp-capabilities.mjs';

const connected = (over = {}) => ({
  ok: true, verdict: 'connected', origin: 'https://mcp.acme.test', mcpEndpoint: { id: 3, name: 'gw' },
  reachable: { initialized: true }, auth: { outcome: 'sent', sent: 'endpoint-variable' },
  tools: { count: 42, unmatched: 25, complete: true, capabilities: { system_health: ['sh'], dashboards: ['ds'], metric_names: ['mlv'], recording_rules: ['rr'], alert_rules: ['ar'] } },
  read: { capability: 'dashboards', tool: 'ds', outcome: 'ok', detail: '1 dashboard listed', backendAuthRefused: false, credentialFree: false },
  timings: { initializeMs: 110, toolsListMs: 70, readMs: 60, totalMs: 240 },
  sentence: 'Connected to https://mcp.acme.test in 240 ms: …',
  checked: ['the MCP answered initialize'], notChecked: ['the backends behind every other tool'],
  ...over,
});

test('a connected answer: the status with its time, the timings, the tool count, what a fetch reads, the families not offered', () => {
  const m = pingResultModel(connected());
  assert.equal(m.ok, true);
  assert.equal(m.tone, 'ok');
  assert.equal(m.status, 'connected · 240 ms');
  assert.equal(m.timings, 'initialize 110 ms · tools/list 70 ms · read 60 ms · total 240 ms');
  assert.equal(m.toolsLine, '42 tools listed, 17 that a fetch reads');
  assert.equal(m.readLine, 'ds: 1 dashboard listed');
  assert.deepEqual(m.reads.map((r) => [r.id, r.label, r.tools]), [
    ['system_health', 'system health', ['sh']], ['dashboards', 'dashboards', ['ds']], ['metric_names', 'metric names', ['mlv']],
    ['recording_rules', 'recording rules', ['rr']], ['alert_rules', 'alert rules', ['ar']],
  ]);
  assert.equal(m.notOffered, 'Not offered by this MCP: scrape targets, alerting routes');
  assert.deepEqual(m.checked, ['the MCP answered initialize']);
  assert.deepEqual(m.notChecked, ['the backends behind every other tool']);
  assert.equal(m.sentence, 'Connected to https://mcp.acme.test in 240 ms: …');
});

test('a listing with pages left: the families not seen are never called absent', () => {
  const m = pingResultModel(connected({ tools: { count: 500, unmatched: 498, complete: false, capabilities: { dashboards: ['ds'], metric_names: ['mlv'] } } }));
  assert.equal(m.toolsLine, '500 tools listed (more pages remained), 2 that a fetch reads');
  assert.equal(m.notOffered, 'Not among the tools listed (more pages remained, so these may still be offered): recording rules, alert rules, scrape targets, alerting routes');
});

test('every family offered: no gap line', () => {
  const caps = Object.fromEntries(INVENTORY_FAMILIES.map(([id]) => [id, ['x']]));
  assert.equal(pingResultModel(connected({ tools: { count: 6, unmatched: 0, complete: true, capabilities: caps } })).notOffered, null);
});

test('a backend that refused the MCP\'s credentials, a failed read: connected, but the tone warns and the status says so', () => {
  const m = pingResultModel(connected({ read: { capability: 'dashboards', tool: 'ds', outcome: 'failed', detail: null, backendAuthRefused: true, credentialFree: false } }));
  assert.equal(m.tone, 'warn');
  assert.equal(m.status, 'connected · 240 ms · its backend refused the MCP');
  assert.equal(pingResultModel(connected({ read: { capability: 'dashboards', tool: 'ds', outcome: 'failed', detail: null, backendAuthRefused: false, credentialFree: false } })).tone, 'warn');
});

test('each failing verdict is a word, never a colour alone; the steps that did not run have no timing', () => {
  const failing = (verdict) => pingResultModel({ ok: false, verdict, tools: null, read: null, timings: { initializeMs: 12, toolsListMs: null, readMs: null, totalMs: 13 }, sentence: 's', checked: [], notChecked: ['any tool call'] });
  assert.deepEqual(['auth-refused', 'unreachable', 'timeout', 'not-mcp'].map((v) => failing(v).status), ['refused', 'unreachable', 'timed out', 'not an MCP server']);
  const m = failing('auth-refused');
  assert.equal(m.ok, false);
  assert.equal(m.tone, 'error');
  assert.equal(m.timings, 'initialize 12 ms · total 13 ms');
  assert.equal(m.toolsLine, null);
  assert.equal(m.readLine, null);
  assert.deepEqual(m.reads, []);
  assert.equal(m.notOffered, null);
});

test('a non-answer is no model', () => {
  for (const x of [null, undefined, 'x', {}, { verdict: 3 }]) assert.equal(pingResultModel(x), null);
});

test('capability labels: a family by its name, any other id spaced', () => {
  assert.equal(capabilityLabel('scrape_configs'), 'scrape targets');
  assert.equal(capabilityLabel('grafana_version'), 'grafana version');
});

test('the duration sentences: from evidence, else the measured range — the same for every kind', () => {
  const measured = `Usually about ${MEASURED_RANGE} on a full MCP tier (measured); dashboards are read one by one.`;
  for (const kind of ['snapshot', 'draft', 'rebuild']) assert.equal(durationText(kind), measured, kind);
  assert.equal(durationText('snapshot', 72_000), "This org's last snapshot took 1 min 12 s.");
  assert.equal(durationText('draft', 45_400), "This org's last draft took 45 s.");
  assert.equal(durationText('rebuild', 120_000), "This org's last rebuild of production-live took 2 min.");
  assert.equal(durationText('draft', 0), measured, 'no evidence, no claim');
  assert.equal(rebuildNoteText(), 'Rebuilds the live pack the LIVE badge reads — every inventory family is read again (usually about 1–1.5 minutes); it writes an audit row.');
});

// ---------- the live panel (C1) ----------

test('liveKindSuffix: a draft is a scaffold, a snapshot a snapshot, anything else nothing', () => {
  assert.equal(liveKindSuffix({ live: 'scaffold' }), ' · scaffold');
  assert.equal(liveKindSuffix({ live: 'snapshot' }), ' · snapshot');
  for (const entry of [{}, { live: null }, { live: 'other' }, null, undefined]) assert.equal(liveKindSuffix(entry), '');
});

test('Compare\'s chip: the scaffold is never presented as a snapshot; a snapshot names its origin and time when it says them', () => {
  assert.equal(liveChipText('scaffold'), 'Scaffold — drafted from MCP discovery; sections marked scaffold are not compared');
  assert.equal(liveChipText('snapshot', { origin: 'https://mcp.acme.test', at: '2026-10-07T12:00:00Z' }), 'Snapshot — inventory read from https://mcp.acme.test at 2026-10-07T12:00:00Z');
  assert.equal(liveChipText('snapshot'), 'Snapshot — inventory read from a live MCP server');
  assert.equal(liveChipText(null), null);
});

test('step 2: only after a connected ping for the target on screen — a picker or an auth change hides it', () => {
  const target = { mcpEndpointId: 3 };
  const ping = { key: liveTargetKey(target), ok: true };
  assert.equal(stepTwoVisible(ping, target), true);
  assert.equal(stepTwoVisible(ping, { mcpEndpointId: 4 }), false, 'another endpoint');
  assert.equal(stepTwoVisible(ping, { mcpEndpointId: 3, mcpAuth: 'k' }), false, 'an auth key typed');
  assert.equal(stepTwoVisible({ ...ping, ok: false }, target), false, 'a ping that did not connect');
  assert.equal(stepTwoVisible(null, target), false);
  assert.equal(stepTwoVisible(ping, null), false, 'nothing to send');
  const typed = { mcpUrl: 'https://mcp.acme.test/mcp' };
  assert.equal(stepTwoVisible({ key: liveTargetKey(typed), ok: true }, { mcpUrl: 'https://mcp.acme.test/other' }), false, 'another URL');
  assert.equal(liveTargetKey({ mcpEndpointId: 3, mcpUrl: 'x' }), liveTargetKey({ mcpEndpointId: 3 }), 'an id ignores a leftover URL');
});

test('the kind preselected: Draft, unless the org or the server configured a snapshot scope', () => {
  assert.equal(preselectedKind(null), 'draft');
  assert.equal(preselectedKind(undefined), 'draft');
  assert.equal(preselectedKind('org'), 'snapshot');
  assert.equal(preselectedKind('deployment'), 'snapshot');
});

test('the scope fields: prefilled from the configured scope, read back as the request\'s scope', () => {
  const form = scopeFormModel({ defaults: { metricPrefixes: ['payments_', 'checkout_'], folderUids: ['ab12'], datasourceUid: null }, from: 'org', errors: [] });
  assert.deepEqual(form, { prefixes: 'payments_, checkout_', folders: 'ab12', note: 'Prefilled from this org\'s configured snapshot scope.', errors: [] });
  assert.match(scopeFormModel(null).note, /^No snapshot scope is configured/);
  assert.deepEqual(scopeFormModel({ defaults: {}, from: null, errors: ['X: bad'] }).errors, ['X: bad']);
  assert.deepEqual(scopeFromForm({ prefixes: ' payments_ ,, checkout_ ', folders: '' }), { metricPrefixes: ['payments_', 'checkout_'], folderUids: [] });
  assert.deepEqual(scopeFromForm(), { metricPrefixes: [], folderUids: [] });
});

test('the plan before a snapshot: what this MCP does not offer, and what cannot be told while pages remained', () => {
  const names = ['system_health', 'system_topology', ...probeCandidates('metric_names').map((c) => (typeof c === 'string' ? c : c.name))];
  const { capabilities } = capabilityInventory(names);
  const m = planModel(fetchPlan(capabilities, { kind: 'snapshot' }), stagesFor('snapshot'));
  assert.deepEqual(m.gaps, ['backends and versions', 'recording rules', 'alert rules', 'dashboards', 'scrape targets', 'alerting routes']);
  assert.equal(m.gapText, 'Not offered by this MCP: backends and versions, recording rules, alert rules, dashboards, scrape targets, alerting routes — the snapshot will name them');
  assert.equal(m.unknownText, null);
  const partial = planModel(fetchPlan(capabilities, { kind: 'snapshot', complete: false }), stagesFor('snapshot'));
  assert.equal(partial.gapText, null, 'never a claimed gap while a page was left');
  assert.match(partial.unknownText, /^Not known before the fetch \(tools\/list was not read whole\): backends and versions, /);
  assert.equal(planModel([{ stage: 'scrape_targets', will: 'gap' }], stagesFor('snapshot')).gapText, 'Not offered by this MCP: scrape targets — the snapshot will name it');
});

test('the gate log: one row per stage of the kind, in fetch order, the last record of a stage winning; a word and an icon for every state', () => {
  const records = [
    { seq: 1, stage: 'connect', state: 'running' },
    { seq: 3, stage: 'dashboards', state: 'running', counts: { listed: 5, detailed: 2 } },
    { seq: 2, stage: 'connect', state: 'done', counts: { tools: 12, pages: 1 } },
    { seq: 4, stage: 'scrape_targets', state: 'skipped', gap: { capability: 'scrape_configs', reason: 'this MCP offers no scrape targets tool' } },
    { seq: 5, stage: 'alerting_routes', state: 'failed', message: 'no answer' },
    { seq: 6, stage: 'nonsense', state: 'done' },
  ];
  const rows = gateLogModel(records, stagesFor('snapshot'));
  assert.deepEqual(rows.map((r) => r.id), stagesFor('snapshot').map((s) => s.id), 'every stage, in order; an unknown stage dropped');
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual([by.connect.state, by.connect.word, by.connect.icon, by.connect.counts], ['done', 'done', '✓', 'tools 12 · pages 1']);
  assert.deepEqual([by.dashboards.word, by.dashboards.counts], ['reading…', 'listed 5 · detailed 2']);
  assert.deepEqual([by.scrape_targets.word, by.scrape_targets.message], ['skipped', 'this MCP offers no scrape targets tool']);
  assert.deepEqual([by.alerting_routes.word, by.alerting_routes.message], ['failed', 'no answer']);
  assert.deepEqual([by.register.state, by.register.word, by.register.icon], ['pending', 'waiting', '○']);
  assert.ok(gateLogModel(records, stagesFor('draft')).some((r) => r.id === 'signals'), 'a draft has the signals stage');
  for (const state of Object.keys(STAGE_WORDS)) assert.ok(STAGE_ICONS[state], `${state} has an icon`);
});

test('a finished job\'s sentence: registered with its count and gaps, cancelled, failed with the server\'s words; running is none', () => {
  const done = liveResultModel({ job: { state: 'done' }, result: { registered: { id: 'u-1', label: 'Payments prod' }, counts: { metric: 20, dashboard: 5 }, gaps: [{ stage: 'scrape_targets' }] } });
  assert.deepEqual(done, { state: 'done', tone: 'ok', sentence: 'Registered Payments prod — 25 artefacts; gaps: scrape targets', registered: { id: 'u-1', label: 'Payments prod' } });
  assert.equal(liveResultModel({ job: { state: 'done' }, result: { registered: { id: 'u', label: 'x' }, counts: { metric: 1 }, gaps: [] } }).sentence, 'Registered x — 1 artefact; gaps: none');
  assert.equal(liveResultModel({ job: { state: 'cancelled' } }).sentence, 'Cancelled — nothing was registered.');
  assert.equal(liveResultModel({ job: { state: 'failed' }, error: 'your access to acme changed during the job — nothing was registered' }).sentence, 'Failed: your access to acme changed during the job — nothing was registered');
  assert.equal(liveResultModel({ job: { state: 'running' } }), null);
  assert.match(LIVE_JOB_GONE_TEXT, /^The server no longer has this job — it restarted, or the result expired 15 minutes after it finished\./);
  assert.equal(elapsedText(72_000), '1 min 12 s');
  assert.equal(elapsedText(8_400), '8 s');
});
