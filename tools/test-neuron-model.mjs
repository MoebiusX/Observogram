// tools/test-neuron-model.mjs — the Neuron view's model over fabricated
// journey listings and run records (the shapes GET /api/journeys and
// GET /api/journeys/:name/runs return).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTCOMES, LADDER_KEYS, BLAST_FIELDS, sortRunsOldestFirst, metricPoints, ladderSeries, stackRowSeries,
  blastRadiusNodes, exposureSeries, buildJourneyDetail, buildNeuronModel, defaultFocus,
  TREND_MIN_RUNS, deliveryState, scheduleLag, trendReadiness, fleetTrendReadiness, latestCheck, attentionList,
} from './lib/neuron-model.mjs';

const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const at = (i) => new Date(T0 + i * 15 * 60e3).toISOString();

function run(i, over = {}) {
  return {
    journey: 'j', startedAt: at(i), tookMs: 100 + i, outcome: 'pass',
    drift: { alignmentPct: 90 - i, aligned: 9, drifted: 1, declaredNotLive: 0, liveNotDeclared: 0 },
    grade: { score: 80 - i, pass: true },
    gate: { thresholds: { minAlignmentPct: 50 }, breaches: [] },
    chains: { declaredTotal: 4, intact: 3, partial: 1, broken: 0, ladder: { healthy: 3, degraded: 1, broken: 0, unobserved: 0 }, integrityPct: 75, ladderIntegrityPct: 80, topExposure: { label: 'rules.yml', kind: 'alert_rule', slos: 2, alerts: 3 } },
    transition: { any: false, changed: [] },
    stackEvidence: { status: 'sampled', reason: null, rows: [
      { id: 'scrape_targets_down', family: 'scrape', product: 'generic', value: i % 2, unit: 'count', direction: 'lower', outcome: 'data', hint: i % 2 ? 'nonzero' : null, at: at(i) },
      { id: 'scrape_success_ratio', family: 'scrape', product: 'generic', value: 0.99, unit: 'ratio', direction: 'higher', outcome: 'data', hint: null, at: at(i) },
    ] },
    causes: { causes: [], vantage: { changed: false }, note: 'n' },
    notify: { status: 'sent', httpStatus: 202, reason: 'x' },
    ...over,
  };
}
const lost = (i) => ({ journey: 'j', startedAt: at(i), tookMs: 5, outcome: 'vantage-lost', error: 'ECONNREFUSED', gate: { thresholds: {}, breaches: [] } });

// A GET /api/journeys entry built from the newest record of `runs`.
function entry(name, runs, over = {}) {
  const sorted = sortRunsOldestFirst(runs);
  const last = sorted[sorted.length - 1] || null;
  return {
    name, loadError: null, packA: 'file: a', packB: 'file: b', gate: { minAlignmentPct: 50 }, scope: {},
    schedule: null, stackBudget: null, notify: null,
    lastRun: last && {
      startedAt: last.startedAt, outcome: last.outcome, alignmentPct: last.drift?.alignmentPct ?? null, gradeScore: last.grade?.score ?? null,
      breaches: last.gate?.breaches?.length ?? 0,
      notify: last.notify ? { status: last.notify.status } : null,
      stack: last.stackEvidence ? { status: 'sampled', families: { scrape: { id: 'scrape_targets_down', hint: last.stackEvidence.rows[0].hint } } } : null,
      chains: last.chains ?? null,
      transition: last.transition ? { any: !!last.transition.any, changed: last.transition.changed.length, worse: last.transition.changed.filter(c => c.direction === 'worse').length } : null,
      topCause: last.causes?.causes?.[0] ?? null,
      vantageChanged: last.causes?.vantage?.changed ?? null,
    },
    ...over,
  };
}

test('sortRunsOldestFirst: by startedAt, unparseable first in input order', () => {
  const a = { startedAt: at(2) }, b = { startedAt: at(0) }, c = { startedAt: 'nope' }, d = { startedAt: at(1) };
  assert.deepEqual(sortRunsOldestFirst([a, b, c, d]), [c, b, d, a]);
  assert.deepEqual(sortRunsOldestFirst(null), []);
});

test('metricPoints: a vantage-lost run is a gap (null), never 0; grade reads grade.score', () => {
  const pts = metricPoints([run(2), lost(1), run(0)], 'alignment');
  assert.deepEqual(pts.map(p => p.v), [90, null, 88]);
  assert.deepEqual(pts.map(p => p.outcome), ['pass', 'vantage-lost', 'pass']);
  assert.deepEqual(metricPoints([run(0)], 'grade').map(p => p.v), [80]);
  assert.equal(pts[1].t, Date.parse(at(1)));
});

test('ladderSeries skips runs without chains; stackRowSeries keeps gaps and ranks nonzero rows first', () => {
  const runs = [run(0), lost(1), run(2), run(3, { stackEvidence: null })];
  const ladder = ladderSeries(runs);
  assert.equal(ladder.length, 3);
  assert.deepEqual(Object.keys(ladder[0]).filter(k => LADDER_KEYS.includes(k)), [...LADDER_KEYS]);
  assert.equal(ladder[0].integrityPct, 75);
  const rows = stackRowSeries(runs);
  assert.deepEqual(rows.map(r => r.id), ['scrape_targets_down', 'scrape_success_ratio']);
  // run(0) value 0, run(2) value 0 — run(1) lost and run(3) without evidence are gaps
  assert.equal(rows[0].series.length, 2);
  assert.equal(rows[0].samples, 2);
  assert.equal(rows[0].nonzero, 0);
  assert.equal(rows[0].direction, 'lower');
  const odd = stackRowSeries([run(1), run(3)]);
  assert.equal(odd[0].id, 'scrape_targets_down');
  assert.equal(odd[0].nonzero, 2);
});

test('buildJourneyDetail: latest record blocks, notify null vs absent, vantage-lost error', () => {
  const noNotify = run(2); delete noNotify.notify;
  const d = buildJourneyDetail({ name: 'j', gate: { a: 1 } }, [run(0), noNotify, lost(3)]);
  assert.equal(d.runs, 3);
  assert.deepEqual(d.outcomes, { pass: 2, 'gate-failed': 0, 'vantage-lost': 1 });
  assert.equal(d.latest.outcome, 'vantage-lost');
  assert.equal(d.latest.error, 'ECONNREFUSED');
  assert.equal(d.latest.drift, null);
  assert.equal(d.latest.notify, undefined, 'a record without a notify key reads undefined (unknown), never null');
  const d2 = buildJourneyDetail({ name: 'j' }, [run(0), { ...run(1), notify: null }]);
  assert.equal(d2.latest.notify, null);
  const d3 = buildJourneyDetail({ name: 'j' }, [noNotify]);
  assert.equal(d3.latest.notify, undefined);
  assert.deepEqual(d.durations.map(x => x.v), [100, 102, 5]);
  assert.deepEqual(d.alignment.map(x => x.v), [90, 88, null]);
});

test('buildNeuronModel: fleet counts, paired deltas, chains, exposure, delivery, stack signal', () => {
  const A = [run(0), run(1), run(2)];                        // latest 88, previous 89 → delta -1
  const B = [run(0, { drift: { alignmentPct: 60 }, grade: { score: 40 } }), lost(1)]; // latest is a gap; previous 60
  const C = [run(0, { outcome: 'gate-failed', gate: { thresholds: {}, breaches: [{ criterion: 'minAlignmentPct', detail: 'x' }, { criterion: 'stack.scrape_targets_down', detail: 'y' }] },
    chains: { declaredTotal: 2, intact: 0, ladder: { healthy: 0, degraded: 1, broken: 1, unobserved: 0 }, integrityPct: 25, ladderIntegrityPct: 30, topExposure: { label: 'dash', kind: 'dashboard', slos: 5, alerts: 0 } },
    transition: { any: true, changed: [{ direction: 'worse' }] },
    causes: { causes: [{ rank: 1, kind: 'observogram-deploy', score: 5, evidence: 'e' }, { rank: 2, kind: 'config-drift', score: 3, evidence: 'f' }], vantage: { changed: true } },
    stackEvidence: { status: 'sampled', reason: null, rows: [{ id: 'scrape_targets_down', family: 'scrape', product: 'generic', value: 2, unit: 'count', direction: 'lower', outcome: 'data', hint: 'nonzero', at: at(0) }] },
    notify: { status: 'failed', httpStatus: 500 } })];
  const journeys = [
    entry('a', A, { schedule: { cron: '*/15 * * * *', cadenceMs: 900000 }, notify: { urlEnv: 'U' } }),
    entry('b', B),
    entry('c', C, { gate: { stack: { rows: { scrape_targets_down: { max: 0 } } } } }),
    entry('d', [], { loadError: 'bad yaml' }),
  ];
  const m = buildNeuronModel({ journeys, runsByName: { a: A, b: B, c: C }, window: 50 });

  assert.equal(m.fleet.journeys, 4);
  assert.equal(m.fleet.loadErrors, 1);
  assert.equal(m.fleet.scheduled, 1);
  assert.equal(m.fleet.notifying, 1);
  assert.equal(m.fleet.stackGated, 1);
  assert.deepEqual(m.fleet.outcomes, { pass: 1, 'gate-failed': 1, 'vantage-lost': 1, 'never-run': 1 });
  // latest alignment: a 88, b gap, c 90 → mean 89 over n=2; paired delta: a (88-89)=-1, b (gap → skipped), c (no previous) → -1
  assert.deepEqual(m.fleet.alignment, { mean: 89, delta: -1, n: 2 });
  assert.deepEqual(m.fleet.grade, { mean: 79, delta: -1, n: 2 });
  assert.equal(m.fleet.chains.journeys, 2, 'b lost its vantage: no chains on its last run');
  assert.equal(m.fleet.chains.intact, 3);
  assert.equal(m.fleet.chains.declaredTotal, 6);
  assert.deepEqual(m.fleet.chains.ladder, { healthy: 3, degraded: 2, broken: 1, unobserved: 0 });
  assert.deepEqual(m.fleet.chains.worse, ['c']);
  assert.equal(m.fleet.chains.integrityPct, 50);
  assert.deepEqual(m.fleet.topExposure, { journey: 'c', label: 'dash', kind: 'dashboard', slos: 5, alerts: 0 });
  assert.deepEqual(m.fleet.delivery, [{ key: 'failed', count: 1 }, { key: 'sent', count: 1 }]);
  assert.deepEqual(m.fleet.stackSignal, ['c'], 'only c\'s last run carries a nonzero lower-is-comfortable sample (a: run(2) sampled 0)');
  assert.deepEqual(m.fleet.vantageChanged, ['c']);
  assert.deepEqual(m.breachFrequency, [{ key: 'minAlignmentPct', count: 1 }, { key: 'stack.scrape_targets_down', count: 1 }]);
  assert.deepEqual(m.causeKinds, [{ key: 'config-drift', count: 1 }, { key: 'observogram-deploy', count: 1 }]);
  assert.deepEqual(m.generatedFrom, { journeys: 4, runs: 6 });
  assert.deepEqual(Object.keys(m.perJourney), ['a', 'b', 'c', 'd']);
  assert.equal(m.perJourney.d.latest, null);
  assert.ok(JSON.stringify(m).length > 0, 'plain data');
});

test('heatmap: columns = the longest history in the window, rows left-padded, newest last; window slices the newest', () => {
  const A = [run(0), run(1), run(2), run(3)];
  const B = [run(5), lost(6)];
  const m = buildNeuronModel({ journeys: [entry('a', A), entry('b', B)], runsByName: { a: A, b: B }, window: 3 });
  assert.equal(m.window, 3);
  assert.equal(m.heatmap.columns, 3);
  const a = m.heatmap.rows.find(r => r.name === 'a');
  const b = m.heatmap.rows.find(r => r.name === 'b');
  assert.deepEqual(a.cells.map(c => c.alignment), [89, 88, 87], 'window 3 keeps the newest three of four');
  assert.deepEqual(b.cells.map(c => c && c.outcome), [null, 'pass', 'vantage-lost']);
  assert.equal(b.cells[2].alignment, null);
  assert.deepEqual(m.series.alignment.find(s => s.name === 'a').points.map(p => p.v), [89, 88, 87]);
});

test('defaultFocus: a journey that needs a person first, then a chain getting worse, gate-failed, vantage-lost, lowest alignment, name', () => {
  const mk = (rows) => buildNeuronModel({ journeys: rows.map(([n, r, o]) => entry(n, r, o)), runsByName: Object.fromEntries(rows.map(([n, r]) => [n, r])) });
  assert.equal(defaultFocus(mk([['a', [run(0)]], ['b', [run(0, { outcome: 'gate-failed' })]]])), 'b');
  assert.equal(defaultFocus(mk([['a', [lost(0)]], ['b', [run(0)]]])), 'a');
  assert.equal(defaultFocus(mk([['a', [run(0)]], ['b', [run(0, { drift: { alignmentPct: 10 } })]]])), 'b');
  assert.equal(defaultFocus(mk([['b', [run(0)]], ['a', [run(0)]]])), 'a');
  const worse = run(0, { outcome: 'pass', transition: { any: true, changed: [{ direction: 'worse' }] } });
  assert.equal(defaultFocus(mk([['a', [run(0, { outcome: 'gate-failed' })]], ['z', [worse]]])), 'a', 'a failed check leads over a passing journey whose chain got worse');
  assert.equal(defaultFocus(mk([['a', []], ['z', [worse]]])), 'z', 'never run stays behind a chain getting worse');
  assert.equal(defaultFocus(mk([['a', [run(0)]], ['z', [worse]]])), 'z');
  assert.equal(defaultFocus(mk([])), null);
  assert.equal(defaultFocus(buildNeuronModel({ journeys: [entry('only', [])], runsByName: {} })), 'only');
});

test('defaultFocus: a passing journey never leads while another cannot load, failed to notify or is overdue', () => {
  const now = Date.parse(at(0)) + 10 * 60e3;                 // the newest runs are 10 min old
  const ok = [run(0, { drift: { alignmentPct: 80 } })];
  const notify = [run(0, { drift: { alignmentPct: 100 }, notify: { status: 'failed', error: 'ECONNRESET' } })];
  const stale = [run(0, { drift: { alignmentPct: 100 } })];
  const rows = [
    entry('ok', ok),
    entry('notify', notify, { notify: { urlEnv: 'U' } }),
    entry('broken', [], { loadError: 'bad yaml' }),
    entry('stale', stale, { schedule: { every: '1m', cadenceMs: 60e3 } }),
  ];
  const runsByName = { ok, notify, stale };
  const pick = (names) => defaultFocus(buildNeuronModel({ journeys: rows.filter(j => names.includes(j.name)), runsByName }), { now });
  assert.equal(pick(['ok', 'notify', 'broken', 'stale']), 'broken');
  assert.equal(pick(['ok', 'notify', 'stale']), 'notify');
  assert.equal(pick(['ok', 'stale']), 'stale');
  assert.equal(pick(['ok']), 'ok');
});

test('buildNeuronModel: notifying journeys with no delivery on record are counted, never read as none needed', () => {
  const sent = [run(0)];
  const skipped = [run(0, { notify: { status: 'skipped' } })];
  const preDelivery = [run(0, { outcome: 'gate-failed', notify: null })];
  const journeys = [
    entry('sent', sent, { notify: { urlEnv: 'U' } }),
    entry('skipped', skipped, { notify: { urlEnv: 'U' } }),
    entry('pre-delivery', preDelivery, { notify: { urlEnv: 'U' } }),
    entry('never', [], { notify: { urlEnv: 'U' } }),
    entry('quiet', [run(0, { notify: null })]),
  ];
  const m = buildNeuronModel({ journeys, runsByName: { sent, skipped, 'pre-delivery': preDelivery } });
  assert.equal(m.fleet.notifying, 4);
  assert.equal(m.fleet.notifyingNeverRun, 1);
  assert.equal(m.fleet.deliveryUnknown, 2, 'the never-run journey and the record written before delivery');
  const allSkipped = buildNeuronModel({ journeys: [entry('skipped', skipped, { notify: { urlEnv: 'U' } })], runsByName: { skipped } });
  assert.equal(allSkipped.fleet.deliveryUnknown, 0);
  assert.equal(buildNeuronModel({}).fleet.deliveryUnknown, 0);
});

test('blastRadiusNodes: declared chains only, one entry per node with every chain, widest first; exposureSeries per run', () => {
  const node = (key, kind, slos, alerts, total, extra = {}) => ({ key, kind, label: key, status: 'declared_only', ladder: { rung: 'absent', status: null, detail: null }, blastRadius: { slos, alerts, panels: 0, dashboards: 0, routes: 0, remediations: 0, total }, ...extra });
  const br = (title, verdict, degraded) => ({ rootKey: `k:${title}`, title, rootKind: 'slo', verdict, ladderVerdict: verdict === 'intact' ? 'healthy' : 'broken', integrityPct: 50, ladderIntegrityPct: 50, confidence: 'verified', missingRoles: [], degraded });
  const rec = run(0, { branches: [
    br('A', 'broken', [node('backend', 'backend', 5, 4, 39), node('rec1', 'recording_rule', 1, 1, 10)]),
    br('B', 'partial', [node('backend', 'backend', 5, 4, 39), node('alert1', 'alert_rule', 2, 3, 5, { status: 'drifted', ladder: { rung: 'alive', status: 'present_stale', detail: 'x' } })]),
    br('U', 'undeclared', [node('live-only', 'metric', 9, 9, 9)]),
    br('I', 'intact', []),
  ] });
  const nodes = blastRadiusNodes(rec);
  assert.deepEqual(nodes.map(n => n.key), ['backend', 'alert1', 'rec1'], 'live-only node of the undeclared chain excluded; sorted by SLOs, then alerts');
  assert.deepEqual(nodes[0].chains, ['A', 'B'], 'one entry, both chains');
  assert.equal(nodes[0].total, 39);
  assert.equal(nodes[1].ladderStatus, 'present_stale');
  assert.deepEqual(Object.keys(nodes[0]).filter(k => BLAST_FIELDS.includes(k)), [...BLAST_FIELDS]);
  assert.deepEqual(blastRadiusNodes({}), []);
  assert.deepEqual(blastRadiusNodes(null), []);

  const noTop = run(2); noTop.chains = { ...noTop.chains, topExposure: null, degradedNodes: 0 };
  const exp = exposureSeries([run(0), lost(1), noTop]);
  assert.equal(exp.length, 2, 'the vantage-lost run carries no chains and is skipped');
  assert.deepEqual(exp.map(e => [e.slos, e.alerts, e.degradedNodes]), [[2, 3, 0], [0, 0, 0]]);
  assert.equal(exp[0].label, 'rules.yml');

  const m = buildNeuronModel({ journeys: [entry('a', [rec]), entry('b', [run(0)])], runsByName: { a: [rec], b: [run(0)] } });
  assert.deepEqual(m.fleet.exposures.map(n => [n.journey, n.key, n.slos]), [['a', 'backend', 5], ['a', 'alert1', 2], ['a', 'rec1', 1]], 'fleet exposures carry the journey; b has no branches');
  assert.equal(m.perJourney.a.blast.length, 3);
  assert.equal(m.perJourney.b.blast.length, 0);
  assert.deepEqual(m.series.exposure.find(s => s.name === 'a').points.map(p => p.v), [2]);
  assert.equal(m.fleet.chains.degradedNodes, 0, 'run() fixtures carry no degradedNodes count');
});

test('inventory coverage: per-journey series from the records, fleet sums from the listing summaries', () => {
  const invRec = (up, silent, unexpected, status = 'checked') => ({ status, reason: null, site: 's', environment: 'prod', kinds: {
    qmgr: { mode: 'enumerated', title: 'queue manager', status, expected: 3, observed: 3 - silent.length, up: up.length, upNames: up, down: [], silent, unexpected, coveragePct: Math.round((up.length / 3) * 1000) / 10 },
    queue: { mode: 'counted', title: 'queue', status, total: 7, counts: { QM1: 7 }, min: { QM1: 5 }, below: [], missing: [] },
  } });
  const summary = (inv) => ({ status: inv.status, reason: null, environment: 'prod', kinds: {
    qmgr: { mode: 'enumerated', title: 'queue manager', status: inv.status, expected: 3, up: inv.kinds.qmgr.up, down: 0, silent: inv.kinds.qmgr.silent.length, unexpected: inv.kinds.qmgr.unexpected.length, coveragePct: inv.kinds.qmgr.coveragePct },
    queue: { mode: 'counted', title: 'queue', status: inv.status, total: 7, below: 0, missing: 0 },
  } });
  const A = [run(0, { inventory: invRec(['QM1'], ['QM2', 'QM3'], []) }), run(1, { inventory: invRec(['QM1', 'QM2', 'QM3'], [], ['QMX']) })];
  const B = [run(0, { inventory: invRec([], [], [], 'not-attempted') })];
  const C = [run(0)];
  const journeys = [
    entry('a', A, { lastRun: { ...entry('a', A).lastRun, inventory: summary(A[1].inventory) } }),
    entry('b', B, { lastRun: { ...entry('b', B).lastRun, inventory: summary(B[0].inventory) } }),
    entry('c', C),
  ];
  const m = buildNeuronModel({ journeys, runsByName: { a: A, b: B, c: C } });
  assert.deepEqual(m.perJourney.a.inventory.series.qmgr.map(p => [p.up, p.silent, p.unexpected, p.coveragePct]), [[1, 2, 0, 33.3], [3, 0, 1, 100]]);
  assert.equal(m.perJourney.a.inventory.latest.kinds.qmgr.unexpected[0], 'QMX');
  assert.deepEqual(m.perJourney.b.inventory.series.qmgr, [], 'a not-attempted record carries no coverage point');
  assert.equal(m.perJourney.b.inventory.latest.status, 'not-attempted');
  assert.equal(m.perJourney.c.inventory.latest, null);
  assert.deepEqual(m.perJourney.c.inventory.series, {});
  assert.equal(m.fleet.inventory.journeys, 2, 'c declares no block and does not count');
  assert.deepEqual(m.fleet.inventory.unchecked, ['b']);
  assert.deepEqual(m.fleet.inventory.kinds.qmgr, { title: 'queue manager', expected: 3, up: 3, down: 0, silent: 0, unexpected: 1, journeys: 1, coveragePct: 100 });
  assert.deepEqual(m.fleet.inventory.counted.queue, { title: 'queue', total: 7, below: 0, missing: 0, journeys: 1 });
  assert.deepEqual(buildNeuronModel({ journeys: [entry('c', C)], runsByName: { c: C } }).fleet.inventory, { journeys: 0, unchecked: [], kinds: {}, counted: {} });
});

test('OUTCOMES is the record vocabulary', () => {
  assert.deepEqual([...OUTCOMES], ['pass', 'gate-failed', 'vantage-lost']);
});

test('deliveryState: sent / skipped / failed from the record; null → not configured; absent → unknown only where notify is declared', () => {
  const d = (runs, journey = { name: 'j' }) => buildJourneyDetail(journey, runs);
  assert.equal(deliveryState(d([])), null, 'no run, no delivery');
  assert.equal(deliveryState(d([run(0)])), 'sent');
  assert.equal(deliveryState(d([run(0, { notify: { status: 'skipped', reason: 'no transition' } })])), 'skipped');
  assert.equal(deliveryState(d([run(0, { notify: { status: 'failed', httpStatus: 500 } })])), 'failed');
  assert.equal(deliveryState(d([run(0, { notify: { status: 'weird' } })])), 'unknown');
  assert.equal(deliveryState(d([run(0, { notify: null })])), 'not-configured');
  const noKey = run(0); delete noKey.notify;
  assert.equal(deliveryState(d([noKey])), 'not-configured', 'an older record on a journey that declares no notify: block');
  assert.equal(deliveryState(d([noKey], { name: 'j', notify: { urlEnv: 'U' } })), 'unknown', 'written before delivery on a journey that notifies');
});

test('scheduleLag: overdue past two cadences plus grace; unknown without a regular cadence', () => {
  const now = Date.parse(at(0)) + 40 * 60e3;                 // the newest run is 40 min old
  const d = (schedule) => buildJourneyDetail({ name: 'j', schedule }, [run(0)]);
  assert.deepEqual(scheduleLag(d({ cron: '*/15 * * * *', cadenceMs: 15 * 60e3 }), { now }), { ageMs: 40 * 60e3, cadenceMs: 15 * 60e3, scheduled: true, overdue: true });
  assert.equal(scheduleLag(d({ cron: '*/30 * * * *', cadenceMs: 30 * 60e3 }), { now }).overdue, false);
  assert.equal(scheduleLag(d({ cron: '0 9 * * 1-5', cadenceMs: null, cadenceNote: 'irregular' }), { now }).overdue, null, 'irregular cron: unknown, never on time');
  assert.deepEqual(scheduleLag(d(null), { now }), { ageMs: 40 * 60e3, cadenceMs: null, scheduled: false, overdue: null });
  assert.equal(scheduleLag(buildJourneyDetail({ name: 'j', schedule: { cadenceMs: 1 } }, []), { now }).ageMs, null);
});

test('trendReadiness: TREND_MIN_RUNS runs, and as many that could observe; the fleet reads its longest history', () => {
  assert.equal(TREND_MIN_RUNS, 3);
  const one = buildJourneyDetail({ name: 'a' }, [lost(0)]);
  assert.deepEqual(trendReadiness(one), { minRuns: 3, runs: 1, observed: 0, ready: false, observedReady: false });
  const mixed = buildJourneyDetail({ name: 'b' }, [run(0), lost(1), run(2)]);
  assert.deepEqual(trendReadiness(mixed), { minRuns: 3, runs: 3, observed: 2, ready: true, observedReady: false });
  const m = buildNeuronModel({ journeys: [entry('a', [lost(0)]), entry('b', [run(0), run(1), run(2)])], runsByName: { a: [lost(0)], b: [run(0), run(1), run(2)] } });
  assert.deepEqual(fleetTrendReadiness(m), { minRuns: 3, runs: 3, observed: 3, ready: true, observedReady: true });
  assert.deepEqual(fleetTrendReadiness(buildNeuronModel({})), { minRuns: 3, runs: 0, observed: 0, ready: false, observedReady: false });
});

test('latestCheck and attentionList: the four outcomes kept apart, most urgent first', () => {
  const now = Date.parse(at(0)) + 4 * 24 * 3600e3;          // four days after the runs
  const lostCheck = latestCheck(buildJourneyDetail({ name: 'l' }, [lost(0)]), { now });
  assert.equal(lostCheck.outcome, 'vantage-lost');
  assert.equal(lostCheck.error, 'ECONNREFUSED');
  assert.equal(lostCheck.ageMs, 4 * 24 * 3600e3);
  assert.equal(lostCheck.trend.ready, false);
  assert.equal(latestCheck(buildJourneyDetail({ name: 'n' }, []), { now }).outcome, 'never-run');
  assert.equal(latestCheck(null), null);

  const failed = [run(0, { outcome: 'gate-failed', gate: { thresholds: {}, breaches: [{ criterion: 'minAlignmentPct', detail: 'x' }] } })];
  const passNotify = [run(0, { notify: { status: 'failed', error: 'ECONNRESET' } })];
  const onTime = [run(0)];
  const stale = [run(0)];
  const journeys = [
    entry('pass-ok', onTime),
    entry('stale', stale, { schedule: { cron: '*/15 * * * *', cadenceMs: 15 * 60e3 } }),
    entry('never', []),
    entry('notify', passNotify),
    entry('lost', [lost(0)]),
    entry('failed', failed),
    entry('broken', [], { loadError: 'bad yaml' }),
  ];
  const m = buildNeuronModel({ journeys, runsByName: { 'pass-ok': onTime, stale, notify: passNotify, lost: [lost(0)], failed } });
  const failedCheck = latestCheck(m.perJourney.failed, { now });
  assert.equal(failedCheck.outcome, 'gate-failed');
  assert.equal(failedCheck.breaches, 1);
  assert.equal(latestCheck(m.perJourney.notify, { now }).delivery, 'failed');
  const list = attentionList(m, { now });
  assert.deepEqual(list.map(a => [a.name, a.reason]), [
    ['broken', 'load-error'], ['failed', 'gate-failed'], ['lost', 'vantage-lost'], ['notify', 'notify-failed'], ['stale', 'overdue'], ['never', 'never-run'],
  ]);
  assert.deepEqual(list.find(a => a.name === 'broken').reasons, ['load-error', 'never-run']);
  assert.ok(!list.some(a => a.name === 'pass-ok'), 'a passing, unscheduled journey needs nobody');
});
