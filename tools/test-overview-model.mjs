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
import { readFileSync, readdirSync } from 'node:fs';
import {
  UI_MODES, OVERVIEW_STATUS, FRESH_WINDOW_MS,
  decideUiMode, orderServicesForOverview, pickOverviewService, journeyForService, journeyIsLive, boardComparison,
  shortGradeLabel, verdictWordFor, runGradedPack, runGradesBoard, differenceCount, vantageShrank,
  gradeModel, gradeWhy, stillTrueModel, nextActionModel, buildOverviewModel,
  layersModel, compositionOf, rulesModel, fidelityModel, changesModel, decideOverviewLayout, OVERVIEW_LAYOUT_KEY, OVERVIEW_LAYOUTS,
  START_IDLE, startChoose, startAdopted,
  REPOSITORY_KINDS, NEW_ENDPOINT, FORM_CLOSED, repositoryLine, rowKey, serviceListModel, formOpened, formInput, formProblems, formProblemsNote, formModel, savePlan, sourceOffText, ALL_SOURCES_OFF,
  formDraft, formRestored, FORM_DRAFT_TTL_MS,
  folderBrowseStart, folderBrowseOpening, folderBrowseListed, folderBrowseFailed, folderBrowseChosen, folderBrowseClosed,
  uploadReading, uploadStaged, uploadFailed,
} from '../studio/overview-model.mjs';
import { renderOverview, renderServiceList, readTokenDrafts } from '../studio/overview-view.mjs';
import { loadServiceListFacts, loadRepositoryFolders, computeOverviewDiagnostic } from '../studio/overview-api.mjs';
import { runServiceRecord, servicesRefusal } from '../studio/services-api.mjs';
import { instrumentGradeFor, GRADE_CRITERION_KEYS } from '../studio/diagnostic-grade.mjs';
import { criteriaScope, criteriaPanelHtml, groupNames, notGradedSentence, switchHtml, askRowHtml, CRITERION_LONG } from '../studio/grade-criteria-ui.mjs';
import { host as studioHost } from '../studio/host.mjs';

// ---------- fixtures ----------

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/overview/${name}.json`, import.meta.url), 'utf8'));
const services = fixture('services').services;
const packs = fixture('packs').packs;
const journeys = fixture('journeys').journeys;
// The recorded runs carry grade schema 2; the board explains a run of the
// engine's current schema only (studio/overview-model.mjs GRADE_SCHEMA), so
// the tests read them re-stamped as schema 4 — a schema-2 run explains
// nothing, pinned in the gradeWhy test below.
const restamp = (r) => ({ ...r, grade: { ...r.grade, schema: 4 } });
const recordedRun = fixture('krystaline-run');
const run = restamp(recordedRun);

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
// The same diagnostic with the engine's criteria (grade schema 4), as computeDiagnosticGrade writes them for the demo pack alone.
const diagnosticFull = {
  ...diagnostic, gradeSchema: 4,
  coverage: { criteria: [
    { key: 'multi-modal', label: 'Multi-modal', pass: true, detail: '3 of 4 signals declared as backends (metrics, traces, logs)' },
    { key: 'correlated', label: 'Correlated', pass: true, detail: 'tracecontext propagator declared' },
    { key: 'calibrated', label: 'Calibrated', pass: true, detail: 'MTTD/MTTR baselines + 18 SLOs with explicit objective' },
    { key: 'comprehensive', label: 'Comprehensive', pass: false, detail: '35% average observed across infra · platform · app · ux' },
  ] },
  trust: { criteria: [
    { key: 'chaos-validated', label: 'Chaos-validated', pass: false, detail: 'no chaos experiment declared - the repository scan cannot detect chaos tooling', declared: 0, scaffolds: 0, unobserved: { repository: 'the repository scan has no chaos-experiment detector', live: null }, fromScan: true },
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
const partialRun = restamp(fixture('krystaline-run-partial'));
// The same journey reading a recording as Pack B (a file path, not "mcp: …").
const fileJourney = { ...journey, packB: 'C:/demo/.observogram-demo/journeys/krystaline/live/2026-10-07T12-00-00-000Z.json' };

// The live pack the server kept from that run (GET /api/journeys `livePack`), and its catalogue entry.
const LIVE_ENTRY = { id: 'uploaded-krystaline-live-5e1f', label: 'krystaline · prod · live', description: 'Uploaded pack — journey-live:krystaline', live: 'scaffold', source: 'uploaded', ok: true };
const keptJourney = { ...journey, livePack: { id: LIVE_ENTRY.id, label: LIVE_ENTRY.label, refreshedAt: run.packB.refreshedAt } };

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

test('journeyForService: found by the pack file although scope.service is null; by slug, case-insensitively; another pack or service is not; scope.env first, another environment never; null when none', () => {
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
  // The start saves a check of the service's own pack beside an older one scoped to the service: the board shows the start's.
  const older = { ...journey, name: 'kx-wallet', packA: '/w/packs/old.pack.yaml', scope: { service: 'kx-wallet', env: 'prod' } };
  const startCheck = { ...journey, name: 'kx-wallet-repo-vs-live', packA: '/w/packs/uploaded-kx-wallet-1.pack.yaml', scope: { service: 'kx-wallet', env: 'prod' } };
  assert.equal(journeyForService([older, startCheck], { slug: 'kx-wallet', env: 'prod', packId: 'uploaded-kx-wallet-1' }), startCheck, 'the check of the service\'s own pack wins over one merely scoped to it');
  assert.equal(journeyForService([older], { slug: 'kx-wallet', env: 'prod', packId: 'uploaded-kx-wallet-1' }), older, 'with none of its own pack, the scoped one');
  // A Windows path to the same pack file is the same link.
  assert.equal(journeyForService([{ ...journey, packA: 'C:\\demo\\.observogram-demo\\packs\\uploaded-krystaline-a37d2521.pack.yaml' }], { packId: 'uploaded-krystaline-a37d2521' })?.name, 'krystaline');
  // Among several journeys of the pack: the one whose scope.env is the environment on screen, else the first.
  const staging = { ...journey, name: 'krystaline-staging', scope: { env: 'staging', service: null, scopeMode: null } };
  const prod = { ...journey, name: 'krystaline-prod', scope: { env: 'prod', service: null, scopeMode: null } };
  assert.equal(journeyForService([staging, prod], { env: 'prod', packId: 'uploaded-krystaline-a37d2521' }), prod);
  assert.equal(journeyForService([staging, prod], { env: 'staging', packId: 'uploaded-krystaline-a37d2521' }), staging);
  assert.equal(journeyForService([staging, prod], { env: 'dev', packId: 'uploaded-krystaline-a37d2521' }), null, 'no journey for dev: none — a check of staging says nothing about dev');
  assert.equal(journeyForService([staging, prod], { env: null, packId: 'uploaded-krystaline-a37d2521' }), staging);
  // A journey with no environment of its own checks whichever is on screen.
  const unscoped = { ...journey, name: 'krystaline-any', scope: { env: null, service: null, scopeMode: null } };
  assert.equal(journeyForService([staging, unscoped], { env: 'dev', packId: 'uploaded-krystaline-a37d2521' }), unscoped);
  // The environment before the pack: a Run's check of staging (the service's newest pack) is not prod's,
  // when an older check scoped to the service and prod exists.
  const runStaging = { ...journey, name: 'kx-exchange.staging', packA: '/w/packs/uploaded-kx-exchange-2.pack.yaml', scope: { service: 'kx-exchange', env: 'staging' } };
  const oldProd = { ...journey, name: 'kx-exchange-prod', packA: '/w/packs/uploaded-kx-exchange-1.pack.yaml', scope: { service: 'kx-exchange', env: 'prod' } };
  assert.equal(journeyForService([runStaging, oldProd], { slug: 'kx-exchange', env: 'prod', packId: 'uploaded-kx-exchange-2' }), oldProd);
  assert.equal(journeyForService([runStaging], { slug: 'kx-exchange', env: 'prod', packId: 'uploaded-kx-exchange-2' }), null, 'prod was never checked');
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

test('boardComparison: the live pack the journey\'s last run read, only when that run is the board\'s letter (it graded this pack, its live side did not shrink) and the catalogue has it; Pack B with no environment, as the run adapted it; null otherwise', () => {
  const catalog = [...packs, LIVE_ENTRY];
  const pack = krystalinePack;
  const pair = { packBId: LIVE_ENTRY.id, envB: null, label: 'krystaline · prod · live' };
  const keptFor = (r) => ({ ...journey, livePack: { id: LIVE_ENTRY.id, label: LIVE_ENTRY.label, refreshedAt: r.packB.refreshedAt } });
  assert.deepEqual(boardComparison({ journey: keptJourney, run, catalog, pack }), pair);
  // Another read than the run shown (the listing moved on), a run that lost its vantage (it read nothing), no run.
  assert.equal(boardComparison({ journey: { ...keptJourney, livePack: { ...keptJourney.livePack, refreshedAt: '2026-10-28T09:00:00.000Z' } }, run, catalog, pack }), null, 'another read than the one the board shows');
  assert.equal(boardComparison({ journey: keptJourney, run: { ...run, outcome: 'vantage-lost', packB: { source: run.packB.source } }, catalog, pack }), null, 'a run that lost its vantage');
  assert.equal(boardComparison({ journey: keptJourney, run: null, catalog, pack }), null, 'no run');
  // A check whose live side showed less than the one before: the board grades the repository alone, so Expert gets no Pack B
  // either (seen 2026-11-04: the board read C from the repository while that read, bound, graded B in Expert).
  assert.ok(vantageShrank(partialRun).length > 0 && runGradedPack(partialRun, pack), 'the fixture is a shrunk read of this same pack');
  assert.equal(boardComparison({ journey: keptFor(partialRun), run: partialRun, catalog, pack }), null, 'a live side that shrank');
  assert.equal(keep(screen({ journeys: [keptFor(partialRun)], catalog, run: partialRun })).grade.basis, 'repository', 'and the board grades the repository alone then');
  // A run of another Pack A than the board's pack.
  assert.equal(boardComparison({ journey: keptJourney, run, catalog, pack: { ...pack, id: 'uploaded-other-0000', name: 'other', version: '9' } }), null, 'a run that graded another pack');
  assert.equal(boardComparison({ journey: keptJourney, run, catalog }), null, 'no pack named');
  // Not in the catalogue (evicted, or another org's), a listing without the field, nothing at all.
  assert.equal(boardComparison({ journey: keptJourney, run, catalog: packs, pack }), null, 'not in the catalogue');
  assert.equal(boardComparison({ journey: keptJourney, run, catalog: [...packs, { ...LIVE_ENTRY, ok: false }], pack }), null, 'a catalogue entry that failed');
  assert.equal(boardComparison({ journey, run, catalog, pack }), null, 'a listing without livePack (a host whose server keeps none)');
  assert.equal(boardComparison({ journey: { ...keptJourney, livePack: null }, run, catalog, pack }), null);
  assert.equal(boardComparison({}), null);
  assert.deepEqual(boardComparison({ journey: { ...keptJourney, livePack: { ...keptJourney.livePack, label: '' } }, run, catalog, pack }), { ...pair, label: null }, 'no label: null, never ""');
  // The screen carries it exactly when its letter is the run's — never while reading, never for a member-only row.
  const m = keep(screen({ journeys: [keptJourney], catalog }));
  assert.deepEqual([m.compare, m.grade.basis], [pair, 'live']);
  assert.equal(keep(screen()).compare, null, 'the listing names no live pack');
  assert.equal(keep(screen({ journeys: [keptJourney], catalog, pending: true })).compare, null, 'reading');
  assert.equal(keep(screen({ journeys: [keptJourney], catalog, serviceId: 2 })).compare, null, 'no pack of its own');
});

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
    ['no', 'No chaos experiment is declared — the repository scan cannot detect chaos tooling.'],
  ];
  const rows = (why) => why.map((w) => [w.ok, w.text]);
  // Against live: the yeses first, the partly, then the noes; the points line says how far B+ is.
  const live = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: diagnosticFull, run, journey, now: NOW }));
  assert.deepEqual(rows(live.why), [...has, ['yes', 'Checked against live 2 hours ago.'], ['partly', "Of the links in the repository's 18 promises, 84 in 100 hold up live; the bar is 85."], ...lacks]);
  assert.equal(live.points, '4.8 of 7 points. B+ starts at 5.3.');
  // The repository alone: the two live criteria say so, and score nothing.
  const alone = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: diagnosticFull, run: null, now: NOW }));
  assert.deepEqual(rows(alone.why), [...has, ...lacks, ['no', 'Nothing live has been checked, so no promise is confirmed live.'], ['no', 'Never checked against live.']]);
  assert.equal(alone.points, '3 of 7 points. B starts at 4.4.');
  // Against a recording: the words say so.
  const recorded = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: diagnosticFull, run, journey: fileJourney, now: NOW }));
  assert.deepEqual(rows(recorded.why).slice(3, 5), [['yes', 'Checked against a live recording 2 hours ago.'], ['partly', "Of the links in the repository's 18 promises, 84 in 100 hold up in the recording; the bar is 85."]]);
  // A live picture older than a day when it was read: Fresh says no, with the letter that goes with it.
  const stale = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: diagnosticFull, run: { ...run, freshness: { liveAgeHours: 30 }, grade: { ...run.grade, score: 55, letter: 'C', letterLabel: 'Field Grade' } }, journey, now: NOW }));
  assert.deepEqual([stale.letter, rows(stale.why).at(-1), stale.points], ['C', ['no', 'The live picture was more than a day old when it was checked.'], '3.8 of 7 points. B starts at 4.4.']);
  // A Pack B with no refresh time (a pack file): the run records the age as null and the engine scores Fresh = no.
  // Number(null) is 0 — "zero hours old" — which counted a point the engine never gave, so the list no longer added
  // up to the letter and the sanity guard hid it. Null, and no freshness at all, are undated: Fresh says no, the list shows.
  const undatedRun = { ...run, packB: { ...run.packB, source: 'file:pack-b.pack.yaml', refreshedAt: null }, grade: { ...run.grade, score: 55, letter: 'C', letterLabel: 'Field Grade' } };
  for (const [what, freshness] of [['null age', { liveAgeHours: null, refreshedAt: null }], ['no freshness', undefined]]) {
    const undated = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: diagnosticFull, run: { ...undatedRun, freshness }, journey: fileJourney, now: NOW }));
    assert.equal(undated.why.length, 7, `${what}: the list is offered`);
    assert.deepEqual([undated.letter, rows(undated.why).at(-1), undated.points], ['C', ['no', 'The recording does not say when it was taken, so it does not count as recent.'], '3.8 of 7 points. B starts at 4.4.'], what);
  }
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
  assert.deepEqual(keep(buildOverviewModel({ services: [], servicesStatus: { kind: 'ok', error: null }, catalog: packs })), { kind: 'empty', error: null, ...blank }, 'a host that does not run the start: the empty state as it was');
  assert.deepEqual(keep(buildOverviewModel({ services: [], servicesStatus: { kind: 'ok', error: null }, catalog: packs, startable: true })), { kind: 'empty', error: null, ...blank, sources: { enabled: true, reason: null }, start: { a: null } });
  assert.deepEqual(buildOverviewModel({ services: [], servicesStatus: { kind: 'ok', error: null }, startable: true, access: { canWrite: false, reason: 'viewers cannot load packs' } }).sources, { enabled: false, reason: 'viewers cannot load packs' }, 'empty: a rank that cannot load a pack is told why');
  assert.deepEqual(keep(buildOverviewModel({ services: null, servicesStatus: { kind: 'loading', error: null } })), { kind: 'loading', error: null, ...blank });
  assert.equal(keep(buildOverviewModel({})).kind, 'empty', 'no status at all reads as empty, never as an error');
  // A drift check started here: Pack A registered (its service now in the table), the start stays until step 2.
  const started = keep(screen({ startable: true, start: { a: { id: 'kx-scan', label: 'krystaline (scanned draft)' } } }));
  assert.deepEqual([started.kind, started.service, started.start, started.primary], ['empty', null, { a: { label: 'krystaline (scanned draft)' } }, null]);
  assert.equal(keep(screen({ start: { a: { id: 'kx-scan', label: 'x' } } })).kind, 'service', 'a start state from a host that does not run the start changes nothing');
  // A service with no pack at all (its pack dropped, the row kept): the start under its own header, not "Open Expert mode".
  const packless = keep(screen({ startable: true, services: [{ ...KRYSTALINE, packs: [] }] }));
  assert.deepEqual([packless.kind, packless.service.slug, packless.grade.label, packless.start, packless.sources, packless.next.button, packless.primary], ['service', 'krystaline', 'No pack yet', { a: null }, { enabled: true, reason: null }, null, null]);
  const packlessOld = keep(screen({ services: [{ ...KRYSTALINE, packs: [] }] }));
  assert.deepEqual([packlessOld.start, packlessOld.next.button.label, packlessOld.primary], [undefined, 'Open Expert mode', 'next'], 'not startable: Open Expert mode, as it was');
  assert.equal(keep(screen({ startable: true, serviceId: 2 })).start, undefined, 'a member-only row stays Expert\'s: no start');
  assert.equal(keep(screen({ startable: true })).start, undefined, 'a service with a pack of its own: no start');
  assert.equal(keep(buildOverviewModel({ services: null, servicesStatus: { kind: 'static', error: null } })).kind, 'error', 'any status but ok/loading with no rows is unreadable');
});


test('startChoose / startAdopted: the start\'s logic every host shares — Pack A kept at step 1, the pair to compare at step 2, the same pack refused as Pack B', () => {
  assert.deepEqual(START_IDLE, { slot: null, a: null });
  assert.ok(Object.isFrozen(START_IDLE));
  assert.deepEqual(startChoose(START_IDLE, 'a'), { slot: 'a', a: null });
  assert.deepEqual(startChoose(START_IDLE, 'anything'), { slot: 'a', a: null }, 'anything but b is step 1');
  const a = { id: 'repo-1', label: 'krystaline (scanned)' };
  const one = startAdopted(startChoose(START_IDLE, 'a'), a);
  assert.deepEqual(one, { start: { slot: null, a }, compare: null, said: 'Pack A loaded: krystaline (scanned). Step 2: its live side.', refused: false });
  assert.deepEqual(startChoose(one.start, 'b'), { slot: 'b', a });
  const two = startAdopted(startChoose(one.start, 'b'), { id: 'live-1', label: 'production-live' });
  assert.deepEqual(two, { start: START_IDLE, compare: { a, b: { id: 'live-1', label: 'production-live' } }, said: 'Comparing krystaline (scanned) against production-live.', refused: false });
  assert.deepEqual(startAdopted(startChoose(one.start, 'b'), { id: 'repo-1', label: 'again' }), { start: { slot: null, a }, compare: null, said: 'That pack is Pack A already: step 2 needs its live side.', refused: true });
  assert.deepEqual(startAdopted(startChoose(one.start, 'a'), { id: 'repo-2', label: 'other' }).start, { slot: null, a: { id: 'repo-2', label: 'other' } }, 'step 1 again: Change Pack A');
  assert.deepEqual(startAdopted({ slot: 'b', a: null }, { id: 'x' }).start, { slot: null, a: { id: 'x', label: 'x' } }, 'no Pack A yet: the pack is Pack A');
  assert.deepEqual(startAdopted(one.start, { label: 'no id' }), { start: one.start, compare: null, said: '', refused: false }, 'a pack with no id changes nothing');
});

// ---------- one primary across the screen ----------

// Every state the screen can be in, through buildOverviewModel. The states allowed to have no
// primary are those where nothing can be done from here: Unchanged against a recording (fresh or
// stale — only a live journey can be checked again), the journeys listing unreadable (Retry is a
// secondary button), the facts still being read (pending), and the screens without panels (loading /
// empty / unreadable services, whose buttons are the empty state's secondaries), and a service with no pack at all, whose way
// in is the start's cards (scan, upload), not a primary button. While a check is running the screen may offer one
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
  'no pack, startable': { services: [{ ...KRYSTALINE, packs: [] }], startable: true },
  'empty, startable': { services: [], startable: true },
  'grade error': { diagnosticError: 'bad yaml', journeys: [] },
  'start error': { startError: '502: gateway' },
  'journeys error': { journeysError: '500: boom', run: null },
  pending: { pending: true },
  'pending, no pack of its own': { pending: true, serviceId: 2 },
  loading: { services: null, servicesStatus: { kind: 'loading', error: null } },
  empty: { services: [] },
  'services error': { services: null, servicesStatus: { kind: 'error', error: '503: down' } },
};
const NONE_ALLOWED = new Set(['unchanged (recording)', 'stale unchanged (recording)', 'journeys error', 'pending', 'loading', 'empty', 'services error', 'no pack, startable', 'empty, startable']);
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
  const plain = overviewContainer();
  assert.doesNotThrow(() => renderOverview(plain, buildOverviewModel({ services: [], servicesStatus: { kind: 'ok', error: null } }), { overview: {} }));
  assert.ok(plain.innerHTML.includes('<p class="ux-empty-title">No service to show yet.</p>') && plain.innerHTML.includes('A service appears here once a pack that names it is registered.'), 'not startable: the empty state as it was');
  assert.ok(plain.innerHTML.includes('data-ux-action="ov-expert">Open Expert mode</button>') && !plain.innerHTML.includes('ov-start'), 'no start drawn for a host that does not run it');
  // A host that runs the start: its hooks on host.overview, startable in the model's input.
  const hooks = { overview: { scan() {}, live() {}, upload() {}, resetStart() {}, explain() {}, expert() {} } };
  const empty = overviewContainer();
  assert.doesNotThrow(() => renderOverview(empty, buildOverviewModel({ services: [], servicesStatus: { kind: 'ok', error: null }, startable: true }), hooks));
  assert.ok(empty.innerHTML.includes('id="ov-start-h">No service to show yet.</h2>') && empty.innerHTML.includes('A service appears here once a pack that names it is registered'));
  assert.ok(empty.innerHTML.includes('Scan a repo') && empty.innerHTML.includes('Generate from live') && empty.innerHTML.includes('Diagnose drift'), 'empty: the three steps');
  // Step 1 offers the scan and an upload as Pack A; step 2 (live, or an upload as Pack B) waits for Pack A.
  const stepOf = (html, n) => html.slice(html.indexOf(`aria-label="Step ${n}:`), n < 3 ? html.indexOf(`aria-label="Step ${n + 1}:`) : undefined);
  assert.deepEqual(['ov-scan', 'ov-upload-a', 'ov-live', 'ov-upload-b'].map((a) => stepOf(empty.innerHTML, 1).includes(`data-ux-action="${a}"`)), [true, true, false, false], 'step 1: scan and upload');
  assert.equal(countOf(stepOf(empty.innerHTML, 2), 'data-ux-action="ov-explain" aria-disabled="true" data-reason="Load Pack A first, in step 1."'), 2, 'step 2: live and upload, drawn waiting for Pack A');
  const second = overviewContainer();
  renderOverview(second, buildOverviewModel({ services: [], servicesStatus: { kind: 'ok', error: null }, startable: true, start: { a: { id: 'kx', label: 'kx <scan>' } } }), hooks);
  assert.ok(stepOf(second.innerHTML, 1).includes('Pack A: kx &lt;scan&gt;') && stepOf(second.innerHTML, 1).includes('data-ux-action="ov-start-reset"') && !second.innerHTML.includes('data-ux-action="ov-scan"'), 'step 1 done: Pack A named, escaped, changeable');
  assert.deepEqual(['ov-live', 'ov-upload-b'].map((a) => stepOf(second.innerHTML, 2).includes(`data-ux-action="${a}"`)), [true, true], 'step 2 open: live and upload as Pack B');
  assert.equal(countOf(second.innerHTML, 'og-btn--primary'), 0);
  const packless = overviewContainer();
  renderOverview(packless, screen({ startable: true, services: [{ ...KRYSTALINE, name: 'k8s <x>', packs: [] }] }), hooks);
  assert.ok(packless.innerHTML.includes('id="ov-service"') && packless.innerHTML.includes('id="ov-start-h">No pack for k8s &lt;x&gt; yet.</h2>'), 'a pack-less service: its header, then the start, named and escaped');
  assert.ok(stepOf(packless.innerHTML, 1).includes('data-ux-action="ov-scan"') && !packless.innerHTML.includes('ov-grade') && !packless.innerHTML.includes('ov-next'), 'the start in place of the three panels');
  assert.ok(empty.innerHTML.includes('data-ux-action="ov-expert">Open Expert mode</button>') && !empty.innerHTML.includes('ov-grade') && !empty.innerHTML.includes('id="ov-service"'));
  const viewer = overviewContainer();
  renderOverview(viewer, buildOverviewModel({ services: [], servicesStatus: { kind: 'ok', error: null }, startable: true, access: { canWrite: false, reason: 'viewers cannot load packs' } }), hooks);
  assert.equal(countOf(viewer.innerHTML, 'data-ux-action="ov-explain" aria-disabled="true" data-reason="viewers cannot load packs"'), 4, 'empty, a viewer: the four cards drawn unavailable, each explains');
  assert.ok(!viewer.innerHTML.includes('data-ux-action="ov-scan"'));
  // A host that runs the start but supplies no live draft: that card drawn unavailable, never a card that does nothing.
  const noLive = overviewContainer();
  renderOverview(noLive, buildOverviewModel({ services: [], servicesStatus: { kind: 'ok', error: null }, startable: true, start: { a: { id: 'kx', label: 'kx' } } }), { overview: { ...hooks.overview, live: undefined } });
  assert.ok(stepOf(noLive.innerHTML, 2).includes('data-reason="Not offered here."') && stepOf(noLive.innerHTML, 2).includes('data-ux-action="ov-upload-b"') && !noLive.innerHTML.includes('data-ux-action="ov-live"'), 'a missing hook: its card unavailable, the others live');
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
  assert.deepEqual(L.rows[1].kinds.filter((k) => k.present).map((k) => k.label), ['17 indicators', '15 objectives', '37 metrics', '2 logs', '1 trace', '4 dashboards and panels', '4 alerts']);
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

test('layersModel adds up: Declared is the plates plus Unplaced, each artefact once — a metric, a scrape job, an alert rule and a panel on their layer, a backend repeated as its signal counted once, what has no layer or no kind of its own in Unplaced and named (seen 2026-11-04: 699 declared, 93 on the plates, 6 unplaced)', async () => {
  const { computePostureMatrix } = await import('../studio/diagnostic-grade.mjs');
  const layered = {
    meta: { annotations: {} },
    layers: {
      L1: [{ id: 'SLI-01', title: 'kx_wallet_availability' }, { id: 'SLO-01', title: 'kx_wallet_availability' }],
      L2: [
        { id: 'BAK-01', title: 'metrics-prometheus node-exporter', spec: { signal: 'metrics' } }, { id: 'BAK-02', title: 'alerting-alertmanager', spec: { signal: 'alerting' } },
        { id: 'METRIC-01', title: 'node_cpu_seconds_total' }, { id: 'METRIC-02', title: 'http_requests_total' }, { id: 'METRIC-03', title: 'widgets' },
        { id: 'SCRAPE-01', title: 'scrape: postgres' }, { id: 'PIP-RCV-01', title: 'receiver: otlp' }, { id: 'OTEL-01' },
      ],
      L3: [{ id: 'DASH-01', title: 'k8s cluster' }, { id: 'PANEL-01', title: 'pod_restarts' }, { id: 'PANEL-02', title: 'rca' }],
      L4: { alerting: [{ id: 'RULE-01', title: 'api_error_ratio_high' }, { id: 'ALR-01', title: 'SEV2 routes' }, { id: 'ALR-02', title: 'SEV1 routes' }] },
      L5: [{ id: 'BASE-01', title: 'MTTD / MTTR baselines' }],
    },
  };
  const { cells, unkinded } = computePostureMatrix(layered, null);
  const L = keep(layersModel({ cells, layered, unkinded }));
  const plates = L.rows.reduce((n, r) => n + r.total, 0);
  assert.deepEqual([L.declared, plates, L.unplaced, L.placeless, L.unkinded], [17, 9, 8, 2, 6]);
  assert.equal(plates + L.unplaced, L.declared, 'the column adds up');
  const row = (key) => L.rows.find((r) => r.key === key).kinds.filter((k) => k.count).map((k) => k.label);
  assert.deepEqual(row('infra'), ['2 metrics', '2 dashboards and panels'], 'the backend and the node metric; the dashboard and its panel');
  assert.deepEqual(row('platform'), ['1 metric'], 'the scrape job');
  assert.deepEqual(row('app'), ['1 indicator', '1 objective', '1 metric', '1 alert'], 'the backend on app as its signal is not counted again');
  assert.equal(L.rows.find((r) => r.key === 'app').kinds.find((k) => k.key === 'metric').present, true);
  assert.equal(L.unplacedNote, '8 things are on no layer: 2 could not be placed on one, and 6 are no kind of signal of their own (2 platform-wide settings, 2 alert routes, 1 backend for another signal, 1 pipeline part).');
  // A host that passes no unkinded (before 2026-11-04) keeps the old reading; one kindless thing alone reads singular.
  assert.equal(layersModel({ cells, layered }).unplaced, 2);
  assert.equal(layersModel({ cells: {}, unkinded: [{ id: 'ALR-01' }] }).unplacedNote, '1 thing is on no layer: no kind of signal of its own (1 alert route).');
  assert.equal(layersModel({ cells: {}, unkinded: 4 }).unplacedNote, '4 things are on no layer: no kind of signal of their own.', 'a count, as a saved posture holds it');
});

test('rulesModel, fidelityModel, changesModel: the required rules, the live fidelity with its four counts and the promises that hold, the three counts to change — withheld with the reason (never as zeros) when nothing live was seen whole', () => {
  assert.deepEqual(keep(rulesModel(conformance)), { passed: 12, total: 15, pct: 80, tier: '2', met: false, unknown: false, sentence: '12 of 15 required rules met for a tier 2 service.', tone: 'warn' });
  assert.deepEqual([rulesModel(null), rulesModel({ must: { passed: 0, total: 0 } })], [null, null]);
  assert.deepEqual([rulesModel({ must: { passed: 3, total: 3 }, conformant: true, declaredTier: 'tier-1' }).tone, rulesModel({ must: { passed: 1, total: 4 } }).sentence, rulesModel({ must: { passed: 1, total: 4 } }).tone], ['ok', '1 of 4 required rules met.', 'fail']);
  // The fixture's run is dated; pin the clock or the freshness note appends itself once the run is a day old.
  const f = keep(fidelityModel({ run, journey, pack: krystalinePack, now: NOW }));
  assert.deepEqual([f.known, f.alignmentPct, f.against, f.note], [true, 78, 'live', 'The live side answered only in part: its dashboards could not be read.']);
  assert.deepEqual(f.tiles.map((t) => [t.key, t.value, t.label, t.tone]), [['aligned', 252, 'match', 'ok'], ['drifted', 5, 'run differently', 'warn'], ['missing', 38, 'not running live', 'fail'], ['extra', 30, 'live only', 'info']]);
  assert.deepEqual(f.chains, { total: 18, intact: 5, partial: 1, broken: 12, integrityPct: 84, sentence: '5 of 18 promises hold in every link, 1 in part, 12 broken.' });
  assert.equal(keep(fidelityModel({ run: { ...run, probes: { failed: [] } }, journey, pack: krystalinePack, now: NOW })).note, '', 'every family answered: no note');
  // Rules compared on part of their labels (a live listing that shows severities only): said beside the numbers and on the strip.
  const partly = keep(fidelityModel({ run: { ...run, drift: { ...run.drift, partlyCompared: 58 } }, journey, pack: krystalinePack, now: NOW }));
  assert.deepEqual([partly.note, partly.partial], ['The live side answered only in part: its dashboards could not be read. 58 alert rules were compared without the labels the live side does not show.', ['dashboards', 'rule labels']]);
  const one = keep(fidelityModel({ run: { ...run, probes: { failed: [] }, drift: { ...run.drift, partlyCompared: 1 } }, journey, pack: krystalinePack, now: NOW }));
  assert.deepEqual([one.note, one.partial], ['1 alert rule was compared without the labels the live side does not show.', ['rule labels']]);
  assert.deepEqual(f.partial, ['dashboards'], 'no such count in the record: the strip names the failed families alone');
  assert.equal(keep(fidelityModel({ run: { ...run, traceability: { declaredTotal: 0 } }, journey, pack: krystalinePack, now: NOW })).chains, null, 'no declared chains: no promises line');
  // Withheld: never checked, a run of another pack, the live side lost, the live side shrunk — each with its reason and no counts.
  const never = keep(fidelityModel({}));
  assert.deepEqual([never.known, never.alignmentPct, never.tiles, never.chains, never.note], [false, null, [], null, 'Never checked against live.']);
  assert.equal(keep(fidelityModel({ run, journey, pack: { ...krystalinePack, id: 'other', name: 'v2' } })).known, false);
  assert.equal(keep(fidelityModel({ run: lostRun, journey, pack: krystalinePack, now: NOW })).note, 'The live side did not answer the last check, so nothing is known about it right now.');
  assert.equal(keep(fidelityModel({ run: partialRun, journey, pack: krystalinePack, now: NOW })).note, 'The live side showed less than the check before, so the counts cannot be compared yet.');
  assert.deepEqual([fidelityModel({ run, journey: fileJourney, pack: krystalinePack, now: NOW }).against, fidelityModel({ run: { ...run, packB: { source: '/rec.json' } }, pack: krystalinePack, now: NOW }).against], ['recording', 'recording']);
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
  assert.deepEqual(keep(board({ pending: true })).board, { layers: null, scan: null, rules: null, fidelity: null, changes: null }, 'reading: nothing yet');
  assert.deepEqual(keep(board({ serviceId: 2 })).board, { layers: null, scan: null, rules: null, fidelity: null, changes: null }, 'no pack of its own: nothing to picture');
  assert.equal(m.board.scan, null, 'a record that carries no scan says nothing of one');
  const scanned = keep(board({ run: { ...run, packA: { ...run.packA, scan: { source: 'the folder /src/shop', files: 40, candidates: 40, skipped: 1, skippedFiles: [{ path: 'k8s/values-secrets.yaml', why: 'its name says it holds secrets, which a scan never reads' }], unclassified: 3, unknownFiles: ['notes/a.json'], environment: { profile: 'prod', excluded: 0, excludedFiles: [] }, warnings: [] } } } }));
  assert.deepEqual([scanned.board.scan.sentence, scanned.board.scan.tone, scanned.board.scan.groups.map((g) => g.key)],
    ['Read 40 files from the folder /src/shop — 1 not read, 3 recognised as nothing.', 'warn', ['skipped', 'unknown']], 'the last Run\'s scan beside the layers');
  const shown = overviewContainer();
  renderOverview(shown, scanned, {});
  assert.ok(shown.innerHTML.includes('<details class="ov-scan ov-scan--warn"><summary class="ov-scan__sum">Read 40 files from the folder /src/shop — 1 not read, 3 recognised as nothing.</summary>')
    && shown.innerHTML.includes('<code>k8s/values-secrets.yaml</code>'), 'drawn in Discover, the files it left out behind it');
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
  // The hint is the name's sibling, not inside it: it runs under the pill as well as the name (studio/overview.css,
  // the head's grid areas), so it is never cut; and with nothing cut, no tooltip repeats it.
  assert.match(html, /<span class="ov-layer__name">User experience<\/span>\s*<span class="ov-layer__hint">front end · journeys · business outcomes<\/span>/, 'the layer\'s hint beside its name');
  assert.ok(!html.includes('ov-layer__hint" title='), 'no tooltip repeats a hint that is never cut');
  assert.ok(html.includes('<span class="ov-layer__total" title="declared on this layer"><b>80</b><small>declared</small></span>'), 'the count');
  assert.ok(html.includes('<div class="ov-layer__kinds og-muted">17 indicators · 15 objectives · 37 metrics · 2 logs · 1 trace · 4 dashboards and panels · 4 alerts</div>') && html.includes('<div class="ov-layer__kinds og-muted">nothing declared on this layer</div>'));
  assert.ok(html.includes('<div class="ov-stat" title="600 things declared in the repository."><dt>Declared</dt><dd>600</dd></div>') && html.includes('<dt>Coverage</dt><dd>35<small>%</small></dd>') && html.includes('<div class="ov-stat" title="7 things could not be placed on a layer."><dt>Unplaced</dt><dd>7</dd></div>'), 'the three stats');
  // The column opens on the summary: In the repository and its counts, closed; the stack is what it opens to; the stats stay outside.
  assert.ok(html.includes('<details class="ov-repo">') && !html.includes('<details class="ov-repo" open>'), 'the summary is the default, closed');
  const sum = html.slice(html.indexOf('<summary class="ov-repo__sum">'), html.indexOf('</summary>', html.indexOf('<summary class="ov-repo__sum">')));
  assert.ok(sum.includes('<span class="ov-repo__title">In the repository</span>') && sum.includes('<span class="ov-comp__row"><span class="ov-comp__name">Dashboards/Recording Rules</span><b class="ov-comp__n">321</b></span>'), 'the counts are the summary itself');
  assert.equal(countOf(sum, '<span class="ov-comp__row">'), 5, 'one row per kind: a list, not a sentence');
  assert.ok(!sum.includes(' · '), 'no run-on separators');
  assert.ok(!sum.includes('ov-layer') && html.indexOf('</summary>') < html.indexOf('<ol class="ov-stack"') && html.indexOf('<ol class="ov-stack"') < html.indexOf('</details>', html.indexOf('<details class="ov-repo">')), 'the layers are inside, behind the summary');
  assert.ok(html.indexOf('</details>', html.indexOf('<details class="ov-repo">')) < html.indexOf('<dl class="ov-stats">'), 'the stats stay in view, after it');
  assert.ok(!html.includes('ov-legend') && !html.includes('Cells, left to right'), 'the cells are labelled directly: no legend paragraph');
  // Diagnose: one status strip for the column — what was graded against what, when, which families were not read, the cadence.
  assert.ok(html.includes('<div class="ov-status ov-status--warn" role="status"><span class="ov-status__dot" aria-hidden="true"></span>'));
  for (const [k, text] of [['source', 'Graded against live'], ['when', 'checked 2 hours ago'], ['partial', 'live side partial: dashboards not read'], ['cadence', 'checks run when you click']]) assert.ok(html.includes(`<span class="ov-status__part ov-status__part--${k}">${text}</span>`), `status ${k}`);
  assert.equal(countOf(html, 'Graded against live, 2 hours ago.'), 0, 'the live source line is not repeated under the shield');
  assert.ok(html.includes('<div class="ov-shield ov-tone-warn" title="B · Industrial Grade — Suitable for production, maintenance, process control, and routine professional use." aria-label="Grade B"><span class="ov-shield__letter">B</span></div>'));
  assert.ok(html.includes('<div class="ov-grade__label">Industrial grade</div>') && html.includes('<div class="ov-grade__word">Almost diagnostic-grade</div>'));
  assert.ok(html.includes('<div class="ov-rules ov-rules--warn" title="12 of 15 required rules met for a tier 2 service."><div class="ov-rules__n"><b>12</b><span class="ov-rules__of">/ 15</span></div><div class="ov-rules__bar" role="img" aria-label="12 of 15 required rules met"><span style="width:80%"></span></div><span class="ov-rules__text">required rules met · tier 2</span></div>'));
  // The seven rows are behind Why this grade, closed, whatever room the screen has: the reader opens them.
  assert.ok(html.includes('<details class="ux-disclosure ov-grade__why"><summary>Why this grade</summary><div class="ux-disclosure-body"><p class="ov-grade__points og-muted">4.8 of 7 points. B+ starts at 5.3.</p><ul class="ov-gw-list ov-gw-list--open">'), 'the seven rows behind a closed disclosure');
  assert.ok(!html.includes('<details class="ux-disclosure ov-grade__why" open>') && !html.includes('ov-grade__why--open'), 'never opened for the reader');
  assert.equal(countOf(html, '<li class="ov-gw '), 7);
  assert.ok(html.includes('<svg class="ov-ring ov-ring--warn" viewBox="0 0 88 88" role="img" aria-label="78 in 100 aligned">') && html.includes('stroke-dasharray="238.76" stroke-dashoffset="52.53"') && html.includes('<text class="ov-ring__pct" x="44" y="42">78%</text>'));
  for (const t of ['<div class="ov-tile ov-tile--ok" title="declared and running live"><span class="ov-tile__n">252</span><span class="ov-tile__l">match</span></div>', '<span class="ov-tile__n">5</span><span class="ov-tile__l">run differently</span>', '<span class="ov-tile__n">38</span><span class="ov-tile__l">not running live</span>', '<span class="ov-tile__n">30</span><span class="ov-tile__l">live only</span>']) assert.ok(html.includes(t), t);
  assert.ok(html.includes('<span class="ov-chains__seg ov-chains__seg--ok" style="flex-grow:5"></span>') && html.includes('<span class="ov-chains__seg ov-chains__seg--warn" style="flex-grow:1"></span>') && html.includes('<span class="ov-chains__seg ov-chains__seg--fail" style="flex-grow:12"></span>'));
  assert.ok(html.includes('<p class="ov-chains__text og-muted">5 of 18 promises hold in every link, 1 in part, 12 broken.</p>') && !html.includes('ov-fid__partial'), 'the families not read are in the strip, not repeated under the counts');
  assert.ok(html.includes('<span class="og-pill og-pill--warn ov-live__pill">Changed</span>') && html.includes('<p class="ov-live__sentence">Checked 2 hours ago against live — 43 things differ from what the repository declares.</p>') && html.includes('<button type="button" class="og-btn ov-check" data-ux-action="ov-check">Check again</button>'));
  // Remediate: three tiles with their icons, then the one next step.
  assert.ok(html.includes('<div class="ov-change ov-change--fail" title="declared in the repository, not running live"><svg class="ov-ic ov-change__ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">') && html.includes('<span class="ov-change__l">to add</span><span class="ov-change__n">38</span><span class="ov-change__note og-muted">declared, not live</span></div>'));
  assert.ok(html.includes('<span class="ov-change__l">to update</span><span class="ov-change__n">5</span><span class="ov-change__note og-muted">live, not as declared</span>') && html.includes('<span class="ov-change__l">to review</span><span class="ov-change__n">30</span><span class="ov-change__note og-muted">live, not declared</span>'), 'to review, never to remove');
  assert.ok(html.includes('<p class="ov-next__sentence">Fix the 43 things the live side does differently.</p>') && html.includes('<button type="button" class="og-btn og-btn--primary ov-next__btn" data-ux-action="ov-next-neuron">See the differences</button>'));
  assert.equal(countOf(html, 'og-btn--primary'), 1, 'one primary on the board');
  for (const [action, label] of [['ov-open-discover', 'Open in Discover'], ['ov-next-diagnose', 'Open in Diagnose'], ['ov-open-remediate', 'Open in Remediate']]) assert.ok(html.includes(`<button type="button" class="og-btn og-btn--text ov-link" data-ux-action="${action}">${label} <span class="ov-link__arrow" aria-hidden="true">→</span></button>`), label);
  c.click('ov-open-discover'); c.click('ov-next-diagnose'); c.click('ov-open-remediate'); c.click('ov-next-neuron'); c.click('ov-check');
  assert.deepEqual(calls, ['discover', 'diagnose', 'remediate', 'neuron', 'check']);
  // The column links carry the comparison the board graded: the live pack its run read, null without one.
  const carried = [];
  const opens = { overview: { openDiscover: (x) => carried.push(['discover', x]), openDiagnose: (x) => carried.push(['diagnose', x]), openRemediate: (x) => carried.push(['remediate', x]) } };
  const withLive = board({ diagnostic: diagnosticFull, journeys: [keptJourney], catalog: [...packs, LIVE_ENTRY] });
  assert.ok(withLive.compare, 'the model carries the comparison');
  const lc = overviewContainer();
  renderOverview(lc, withLive, opens);
  assert.ok(!lc.innerHTML.includes(LIVE_ENTRY.id) && !lc.innerHTML.includes('uploaded-'), 'the pack id rides on the click, never on the page');
  lc.click('ov-open-discover'); lc.click('ov-next-diagnose'); lc.click('ov-open-remediate');
  const nc = overviewContainer();
  renderOverview(nc, board({ diagnostic: diagnosticFull }), opens);
  nc.click('ov-next-diagnose');
  assert.deepEqual(carried, [['discover', withLive.compare], ['diagnose', withLive.compare], ['remediate', withLive.compare], ['diagnose', null]]);
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

// `compare` is what a column link hands the host (a pack id, by design) and
// is never drawn — the board's render test checks the id stays off the page.
const HANDED_TO_HOST = new Set(['compare']);
const stringsOf = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsOf(v, out));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => { if (!HANDED_TO_HOST.has(k)) stringsOf(v, out); });
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
  assert.equal(g.why.find((w) => w.text.startsWith('Of the links in the repository'))?.ok, 'yes', 'at the bar the mark is a yes');
  assert.ok(g.why.some((w) => w.text === "Of the links in the repository's 18 promises, 85 in 100 hold up live; the bar is 85."));
  assert.equal(g.points, '4.9 of 7 points. B+ starts at 5.3.');
  const far = { ...run, traceability: { ...run.traceability, integrityPct: 100 } };
  assert.equal(keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: diagnosticFull, run: far, journey, now: NOW })).why.length, 0, 'a full point at 100 no longer adds up to a score of 69: withheld, as before');
});

test('gradeWhy, grade schema 3 (krystaline audit 2026-11-06): the scan\'s default baselines and a placeholder chaos experiment earn nothing, and the chaos line says what each side could see — never that recovery was or was not proven; a schema-2 run explains nothing', () => {
  const layered = (L5, annotations = {}) => ({ id: 'kx', meta: { name: 'kx', annotations }, layers: { L1: [{ id: 'SLO-01', title: 'kx_availability', spec: { objective: 0.999 } }], L2: [], L5 } });
  const SCAN = { 'crawler.discoveredAt': '2026-11-06T00:00:00Z', 'crawler.unobserved.chaos': 'the repository scan has no chaos-experiment detector' };
  const SCAFFOLD_BASE = { id: 'BASE-01', title: 'MTTD / MTTR baselines', source: 'Scaffold' };
  const REAL_BASE = { id: 'BASE-01', title: 'MTTD / MTTR baselines' };
  const CHAOS = (n, source) => ({ id: `CHAOS-0${n}`, title: `pod-kill-${n}`, spec: { target: 'deployment/kx' }, ...(source ? { source } : {}) });
  // score NaN: the lines are read alone, not held to a letter (null would read as 0).
  const why = (pack, r = null) => gradeWhy({ diagnostic: computeOverviewDiagnostic(pack), run: r, letter: 'D', score: NaN, now: NOW }).why;
  const line = (w, re) => { const x = w.find((y) => re.test(y.text)); return x ? { ok: x.ok, text: x.text } : null; };
  const chaos = (w) => line(w, /chaos/i);
  const normal = (w) => line(w, /^Normal is/);

  // The repository scan's pack, nothing live checked.
  const scanned = why(layered([SCAFFOLD_BASE, CHAOS(2, 'Scaffold')], SCAN));
  assert.equal(scanned.length, 7);
  assert.deepEqual(chaos(scanned), { ok: 'no', text: 'No chaos experiment is declared — the repository scan cannot detect chaos tooling.' }, 'a placeholder experiment is none; the scan says why it cannot see more');
  assert.deepEqual(normal(scanned), { ok: 'no', text: 'Normal is not defined with numbers: the detection and repair baselines are defaults the scan wrote, not measurements.' }, 'the scan\'s baselines are defaults, not a pass');
  // Checked against live: the run's Pack B says it could not look at chaos.
  const liveRun = { ...run, packB: { ...run.packB, unobserved: ['baselines', 'chaos', 'synthetic'] } };
  assert.equal(chaos(why(layered([SCAFFOLD_BASE], SCAN), liveRun)).text, 'No chaos experiment is declared — the repository scan cannot detect chaos tooling and the live side cannot observe it.');
  assert.equal(chaos(why(layered([SCAFFOLD_BASE], SCAN), run)).text, 'No chaos experiment is declared — the repository scan cannot detect chaos tooling.', 'a record without packB.unobserved claims nothing about the live side');
  assert.equal(chaos(why(layered([SCAFFOLD_BASE]), liveRun)).text, 'No chaos experiment is declared — the live side cannot observe it.', 'a pack the scan did not write');
  assert.equal(chaos(why(layered([REAL_BASE]))).text, 'No chaos experiment is declared in this pack.', 'no stamp on either side: only what the pack holds');
  // Declared (grade schema 4): partly — never a yes, and never "proven".
  assert.deepEqual(chaos(why(layered([REAL_BASE, CHAOS(1)]))), { ok: 'partly', text: '1 chaos experiment declared, never recorded as run.' });
  assert.equal(chaos(why(layered([REAL_BASE, CHAOS(1), CHAOS(3), CHAOS(2, 'Scaffold')]))).text, '2 chaos experiments declared, never recorded as run.', 'the scaffold is not counted');
  assert.equal(normal(why(layered([REAL_BASE, CHAOS(1)]))).ok, 'yes', 'a declared baseline still makes normal defined');
  for (const w of [scanned, why(layered([REAL_BASE, CHAOS(1)]))]) assert.ok(w.every((x) => !/proven|never been/i.test(x.text)), 'no line without a passing run says recovery was or was not proven');
  // A run graded under schema 2 explains nothing on a schema-4 board.
  assert.deepEqual(gradeWhy({ diagnostic: diagnosticFull, run: recordedRun, letter: recordedRun.grade.letter, score: recordedRun.grade.score, now: NOW }), { why: [], points: '' });
  assert.equal(computeOverviewDiagnostic(layered([REAL_BASE])).gradeSchema, 4);
});

test('gradeWhy, grade schema 4 (spec 1.5): the chaos line says declared, never recorded as run, proven <date>, failed or stale, from the engine\'s proof', () => {
  const layered = (L5) => ({ id: 'kx', meta: { name: 'kx', annotations: {} }, layers: { L1: [{ id: 'SLO-01', title: 'kx_availability', spec: { objective: 0.999 } }], L2: [], L5: [{ id: 'BASE-01', title: 'MTTD / MTTR baselines' }, ...L5] } });
  // computeOverviewDiagnostic grades on the real clock: the runs are dated from it.
  const ago = (days) => new Date(Date.now() - days * 86400e3).toISOString();
  const exp = (n, last_result, schedule = 'weekly') => ({ id: `CHAOS-0${n}`, title: `fault-${n}`, spec: { id: `fault-${n}`, target: 'deployment/kx', schedule, expected_alerts: ['KxDown'], expected_mttd: '3m', ...(last_result ? { last_result } : {}) } });
  const chaos = (L5) => { const x = gradeWhy({ diagnostic: computeOverviewDiagnostic(layered(L5)), run: null, letter: 'D', score: NaN, now: NOW }).why.find((y) => /chaos|Recovery/i.test(y.text)); return x && { ok: x.ok, text: x.text }; };
  assert.deepEqual(chaos([exp(1, { at: ago(1), outcome: 'pass' })]), { ok: 'yes', text: `Recovery proven ${ago(1).slice(0, 10)} by fault injection: 1 of 1 chaos experiment passed a recent run (recorded in the repository).` });
  assert.deepEqual(chaos([exp(1, { at: ago(1), outcome: 'pass' }), exp(2)]), { ok: 'partly', text: `Recovery proven ${ago(1).slice(0, 10)} by fault injection: 1 of 2 chaos experiments passed a recent run (recorded in the repository).` }, 'one of two: partly');
  assert.deepEqual(chaos([exp(1, { at: ago(2), outcome: 'fail', alerts_fired: [] })]), { ok: 'no', text: `Chaos experiment fault-1 failed on ${ago(2).slice(0, 10)}: KxDown did not fire within 3m.` });
  assert.deepEqual(chaos([exp(1, { at: ago(20), outcome: 'pass' })]), { ok: 'partly', text: `1 chaos experiment declared; the last recorded pass, ${ago(20).slice(0, 10)}, is older than 8 days.` });
  assert.deepEqual(chaos([exp(1)]), { ok: 'partly', text: '1 chaos experiment declared, never recorded as run.' });
  // Each line counts what the engine counted, so a declared experiment never
  // stops the seven lines adding up to the letter (a real Run on krystaline,
  // 2026-11-06, drew no list: the partly line counted 0 against the engine's 0.25).
  for (const L5 of [[exp(1)], [exp(1, { at: ago(1), outcome: 'pass' }), exp(2)], [exp(1, { at: ago(20), outcome: 'pass' })]]) {
    const diagnostic = computeOverviewDiagnostic(layered(L5));
    const g = gradeWhy({ diagnostic, run: null, letter: diagnostic.overall.instrumentGrade.letter, score: diagnostic.overall.audit.scorePctExact, now: NOW });
    assert.equal(g.why.length, 7, `the list adds up to the letter (${diagnostic.overall.audit.scorePctExact}%)`);
  }
});

// ---------- criteria a service is not graded on ----------
//
// A service may switch grade criteria off (its record's gradeOff): the board
// grades it over the others and says so. The promises at the bar make the
// seven lines add up (3 + 0.85 + 1 of 7); with Chaos-validated off the same
// lines are 4.85 of 6.
const OFF = [{ key: 'chaos-validated', reason: 'No fault injection here', by: 'ada', at: '2026-11-10T09:00:00.000Z' }];
const atBarRun = { ...run, traceability: { ...run.traceability, integrityPct: 85 } };
const SIX_SCORE = 4.85 / 6 * 100;
const offRun = { ...atBarRun, grade: { ...atBarRun.grade, score: SIX_SCORE, letter: instrumentGradeFor(SIX_SCORE).letter, letterLabel: instrumentGradeFor(SIX_SCORE).label, off: ['chaos-validated'] } };

test('criteria a service is not graded on: each line names its criterion; the ones off leave the lines and the points and are listed with why, who and when; a run that graded on other criteria is not the letter', () => {
  // Every line names its criterion — what the board's switch acts on.
  const all = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: diagnosticFull, run: atBarRun, journey, now: NOW }));
  assert.deepEqual(all.why.map((w) => w.key).sort(), [...GRADE_CRITERION_KEYS].sort());
  assert.deepEqual(all.why.find((w) => w.key === 'chaos-validated'), { ok: 'no', text: 'No chaos experiment is declared — the repository scan cannot detect chaos tooling.', key: 'chaos-validated', label: 'Chaos-validated' });
  assert.ok(!('criteria' in all) && !('notGraded' in all) && !('switches' in all), 'nothing off: the model is what it was');

  // Chaos-validated off, and a run that graded without it.
  const six = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: diagnosticFull, run: offRun, journey, now: NOW, off: OFF }));
  assert.deepEqual([six.letter, six.basis, six.criteria], [offRun.grade.letter, 'live', 'Graded on 6 of 7 criteria']);
  assert.equal(six.why.length, 6);
  assert.ok(!six.why.some((w) => w.key === 'chaos-validated'), 'the criterion left out is no reason for the letter');
  assert.equal(six.points, '4.9 of 6 points. A starts above 5.1.', 'the points and the next band are over six');
  assert.deepEqual(six.notGraded, [{ key: 'chaos-validated', label: 'Chaos-validated', text: 'Chaos-validated is not graded for this service: No fault injection here', by: 'ada, 10 Nov' }]);
  // Bare keys (no record's reason): listed without one.
  assert.deepEqual(gradeWhy({ diagnostic: diagnosticFull, run: offRun, letter: offRun.grade.letter, score: offRun.grade.score, now: NOW, off: ['chaos-validated'] }).notGraded,
    [{ key: 'chaos-validated', label: 'Chaos-validated', text: 'Chaos-validated is not graded for this service.', by: '' }]);
  // Two off: the engine's order, whatever the record's.
  const two = gradeWhy({ diagnostic: diagnosticFull, run: null, letter: 'D', score: NaN, now: NOW, off: [{ key: 'fresh', reason: 'b' }, { key: 'calibrated', reason: 'a' }] });
  assert.deepEqual([two.why.length, two.notGraded.map((x) => x.key), two.points.startsWith('2 of 5 points.')], [5, ['calibrated', 'fresh'], true]);
  // What names no criterion, or every one, switches nothing off.
  assert.ok(!('notGraded' in gradeWhy({ diagnostic: diagnosticFull, run: atBarRun, letter: 'B', score: 69, now: NOW, off: ['nope', 7, null] })));
  assert.equal(gradeWhy({ diagnostic: diagnosticFull, run: atBarRun, letter: 'B', score: 69, now: NOW, off: GRADE_CRITERION_KEYS }).why.length, 7, 'all seven named: ignored whole, as the engine does');

  // The run's letter is the board's only when it graded on the service's criteria.
  assert.equal(runGradesBoard(offRun, krystalinePack, OFF), true);
  assert.equal(runGradesBoard(offRun, krystalinePack, ['nope', 'chaos-validated']), true, 'by the criteria, not by how they are written');
  assert.equal(runGradesBoard(offRun, krystalinePack), false, 'the run left one out that the service now grades');
  assert.equal(runGradesBoard(atBarRun, krystalinePack, OFF), false, 'the run graded one the service has switched off');
  assert.equal(runGradesBoard(atBarRun, krystalinePack), true);
  const changed = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: diagnosticFull, run: atBarRun, journey, now: NOW, off: OFF }));
  assert.deepEqual([changed.basis, changed.source, changed.criteria, changed.notGraded.length],
    ['repository', 'Graded from the repository alone: the criteria graded here changed since the last live check. Check again to grade against live.', 'Graded on 6 of 7 criteria', 1]);
  assert.equal(changed.letter, 'C', 'the pack-alone letter, never the run\'s');
  assert.equal(keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: diagnosticFull, run: offRun, journey, now: NOW })).basis, 'repository', 'and the other way round');
  // Expert is handed the run's live read by the same rule.
  assert.deepEqual(boardComparison({ journey: keptJourney, run: offRun, catalog: [...packs, LIVE_ENTRY], pack: krystalinePack, off: OFF })?.packBId, LIVE_ENTRY.id);
  assert.equal(boardComparison({ journey: keptJourney, run: offRun, catalog: [...packs, LIVE_ENTRY], pack: krystalinePack }), null);
  // The pack-alone grade is computed with the same criteria off.
  const layered = { id: 'kx', meta: { name: 'kx', annotations: {} }, layers: { L1: [{ id: 'SLO-01', title: 'kx_availability', spec: { objective: 0.999 } }], L2: [], L5: [{ id: 'BASE-01', title: 'MTTD / MTTR baselines' }] } };
  const alone = computeOverviewDiagnostic(layered, null, { off: OFF });
  assert.deepEqual([alone.overall.off, alone.overall.total, alone.trust.criteria.find((c) => c.key === 'chaos-validated').applies], [['chaos-validated'], 6, false]);
  assert.deepEqual([computeOverviewDiagnostic(layered).overall.total, 'off' in computeOverviewDiagnostic(layered).overall], [7, false]);
});

test('the board switches a criterion: only where the host wires it; the ask in place and a reason required; the criteria off listed with a way back; a reader who may not switch is told why; the simple layout lists them and switches nothing', () => {
  const withOff = services.map((x) => (x.id === 1 ? { ...x, gradeOff: OFF } : x));
  const full = { diagnostic: diagnosticFull, run: atBarRun };
  // Opt-in: a host that does not wire the switch draws none.
  const plain = keep(board(full));
  assert.ok(!('switches' in plain.grade));
  const none = overviewContainer();
  renderOverview(none, plain, { overview: {} });
  assert.ok(!none.innerHTML.includes('ov-gw__switch') && !none.innerHTML.includes('ov-grade__criteria') && !none.innerHTML.includes('ov-gw-off__h'));

  const on = keep(board({ ...full, gradeSwitches: true }));
  assert.deepEqual(on.grade.switches, { enabled: true, reason: null });
  const c = overviewContainer();
  const calls = [];
  const host = { overview: { setGradeCriterion: (...a) => calls.push(a), explain: (r) => calls.push(['explain', r]) } };
  renderOverview(c, on, host);
  assert.equal(countOf(c.innerHTML, 'data-ux-action="ov-grade-ask"'), 7, 'one switch a criterion');
  assert.ok(c.innerHTML.includes('<button type="button" class="ov-gw__switch" data-ux-action="ov-grade-ask" data-key="chaos-validated" aria-label="Stop grading Chaos-validated for this service">Not for this service…</button>'));
  assert.equal(countOf(c.innerHTML, 'og-btn--primary'), primariesOf(on), 'the switches add no primary button');
  // The ask, in place: the reason is required.
  c.click('ov-grade-ask', { key: 'chaos-validated' });
  assert.ok(c.innerHTML.includes('<span class="ov-gw__ask-l">Why is Chaos-validated not graded for this service?</span><input class="og-input" data-grade-reason="chaos-validated" value="" maxlength="200"'));
  assert.ok(c.innerHTML.includes('data-ux-action="ov-grade-off" data-key="chaos-validated">Stop grading it</button><button type="button" class="og-btn og-btn--text" data-ux-action="ov-grade-ask-cancel">Cancel</button>'));
  assert.ok(/<details[^>]*class="[^"]*ov-grade__why[^"]*"[^>]*open/.test(c.innerHTML) || /ov-grade__why[^>]*open/.test(c.innerHTML), 'the reasons stay open for the ask');
  c.click('ov-grade-off', { key: 'chaos-validated' });
  assert.deepEqual(calls, [], 'no reason typed (the shim has no field): nothing is switched');
  assert.ok(c.innerHTML.includes('data-grade-reason="chaos-validated"'), 'and the ask stays');
  c.click('ov-grade-ask-cancel');
  assert.ok(!c.innerHTML.includes('data-grade-reason'), 'Cancel puts it away');
  // A reason typed: trimmed, handed to the host with the criterion.
  c.click('ov-grade-ask', { key: 'chaos-validated' });
  c.querySelector = (sel) => (sel === '[data-grade-reason]' ? { value: '  No fault injection here  ', dataset: { gradeReason: 'chaos-validated' }, addEventListener() {}, focus() {}, setAttribute() {} } : null);
  c.click('ov-grade-off', { key: 'chaos-validated' });
  assert.deepEqual(calls, [['chaos-validated', { graded: false, reason: 'No fault injection here' }]]);

  // With one off: the note, the list, the way back.
  const off = keep(board({ services: withOff, diagnostic: diagnosticFull, run: offRun, gradeSwitches: true }));
  assert.deepEqual([off.grade.criteria, off.grade.notGraded.length, off.grade.why.length], ['Graded on 6 of 7 criteria', 1, 6]);
  const c2 = overviewContainer();
  renderOverview(c2, off, host);
  const html = c2.innerHTML;
  assert.ok(html.includes('<div class="ov-grade__criteria og-muted">Graded on 6 of 7 criteria</div>'));
  assert.ok(html.includes('<span class="ov-status__part ov-status__part--criteria">on 6 of 7 criteria</span>'), 'the status strip says it beside the source');
  assert.ok(html.includes('<p class="ov-gw-off__h og-muted">Not graded for this service</p>'));
  assert.ok(html.includes('<span class="ov-gw__text">Chaos-validated is not graded for this service: No fault injection here <span class="ov-gw__by og-muted">ada, 10 Nov</span></span><button type="button" class="ov-gw__switch" data-ux-action="ov-grade-on" data-key="chaos-validated" aria-label="Grade Chaos-validated for this service again">Grade it again</button>'));
  assert.equal(countOf(html, 'data-ux-action="ov-grade-ask"'), 6);
  calls.length = 0;
  c2.click('ov-grade-on', { key: 'chaos-validated' });
  assert.deepEqual(calls, [['chaos-validated', { graded: true }]]);

  // A reader who may not switch: the same words, explaining why when pressed.
  const viewer = keep(board({ services: withOff, diagnostic: diagnosticFull, run: offRun, gradeSwitches: true, access: { canWrite: false, reason: 'needs the operator role in Acme — yours is viewer' } }));
  assert.deepEqual(viewer.grade.switches, { enabled: false, reason: 'needs the operator role in Acme — yours is viewer' });
  const c3 = overviewContainer();
  renderOverview(c3, viewer, host);
  assert.ok(!c3.innerHTML.includes('data-ux-action="ov-grade-ask"') && !c3.innerHTML.includes('data-ux-action="ov-grade-on"'));
  assert.ok(c3.innerHTML.includes('data-ux-action="ov-explain" aria-disabled="true" data-reason="needs the operator role in Acme — yours is viewer" title="needs the operator role in Acme — yours is viewer" aria-label="Grade Chaos-validated for this service again">Grade it again</button>'));
  // The simple layout: what is off is listed, nothing is switched there.
  const simple = keep(screen({ services: withOff, diagnostic: diagnosticFull, run: offRun, gradeSwitches: true }));
  const c4 = overviewContainer();
  renderOverview(c4, simple, host);
  assert.ok(c4.innerHTML.includes('Graded on 6 of 7 criteria') && c4.innerHTML.includes('Not graded for this service') && !c4.innerHTML.includes('ov-gw__switch'));
  // No service with a pack of its own: no switch to offer.
  assert.ok(!('switches' in (screen({ serviceId: 999, gradeSwitches: true, pending: true }).grade || {})));
});

test('the service list names a letter over fewer criteria where it names the grade, and one graded before the service\'s criteria changed', () => {
  const lastRun = { startedAt: lastRunAt, outcome: 'pass', alignmentPct: 91.6, gradeScore: 88 };
  const offOf = (keys) => keys.map((key) => ({ key, reason: 'r', by: 'ada', at: '2026-11-10T09:00:00.000Z' }));
  const rowOf = (over, serviceOff = over.gradeOff || []) => serviceListModel({ services: [svcRow({ gradeOff: offOf(serviceOff.filter((k) => k !== 'nope')) })], servicesStatus: { kind: 'ok' }, journeys: [listJourney('checkout.prod', { service: 'checkout', env: 'prod' }, { ...lastRun, ...over })], endpoints: [EP], now: NOW }).rows[0];
  assert.equal(rowOf({}).last.gradeLabel, 'Diagnostic grade');
  assert.equal(rowOf({ gradeOff: [] }).last.gradeLabel, 'Diagnostic grade');
  assert.equal(rowOf({ gradeOff: ['chaos-validated'] }).last.gradeLabel, 'Diagnostic grade · on 6 of 7 criteria');
  assert.equal(rowOf({ gradeOff: ['chaos-validated', 'calibrated', 'nope'] }).last.gradeLabel, 'Diagnostic grade · on 5 of 7 criteria');
  // The letter of a run graded on other criteria than the service's now: said, both ways.
  assert.equal(rowOf({}, ['chaos-validated']).last.gradeLabel, "Diagnostic grade · graded before this service's criteria changed");
  assert.equal(rowOf({ gradeOff: ['chaos-validated'] }, []).last.gradeLabel, "Diagnostic grade · on 6 of 7 criteria · graded before this service's criteria changed");
  assert.equal(serviceListModel({ services: [svcRow()], servicesStatus: { kind: 'ok' }, journeys: [listJourney('checkout.prod', { service: 'checkout', env: 'prod' }, lastRun)], endpoints: [EP], now: NOW }).rows[0].last.gradeLabel, 'Diagnostic grade', 'a record of no switches and a run of none: as before');
  const c = overviewContainer();
  renderServiceList(c, serviceListModel({ services: [svcRow({ gradeOff: offOf(['chaos-validated']) })], servicesStatus: { kind: 'ok' }, journeys: [listJourney('checkout.prod', { service: 'checkout', env: 'prod' }, { ...lastRun, gradeOff: ['chaos-validated'] })], endpoints: [EP], now: NOW }), formModel(FORM_CLOSED), { overview: {} });
  assert.ok(c.innerHTML.includes('aria-label="Grade A" title="Diagnostic grade · on 6 of 7 criteria">A</span>'));
});

test('the board\'s switch where the reasons are not offered: the criteria graded, by name, each with its switch; a recording\'s source line does not say to check against live; a reason being typed keeps its focus and caret through a repaint', () => {
  const withOff = services.map((x) => (x.id === 1 ? { ...x, gradeOff: OFF } : x));
  // A run whose drift was scored on the diff buckets: the reasons are withheld, the switches are not.
  const bucketRun = { ...atBarRun, grade: { ...atBarRun.grade, driftConstruct: 'diff-buckets' } };
  const m = keep(board({ diagnostic: diagnosticFull, run: bucketRun, gradeSwitches: true }));
  assert.deepEqual([m.grade.why.length, m.grade.graded.map((x) => x.key)], [0, GRADE_CRITERION_KEYS]);
  const c = overviewContainer();
  const calls = [];
  renderOverview(c, m, { overview: { setGradeCriterion: (...a) => calls.push(a) } });
  assert.ok(c.innerHTML.includes('The criteria graded'), 'the disclosure says what it holds');
  assert.ok(c.innerHTML.includes('<p class="ov-gw-off__h og-muted">Graded for this service</p><ul class="ov-gw-list ov-gw-list--plain ov-gw-list--open"><li class="ov-gw ov-gw--plain"><span class="ov-gw__text">Multi-modal</span><button type="button" class="ov-gw__switch" data-ux-action="ov-grade-ask" data-key="multi-modal" aria-label="Stop grading Multi-modal for this service">Not for this service…</button></li>'));
  assert.equal(countOf(c.innerHTML, 'data-ux-action="ov-grade-ask"'), 7);
  c.click('ov-grade-ask', { key: 'chaos-validated' });
  assert.ok(c.innerHTML.includes('Why is Chaos-validated not graded for this service?'), 'the ask, in place, as on a reason');
  c.click('ov-grade-ask-cancel');
  // One off, the reasons withheld: six by name, the one off below with its way back.
  const m6 = keep(board({ services: withOff, diagnostic: diagnosticFull, run: { ...offRun, grade: { ...offRun.grade, driftConstruct: 'diff-buckets' } }, gradeSwitches: true }));
  assert.deepEqual([m6.grade.graded.length, m6.grade.notGraded.length], [6, 1]);
  // Without the switch wired, nothing new is drawn when the reasons are withheld.
  const plain = overviewContainer();
  renderOverview(plain, keep(board({ diagnostic: diagnosticFull, run: bucketRun })), { overview: {} });
  assert.ok(!plain.innerHTML.includes('ov-gw-list--plain') && !plain.innerHTML.includes('The criteria graded'));

  // A recording: the criteria changed, and there is no check against live to ask for.
  const rec = keep(gradeModel({ pack: krystalinePack, how: 'primary', diagnostic: diagnosticFull, run: atBarRun, journey: fileJourney, now: NOW, off: OFF }));
  assert.equal(rec.source, 'Graded from the repository alone: the criteria graded here changed since the last check.');

  // The reason being typed: a repaint keeps its focus and caret. The shim's page answers with the
  // field as it was before a draw replaces the markup, and with the new one after.
  const field = (over = {}) => ({ value: '', dataset: { gradeReason: 'chaos-validated' }, addEventListener() {}, setAttribute() {}, focus(o) { this.focused = o; }, setSelectionRange(a, b) { this.range = [a, b]; }, ...over });
  const pageOf = () => {
    const page = overviewContainer();
    let html = '';
    const state = { before: null, after: null, swapped: false };
    Object.defineProperty(page, 'innerHTML', { get: () => html, set: (v) => { html = v; state.swapped = true; }, configurable: true });
    page.querySelector = (sel) => (sel === '[data-grade-reason]' ? (state.swapped ? state.after : state.before) : null);
    const draw = (model, before, after) => { Object.assign(state, { before, after, swapped: false }); renderOverview(page, model, host); };
    return { page, draw };
  };
  const host = { overview: { setGradeCriterion() {} } };
  const doc = {};
  const { page, draw } = pageOf();
  draw(m, null, null);
  page.click('ov-grade-ask', { key: 'chaos-validated' });
  const typed = field({ value: 'No fault', selectionStart: 3, selectionEnd: 5, ownerDocument: doc });
  doc.activeElement = typed;
  const again = field();
  draw(m, typed, again);
  assert.deepEqual([again.focused, again.range], [{ preventScroll: true }, [3, 5]], 'the new field takes the focus and the caret');
  // Not focused before the repaint: the new field takes nothing.
  doc.activeElement = null;
  const idle = field();
  draw(m, field({ ownerDocument: doc }), idle);
  assert.deepEqual([idle.focused, idle.range], [undefined, undefined]);
});


// ---------- the service list: Overview's front door ----------

const EP = { id: 7, name: 'prod-mcp', origin: 'https://mcp.example.test' };
const svcRow = (over = {}) => ({
  id: 1, slug: 'checkout', name: 'Checkout', owners: [], tier: null, description: null,
  repository: { kind: 'github', location: 'https://github.com/acme/checkout', ref: null },
  source: { kind: 'observogram' }, createdAt: 't', updatedAt: 't',
  environments: [{ id: 11, serviceId: 1, name: 'prod', mcpEndpoint: { id: EP.id, name: EP.name, origin: EP.origin } }],
  packs: [], ...over,
});
const lastRunAt = new Date(NOW - 2 * HOUR).toISOString();
const listJourney = (name, scope, lastRun, packA = '/w/packs/x.pack.yaml') => ({ name, scope, packA, packB: 'mcp: https://mcp.example.test/mcp', lastRun });

test('repositoryLine: GitHub as owner/repo with its branch, Azure DevOps as project/repo, a folder by its name with its path beneath; nothing → null', () => {
  assert.deepEqual(repositoryLine({ kind: 'github', location: 'https://github.com/acme/checkout', ref: 'develop' }),
    { kind: 'github', kindText: 'GitHub', text: 'acme/checkout', ref: 'develop', detail: 'develop', title: 'https://github.com/acme/checkout (develop)' });
  assert.deepEqual(repositoryLine({ kind: 'ado', location: 'https://dev.azure.com/acme/My%20Shop/_git/checkout', ref: null }),
    { kind: 'ado', kindText: 'Azure DevOps', text: 'My Shop/checkout', ref: null, detail: null, title: 'https://dev.azure.com/acme/My%20Shop/_git/checkout' });
  assert.deepEqual(repositoryLine({ kind: 'path', location: 'C:\\src\\shop\\checkout', ref: null }),
    { kind: 'path', kindText: 'Folder', text: 'checkout', ref: null, detail: 'C:\\src\\shop\\checkout', title: 'C:\\src\\shop\\checkout' });
  assert.equal(repositoryLine(null), null);
  assert.equal(repositoryLine({ kind: 'github' }), null);
  assert.deepEqual(REPOSITORY_KINDS.map((k) => k.kind), ['github', 'ado', 'path', 'upload'], 'Upload is offered only by a host that wires it (the uploads option of formModel)');
});

test('serviceListModel: one row per service and environment with its two places and its last check; what is missing says so; the rows a person can run first', () => {
  const services = [
    svcRow(),
    svcRow({ id: 2, slug: 'basket', name: 'Basket', repository: null, packs: [{ id: 'uploaded-basket-1', role: 'primary' }], environments: [{ id: 21, name: 'prod', mcpEndpoint: null }] }),
    svcRow({ id: 3, slug: 'kx-wallet', name: 'kx-wallet', repository: null, packs: [{ id: 'uploaded-live-1', role: 'member' }], environments: [{ id: 31, name: 'prod', mcpEndpoint: null }] }),
    svcRow({ id: 4, slug: 'ledger', name: 'Ledger', environments: [] }),
    svcRow({ id: 5, slug: 'search', name: 'Search', environments: [{ id: 51, name: 'prod', mcpEndpoint: null }, { id: 52, name: 'staging', mcpEndpoint: { id: 7, name: 'prod-mcp', origin: EP.origin } }] }),
  ];
  const catalog = [{ id: 'uploaded-basket-1', ok: true }, { id: 'uploaded-live-1', ok: true, live: 'scaffold' }];
  const journeys = [
    listJourney('checkout.prod', { service: 'checkout', env: 'prod' }, { startedAt: lastRunAt, outcome: 'gate-failed', alignmentPct: 75.4, gradeScore: 70 }),
    listJourney('search.staging', { service: 'search', env: 'staging' }, { startedAt: lastRunAt, outcome: 'vantage-lost', alignmentPct: null, gradeScore: null }),
  ];
  const m = serviceListModel({ services, servicesStatus: { kind: 'ok' }, catalog, isLiveAggregatePack, journeys, endpoints: [EP], now: NOW });
  assert.equal(m.kind, 'list');
  assert.equal(m.hidden, 1, 'kx-wallet — a live draft\'s member, no repository — is counted, not drawn');
  assert.deepEqual(m.rows.map((r) => [r.key, r.complete]), [['1:prod', true], ['5:staging', true], ['2:prod', false], ['4:', false], ['5:prod', false]]);
  const [checkout, searchStaging, basket, ledger, searchProd] = m.rows;
  assert.deepEqual(checkout.repository.text, 'acme/checkout');
  assert.deepEqual(checkout.live, { id: 7, name: 'prod-mcp', origin: 'https://mcp.example.test' });
  assert.deepEqual(checkout.last, { state: 'checked', word: 'Checked 2 hours ago', ago: '2 hours ago', letter: 'B', tone: 'warn', gradeLabel: 'Industrial grade', alignmentPct: 75.4, gate: 'fail' });
  assert.deepEqual(checkout.run, { enabled: true, reason: null, running: false });
  assert.equal(checkout.journey, 'checkout.prod');
  assert.deepEqual([searchStaging.last.state, searchStaging.last.word, searchStaging.last.letter], ['unreachable', 'Unreachable', null]);
  assert.deepEqual([basket.run.enabled, basket.run.reason, basket.open.enabled], [false, "Say where Basket's repository is first.", true], 'its own pack opens the board');
  assert.deepEqual([ledger.env, ledger.run.reason, ledger.last.word], [null, 'Add an environment to Ledger first.', 'Never checked']);
  assert.deepEqual([searchProd.run.reason, searchProd.journey], ['Choose the live MCP endpoint for prod first.', null], 'a check of staging is not prod\'s');
  // showAll draws the hidden one; running and a refusal ride on their row.
  const all = serviceListModel({ services, servicesStatus: { kind: 'ok' }, catalog, isLiveAggregatePack, journeys, endpoints: [EP], now: NOW, showAll: true,
    running: { '1:prod': true }, results: { '5:staging': { error: '502: the live side did not answer' } } });
  assert.equal(all.hidden, 0);
  assert.ok(all.rows.some((r) => r.name === 'kx-wallet'));
  assert.deepEqual(all.rows[0].run, { enabled: false, reason: null, running: true });
  assert.equal(all.rows.find((r) => r.key === '5:staging').error, '502: the live side did not answer');
  // The rank: every Run explains the role.
  const viewer = serviceListModel({ services, servicesStatus: { kind: 'ok' }, catalog, isLiveAggregatePack, journeys, endpoints: [EP], now: NOW, access: { canWrite: false, reason: 'needs the operator role in Acme — yours is viewer' } });
  assert.deepEqual([viewer.canWrite, viewer.rows[0].run.enabled, viewer.rows[0].run.reason], [false, false, 'needs the operator role in Acme — yours is viewer']);
  // No percentage in a string: the renderer writes the sign.
  const strings = [];
  const walk = (v) => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(all);
  assert.deepEqual(strings.filter((x) => x.includes('%')), []);
  // Not read yet, could not be read, an empty table.
  assert.equal(serviceListModel({ services: null, servicesStatus: { kind: 'loading' } }).kind, 'loading');
  assert.deepEqual([serviceListModel({ services: null, servicesStatus: { kind: 'error', error: '500: boom' } }).kind, serviceListModel({ services: null, servicesStatus: { kind: 'error', error: '500: boom' } }).error], ['error', '500: boom']);
  assert.deepEqual([serviceListModel({ services: [], servicesStatus: { kind: 'ok' } }).empty, rowKey(9, null)], [true, '9:']);
  // The journeys listing failed: every row says so, never "never checked".
  assert.equal(serviceListModel({ services, servicesStatus: { kind: 'ok' }, catalog, isLiveAggregatePack, journeysError: '500: x', endpoints: [EP], now: NOW }).rows[0].last.word, 'Not known');
});

test('the form: opened blank or on a row; typing keeps its values; what is missing; the model it draws; the save plan completes a record, never a second one', () => {
  const services = [svcRow()];
  // Opened blank: prod, GitHub, the one endpoint chosen; none → a new one; several → choose.
  const blank = formOpened(services, { endpoints: [EP] });
  assert.deepEqual([blank.open, blank.mode, blank.envFixed, blank.values], [true, 'add', false, { name: '', env: 'prod', kind: 'github', location: '', ref: '', endpointId: '7', epName: '', epUrl: '', epToken: '' }]);
  assert.equal(formOpened(services, { endpoints: [] }).values.endpointId, NEW_ENDPOINT);
  assert.equal(formOpened(services, { endpoints: [EP, { ...EP, id: 8 }] }).values.endpointId, '');
  // Opened on a row: its service and environment, the environment fixed.
  const edit = formOpened(services, { serviceId: 1, env: 'prod', endpoints: [EP, { ...EP, id: 8 }] });
  assert.deepEqual([edit.mode, edit.serviceId, edit.envFixed, edit.values.name, edit.values.location, edit.values.endpointId], ['edit', 1, true, 'Checkout', 'https://github.com/acme/checkout', '7']);
  assert.equal(formOpened(services, { serviceId: 1, env: null }).envFixed, false, 'a service with no environment yet: the environment is typed');
  // Typing.
  const typed = formInput({ ...blank, error: 'x' }, 'name', 'Basket');
  assert.deepEqual([typed.values.name, typed.error], ['Basket', null]);
  assert.equal(formInput(blank, 'nope', 'x'), blank, 'an unknown field changes nothing');
  assert.equal(formInput(FORM_CLOSED, 'name', 'x'), FORM_CLOSED);
  // What is missing.
  assert.deepEqual(formProblems(blank.values), { name: 'Name the service.', location: "Give the repository's address." });
  assert.deepEqual(formProblems({ ...blank.values, name: 'B', kind: 'path', location: ' ', endpointId: NEW_ENDPOINT }), {
    location: "Give the folder's full path on the server.", epUrl: "Give the MCP endpoint's URL.", epName: 'Name the endpoint.',
  });
  // The model.
  const fm = formModel({ ...edit, focus: 'location' }, { endpoints: [EP], register: { allowed: false, why: 'MCP endpoints cannot be registered here' } });
  assert.deepEqual([fm.open, fm.title, fm.nameFixed, fm.envFixed, fm.focus, fm.kind.kind], [true, 'Checkout · prod', true, true, 'location', 'github']);
  assert.deepEqual(fm.kinds.map((k) => [k.kind, k.selected]), [['github', true], ['ado', false], ['path', false]]);
  assert.deepEqual(fm.endpoints, [{ id: '7', name: 'prod-mcp', origin: 'https://mcp.example.test', selected: true }]);
  assert.deepEqual(fm.newEndpoint, { allowed: false, reason: 'MCP endpoints cannot be registered here', selected: false });
  assert.deepEqual(formModel(FORM_CLOSED), { open: false });
  // The save plan: a new service, an endpoint by id, its environment created.
  const fresh = savePlan({ ...blank.values, name: 'Basket', location: 'acme/basket', ref: 'main' }, { services });
  assert.deepEqual(fresh, { endpoint: { id: 7 }, service: { create: { name: 'Basket', repository: { kind: 'github', location: 'acme/basket', ref: 'main' } } }, env: { create: { name: 'prod' } }, upload: null, envName: 'prod', name: 'Basket' });
  // A name that keys an existing record completes it: the repository patched when it differs, the environment bound when it does not point there yet.
  const same = savePlan({ ...edit.values }, { services, serviceId: 1 });
  assert.deepEqual([same.service, same.env], [{ id: 1, patch: null }, { id: 11, bind: false }], 'nothing differs: no patch, no bind');
  const moved = savePlan({ ...edit.values, name: 'CHECKOUT', location: 'acme/checkout-v2', endpointId: '8' }, { services });
  assert.deepEqual([moved.service, moved.env], [{ id: 1, patch: { repository: { kind: 'github', location: 'acme/checkout-v2' } } }, { id: 11, bind: true }]);
  const staging = savePlan({ ...edit.values, env: 'staging' }, { services, serviceId: 1 });
  assert.deepEqual(staging.env, { create: { name: 'staging' } });
  const newEp = savePlan({ ...blank.values, name: 'B', location: 'a/b', endpointId: NEW_ENDPOINT, epName: ' live ', epUrl: ' https://mcp.example.test/mcp ', epToken: 'OBSERVOGRAM_ORG_DEFAULT_MCP_TOKEN' }, { services });
  assert.deepEqual(newEp.endpoint, { create: { name: 'live', url: 'https://mcp.example.test/mcp', readTokenEnv: 'OBSERVOGRAM_ORG_DEFAULT_MCP_TOKEN' } });
});

test('renderServiceList: the rows, one primary button (Add a service, or Save and run with the form open), the names escaped, the actions proxied; a headless host never throws', () => {
  const services = [svcRow({ name: 'Check<img onerror=x>out' }), svcRow({ id: 4, slug: 'ledger', name: 'Ledger', environments: [] })];
  const journeys = [listJourney('checkout.prod', { service: 'checkout', env: 'prod' }, { startedAt: lastRunAt, outcome: 'pass', alignmentPct: 91.6, gradeScore: 88 })];
  const list = serviceListModel({ services, servicesStatus: { kind: 'ok' }, journeys, endpoints: [EP], now: NOW });
  const c = overviewContainer();
  const calls = [];
  const host = { overview: { addService: () => calls.push(['add']), runService: (k) => calls.push(['run', k]), editService: (id, env) => calls.push(['edit', id, env]), openService: (id, env) => calls.push(['open', id, env]), compare: () => calls.push(['compare']) } };
  renderServiceList(c, list, formModel(FORM_CLOSED), host);
  const html = c.innerHTML;
  assert.equal(countOf(html, 'og-btn--primary'), 1, 'one primary: Add a service');
  assert.ok(html.includes('Add a service</button>'));
  assert.ok(html.includes('Check&lt;img onerror=x&gt;out') && !html.includes('<img'), 'the name is escaped');
  assert.ok(html.includes('<span class="ov-svc__letter ov-tone-ok" aria-label="Grade A" title="Diagnostic grade">A</span><span class="ov-svc__last-text"><b>Checked 2 hours ago</b><small>92% matches live</small></span>'), 'the letter and the match, the sign the renderer\'s');
  assert.ok(html.includes('data-ux-action="ov-svc-run" data-key="1:prod"'));
  assert.ok(html.includes('data-ux-action="ov-explain" aria-disabled="true" data-reason="Add an environment to Ledger first."'), 'a row that cannot run explains why');
  assert.ok(html.includes('Upload one or compare two instead'), 'the host offers packs in hand');
  c.click('ov-svc-run', { key: '1:prod' });
  c.click('ov-svc-add');
  c.click('ov-svc-edit', { service: '4', env: '' });
  c.click('ov-svc-open', { service: '1', env: 'prod' });
  assert.deepEqual(calls, [['run', '1:prod'], ['add'], ['edit', 4, null], ['open', 1, 'prod']]);
  // The form open: Save and run is the one primary; Add a service steps aside.
  const f = formModel({ ...formOpened(services, { endpoints: [EP] }), error: 'Some answers are missing — each is marked where it goes.' }, { endpoints: [EP] });
  const c2 = overviewContainer();
  renderServiceList(c2, list, f, host);
  assert.equal(countOf(c2.innerHTML, 'og-btn--primary'), 1);
  assert.ok(c2.innerHTML.includes('>Save and run</button>') && !c2.innerHTML.includes('>Add a service</button>'));
  assert.ok(c2.innerHTML.includes('<span class="ov-form__err">Name the service.</span>'), 'after a try, each missing answer is marked');
  assert.ok(c2.innerHTML.includes('placeholder="https://github.com/owner/repo"'));
  // Without a compare hook, no line offering one; a headless host never throws.
  const c3 = overviewContainer();
  assert.doesNotThrow(() => renderServiceList(c3, list, formModel(FORM_CLOSED), { overview: {} }));
  assert.ok(!c3.innerHTML.includes('compare two instead'));
  assert.doesNotThrow(() => renderServiceList(overviewContainer(), serviceListModel({ services: null, servicesStatus: { kind: 'loading' } }), formModel(FORM_CLOSED), {}));
});

// ---------- Browse…: the Folder answer picked on the server ----------

const ROOT_LISTING = { ok: true, allowed: true, why: null, bounded: true, limit: 500, path: null, up: null, repository: false, folders: [{ name: '/srv/src', path: '/srv/src', repository: false }], truncated: false };
const SRC_LISTING = {
  ok: true, allowed: true, why: null, bounded: true, limit: 500, path: '/srv/src', up: { path: null }, repository: false, truncated: false,
  folders: [{ name: 'checkout', path: '/srv/src/checkout', repository: true }, { name: 'docs<b>', path: '/srv/src/docs<b>', repository: false }],
};
const FOLDERS_OK = { allowed: true, why: null };
const pathForm = (over = {}) => ({ ...formOpened([svcRow()], { endpoints: [EP] }), ...over, values: { ...formOpened([svcRow()], { endpoints: [EP] }).values, kind: 'path', ...(over.values || {}) } });

test('Browse…: offered only on the Folder answer, with the `folders` fact, when the server takes a folder from this reader and the reader may save; the server\'s reason replaces the hint when it will not; a host that passes no fact draws the form as before', () => {
  const none = { offered: false, open: false, hint: null, panel: null };
  assert.deepEqual(formModel(pathForm()).browse, none, 'no fact: nothing changes');
  assert.deepEqual(formModel(pathForm(), { folders: FOLDERS_OK }).browse, { ...none, offered: true });
  assert.deepEqual(formModel(pathForm({ values: { kind: 'github' } }), { folders: FOLDERS_OK }).browse, none, 'GitHub and Azure DevOps are typed');
  assert.deepEqual(formModel(pathForm(), { folders: FOLDERS_OK, access: { canWrite: false, reason: 'Operators save services.' } }).browse, none, 'a reader who cannot save is offered nothing');
  const refused = formModel(pathForm(), { folders: { allowed: false, why: 'a folder is read on the server, so it is taken only under the folders listed in OBSERVOGRAM_REPO_ROOTS' } }).browse;
  assert.deepEqual(refused, { ...none, hint: 'A folder is read on the server, so it is taken only under the folders listed in OBSERVOGRAM_REPO_ROOTS.' });
  assert.deepEqual(formModel(pathForm(), { folders: { allowed: false, why: null } }).browse, none);
});

test('Browse…: the steps every host takes — where it opens, a folder asked for (the last listing kept meanwhile), the answer, a refusal as one sentence, Use this folder, Close, a change of kind', () => {
  assert.equal(folderBrowseStart({ kind: 'path', location: ' /srv/src/checkout ' }), '/srv/src/checkout');
  assert.equal(folderBrowseStart({ kind: 'path', location: 'C:\\src\\shop' }), 'C:\\src\\shop');
  assert.equal(folderBrowseStart({ kind: 'path', location: '\\\\fileserver\\src' }), '\\\\fileserver\\src');
  assert.equal(folderBrowseStart({ kind: 'path', location: 'src/shop' }), null, 'not a full path: the top');
  assert.equal(folderBrowseStart({ kind: 'github', location: '/srv/src' }), null);
  assert.equal(folderBrowseStart({}), null);

  const opening = folderBrowseOpening(pathForm({ focus: 'location' }), null);
  assert.deepEqual([opening.browse, opening.focus], [{ loading: true, asked: null, listing: null, error: null }, null]);
  const top = folderBrowseListed(opening, ROOT_LISTING);
  assert.deepEqual(top.browse, { loading: false, asked: null, error: null, listing: { path: null, up: null, bounded: true, repository: false, folders: [{ name: '/srv/src', path: '/srv/src', repository: false }], truncated: false, limit: 500 } });
  assert.equal(top.focus, 'folders');
  const again = folderBrowseOpening(top, ' /srv/src ');
  assert.deepEqual([again.browse.loading, again.browse.asked, again.browse.listing], [true, '/srv/src', top.browse.listing], 'the last listing stays on screen while the next is read');
  const src = folderBrowseListed(again, SRC_LISTING);
  assert.deepEqual(src.browse.listing.up, { path: null });

  const failed = folderBrowseFailed(folderBrowseOpening(src, '/srv/src/nope'), new Error('404: there is no folder "/srv/src/nope" on the server'));
  assert.deepEqual([failed.browse.loading, failed.browse.error, failed.browse.listing], [false, 'There is no folder "/srv/src/nope" on the server.', src.browse.listing]);
  assert.equal(folderBrowseListed(opening, { ...ROOT_LISTING, allowed: false, why: 'a folder is read on the server' }).browse.error, 'A folder is read on the server.', 'a refusal at the top is a failure');
  assert.equal(folderBrowseListed(opening, null).browse.error, 'The server does not list folders here.');

  const chosen = folderBrowseChosen({ ...src, error: 'x' }, '/srv/src/checkout');
  assert.deepEqual([chosen.values.kind, chosen.values.location, chosen.browse, chosen.focus, chosen.error], ['path', '/srv/src/checkout', null, 'location', null]);
  assert.equal(folderBrowseChosen(src, '  '), src, 'no path: nothing chosen');
  assert.deepEqual([folderBrowseClosed(src).browse, folderBrowseClosed(src).focus], [null, 'location']);
  assert.equal(formInput(src, 'kind', 'github').browse, null, 'a change of kind closes the panel');
  assert.equal(formInput(src, 'location', '/x').browse, src.browse, 'typing keeps it');
  // A closed form is never changed; the answer of a closed panel is dropped.
  for (const step of [(f) => folderBrowseOpening(f, '/x'), (f) => folderBrowseListed(f, SRC_LISTING), (f) => folderBrowseFailed(f, 'x'), (f) => folderBrowseChosen(f, '/x'), folderBrowseClosed]) {
    assert.equal(step(FORM_CLOSED), FORM_CLOSED);
  }
  const closed = folderBrowseClosed(src);
  assert.equal(folderBrowseListed(closed, SRC_LISTING), closed);
});

test('Browse…: the panel the model draws — the top of a bounded server, a folder with Up, the repositories, the cap, an empty folder, a refusal with a way back to the top', () => {
  const model = (form) => formModel(form, { folders: FOLDERS_OK }).browse.panel;
  const reading = model(folderBrowseOpening(pathForm(), null));
  assert.deepEqual(reading, { loading: true, error: null, title: 'Folders on the server', path: null, up: null, folders: [], empty: false, note: '', here: '', choose: { enabled: false, path: '' }, restart: false });
  const top = model(folderBrowseListed(folderBrowseOpening(pathForm(), null), ROOT_LISTING));
  assert.deepEqual([top.title, top.up, top.choose, top.folders.length], ['The folders this server reads repositories from', null, { enabled: false, path: '' }, 1], 'the top of a bounded server: nothing to use, no Up');
  const srcForm = folderBrowseListed(folderBrowseOpening(pathForm(), '/srv/src'), SRC_LISTING);
  const src = model(srcForm);
  assert.deepEqual([src.title, src.path, src.up, src.choose, src.here], ['/srv/src', '/srv/src', { path: '' }, { enabled: true, path: '/srv/src' }, ''], 'Up from a listed folder is the top (path \'\')');
  assert.deepEqual(src.folders.map((f) => [f.name, f.repository]), [['checkout', true], ['docs<b>', false]]);
  assert.equal(model(folderBrowseOpening(srcForm, '/srv/src/checkout')).choose.enabled, false, 'nothing to use while the next folder is read');
  const repo = model(folderBrowseListed(folderBrowseOpening(srcForm, '/srv/src/checkout'), { ...SRC_LISTING, path: '/srv/src/checkout', up: { path: '/srv/src' }, repository: true, folders: [] }));
  assert.deepEqual([repo.here, repo.empty, repo.up], ['This folder is a repository.', true, { path: '/srv/src' }]);
  assert.equal(model(folderBrowseListed(srcForm, { ...SRC_LISTING, truncated: true, limit: 2 })).note, 'Only the first 2 folders are listed: type the rest of the path to go further.');
  const failed = model(folderBrowseFailed(folderBrowseOpening(pathForm(), '/srv/gone'), '404: there is no folder "/srv/gone" on the server'));
  assert.deepEqual([failed.error, failed.restart, failed.empty], ['There is no folder "/srv/gone" on the server.', true, false]);
  assert.equal(model(folderBrowseFailed(folderBrowseOpening(pathForm(), null), 'no answer')).restart, false, 'the top failed: no top to go back to');
});

test('renderServiceList: Browse… beside the Folder answer and its panel — names escaped, the repositories marked, Up, Use this folder and Close proxied to host.overview, still one primary; nothing drawn without the fact', () => {
  const list = serviceListModel({ services: [svcRow()], servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW });
  const calls = [];
  const host = { overview: {
    browseFolders: () => calls.push(['browse']), openFolder: (p) => calls.push(['open', p]),
    chooseFolder: (p) => calls.push(['choose', p]), closeFolders: () => calls.push(['close']),
  } };
  const c = overviewContainer();
  renderServiceList(c, list, formModel(pathForm(), { endpoints: [EP], folders: FOLDERS_OK }), host);
  assert.ok(c.innerHTML.includes('<button type="button" class="og-btn ov-form__browse" data-ux-action="ov-form-browse" aria-expanded="false" aria-controls="ov-folders">Browse…</button>'));
  assert.ok(c.innerHTML.includes('A folder the server can read: its full path on the server.'));
  c.click('ov-form-browse');

  const open = folderBrowseListed(folderBrowseOpening(pathForm(), '/srv/src'), SRC_LISTING);
  const c2 = overviewContainer();
  renderServiceList(c2, list, formModel(open, { endpoints: [EP], folders: FOLDERS_OK }), host);
  const html = c2.innerHTML;
  assert.equal(countOf(html, 'og-btn--primary'), 1, 'Save and run stays the one primary');
  assert.ok(html.includes('aria-expanded="true"'));
  assert.ok(html.includes('<div class="ov-folders" id="ov-folders" role="group" aria-label="Folders on the server">'));
  assert.ok(html.includes('data-ux-action="ov-folders-open" data-path="" aria-label="Up one folder">'), 'Up to the top');
  assert.ok(html.includes('<span class="ov-folders__path" title="/srv/src"><bdi>/srv/src</bdi></span>'));
  assert.ok(html.includes('data-path="/srv/src/checkout" title="/srv/src/checkout">') && html.includes('<span class="ov-folders__name">checkout</span><span class="og-pill ov-folders__repo">repository</span>'));
  assert.ok(html.includes('<span class="ov-folders__name">docs&lt;b&gt;</span>') && !html.includes('docs<b>'), 'a folder name is escaped');
  assert.ok(html.includes('data-ux-action="ov-folders-choose" data-path="/srv/src">Use this folder</button>'));
  assert.ok(!html.includes('Start from the top'));
  c2.click('ov-folders-open', { path: '/srv/src/checkout' });
  c2.click('ov-folders-open', { path: '' });
  c2.click('ov-folders-choose', { path: '/srv/src' });
  c2.click('ov-folders-close');
  assert.deepEqual(calls, [['browse'], ['open', '/srv/src/checkout'], ['open', null], ['choose', '/srv/src'], ['close']]);

  // Reading: aria-busy, the folders and Up disabled; a refusal: the sentence and a way back.
  const c3 = overviewContainer();
  renderServiceList(c3, list, formModel(folderBrowseOpening(open, '/srv/src/checkout'), { endpoints: [EP], folders: FOLDERS_OK }), host);
  assert.ok(c3.innerHTML.includes('aria-busy="true"') && c3.innerHTML.includes('role="status">Reading the folder…</p>'));
  assert.ok(c3.innerHTML.includes('aria-label="Up one folder" disabled>'));
  const c4 = overviewContainer();
  renderServiceList(c4, list, formModel(folderBrowseFailed(folderBrowseOpening(open, '/srv/gone'), '404: there is no folder "/srv/gone" on the server'), { endpoints: [EP], folders: FOLDERS_OK }), host);
  assert.ok(c4.innerHTML.includes('<p class="ov-folders__error" role="alert">There is no folder &quot;/srv/gone&quot; on the server.</p>'));
  assert.ok(c4.innerHTML.includes('data-ux-action="ov-folders-open" data-path="">Start from the top</button>'));

  // The server will not take a folder here: no Browse…, its reason as the hint.
  const c5 = overviewContainer();
  renderServiceList(c5, list, formModel(pathForm(), { endpoints: [EP], folders: { allowed: false, why: 'list the folder in OBSERVOGRAM_REPO_ROOTS' } }), host);
  assert.ok(!c5.innerHTML.includes('Browse…') && c5.innerHTML.includes('List the folder in OBSERVOGRAM_REPO_ROOTS.'));
  // No fact, or a host without the hooks: the form as before, and nothing throws.
  const c6 = overviewContainer();
  renderServiceList(c6, list, formModel(pathForm(), { endpoints: [EP] }), host);
  assert.ok(!c6.innerHTML.includes('Browse…') && !c6.innerHTML.includes('ov-folders'));
  assert.doesNotThrow(() => { const c7 = overviewContainer(); renderServiceList(c7, list, formModel(open, { endpoints: [EP], folders: FOLDERS_OK }), { overview: {} }); c7.click('ov-folders-choose', { path: '/srv/src' }); });
});

test('loadServiceListFacts: `folders` from the top of GET /api/repository-folders — allowed and why, null when the server has no listing or refuses the reader; loadRepositoryFolders asks for a folder by ?path=', async () => {
  const asked = [];
  const fetchWith = (folders) => async (path) => {
    asked.push(path);
    if (path === '/api/journeys') return { journeys: [] };
    if (path === '/api/mcp-endpoints') return { endpoints: [], policy: { register: { allowed: true } } };
    if (path.startsWith('/api/repository-folders')) return folders();
    throw new Error(`unexpected ${path}`);
  };
  assert.deepEqual((await loadServiceListFacts({ fetchFn: fetchWith(() => SRC_LISTING) })).folders, { allowed: true, why: null });
  assert.deepEqual((await loadServiceListFacts({ fetchFn: fetchWith(() => ({ ...ROOT_LISTING, allowed: false, why: 'not here' })) })).folders, { allowed: false, why: 'not here' });
  assert.equal((await loadServiceListFacts({ fetchFn: fetchWith(() => { throw new Error('404: no answer'); }) })).folders, null, 'an older server');
  assert.equal((await loadServiceListFacts({ fetchFn: fetchWith(() => ({ ok: true })) })).folders, null, 'a body with no answer');
  assert.ok(asked.includes('/api/repository-folders'));
  const paths = [];
  await loadRepositoryFolders('C:\\src\\shop', { fetchFn: async (p) => { paths.push(p); return {}; } });
  await loadRepositoryFolders(null, { fetchFn: async (p) => { paths.push(p); return {}; } });
  assert.deepEqual(paths, ['/api/repository-folders?path=C%3A%5Csrc%5Cshop', '/api/repository-folders']);
});

test('buildOverviewModel with listable: the service header links back to the list; without it, nothing changes', () => {
  const base = { services, servicesStatus: { kind: 'ok' }, catalog: packs, isLiveAggregatePack, diagnostic, decision, journeys, run, now: NOW };
  assert.equal(buildOverviewModel({ ...base, listable: true }).back, true);
  assert.equal(buildOverviewModel(base).back, false);
  const c = overviewContainer();
  const calls = [];
  renderOverview(c, buildOverviewModel({ ...base, listable: true }), { overview: { backToList: () => calls.push('back') } });
  assert.ok(c.innerHTML.includes('data-ux-action="ov-back"'));
  c.click('ov-back');
  assert.deepEqual(calls, ['back']);
  const c2 = overviewContainer();
  renderOverview(c2, buildOverviewModel(base), { overview: {} });
  assert.ok(!c2.innerHTML.includes('ov-back'));
});

// ---------- Upload: the repository from the person's own machine ----------

const UPLOADED_AT = new Date(NOW - 2 * 24 * HOUR).toISOString();
const uploadRow = () => svcRow({ id: 5, slug: 'ledger', name: 'Ledger', repository: { kind: 'upload', location: 'ledger-main.zip', ref: null, uploadedAt: UPLOADED_AT, files: 12, bytes: 4096 } });
const READ = { name: 'shop-main', files: { 'shop-main/prometheus/rules.yaml': 'groups: []\n', 'shop-main/otel/collector.yaml': 'receivers: {}\n' }, bytes: 2.5 * 1024 * 1024, skipped: [{ path: 'shop-main/logo.yaml', why: 'it is not UTF-8 text' }], ignored: 40, truncated: false };

test('Upload is offered only by a host that wires it (uploads); its row says what was uploaded and when; a form on an upload remembers it', () => {
  const blank = formOpened([svcRow()], { endpoints: [EP] });
  assert.deepEqual(formModel(blank).kinds.map((k) => k.kind), ['github', 'ado', 'path'], 'no uploads option: the form as before');
  assert.deepEqual(formModel(blank, { uploads: true }).kinds.map((k) => k.kind), ['github', 'ado', 'path', 'upload']);
  assert.deepEqual(repositoryLine(uploadRow().repository, { now: NOW }), { kind: 'upload', kindText: 'Upload', text: 'ledger-main.zip', ref: null, detail: 'uploaded 2 days ago · 12 files', title: `ledger-main.zip, uploaded ${UPLOADED_AT}` });
  const row = serviceListModel({ services: [uploadRow()], servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW }).rows[0];
  assert.deepEqual([row.repository.kindText, row.repository.detail, row.run.enabled], ['Upload', 'uploaded 2 days ago · 12 files', true], 'an uploaded repository runs like any other');
  const edit = formOpened([uploadRow()], { serviceId: 5, env: 'prod', endpoints: [EP] });
  assert.deepEqual([edit.values.kind, edit.values.location, edit.uploaded, edit.upload], ['upload', 'ledger-main.zip', { name: 'ledger-main.zip', uploadedAt: UPLOADED_AT, files: 12 }, null]);
  assert.deepEqual(formModel(edit, { now: NOW }).kinds.map((k) => k.kind), ['github', 'ado', 'path', 'upload'], 'a host without uploads still shows the kind a record has');
  assert.deepEqual(formModel(edit, { uploads: true, now: NOW }).upload, { offered: true, state: 'kept', error: null, note: '', text: 'ledger-main.zip · uploaded 2 days ago · 12 files. Choose again to replace it.' });
  assert.equal(formModel(edit, { now: NOW }).upload.offered, false, 'without uploads: the words, no buttons');
  assert.equal(formModel(edit, { uploads: true, access: { canWrite: false }, now: NOW }).upload.offered, false, 'a reader who cannot save is offered nothing');
});

test('Upload\'s steps: a change of kind swaps the location (an upload\'s is its name, never an address); reading, staged with what was not read, a read that failed; what is missing; the save plan uploads last and never names the repository', () => {
  const opened = formOpened([svcRow()], { endpoints: [EP] });
  const blank = { ...opened, values: { ...opened.values, name: 'Shop', location: 'acme/shop' } };
  const toUpload = formInput(blank, 'kind', 'upload');
  assert.deepEqual([toUpload.values.kind, toUpload.values.location], ['upload', ''], 'the address is not an upload\'s name');
  assert.deepEqual(formProblems(toUpload.values).location, 'Choose a folder or a .zip to upload.');
  assert.deepEqual(formModel(toUpload, { uploads: true }).upload, { offered: true, state: 'empty', error: null, note: '', text: 'Choose the folder, or a .zip of it, from your machine.' });

  const reading = uploadReading(toUpload, 'shop-main.zip');
  assert.deepEqual([reading.upload, formModel(reading, { uploads: true }).upload.text], [{ reading: 'shop-main.zip' }, 'Reading shop-main.zip…']);
  const staged = uploadStaged(reading, READ);
  assert.deepEqual([staged.values.location, staged.upload.staged.count, staged.focus], ['shop-main', 2, 'upload']);
  assert.deepEqual(formModel(staged, { uploads: true }).upload, {
    offered: true, state: 'staged', error: null,
    text: 'shop-main · 2 files · 2.5 MB — uploaded when you save.',
    note: '1 not read: shop-main/logo.yaml (it is not UTF-8 text)',
  });
  assert.deepEqual(formProblems(staged.values), {}, 'staged: nothing missing');
  assert.match(formModel(uploadStaged(reading, { ...READ, bytes: 3000 }), { uploads: true }).upload.text, / · 3 KB — /, 'a small upload in KB, never "0 MB"');
  assert.equal(formModel(uploadStaged(reading, { ...READ, truncated: true, skipped: [] }), { uploads: true }).upload.note, 'it stops at 15 MB: upload only the folder the scan needs');
  const empty = uploadStaged(reading, { name: 'docs', files: {} });
  assert.deepEqual([empty.upload.error, formModel(empty, { uploads: true }).upload.state], ['Docs holds no file the scan reads — Prometheus rules, collector configs, dashboards, compose files, Helm values or metrics code.', 'failed']);
  const failed = uploadFailed(reading, new Error('this .zip is a ZIP64 archive (over 4 GB or 65,535 entries), which is not read: zip only the folder the scan needs'));
  assert.equal(formModel(failed, { uploads: true }).upload.error, 'This .zip is a ZIP64 archive (over 4 GB or 65,535 entries), which is not read: zip only the folder the scan needs.');
  assert.equal(formInput(staged, 'kind', 'github').values.location, '', 'leaving Upload: its name is no address');
  assert.equal(formInput(formInput(staged, 'kind', 'github'), 'kind', 'upload').values.location, 'shop-main', 'and back: the staged name again');
  for (const step of [(f) => uploadReading(f, 'x'), (f) => uploadStaged(f, READ), (f) => uploadFailed(f, 'x')]) assert.equal(step(FORM_CLOSED), FORM_CLOSED);

  const plan = savePlan(staged.values, { services: [svcRow()], upload: staged.upload.staged });
  assert.deepEqual([plan.service, plan.upload], [{ create: { name: 'Shop' } }, { name: 'shop-main', files: READ.files, skipped: READ.skipped }], 'created with no repository; the upload points it at its copy, and names what was not read');
  const kept = formOpened([uploadRow()], { serviceId: 5, env: 'prod', endpoints: [EP] });
  const keptPlan = savePlan(kept.values, { services: [uploadRow()], serviceId: 5 });
  assert.deepEqual([keptPlan.service, keptPlan.upload], [{ id: 5, patch: null }, null], 'nothing new chosen: nothing patched, nothing sent');
  const moved = savePlan({ ...kept.values, kind: 'github', location: 'acme/ledger' }, { services: [uploadRow()], serviceId: 5 });
  assert.deepEqual([moved.service.patch, moved.upload], [{ repository: { kind: 'github', location: 'acme/ledger' } }, null], 'pointed elsewhere: a PATCH, as before');
});

test('renderServiceList: Upload\'s block in place of the address — the two buttons and the drop words, the state as the model words it, the hooks proxied, still one primary; without the hooks offered, the words alone', () => {
  const list = serviceListModel({ services: [svcRow()], servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW });
  const calls = [];
  const host = { overview: { pickRepositoryFolder: () => calls.push('folder'), pickRepositoryZip: () => calls.push('zip'), dropRepository: () => calls.push('drop') } };
  const staged = uploadStaged(uploadReading(formInput(formOpened([svcRow()], { endpoints: [EP] }), 'kind', 'upload'), 'shop-main.zip'), READ);
  const c = overviewContainer();
  renderServiceList(c, list, formModel(staged, { endpoints: [EP], uploads: true }), host);
  const html = c.innerHTML;
  assert.equal(countOf(html, 'og-btn--primary'), 1, 'Save and run stays the one primary');
  assert.ok(html.includes('<div class="ov-form__upload ov-form__upload--staged" data-upload-drop="on">'));
  assert.ok(html.includes('data-ux-action="ov-form-upload-folder">Choose a folder</button>') && html.includes('data-ux-action="ov-form-upload-zip">Choose a .zip</button>'));
  assert.ok(html.includes('>shop-main · 2 files · 2.5 MB — uploaded when you save.</span>'));
  assert.ok(html.includes('<span class="ov-form__upload-note og-muted">1 not read: shop-main/logo.yaml (it is not UTF-8 text)</span>'));
  assert.ok(!html.includes('data-field="location"') && !html.includes('data-field="ref"'), 'no address and no branch for an upload');
  assert.ok(/data-kind="upload" aria-pressed="true">/.test(html), 'the Upload kind pressed');
  c.click('ov-form-upload-folder');
  c.click('ov-form-upload-zip');
  assert.deepEqual(calls, ['folder', 'zip']);
  const c2 = overviewContainer();
  renderServiceList(c2, list, formModel(uploadReading(staged, 'shop-main.zip'), { endpoints: [EP], uploads: true }), host);
  assert.ok(c2.innerHTML.includes('role="status" data-field-focus="upload" tabindex="-1">Reading shop-main.zip…</span>'), 'reading: the status');
  assert.ok(/data-ux-action="ov-form-upload-folder" disabled>/.test(c2.innerHTML), 'and no second pick while it reads');
  const c3 = overviewContainer();
  renderServiceList(c3, list, formModel(formOpened([uploadRow()], { serviceId: 5, env: 'prod', endpoints: [EP] }), { endpoints: [EP], now: NOW }), { overview: {} });
  assert.ok(!c3.innerHTML.includes('Choose a folder') && c3.innerHTML.includes('data-upload-drop="off"') && c3.innerHTML.includes('ledger-main.zip · uploaded 2 days ago · 12 files.'), 'no uploads: the words alone, no drop target');
});

// ---------- a repository read with the person's own token ----------

test('a Run its host would not read without the person\'s own token asks for it on the row; a refused one says so; the tokens held in the tab are named with a way to forget them; a reader who cannot run is never asked', () => {
  const services = [svcRow()];
  const ask = { kind: 'github', label: 'GitHub token', refused: false };
  const list = serviceListModel({ services, servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW, results: { '1:prod': { error: '404: the repository could not be read: …', repoAuth: ask } } });
  assert.deepEqual(list.rows[0].auth, { kind: 'github', label: 'GitHub token', refused: false, text: 'GitHub reads this repository with your own token. It is sent with this tab\'s Runs only and never kept on the server.' });
  const refused = serviceListModel({ services, servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW, results: { '1:prod': { error: 'x', repoAuth: { ...ask, refused: true } } } });
  assert.equal(refused.rows[0].auth.text, 'That GitHub token was refused, or cannot read this repository. Give one that can.');
  assert.equal(serviceListModel({ services, servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW, access: { canWrite: false }, results: { '1:prod': { error: 'x', repoAuth: ask } } }).rows[0].auth, null);
  assert.equal(serviceListModel({ services, servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW, results: { '1:prod': { error: 'x' } } }).rows[0].auth?.offered, true, 'an error that is no access question asks nothing: the row keeps the offer it starts with');
  const held = serviceListModel({ services, servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW, heldTokens: ['ado', 'nope'] });
  assert.deepEqual(held.tokens, [{ kind: 'ado', label: 'Azure DevOps token', text: 'Your Azure DevOps token is sent with this tab\'s Runs of Azure DevOps repositories; it is never kept on the server.' }]);
  assert.deepEqual(serviceListModel({ services, servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW }).tokens, []);
  assert.deepEqual(REPOSITORY_KINDS.slice(0, 2).map((k) => k.hint), [
    'A public repository, or a private one read with your own GitHub token.',
    'Read with your own Azure DevOps token (Code (Read)).',
  ], 'no hint says the server reads with its own token');
  // A server that offers Sign in to GitHub says so where the repository is typed.
  const hintFor = (kind, repoSignIn) => formModel({ ...formOpened([], { endpoints: [EP] }), values: { ...formOpened([], { endpoints: [EP] }).values, kind } }, { endpoints: [EP], repoSignIn }).kind.hint;
  assert.equal(hintFor('github', null), REPOSITORY_KINDS[0].hint, 'no sign-in offered (or no one signed in to the studio): the token hint, as before');
  assert.equal(hintFor('github', { github: { available: false }, ado: { available: true } }), REPOSITORY_KINDS[0].hint);
  assert.equal(hintFor('github', { github: { available: true, signedIn: false, account: null } }),
    'A public repository, or a private one read as you: sign in to GitHub, or give your own GitHub token.');
  assert.equal(hintFor('github', { github: { available: true, signedIn: true, account: 'octo' } }),
    'A public repository, or a private one read as you: you are signed in to GitHub as octo.');
  assert.equal(hintFor('ado', { ado: { available: true } }), 'Read as you: sign in to Azure DevOps, or give your own token (Code (Read)).');
  assert.equal(hintFor('ado', { ado: { available: true, signedIn: true, account: null } }), 'Read as you: you are signed in to Azure DevOps. A repository on another Azure DevOps host takes your own token (Code (Read)).', 'signed in, no account known: the sign-in reads Azure DevOps Services only');
  assert.equal(hintFor('ado', { ado: { available: true, signedIn: true, account: 'ada@acme.test' } }), 'Read as you: you are signed in to Azure DevOps as ada@acme.test. A repository on another Azure DevOps host takes your own token (Code (Read)).');
  assert.equal(hintFor('path', { github: { available: true } }), REPOSITORY_KINDS[2].hint, 'a folder has no sign-in');
  const opened = formModel(formOpened([], { endpoints: [EP] }), { endpoints: [EP], repoSignIn: { github: { available: true } } });
  assert.equal(opened.kind.kind, 'github', 'a new service opens on GitHub');
  assert.equal(opened.kinds.find((k) => k.kind === 'github').hint, opened.kind.hint, 'the kind buttons carry the same hint');
  assert.match(opened.kind.hint, /sign in to GitHub/);
});

test('the token is offered on the row from the start: a GitHub or Azure DevOps repository with no token held in the tab and no sign-in to its host — never on a row that cannot run, is running, reads a folder, or whose host already has the person\'s token or sign-in; what the host answered the last Run wins', () => {
  const base = { servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW };
  const authOf = (over = {}, service = svcRow()) => serviceListModel({ ...base, services: [service], ...over }).rows[0].auth;
  const KEPT = 'sent with this tab\'s Runs only and never kept on the server';
  // Nothing run yet: the field is there, and says a public repository needs no token.
  assert.deepEqual(authOf(), { kind: 'github', label: 'GitHub token', refused: false, offered: true, text: `A private repository reads with your own GitHub token — ${KEPT}. A public one needs none.` });
  // The host offers sign-in here: Sign in first, then the token.
  assert.deepEqual(authOf({ repoSignIn: { github: { available: true, signedIn: false, account: null } } }),
    { kind: 'github', label: 'GitHub token', refused: false, offered: true, text: `A private repository reads as you: sign in to GitHub, or give your own token — ${KEPT}. A public one needs neither.`, signIn: { kind: 'github', label: 'Sign in to GitHub' } });
  // Already able to read as the person: nothing to give.
  assert.equal(authOf({ heldTokens: ['github'] }), null, 'the tab holds a token of that host');
  assert.equal(authOf({ repoSignIn: { github: { available: true, signedIn: true, account: 'ada-gh' } } }), null, 'signed in to the host');
  assert.equal(authOf({ heldTokens: ['ado'] })?.offered, true, 'another host\'s token is no help');
  // Azure DevOps: always the person's access; its sign-in reads Azure DevOps Services only.
  const ado = (location) => svcRow({ repository: { kind: 'ado', location, ref: null } });
  assert.deepEqual(authOf({}, ado('https://dev.azure.com/acme/Shop/_git/checkout')),
    { kind: 'ado', label: 'Azure DevOps token', refused: false, offered: true, text: `Azure DevOps reads this repository with your own token (Code (Read)) — ${KEPT}.` });
  const adoSignIn = { ado: { available: true, signedIn: false, account: null } };
  assert.deepEqual(authOf({ repoSignIn: adoSignIn }, ado('https://dev.azure.com/acme/Shop/_git/checkout')).signIn, { kind: 'ado', label: 'Sign in to Azure DevOps' });
  assert.deepEqual(authOf({ repoSignIn: adoSignIn }, ado('https://acme.visualstudio.com/Shop/_git/checkout')).signIn, { kind: 'ado', label: 'Sign in to Azure DevOps' });
  const server = authOf({ repoSignIn: adoSignIn }, ado('https://tfs.corp.example/DefaultCollection/Shop/_git/checkout'));
  assert.deepEqual([server.signIn, server.text], [undefined, `Azure DevOps reads this repository with your own token (Code (Read)) — ${KEPT}.`], 'an Azure DevOps Server repository: the token alone');
  assert.equal(authOf({ repoSignIn: adoSignIn }, ado('https://dev.azure.com.evil.example/a/b/_git/c')).signIn, undefined, 'a host that only starts like dev.azure.com is not it');
  // Not where it could not be used.
  assert.equal(authOf({ access: { canWrite: false } }), null, 'a reader who cannot run');
  assert.equal(authOf({ running: { '1:prod': true } }), null, 'while its Run is under way');
  assert.equal(authOf({}, svcRow({ environments: [{ id: 11, serviceId: 1, name: 'prod', mcpEndpoint: null }] })), null, 'no live endpoint yet: nothing to run');
  assert.equal(authOf({}, svcRow({ repository: { kind: 'path', location: '/srv/src/checkout', ref: null } })), null, 'a folder is read by the server');
  assert.equal(authOf({}, uploadRow()), null, 'an upload came from the person\'s machine');
  assert.equal(authOf({ sources: { github: false } }), null, 'a source switched off does not run');
  // What the host answered wins over the offer: the refusal's own words, no `offered`.
  const refused = authOf({ results: { '1:prod': { error: 'x', repoAuth: { kind: 'github', label: 'GitHub token', refused: true } } } });
  assert.deepEqual([refused.refused, refused.offered, refused.text], [true, undefined, 'That GitHub token was refused, or cannot read this repository. Give one that can.']);
});

test('renderServiceList: the offered field is on the row before any Run, and Run sends what it holds — nothing when it is empty', () => {
  const list = serviceListModel({ services: [svcRow()], servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW });
  const calls = [];
  const c = overviewContainer();
  renderServiceList(c, list, formModel(FORM_CLOSED), { overview: { runService: (...args) => calls.push(args) } });
  const html = c.innerHTML;
  assert.ok(html.includes('<div class="ov-svc__auth ov-svc__auth--offered" role="group" aria-label="Your GitHub token for Checkout">'), 'the field, marked as the offer');
  assert.ok(html.includes('<input class="og-input" type="password" data-auth-input="1:prod" autocomplete="one-time-code" spellcheck="false" aria-describedby="ov-auth-1-prod">'), 'a password field, nothing pre-filled');
  assert.ok(html.includes('A private repository reads with your own GitHub token — sent with this tab&#39;s Runs only and never kept on the server. A public one needs none.'));
  assert.ok(!html.includes('ov-svc__error'), 'and no error beside it: nothing has failed');
  assert.equal(countOf(html, 'og-btn--primary'), 1, 'still one primary: Add a service');
  // The shim's container has no field to read: Run goes as it always did, with no token.
  c.click('ov-svc-run', { key: '1:prod' });
  assert.deepEqual(calls, [['1:prod']], 'an empty field: Run reads the repository with none');
  // A field that holds a token: the row's own Run sends it, trimmed, as Run with it does.
  const filled = overviewContainer();
  filled.querySelector = (sel) => (sel === '[data-auth-input="1:prod"]' ? { value: '  made-up-token  ' } : null);
  const sent = [];
  renderServiceList(filled, list, formModel(FORM_CLOSED), { overview: { runService: (...args) => sent.push(args) } });
  filled.click('ov-svc-run', { key: '1:prod' });
  filled.click('ov-svc-auth-run', { key: '1:prod' });
  assert.deepEqual(sent, [['1:prod', { repoAuth: 'made-up-token' }], ['1:prod', { repoAuth: 'made-up-token' }]], 'Run and Run with it send the same');
  // A held token: the row has no field, the line above the list names it.
  const held = overviewContainer();
  renderServiceList(held, serviceListModel({ services: [svcRow()], servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW, heldTokens: ['github'] }), formModel(FORM_CLOSED), { overview: {} });
  assert.ok(!held.innerHTML.includes('ov-svc__auth') && held.innerHTML.includes('data-ux-action="ov-svc-forget-token" data-kind="github">Forget it</button>'));
});

test('the form offers the person\'s own token where a row would — GitHub (optional) and Azure DevOps; never a folder, an upload, a host whose token the tab holds or the person is signed in to, a source switched off, a reader who cannot save; and only for a host that passes heldTokens', () => {
  const open = (kind) => { const f = formOpened([], { endpoints: [EP] }); return { ...f, values: { ...f.values, kind } }; };
  const authOf = (kind, opts = {}) => formModel(open(kind), { endpoints: [EP], uploads: true, heldTokens: [], ...opts }).auth;
  assert.deepEqual(authOf('github'), { kind: 'github', label: 'GitHub token', optional: true, text: 'For a private repository. Sent with this tab\'s Runs only and never kept on the server.' });
  assert.deepEqual(authOf('ado'), { kind: 'ado', label: 'Azure DevOps token', optional: false, text: 'Sent with this tab\'s Runs only and never kept on the server.' });
  assert.equal(authOf('path'), null, 'a folder is read by the server');
  assert.equal(authOf('upload'), null, 'an upload is the person\'s own files');
  assert.equal(authOf('github', { heldTokens: ['github'] }), null, 'held in the tab: the line above the list names it');
  assert.equal(authOf('ado', { heldTokens: ['github'] }).kind, 'ado', 'another host\'s token is no use here');
  assert.equal(authOf('github', { repoSignIn: { github: { available: true, signedIn: true, account: 'octo' } } }), null, 'read as that account');
  assert.deepEqual(Object.keys(authOf('github', { repoSignIn: { github: { available: true, signedIn: false, account: null } } })), ['kind', 'label', 'optional', 'text', 'signIn'], 'sign-in offered, not signed in: the field, and Sign in before it');
  assert.equal(authOf('github', { sources: { github: false } }), null, 'a source switched off saves nothing new');
  assert.equal(authOf('github', { access: { canWrite: false, reason: 'needs the operator role' } }), null);
  assert.equal(authOf('github', { heldTokens: undefined }), null, 'a host that passes no heldTokens takes no token from the form: no field');
  assert.equal(formModel(open('github'), { endpoints: [EP] }).auth, null);
  // The form's values never hold it: nothing typed there is drawn back.
  assert.deepEqual(Object.keys(open('github').values), ['name', 'env', 'kind', 'location', 'ref', 'endpointId', 'epName', 'epUrl', 'epToken']);
  const opened = open('github');
  assert.equal(formInput(opened, 'repoAuth', 'made-up-token'), opened, 'and typing never reaches them: the field is no form value');
});

test('renderServiceList: the form\'s token field — a password input with nothing in it; Save and run and Save send what it holds, trimmed, and nothing when it is empty; a typed token outlives a redraw by the drafts handed over, never by the markup', () => {
  const list = serviceListModel({ services: [svcRow()], servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW });
  const form = formModel(formOpened([svcRow()], { endpoints: [EP] }), { endpoints: [EP], heldTokens: [] });
  const c = overviewContainer();
  const calls = [];
  renderServiceList(c, list, form, { overview: { saveService: (o) => calls.push(o) } });
  const html = c.innerHTML;
  assert.ok(html.includes('<label class="ov-form__f"><span class="ov-form__l">Your GitHub token <em>optional</em></span><input class="og-input" type="password" data-form-auth="github" autocomplete="one-time-code" spellcheck="false" aria-describedby="ov-form-auth-note"></label>'), 'a password field, nothing pre-filled');
  assert.ok(html.includes('<span class="ov-form__hint og-muted" id="ov-form-auth-note">For a private repository. Sent with this tab&#39;s Runs only and never kept on the server.</span>'));
  assert.ok(html.indexOf('data-field="location"') < html.indexOf('data-form-auth="github"') && html.indexOf('data-form-auth="github"') < html.indexOf('data-field="endpointId"'), 'under the address it reads, before Live');
  assert.equal(countOf(html, 'og-btn--primary'), 1, 'still one primary: Save and run');
  // The shim's container has no field to read: saved as it always was.
  c.click('ov-form-run');
  c.click('ov-form-save');
  assert.deepEqual(calls, [{ run: true }, { run: false }], 'an empty field sends no token');
  // A field that holds one: both buttons send it, trimmed.
  const filled = overviewContainer();
  filled.querySelector = (sel) => (sel === '[data-form-auth]' ? { value: '  made-up-token  ' } : null);
  const sent = [];
  renderServiceList(filled, list, form, { overview: { saveService: (o) => sent.push(o) } });
  filled.click('ov-form-run');
  filled.click('ov-form-save');
  assert.deepEqual(sent, [{ run: true, repoAuth: 'made-up-token' }, { run: false, repoAuth: 'made-up-token' }]);
  assert.ok(!filled.innerHTML.includes('made-up-token'), 'the view writes nothing typed');
  // Azure DevOps: not optional. No heldTokens passed: no field.
  const adoForm = formOpened([svcRow()], { endpoints: [EP] });
  const ado = overviewContainer();
  renderServiceList(ado, list, formModel({ ...adoForm, values: { ...adoForm.values, kind: 'ado' } }, { endpoints: [EP], heldTokens: [] }), { overview: {} });
  assert.ok(ado.innerHTML.includes('<span class="ov-form__l">Your Azure DevOps token</span><input class="og-input" type="password" data-form-auth="ado"'));
  const none = overviewContainer();
  renderServiceList(none, list, formModel(formOpened([svcRow()], { endpoints: [EP] }), { endpoints: [EP] }), { overview: {} });
  assert.ok(!none.innerHTML.includes('data-form-auth') && !none.innerHTML.includes('ov-form__auth'));

  // The drafts: what the fields hold, read before the page is cleared — a row's by its key, the form's by its host.
  const FIELDS = '[data-auth-input], [data-form-auth]';
  const field = (dataset, value, over = {}) => ({ dataset, value, selectionStart: value.length, selectionEnd: value.length, ...over });
  const doc = {};
  const typing = field({ formAuth: 'github' }, 'made-up-1', { selectionStart: 3, selectionEnd: 5, ownerDocument: doc });
  doc.activeElement = typing;
  const page = { querySelectorAll: (sel) => (sel === FIELDS ? [field({ authInput: '1:prod' }, 'made-up-2'), field({ authInput: '2:prod' }, ''), typing] : []) };
  const drafts = readTokenDrafts(page);
  assert.deepEqual(drafts, [
    { row: '1:prod', form: null, value: 'made-up-2', focused: false, start: 9, end: 9 },
    { row: null, form: 'github', value: 'made-up-1', focused: true, start: 3, end: 5 },
  ], 'an empty field that is not being typed in is no draft');
  assert.equal(readTokenDrafts(overviewContainer()), null, 'no field, no drafts');
  assert.equal(readTokenDrafts(null), null);
  // Handed to the next draw: each goes to the field drawn in its place, the caret where it was.
  const fresh = {
    row: { dataset: { authInput: '1:prod' }, value: '' },
    other: { dataset: { authInput: '3:prod' }, value: '' },
    form: { dataset: { formAuth: 'github' }, value: '', focus(o) { this.focused = o; }, setSelectionRange(a, b) { this.range = [a, b]; } },
  };
  const next = overviewContainer();
  next.querySelectorAll = (sel) => (sel === FIELDS ? Object.values(fresh) : []);
  renderServiceList(next, list, form, { overview: {} }, { drafts });
  assert.deepEqual([fresh.row.value, fresh.other.value, fresh.form.value, fresh.form.focused, fresh.form.range], ['made-up-2', '', 'made-up-1', { preventScroll: true }, [3, 5]]);
  assert.ok(!next.innerHTML.includes('made-up'), 'through the fields, never the markup');
  // A draft whose field is not drawn again is dropped: the form now asks for another host's, the row is gone.
  const other = { dataset: { formAuth: 'ado' }, value: '' };
  const changed = overviewContainer();
  changed.querySelectorAll = (sel) => (sel === FIELDS ? [other, fresh.other] : []);
  renderServiceList(changed, list, form, { overview: {} }, { drafts });
  assert.deepEqual([other.value, fresh.other.value], ['', '']);
  assert.doesNotThrow(() => renderServiceList(overviewContainer(), list, form, { overview: {} }, { drafts }), 'a page with no field takes none');
});

test('a row whose last scan read its repository with no access of the person\'s — none at all, or the server\'s own — is offered no field; one read with theirs, a record of another repository, or no record keeps it; a person signed in to Azure DevOps is still offered it off Azure DevOps Services', () => {
  const here = { kind: 'github', location: 'https://github.com/acme/checkout' };
  const ran = (access) => [listJourney('checkout.prod', { service: 'checkout', env: 'prod' }, { startedAt: lastRunAt, outcome: 'pass', alignmentPct: 91, gradeScore: 88, ...(access ? { repositoryAccess: access } : {}) })];
  const authOf = (journeys, over = {}, service = svcRow()) => serviceListModel({ services: [service], servicesStatus: { kind: 'ok' }, journeys, endpoints: [EP], now: NOW, ...over }).rows[0].auth;
  assert.equal(authOf(ran({ by: 'none', ...here })), null, 'a public repository: read with nothing');
  assert.equal(authOf(ran({ by: 'server', ...here })), null, 'a server without sign-in read it with its own');
  assert.equal(authOf(ran({ by: 'token', ...here })).offered, true, 'read with the person\'s token: a page read again needs it again');
  assert.equal(authOf(ran({ by: 'sign-in', ...here })).offered, true, 'read as an account no longer signed in');
  assert.equal(authOf(ran({ by: 'none', kind: 'github', location: 'https://github.com/acme/other' })).offered, true, 'the record is of another repository: the service was pointed elsewhere since');
  assert.equal(authOf(ran({ by: 'none', kind: 'ado', location: here.location })).offered, true);
  assert.equal(authOf(ran(null)).offered, true, 'a record from before the access was kept');
  assert.equal(authOf([]).offered, true, 'never run');
  assert.equal(serviceListModel({ services: [svcRow()], servicesStatus: { kind: 'ok' }, journeysError: '500: x', endpoints: [EP], now: NOW }).rows[0].auth.offered, true, 'the listing could not be read: nothing is known');
  // What the host answered the last Run still wins: a repository that stopped being public asks, as every row did.
  const asked = authOf(ran({ by: 'none', ...here }), { results: { '1:prod': { error: '404: the repository could not be read', repoAuth: { kind: 'github', label: 'GitHub token', refused: false } } } });
  assert.deepEqual([asked.refused, asked.offered, asked.text], [false, undefined, 'GitHub reads this repository with your own token. It is sent with this tab\'s Runs only and never kept on the server.']);
  // Signed in to Azure DevOps: the sign-in reads Azure DevOps Services only.
  const ado = (location) => svcRow({ repository: { kind: 'ado', location, ref: null } });
  const signedIn = { repoSignIn: { ado: { available: true, signedIn: true, account: 'ada@acme.test' } } };
  assert.equal(authOf([], signedIn, ado('https://dev.azure.com/acme/Shop/_git/checkout')), null, 'read as that account');
  const server = authOf([], signedIn, ado('https://tfs.corp.example/DefaultCollection/Shop/_git/checkout'));
  assert.deepEqual([server.offered, server.signIn, server.text], [true, undefined, 'Azure DevOps reads this repository with your own token (Code (Read)) — sent with this tab\'s Runs only and never kept on the server.'], 'a host the sign-in does not read: the token');
});

test('the form offers Sign in to … before the token where the host offers it, and its answers outlive a sign-in that takes the tab away: a draft of the form\'s values alone — never a token, never an upload\'s files — restored for a new service or one being changed, and nothing from a stale, foreign or broken one', () => {
  const open = (kind, location = '') => { const f = formOpened([], { endpoints: [EP] }); return { ...f, values: { ...f.values, kind, location } }; };
  const offered = { github: { available: true, signedIn: false, account: null }, ado: { available: true, signedIn: false, account: null } };
  const authOf = (kind, location = '', opts = {}) => formModel(open(kind, location), { endpoints: [EP], heldTokens: [], repoSignIn: offered, ...opts }).auth;
  assert.deepEqual(authOf('github'), {
    kind: 'github', label: 'GitHub token', optional: true, signIn: { kind: 'github', label: 'Sign in to GitHub' },
    text: 'For a private repository: sign in to GitHub to read it as you, or give your own token — sent with this tab\'s Runs only and never kept on the server.',
  });
  assert.deepEqual([authOf('ado').signIn, authOf('ado').text], [{ kind: 'ado', label: 'Sign in to Azure DevOps' }, 'Sign in to Azure DevOps to read it as you, or give your own token — sent with this tab\'s Runs only and never kept on the server.'], 'the address is still to be typed');
  assert.deepEqual(authOf('ado', 'https://dev.azure.com/acme/Shop/_git/checkout').signIn, { kind: 'ado', label: 'Sign in to Azure DevOps' });
  assert.equal(authOf('ado', 'https://tfs.corp.example/DefaultCollection/Shop/_git/checkout').signIn, undefined, 'an Azure DevOps Server address: the token alone');
  assert.equal(authOf('github', '', { repoSignIn: { github: { available: false } } }).signIn, undefined, 'the server offers none');
  assert.equal(authOf('github', '', { repoSignIn: { github: { available: true, signedIn: true, account: 'octo' } } }), null, 'signed in: nothing to give');
  // Drawn: the button, "or", the field; pressed, it asks the host with no row to run and the form named.
  const list = serviceListModel({ services: [svcRow()], servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW });
  const c = overviewContainer();
  const calls = [];
  renderServiceList(c, list, formModel(open('github'), { endpoints: [EP], heldTokens: [], repoSignIn: offered }), { overview: { signInRepoHost: (...args) => calls.push(args) } });
  assert.ok(c.innerHTML.includes('<button type="button" class="og-btn" data-ux-action="ov-form-sign-in" data-kind="github">Sign in to GitHub</button>\n                <span class="ov-form__auth-or og-muted">or</span>\n                <label class="ov-form__f"><span class="ov-form__l">Your GitHub token <em>optional</em></span>'), 'sign in first, then the token');
  assert.equal(countOf(c.innerHTML, 'og-btn--primary'), 1, 'still one primary: Save and run');
  c.click('ov-form-sign-in', { kind: 'github' });
  assert.deepEqual(calls, [['github', null, { fromForm: true }]]);
  const saving = overviewContainer();
  renderServiceList(saving, list, formModel({ ...open('github'), saving: true }, { endpoints: [EP], heldTokens: [], repoSignIn: offered }), { overview: {} });
  assert.ok(saving.innerHTML.includes('data-ux-action="ov-form-sign-in" data-kind="github" disabled>'), 'not while a save is under way');
  const plain = overviewContainer();
  renderServiceList(plain, list, formModel(open('github'), { endpoints: [EP], heldTokens: [] }), { overview: {} });
  assert.ok(!plain.innerHTML.includes('ov-form-sign-in') && !plain.innerHTML.includes('ov-form__auth-ways'), 'no sign-in offered: the field alone, as before');

  // The draft: the form's nine values and where it was opened from.
  const services = [svcRow()];
  let form = formOpened(services, { endpoints: [EP] });
  for (const [field, value] of Object.entries({ name: 'Basket', env: 'staging', kind: 'ado', location: 'https://dev.azure.com/acme/Shop/_git/basket', ref: 'develop' })) form = formInput(form, field, value);
  const draft = formDraft(form, { now: NOW });
  assert.deepEqual(draft, { v: 1, at: NOW, serviceId: null, env: null, values: form.values });
  assert.notEqual(draft.values, form.values, 'a copy');
  assert.deepEqual(Object.keys(draft.values), ['name', 'env', 'kind', 'location', 'ref', 'endpointId', 'epName', 'epUrl', 'epToken'], 'the form holds no token, so the draft cannot');
  assert.equal(formDraft(FORM_CLOSED), null);
  const back = formRestored(services, JSON.parse(JSON.stringify(draft)), { endpoints: [EP], now: NOW + 60_000 });
  assert.deepEqual([back.open, back.mode, back.serviceId, back.saving, back.error, back.values], [true, 'add', null, false, null, form.values]);
  // A service being changed comes back as that: its environment fixed, what it was saved as known.
  const edit = formInput(formOpened(services, { serviceId: 1, env: 'prod', endpoints: [EP] }), 'ref', 'release-2');
  const editDraft = formDraft(edit, { now: NOW });
  assert.deepEqual([editDraft.serviceId, editDraft.env], [1, 'prod']);
  const editBack = formRestored(services, editDraft, { endpoints: [EP], now: NOW });
  assert.deepEqual([editBack.mode, editBack.serviceId, editBack.envFixed, editBack.values.ref, editBack.original], ['edit', 1, true, 'release-2', edit.original]);
  // Nothing from a draft past its time, from the future, of a service that is gone, or that is no draft.
  assert.equal(formRestored(services, { ...draft, at: NOW - FORM_DRAFT_TTL_MS - 1 }, { now: NOW }), null);
  assert.ok(formRestored(services, { ...draft, at: NOW - FORM_DRAFT_TTL_MS }, { now: NOW }), 'at the limit it still is one');
  assert.equal(formRestored(services, { ...draft, at: NOW + 5 * 60_000 }, { now: NOW }), null);
  assert.equal(formRestored(services, { ...editDraft, serviceId: 99 }, { now: NOW }), null);
  assert.equal(formRestored(null, editDraft, { now: NOW }), null);
  for (const junk of [null, undefined, 'x', 7, [], {}, { v: 2, at: NOW, values: {} }, { v: 1, at: 'now', values: {} }]) assert.equal(formRestored(services, junk, { now: NOW }), null);
  // Field by field: only the form's own, only strings of a sane length, only a known kind.
  const odd = formRestored(services, { v: 1, at: NOW, serviceId: null, env: null, values: { name: 'Ok', kind: 'nope', location: 7, ref: 'x'.repeat(2049), repoAuth: 'made-up-token', extra: 'y' } }, { endpoints: [EP], now: NOW });
  assert.deepEqual([odd.values.name, odd.values.kind, odd.values.location, odd.values.ref, Object.hasOwn(odd.values, 'repoAuth'), Object.hasOwn(odd.values, 'extra')], ['Ok', 'github', '', '', false, false]);
  assert.deepEqual(formRestored(services, { v: 1, at: NOW, values: null }, { endpoints: [EP], now: NOW }).values, formOpened(services, { endpoints: [EP] }).values, 'no values: a fresh form');
  // An upload's files left with the page: a fresh form, nothing of the draft.
  const up = formRestored(services, { v: 1, at: NOW, serviceId: null, env: null, values: { ...form.values, kind: 'upload', location: 'shop.zip' } }, { endpoints: [EP], now: NOW });
  assert.deepEqual([up.values.kind, up.values.location, up.values.name, up.upload], ['github', '', '', null]);
});

test('every input of the studio that takes a token for another host is a password field marked autocomplete="one-time-code": measured in Chrome, "off" let its own store offer to keep what was typed and fill a saved sign-in into the field; "new-password" still offered to keep', () => {
  const dir = new URL('../studio/', import.meta.url);
  const found = {};
  for (const name of readdirSync(dir)) {
    if (!/\.(mjs|html)$/.test(name)) continue;
    const tags = readFileSync(new URL(name, dir), 'utf8').match(/<input\b[^>]*type="password"[^>]*>/g) || [];
    if (!tags.length) continue;
    found[name] = tags.length;
    for (const tag of tags) assert.ok(tag.includes(' autocomplete="one-time-code"'), `studio/${name}: ${tag.slice(0, 90)}`);
  }
  // The service list's two (a row's, the form's), Expert's four in the page and the one its home draws.
  // The MCP settings form builds its secret from a model of its own (studio/mcp-settings-model.mjs); the
  // sign-in pages are the server's (server/auth.mjs), where a password is a password.
  assert.deepEqual(found, { 'app.mjs': 1, 'index.html': 4, 'overview-view.mjs': 2 });
});

test('renderServiceList: the row\'s token field (a password input, Run with it) and the held-token line with Forget it; both proxied to host.overview; nothing typed is kept in the markup', () => {
  const services = [svcRow()];
  const list = serviceListModel({ services, servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW, heldTokens: ['github'], results: { '1:prod': { error: '404: the repository could not be read', repoAuth: { kind: 'github', label: 'GitHub token', refused: false } } } });
  const calls = [];
  const c = overviewContainer();
  renderServiceList(c, list, formModel(FORM_CLOSED), { overview: { runService: (key, opts) => calls.push(['run', key, opts]), forgetRepoToken: (kind) => calls.push(['forget', kind]) } });
  const html = c.innerHTML;
  assert.ok(html.includes('<div class="ov-svc__auth" role="group" aria-label="Your GitHub token for Checkout">'));
  assert.ok(html.includes('<input class="og-input" type="password" data-auth-input="1:prod" autocomplete="one-time-code" spellcheck="false" aria-describedby="ov-auth-1-prod">'), 'a password field, nothing pre-filled');
  assert.ok(html.includes('data-ux-action="ov-svc-auth-run" data-key="1:prod">Run with it</button>'));
  assert.ok(html.includes('Your GitHub token is sent with this tab&#39;s Runs of GitHub repositories; it is never kept on the server. <button type="button" class="ov-start__expert" data-ux-action="ov-svc-forget-token" data-kind="github">Forget it</button>'));
  assert.equal(countOf(html, 'og-btn--primary'), 1, 'still one primary: Add a service');
  c.click('ov-svc-auth-run', { key: '1:prod' });
  c.click('ov-svc-forget-token', { kind: 'github' });
  assert.deepEqual(calls, [['run', '1:prod', { repoAuth: '' }], ['forget', 'github']], 'the view reads the field when pressed (the shim has none) and keeps nothing');
});

test('the services client: a Run sends the person\'s token only when given; a refusal keeps the host\'s ask', async () => {
  const sent = [];
  const fetchFn = async (path, init) => { sent.push([path, JSON.parse(init.body)]); return { ok: true }; };
  await runServiceRecord(3, 'prod', { fetchFn });
  await runServiceRecord(3, 'prod', { fetchFn, repoAuth: 'ghp_x1234' });
  await runServiceRecord(3, null, { fetchFn });
  assert.deepEqual(sent, [['/api/services/3/run', { env: 'prod' }], ['/api/services/3/run', { env: 'prod', repoAuth: 'ghp_x1234' }], ['/api/services/3/run', {}]]);
  const e = servicesRefusal(404, { ok: false, error: 'the repository could not be read', repoAuth: { kind: 'ado', label: 'Azure DevOps token', refused: true } });
  assert.deepEqual([e.message, e.status, e.repoAuth], ['404: the repository could not be read', 404, { kind: 'ado', label: 'Azure DevOps token', refused: true }]);
  assert.equal(servicesRefusal(502, { ok: false, error: 'x' }).repoAuth, undefined);
});

// ---------- signing in to a repository host ----------

test('a host that offers sign-in: the row asks to sign in first, then for a token; a refused sign-in names the account, an ended one says so; the signed-in hosts are named with a way to sign out; a page that passes no repoSignIn is offered none', () => {
  const services = [svcRow()];
  const offered = { github: { available: true, signedIn: false, account: null }, ado: { available: false, signedIn: false, account: null } };
  const base = { services, servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW };
  const ask = { kind: 'github', label: 'GitHub token', refused: false, signIn: true };
  const asked = serviceListModel({ ...base, repoSignIn: offered, results: { '1:prod': { error: 'x', repoAuth: ask } } });
  assert.deepEqual(asked.rows[0].auth, {
    kind: 'github', label: 'GitHub token', refused: false, signIn: { kind: 'github', label: 'Sign in to GitHub' },
    text: 'GitHub shows this repository only to someone who can read it. Sign in to GitHub to run it as you, or give your own token: it is sent with this tab\'s Runs only and never kept on the server.',
  });
  assert.equal(serviceListModel({ ...base, results: { '1:prod': { error: 'x', repoAuth: ask } } }).rows[0].auth.signIn, undefined, 'no repoSignIn passed: no Sign in button, whatever the server offers');
  assert.equal(serviceListModel({ ...base, repoSignIn: offered, results: { '1:prod': { error: 'x', repoAuth: { ...ask, signIn: undefined } } } }).rows[0].auth.signIn.label, 'Sign in to GitHub', '/auth/me says GitHub offers it');
  assert.equal(serviceListModel({ ...base, repoSignIn: offered, results: { '1:prod': { error: 'x', repoAuth: { kind: 'ado', label: 'Azure DevOps token', refused: false } } } }).rows[0].auth.signIn, undefined, 'Azure DevOps offers none here');
  const adoOffered = { ...offered, ado: { available: true, signedIn: false, account: null } };
  const server = serviceListModel({ ...base, repoSignIn: adoOffered, results: { '1:prod': { error: 'x', repoAuth: { kind: 'ado', label: 'Azure DevOps token', refused: false, signIn: false } } } }).rows[0].auth;
  assert.deepEqual([server.signIn, server.text], [undefined, 'Azure DevOps reads this repository with your own token. It is sent with this tab\'s Runs only and never kept on the server.'], 'an Azure DevOps Server repository (signIn: false): the token only, though /auth/me offers the Azure DevOps sign-in');

  const cannot = serviceListModel({ ...base, repoSignIn: offered, results: { '1:prod': { error: 'x', repoAuth: { ...ask, refused: true, via: 'sign-in', account: 'ada-gh' } } } });
  assert.equal(cannot.rows[0].auth.text, 'You are signed in to GitHub as ada-gh, and that account cannot read this repository. Sign in as one that can, or give a token that can.');
  const ended = serviceListModel({ ...base, repoSignIn: offered, results: { '1:prod': { error: 'x', repoAuth: { ...ask, refused: true, via: 'sign-in', account: 'ada-gh', expired: true } } } });
  assert.equal(ended.rows[0].auth.text, 'Your GitHub sign-in has ended. Sign in to GitHub again, or give your own token.');
  assert.equal(serviceListModel({ ...base, repoSignIn: offered, results: { '1:prod': { error: 'x', repoAuth: { ...ask, refused: true } } } }).rows[0].auth.text,
    'That GitHub token was refused, or cannot read this repository. Give one that can. Or sign in to GitHub.');

  const signedIn = serviceListModel({ ...base, repoSignIn: { github: { available: true, signedIn: true, account: 'ada-gh' }, ado: { available: true, signedIn: true, account: null } } });
  assert.deepEqual(signedIn.accounts, [
    { kind: 'github', host: 'GitHub', account: 'ada-gh', text: 'Signed in to GitHub as ada-gh: your Runs of GitHub repositories read as that account in this browser.' },
    { kind: 'ado', host: 'Azure DevOps', account: null, text: 'Signed in to Azure DevOps: your Runs of Azure DevOps repositories read as that account in this browser.' },
  ]);
  assert.deepEqual(serviceListModel(base).accounts, []);
  assert.deepEqual(serviceListModel({ ...base, services: null }).accounts, [], 'the loading list says the same');
});

test('renderServiceList: Sign in to … before the token field and Sign out of … beside the held tokens, both proxied to host.overview with the row and the host; still one primary', () => {
  const list = serviceListModel({
    services: [svcRow()], servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW, heldTokens: ['ado'],
    repoSignIn: { github: { available: true, signedIn: true, account: 'ada-gh' }, ado: { available: false, signedIn: false, account: null } },
    results: { '1:prod': { error: '404: the repository could not be read', repoAuth: { kind: 'github', label: 'GitHub token', refused: true, signIn: true, via: 'sign-in', account: 'ada-gh' } } },
  });
  const calls = [];
  const c = overviewContainer();
  renderServiceList(c, list, formModel(FORM_CLOSED), { overview: { signInRepoHost: (kind, key) => calls.push(['in', kind, key]), signOutRepoHost: (kind) => calls.push(['out', kind]) } });
  const html = c.innerHTML;
  assert.ok(html.includes('aria-label="Your GitHub token for Checkout">\n          <button type="button" class="og-btn" data-ux-action="ov-svc-sign-in" data-kind="github" data-key="1:prod">Sign in to GitHub</button>\n          <span class="ov-svc__auth-or og-muted">or</span>\n          <label'), 'sign in first, then the token');
  assert.ok(html.includes('Signed in to GitHub as ada-gh: your Runs of GitHub repositories read as that account in this browser. <button type="button" class="ov-start__expert" data-ux-action="ov-svc-sign-out" data-kind="github">Sign out of GitHub</button>'));
  assert.ok(html.includes('data-ux-action="ov-svc-forget-token" data-kind="ado">Forget it</button>'), 'a typed token\'s line beside it');
  assert.equal(countOf(html, 'class="ov-svcs__tokens"'), 1, 'one block of held access');
  assert.equal(countOf(html, 'og-btn--primary'), 1, 'still one primary: Add a service');
  c.click('ov-svc-sign-in', { kind: 'github', key: '1:prod' });
  c.click('ov-svc-sign-out', { kind: 'github' });
  assert.deepEqual(calls, [['in', 'github', '1:prod'], ['out', 'github']]);
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

// ---------- the org's repository sources (Settings → Repository sources) ----------

test('the service list under the org\'s repository sources: a row whose source is switched off keeps its repository, marked, and its Run waits with the server\'s sentence; every other row runs as before; no sources read, every row as before', () => {
  const OFF = sourceOffText('github');
  assert.equal(OFF, 'GitHub is switched off in Settings → Repository sources — an org admin can switch it back on', 'the server\'s words (server/service-admin.mjs WAYS.repositorySourceOff)');
  const services = [svcRow(), uploadRow()];
  const rows = (sources) => serviceListModel({ services, servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW, sources }).rows;
  const [checkout, ledger] = rows({ github: false, ado: true, path: true, upload: true });
  assert.deepEqual([checkout.repository.text, checkout.repository.off, checkout.run], ['acme/checkout', true, { enabled: false, reason: `${OFF}.`, running: false }]);
  assert.equal(checkout.complete, true, 'still a complete record: it sorts with the runnable ones');
  assert.deepEqual([ledger.repository.off, ledger.run.enabled], [undefined, true], 'an upload, switched on, runs');
  assert.deepEqual(rows({ upload: false })[1].run.reason, `${sourceOffText('upload')}.`);
  for (const sources of [null, {}, { github: true }]) assert.deepEqual(rows(sources)[0].run, { enabled: true, reason: null, running: false }, `sources ${JSON.stringify(sources)}: as before`);
  // The row says so beside its repository.
  const list = serviceListModel({ services, servicesStatus: { kind: 'ok' }, journeys: [], endpoints: [EP], now: NOW, sources: { github: false } });
  const c = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  renderServiceList(c, list, formModel(FORM_CLOSED), { overview: {} });
  assert.equal(c.innerHTML.split('<span class="ov-svc__ref">switched off in Settings</span>').length - 1, 1, 'the one row whose source is off says so beside its repository');
});

test('the form under the org\'s repository sources: a source switched off is not offered — but for the record\'s own, kept and marked; a new form opens on the first source on; a save on a switched-off source is caught before any call, unless the repository is kept exactly as saved', () => {
  const OFF = { github: false, ado: true, path: true, upload: true };
  // Opened blank: the first source on, a folder or an address before Upload.
  assert.equal(formOpened([svcRow()], { endpoints: [EP], sources: OFF }).values.kind, 'ado');
  assert.equal(formOpened([svcRow()], { endpoints: [EP], sources: { github: false, ado: false, path: false } }).values.kind, 'upload', 'only Upload on');
  assert.equal(formOpened([svcRow()], { endpoints: [EP], sources: { github: false, ado: false, path: false, upload: false } }).values.kind, 'github', 'every source off: GitHub, marked off below');
  assert.equal(formOpened([svcRow()], { endpoints: [EP] }).values.kind, 'github', 'no sources read: as before');
  const blank = formOpened([svcRow()], { endpoints: [EP], sources: OFF });
  assert.equal(blank.original, null, 'a new service has no saved repository');
  const add = formModel(blank, { uploads: true, sources: OFF });
  assert.deepEqual(add.kinds.map((k) => [k.kind, k.selected, k.off ?? false]), [['ado', true, false], ['path', false, false], ['upload', false, false]], 'GitHub not offered');
  assert.equal(add.sourcesNote, 'Switched off in Settings → Repository sources: GitHub.');
  assert.equal(formModel(blank, { uploads: true }).sourcesNote, null, 'no sources read: no note');
  // Opened on a GitHub service while GitHub is off: its own kind stays, marked, with the server's sentence as its hint.
  const edit = formOpened([svcRow()], { serviceId: 1, env: 'prod', endpoints: [EP], sources: OFF });
  assert.deepEqual(edit.original, { kind: 'github', location: 'https://github.com/acme/checkout', ref: '' });
  const em = formModel(edit, { uploads: true, sources: OFF });
  assert.deepEqual(em.kinds.map((k) => [k.kind, k.selected, k.off ?? false]), [['github', true, true], ['ado', false, false], ['path', false, false], ['upload', false, false]]);
  assert.equal(em.kind.hint, `${sourceOffText('github')}. A service kept on it as it is still saves its other changes.`);
  assert.equal(em.problems.kind, undefined, 'kept exactly as saved: it saves (the endpoint, say)');
  // Changed: caught before any call, in the server's words.
  const CAUGHT = `${sourceOffText('github')}: choose another source.`;
  assert.equal(formModel(formInput(edit, 'location', 'https://github.com/acme/other'), { sources: OFF }).problems.kind, CAUGHT);
  assert.equal(formModel(formInput(edit, 'ref', 'main'), { sources: OFF }).problems.kind, CAUGHT, 'a branch is part of the repository');
  // Another kind chosen, by mistake or to look: the record's own stays offered, to be chosen again and kept.
  const away = formInput(edit, 'kind', 'ado');
  assert.deepEqual(formModel(away, { uploads: true, sources: OFF }).kinds.map((k) => [k.kind, k.selected, k.off ?? false]), [['github', false, true], ['ado', true, false], ['path', false, false], ['upload', false, false]]);
  const back = formInput(formInput(away, 'kind', 'github'), 'location', edit.values.location);
  assert.equal(formModel(back, { sources: OFF }).problems.kind, undefined, 'chosen again with its address: kept, it saves');
  assert.equal(formProblems({ ...blank.values, kind: 'github', name: 'B', location: 'https://github.com/acme/b' }, { sources: OFF }).kind, CAUGHT, 'a new service on it');
  assert.equal(formProblems({ ...blank.values, kind: 'github', name: 'B', location: 'https://github.com/acme/b' }).kind, undefined, 'no sources: as before');
  // Upload: kept while nothing new is staged; a new upload is caught.
  const upOff = { upload: false };
  const upEdit = formOpened([uploadRow()], { serviceId: 5, env: 'prod', endpoints: [EP], sources: upOff });
  assert.equal(formModel(upEdit, { uploads: false, sources: upOff, now: NOW }).problems.kind, undefined, 'the upload as it is');
  assert.equal(formModel(upEdit, { uploads: false, sources: upOff, now: NOW }).upload.text, 'ledger-main.zip · uploaded 2 days ago · 12 files.', 'Upload switched off: no Choose buttons, so no "choose again"');
  assert.equal(formProblems(upEdit.values, { sources: upOff, original: upEdit.original, uploadStaged: true }).kind, `${sourceOffText('upload')}: choose another source.`);
  assert.deepEqual(formModel(upEdit, { uploads: false, sources: upOff, now: NOW }).kinds.map((k) => [k.kind, k.off ?? false]), [['github', false], ['ado', false], ['path', false], ['upload', true]], 'its kind kept, marked off; the host passes uploads off');
  // Every source off: the one kind drawn is marked off, and the save is caught.
  const none = { github: false, ado: false, path: false, upload: false };
  const nm = formModel(formOpened([svcRow()], { endpoints: [EP], sources: none }), { uploads: false, sources: none });
  assert.deepEqual(nm.kinds.map((k) => [k.kind, k.off]), [['github', true]]);
  assert.equal(nm.kinds[0].hint, `${sourceOffText('github')}.`, 'a new service: no "kept" hint');
  assert.equal(nm.sourcesNote, 'Switched off in Settings → Repository sources: GitHub, Azure DevOps, Folder, Upload.');
  assert.equal(nm.problems.kind, ALL_SOURCES_OFF, 'no other source to choose: said as such');
  assert.equal(formProblemsNote({ kind: ALL_SOURCES_OFF }), ALL_SOURCES_OFF);
  // The form's note when the save is stopped: the sentence itself when nothing is missing.
  assert.equal(formProblemsNote({ kind: CAUGHT }), CAUGHT);
  assert.equal(formProblemsNote({ kind: CAUGHT, name: 'Name the service.' }), 'Some answers are missing — each is marked where it goes.');
  assert.equal(formProblemsNote({ name: 'Name the service.' }), 'Some answers are missing — each is marked where it goes.');
});

test('loadServiceListFacts: `sources` from GET /api/repository-sources — the switches, or null when the server has none (an older one) or refuses', async () => {
  const fetchWith = (sources) => async (path) => {
    if (path === '/api/journeys') return { journeys: [] };
    if (path === '/api/mcp-endpoints') return { endpoints: [], policy: { register: { allowed: true } } };
    if (path.startsWith('/api/repository-folders')) return { allowed: true, entries: [] };
    if (path === '/api/repository-sources') return sources();
    throw new Error(`unexpected ${path}`);
  };
  assert.deepEqual((await loadServiceListFacts({ fetchFn: fetchWith(() => ({ ok: true, sources: { github: false, ado: true, path: true, upload: true } })) })).sources, { github: false, ado: true, path: true, upload: true });
  assert.equal((await loadServiceListFacts({ fetchFn: fetchWith(() => { throw new Error('404: no answer'); }) })).sources, null, 'an older server');
  assert.equal((await loadServiceListFacts({ fetchFn: fetchWith(() => ({ ok: true })) })).sources, null, 'a body with no switches');
});

// ---------- Expert's Diagnose: the service's criteria (studio/grade-criteria-ui.mjs) ----------

const FRESH_OFF = { id: 4, name: 'krystaline', gradeOff: [{ key: 'fresh', reason: 'test', by: 'admin', at: '2026-11-10T12:00:00Z' }] };

test("criteriaScope: the criteria of the grade on screen — none for a pack that is no service's own; the switch only where the host saves one, explained to a reader who may not", () => {
  assert.equal(criteriaScope({ service: null, canSwitch: true }), null, 'no service: graded on all seven, nothing to switch');
  assert.equal(criteriaScope({ service: { name: 'no id' }, canSwitch: true }), null);
  assert.deepEqual(criteriaScope({ service: FRESH_OFF, canSwitch: true }), {
    serviceId: 4, serviceName: 'krystaline', total: 7, graded: 6, offKeys: ['fresh'],
    notGraded: [{ key: 'fresh', label: 'Fresh', text: 'Fresh is not graded for this service: test', by: 'admin, 10 Nov' }],
    switches: { enabled: true, reason: null },
  });
  assert.equal(criteriaScope({ service: FRESH_OFF }).switches, null, 'no host hook: what is off is said, no switch offered');
  assert.deepEqual(criteriaScope({ service: FRESH_OFF, canSwitch: true, canWrite: false, writeReason: 'operators and admins switch criteria' }).switches,
    { enabled: false, reason: 'operators and admins switch criteria' });
  assert.deepEqual(criteriaScope({ service: FRESH_OFF, canSwitch: true, canWrite: false }).switches, { enabled: false, reason: 'Not available for your role here.' });
  const all = criteriaScope({ service: { id: 1, name: 'x', gradeOff: GRADE_CRITERION_KEYS.map((key) => ({ key, reason: 'r' })) } });
  assert.deepEqual([all.graded, all.offKeys, all.notGraded], [7, [], []], 'a list naming all seven is ignored, as the engine ignores it');
  assert.equal(criteriaScope({ service: { id: 2, slug: 'ledger', gradeOff: null } }).serviceName, 'ledger');
});

test('groupNames: the checks of a group by name — with every criterion graded, the words Diagnose always used; one left out is named apart', () => {
  const cov = { criteria: ['multi-modal', 'correlated', 'calibrated', 'comprehensive'].map((key) => ({ key })) };
  const trust = { criteria: ['chaos-validated', 'drift-free', 'fresh'].map((key) => ({ key })) };
  assert.deepEqual(groupNames(cov), { graded: 'signal types, correlation, calibration, breadth', off: '', count: 4 });
  assert.deepEqual(groupNames(trust), { graded: 'recovery tested, matches live, recently verified', off: '', count: 3 });
  assert.equal(groupNames(cov, CRITERION_LONG).graded, 'signal types, correlation, calibration, breadth across layers');
  assert.equal(groupNames(trust, CRITERION_LONG).graded, 'recovery tested by chaos, declarations matching live, verified within 24 hours');
  const off = { criteria: [{ key: 'fresh', applies: false }, { key: 'chaos-validated', applies: false }, { key: 'drift-free' }] };
  assert.deepEqual(groupNames(off), { graded: 'matches live', off: 'recovery tested and recently verified', count: 1 }, "in the engine's order");
  assert.deepEqual(groupNames({ criteria: trust.criteria.map((c) => ({ ...c, applies: false })) }), { graded: '', off: 'recovery tested, matches live and recently verified', count: 0 });
  assert.deepEqual(groupNames(null), { graded: '', off: '', count: 0 });
  assert.equal(notGradedSentence(['Fresh']), 'Fresh is not graded for this service');
  assert.equal(notGradedSentence(['Chaos-validated', 'Fresh']), 'Chaos-validated and Fresh are not graded for this service');
  assert.equal(notGradedSentence(['Calibrated', 'Chaos-validated', 'Fresh']), 'Calibrated, Chaos-validated and Fresh are not graded for this service');
  assert.equal(notGradedSentence([]), '');
});

test('criteriaPanelHtml: the summary says on how many criteria the grade stands and what is off — why, who, when — with Grade it again; nothing at all with nothing off and no switch', () => {
  assert.equal(criteriaPanelHtml(null), '');
  assert.equal(criteriaPanelHtml(criteriaScope({ service: { id: 4, name: 'krystaline', gradeOff: [] } })), '', 'nothing off, no switch: the summary is what it was');
  assert.equal(criteriaPanelHtml(criteriaScope({ service: FRESH_OFF, canSwitch: true })),
    '<section class="diag-criteria" aria-labelledby="diag-criteria-title"><h3 class="diag-measure-group-title" id="diag-criteria-title">Criteria graded for krystaline</h3>'
    + '<p class="diag-criteria-lede">Graded on 6 of 7 criteria: Fresh is not graded for this service.</p>'
    + '<ul class="diag-criteria-off"><li class="diag-criteria-item"><span class="ux-chip ux-chip-neutral">Off</span><span class="diag-criteria-text">Fresh is not graded for this service: test <span class="diag-criteria-by">admin, 10 Nov</span></span>'
    + '<button type="button" class="ux-link-btn diag-crit-switch" data-ux-action="diag-grade-on:fresh" aria-label="Grade Fresh for this service again">Grade it again</button></li></ul>'
    + '<p class="diag-criteria-how"><span>A criterion that does not apply to krystaline is left out under Evidence: <em>Not for this service…</em> beside it, with a reason.</span><button type="button" class="ux-link-btn" data-ux-action="diag-goto:diag-evidence">Choose the criteria →</button></p></section>');
  const none = criteriaPanelHtml(criteriaScope({ service: { id: 4, name: 'krystaline', gradeOff: [] }, canSwitch: true }));
  assert.ok(none.includes('<p class="diag-criteria-lede">Graded on all 7 criteria.</p>') && !none.includes('diag-criteria-off'), 'with a switch and nothing off: where to switch one');
  const told = criteriaPanelHtml(criteriaScope({ service: FRESH_OFF }));
  assert.ok(told.includes('Fresh is not graded for this service: test') && !told.includes('<button'), 'no host hook: said, nothing to press');
  const hostile = criteriaPanelHtml(criteriaScope({ service: { id: 9, name: '<b>x</b>', gradeOff: [{ key: 'fresh', reason: '<img src=x>', by: '"a"' }] }, canSwitch: true }));
  assert.ok(!hostile.includes('<b>x</b>') && !hostile.includes('<img') && hostile.includes('&lt;img src=x&gt;'), 'every word from the record escaped');
});

test('switchHtml / askRowHtml: Not for this service… asks why in place, Grade it again grades it again; a reader who may not switch gets the same words, explained; the host hook defaults to none', () => {
  const on = { enabled: true, reason: null };
  assert.equal(switchHtml(on, 'off', 'chaos-validated', 'Chaos-validated'),
    '<button type="button" class="ux-link-btn diag-crit-switch" data-ux-action="diag-grade-ask:chaos-validated" aria-label="Stop grading Chaos-validated for this service">Not for this service…</button>');
  assert.equal(switchHtml(on, 'on', 'fresh'),
    '<button type="button" class="ux-link-btn diag-crit-switch" data-ux-action="diag-grade-on:fresh" aria-label="Grade Fresh for this service again">Grade it again</button>');
  assert.equal(switchHtml({ enabled: false, reason: 'operators switch criteria' }, 'off', 'fresh'),
    '<button type="button" class="ux-link-btn diag-crit-switch" data-ux-action="diag-grade-explain" aria-disabled="true" title="operators switch criteria" aria-label="Stop grading Fresh for this service">Not for this service…</button>');
  assert.equal(switchHtml(null, 'off', 'fresh'), '');
  const ask = askRowHtml({ reason: 'no "chaos" <here>' }, 'chaos-validated');
  assert.ok(ask.startsWith('<tr class="diag-crit-ask"><td colspan="4">'));
  assert.ok(ask.includes('<span>Why is Chaos-validated not graded for this service?</span><input class="og-input" data-diag-grade-reason="chaos-validated" value="no &quot;chaos&quot; &lt;here&gt;" maxlength="200"'), 'what was typed, kept and escaped');
  assert.ok(ask.includes('data-ux-action="diag-grade-off:chaos-validated">Stop grading it</button>') && ask.includes('data-ux-action="diag-grade-cancel">Cancel</button>'));
  assert.equal(studioHost.setGradeCriterion, null, 'a page that embeds Diagnose without the hook offers no switch');
});
