#!/usr/bin/env node
/**
 * tools/test-probe-outcomes.mjs
 *
 * What a probe family's outcome rests on (C6, P6): the live fetcher end to
 * end — fetchMcp against a fake MCP (server/fixtures/fake-mcp.mjs), then
 * buildCanonicalPack — and the two text rules it reads answers by.
 *
 *   - A read refused with 401 / 403 whose fallback answers nothing is
 *     FAILED, its refusal kept — an honest zero needs a read that was
 *     allowed. Data from another candidate still wins.
 *   - Scrape targets whose store answers 400 / 404 / 405 (a federated or
 *     remote-write store keeps none) are UNSUPPORTED, never failed; an
 *     Alertmanager status that answers without its configuration makes the
 *     routes unsupported the same way. Neither degrades the vantage.
 *   - A journey's memory of such a family (fetchMcp's probeMemory) keeps it
 *     unsupported when it answers a mere error next time; data, an empty
 *     answer or a refusal still decide.
 *   - metrics_metadata is never called without its metric.
 *   - A declared alert rule is "not checked", never "declared, not live",
 *     when the alert-rule family could not be read.
 *
 *   node --test tools/test-probe-outcomes.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeMcp } from '../server/fixtures/fake-mcp.mjs';
import { probeCandidates, capabilityTool, candidateTool } from './lib/contracts/mcp-capabilities.mjs';
import { fetchMcp, buildCanonicalPack, isProbeRefusal, notServedStatus } from './fetch-live-pack.mjs';
import { partialLiveEvidence } from '../studio/diagnostic-grade.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { SPEC_DIR } from './lib/validator.mjs';
import { adapt } from './lib/adapter.mjs';
import { diffPacks } from './lib/diff.mjs';

// A developer's exported transport hook must not reach the fake.
delete process.env.OBSERVOGRAM_TRANSPORT_HOOK;
delete process.env.TOMOGRAPH_TRANSPORT_HOOK;

const __dirname = dirname(fileURLToPath(import.meta.url));
const AT = '2026-11-16T10:00:00.000Z';
const nameOf = (c) => (typeof c === 'string' ? c : c.name);
const first = (family, i = 0) => nameOf(probeCandidates(family)[i]);
const T = {
  health: capabilityTool('system_health'),
  topology: capabilityTool('system_topology'),
  names: first('metric_names'),
  search: candidateTool('dashboards', 'search'),
  dashList: first('dashboards', 1),
  targets: first('scrape_configs'),
  targets2: first('scrape_configs', 1),
  rules: first('alert_rules'),          // serves recording and alert rules
  rules2: first('alert_rules', 1),
  status: first('alerting_routes'),
  query: capabilityTool('build_info_versions'),
};
const NAMES = { label: '__name__', values: ['up', 'http_server_request_duration_seconds_count'] };

// One fetch against a fake that advertises `tools` and answers through
// `answers` (tool name → answer, or a function of the call's arguments).
async function fetchFrom(answers, { probeMemory = null, extraTools = [] } = {}) {
  const tools = [T.health, T.topology, ...Object.keys(answers), ...extraTools];
  const fake = await startFakeMcp([...new Set(tools)], (name, args) => {
    if (name === T.health) return { services: [] };
    if (name === T.topology) return { dependencies: [] };
    const a = answers[name];
    return typeof a === 'function' ? a(args) : (a ?? {});
  });
  try {
    const fetched = await fetchMcp({ mcpUrl: fake.url, refreshedAt: AT, ...(probeMemory ? { probeMemory } : {}) });
    const pack = buildCanonicalPack({ refreshedAt: AT, mcpUrl: fake.url, ...fetched });
    return { fetched, pack, ann: pack.metadata.annotations, calls: fake.calls.map((c) => ({ name: c.name, args: c.arguments || {} })) };
  } finally {
    await fake.close();
  }
}
const list = (ann, key) => String(ann[key] || '').split(',').filter(Boolean);

test('a refused read whose fallback answers empty is failed, its refusal kept — for 401 and for 403 (P7: "403 with empty fallback")', async () => {
  for (const status of [401, 403]) {
    const word = status === 401 ? 'Unauthorized' : 'Forbidden';
    const { ann, pack } = await fetchFrom({
      [T.names]: NAMES,
      [T.search]: { __isError: `Error: HTTP ${status}: ${word} — https://grafana.example.com/api/search` },
      [T.dashList]: [],
    });
    assert.ok(list(ann, 'mcp.probesFailed').includes('dashboards') && !list(ann, 'mcp.probesEmpty').includes('dashboards'),
      `${status}: the dashboards family is failed, never an honest empty`);
    assert.match(ann['mcp.probeErrors.dashboards'], new RegExp(`^${T.search}: .*HTTP ${status}`), `${status}: the refusal is the probe error`);
    assert.match(ann['observogram.unobserved.dashboard'], new RegExp(`HTTP ${status}`), `${status}: declared dashboards are not checked, never missing`);
    assert.equal(partialLiveEvidence(pack).vantage, 'partial', `${status}: a hole of unknown size: the vantage is partial`);
  }
});

test('a refused read beside a candidate that answers with data is that data', async () => {
  const { ann } = await fetchFrom({
    [T.names]: NAMES,
    [T.search]: { __isError: 'Error: HTTP 401: Unauthorized — https://grafana.example.com/api/search' },
    [T.dashList]: [{ uid: 'shop-overview', title: 'Shop overview' }],
  });
  assert.ok(list(ann, 'mcp.probesSucceeded').includes('dashboards'));
  assert.equal(ann['mcp.probeErrors.dashboards'], undefined, 'a family that answered carries no probe error');
});

test('a declared alert rule is not checked, never "declared, not live", when the alert-rule read was refused and its fallback answered empty (A3)', async () => {
  const { ann, pack } = await fetchFrom({
    [T.names]: NAMES,
    [T.rules]: { __isError: 'HTTP 403: Forbidden' },
    [T.rules2]: { groups: [] },
  });
  assert.ok(list(ann, 'mcp.probesFailed').includes('alert_rules'), 'the alert-rule family is failed');
  assert.match(ann['observogram.unobserved.alert_rule'], /HTTP 403/, 'declared alert rules are parked with the reason');
  assert.match(ann['observogram.unobserved.burn_rate'], /HTTP 403/);
  const repo = parseYaml(readFileSync(resolve(__dirname, '..', SPEC_DIR, 'examples/payment-service.pack.yaml'), 'utf8'));
  const d = diffPacks(adapt(repo), adapt(pack));
  const count = (bucket) => Object.values(d.layers).flatMap((l) => l[bucket]).filter((e) => e.key.startsWith('alert_rule::')).length;
  assert.equal(count('onlyInA'), 0, 'no alert rule reads declared, not live');
  assert.equal(count('notObserved'), 3, 'the three declared alert rules read not checked');
});

test('a ruler that refused the read still gathers the firing alerts and the recorded-series names it gathered as an empty one (S2)', async () => {
  const { ann, calls } = await fetchFrom({
    [T.names]: { label: '__name__', values: ['up', 'checkout:requests:good_5m', 'checkout:requests:total_5m'] },
    [T.rules]: { __isError: 'HTTP 403: Forbidden' },
    [T.query]: (args) => (/ALERTS/.test(String(args.query || '')) ? { result: [{ metric: { alertname: 'CheckoutDown', severity: 'page' }, value: [0, '1'] }] } : { result: [] }),
  });
  assert.ok(list(ann, 'mcp.probesFailed').includes('alert_rules'));
  assert.ok(calls.some((c) => c.name === T.query && /ALERTS/.test(String(c.args.query || ''))), 'the firing-alerts query ran');
  assert.equal(ann['mcp.discovered.alerts_firing.names'], 'CheckoutDown');
  assert.equal(ann['mcp.discovered.recording_rules_via_inventory.count'], '2', 'the recorded series are read from the metric names');
});

test('the texts a refusal comes in (one rule for the probe cascade and the ping)', () => {
  for (const yes of ['MCP HTTP 401 on tools/call: unauthorized', 'x: HTTP 403: Forbidden', 'x: Unauthorized', 'tools/call: Forbidden',
    'x: request failed with status code 403', 'HTTP 401 from Grafana: Unauthorized', 'x: 403 Forbidden']) {
    assert.equal(isProbeRefusal(yes), true, yes);
  }
  for (const no of ['MCP HTTP 503 on tools/call: busy', 'x: MCP error -32602: Input validation error', 'x: HTTP 404: Not Found',
    'x: query returned 401 series', 'upstream refused: Authorization: (none)', 'search index rebuilding', null, 42]) {
    assert.equal(isProbeRefusal(no), false, String(no));
  }
});

test('the statuses a store answers when it keeps no such thing', () => {
  const S = [400, 404, 405];
  assert.equal(notServedStatus('x: Error: HTTP 404: Not Found — http://grafana.example.com/api/datasources/proxy/uid/x/api/v1/targets', S), 404);
  assert.equal(notServedStatus('x: HTTP 405: Method Not Allowed', S), 405);
  assert.equal(notServedStatus('x: request failed with status code 400', S), 400);
  assert.equal(notServedStatus('tools/call: 404 not found', S), 404);
  assert.equal(notServedStatus('MCP HTTP 404 on tools/call: no such route', S), null, 'the MCP endpoint\'s own status is the MCP, not the store');
  assert.equal(notServedStatus('x: HTTP 401: Unauthorized', S), null, 'a refusal is never "not served"');
  assert.equal(notServedStatus('x: HTTP 404', []), null, 'no statuses, no match');
  assert.equal(notServedStatus('x: dashboard d not found', S), null, 'a word is not a status');
  assert.equal(notServedStatus('x: HTTP 503 Service Unavailable', S), null);
});

test('scrape targets answered 400, 404 or 405 are unsupported, the status the reason; the vantage stays full', async () => {
  for (const [status, phrase] of [[400, 'Bad Request'], [404, 'Not Found'], [405, 'Method Not Allowed']]) {
    const { ann, pack } = await fetchFrom({
      [T.names]: NAMES,
      [T.targets]: { __isError: `Error: HTTP ${status}: ${phrase} — http://grafana.example.com/api/datasources/proxy/uid/x/api/v1/targets` },
    });
    assert.ok(list(ann, 'mcp.probesUnsupported').includes('scrape_configs') && !list(ann, 'mcp.probesFailed').includes('scrape_configs'), `${status}: unsupported, never failed`);
    assert.equal(ann['mcp.probeErrors.scrape_configs'], undefined, `${status}: no probe error`);
    const entry = JSON.parse(ann['mcp.probeUnsupported.scrape_configs']);
    assert.deepEqual([entry.reason, entry.tools], [`${T.targets}: HTTP ${status} ${phrase}`, [T.targets]], `${status}: the reason is the tool and the status — no URL (P7: reasons only)`);
    assert.ok(typeof entry.since === 'string' && !('remembered' in entry));
    assert.ok(!JSON.stringify(entry).includes('grafana.example.com'), 'the answer\'s text is not kept');
    assert.equal(ann['observogram.unobserved.scrape_job'], `${T.targets}: HTTP ${status} ${phrase} — the scrape targets are not served here; not counted as a failure`);
    assert.ok(!list(ann, 'mcp.toolsUnmatched').includes(T.targets), 'a tool probed is never "no probe pattern yet"');
    assert.equal(partialLiveEvidence(pack).vantage, 'full', `${status}: an unsupported family never degrades the vantage`);
  }
});

test('not every 4xx is "not served": a 503 fails; a 404 beside an empty candidate is that empty; a 404 beside a 503 fails', async () => {
  const unavailable = await fetchFrom({ [T.names]: NAMES, [T.targets]: { __isError: 'Error: HTTP 503: Service Unavailable' } });
  assert.ok(list(unavailable.ann, 'mcp.probesFailed').includes('scrape_configs'));
  assert.equal(partialLiveEvidence(unavailable.pack).vantage, 'partial');
  const besideEmpty = await fetchFrom({ [T.names]: NAMES, [T.targets]: { __isError: 'Error: HTTP 404: Not Found' }, [T.targets2]: { targets: [] } });
  assert.ok(list(besideEmpty.ann, 'mcp.probesEmpty').includes('scrape_configs'), 'an honest zero from a candidate that worked');
  const beside503 = await fetchFrom({ [T.names]: NAMES, [T.targets]: { __isError: 'Error: HTTP 404: Not Found' }, [T.targets2]: { __isError: 'Error: HTTP 503: Service Unavailable' } });
  assert.ok(list(beside503.ann, 'mcp.probesFailed').includes('scrape_configs'), 'one candidate that might have answered: failed');
});

test('a Prometheus error envelope answered as content is no honest empty (S12): not_found is not served, execution fails', async () => {
  const notFound = await fetchFrom({ [T.names]: NAMES, [T.targets]: { status: 'error', errorType: 'not_found', error: 'unknown API endpoint' } });
  assert.ok(list(notFound.ann, 'mcp.probesUnsupported').includes('scrape_configs'));
  assert.equal(JSON.parse(notFound.ann['mcp.probeUnsupported.scrape_configs']).reason, `${T.targets}: errorType not_found (HTTP 404 Not Found)`);
  const execution = await fetchFrom({ [T.names]: NAMES, [T.targets]: { status: 'error', errorType: 'execution', error: 'query timed out' } });
  assert.ok(list(execution.ann, 'mcp.probesFailed').includes('scrape_configs') && !list(execution.ann, 'mcp.probesEmpty').includes('scrape_configs'));
  assert.match(execution.ann['mcp.probeErrors.scrape_configs'], /errorType execution/);
});

test('an Alertmanager status that answers without its configuration makes the routes unsupported, never failed (A16); one with it reads the routes', async () => {
  const trimmed = await fetchFrom({ [T.names]: NAMES, [T.status]: { versionInfo: { version: '0.27.0' }, cluster: { status: 'ready' } } });
  assert.ok(list(trimmed.ann, 'mcp.probesUnsupported').includes('alerting_routes') && !list(trimmed.ann, 'mcp.probesFailed').includes('alerting_routes'));
  assert.equal(JSON.parse(trimmed.ann['mcp.probeUnsupported.alerting_routes']).reason, `${T.status}: the Alertmanager status carries no configuration`);
  assert.equal(trimmed.ann['mcp.probeErrors.alerting_routes'], undefined);
  assert.equal(partialLiveEvidence(trimmed.pack).vantage, 'full');
  const config = 'route:\n  receiver: oncall\nreceivers:\n  - name: oncall\n    webhook_configs:\n      - url: https://hooks.example.com/x\n';
  const whole = await fetchFrom({ [T.names]: NAMES, [T.status]: { versionInfo: { version: '0.27.0' }, config: { original: config } } });
  assert.ok(list(whole.ann, 'mcp.probesSucceeded').includes('alerting_routes'));
});

test('a remembered family is asked again: a mere error keeps it unsupported as remembered; data, an empty answer and a refusal decide (P6, S1)', async () => {
  const since = '2026-11-01T08:00:00.000Z';
  const probeMemory = { unsupported: { scrape_configs: { reason: `${T.targets}: HTTP 404 Not Found`, since, tools: [T.targets] } } };
  const busy = await fetchFrom({ [T.names]: NAMES, [T.targets]: { __isError: 'Error: HTTP 503: Service Unavailable' } }, { probeMemory });
  assert.ok(busy.calls.some((c) => c.name === T.targets), 'the family is asked again');
  assert.ok(list(busy.ann, 'mcp.probesUnsupported').includes('scrape_configs'), 'a 503 is no new failure');
  assert.deepEqual(JSON.parse(busy.ann['mcp.probeUnsupported.scrape_configs']), { reason: `${T.targets}: HTTP 404 Not Found`, since, tools: [T.targets], remembered: true });
  assert.match(busy.ann['observogram.unobserved.scrape_job'], /answered so since 2026-11-01/);
  assert.equal(partialLiveEvidence(busy.pack).vantage, 'full');
  const again = await fetchFrom({ [T.names]: NAMES, [T.targets]: { __isError: 'Error: HTTP 404: Not Found' } }, { probeMemory });
  assert.equal(JSON.parse(again.ann['mcp.probeUnsupported.scrape_configs']).since, since, 'the same answer again keeps the first instant');
  const answered = await fetchFrom({ [T.names]: NAMES, [T.targets]: { targets: [{ job: 'shop-api', instance: 'shop-api:9100', health: 'up' }] } }, { probeMemory });
  assert.ok(list(answered.ann, 'mcp.probesSucceeded').includes('scrape_configs') && answered.ann['mcp.probeUnsupported.scrape_configs'] === undefined, 'data always wins');
  const empty = await fetchFrom({ [T.names]: NAMES, [T.targets]: { targets: [] } }, { probeMemory });
  assert.ok(list(empty.ann, 'mcp.probesEmpty').includes('scrape_configs'), 'an honest zero wins');
  const refused = await fetchFrom({ [T.names]: NAMES, [T.targets]: { __isError: 'Error: HTTP 401: Unauthorized' } }, { probeMemory });
  assert.ok(list(refused.ann, 'mcp.probesFailed').includes('scrape_configs'), 'a refusal fails the family, remembered or not');
  const otherTool = await fetchFrom({ [T.names]: NAMES, [T.targets2]: { __isError: 'Error: HTTP 503: Service Unavailable' } }, { probeMemory });
  assert.ok(list(otherTool.ann, 'mcp.probesFailed').includes('scrape_configs'), 'a tool the memory never heard answer "not served" fails as before');
});

test('metrics_metadata is never called without its metric: the metric-names error names the tool that failed alone', async () => {
  const { ann, calls } = await fetchFrom({
    [T.names]: { __isError: 'HTTP 503 Service Unavailable' },
    [T.targets]: { targets: [{ job: 'shop-api', instance: 'shop-api:9100', health: 'up' }] },
    metrics_metadata: () => ({ data: { up: [{ type: 'gauge' }] } }),
  });
  assert.ok(!calls.some((c) => c.name === 'metrics_metadata'), 'no metrics_metadata call');
  assert.ok(list(ann, 'mcp.probesFailed').includes('metric_names'));
  assert.equal(ann['mcp.probeErrors.metric_names'], `${T.names}: HTTP 503 Service Unavailable`);
});
