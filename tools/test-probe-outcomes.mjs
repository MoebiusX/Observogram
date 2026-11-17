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
 *     Alertmanager status object with no configuration key at all makes the
 *     routes unsupported the same way. Neither degrades the vantage. Not
 *     served needs that positive signal: an error, an envelope, a missing
 *     datasource, an empty configuration or one in a shape the reader does
 *     not read is a failure.
 *   - A journey's memory (fetchMcp's probeMemory) never absorbs an outage: a
 *     family remembered as not served that answers a 503 next time fails;
 *     and a tool the journey saw answer a family whose answer now says "not
 *     served" fails, saying when it answered.
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
import { probeCandidates, capabilityTool, candidateTool, productAttestedByTool } from './lib/contracts/mcp-capabilities.mjs';
import { fetchMcp, buildCanonicalPack, isProbeRefusal, notServedStatus, pingMcp } from './fetch-live-pack.mjs';
import { partialLiveEvidence } from '../studio/diagnostic-grade.mjs';
import { liveEvidenceFacts } from './lib/journey.mjs';
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
async function fetchFrom(answers, { probeMemory = null, extraTools = [], scope = null } = {}) {
  const tools = [T.health, T.topology, ...Object.keys(answers), ...extraTools];
  const fake = await startFakeMcp([...new Set(tools)], (name, args) => {
    if (name === T.health) return { services: [] };
    if (name === T.topology) return { dependencies: [] };
    const a = answers[name];
    return typeof a === 'function' ? a(args) : (a ?? {});
  });
  try {
    const fetched = await fetchMcp({ mcpUrl: fake.url, refreshedAt: AT, ...(probeMemory ? { probeMemory } : {}), ...(scope ? { scope } : {}) });
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

test('a scoped read whose Grafana alert-rule engine is refused beside a ruler that answered: the rules stand, the family is read in part (mcp.probesPartial, the refusal its masked probe error) and the vantage is partial, in the pack and in the facts a run records (A2); refused beside an empty ruler it fails, the refusal kept as one, and the firing alerts are still gathered (C6 inside the union)', async () => {
  const grafana = probeCandidates('alert_rules').map(nameOf).find((n) => productAttestedByTool(n) === 'grafana');
  const scope = { folderUids: ['shop-alerts'], ruleGroups: ['shop'] };
  const ruler = { groups: [{ name: 'shop', rules: [{ name: 'CheckoutDown', type: 'alerting', query: 'up{job="checkout"} == 0', labels: { severity: 'critical' } }] }] };
  const refused = { __isError: 'Error: HTTP 403: Forbidden — https://grafana.example.com/api/v1/provisioning/alert-rules?folder_uid=shop-alerts' };
  const beside = await fetchFrom({ [T.names]: NAMES, [T.rules]: ruler, [grafana]: refused }, { scope });
  assert.ok(beside.calls.some((c) => c.name === grafana && c.args.folder_uid === 'shop-alerts'), 'the scope\'s folder was asked of Grafana');
  assert.ok(list(beside.ann, 'mcp.probesSucceeded').includes('alert_rules') && !list(beside.ann, 'mcp.probesFailed').includes('alert_rules'), 'the rules that answered stand');
  assert.equal(beside.ann['mcp.probesPartial'], 'alert_rules', 'read in part');
  assert.match(beside.ann['mcp.probeErrors.alert_rules'], new RegExp(`^${grafana}: .*HTTP 403`), 'the refusal kept');
  assert.ok(!beside.ann['mcp.probeErrors.alert_rules'].includes('folder_uid='), 'masked as every probe error is');
  const ev = partialLiveEvidence(beside.pack);
  assert.deepEqual([ev.vantage, ev.inPart, ev.failed], ['partial', ['alert_rules'], []], 'the vantage reads the hole');
  const facts = liveEvidenceFacts(beside.pack);
  assert.deepEqual([facts.vantage, facts.probes.partial], ['partial', ['alert_rules']], 'and so does the run record');
  // The same read with Grafana answering — nothing in the folder — is whole.
  const whole = await fetchFrom({ [T.names]: NAMES, [T.rules]: ruler, [grafana]: [] }, { scope });
  assert.deepEqual([whole.ann['mcp.probesPartial'], partialLiveEvidence(whole.pack).vantage], [undefined, 'full']);
  // Refused beside a ruler that lists nothing: no honest zero — failed, the refusal kept as one, so the
  // firing alerts are gathered as for a refused cascade.
  const alone = await fetchFrom({
    [T.names]: NAMES, [T.rules]: { groups: [] }, [grafana]: refused,
    [T.query]: (args) => (/ALERTS/.test(String(args.query || '')) ? { result: [{ metric: { alertname: 'CheckoutDown', severity: 'page' }, value: [0, '1'] }] } : { result: [] }),
  }, { scope });
  assert.ok(list(alone.ann, 'mcp.probesFailed').includes('alert_rules') && !list(alone.ann, 'mcp.probesEmpty').includes('alert_rules'));
  assert.deepEqual(alone.fetched.probeResults.alert_rules.refused, [grafana]);
  assert.equal(alone.ann['mcp.probesPartial'], undefined, 'a failed family is no partial one');
  assert.equal(alone.ann['mcp.discovered.alerts_firing.names'], 'CheckoutDown', 'the firing-alerts fallback ran');
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

test('a refusal in the words of other client libraries is one too — the Prometheus Go client, a generated Grafana client, gRPC, AWS — and a bare 401 or 403 in other words still is not (E4)', () => {
  for (const yes of [
    'client_error: client error: 403',
    '[GET /search][403] searchForbidden {"message":"You\'ll need additional permissions to perform this action.","title":"Access denied"}',
    '[GET /search][401] searchUnauthorized {"message":"Invalid API key","messageId":"api-keys.invalid","statusCode":401}',
    'rpc error: code = PermissionDenied desc = permission denied',
    'rpc error: code = Unauthenticated desc = invalid bearer token',
    'Grafana API error (403): Access denied',
    'received 403 from upstream',
    'AccessDeniedException: User: arn:aws:sts::123:assumed-role/x is not authorized to perform: aps:QueryMetrics',
    'x: {"status":403,"message":"denied"}',
  ]) {
    assert.equal(isProbeRefusal(yes), true, yes);
  }
  for (const no of ['execution: the query hit the max number of chunks limit (limit: 2000000) - 403 series matched',
    'client_error: client error: 404', '[GET /search][404] searchNotFound', 'x: HTTP 502: Bad Gateway', 'x: (404) not here']) {
    assert.equal(isProbeRefusal(no), false, no);
  }
});

test('a dashboard search refused in a generated client\'s words beside a fallback that answers empty is failed, never an honest empty; the ping reads the Go client\'s refusal as the backend refusing the MCP (E4)', async () => {
  const { ann, pack } = await fetchFrom({
    [T.names]: NAMES,
    [T.search]: { __isError: '[GET /search][403] searchForbidden {"message":"You\'ll need additional permissions to perform this action.","title":"Access denied"}' },
    [T.dashList]: [],
  });
  assert.ok(list(ann, 'mcp.probesFailed').includes('dashboards') && !list(ann, 'mcp.probesEmpty').includes('dashboards'), 'the refused search leaves a hole');
  assert.match(ann['observogram.unobserved.dashboard'], /\[403\] searchForbidden/, 'declared dashboards are not checked, never "declared, not live"');
  assert.equal(partialLiveEvidence(pack).vantage, 'partial');
  const fake = await startFakeMcp([T.health, T.topology, T.search], (name) => (name === T.search ? { __isError: 'client_error: client error: 403' } : {}));
  try {
    const ping = await pingMcp({ mcpUrl: fake.url });
    assert.deepEqual([ping.verdict, ping.read?.outcome, ping.read?.backendAuthRefused], ['connected', 'failed', true]);
  } finally {
    await fake.close();
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

test('a 404 that names a missing datasource is never "not served": a wrong datasource uid is a failure, its text kept as the probe error (E2)', async () => {
  const S = [400, 404, 405];
  assert.equal(notServedStatus('x: Error: HTTP 404: {"message":"Data source not found"} — http://grafana.example.com/api/datasources/proxy/uid/promm/api/v1/targets', S), null);
  assert.equal(notServedStatus('x: HTTP 404: {"message":"Unable to find datasource"}', S), null);
  assert.equal(notServedStatus('x: HTTP 404: datasource with uid "promm" does not exist', S), null);
  assert.equal(notServedStatus('x: Error: HTTP 404: Not Found — http://grafana.example.com/api/datasources/proxy/uid/x/api/v1/targets', S), 404,
    'a datasource in the URL\'s path is no missing datasource: the store answered 404');
  assert.equal(notServedStatus('x: HTTP 404: the datasource proxy returned Not Found', S), 404, 'the store behind the datasource answered 404');
  const { ann, pack } = await fetchFrom({
    [T.names]: NAMES,
    [T.targets]: { __isError: 'Error: HTTP 404: {"message":"Data source not found"} — http://grafana.example.com/api/datasources/proxy/uid/promm/api/v1/targets' },
  });
  assert.ok(list(ann, 'mcp.probesFailed').includes('scrape_configs') && !list(ann, 'mcp.probesUnsupported').includes('scrape_configs'));
  assert.match(ann['mcp.probeErrors.scrape_configs'], /Data source not found/);
  assert.equal(ann['mcp.probeUnsupported.scrape_configs'], undefined);
  assert.equal(partialLiveEvidence(pack).vantage, 'partial');
});

test('a not-served answer from a tool the journey saw answer the family is a failure that says when it answered; a tool never seen answering is still "not served" (E2)', async () => {
  const at = '2026-11-15T09:00:00.000Z';
  const NOT_FOUND = { __isError: 'Error: HTTP 404: Not Found — http://grafana.example.com/api/datasources/proxy/uid/x/api/v1/targets' };
  const seen = { answered: { scrape_configs: { tools: [T.targets], at } } };
  const lostRoute = await fetchFrom({ [T.names]: NAMES, [T.targets]: NOT_FOUND }, { probeMemory: seen });
  assert.ok(list(lostRoute.ann, 'mcp.probesFailed').includes('scrape_configs'), 'the store served the targets: a 404 now is a failure');
  assert.equal(lostRoute.ann['mcp.probeErrors.scrape_configs'],
    `${T.targets}: it answered on 2026-11-15; now Error: HTTP 404: Not Found — http://grafana.example.com/api/datasources/proxy/uid/x/api/v1/targets`);
  assert.equal(lostRoute.ann['mcp.probeUnsupported.scrape_configs'], undefined);
  assert.equal(partialLiveEvidence(lostRoute.pack).vantage, 'partial');
  // Another tool, one the journey never saw answer: its store may keep none.
  const otherTool = await fetchFrom({ [T.names]: NAMES, [T.targets2]: NOT_FOUND }, { probeMemory: seen });
  assert.ok(list(otherTool.ann, 'mcp.probesUnsupported').includes('scrape_configs'));
  // An older record that did not say which tool answered: every tool's not-served answer fails.
  const anyTool = await fetchFrom({ [T.names]: NAMES, [T.targets2]: NOT_FOUND }, { probeMemory: { answered: { scrape_configs: { tools: [], at, anyTool: true } } } });
  assert.ok(list(anyTool.ann, 'mcp.probesFailed').includes('scrape_configs'));
  // The Alertmanager status the same way: a status that served its configuration and now trims it.
  const trimmed = await fetchFrom({ [T.names]: NAMES, [T.status]: { versionInfo: { version: '0.27.0' }, cluster: { status: 'ready' } } },
    { probeMemory: { answered: { alerting_routes: { tools: [T.status], at } } } });
  assert.ok(list(trimmed.ann, 'mcp.probesFailed').includes('alerting_routes'));
  assert.equal(trimmed.ann['mcp.probeErrors.alerting_routes'], `${T.status}: it answered on 2026-11-15; now the Alertmanager status carries no configuration`);
  // What a journey remembers it from: the tool that answered a family that can read "not served" — data or an honest empty.
  const data = await fetchFrom({ [T.names]: NAMES, [T.targets]: { targets: [{ job: 'shop-api', instance: 'shop-api:9100', health: 'up' }] } });
  assert.equal(data.ann['mcp.probeAnsweredBy.scrape_configs'], T.targets);
  assert.equal(data.ann['mcp.probeAnsweredBy.metric_names'], undefined, 'a family that never reads "not served" needs no memory');
  assert.deepEqual(liveEvidenceFacts(data.pack).probeAnsweredBy, { scrape_configs: [T.targets] });
  const empty = await fetchFrom({ [T.names]: NAMES, [T.targets2]: { targets: [] } });
  assert.equal(empty.ann['mcp.probeAnsweredBy.scrape_configs'], T.targets2);
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

test('"not served" needs a positive signal: an Alertmanager answer that is an error, an envelope, no status at all, an empty configuration or one in a shape the reader does not read fails the routes, the vantage partial (E1)', async () => {
  const status = { versionInfo: { version: '0.27.0' }, cluster: { status: 'ready', peers: [] }, uptime: '2026-11-16T09:00:00.000Z' };
  // Grafana's built-in Alertmanager states its configuration as a JSON object (GettableStatus).
  const grafanaConfig = { route: { receiver: 'shop-oncall', routes: [{ receiver: 'shop-oncall', object_matchers: [['severity', '=', 'critical']] }] }, receivers: [{ name: 'shop-oncall', grafana_managed_receiver_configs: [{ type: 'webhook', settings: { url: 'https://hooks.example.com/shop' } }] }] };
  const cases = [
    ['an error as content', { error: 'dial tcp 10.0.0.7:9093: connect: connection refused' }, 'the status answer carries an error'],
    ['an error envelope', { status: 'error', errorType: 'unavailable', error: 'alertmanager unavailable' }, 'the status answer is an error envelope (errorType unavailable)'],
    ['plain text', 'Error: could not reach the Alertmanager', 'the answer is no Alertmanager status'],
    ['an empty object', {}, 'the answer is no Alertmanager status'],
    ['an empty list', [], 'the answer is no Alertmanager status'],
    ['a bare status word', { status: 'down' }, 'the answer is no Alertmanager status'],
    ['an empty configuration text', { ...status, config: { original: '' } }, 'the Alertmanager status carries an empty configuration'],
    ['a null configuration', { ...status, config: null }, 'the Alertmanager status carries an empty configuration'],
    ['a configuration as a JSON object', { ...status, config: grafanaConfig }, 'the Alertmanager status carries its configuration in a shape this reader does not read'],
  ];
  for (const [what, answer, why] of cases) {
    const { ann, pack } = await fetchFrom({ [T.names]: NAMES, [T.status]: answer });
    assert.ok(list(ann, 'mcp.probesFailed').includes('alerting_routes') && !list(ann, 'mcp.probesUnsupported').includes('alerting_routes'), `${what}: failed, never "not served"`);
    assert.equal(ann['mcp.probeErrors.alerting_routes'], `${T.status}: ${why}`, `${what}: the reason, not the answer's text`);
    assert.equal(ann['mcp.probeUnsupported.alerting_routes'], undefined);
    assert.equal(partialLiveEvidence(pack).vantage, 'partial', `${what}: a hole in the live read`);
  }
  // A status object with no configuration key at all is the one positive signal (A16).
  const trimmed = await fetchFrom({ [T.names]: NAMES, [T.status]: status });
  assert.ok(list(trimmed.ann, 'mcp.probesUnsupported').includes('alerting_routes'));
  assert.equal(partialLiveEvidence(trimmed.pack).vantage, 'full');
});

test('a family the journey remembers as not served is asked again and its answer alone decides: a 503 is a failure, never absorbed; the not-served answer again keeps its first instant; data, an empty answer and a refusal decide (P6, E1)', async () => {
  const since = '2026-11-01T08:00:00.000Z';
  const probeMemory = { unsupported: { scrape_configs: { reason: `${T.targets}: HTTP 404 Not Found`, since, tools: [T.targets] } } };
  const busy = await fetchFrom({ [T.names]: NAMES, [T.targets]: { __isError: 'Error: HTTP 503: Service Unavailable' } }, { probeMemory });
  assert.ok(busy.calls.some((c) => c.name === T.targets), 'the family is asked again');
  assert.ok(list(busy.ann, 'mcp.probesFailed').includes('scrape_configs') && !list(busy.ann, 'mcp.probesUnsupported').includes('scrape_configs'), 'a 503 is an outage, not "not served"');
  assert.equal(busy.ann['mcp.probeUnsupported.scrape_configs'], undefined);
  assert.equal(busy.ann['mcp.probeErrors.scrape_configs'], `${T.targets}: Error: HTTP 503: Service Unavailable`);
  assert.equal(partialLiveEvidence(busy.pack).vantage, 'partial');
  const status = { versionInfo: { version: '0.27.0' }, cluster: { status: 'ready' } };
  const amDown = await fetchFrom({ [T.names]: NAMES, [T.status]: { __isError: 'Error: HTTP 503: Service Unavailable' } },
    { probeMemory: { unsupported: { alerting_routes: { reason: `${T.status}: the Alertmanager status carries no configuration`, since, tools: [T.status] } } } });
  assert.ok(list(amDown.ann, 'mcp.probesFailed').includes('alerting_routes'), 'a trimmed Alertmanager that is now down is down');
  assert.equal(partialLiveEvidence(amDown.pack).vantage, 'partial');
  const amAgain = await fetchFrom({ [T.names]: NAMES, [T.status]: status },
    { probeMemory: { unsupported: { alerting_routes: { reason: `${T.status}: the Alertmanager status carries no configuration`, since, tools: [T.status] } } } });
  assert.equal(JSON.parse(amAgain.ann['mcp.probeUnsupported.alerting_routes']).since, since);
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
