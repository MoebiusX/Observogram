#!/usr/bin/env node
/**
 * tools/test-live-model.mjs — the pure models of the live MCP connection
 * (studio/live-model.mjs, rebadge batch 3): what the MCP panel draws from a
 * POST /api/mcp/ping answer (the status word per verdict, the timings, the
 * capabilities a fetch reads, the families not offered — "not among the
 * tools listed" while pages remained, never called absent —, checked and
 * notChecked passed through), and the duration sentences (from evidence,
 * else the measured range; no kind said to be faster).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pingResultModel, durationText, rebuildNoteText, capabilityLabel, INVENTORY_FAMILIES, MEASURED_RANGE,
} from '../studio/live-model.mjs';

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
