// tools/test-neuron-model.mjs — the Neuron view's model over fabricated
// journey listings and run records (the shapes GET /api/journeys and
// GET /api/journeys/:name/runs return).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTCOMES, LADDER_KEYS, sortRunsOldestFirst, metricPoints, ladderSeries, stackRowSeries,
  buildJourneyDetail, buildNeuronModel, defaultFocus,
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

test('defaultFocus: a chain getting worse wins, then gate-failed, vantage-lost, lowest alignment, name', () => {
  const mk = (rows) => buildNeuronModel({ journeys: rows.map(([n, r, o]) => entry(n, r, o)), runsByName: Object.fromEntries(rows.map(([n, r]) => [n, r])) });
  assert.equal(defaultFocus(mk([['a', [run(0)]], ['b', [run(0, { outcome: 'gate-failed' })]]])), 'b');
  assert.equal(defaultFocus(mk([['a', [lost(0)]], ['b', [run(0)]]])), 'a');
  assert.equal(defaultFocus(mk([['a', [run(0)]], ['b', [run(0, { drift: { alignmentPct: 10 } })]]])), 'b');
  assert.equal(defaultFocus(mk([['b', [run(0)]], ['a', [run(0)]]])), 'a');
  const worse = run(0, { outcome: 'pass', transition: { any: true, changed: [{ direction: 'worse' }] } });
  assert.equal(defaultFocus(mk([['a', [run(0, { outcome: 'gate-failed' })]], ['z', [worse]]])), 'z');
  assert.equal(defaultFocus(mk([])), null);
  assert.equal(defaultFocus(buildNeuronModel({ journeys: [entry('only', [])], runsByName: {} })), 'only');
});

test('OUTCOMES is the record vocabulary', () => {
  assert.deepEqual([...OUTCOMES], ['pass', 'gate-failed', 'vantage-lost']);
});
