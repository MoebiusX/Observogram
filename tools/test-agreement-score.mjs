#!/usr/bin/env node
/**
 * tools/test-agreement-score.mjs — the agreement's score (studio/agreement-score.mjs): the built-in
 * rules cell by cell, the points as sums, what is not applicable and what was not checked kept out
 * of them, a host's own scorer checked and never patched with the built-in's numbers
 * (server/agreement-scorer.mjs), and the module's own rule — zero imports.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILT_IN_SCORER, DIMENSIONS, LEVEL_MAX, builtInCells, pointsOf, scoreAgreement, resultFrom, resultTermsKey, scoredByBuiltIn, pointsWords, scoreSummary,
} from '../studio/agreement-score.mjs';
import { loadAgreementScorer, scoreFacts } from '../server/agreement-scorer.mjs';

const objective = (source = 'repository') => ({ slo: 's', value: 0.999, window: '30d', source });
const fact = (over = {}) => ({
  id: 'c', owner: 'service', weight: 1, state: 'covered', links: [{ kind: 'slo', name: 's' }],
  has: { kinds: ['slo'], measured: true, measure: 'indicator', alerts: [{ kind: 'burn_alert', name: 's' }], severities: ['SEV1', 'SEV2'], unrouted: [], routed: true, dashboards: 2, objective: objective() },
  target: { state: 'same', words: 'The target and the objective agree: 99.9% over 30 days.' }, gaps: [], ...over,
});
const marks = (cells) => DIMENSIONS.map((d) => (cells[d.key].state === 'scored' ? String(cells[d.key].level) : cells[d.key].state === 'not-applicable' ? '–' : '?')).join('');

test('the built-in scorer: its name, the seven dimensions and their weights, levels 0 to 4; the module imports nothing', () => {
  assert.deepEqual(BUILT_IN_SCORER, { id: 'observogram.levels', version: 1, label: 'Built-in levels, version 1' });
  assert.deepEqual(DIMENSIONS.map((d) => [d.key, d.weight]), [['in_pack', 15], ['measurable', 20], ['detectable', 15], ['actionable', 15], ['observable', 10], ['target_match', 15], ['evidence', 10]]);
  assert.equal(DIMENSIONS.reduce((n, d) => n + d.weight, 0), 100);
  assert.equal(LEVEL_MAX, 4);
  const src = readFileSync(new URL('../studio/agreement-score.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...src.matchAll(/^import\s/gm)], []);
});

test('the levels, dimension by dimension: 0 when the fact is missing, 4 when it is all there, a middle only where partly means something; what does not apply is left out, and what was not looked at has no level', () => {
  // A whole chain: everything but live proof, which is not read yet.
  assert.equal(marks(builtInCells(fact())), '444444?');
  assert.deepEqual(pointsOf(builtInCells(fact())), { earned: 90, of: 90 });
  // In the repository: all, some, none of its links.
  assert.equal(builtInCells(fact({ state: 'part' })).in_pack.level, 2);
  // Measured: an indicator with a series, a metric or recording rule only, nothing.
  assert.equal(builtInCells(fact({ has: { ...fact().has, measure: 'series' } })).measurable.level, 2);
  assert.deepEqual(builtInCells(fact({ has: { ...fact().has, measure: null, measured: false } })).measurable, { state: 'scored', level: 0, why: 'Nothing measures it.' });
  // Alerted on, and routed: none; some severities; all; no severity at all.
  const noAlert = builtInCells(fact({ has: { ...fact().has, alerts: [], severities: [], unrouted: [], routed: null } }));
  assert.deepEqual([noAlert.detectable.level, noAlert.actionable.level, noAlert.actionable.why], [0, 0, 'No alert, so nothing reaches anyone.']);
  assert.deepEqual([builtInCells(fact({ has: { ...fact().has, unrouted: ['SEV2'], routed: false } })).actionable.level, builtInCells(fact({ has: { ...fact().has, unrouted: ['SEV1', 'SEV2'], routed: false } })).actionable.level], [2, 0]);
  assert.equal(builtInCells(fact({ has: { ...fact().has, severities: [], unrouted: [], routed: false } })).actionable.why, 'Its alerts state no severity, so nothing says where they go.');
  // Shown.
  assert.equal(builtInCells(fact({ has: { ...fact().has, dashboards: 0 } })).observable.level, 0);
  // Target match: the same or stricter 4, approximated 3, looser 1, nothing to compare with or the scan's default 0; in words or not written, it does not apply.
  const target = (state) => builtInCells(fact({ target: { state, words: state } })).target_match;
  assert.deepEqual(['same', 'stricter', 'approximated', 'looser', 'no-objective', 'guessed'].map((s) => target(s).level), [4, 4, 3, 1, 0, 0]);
  assert.deepEqual([target('words').state, target('none').state], ['not-applicable', 'not-applicable']);
  // An alert that must exist: alerted on and routed; no measure, dashboard or target is called for.
  const alertOnly = builtInCells(fact({ links: [{ kind: 'alert', name: 'A' }], has: { kinds: ['alert'], measured: false, measure: null, alerts: [{ kind: 'alert', name: 'A' }], severities: ['SEV3'], unrouted: ['SEV3'], routed: false, dashboards: 0, objective: null }, target: { state: 'words', words: 'in words' } }));
  assert.deepEqual([marks(alertOnly), pointsOf(alertOnly)], ['4–40––?', { earned: 30, of: 45 }]);
  // A dashboard that must exist: in the repository and shown, nothing else asked.
  const dashOnly = builtInCells(fact({ links: [{ kind: 'dashboard', name: 'D' }], has: { kinds: ['dashboard'], measured: false, measure: null, alerts: [], severities: [], unrouted: [], routed: null, dashboards: 1, objective: null }, target: { state: 'none', words: '' } }));
  assert.deepEqual([marks(dashOnly), pointsOf(dashOnly)], ['4–––4–?', { earned: 25, of: 25 }]);
  // A metric that must exist: half a measure, as the rules say.
  assert.equal(marks(builtInCells(fact({ links: [{ kind: 'metric', name: 'm' }], has: { kinds: ['metric'], measured: true, measure: 'series', alerts: [], severities: [], unrouted: [], routed: null, dashboards: 0, objective: null }, target: { state: 'none', words: '' } }))), '42––––?');
  // Linked to nothing: five zeros, and a target in words still does not apply.
  const unlinked = builtInCells(fact({ state: 'not-covered', has: null, links: [], target: { state: 'words', words: 'in words' } }));
  assert.deepEqual([marks(unlinked), pointsOf(unlinked), unlinked.in_pack.why], ['00000–?', { earned: 0, of: 75 }, 'It is linked to nothing in the repository.']);
  // No pack read: nothing has a level — never a 0.
  const unread = builtInCells(fact({ state: 'not-read', has: null, target: null }));
  assert.deepEqual([marks(unread), pointsOf(unread)], ['???????', { earned: 0, of: 0 }]);
});

test('scoreAgreement: a commitment\'s points are sums over its scored cells; the service\'s are sums over the commitments it answers for, each times its weight — the consumer\'s shown and left out; what no commitment could be scored on is named', () => {
  const facts = { read: true, commitments: [
    fact({ id: 'whole' }),
    fact({ id: 'heavy', weight: 3, owner: 'both', has: { ...fact().has, alerts: [], severities: [], unrouted: [], routed: null, dashboards: 0 }, target: { state: 'looser', words: 'looser' } }),
    fact({ id: 'theirs', owner: 'consumer' }),
  ] };
  const result = scoreAgreement(facts);
  assert.deepEqual([result.state, result.scorer, result.levelMax, result.dimensions.length], ['scored', BUILT_IN_SCORER, 4, 7]);
  assert.deepEqual(result.commitments.map((c) => [c.id, c.owner, c.weight, c.counted, c.earned, c.of]), [['whole', 'service', 1, true, 90, 90], ['heavy', 'both', 3, true, 38.75, 90], ['theirs', 'consumer', 1, false, 90, 90]]);
  assert.deepEqual(result.total, { commitments: 2, earned: 206.25, of: 360, notChecked: ['evidence'] }, '90 + 3 × 38.75 of 90 + 3 × 90: sums, never a mean of two ratios');
  assert.equal(pointsWords(result.commitments[1]), '38.8 of 90 points');
  assert.equal(scoreSummary(result), '206.3 of 360 points over 2 commitments · Built-in levels, version 1. Proven live is not checked yet.');
  assert.equal(resultTermsKey(result), 'observogram.levels@1:in_pack=15,measurable=20,detectable=15,actionable=15,observable=10,target_match=15,evidence=10/4');
  assert.ok(scoredByBuiltIn(result) && !scoredByBuiltIn({ scorer: { id: 'observogram.levels', version: 2 } }) && !scoredByBuiltIn(null));
  // Nothing to score, and nothing read.
  assert.deepEqual(scoreAgreement({ commitments: [] }).total, { commitments: 0, earned: 0, of: 0, notChecked: [] });
  assert.equal(scoreSummary(scoreAgreement({ commitments: [] })), '');
  assert.equal(scoreSummary(scoreAgreement({ commitments: [fact({ state: 'not-read', has: null, target: null })] })), 'Not scored yet: the repository is not read. Built-in levels, version 1.');
  assert.equal(pointsWords({ earned: 0, of: 0 }), '');
});

test('a host\'s own scorer: its dimensions and levels are the result\'s; an answer that does not read is "not scored" with why — never the built-in\'s numbers', () => {
  const facts = { read: true, commitments: [fact({ id: 'a', weight: 2 }), fact({ id: 'b', owner: 'consumer' })] };
  const scorer = { id: 'acme.scorecard', version: '3', label: 'Acme scorecard 3' };
  const answer = { levelMax: 2, dimensions: [{ key: 'kept', label: 'Kept', weight: 60 }, { key: 'proven', label: 'Proven', short: 'Prov', weight: 40 }], commitments: [
    { id: 'a', cells: { kept: { state: 'scored', level: 1, why: 'half' }, proven: { state: 'not-checked' } } },
    { id: 'b', cells: { kept: { state: 'not-applicable' }, proven: { state: 'not-applicable' } } },
  ] };
  const result = resultFrom(scorer, answer, facts);
  assert.deepEqual([result.state, result.scorer, result.levelMax, result.dimensions], ['scored', scorer, 2, [{ key: 'kept', label: 'Kept', short: 'Kept', weight: 60 }, { key: 'proven', label: 'Proven', short: 'Prov', weight: 40 }]]);
  assert.deepEqual(result.commitments.map((c) => [c.id, c.counted, c.weight, c.earned, c.of]), [['a', true, 2, 30, 60], ['b', false, 1, 0, 0]]);
  assert.deepEqual(result.total, { commitments: 1, earned: 60, of: 120, notChecked: ['proven'] });
  assert.equal(scoreSummary(result), '60 of 120 points over 1 commitment · Acme scorecard 3. Proven is not checked yet.');
  assert.ok(resultTermsKey(result) !== resultTermsKey(scoreAgreement(facts)), 'another scorer: never compared with the built-in\'s');
  const why = (a, s = scorer) => { const r = resultFrom(s, a, facts); assert.equal(r.state, 'not-scored'); assert.ok(!('commitments' in r) && !('total' in r), 'no numbers of any kind'); return r.reason; };
  assert.equal(why(null), 'its answer is not { dimensions, commitments }');
  assert.equal(why(answer, { version: 1 }), 'the scorer names no id');
  assert.match(why({ ...answer, dimensions: [{ key: 'kept', weight: 0 }] }), /a weight above 0/);
  assert.equal(why({ ...answer, dimensions: [...answer.dimensions, answer.dimensions[0]] }), 'the dimension kept is named twice');
  assert.equal(why({ ...answer, commitments: [answer.commitments[0]] }), 'its answer leaves a commitment out');
  assert.match(why({ ...answer, commitments: [{ id: 'zzz', cells: {} }, answer.commitments[1]] }), /is not one of the agreement's/);
  assert.equal(why({ ...answer, commitments: [{ id: 'a', cells: { kept: { state: 'scored', level: 3 }, proven: { state: 'not-checked' } } }, answer.commitments[1]] }), 'the cell a · kept has no level from 0 to 2');
  assert.equal(why({ ...answer, commitments: [{ id: 'a', cells: { kept: { state: 'maybe' }, proven: { state: 'not-checked' } } }, answer.commitments[1]] }), 'the cell a · kept is not scored, not-applicable or not-checked');
  assert.equal(scoreSummary({ state: 'not-scored', scorer, reason: 'it threw: boom' }), 'Not scored: Acme scorecard 3 did not answer — it threw: boom.');
});

test('the server\'s scorer: the built-in unless OBSERVOGRAM_AGREEMENT_SCORER names a module; one that does not load, throws, or answers a promise is said — never replaced by the built-in', async () => {
  const facts = { read: true, commitments: [fact({ id: 'a' })] };
  const dir = mkdtempSync(join(tmpdir(), 'observogram-scorer-'));
  const lines = [];
  try {
    assert.equal(await loadAgreementScorer((l) => lines.push(l), { path: '' }), null);
    assert.ok(scoredByBuiltIn(scoreFacts(facts)), 'none named: the built-in');
    const good = join(dir, 'good.mjs');
    writeFileSync(good, `export const scorer = { id: 'acme.scorecard', version: 3, label: 'Acme scorecard 3' };
export function score({ facts, builtIn }) {
  return { levelMax: 1, dimensions: [{ key: 'kept', label: 'Kept', weight: 100 }], commitments: facts.commitments.map((c) => ({ id: c.id, cells: { kept: { state: 'scored', level: builtIn.commitments.find((x) => x.id === c.id).earned === 90 ? 1 : 0, why: 'from the built-in' } } })) };
}\n`);
    assert.deepEqual(await loadAgreementScorer((l) => lines.push(l), { path: good }), { id: 'acme.scorecard', version: 3, label: 'Acme scorecard 3' });
    assert.match(lines.at(-1), /agreement scorer: Acme scorecard 3 \(acme\.scorecard @ 3\) from good\.mjs/);
    const mine = scoreFacts(facts, { source: {}, commitments: [] });
    assert.deepEqual([mine.scorer.id, mine.total, mine.commitments[0].cells.kept], ['acme.scorecard', { commitments: 1, earned: 100, of: 100, notChecked: [] }, { state: 'scored', level: 1, why: 'from the built-in' }]);
    const throwing = join(dir, 'throwing.mjs');
    writeFileSync(throwing, `export const scorer = { id: 'acme.broken', label: 'Acme broken' };\nexport function score() { throw new Error('boom'); }\n`);
    await loadAgreementScorer(() => {}, { path: throwing });
    assert.deepEqual(scoreFacts(facts), { state: 'not-scored', scorer: { id: 'acme.broken', version: null, label: 'Acme broken' }, reason: 'it threw: boom' });
    const later = join(dir, 'later.mjs');
    writeFileSync(later, `export const scorer = { id: 'acme.later' };\nexport async function score() { return {}; }\n`);
    await loadAgreementScorer(() => {}, { path: later });
    assert.equal(scoreFacts(facts).reason, 'score() answered a promise: it must answer at once');
    // A module that is not there, or exports no scorer: said, and every agreement reads not scored.
    const errors = [];
    const write = process.stderr.write;
    process.stderr.write = (chunk) => { errors.push(String(chunk)); return true; };
    try {
      assert.equal(await loadAgreementScorer(() => {}, { path: join(dir, 'missing.mjs') }), null);
      const none = scoreFacts(facts);
      assert.ok(none.state === 'not-scored' && /^the module missing\.mjs did not load: /.test(none.reason) && !('total' in none), JSON.stringify(none));
      const empty = join(dir, 'empty.mjs');
      writeFileSync(empty, 'export const nothing = 1;\n');
      await loadAgreementScorer(() => {}, { path: empty });
      assert.match(scoreFacts(facts).reason, /it exports no scorer \{ id, version, label \} and score\(\)/);
    } finally { process.stderr.write = write; }
    assert.ok(errors.length === 2 && errors.every((e) => /agreements read "not scored" until it does/.test(e)));
  } finally {
    await loadAgreementScorer(() => {}, { path: '' });
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(scoredByBuiltIn(scoreFacts(facts)), 'and back to the built-in');
});

test('Proven live reads production\'s evidence for the commitment: its level, or not checked with why — never a 0 for what was not looked at', () => {
  assert.deepEqual(builtInCells(fact()).evidence, { state: 'not-checked', why: 'No live check of production has been read.' });
  assert.deepEqual(builtInCells(fact({ live: { state: 'proven', level: 4, why: 'Everything it is linked to runs live as declared in prod.' } })).evidence, { state: 'scored', level: 4, why: 'Everything it is linked to runs live as declared in prod.' });
  assert.deepEqual(builtInCells(fact({ live: { state: 'part', level: 2, why: 'In part.' } })).evidence.level, 2);
  assert.deepEqual(builtInCells(fact({ live: { state: 'not-live', level: 0, why: 'None of it runs live.' } })).evidence, { state: 'scored', level: 0, why: 'None of it runs live.' });
  assert.deepEqual(builtInCells(fact({ live: { state: 'not-checked', why: 'The last check of prod could not see d.' } })).evidence, { state: 'not-checked', why: 'The last check of prod could not see d.' });
  const proven = scoreAgreement({ commitments: [fact({ id: 'a', live: { state: 'proven', level: 4, why: '' } })] });
  assert.deepEqual([proven.commitments[0].earned, proven.commitments[0].of, proven.total.notChecked], [100, 100, []], 'every dimension scored: nothing left unchecked');
  assert.equal(scoreSummary(proven), '100 of 100 points over 1 commitment · Built-in levels, version 1.');
});
