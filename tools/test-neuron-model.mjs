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
  assert.deepEqual(d.outcomes, { pass: 2, 'gate-failed': 0, 'nothing-compared': 0, 'vantage-lost': 1, 'scan-partial': 0 });
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

test('buildJourneyDetail and packSourceHtml: a registered Pack A is named by its label, never by a server path', async () => {
  const { packSourceHtml } = await import('../studio/util.mjs');
  const file = 'C:/Users/someone/elsewhere/ws/packs/uploaded-krystaline-46245ab3.pack.yaml';
  const ref = { id: 'uploaded-krystaline-46245ab3', label: 'krystaline · prod · repository' };
  const d = buildJourneyDetail({ name: 'krystaline.prod', packA: file, packARef: ref, packB: 'mcp: https://mcp.example/x', packBRef: null }, []);
  assert.deepEqual([d.packARef, d.packBRef], [ref, null]);
  const html = packSourceHtml(d.packA, d.packARef);
  assert.equal(html, '<code title="uploaded-krystaline-46245ab3 · C:/Users/someone/elsewhere/ws/packs/uploaded-krystaline-46245ab3.pack.yaml">krystaline · prod · repository</code>');
  assert.equal(packSourceHtml(d.packB, d.packBRef), '<code>mcp: https://mcp.example/x</code>', 'a source that is no registered pack reads as the definition gives it');
  assert.equal(packSourceHtml(null, null), '<code>?</code>');
  assert.equal(buildJourneyDetail({ name: 'old' }, []).packARef, null, 'a listing without the field (an older server): null');
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
  assert.deepEqual(m.fleet.outcomes, { pass: 1, 'gate-failed': 1, 'nothing-compared': 0, 'vantage-lost': 1, 'scan-partial': 0, 'never-run': 1 });
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

test('OUTCOMES is the record vocabulary, read as a reader says it (a pass over nothing compared is nothing-compared; a stopped Run is scan-partial)', () => {
  assert.deepEqual([...OUTCOMES], ['pass', 'gate-failed', 'nothing-compared', 'vantage-lost', 'scan-partial']);
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

// The Neuron and Journeys views' notify hints (studio/journeys-view.mjs; the
// follow-up journey-notify-env-ownership): a journey notifies through one of
// its org's notify hooks, and one the server would refuse is never "Set up"
// — its Notification row says the refusal, after any delivery; an org that
// can have no hook is told so, never a hook to add.
test('notify hints name the org\'s hook variables — <KEY>, said so, when the org is unknown (never guessed as DEFAULT) — and a journey the server would refuse is never "Set up": the Neuron view says the refusal, whether it ran before or not; for an org whose every hook name another org\'s id takes, the hints say the server\'s sentence that none can be set', async () => {
  const jv = await import('../studio/journeys-view.mjs');
  const { setActiveOrg } = await import('../studio/api.mjs');
  const KEY_NOTE = ' <KEY> is this org\'s id in capitals, with - as _.';
  assert.equal(jv.notifyHookExample('pay-eu'), 'OBSERVOGRAM_ORG_PAY_EU_NOTIFY_<HOOK>_URL');
  assert.equal(jv.notifyHookExample('default'), 'OBSERVOGRAM_ORG_DEFAULT_NOTIFY_<HOOK>_URL');
  assert.equal(jv.notifyKeyNote('pay-eu'), '');
  for (const org of [null, undefined, '']) {
    assert.equal(jv.notifyHookExample(org), 'OBSERVOGRAM_ORG_<KEY>_NOTIFY_<HOOK>_URL', String(org));
    assert.equal(jv.notifyKeyNote(org), KEY_NOTE, String(org));
  }
  // The not-configured remedy reads the studio's active org when it is read.
  const remedy = (example) => `Add notify: { urlEnv: ${example} } to the journey file to be warned when it changes — one of this org's notify hooks, which the server's operator sets (GET /api/journeys/notify-hooks lists them).`;
  setActiveOrg(null);
  assert.equal(jv.DELIVERY_OUTCOMES['not-configured'].remedy, `${remedy('OBSERVOGRAM_ORG_<KEY>_NOTIFY_<HOOK>_URL')}${KEY_NOTE}`);
  setActiveOrg('pay-eu');
  try {
    assert.equal(jv.DELIVERY_OUTCOMES['not-configured'].remedy, remedy('OBSERVOGRAM_ORG_PAY_EU_NOTIFY_<HOOK>_URL'));
  } finally {
    setActiveOrg(null);
  }
  assert.ok(!JSON.stringify(jv.DELIVERY_OUTCOMES).includes('MY_WEBHOOK_URL'), 'no bare name is suggested');
  // Before any delivery: what is set up, or the server's refusal (GET /api/journeys' notify.problem).
  assert.equal(jv.notifySetupLine({ urlEnv: 'OBSERVOGRAM_ORG_PAY_EU_NOTIFY_ONCALL_URL', authEnv: null, on: 'always', format: 'json' }),
    'Set up: posts always to the webhook in $OBSERVOGRAM_ORG_PAY_EU_NOTIFY_ONCALL_URL.');
  assert.equal(jv.notifySetupLine({ urlEnv: 'OBSERVOGRAM_ORG_PAY_EU_NOTIFY_ONCALL_URL' }), 'Set up: posts transitions to the webhook in $OBSERVOGRAM_ORG_PAY_EU_NOTIFY_ONCALL_URL.');
  const problem = 'journey legacy is not run: its notify.urlEnv "MY_HOOK_URL" is not a notify hook of org \'pay-eu\' — the server posts only to OBSERVOGRAM_ORG_PAY_EU_NOTIFY_<HOOK>_URL';
  const refused = jv.notifySetupLine({ urlEnv: 'MY_HOOK_URL', authEnv: null, on: 'always', format: 'json', problem });
  // The run's text opens `journey <name> is not run: `; the line's lead says that once.
  const reason = 'its notify.urlEnv "MY_HOOK_URL" is not a notify hook of org \'pay-eu\' — the server posts only to OBSERVOGRAM_ORG_PAY_EU_NOTIFY_<HOOK>_URL';
  assert.equal(refused, `The server will not run this journey as it stands: ${reason}`);
  assert.equal(jv.notifySetupLine({ urlEnv: 'MY_HOOK_URL', problem: `journey Pay EU legacy is not run: ${reason}` }),
    `The server will not run this journey as it stands: ${reason}`, 'a name: with spaces');
  assert.ok(!refused.includes('Set up'));
  // The Neuron view's Notification row says the refusal whatever the newest
  // record says: a journey that notified before the rule, or through the
  // CronJob's CLI, is the one the migration must find (docs/NOTIFY_HOOKS.md §17.2 step 1).
  const nv = await import('../studio/neuron-view.mjs');
  const { escapeHtml } = await import('../studio/util.mjs');
  const legacy = (runs) => entry('legacy', runs, { notify: { urlEnv: 'MY_HOOK_URL', authEnv: null, on: 'always', format: 'json', problem } });
  const hooked = (runs) => entry('hooked', runs, { notify: { urlEnv: 'OBSERVOGRAM_ORG_PAY_EU_NOTIFY_ONCALL_URL', authEnv: null, on: 'always', format: 'json' } });
  const notificationRow = (journey, runs) => { const d = buildJourneyDetail(journey(runs), runs); return nv.deliveryLine(d, latestCheck(d)); };
  for (const [runs, delivery] of [
    [[], null],
    [[run(0)], 'Notification sent'],
    [[run(0, { notify: { status: 'failed', error: 'HTTP 500', httpStatus: 500 } })], 'Notification failed'],
    [[run(0, { notify: { status: 'skipped', reason: 'policy transitions: no transition' } })], 'Nothing to notify'],
    [[run(0, { notify: null })], 'No notifications set up'],
    [[run(0, { notify: {} })], 'Delivery unknown'],
  ]) {
    const label = delivery || 'no record';
    const row = notificationRow(legacy, runs);
    assert.ok(row.includes(escapeHtml(refused)), `${label}: the row says the server's refusal — ${row}`);
    if (delivery) assert.ok(row.includes(`>${delivery}</span>`), `${label}: the newest record's delivery is still said — ${row}`);
    assert.ok(!row.includes('Set up'), label);
    assert.ok(!notificationRow(hooked, runs).includes('will not run'), `${label}: a journey through its org's hook is not flagged`);
  }
  // An org whose every hook name another org's id takes (pay beside pay-notify): GET /api/journeys carries the
  // listing's none as notifyUnavailable; the listing loaders — the Journeys view's and the Neuron view's — note it
  // for the org they asked for, and the not-configured remedy and the evidence block's hint say it, never a hook to
  // add, which no name could satisfy. Another org, and an answer without it, keep the hook example.
  const NONE = "no notify hook can be set for org 'pay' — another org's id also maps onto every OBSERVOGRAM_ORG_PAY_NOTIFY_<HOOK>_URL by the longest-prefix rule, so the server posts no notification for this org's journeys: whoever holds the workspace leaves notify out of them";
  const SAID = `N${NONE.slice(1)}.`;
  const answering = (body) => async (path) => { assert.equal(path, '/api/journeys'); return body; };
  const libs = async () => ({ model: { buildNeuronModel } });
  const hint = (org) => `Add <code>notify: { urlEnv: ${escapeHtml(jv.notifyHookExample(org))} }</code> to the journey file to post transitions to a webhook — one of this org's notify hooks, set by the server's operator; the URL and token stay in the server's environment.`;
  try {
    setActiveOrg('pay');
    assert.equal(nv.notifyHintHtml('pay'), hint('pay'), 'before any listing: the hook example');
    assert.deepEqual((await jv.loadJourneysData({ fetchFn: answering({ journeys: [], notifyUnavailable: NONE }) })).journeys, []);
    assert.equal(jv.notifyUnavailableOf('pay'), SAID);
    assert.equal(jv.DELIVERY_OUTCOMES['not-configured'].remedy, SAID, 'the remedy says no hook can be set');
    assert.equal(nv.notifyHintHtml('pay'), escapeHtml(SAID), 'the evidence hint says no hook can be set');
    setActiveOrg('pay-eu');
    assert.equal(jv.DELIVERY_OUTCOMES['not-configured'].remedy, remedy('OBSERVOGRAM_ORG_PAY_EU_NOTIFY_<HOOK>_URL'), 'another org never borrows pay\'s answer');
    assert.equal(nv.notifyHintHtml('pay-eu'), hint('pay-eu'));
    setActiveOrg('pay');
    await nv.loadNeuronData({ fetchFn: answering({ journeys: [] }), libs });
    assert.equal(nv.notifyHintHtml('pay'), hint('pay'), 'an answer without it: the hook example');
    await nv.loadNeuronData({ fetchFn: answering({ journeys: [], notifyUnavailable: NONE }), libs });
    assert.equal(nv.notifyHintHtml('pay'), escapeHtml(SAID), 'the Neuron view\'s loader notes it');
    // Sign-in off: the studio knows no org, and the answer is the default org's.
    setActiveOrg(null);
    await jv.loadJourneysData({ fetchFn: answering({ journeys: [], notifyUnavailable: NONE }) });
    assert.equal(jv.DELIVERY_OUTCOMES['not-configured'].remedy, SAID);
  } finally {
    for (const org of ['pay', null]) { setActiveOrg(org); await jv.loadJourneysData({ fetchFn: answering({ journeys: [] }) }); }
    setActiveOrg(null);
  }
});

test('Stack evidence reads a sampled value to three significant digits and keeps whole numbers whole', async () => {
  const { evidenceNumber } = await import('../studio/neuron-view.mjs');
  assert.deepEqual(
    [0.0033333333333333335, 0.586, 39805, 1, 0, 2.5, 123.4, -0.012345].map(evidenceNumber),
    ['0.00333', '0.586', '39805', '1', '0', '2.5', '123', '-0.0123'],
  );
});

test("the fleet's grade delta pairs a run only with one graded on the same criteria (the record's grade.off): a step over two sets is no delta; alignment is paired as before", () => {
  const graded = (i, score, off) => run(i, { grade: { score, pass: true, ...(off ? { off } : {}) } });
  const fleetOf = (runs) => buildNeuronModel({ journeys: [entry('a', runs)], runsByName: { a: runs }, window: 50 }).fleet;
  // 57 on seven, then chaos switched off and 67 on six: no "+10 vs the run before".
  const changed = fleetOf([graded(0, 57), graded(1, 67, ['chaos-validated'])]);
  assert.deepEqual(changed.grade, { mean: 67, delta: null, n: 1 });
  assert.equal(changed.alignment.delta, -1, 'the alignment is the same measure on both runs');
  // Both on six (the keys in any order): paired.
  assert.deepEqual(fleetOf([graded(0, 60, ['fresh', 'chaos-validated']), graded(1, 67, ['chaos-validated', 'fresh'])]).grade, { mean: 67, delta: 7, n: 1 });
  // Both on seven, as before.
  assert.deepEqual(fleetOf([graded(0, 60), graded(1, 67)]).grade, { mean: 67, delta: 7, n: 1 });
  // The previous scored run decides, a gap between is skipped as before.
  assert.deepEqual(fleetOf([graded(0, 60, ['fresh']), lost(1), graded(2, 64, ['fresh'])]).grade, { mean: 64, delta: 4, n: 1 });
  assert.deepEqual(fleetOf([graded(0, 60, ['fresh']), graded(1, 50), graded(2, 64, ['fresh'])]).grade.delta, null, 'the run just before was graded on seven');
});

test("the fleet's grade delta pairs a run only with one scored under the same grade schema (the record's grade.schema, 1 when it names none): a step over two rules is no delta", () => {
  const scored = (i, score, schema) => run(i, { grade: { score, pass: true, ...(schema === undefined ? {} : { schema }) } });
  const fleetOf = (runs) => buildNeuronModel({ journeys: [entry('a', runs)], runsByName: { a: runs }, window: 50 }).fleet;
  // 74 under schema 4, then 77 under schema 5 (Multi-modal and Comprehensive by how far they get): no "+3".
  assert.deepEqual(fleetOf([scored(0, 74, 4), scored(1, 77, 5)]).grade, { mean: 77, delta: null, n: 1 });
  assert.deepEqual(fleetOf([scored(0, 70, 5), scored(1, 77, 5)]).grade, { mean: 77, delta: 7, n: 1 });
  // A record naming no schema is schema 1.
  assert.deepEqual(fleetOf([scored(0, 60), scored(1, 64, 1)]).grade.delta, 4);
  assert.equal(fleetOf([scored(0, 60), scored(1, 64, 5)]).grade.delta, null);
});

// ---------- no figure without its basis (tools/lib/run-basis.mjs) ----------

const emptyOld = (i) => run(i, { drift: { alignmentPct: 100, aligned: 0, drifted: 0, declaredNotLive: 0, liveNotDeclared: 0 } });
const allFailed = (i) => run(i, { probes: { attempted: ['alert_rules'], succeeded: [], empty: [], failed: ['alert_rules'], unsupported: [] }, probeErrors: { alert_rules: 'alert_rules_list: HTTP 500: no backend session' } });
const noData = (i) => ({ journey: 'j', startedAt: at(i), tookMs: 5, outcome: 'vantage-lost', error: 'no probe family returned data', vantage: 'lost',
  probes: { attempted: ['alert_rules'], succeeded: [], empty: ['alert_rules'], failed: [], unsupported: [] }, probeErrors: {}, gate: { thresholds: {}, breaches: [{ criterion: 'vantage', detail: 'vantage lost' }] } });
const stoppedRec = (i) => ({ journey: 'j', startedAt: at(i), tookMs: 7, outcome: 'scan-partial', error: '49 of 220 files not read: grafana/a.json — it could not be downloaded (HTTP 403)',
  packA: { source: 'file: a', scan: { files: 171, candidates: 220, partial: true, notRead: 49, notReadReasons: [{ path: 'grafana/a.json', why: 'it could not be downloaded (HTTP 403)' }] } }, packB: { source: 'mcp:https://mcp.example.test/mcp' }, gate: { thresholds: {}, breaches: [] } });
// The listing's last run as GET /api/journeys gives it now: its reading and what it rests on.
const listed = async (rec) => ({ startedAt: rec.startedAt, outcome: rec.outcome, ...(await import('./lib/run-basis.mjs')).basisSummary(rec), gradeScore: rec.grade?.score ?? null, breaches: rec.gate?.breaches?.length ?? 0 });

test('NM1 nothing compared and a live side that gave nothing are gaps, never points: metricPoints, the heat cell\'s reading, the fleet mean and the paired delta skip them; an older record\'s 100 over an empty union included; a run not comparable with the one before pairs with nothing', () => {
  const runs = [run(0), emptyOld(1), allFailed(2), noData(3)];
  assert.deepEqual(metricPoints(runs, 'alignment').map((p) => p.v), [90, null, null, null], 'never [.., 100, ..]');
  assert.deepEqual(metricPoints(runs, 'grade').map((p) => p.v), [80, 79, null, null], 'the grade where the live side gave data');
  assert.deepEqual(metricPoints(runs).map((p) => p.outcome), ['pass', 'nothing-compared', 'vantage-lost', 'vantage-lost']);
  const m = buildNeuronModel({ journeys: [entry('j', runs)], runsByName: { j: runs } });
  assert.deepEqual(m.heatmap.rows[0].cells.map((c) => [c.outcome, c.alignment]), [['pass', 90], ['nothing-compared', null], ['vantage-lost', null], ['vantage-lost', null]]);
  assert.deepEqual([m.fleet.alignment.mean, m.fleet.alignment.n], [null, 0], 'the latest compared nothing: no mean');
  assert.equal(m.perJourney.j.latest.alignment, null);
  assert.deepEqual(trendReadiness(m.perJourney.j).observed, 1, 'one run observed');
  // Not comparable with the run before: no delta across the pair.
  const nc = [run(0), run(1, { comparable: { withPrevious: false, reason: 'this scan could not read 49 of 220 files' } })];
  const mn = buildNeuronModel({ journeys: [entry('j', nc)], runsByName: { j: nc } });
  assert.deepEqual([mn.fleet.alignment.delta, mn.fleet.grade.delta, mn.perJourney.j.latest.comparable], [null, null, false]);
  const ok = [run(0), run(1)];
  assert.equal(buildNeuronModel({ journeys: [entry('j', ok)], runsByName: { j: ok } }).fleet.alignment.delta, -1, 'a comparable pair keeps its delta');
});

test('NM2 a stopped Run is an outcome of its own: the record\'s reading, the per-journey and fleet counts, its delivery, the attention reasons (stopped on a partial scan before nothing compared); latestCheck carries the first probe error and whether live gave no data', async () => {
  const runs = [run(0), stoppedRec(1)];
  const d = buildJourneyDetail(entry('j', runs), runs);
  assert.deepEqual([d.outcomes['scan-partial'], d.latest.outcome], [1, 'scan-partial']);
  const c = latestCheck(d, { now: T0 + 3600e3 });
  assert.deepEqual([c.outcome, c.scan?.notRead, c.scan?.candidates, c.delivery], ['scan-partial', 49, 220, 'not-configured']);
  assert.equal(deliveryState(buildJourneyDetail(entry('j', runs, { notify: { urlEnv: 'X_URL' } }), runs)), 'skipped', 'a stopped Run without a delivery posted nothing — never "Delivery unknown"');
  // The listing's readings, counted.
  const journeys = [
    { ...entry('a', [emptyOld(0)]), lastRun: await listed(emptyOld(0)) },
    { ...entry('b', [allFailed(0)]), lastRun: await listed(allFailed(0)) },
    { ...entry('c', [run(0)]), lastRun: await listed(run(0)) },
    entry('d', []),
  ];
  const m = buildNeuronModel({ journeys, runsByName: { a: [emptyOld(0)], b: [allFailed(0)], c: [run(0)], d: [] } });
  assert.deepEqual(m.fleet.outcomes, { pass: 1, 'gate-failed': 0, 'nothing-compared': 1, 'vantage-lost': 1, 'scan-partial': 0, 'never-run': 1 }, 'a pass over nothing, and over a live side that gave nothing, is not counted passed');
  // The attention list, in its order.
  const at2 = buildNeuronModel({ journeys: [entry('s', runs), entry('n', [emptyOld(0)]), entry('l', [noData(0)])], runsByName: { s: runs, n: [emptyOld(0)], l: [noData(0)] } });
  assert.deepEqual(attentionList(at2, { now: T0 + 3600e3 }).map((a) => [a.name, a.reason]), [['l', 'vantage-lost'], ['s', 'scan-partial'], ['n', 'nothing-compared']]);
  const cl = latestCheck(at2.perJourney.l, { now: T0 + 3600e3 });
  assert.deepEqual([cl.outcome, cl.noData, cl.firstProbeError], ['vantage-lost', true, null]);
  const cf = latestCheck(buildJourneyDetail(entry('f', [allFailed(0)]), [allFailed(0)]), { now: T0 + 3600e3 });
  assert.deepEqual([cf.outcome, cf.noData, cf.firstProbeError], ['vantage-lost', false, 'alert_rules_list: HTTP 500: no backend session']);
  assert.deepEqual(buildJourneyDetail(entry('k', [run(0, { gate: { breaches: [{ key: 'vantage', detail: 'x' }] } })]), [run(0, { gate: { breaches: [{ key: 'vantage', detail: 'x' }] } })]).breachFrequency, [{ key: 'vantage', count: 1 }], 'a breach written { key } is counted by it');
});

test('NM3 the Journeys and Neuron views\' words: alignment only over a comparison, unable to observe with the first probe error, Partial scan with its counts, Nothing compared never with a pass mark — alignmentWords, runResultText, outcomeLabel, renderRunsTable, CHECK_OUTCOMES, evidenceLine', async () => {
  const jv = await import('../studio/journeys-view.mjs');
  const nv = await import('../studio/neuron-view.mjs');
  assert.deepEqual([jv.alignmentWords(emptyOld(0)), jv.alignmentWords(run(0)), jv.alignmentWords({ drift: { alignmentPct: null, aligned: 1 } })], ['nothing compared', 'alignment 90%', 'alignment not recorded']);
  assert.equal(jv.runResultText('j', emptyOld(0)), 'j: nothing compared');
  assert.equal(jv.runResultText('j', allFailed(0)), 'j: unable to observe — the live source did not answer: alert_rules_list: HTTP 500: no backend session');
  assert.equal(jv.runResultText('j', noData(0)), 'j: unable to observe — the live source answered, but returned no data');
  assert.equal(jv.runResultText('j', stoppedRec(0)), 'j: stopped — partial scan — 49 of 220 files not read; the previous pack is kept');
  assert.equal(jv.runResultText('j', run(0)), 'j: passed · alignment 90%');
  assert.equal(jv.outcomeLabel(await listed(emptyOld(0))), 'Nothing compared · grade 80%', 'never "Passed · alignment 100%"');
  assert.equal(jv.outcomeLabel(await listed(allFailed(0))), 'Unable to observe · the live source did not answer: alert_rules_list: HTTP 500: no backend session');
  assert.equal(jv.outcomeLabel({ startedAt: at(0), outcome: 'vantage-lost', alignmentPct: null, gradeScore: null }), 'Unable to observe · the live source did not answer', 'an older listing reads as before');
  assert.equal(jv.outcomeLabel(await listed(run(0))), 'Passed · alignment 90% · grade 80%');
  const table = jv.renderRunsTable([emptyOld(0), allFailed(1), stoppedRec(2), noData(3)]);
  assert.ok(table.includes('<span class="sr-text">Nothing compared</span>') && table.includes('<td>nothing compared</td>'));
  assert.ok(table.includes('unable to observe — the live source did not answer: alert_rules_list: HTTP 500: no backend session'));
  assert.ok(table.includes('partial scan: 49 of 220 files not read') && table.includes('<td>no live data</td>'));
  assert.ok(!/100%|null%|undefined%|✅/.test(table), 'no figure, and no pass mark, over nothing');
  assert.deepEqual([jv.CHECK_OUTCOMES['scan-partial'].label, jv.CHECK_OUTCOMES['nothing-compared'].label], ['Partial scan', 'Nothing compared']);
  assert.ok(![jv.CHECK_OUTCOMES['scan-partial'].icon, jv.CHECK_OUTCOMES['nothing-compared'].icon].includes('✅'));
  const ds = buildJourneyDetail(entry('j', [stoppedRec(0)]), [stoppedRec(0)]);
  assert.deepEqual(nv.evidenceLine(ds, latestCheck(ds)), ['Missing prerequisite', 'The repository was read in part: partial scan — 49 of 220 files not read; the previous pack is kept. The run stopped before comparing anything.']);
  const dn = buildJourneyDetail(entry('j', [noData(0)]), [noData(0)]);
  assert.ok(nv.evidenceLine(dn, latestCheck(dn))[1].includes('answered, but returned no data'));
  const de = buildJourneyDetail(entry('j', [emptyOld(0)]), [emptyOld(0)]);
  assert.ok(nv.evidenceLine(de, latestCheck(de))[1].startsWith('nothing compared · grade 80%'), 'the facts say nothing compared, never alignment 100%');
});

test('NM4 a lost run read as the record it left: the Journeys view\'s run now and Neuron\'s Run now / Run all read the 502 that recorded it (its outcome) as unable to observe — its first probe error, or a live side that answered with no data — and count it so, never "did not finish" with the server\'s raw answer; Neuron\'s focus head and newest-record rows show no grade and no chain integrity over a live side that gave nothing', async () => {
  const jv = await import('../studio/journeys-view.mjs');
  const nv = await import('../studio/neuron-view.mjs');
  const { servicesRefusal } = await import('../studio/services-api.mjs');
  const { NO_PROBE_DATA } = await import('./lib/journey.mjs');
  // The server's 502 of a lost run (server/index.mjs executeJourneyRun), as requestJson throws it.
  const answer = (error) => servicesRefusal(502, JSON.stringify({ ok: false, error, outcome: 'vantage-lost' }));
  assert.equal(jv.runResultText('j', jv.lostRunOf(answer('alert_rules_list: HTTP 500: no backend session'))), 'j: unable to observe — the live source did not answer: alert_rules_list: HTTP 500: no backend session');
  assert.equal(jv.runResultText('j', jv.lostRunOf(answer(NO_PROBE_DATA))), 'j: unable to observe — the live source answered, but returned no data', 'the engine\'s own words for no data');
  assert.ok(!/[{}]|did not finish/.test(jv.runResultText('j', jv.lostRunOf(answer('x')))), 'no raw answer, never "did not finish"');
  // A refusal that recorded nothing still did not finish; so does a 502 whose body names no outcome.
  assert.equal(jv.lostRunOf(servicesRefusal(400, JSON.stringify({ ok: false, error: 'journey j is not run: its notify hook is not set' }))), null);
  assert.equal(jv.lostRunOf(servicesRefusal(502, JSON.stringify({ ok: false, error: 'fetch failed' }))), null);
  assert.equal(jv.lostRunOf(new Error('502 Bad Gateway on /api/journeys/j/run: {"ok":false}')), null);
  // Run all counts them under unable to observe — a bucket the old reading of a 502 could never reach.
  assert.equal(jv.runAllText(['a', 'b'], { pass: 0, 'gate-failed': 0, 'nothing-compared': 0, 'vantage-lost': 2, 'scan-partial': 0, error: 0 }, []), 'Ran 2 journeys: 2 unable to observe.');
  // Neuron over the older record whose every probe failed (defect 1 as history holds it: a pass, alignment 100
  // over an empty union, a grade and the chains' scored integrity).
  const old = { ...allFailed(0), drift: { alignmentPct: 100, aligned: 0, drifted: 0, declaredNotLive: 0, liveNotDeclared: 0 }, grade: { score: 17, pass: false, threshold: 85, letter: 'D', letterLabel: 'Consumer Grade', schema: 5, driftConstruct: 'requirement-chain' },
    traceability: { integrityPct: 0, intact: 0, partial: 0, broken: 2, undeclared: 0, declaredTotal: 2 } };
  const d = buildJourneyDetail(entry('j', [old]), [old]);
  assert.deepEqual([d.latest.outcome, d.latest.grade, d.latest.traceability], ['vantage-lost', null, null], 'the model shows no grade and no chain integrity over a live side that gave nothing');
  const head = nv.focusOutcomeWords(d.latest, T0 + 19 * 3600e3);
  assert.equal(head, 'the live source did not answer: alert_rules_list: HTTP 500: no backend session · 19 hours ago');
  assert.ok(!/grade|%/.test(head));
  const rows = Object.fromEntries(nv.latestFactRows(d.latest));
  assert.deepEqual([rows.alignment.split(' — ')[0], rows.grade, rows.traceability], ['unable to observe', '— (unable to observe)', '— (unable to observe)']);
  // A run whose families answered with no data says so; a run over a comparison keeps its words.
  assert.equal(nv.focusOutcomeWords(buildJourneyDetail(entry('j', [noData(0)]), [noData(0)]).latest, T0 + 2 * 3600e3), 'the live source answered, but returned no data · two hours ago');
  const ok = buildJourneyDetail(entry('j', [run(0)]), [run(0)]).latest;
  assert.equal(nv.focusOutcomeWords(ok, T0 + 2 * 3600e3), 'alignment 90% · grade 80% · two hours ago');
  assert.equal(Object.fromEntries(nv.latestFactRows(ok)).grade.startsWith('80% (PASS at'), true);
  // Nothing compared: the chains' integrity is not measured (the links would read broken for want of anything compared).
  const nothing = { ...emptyOld(0), traceability: { integrityPct: 0, intact: 0, partial: 0, broken: 2, undeclared: 0, declaredTotal: 2 } };
  assert.ok(Object.fromEntries(nv.latestFactRows(buildJourneyDetail(entry('j', [nothing]), [nothing]).latest)).traceability.startsWith('integrity not measured: nothing was compared · 0 intact'));
});
