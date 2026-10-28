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
  shortGradeLabel, verdictWordFor, runGradedPack, differenceCount, vantageShrank,
  gradeModel, gradeWhy, stillTrueModel, nextActionModel, buildOverviewModel,
  layersModel, compositionOf, rulesModel, fidelityModel, changesModel, decideOverviewLayout, OVERVIEW_LAYOUT_KEY, OVERVIEW_LAYOUTS,
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
// The same diagnostic with the engine's criteria (grade schema 2), as computeDiagnosticGrade writes them for the demo pack alone.
const diagnosticFull = {
  ...diagnostic, gradeSchema: 2,
  coverage: { criteria: [
    { key: 'multi-modal', label: 'Multi-modal', pass: true, detail: '3 of 4 signals declared as backends (metrics, traces, logs)' },
    { key: 'correlated', label: 'Correlated', pass: true, detail: 'tracecontext propagator declared' },
    { key: 'calibrated', label: 'Calibrated', pass: true, detail: 'MTTD/MTTR baselines + 18 SLOs with explicit objective' },
    { key: 'comprehensive', label: 'Comprehensive', pass: false, detail: '35% average observed across infra · platform · app · ux' },
  ] },
  trust: { criteria: [
    { key: 'chaos-validated', label: 'Chaos-validated', pass: false, detail: 'no chaos experiments - recovery procedures are theoretical' },
    { key: 'drift-free', label: 'Drift-free', pass: false, score: 0, detail: 'declared-only - no live signal to verify against (connect MCP or scan live)' },
    { key: 'fresh', label: 'Fresh', pass: false, detail: 'no mcp.refreshedAt annotation - pack has never been verified against live state' },
  ] },
};

// Derived runs: nothing differs; the live side did not answer.
const withDrift = (over) => ({ ...run, drift: { ...run.drift, ...over } });
const unchangedRun = withDrift({ declaredNotLive: 0, drifted: 0, liveNotDeclared: 0 });
const lostRun = { ...run, outcome: 'vantage-lost' };
// The record the night before the first demo: the stack behind the MCP was restarting, the metric names
// probe newly failed, and the engine read C · 30 % alignment · 86 declared-not-live — a smaller live picture.
const partialRun = fixture('krystaline-run-partial');
// The same journey reading a recording as Pack B (a file path, not "mcp: …").
const fileJourney = { ...journey, packB: 'C:/demo/.observogram-demo/journeys/krystaline/live/2026-10-07T12-00-00-000Z.json' };

// buildOverviewModel's input for the real screen: krystaline on prod, +2h after the run.
const screen = (over = {}) => buildOverviewModel({
  services, servicesStatus: { kind: 'ok', error: null }, catalog: packs, serviceId: 1, env: 'prod', isLiveAggregatePack,
  diagnostic, decision, journeys, run, now: NOW, layout: 'simple', ...over,
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
    basis: 'live', why: [], points: '',
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
    source: 'Graded from the repository alone.', tone: 'warn', title: 'C · Field Grade — …', basis: 'repository', why: [], points: '',
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
  const noPack = { letter: '–', label: 'No pack yet', word: 'Nothing to grade: no pack is registered for this service.', source: '', tone: 'neutral', title: '', basis: 'none', why: [], points: '' };
  assert.deepEqual(keep(gradeModel({ pack: null, how: 'none', diagnostic, run, journey, now: NOW })), noPack);
  assert.deepEqual(keep(gradeModel({ pack: krystalinePack, how: 'none', diagnostic, run, journey, now: NOW })), noPack, 'how says none: the pack is not this service\'s');
  assert.deepEqual(keep(gradeModel()), noPack);
  assert.deepEqual(keep(gradeModel({ pack: packs[1], how: 'aggregate', diagnostic, run, journey, now: NOW })), {
    letter: '–', label: 'No pack of its own', word: 'This service appears in a live draft, but no pack of its own is registered yet.', source: '', tone: 'neutral', title: '', basis: 'none', why: [], points: '',
  });
  // Unreadable, and not yet read.
  assert.deepEqual(keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnosticError: 'the pack file is not valid YAML', now: NOW })), {
    letter: '?', label: 'Not graded', word: 'The pack could not be read: the pack file is not valid YAML', source: '', tone: 'neutral', title: '', basis: 'error', why: [], points: '',
  });
  assert.deepEqual(keep(gradeModel({ pack: krystalinePack, how: 'primary', now: NOW })), { letter: '·', label: 'Reading…', word: '', source: '', tone: 'neutral', title: '', basis: 'pending', why: [], points: '' });
  assert.equal(keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: {}, now: NOW })).basis, 'pending', 'a diagnostic without overall is not read yet');
  assert.equal(keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic, diagnosticError: 'x', run, journey, now: NOW })).basis, 'live', 'a usable run outranks a read error of the pack alone');
});

test('gradeWhy: the seven criteria in plain words behind the letter — against live, from the repository alone, against a recording; the points line names the next band; nothing when the list would not add up to the letter', () => {
  const has = [
    ['yes', '3 of 4 kinds of signal are collected: metrics, traces, logs.'],
    ['yes', 'Traces and logs can be joined, so one request can be followed end to end.'],
    ['yes', 'Normal is defined with numbers: 18 objectives, with detection and repair baselines.'],
  ];
  const lacks = [
    ['no', 'Coverage reaches only 35 in 100 across infrastructure, platform, application and user experience.'],
    ['no', 'Recovery has never been proven by fault injection.'],
  ];
  const rows = (why) => why.map((w) => [w.ok, w.text]);
  // Against live: the yeses first, the partly, then the noes; the points line says how far B+ is.
  const live = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: diagnosticFull, run, journey, now: NOW }));
  assert.deepEqual(rows(live.why), [...has, ['yes', 'Checked against live 2 hours ago.'], ['partly', 'Of what the repository promises, 84 in 100 holds up live; the bar is 85.'], ...lacks]);
  assert.equal(live.points, '4.8 of 7 points. B+ starts at 5.3.');
  // The repository alone: the two live criteria say so, and score nothing.
  const alone = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: diagnosticFull, run: null, now: NOW }));
  assert.deepEqual(rows(alone.why), [...has, ...lacks, ['no', 'Nothing live has been checked, so no promise is confirmed live.'], ['no', 'Never checked against live.']]);
  assert.equal(alone.points, '3 of 7 points. B starts at 4.4.');
  // Against a recording: the words say so.
  const recorded = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: diagnosticFull, run, journey: fileJourney, now: NOW }));
  assert.deepEqual(rows(recorded.why).slice(3, 5), [['yes', 'Checked against a live recording 2 hours ago.'], ['partly', 'Of what the repository promises, 84 in 100 holds up in the recording; the bar is 85.']]);
  // A live picture older than a day when it was read: Fresh says no, with the letter that goes with it.
  const stale = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: diagnosticFull, run: { ...run, freshness: { liveAgeHours: 30 }, grade: { ...run.grade, score: 55, letter: 'C', letterLabel: 'Field Grade' } }, journey, now: NOW }));
  assert.deepEqual([stale.letter, rows(stale.why).at(-1), stale.points], ['C', ['no', 'The live picture was more than a day old when it was checked.'], '3.8 of 7 points. B starts at 4.4.']);
  // Nothing when it would not add up: another grade schema, a score the lines do not reach, drift scored on another construct, a diagnostic without the criteria.
  for (const [what, over] of [['schema', { grade: { ...run.grade, schema: 1 } }], ['score', { grade: { ...run.grade, score: 30, letter: 'D', letterLabel: 'Consumer Grade' } }], ['construct', { grade: { ...run.grade, driftConstruct: 'diff-buckets' } }]]) {
    const m = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: diagnosticFull, run: { ...run, ...over }, journey, now: NOW }));
    assert.deepEqual([m.why, m.points], [[], ''], what);
  }
  assert.deepEqual(gradeWhy({ diagnostic, run, letter: 'B', score: 69, now: NOW }), { why: [], points: '' }, 'the minimal diagnostic carries no criteria');
  assert.equal(gradeWhy({ diagnostic: diagnosticFull, letter: 'C', score: 43 }).why.length, 7);
  // The top of the ladder names no next band.
  const allPass = (list) => list.map((c) => ({ ...c, pass: true }));
  const top = gradeWhy({
    diagnostic: { ...diagnosticFull, coverage: { criteria: allPass(diagnosticFull.coverage.criteria) }, trust: { criteria: allPass(diagnosticFull.trust.criteria) } },
    run: { ...run, traceability: { ...run.traceability, integrityPct: 100 }, grade: { ...run.grade, score: 100, letter: 'A+' } }, letter: 'A+', score: 100, now: NOW,
  });
  assert.deepEqual([top.points, top.why.every((w) => w.ok === 'yes')], ['7 of 7 points.', true]);
});

// ---------- is that still true right now? ----------

test('stillTrueModel: never checked (no journey; a journey without a run, with and without an env), the live wording and the Check button only for a live journey', () => {
  assert.deepEqual(OVERVIEW_STATUS, { never: 'Never checked', unchanged: 'Unchanged', changed: 'Changed', unreachable: 'Unreachable' });
  assert.equal(FRESH_WINDOW_MS, 24 * HOUR);
  // S0: no journey at all.
  const s0 = keep(stillTrueModel({ journey: null, run: null, now: NOW }));
  assert.deepEqual(s0, { status: 'never', pill: 'Never checked', sentence: 'Never checked against live.', note: '', cadence: '', stale: false, canCheck: false, checkLabel: '', checkPrimary: false, tone: 'info', error: null, pending: false, running: false, ago: '' });
  assert.deepEqual(keep(stillTrueModel()), s0);
  // S1: a journey, never run. The fixture's scope.env is null; with one the sentence names it.
  const s1 = keep(stillTrueModel({ journey, run: null, now: NOW }));
  assert.deepEqual(s1, { status: 'never', pill: 'Never checked', sentence: 'Never checked against live. A live check is set up.', note: '', cadence: 'Checks run only when you click.', stale: false, canCheck: false, checkLabel: '', checkPrimary: false, tone: 'info', error: null, pending: false, running: false, ago: '' });
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
    note: '', cadence: 'Checks run only when you click.', stale: false, canCheck: true, checkLabel: 'Check again', checkPrimary: false, tone: 'warn', error: null, pending: false, running: false, ago: '2 hours ago',
  });
  // The transition: 'first run' or no `since` says nothing; worse wins over changed; nothing changed says nothing.
  const since = (transition) => keep(stillTrueModel({ journey, run: { ...run, transition }, now: NOW })).sentence;
  assert.equal(since({ reason: 'first run', since: null, changed: [] }), 'Checked 2 hours ago against live — 43 things differ from what the repository declares.');
  assert.equal(since({ reason: null, since: '2026-10-27T18:48:29.174Z', changed: [{ direction: 'worse' }, { direction: 'better' }] }), 'Checked 2 hours ago against live — 43 things differ from what the repository declares. 1 got worse since the check before.');
  assert.equal(since({ reason: null, since: '2026-10-27T18:48:29.174Z', changed: [{ direction: 'better' }, { direction: 'same' }] }), 'Checked 2 hours ago against live — 43 things differ from what the repository declares. 2 changed since the check before.');
  // Every chain that moved moved back (the first good check after a half-blind one): recovered, not merely changed.
  assert.equal(since({ reason: null, since: '2026-10-27T18:48:29.174Z', changed: [{ direction: 'better' }, { direction: 'better' }] }), 'Checked 2 hours ago against live — 43 things differ from what the repository declares. 2 recovered since the check before.');
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
    note: '', cadence: 'Checks run only when you click.', stale: false, canCheck: true, checkLabel: 'Check again', checkPrimary: true, tone: 'ok', error: null, pending: false, running: false, ago: '2 hours ago',
  });
  assert.equal(keep(stillTrueModel({ journey, run: { ...unchangedRun, transition: { reason: null, since: '2026-10-27T18:48:29.174Z', changed: [{ direction: 'better' }] } }, now: NOW })).sentence,
    'Checked 2 hours ago against live — it matches: everything the repository declares is running live. 1 recovered since the check before.');
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
    note: '', cadence: 'Checks run only when you click.', stale: false, canCheck: false, checkLabel: '', checkPrimary: false, tone: 'warn', error: null, pending: false, running: false, ago: '2 hours ago',
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
  assert.deepEqual(running, { status: 'changed', pill: 'Changed', sentence: 'Checking against live now…', note: '', cadence: 'Checks run only when you click.', stale: false, canCheck: true, checkLabel: 'Checking…', checkPrimary: false, tone: 'info', error: null, pending: false, running: true, ago: '' });
  assert.deepEqual([keep(stillTrueModel({ journey, run: null, running: true })).status, keep(stillTrueModel({ journey, run: lostRun, running: true })).status, keep(stillTrueModel({ journey, run: unchangedRun, running: true })).pill], ['never', 'unreachable', 'Unchanged']);
  // The journeys listing could not be read: nothing is claimed, a Retry is offered.
  const unread = keep(stillTrueModel({ journey: null, run: null, now: NOW, journeysError: '500: boom' }));
  assert.deepEqual(unread, { status: null, pill: '', sentence: 'Whether it was ever checked could not be read: 500: boom', note: '', cadence: '', stale: false, canCheck: false, checkLabel: '', checkPrimary: false, tone: 'warn', error: null, pending: false, running: false, ago: '', retry: true });
  assert.equal(keep(stillTrueModel({ journey, run, now: NOW, journeysError: '500: boom', startError: '502: gateway' })).error, null, 'the listing error outranks a start error');
  // The facts are still being read: "Reading…", nothing claimed, no cadence, no button — whatever else is passed.
  const pending = keep(stillTrueModel({ journey, run, now: NOW, pending: true }));
  assert.deepEqual(pending, { status: null, pill: '', sentence: 'Reading…', note: '', cadence: '', stale: false, canCheck: false, checkLabel: '', checkPrimary: false, tone: 'neutral', error: null, pending: true, running: false, ago: '' });
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
  assert.deepEqual(m.options, [{ id: 1, name: 'krystaline', selected: true }], 'the picker lists the rows with a pack of their own; the member-only rows are Expert\'s');
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
  assert.deepEqual(kx.options, [{ id: 1, name: 'krystaline', selected: false }, { id: 2, name: 'kx-exchange', selected: true }], 'the remembered member-only row stays listed');
  assert.deepEqual(keep(screen({ catalog: [] })).options.map((o) => o.id), [1, 2, 3, 4], 'no row has a pack of its own: every row is listed');
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
  const blank = { options: [], service: null, envs: [], env: null, grade: null, still: null, next: null, productName: '', primary: null, layout: 'board', board: null };
  assert.deepEqual(keep(buildOverviewModel({ services: null, servicesStatus: { kind: 'error', error: '503: down' }, catalog: packs })), { kind: 'error', error: '503: down', ...blank });
  assert.deepEqual(keep(buildOverviewModel({ services: null, servicesStatus: { kind: 'error', error: null } })), { kind: 'error', error: 'the services table could not be read', ...blank });
  assert.deepEqual(keep(buildOverviewModel({ services: [], servicesStatus: { kind: 'ok', error: null }, catalog: packs })), { kind: 'empty', error: null, ...blank });
  assert.deepEqual(keep(buildOverviewModel({ services: null, servicesStatus: { kind: 'loading', error: null } })), { kind: 'loading', error: null, ...blank });
  assert.equal(keep(buildOverviewModel({})).kind, 'empty', 'no status at all reads as empty, never as an error');
  assert.equal(keep(buildOverviewModel({ services: null, servicesStatus: { kind: 'static', error: null } })).kind, 'error', 'any status but ok/loading with no rows is unreadable');
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
  'showed less than the check before': { run: partialRun },
  'showed less than the check before (recording)': { journeys: [fileJourney], run: partialRun },
  'running, showed less than the check before': { run: partialRun, running: true },
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
const EITHER = new Set(['running, no run', 'running, changed', 'running, unchanged', 'running, unreachable', 'running, showed less than the check before']);
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
  assert.ok(html.includes('<select class="og-input ov-service" id="ov-service" aria-label="Service">') && html.includes('<option value="1" selected>krystaline</option>') && !html.includes('kx-exchange'), 'the picker: the rows with a pack of their own');
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
  assert.ok(!html.includes('Why this grade'), 'the minimal diagnostic carries no criteria: no grade disclosure');
  // With the engine's criteria: Why this grade, closed — the points line, then a pill and a sentence per criterion; still one primary.
  const full = overviewContainer();
  renderOverview(full, screen({ diagnostic: diagnosticFull }), host);
  assert.ok(full.innerHTML.includes('<details class="ux-disclosure ov-grade__why"><summary>Why this grade</summary><div class="ux-disclosure-body"><p class="ov-grade__points og-muted">4.8 of 7 points. B+ starts at 5.3.</p><ul class="ov-gw-list"><li class="ov-gw ov-gw--yes"><span class="og-pill og-pill--ok ov-gw__pill">Yes</span><span class="ov-gw__text">3 of 4 kinds of signal are collected: metrics, traces, logs.</span></li>'), 'the grade disclosure');
  assert.ok(full.innerHTML.includes('<li class="ov-gw ov-gw--partly"><span class="og-pill og-pill--warn ov-gw__pill">Partly</span>') && full.innerHTML.includes('<li class="ov-gw ov-gw--no"><span class="og-pill og-pill--fail ov-gw__pill">No</span>'));
  assert.equal(countOf(full.innerHTML, 'og-btn--primary'), 1, 'still one primary');
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

test('a live side that showed less than the check before (a probe family newly failed): the sentence says so instead of a count, the grade falls back to the repository and says why, Check again is the one thing to do; a vantage that held or grew changes nothing', () => {
  const LATER = Date.parse(partialRun.startedAt) + 2 * HOUR;
  assert.deepEqual(vantageShrank(partialRun), ['metric_names']);
  assert.deepEqual([vantageShrank(run), vantageShrank(null), vantageShrank({ causes: { vantage: { changed: true, from: { failed: ['a', 'b'] }, to: { failed: ['a'] } } } })], [[], [], []], 'held, none, grew');
  // The first good check after an outage compares with a record that saw nothing: a recovery, not a shrink (dashboards has always been short).
  assert.deepEqual(vantageShrank({ causes: { vantage: { changed: true, from: { vantage: 'lost', failed: [], unsupported: [] }, to: { vantage: 'partial', failed: ['dashboards'], unsupported: [] } } } }), []);
  const g = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic, run: partialRun, journey, now: LATER }));
  assert.deepEqual([g.letter, g.basis, g.source], ['C', 'repository', 'Graded from the repository alone; the last live check saw only part of production.']);
  const s = keep(stillTrueModel({ journey, run: partialRun, now: LATER }));
  assert.deepEqual([s.status, s.pill, s.tone, s.sentence, s.canCheck, s.checkLabel, s.checkPrimary],
    ['changed', 'Changed', 'warn', 'Checked 2 hours ago against live — the live side showed less than the check before: its metric names could not be read, so what differs cannot be told yet.', true, 'Check again', false]);
  const n = keep(nextActionModel({ still: s, grade: g, run: partialRun, journey, now: LATER }));
  assert.deepEqual(n, { sentence: 'Check again: the live side answered only in part.', button: { label: 'Check again', action: 'ov-check' }, why: ['Its metric names could not be read this time.', 'What differs was counted against a smaller live picture.'], primary: true });
  const m = keep(screen({ run: partialRun, now: LATER }));
  assert.deepEqual([m.grade.letter, m.grade.basis, m.still.status, m.next.button.label, m.primary], ['C', 'repository', 'changed', 'Check again', 'next']);
  // Two families newly failed read as a list; a recording that answered in part sends to Expert.
  const two = { ...partialRun, causes: { vantage: { changed: true, from: { failed: [] }, to: { failed: ['dashboards', 'metric_names'] } } } };
  assert.ok(keep(stillTrueModel({ journey, run: two, now: LATER })).sentence.includes('its dashboards and metric names could not be read'));
  const rec = keep(nextActionModel({ still: keep(stillTrueModel({ journey: fileJourney, run: partialRun, now: LATER })), grade: g, run: partialRun, journey: fileJourney, now: LATER }));
  assert.deepEqual([rec.sentence, rec.button.label], ['The recording answered only in part; open Expert mode to look.', 'Open Expert mode']);
});

test('while a check is running, the next panel offers no second Check beside the busy one', () => {
  for (const over of [{ run: null, running: true }, { run: lostRun, running: true }]) {
    const m = screen(over);
    assert.notEqual(m.next.button?.action, 'ov-check', `running with ${over.run ? 'an unreachable last run' : 'no run'}: a second Check is offered (${JSON.stringify(m.next.button)})`);
  }
});

// ---------- the board ----------
//
// The same model, drawn as pictures: the stack (the posture matrix's cells as
// counts, tools/fixtures/overview/krystaline-posture.json, saved from the demo
// seed because the layered pack is 1.1 MB), the specification's rules (the
// real GET /api/packs/:id/conformance), the live fidelity and the delta (the
// real run). A layered stub stands in for the pack's own layers.

const posture = fixture('krystaline-posture');
const conformance = fixture('krystaline-conformance');
const layeredStub = {
  layers: {
    L1: Array.from({ length: 36 }, (_, i) => ({ id: `SLI-${i}` })), L2: Array.from({ length: 225 }, () => ({})), L2X: [{}], L3: Array.from({ length: 321 }, () => ({})),
    L4: { policy: Array.from({ length: 8 }, () => ({})), alerting: Array.from({ length: 7 }, () => ({})), healing: [] }, L5: [{}, {}], GOV: [],
  },
};
const board = (over = {}) => screen({ layout: 'board', cells: posture.cells, layered: layeredStub, conformance, ...over });

test('layersModel: the four layers top down with the ten kinds each, counts of distinct declared artefacts (a backend the matrix lists twice counts once, evidence not at all), the coverage average the engine reports, the unplaced, the composition with the extended layer folded in', () => {
  const L = keep(layersModel({ cells: posture.cells, layered: layeredStub }));
  assert.deepEqual(L.rows.map((r) => [r.key, r.name, r.covered, r.of, r.pct, r.tone, r.total]), [
    ['ux', 'User experience', 0, 10, 0, 'fail', 0], ['app', 'Application', 7, 10, 70, 'ok', 80], ['platform', 'Platform', 4, 10, 40, 'warn', 4], ['infra', 'Infrastructure', 3, 10, 30, 'warn', 7],
  ]);
  assert.deepEqual(L.rows[1].kinds.map((k) => k.key), ['sli', 'slo', 'metric', 'log', 'trace', 'dashboard', 'alert', 'runbook', 'chaos', 'synthetic'], 'the ten kinds, in drawing order');
  assert.deepEqual(L.rows[1].kinds.filter((k) => k.present).map((k) => k.label), ['17 indicators', '15 objectives', '37 metrics', '2 logs', '1 trace', '4 dashboards', '4 alerts']);
  assert.deepEqual(L.rows[1].kinds.filter((k) => !k.present).map((k) => k.label), ['no runbooks', 'no chaos tests', 'no synthetic checks']);
  assert.deepEqual([L.coveragePct, L.unplaced, L.declared], [35, 7, 600], 'the average of the four layers is the engine\'s "35% average observed"');
  assert.deepEqual(L.composition, [{ name: 'SLI/SLO', count: 36 }, { name: 'Metrics/Logs/Traces', count: 226 }, { name: 'Dashboards/Recording Rules', count: 321 }, { name: 'Alerts/Policy/Self-healing', count: 15 }, { name: 'Self-check', count: 2 }]);
  assert.deepEqual([L.lead, L.coverage, L.unplacedNote], ['600 things declared in the repository.', 'Coverage reaches 35 in 100 across the four layers.', '7 things could not be placed on a layer.']);
  // Cells as the matrix hands them (arrays of artefacts): distinct ids; evidence pseudo-artefacts skipped; an artefact without an id counts once.
  const cells = { 'app:trace': [{ id: 'BAK-03' }, { id: 'BAK-03' }, { id: 'scrape/x', title: 'x', _evidence: true }], 'app:metric': [{ id: 'QRY-1' }, {}, {}], 'unknown:alert': [{ id: 'POL-9' }] };
  const fromArrays = layersModel({ cells });
  assert.deepEqual(fromArrays.rows[1].kinds.filter((k) => k.present).map((k) => [k.key, k.count]), [['metric', 3], ['trace', 1]]);
  assert.deepEqual([fromArrays.unplaced, fromArrays.declared, fromArrays.lead, fromArrays.composition, fromArrays.unplacedNote], [1, 0, '', [], '1 thing could not be placed on a layer.']);
  assert.equal(layersModel({ cells: null }), null, 'no matrix, no stack');
  assert.deepEqual(compositionOf(null), []);
});

test('rulesModel, fidelityModel, changesModel: the required rules, the live fidelity with its four counts and the promises that hold, the three counts to change — withheld with the reason (never as zeros) when nothing live was seen whole', () => {
  assert.deepEqual(keep(rulesModel(conformance)), { passed: 12, total: 15, pct: 80, tier: '2', met: false, unknown: false, sentence: '12 of 15 required rules met for a tier 2 service.', tone: 'warn' });
  assert.deepEqual([rulesModel(null), rulesModel({ must: { passed: 0, total: 0 } })], [null, null]);
  assert.deepEqual([rulesModel({ must: { passed: 3, total: 3 }, conformant: true, declaredTier: 'tier-1' }).tone, rulesModel({ must: { passed: 1, total: 4 } }).sentence, rulesModel({ must: { passed: 1, total: 4 } }).tone], ['ok', '1 of 4 required rules met.', 'fail']);
  const f = keep(fidelityModel({ run, journey, pack: krystalinePack }));
  assert.deepEqual([f.known, f.alignmentPct, f.against, f.note], [true, 78, 'live', 'The live side answered only in part: its dashboards could not be read.']);
  assert.deepEqual(f.tiles.map((t) => [t.key, t.value, t.label, t.tone]), [['aligned', 252, 'match', 'ok'], ['drifted', 5, 'run differently', 'warn'], ['missing', 38, 'not running live', 'fail'], ['extra', 30, 'live only', 'info']]);
  assert.deepEqual(f.chains, { total: 18, intact: 5, partial: 1, broken: 12, integrityPct: 84, sentence: '5 of 18 promises hold end to end, 1 in part.' });
  assert.equal(keep(fidelityModel({ run: { ...run, probes: { failed: [] } }, journey, pack: krystalinePack })).note, '', 'every family answered: no note');
  assert.equal(keep(fidelityModel({ run: { ...run, traceability: { declaredTotal: 0 } }, journey, pack: krystalinePack })).chains, null, 'no declared chains: no promises line');
  // Withheld: never checked, a run of another pack, the live side lost, the live side shrunk — each with its reason and no counts.
  const never = keep(fidelityModel({}));
  assert.deepEqual([never.known, never.alignmentPct, never.tiles, never.chains, never.note], [false, null, [], null, 'Never checked against live.']);
  assert.equal(keep(fidelityModel({ run, journey, pack: { ...krystalinePack, id: 'other', name: 'v2' } })).known, false);
  assert.equal(keep(fidelityModel({ run: lostRun, journey, pack: krystalinePack })).note, 'The live side did not answer the last check, so nothing is known about it right now.');
  assert.equal(keep(fidelityModel({ run: partialRun, journey, pack: krystalinePack })).note, 'The live side showed less than the check before, so the counts cannot be compared yet.');
  assert.deepEqual([fidelityModel({ run, journey: fileJourney, pack: krystalinePack }).against, fidelityModel({ run: { ...run, packB: { source: '/rec.json' } }, pack: krystalinePack }).against], ['recording', 'recording']);
  const c = keep(changesModel({ fidelity: f }));
  assert.deepEqual(c.items.map((i) => [i.key, i.value, i.label, i.note, i.tone]), [
    ['add', 38, 'to add', 'declared in the repository, not running live', 'fail'], ['update', 5, 'to update', 'running live, but not as declared', 'warn'], ['review', 30, 'to review', 'running live, not in the repository', 'info'],
  ]);
  assert.deepEqual([c.known, c.total, c.sentence], [true, 73, '']);
  assert.deepEqual(keep(changesModel({ fidelity: never })), { known: false, items: [], total: 0, sentence: 'Check against live to count what to change.' });
  const none = keep(changesModel({ fidelity: fidelityModel({ run: unchangedRun, journey, pack: krystalinePack }) }));
  assert.deepEqual([none.total, none.sentence], [0, 'Nothing to change: live matches what the repository declares.']);
});

test('decideOverviewLayout: the query wins, then the saved preference, else the board; unknown values are ignored', () => {
  assert.deepEqual([decideOverviewLayout({ query: 'simple', saved: 'board' }), decideOverviewLayout({ saved: 'simple' }), decideOverviewLayout({}), decideOverviewLayout({ query: 'x', saved: 'y' })], ['simple', 'simple', 'board', 'board']);
  assert.deepEqual([OVERVIEW_LAYOUT_KEY, [...OVERVIEW_LAYOUTS]], ['studioOverviewLayout.v1', ['board', 'simple']]);
});

test('buildOverviewModel: the board from the same facts — layers, rules, fidelity, changes; nothing while the facts are read, nothing for a service without a pack of its own; the layout rides on the model and the renderer decides', () => {
  const m = keep(board());
  assert.deepEqual([m.layout, m.board.layers.declared, m.board.rules.pct, m.board.fidelity.alignmentPct, m.board.changes.total, m.grade.letter, m.still.status, m.primary], ['board', 600, 80, 78, 73, 'B', 'changed', 'next']);
  assert.deepEqual(keep(board({ pending: true })).board, { layers: null, rules: null, fidelity: null, changes: null }, 'reading: nothing yet');
  assert.deepEqual(keep(board({ serviceId: 2 })).board, { layers: null, rules: null, fidelity: null, changes: null }, 'no pack of its own: nothing to picture');
  const bare = keep(board({ cells: null, conformance: null }));
  assert.deepEqual([bare.board.layers, bare.board.rules, bare.board.fidelity.known], [null, null, true], 'no matrix and no conformance cost their pieces, not the others');
  const never = keep(board({ run: null, journeys: [] }));
  assert.deepEqual([never.board.fidelity.known, never.board.fidelity.note, never.board.changes.sentence, never.next.button.label], [false, 'Never checked against live.', 'Check against live to count what to change.', 'See what to fix']);
  assert.deepEqual([keep(screen()).layout, keep(screen()).board.layers], ['simple', null], 'the simple layout carries the board too, without cells');
  assert.equal(keep(buildOverviewModel({ services, servicesStatus: { kind: 'ok', error: null }, catalog: packs })).layout, 'board', 'the board is the default');
});

test('renderOverview: the board — three numbered stages over three columns; the stack with its plates, labelled cells and counts; one status strip; the shield, the rules and the seven rows open; the ring, four counts and the promises bar; the three tiles to change; one primary; the column links reach host.overview; the simple layout on request, without a pack of its own, and as the fallback when the board cannot be drawn', () => {
  const c = overviewContainer();
  const calls = [];
  const host = { overview: { openDiscover: () => calls.push('discover'), openDiagnose: () => calls.push('diagnose'), openRemediate: () => calls.push('remediate'), openNeuron: () => calls.push('neuron'), checkNow: () => calls.push('check') } };
  renderOverview(c, board({ diagnostic: diagnosticFull }), host);
  const html = c.innerHTML;
  assert.ok(html.startsWith('<div class="ov-page ov-page--board">'), 'the zone, the board');
  // The workflow header: three numbered stages in the words of Expert's tabs, each with its question.
  assert.ok(html.includes('<ol class="ov-stages" aria-label="The three stages">'));
  for (const [n, key, word, ask] of [[1, 'discover', 'Discover', 'What is in place?'], [2, 'diagnose', 'Diagnose', 'Is it diagnostic-grade?'], [3, 'remediate', 'Remediate', 'What to change?']]) {
    assert.ok(html.includes(`<li class="ov-stage ov-stage--${key}">`) && html.includes(`<span class="ov-stage__n" aria-hidden="true">${n}</span>`) && html.includes(`${word}</span><span class="ov-stage__ask">${ask}</span>`), `stage ${n}`);
  }
  for (const piece of ['<div class="ov-board">', 'class="ov-col ov-col--discover og-panel og-panel--pad"', 'class="ov-col ov-col--diagnose"', 'class="ov-col ov-col--remediate og-panel og-panel--pad"']) assert.ok(html.includes(piece), piece);
  assert.ok(html.includes('<h2 class="ov-card__h" id="ov-discover-h">Layers</h2>') && html.includes('>Are the right signals in place?</span></h2>') && html.includes('<h2 class="ov-card__h" id="ov-live-eyebrow">Can you trust what the signals show?</h2>') && html.includes('<h2 class="ov-card__h" id="ov-remediate-h">Changes to apply</h2>'), 'the panel headings');
  assert.ok(html.includes('<span class="ov-card__badge" aria-hidden="true">A</span>') && html.includes('<span class="ov-card__badge" aria-hidden="true">B</span>'), 'the two groups are lettered');
  // Discover: the kinds labelled once above the stack, then the four layers top down, each with its plate, its identity, its health and its count.
  assert.ok(html.includes('<div class="ov-cells ov-cells--head" aria-hidden="true"><span class="ov-cell-h" title="indicators">SLI</span><span class="ov-cell-h" title="objectives">SLO</span>') && html.includes('<span class="ov-cell-h" title="synthetic checks">Syn</span></div>'));
  assert.equal(countOf(html, '<li class="ov-layer ov-layer--'), 4);
  assert.equal(countOf(html, '<span class="ov-plate" aria-hidden="true"><svg class="ov-plate__svg"'), 4, 'a plate per layer');
  assert.ok(html.indexOf('>User experience<') < html.indexOf('>Application<') && html.indexOf('>Application<') < html.indexOf('>Platform<') && html.indexOf('>Platform<') < html.indexOf('>Infrastructure<'), 'top down');
  assert.ok(html.includes('<li class="ov-layer ov-layer--ux ov-layer--fail">') && html.includes('<li class="ov-layer ov-layer--app ov-layer--ok">') && html.includes('<li class="ov-layer ov-layer--platform ov-layer--warn">') && html.includes('<li class="ov-layer ov-layer--infra ov-layer--warn">'), 'identity and health are separate classes');
  assert.equal(countOf(html, 'class="ov-cell ov-cell--on"'), 14, '7 + 4 + 3 lit cells');
  assert.equal(countOf(html, 'class="ov-cell"'), 26, 'the rest dark');
  assert.ok(html.includes('<span class="ov-cell ov-cell--on" title="37 metrics">37</span>') && html.includes('<span class="ov-cell" title="no runbooks"></span>'));
  assert.ok(html.includes('<span class="og-pill og-pill--ok ov-layer__n">7 of 10 kinds</span>') && html.includes('<span class="og-pill og-pill--fail ov-layer__n">0 of 10 kinds</span>'), 'the health pill');
  assert.ok(html.includes('<span class="ov-layer__total" title="declared on this layer"><b>80</b><small>declared</small></span>'), 'the count');
  assert.ok(html.includes('<div class="ov-layer__kinds og-muted">17 indicators · 15 objectives · 37 metrics · 2 logs · 1 trace · 4 dashboards · 4 alerts</div>') && html.includes('<div class="ov-layer__kinds og-muted">nothing declared on this layer</div>'));
  assert.ok(html.includes('<div class="ov-stat" title="600 things declared in the repository."><dt>Declared</dt><dd>600</dd></div>') && html.includes('<dt>Coverage</dt><dd>35<small>%</small></dd>') && html.includes('<div class="ov-stat" title="7 things could not be placed on a layer."><dt>Unplaced</dt><dd>7</dd></div>'), 'the three stats');
  assert.ok(html.includes('<details class="ux-disclosure ov-comp__wrap"><summary>In the repository</summary>') && html.includes('<span class="ov-comp__item"><b class="ov-comp__n">321</b> Dashboards/Recording Rules</span>'), 'the composition behind a compact row');
  assert.ok(!html.includes('ov-legend') && !html.includes('Cells, left to right'), 'the cells are labelled directly: no legend paragraph');
  // Diagnose: one status strip for the column — what was graded against what, when, which families were not read, the cadence.
  assert.ok(html.includes('<div class="ov-status ov-status--warn" role="status"><span class="ov-status__dot" aria-hidden="true"></span>'));
  for (const [k, text] of [['source', 'Graded against live'], ['when', 'checked 2 hours ago'], ['partial', 'live side partial: dashboards not read'], ['cadence', 'checks run when you click']]) assert.ok(html.includes(`<span class="ov-status__part ov-status__part--${k}">${text}</span>`), `status ${k}`);
  assert.equal(countOf(html, 'Graded against live, 2 hours ago.'), 0, 'the live source line is not repeated under the shield');
  assert.ok(html.includes('<div class="ov-shield ov-tone-warn" title="B · Industrial Grade — Suitable for production, maintenance, process control, and routine professional use." aria-label="Grade B"><span class="ov-shield__letter">B</span></div>'));
  assert.ok(html.includes('<div class="ov-grade__label">Industrial grade</div>') && html.includes('<div class="ov-grade__word">Almost diagnostic-grade</div>'));
  assert.ok(html.includes('<div class="ov-rules ov-rules--warn" title="12 of 15 required rules met for a tier 2 service."><div class="ov-rules__n"><b>12</b><span class="ov-rules__of">/ 15</span></div><div class="ov-rules__bar" role="img" aria-label="12 of 15 required rules met"><span style="width:80%"></span></div><span class="ov-rules__text">required rules met · tier 2</span></div>'));
  assert.ok(html.includes('<div class="ov-grade__why ov-grade__why--open"><p class="ov-grade__points og-muted">4.8 of 7 points. B+ starts at 5.3.</p><ul class="ov-gw-list ov-gw-list--open">'), 'headless: the seven rows open, no disclosure');
  assert.equal(countOf(html, '<li class="ov-gw '), 7);
  assert.ok(html.includes('<svg class="ov-ring ov-ring--warn" viewBox="0 0 88 88" role="img" aria-label="78 in 100 aligned">') && html.includes('stroke-dasharray="238.76" stroke-dashoffset="52.53"') && html.includes('<text class="ov-ring__pct" x="44" y="42">78%</text>'));
  for (const t of ['<div class="ov-tile ov-tile--ok" title="declared and running live"><span class="ov-tile__n">252</span><span class="ov-tile__l">match</span></div>', '<span class="ov-tile__n">5</span><span class="ov-tile__l">run differently</span>', '<span class="ov-tile__n">38</span><span class="ov-tile__l">not running live</span>', '<span class="ov-tile__n">30</span><span class="ov-tile__l">live only</span>']) assert.ok(html.includes(t), t);
  assert.ok(html.includes('<span class="ov-chains__seg ov-chains__seg--ok" style="flex-grow:5"></span>') && html.includes('<span class="ov-chains__seg ov-chains__seg--warn" style="flex-grow:1"></span>') && html.includes('<span class="ov-chains__seg ov-chains__seg--fail" style="flex-grow:12"></span>'));
  assert.ok(html.includes('<p class="ov-chains__text og-muted">5 of 18 promises hold end to end, 1 in part.</p>') && !html.includes('ov-fid__partial'), 'the families not read are in the strip, not repeated under the counts');
  assert.ok(html.includes('<span class="og-pill og-pill--warn ov-live__pill">Changed</span>') && html.includes('<p class="ov-live__sentence">Checked 2 hours ago against live — 43 things differ from what the repository declares.</p>') && html.includes('<button type="button" class="og-btn ov-check" data-ux-action="ov-check">Check again</button>'));
  // Remediate: three tiles with their icons, then the one next step.
  assert.ok(html.includes('<div class="ov-change ov-change--fail" title="declared in the repository, not running live"><svg class="ov-ic ov-change__ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">') && html.includes('<span class="ov-change__l">to add</span><span class="ov-change__n">38</span><span class="ov-change__note og-muted">declared, not live</span></div>'));
  assert.ok(html.includes('<span class="ov-change__l">to update</span><span class="ov-change__n">5</span><span class="ov-change__note og-muted">live, not as declared</span>') && html.includes('<span class="ov-change__l">to review</span><span class="ov-change__n">30</span><span class="ov-change__note og-muted">live, not declared</span>'), 'to review, never to remove');
  assert.ok(html.includes('<p class="ov-next__sentence">Fix the 43 things the live side does differently.</p>') && html.includes('<button type="button" class="og-btn og-btn--primary ov-next__btn" data-ux-action="ov-next-neuron">See the differences</button>'));
  assert.equal(countOf(html, 'og-btn--primary'), 1, 'one primary on the board');
  for (const [action, label] of [['ov-open-discover', 'Open in Discover'], ['ov-next-diagnose', 'Open in Diagnose'], ['ov-open-remediate', 'Open in Remediate']]) assert.ok(html.includes(`<button type="button" class="og-btn og-btn--text ov-link" data-ux-action="${action}">${label} <span class="ov-link__arrow" aria-hidden="true">→</span></button>`), label);
  c.click('ov-open-discover'); c.click('ov-next-diagnose'); c.click('ov-open-remediate'); c.click('ov-next-neuron'); c.click('ov-check');
  assert.deepEqual(calls, ['discover', 'diagnose', 'remediate', 'neuron', 'check']);
  assert.ok(!/<(img|script)\b/.test(html), 'no raw markup');
  assert.equal((html.match(/%<\//g) || []).length, 2, 'two percent signs reach the page: the ring\'s and the coverage stat\'s');
  // Never checked: the strip says so, the ring is empty, the counts withheld with their reason; the next step is the one primary.
  const never = overviewContainer();
  renderOverview(never, board({ run: null, journeys: [] }), { overview: {} });
  assert.ok(never.innerHTML.includes('<span class="ov-status__part ov-status__part--when">never checked against live</span>') && never.innerHTML.includes('<span class="ov-status__part ov-status__part--source">Graded from the repository</span>'));
  assert.ok(never.innerHTML.includes('<svg class="ov-ring ov-ring--neutral" viewBox="0 0 88 88" role="img" aria-label="Not known">') && never.innerHTML.includes('<text class="ov-ring__pct" x="44" y="42">–</text>'));
  assert.ok(never.innerHTML.includes('<p class="ov-fid__note og-muted">Never checked against live.</p>') && !never.innerHTML.includes('ov-tile') && !never.innerHTML.includes('ov-chains'));
  assert.ok(never.innerHTML.includes('<div class="ov-grade__src og-muted">Graded from the repository alone.</div>'), 'a source other than live is said under the shield');
  assert.ok(never.innerHTML.includes('<p class="ov-col__lead og-muted">Check against live to count what to change.</p>') && !never.innerHTML.includes('class="ov-change '));
  assert.equal(countOf(never.innerHTML, 'og-btn--primary'), 1);
  // Reading: placeholders, no counts, no rules, no strip.
  const pending = overviewContainer();
  renderOverview(pending, board({ pending: true }), { overview: {} });
  assert.ok(pending.innerHTML.includes('<p class="ov-reading og-muted" role="status">Reading the repository…</p>') && pending.innerHTML.includes('Reading the last check…') && !pending.innerHTML.includes('ov-rules') && !pending.innerHTML.includes('ov-tile') && !pending.innerHTML.includes('class="ov-status '));
  // Without a pack of its own there is nothing to picture: the simple layout, whatever was asked.
  const kx = overviewContainer();
  renderOverview(kx, board({ serviceId: 2 }), { overview: {} });
  assert.ok(kx.innerHTML.startsWith('<div class="ov-page">') && !kx.innerHTML.includes('ov-board') && kx.innerHTML.includes('No pack of its own'));
  // The simple layout on request.
  const simple = overviewContainer();
  renderOverview(simple, board({ layout: 'simple' }), { overview: {} });
  assert.ok(simple.innerHTML.startsWith('<div class="ov-page">') && !simple.innerHTML.includes('ov-board') && !simple.innerHTML.includes('ov-stages') && simple.innerHTML.includes('class="ov-next og-panel'));
  // The fallback: a board that cannot be drawn gives the simple layout and logs, never a blank screen.
  const broken = board();
  broken.board.layers.rows = null;
  const fb = overviewContainer();
  const logged = [];
  const original = console.error;
  console.error = (...a) => logged.push(a[0]);
  try { renderOverview(fb, broken, { overview: {} }); } finally { console.error = original; }
  assert.ok(fb.innerHTML.startsWith('<div class="ov-page">') && fb.innerHTML.includes('class="ov-next og-panel') && !fb.innerHTML.includes('ov-board'));
  assert.deepEqual(logged, ['[overview] the board could not be drawn; the simple layout instead']);
  // Every state of the matrix draws on the board too, with exactly the model's primaries and no raw markup.
  for (const [name, over] of Object.entries(STATES)) {
    const m = board(over);
    const bc = overviewContainer();
    assert.doesNotThrow(() => renderOverview(bc, m, { overview: {} }), name);
    assert.equal(countOf(bc.innerHTML, 'og-btn--primary'), primariesOf(m), `${name}: the board's primaries`);
    assert.ok(!/<(img|script)\b/.test(bc.innerHTML), `${name}: no raw markup from data`);
  }
});

test('the board agrees with the engine: a cell lit by live evidence alone is present (observed) but counts nothing and reads "seen live"; the coverage is summed the way Comprehensive sums it, rounded once; the required rules read the tier out of the body\'s object and say when they could not be read; a stale reading is said beside the counts', () => {
  // Evidence only: present for the engine, no declaration to count.
  const evidenceOnly = { 'infra:metric': [{ id: 'scrape/node', title: 'node', _evidence: true }], 'infra:slo': [{ id: 'SLO-1' }] };
  const infra = layersModel({ cells: evidenceOnly }).rows.find((r) => r.key === 'infra');
  assert.deepEqual([infra.covered, infra.total, infra.kinds.find((k) => k.key === 'metric')], [2, 1, { key: 'metric', word: 'metrics', count: 0, present: true, label: 'metrics seen live' }]);
  // Rounding: per-layer shares summed then rounded once — 7/10 + 4/10 + 3/10 + 0 = 1.4 / 4 = 35; and a case where rounding each layer first would differ.
  const cells = (a, b, c, d) => Object.fromEntries([['app', a], ['platform', b], ['infra', c], ['ux', d]].flatMap(([L, n]) => Array.from({ length: n }, (_, i) => [`${L}:${['sli', 'slo', 'metric', 'log', 'trace', 'dashboard', 'alert', 'runbook', 'chaos', 'synthetic'][i]}`, 1])));
  assert.equal(layersModel({ cells: cells(7, 4, 3, 0) }).coveragePct, 35);
  const engineAverage = (...covered) => Math.round(covered.reduce((n, c) => n + c / 10, 0) / 4 * 100);
  for (const combo of [[1, 1, 1, 2], [3, 3, 3, 0], [9, 7, 1, 1], [5, 5, 5, 6]]) assert.equal(layersModel({ cells: cells(...combo) }).coveragePct, engineAverage(...combo), combo.join('/'));
  // The rules: the body's `tier` is an object; a read failure is said, not shown as "no rules".
  assert.equal(rulesModel({ must: { passed: 1, total: 2 }, tier: { graded: 'tier-3' } }).sentence, '1 of 2 required rules met for a tier 3 service.');
  assert.deepEqual(keep(rulesModel(null, { error: '500: boom' })), { passed: 0, total: 0, pct: 0, tier: '', met: false, unknown: true, sentence: 'The required rules could not be read.', tone: 'neutral' });
  assert.equal(rulesModel(null, { error: null }), null, 'no body and no error: nothing to say');
  const unread = overviewContainer();
  renderOverview(unread, board({ conformance: null, conformanceError: '500: boom' }), { overview: {} });
  assert.ok(unread.innerHTML.includes('<div class="ov-rules ov-rules--unknown"><span class="ov-rules__text og-muted">The required rules could not be read.</span></div>') && !unread.innerHTML.includes('ov-rules__bar'));
  // Stale: the counts are shown, with the caveat the engine applies.
  const stale = keep(fidelityModel({ run, journey, pack: krystalinePack, now: STALE_NOW }));
  assert.deepEqual([stale.known, stale.note], [true, 'The live side answered only in part: its dashboards could not be read. Counted 1 day ago; readings older than a day are not trusted.']);
  assert.equal(keep(board({ now: STALE_NOW })).board.fidelity.note.endsWith('readings older than a day are not trusted.'), true);
  // The lit-by-evidence cell draws a dot, never a zero.
  const dot = overviewContainer();
  renderOverview(dot, board({ cells: { ...posture.cells, 'ux:metric': [{ id: 'scrape/rum', _evidence: true }] } }), { overview: {} });
  assert.ok(dot.innerHTML.includes('<span class="ov-cell ov-cell--on" title="metrics seen live">•</span>'));
});

// ---------- the vocabulary ----------
//
// Last, so every model the tests above kept — the board's included — is walked.

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

test('gradeWhy at the bar: promises at 85 in 100 read Yes and still count 0.85 of a point, as the engine scores them, so the list is offered for the letter it explains (seen on the demo 2026-10-28 when a check moved 84 to 85)', () => {
  const atBar = { ...run, traceability: { ...run.traceability, integrityPct: 85 } };
  const g = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: diagnosticFull, run: atBar, journey, now: NOW }));
  assert.equal(g.why.length, 7, 'offered: 3 + 0.85 + 1 = 4.85 of 7 is the letter\'s 69');
  assert.equal(g.why.find((w) => w.text.startsWith('Of what the repository promises'))?.ok, 'yes', 'at the bar the mark is a yes');
  assert.ok(g.why.some((w) => w.text === 'Of what the repository promises, 85 in 100 holds up live; the bar is 85.'));
  assert.equal(g.points, '4.9 of 7 points. B+ starts at 5.3.');
  const far = { ...run, traceability: { ...run.traceability, integrityPct: 100 } };
  assert.equal(keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: diagnosticFull, run: far, journey, now: NOW })).why.length, 0, 'a full point at 100 no longer adds up to a score of 69: withheld, as before');
});

// ---------- the vendoring seam (docs/VENDORING.md, "The Overview board") ----------
//
// A downstream copies these files verbatim; an import creeping in from the
// app shell or the state breaks their build, not ours — so CI holds the line
// here, the way tools/test-diagnostic-grade.mjs holds the grade engine.

const VENDORABLE_OVERVIEW = {
  'studio/overview-model.mjs': ['./services-model.mjs', './diagnostic-grade.mjs', './constants.mjs'],
  'studio/overview-view.mjs': ['./util.mjs', './host.mjs', './ux-kit-pure.mjs'],
  'studio/overview-api.mjs': ['./services-api.mjs', './diagnostic-grade.mjs'],
  'studio/ux-kit-pure.mjs': ['./util.mjs'],
  'studio/services-model.mjs': [],
  'studio/services-api.mjs': ['./api.mjs'],
};

test('the Overview board\'s import closure is exactly the one docs/VENDORING.md lists, and studio/overview.css reads design tokens and its own --ov-* properties only', () => {
  for (const [file, allowed] of Object.entries(VENDORABLE_OVERVIEW)) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.deepEqual(imports, allowed, `${file} imports`);
    assert.ok(!/\b(document|window|localStorage|sessionStorage)\b\s*[.[]/.test(src.replace(/\/\/.*$/gm, '').replace(/typeof (window|document)/g, '')) || !['studio/overview-model.mjs', 'studio/ux-kit-pure.mjs', 'studio/services-model.mjs'].includes(file), `${file} (the model, the pure kit) touches no DOM`);
  }
  const css = readFileSync(new URL('../studio/overview.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const refs = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
  const foreign = refs.filter((r) => !r.startsWith('--og-') && !r.startsWith('--ov-'));
  assert.deepEqual(foreign, [], 'overview.css reads a property that is neither a design token nor its own');
  const own = new Set([...css.matchAll(/(--ov-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  for (const r of refs.filter((x) => x.startsWith('--ov-'))) assert.ok(own.has(r), `${r} is read but never set`);
  const tokens = readFileSync(new URL('../studio/design-tokens.css', import.meta.url), 'utf8');
  for (const r of refs.filter((x) => x.startsWith('--og-'))) assert.ok(tokens.includes(`${r}:`), `${r} is not a design token`);
  // Every selector is scoped to the zone (an `html[data-theme] .ov-page` theme override included).
  const selectors = (css.match(/[^{};]+(?=\s*\{)/g) || []).map((s) => s.trim()).filter((s) => s && !s.startsWith('@'));
  const unscoped = selectors.filter((s) => !s.split(',').every((part) => part.includes('.ov-')));
  assert.deepEqual(unscoped, [], 'overview.css styles nothing outside its zone');
});
