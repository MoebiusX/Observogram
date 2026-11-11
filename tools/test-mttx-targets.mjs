#!/usr/bin/env node
/**
 * tools/test-mttx-targets.mjs — the MTTD / MTTR targets a service can be given in the studio
 * (studio/mttx-targets.mjs): the profiles as the product recommends them, the minutes and their
 * words, what a client may send and what is kept, the form's answer, and the module's own rule —
 * zero imports, so the server and every studio copy read the same list.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MTTX_PROFILES, MTTX_RECOMMENDED, MTTX_CUSTOM, MTTX_MINUTES_MAX, mttxProfile, recommendedProfile, durationMinutes, durationSeconds, minutesWords,
  targetsErrors, targetsRecord, sameTargets, targetsView, targetsFormValues, targetsFromForm, targetsFormProblems, targetsOptions,
} from '../studio/mttx-targets.mjs';

test('the profiles: the four the product recommends, in order, the lab default recommended, each duration its words', () => {
  assert.deepEqual(MTTX_PROFILES.map((p) => [p.id, p.name, p.mttdWords, p.mttrWords, !!p.recommended]), [
    ['lab', 'Lab default', '≤ 1 min', '≤ 5 min', true],
    ['financial', 'Critical financial service', '≤ 1 min', '≤ 15 min', false],
    ['degradation', 'Significant degradation', '≤ 5 min', '≤ 60 min', false],
    ['noncritical', 'Noncritical service', '≤ 15 min', '≤ 4 hours', false],
  ]);
  assert.deepEqual(MTTX_PROFILES.map((p) => [durationMinutes(p.mttd), durationMinutes(p.mttr)]), [[1, 5], [1, 15], [5, 60], [15, 240]], 'each duration as its words say');
  assert.equal(MTTX_RECOMMENDED, 'lab');
  assert.equal(recommendedProfile(), mttxProfile('lab'));
  assert.ok(MTTX_PROFILES.every((p) => Object.isFrozen(p)) && Object.isFrozen(MTTX_PROFILES));
  assert.equal(MTTX_PROFILES.filter((p) => p.recommended).length, 1, 'one recommended');
});

test('minutes: a Duration of whole minutes or hours in minutes, and minutes in words; any spec Duration in seconds, to set a measurement beside a target', () => {
  assert.deepEqual(['5m', '90m', '1h30m', '4h', '240m', '0m', '30s', '1d', '', 'x', null, 5, ['5m']].map(durationMinutes), [5, 90, 90, 240, 240, 0, null, null, null, null, null, null, null], 'a non-text value is none');
  assert.deepEqual(['90s', '4m30s', '1h', '2d', '500ms', '1w', ' 5m ', '', '5', 'm', '5x', null, 60].map(durationSeconds), [90, 270, 3600, 172800, 0.5, 604800, 300, null, null, null, null, null, null]);
  assert.deepEqual([1, 59, 60, 90, 240, 10080].map(minutesWords), ['≤ 1 min', '≤ 59 min', '≤ 1 hour', '≤ 1 h 30 min', '≤ 4 hours', '≤ 168 hours']);
  assert.equal(MTTX_MINUTES_MAX, 10080);
});

test('what a client may send: a profile, custom minutes, or null — and what is kept: the durations copied in', () => {
  assert.deepEqual(targetsErrors(null), []);
  assert.deepEqual(targetsErrors({ profile: 'lab' }), []);
  assert.deepEqual(targetsErrors({ profile: 'lab', mttd: '1m', mttr: '5m' }), [], 'a profile with its own durations is the profile');
  assert.deepEqual(targetsErrors({ profile: 'custom', mttd: '2m', mttr: '1h30m' }), []);
  assert.deepEqual(targetsErrors({ profile: 'custom', mttd: '2m', mttr: '5m', by: 'x', at: 'y' }), [], 'a view sent back as it came');
  assert.deepEqual(targetsErrors('lab'), ['targets is { profile } — a profile id or "custom" with mttd and mttr — or null']);
  assert.deepEqual(targetsErrors({ profile: 'custom' }), ['mttd is not a duration of whole minutes from 1m to 10080m (a week)', 'mttr is not a duration of whole minutes from 1m to 10080m (a week)']);
  assert.deepEqual(targetsErrors({ profile: 'lab', mttr: '9m' }), ['mttr is the profile\'s own (5m): leave it out, or choose "custom"']);
  assert.deepEqual(targetsRecord({ profile: 'noncritical' }), { profile: 'noncritical', mttd: '15m', mttr: '240m' });
  assert.deepEqual(targetsRecord({ profile: 'custom', mttd: '1h30m', mttr: '2h' }), { profile: 'custom', mttd: '90m', mttr: '120m' });
  assert.equal(targetsRecord(null), null);
  assert.ok(sameTargets({ profile: 'custom', mttd: '90m', mttr: '2h' }, { profile: 'custom', mttd: '1h30m', mttr: '120m', by: 'a', at: 'b' }));
  assert.ok(!sameTargets({ profile: 'lab', mttd: '1m', mttr: '5m' }, null) && sameTargets(null, undefined));
});

test('a service\'s targets in words: a profile\'s own, custom minutes in minutes or hours; nothing for what is not targets', () => {
  assert.deepEqual(targetsView({ profile: 'financial', mttd: '1m', mttr: '15m', by: 'ada', at: '2026-11-11T10:00:00Z' }), {
    profile: 'financial', name: 'Critical financial service', mttd: '1m', mttr: '15m', mttdWords: '≤ 1 min', mttrWords: '≤ 15 min',
    words: 'MTTD ≤ 1 min · MTTR ≤ 15 min', by: 'ada', at: '2026-11-11T10:00:00Z',
  });
  assert.equal(targetsView({ profile: 'custom', mttd: '3m', mttr: '90m' }).words, 'MTTD ≤ 3 min · MTTR ≤ 1 h 30 min');
  // A profile whose durations were changed by hand is said as what it holds, as custom.
  assert.deepEqual([targetsView({ profile: 'lab', mttd: '2m', mttr: '5m' }).profile, targetsView({ profile: 'lab', mttd: '2m', mttr: '5m' }).words], [MTTX_CUSTOM, 'MTTD ≤ 2 min · MTTR ≤ 5 min']);
  assert.deepEqual([targetsView(null), targetsView({ profile: 'lab' }), targetsView('lab')], [null, null, null]);
});

test('the form\'s answer: the recommended profile for a new service, the record\'s for one kept, custom minutes and their problems, the dropdown', () => {
  assert.deepEqual(targetsFormValues(null, { isNew: true }), { targetProfile: 'lab', targetMttd: '', targetMttr: '' });
  assert.deepEqual(targetsFormValues(null), { targetProfile: '', targetMttd: '', targetMttr: '' }, 'a service kept without targets starts on none');
  assert.deepEqual(targetsFormValues({ profile: 'custom', mttd: '3m', mttr: '90m' }), { targetProfile: 'custom', targetMttd: '3', targetMttr: '90' });
  assert.deepEqual([targetsFromForm({ targetProfile: '' }), targetsFromForm({ targetProfile: 'degradation' }), targetsFromForm({ targetProfile: 'custom', targetMttd: '2', targetMttr: ' 45 ' })],
    [null, { profile: 'degradation' }, { profile: 'custom', mttd: '2m', mttr: '45m' }]);
  assert.deepEqual(targetsFormProblems({ targetProfile: 'custom', targetMttd: '0', targetMttr: '1.5' }), { targetMttd: 'Minutes, a whole number from 1 to 10080.', targetMttr: 'Minutes, a whole number from 1 to 10080.' });
  assert.deepEqual(targetsFormProblems({ targetProfile: 'lab', targetMttd: 'x' }), {}, 'minutes matter for custom only');
  assert.deepEqual(targetsOptions('custom').map((o) => [o.value, o.selected]), [['lab', false], ['financial', false], ['degradation', false], ['noncritical', false], ['custom', true], ['', false]]);
  assert.deepEqual(targetsOptions('').map((o) => o.label), [
    'Lab default — MTTD ≤ 1 min · MTTR ≤ 5 min (recommended)', 'Critical financial service — MTTD ≤ 1 min · MTTR ≤ 15 min',
    'Significant degradation — MTTD ≤ 5 min · MTTR ≤ 60 min', 'Noncritical service — MTTD ≤ 15 min · MTTR ≤ 4 hours',
    'Custom — minutes of your own', 'Not set (the board recommends one)',
  ]);
});

test('the module imports nothing: the server and every studio copy read the same list', () => {
  const src = readFileSync(new URL('../studio/mttx-targets.mjs', import.meta.url), 'utf8');
  assert.ok(!/^\s*import\b/m.test(src) && !/\bimport\(/.test(src), 'zero imports');
});
