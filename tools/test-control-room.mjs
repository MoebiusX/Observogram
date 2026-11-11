#!/usr/bin/env node
/**
 * tools/test-control-room.mjs — Overview's control room, the engine side: the known metric families
 * (tools/lib/contracts/control-room-families.mjs) and the reader (tools/lib/control-room.mjs).
 *
 * The families' bounds that cite a library entry are held equal to the entry's YAML; every built-in
 * row passes the row check a downstream's rows pass; a downstream file merges by id. The incident
 * rebuild and the MTTR summary are pinned on small histories; the reader is driven by a fake query
 * tool keyed by query, for its outcomes (data, empty, failed, not-attempted), its budget, its pool
 * and the only request data that reaches PromQL: the declared job names, escaped.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from './lib/mini-yaml.mjs';
import { CONTROL_ROOM_FAMILIES, CONTROL_ROOM_UNITS } from './lib/contracts/control-room-families.mjs';
import {
  CONTROL_ROOM_LIMITS, normaliseSeverity, statusWord, judgeValue, jobsRegex, cleanError,
  incidentsFrom, timingSummary, familyRowErrors, controlRoomFamilies, detectionQuery, pickVariant, readControlRoom, openControlRoom,
  scopeSelectors, scopeQueries,
} from './lib/control-room.mjs';
import { capabilityTool } from './lib/contracts/mcp-capabilities.mjs';

const library = (entry) => {
  for (const dir of ['archetypes', 'products']) {
    try { return parse(readFileSync(new URL(`../library/${dir}/${entry}.library.yaml`, import.meta.url), 'utf8')); } catch { /* the other */ }
  }
  throw new Error(`no library entry ${entry}`);
};

test('every bound a family cites from the library is the library entry\'s own, and every built-in row is a valid row', () => {
  let cited = 0;
  for (const f of CONTROL_ROOM_FAMILIES) {
    assert.deepEqual(familyRowErrors(f), [], `${f.id}: a valid row`);
    for (const v of f.variants) {
      for (const t of v.tiles) {
        assert.ok(CONTROL_ROOM_UNITS.includes(t.unit), `${f.id}/${t.id}: a known unit`);
        assert.ok(!/[\r\n]/.test(t.expr), `${f.id}/${t.id}: one line`);
        const from = t.judge.from || '';
        const m = from.match(/^library:([a-z0-9-]+)#([a-z0-9_]+)$/);
        if (!m) { assert.ok(t.judge.kind === 'info' || from === 'stated', `${f.id}/${t.id}: a bound is from the library or stated (${from})`); continue; }
        const y = library(m[1]);
        const sli = (y.slis || []).find((s) => s.id === m[2]);
        const param = (y.params || y.parameters || []).find((p) => p.id === m[2]);
        const value = sli ? sli.threshold : param ? param.default : undefined;
        assert.equal(t.judge.bound, value, `${f.id}/${t.id}: its bound is ${m[1]}'s ${m[2]}`);
        cited += 1;
      }
    }
  }
  assert.ok(cited >= 10, `at least ten bounds are the library's (${cited})`);
  assert.deepEqual(CONTROL_ROOM_FAMILIES.map((f) => f.id), ['http', 'runtime', 'containers', 'kubernetes', 'nodes', 'rabbitmq', 'postgresql', 'redis', 'kong']);
});

test('the small rules: severities in four words, the status word, a tile\'s tone, job names escaped, an error without its URL or page', () => {
  assert.deepEqual(['critical', 'SEV1', 'sev-1', 'P0', 'page', 'Urgent', 'warning', 'major', 'SEV3', 'info', 'none', 'weird', undefined].map(normaliseSeverity),
    ['critical', 'critical', 'critical', 'critical', 'critical', 'critical', 'warning', 'warning', 'warning', 'info', 'info', 'other', 'other']);
  assert.equal(statusWord({ outcome: 'data', bySeverity: { critical: 1, warning: 3 } }), 'critical');
  assert.equal(statusWord({ outcome: 'data', bySeverity: { critical: 0, warning: 0, other: 1 } }), 'firing', 'a severity not recognised is never called a warning');
  assert.equal(statusWord({ outcome: 'data', bySeverity: { critical: 0, warning: 2, other: 0 } }), 'warning');
  assert.equal(statusWord({ outcome: 'empty', evidence: true, bySeverity: { critical: 0, warning: 0, info: 2 } }), 'quiet');
  assert.equal(statusWord({ outcome: 'empty', evidence: false, bySeverity: { critical: 0, warning: 0 } }), 'unknown', 'no alert history in the store: quiet cannot be told from unwatched');
  assert.equal(statusWord({ outcome: 'empty', evidence: null, bySeverity: { critical: 0, warning: 0 } }), 'unknown', 'the history not read: not quiet either');
  assert.equal(statusWord({ outcome: 'failed' }), 'unknown', 'not read is never quiet');
  assert.equal(statusWord(null), 'unknown');
  const ceiling = { kind: 'ceiling', bound: 0.8, critical: 0.95, from: 'stated' };
  assert.deepEqual([0.5, 0.8, 0.81, 0.96, null].map((v) => judgeValue(ceiling, v)), ['good', 'good', 'warn', 'bad', 'info']);
  assert.equal(judgeValue({ kind: 'ceiling', bound: 1, from: 'stated' }, 25), 'warn', 'no critical stated: never red');
  const restarts = { kind: 'ceiling', bound: 3, critical: 6, from: 'stated' };
  assert.deepEqual([3.4, 6.2, 6.6].map((v) => judgeValue(restarts, v, 'count')), ['good', 'warn', 'bad'], 'a count judged as the whole number shown');
  const floor = { kind: 'floor', bound: 1, critical: 0.9, from: 'stated' };
  assert.deepEqual([1, 0.95, 0.5].map((v) => judgeValue(floor, v)), ['good', 'warn', 'bad']);
  assert.equal(judgeValue({ kind: 'info' }, 3), 'info');
  assert.equal(jobsRegex(['api', 'a.b', 'x|y', 'api']), 'api|a\\.b|x\\|y', 'each name escaped, once');
  assert.equal(cleanError('metrics_query: MCP HTTP 503 on tools/call: <html> <head><title>503 Service Temporarily Unavailable</title></head> <body> <center><h1>503 Service Temporarily Unavailable</h1></center>'), 'MCP HTTP 503 on tools/call: 503 Service Temporarily Unavailable');
  assert.equal(cleanError('metrics_query: Error: HTTP 422: Unprocessable Entity — http://store.internal:8428/api/v1/query?query=x'), 'HTTP 422: Unprocessable Entity', 'the backend\'s address never reaches the screen');
  assert.equal(cleanError('metrics_query: Post "x": dial tcp 10.0.3.7:8428: connect: connection refused'), 'Post "x": dial to the backend: connect: connection refused', 'no backend address');
  assert.equal(cleanError('metrics_query: dial tcp: lookup victoria.monitoring.svc on 10.96.0.10:53: no such host'), 'dial tcp: lookup of the backend: no such host', 'no host, no resolver');
  assert.equal(cleanError('upstream vm-select.internal:8481 refused; also [fd00::1]:9090 and 192.168.1.4 at 12:30'), 'upstream the backend refused; also the backend and the backend at 12:30', 'a time is not an address');
  assert.equal(cleanError('error code:500 from upstream, line:42'), 'error code:500 from upstream, line:42', 'a word, a colon and a number are not an address');
  assert.equal(cleanError('getaddrinfo ENOTFOUND victoria.monitoring.svc'), 'ENOTFOUND the backend');
  assert.equal(cleanError('connect ECONNREFUSED ::1:8428'), 'connect ECONNREFUSED the backend');
  assert.equal(cleanError('x509: certificate is valid for a.internal, b.internal, not victoria.monitoring.svc'), 'x509: certificate is not valid for the backend');
  assert.equal(cleanError('connect to localhost:9090 failed'), 'connect to the backend failed');
  assert.equal(cleanError('upstream store.acme.cc:8428 refused, query.go:42'), 'upstream the backend refused, query.go:42', 'a host in a country domain is a host; a source file and line is not');
  assert.equal(cleanError('error at line:42, connection to prometheus:9090 failed'), 'error at line:42, connection to the backend failed');
  assert.equal(cleanError(''), 'no answer');
  assert.equal(cleanError('x'.repeat(400)).length, 160);
});

test('incidentsFrom rebuilds incidents from the firing steps: a pause of at most the merge window is one incident at its highest severity, an open one and one begun before the window are marked', () => {
  const step = 120, merge = 300, now = 100_000;
  const pts = (...ts) => ts.map((t) => [t, '1']);
  const series = [
    { metric: { alertname: 'A' }, values: pts(10_000, 10_120, 10_240, 10_480, 20_000) }, // a 120 s pause merges; 20_000 is a new one
    { metric: { alertname: 'B' }, values: pts(99_760, 99_880) }, // still firing at now
    { metric: { alertname: 'C' }, values: pts(1_000, 1_120) }, // at the window's start
    { metric: { alertname: '' }, values: pts(5_000) }, // no name: dropped
    { metric: { alertname: 'D' }, values: [[50_000, '0'], [50_120, 'NaN']] }, // never firing
    // E: one name, two severities. Fired warning, escalated to critical for a step, then warning; a pause
    // of exactly 300 s (gap 420) is the same incident; a pause of 420 s (gap 540) is a new, warning-only one.
    { metric: { alertname: 'E', severity: 'warning' }, values: pts(60_000, 60_120, 60_240, 60_660, 61_200) },
    { metric: { alertname: 'E', severity: 'critical' }, values: pts(60_120) },
    null, 'not a series', { metric: null, values: 'x' }, // malformed: skipped, never thrown on
  ];
  // F: its first step lands 200 s after the history starts (the store's own step alignment): still "before".
  series.push({ metric: { alertname: 'F', severity: 'warning' }, values: pts(1_200, 1_320) });
  const inc = incidentsFrom(series, { stepSeconds: step, mergeSeconds: merge, nowSeconds: now, windowStartSeconds: 1_000, severityOf: (n) => (n === 'A' ? 'critical' : 'warning') });
  assert.deepEqual(inc.map((i) => [i.name, i.start, i.end, i.seconds, i.open, i.before, i.severity]), [
    ['C', 1_000, 1_120, 240, false, true, 'warning'],
    ['F', 1_200, 1_320, 240, false, true, 'warning'],
    ['A', 10_000, 10_480, 600, false, false, 'critical'],
    ['A', 20_000, 20_000, 120, false, false, 'critical'],
    ['E', 60_000, 60_660, 780, false, false, 'critical'],
    ['E', 61_200, 61_200, 120, false, false, 'warning'],
    ['B', 99_760, 99_880, 240, true, false, 'warning'],
  ]);
});

test('timingSummary: the median and p95 of the closed incidents, nothing below the minimum, by severity, the busiest alert, the open ones apart', () => {
  const mk = (name, seconds, extra = {}) => ({ name, severity: 'warning', start: 0, end: 0, seconds, open: false, before: false, ...extra });
  const closed = [mk('A', 120), mk('A', 120), mk('A', 240), mk('A', 600), mk('B', 3600, { severity: 'critical' }), mk('A', 120)];
  const notices = [mk('N', 60, { severity: 'info' }), mk('N', 60, { severity: 'info' }), mk('N', 60, { severity: 'info' })];
  const s = timingSummary([...closed, ...notices, mk('C', 9e6, { open: true, start: 1_790_000_000 }), mk('D', 500, { before: true })], { minIncidents: 5 });
  assert.deepEqual([s.incidents, s.closed, s.notices, s.tooFew, s.medianSeconds, s.p95Seconds], [11, 6, 3, false, 120, 3600], 'nearest rank: the third of six, the sixth of six; the info notices apart');
  assert.deepEqual(s.bySeverity, { critical: { closed: 1, medianSeconds: null, longestSeconds: 3600 }, warning: { closed: 5, medianSeconds: 120, longestSeconds: 600 } }, 'a severity\'s median only from the minimum up');
  assert.deepEqual(s.busiest, { name: 'A', incidents: 5 }, 'a notice is never the busiest alert');
  assert.deepEqual(s.open, [{ name: 'C', severity: 'warning', since: new Date(1_790_000_000 * 1000).toISOString(), began: null }]);
  assert.deepEqual([s.before, s.beforeNames], [1, ['D']], 'begun before the window: counted and named apart, never in the figure');
  const few = timingSummary(closed.slice(0, 3), { minIncidents: 5 });
  assert.deepEqual([few.tooFew, few.medianSeconds, few.p95Seconds, few.closed], [true, null, null, 3], 'too few: no figure at all');
});

test('the families a downstream adds: a row with a built-in id replaces it, a new one is added, a bad one is dropped with a warning, and the built-in rows are untouched', () => {
  const own = {
    id: 'example-queue', title: 'Example queue', layer: 'platform',
    variants: [{ requires: ['example_queue_depth'], tiles: [{ id: 'depth', label: 'Deepest queue', unit: 'count', expr: 'max(example_queue_depth)', judge: { kind: 'ceiling', bound: 100, from: 'stated' } }], chart: null }],
  };
  const http = { ...own, id: 'http', title: 'HTTP, our way' };
  const bad = { id: 'Bad Id', title: '', layer: 'moon', variants: [] };
  const { families, warnings } = controlRoomFamilies({ families: [own, http, bad, { ...own, id: 'noexpr', variants: [{ ...own.variants[0], tiles: [{ ...own.variants[0].tiles[0], expr: 'a\nb' }] }] }] });
  assert.equal(families.find((f) => f.id === 'http').title, 'HTTP, our way');
  assert.equal(families.at(-1).id, 'example-queue');
  assert.equal(families.length, CONTROL_ROOM_FAMILIES.length + 1);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /^family Bad Id: id is not a lower-case slug of at most 40 characters; dropped\.$/);
  assert.match(warnings[1], /^family noexpr: variants\[0\]\.tiles\[0\]\.expr is not one line of PromQL/);
  assert.equal(CONTROL_ROOM_FAMILIES.find((f) => f.id === 'http').title, 'HTTP traffic', 'the built-in table is not changed');
  assert.deepEqual(controlRoomFamilies(null).warnings, []);
  assert.match(controlRoomFamilies({ rows: [] }).warnings[0], /holds no "families" list/);
  assert.deepEqual(familyRowErrors({ ...own, variants: [{ ...own.variants[0], tiles: [{ ...own.variants[0].tiles[0], judge: { kind: 'ceiling', bound: 'x' } }] }] }),
    ['variants[0].tiles[0].judge needs a numeric bound (and critical, when given) and a "from" naming its source']);
  assert.ok(detectionQuery(families).startsWith('count by (__name__) ({__name__=~"'), 'one query finds which families are exposed');
  assert.ok(detectionQuery(families).includes('example_queue_depth'));
  const exposed = new Set(['http_requests_total', 'http_request_duration_seconds_bucket']);
  assert.deepEqual(pickVariant(CONTROL_ROOM_FAMILIES[0], exposed)?.requires, ['http_requests_total', 'http_request_duration_seconds_bucket'], 'the first variant whose names are all exposed');
  assert.equal(pickVariant(CONTROL_ROOM_FAMILIES[0], new Set(['http_requests_total'])), null, 'one name of two: not exposed');
});

// A fake query tool: a map from a query (or a test on it) to an answer, recording every query and the most
// queries in flight at once.
function fakeTool(answers) {
  const seen = [];
  let inFlight = 0, most = 0;
  const callTool = async (name, args) => {
    seen.push({ name, query: args.query });
    inFlight += 1; most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight -= 1;
    for (const [match, answer] of answers) {
      if (typeof match === 'string' ? args.query === match : match.test(args.query)) {
        if (answer instanceof Error) throw answer;
        return typeof answer === 'function' ? answer(args.query) : answer;
      }
    }
    return { result: [] };
  };
  return { callTool, seen, most: () => most };
}
const vec = (...rows) => ({ resultType: 'vector', result: rows.map(([metric, v]) => ({ metric, value: [0, String(v)] })) });

test('readControlRoom: the alerts now, the targets up (and the declared jobs\'), the incidents, the families — each with its outcome, two queries at a time, the tool named by its capability', async () => {
  const now = 1_800_000_000;
  const step = CONTROL_ROOM_LIMITS.stepSeconds;
  const windowStart = now - 30 * 86400;
  const history = { resultType: 'matrix', result: [
    { metric: { alertname: 'Flappy', severity: 'warning' }, values: Array.from({ length: 6 }, (_, i) => [now - 86400 * (i + 1), '1']) },
    { metric: { alertname: 'Stuck', severity: 'critical' }, values: [[now - 2 * step, '1'], [now - step, '1']] },
    // Three hours into the window: inside it, never "before the history" (the store keeps all 30 days).
    { metric: { alertname: 'Early', severity: 'warning' }, values: [[windowStart + 3 * 3600, '1']] },
  ] };
  const fake = fakeTool([
    [/^count by \(__name__\)/, vec([{ __name__: 'http_requests_total' }, 1], [{ __name__: 'http_request_duration_seconds_bucket' }, 1])],
    // A pending critical instance of Odd never makes its firing row, or the status, critical.
    ['count by (alertname, severity, alertstate) (ALERTS)', vec(
      [{ alertname: 'Stuck', severity: 'critical', alertstate: 'firing' }, 2], [{ alertname: 'Slow', severity: 'warning', alertstate: 'pending' }, 1],
      [{ alertname: 'Odd', severity: 'sev-a', alertstate: 'firing' }, 1], [{ alertname: 'Odd', severity: 'critical', alertstate: 'pending' }, 1],
    )],
    // Each state its own age: Odd's pending instance is 30 s old, never its firing one's age.
    ['min by (alertname, alertstate) (ALERTS_FOR_STATE * ignoring(alertstate) group_left(alertstate) ALERTS)', vec(
      [{ alertname: 'Stuck', alertstate: 'firing' }, now - 600], [{ alertname: 'Odd', alertstate: 'firing' }, now - 7200], [{ alertname: 'Odd', alertstate: 'pending' }, now - 30],
    )],
    ['count(up)', vec([{}, 10])], ['sum(up)', vec([{}, 9])], ['count by (job) (up == 0)', vec([{ job: 'batch' }, 1])],
    [/^sum by \(job\) \(up\{job=~/, vec([{ job: 'api' }, 1], [{ job: 'a.b' }, 0], [{ job: 'half' }, 0.5])],
    [/^max by \(alertname, severity\) \(ALERTS\{alertstate="firing"\}\)\[30d:2m\]$/, history],
    // The probe's first 6-hour point, as a store keeping more than 30 days answers it: just after the window opens.
    [/^min\(min_over_time\(timestamp\(up\)\[30d:6h\]\)\)$/, vec([{}, Math.ceil(windowStart / 21600) * 21600 - 15])],
    // The second probe, over the window's first 6 hours at the history's step: data from its first step.
    ['min(min_over_time(timestamp(up)[6h:2m] offset 714h))', vec([{}, windowStart + 60])],
    ['sum(rate(http_requests_total[5m]))', vec([{}, 12.5])],
    [/http_requests_total\{status_code=~"5\.\."\}/, new Error('metrics_query: HTTP 422: Unprocessable Entity — http://store.internal/api')],
    [/histogram_quantile/, { result: [] }],
    [/\[6h:10m\]$/, { resultType: 'matrix', result: [{ metric: {}, values: [[now - 600, '10'], [now, '12']] }] }],
  ]);
  const r = await readControlRoom({ callTool: fake.callTool, tool: capabilityTool('control_room_query'), declaredJobs: ['api', 'a.b', 'half', 'gone'], nowSeconds: now });
  assert.ok(fake.seen.every((c) => c.name === capabilityTool('control_room_query')), 'every query through the capability\'s tool');
  assert.ok(fake.most() <= CONTROL_ROOM_LIMITS.concurrency, `at most ${CONTROL_ROOM_LIMITS.concurrency} at once (${fake.most()})`);
  assert.ok(fake.seen.some((c) => c.query === 'sum by (job) (up{job=~"api|a\\\\.b|half|gone"}) / count by (job) (up{job=~"api|a\\\\.b|half|gone"})'), 'the declared jobs, escaped, the only request data in a query');
  assert.ok(!fake.seen.some((c) => c.query.startsWith('count(last_over_time(ALERTS')), 'alerts firing: no evidence query needed');
  // Alerts: firing and pending apart, an unknown severity said as its own label.
  assert.deepEqual(r.alerts.bySeverity, { critical: 1, warning: 0, info: 0, other: 1 });
  assert.equal(r.alerts.pending, 2);
  assert.equal(r.alerts.evidence, true);
  assert.deepEqual(r.alerts.otherSeverities, ['sev-a']);
  assert.deepEqual(r.alerts.active.map((a) => [a.name, a.state, a.severity, a.instances, a.seconds]),
    [['Odd', 'firing', 'other', 1, 7200], ['Stuck', 'firing', 'critical', 2, 600], ['Odd', 'pending', 'critical', 1, 30], ['Slow', 'pending', 'warning', 1, null]].sort((x, y) => (x[1] === y[1] ? 0 : x[1] === 'firing' ? -1 : 1) || ({ critical: 0, warning: 1, other: 2 }[x[2]] - { critical: 0, warning: 1, other: 2 }[y[2]])),
    'each state with its own age');
  assert.ok(!fake.seen.some((c) => c.query === 'min by (alertname) (ALERTS_FOR_STATE)'), 'the join answered: no fallback');
  // Scrape, and the declared jobs: a job is up only when all its targets are.
  assert.deepEqual([r.scrape.outcome, r.scrape.up, r.scrape.total, r.scrape.downJobs], ['data', 9, 10, ['batch']]);
  assert.deepEqual(r.scrape.declared, { outcome: 'data', jobs: 4, up: 1, partly: ['half'], partlyCount: 1, down: ['a.b'], downCount: 1, missing: ['gone'], missingCount: 1, cut: 0 });
  // Timing: the history read through its own client when given one.
  assert.equal(r.timing.outcome, 'data');
  assert.deepEqual([r.timing.incidents, r.timing.closed, r.timing.tooFew, r.timing.medianSeconds], [8, 7, false, step], 'seven one-step incidents closed (the early one too), one open');
  assert.deepEqual(r.timing.open.map((o) => o.name), ['Stuck']);
  assert.equal(r.timing.before, 0, 'an incident three hours into a fully kept window is not "before the history"');
  assert.equal(r.timing.busiest.name, 'Flappy');
  assert.equal(r.timing.coversDays, 30, 'history older than the window: the window');
  assert.equal(r.timing.historyFrom, new Date(windowStart * 1000).toISOString());
  // Families: the HTTP one, a tile failed (its error cleaned), one empty, the chart read.
  assert.equal(r.families.rows.length, 1);
  const http = r.families.rows[0];
  assert.deepEqual(http.tiles.map((t) => [t.id, t.outcome, t.value, t.tone]), [['rate', 'data', 12.5, 'info'], ['errors', 'failed', null, 'info'], ['p99', 'empty', null, 'info']]);
  assert.equal(http.tiles[1].reason, 'HTTP 422: Unprocessable Entity');
  assert.deepEqual([http.chart.outcome, http.chart.points.length], ['data', 2]);
  assert.equal(r.absent.length, CONTROL_ROOM_FAMILIES.length - 1, 'the others named once as not exposed');
  assert.ok(r.calls.made <= r.calls.budget);
});

test('readControlRoom: a budget too small leaves parts not attempted, never zero; a transport hook fault is thrown; timing: false reads no history', async () => {
  const fake = fakeTool([['count(up)', vec([{}, 3])], ['sum(up)', vec([{}, 3])]]);
  const tight = await readControlRoom({ callTool: fake.callTool, tool: 'q', nowSeconds: 1e9, limits: { maxCalls: 3 } });
  assert.ok(fake.seen.length <= 3);
  const parts = [tight.alerts, tight.scrape, tight.timing, tight.families];
  assert.ok(parts.some((p) => p.outcome === 'not-attempted'), 'past the budget: not attempted');
  // The targets up, never read: null with its reason, never 0 up.
  const noSum = fakeTool([['count(up)', vec([{}, 48])], ['sum(up)', new Error('metrics_query: HTTP 503')]]);
  const half = await readControlRoom({ callTool: noSum.callTool, tool: 'q', nowSeconds: 1e9 });
  assert.deepEqual([half.scrape.outcome, half.scrape.total, half.scrape.up, half.scrape.upReason], ['data', 48, null, 'HTTP 503'], 'a failed sum(up) is "not read", never 0 of 48');
  const cut = fakeTool([['count(up)', vec([{}, 48])], ['sum(up)', vec([{}, 47])]]);
  const late = await readControlRoom({ callTool: cut.callTool, tool: 'q', nowSeconds: 1e9, limits: { maxCalls: 4 } });
  assert.notEqual(late.scrape.up, 0, 'cut by the budget: never 0');
  const hook = Object.assign(new Error('hook says no'), { name: 'TransportHookError' });
  await assert.rejects(readControlRoom({ callTool: async () => { throw hook; }, tool: 'q', nowSeconds: 1e9 }), /hook says no/);
  const noHistory = fakeTool([]);
  const r = await readControlRoom({ callTool: noHistory.callTool, tool: 'q', nowSeconds: 1e9, timing: false });
  assert.equal(r.timing, null);
  assert.ok(!noHistory.seen.some((c) => c.query.includes('ALERTS{alertstate="firing"})[')), 'no history query');
  const all = fakeTool([[/./, new Error('down')]]);
  const failed = await readControlRoom({ callTool: all.callTool, tool: 'q', nowSeconds: 1e9 });
  assert.deepEqual([failed.alerts.outcome, failed.scrape.outcome, failed.timing.outcome, failed.families.outcome], ['failed', 'failed', 'failed', 'failed']);
  assert.equal(statusWord(failed.alerts), 'unknown');
});

test('readControlRoom: nothing firing is quiet only where the store holds an alert history, asked once; a history start not read is no 30-day claim', async () => {
  const now = 1_800_000_000;
  // No ALERTS series in the window at all: not quiet, and nothing to time.
  const blank = fakeTool([['count(up)', vec([{}, 3])], ['sum(up)', vec([{}, 3])], [/^count\(last_over_time\(ALERTS\[30d\]\)\)$/, { result: [] }]]);
  const unwatched = await readControlRoom({ callTool: blank.callTool, tool: 'q', nowSeconds: now });
  assert.deepEqual([unwatched.alerts.outcome, unwatched.alerts.evidence, statusWord(unwatched.alerts)], ['empty', false, 'unknown']);
  assert.deepEqual([unwatched.timing.outcome, unwatched.timing.evidence, unwatched.timing.reason], ['empty', false, 'the store shows no alert history']);
  assert.equal(blank.seen.filter((c) => c.query.startsWith('count(last_over_time(ALERTS')).length, 1, 'the evidence asked once for both parts');
  assert.equal(unwatched.timing.coversDays, null, 'how far back the store keeps data was not read: no window claimed');
  // ALERTS seen in the window: quiet, and "no alert fired" is a finding.
  const kept = fakeTool([[/^count\(last_over_time\(ALERTS\[30d\]\)\)$/, vec([{}, 4])]]);
  const quiet = await readControlRoom({ callTool: kept.callTool, tool: 'q', nowSeconds: now });
  assert.deepEqual([quiet.alerts.evidence, statusWord(quiet.alerts), quiet.timing.reason], [true, 'quiet', 'no alert fired in the window']);
  // The history start not read: the matrix's own first step stands in, so an incident there is "before".
  const step = CONTROL_ROOM_LIMITS.stepSeconds;
  const unknownStart = fakeTool([
    [/^max by \(alertname, severity\)/, { result: [
      { metric: { alertname: 'Old', severity: 'warning' }, values: [[now - 20 * 86400, '1'], [now - 20 * 86400 + step, '1']] },
      ...Array.from({ length: 5 }, (_, i) => ({ metric: { alertname: `New${i}`, severity: 'warning' }, values: [[now - 86400 * (i + 1), '1']] })),
    ] }],
    [/^min\(min_over_time/, new Error('down')],
  ]);
  const t = (await readControlRoom({ callTool: unknownStart.callTool, tool: 'q', nowSeconds: now })).timing;
  assert.deepEqual([t.outcome, t.coversDays, t.historyFrom, t.before, t.beforeNames, t.closed], ['data', null, null, 1, ['Old'], 5]);
});

test('readControlRoom: the firing history through its own client; malformed answers fail no part; an abort refuses what is queued and fails the read', async () => {
  const now = 1_800_000_000;
  const main = fakeTool([
    ['count(up)', { result: [null, 'x', { metric: null, value: 'bad' }, { metric: {}, value: [0, '5'] }] }],
    ['sum(up)', vec([{}, 5])],
    ['count by (alertname, severity, alertstate) (ALERTS)', { result: [null, { metric: 'x' }, { metric: { alertname: 'A', alertstate: 'firing', severity: 'warning' }, value: [0, '1'] }] }],
    [/^count by \(__name__\)/, vec([{ __name__: 'http_requests_total' }, 1], [{ __name__: 'http_request_duration_seconds_bucket' }, 1])],
    [/\[6h:10m\]$/, { result: [{ metric: {}, values: [null, 'x', [now, '1'], [now - 600, '2']] }] }],
  ]);
  const history = fakeTool([[/^max by \(alertname, severity\)/, { result: [{ metric: { alertname: 'A', severity: 'warning' }, values: [[now - 2 * CONTROL_ROOM_LIMITS.stepSeconds, '1']] }] }]]);
  const r = await readControlRoom({ callTool: main.callTool, callHistoryTool: history.callTool, tool: 'q', nowSeconds: now });
  assert.ok(!main.seen.some((c) => c.query.includes('ALERTS{alertstate="firing"})[')), 'the history never through the small client');
  assert.equal(history.seen.length, 1, 'and once through its own');
  assert.deepEqual([r.scrape.outcome, r.scrape.total, r.alerts.outcome, r.alerts.active.length, r.families.outcome], ['data', 5, 'data', 1, 'data'], 'malformed entries skipped');
  assert.equal(r.families.rows[0].chart.points.length, 2);
  // An abort mid-read (the route's deadline): the parts already read are kept, the others said as out of
  // time, and what was still queued never reaches the endpoint.
  const ac = new AbortController();
  let calls = 0;
  const slow = async (name, { query }) => {
    calls += 1;
    if (query === 'count(up)') return vec([{}, 4]);
    if (query === 'sum(up)' || query === 'count by (job) (up == 0)') return vec([{}, 4]);
    if (calls >= 6) ac.abort(new Error('deadline'));
    await new Promise((res) => setTimeout(res, 5));
    if (ac.signal.aborted) throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    return { result: [] };
  };
  const cut = await readControlRoom({ callTool: slow, tool: 'q', nowSeconds: now, signal: ac.signal });
  assert.equal(cut.calls.outOfTime, true);
  assert.deepEqual([cut.scrape.outcome, cut.scrape.total], ['data', 4], 'read before the cut: kept');
  assert.ok([cut.alerts, cut.timing, cut.families].some((p) => p.outcome === 'not-attempted' && p.reason === 'the read ran out of time'), 'cut: out of time');
  assert.ok(calls <= 6 + CONTROL_ROOM_LIMITS.concurrency, `queued reads refused on the abort (${calls} made)`);
  // A heartbeat notice firing for ever is no "before the history" incident and no last firing.
  const beat = timingSummary([{ name: 'Watchdog', severity: 'info', start: 0, end: 100, seconds: 220, open: true, before: true }, { name: 'Disk', severity: 'warning', start: 50, end: 80, seconds: 150, open: false, before: false }]);
  assert.deepEqual([beat.before, beat.beforeNames, beat.lastFiredAt, beat.open.map((o) => o.severity)], [0, [], new Date(80 * 1000).toISOString(), ['info']]);
});

test('readControlRoom: a store keeping 21 days, the alert ages by name when the join fails, the status before the tiles, a transport hook fault stopping every queued read', async () => {
  const now = 1_800_000_000;
  const step = CONTROL_ROOM_LIMITS.stepSeconds;
  // 21 days kept: the window is what the store keeps, and an incident at its first step began before it.
  const from = now - 21 * 86400;
  const kept = fakeTool([
    [/^min\(min_over_time\(timestamp\(up\)\[30d:6h\]\)\)$/, vec([{}, from])],
    [/^max by \(alertname, severity\)/, { result: [
      { metric: { alertname: 'Cut', severity: 'warning' }, values: [[from, '1'], [from + step, '1']] },
      ...Array.from({ length: 5 }, (_, i) => ({ metric: { alertname: `N${i}`, severity: 'warning' }, values: [[now - 86400 * (i + 1), '1']] })),
    ] }],
  ]);
  const t = (await readControlRoom({ callTool: kept.callTool, tool: 'q', nowSeconds: now })).timing;
  assert.deepEqual([Math.round(t.coversDays), t.historyFrom, t.before, t.beforeNames, t.closed], [21, new Date(from * 1000).toISOString(), 1, ['Cut'], 5]);
  assert.ok(!kept.seen.some((c) => c.query.includes('offset 714h')), 'a start well inside the window: no second probe');
  // The join fails: ages by name, a pending twin of a firing name gets none.
  const byName = fakeTool([
    ['count by (alertname, severity, alertstate) (ALERTS)', vec([{ alertname: 'Disk', severity: 'warning', alertstate: 'firing' }, 1], [{ alertname: 'Disk', severity: 'warning', alertstate: 'pending' }, 1], [{ alertname: 'Cpu', severity: 'warning', alertstate: 'pending' }, 1])],
    [/group_left/, new Error('metrics_query: HTTP 422: group_left not supported')],
    ['min by (alertname) (ALERTS_FOR_STATE)', vec([{ alertname: 'Disk' }, now - 10800], [{ alertname: 'Cpu' }, now - 30])],
  ]);
  const a = (await readControlRoom({ callTool: byName.callTool, tool: 'q', nowSeconds: now })).alerts;
  assert.deepEqual(a.active.map((r) => [r.name, r.state, r.seconds]), [['Disk', 'firing', 10800], ['Cpu', 'pending', 30], ['Disk', 'pending', null]].sort((x, y) => (x[1] === y[1] ? 0 : x[1] === 'firing' ? -1 : 1) || (y[2] ?? 0) - (x[2] ?? 0)));
  // The status, the targets and the history are asked before any family tile.
  const lanes = fakeTool([[/^count by \(__name__\)/, vec([{ __name__: 'http_requests_total' }, 1], [{ __name__: 'http_request_duration_seconds_bucket' }, 1])]]);
  await readControlRoom({ callTool: lanes.callTool, tool: 'q', nowSeconds: now });
  const at = (pred) => lanes.seen.findIndex((c) => pred(c.query));
  const firstTile = at((q) => q.includes('http_requests_total[5m]'));
  assert.ok(at((q) => q.startsWith('count(last_over_time(ALERTS')) < firstTile, 'the evidence before the tiles');
  assert.ok(at((q) => q.includes('[30d:2m]')) < firstTile, 'the history before the tiles');
  // A transport hook fault: the read fails, and nothing queued after it reaches the endpoint.
  let made = 0;
  const hook = Object.assign(new Error('token service 503'), { name: 'TransportHookError' });
  const faulty = async () => { made += 1; await new Promise((r) => setTimeout(r, 2)); if (made === 2) throw hook; return { result: [] }; };
  await assert.rejects(readControlRoom({ callTool: faulty, tool: 'q', nowSeconds: now }), /token service 503/);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(made <= 2 + CONTROL_ROOM_LIMITS.concurrency, `the pool stopped at the fault (${made} calls)`);
  // Cut while a follow-up runs (the ages by name, after the join failed): the alert states already read stand.
  const ac = new AbortController();
  const late = async (name, { query }) => {
    if (query === 'count by (alertname, severity, alertstate) (ALERTS)') return vec([{ alertname: 'ShopDown', severity: 'critical', alertstate: 'firing' }, 1]);
    if (query.includes('group_left')) throw new Error('HTTP 422: group_left not supported');
    if (query === 'min by (alertname) (ALERTS_FOR_STATE)') { ac.abort(new Error('deadline')); throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }); }
    await new Promise((r) => setTimeout(r, 20));
    return { result: [] };
  };
  const stood = await readControlRoom({ callTool: late, tool: 'q', nowSeconds: now, signal: ac.signal });
  assert.deepEqual([stood.alerts.outcome, stood.alerts.bySeverity.critical, statusWord(stood.alerts), stood.alerts.active[0].seconds], ['data', 1, 'critical', null], 'a critical alert read before the cut is said as critical, its age unknown');
  // A history start not read: the start is the history's own first step, with no slack for the store's alignment.
  const own = fakeTool([
    [/^max by \(alertname, severity\)/, { result: [
      { metric: { alertname: 'ServiceDown', severity: 'critical' }, values: [[now - 20 * 86400, '1'], [now - 20 * 86400 + step, '1']] },
      { metric: { alertname: 'HighErrorRate', severity: 'warning' }, values: [[now - 20 * 86400 + 240, '1']] },
    ] }],
    [/^min\(min_over_time/, new Error('HTTP 503')],
  ]);
  const ownT = (await readControlRoom({ callTool: own.callTool, tool: 'q', nowSeconds: now })).timing;
  assert.deepEqual([ownT.before, ownT.beforeNames], [1, ['ServiceDown']], 'an alert 4 minutes into the history began inside it');
});

test('openControlRoom: an answer past its cap fails that part, said; end() sends each session\'s DELETE once, even after a cut', async () => {
  const requests = [];
  let session = 0;
  const fetchImpl = async (url, init) => {
    const msg = init.body ? JSON.parse(init.body) : null;
    requests.push({ method: init.method, rpc: msg?.method || null, session: init.headers['Mcp-Session-Id'] || null });
    if (init.method === 'DELETE') return new Response(null, { status: 405 });
    const headers = { 'Content-Type': 'application/json', 'Mcp-Session-Id': msg.method === 'initialize' ? `s${++session}` : init.headers['Mcp-Session-Id'] };
    if (msg.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }), { headers });
    if (msg.method === 'notifications/initialized') return new Response(null, { status: 202, headers });
    if (msg.method === 'tools/list') return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: capabilityTool('control_room_query') }] } }), { headers });
    const big = msg.params.arguments.query.includes('[30d:2m]');
    const text = JSON.stringify({ resultType: 'vector', result: big ? Array.from({ length: 400 }, (_, i) => ({ metric: { alertname: `A${i}` }, values: [[1, '1']] })) : [] });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } }), { headers });
  };
  const ac = new AbortController();
  const room = await openControlRoom({ mcpUrl: 'https://mcp.example.test/mcp', transport: { fetchImpl }, signal: ac.signal, limits: { answerBytes: 64 * 1024, historyAnswerBytes: 8 * 1024 } });
  assert.equal(room.advertised, true);
  const r = await readControlRoom({ callTool: room.callTool, callHistoryTool: room.callHistoryTool, tool: room.tool, nowSeconds: 1e9 });
  assert.equal(r.timing.outcome, 'failed');
  assert.match(r.timing.reason, /the answer exceeded 8 KiB/, 'the history past its own cap: that part fails, said');
  ac.abort(new Error('deadline'));
  await room.end();
  const deletes = requests.filter((q) => q.method === 'DELETE');
  assert.deepEqual(deletes.map((d) => d.session).sort(), ['s1', 's2'], 'both sessions ended, after the cut too');
  await room.end();
  assert.equal(requests.filter((q) => q.method === 'DELETE').length, 2, 'once each');
  await assert.rejects(room.callHistoryTool(room.tool, { query: 'up' }), /the read has ended/, 'no new session after end');
  // A tools/list that fails after initialize: the session it opened is ended, not left.
  requests.length = 0;
  const broken = async (url, init) => {
    const msg = init.body ? JSON.parse(init.body) : null;
    if (msg?.method === 'tools/list') return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: 'nope' } }), { headers: { 'Content-Type': 'application/json' } });
    return fetchImpl(url, init);
  };
  await assert.rejects(openControlRoom({ mcpUrl: 'https://mcp.example.test/mcp', transport: { fetchImpl: broken } }), /tools\/list/);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(requests.filter((q) => q.method === 'DELETE').map((q) => q.session), ['s3'], 'its session ended');
  // The history client still opening (its initialize held): the main session's end does not wait on it.
  requests.length = 0;
  let initCount = 0;
  const holding = async (url, init) => {
    const msg = init.body ? JSON.parse(init.body) : null;
    if (msg?.method === 'initialize' && ++initCount === 2) return new Promise(() => {});
    return fetchImpl(url, init);
  };
  const r2 = await openControlRoom({ mcpUrl: 'https://mcp.example.test/mcp', transport: { fetchImpl: holding } });
  r2.callHistoryTool(r2.tool, { query: 'x' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  await Promise.race([r2.end(), new Promise((r) => setTimeout(r, 200))]);
  assert.equal(requests.filter((q) => q.method === 'DELETE').length, 1, 'the main session ended, the history one still opening');
});

// ---------- the scope: a service's own series ----------

// The metric names an expression reads: every name outside strings, matchers, by / without / on lists,
// ranges and function calls — each must carry the scope's matcher.
const PROMQL_WORDS = new Set(['sum', 'rate', 'irate', 'increase', 'by', 'without', 'histogram_quantile', 'or', 'and', 'unless', 'on', 'ignoring', 'group_left', 'group_right', 'offset', 'bool', 'max', 'min', 'avg', 'count', 'topk', 'bottomk', 'clamp_min', 'clamp_max', 'abs', 'time', 'vector', 'scalar', 'label_replace', 'max_over_time', 'min_over_time', 'avg_over_time', 'sum_over_time', 'last_over_time', 'delta', 'deriv', 'changes', 'resets', 'absent', 'count_over_time', 'quantile', 'stddev', 'round', 'ceil', 'floor', 'sort', 'timestamp']);
function unscopedNames(out, matcher) {
  const bare = out.replace(/"[^"]*"/g, (q) => '_'.repeat(q.length));
  const missed = [];
  for (const m of bare.matchAll(/[a-zA-Z_:][a-zA-Z0-9_:]*/g)) {
    const w = m[0];
    const head = bare.slice(0, m.index);
    if (PROMQL_WORDS.has(w) || /[0-9.]$/.test(head)) continue;
    if (/^\s*\(/.test(bare.slice(m.index + w.length))) continue;
    if ((head.match(/\{/g) || []).length > (head.match(/\}/g) || []).length) continue;
    if (/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*$/.test(head) || /\[[^\]]*$/.test(head)) continue;
    if (!out.slice(m.index + w.length).startsWith('{' + matcher)) missed.push(w);
  }
  return missed;
}

test('scopeSelectors: the job matcher on every selector of every built-in family\'s tile and chart, nothing else changed; keywords, functions, by-lists, ranges, durations and strings left as they are', () => {
  const M = 'job=~"api|db"';
  let n = 0;
  for (const f of CONTROL_ROOM_FAMILIES) for (const v of f.variants) for (const e of [...v.tiles.map((t) => t.expr), v.chart?.expr].filter(Boolean)) {
    n += 1;
    const out = scopeSelectors(e, M);
    assert.deepEqual(unscopedNames(out, M), [], `${f.id}: ${out}`);
    assert.equal(out.split('{' + M + ', ').join('{').split('{' + M + '}').join(''), e, `${f.id}: only the matcher added`);
  }
  assert.ok(n > 40, 'every built-in expression');
  // The small cases: an aggregation written with by / without before its argument, offset, bool, a
  // nameless selector, a string that looks like a name, an empty matcher.
  assert.equal(scopeSelectors('histogram_quantile(0.99, sum by (le) (rate(x_bucket{a="b"}[5m]))) > bool 0', M), 'histogram_quantile(0.99, sum by (le) (rate(x_bucket{job=~"api|db", a="b"}[5m]))) > bool 0');
  assert.equal(scopeSelectors('max without (pod) (y) offset 5m', M), 'max without (pod) (y{job=~"api|db"}) offset 5m');
  assert.equal(scopeSelectors('{__name__=~"a|b"}', M), '{job=~"api|db", __name__=~"a|b"}');
  assert.equal(scopeSelectors('label_replace(up, "dst", "$1", "src", "(.*)") * on (job) group_left(team) team_info{}', M), 'label_replace(up{job=~"api|db"}, "dst", "$1", "src", "(.*)") * on (job) group_left(team) team_info{job=~"api|db"}');
  assert.equal(scopeSelectors('rate(a[5m]) / 1e3', M), 'rate(a{job=~"api|db"}[5m]) / 1e3');
  assert.equal(scopeSelectors('sum(x)', ''), 'sum(x)', 'no matcher: as it was');
});

test('scopeQueries: the alerts a service names or that fire on its jobs, each selector apart; jobs alone, alerts alone, neither; cut at the limits and said', () => {
  const S = scopeQueries({ jobs: ['kx-b', 'a.c', 'kx-b', ''], alerts: ['Up', 'Down'] });
  assert.deepEqual([S.jobs, S.alerts, S.job, S.empty, S.cut], [['a.c', 'kx-b'], ['Down', 'Up'], 'job=~"a\\\\.c|kx-b"', false, { jobs: 0, alerts: 0 }], 'sorted, each once, escaped');
  // A named alert is the service's on its jobs (the job arm) or with no job at all: another service's alert of the same name, on its own job, is not.
  assert.equal(S.alertsSel(), '(ALERTS{alertname=~"Down|Up", job=""} or ALERTS{job=~"a\\\\.c|kx-b"})');
  assert.deepEqual(S.alertsParts('alertstate="firing"'), ['ALERTS{alertstate="firing", alertname=~"Down|Up", job=""}', 'ALERTS{alertstate="firing", job=~"a\\\\.c|kx-b"}']);
  assert.equal(S.forStateSel(), '(ALERTS_FOR_STATE{alertname=~"Down|Up", job=""} or ALERTS_FOR_STATE{job=~"a\\\\.c|kx-b"})');
  assert.deepEqual([scopeQueries({ jobs: ['api'] }).alertsSel(), scopeQueries({ alerts: ['X'] }).alertsSel(), scopeQueries({ alerts: ['X'] }).job], ['ALERTS{job=~"api"}', 'ALERTS{alertname=~"X"}', '']);
  const none = scopeQueries({ jobs: [], alerts: [] });
  assert.deepEqual([none.empty, none.alertsSel(), none.forStateSel()], [true, null, null]);
  const cut = scopeQueries({ jobs: ['a', 'b', 'c'], alerts: ['x', 'y'] }, { declaredJobs: 2, declaredAlerts: 1 });
  assert.deepEqual([cut.jobs, cut.alerts, cut.cut], [['a', 'b'], ['x'], { jobs: 1, alerts: 1 }]);
});

test('readControlRoom with a scope: only the service\'s alerts, history, targets and families are asked for; nothing named reads nothing; no jobs reads no targets and no metrics', async () => {
  const now = 1_800_000_000;
  const sel = '(ALERTS{alertname=~"ShopDown", job=""} or ALERTS{job=~"shop"})';
  const fake = fakeTool([
    [`count by (alertname, severity, alertstate) (${sel})`, vec([{ alertname: 'ShopDown', severity: 'critical', alertstate: 'firing' }, 1])],
    ['count(up{job=~"shop"})', vec([{}, 2])], ['sum(up{job=~"shop"})', vec([{}, 2])],
    [/^count by \(__name__\) \(\{__name__=~"[^"]*", job=~"shop"\}\)$/, vec([{ __name__: 'http_requests_total' }, 1], [{ __name__: 'http_request_duration_seconds_bucket' }, 1])],
  ]);
  const r = await readControlRoom({ callTool: fake.callTool, tool: 'q', nowSeconds: now, scope: { jobs: ['shop'], alerts: ['ShopDown'] }, declaredJobs: ['ignored-with-a-scope'] });
  assert.deepEqual(r.scope, { kind: 'service', jobs: 1, alerts: 1, cut: { jobs: 0, alerts: 0 } });
  assert.deepEqual(r.alerts.active.map((a) => a.name), ['ShopDown']);
  assert.deepEqual([r.scrape.up, r.scrape.total, r.scrape.declared.jobs], [2, 2, 1]);
  const asked = fake.seen.map((c) => c.query);
  assert.ok(asked.includes('max by (alertname, severity) ((ALERTS{alertstate="firing", alertname=~"ShopDown", job=""} or ALERTS{alertstate="firing", job=~"shop"}))[30d:2m]'), 'the history of its own alerts');
  assert.ok(asked.includes('sum(rate(http_requests_total{job=~"shop"}[5m]))'), 'its families from its jobs\' series');
  assert.deepEqual(asked.filter((q) => /\b(ALERTS|ALERTS_FOR_STATE)\b(?!\{)/.test(q) || /\bup\b(?!\{)/.test(q.replace(/timestamp\(up\)/g, ''))), [], 'nothing of another service: only the store\'s age reads the whole up');
  assert.ok(!asked.some((q) => q.includes('ignored-with-a-scope')), 'the scope\'s jobs, not declaredJobs');
  // Nothing named: no call at all, every part said why.
  const silent = fakeTool([]);
  const none = await readControlRoom({ callTool: silent.callTool, tool: 'q', nowSeconds: now, scope: { jobs: [], alerts: [] } });
  assert.equal(silent.seen.length, 0, 'nothing asked');
  for (const p of ['alerts', 'scrape', 'timing', 'families']) assert.equal(none[p].outcome, 'not-attempted', p);
  assert.match(none.alerts.reason, /declares no alert rule and no scrape job/);
  assert.match(none.scrape.reason, /declares no scrape job/);
  // Alert names but no jobs: its alerts are read; no target or metric is known to be its own.
  const named = fakeTool([]);
  const onlyAlerts = await readControlRoom({ callTool: named.callTool, tool: 'q', nowSeconds: now, scope: { alerts: ['ShopDown'] } });
  assert.deepEqual([onlyAlerts.scrape.outcome, onlyAlerts.families.outcome, onlyAlerts.alerts.outcome], ['not-attempted', 'not-attempted', 'empty']);
  assert.ok(named.seen.some((c) => c.query === 'count by (alertname, severity, alertstate) (ALERTS{alertname=~"ShopDown"})'));
  // No scope: the endpoint's whole, as before.
  const whole = fakeTool([]);
  const old = await readControlRoom({ callTool: whole.callTool, tool: 'q', nowSeconds: now });
  assert.equal(Object.hasOwn(old, 'scope'), false, 'no scope key: an older caller\'s answer keeps its own');
  assert.ok(whole.seen.some((c) => c.query === 'count by (alertname, severity, alertstate) (ALERTS)'));
});
