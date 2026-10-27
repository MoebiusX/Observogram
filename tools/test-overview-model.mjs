#!/usr/bin/env node
/**
 * tools/test-overview-model.mjs — the Overview screen's pure model (studio/overview-model.mjs)
 * and its renderer (studio/overview-view.mjs), headless under node:test.
 *
 * The fixtures are bodies recorded from the demo server on 2026-10-27 (tools/fixtures/overview):
 * GET /api/services (krystaline with a primary pack; kx-exchange, kx-matcher, kx-wallet linked to
 * the live draft as members only), GET /api/packs (the catalogue: the repository pack and the live
 * draft, `live: 'scaffold'`), GET /api/journeys (the `krystaline` journey — scope.service null,
 * Pack A the pack file, Pack B "mcp: https://…") and its newest run (gate-failed, B · Industrial
 * Grade 69, drift 38 declared-not-live · 5 drifted · 30 live-not-declared, probes.failed
 * ['dashboards'], vantage partial).
 *
 * Every sentence the screen can say is pinned here as an exact string, and a vocabulary guard
 * walks every string of every model built: no percentage, no layer code, no artefact id, no
 * engine jargon, no product name.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  UI_MODES, OVERVIEW_STATUS, FRESH_WINDOW_MS,
  decideUiMode, orderServicesForOverview, pickOverviewService, journeyForService, journeyIsLive,
  shortGradeLabel, verdictWordFor, runGradedPack, differenceCount,
  gradeModel, stillTrueModel, nextActionModel, buildOverviewModel,
} from '../studio/overview-model.mjs';
import { renderOverview } from '../studio/overview-view.mjs';

// ---------- fixtures ----------

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/overview/${name}.json`, import.meta.url), 'utf8'));
const services = fixture('services').services;
const packs = fixture('packs').packs;
const journeys = fixture('journeys').journeys;
const run = fixture('krystaline-run');

const KRYSTALINE = services.find((s) => s.slug === 'krystaline');
const krystalinePack = packs.find((p) => p.id === 'uploaded-krystaline-a37d2521');
const journey = journeys[0];
const isLiveAggregatePack = (p) => p.live === 'scaffold' || p.live === 'snapshot';

const T0 = Date.parse(run.startedAt);
const NOW = T0 + 2 * 3600e3;            // "2 hours ago"
const STALE_NOW = T0 + 25 * 3600e3;     // past the engine's freshness window: "1 day ago"
const HOUR = 3600e3;

// The pack-alone diagnostic (computeDiagnosticGrade on Pack A) and the decision (buildAssessmentDecision), minimal.
const diagnostic = { overall: { instrumentGrade: { letter: 'C', tier: 'c', label: 'Field Grade', blurb: '…' }, verdict: { word: 'Not yet diagnostic-grade' }, audit: { scorePctExact: 43 } } };
const decision = { causes: [{ title: 'Nothing live has been checked' }, { title: 'Not every signal type is declared' }, { title: 'Whole layers are unobserved' }, { title: 'a fourth' }] };

// Derived runs: nothing differs; the live side did not answer.
const withDrift = (over) => ({ ...run, drift: { ...run.drift, ...over } });
const unchangedRun = withDrift({ declaredNotLive: 0, drifted: 0, liveNotDeclared: 0 });
const lostRun = { ...run, outcome: 'vantage-lost' };
// The same journey reading a recording as Pack B (a file path, not "mcp: …").
const fileJourney = { ...journey, packB: 'C:/demo/.observogram-demo/journeys/krystaline/live/2026-10-07T12-00-00-000Z.json' };

// buildOverviewModel's input for the real screen: krystaline on prod, +2h after the run.
const screen = (over = {}) => buildOverviewModel({
  services, servicesStatus: { kind: 'ok', error: null }, catalog: packs, serviceId: 1, env: 'prod', isLiveAggregatePack,
  diagnostic, decision, journeys, run, now: NOW, ...over,
});

// Every model built in the grade / still-true / next / screen tests is kept for the vocabulary guard.
const builtModels = [];
const keep = (m) => { builtModels.push(m); return m; };

// ---------- which mode the studio opens in ----------

test('decideUiMode: the query wins over the saved preference and the default; saved over the default; the default is overview only with a service to show; unknown values are ignored', () => {
  assert.deepEqual(UI_MODES, ['overview', 'expert']);
  assert.equal(decideUiMode({ query: 'expert', saved: 'overview', hasServices: true }), 'expert');
  assert.equal(decideUiMode({ query: 'overview', saved: 'expert', hasServices: false }), 'overview');
  assert.equal(decideUiMode({ saved: 'expert', hasServices: true }), 'expert');
  assert.equal(decideUiMode({ saved: 'overview', hasServices: false }), 'overview');
  assert.equal(decideUiMode({ hasServices: true }), 'overview');
  assert.equal(decideUiMode({ hasServices: false }), 'expert');
  assert.equal(decideUiMode(), 'expert', 'the empty studio boots as before');
  // Unknown values never win: the next source decides.
  assert.equal(decideUiMode({ query: 'admin', saved: 'overview', hasServices: false }), 'overview');
  assert.equal(decideUiMode({ query: 'OVERVIEW', saved: 'nope', hasServices: true }), 'overview', 'case matters; two unknowns fall to the default');
  assert.equal(decideUiMode({ query: '', saved: null, hasServices: false }), 'expert');
});

// ---------- the service on screen ----------

test('orderServicesForOverview / pickOverviewService: the row with a pack of its own first, the member-only rows after; the remembered id wins, an unknown one falls back; the env falls back to the first; nothing → null', () => {
  const ordered = orderServicesForOverview(services, packs, { isLiveAggregatePack });
  assert.deepEqual(ordered.map((s) => s.slug), ['krystaline', 'kx-exchange', 'kx-matcher', 'kx-wallet'], 'krystaline is the only row with a primary pack in the catalogue');
  // The same rows in another table order: krystaline still first, the rest in table order.
  assert.deepEqual(orderServicesForOverview([...services].reverse(), packs, { isLiveAggregatePack }).map((s) => s.id), [1, 4, 3, 2]);
  // Without the live-aggregate rule the kx-* rows have no pack at all; the order is the same.
  assert.deepEqual(orderServicesForOverview(services, packs).map((s) => s.id), [1, 2, 3, 4]);
  assert.deepEqual(orderServicesForOverview([null, services[1], undefined], packs, { isLiveAggregatePack }).map((s) => s.id), [2], 'holes are dropped');

  const picked = pickOverviewService(services, packs, { serviceId: 1, env: 'prod', isLiveAggregatePack });
  assert.equal(picked.service, KRYSTALINE);
  assert.deepEqual([picked.env, picked.envs, picked.pack.id, picked.how], ['prod', ['prod'], 'uploaded-krystaline-a37d2521', 'primary']);
  // The remembered row wins when present — even a member-only one.
  const remembered = pickOverviewService(services, packs, { serviceId: 3, env: 'prod', isLiveAggregatePack });
  assert.deepEqual([remembered.service.slug, remembered.how, remembered.pack.id], ['kx-matcher', 'aggregate', 'uploaded-krystaline-8ead3bb1']);
  assert.equal(pickOverviewService(services, packs, { serviceId: 3, env: 'prod' }).how, 'none', 'a member link that is not a live aggregate is no pack');
  // An unknown id, or none: the first in overview order.
  assert.equal(pickOverviewService(services, packs, { serviceId: 99, isLiveAggregatePack }).service.slug, 'krystaline');
  assert.equal(pickOverviewService([...services].reverse(), packs, { isLiveAggregatePack }).service.slug, 'krystaline');
  // The env: the remembered one when the row has it, else the row's first, else null.
  assert.equal(pickOverviewService(services, packs, { serviceId: 1, env: 'staging', isLiveAggregatePack }).env, 'prod');
  assert.equal(pickOverviewService(services, packs, { serviceId: 1, isLiveAggregatePack }).env, 'prod');
  const noEnvs = pickOverviewService([{ ...KRYSTALINE, environments: [] }], packs, { serviceId: 1, env: 'prod', isLiveAggregatePack });
  assert.deepEqual([noEnvs.env, noEnvs.envs], [null, []]);
  // Nothing to show.
  const none = { service: null, env: null, envs: [], pack: null, how: 'none' };
  assert.deepEqual(pickOverviewService([], packs, { serviceId: 1 }), none);
  assert.deepEqual(pickOverviewService(null, packs, { serviceId: 1 }), none);
  assert.deepEqual(pickOverviewService(undefined, undefined), none);
});

// ---------- the journey that checks this service ----------

test('journeyForService: found by the pack file although scope.service is null; by slug, case-insensitively; another pack or service is not; scope.env prefers among several; null when none', () => {
  // The real listing: scope.service is null, Pack A is the pack file — the pack is the link.
  assert.equal(journeyForService(journeys, { slug: 'krystaline', env: 'prod', packId: 'uploaded-krystaline-a37d2521' }), journey);
  assert.equal(journeyForService(journeys, { packId: 'uploaded-krystaline-a37d2521' }), journey, 'the pack alone suffices');
  assert.equal(journeyForService(journeys, { slug: 'krystaline' }), null, 'the slug alone does not: the listing scopes no service');
  // A journey that names the service in its scope: found by slug, whatever the case, whatever Pack A.
  const scoped = { ...journey, name: 'kx-wallet-check', packA: '/elsewhere/other.pack.yaml', scope: { env: 'prod', service: 'KX-Wallet', scopeMode: null } };
  assert.equal(journeyForService([journey, scoped], { slug: 'kx-wallet', env: 'prod', packId: 'uploaded-krystaline-8ead3bb1' }), scoped);
  assert.equal(journeyForService([scoped], { slug: ' kx-wallet ', packId: null }), scoped, 'whitespace around the slug is trimmed');
  // Another pack / another service: not this service's journey.
  assert.equal(journeyForService(journeys, { slug: 'kx-exchange', env: 'prod', packId: 'uploaded-krystaline-8ead3bb1' }), null);
  assert.equal(journeyForService([scoped], { slug: 'kx-matcher', env: 'prod', packId: 'uploaded-krystaline-8ead3bb1' }), null);
  assert.equal(journeyForService(journeys, { slug: null, env: null, packId: null }), null, 'nothing to match on matches nothing');
  // A Windows path to the same pack file is the same link.
  assert.equal(journeyForService([{ ...journey, packA: 'C:\\demo\\.observogram-demo\\packs\\uploaded-krystaline-a37d2521.pack.yaml' }], { packId: 'uploaded-krystaline-a37d2521' })?.name, 'krystaline');
  // Among several journeys of the pack: the one whose scope.env is the environment on screen, else the first.
  const staging = { ...journey, name: 'krystaline-staging', scope: { env: 'staging', service: null, scopeMode: null } };
  const prod = { ...journey, name: 'krystaline-prod', scope: { env: 'prod', service: null, scopeMode: null } };
  assert.equal(journeyForService([staging, prod], { env: 'prod', packId: 'uploaded-krystaline-a37d2521' }), prod);
  assert.equal(journeyForService([staging, prod], { env: 'staging', packId: 'uploaded-krystaline-a37d2521' }), staging);
  assert.equal(journeyForService([staging, prod], { env: 'dev', packId: 'uploaded-krystaline-a37d2521' }), staging, 'no journey for dev: the first');
  assert.equal(journeyForService([staging, prod], { env: null, packId: 'uploaded-krystaline-a37d2521' }), staging);
  // None.
  assert.equal(journeyForService([], { slug: 'krystaline', packId: 'uploaded-krystaline-a37d2521' }), null);
  assert.equal(journeyForService(null, { slug: 'krystaline' }), null);
  assert.equal(journeyForService([null, undefined], { slug: 'krystaline' }), null);
});

test('journeyIsLive: "mcp: …" as Pack B is live; a file path, nothing, or no journey is not', () => {
  assert.equal(journeyIsLive(journey), true);
  assert.equal(journeyIsLive({ packB: 'mcp: https://www.example.test/mcp/public' }), true);
  assert.equal(journeyIsLive({ packB: 'MCP:https://www.example.test/mcp' }), true, 'case does not matter');
  assert.equal(journeyIsLive(fileJourney), false);
  assert.equal(journeyIsLive({ packB: '/var/lib/mcp:not-a-scheme.json' }), false, 'only a leading "mcp:" is a live draft');
  assert.equal(journeyIsLive({ packB: null }), false);
  assert.equal(journeyIsLive({}), false);
  assert.equal(journeyIsLive(null), false);
  assert.equal(journeyIsLive(undefined), false);
});

// ---------- the grade words ----------

test('shortGradeLabel: the first word of each of the seven ladder labels, then "grade"; verdictWordFor: the engine\'s four bands at their edges', () => {
  assert.deepEqual([
    'Calibration / Reference Grade', 'Laboratory / Research Grade', 'Diagnostic / Clinical Grade', 'Inspection Grade', 'Industrial Grade', 'Field Grade', 'Consumer Grade',
  ].map((label) => shortGradeLabel({ label })), [
    'Calibration grade', 'Laboratory grade', 'Diagnostic grade', 'Inspection grade', 'Industrial grade', 'Field grade', 'Consumer grade',
  ]);
  assert.equal(shortGradeLabel({ label: '  Industrial Grade  ' }), 'Industrial grade');
  assert.equal(shortGradeLabel({ label: 'Industrial' }), 'Industrial grade', 'a label without the word');
  assert.deepEqual([shortGradeLabel({ label: '' }), shortGradeLabel({}), shortGradeLabel(null), shortGradeLabel(undefined)], ['', '', '', '']);

  assert.equal(verdictWordFor(86), 'Diagnostic-grade');
  assert.equal(verdictWordFor(85), 'Almost diagnostic-grade', '85 is not above the pass threshold');
  assert.equal(verdictWordFor(62.5), 'Almost diagnostic-grade');
  assert.equal(verdictWordFor(62.4), 'Not yet diagnostic-grade');
  assert.equal(verdictWordFor(37.5), 'Not yet diagnostic-grade');
  assert.equal(verdictWordFor(37.4), 'Far from diagnostic-grade');
  assert.equal(verdictWordFor(0), 'Far from diagnostic-grade');
  assert.equal(verdictWordFor(100), 'Diagnostic-grade');
  assert.equal(verdictWordFor('69'), 'Almost diagnostic-grade', 'a numeric string is a number');
  assert.deepEqual([verdictWordFor(undefined), verdictWordFor('n/a'), verdictWordFor(NaN)], ['', '', ''], 'no score, no word (null and the empty string are pinned below)');
});

test('runGradedPack: the record\'s Pack A file named by the pack id, else name and version agree; differenceCount is declared-not-live plus drifted, never live-only', () => {
  assert.equal(runGradedPack(run, krystalinePack), true, 'the source is the pack file');
  assert.equal(runGradedPack(run, { id: 'other-pack', name: 'krystaline', version: '0.1.0-crawled' }), true, 'another id, the same name and version');
  assert.equal(runGradedPack(run, { id: 'other-pack', label: 'krystaline' }), true, 'the label stands in for the name; no version on the pack side passes');
  assert.equal(runGradedPack(run, { id: 'other-pack', name: 'krystaline', version: '0.2.0' }), false, 'the version disagrees');
  assert.equal(runGradedPack(run, { id: 'other-pack', name: 'krystaline-v2', version: '0.1.0-crawled' }), false, 'the name disagrees');
  assert.equal(runGradedPack({ ...run, packA: { name: 'krystaline' } }, { id: 'x', name: 'krystaline', version: '9' }), true, 'no version on the run side passes');
  assert.equal(runGradedPack({ ...run, packA: {} }, krystalinePack), false);
  assert.equal(runGradedPack(null, krystalinePack), false);
  assert.equal(runGradedPack(run, null), false);

  assert.equal(differenceCount(run), 43);
  assert.equal(differenceCount(unchangedRun), 0);
  assert.equal(differenceCount(withDrift({ declaredNotLive: 1, drifted: 1, liveNotDeclared: 0 })), 2);
  assert.equal(differenceCount(withDrift({ declaredNotLive: '3', drifted: null, liveNotDeclared: 99 })), 3, 'strings count, nulls do not, live-only never does');
  assert.equal(differenceCount({ drift: {} }), 0);
  assert.equal(differenceCount(null), 0);
});

// ---------- the grade ----------

test('gradeModel: the run\'s letter when it graded this pack against live; the pack alone otherwise and the source says which; no pack, no pack of its own, unreadable, reading', () => {
  const live = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic, run, journey, now: NOW }));
  assert.deepEqual(live, {
    letter: 'B', label: 'Industrial grade', word: 'Almost diagnostic-grade',
    source: 'Graded against live, 2 hours ago.', tone: 'warn',
    title: 'B · Industrial Grade — Suitable for production, maintenance, process control, and routine professional use.',
    basis: 'live',
  });
  assert.equal(keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic, run: { ...run, outcome: 'pass' }, journey, now: NOW })).basis, 'live', 'a passing run is as usable as a gate-failed one');
  // The same run against a recording: the words say so, and never "against live".
  const recorded = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic, run, journey: fileJourney, now: NOW }));
  assert.deepEqual([recorded.letter, recorded.source, recorded.basis], ['B', 'Graded against a live recording, 2 hours ago.', 'recording']);
  // No journey given: the run's own Pack B source decides.
  assert.equal(keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic, run, journey: null, now: NOW })).source, 'Graded against live, 2 hours ago.');
  assert.equal(keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic, run: { ...run, packB: { ...run.packB, source: '/recordings/old.json' } }, journey: null, now: NOW })).basis, 'recording');
  // The run graded another pack: the pack-alone grade.
  const packAlone = {
    letter: 'C', label: 'Field grade', word: 'Not yet diagnostic-grade',
    source: 'Graded from the repository alone.', tone: 'warn', title: 'C · Field Grade — …', basis: 'repository',
  };
  assert.deepEqual(keep(gradeModel({ pack: { ...krystalinePack, id: 'other-pack', name: 'krystaline-v2', label: 'krystaline-v2' }, how: 'primary', diagnostic, run, journey, now: NOW })), packAlone);
  assert.deepEqual(keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic, run: null, journey: null, now: NOW })), packAlone, 'no run at all');
  assert.deepEqual(keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic, run: { ...run, grade: null }, journey, now: NOW })), packAlone, 'a run without a letter');
  // The live side could not be seen: the pack alone, and the source says why.
  const lost = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic, run: lostRun, journey, now: NOW }));
  assert.deepEqual(lost, { ...packAlone, source: 'Graded from the repository alone; the last live check could not see production.' });
  assert.equal(keep(gradeModel({ pack: { ...krystalinePack, id: 'other-pack', name: 'v2' }, how: 'primary', diagnostic, run: lostRun, journey, now: NOW })).source, 'Graded from the repository alone.', 'a lost run of another pack says nothing here');
  // The pack-alone grade without the engine's instrumentGrade: derived from the exact score; the word from the score too.
  const derived = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: { overall: { audit: { scorePctExact: 90 } } }, now: NOW }));
  assert.deepEqual([derived.letter, derived.label, derived.word, derived.tone, derived.title], ['A', 'Diagnostic grade', 'Diagnostic-grade', 'ok', 'A · Diagnostic / Clinical Grade — Fit for professional diagnostic, clinical, or decision-critical use.']);
  // No pack, or only a live draft's membership.
  const noPack = { letter: '–', label: 'No pack yet', word: 'Nothing to grade: no pack is registered for this service.', source: '', tone: 'neutral', title: '', basis: 'none' };
  assert.deepEqual(keep(gradeModel({ pack: null, how: 'none', diagnostic, run, journey, now: NOW })), noPack);
  assert.deepEqual(keep(gradeModel({ pack: krystalinePack, how: 'none', diagnostic, run, journey, now: NOW })), noPack, 'how says none: the pack is not this service\'s');
  assert.deepEqual(keep(gradeModel()), noPack);
  assert.deepEqual(keep(gradeModel({ pack: packs[1], how: 'aggregate', diagnostic, run, journey, now: NOW })), {
    letter: '–', label: 'No pack of its own', word: 'This service appears in a live draft, but no pack of its own is registered yet.', source: '', tone: 'neutral', title: '', basis: 'none',
  });
  // Unreadable, and not yet read.
  assert.deepEqual(keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnosticError: 'the pack file is not valid YAML', now: NOW })), {
    letter: '?', label: 'Not graded', word: 'The pack could not be read: the pack file is not valid YAML', source: '', tone: 'neutral', title: '', basis: 'error',
  });
  assert.deepEqual(keep(gradeModel({ pack: krystalinePack, how: 'primary', now: NOW })), { letter: '·', label: 'Reading…', word: '', source: '', tone: 'neutral', title: '', basis: 'pending' });
  assert.equal(keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: {}, now: NOW })).basis, 'pending', 'a diagnostic without overall is not read yet');
  assert.equal(keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic, diagnosticError: 'x', run, journey, now: NOW })).basis, 'live', 'a usable run outranks a read error of the pack alone');
});

// ---------- is that still true right now? ----------

test('stillTrueModel: never checked (no journey; a journey without a run, with and without an env), the live wording and the Check button only for a live journey', () => {
  assert.deepEqual(OVERVIEW_STATUS, { never: 'Never checked', unchanged: 'Unchanged', changed: 'Changed', unreachable: 'Unreachable' });
  assert.equal(FRESH_WINDOW_MS, 24 * HOUR);
  // S0: no journey at all.
  const s0 = keep(stillTrueModel({ journey: null, run: null, now: NOW }));
  assert.deepEqual(s0, { status: 'never', pill: 'Never checked', sentence: 'Never checked against live.', note: '', cadence: '', stale: false, canCheck: false, checkLabel: '', checkPrimary: false, tone: 'info', error: null, pending: false, running: false });
  assert.deepEqual(keep(stillTrueModel()), s0);
  // S1: a journey, never run. The fixture's scope.env is null; with one the sentence names it.
  const s1 = keep(stillTrueModel({ journey, run: null, now: NOW }));
  assert.deepEqual(s1, { status: 'never', pill: 'Never checked', sentence: 'Never checked against live. A live check is set up.', note: '', cadence: 'Checks run only when you click.', stale: false, canCheck: false, checkLabel: '', checkPrimary: false, tone: 'info', error: null, pending: false, running: false });
  const s1prod = keep(stillTrueModel({ journey: { ...journey, scope: { ...journey.scope, env: 'prod' } }, run: null, now: NOW }));
  assert.equal(s1prod.sentence, 'Never checked against live. A live check is set up for prod.');
  assert.equal(keep(stillTrueModel({ journey: { ...journey, schedule: '0 * * * *' }, run: null, now: NOW })).cadence, 'Checks run on a schedule.');
  // A file-backed journey cannot be checked from here.
  const s1file = keep(stillTrueModel({ journey: fileJourney, run: null, now: NOW }));
  assert.deepEqual([s1file.status, s1file.sentence, s1file.canCheck, s1file.checkLabel, s1file.checkPrimary], ['never', 'Never checked against live. A live check is set up.', false, '', false]);
});

test('stillTrueModel: the real run reads Changed with the count of what differs (declared-not-live plus drifted), no transition clause on a first run; the since clause counts worse first, else changed', () => {
  const s3 = keep(stillTrueModel({ journey, run, now: NOW }));
  assert.deepEqual(s3, {
    status: 'changed', pill: 'Changed',
    sentence: 'Checked 2 hours ago against live — 43 things differ from what the repository declares.',
    note: '', cadence: 'Checks run only when you click.', stale: false, canCheck: true, checkLabel: 'Check again', checkPrimary: false, tone: 'warn', error: null, pending: false, running: false,
  });
  // The transition: 'first run' or no `since` says nothing; worse wins over changed; nothing changed says nothing.
  const since = (transition) => keep(stillTrueModel({ journey, run: { ...run, transition }, now: NOW })).sentence;
  assert.equal(since({ reason: 'first run', since: null, changed: [] }), 'Checked 2 hours ago against live — 43 things differ from what the repository declares.');
  assert.equal(since({ reason: null, since: '2026-10-27T18:48:29.174Z', changed: [{ direction: 'worse' }, { direction: 'better' }] }), 'Checked 2 hours ago against live — 43 things differ from what the repository declares. 1 got worse since the check before.');
  assert.equal(since({ reason: null, since: '2026-10-27T18:48:29.174Z', changed: [{ direction: 'better' }, { direction: 'same' }] }), 'Checked 2 hours ago against live — 43 things differ from what the repository declares. 2 changed since the check before.');
  assert.equal(since({ reason: null, since: '2026-10-27T18:48:29.174Z', changed: [{ direction: 'worse' }, { direction: 'worse' }, { direction: 'better' }] }), 'Checked 2 hours ago against live — 43 things differ from what the repository declares. 2 got worse since the check before.');
  assert.equal(since({ reason: null, since: null, changed: [{ direction: 'worse' }] }), 'Checked 2 hours ago against live — 43 things differ from what the repository declares.', 'no `since` is a first run whatever `changed` holds');
  assert.equal(since({ reason: null, since: '2026-10-27T18:48:29.174Z', changed: 3, worse: 1 }), 'Checked 2 hours ago against live — 43 things differ from what the repository declares. 1 got worse since the check before.', 'the listing\'s counted shape');
  assert.equal(since({ reason: null, since: '2026-10-27T18:48:29.174Z', changed: 3, worse: 0 }), 'Checked 2 hours ago against live — 43 things differ from what the repository declares. 3 changed since the check before.');
  assert.equal(since(undefined), 'Checked 2 hours ago against live — 43 things differ from what the repository declares.');
  // Just run: "just now".
  assert.equal(keep(stillTrueModel({ journey, run, now: T0 + 30e3 })).sentence, 'Checked just now against live — 43 things differ from what the repository declares.');
});

test('stillTrueModel: Unchanged with the Check again primary; stale after a day (no check, warn); Unreachable; a recording names its day and cannot be checked; running; the listing unreadable; a start error carried', () => {
  // S2: nothing differs.
  const s2 = keep(stillTrueModel({ journey, run: unchangedRun, now: NOW }));
  assert.deepEqual(s2, {
    status: 'unchanged', pill: 'Unchanged',
    sentence: 'Checked 2 hours ago against live — it matches: everything the repository declares is running live.',
    note: '', cadence: 'Checks run only when you click.', stale: false, canCheck: true, checkLabel: 'Check again', checkPrimary: true, tone: 'ok', error: null, pending: false, running: false,
  });
  assert.equal(keep(stillTrueModel({ journey, run: { ...unchangedRun, transition: { reason: null, since: '2026-10-27T18:48:29.174Z', changed: [{ direction: 'better' }] } }, now: NOW })).sentence,
    'Checked 2 hours ago against live — it matches: everything the repository declares is running live. 1 changed since the check before.');
  // Stale: older than the freshness window — no Check from here, and Unchanged turns to warn.
  const stale = keep(stillTrueModel({ journey, run: unchangedRun, now: STALE_NOW }));
  assert.deepEqual([stale.status, stale.stale, stale.canCheck, stale.checkPrimary, stale.tone, stale.sentence], ['unchanged', true, false, false, 'warn', 'Checked 1 day ago against live — it matches: everything the repository declares is running live.']);
  const staleChanged = keep(stillTrueModel({ journey, run, now: STALE_NOW }));
  assert.deepEqual([staleChanged.status, staleChanged.stale, staleChanged.canCheck, staleChanged.tone], ['changed', true, false, 'warn']);
  assert.equal(keep(stillTrueModel({ journey, run: unchangedRun, now: T0 + FRESH_WINDOW_MS })).stale, false, 'exactly a day old is still fresh');
  assert.equal(keep(stillTrueModel({ journey, run: unchangedRun, now: T0 + FRESH_WINDOW_MS + 1 })).stale, true);
  // Unreachable: the live side did not answer.
  const lost = keep(stillTrueModel({ journey, run: lostRun, now: NOW }));
  assert.deepEqual(lost, {
    status: 'unreachable', pill: 'Unreachable',
    sentence: 'Last check 2 hours ago: the live side did not answer, so nothing is known about it right now.',
    note: '', cadence: 'Checks run only when you click.', stale: false, canCheck: false, checkLabel: '', checkPrimary: false, tone: 'warn', error: null, pending: false, running: false,
  });
  assert.equal(keep(stillTrueModel({ journey, run: lostRun, now: STALE_NOW })).stale, true);
  // A recording as Pack B: the words say so with its day, and nothing can be checked from here.
  const recorded = keep(stillTrueModel({ journey: fileJourney, run: { ...run, packB: { ...run.packB, refreshedAt: '2026-10-07T12:00:00.000Z' } }, now: NOW }));
  assert.deepEqual([recorded.status, recorded.sentence, recorded.canCheck, recorded.checkLabel, recorded.checkPrimary],
    ['changed', 'Checked 2 hours ago against a live recording from 7 Oct — 43 things differ from what the repository declares.', false, 'Check again', false]);
  const recordedOk = keep(stillTrueModel({ journey: fileJourney, run: { ...unchangedRun, packB: { source: 'live/x.json' } }, now: NOW }));
  assert.deepEqual([recordedOk.sentence, recordedOk.canCheck, recordedOk.checkPrimary], ['Checked 2 hours ago against a live recording — it matches: everything the repository declares is running live.', false, false], 'no refreshedAt: no day; Unchanged against a recording is never the primary');
  // Running: the sentence and the button say so; the status is the last run's.
  const running = keep(stillTrueModel({ journey, run, now: NOW, running: true }));
  assert.deepEqual(running, { status: 'changed', pill: 'Changed', sentence: 'Checking against live now…', note: '', cadence: 'Checks run only when you click.', stale: false, canCheck: true, checkLabel: 'Checking…', checkPrimary: false, tone: 'info', error: null, pending: false, running: true });
  assert.deepEqual([keep(stillTrueModel({ journey, run: null, running: true })).status, keep(stillTrueModel({ journey, run: lostRun, running: true })).status, keep(stillTrueModel({ journey, run: unchangedRun, running: true })).pill], ['never', 'unreachable', 'Unchanged']);
  // The journeys listing could not be read: nothing is claimed, a Retry is offered.
  const unread = keep(stillTrueModel({ journey: null, run: null, now: NOW, journeysError: '500: boom' }));
  assert.deepEqual(unread, { status: null, pill: '', sentence: 'Whether it was ever checked could not be read: 500: boom', note: '', cadence: '', stale: false, canCheck: false, checkLabel: '', checkPrimary: false, tone: 'warn', error: null, pending: false, running: false, retry: true });
  assert.equal(keep(stillTrueModel({ journey, run, now: NOW, journeysError: '500: boom', startError: '502: gateway' })).error, null, 'the listing error outranks a start error');
  // The facts are still being read: "Reading…", nothing claimed, no cadence, no button — whatever else is passed.
  const pending = keep(stillTrueModel({ journey, run, now: NOW, pending: true }));
  assert.deepEqual(pending, { status: null, pill: '', sentence: 'Reading…', note: '', cadence: '', stale: false, canCheck: false, checkLabel: '', checkPrimary: false, tone: 'neutral', error: null, pending: true, running: false });
  assert.equal(keep(stillTrueModel({ journey, run, running: true, pending: true })).sentence, 'Reading…', 'pending outranks running');
  assert.equal(keep(stillTrueModel({ journeysError: '500: boom', pending: true })).retry, undefined, 'pending outranks the listing error');
  assert.equal(keep(stillTrueModel({ journey, run, pending: true, startError: '502: gateway' })).error, '502: gateway', 'a start error is still carried');
  // A check that could not start: the error rides along with the state as it was.
  const failed = keep(stillTrueModel({ journey, run, now: NOW, startError: '502: the journey runner did not answer' }));
  assert.deepEqual([failed.status, failed.sentence, failed.error], ['changed', 'Checked 2 hours ago against live — 43 things differ from what the repository declares.', '502: the journey runner did not answer']);
});

// ---------- what to do next ----------

const still = (over = {}) => stillTrueModel({ journey, run, now: NOW, ...over });
const liveGrade = gradeModel({ pack: krystalinePack, how: 'primary', diagnostic, run, journey, now: NOW });
const packGrade = gradeModel({ pack: krystalinePack, how: 'primary', diagnostic, now: NOW });

test('nextActionModel: never checked → the repository\'s causes (three at most); a live journey never run → Check now; a recording → Expert mode', () => {
  const n0 = keep(nextActionModel({ still: still({ journey: null, run: null }), grade: packGrade, decision, run: null, journey: null }));
  assert.deepEqual(n0, {
    sentence: 'Nothing live has been checked yet; the grade rests on what the repository declares.',
    button: { label: 'See what to fix', action: 'ov-next-diagnose' },
    why: ['Nothing live has been checked', 'Not every signal type is declared', 'Whole layers are unobserved'],
    primary: true,
  });
  assert.deepEqual(keep(nextActionModel({ still: still({ journey: null, run: null }), grade: packGrade, decision: null })).why, [], 'no decision yet: no why');
  assert.deepEqual(keep(nextActionModel({ still: still({ journey: null, run: null }), grade: packGrade, decision: { causes: [{ title: '' }, { title: 'One' }, {}] } })).why, ['One'], 'blank titles are dropped');
  const n1 = keep(nextActionModel({ still: still({ run: null }), grade: packGrade, decision, run: null, journey }));
  assert.deepEqual(n1, { sentence: 'Check it against live now.', button: { label: 'Check now', action: 'ov-check' }, why: [], primary: true });
  const n1file = keep(nextActionModel({ still: still({ journey: fileJourney, run: null }), grade: packGrade, decision, run: null, journey: fileJourney }));
  assert.deepEqual(n1file, { sentence: 'The saved check reads a recording; open Expert mode to run it.', button: { label: 'Open Expert mode', action: 'ov-expert' }, why: [], primary: true });
});

test('nextActionModel: Changed → fix the things that differ, the why in plural and singular, the probes item fourth and cut; Unchanged → nothing, no button; Unreachable; stale; no pack or unreadable → Expert mode; nothing known → nothing', () => {
  const s3 = keep(nextActionModel({ still: still(), grade: liveGrade, decision, run, journey }));
  assert.deepEqual(s3, {
    sentence: 'Fix the 43 things the live side does differently.',
    button: { label: 'See the differences', action: 'ov-next-neuron' },
    why: ['38 declared things are not running live.', '5 things run differently live than declared.', '30 more things run live that the repository does not declare.'],
    primary: true,
  });
  assert.equal(s3.why.length, 3, 'the failed probe is the fourth item, cut by the ≤ 3 rule');
  // Without live-only things the failed probe shows as the third item.
  const probes = keep(nextActionModel({ still: still(), grade: liveGrade, decision, run: withDrift({ liveNotDeclared: 0 }), journey }));
  assert.deepEqual(probes.why, ['38 declared things are not running live.', '5 things run differently live than declared.', 'Part of the live side could not be read.']);
  // Singulars.
  const two = withDrift({ declaredNotLive: 1, drifted: 1, liveNotDeclared: 0 });
  const singular = keep(nextActionModel({ still: still({ run: two }), grade: liveGrade, decision, run: { ...two, probes: { ...run.probes, failed: [] } }, journey }));
  assert.deepEqual([singular.sentence, singular.why], ['Fix the 2 things the live side does differently.', ['1 declared thing is not running live.', '1 thing runs differently live than declared.']]);
  const one = withDrift({ declaredNotLive: 1, drifted: 0, liveNotDeclared: 1 });
  const k1 = keep(nextActionModel({ still: still({ run: one }), grade: liveGrade, decision, run: { ...one, probes: { failed: [] } }, journey }));
  assert.deepEqual([k1.sentence, k1.why], ['Fix the 1 thing the live side does differently.', ['1 declared thing is not running live.', '1 more thing runs live that the repository does not declare.']]);
  const onlyDrifted = keep(nextActionModel({ still: still({ run: withDrift({ declaredNotLive: 0, drifted: 1, liveNotDeclared: 0 }) }), grade: liveGrade, decision, run: withDrift({ declaredNotLive: 0, drifted: 1, liveNotDeclared: 0 }), journey }));
  assert.equal(onlyDrifted.sentence, 'Fix the 1 thing the live side does differently.');
  // Unchanged: nothing to do; the still-true panel's Check again is the primary instead.
  const n2 = keep(nextActionModel({ still: still({ run: unchangedRun }), grade: liveGrade, decision, run: unchangedRun, journey }));
  assert.deepEqual(n2, { sentence: 'Nothing to do right now: live matches what the repository declares.', button: null, why: [], primary: false });
  assert.equal(still({ run: unchangedRun }).checkPrimary, true);
  // Unreachable: a live journey is checked again; a recording is a matter for Expert mode.
  const lost = keep(nextActionModel({ still: still({ run: lostRun }), grade: packGrade, decision, run: lostRun, journey }));
  assert.deepEqual(lost, { sentence: 'Check again once the live side answers; until then nothing is known.', button: { label: 'Check again', action: 'ov-check' }, why: ['The live side did not answer the last check.'], primary: true });
  const lostFile = keep(nextActionModel({ still: still({ journey: fileJourney, run: lostRun }), grade: packGrade, decision, run: lostRun, journey: fileJourney }));
  assert.deepEqual(lostFile, { sentence: 'The recording could not be read; open Expert mode to look.', button: { label: 'Open Expert mode', action: 'ov-expert' }, why: [], primary: true });
  // Stale, live: Check now, whatever the last run said; the why names the freshness rule.
  for (const r of [run, unchangedRun]) {
    const stale = keep(nextActionModel({ still: still({ run: r, now: STALE_NOW }), grade: liveGrade, decision, run: r, journey }));
    assert.deepEqual([stale.sentence, stale.button, stale.primary, stale.why.length], ['Check it against live now.', { label: 'Check now', action: 'ov-check' }, true, 1]);
    assert.match(stale.why[0], /^The last check is .+ old; readings older than a day are not trusted\.$/);
  }
  // Stale, a recording: nothing can be checked from here — Changed still points at the differences, Unchanged says nothing.
  assert.equal(keep(nextActionModel({ still: still({ journey: fileJourney, run, now: STALE_NOW }), grade: liveGrade, decision, run, journey: fileJourney })).button.label, 'See the differences');
  assert.deepEqual(keep(nextActionModel({ still: still({ journey: fileJourney, run: unchangedRun, now: STALE_NOW }), grade: liveGrade, decision, run: unchangedRun, journey: fileJourney })).button, null);
  // No pack, or an unreadable one: Expert mode, before anything else is weighed.
  const expert = { sentence: 'Open Expert mode to register or repair the pack.', button: { label: 'Open Expert mode', action: 'ov-expert' }, why: [], primary: true };
  assert.deepEqual(keep(nextActionModel({ still: still(), grade: gradeModel({ pack: null, how: 'none' }), decision, run, journey })), expert);
  assert.deepEqual(keep(nextActionModel({ still: still(), grade: gradeModel({ pack: packs[1], how: 'aggregate' }), decision, run, journey })), expert);
  assert.deepEqual(keep(nextActionModel({ still: still(), grade: gradeModel({ pack: krystalinePack, how: 'primary', diagnosticError: 'bad yaml' }), decision, run, journey })), expert);
  // Nothing is known about the live side, or it is still being read: nothing is said.
  const nothing = { sentence: '', button: null, why: [], primary: false };
  assert.deepEqual(keep(nextActionModel({ still: still({ pending: true }), grade: liveGrade, decision, run, journey })), nothing);
  assert.deepEqual(keep(nextActionModel({ still: null, grade: liveGrade, decision, run, journey })), nothing);
  assert.deepEqual(keep(nextActionModel({ still: still({ journeysError: '500: boom' }), grade: liveGrade, decision, run, journey })), nothing);
  assert.deepEqual(keep(nextActionModel()), nothing);
  // A pending grade (still reading) does not block the live answer.
  assert.equal(keep(nextActionModel({ still: still(), grade: gradeModel({ pack: krystalinePack, how: 'primary' }), decision, run, journey })).button.label, 'See the differences');
});

// ---------- the whole screen ----------

test('buildOverviewModel: the real screen end to end — krystaline on prod, graded B against live, Changed, one primary (See the differences); Unchanged hands the primary to Check again; the member-only rows; nothing / unreadable / loading', () => {
  const m = keep(screen());
  assert.equal(m.kind, 'service');
  assert.equal(m.error, null);
  assert.deepEqual(m.options, [{ id: 1, name: 'krystaline', selected: true }, { id: 2, name: 'kx-exchange', selected: false }, { id: 3, name: 'kx-matcher', selected: false }, { id: 4, name: 'kx-wallet', selected: false }]);
  assert.deepEqual(m.service, { id: 1, name: 'krystaline', slug: 'krystaline' });
  assert.deepEqual([m.envs, m.env], [[{ name: 'prod', selected: true }], 'prod']);
  assert.deepEqual(m.journey, { name: 'krystaline', live: true });
  assert.deepEqual([m.grade.letter, m.grade.label, m.grade.source, m.grade.basis], ['B', 'Industrial grade', 'Graded against live, 2 hours ago.', 'live']);
  assert.deepEqual([m.still.status, m.still.pill, m.still.sentence], ['changed', 'Changed', 'Checked 2 hours ago against live — 43 things differ from what the repository declares.']);
  assert.deepEqual([m.next.sentence, m.next.button.label, m.next.button.action], ['Fix the 43 things the live side does differently.', 'See the differences', 'ov-next-neuron']);
  assert.equal(m.primary, 'next');
  assert.equal(m.productName, '');
  // Nothing differs: the still-true panel's Check again is the one primary.
  const ok = keep(screen({ run: unchangedRun }));
  assert.deepEqual([ok.still.status, ok.still.checkPrimary, ok.next.button, ok.primary], ['unchanged', true, null, 'check']);
  // The remembered env is not one of the row's: the first; a remembered row that is gone: the first row.
  assert.deepEqual([keep(screen({ env: 'staging' })).env, keep(screen({ serviceId: 42 })).service.id], ['prod', 1]);
  // The run is only this service's through its journey: with no journey the run is ignored (the pack-alone grade, Never checked).
  const noJourney = keep(screen({ journeys: [] }));
  assert.deepEqual([noJourney.journey, noJourney.grade.letter, noJourney.grade.basis, noJourney.still.status, noJourney.next.button.label, noJourney.primary], [null, 'C', 'repository', 'never', 'See what to fix', 'next']);
  assert.deepEqual(noJourney.next.why, ['Nothing live has been checked', 'Not every signal type is declared', 'Whole layers are unobserved']);
  // A member-only row: no pack of its own, no journey, Expert mode is the one thing to do.
  const kx = keep(screen({ serviceId: 2 }));
  assert.deepEqual([kx.service.slug, kx.options.find((o) => o.selected).id, kx.journey, kx.grade.label, kx.still.status, kx.next.button.label, kx.primary], ['kx-exchange', 2, null, 'No pack of its own', 'never', 'Open Expert mode', 'next']);
  // Running: the still-true panel says so; the listing unreadable: nothing claimed, Retry.
  const running = keep(screen({ running: true }));
  assert.deepEqual([running.still.sentence, running.still.checkLabel], ['Checking against live now…', 'Checking…']);
  const unread = keep(screen({ journeysError: '500: boom', run: null }));
  assert.deepEqual([unread.still.retry, unread.still.sentence, unread.next.button, unread.primary], [true, 'Whether it was ever checked could not be read: 500: boom', null, null]);
  // Still reading the facts: the grade reads "Reading…" whatever was passed, the still-true panel too, nothing to do, no primary.
  const pending = keep(screen({ pending: true, diagnosticError: 'ignored while pending' }));
  assert.deepEqual([pending.grade.letter, pending.grade.label, pending.grade.basis, pending.still.sentence, pending.still.pending, pending.next.button, pending.primary], ['·', 'Reading…', 'pending', 'Reading…', true, null, null]);
  assert.equal(keep(screen({ pending: true, serviceId: 2 })).next.button.label, 'Open Expert mode', 'no pack of its own is known from the catalogue alone: Expert mode, pending or not');
  // No service to show: the table empty, unreadable, or not yet read. No panel is built.
  const blank = { options: [], service: null, envs: [], env: null, grade: null, still: null, next: null, productName: '', primary: null };
  assert.deepEqual(keep(buildOverviewModel({ services: null, servicesStatus: { kind: 'error', error: '503: down' }, catalog: packs })), { kind: 'error', error: '503: down', ...blank });
  assert.deepEqual(keep(buildOverviewModel({ services: null, servicesStatus: { kind: 'error', error: null } })), { kind: 'error', error: 'the services table could not be read', ...blank });
  assert.deepEqual(keep(buildOverviewModel({ services: [], servicesStatus: { kind: 'ok', error: null }, catalog: packs })), { kind: 'empty', error: null, ...blank });
  assert.deepEqual(keep(buildOverviewModel({ services: null, servicesStatus: { kind: 'loading', error: null } })), { kind: 'loading', error: null, ...blank });
  assert.equal(keep(buildOverviewModel({})).kind, 'empty', 'no status at all reads as empty, never as an error');
  assert.equal(keep(buildOverviewModel({ services: null, servicesStatus: { kind: 'static', error: null } })).kind, 'error', 'any status but ok/loading with no rows is unreadable');
});

// ---------- the vocabulary ----------

const stringsOf = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsOf(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => stringsOf(v, out));
  return out;
};

test('vocabulary: no string of any model built above carries a percentage, a layer code, an artefact id, engine jargon or the product name', () => {
  assert.ok(builtModels.length >= 60, `the guard saw ${builtModels.length} models`);
  const all = stringsOf(builtModels);
  assert.ok(all.length >= 200, `the guard saw ${all.length} strings`);
  const banned = [
    ['%', (s) => s.includes('%')],
    ['a layer code', (s) => /\bL[1-5]\b|\bL2X\b|\bGOV\b/.test(s)],
    ['an artefact id', (s) => /uploaded-|\b[0-9a-f]{8}\b/.test(s)],
    ['"scaffold"', (s) => /scaffold/i.test(s)],
    ['"declared only"', (s) => /declared only/i.test(s)],
    ['"candidate"', (s) => /candidate/i.test(s)],
    ['"recorded live"', (s) => /recorded live/i.test(s)],
    ['the product name', (s) => /Observogram/.test(s)],
  ];
  for (const [what, hit] of banned) {
    const offenders = all.filter(hit);
    assert.deepEqual(offenders, [], `${what} reaches the screen: ${JSON.stringify(offenders)}`);
  }
  // The four status words, and only those, ever reach the pill.
  const pills = new Set(builtModels.map((m) => m?.pill ?? m?.still?.pill).filter(Boolean));
  assert.deepEqual([...pills].sort(), ['Changed', 'Never checked', 'Unchanged', 'Unreachable']);
});

// ---------- one primary across the screen ----------

// Every state the screen can be in, through buildOverviewModel. The states allowed to have no
// primary are those where nothing can be done from here: Unchanged against a recording (fresh or
// stale — only a live journey can be checked again), the journeys listing unreadable (Retry is a
// secondary button), the facts still being read (pending), and the screens without panels (loading /
// empty / unreadable services, whose buttons are the empty state's secondaries). While a check is running the screen may offer one
// primary (the last run's differences) or none (Unchanged): the Check button is busy either way.
const STATES = {
  'never, no journey': { journeys: [] },
  'never, no journey, grade pending': { journeys: [], diagnostic: null },
  'journey, no run (live)': { run: null },
  'journey, no run (recording)': { journeys: [fileJourney], run: null },
  changed: {},
  'changed (recording)': { journeys: [fileJourney] },
  unchanged: { run: unchangedRun },
  'unchanged (recording)': { journeys: [fileJourney], run: unchangedRun },
  unreachable: { run: lostRun },
  'unreachable (recording)': { journeys: [fileJourney], run: lostRun },
  'stale changed': { now: STALE_NOW },
  'stale unchanged': { run: unchangedRun, now: STALE_NOW },
  'stale changed (recording)': { journeys: [fileJourney], now: STALE_NOW },
  'stale unchanged (recording)': { journeys: [fileJourney], run: unchangedRun, now: STALE_NOW },
  'running, no run': { run: null, running: true },
  'running, changed': { running: true },
  'running, unchanged': { run: unchangedRun, running: true },
  'running, unreachable': { run: lostRun, running: true },
  'no pack of its own': { serviceId: 2 },
  'no pack': { services: [{ ...KRYSTALINE, packs: [] }] },
  'grade error': { diagnosticError: 'bad yaml', journeys: [] },
  'start error': { startError: '502: gateway' },
  'journeys error': { journeysError: '500: boom', run: null },
  pending: { pending: true },
  'pending, no pack of its own': { pending: true, serviceId: 2 },
  loading: { services: null, servicesStatus: { kind: 'loading', error: null } },
  empty: { services: [] },
  'services error': { services: null, servicesStatus: { kind: 'error', error: '503: down' } },
};
const NONE_ALLOWED = new Set(['unchanged (recording)', 'stale unchanged (recording)', 'journeys error', 'pending', 'loading', 'empty', 'services error']);
const EITHER = new Set(['running, no run', 'running, changed', 'running, unchanged', 'running, unreachable']);
const primariesOf = (m) => (m.primary === 'next' && m.next?.button ? 1 : 0) + (m.primary === 'check' && m.still?.checkPrimary ? 1 : 0);

test('one primary across the screen: every state has exactly one primary button, or none where nothing can be done from here', () => {
  for (const [name, over] of Object.entries(STATES)) {
    const m = screen(over);
    const n = primariesOf(m);
    assert.ok(n <= 1, `${name}: ${n} primaries`);
    if (NONE_ALLOWED.has(name)) assert.equal(n, 0, `${name}: expected no primary, got ${m.primary}`);
    else if (!EITHER.has(name)) assert.equal(n, 1, `${name}: expected one primary, got none (primary=${m.primary}, next.button=${JSON.stringify(m.next?.button)}, still.checkPrimary=${m.still?.checkPrimary})`);
    // The model's `primary` never names a button that is not there.
    if (m.primary === 'next') assert.ok(m.next.button && m.next.primary, `${name}: primary says next, but next has no primary button`);
    if (m.primary === 'check') assert.ok(m.still.checkPrimary && m.still.canCheck, `${name}: primary says check, but the panel offers none`);
  }
});

// ---------- the renderer, headless ----------

// A container the renderer can draw into without a DOM: innerHTML as a string, the click listener
// wireUxActions attaches, a stub for the service <select>. A click is fired with a fake event whose
// target "closes" to an element carrying data-ux-action.
function overviewContainer() {
  let html = '';
  const listeners = {};
  const select = { value: '', listeners: {}, dataset: {}, addEventListener(t, fn) { this.listeners[t] = fn; }, fire(t) { this.listeners[t]?.(); } };
  return {
    get innerHTML() { return html; },
    set innerHTML(v) { html = v; },
    dataset: {},
    addEventListener: (t, fn) => { listeners[t] = fn; },
    contains: () => true,
    querySelector: (sel) => (sel === '#ov-service' && /id="ov-service"/.test(html) ? select : null),
    querySelectorAll: () => [],
    select,
    click(uxAction, dataset = {}) {
      let prevented = false;
      listeners.click?.({ target: { closest: () => ({ dataset: { uxAction, ...dataset } }) }, preventDefault: () => { prevented = true; } });
      return prevented;
    },
  };
}
const countOf = (html, needle) => (html.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

test('renderOverview: the four pieces, one primary button, the sentences as the model says them, escaped at the seam; the actions proxied to host.overview; a headless host never throws', () => {
  const c = overviewContainer();
  const calls = [];
  const host = { overview: {
    selectService: (id) => calls.push(['service', id]), selectEnv: (name) => calls.push(['env', name]), checkNow: () => calls.push(['check']),
    openDiagnose: () => calls.push(['diagnose']), openNeuron: () => calls.push(['neuron']), expert: () => calls.push(['expert']), retry: () => calls.push(['retry']),
  } };
  renderOverview(c, screen(), host);
  const html = c.innerHTML;
  assert.ok(html.startsWith('<div class="ov-page">'), 'the zone');
  for (const piece of ['class="og-input ov-service"', 'class="ov-grade og-panel', 'class="ov-live og-panel', 'class="ov-next og-panel']) assert.ok(html.includes(piece), `the piece ${piece}`);
  assert.ok(html.includes('<select class="og-input ov-service" id="ov-service" aria-label="Service">') && html.includes('<option value="1" selected>krystaline</option>') && html.includes('<option value="2">kx-exchange</option>'));
  assert.ok(html.includes('<span class="og-pill ov-env-one">prod</span>') && !html.includes('ov-envs'), 'one environment: a pill, not a switch');
  assert.equal(countOf(html, 'og-btn--primary'), 1, 'exactly one primary button');
  assert.ok(html.includes('<button type="button" class="og-btn og-btn--primary ov-next__btn" data-ux-action="ov-next-neuron">See the differences</button>'));
  assert.ok(html.includes('<button type="button" class="og-btn ov-check" data-ux-action="ov-check">Check again</button>'), 'Check again is drawn, not primary');
  assert.ok(html.includes('aria-label="Grade B">B</div>') && html.includes('<div class="ov-grade__label og-h1">Industrial grade</div>') && html.includes('<div class="ov-grade__word">Almost diagnostic-grade</div>') && html.includes('Graded against live, 2 hours ago.'));
  assert.ok(html.includes('title="B · Industrial Grade — Suitable for production, maintenance, process control, and routine professional use."'), 'the engine\'s label and blurb live in the hover');
  assert.ok(html.includes('<span class="og-pill og-pill--warn ov-live__pill">Changed</span>'));
  assert.ok(html.includes('<p class="ov-live__sentence">Checked 2 hours ago against live — 43 things differ from what the repository declares.</p>'));
  assert.ok(html.includes('<p class="ov-live__cadence og-muted">Checks run only when you click.</p>'));
  assert.ok(html.includes('<p class="ov-next__sentence">Fix the 43 things the live side does differently.</p>'));
  assert.ok(html.includes('<details class="ux-disclosure ov-next__why"><summary>Why</summary>') && html.includes('<li>38 declared things are not running live.</li><li>5 things run differently live than declared.</li><li>30 more things run live that the repository does not declare.</li>'), 'the why is a closed disclosure');
  assert.ok(html.includes('<span class="ux-term" tabindex="0" title="Diagnostic grade: ') && html.includes('>How well is it observed?</span>'), 'the grade eyebrow carries the formal term on hover');
  assert.ok(!html.includes('ov-live__error'), 'no start error: no callout');
  // The wiring: every action reaches host.overview; the select's change reads the id as a number.
  assert.equal(c.click('ov-check'), true, 'a handled click is prevented');
  c.click('ov-next-neuron'); c.click('ov-next-diagnose'); c.click('ov-expert'); c.click('ov-retry'); c.click('ov-env', { env: 'staging' });
  assert.equal(c.click('ov-unknown'), false, 'an unknown action is left alone');
  c.select.value = '2'; c.select.fire('change');
  assert.deepEqual(calls, [['check'], ['neuron'], ['diagnose'], ['expert'], ['retry'], ['env', 'staging'], ['service', 2]]);
  // A headless host: nothing throws, on render or on click.
  const c2 = overviewContainer();
  assert.doesNotThrow(() => renderOverview(c2, screen(), { overview: {} }));
  assert.doesNotThrow(() => { c2.click('ov-check'); c2.select.value = '3'; c2.select.fire('change'); });
  assert.doesNotThrow(() => renderOverview(overviewContainer(), screen(), {}), 'no overview on the host at all');
});

test('renderOverview: a hostile service name is escaped; running is aria-busy; the unreachable sentence wraps "live side" in the vantage term; the start error callout; several environments as a switch', () => {
  // The name of a service, and the error text, are escaped at the seam.
  const hostile = services.map((s) => (s.id === 1 ? { ...s, name: '<img onerror=x>' } : s));
  const c = overviewContainer();
  renderOverview(c, screen({ services: hostile, startError: '<script>alert(1)</script>' }), { overview: {} });
  assert.ok(c.innerHTML.includes('&lt;img onerror=x&gt;') && !c.innerHTML.includes('<img'), 'nothing from the name reaches the page');
  assert.ok(c.innerHTML.includes('<div class="og-callout og-callout--warn ov-live__error" role="status">The check could not start: &lt;script&gt;alert(1)&lt;/script&gt;</div>') && !c.innerHTML.includes('<script>'));
  // Running: the Check button is busy and disabled; still one primary at most.
  const r = overviewContainer();
  renderOverview(r, screen({ run: unchangedRun, running: true }), { overview: {} });
  assert.ok(r.innerHTML.includes('<button type="button" class="og-btn ov-check" data-ux-action="ov-check" aria-busy="true" disabled>Checking…</button>'));
  assert.ok(r.innerHTML.includes('<p class="ov-live__sentence">Checking against live now…</p>'));
  assert.equal(countOf(r.innerHTML, 'og-btn--primary'), 0, 'Unchanged while running: nothing to press');
  // Unreachable: "live side" is the vantage term; the rest of the sentence is escaped text around it.
  const u = overviewContainer();
  renderOverview(u, screen({ run: lostRun }), { overview: {} });
  assert.ok(u.innerHTML.includes('<p class="ov-live__sentence">Last check 2 hours ago: the <span class="ux-term" tabindex="0" title="Vantage point: The probe or MCP endpoint a Neuron journey uses to see the platform. When it is lost the check cannot observe, which is different from the check failing.">live side</span> did not answer, so nothing is known about it right now.</p>'));
  assert.ok(u.innerHTML.includes('<span class="og-pill og-pill--warn ov-live__pill">Unreachable</span>'));
  assert.ok(!u.innerHTML.includes(' ov-check"'), 'no Check button in the still-true panel until the live side answers — the next panel offers Check again');
  assert.ok(u.innerHTML.includes('og-btn og-btn--primary ov-next__btn" data-ux-action="ov-check">Check again</button>'));
  assert.equal(countOf(u.innerHTML, 'og-btn--primary'), 1);
  // Unchanged: the still-true panel's Check again is the one primary; the next panel has a sentence and no button.
  const ok = overviewContainer();
  renderOverview(ok, screen({ run: unchangedRun }), { overview: {} });
  assert.ok(ok.innerHTML.includes('<button type="button" class="og-btn og-btn--primary ov-check" data-ux-action="ov-check">Check again</button>'));
  assert.ok(ok.innerHTML.includes('<p class="ov-next__sentence">Nothing to do right now: live matches what the repository declares.</p>') && !ok.innerHTML.includes('ov-next__btn'));
  assert.equal(countOf(ok.innerHTML, 'og-btn--primary'), 1);
  // Several environments: a switch with the selected one pressed; the selection reaches selectEnv.
  const envs = overviewContainer();
  const envCalls = [];
  const twoEnvs = services.map((s) => (s.id === 1 ? { ...s, environments: [...s.environments, { ...s.environments[0], id: 9, name: 'staging' }] } : s));
  renderOverview(envs, screen({ services: twoEnvs, env: 'staging' }), { overview: { selectEnv: (n) => envCalls.push(n) } });
  assert.ok(envs.innerHTML.includes('<div class="og-seg ov-envs" role="group" aria-label="Environment">'));
  assert.ok(envs.innerHTML.includes('data-env="prod" aria-pressed="false">prod</button>') && envs.innerHTML.includes('data-env="staging" aria-pressed="true">staging</button>'));
  envs.click('ov-env', { env: 'prod' });
  assert.deepEqual(envCalls, ['prod']);
  // The journeys listing unreadable: the Retry button, no primary, no next panel.
  const unread = overviewContainer();
  renderOverview(unread, screen({ journeysError: '500: boom', run: null }), { overview: {} });
  assert.ok(unread.innerHTML.includes('<button type="button" class="og-btn ov-retry" data-ux-action="ov-retry">Retry</button>'));
  assert.ok(unread.innerHTML.includes('Whether it was ever checked could not be read: 500: boom') && !unread.innerHTML.includes('ov-next') && !unread.innerHTML.includes('ov-live__pill'));
  assert.equal(countOf(unread.innerHTML, 'og-btn--primary'), 0);
});

test('renderOverview: empty, error and loading render without throwing and without the panels; the markup\'s primary count agrees with the model in every state', () => {
  const empty = overviewContainer();
  assert.doesNotThrow(() => renderOverview(empty, buildOverviewModel({ services: [], servicesStatus: { kind: 'ok', error: null } }), { overview: {} }));
  assert.ok(empty.innerHTML.includes('<p class="ux-empty-title">No service to show yet.</p>') && empty.innerHTML.includes('A service appears here once a pack that names it is registered.'));
  assert.ok(empty.innerHTML.includes('data-ux-action="ov-expert">Open Expert mode</button>') && !empty.innerHTML.includes('ov-grade') && !empty.innerHTML.includes('id="ov-service"'));
  const error = overviewContainer();
  assert.doesNotThrow(() => renderOverview(error, buildOverviewModel({ services: null, servicesStatus: { kind: 'error', error: '503: <down>' } }), { overview: {} }));
  assert.ok(error.innerHTML.includes('<div class="ux-empty ux-tone-warn" role="note">') && error.innerHTML.includes('<p class="ux-empty-title">The services could not be read.</p>'));
  assert.ok(error.innerHTML.includes('<span class="ux-empty-key">Checked:</span> 503: &lt;down&gt;</p>'), 'the refusal, escaped');
  assert.ok(error.innerHTML.includes('data-ux-action="ov-retry">Retry</button>') && error.innerHTML.includes('data-ux-action="ov-expert">Open Expert mode</button>'));
  const loading = overviewContainer();
  assert.doesNotThrow(() => renderOverview(loading, buildOverviewModel({ services: null, servicesStatus: { kind: 'loading', error: null } }), { overview: {} }));
  assert.ok(loading.innerHTML.includes('<p class="ov-loading og-muted" role="status">Reading the services…</p>'));
  for (const c of [empty, error, loading]) assert.equal(countOf(c.innerHTML, 'og-btn--primary'), 0);
  // Every state of the matrix: at most one primary in the markup, and as many as the model says.
  for (const [name, over] of Object.entries(STATES)) {
    const m = screen(over);
    const c = overviewContainer();
    assert.doesNotThrow(() => renderOverview(c, m, { overview: {} }), name);
    assert.equal(countOf(c.innerHTML, 'og-btn--primary'), primariesOf(m), `${name}: the markup's primaries`);
    assert.ok(!/<(img|script)\b/.test(c.innerHTML), `${name}: no raw markup from data`);
  }
});

// ---------- the defects the first pass over the model found, now ordinary tests ----------

test('the stale why item is timed from the model\'s now, never the wall clock', () => {
  const stale = nextActionModel({ still: still({ now: STALE_NOW }), grade: liveGrade, decision, run, journey, now: STALE_NOW });
  assert.deepEqual(stale.why, ['The last check is 1 day old; readings older than a day are not trusted.']);
});

test('verdictWordFor: a missing score (null, empty) yields no word', () => {
  assert.deepEqual([verdictWordFor(null), verdictWordFor('')], ['', '']);
});

test('stillTrueModel: one thing that differs reads "1 thing differs from"', () => {
  assert.equal(stillTrueModel({ journey, run: withDrift({ declaredNotLive: 1, drifted: 0 }), now: NOW }).sentence, 'Checked 2 hours ago against live — 1 thing differs from what the repository declares.');
});

test('while a check is running, the next panel offers no second Check beside the busy one', () => {
  for (const over of [{ run: null, running: true }, { run: lostRun, running: true }]) {
    const m = screen(over);
    assert.notEqual(m.next.button?.action, 'ov-check', `running with ${over.run ? 'an unreachable last run' : 'no run'}: a second Check is offered (${JSON.stringify(m.next.button)})`);
  }
});
