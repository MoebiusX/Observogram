// tools/test-chaos-runs.mjs — the chaos runs a person records in the studio
// (studio/chaos-runs.mjs): what the server accepts, how a run is kept, and how
// it becomes an experiment's last_result that the grade, the board's MTTD and
// the control room read — said as recorded in the studio, never as the
// repository's, and never over a newer run the repository records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { adapt } from './lib/adapter.mjs';
import { SPEC_DIR } from './lib/validator.mjs';
import { computeDiagnosticGrade, computePostureMatrix } from '../studio/diagnostic-grade.mjs';
import { declaredByTier } from '../studio/artefact-tiers.mjs';
import {
  CHAOS_RUNS_MAX, chaosRunErrors, chaosRunId, chaosRunRecord, chaosRunWords, lastResultOf, mttdDuration, mttdSeconds,
  parseMttdText, sameChaosRun, studioRunFor, withStudioRuns,
} from '../studio/chaos-runs.mjs';

const MODULE = resolve(fileURLToPath(new URL('../studio/chaos-runs.mjs', import.meta.url)));
const NOW = Date.parse('2026-11-11T15:00:00Z');
const pack = () => adapt(parseYaml(readFileSync(resolve(SPEC_DIR, 'examples/payment-service.pack.yaml'), 'utf8')), { environment: 'prod' });
const chaosOf = (grade) => grade.trust.criteria.find((c) => c.key === 'chaos-validated');
const gradeOf = (layered) => computeDiagnosticGrade(layered, null, computePostureMatrix(layered, null), null, null, { nowMs: NOW });
const run = (over = {}) => ({ experiment: 'api-network-latency', at: '2026-11-11T13:05:00Z', outcome: 'pass', environment: 'prod', mttd: '45s', alertsFired: null, note: '', by: 'carlos', recordedAt: '2026-11-11T14:00:00Z', ...over });

test('the module imports nothing, so a downstream copies it alone', () => {
  assert.equal([...readFileSync(MODULE, 'utf8').matchAll(/^import\s/gm)].length, 0);
});

test('what the server accepts: an experiment id, a date-time not in the future, pass / fail / aborted, an environment, an MTTD of at most a week, the alerts that fired, a note — each refusal named', () => {
  assert.deepEqual(chaosRunErrors({ experiment: 'api-pod-kill', at: '2026-11-11T13:05:00Z', outcome: 'pass' }, { now: NOW }), []);
  assert.deepEqual(chaosRunErrors(run(), { now: NOW }), [], 'with every field, by and recordedAt the server\'s own');
  const first = (r) => chaosRunErrors(r, { now: NOW })[0];
  assert.equal(first(null), 'a run is { experiment, at, outcome, environment, mttd, alertsFired, note }');
  assert.equal(first(run({ extra: 1 })), 'extra is not a run\'s field');
  assert.equal(first(run({ experiment: 'Pod Kill' })), 'experiment "Pod Kill" is not an experiment\'s id');
  assert.equal(first(run({ at: '11/11/2026' })), 'at "11/11/2026" is not a date-time (2026-11-11T14:05:00Z)');
  assert.equal(first(run({ at: '2026-11-11T15:06:00Z' })), 'at 2026-11-11T15:06:00Z is in the future', 'more than five minutes ahead of the server');
  assert.deepEqual(chaosRunErrors(run({ at: '2026-11-11T15:04:00Z' }), { now: NOW }), [], 'a browser a few minutes fast is fine');
  assert.equal(first(run({ at: '1999-12-31T23:00:00Z' })), 'at 1999-12-31T23:00:00Z is before 2000');
  assert.equal(first(run({ outcome: 'ok' })), 'outcome is pass, fail, aborted, not "ok"');
  assert.equal(first(run({ environment: 'Prod EU' })), 'environment "Prod EU" is not an environment\'s name');
  assert.equal(first(run({ mttd: '2 minutes' })), 'mttd "2 minutes" is not a Duration of at most a week ("45s", "2m30s")');
  assert.equal(first(run({ mttd: '200h' })), 'mttd "200h" is not a Duration of at most a week ("45s", "2m30s")');
  assert.equal(first(run({ alertsFired: 'PodDown' })), 'alertsFired is a list of at most 50 alert names, or null');
  assert.equal(first(run({ note: 'a\nb' })), 'note is at most 280 characters on one line');
  assert.equal(first(run({ note: 'x'.repeat(281) })), 'note is at most 280 characters on one line');
  assert.equal(CHAOS_RUNS_MAX, 200);
});

test('a run as it is kept: the time in UTC to the second, the MTTD in whole seconds, each alert once; its identity and when two say the same', () => {
  assert.deepEqual(chaosRunRecord({ experiment: 'api-pod-kill', at: '2026-11-11T14:05:00+01:00', outcome: 'fail', mttd: '90s', alertsFired: [' PodDown', 'PodDown'], note: ' slow ' }),
    { experiment: 'api-pod-kill', at: '2026-11-11T13:05:00Z', outcome: 'fail', environment: null, mttd: '1m30s', alertsFired: ['PodDown'], note: 'slow' });
  assert.deepEqual(chaosRunRecord({ experiment: 'x1', at: '2026-11-11T13:05:00.250Z', outcome: 'aborted' }).at, '2026-11-11T13:05:00.250Z');
  assert.equal(chaosRunId(run()), 'api-network-latency\u00002026-11-11T13:05:00Z\u0000prod');
  assert.ok(sameChaosRun(run(), run({ by: 'someone else', recordedAt: '2026-11-12T00:00:00Z' })), 'who recorded it and when are not what it says');
  for (const over of [{ outcome: 'fail' }, { mttd: '46s' }, { note: 'again' }, { alertsFired: ['A'] }, { environment: 'staging' }]) assert.ok(!sameChaosRun(run(), run(over)), JSON.stringify(over));
  assert.ok(sameChaosRun(run({ alertsFired: ['B', 'A'] }), run({ alertsFired: ['A', 'B'] })), 'the alerts in any order');
});

test('the MTTD a person types: seconds, or a duration of hours, minutes and seconds; none; anything else refused', () => {
  assert.deepEqual(['', '  ', '45', '45s', '2m30s', '2m 30s', '1h', '1H2M', '0'].map(parseMttdText), [null, null, 45, 45, 150, 150, 3600, 3720, 0]);
  for (const bad of ['2 minutes', '1.5m', '-3', 'abc', '604801', '169h']) assert.ok(Number.isNaN(parseMttdText(bad)), bad);
  assert.deepEqual([45, 150, 3600, 3725, 0, 89.6].map(mttdDuration), ['45s', '2m30s', '1h', '1h2m5s', '0s', '1m30s']);
  assert.deepEqual(['45s', '2m30s', '1h', 'x', 5].map(mttdSeconds), [45, 150, 3600, null, null]);
});

test('the run an experiment takes: its newest in the environment, one naming none standing for any; as a last_result whose evidence says the studio', () => {
  const runs = [run({ at: '2026-11-09T10:00:00Z' }), run({ at: '2026-11-10T10:00:00Z', environment: null }), run({ at: '2026-11-11T10:00:00Z', environment: 'staging' })];
  assert.equal(studioRunFor(runs, 'api-network-latency', 'prod').at, '2026-11-10T10:00:00Z', 'staging\'s is not prod\'s; the one naming none is');
  assert.equal(studioRunFor(runs, 'api-network-latency', 'staging').at, '2026-11-11T10:00:00Z');
  assert.equal(studioRunFor(runs, 'api-network-latency', null).at, '2026-11-11T10:00:00Z', 'a check with no environment takes every run');
  assert.equal(studioRunFor(runs, 'api-pod-kill', 'prod'), null);
  assert.deepEqual(lastResultOf(run({ note: 'game day', alertsFired: ['PodDown'] })), {
    at: '2026-11-11T13:05:00Z', outcome: 'pass', environment: 'prod', observed_mttd: '45s', alerts_fired: ['PodDown'],
    evidence: 'Recorded in the studio by carlos on 2026-11-11: game day',
  });
  assert.deepEqual(lastResultOf({ experiment: 'x1', at: '2026-11-11T13:05:00Z', outcome: 'aborted' }), { at: '2026-11-11T13:05:00Z', outcome: 'aborted', evidence: 'Recorded in the studio' });
  assert.equal(chaosRunWords(run()), 'Passed · 2026-11-11 13:05 UTC · MTTD 45s · prod · by carlos');
  assert.equal(chaosRunWords(run({ outcome: 'fail', mttd: null, environment: null, by: null })), 'Failed · 2026-11-11 13:05 UTC');
});

test('withStudioRuns: the newest run in the environment is the experiment\'s last_result where newer than the repository\'s, the artefact marked; nothing to apply is the same object', () => {
  const layered = pack();
  assert.equal(withStudioRuns(layered, [], { env: 'prod' }), layered, 'no runs: untouched');
  assert.equal(withStudioRuns(layered, null), layered);
  assert.equal(withStudioRuns(layered, [run({ experiment: 'not-in-the-pack' })], { env: 'prod' }), layered, 'a run of an experiment the pack does not declare changes nothing');
  // api-pod-kill's own last_result is 2026-11-02: an older studio run leaves it; a newer one takes its place.
  const older = withStudioRuns(layered, [run({ experiment: 'api-pod-kill', at: '2026-11-01T00:00:00Z', environment: null })], { env: 'prod' });
  assert.equal(older, layered, 'the repository\'s newer run comes first');
  const applied = withStudioRuns(layered, [run(), run({ experiment: 'api-pod-kill', at: '2026-11-03T00:00:00Z', environment: null, outcome: 'fail', mttd: null })], { env: 'prod' });
  assert.notEqual(applied, layered);
  const byId = (p) => Object.fromEntries(p.layers.L5.filter((a) => /^CHAOS-/.test(a.id)).map((a) => [a.spec.id, a]));
  assert.deepEqual(byId(applied)['api-network-latency'].spec.last_result, lastResultOf(run()));
  assert.deepEqual(byId(applied)['api-network-latency']._studioRun, { by: 'carlos', recordedAt: '2026-11-11T14:00:00Z', note: '' });
  assert.equal(byId(applied)['api-pod-kill'].spec.last_result.outcome, 'fail', 'newer than the repository\'s 2026-11-02 pass');
  assert.equal(byId(applied)['kafka-partition-failure'], byId(layered)['kafka-partition-failure'], 'an experiment with no run is the same artefact');
  assert.equal(byId(layered)['api-network-latency'].spec.last_result, undefined, 'the pack given is not changed');
  assert.equal(applied.layers.L1, layered.layers.L1, 'the other layers are the same objects');
});

test('the grade, the board\'s MTTD and the control room read a studio run: stale becomes proven, said as recorded in the studio; a failed one fails the criterion', () => {
  const layered = pack();
  const before = chaosOf(gradeOf(layered));
  assert.deepEqual([before.proof.state, before.score], ['stale', 0.25], 'the example\'s only run, 2026-11-02, is older than its weekly window');
  const runs = [run(), run({ experiment: 'kafka-partition-failure', at: '2026-11-10T10:00:00Z', environment: null, mttd: '2m' })];
  const after = chaosOf(gradeOf(withStudioRuns(layered, runs, { env: 'prod' })));
  assert.deepEqual([after.proof.state, after.score, after.proof.source], ['proven', 0.75, 'studio']);
  assert.equal(after.detail, 'recovery proven 2026-11-11 by fault injection: 2 of 3 chaos experiments passed a run within its window (recorded in the studio)');
  assert.ok(gradeOf(withStudioRuns(layered, runs, { env: 'prod' })).overall.audit.scorePctExact > gradeOf(layered).overall.audit.scorePctExact, 'the score moves with it');
  const failed = chaosOf(gradeOf(withStudioRuns(layered, [run({ outcome: 'fail', alertsFired: [] })], { env: 'prod' })));
  assert.deepEqual([failed.proof.state, failed.score, failed.proof.failed[0].source], ['failed', 0, 'studio']);
  // The runs the board and the control room read carry where they come from.
  const tiers = declaredByTier(withStudioRuns(layered, runs, { env: 'prod' })).mttx;
  assert.deepEqual(tiers.runs[0], { experiment: 'api-network-latency', at: '2026-11-11T13:05:00Z', outcome: 'pass', environment: 'prod', mttd: '45s', studio: true, by: 'carlos' });
  assert.ok(!('studio' in tiers.runs.find((r) => r.experiment === 'api-pod-kill')), 'the repository\'s run says nothing of the studio');
  assert.deepEqual(tiers.measured, { mttd: '45s', at: '2026-11-11T13:05:00Z', experiment: 'api-network-latency', outcome: 'pass' });
});
