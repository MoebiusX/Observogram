#!/usr/bin/env node
/**
 * tools/test-slo-objectives.mjs — the SLO objectives a service can be given in the studio
 * (studio/slo-objectives.mjs): what a client may send and what is kept (who stated each and when),
 * the pack the grade reads them from, the key a record and the board compare, the form's rows and
 * answers, and the module's own rule — zero imports, so the server and every studio copy read the same.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  OBJECTIVE_WINDOWS, OBJECTIVES_MAX, objectivesErrors, objectivesRecord, sameObjectives, withStatedObjectives, objectivesTermKey,
  storedObjectivesError, objectivePercent, percentObjective, objectivesFormModel, objectivesFromForm,
} from '../studio/slo-objectives.mjs';
import { SLO_WINDOWS } from './lib/library.mjs';
import { computeDiagnosticGrade, computePostureMatrix } from '../studio/diagnostic-grade.mjs';

const TWO = { slos: { checkout_availability_99: { objective: 0.999, window: '30d' }, checkout_latency_99: { objective: 0.995, window: '28d' } } };

test('the windows are the pack specification\'s own, and the module imports nothing', () => {
  assert.deepEqual([...OBJECTIVE_WINDOWS], SLO_WINDOWS);
  assert.ok(Object.isFrozen(OBJECTIVE_WINDOWS));
  const src = readFileSync(new URL('../studio/slo-objectives.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...src.matchAll(/^import\s/gm)], [], 'zero imports');
  assert.ok(!/\b(document|window|localStorage)\s*\./.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'no browser global');
});

test('objectivesErrors: what a client may send — { slos: { id: { objective, window } } } or null, each fault named', () => {
  assert.deepEqual(objectivesErrors(null), []);
  assert.deepEqual(objectivesErrors(TWO), []);
  assert.deepEqual(objectivesErrors({ slos: {} }), [], 'none stated reads');
  for (const bad of [undefined, [], 'x', 42, {}, { slos: [] }, { slos: null }]) {
    assert.deepEqual(objectivesErrors(bad), ['objectives is { slos: { "<slo id>": { objective, window } } } or null'], JSON.stringify(bad));
  }
  assert.deepEqual(objectivesErrors({ slos: {}, extra: 1 }), ['extra is not an objectives field']);
  const one = (e) => objectivesErrors({ slos: { a_99: e } });
  for (const objective of [0, 1, 1.5, -0.1, 99.9, '0.99', null, NaN, Infinity]) {
    assert.deepEqual(one({ objective, window: '30d' }), ['"a_99": objective is a number above 0 and below 1 (0.999 for 99.9%)'], String(objective));
  }
  for (const window of ['45d', '30', 30, '', null, undefined]) {
    assert.deepEqual(one({ objective: 0.99, window }), ['"a_99": window is one of 7d, 28d, 30d, 90d'], String(window));
  }
  assert.deepEqual(one('x'), ['"a_99" is not { objective, window }']);
  assert.deepEqual(one({ objective: 0.99, window: '30d', note: 'x' }), ['"a_99": note is not an objective field']);
  assert.deepEqual(one({ objective: 0.99, window: '30d', by: 'ana', at: '2026-11-18T10:00:00Z' }), [], 'the kept record may be sent back as it was read');
  for (const id of ['not an id', '', '-x', 'a'.repeat(65), 'a;b', 'a=b', 'a#b']) {
    assert.match(objectivesErrors({ slos: { [id]: { objective: 0.99, window: '30d' } } })[0], /is not an SLO id/, id);
  }
  for (const id of ['a', 'slo_http_requests_99', 'checkout.latency:p99-v2', 'A1']) assert.deepEqual(objectivesErrors({ slos: { [id]: { objective: 0.99, window: '7d' } } }), [], id);
  const many = { slos: Object.fromEntries(Array.from({ length: OBJECTIVES_MAX + 1 }, (_, i) => [`s${i}`, { objective: 0.99, window: '30d' }])) };
  assert.deepEqual(objectivesErrors(many), [`more than ${OBJECTIVES_MAX} SLOs`]);
});

test('objectivesRecord: each entry signed and dated; one sent again unchanged keeps who and when; none is null', () => {
  const first = objectivesRecord(TWO, { actor: 'ana', now: '2026-11-18T10:00:00.000Z' });
  assert.deepEqual(first, { slos: {
    checkout_availability_99: { objective: 0.999, window: '30d', by: 'ana', at: '2026-11-18T10:00:00.000Z' },
    checkout_latency_99: { objective: 0.995, window: '28d', by: 'ana', at: '2026-11-18T10:00:00.000Z' },
  } });
  const next = objectivesRecord({ slos: { ...TWO.slos, checkout_latency_99: { objective: 0.99, window: '28d' }, b_99: { objective: 0.9, window: '7d' } } }, { current: first, actor: 'ben', now: '2026-11-19T09:00:00.000Z' });
  assert.deepEqual(next.slos.checkout_availability_99, first.slos.checkout_availability_99, 'unchanged: the first statement stands');
  assert.deepEqual(next.slos.checkout_latency_99, { objective: 0.99, window: '28d', by: 'ben', at: '2026-11-19T09:00:00.000Z' }, 'changed: signed again');
  assert.deepEqual(Object.keys(next.slos), ['b_99', 'checkout_availability_99', 'checkout_latency_99'], 'kept sorted by id');
  assert.equal(objectivesRecord({ slos: {} }, { actor: 'ana', now: 'x' }), null);
  assert.equal(objectivesRecord(null), null);
  assert.deepEqual(objectivesRecord(TWO).slos.checkout_latency_99, { objective: 0.995, window: '28d', by: null, at: null }, 'no actor: unsigned, never invented');
  assert.ok(sameObjectives(first, TWO) && sameObjectives(null, { slos: {} }) && !sameObjectives(first, next));
});

test('withStatedObjectives and objectivesTermKey: the grade\'s copy of the pack carries them; the key names each, or only the ones a run counted', () => {
  const layered = { layers: { L1: [] }, meta: { annotations: { a: '1' } } };
  const withThem = withStatedObjectives(layered, objectivesRecord(TWO, { actor: 'ana', now: 'x' }));
  assert.deepEqual(withThem.meta, { annotations: { a: '1' }, studioObjectives: TWO.slos }, 'who and when stay off the pack');
  assert.equal(layered.meta.studioObjectives, undefined, 'the pack handed in is not touched');
  assert.equal(withStatedObjectives(layered, null), layered, 'none stated: the same object');
  assert.equal(withStatedObjectives(layered, { slos: { bad: { objective: 7, window: '30d' } } }), layered, 'an entry that does not read counts nothing');
  assert.equal(objectivesTermKey(TWO), 'checkout_availability_99=0.999/30d;checkout_latency_99=0.995/28d');
  assert.equal(objectivesTermKey(TWO, ['checkout_latency_99', 'not_here']), 'checkout_latency_99=0.995/28d');
  assert.equal(objectivesTermKey(TWO, []), '');
  assert.equal(objectivesTermKey(null), '');
  assert.equal(storedObjectivesError(TWO), '');
  assert.equal(storedObjectivesError([]), 'it is not { slos: { <slo id>: { objective, window } } }');
  assert.match(storedObjectivesError({ slos: { a: { objective: 2, window: '30d' } } }), /objective is a number above 0 and below 1/);
});

test('the grade counts a stated objective only where the SLO\'s own is the scan\'s guess; the repository\'s own statement wins', () => {
  const sli = (id, extra = {}) => ({ id: `SLI-${id}`, title: id, spec: { id, type: 'ratio', description: 'Inferred from recording rules a and b.', good: `sum(rate(${id}_good[5m]))`, ...extra } });
  const slo = (id, sliId, objective = 0.99) => ({ id: `SLO-${id}`, title: id, spec: { id, sli: `ref:slis.${sliId}`, objective, window: '30d' } });
  const layered = {
    // Detection and repair targets set in the studio: Calibrated's other half, so the share scores.
    meta: { studioTargets: { profile: 'lab', mttd: '1m', mttr: '5m' }, annotations: {
      'crawler.guessMarks': '1',
      'crawler.scaffold.slos.a_99.objective': 'default', 'crawler.scaffold.slos.b_99.objective': 'default', 'crawler.scaffold.slos.c_99.objective': 'default',
      'crawler.scaffold.slis.c.threshold': 'default',
    } },
    layers: { L1: [sli('a'), sli('b'), sli('c', { type: 'threshold', threshold: 1, unit: 'ratio' }), sli('d'), slo('a_99', 'a'), slo('b_99', 'b'), slo('c_99', 'c'), slo('d_999', 'd', 0.999)], L2: [], L3: [], L4: {}, L5: [], GOV: [] },
  };
  const calibrated = (pack) => {
    const g = computeDiagnosticGrade(pack, null, computePostureMatrix(pack, null), null, null, {});
    return [...g.coverage.criteria, ...g.trust.criteria].find((c) => c.key === 'calibrated');
  };
  const none = calibrated(layered);
  assert.deepEqual(none.objectives, { declared: 1, scaffolds: 0, guessed: 2, unbounded: 1, total: 3 }, 'none stated: no studio key, as before');
  assert.deepEqual(none.objectiveRows.map((r) => [r.id, r.sli, r.state]), [['a_99', 'a', 'guessed'], ['b_99', 'b', 'guessed'], ['c_99', 'c', 'unbounded'], ['d_999', 'd', 'repository']]);
  assert.equal(none.objectiveRows[0].series, 'sum(rate(a_good[5m]))', 'a row names the series its indicator reads');
  // Stated for a guessed one, for the one with no bound, for the repository's own and for one the pack does not hold.
  const stated = { slos: { a_99: { objective: 0.999, window: '28d' }, c_99: { objective: 0.9, window: '7d' }, d_999: { objective: 0.5, window: '7d' }, gone_99: { objective: 0.9, window: '7d' } } };
  const some = calibrated(withStatedObjectives(layered, stated));
  assert.deepEqual(some.objectives, { declared: 2, scaffolds: 0, guessed: 1, unbounded: 1, total: 3, studio: 1, studioIds: ['a_99'] }, 'only the guessed one it names is counted');
  assert.equal(some.score, 2 / 3);
  assert.match(some.detail, /2 SLOs with explicit objective \(1 stated in the studio\); 1 more carry the scan's default/);
  assert.deepEqual(some.objectiveRows.map((r) => r.state), ['studio', 'guessed', 'unbounded', 'repository']);
  // The form's rows over that criterion.
  assert.deepEqual(objectivesFormModel(some, stated), {
    ask: [
      { id: 'a_99', sli: 'a', series: 'sum(rate(a_good[5m]))', percent: '99.9', window: '28d', stated: true },
      { id: 'b_99', sli: 'b', series: 'sum(rate(b_good[5m]))', percent: '', window: '30d', stated: false },
    ],
    unbounded: [{ id: 'c_99', sli: 'c' }],
    repository: 1,
    elsewhere: [{ id: 'gone_99', percent: '90', window: '7d' }],
  });
  assert.deepEqual(objectivesFormModel(null, null), { ask: [], unbounded: [], repository: 0, elsewhere: [] });
});

test('the form: a percent in, a ratio kept; a blank states nothing; what the scan does not hold is kept unless removed', () => {
  assert.deepEqual(['99.9', '99.95', '99', '50', '0.5', ' 99.9% ', '99.9999'].map(percentObjective), [0.999, 0.9995, 0.99, 0.5, 0.005, 0.999, 0.999999]);
  for (const bad of ['', 'abc', '100', '0', '-1', '99.99999', '1e2', '99,9', '100.0']) assert.equal(percentObjective(bad), null, bad);
  assert.deepEqual([0.999, 0.9995, 0.99, 0.5, 0.005].map(objectivePercent), ['99.9', '99.95', '99', '50', '0.5']);
  assert.equal(objectivePercent(2), '');
  const keep = { gone_99: { objective: 0.9, window: '7d', by: 'ana', at: 'x' } };
  assert.deepEqual(objectivesFromForm({ a_99: { percent: '99.9', window: '28d' }, b_99: { percent: '  ', window: '30d' }, c_99: { percent: '99.5', window: 'never' } }, keep), {
    objectives: { slos: { gone_99: { objective: 0.9, window: '7d' }, a_99: { objective: 0.999, window: '28d' }, c_99: { objective: 0.995, window: '30d' } } },
    problems: [],
  });
  assert.deepEqual(objectivesFromForm({ a_99: { percent: 'abc', window: '30d' } }), { objectives: null, problems: [{ id: 'a_99', text: 'A percent above 0 and below 100, such as 99.9' }] });
  assert.deepEqual(objectivesFromForm({ a_99: { percent: '', window: '30d' } }, {}), { objectives: null, problems: [] }, 'all blank: none stated');
});
