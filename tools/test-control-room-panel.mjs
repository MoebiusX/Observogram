#!/usr/bin/env node
/**
 * tools/test-control-room-panel.mjs — Overview's control room, the studio side: the model
 * (studio/control-room-model.mjs), the panel (studio/control-room-view.mjs) and the reads' driver
 * (studio/control-room-api.mjs), headless under node:test.
 *
 * The answer is the server's (server/routes/control-room.mjs), the krystaline numbers of 2026-11-11:
 * one warning firing and one pending, 24 of 24 targets up, 72 incidents over 21 days of history,
 * median 4 min, p95 3 h 34 min, one critical incident, 60 of the 72 one flapping alert, one alert
 * open since before the history; nine known families. Every sentence the panel says is pinned.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_ROOM_CLOSED, CONTROL_ROOM_INTERVAL_MS, controlRoomOpened, controlRoomReading, controlRoomAnswered, controlRoomFailed, controlRoomDue,
  durationWords, durationSeconds, buildControlRoomModel, slosOf,
} from '../studio/control-room-model.mjs';
import { createControlRoomDriver, loadControlRoom } from '../studio/control-room-api.mjs';
import { renderControlRoom, formatValue, boundWords, placeControlRoom } from '../studio/control-room-view.mjs';

const NOW = Date.parse('2026-11-11T00:25:00Z');
const answer = (over = {}) => ({
  ok: true, readAt: '2026-11-11T00:25:00.000Z', tookMs: 2400, cached: false,
  service: { id: 3, name: 'Demo', slug: 'demo' }, env: { name: 'prod' },
  endpoint: { id: 1, name: 'prod-mcp', origin: 'https://example.test' },
  scope: { kind: 'endpoint', declaredJobs: 21 },
  calls: { made: 45, budget: 64 },
  alerts: {
    outcome: 'data', reason: null, evidence: true, bySeverity: { critical: 0, warning: 1, info: 0, other: 0 }, pending: 1, more: 0, otherSeverities: [],
    active: [
      { name: 'ContainerOOMKilled', severity: 'warning', state: 'firing', instances: 1, since: '2026-10-29T00:12:45.000Z', seconds: 1120345 },
      { name: 'GenAiClientHighLatencyP95', severity: 'warning', state: 'pending', instances: 1, since: null, seconds: 360 },
    ],
  },
  scrape: { outcome: 'data', reason: null, up: 24, total: 24, downJobs: [], declared: { outcome: 'data', jobs: 21, up: 21, down: [], missing: [], missingCount: 0, cut: 0 } },
  timing: {
    outcome: 'data', reason: null, evidence: true, windowDays: 30, stepSeconds: 120, mergeSeconds: 300, minIncidents: 5,
    historyFrom: '2026-10-20T11:59:17.000Z', coversDays: 21.5, incidents: 73, closed: 72, notices: 0, tooFew: false, medianSeconds: 240, p95Seconds: 12840,
    bySeverity: { critical: { closed: 1, medianSeconds: null, longestSeconds: 120 }, warning: { closed: 71, medianSeconds: 240, longestSeconds: 12840 } },
    busiest: { name: 'GenAiClientHighLatencyP95', incidents: 60 },
    open: [{ name: 'ContainerOOMKilled', severity: 'warning', since: '2026-10-20T09:10:00.000Z', began: 'before the window' }], before: 0, beforeNames: [],
    readAt: '2026-11-11T00:20:00.000Z',
  },
  families: { outcome: 'data', reason: null, rows: [
    { id: 'http', title: 'HTTP traffic', layer: 'app', outcome: 'data', tiles: [
      { id: 'rate', label: 'Requests', unit: 'per-second', value: 1.01, outcome: 'data', reason: null, tone: 'info', judge: null },
      { id: 'errors', label: 'Server errors', unit: 'ratio', value: 0, outcome: 'data', reason: null, tone: 'good', judge: { kind: 'ceiling', bound: 0.005, critical: 0.05, from: 'stated' } },
      { id: 'p99', label: 'Slowest 1 in 100', unit: 'seconds', value: null, outcome: 'failed', reason: 'HTTP 422: Unprocessable Entity', tone: 'info', judge: { kind: 'ceiling', bound: 0.5, critical: 1, from: 'library:http-service#latency_p99' } },
    ], chart: { label: 'Requests', unit: 'per-second', range: '6h', outcome: 'data', reason: null, points: [[1, 1], [2, 1.2], [3, 0.9]] } },
    { id: 'containers', title: 'Containers', layer: 'infra', outcome: 'data', tiles: [
      { id: 'limit', label: 'Closest to its memory limit', unit: 'ratio', value: 0.942, outcome: 'data', reason: null, tone: 'warn', judge: { kind: 'ceiling', bound: 0.8, critical: 0.95, from: 'stated' } },
    ], chart: null },
  ] },
  absent: [{ id: 'kafka', title: 'Kafka' }],
  ...over,
});
const mttx = { declared: true, mttdTarget: '5m', mttrTarget: '2h', measured: null };
const openState = () => controlRoomAnswered(controlRoomOpened(CONTROL_ROOM_CLOSED, { serviceId: 3, env: 'prod', now: NOW }), answer(), { now: NOW });

test('the scope said under the title: only the service\'s own — the alert rules its repository names and its scrape jobs — or nothing yet when it was never run; an older server\'s answer is said as the endpoint\'s', () => {
  const said = (scope, over = {}) => buildControlRoomModel({ state: controlRoomAnswered(controlRoomOpened(CONTROL_ROOM_CLOSED, { serviceId: 3, env: 'prod', now: NOW }), answer({ scope, ...over }), { now: NOW }), serviceName: 'Demo', envName: 'prod', mttx, now: NOW });
  const own = said({ kind: 'service', jobs: 21, alerts: 58, cut: { jobs: 0, alerts: 0 } });
  // What a job name cannot tell apart is said: a service that shares one of the jobs is counted on it too.
  assert.equal(own.scope, 'Only Demo\'s own: the alert rules its repository names and its 21 scrape jobs, read through prod-mcp. A service that shares one of these jobs (an exporter or a collector they all use) is counted on it too.');
  assert.match(own.kpis.mttr.basis, /The figures are this service's own: the alerts that fire on its scrape jobs, and the alerts its repository names that carry no job/);
  assert.doesNotMatch(own.kpis.mttr.basis, /not only this service/);
  // The declared numbers, the read's cut beside them.
  assert.equal(said({ kind: 'service', jobs: 63, alerts: 58, cut: { jobs: 3, alerts: 0 } }).scope, 'Only Demo\'s own: the alert rules its repository names and its 63 scrape jobs (read: the first 60), read through prod-mcp. A service that shares one of these jobs (an exporter or a collector they all use) is counted on it too.');
  assert.equal(said({ kind: 'service', jobs: 2, alerts: 0, cut: { jobs: 0, alerts: 0 } }).scope, 'Only Demo\'s own: its 2 scrape jobs, read through prod-mcp. A service that shares one of these jobs (an exporter or a collector they all use) is counted on it too.');
  // Alert names alone: nothing tells them apart from another service's.
  assert.equal(said({ kind: 'service', jobs: 0, alerts: 4, cut: { jobs: 0, alerts: 0 } }).scope, 'Only Demo\'s own: the alert rules its repository names, read through prod-mcp. Another service\'s alert of the same name is counted too: there is no job to tell them apart.');
  assert.equal(said({ kind: 'service', jobs: 0, alerts: 0, cut: { jobs: 0, alerts: 0 } }).scope, 'Demo\'s repository declares no alert rule and no scrape job, so nothing live is known to be its own.');
  // Nothing of the service's in the store: said of its alerts, never of the store's others; its families by its jobs.
  const quietNone = said({ kind: 'service', jobs: 1, alerts: 0, cut: { jobs: 0, alerts: 0 } }, {
    alerts: { outcome: 'empty', reason: null, evidence: false, bySeverity: { critical: 0, warning: 0, info: 0, other: 0 }, pending: 0, active: [], more: 0, otherSeverities: [] },
    timing: { ...answer().timing, outcome: 'empty', evidence: false, incidents: 0, closed: 0, open: [] },
    families: { outcome: 'data', reason: null, rows: [] }, absent: [{ id: 'kafka', title: 'Kafka' }],
  });
  assert.equal(quietNone.status.sentence, 'Nothing of this service\'s is firing, and none of its alerts has fired or been pending here in 30 days: this store holds no history of them, so quiet cannot be told from unwatched.');
  assert.equal(quietNone.kpis.mttr.sub, 'None of its alerts has a history in this store: nothing to time.');
  assert.deepEqual([quietNone.families.note, quietNone.families.absent], ['None of the known metric families is exposed by its scrape jobs.', 'Not exposed by its scrape jobs: Kafka.']);
  // Never run: nothing read, said so — "Not read", never "could not be read".
  const why = 'Demo has never been run, so nothing live is known to be its own yet — Run it first';
  const none = { outcome: 'not-attempted', reason: why };
  const never = said({ kind: 'service', jobs: 0, alerts: 0, neverRun: true }, { alerts: { ...none, bySeverity: null, active: [], more: 0 }, scrape: { ...none }, timing: { ...none }, families: { ...none, rows: [] }, absent: [] });
  assert.equal(never.scope, 'Nothing is read until Demo has been run: the control room reads live what its repository declares.');
  assert.deepEqual([never.status.word, never.status.sentence], ['Not known', `Not read: ${why}.`]);
  assert.equal(never.kpis.mttr.sub, `Not read: ${why}.`);
  assert.equal(never.families.note, `Not read: ${why}.`);
  // A read that failed is still said as failed.
  const failed = said({ kind: 'service', jobs: 1, alerts: 1, cut: { jobs: 0, alerts: 0 } }, { alerts: { outcome: 'failed', reason: 'HTTP 503', bySeverity: null, active: [], more: 0 } });
  assert.equal(failed.status.sentence, 'The alerts could not be read: HTTP 503.');
  // An older server (no service scope): the endpoint's, as before.
  assert.match(said({ kind: 'endpoint', declaredJobs: 21 }).scope, /^Everything prod-mcp reads, not only Demo/);
});

test('the panel\'s state: open, reading, answered, failed — and when the next read is due (a minute, longer after a failure, never hidden, never after a final refusal)', () => {
  const s0 = controlRoomOpened(CONTROL_ROOM_CLOSED, { serviceId: 3, env: 'prod', now: NOW });
  assert.deepEqual([s0.open, s0.key, s0.reading, s0.answer], [true, '3:prod', false, null]);
  assert.equal(controlRoomOpened(s0, { serviceId: 3, env: 'prod' }), s0, 'the same key keeps its state');
  assert.equal(controlRoomDue(s0, { now: NOW }), 0, 'never read: at once');
  const reading = controlRoomReading(s0);
  assert.equal(controlRoomDue(reading, { now: NOW }), null, 'one read at a time');
  const done = controlRoomAnswered(reading, answer(), { now: NOW });
  assert.equal(controlRoomDue(done, { now: NOW + 1000 }), CONTROL_ROOM_INTERVAL_MS - 1000);
  assert.equal(controlRoomDue(done, { now: NOW, hidden: true }), null, 'hidden: no read');
  const f1 = controlRoomFailed(done, Object.assign(new Error('502: The live endpoint did not answer: no answer within 20 s'), { status: 502 }), { now: NOW });
  assert.deepEqual([f1.error, f1.stopped, f1.failures, f1.answer !== null], ['The live endpoint did not answer: no answer within 20 s', false, 1, true], 'the last answer is kept, said as stale');
  assert.equal(controlRoomDue(f1, { now: NOW }), 60_000);
  assert.equal(controlRoomDue(controlRoomFailed(f1, { status: 502 }, { now: NOW }), { now: NOW }), 120_000);
  const refused = controlRoomFailed(done, Object.assign(new Error('403: Reading live is not open to your role'), { status: 403 }), { now: NOW });
  assert.deepEqual([refused.stopped, controlRoomDue(refused, { now: NOW })], [true, null], 'a refusal a later read would repeat stops the reads');
  assert.equal(controlRoomDue(CONTROL_ROOM_CLOSED, { now: NOW }), null);
});

test('the words: durations, spec durations', () => {
  assert.deepEqual([40, 240, 12840, 3600, 1120345, null, -1].map(durationWords), ['40 s', '4 min', '3 h 34 min', '1 h', '13 days', '', '']);
  assert.deepEqual(['15m', '1h30m', '2d', '500ms', 'soon', ''].map(durationSeconds), [900, 5400, 172800, 0.5, null, null]);
});

test('the model: the status, MTTR as the median over the incidents with its target, MTTD not measured without a chaos run, what was found, the exporters, the alerts, the families', () => {
  const m = buildControlRoomModel({ state: openState(), serviceName: 'Demo', envName: 'prod', mttx, now: NOW });
  assert.equal(m.title, 'Demo · prod');
  assert.equal(m.scope, 'Everything prod-mcp reads, not only Demo: its alerts, incidents, targets and metrics. Only the line on the exporters the repository declares is Demo\'s own.', 'the figures are said as the endpoint\'s');
  assert.equal(m.next, 'refreshes every minute while open');
  assert.deepEqual([m.status.word, m.status.tone, m.status.sentence], ['Warning', 'warn', '1 warning firing, nothing critical. 1 alert is pending.']);
  const r = m.kpis.mttr;
  assert.deepEqual([r.label, r.long, r.words, r.sub, r.detail, r.target, r.verdict, r.tone, r.asOf], [
    'MTTR', 'Time to resolve', '4 min', 'Median time an incident took to clear, over 72 incidents in the last 22 days.',
    '95 in 100 cleared within 3 h 34 min.', 'Target 2 h', 'met', 'ok', '2026-11-11T00:20:00.000Z',
  ], 'the history, read five minutes before the rest, says its own read time');
  assert.equal(r.basis, 'How long the alert rules\' own firing records lasted, in 2-minute steps; an alert that pauses for 5 minutes or less and fires again is one incident, at the highest severity it reached. An alert still firing is left out. The figures are the endpoint\'s: every alert it holds, not only this service\'s, over the history the store keeps (an evaluator that began writing later than that is not seen).');
  const d = m.kpis.mttd;
  assert.deepEqual([d.words, d.sub, d.target, d.verdict], ['—', 'Not measured in prod: an alert knows when it fired, not when the fault began.', 'Target 5 min', null]);
  assert.deepEqual(m.insights.map((i) => i.text), [
    'Critical: 1 incident, the longest 2 min.',
    '60 of the 72 incidents are one alert, GenAiClientHighLatencyP95: it fires and clears again and again.',
    'ContainerOOMKilled has been firing for 22 days, since before the history begins: still open, so not in the figure.',
  ]);
  assert.deepEqual([m.scrape.words, m.scrape.tone, m.scrape.declared.words], ['24 of 24 targets up', 'ok', '21 of the 21 exporters the repository declares are up.']);
  assert.deepEqual(m.alerts.rows.map((a) => [a.name, a.state, a.forWords]), [['ContainerOOMKilled', 'firing', '22 days'], ['GenAiClientHighLatencyP95', 'pending', '6 min']], 'an open alert takes the history\'s start, not the evaluator\'s reset one');
  assert.deepEqual(m.families.rows.map((f) => [f.id, f.tone, f.toneWords, f.headline.map((t) => t.id)]), [['http', 'good', '', ['rate', 'errors']], ['containers', 'warn', '1 past its amber bound', ['limit']]]);
  assert.equal(m.families.rows[0].tiles[2].note, 'Not read: HTTP 422: Unprocessable Entity', 'a tile not read says so');
  assert.equal(m.families.absent, 'Not exposed live: Kafka.');
  assert.equal(buildControlRoomModel({ state: CONTROL_ROOM_CLOSED }), null);
});

test('the model never shows a number it did not read: too few incidents, none at all, the history not read, MTTD from a chaos run, a target missed, the alerts not read', () => {
  const at = (timing, extra = {}) => buildControlRoomModel({ state: controlRoomAnswered(controlRoomOpened(CONTROL_ROOM_CLOSED, { serviceId: 3, env: 'prod' }), answer({ timing, ...extra })), mttx, now: NOW });
  const few = at({ ...answer().timing, closed: 3, tooFew: true, medianSeconds: null, p95Seconds: null });
  assert.deepEqual([few.kpis.mttr.words, few.kpis.mttr.sub], ['—', 'Too few incidents to say: 3 cleared in the last 22 days (5 needed).']);
  const none = at({ ...answer().timing, outcome: 'empty', reason: 'no alert fired in the window' });
  assert.deepEqual([none.kpis.mttr.words, none.kpis.mttr.sub], ['—', 'No alert fired in the last 22 days.']);
  const blank = at({ ...answer().timing, outcome: 'empty', evidence: false, reason: 'the store shows no alert history' });
  assert.equal(blank.kpis.mttr.sub, 'No alert history in this store: nothing to time.', 'no history: never "no alert fired"');
  const unsure = at({ ...answer().timing, outcome: 'empty', evidence: null });
  assert.equal(unsure.kpis.mttr.sub, 'Whether this store holds an alert history could not be read.');
  const noStart = at({ ...answer().timing, coversDays: null, historyFrom: null });
  assert.deepEqual([noStart.kpis.mttr.sub, noStart.kpis.mttr.verdict], ['Median time an incident took to clear, over 72 incidents in the history this store keeps.', null], 'how far back unknown: no 30-day claim, no verdict');
  assert.match(noStart.kpis.mttr.basis, /How far back this store keeps its history is not known\./);
  const hours = at({ ...answer().timing, coversDays: 0.4 });
  assert.equal(hours.kpis.mttr.sub, 'Median time an incident took to clear, over 72 incidents in the last 10 hours.', 'below a day: hours, never "1 day"');
  const apart = at({ ...answer().timing, before: 2, beforeNames: ['Old', 'Older'], notices: 3 });
  assert.match(apart.kpis.mttr.basis, /An alert still firing is left out, and so are 2 incidents that began before the history \(Old, Older\) and 3 info notices\./);
  const fewCrit = at({ ...answer().timing, bySeverity: { critical: { closed: 7, medianSeconds: 600, longestSeconds: 3600 } }, busiest: { name: 'Twice', incidents: 2 }, closed: 5 });
  assert.deepEqual(fewCrit.insights.map((i) => i.text).slice(0, 2), ['Critical: 7 incidents, cleared in 10 min at the median.', 'ContainerOOMKilled has been firing for 22 days, since before the history begins: still open, so not in the figure.'], 'two of five is no flapping alert');
  // The history holds an alert open that is not firing now: not said as open, its age not taken.
  const resolved = at({ ...answer().timing, open: [{ name: 'GoneNow', severity: 'warning', since: '2026-10-20T09:10:00.000Z', began: null }] });
  assert.ok(!resolved.insights.some((i) => i.text.startsWith('GoneNow')), 'resolved since the history was read');
  // The evaluator restarted after the history was read: its own age, not the history's.
  const restarted = at(answer().timing, { alerts: { ...answer().alerts, active: [{ ...answer().alerts.active[0], seconds: 120 }] } });
  assert.equal(restarted.alerts.rows[0].forWords, '2 min', 'a gap the history could not see: no history age');
  const failed = at({ outcome: 'failed', reason: 'HTTP 422: Unprocessable Entity' });
  assert.deepEqual([failed.kpis.mttr.words, failed.kpis.mttr.sub], ['—', 'The alert history could not be read: HTTP 422: Unprocessable Entity.']);
  assert.match(failed.kpis.mttr.basis, /^How long the alert rules' own firing records lasted/, 'how it is measured, said even when the history was not read');
  const outdated = at({ ...answer().timing, outcome: 'empty', evidence: true, outdated: true });
  assert.equal(outdated.kpis.mttr.sub, 'No alert had fired in the last 22 days when the history was read; it is read again with the next refresh.', 'a kept empty history beside an alert firing now: said as that read\'s');
  const many = at({ ...answer().timing, before: 7, beforeNames: ['A', 'B', 'C', 'D', 'E'] });
  assert.match(many.kpis.mttr.basis, /and so are 7 incidents that began before the history \(A, B, C, D, E, and 2 more\)\./);
  // Quiet, with when an alert last fired: a long silence is said.
  const longQuiet = at({ ...answer().timing, lastFiredAt: '2026-10-21T00:25:00.000Z' }, { alerts: { outcome: 'empty', reason: null, evidence: true, bySeverity: { critical: 0, warning: 0, info: 0, other: 0 }, pending: 0, active: [], more: 0 } });
  assert.equal(longQuiet.status.sentence, 'No alert is firing. The last alert here fired 21 days ago.');
  // A heartbeat notice firing for ever is never a "still open" insight; a critical one comes first.
  const beats = at({ ...answer().timing, open: [
    { name: 'Watchdog', severity: 'info', since: '2026-10-12T00:00:00.000Z', began: 'before the window' },
    { name: 'ContainerOOMKilled', severity: 'warning', since: '2026-10-20T09:10:00.000Z', began: 'before the window' },
    { name: 'KubeletDown', severity: 'critical', since: '2026-11-11T00:15:00.000Z', began: null },
  ] }, { alerts: { ...answer().alerts, bySeverity: { critical: 1, warning: 1, info: 1, other: 0 }, active: [
    { name: 'KubeletDown', severity: 'critical', state: 'firing', instances: 1, seconds: 600 },
    { name: 'ContainerOOMKilled', severity: 'warning', state: 'firing', instances: 1, seconds: 1120345 },
    { name: 'Watchdog', severity: 'info', state: 'firing', instances: 1, seconds: 2592000 },
  ] } });
  assert.deepEqual(beats.insights.filter((i) => / still open/.test(i.text)).map((i) => [i.tone, i.text.split(' has ')[0]]), [['fail', 'KubeletDown'], ['warn', 'ContainerOOMKilled']]);
  // Fired again after the kept history was read: the insight takes the evaluator's age, as the row does,
  // said as "active" (the evaluator's age counts the rule's pending wait too).
  const refired = at(answer().timing, { alerts: { ...answer().alerts, active: [{ ...answer().alerts.active[0], seconds: 60 }] } });
  assert.match(refired.insights.find((i) => i.text.startsWith('ContainerOOMKilled')).text, /^ContainerOOMKilled has been active for 1 min: still open/);
  // Quiet's last firing in whole days only: under a day, nothing is said.
  const recentQuiet = at({ ...answer().timing, lastFiredAt: '2026-11-10T20:25:00.000Z' }, { alerts: { outcome: 'empty', reason: null, evidence: true, bySeverity: { critical: 0, warning: 0, info: 0, other: 0 }, pending: 0, active: [], more: 0 } });
  assert.equal(recentQuiet.status.sentence, 'No alert is firing.');
  // A history kept from a failed read: when it was last tried, never "History read at".
  const triedEarlier = at({ outcome: 'failed', reason: 'HTTP 422', readAt: '2026-11-11T00:22:00.000Z' });
  assert.deepEqual([triedEarlier.kpis.mttr.asOfWord, triedEarlier.kpis.mttr.asOf], ['Last tried at', '2026-11-11T00:22:00.000Z']);
  // No up series at all: said as a finding, the declared line kept.
  const silent = at(answer().timing, { scrape: { outcome: 'empty', reason: 'the endpoint answers no up series', up: null, total: null, downJobs: [], declared: { outcome: 'data', jobs: 3, up: 0, partly: [], partlyCount: 0, down: [], downCount: 0, missing: ['api', 'db', 'web'], missingCount: 3, cut: 0 } } });
  assert.deepEqual([silent.scrape.words, silent.scrape.tone, silent.scrape.declared.words], ['No targets answer here', 'warn', '0 of the 3 exporters the repository declares are up. 3 declared jobs are not scraped at all: api, db, web.']);
  // The browser's clock an hour fast: ages are the server's.
  const recent = answer({ tookMs: 0, timing: { ...answer().timing, readAt: answer().readAt, open: [{ name: 'ContainerOOMKilled', severity: 'warning', since: '2026-11-11T00:15:00.000Z', began: null }] }, alerts: { ...answer().alerts, active: [{ ...answer().alerts.active[0], seconds: 120 }] } });
  const fastState = controlRoomAnswered(controlRoomOpened(CONTROL_ROOM_CLOSED, { serviceId: 3, env: 'prod' }), recent, { now: NOW + 3_600_000 });
  const fast = buildControlRoomModel({ state: fastState, mttx, now: NOW + 3_600_000 + 60_000 });
  assert.equal(fast.alerts.rows[0].forWords, '11 min', 'firing since 00:15, a minute after the 00:25 read by the server\'s clock — not an hour more');
  assert.equal(fast.alerts.rows[0].ageFrom, 'history');
  // The read itself took 2 minutes: the answer is 2 minutes older than its readAt says.
  const slowState = controlRoomAnswered(controlRoomOpened(CONTROL_ROOM_CLOSED, { serviceId: 3, env: 'prod' }), { ...recent, tookMs: 120_000 }, { now: NOW });
  assert.equal(buildControlRoomModel({ state: slowState, mttx, now: NOW }).alerts.rows[0].forWords, '12 min', 'readAt + tookMs');
  // A failed read after it keeps the answer and its clock: ages go on, never back.
  const afterFail = controlRoomFailed(fastState, { status: 502, message: 'x' }, { now: NOW + 3_600_000 + 300_000 });
  assert.equal(buildControlRoomModel({ state: afterFail, mttx, now: NOW + 3_600_000 + 360_000 }).alerts.rows[0].forWords, '16 min');
  // The evaluator's own age (it counts the rule's pending wait): said as active.
  const own = buildControlRoomModel({ state: controlRoomAnswered(controlRoomOpened(CONTROL_ROOM_CLOSED, { serviceId: 3, env: 'prod' }), answer({ timing: { ...answer().timing, readAt: answer().readAt, open: [] }, alerts: { ...answer().alerts, active: [{ ...answer().alerts.active[0], seconds: 360 }] } }), { now: NOW }), mttx, now: NOW });
  assert.equal(own.alerts.rows[0].ageFrom, 'evaluator');
  // No severity label at all: one set of parentheses, worded.
  const bare = at(answer().timing, { alerts: { ...answer().alerts, bySeverity: { critical: 0, warning: 0, info: 0, other: 1 }, otherSeverities: [''], active: [{ name: 'Bare', severity: 'other', label: '', state: 'firing', instances: 1, seconds: 60 }] } });
  assert.equal(bare.status.sentence, '1 alert of a severity not recognised (none set) firing. 1 alert is pending.');
  // Cut at the deadline: said on the strip.
  const cutShort = at(answer().timing, { calls: { made: 30, budget: 64, outOfTime: true } });
  assert.equal(cutShort.outOfTime, true);
  const slow = at({ ...answer().timing, medianSeconds: 3 * 3600 });
  assert.deepEqual([slow.kpis.mttr.verdict, slow.kpis.mttr.tone], ['missed', 'warn']);
  // MTTD from this environment's newest chaos run; below its target but reading as it at minute
  // precision: said finer, never "5 min · Target 5 min".
  const run = (o) => ({ experiment: 'pod-kill', at: '2026-11-08T06:00:00Z', outcome: 'pass', environment: 'prod', mttd: '4m30s', ...o });
  const mt = (runs, envName = 'prod') => buildControlRoomModel({ state: openState(), envName, mttx: { ...mttx, runs }, now: NOW }).kpis.mttd;
  const chaos = mt([run()]);
  assert.deepEqual([chaos.words, chaos.sub, chaos.verdict, chaos.tone], ['4 min 30 s', 'Measured in a chaos test in prod on 8 Nov, recorded in the repository.', 'met', 'ok']);
  assert.match(chaos.basis, /the slowest of the alerts it expected/, 'what observed_mttd is');
  // The newest run here failed: said as failed, no verdict — never an older passed run's figure.
  const failedRun = mt([run({ at: '2026-11-09T06:00:00Z', outcome: 'fail', mttd: '6m40s', experiment: 'latency' }), run()]);
  assert.deepEqual([failedRun.words, failedRun.verdict, failedRun.tone, failedRun.sub, failedRun.detail], ['—', null, 'warn', 'The last chaos test in prod (latency), on 9 Nov, failed: an alert it expected never fired.', 'The alerts that did fire took up to 7 min.']);
  const aborted = mt([run({ outcome: 'aborted', mttd: null })]);
  assert.deepEqual([aborted.words, aborted.verdict, aborted.sub], ['—', null, 'The last chaos test in prod (pod-kill), on 8 Nov, was aborted: nothing measured.']);
  // Another environment's run: named beside, never this panel's figure.
  const staging = mt([run({ environment: 'staging', mttd: '3m' })]);
  assert.deepEqual([staging.words, staging.verdict, staging.sub, staging.detail], ['—', null, 'Not measured in prod: an alert knows when it fired, not when the fault began.', 'A chaos test in staging measured 3 min on 8 Nov.']);
  // A run that names no environment: its figure, said so, no verdict; a run of another year carries the year.
  const unplaced = mt([run({ environment: null, at: '2025-11-08T06:00:00Z', mttd: '7m20s' })]);
  assert.deepEqual([unplaced.words, unplaced.verdict, unplaced.sub], ['7 min', null, 'Measured in a chaos test on 8 Nov 2025, recorded in the repository. The run names no environment, so no verdict.']);
  // Just over a target that its rounding would equal: finer, so "over target" never sits beside an equal figure.
  const over = mt([run({ mttd: '5m20s' })]);
  assert.deepEqual([over.words, over.verdict], ['5 min 20 s', 'missed']);
  // MTTR the same way: 2.4 days against 2 days.
  const longMttr = at({ ...answer().timing, medianSeconds: 2.4 * 86400 });
  const longTarget = buildControlRoomModel({ state: controlRoomAnswered(controlRoomOpened(CONTROL_ROOM_CLOSED, { serviceId: 3, env: 'prod' }), answer({ timing: { ...answer().timing, medianSeconds: 2.4 * 86400 } })), mttx: { ...mttx, mttrTarget: '2d' }, now: NOW }).kpis.mttr;
  assert.deepEqual([longMttr.kpis.mttr.words, longTarget.words, longTarget.verdict], ['2 days', '2 days 10 h', 'missed']);
  const blind = at(answer().timing, { alerts: { outcome: 'failed', reason: 'no answer', bySeverity: null, active: [], more: 0 } });
  assert.deepEqual([blind.status.word, blind.status.sentence, blind.status.counts], ['Not known', 'The alerts could not be read: no answer.', null], 'not read is never quiet');
  const quiet = at(answer().timing, { alerts: { outcome: 'empty', reason: null, evidence: true, bySeverity: { critical: 0, warning: 0, info: 0, other: 0 }, pending: 0, active: [], more: 0 } });
  assert.deepEqual([quiet.status.word, quiet.status.tone, quiet.status.sentence], ['Quiet', 'ok', 'No alert is firing.']);
  const unwatched = at(answer().timing, { alerts: { outcome: 'empty', reason: null, evidence: false, bySeverity: { critical: 0, warning: 0, info: 0, other: 0 }, pending: 0, active: [], more: 0 } });
  assert.deepEqual([unwatched.status.word, unwatched.status.tone, unwatched.status.sentence], ['Not known', 'neutral', 'Nothing is firing, and no alert has fired or been pending here in 30 days: this store shows no alert history, so quiet cannot be told from unwatched.']);
  const odd = at(answer().timing, { alerts: { ...answer().alerts, bySeverity: { critical: 0, warning: 1, info: 0, other: 2 }, otherSeverities: ['sev-a', 'P9'], active: [{ name: 'Odd', severity: 'other', label: 'sev-a', state: 'firing', instances: 1, seconds: 60 }] } });
  assert.deepEqual([odd.status.word, odd.status.sentence], ['Firing', '2 alerts of a severity not recognised (sev-a, P9) firing, and 1 warning. 1 alert is pending.'], 'never "nothing critical" beside a severity not known');
  assert.equal(odd.alerts.rows[0].severityText, 'sev-a', 'its row says its own label');
  const noTargets = buildControlRoomModel({ state: openState(), mttx: null, now: NOW });
  assert.equal(noTargets.kpis.mttr.target, '', 'no declared target: none shown');
  // Targets set in the studio: real verdicts, the target said as the studio's.
  const studio = buildControlRoomModel({ state: openState(), mttx: { declared: true, origin: 'studio', mttdTarget: '1m', mttrTarget: '5m', runs: [] }, now: NOW }).kpis;
  assert.deepEqual([studio.mttr.target, studio.mttr.verdict, studio.mttr.tone, studio.mttd.target], ['Target 5 min · set in the studio', 'met', 'ok', 'Target 1 min · set in the studio']);
  // None anywhere: the recommendation, never a verdict.
  const rec = buildControlRoomModel({ state: openState(), mttx: { declared: false, runs: [], recommended: { name: 'Lab default', mttd: '1m', mttr: '5m' } }, now: NOW }).kpis;
  assert.deepEqual([rec.mttr.target, rec.mttr.verdict, rec.mttr.tone, rec.mttd.target, rec.mttd.verdict], ['Recommended ≤ 5 min (lab default); none declared', null, 'neutral', 'Recommended ≤ 1 min (lab default); none declared', null]);
  // The studio's and the recommendation's own words, when given, so the panel says them as the board and the form do.
  const worded = buildControlRoomModel({ state: openState(), mttx: { declared: true, origin: 'studio', mttdTarget: '15m', mttrTarget: '240m', mttdWords: '≤ 15 min', mttrWords: '≤ 4 hours', runs: [] }, now: NOW }).kpis;
  assert.deepEqual([worded.mttr.target, worded.mttd.target], ['Target 4 hours · set in the studio', 'Target 15 min · set in the studio']);
  const recWorded = buildControlRoomModel({ state: openState(), mttx: { declared: false, runs: [], recommended: { name: 'Noncritical service', mttd: '15m', mttr: '240m', mttdWords: '≤ 15 min', mttrWords: '≤ 4 hours' } }, now: NOW }).kpis;
  assert.equal(recWorded.mttr.target, 'Recommended ≤ 4 hours (noncritical service); none declared');
  // The way to set them, from where the figures stand against them: the host's action words, only these two.
  const offer = (action, extra = {}) => buildControlRoomModel({ state: openState(), serviceName: 'Demo', envName: 'prod', mttx: { declared: false, runs: [], action, ...extra }, now: NOW }).targets;
  assert.deepEqual(offer('Set targets…'), { label: 'Set targets…', aria: 'Set the MTTD / MTTR targets of Demo · prod' });
  assert.deepEqual(offer('Change targets…', { declared: true, origin: 'studio', mttdTarget: '1m', mttrTarget: '5m' }), { label: 'Change targets…', aria: 'Change the MTTD / MTTR targets of Demo · prod' });
  assert.deepEqual([offer(null), offer('Delete everything'), buildControlRoomModel({ state: openState(), mttx: { unread: true, action: 'Set targets…' }, now: NOW }).targets], [null, null, null], 'nothing else, and nothing while the pack is unread');
  // A pack not read: neither the studio's nor the recommendation (the repository's own might be there).
  const unreadRec = buildControlRoomModel({ state: openState(), mttx: { unread: true }, now: NOW }).kpis;
  assert.deepEqual([unreadRec.mttr.target, unreadRec.mttd.target], ["The repository's targets were not read.", '']);
  const unread = buildControlRoomModel({ state: openState(), mttx: { unread: true }, now: NOW });
  assert.deepEqual([unread.kpis.mttr.target, unread.kpis.mttd.target, unread.kpis.mttd.sub], ["The repository's targets were not read.", '', 'Not measured here: an alert knows when it fired, not when the fault began.'], 'the pack not read: never "record its runs"');
  assert.doesNotMatch(unread.kpis.mttd.basis, /Record its runs/);
  // The targets up, never read: said, never 0.
  const noUp = at(answer().timing, { scrape: { outcome: 'data', reason: null, up: null, upReason: 'HTTP 503', total: 48, downJobs: [], declared: { outcome: 'data', jobs: 60, up: 58, partly: ['api'], partlyCount: 1, down: [], downCount: 0, missing: ['x'], missingCount: 1, cut: 4 } } });
  assert.deepEqual([noUp.scrape.words, noUp.scrape.sub, noUp.scrape.ratio, noUp.scrape.tone], ['48 targets; how many are up was not read', 'HTTP 503', null, 'neutral']);
  assert.deepEqual([noUp.scrape.declared.words, noUp.scrape.declared.tone], ['58 of the 60 exporters read are up; the repository declares 64, the other 4 were not read. 1 declared job is partly down: api. 1 declared job is not scraped at all: x.', 'warn'], 'cut: the count is of those read, the repository\'s own total said');
  // A tile the budget left unread, an empty one with its own words.
  const budget = at(answer().timing, { families: { outcome: 'data', reason: null, rows: [{ id: 'rabbitmq', title: 'RabbitMQ', layer: 'platform', outcome: 'data', tiles: [
    { id: 'ready', label: 'Ready messages, all queues', unit: 'count', value: 12, outcome: 'data', reason: null, tone: 'info', judge: null },
    { id: 'backlog', label: 'Longest queue (ready messages)', unit: 'count', value: null, outcome: 'empty', reason: 'Not exposed per queue', tone: 'info', judge: null },
    { id: 'memory', label: 'Memory against its alarm', unit: 'ratio', value: null, outcome: 'not-attempted', reason: 'the read reached its budget of calls', tone: 'info', judge: null },
    { id: 'bad', label: 'Worst', unit: 'ratio', value: 0.99, outcome: 'data', reason: null, tone: 'bad', judge: null },
  ], chart: null }] } });
  assert.deepEqual(budget.families.rows[0].tiles.map((t) => t.note), ['', 'Not exposed per queue', 'Not read: the read reached its budget of calls', '']);
  assert.deepEqual([budget.families.rows[0].tone, budget.families.rows[0].toneWords, budget.families.rows[0].headline.map((t) => t.id)], ['bad', '1 past its red bound', ['bad', 'ready']], 'the worst tile first on the closed row');
  // The strip's next read, as the driver does it.
  const failedOnce = buildControlRoomModel({ state: controlRoomFailed(openState(), { status: 502, message: 'x' }, { now: NOW }), mttx, now: NOW });
  const failedTwice = buildControlRoomModel({ state: controlRoomFailed(controlRoomFailed(openState(), { status: 502 }, { now: NOW }), { status: 502 }, { now: NOW }), mttx, now: NOW });
  const stopped = buildControlRoomModel({ state: controlRoomFailed(openState(), { status: 403, message: 'no' }, { now: NOW }), mttx, now: NOW });
  const busy = controlRoomFailed(openState(), { status: 429, message: 'Too many live reads' }, { now: NOW });
  assert.deepEqual([failedOnce.next, failedTwice.next, stopped.next, buildControlRoomModel({ state: busy, mttx, now: NOW }).next], ['next read in 1 min', 'next read in 2 min', 'reads stopped: Refresh tries again', 'next read in 15 s']);
  assert.equal(controlRoomDue(busy, { now: NOW }), 15_000, 'a busy server: a quarter of a minute, not the failure backoff');
});

test('formatValue: each unit in its words, never a rounded lie; a bound in the words its judge applies', () => {
  assert.deepEqual([[0.942, 'ratio'], [0.9975, 'ratio'], [0.05, 'ratio'], [1.01, 'per-second'], [0.02, 'per-second'], [0, 'per-second'], [0.174, 'seconds'], [2.5, 'seconds'], [1.54e9, 'bytes'], [2.44, 'cores'], [12, 'count'], [18400, 'count'], [null, 'ratio']].map(([v, u]) => formatValue(v, u)),
    ['94%', '99.7%', '5%', '1/s', '1.2/min', '0/s', '174 ms', '2.5 s', '1.4 GB', '2.44 cores', '12', '18.4K', '—']);
  assert.deepEqual([[0.0004, 'ratio'], [0, 'ratio'], [0.99996, 'ratio'], [1, 'ratio'], [0.0006, 'per-second'], [0.0001, 'seconds'], [0.3, 'count'], [0, 'count']].map(([v, u]) => formatValue(v, u)),
    ['<0.1%', '0%', '>99.9%', '100%', '<0.1/min', '<1 ms', '<1', '0'], 'above 0 is never 0; short of 1 is never 100%');
  assert.equal(boundWords({ kind: 'ceiling', bound: 0.8, critical: 0.95, from: 'stated' }, 'ratio'), 'Amber above 80%, red above 95% (from a stated default).');
  assert.equal(boundWords({ kind: 'ceiling', bound: 100, critical: 500, from: 'library:rabbitmq#backlog_warning' }, 'count'), 'Amber at 101 or more, red at 501 or more (from the library: rabbitmq, backlog_warning).', 'a count\'s bound as the whole number it turns at');
  assert.equal(boundWords({ kind: 'ceiling', bound: 0.5, critical: 0.5, from: 'stated' }, 'count'), 'Red at 1 or more (from a stated default).');
  assert.equal(boundWords({ kind: 'ceiling', bound: 0.01, critical: null, from: 'stated' }, 'ratio'), 'Amber above 1% (from a stated default).', 'no red stated: none said');
  assert.equal(boundWords({ kind: 'floor', bound: 0.9995, critical: 0.99, from: 'stated' }, 'ratio'), 'Amber below 99.95%, red below 99% (from a stated default).', 'a bound exactly as stated, never a value\'s floor');
  assert.equal(boundWords({ kind: 'ceiling', bound: 0.0001, critical: null, from: 'stated' }, 'ratio'), 'Amber above 0.01% (from a stated default).');
  assert.deepEqual([[0.004, 'cores'], [0.004, 'other'], [0, 'cores']].map(([v, u]) => formatValue(v, u)), ['<0.01 cores', '<0.01', '0 cores']);
});

// A headless host for the panel: the container holds a mount (its HTML, repainted) and a live region (kept);
// the aside the mount holds records its listeners and focus.
function panelHost() {
  let html = '';
  let built = false;
  const live = { textContent: '', said: [] };
  const aside = {
    dataset: {}, listeners: {}, focused: 0, _uxWired: false,
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    focus() { this.focused += 1; globalThis.document.activeElement = this; },
    contains(el) { return el === aside || el?.inside === true; },
    querySelector: (sel) => (sel === '.ov-cr__body' ? { scrollTop: 0 } : null),
    querySelectorAll: () => [],
    click(uxAction) { for (const fn of this.listeners.click || []) fn({ target: { closest: () => ({ dataset: { uxAction }, inside: true }) }, preventDefault() {} }); },
    key(key) { let prevented = false; for (const fn of this.listeners.keydown || []) fn({ key, defaultPrevented: false, preventDefault() { prevented = true; }, stopPropagation() {} }); return prevented; },
  };
  // The panel's pieces, as the renderer writes them in place: each splices its part of the panel's HTML.
  const pieceAt = (start, end, last = false) => ({
    scrollTop: 0, writes: 0,
    contains: () => false, querySelectorAll: () => [],
    get innerHTML() { const i = html.indexOf(start) + start.length; return html.slice(i, last ? html.lastIndexOf(end) : html.indexOf(end, i)); },
    set innerHTML(v) { this.writes += 1; const i = html.indexOf(start) + start.length; const j = last ? html.lastIndexOf(end) : html.indexOf(end, i); html = html.slice(0, i) + v + html.slice(j); },
  });
  const pieces = {
    '.ov-cr__acts': pieceAt('<div class="ov-cr__acts">', '</div>\n      </header>'),
    '.ov-cr__head': pieceAt('<div class="ov-cr__head">', '</div>\n      <div class="ov-cr__body">'),
    '.ov-cr__body': pieceAt('<div class="ov-cr__body">', '</div>\n    </aside>', true),
  };
  aside.querySelector = (sel) => pieces[sel] || null;
  const mount = {
    get innerHTML() { return html; },
    set innerHTML(v) { html = v; aside.listeners = {}; aside._uxWired = false; for (const p of Object.values(pieces)) p.writes = 0; const k = /data-cr-key="([^"]*)"/.exec(v); aside.dataset.crKey = k ? k[1] : undefined; },
    querySelector: (sel) => (sel === '.ov-cr' && /class="ov-cr"/.test(html) ? aside : null),
  };
  const liveProxy = new Proxy(live, { set(t, k, v) { if (k === 'textContent') t.said.push(v); t[k] = v; return true; } });
  const container = {
    get innerHTML() { return built ? html : ''; },
    set innerHTML(v) { built = v !== ''; html = ''; liveProxy.textContent = ''; live.said.length = 0; },
    querySelector: (sel) => (!built ? null : sel === ':scope > .ov-cr-mount' ? mount : sel === ':scope > .ov-cr__live' ? liveProxy : null),
  };
  return { container, aside, live, pieces };
}

test('renderControlRoom: a labelled panel, the status, MTTR and MTTD first, the alerts and families, every live string escaped; Close, Refresh and Escape reach the host; closed, it is gone', () => {
  globalThis.document = { activeElement: null };
  const { container, aside, live, pieces } = panelHost();
  const calls = [];
  const host = { overview: { closeControlRoom: () => calls.push('close'), refreshControlRoom: () => calls.push('refresh') } };
  const hostile = answer({ alerts: { ...answer().alerts, active: [{ name: '<img src=x onerror=alert(1)>', severity: 'critical', state: 'firing', instances: 3, since: null, seconds: 90 }] } });
  const m = buildControlRoomModel({ state: controlRoomAnswered(controlRoomOpened(CONTROL_ROOM_CLOSED, { serviceId: 3, env: 'prod' }), hostile), serviceName: 'Demo <b>', envName: 'prod', mttx, now: NOW });
  renderControlRoom(container, m, host);
  const html = container.innerHTML;
  assert.ok(html.includes('<aside class="ov-cr" id="ov-cr" role="dialog" aria-modal="false" aria-labelledby="ov-cr-title" tabindex="-1" data-cr-key="3:prod">'), 'a non-modal, labelled panel');
  assert.ok(html.includes('<h2 class="ov-cr__title" id="ov-cr-title">Demo &lt;b&gt; · prod</h2>'));
  assert.ok(html.includes('<p class="ov-cr__scope">Everything prod-mcp reads, not only Demo &lt;b&gt;: its alerts, incidents, targets and metrics.'), 'the scope under the title');
  assert.ok(html.includes('<p class="ov-cr__strip">Read through prod-mcp · at ') && html.includes(' · refreshes every minute while open · 45 queries</p>'));
  assert.ok(html.includes('<p class="ov-cr__kpi-detail">History read at '), 'the history\'s own read time');
  assert.ok(!html.includes('<img src=x') && html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'a live alert name escaped');
  assert.ok(html.indexOf('ov-cr__status') < html.indexOf('ov-cr__kpis') && html.indexOf('ov-cr__kpis') < html.indexOf('ov-cr__alerts'), 'status, then MTTR / MTTD, then the alerts');
  assert.ok(html.includes('<div class="ov-cr__kpi-value">4 min</div>') && html.includes('Target 2 h · <span class="ov-cr__verdict ov-cr__verdict--met">within target</span>'));
  assert.ok(html.includes('<summary>How it is measured</summary>'), 'the basis is one click away');
  assert.ok(html.includes('<svg class="ov-cr__spark" viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label="Requests, last 6h: from 1/s to 0.9/s, between 0.9/s and 1.2/s">'), 'the chart has words');
  assert.ok(html.includes('<span class="ov-cr__tile-b">Amber above 80%, red above 95% (from a stated default).</span>'), 'a tile\'s bound and its source, in words on the tile');
  assert.ok(html.includes('<span class="ov-cr__sr">Requests: </span>1/s'), 'a closed row\'s number names itself');
  assert.ok(html.includes('<span class="ov-cr__fam-mark ov-cr__fam-mark--warn" title="1 past its amber bound" aria-hidden="true">amber</span><span class="ov-cr__sr">1 past its amber bound: </span>Containers'), 'a closed row says its worst tone, in a word as well as a colour');
  assert.ok(html.includes('<div class="ov-cr__counts" role="group" aria-label="Firing alerts by severity">'));
  assert.ok(!html.includes('og-btn--primary'), 'no primary button: the board keeps its one');
  assert.equal(aside.focused, 1, 'a new panel takes the focus');
  assert.deepEqual(live.said, ['Demo <b> · prod: Warning. 1 warning firing, nothing critical. 1 alert is pending.'], 'the live region says the service environment and its status once');
  aside.click('cr-close');
  aside.click('cr-refresh');
  assert.ok(aside.key('Escape'), 'Escape is taken');
  assert.ok(!aside.key('a'), 'another key is not');
  assert.deepEqual(calls, ['close', 'refresh', 'close']);
  assert.ok(!html.includes('cr-targets'), 'the repository\'s targets: nothing to set here');
  // Set targets… under the two figures reaches the host's setTargets.
  const offered = panelHost();
  const asked = [];
  renderControlRoom(offered.container, buildControlRoomModel({ state: controlRoomAnswered(controlRoomOpened(CONTROL_ROOM_CLOSED, { serviceId: 3, env: 'prod' }), answer()), serviceName: 'Demo', envName: 'prod', mttx: { declared: false, runs: [], action: 'Set targets…' }, now: NOW }), { overview: { setTargets: () => asked.push('targets') } });
  assert.ok(offered.container.innerHTML.includes('</section>\n      <p class="ov-cr__targets"><button type="button" class="og-btn og-btn--text" data-ux-action="cr-targets" aria-label="Set the MTTD / MTTR targets of Demo · prod">Set targets…</button></p>'), 'under the two figures');
  offered.aside.click('cr-targets');
  assert.deepEqual(asked, ['targets']);
  // A repaint of the same service environment does not take the focus again unless the panel had it,
  // and does not say the same status again.
  globalThis.document.activeElement = null;
  renderControlRoom(container, m, host);
  assert.equal(aside.focused, 1);
  assert.deepEqual(live.said, ['Demo <b> · prod: Warning. 1 warning firing, nothing critical. 1 alert is pending.'], 'nothing new: nothing said');
  assert.deepEqual(Object.values(pieces).map((p) => p.writes), [0, 0, 0], 'nothing changed: nothing drawn again (the reader keeps their place)');
  // Reading: only the buttons change; the body stays as it is.
  renderControlRoom(container, buildControlRoomModel({ state: controlRoomReading(controlRoomAnswered(controlRoomOpened(CONTROL_ROOM_CLOSED, { serviceId: 3, env: 'prod' }), hostile)), serviceName: 'Demo <b>', envName: 'prod', mttx, now: NOW }), host);
  assert.deepEqual([pieces['.ov-cr__acts'].writes, pieces['.ov-cr__body'].writes], [1, 0], 'a read in flight redraws the buttons, never the body');
  assert.ok(container.innerHTML.includes('aria-busy="true" aria-disabled="true">Reading…</button>'));
  // Reading, then a failure with the last answer kept: said as stale.
  const failed = buildControlRoomModel({ state: controlRoomFailed(openState(), Object.assign(new Error('502: The live endpoint did not answer: timeout'), { status: 502 })), mttx, now: NOW });
  renderControlRoom(container, failed, host);
  assert.match(container.innerHTML, /<p class="ov-cr__error">The last read failed: The live endpoint did not answer: timeout The figures below are from /);
  assert.equal(live.said.at(-1), 'Demo · prod: the last read failed: The live endpoint did not answer: timeout', 'a failure said once, as a status');
  assert.ok(container.innerHTML.includes(' · next read in 1 min · '), 'the strip says the real next read');
  const first = buildControlRoomModel({ state: controlRoomReading(controlRoomOpened(CONTROL_ROOM_CLOSED, { serviceId: 4, env: 'prod' })), mttx, now: NOW });
  renderControlRoom(container, first, host);
  assert.ok(container.innerHTML.includes('Reading the live side…') && container.innerHTML.includes('aria-busy="true" aria-disabled="true">Reading…</button>'), 'Refresh stays focusable while reading');
  assert.ok(!container.innerHTML.includes(' disabled>'));
  const before = calls.length;
  aside.click('cr-refresh');
  assert.equal(calls.length, before, 'a click while reading is ignored');
  renderControlRoom(container, null, host);
  assert.equal(container.innerHTML, '', 'closed: nothing');
  delete globalThis.document;
});

test('Record a chaos run… beside Set targets… where the pack declares an experiment, reaching the host; a run recorded in the studio is said as the studio\'s, by whom; the basis names both ways to record', () => {
  globalThis.document = { activeElement: null };
  const model = (m) => buildControlRoomModel({ state: openState(), serviceName: 'Demo', envName: 'prod', mttx: m, now: NOW });
  assert.equal(model({ declared: false, runs: [], action: 'Set targets…' }).record, null, 'not without record: true');
  assert.equal(model({ unread: true, record: true }).record, null, 'not while the pack is not read');
  const both = model({ declared: false, runs: [], action: 'Set targets…', record: true });
  assert.deepEqual(both.record, { label: 'Record a chaos run…', aria: 'Record a chaos run of Demo · prod' });
  const { container, aside } = panelHost();
  const asked = [];
  renderControlRoom(container, both, { overview: { setTargets: () => asked.push('targets'), recordChaosRun: (from) => asked.push(`record:${from}`) } });
  assert.ok(container.innerHTML.includes('<p class="ov-cr__targets"><button type="button" class="og-btn og-btn--text" data-ux-action="cr-targets" aria-label="Set the MTTD / MTTR targets of Demo · prod">Set targets…</button><button type="button" class="og-btn og-btn--text" data-ux-action="cr-record" aria-label="Record a chaos run of Demo · prod">Record a chaos run…</button></p>'), 'one line under the two figures');
  aside.click('cr-record');
  assert.deepEqual(asked, ['record:control-room']);
  const alone = panelHost();
  renderControlRoom(alone.container, model({ declared: true, origin: 'repository', mttdTarget: '5m', mttrTarget: '2h', runs: [], action: null, record: true }), { overview: {} });
  assert.ok(alone.container.innerHTML.includes('<p class="ov-cr__targets"><button type="button" class="og-btn og-btn--text" data-ux-action="cr-record"'), 'the repository\'s targets: Record a chaos run… alone');
  // The MTTD a run recorded in the studio measured, said so; the basis names Record a chaos run… and the repository.
  const studio = model({ ...mttx, runs: [{ experiment: 'pod-kill', at: '2026-11-08T06:00:00Z', outcome: 'pass', environment: 'prod', mttd: '4m30s', studio: true, by: 'ada' }] }).kpis.mttd;
  assert.deepEqual([studio.words, studio.sub, studio.verdict], ['4 min 30 s', 'Measured in a chaos test in prod on 8 Nov, recorded in the studio by ada.', 'met']);
  assert.match(model({ ...mttx, runs: [] }).kpis.mttd.basis, /^A chaos test knows its start\. Record its runs with Record a chaos run…, or in the repository \(\.observability\/pack\.yaml/);
  delete globalThis.document;
});

test('renderControlRoom redraws the body in place keeping the rows opened, the focus and the scroll; placeControlRoom starts the panel under the bar', () => {
  // A small DOM of the pieces the renderer touches: elements with innerHTML, details rows and focus.
  const activeRef = { el: null };
  globalThis.document = { get activeElement() { return activeRef.el; } };
  const rowsOf = (html) => [...html.matchAll(/<details[^>]*data-cr-open="([^"]+)"/g)].map((m) => m[1]);
  const mkPiece = () => {
    const piece = {
      html: '', scrollTop: 0, rows: [],
      get innerHTML() { return this.html; },
      set innerHTML(v) {
        this.html = v; this.scrollTop = 0;
        this.rows = rowsOf(v).map((id) => {
          const r = { dataset: { crOpen: id }, open: false, listeners: [], addEventListener(t, fn) { this.listeners.push(fn); } };
          r.summary = { focus() { activeRef.el = this; }, getAttribute: () => null, closest: () => r };
          return r;
        });
      },
      querySelectorAll: () => piece.rows,
      contains: (el) => piece.rows.some((r) => r.summary === el),
    };
    return piece;
  };
  const pieces = { '.ov-cr__titles': mkPiece(), '.ov-cr__acts': mkPiece(), '.ov-cr__head': mkPiece(), '.ov-cr__body': mkPiece() };
  const aside = {
    dataset: {}, listeners: {}, _uxWired: false, focused: 0,
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    focus() { this.focused += 1; activeRef.el = this; },
    contains: (el) => el === aside || Object.values(pieces).some((p) => p.contains(el)),
    querySelector: (sel) => {
      if (pieces[sel]) return pieces[sel];
      const m = /^\[data-cr-open="([^"]+)"\] summary$/.exec(sel);
      if (m) return pieces['.ov-cr__body'].rows.find((r) => r.dataset.crOpen === m[1])?.summary || null;
      return null;
    },
    querySelectorAll: () => pieces['.ov-cr__body'].rows,
  };
  let built = false;
  const mount = {
    set innerHTML(v) {
      for (const [sel, p] of Object.entries(pieces)) {
        const cls = sel.slice(1);
        const start = v.indexOf(`<div class="${cls}">`);
        if (start >= 0) p.innerHTML = v.slice(start);
      }
      aside.dataset.crKey = /data-cr-key="([^"]*)"/.exec(v)?.[1];
    },
    querySelector: (sel) => (sel === '.ov-cr' ? aside : null),
  };
  const container = {
    set innerHTML(v) { built = v !== ''; },
    querySelector: (sel) => (!built ? null : sel === ':scope > .ov-cr-mount' ? mount : sel === ':scope > .ov-cr__live' ? { textContent: '' } : null),
  };
  const host = { overview: { closeControlRoom() {}, refreshControlRoom() {} } };
  const state = controlRoomAnswered(controlRoomOpened(CONTROL_ROOM_CLOSED, { serviceId: 3, env: 'prod' }), answer(), { now: NOW });
  renderControlRoom(container, buildControlRoomModel({ state, serviceName: 'Demo', envName: 'prod', mttx, now: NOW }), host);
  const body = pieces['.ov-cr__body'];
  const row = body.rows.find((r) => r.dataset.crOpen === 'fam-containers');
  assert.ok(row, 'a family row drawn');
  row.open = true;
  for (const fn of row.listeners) fn();
  body.scrollTop = 240;
  row.summary.focus();
  // A new answer that changes the body: drawn again, the row opened again, the focus back on it, the scroll kept.
  const next = controlRoomAnswered(state, answer({ alerts: { ...answer().alerts, pending: 2 } }), { now: NOW + 60_000 });
  renderControlRoom(container, buildControlRoomModel({ state: next, serviceName: 'Demo', envName: 'prod', mttx, now: NOW + 60_000 }), host);
  const again = body.rows.find((r) => r.dataset.crOpen === 'fam-containers');
  assert.notEqual(again, row, 'the body was drawn again');
  assert.deepEqual([again.open, activeRef.el === again.summary, body.scrollTop, aside.focused], [true, true, 240, 1], 'the row opened, the focus and the scroll kept; the panel never took the focus back');
  // A renamed service: the title redrawn in place.
  renderControlRoom(container, buildControlRoomModel({ state: next, serviceName: 'Shop', envName: 'prod', mttx, now: NOW + 60_000 }), host);
  assert.match(pieces['.ov-cr__titles'].html, /<h2 class="ov-cr__title" id="ov-cr-title">Shop · prod<\/h2>/);
  delete globalThis.document;
  // The placement: the bar's bottom plus 12 px, less the panel's own top; no bar, the last value stays.
  const props = {};
  const doc = {
    documentElement: { style: { setProperty: (k, v) => { props[k] = v; } } },
    querySelector: () => ({ getBoundingClientRect: () => ({ top: props['--ov-cr-head'] === '0px' ? 75 : 999 }) }),
    defaultView: { scrollY: 0 },
  };
  placeControlRoom({ getBoundingClientRect: () => ({ bottom: 133 }) }, doc);
  assert.equal(props['--ov-cr-head'], '70px', '133 + 12 − 75');
  placeControlRoom(null, doc);
  assert.equal(props['--ov-cr-head'], '70px', 'no bar: kept');
});

// Fake timers: setTimeout records, run() fires the earliest.
function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    get waits() { return [...pending.values()].map((p) => p.ms); },
    run() { const [id, p] = [...pending.entries()][0] || []; if (!id) return false; pending.delete(id); p.fn(); return true; },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test('the driver: one read when opened, the next a minute after it settles, none while hidden, a fresh one on Refresh, none after a refusal; closing drops a late answer', async () => {
  const timers = fakeTimers();
  let hidden = false, onVisible = null;
  const loads = [];
  let answerNext = () => answer();
  const driver = createControlRoomDriver({
    timers, now: () => NOW, intervalMs: 60_000,
    visibility: { hidden: () => hidden, subscribe: (fn) => { onVisible = fn; return () => { onVisible = null; }; } },
    load: async (serviceId, env, opts) => { loads.push([serviceId, env, !!opts.fresh]); return answerNext(); },
  });
  driver.open(3, 'prod');
  await settle();
  assert.deepEqual(loads, [[3, 'prod', false]]);
  assert.equal(driver.state().answer.service.name, 'Demo');
  assert.deepEqual(timers.waits, [60_000], 'the next read a minute after');
  driver.refresh();
  await settle();
  assert.deepEqual(loads.at(-1), [3, 'prod', true], 'Refresh asks for a fresh read');
  hidden = true;
  onVisible();
  assert.deepEqual(timers.waits, [], 'hidden: no read waits');
  hidden = false;
  onVisible();
  assert.equal(timers.waits.length, 1, 'visible again: armed');
  answerNext = () => { throw Object.assign(new Error('403: Reading live is not open to your role here.'), { status: 403 }); };
  timers.run();
  await settle();
  assert.deepEqual([driver.state().stopped, timers.waits], [true, []], 'a refusal stops the reads');
  // Another service while a read for the first runs: the late answer never lands on the second.
  const held = new Map();
  answerNext = () => new Promise((r) => { held.set(loads.at(-1)[0], r); });
  driver.open(4, 'staging');
  driver.open(5, 'prod');
  assert.deepEqual(loads.slice(-2), [[4, 'staging', false], [5, 'prod', false]]);
  held.get(4)(answer({ service: { id: 4, name: 'Four', slug: 'four' } }));
  await settle();
  assert.deepEqual([driver.state().key, driver.state().answer, driver.state().reading], ['5:prod', null, true], '4\'s answer dropped: 5 is still reading');
  held.get(5)(answer({ service: { id: 5, name: 'Five', slug: 'five' } }));
  await settle();
  assert.equal(driver.state().answer.service.name, 'Five', '5 gets its own');
  // Closing while a read runs drops its answer.
  let release;
  answerNext = () => new Promise((r) => { release = r; });
  driver.open(6, 'staging');
  driver.close();
  release(answer());
  await settle();
  assert.equal(driver.state().open, false);
  assert.equal(onVisible, null, 'closed: no visibility listener');
});

test('loadControlRoom posts the environment, and fresh only when asked', async () => {
  const seen = [];
  const fetchFn = async (path, init) => { seen.push([path, init.method, init.body]); return { ok: true }; };
  await loadControlRoom(3, 'prod', { fetchFn });
  await loadControlRoom('7/x', null, { fetchFn, fresh: true });
  assert.deepEqual(seen, [['/api/services/3/control-room', 'POST', '{"env":"prod"}'], ['/api/services/7%2Fx/control-room', 'POST', '{"fresh":true}']]);
});

// The SLIs and SLOs beside MTTD / MTTR; the rest of the live side folded under them.
const SLOS = {
  outcome: 'data', reason: null, cut: 3, rows: [
    { id: 'slo_availability_99', sli: 'slo_availability', objective: 0.99, window: '30d', objectiveSource: 'default',
      now: { name: 'slo:availability:composite_1h', unit: 'ratio', better: 'higher', role: 'good', window: '1h', outcome: 'data', value: 0.9993, min: 0.9993, max: 0.9993, n: 1 },
      budget: { name: 'slo:availability:error_budget_remaining', outcome: 'data', value: 0.42, min: 0.42, max: 0.42, n: 1 } },
    { id: 'checkout_errors_99_9', sli: 'checkout_errors', objective: 0.999, window: '30d', objectiveSource: 'repository',
      now: { name: 'shop:checkout_errors:error_ratio_5m', unit: 'ratio', better: 'lower', role: 'errors', window: '5m', outcome: 'data', value: null, min: 0.0004, max: 0.003, n: 2 }, budget: null },
    { id: 'slo_http_requests_99', sli: 'slo_http_requests', objective: 0.99, window: '30d', objectiveSource: 'default',
      now: { name: 'slo:http_requests:error_ratio_5m', unit: 'ratio', better: 'lower', role: 'errors', window: '5m', outcome: 'data', value: 0.2, min: 0.2, max: 0.2, n: 1 }, budget: null },
    { id: 'p99_99', sli: 'checkout_latency', objective: 0.99, window: '7d', objectiveSource: 'repository',
      now: { name: 'shop:checkout_latency:value_5m', unit: 'seconds', better: 'lower', role: 'latency', window: '5m', outcome: 'empty', reason: 'no series of this name answers live', value: null, min: null, max: null, n: 0 }, budget: null },
    { id: 'spent_99', sli: 'slo_latency', objective: 0.99, window: '30d', objectiveSource: 'default', now: null,
      budget: { name: 'slo:latency:error_budget_remaining', outcome: 'data', value: -0.25, min: -0.25, max: -0.25, n: 1 } },
    { id: 'not_read_99', sli: 'slo_queue', objective: 0.99, window: '30d', objectiveSource: 'repository',
      now: { name: 'q:x:ratio_5m', unit: 'ratio', better: 'higher', role: 'good', window: '5m', outcome: 'not-attempted', reason: 'the read ran out of time', value: null, min: null, max: null, n: 0 }, budget: null },
  ],
};

test('the SLIs and SLOs: each one\'s value now as read (a range across several series), its objective (a default said so), its budget left; the tone the budget\'s, else the SLI\'s against an objective the repository states — never against a default', () => {
  const m = slosOf(SLOS);
  assert.deepEqual(m.rows.map((r) => [r.title, r.tone]), [
    ['availability', 'warn'], ['checkout errors', 'bad'], ['http requests', 'none'], ['checkout latency', 'none'], ['latency', 'bad'], ['queue', 'none'],
  ], 'a budget under half warns, spent is red; the worst of two series past 0.1 % errors is red; a 20 % error ratio against a default objective is not judged');
  assert.deepEqual(m.rows[0].objective, { value: 0.99, window: '30 days', isDefault: true });
  assert.deepEqual(m.rows[3].now, { state: 'empty', note: 'shop:checkout_latency:value_5m answers nothing live' });
  assert.deepEqual(m.rows[4].now, { state: 'none', note: 'its repository records no series for it' });
  assert.deepEqual(m.rows[5].now, { state: 'not-read', note: 'Not read: the read ran out of time' });
  assert.equal(m.cut, 3);
  assert.deepEqual(slosOf({ outcome: 'data', rows: [], cut: 0, reason: 'its repository declares no SLO' }), { rows: [], unrecorded: [], note: 'Its repository declares no SLO.', cut: 0 });
  // An SLO its repository records nothing for has no row: named on one line.
  const bare = slosOf({ outcome: 'data', cut: 0, rows: [{ id: 'cart_99', sli: 'cartadditemhighlatency', objective: 0.99, window: '30d', objectiveSource: 'default', now: null, budget: null }, SLOS.rows[0]] });
  assert.deepEqual([bare.rows.map((r) => r.title), bare.unrecorded, bare.note], [['availability'], ['cartadditemhighlatency'], '']);
  const none = slosOf({ outcome: 'data', cut: 0, rows: [{ id: 'cart_99', sli: 'cart', objective: 0.99, window: '30d', objectiveSource: 'default', now: null, budget: null }] });
  assert.deepEqual([none.rows, none.unrecorded, none.note], [[], ['cart'], 'Its repository records no series for any of them, so none can be read live.']);
  assert.deepEqual(slosOf({ outcome: 'failed', reason: 'boom' }), { rows: [], note: 'The SLOs were not read: boom.', cut: 0 });
  assert.equal(slosOf(undefined), null, 'an older server: no section');
});

test('renderControlRoom: the status, MTTR and MTTD, then the SLIs and SLOs; the alerts, exporters and known metrics folded under "More from the live side", its summary counting what fires; an older server draws no SLO section', () => {
  globalThis.document = { activeElement: null };
  const { container } = panelHost();
  const m = buildControlRoomModel({ state: controlRoomAnswered(controlRoomOpened(CONTROL_ROOM_CLOSED, { serviceId: 3, env: 'prod', now: NOW }), answer({ slos: SLOS }), { now: NOW }), serviceName: 'Demo', envName: 'prod', mttx, now: NOW });
  renderControlRoom(container, m, { overview: {} });
  const html = container.innerHTML;
  const at = (x) => html.indexOf(x);
  assert.ok(at('ov-cr__status') < at('ov-cr__kpis') && at('ov-cr__kpis') < at('ov-cr__slos') && at('ov-cr__slos') < at('ov-cr__fold'), 'status, MTTR / MTTD, the SLOs, then the fold');
  assert.ok(at('ov-cr__fold') < at('ov-cr__alerts') && at('ov-cr__fold') < at('ov-cr__fams'), 'the alerts and the families inside the fold');
  assert.ok(html.includes('<details class="ov-cr__fold" data-cr-open="more">'), 'closed until opened, and kept open across redraws once opened');
  assert.ok(html.includes('<span class="ov-cr__h">More from the live side</span><span class="ov-cr__muted">1 alert firing · exporters · 2 known metric families</span>'));
  assert.ok(html.includes('<li class="ov-cr__slo ov-cr__slo--warn">'));
  assert.ok(html.includes('<span class="ov-cr__slo-now">99.9% over 1 h</span>'));
  assert.ok(html.includes('<span class="ov-cr__slo-obj ov-cr__muted">Objective 99% over 30 days (default)</span>'));
  assert.ok(html.includes('<span class="ov-cr__slo-obj ov-cr__muted">Objective 99.9% over 30 days</span>'), 'the repository\'s own objective, unmarked');
  assert.ok(html.includes('<span class="ov-cr__slo-budget">42% of its error budget left</span>'));
  assert.ok(html.includes('<span class="ov-cr__slo-now">0.04%–0.3% errors across 2 series over 5 min</span>'), 'a range, never one averaged number; judged against its objective, said exactly');
  // The fold's line counts every firing alert the status counted, not only the listed rows.
  assert.ok(m.more.detail.startsWith('1 alert firing'));
  // A threshold SLI is judged against its threshold, never its objective; its bound beside the objective; no "errors".
  const disk = slosOf({ outcome: 'data', cut: 0, rows: [{ id: 'disk_99', sli: 'disk', objective: 0.99, window: '30d', objectiveSource: 'repository',
    now: { name: 'node:disk:value_5m', unit: 'ratio', better: 'lower', role: 'value', threshold: 0.85, window: '5m', outcome: 'data', value: 0.5, min: 0.5, max: 0.5, n: 1 }, budget: null }] });
  assert.deepEqual([disk.rows[0].tone, disk.rows[0].judged], ['good', true], 'a disk half full under its 85 % ceiling is fine');
  const { container: c4 } = panelHost();
  renderControlRoom(c4, buildControlRoomModel({ state: controlRoomAnswered(controlRoomOpened(CONTROL_ROOM_CLOSED, { serviceId: 3, env: 'prod', now: NOW }), answer({ slos: { outcome: 'data', cut: 0, rows: [disk.rows.length && { id: 'disk_99', sli: 'disk', objective: 0.99, window: '30d', objectiveSource: 'repository', now: { name: 'node:disk:value_5m', unit: 'ratio', better: 'lower', role: 'value', threshold: 0.85, window: '5m', outcome: 'data', value: 0.5, min: 0.5, max: 0.5, n: 1 }, budget: { name: 'b', outcome: 'data', value: null, min: 0, max: 0.6, n: 2 } }] } }), { now: NOW }), serviceName: 'Demo', envName: 'prod', mttx, now: NOW }), { overview: {} });
  assert.ok(c4.innerHTML.includes('<span class="ov-cr__slo-now">50% over 5 min</span>'), 'a value, not "errors"');
  assert.ok(c4.innerHTML.includes('Objective 99% over 30 days, ≤ 85%</span>'));
  assert.ok(c4.innerHTML.includes('<span class="ov-cr__slo-budget">Error budget across 2 series: spent to 60% left</span>'), 'several budgets as their range; none left is spent');
  assert.ok(c4.innerHTML.includes('<li class="ov-cr__slo ov-cr__slo--bad">'), 'the lowest budget (spent) colours the row');
  assert.ok(html.includes('<span class="ov-cr__slo-budget">Error budget spent, 25% over</span>'));
  assert.ok(html.includes('<span class="ov-cr__slo-now ov-cr__slo-now--note ov-cr__muted">its repository records no series for it</span>'), 'a note takes the row\'s width');
  assert.ok(html.includes("Read live from the series its repository's own recording rules write. A default objective is the scan's: the repository states none, so the SLI is not judged against it. 3 more not read."));
  // Several series that read alike are one value, said so.
  const alike = { ...SLOS, cut: 0, rows: [{ ...SLOS.rows[1], now: { ...SLOS.rows[1].now, min: 0, max: 0, n: 2 } }] };
  const { container: c3 } = panelHost();
  renderControlRoom(c3, buildControlRoomModel({ state: controlRoomAnswered(controlRoomOpened(CONTROL_ROOM_CLOSED, { serviceId: 3, env: 'prod', now: NOW }), answer({ slos: alike }), { now: NOW }), serviceName: 'Demo', envName: 'prod', mttx, now: NOW }), { overview: {} });
  assert.ok(c3.innerHTML.includes('<span class="ov-cr__slo-now">0% errors in each of 2 series over 5 min</span>'));
  assert.ok(!c3.innerHTML.includes('A default objective'), 'no default, no note on it');
  // An older server: no slos key, no section; the fold all the same.
  const { container: c2 } = panelHost();
  renderControlRoom(c2, buildControlRoomModel({ state: openState(), serviceName: 'Demo', envName: 'prod', mttx, now: NOW }), { overview: {} });
  assert.ok(!c2.innerHTML.includes('ov-cr__slos') && c2.innerHTML.includes('ov-cr__fold'));
});

