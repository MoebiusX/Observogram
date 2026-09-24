#!/usr/bin/env node
/**
 * tools/test-journey.mjs
 *
 * Unit test for the saved-journey runner (tools/lib/journey.mjs). Uses
 * file-vs-file journeys over the shipped example packs — no MCP, no
 * network. Covers: definition loading (by name and by path, with the
 * secrets-by-env-ref rule), the run record's Workstream-D gate-contract
 * fields, gate evaluation (pass and every breach type), run history
 * append + read-back ordering, and the markdown report. Exit 0 = pass.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { createHarness } from './lib/harness.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { SPEC_DIR } from './lib/validator.mjs';
import { adapt } from './lib/adapter.mjs';
import { diffPacks } from './lib/diff.mjs';
import { comparePackBranches } from './lib/traceability-graph.mjs';
import { computeDiagnosticGrade, computePostureMatrix } from '../studio/diagnostic-grade.mjs';

const { assert, report } = createHarness();

const TMP = mkdtempSync(join(tmpdir(), 'observogram-journey-'));
process.env.OBSERVOGRAM_WORKSPACE = TMP;

const {
  loadJourneyDef, runJourney, listJourneys, readJourneyRuns,
  evaluateGate, renderJourneyMarkdown, liveEvidenceFacts,
  pruneRunFiles, parseRunRetention, journeyRunRetention, JOURNEY_RUN_RETENTION_DEFAULT,
  formatStackValue, validateGateStack, stackStatusLine,
  chainStatusLine, liveVersions, livePackDecision, pruneLiveSnapshots, readLivePack, KEEP_LIVE_PACK_POLICIES, LIVE_PACK_PATH_RE,
  causeLine, transitionGotWorse, resolveDeployArtifact,
  notifyStatusLine, postNotification, resolveNotifyTarget, validateNotify, NOTIFY_POLICIES, NOTIFY_TIMEOUT_DEFAULT_MS,
inventorySummary, inventoryStatusLine,
} = await import('./lib/journey.mjs');
const { chainGotWorse } = await import('./lib/journey-notify.mjs');
const { STACK_SELF_METRIC_PROBES } = await import('./lib/contracts/stack-self-metrics.mjs');

// A TCP port nobody listens on: bind an ephemeral one, read it, release
// it. Connecting to it afterwards is refused immediately — the fastest,
// fully offline way to make the live fetcher lose its vantage.
async function closedLoopbackPort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

const PACK_A = resolve(SPEC_DIR, 'examples/payment-service.pack.yaml');
const PACK_B = resolve('examples/production-curated.pack.yaml');

try {
  // --- definition loading ---
  mkdirSync(join(TMP, 'journeys'), { recursive: true });
  writeFileSync(join(TMP, 'journeys', 'pay-vs-curated.journey.yaml'), [
    'name: pay-vs-curated',
    `packA:`,
    `  file: ${PACK_A.replaceAll('\\', '/')}`,
    `packB:`,
    `  file: ${PACK_B.replaceAll('\\', '/')}`,
    'env: prod',
    'gate:',
    '  minAlignmentPct: 1',
  ].join('\n'));

  assert(listJourneys().includes('pay-vs-curated'), 'saved journey is listed');
  const def = loadJourneyDef('pay-vs-curated');
  assert(def.name === 'pay-vs-curated' && def.gate.minAlignmentPct === 1, 'definition loads by name with gate thresholds');
  let missing = null;
  try { loadJourneyDef('no-such-journey'); } catch (e) { missing = e.message; }
  assert(/journey not found/.test(missing || ''), 'unknown journey names fail with a clear error');
  assert(/pay-vs-curated/.test(missing || ''), 'the error lists known journeys');

  // --- a run produces the Workstream-D record ---
  const rec = await runJourney(def);
  assert(rec.journey === 'pay-vs-curated', 'record names the journey');
  assert(rec.packA.name === 'payment-service', 'record carries declared pack identity', rec.packA, 'payment-service');
  assert(rec.packB.name === 'production-curated', 'record carries reference pack identity');
  assert(rec.scope.env === 'prod', 'record carries the env scope');
  assert(typeof rec.grade.score === 'number' && typeof rec.grade.pass === 'boolean', 'record carries grade score + pass');
  assert(rec.grade.threshold === 85, 'record states the pass threshold');
  assert(rec.grade.schema === 2, 'record names the grade schema so score-history steps are explainable', rec.grade);
  assert(typeof rec.grade.letter === 'string' && rec.grade.letter.length >= 1, 'record carries the instrument-grade letter', rec.grade);
  assert(typeof rec.conformance.scorePercent === 'number' && rec.conformance.declaredTier === 'tier-1',
         'record carries the conformance verdict');
  assert(typeof rec.drift.alignmentPct === 'number' && rec.drift.aligned >= 0, 'record carries drift bucket counts');
  assert(rec.freshness.liveAgeHours === null, 'file-sourced pack B has no live freshness — reported as null, not faked');
  assert(rec.outcome === 'pass' && rec.gate.breaches.length === 0, 'permissive gate passes', rec.gate.breaches, []);
  // Vantage fields exist on every record; a file-sourced B is honest absence.
  assert(Array.isArray(rec.probes?.attempted) && rec.probes.attempted.length === 0 && rec.probes.failed.length === 0,
         'file-sourced B records empty probe lists, never invented ones', rec.probes);
  assert(rec.vantage === 'none' && rec.toolsExposedCount === null, 'file-sourced B has vantage none and no tools-exposed count', { v: rec.vantage, t: rec.toolsExposedCount });
  assert(rec.scrapeJobsDown === 0 && rec.unhealthyRules === 0, 'file-sourced B counts no on-wire failures', { d: rec.scrapeJobsDown, u: rec.unhealthyRules });
  assert(['requirement-chain', 'diff-buckets'].includes(rec.grade.driftConstruct), 'record names the Drift-free construct', rec.grade.driftConstruct);

  // --- history: appended, newest first ---
  const runs1 = readJourneyRuns('pay-vs-curated');
  assert(runs1.length === 1 && runs1[0].startedAt === rec.startedAt, 'run record lands in workspace history');
  await new Promise(r => setTimeout(r, 1100));   // distinct timestamped filename
  await runJourney(def);
  const runs2 = readJourneyRuns('pay-vs-curated');
  assert(runs2.length === 2, 'second run appends to history', runs2.length, 2);
  assert(runs2[0].startedAt > runs2[1].startedAt, 'history reads back newest first');
  assert(readdirSync(join(TMP, 'runs', 'pay-vs-curated')).length === 2, 'one JSON file per run on disk');
  assert(rec.stackEvidence === null, 'file-sourced B carries no stack evidence — null, never an empty healthy panel', rec.stackEvidence);

  // --- retention: the run directory is bounded (policy + effect) ---
  assert(parseRunRetention(undefined) === JOURNEY_RUN_RETENTION_DEFAULT && JOURNEY_RUN_RETENTION_DEFAULT === 1000, 'retention defaults to 1000');
  assert(parseRunRetention('250') === 250 && parseRunRetention(' 7 ') === 7, 'retention parses a non-negative integer');
  assert(parseRunRetention('0') === 0, 'retention 0 parses as 0 (unlimited)');
  assert(parseRunRetention('abc') === 1000 && parseRunRetention('-5') === 1000 && parseRunRetention('2.5') === 1000 && parseRunRetention('') === 1000,
         'garbage, negative, fractional and empty retention values fall back to the default');
  delete process.env.OBSERVOGRAM_JOURNEY_RUN_RETENTION;
  delete process.env.TOMOGRAPH_JOURNEY_RUN_RETENTION;
  assert(journeyRunRetention() === 1000, 'journeyRunRetention reads the default when the env var is unset');
  process.env.OBSERVOGRAM_JOURNEY_RUN_RETENTION = '3';
  assert(journeyRunRetention() === 3, 'journeyRunRetention reads OBSERVOGRAM_JOURNEY_RUN_RETENTION at call time');
  const names = ['2026-01-03T00-00-00-000Z.json', '2026-01-01T00-00-00-000Z.json', 'notes.txt', 'notes.json', '2026-01-02T00-00-00-000Z.json', '2026-01-04T00-00-00-000Z.json'];
  assert(pruneRunFiles(names, 3).join() === '2026-01-01T00-00-00-000Z.json', 'a hand-dropped notes.json is neither a candidate nor counted as the newest run', pruneRunFiles(names, 3));
  assert(pruneRunFiles(names, 2).join() === '2026-01-01T00-00-00-000Z.json,2026-01-02T00-00-00-000Z.json', 'pruneRunFiles names the oldest run files beyond the keep count, oldest first', pruneRunFiles(names, 2));
  assert(pruneRunFiles(names, 4).length === 0 && pruneRunFiles(names, 10).length === 0, 'pruneRunFiles deletes nothing at or under the keep count');
  assert(pruneRunFiles(names, 0).length === 0 && pruneRunFiles(names, -1).length === 0 && pruneRunFiles(names, NaN).length === 0, 'keep 0 / negative / NaN means unlimited — nothing deleted');
  assert(pruneRunFiles(names, 1).every(f => f.endsWith('.json')) && pruneRunFiles(names, 1).length === 3, 'non-run files are never pruned');
  assert(pruneRunFiles(null, 1).length === 0, 'pruneRunFiles tolerates a missing list');
  writeFileSync(join(TMP, 'journeys', 'retained.journey.yaml'), [
    'name: retained',
    `packA: { file: ${PACK_A.replaceAll('\\', '/')} }`,
    `packB: { file: ${PACK_B.replaceAll('\\', '/')} }`,
  ].join('\n'));
  const retainedDef = loadJourneyDef('retained');
  const started = [];
  for (let i = 0; i < 5; i++) {
    const r = await runJourney(retainedDef);
    started.push(r.startedAt);
    assert(r.historyError === undefined, `retention run ${i + 1} reports no history error`, r.historyError);
    await new Promise(res => setTimeout(res, 5));   // distinct millisecond filenames
  }
  const retainedFiles = readdirSync(join(TMP, 'runs', 'retained')).sort();
  assert(retainedFiles.length === 3, 'retention 3 keeps exactly three run files after five runs', retainedFiles);
  const keptStarts = readJourneyRuns('retained').map(r => r.startedAt);
  assert(keptStarts.join() === [started[4], started[3], started[2]].join(), 'the newest three survive, newest first; the two oldest are deleted', { kept: keptStarts, started });
  // A victim that cannot be deleted (a non-empty directory wearing a run
  // filename) lands on the record as historyError; the run still lands.
  const stuck = join(TMP, 'runs', 'retained', '0000-01-01T00-00-00-000Z.json');
  mkdirSync(stuck, { recursive: true });
  writeFileSync(join(stuck, 'blocker.txt'), 'not a run');
  const stuckRun = await runJourney(retainedDef);
  assert(typeof stuckRun.historyError === 'string' && /prune 0000-01-01T00-00-00-000Z\.json: /.test(stuckRun.historyError) && stuckRun.outcome === 'pass',
         'a deletion failure is noted as historyError on the record, never thrown, and the verdict stands', stuckRun.historyError);
  assert(readJourneyRuns('retained')[0]?.startedAt === stuckRun.startedAt, 'the run record itself still landed on disk beside the undeletable file');
  assert(readdirSync(join(TMP, 'runs', 'retained')).filter(f => f !== '0000-01-01T00-00-00-000Z.json').length === 3, 'the deletable victim was still pruned around the stuck one');
  rmSync(stuck, { recursive: true, force: true });
  process.env.OBSERVOGRAM_JOURNEY_RUN_RETENTION = '0';
  for (let i = 0; i < 2; i++) {
    await runJourney(retainedDef);
    await new Promise(res => setTimeout(res, 5));
  }
  assert(readdirSync(join(TMP, 'runs', 'retained')).length === 5, 'retention 0 is unlimited — nothing pruned', readdirSync(join(TMP, 'runs', 'retained')).length);
  process.env.OBSERVOGRAM_JOURNEY_RUN_RETENTION = 'not-a-number';
  await runJourney(retainedDef);
  assert(readdirSync(join(TMP, 'runs', 'retained')).length === 6, 'an unparseable retention falls back to the default (1000) — nothing pruned at 6 files');
  delete process.env.OBSERVOGRAM_JOURNEY_RUN_RETENTION;

  // --- gate breaches, each criterion ---
  const facts = { gradeScore: 60, gradePass: false, alignmentPct: 40, declaredNotLive: 7, liveNotDeclared: 2, drifted: 9, aligned: 10, liveAgeHours: 30 };
  let breaches = evaluateGate({ requireGradePass: true }, facts);
  assert(breaches.length === 1 && breaches[0].criterion === 'requireGradePass', 'requireGradePass breach detected');
  breaches = evaluateGate({ minAlignmentPct: 85 }, facts);
  assert(breaches[0]?.criterion === 'minAlignmentPct' && /40% < required 85%/.test(breaches[0].detail), 'alignment breach names both numbers');
  breaches = evaluateGate({ maxDeclaredNotLive: 0 }, facts);
  assert(breaches[0]?.criterion === 'maxDeclaredNotLive', 'declared-not-live breach detected');
  breaches = evaluateGate({ maxDrifted: 5 }, facts);
  assert(breaches[0]?.criterion === 'maxDrifted', 'drifted breach detected');
  breaches = evaluateGate({ maxLiveAgeHours: 24 }, facts);
  assert(breaches[0]?.criterion === 'maxLiveAgeHours' && /30\.0h/.test(breaches[0].detail), 'staleness breach reports the age');
  breaches = evaluateGate({ maxLiveAgeHours: 24 }, { ...facts, liveAgeHours: null });
  assert(/cannot be proven fresh/.test(breaches[0]?.detail || ''), 'missing freshness evidence breaches a freshness gate — absence is not freshness');
  assert(evaluateGate({}, facts).length === 0, 'empty gate never breaches');
  assert(evaluateGate(undefined, facts).length === 0, 'missing gate never breaches');

  // --- vantage-aware gate keys ---
  const partialFacts = { ...facts, probes: { attempted: ['a', 'dashboards', 'scrape_configs'], succeeded: ['a'], empty: [], failed: ['dashboards', 'scrape_configs'], unsupported: [] }, vantage: 'partial' };
  breaches = evaluateGate({ failOnPartialEvidence: true }, partialFacts);
  assert(breaches.length === 1 && breaches[0].criterion === 'failOnPartialEvidence', 'failOnPartialEvidence breaches when a probe family failed', breaches);
  assert(/probes failed: dashboards, scrape_configs/.test(breaches[0].detail) && /verdict not trustworthy/.test(breaches[0].detail),
         'partial-evidence breach names the failed families and says the verdict is not trustworthy', breaches[0].detail);
  const emptyOnly = { ...facts, probes: { attempted: ['a', 'b'], succeeded: ['a'], empty: ['b'], failed: [], unsupported: [] }, vantage: 'full' };
  assert(evaluateGate({ failOnPartialEvidence: true }, emptyOnly).length === 0, 'an EMPTY probe is an honest zero — no partial-evidence breach');
  const restricted = { ...facts, probes: { attempted: ['a', 'b'], succeeded: ['a'], empty: [], failed: [], unsupported: ['b'] }, vantage: 'restricted' };
  assert(evaluateGate({ failOnPartialEvidence: true }, restricted).length === 0, 'a restricted tier with answers is not partial evidence');
  const lost = { ...facts, probes: { attempted: ['a', 'b'], succeeded: [], empty: [], failed: [], unsupported: ['a', 'b'] }, vantage: 'lost' };
  breaches = evaluateGate({ failOnPartialEvidence: true }, lost);
  assert(breaches[0]?.criterion === 'failOnPartialEvidence' && /live evidence is lost/.test(breaches[0].detail), 'a vantage entirely lost breaches failOnPartialEvidence too', breaches);
  assert(evaluateGate({ failOnPartialEvidence: false }, partialFacts).length === 0, 'failOnPartialEvidence: false never breaches');
  assert(evaluateGate({ failOnPartialEvidence: true }, facts).length === 0, 'facts without probe lists (file-sourced B) do not breach');
  const unhealthyFacts = { ...facts, scrapeJobsDown: 1, scrapeJobsDownNames: ['alertmanager'], unhealthyRules: 2, unhealthyRuleNames: ['rr_bad', 'ar_bad'] };
  breaches = evaluateGate({ maxUnhealthy: 2 }, unhealthyFacts);
  assert(breaches.length === 1 && breaches[0].criterion === 'maxUnhealthy', 'maxUnhealthy breaches when jobs down + unhealthy rules exceed it', breaches);
  assert(/1 scrape job\(s\) down \+ 2 unhealthy rule\(s\)/.test(breaches[0].detail) && /job alertmanager down/.test(breaches[0].detail) && /rule rr_bad unhealthy/.test(breaches[0].detail),
         'maxUnhealthy breach names both counts and the offenders', breaches[0].detail);
  assert(evaluateGate({ maxUnhealthy: 3 }, unhealthyFacts).length === 0, 'maxUnhealthy at the exact sum passes (> not >=)');
  assert(evaluateGate({ maxUnhealthy: 0 }, facts).length === 0, 'maxUnhealthy: 0 passes when nothing is down or unhealthy');

  // --- a strict gate fails the run with outcome gate-failed ---
  writeFileSync(join(TMP, 'journeys', 'strict.journey.yaml'), [
    'name: strict',
    `packA: { file: ${PACK_A.replaceAll('\\', '/')} }`,
    `packB: { file: ${PACK_B.replaceAll('\\', '/')} }`,
    'gate: { minAlignmentPct: 100, maxDeclaredNotLive: 0 }',
  ].join('\n'));
  const strictRec = await runJourney(loadJourneyDef('strict'));
  assert(strictRec.outcome === 'gate-failed' && strictRec.gate.breaches.length >= 1,
         'breached gate yields outcome gate-failed', strictRec.gate.breaches.map(b => b.criterion), 'breaches');

  // --- a live placeholder never masks a declared artefact ---
  // Pack B is Pack A itself, re-annotated as a live draft whose burn-rate
  // entry is the fetcher's schema-forced placeholder. Same SLO, same
  // windows — the declared alert used to read aligned, so
  // maxDeclaredNotLive: 0 passed against a platform with no burn-rate
  // alerting rule at all.
  const maskedB = parseYaml(readFileSync(PACK_A, 'utf8'));
  maskedB.metadata.name = `${maskedB.metadata.name}-live`;
  maskedB.metadata.annotations = {
    ...(maskedB.metadata.annotations || {}),
    'mcp.url': 'https://otel-mcp.example.invalid/mcp',
    'mcp.refreshedAt': new Date().toISOString(),
    'mcp.scaffold.policy.burn_rate_alerts[0]': 'schema-required fallback; no burn-rate alerting rule discovered via MCP',
  };
  const MASKED_B = join(TMP, 'masked-b.pack.json');
  writeFileSync(MASKED_B, JSON.stringify(maskedB, null, 2));
  writeFileSync(join(TMP, 'journeys', 'masked.journey.yaml'), [
    'name: masked',
    `packA: { file: ${PACK_A.replaceAll('\\', '/')} }`,
    `packB: { file: ${MASKED_B.replaceAll('\\', '/')} }`,
    'gate: { maxDeclaredNotLive: 0 }',
  ].join('\n'));
  const maskedRec = await runJourney(loadJourneyDef('masked'));
  assert(maskedRec.drift.declaredNotLive === 1 && maskedRec.drift.scaffold === 1,
         'the declared burn-rate alert counts as declared-not-live; the placeholder is parked, not aligned',
         { declaredNotLive: maskedRec.drift.declaredNotLive, scaffold: maskedRec.drift.scaffold }, { declaredNotLive: 1, scaffold: 1 });
  assert(maskedRec.outcome === 'gate-failed' && maskedRec.gate.breaches[0]?.criterion === 'maxDeclaredNotLive',
         'maxDeclaredNotLive: 0 breaches on the masked alert', maskedRec.gate.breaches.map(b => b.criterion));
  assert(maskedRec.drift.alignmentPct < 100, 'alignment is below 100% against the placeholder', maskedRec.drift.alignmentPct);

  // --- markdown report ---
  const md = renderJourneyMarkdown(strictRec);
  assert(/GATE FAILED/.test(md), 'markdown headline states the verdict');
  assert(/payment-service/.test(md) && /production-curated/.test(md), 'markdown names both packs');
  assert(/Gate breaches/.test(md), 'markdown lists the breaches');
  assert(/not incident-validated/.test(md), 'markdown labels the result verification, not validation');
  const mdPass = renderJourneyMarkdown(rec);
  assert(/PASS/.test(mdPass) && !/Gate breaches/.test(mdPass), 'passing report has no breach section');

  // --- a live-like Pack B: probes, on-wire health, studio grade parity ---
  // production-curated with the fetcher's annotations planted: a partial
  // vantage (dashboards failed, scrape_configs not exposed), one scrape
  // job down, three unhealthy rules. Named *-live so the grade treats the
  // comparison as drift (declared vs live), exactly like a studio draft.
  const liveB = parseYaml(readFileSync(PACK_B, 'utf8'));
  liveB.metadata.name = 'production-live-synthetic';
  const nowIso = new Date().toISOString();
  liveB.metadata.annotations = {
    ...(liveB.metadata.annotations || {}),
    'mcp.url': 'https://otel-mcp.example.invalid/mcp',
    'mcp.refreshedAt': nowIso,
    'mcp.probesAttempted': 'recording_rules,alert_rules,dashboards,metric_names,scrape_configs',
    'mcp.probesSucceeded': 'recording_rules,alert_rules',
    'mcp.probesEmpty': 'metric_names',
    'mcp.probesFailed': 'dashboards',
    'mcp.probesUnsupported': 'scrape_configs',
    'mcp.probeErrors.dashboards': 'HTTP 502 Bad Gateway',
    'mcp.toolsExposedCount': '12',
    'mcp.discovered.scrape_jobs_down': 'alertmanager',
    'mcp.discovered.recording_rules_unhealthy': 'svc_rr_bad',
    'mcp.discovered.alert_rules_unhealthy': 'svc_ar_bad,svc_ar_worse',
    'mcp.stack.status': 'sampled',
    'mcp.stack.sampled': '12',
    'mcp.stack.empty': '3',
    'mcp.stack.failed': '0',
    'mcp.stack.notInInventory': '9',
    'mcp.stack.notAttempted': '0',
    // Step 3: the samples themselves, exactly as the fetcher annotates them
    // (JSON strings; expr present on the wire, dropped on the record).
    'mcp.observed.stack_metrics': JSON.stringify([
      { id: 'scrape_success_ratio', family: 'scrape', product: 'generic', expr: 'sum(up) / count(up)', value: 0.95, unit: 'ratio', direction: 'higher', at: nowIso, outcome: 'data' },
      { id: 'scrape_targets_down', family: 'scrape', product: 'generic', expr: 'count(up == 0) or (count(up) * 0)', value: 2, unit: 'count', direction: 'lower', at: nowIso, outcome: 'data' },
      { id: 'rule_evaluation_failures', family: 'ruler', product: 'prometheus', expr: 'x', value: null, unit: 'per-second', direction: 'lower', at: nowIso, outcome: 'empty' },
      { id: 'notification_errors', family: 'notify', product: 'alertmanager', expr: 'y', value: null, unit: 'per-second', direction: 'lower', at: nowIso, outcome: 'failed', reason: 'HTTP 500' },
      { id: 'log_shipper_drops', family: 'logs', product: 'promtail', expr: 'z', value: null, unit: 'per-second', direction: 'lower', at: nowIso, outcome: 'not-in-inventory' },
      { id: 'retired_row_zzz', family: 'tsdb', product: 'generic', expr: 'w', value: 1, unit: 'count', direction: 'lower', at: nowIso, outcome: 'data' },
    ]),
    'mcp.observed.alertmanager': JSON.stringify({ version: '0.27.0', uptime: '2h', clusterStatus: 'ready', silences: { active: 1, total: 4 } }),
    'mcp.observed.grafana.datasources': JSON.stringify([
      { uid: 'p1', name: 'Prometheus', type: 'prometheus', health: 'ok', message: null },
      { uid: 'l1', name: 'Loki', type: 'loki', health: 'error', message: 'connection refused' },
      { uid: 't1', name: 'Tempo', type: 'tempo', health: 'unknown', message: null },
    ]),
    'mcp.observed.grafana.contact_points': JSON.stringify({ count: 3, names: ['email', 'teams', 'pagerduty'] }),
    // Step 4: observed product versions (bare keys are versions; the
    // provenance keys beside them are not).
    'mcp.versions.prometheus': '2.53.0',
    'mcp.versions.prometheus.source': 'buildinfo',
    'mcp.versions.grafana': 'live',
  };
  const LIVE_B = join(TMP, 'live-b.pack.json');
  writeFileSync(LIVE_B, JSON.stringify(liveB, null, 2));
  const lf = liveEvidenceFacts(liveB);
  assert(lf.probes.failed.join() === 'dashboards' && lf.probes.unsupported.join() === 'scrape_configs' && lf.probes.succeeded.join() === 'recording_rules,alert_rules',
         'liveEvidenceFacts reads the probe families per outcome', lf.probes);
  assert(lf.vantage === 'partial' && lf.toolsExposedCount === 12 && lf.scrapeJobsDown === 1 && lf.unhealthyRules === 3,
         'liveEvidenceFacts reads vantage, tools exposed, down jobs and unhealthy rules', lf);
  assert(lf.probeErrors.dashboards === 'HTTP 502 Bad Gateway', 'liveEvidenceFacts carries the probe error text');
  assert(lf.stack.status === 'sampled' && lf.stack.sampled === 12 && lf.stack.empty === 3 && lf.stack.failed === 0 && lf.stack.notAttempted === 0 && lf.stack.reason === null,
         'liveEvidenceFacts reads the stack self-metric counts as numbers', lf.stack);
  {
    const restrictedB = { ...liveB, metadata: { ...liveB.metadata, annotations: { ...liveB.metadata.annotations, 'mcp.stack.status': 'not-attempted', 'mcp.stack.reason': 'metrics_query not exposed by this MCP (restricted tier)', 'mcp.stack.sampled': '0', 'mcp.stack.notAttempted': '24' } } };
    const rf = liveEvidenceFacts(restrictedB).stack;
    assert(rf.status === 'not-attempted' && rf.reason === 'metrics_query not exposed by this MCP (restricted tier)' && rf.sampled === 0 && rf.notAttempted === 24,
           'liveEvidenceFacts keeps a not-attempted panel with its reason', rf);
    const rev = liveEvidenceFacts(restrictedB).stackEvidence;
    assert(rev && rev.status === 'not-attempted' && rev.reason === 'metrics_query not exposed by this MCP (restricted tier)',
           'stackEvidence keeps a not-attempted status with its reason (restricted tier reads not-attempted, never absent)', rev);
    // An outcome the contracts do not declare is kept verbatim — never relabelled as a probe failure nothing reported.
    const oddB = { ...liveB, metadata: { ...liveB.metadata, annotations: { ...liveB.metadata.annotations, 'mcp.observed.stack_metrics': JSON.stringify([
      { id: 'scrape_targets_down', family: 'scrape', product: 'generic', value: 3, unit: 'count', direction: 'lower', at: nowIso, outcome: 'throttled' },
      { id: 'scrape_success_ratio', family: 'scrape', product: 'generic', value: 0.5, unit: 'ratio', direction: 'higher', at: nowIso },
    ]) } } };
    const odd = liveEvidenceFacts(oddB).stackEvidence.rows;
    assert(odd[0].outcome === 'throttled' && odd[1].outcome === 'unknown', 'an undeclared outcome is kept verbatim and a missing one reads unknown — neither becomes "failed"', odd.map(r => r.outcome));
    assert(evaluateGate({ stack: { rows: { scrape_targets_down: { max: 0 } } } }, { stackEvidence: liveEvidenceFacts(oddB).stackEvidence })[0].detail.includes('(throttled)'),
           'a threshold on a row with an undeclared outcome breaches as "no sample" naming that outcome');
  }
  // --- step 3: stackEvidence — the samples, enriched from the contracts table ---
  const se = lf.stackEvidence;
  assert(se && se.status === 'sampled' && se.reason === null, 'stackEvidence status is sampled with no reason', se && { status: se.status, reason: se.reason });
  assert(Array.isArray(se.rows) && se.rows.length === 6, 'stackEvidence keeps every observed row', se.rows.length);
  const byId = Object.fromEntries(se.rows.map(r => [r.id, r]));
  assert(byId.scrape_success_ratio.value === 0.95 && byId.scrape_success_ratio.unit === 'ratio' && byId.scrape_success_ratio.direction === 'higher' && byId.scrape_success_ratio.outcome === 'data',
         'a data row keeps value, unit, direction and outcome', byId.scrape_success_ratio);
  assert(byId.scrape_success_ratio.referenceSli === 'prometheus-reference/scrape_success_ratio', 'referenceSli is looked up from the contracts table', byId.scrape_success_ratio.referenceSli);
  assert(byId.scrape_success_ratio.hint === null && byId.scrape_targets_down.hint === 'nonzero', 'hint is the contracts display marker: nonzero only for a lower-is-better row above zero', { ratio: byId.scrape_success_ratio.hint, down: byId.scrape_targets_down.hint });
  assert(byId.scrape_targets_down.referenceSli === null, 'a row the table maps to no reference SLI keeps null');
  assert(se.rows.every(r => !('expr' in r)), 'expr is dropped from the record (the sample, not the query, is the evidence)');
  assert(se.rows.every(r => r.at === nowIso && r.product), 'rows keep their sample time and product', se.rows.map(r => [r.at, r.product]));
  assert(byId.rule_evaluation_failures.outcome === 'empty' && byId.rule_evaluation_failures.value === null && byId.rule_evaluation_failures.hint === null, 'an empty row has null value and no hint');
  assert(byId.notification_errors.outcome === 'failed' && byId.notification_errors.reason === 'HTTP 500', 'a failed row keeps its reason', byId.notification_errors);
  assert(byId.log_shipper_drops.outcome === 'not-in-inventory' && !('reason' in byId.log_shipper_drops), 'a not-in-inventory row is kept without inventing a reason');
  assert(byId.retired_row_zzz && byId.retired_row_zzz.referenceSli === null && byId.retired_row_zzz.value === 1 && byId.retired_row_zzz.family === 'tsdb',
         'a row the table no longer declares is kept with referenceSli null (its own family and unit stand)', byId.retired_row_zzz);
  assert(se.alertmanager && se.alertmanager.version === '0.27.0' && se.alertmanager.clusterStatus === 'ready' && se.alertmanager.silencesActive === 1 && se.alertmanager.error === null,
         'stackEvidence.alertmanager carries version, cluster status, active silences, no error', se.alertmanager);
  assert(se.grafana && se.grafana.datasources === 3 && se.grafana.unhealthyDatasources.join() === 'Loki' && se.grafana.contactPoints === 3 && se.grafana.error === null,
         'stackEvidence.grafana counts datasources, names only the error-health ones (unknown is unchecked, not unhealthy), counts contact points', se.grafana);
  {
    // Malformed JSON degrades to no rows — never to a fabricated panel.
    const brokenB = { ...liveB, metadata: { ...liveB.metadata, annotations: { ...liveB.metadata.annotations, 'mcp.observed.stack_metrics': '[{not json', 'mcp.observed.alertmanager': '{{', 'mcp.observed.grafana.datasources': 'nope' } } };
    const bev = liveEvidenceFacts(brokenB).stackEvidence;
    assert(bev && bev.status === 'sampled' && bev.rows.length === 0 && bev.alertmanager === null, 'malformed stack_metrics / alertmanager JSON is tolerated: status kept, rows empty, alertmanager null', bev);
    assert(bev.grafana && bev.grafana.datasources === null && bev.grafana.unhealthyDatasources.length === 0 && bev.grafana.contactPoints === 3,
           'malformed datasources JSON reads as unknown count while the contact points still parse', bev.grafana);
    const noGrafana = { ...liveB, metadata: { ...liveB.metadata, annotations: Object.fromEntries(Object.entries(liveB.metadata.annotations).filter(([k]) => !k.startsWith('mcp.observed.grafana') && k !== 'mcp.observed.alertmanager')) } };
    const nev = liveEvidenceFacts(noGrafana).stackEvidence;
    assert(nev.alertmanager === null && nev.grafana === null && nev.rows.length === 6, 'surfaces the fetcher never wrote are null on the evidence, not empty objects', { am: nev.alertmanager, g: nev.grafana });
    const errGrafana = { ...liveB, metadata: { ...liveB.metadata, annotations: { ...noGrafana.metadata.annotations, 'mcp.observed.grafana.error': 'HTTP 503', 'mcp.observed.alertmanager': JSON.stringify({ version: null, uptime: null, clusterStatus: null, silences: null, error: 'timeout' }) } } };
    const eev = liveEvidenceFacts(errGrafana).stackEvidence;
    assert(eev.grafana && eev.grafana.error === 'HTTP 503' && eev.grafana.datasources === null && eev.alertmanager.error === 'timeout' && eev.alertmanager.silencesActive === null,
           'an advertised-but-failing surface keeps its error, with null counts', { g: eev.grafana, am: eev.alertmanager });
  }

  writeFileSync(join(TMP, 'journeys', 'live-synthetic.journey.yaml'), [
    'name: live-synthetic',
    `packA: { file: ${PACK_A.replaceAll('\\', '/')} }`,
    `packB: { file: ${LIVE_B.replaceAll('\\', '/')} }`,
    'env: prod',
    'gate: { failOnPartialEvidence: true, maxUnhealthy: 2 }',
  ].join('\n'));
  const liveRec = await runJourney(loadJourneyDef('live-synthetic'));
  assert(liveRec.outcome === 'gate-failed', 'partial vantage + on-wire failures fail the gate', liveRec.outcome);
  const crit = liveRec.gate.breaches.map(b => b.criterion).sort();
  assert(crit.join() === 'failOnPartialEvidence,maxUnhealthy', 'both vantage-aware criteria breach', crit);
  assert(liveRec.probes.failed.join() === 'dashboards' && liveRec.probes.unsupported.join() === 'scrape_configs' && liveRec.probes.empty.join() === 'metric_names',
         'run record carries the probe families per outcome', liveRec.probes);
  assert(liveRec.vantage === 'partial' && liveRec.toolsExposedCount === 12, 'run record carries vantage and toolsExposedCount', { v: liveRec.vantage, t: liveRec.toolsExposedCount });
  assert(liveRec.scrapeJobsDown === 1 && liveRec.unhealthyRules === 3, 'run record counts down jobs and unhealthy rules (recording + alerting)', { d: liveRec.scrapeJobsDown, u: liveRec.unhealthyRules });
  assert(liveRec.probeErrors?.dashboards === 'HTTP 502 Bad Gateway', 'run record keeps the probe error text', liveRec.probeErrors);
  assert(liveRec.stack && liveRec.stack.status === 'sampled' && liveRec.stack.sampled === 12 && liveRec.stack.empty === 3 && liveRec.stack.failed === 0,
         'run record carries the stack self-metric counts', liveRec.stack);
  assert(!liveRec.gate.breaches.some(b => /stack/i.test(b.criterion)), 'without a gate.stack block no stack criterion breaches — the sample stays a signal');
  assert(liveRec.stackEvidence && liveRec.stackEvidence.status === 'sampled' && liveRec.stackEvidence.rows.length === 6 && liveRec.stackEvidence.alertmanager.version === '0.27.0' && liveRec.stackEvidence.grafana.unhealthyDatasources.join() === 'Loki',
         'run record carries stackEvidence next to the stack counts', liveRec.stackEvidence && { status: liveRec.stackEvidence.status, rows: liveRec.stackEvidence.rows.length });
  assert(JSON.parse(JSON.stringify(readJourneyRuns('live-synthetic')[0])).stackEvidence.rows.find(r => r.id === 'scrape_targets_down').hint === 'nonzero',
         'stackEvidence round-trips through the run history file');
  assert(typeof liveRec.freshness.liveAgeHours === 'number', 'live-like B has a freshness age');

  // --- step 4: the record carries the requirement chains, their summary, the versions, the transition and the live-pack decision ---
  {
    const keys = Object.keys(liveRec);
    assert(keys.slice(keys.indexOf('traceability'), keys.indexOf('traceability') + 6).join() === 'traceability,branches,chains,versions,transition,livePack',
           'branches, chains, versions, transition and livePack follow traceability on the record', keys);
    assert(Array.isArray(liveRec.branches) && liveRec.branches.length === liveRec.traceability.declaredTotal + liveRec.traceability.undeclared,
           'branches holds one record per chain of the comparison', { branches: liveRec.branches.length, t: liveRec.traceability });
    const b0 = liveRec.branches[0];
    assert(Object.keys(b0).join() === 'rootKey,title,rootKind,verdict,ladderVerdict,integrityPct,ladderIntegrityPct,confidence,missingRoles,degraded',
           'a persisted branch carries the chain-history shape', Object.keys(b0));
    assert(b0.degraded.length > 0 && Object.keys(b0.degraded[0]).join() === 'key,kind,label,status,ladder,blastRadius,deltaFields,aId,bId' && b0.degraded[0].ladder.rung && b0.degraded[0].blastRadius && typeof b0.degraded[0].blastRadius.slos === 'number',
           'a persisted degraded node carries status, ladder, blast radius, delta fields and the artefact ids', b0.degraded[0]);
    assert(liveRec.branches.some(b => b.degraded.some(d => typeof d.aId === 'string' && /^[A-Z]+-\d+$/.test(d.aId))), 'a declared node persists the adapter artefact id (e.g. QRY-01) so a deploy naming it by id can match', liveRec.branches[0].degraded.map(d => [d.label, d.aId, d.bId]));
    assert(liveRec.branches.some(b => b.degraded.some(d => d.ladder.status === 'unobserved' && /probe family dashboards failed/.test(d.ladder.detail))),
           'the failed dashboards probe lands on the record as unobserved nodes, never as absent ones');
    assert(liveRec.branches.every(b => b.degraded.every(d => d.status !== 'unverifiable')), 'unverifiable nodes (not live-introspectable) are not recorded as degraded');
    const c = liveRec.chains;
    assert(c && c.declaredTotal === liveRec.traceability.declaredTotal && c.intact === liveRec.traceability.intact && c.broken === liveRec.traceability.broken && c.undeclared === liveRec.traceability.undeclared,
           'chains counts agree with the traceability rollup the grade was scored on', { chains: c, t: liveRec.traceability });
    assert(c.ladder && typeof c.ladder.healthy === 'number' && typeof c.ladder.unobserved === 'number' && typeof c.degradedNodes === 'number' && c.degradedNodes > 0,
           'chains carries the ladder counts and the degraded-node count', c);
    assert(c.topExposure && typeof c.topExposure.label === 'string' && c.topExposure.slos > 0, 'chains names the top exposure (the degraded node that blinds the most SLOs)', c.topExposure);
    assert(JSON.stringify(liveRec.versions) === JSON.stringify({ grafana: 'live', prometheus: '2.53.0' }), 'versions maps mcp.versions.<product> only (provenance keys excluded), sorted', liveRec.versions);
    assert(rec.versions === null, 'a Pack B without version annotations records versions null, never {}', rec.versions);
    assert(liveRec.transition && liveRec.transition.reason === 'first run' && liveRec.transition.any === false && liveRec.transition.since === null && liveRec.transition.changed.length === 0 && liveRec.transition.skipped.length === 0,
           'the first run of a journey has no comparison and its transition says why (reason: first run), with empty lists — never "any: true"', liveRec.transition);
    assert(JSON.stringify(liveRec.livePack) === JSON.stringify({ kept: false, path: null, reason: `Pack B is a file (${LIVE_B})` }),
           'a file-sourced Pack B is never snapshotted, and the record says so', liveRec.livePack);
    assert(!readdirSync(join(TMP, 'runs', 'live-synthetic')).includes('live'), 'no live/ directory is created for a file-sourced B');
    const persisted = readJourneyRuns('live-synthetic')[0];
    assert(persisted.branches.length === liveRec.branches.length && JSON.stringify(persisted.chains) === JSON.stringify(liveRec.chains) && persisted.transition.reason === 'first run',
           'branches, chains and transition round-trip through the run history file');
    assert(typeof liveRec.chains.undeclaredNodes === 'number' && liveRec.chains.degradedNodes === liveRec.branches.filter(b => b.verdict !== 'undeclared').reduce((s, b) => s + b.degraded.length, 0)
           && liveRec.chains.undeclaredNodes === liveRec.branches.filter(b => b.verdict === 'undeclared').reduce((s, b) => s + b.degraded.length, 0),
           'chains.degradedNodes counts the declared chains\' nodes and undeclaredNodes the live-only nodes of undeclared chains', { d: liveRec.chains.degradedNodes, u: liveRec.chains.undeclaredNodes });
    await new Promise(r => setTimeout(r, 5));
    const liveRec2 = await runJourney(loadJourneyDef('live-synthetic'));
    assert(liveRec2.transition && liveRec2.transition.any === false && liveRec2.transition.since === liveRec.startedAt && liveRec2.transition.changed.length === 0 && liveRec2.transition.reason === null && liveRec2.transition.skipped.length === 0,
           'an identical second run reads transition.any false against the first run, with no reason and nothing skipped', liveRec2.transition);
    assert(JSON.stringify(liveRec2.branches) === JSON.stringify(liveRec.branches), 'identical inputs record identical branches');
    assert(liveRec2.livePack.kept === false && /^Pack B is a file/.test(liveRec2.livePack.reason), 'the file rule wins over the transition rule');
    const md2 = renderJourneyMarkdown(liveRec2);
    assert(/### Requirement chains/.test(md2) && /\| chain \| verdict \| ladder \| integrity \| ladder integrity \| worst node \|/.test(md2), 'markdown carries the requirement-chains table with its header');
    assert(new RegExp(`\\| ${liveRec.branches[0].title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\| ${liveRec.branches[0].verdict} \\| ${liveRec.branches[0].ladderVerdict} \\| ${liveRec.branches[0].integrityPct}% \\| ${liveRec.branches[0].ladderIntegrityPct}% \\| `).test(md2),
           'a chain row prints title, verdict, ladder verdict and both integrities', md2);
    assert(/blinds \d+ SLOs?\)/.test(md2), 'the worst-node cell says how many SLOs it blinds');
    assert(/### Transitions since previous run/.test(md2) && new RegExp(`_no chain changed since ${liveRec.startedAt.replace(/[.]/g, '\\.')}_`).test(md2), 'markdown says no chain changed since the previous run', md2);
    assert(/_no previous run to compare_/.test(renderJourneyMarkdown(liveRec)), 'the first run\'s markdown says there is no previous run to compare');
    assert(/^live pack: not kept — Pack B is a file/m.test(md2), 'markdown prints the live-pack decision with its reason', md2);
    assert(!/### Requirement chains/.test(renderJourneyMarkdown({ ...liveRec, branches: [] })), 'no chains → no table (never an empty "all intact" table)');
    {
      const many = { ...liveRec, branches: Array.from({ length: 30 }, (_, i) => ({ ...liveRec.branches[0], title: `chain_${i}` })) };
      const manyMd = renderJourneyMarkdown(many);
      assert((manyMd.match(/^\| chain_\d+ \|/gm) || []).length === 24 && /6 more chain\(s\) not shown/.test(manyMd), 'the chains table is capped at 24 rows and says how many were left out');
    }
    assert(chainStatusLine(liveRec) === `chains ${c.intact}/${c.declaredTotal} intact · ladder ${c.ladder.healthy} healthy` + ['degraded', 'broken', 'unobserved'].filter(k => c.ladder[k] > 0).map(k => ` · ${c.ladder[k]} ${k}`).join(''),
           'chainStatusLine reads intact/declared and the nonzero ladder buckets', chainStatusLine(liveRec));
    assert(chainStatusLine({ branches: [{ verdict: 'intact', ladderVerdict: 'healthy', integrityPct: 100, ladderIntegrityPct: 100, degraded: [] }, { verdict: 'partial', ladderVerdict: 'degraded', integrityPct: 50, ladderIntegrityPct: 50, degraded: [] }] }) === 'chains 1/2 intact · ladder 1 healthy · 1 degraded'
           && chainStatusLine({ outcome: 'vantage-lost' }) === 'chains none (vantage lost)' && chainStatusLine({ outcome: 'pass', drift: {} }) === 'chains none (pre-step-4 record)'
           && chainStatusLine({ branches: [] }) === 'chains 0 declared' && chainStatusLine({ branches: [{ verdict: 'undeclared', ladderVerdict: 'undeclared' }] }) === 'chains 0 declared',
           'chainStatusLine omits zero buckets, distinguishes a record without chains (pre-step-4 / vantage lost) from one that declares none');
  }
  const liveMd = renderJourneyMarkdown(liveRec);
  assert(/Live probes/.test(liveMd) && /failed: dashboards/.test(liveMd) && /not exposed: scrape_configs/.test(liveMd) && /vantage \*\*partial\*\*/.test(liveMd),
         'markdown prints the probes line with failed / not-exposed families and the vantage');
  assert(/12 MCP tools exposed/.test(liveMd), 'markdown prints the tools-exposed count');
  assert(/1 scrape job\(s\) down · 3 unhealthy rule\(s\)/.test(liveMd), 'markdown prints the on-wire health line');
  assert(/\| Stack self-metrics \| sampled 12 · empty 3 · failed 0 \|/.test(liveMd), 'markdown prints the stack self-metrics line');
  assert(/not attempted \(metrics_query not exposed by this MCP \(restricted tier\)\)/.test(renderJourneyMarkdown({ ...liveRec, stack: { status: 'not-attempted', reason: 'metrics_query not exposed by this MCP (restricted tier)', sampled: 0, empty: 0, failed: 0, notAttempted: 24 } })),
         'markdown prints the not-attempted reason for a restricted tier');
  assert(/\*\*failOnPartialEvidence\*\*/.test(liveMd) && /\*\*maxUnhealthy\*\*/.test(liveMd), 'markdown lists both new breach types');
  assert(/no live probes \(file-sourced B\)/.test(renderJourneyMarkdown(rec)), 'file-sourced report says there were no live probes');

  // --- step 3: gate key `stack` — thresholds on the samples ---
  assert(formatStackValue(0.8333, 'ratio') === '83.3%' && formatStackValue(0.0041, 'per-second') === '0.004/s' && formatStackValue(0.04, 'per-hour') === '0.0/h'
         && formatStackValue(7.44, 'seconds') === '7.4s' && formatStackValue(1.2, 'count') === '1' && formatStackValue(3, 'unknown-unit') === '3',
         'formatStackValue formats each contracts unit', ['ratio', 'per-second', 'per-hour', 'seconds', 'count'].map(u => formatStackValue(1.23456, u)));
  assert(formatStackValue(null, 'count') === '—' && formatStackValue(NaN, 'ratio') === '—' && formatStackValue('7', 'count') === '—', 'formatStackValue never prints a non-number as a number');
  const sampled = { ...facts, stackEvidence: lf.stackEvidence };
  const noStack = { ...facts, stackEvidence: null };
  const notAttempted = { ...facts, stackEvidence: { status: 'not-attempted', reason: 'metrics_query not exposed by this MCP (restricted tier)', rows: [], alertmanager: null, grafana: null } };
  const noData = { ...facts, stackEvidence: { ...lf.stackEvidence, rows: lf.stackEvidence.rows.filter(r => r.outcome !== 'data') } };
  breaches = evaluateGate({ stack: { requireSampled: true } }, noStack);
  assert(breaches.length === 1 && breaches[0].criterion === 'stack' && /not sampled \(Pack B is not a live draft\)/.test(breaches[0].detail) && /cannot prove stack health/.test(breaches[0].detail),
         'requireSampled breaches on a file-sourced B (no stack evidence) and says the vantage cannot prove stack health', breaches);
  breaches = evaluateGate({ stack: { requireSampled: true } }, notAttempted);
  assert(breaches.length === 1 && breaches[0].criterion === 'stack' && /not sampled \(metrics_query not exposed by this MCP \(restricted tier\)\)/.test(breaches[0].detail),
         'requireSampled breaches on a not-attempted panel with the reason', breaches);
  breaches = evaluateGate({ stack: { requireSampled: true } }, noData);
  assert(breaches.length === 1 && breaches[0].criterion === 'stack' && /no row answered with data/.test(breaches[0].detail),
         'requireSampled breaches when the panel was sampled but no row answered data', breaches);
  assert(evaluateGate({ stack: { requireSampled: true } }, sampled).length === 0, 'requireSampled passes when a row answered data');
  assert(evaluateGate({ stack: { requireSampled: false } }, noStack).length === 0 && evaluateGate({ stack: {} }, noStack).length === 0, 'requireSampled: false / an empty stack block never breach');
  assert(evaluateGate({ stack: { rows: { scrape_success_ratio: { min: 0.9 }, scrape_targets_down: { max: 5 } } } }, sampled).length === 0, 'row thresholds pass when the samples sit inside the band');
  breaches = evaluateGate({ stack: { rows: { scrape_success_ratio: { min: 0.99 } } } }, sampled);
  assert(breaches.length === 1 && breaches[0].criterion === 'stack.scrape_success_ratio' && /scrape_success_ratio = 95\.0% ratio outside \[99\.0% … ∞\]/.test(breaches[0].detail) && /point-in-time sample, not an SLO verdict/.test(breaches[0].detail),
         'a min breach names the row, the formatted value with its unit, the band, and says it is a sample not an SLO verdict', breaches);
  breaches = evaluateGate({ stack: { rows: { scrape_targets_down: { max: 0 } } } }, sampled);
  assert(breaches.length === 1 && breaches[0].criterion === 'stack.scrape_targets_down' && /scrape_targets_down = 2 count outside \[-∞ … 0\]/.test(breaches[0].detail),
         'a max breach formats a count as an integer with an open lower bound', breaches);
  breaches = evaluateGate({ stack: { rows: { scrape_targets_down: { min: 0, max: 1 } } } }, sampled);
  assert(breaches.length === 1 && /outside \[0 … 1\]/.test(breaches[0].detail), 'a two-sided band prints both bounds', breaches);
  assert(evaluateGate({ stack: { rows: { scrape_targets_down: { max: 2 }, scrape_success_ratio: { min: 0.95, max: 0.95 } } } }, sampled).length === 0, 'boundary equality passes (< min / > max, never <= / >=)');
  breaches = evaluateGate({ stack: { rows: { notification_errors: { max: 0 } } } }, sampled);
  assert(breaches.length === 1 && breaches[0].criterion === 'stack.notification_errors' && /no sample for notification_errors \(failed: HTTP 500\) — threshold cannot be checked/.test(breaches[0].detail),
         'a threshold on a row that did not answer data breaches as "no sample" with the outcome and reason — never passes by absence', breaches);
  breaches = evaluateGate({ stack: { rows: { rule_evaluation_failures: { max: 0 } } } }, sampled);
  assert(breaches.length === 1 && /no sample for rule_evaluation_failures \(empty\)/.test(breaches[0].detail), 'an empty row breaches a threshold as "no sample (empty)"', breaches);
  breaches = evaluateGate({ stack: { rows: { log_shipper_drops: { max: 0 } } } }, sampled);
  assert(breaches.length === 1 && /\(not-in-inventory\)/.test(breaches[0].detail), 'a not-in-inventory row breaches a threshold as "no sample"', breaches);
  breaches = evaluateGate({ stack: { rows: { tsdb_compaction_failures: { max: 0 } } } }, sampled);
  assert(breaches.length === 1 && breaches[0].criterion === 'stack.tsdb_compaction_failures' && /no sample for tsdb_compaction_failures \(not attempted by the sampler — call budget exhausted or row not observed\)/.test(breaches[0].detail),
         'a threshold on a row absent from a sampled panel breaches honestly and names why the sampler has no row', breaches);
  breaches = evaluateGate({ stack: { rows: { scrape_targets_down: { max: 0 } } } }, notAttempted);
  assert(breaches.length === 1 && /no sample for scrape_targets_down \(not-attempted: metrics_query not exposed by this MCP \(restricted tier\)\)/.test(breaches[0].detail),
         'a threshold on a not-attempted panel carries the tier reason — the breach reads as a tier limit, not a fetch hole', breaches);
  // Display rounding must not print a breach as "0.000/s outside [-∞ … 0.000/s]".
  {
    const tiny = { ...facts, stackEvidence: { ...lf.stackEvidence, rows: [
      { id: 'grafana_http_errors', family: 'dashboards', product: 'grafana', value: 0.0004, unit: 'per-second', direction: 'lower', outcome: 'data', hint: 'nonzero', at: nowIso, referenceSli: null },
      { id: 'scrape_success_ratio', family: 'scrape', product: 'generic', value: 0.8999, unit: 'ratio', direction: 'higher', outcome: 'data', hint: null, at: nowIso, referenceSli: null },
    ] } };
    breaches = evaluateGate({ stack: { rows: { grafana_http_errors: { max: 0 }, scrape_success_ratio: { min: 0.9 } } } }, tiny);
    assert(breaches.length === 2 && /grafana_http_errors = 0\.000\/s \(raw 0\.0004\) per-second outside \[-∞ … 0\.000\/s\]/.test(breaches[0].detail),
           'a value that rounds to its max bound prints the raw number', breaches[0]);
    assert(/scrape_success_ratio = 90\.0% \(raw 0\.8999\) ratio outside \[90\.0% … ∞\]/.test(breaches[1].detail),
           'a value that rounds to its min bound prints the raw number', breaches[1]);
    assert(!/raw/.test(evaluateGate({ stack: { rows: { scrape_targets_down: { max: 0 } } } }, sampled)[0].detail), 'no raw suffix when the formatted value already differs from the bound');
  }
  // evaluateGate is exported: a threshold it cannot check breaches, never passes by silence.
  for (const [label, t, why] of [
    ['NaN max', { max: NaN }, /max is not a finite number/],
    ['Infinity bounds', { min: -Infinity, max: Infinity }, /min is not a finite number/],
    ['a string bound', { max: '0' }, /max is not a finite number/],
    ['neither bound', {}, /neither min nor max declared/],
    ['min above max', { min: 5, max: 1 }, /min 5 is above max 1/],
    ['a scalar entry', 0, /not a mapping/],
  ]) {
    breaches = evaluateGate({ stack: { rows: { scrape_targets_down: t } } }, sampled);
    assert(breaches.length === 1 && breaches[0].criterion === 'stack.scrape_targets_down' && /^threshold invalid \(/.test(breaches[0].detail) && why.test(breaches[0].detail) && /cannot be checked/.test(breaches[0].detail),
           `an unvalidated gate object with ${label} breaches as "threshold invalid"`, breaches);
  }
  breaches = evaluateGate({ stack: { rows: { scrape_targets_down: { max: 0 } } } }, noStack);
  assert(breaches.length === 1 && /\(no stack evidence\)/.test(breaches[0].detail), 'a file-sourced B breaches a declared row threshold with "no stack evidence" (never silently passes)', breaches);
  assert(evaluateGate({ stack: { rows: {} } }, noStack).length === 0, 'a file-sourced B with no declared row threshold never breaches stack.rows');
  {
    const infoRow = { id: 'tsdb_active_series', family: 'tsdb', product: 'prometheus', value: 120000, unit: 'count', direction: 'info', outcome: 'data', hint: null, at: nowIso, referenceSli: null };
    const withInfo = { ...facts, stackEvidence: { ...lf.stackEvidence, rows: [...lf.stackEvidence.rows, infoRow] } };
    breaches = evaluateGate({ stack: { rows: { tsdb_active_series: { max: 100000 } } } }, withInfo);
    assert(breaches.length === 1 && /tsdb_active_series = 120000 count outside \[-∞ … 100000\]/.test(breaches[0].detail), 'an info-direction row may still carry a threshold', breaches);
    assert(evaluateGate({ stack: { rows: { tsdb_active_series: { max: 200000 } } } }, withInfo).length === 0, 'an info row inside its band passes');
    const nullValue = { ...facts, stackEvidence: { ...lf.stackEvidence, rows: [{ ...infoRow, value: null }] } };
    breaches = evaluateGate({ stack: { rows: { tsdb_active_series: { max: 1 } } } }, nullValue);
    assert(breaches.length === 1 && /data without a numeric value/.test(breaches[0].detail), 'a data row without a numeric value cannot be checked and says so', breaches);
  }
  breaches = evaluateGate({ stack: { requireSampled: true, rows: { scrape_targets_down: { max: 0 } } } }, notAttempted);
  assert(breaches.map(b => b.criterion).join() === 'stack,stack.scrape_targets_down', 'requireSampled and a row threshold breach independently on a not-attempted panel', breaches.map(b => b.criterion));

  // --- gate.stack definition validation ---
  const known = STACK_SELF_METRIC_PROBES.map(r => r.id);
  const badDef = (name, gateYaml) => {
    writeFileSync(join(TMP, 'journeys', `${name}.journey.yaml`), [
      `name: ${name}`,
      `packA: { file: ${PACK_A.replaceAll('\\', '/')} }`,
      `packB: { file: ${LIVE_B.replaceAll('\\', '/')} }`,
      ...gateYaml,
    ].join('\n'));
    try { loadJourneyDef(name); return null; } catch (e) { return e.message; }
  };
  let verr = badDef('bad-id', ['gate:', '  stack:', '    rows:', '      Scrape_Targets_Down: { max: 0 }']);
  assert(/journey bad-id: gate\.stack\.rows names unknown row Scrape_Targets_Down; known rows: /.test(verr || '') && known.every(id => (verr || '').includes(id)),
         'an unknown (case-sensitive) row id is refused at load time and the error lists every known row', verr);
  verr = badDef('bad-nan', ['gate:', '  stack:', '    rows:', '      scrape_targets_down: { max: abc }']);
  assert(/gate\.stack\.rows\.scrape_targets_down\.max must be a finite number/.test(verr || ''), 'a non-numeric bound is refused', verr);
  verr = badDef('bad-empty', ['gate:', '  stack:', '    rows:', '      scrape_targets_down: {}']);
  assert(/gate\.stack\.rows\.scrape_targets_down declares neither min nor max/.test(verr || ''), 'an entry with neither min nor max is refused', verr);
  verr = badDef('bad-band', ['gate:', '  stack:', '    rows:', '      scrape_targets_down: { min: 5, max: 1 }']);
  assert(/min 5 is above max 1/.test(verr || ''), 'min above max is refused', verr);
  verr = badDef('bad-flag', ['gate:', '  stack:', '    requireSampled: yes-please']);
  assert(/requireSampled must be true or false/.test(verr || ''), 'a non-boolean requireSampled is refused', verr);
  verr = badDef('bad-shape', ['gate:', '  stack: 3']);
  assert(/gate\.stack must be a mapping/.test(verr || ''), 'a scalar stack block is refused', verr);
  assert(badDef('good-stack', ['gate:', '  stack:', '    requireSampled: true', '    rows:', '      scrape_success_ratio: { min: 0.9 }', '      scrape_targets_down: { max: 0 }']) === null,
         'a well-formed stack block loads');
  assert(loadJourneyDef('good-stack').gate.stack.rows.scrape_targets_down.max === 0, 'the loaded definition keeps the stack thresholds');
  for (const [label, fn] of [
    ['NaN', () => validateGateStack({ rows: { scrape_targets_down: { max: NaN } } }, 'x')],
    ['Infinity', () => validateGateStack({ rows: { scrape_targets_down: { min: Infinity } } }, 'x')],
    ['a string bound', () => validateGateStack({ rows: { scrape_targets_down: { max: '0' } } }, 'x')],
    ['a list of rows', () => validateGateStack({ rows: ['scrape_targets_down'] }, 'x')],
    ['a scalar entry', () => validateGateStack({ rows: { scrape_targets_down: 0 } }, 'x')],
  ]) {
    let m = null;
    try { fn(); } catch (e) { m = e.message; }
    assert(/journey x: gate\.stack/.test(m || ''), `validateGateStack refuses ${label}`, m);
  }
  assert((() => { try { validateGateStack({ requireSampled: false }, 'x'); validateGateStack({ rows: {} }, 'x'); return true; } catch { return false; } })(), 'validateGateStack accepts requireSampled alone and an empty rows map');
  // The existing gate keys are untouched: a stack-free gate still loads without the block.
  assert(loadJourneyDef('live-synthetic').gate.stack === undefined, 'a journey without gate.stack loads unchanged');

  // --- a run with a stack gate: breaches land beside the others; report + CLI ---
  writeFileSync(join(TMP, 'journeys', 'stack-gated.journey.yaml'), [
    'name: stack-gated',
    `packA: { file: ${PACK_A.replaceAll('\\', '/')} }`,
    `packB: { file: ${LIVE_B.replaceAll('\\', '/')} }`,
    'env: prod',
    'gate:',
    '  maxUnhealthy: 10',
    '  stack:',
    '    requireSampled: true',
    '    rows:',
    '      scrape_success_ratio: { min: 0.9 }',
    '      scrape_targets_down: { max: 0 }',
    '      notification_errors: { max: 0 }',
  ].join('\n'));
  const gatedRec = await runJourney(loadJourneyDef('stack-gated'));
  assert(gatedRec.outcome === 'gate-failed', 'a stack threshold breach fails the gate', gatedRec.outcome);
  assert(gatedRec.gate.breaches.map(b => b.criterion).sort().join() === 'stack.notification_errors,stack.scrape_targets_down',
         'only the breached rows appear: requireSampled satisfied, the ratio inside its band, the count and the failed row breach', gatedRec.gate.breaches.map(b => b.criterion));
  assert(gatedRec.gate.thresholds.stack.rows.scrape_targets_down.max === 0, 'the record keeps the stack thresholds it was gated on');
  const gatedMd = renderJourneyMarkdown(gatedRec);
  assert(/### Stack self-metrics — point-in-time samples/.test(gatedMd) && /\| id \| family \| value unit \| outcome \| hint \| reference SLI \|/.test(gatedMd), 'markdown carries the stack self-metrics table with its header');
  assert(/\| scrape_success_ratio \| scrape \| 95\.0% ratio \| data \| - \| prometheus-reference\/scrape_success_ratio \|/.test(gatedMd), 'a data row prints its formatted value, unit, outcome and reference SLI', gatedMd);
  assert(/\| scrape_targets_down \| scrape \| 2 count \| data \| nonzero \| - \|/.test(gatedMd), 'the nonzero hint prints as text, a missing reference SLI as -', gatedMd);
  assert(/\| notification_errors \| notify \| - \| failed: HTTP 500 \| - \| /.test(gatedMd), 'a failed row prints no value and its reason beside the outcome', gatedMd);
  assert(/\| log_shipper_drops \| logs \| - \| not-in-inventory \|/.test(gatedMd), 'a not-in-inventory row prints its outcome, no value');
  assert(/Samples, not verdicts/.test(gatedMd), 'the table is labelled samples, not verdicts');
  assert(/- \*\*stack\.scrape_targets_down\*\* — scrape_targets_down = 2 count outside/.test(gatedMd) && /- \*\*stack\.notification_errors\*\* — no sample for notification_errors/.test(gatedMd),
         'stack breaches are listed with the other gate breaches');
  assert(!/### Stack self-metrics — point-in-time samples/.test(renderJourneyMarkdown(rec)), 'a file-sourced report has no stack table (no rows to show, no empty "healthy" table)');
  {
    const many = { ...gatedRec, stackEvidence: { ...gatedRec.stackEvidence, rows: Array.from({ length: 30 }, (_, i) => ({ ...gatedRec.stackEvidence.rows[0], id: `row_${i}` })) } };
    const manyMd = renderJourneyMarkdown(many);
    assert((manyMd.match(/^\| row_\d+ \|/gm) || []).length === 24 && /6 more row\(s\) not shown/.test(manyMd), 'the table is capped at 24 rows and says how many were left out');
  }
  assert(stackStatusLine(gatedRec) === 'stack sampled 3' && stackStatusLine(rec) === 'stack none' && stackStatusLine({ stackEvidence: { status: 'not-attempted', rows: [] } }) === 'stack not attempted'
         && stackStatusLine({ stack: { status: 'sampled', sampled: 7 } }) === 'stack sampled 7' && stackStatusLine({ outcome: 'vantage-lost' }) === 'stack none',
         'stackStatusLine reads sampled N (data rows) / not attempted / none, falling back to a pre-step-3 count-only record');

  // Studio parity: the studio's /api/diff attaches comparePackBranches to
  // the diff before grading; the journey must grade on the same construct.
  const layeredA = adapt(parseYaml(readFileSync(PACK_A, 'utf8')), { environment: 'prod' });
  const layeredB = adapt(liveB, {});
  const bareDiff = diffPacks(layeredA, layeredB, {});
  const studioDiff = { ...bareDiff, traceabilityGraph: comparePackBranches(layeredA, layeredB) };
  const posture = computePostureMatrix(layeredA, layeredB);
  const gradeStudio = computeDiagnosticGrade(layeredA, layeredB, posture, null, studioDiff);
  const gradeBare = computeDiagnosticGrade(layeredA, layeredB, posture, null, bareDiff);
  const driftOf = (g) => g.trust.criteria.find(c => c.key === 'drift-free');
  assert(studioDiff.traceabilityGraph.rollup.declaredTotal > 0, 'the example packs declare commitments, so the construct choice matters', studioDiff.traceabilityGraph.rollup);
  assert(/requirement-chain integrity/.test(driftOf(gradeStudio).detail) && !/requirement-chain integrity/.test(driftOf(gradeBare).detail),
         'with the graph attached Drift-free is chain integrity; without it, diff buckets', { studio: driftOf(gradeStudio).detail, bare: driftOf(gradeBare).detail });
  assert(liveRec.grade.score === Math.round(gradeStudio.overall.audit.scorePctExact), 'journey grade equals the studio construct', { journey: liveRec.grade.score, studio: gradeStudio.overall.audit.scorePctExact, bare: gradeBare.overall.audit.scorePctExact });
  assert(liveRec.grade.driftConstruct === 'requirement-chain', 'record says Drift-free was scored on the requirement chain', liveRec.grade.driftConstruct);
  assert(liveRec.traceability && liveRec.traceability.integrityPct === studioDiff.traceabilityGraph.rollup.integrityPct && liveRec.traceability.declaredTotal === studioDiff.traceabilityGraph.rollup.declaredTotal,
         'record carries the chain rollup the grade was scored on', liveRec.traceability);

  // --- vantage lost: the live source does not answer ---
  // A closed loopback port makes the fetcher fail on its core tools at
  // once (connection refused) — no network, no timeout wait.
  const port = await closedLoopbackPort();
  const lostUrl = `http://127.0.0.1:${port}/mcp`;
  const lostPath = join(TMP, 'journeys', 'lost.journey.yaml');
  writeFileSync(lostPath, [
    'name: lost',
    `packA: { file: ${PACK_A.replaceAll('\\', '/')} }`,
    `packB: { mcp: { url: ${lostUrl} } }`,
    'gate: { requireGradePass: true }',
  ].join('\n'));
  let lostErr = null;
  try { await runJourney(loadJourneyDef('lost')); } catch (e) { lostErr = e; }
  assert(lostErr && lostErr.vantageLost === true, 'an unreachable live source still throws (exit 2 contract), flagged as vantage loss', lostErr?.message);
  const lostRuns = readJourneyRuns('lost');
  assert(lostRuns.length === 1 && lostRuns[0].outcome === 'vantage-lost', 'the vantage loss is written to history as a run record', lostRuns.map(r => r.outcome));
  const lostRec = lostRuns[0];
  assert(typeof lostRec.error === 'string' && lostRec.error.length > 0, 'vantage-lost record carries the error message', lostRec.error);
  assert(lostRec.packB.source === `mcp:${lostUrl}` && lostRec.packA.name === 'payment-service', 'vantage-lost record names both sources', { a: lostRec.packA, b: lostRec.packB });
  assert(typeof lostRec.startedAt === 'string' && typeof lostRec.tookMs === 'number' && lostRec.gate.breaches.length === 0, 'vantage-lost record has the timing fields and no fabricated breaches');
  assert(lostRec.grade === undefined && lostRec.drift === undefined, 'vantage-lost record carries no grade or drift — nothing was verified');
  const lostMd = renderJourneyMarkdown(lostRec);
  assert(/VANTAGE LOST/.test(lostMd) && /unreachable/.test(lostMd) && /No verdict/.test(lostMd), 'markdown reports a vantage loss as no verdict', lostMd.split('\n')[0]);
  // Configuration errors are NOT vantage losses: a missing pack file leaves no record.
  writeFileSync(join(TMP, 'journeys', 'nofile.journey.yaml'), [
    'name: nofile',
    `packA: { file: ${PACK_A.replaceAll('\\', '/')} }`,
    `packB: { file: ${join(TMP, 'does-not-exist.pack.yaml').replaceAll('\\', '/')} }`,
  ].join('\n'));
  let nofileErr = null;
  try { await runJourney(loadJourneyDef('nofile')); } catch (e) { nofileErr = e; }
  assert(nofileErr && !nofileErr.vantageLost && readJourneyRuns('nofile').length === 0, 'a missing pack file is a config error — no vantage-lost record');

  // CLI contract: exit code stays 2 and the record still lands.
  const cli = spawnSync(process.execPath, [resolve('tools/cli.mjs'), 'journey', 'run', lostPath], {
    env: { ...process.env, OBSERVOGRAM_WORKSPACE: TMP }, encoding: 'utf8', timeout: 60_000,
  });
  assert(cli.status === 2, 'CLI exits 2 on vantage loss', { status: cli.status, stderr: cli.stderr.slice(0, 300) });
  assert(/packc journey:/.test(cli.stderr), 'CLI reports the error on stderr');
  assert(readJourneyRuns('lost').length === 2, 'the CLI run appended a second vantage-lost record', readJourneyRuns('lost').map(r => r.outcome));
  const cliList = spawnSync(process.execPath, [resolve('tools/cli.mjs'), 'journey', 'list'], {
    env: { ...process.env, OBSERVOGRAM_WORKSPACE: TMP }, encoding: 'utf8', timeout: 60_000,
  });
  assert(/^lost\tvantage-lost · /m.test(cliList.stdout) && !/undefined%/.test(cliList.stdout), 'journey list shows vantage-lost without a fake alignment', cliList.stdout);
  // Step 4: the chains segment follows the stack segment on every run line.
  assert(/^stack-gated\tgate-failed · .* · stack sampled 3 · chains \d+\/\d+ intact · ladder /m.test(cliList.stdout), 'journey list prints the stack status (sampled N) per journey, then the chains status', cliList.stdout);
  assert(/^pay-vs-curated\tpass · .* · stack none · chains \d+\/\d+ intact · ladder \d+ healthy/m.test(cliList.stdout), 'journey list prints stack none for a file-sourced journey, then the chains status', cliList.stdout);
  assert(!/^lost\t.*stack/m.test(cliList.stdout) && !/^lost\t.*chains/m.test(cliList.stdout), 'a vantage-lost line carries no stack or chains status');

  // --- step 4: the live-pack snapshot (policy, files, pruning, read-back) ---
  // Pure policy first: every branch of livePackDecision.
  {
    const prev = { startedAt: '2026-09-08T09:00:00.000Z', outcome: 'pass', branches: [] };
    const quiet = { since: prev.startedAt, changed: [], appeared: [], disappeared: [], any: false };
    const moved = { since: prev.startedAt, changed: [{ rootKey: 'x' }], appeared: ['y'], disappeared: [], any: true };
    const d = (patch) => livePackDecision({ policy: undefined, previousRun: prev, transition: quiet, outcome: 'pass', packBIsFile: false, packBSource: 'mcp:http://x/mcp', ...patch });
    assert(KEEP_LIVE_PACK_POLICIES.join() === 'transitions,always,never', 'the policies are transitions, always, never');
    assert(d({ packBIsFile: true, packBSource: '/p/b.yaml' }).kept === false && d({ packBIsFile: true, packBSource: '/p/b.yaml', policy: 'always' }).reason === 'Pack B is a file (/p/b.yaml)',
           'a file-sourced Pack B is never kept, even under always');
    assert(d({ policy: 'never', transition: moved }).kept === false && d({ policy: 'never' }).reason === 'keepLivePack: never', 'never keeps nothing, even on a transition');
    assert(d({ policy: 'always' }).kept === true && d({ policy: 'always' }).reason === 'keepLivePack: always', 'always keeps a quiet run');
    assert(d({ previousRun: null, transition: null }).kept === true && d({ previousRun: null, transition: null }).reason === 'first run (no previous record)', 'transitions keeps the first run');
    assert(d({ previousRun: { startedAt: 't0', outcome: 'vantage-lost' }, transition: null }).kept === true && /previous run t0 lost its vantage/.test(d({ previousRun: { startedAt: 't0', outcome: 'vantage-lost' }, transition: null }).reason),
           'transitions keeps the run after a vantage loss');
    assert(d({ previousRun: { startedAt: 't0', outcome: 'pass' }, transition: null }).kept === true && /carries no chain record to compare/.test(d({ previousRun: { startedAt: 't0', outcome: 'pass' }, transition: null }).reason),
           'transitions keeps the run after a record that cannot be compared (pre-chain record)');
    assert(d({ transition: moved }).kept === true && d({ transition: moved }).reason === `chains changed since ${prev.startedAt}: 1 changed · 1 appeared`, 'transitions keeps a run whose chains moved and says what moved');
    assert(d({ outcome: 'gate-failed' }).kept === true && d({ outcome: 'gate-failed' }).reason === 'gate failed', 'transitions keeps a gate failure without a transition');
    assert(d({}).kept === false && d({}).reason === `no transition since ${prev.startedAt}`, 'transitions drops a quiet passing run and names the previous run');
    assert(d({ policy: 'bogus' }).reason === `no transition since ${prev.startedAt}`, 'an unknown policy reads as the default (transitions)');
    assert(JSON.stringify(liveVersions({ metadata: { annotations: { 'mcp.versions.b': '1', 'mcp.versions.a': 'live', 'mcp.versions.a.source': 'x', 'mcp.versions.c': '', 'mcp.url': 'u' } } })) === JSON.stringify({ a: 'live', b: '1' })
           && liveVersions({ metadata: { annotations: { 'mcp.versions.a.source': 'x' } } }) === null && liveVersions(null) === null,
           'liveVersions keeps bare product keys with a value, sorted; provenance-only or no annotations read null');
    assert(pruneLiveSnapshots(['2026-01-02T00-00-00-000Z.json', 'notes.json', 'live'], ['2026-01-01T00-00-00-000Z.json', '2026-01-02T00-00-00-000Z.json', 'notes.json', '2026-01-03T00-00-00-000Z.json']).join() === '2026-01-01T00-00-00-000Z.json',
           'pruneLiveSnapshots names only the run-shaped live files OLDER than the oldest surviving record — never a survivor, never a non-run file, never a newer snapshot whose record a concurrent writer has not landed yet');
    assert(pruneLiveSnapshots(null, ['2026-01-01T00-00-00-000Z.json']).length === 0 && pruneLiveSnapshots(['notes.json'], ['2026-01-01T00-00-00-000Z.json']).length === 0 && pruneLiveSnapshots([], null).length === 0 && pruneLiveSnapshots(['x'], [3, null]).length === 0,
           'with no surviving record nothing is older than one — nothing is named; missing lists and non-string entries are tolerated');
    assert(LIVE_PACK_PATH_RE.test('live/2026-01-01T00-00-00-000Z.json') && !LIVE_PACK_PATH_RE.test('live/../x.json') && !LIVE_PACK_PATH_RE.test('2026-01-01T00-00-00-000Z.json'),
           'only live/<run stem>.json is a snapshot path');
  }
  // A fake MCP that answers the core tools (and, when flipped, the
  // recording-rules family) so Pack B is a real `mcp:` source. Answers are
  // identical run to run unless `fakeRules` is set, so a chain transition
  // is under the test's control.
  let fakeRules = false;
  // Inventory coverage: when set, the fake advertises the metrics query tool and answers the
  // journey's per-kind queries — QM1 up, QM2 down, QMX not inventoried; host h1 only; 3 queues on QM1.
  let fakeInventory = false;
  const fakeMetrics = (query) => {
    const q = String(query || '');
    if (/^max by \(qmgr\)/.test(q)) return { result: [{ metric: { qmgr: 'QM1' }, value: [0, '1'] }, { metric: { qmgr: 'QM2' }, value: [0, '0'] }, { metric: { qmgr: 'QMX' }, value: [0, '1'] }] };
    if (/^max by \(host\)/.test(q)) return { result: [{ metric: { host: 'h1' }, value: [0, '1'] }] };
    if (/^count by \(qmgr\)/.test(q)) return { result: [{ metric: { qmgr: 'QM1' }, value: [0, '3'] }] };
    return { result: [] };
  };
  const fakeSrv = createHttpServer(async (req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    let msg = {};
    try { msg = JSON.parse(raw || '{}'); } catch (_) {}
    const send = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'journey-test-session' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, result }));
    };
    if (msg.method === 'initialize') return send({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-mcp' } });
    if (msg.method === 'notifications/initialized') return send({});
    if (msg.method === 'tools/list') {
      return send({ tools: ['system_health', 'system_topology', 'anomalies_active', 'anomalies_baselines', ...(fakeRules ? ['list_recording_rules'] : []), ...(fakeInventory ? ['metrics_query'] : [])].map(name => ({ name })) });
    }
    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      const result = name === 'system_health' ? { services: [] }
        : name === 'system_topology' ? { dependencies: [] }
        : name === 'anomalies_baselines' ? { baselines: [] }
        : name === 'list_recording_rules' ? { groups: [{ name: 'payment', interval: '1m', rules: [{ record: 'payment:api_availability:ratio_5m', expr: 'sum(rate(http_server_request_duration_seconds_count{code!~"5.."}[5m])) / sum(rate(http_server_request_duration_seconds_count[5m]))', health: 'ok' }] }] }
        : name === 'metrics_query' ? fakeMetrics(msg.params?.arguments?.query)
        : {};
      return send({ content: [{ type: 'text', text: JSON.stringify(result) }] });
    }
    send({});
  });
  await new Promise(r => fakeSrv.listen(0, '127.0.0.1', r));
  const fakeUrl = `http://127.0.0.1:${fakeSrv.address().port}/mcp`;
  try {
    const fakeDef = (name, extra = []) => {
      writeFileSync(join(TMP, 'journeys', `${name}.journey.yaml`), [
        `name: ${name}`,
        `packA: { file: ${PACK_A.replaceAll('\\', '/')} }`,
        `packB: { mcp: { url: ${fakeUrl} } }`,
        ...extra,
      ].join('\n'));
      return loadJourneyDef(name);
    };
    const liveDirOf = (name) => join(TMP, 'runs', name, 'live');
    const liveFilesOf = (name) => { try { return readdirSync(liveDirOf(name)).sort(); } catch (_) { return []; } };
    const stemOf = (r) => `${r.startedAt.replace(/[:.]/g, '-')}.json`;

    // transitions (default): first run kept, identical run not, moved run kept, gate failure kept.
    const t1 = await runJourney(fakeDef('fake-live'));
    assert(t1.packB.source === `mcp:${fakeUrl}` && t1.outcome === 'pass' && t1.transition.reason === 'first run', 'the fake MCP answers as a live source; the first run has no comparison (reason: first run)', { src: t1.packB.source, o: t1.outcome, t: t1.transition });
    assert(t1.livePack.kept === true && t1.livePack.path === `live/${stemOf(t1)}` && t1.livePack.bytes > 0 && t1.livePack.reason === 'first run (no previous record)',
           'the first run keeps the live pack under live/<record stem>.json and says why', t1.livePack);
    assert(liveFilesOf('fake-live').join() === stemOf(t1), 'the snapshot file exists beside the run directory', liveFilesOf('fake-live'));
    assert(readdirSync(join(TMP, 'runs', 'fake-live')).sort().join() === `${stemOf(t1)},live` && readJourneyRuns('fake-live').length === 1,
           'readJourneyRuns ignores the live/ directory (one record, not two)', readdirSync(join(TMP, 'runs', 'fake-live')));
    const snap = readLivePack('fake-live', t1);
    assert(snap && snap.metadata?.annotations?.['mcp.url'] === fakeUrl && snap.metadata?.name && Array.isArray(snap.spec?.slos ?? []),
           'readLivePack round-trips the canonical Pack B (its annotations name the MCP)', snap && Object.keys(snap));
    assert(Buffer.byteLength(readFileSync(join(liveDirOf('fake-live'), stemOf(t1)), 'utf8'), 'utf8') === t1.livePack.bytes,
           'livePack.bytes is the size of the written snapshot', { bytes: t1.livePack.bytes, size: Buffer.byteLength(readFileSync(join(liveDirOf('fake-live'), stemOf(t1)), 'utf8'), 'utf8') });
    assert(readLivePack('fake-live', { livePack: { kept: false, path: null } }) === null && readLivePack('fake-live', { livePack: { kept: true, path: 'live/../../x.json' } }) === null && readLivePack('fake-live', { livePack: { kept: true, path: 'live/1999-01-01T00-00-00-000Z.json' } }) === null,
           'readLivePack is null for no snapshot, a path outside the snapshot shape, and a missing file');
    assert(t1.versions === null || typeof t1.versions === 'object', 'versions is null or a map on a live source (the fake exposes no version probe)', t1.versions);
    await new Promise(r => setTimeout(r, 5));
    const t2 = await runJourney(loadJourneyDef('fake-live'));
    assert(t2.transition && t2.transition.any === false && t2.transition.since === t1.startedAt, 'an identical second live run has no transition', t2.transition);
    assert(t2.livePack.kept === false && t2.livePack.path === null && t2.livePack.reason === `no transition since ${t1.startedAt}`, 'the identical run is not kept, naming the run it did not move from', t2.livePack);
    assert(liveFilesOf('fake-live').join() === stemOf(t1), 'no snapshot was written for the identical run', liveFilesOf('fake-live'));
    assert(/^live pack: not kept — no transition since /m.test(renderJourneyMarkdown(t2)) && /_no chain changed since /.test(renderJourneyMarkdown(t2)), 'markdown prints the not-kept decision and the quiet transition');
    // Slice 4: Observogram's own deploy audit beside the runs (the server
    // appends deploys.jsonl under the workspace root). One deploy inside
    // the window (t2, t3] whose item carries the server's real selector
    // (`declared:0` — Pack A's first declared recording rule, the one the
    // third run will see move), one long before the window naming the same
    // rule, its verify line, and a torn line.
    await new Promise(r => setTimeout(r, 5));
    const depAt = new Date().toISOString();
    const depItem = { artifact: 'declared:0', group: 'rules', flavor: 'prometheus', scope: 'recording', ok: true, tookMs: 2 };
    {
      const packA = parseYaml(readFileSync(PACK_A, 'utf8'));
      assert(packA.spec.queries.recording_rules[0].name === 'payment:api_availability:ratio_5m', 'fixture: Pack A\'s first declared recording rule is the one the fake MCP exposes');
      assert(resolveDeployArtifact('declared:0', packA).join() === 'payment:api_availability:ratio_5m' && resolveDeployArtifact('declared:99', packA).length === 0 && resolveDeployArtifact('declared:x', packA).length === 0,
             'resolveDeployArtifact maps declared:<i> to the i-th declared recording rule name, nothing for an index the pack lacks', resolveDeployArtifact('declared:0', packA));
      const slo0 = packA.spec.slos[0];
      const sli0 = String(slo0.sli).replace(/^slis\./, '');
      assert(resolveDeployArtifact(`slo:${slo0.id}`, packA).join() === [...new Set([slo0.id, slo0.id.replace(/_\d+(?:_\d+)*$/, ''), sli0])].join(),
             'resolveDeployArtifact maps slo:<id> to the SLO id, its SLI base and the SLI the pack binds it to', resolveDeployArtifact(`slo:${slo0.id}`, packA));
      assert(resolveDeployArtifact('slo:no_such_slo_99', packA).join() === 'no_such_slo_99,no_such_slo', 'an SLO the pack does not declare still resolves to its id and SLI base (pack-free part)');
      assert(resolveDeployArtifact('dash:payment-overview', packA).join() === 'payment-overview' && resolveDeployArtifact('all', packA).length === 0 && resolveDeployArtifact('  ', packA).length === 0
             && resolveDeployArtifact('payment-overview', packA).join() === 'payment-overview' && resolveDeployArtifact('dash:', packA).length === 0 && resolveDeployArtifact(null, null).length === 0,
             'resolveDeployArtifact: dash:<id> → the id, a bare name → itself, all / blank / empty selector → nothing, no pack tolerated');
    }
    writeFileSync(join(TMP, 'deploys.jsonl'), [
      JSON.stringify({ type: 'deploy', deployId: 'dep_out', at: '2000-01-01T00:00:00.000Z', actor: 'old', pack: { id: 'payment-service', version: '1.5.0' }, env: null, mcpUrl: fakeUrl, target: { product: 'prometheus' }, mode: 'upsert', dryRun: false, items: [depItem], summary: { total: 1, ok: 1, failed: 0 } }),
      JSON.stringify({ type: 'deploy', deployId: 'dep_in', at: depAt, actor: 'carlos', pack: { id: 'payment-service', version: '1.5.0' }, env: null, mcpUrl: fakeUrl, target: { product: 'prometheus' }, mode: 'upsert', dryRun: false, items: [depItem], summary: { total: 1, ok: 1, failed: 0 } }),
      JSON.stringify({ type: 'verify', deployId: 'dep_in', at: depAt, outcome: 'pending' }),
      '{"type":"deploy","deployId":"dep_torn","at":"20',
    ].join('\n') + '\n');
    fakeRules = true;
    await new Promise(r => setTimeout(r, 5));
    const t3 = await runJourney(loadJourneyDef('fake-live'));
    assert(t3.transition && t3.transition.any === true && t3.transition.changed.length > 0 && t3.transition.since === t2.startedAt,
           'exposing the recording-rules family moves chains (unobserved → absent is a ladder transition)', t3.transition && { any: t3.transition.any, changed: t3.transition.changed.map(c => [c.title, c.from, c.to, c.direction]) });
    assert(t3.transition.changed.every(c => c.from.ladderVerdict === 'unobserved' || c.from.verdict !== c.to.verdict) && t3.transition.changed.some(c => c.direction === 'worse'),
           'the vantage that now looks and sees nothing reads worse — not "changed", never a cause', t3.transition.changed.map(c => c.direction));
    // Step 5: journey-notify's zero-import worse predicate agrees with transitionGotWorse on every recorded run.
    assert([t1, t2, t3].every(r => chainGotWorse(r) === transitionGotWorse(r)) && chainGotWorse(t3) === true && chainGotWorse(t2) === false,
           'journey-notify chainGotWorse is pinned equal to journey.mjs transitionGotWorse over the step-4 records', [t1, t2, t3].map(r => [chainGotWorse(r), transitionGotWorse(r)]));
    assert(t3.livePack.kept === true && new RegExp(`^chains changed since ${t2.startedAt.replace(/[.]/g, '\\.')}: \\d+ changed`).test(t3.livePack.reason) && t3.livePack.path === `live/${stemOf(t3)}`,
           'the moved run keeps its live pack and the reason says what moved', t3.livePack);
    assert(liveFilesOf('fake-live').join() === [stemOf(t1), stemOf(t3)].join(), 'the live directory holds the first and the moved run', liveFilesOf('fake-live'));
    const md3 = renderJourneyMarkdown(t3);
    assert(/### Transitions since previous run/.test(md3) && /→ .*\((worse|better|changed)\)/.test(md3) && /^live pack: kept \(live\/.*\.json, \d+ bytes\) — chains changed since/m.test(md3),
           'markdown lists the transitions with their direction and the kept live pack', md3.split('### Transitions since previous run')[1]?.slice(0, 400));
    const t3json = JSON.parse(JSON.stringify(readJourneyRuns('fake-live')[0]));
    assert(t3json.transition.any === true && t3json.livePack.kept === true && readLivePack('fake-live', t3json)?.metadata?.annotations?.['mcp.url'] === fakeUrl,
           'transition and livePack round-trip through the history file and readLivePack works from the persisted record');
    // Slice 4: candidate causes. The first run has nothing to rank against,
    // the identical run nothing to explain, the moved run finds the deploy
    // inside the window — and the vantage change rides beside it.
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert(t1.causes === null && /### Candidate causes — ranked by evidence, not a root-cause verdict\n\n_no previous run_/.test(renderJourneyMarkdown(t1)),
           'the first run records causes null and its markdown says there is no previous run');
    assert(t2.causes && typeof t2.causes === 'object' && Object.keys(t2.causes).join() === 'causes,vantage,note' && t2.causes.causes.length === 0
           && t2.causes.note === 'candidate causes ranked by evidence — not a root-cause verdict' && t2.causes.vantage?.changed === false,
           'an identical run records an empty cause list with the note and an unchanged vantage — and no second copy of the transition', t2.causes);
    assert(new RegExp(`_no chain got worse since ${escapeRe(t1.startedAt)}_\n\nvantage: unchanged`).test(renderJourneyMarkdown(t2)), 'the quiet run\'s markdown says no chain got worse and the vantage is unchanged', renderJourneyMarkdown(t2).split('### Candidate causes')[1]);
    const c3 = t3.causes;
    assert(c3 && c3.causes.length === 1 && c3.causes[0].rank === 1 && c3.causes[0].kind === 'observogram-deploy' && c3.causes[0].score === 0.9,
           'the moved run ranks the deploy inside the window first (0.9)', c3 && c3.causes);
    assert(c3.causes[0].evidence === `deploy dep_in by carlos at ${depAt} (upsert) touched declared:0 → payment:api_availability:ratio_5m; verify: pending`,
           'the deploy evidence names deployId, actor, at, mode, the selector with the rule it resolved to against Pack A, and the verify outcome merged from its verify line', c3.causes[0].evidence);
    assert(!JSON.stringify(c3).includes('dep_out') && !JSON.stringify(c3).includes('dep_torn'), 'the deploy outside the window and the torn line never appear');
    const availChain = t3.branches.find(b => b.title === 'api_availability_99_9');
    assert(c3.causes[0].chains.join() === availChain.title && c3.causes[0].rootKeys.join() === availChain.rootKey && c3.causes[0].nodes.join() === 'payment:api_availability:ratio_5m',
           'the cause names the chain by title (its identity key apart) and the recording rule the deploy touched — not the SLI whose name the rule embeds, not the still-unobserved metric of the same name', { chains: c3.causes[0].chains, rootKeys: c3.causes[0].rootKeys, nodes: c3.causes[0].nodes });
    assert(c3.vantage && c3.vantage.changed === true && /vantage lost → restricted/.test(c3.vantage.detail) && /probe family recording_rules now exposed/.test(c3.vantage.detail) && /4 → 5 MCP tools exposed/.test(c3.vantage.detail),
           'the vantage block reports the family that now answers and the tool count — beside the causes, never among them', c3.vantage);
    assert(new RegExp(`### Candidate causes — ranked by evidence, not a root-cause verdict\n\n1\\. \\[observogram-deploy\\] 0\\.9 — deploy dep_in by carlos at ${escapeRe(depAt)} \\(upsert\\) touched declared:0 → payment:api_availability:ratio_5m; verify: pending \\(chains: api_availability_99_9\\)\n\nvantage changed: vantage lost → restricted`).test(md3),
           'markdown lists the ranked causes with their chains by title, then the vantage change', md3.split('### Candidate causes')[1]);
    assert(JSON.stringify(t3json.causes) === JSON.stringify(c3), 'causes round-trip through the history file');
    assert(causeLine(t3) === `top cause: [observogram-deploy] ${c3.causes[0].evidence}` && causeLine(t2) === 'no candidate causes' && causeLine(t1) === 'no candidate causes' && causeLine({ outcome: 'vantage-lost' }) === 'no candidate causes',
           'causeLine reads the rank-1 cause or no candidate causes', causeLine(t3));
    assert(transitionGotWorse(t3) === true && transitionGotWorse(t2) === false && transitionGotWorse(t1) === false && transitionGotWorse(null) === false, 'transitionGotWorse is true only for the moved run');
    assert(t3.transition.changed.every(c => c.note === null) && t3.transition.skipped.length === 0 && t3.transition.reason === null, 'a comparison against the immediately previous run skips nothing, has no reason, and its entries carry no declared-side note when only the wire moved', t3.transition);
    // Review B-M4: every wire / request value the report interpolates goes
    // through mdCell — a label, an actor, an evidence string or a breach
    // detail carrying a heading cannot forge a section.
    {
      const forged = 'x\n\n### Gate breaches\n\n- **requireGradePass** - forged';
      const rec = JSON.parse(JSON.stringify(t3));
      rec.transition.changed[0].title = forged;
      rec.transition.changed[0].nodes.newlyDegraded = ['# not a heading', '- not a bullet', '1. not a list', 'a | b'];
      rec.transition.appeared = ['* also\r\nnot a bullet'];
      rec.causes.causes[0].evidence = `deploy dep_in by ${forged} at now (upsert) touched declared:0`;
      rec.causes.causes[0].chains = ['> not a quote'];
      rec.causes.vantage.detail = 'vantage lost → restricted\n### forged vantage';
      rec.livePack.reason = 'kept\n\n### forged live pack';
      rec.gate.breaches = [{ criterion: 'requireGradePass\n### forged', detail: 'below the bar\n\n### Gate breaches\n\n- forged' }];
      const fmd = renderJourneyMarkdown(rec);
      assert((fmd.match(/^### Gate breaches$/gm) || []).length === 1, 'exactly one Gate breaches heading survives — the forged ones are collapsed into their lines', fmd.match(/^###.*$/gm));
      assert((fmd.match(/^### /gm) || []).length === (t3.gate.breaches.length ? 0 : 1) + (renderJourneyMarkdown(t3).match(/^### /gm) || []).length, 'no interpolated value adds a heading line', fmd.match(/^###.*$/gm));
      assert(/^- \*\*x {2}### Gate breaches {2}- \*\*requireGradePass\*\* - forged\*\* — broken\/unobserved → broken\/broken \(worse\); newly degraded: /m.test(fmd), 'a title carrying line breaks and a heading prints on one line (a mid-line # is no heading; only a line-leading marker is escaped)', fmd.split('\n').find(l => l.includes('forged')));
      assert(/newly degraded: \\# not a heading, \\- not a bullet, \\1\. not a list, a \\\| b/.test(fmd), 'leading #, -, 1. markers and pipes inside node labels are neutralised', fmd.split('\n').find(l => l.includes('newly degraded')));
      assert(/- appeared: \\\* also not a bullet/.test(fmd) && /\(chains: \\> not a quote\)/.test(fmd), 'appeared keys and chain titles are escaped too', fmd.split('\n').filter(l => /appeared|chains:/.test(l)));
      assert(/^vantage changed: vantage lost → restricted ### forged vantage$/m.test(fmd) && /^live pack: kept \(live\/.*\) — kept {2}### forged live pack$/m.test(fmd), 'the vantage detail and the live-pack reason cannot open a line', fmd.split('\n').filter(l => /^vantage changed|^live pack/.test(l)));
      assert(/^1\. \[observogram-deploy\] 0\.9 — deploy dep_in by x {2}### Gate breaches/m.test(fmd), 'the rank stays the list marker and the score a plain number; the forged actor is on that same line', fmd.split('\n').find(l => l.startsWith('1. ')));
      assert(/^- \*\*requireGradePass ### forged\*\* — below the bar {2}### Gate breaches {2}- forged$/m.test(fmd), 'a breach criterion / detail prints on its own line only', fmd.split('\n').filter(l => l.startsWith('- **requireGradePass')));
    }
    // `journey list` while t3 is the newest run: the top candidate cause
    // rides on the line of the journey whose chains got worse — and, since
    // the vantage moved too (lost → restricted), that change beside it.
    {
      const cliT3 = spawnSync(process.execPath, [resolve('tools/cli.mjs'), 'journey', 'list'], { env: { ...process.env, OBSERVOGRAM_WORKSPACE: TMP }, encoding: 'utf8', timeout: 60_000 });
      assert(/^fake-live\t.* · top cause: \[observogram-deploy\] deploy dep_in by carlos at .* touched declared:0 → payment:api_availability:ratio_5m; verify: pending · vantage changed: vantage lost → restricted · probe family recording_rules now exposed · 4 → 5 MCP tools exposed$/m.test(cliT3.stdout),
             'journey list appends the top candidate cause to the journey whose chains got worse, then the vantage change beside it', cliT3.stdout.split('\n').filter(l => l.startsWith('fake-live')));
    }
    // Review B-M6: a hand-dropped notes.json in the run directory is not a
    // record — the newest run stays the newest run, and nothing reads it.
    writeFileSync(join(TMP, 'runs', 'fake-live', 'notes.json'), '{"startedAt":"zzz-not-a-run","branches":[]}');
    writeFileSync(join(TMP, 'runs', 'fake-live', 'zzzz.json'), 'not even json');
    assert(readJourneyRuns('fake-live').length === 3 && readJourneyRuns('fake-live')[0].startedAt === t3.startedAt && readJourneyRuns('fake-live', { limit: 1 })[0].startedAt === t3.startedAt,
           'readJourneyRuns reads only run-shaped files: a stray notes.json sorts after every ISO name yet never becomes the previous run', readJourneyRuns('fake-live').map(r => r.startedAt));
    // Review B-M2: a vantage-lost record between two live runs. The next run
    // compares its chains against the newest record that CARRIES chains
    // (t3), names the skipped record, and its wording says so — never "no
    // previous run", never "no chain got worse" as if something had been
    // compared against the outage.
    await new Promise(r => setTimeout(r, 5));
    const lostAt = new Date().toISOString();
    writeFileSync(join(TMP, 'runs', 'fake-live', `${lostAt.replace(/[:.]/g, '-')}.json`), JSON.stringify({
      journey: 'fake-live', startedAt: lostAt, tookMs: 3, outcome: 'vantage-lost', error: 'connect ECONNREFUSED (synthetic)',
      packA: t3.packA, packB: { source: t3.packB.source }, scope: t3.scope, gate: { thresholds: {}, breaches: [] },
    }, null, 2));
    await new Promise(r => setTimeout(r, 5));
    const t4 = await runJourney(loadJourneyDef('fake-live'));
    assert(t4.transition.since === t3.startedAt && t4.transition.reason === null && t4.transition.any === false && t4.transition.skipped.length === 1 && t4.transition.skipped[0].startedAt === lostAt && t4.transition.skipped[0].outcome === 'vantage-lost',
           'after a vantage-lost run the transition is against the newest record with chains (since = t3) and names the skipped record', t4.transition);
    assert(t4.livePack.kept === true && t4.livePack.reason === `previous run ${lostAt} lost its vantage`, 'the run after a vantage loss keeps its snapshot for that reason', t4.livePack);
    assert(t4.causes.causes.length === 0 && t4.causes.vantage.changed === true && /^vantage lost → restricted/.test(t4.causes.vantage.detail) && !('transitions' in t4.causes),
           'the vantage is compared against the lost run (lost → restricted); nothing got worse against t3; the ranker\'s copy of the diff is not persisted', t4.causes);
    const md4 = renderJourneyMarkdown(t4);
    assert(new RegExp(`### Transitions since previous run\\n\\n_previous run ${escapeRe(lostAt)} lost its vantage — comparing against ${escapeRe(t3.startedAt)}_\\n\\n_no chain changed since ${escapeRe(t3.startedAt)}_`).test(md4),
           'the transitions section says the previous run lost its vantage and which run it compared against', md4.split('### Transitions since previous run')[1]?.slice(0, 300));
    assert(new RegExp(`_no chain got worse since ${escapeRe(t3.startedAt)} \\(previous run ${escapeRe(lostAt)} lost its vantage — comparing against ${escapeRe(t3.startedAt)}\\)_\\n\\nvantage changed: vantage lost → restricted`).test(md4),
           'the causes section words the baseline the same way, then the vantage change', md4.split('### Candidate causes')[1]?.slice(0, 400));
    assert(!/no previous run/.test(md4), 'a run after an outage never claims there was no previous run', md4);
    const lostFirst = readJourneyRuns('fake-live').find(r => r.outcome === 'vantage-lost');
    assert(lostFirst && lostFirst.startedAt === lostAt && readJourneyRuns('fake-live')[0].startedAt === t4.startedAt, 'the synthetic vantage-lost record sits in the history between t3 and t4');
    // The first run after an outage with no earlier chains at all: reason 'previous run lost its vantage'.
    {
      mkdirSync(join(TMP, 'runs', 'fake-lost-first'), { recursive: true });
      writeFileSync(join(TMP, 'runs', 'fake-lost-first', `${lostAt.replace(/[:.]/g, '-')}.json`), JSON.stringify({ journey: 'fake-lost-first', startedAt: lostAt, tookMs: 3, outcome: 'vantage-lost', error: 'ECONNREFUSED', packA: t3.packA, packB: { source: t3.packB.source }, scope: t3.scope, gate: { thresholds: {}, breaches: [] } }));
      const lf = await runJourney(fakeDef('fake-lost-first'));
      assert(lf.transition.reason === 'previous run lost its vantage' && lf.transition.since === null && lf.transition.skipped.length === 1 && lf.transition.skipped[0].outcome === 'vantage-lost',
             'with no earlier record carrying chains the transition says the previous run lost its vantage (not "first run")', lf.transition);
      assert(new RegExp(`_previous run ${escapeRe(lostAt)} lost its vantage — no earlier run carries chains to compare against_`).test(renderJourneyMarkdown(lf)) && /_previous run .* lost its vantage — no earlier run carries chains to compare against — nothing to rank_/.test(renderJourneyMarkdown(lf)),
             'both sections word the uncomparable case honestly', renderJourneyMarkdown(lf).split('### Transitions')[1]);
      // A pre-step-4 record (no branches) as the only history: reason 'previous runs carry no chain record'.
      mkdirSync(join(TMP, 'runs', 'fake-prestep4'), { recursive: true });
      writeFileSync(join(TMP, 'runs', 'fake-prestep4', `${lostAt.replace(/[:.]/g, '-')}.json`), JSON.stringify({ journey: 'fake-prestep4', startedAt: lostAt, tookMs: 3, outcome: 'pass', packA: t3.packA, packB: t3.packB, scope: t3.scope, grade: { score: 90, pass: true }, drift: { alignmentPct: 80 }, gate: { thresholds: {}, breaches: [] } }));
      const ps = await runJourney(fakeDef('fake-prestep4'));
      assert(ps.transition.reason === 'previous runs carry no chain record' && ps.transition.skipped.length === 1 && ps.livePack.kept === true && /carries no chain record to compare/.test(ps.livePack.reason),
             'a pre-step-4 record as the only history reads reason "previous runs carry no chain record"', ps.transition);
      assert(new RegExp(`_previous run ${escapeRe(lostAt)} carries no chain record to compare against \\(pre-step-4 record\\)_`).test(renderJourneyMarkdown(ps)), 'the markdown names the pre-step-4 record', renderJourneyMarkdown(ps).split('### Transitions')[1]?.slice(0, 200));
    }
    // Review B-M6: a baseline whose startedAt cannot be parsed gives an EMPTY
    // deploy window — an ancient deploy naming a moved artefact is never
    // pulled in as "all of history".
    {
      mkdirSync(join(TMP, 'runs', 'fake-badstart'), { recursive: true });
      writeFileSync(join(TMP, 'runs', 'fake-badstart', '2020-01-01T00-00-00-000Z.json'), JSON.stringify({ journey: 'fake-badstart', startedAt: 'yesterday', tookMs: 3, outcome: 'pass', packA: t3.packA, packB: t3.packB, scope: t3.scope, grade: { score: 90, pass: true }, drift: { alignmentPct: 80 }, gate: { thresholds: {}, breaches: [] }, branches: [], chains: null, versions: null, transition: null, livePack: { kept: false, path: null, reason: 'x' } }));
      const ancientLog = readFileSync(join(TMP, 'deploys.jsonl'), 'utf8');
      writeFileSync(join(TMP, 'deploys.jsonl'), ancientLog + JSON.stringify({ type: 'deploy', deployId: 'dep_ancient', at: '2000-06-01T00:00:00.000Z', actor: 'old', pack: { id: 'payment-service' }, mode: 'upsert', dryRun: false, items: [depItem] }) + '\n');
      const bs = await runJourney(fakeDef('fake-badstart'));
      assert(bs.transition.since === 'yesterday' && bs.transition.appeared.length > 0 && bs.transition.any === true, 'fixture: the run compares against the bad-start baseline (every chain appears)', bs.transition);
      assert(!JSON.stringify(bs.causes).includes('dep_ancient') && !JSON.stringify(bs.causes).includes('dep_out'), 'an unparseable baseline start gives an empty deploy window: no deploy from history is a cause', bs.causes.causes.map(c => c.evidence));
      writeFileSync(join(TMP, 'deploys.jsonl'), ancientLog);
    }
    // Review B-M5: only the trailing 8 MB of deploys.jsonl are read; the
    // partial first line of the tail is dropped, never mis-parsed.
    {
      const { readDeployLog, DEPLOY_LOG_TAIL_BYTES } = await import('./lib/journey.mjs');
      assert(DEPLOY_LOG_TAIL_BYTES === 8 * 1024 * 1024, 'the tail cap is 8 MB');
      const original = readFileSync(join(TMP, 'deploys.jsonl'), 'utf8');
      const filler = [];
      let bytes = 0;
      const pad = 'x'.repeat(150);
      for (let i = 0; bytes < DEPLOY_LOG_TAIL_BYTES + 512 * 1024; i++) {
        const line = JSON.stringify({ type: 'deploy', deployId: `dep_filler_${i}`, at: '2001-01-01T00:00:00.000Z', actor: 'old', pack: { id: 'p' }, mode: 'upsert', items: [], note: pad }) + '\n';
        filler.push(line);
        bytes += Buffer.byteLength(line);
      }
      const last = JSON.stringify({ type: 'deploy', deployId: 'dep_tail_last', at: '2001-01-02T00:00:00.000Z', actor: 'old', pack: { id: 'p' }, mode: 'upsert', items: [] }) + '\n';
      writeFileSync(join(TMP, 'deploys.jsonl'), filler.join('') + last);
      const tail = readDeployLog();
      assert(tail.length > 0 && tail.length < filler.length && tail[tail.length - 1].deployId === 'dep_tail_last' && !tail.some(r => r.deployId === 'dep_filler_0'),
             'a log larger than the cap yields only its tail: the newest line is there, the oldest is not', { got: tail.length, lines: filler.length + 1 });
      assert(tail.every(r => typeof r.deployId === 'string' && r.type === 'deploy' && (r.deployId === 'dep_tail_last' || r.note === pad)), 'every record of the tail parsed whole — the cut line at the start of the tail was dropped, not mis-parsed', tail.find(r => typeof r.deployId !== 'string'));
      const first = tail[0].deployId;
      const firstIdx = Number(first.replace('dep_filler_', ''));
      assert(Number.isInteger(firstIdx) && firstIdx > 0 && filler.slice(firstIdx).join('').length + last.length <= DEPLOY_LOG_TAIL_BYTES, 'the tail starts at the first whole line inside the cap', { first, firstIdx });
      writeFileSync(join(TMP, 'deploys.jsonl'), original);
      assert(readDeployLog().length === original.split('\n').filter(l => l.trim()).length - 1, 'a log under the cap reads whole (the torn line skipped)', readDeployLog().length);
    }
    // Review B-L2: `journey list` appends the vantage change beside the
    // cause segment — for the run after the outage (no cause, vantage
    // changed) and, seeded, for a vantage-only worse transition.
    {
      writeFileSync(join(TMP, 'journeys', 'vantage-worse.journey.yaml'), ['name: vantage-worse', `packA: { file: ${PACK_A.replaceAll('\\', '/')} }`, `packB: { file: ${LIVE_B.replaceAll('\\', '/')} }`].join('\n'));
      mkdirSync(join(TMP, 'runs', 'vantage-worse'), { recursive: true });
      const vwAt = '2026-09-08T12:00:00.000Z';
      writeFileSync(join(TMP, 'runs', 'vantage-worse', `${vwAt.replace(/[:.]/g, '-')}.json`), JSON.stringify({
        journey: 'vantage-worse', startedAt: vwAt, tookMs: 3, outcome: 'pass', packA: t3.packA, packB: t3.packB, scope: t3.scope, grade: { score: 90, pass: true }, drift: { alignmentPct: 80 }, gate: { thresholds: {}, breaches: [] },
        branches: [{ rootKey: 'slo::x', title: 'x', rootKind: 'slo', verdict: 'intact', ladderVerdict: 'unobserved', integrityPct: 100, ladderIntegrityPct: 0, confidence: 'declared', missingRoles: [], degraded: [] }],
        chains: null, versions: null,
        transition: { since: '2026-09-08T11:00:00.000Z', changed: [{ rootKey: 'slo::x', title: 'x', from: { verdict: 'intact', ladderVerdict: 'healthy' }, to: { verdict: 'intact', ladderVerdict: 'unobserved' }, direction: 'worse', nodes: { newlyDegraded: [], recovered: [] }, note: null }], appeared: [], disappeared: [], any: true, skipped: [], reason: null },
        livePack: { kept: false, path: null, reason: 'Pack B is a file (x)' },
        causes: { causes: [], vantage: { changed: true, from: { vantage: 'full', failed: [], unsupported: [], toolsExposedCount: 12 }, to: { vantage: 'partial', failed: ['recording_rules'], unsupported: [], toolsExposedCount: 12 }, detail: 'vantage full → partial · probe family recording_rules newly failed (HTTP 502)' }, note: 'candidate causes ranked by evidence — not a root-cause verdict' },
      }, null, 2));
      const cliV = spawnSync(process.execPath, [resolve('tools/cli.mjs'), 'journey', 'list'], { env: { ...process.env, OBSERVOGRAM_WORKSPACE: TMP }, encoding: 'utf8', timeout: 60_000 });
      assert(/^vantage-worse\tpass · .* · no candidate causes · vantage changed: vantage full → partial · probe family recording_rules newly failed \(HTTP 502\)$/m.test(cliV.stdout),
             'a vantage-only worse transition lists no candidate causes AND the vantage change — the change is named, never blamed', cliV.stdout.split('\n').filter(l => l.startsWith('vantage-worse')));
      assert(/^fake-live\tpass · .* · ladder [^\n]* · vantage changed: vantage lost → restricted[^\n]*$/m.test(cliV.stdout) && !/^fake-live\t.*top cause/m.test(cliV.stdout),
             'the run after the outage (no cause) still lists the vantage change', cliV.stdout.split('\n').filter(l => l.startsWith('fake-live')));
      assert(!/^fake-always\t.*vantage changed/m.test(cliV.stdout), 'a run whose vantage did not change gets no vantage segment');
    }
    // Gate failure without a transition: kept, reason 'gate failed'.
    const g1 = await runJourney(fakeDef('fake-gated', ['gate: { maxDeclaredNotLive: 0 }']));
    assert(g1.outcome === 'gate-failed' && g1.livePack.kept === true && g1.livePack.reason === 'first run (no previous record)', 'a gated journey keeps its first run for being first', g1.livePack);
    await new Promise(r => setTimeout(r, 5));
    const g2 = await runJourney(loadJourneyDef('fake-gated'));
    assert(g2.outcome === 'gate-failed' && g2.transition.any === false && g2.livePack.kept === true && g2.livePack.reason === 'gate failed' && liveFilesOf('fake-gated').length === 2,
           'a quiet run that fails the gate is kept with reason "gate failed"', g2.livePack);
    // never / always / invalid.
    const n1 = await runJourney(fakeDef('fake-never', ['keepLivePack: never']));
    assert(n1.livePack.kept === false && n1.livePack.reason === 'keepLivePack: never' && !readdirSync(join(TMP, 'runs', 'fake-never')).includes('live'),
           'keepLivePack: never writes nothing (no live/ directory at all)', n1.livePack);
    const a1 = await runJourney(fakeDef('fake-always', ['keepLivePack: always']));
    await new Promise(r => setTimeout(r, 5));
    const a2 = await runJourney(loadJourneyDef('fake-always'));
    assert(a1.livePack.kept === true && a2.livePack.kept === true && a2.livePack.reason === 'keepLivePack: always' && a2.transition.any === false && liveFilesOf('fake-always').length === 2,
           'keepLivePack: always keeps a quiet identical run too', a2.livePack);
    let policyErr = null;
    try { fakeDef('fake-bad-policy', ['keepLivePack: sometimes']); } catch (e) { policyErr = e.message; }
    assert(/journey fake-bad-policy: keepLivePack must be one of transitions, always, never \(got "sometimes"\)/.test(policyErr || ''), 'an unknown keepLivePack value is refused at load time, naming the allowed values', policyErr);
    assert(loadJourneyDef('fake-live').keepLivePack === undefined, 'a journey without keepLivePack loads unchanged (the default applies at run time)');
    // Pruning: retention drops records, then their orphaned snapshots — never a survivor's.
    process.env.OBSERVOGRAM_JOURNEY_RUN_RETENTION = '2';
    const orphan = '2000-01-01T00-00-00-000Z.json';
    writeFileSync(join(liveDirOf('fake-always'), orphan), '{}');
    writeFileSync(join(liveDirOf('fake-always'), 'notes.json'), '{}');
    await new Promise(r => setTimeout(r, 5));
    const a3 = await runJourney(loadJourneyDef('fake-always'));
    assert(a3.historyError === undefined, 'pruning with snapshots reports no history error', a3.historyError);
    const survivors = readdirSync(join(TMP, 'runs', 'fake-always')).filter(f => f !== 'live').sort();
    assert(survivors.join() === [stemOf(a2), stemOf(a3)].join(), 'retention 2 keeps the two newest records', survivors);
    assert(liveFilesOf('fake-always').join() === [stemOf(a2), stemOf(a3), 'notes.json'].join(),
           'the pruned record\'s snapshot and the orphan are deleted; the survivors\' snapshots and a non-run file stay', liveFilesOf('fake-always'));
    assert(readLivePack('fake-always', a2) !== null && readLivePack('fake-always', a1) === null, 'a surviving record still reads its snapshot; a pruned one reads null');
    delete process.env.OBSERVOGRAM_JOURNEY_RUN_RETENTION;
    // A snapshot that cannot be written lands as historyError, never thrown; the record still lands.
    const blocked = join(liveDirOf('fake-never'));
    mkdirSync(join(TMP, 'runs', 'fake-never'), { recursive: true });
    writeFileSync(blocked, 'not a directory');
    writeFileSync(join(TMP, 'journeys', 'fake-never.journey.yaml'), [
      'name: fake-never',
      `packA: { file: ${PACK_A.replaceAll('\\', '/')} }`,
      `packB: { mcp: { url: ${fakeUrl} } }`,
      'keepLivePack: always',
    ].join('\n'));
    await new Promise(r => setTimeout(r, 5));
    const blockedRun = await runJourney(loadJourneyDef('fake-never'));
    assert(blockedRun.outcome === 'pass' && blockedRun.livePack.kept === false && /^live pack live\/.*\.json: /.test(blockedRun.historyError || '') && /^snapshot write failed: live pack live\/.*\.json: /.test(blockedRun.livePack.reason),
           'a snapshot write failure is noted as historyError on the record, the run still lands and livePack reads not kept with the failure as its reason (never the policy that asked for it)', { lp: blockedRun.livePack, he: blockedRun.historyError });
    assert(readJourneyRuns('fake-never')[0]?.startedAt === blockedRun.startedAt && readJourneyRuns('fake-never')[0].historyError === blockedRun.historyError, 'the persisted record carries the same historyError');
    // The CLI line shows the chains segment for a live journey too.
    const cliLive = spawnSync(process.execPath, [resolve('tools/cli.mjs'), 'journey', 'list'], { env: { ...process.env, OBSERVOGRAM_WORKSPACE: TMP }, encoding: 'utf8', timeout: 60_000 });
    assert(/^fake-live\tpass · .* · chains \d+\/\d+ intact · ladder \d+ healthy/m.test(cliLive.stdout), 'journey list prints the chains status for a live journey', cliLive.stdout.split('\n').filter(l => l.startsWith('fake-live')));
    assert(/^fake-live\t.* · ladder [^\n]* · vantage changed: vantage lost → restricted[^\n]*$/m.test(cliLive.stdout) && !/^fake-live\t.*top cause/m.test(cliLive.stdout),
           'once the run after the outage is the newest, the line carries the vantage change and no cause segment (nothing got worse against t3)', cliLive.stdout.split('\n').filter(l => l.startsWith('fake-live')));
    assert(/^fake-always\t.* · ladder [^\n]*$/m.test(cliLive.stdout) && !/^fake-always\t.*top cause/m.test(cliLive.stdout) && !/^fake-always\t.*no candidate causes/m.test(cliLive.stdout),
           'a journey whose chains did not get worse gets no cause segment at all', cliLive.stdout.split('\n').filter(l => l.startsWith('fake-always')));
    // ---------- inventory coverage: the site's expected sets against the fake MCP's up series ----------
    mkdirSync(join(TMP, 'sites', 'prod'), { recursive: true });
    writeFileSync(join(TMP, 'sites', 'prod', 'site.json'), readFileSync(resolve('tools/fixtures/site/prod.site.expected.json'), 'utf8'));
    // load-time validation
    let threw = null;
    try { fakeDef('inv-bad-block', ['inventory: sites/prod/site.json']); } catch (e) { threw = e.message; }
    assert(/journey inv-bad-block: inventory must be a mapping/.test(threw || ''), 'a scalar inventory: block is a load error', threw);
    threw = null;
    try { fakeDef('inv-bad-gate', ['inventory: { site: ../sites/prod/site.json }', 'gate: { inventory: { maxSilent: -1 } }']); } catch (e) { threw = e.message; }
    assert(/gate\.inventory\.maxSilent must be a non-negative integer/.test(threw || ''), 'a bad gate.inventory is a load error', threw);
    // the MCP does not advertise the metrics query tool: not-attempted, and requireChecked (the default) breaches
    fakeInventory = false;
    const invNa = await runJourney(fakeDef('inv-na', ['inventory: { site: ../sites/prod/site.json }', 'gate: { minAlignmentPct: 1, inventory: { maxSilent: 0 } }']));
    assert(invNa.inventory?.status === 'not-attempted' && /metrics_query/.test(invNa.inventory.reason || ''), 'without the metrics tool the inventory block is not-attempted with the tier reason', invNa.inventory);
    assert(invNa.inventory.site === '../sites/prod/site.json' && invNa.inventory.environment === 'prod' && Object.keys(invNa.inventory.kinds).join() === 'qmgr,host,queue', 'the record names the site, the environment and every kind', invNa.inventory);
    assert(invNa.inventory.kinds.qmgr.status === 'not-attempted' && invNa.inventory.kinds.qmgr.expected === 3 && invNa.inventory.kinds.qmgr.up === null, 'a not-attempted kind keeps its expected count and no observed numbers', invNa.inventory.kinds.qmgr);
    assert(invNa.outcome === 'gate-failed' && invNa.gate.breaches.some(b => b.criterion === 'inventory' && /not-attempted/.test(b.detail)), 'requireChecked (default) breaches when coverage could not be checked', invNa.gate.breaches);
    // the MCP answers: up / down / silent / unexpected per kind, floors on the counted kind, the gate names each
    fakeInventory = true;
    const inv = await runJourney(fakeDef('inv-live', ['inventory: { site: ../sites/prod/site.json }', 'gate: { minAlignmentPct: 1, inventory: { maxSilent: 0, maxDown: 0, maxUnexpected: 0 } }']));
    assert(inv.inventory.status === 'checked' && inv.inventory.reason === null, 'with the metrics tool every kind is checked', inv.inventory);
    const q = inv.inventory.kinds.qmgr;
    assert(q.expected === 3 && q.up === 1 && JSON.stringify(q.upNames) === '["QM1"]' && JSON.stringify(q.down) === '["QM2"]' && JSON.stringify(q.silent) === '["QM3"]' && JSON.stringify(q.unexpected) === '["QMX"]' && q.coveragePct === 33.3,
           'qmgr: QM1 up, QM2 targeted but down, QM3 silent, QMX answering but not inventoried', q);
    assert(JSON.stringify(inv.inventory.kinds.host.silent) === '["h2"]' && inv.inventory.kinds.host.up === 1, 'host: h2 silent (no up series carries host=h2)', inv.inventory.kinds.host);
    const qu = inv.inventory.kinds.queue;
    assert(qu.mode === 'counted' && qu.total === 3 && JSON.stringify(qu.below) === '[{"parent":"QM1","count":3,"min":5}]' && qu.missing.length === 0, 'queue: 3 counted on QM1, below its floor of 5', qu);
    const crits = inv.gate.breaches.map(b => b.criterion).sort();
    assert(JSON.stringify(crits) === JSON.stringify(['inventory.host.silent', 'inventory.qmgr.down', 'inventory.qmgr.silent', 'inventory.qmgr.unexpected', 'inventory.queue.min']), 'the gate names every hole per kind, and the floor', crits);
    assert(inv.gate.breaches.find(b => b.criterion === 'inventory.qmgr.silent').detail.includes('QM3'), 'a breach names the silent item');
    const md = renderJourneyMarkdown(inv);
    assert(/\| Inventory coverage \| inventory 1\/3 qmgr \(1 down, 1 silent, 1 unexpected\) · 1\/2 host \(1 silent\) · 3 queues \(1 below floor\) \|/.test(md), 'the report carries the inventory line', md.split('\n').find(l => /Inventory coverage \|/.test(l)));
    assert(/### Inventory coverage — checked/.test(md) && /\| qmgr \(queue manager\) \| 3 \| 1 \| QM2 \| QM3 \| QMX \| checked · 33\.3% \|/.test(md), 'the report carries the per-kind table', md.split('\n').filter(l => /^\| (qmgr|host|queue)/.test(l)).join('\n'));
    // the CLI listing carries the same segment on the pass / gate-failed line
    const cliInv = spawnSync(process.execPath, [resolve('tools/cli.mjs'), 'journey', 'list'], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, OBSERVOGRAM_WORKSPACE: TMP } });
    assert(cliInv.status === 0 && /^inv-live\tgate-failed · .* · inventory 1\/3 qmgr \(1 down, 1 silent, 1 unexpected\) · 1\/2 host \(1 silent\) · 3 queues \(1 below floor\)/m.test(cliInv.stdout), 'packc journey list prints the inventory segment for a run that carries a block', cliInv.stdout.split('\n').find(l => l.startsWith('inv-live')) || cliInv.stderr);
    // a kinds: entry the site does not declare is a named failure before any wire call
    const invTypo = await runJourney(fakeDef('inv-typo', ['inventory: { site: ../sites/prod/site.json, kinds: [qmgrs] }', 'gate: { minAlignmentPct: 1, inventory: { maxSilent: 0 } }']));
    assert(invTypo.inventory.status === 'failed' && /inventory\.kinds names qmgrs — not in \.\.\/sites\/prod\/site\.json's expected block \(kinds: qmgr, host, queue\)/.test(invTypo.inventory.reason) && invTypo.outcome === 'gate-failed', 'kinds naming an unknown kind fails with the known kinds named, and requireChecked breaches', invTypo.inventory);
    const listed = inventorySummary(inv);
    assert(listed.status === 'checked' && listed.kinds.qmgr.silent === 1 && listed.kinds.qmgr.unexpected === 1 && listed.kinds.queue.below === 1 && listed.kinds.queue.total === 3, 'inventorySummary is the listing shape', listed);
    assert(inventoryStatusLine(inv) === 'inventory 1/3 qmgr (1 down, 1 silent, 1 unexpected) · 1/2 host (1 silent) · 3 queues (1 below floor)', 'inventoryStatusLine', inventoryStatusLine(inv));
    // kinds narrows both the observation and the record; a gate that does not ask for a kind ignores it
    const invHost = await runJourney(fakeDef('inv-host', ['inventory: { site: ../sites/prod/site.json, kinds: [host] }', 'gate: { minAlignmentPct: 1, inventory: { maxSilent: 5 } }']));
    assert(Object.keys(invHost.inventory.kinds).join() === 'host' && invHost.outcome === 'pass', 'kinds: [host] observes and records the host kind only', invHost.inventory);
    // an unreadable site is failed with the reason; requireChecked breaches, requireChecked: false does not
    const invMissing = await runJourney(fakeDef('inv-missing', ['inventory: { site: ../sites/nope/site.json }', 'gate: { minAlignmentPct: 1, inventory: { requireChecked: false } }']));
    assert(invMissing.inventory.status === 'failed' && /cannot read \.\.\/sites\/nope\/site\.json/.test(invMissing.inventory.reason) && invMissing.outcome === 'pass', 'a missing site.json is failed with the reason; requireChecked: false lets the run pass', invMissing.inventory);
    // a file-sourced Pack B has no live series: not-attempted, said so
    writeFileSync(join(TMP, 'journeys', 'inv-file.journey.yaml'), ['name: inv-file', `packA: { file: ${PACK_A.replaceAll('\\', '/')} }`, `packB: { file: ${PACK_A.replaceAll('\\', '/')} }`, 'inventory: { site: ../sites/prod/site.json }', 'gate: { minAlignmentPct: 1 }'].join('\n'));
    const invFile = await runJourney(loadJourneyDef('inv-file'));
    assert(invFile.inventory.status === 'not-attempted' && /file-sourced Pack B/.test(invFile.inventory.reason) && invFile.outcome === 'pass', 'a file-sourced B is not-attempted and, without gate.inventory, never breaches', invFile.inventory);
    // no inventory block: the record carries null and the listing summary is null
    assert(t1.inventory === null && inventorySummary(t1) === null && inventoryStatusLine(t1) === null, 'a journey without inventory: records null', t1.inventory);
    fakeInventory = false;
  } finally {
    await new Promise(r => fakeSrv.close(r));
  }

  // --- step 5: notify — the wire, against a node:http receiver ---
  // A fake webhook on 127.0.0.1 that records every request and answers
  // per `mode`: 202 · 500-then-202 · 500-500 · 400 (final) · hang beyond
  // the timeout. Its URL and a token travel ONLY through env vars.
  {
    const hits = [];
    let mode = 'ok';
    let flakyLeft = 0;
    const hung = new Set();
    const rx = createHttpServer(async (req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      for await (const c of req) raw += c;
      hits.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      if (mode === 'hang') { hung.add(res); return; }
      if (mode === 'down') { res.writeHead(500); res.end('nope'); return; }
      if (mode === 'reject') { res.writeHead(400); res.end('bad'); return; }
      if (mode === 'flaky' && flakyLeft > 0) { flakyLeft--; res.writeHead(500); res.end('retry'); return; }
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise(r => rx.listen(0, '127.0.0.1', r));
    const rxUrl = `http://127.0.0.1:${rx.address().port}/hook`;
    process.env.OBSERVOGRAM_TEST_WEBHOOK_URL = rxUrl;
    process.env.OBSERVOGRAM_TEST_WEBHOOK_TOKEN = 'tok-secret-123';
    // A second fake MCP (same shape as the step-4 one above, which is closed
    // by now): answers are identical run to run until `rulesExposed` flips,
    // which makes the recording-rule chains go unobserved → absent — a
    // `worse` transition under the test's control, exactly as t2 → t3.
    let rulesExposed = false;
    const mcp = createHttpServer(async (req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      for await (const chunk of req) raw += chunk;
      let msg = {};
      try { msg = JSON.parse(raw || '{}'); } catch { /* not JSON */ }
      const send = (result) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'notify-test-session' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, result })); };
      if (msg.method === 'initialize') return send({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-mcp-notify' } });
      if (msg.method === 'notifications/initialized') return send({});
      if (msg.method === 'tools/list') return send({ tools: ['system_health', 'system_topology', 'anomalies_active', 'anomalies_baselines', ...(rulesExposed ? ['list_recording_rules'] : [])].map(name => ({ name })) });
      if (msg.method === 'tools/call') {
        const name = msg.params?.name;
        const result = name === 'system_health' ? { services: [] } : name === 'system_topology' ? { dependencies: [] } : name === 'anomalies_baselines' ? { baselines: [] }
          : name === 'list_recording_rules' ? { groups: [{ name: 'payment', interval: '1m', rules: [{ record: 'payment:api_availability:ratio_5m', expr: 'sum(rate(http_server_request_duration_seconds_count{code!~"5.."}[5m])) / sum(rate(http_server_request_duration_seconds_count[5m]))', health: 'ok' }] }] }
          : {};
        return send({ content: [{ type: 'text', text: JSON.stringify(result) }] });
      }
      send({});
    });
    await new Promise(r => mcp.listen(0, '127.0.0.1', r));
    const mcpUrl = `http://127.0.0.1:${mcp.address().port}/mcp`;
    const MCP_B = `packB: { mcp: { url: ${mcpUrl} } }`;
    const A = PACK_A.replaceAll('\\', '/');
    const FILE_B = `packB: { file: ${LIVE_B.replaceAll('\\', '/')} }`;
    const notifyDef = (name, packBLine, notifyLines = [], extra = []) => {
      writeFileSync(join(TMP, 'journeys', `${name}.journey.yaml`), [
        `name: ${name}`, `packA: { file: ${A} }`, packBLine, 'env: prod', ...extra,
        'notify:', '  urlEnv: OBSERVOGRAM_TEST_WEBHOOK_URL', '  authEnv: OBSERVOGRAM_TEST_WEBHOOK_TOKEN', '  timeoutMs: 1000', ...notifyLines,
      ].join('\n'));
      return loadJourneyDef(name);
    };
    // The CLI, asynchronously: both fakes live in THIS process, so a
    // spawnSync would block the event loop they answer from.
    const runCli = (args) => new Promise((res) => {
      const child = spawn(process.execPath, [resolve('tools/cli.mjs'), ...args], { env: { ...process.env, OBSERVOGRAM_WORKSPACE: TMP } });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', (status) => res({ status, stdout, stderr }));
    });
    const loadErr = (name, lines) => {
      writeFileSync(join(TMP, 'journeys', `${name}.journey.yaml`), [`name: ${name}`, `packA: { file: ${A} }`, `packB: { file: ${LIVE_B.replaceAll('\\', '/')} }`, ...lines].join('\n'));
      try { loadJourneyDef(name); return null; } catch (e) { return e.message; }
    };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    try {
      // (h) secrets never live in a journey file: literal keys are refused at load, naming the env-var alternative.
      assert(loadErr('notify-literal', ['notify: { url: https://hooks.example/x }']) === 'journey notify-literal: notify.url is not allowed — reference an env var name with urlEnv (secrets never live in a journey file)',
             'a literal notify.url is refused at load with the pinned message', loadErr('notify-literal', ['notify: { url: https://hooks.example/x }']));
      assert(/notify\.token is not allowed — reference an env var name with authEnv/.test(loadErr('notify-token', ['notify: { urlEnv: X, token: abc }']) || ''), 'a literal notify.token is refused');
      assert(/notify\.headers is not allowed/.test(loadErr('notify-headers', ['notify:', '  urlEnv: X', '  headers:', '    X-Key: abc']) || ''), 'a literal notify.headers block is refused');
      assert(/notify\.webhook is not a known key \(known: urlEnv, authEnv, on, format, timeoutMs, studioUrl\)/.test(loadErr('notify-unknown', ['notify: { urlEnv: X, webhook: y }']) || ''), 'an unknown notify key is named with the known ones');
      assert(/notify\.urlEnv must name an environment variable \(got undefined\)/.test(loadErr('notify-nourl', ['notify: { on: always }']) || ''), 'urlEnv is required');
      assert(/notify\.urlEnv must name an environment variable \(got "https:\/\/x"\)/.test(loadErr('notify-urlval', ['notify: { urlEnv: https://x }']) || ''), 'urlEnv must be an env var NAME, not a URL');
      assert(/notify\.on must be one of transitions, breach, always \(got "sometimes"\)/.test(loadErr('notify-on', ['notify: { urlEnv: X, on: sometimes }']) || ''), 'notify.on is closed over the three policies');
      assert(/notify\.format must be one of json, text \(got "xml"\)/.test(loadErr('notify-fmt', ['notify: { urlEnv: X, format: xml }']) || ''), 'notify.format is json or text');
      assert(/notify\.timeoutMs must be a positive integer/.test(loadErr('notify-to', ['notify: { urlEnv: X, timeoutMs: fast }']) || ''), 'notify.timeoutMs must be an integer');
      assert(/notify\.studioUrl must be a plain http\(s\) URL without credentials/.test(loadErr('notify-studio', ['notify: { urlEnv: X, studioUrl: https://u:p@studio.example }']) || ''), 'studioUrl refuses userinfo');
      assert(/notify must be a mapping with urlEnv/.test(loadErr('notify-scalar', ['notify: yes']) || ''), 'a scalar notify block is refused');
      assert(loadErr('notify-ok', ['notify: { urlEnv: X, authEnv: Y, on: breach, format: text, timeoutMs: 2000, studioUrl: https://studio.example/ }']) === null, 'a well-formed notify block loads (env vars are NOT resolved at load)');
      assert(NOTIFY_POLICIES.join() === 'transitions,breach,always' && NOTIFY_TIMEOUT_DEFAULT_MS === 5000, 'journey.mjs re-exports the notify vocabulary');
      assert(validateNotify({ urlEnv: 'X' }, 'z').urlEnv === 'X', 'validateNotify returns the block');
      // resolveNotifyTarget: env resolved at run time, timeout clamped, headers built, URL kept out of the definition.
      {
        const t = resolveNotifyTarget({ name: 'r', notify: { urlEnv: 'OBSERVOGRAM_TEST_WEBHOOK_URL', authEnv: 'OBSERVOGRAM_TEST_WEBHOOK_TOKEN', timeoutMs: 10, studioUrl: 'https://studio.example/' } });
        assert(t.url === rxUrl && t.headers.Authorization === 'Bearer tok-secret-123' && t.headers['Content-Type'] === 'application/json' && t.timeoutMs === 1000 && t.on === 'transitions' && t.format === 'json' && t.urlEnv === 'OBSERVOGRAM_TEST_WEBHOOK_URL' && t.studioUrl === 'https://studio.example',
               'resolveNotifyTarget reads the env vars, clamps a tiny timeout up to 1000, defaults on/format and trims the studio URL', t);
        assert(resolveNotifyTarget({ name: 'r', notify: { urlEnv: 'OBSERVOGRAM_TEST_WEBHOOK_URL', timeoutMs: 999999, format: 'text' } }).timeoutMs === 60000 && resolveNotifyTarget({ name: 'r', notify: { urlEnv: 'OBSERVOGRAM_TEST_WEBHOOK_URL', format: 'text' } }).headers['Content-Type'] === 'text/plain; charset=utf-8'
               && resolveNotifyTarget({ name: 'r', notify: { urlEnv: 'OBSERVOGRAM_TEST_WEBHOOK_URL' } }).timeoutMs === 5000 && !('Authorization' in resolveNotifyTarget({ name: 'r', notify: { urlEnv: 'OBSERVOGRAM_TEST_WEBHOOK_URL' } }).headers),
               'timeout clamps down to 60000 and defaults to 5000; text format sets text/plain; no authEnv → no Authorization header');
        assert(resolveNotifyTarget({ name: 'r' }) === null && resolveNotifyTarget(null) === null, 'no notify block → null target');
        let e1 = null; try { resolveNotifyTarget({ name: 'r', notify: { urlEnv: 'OBSERVOGRAM_TEST_NO_SUCH_URL' } }); } catch (e) { e1 = e.message; }
        assert(e1 === 'journey r: notify.urlEnv names OBSERVOGRAM_TEST_NO_SUCH_URL, but that env var is not set', 'an unset urlEnv throws naming the var', e1);
        let e2 = null; try { resolveNotifyTarget({ name: 'r', notify: { urlEnv: 'OBSERVOGRAM_TEST_WEBHOOK_URL', authEnv: 'OBSERVOGRAM_TEST_NO_SUCH_TOKEN' } }); } catch (e) { e2 = e.message; }
        assert(e2 === 'journey r: notify.authEnv names OBSERVOGRAM_TEST_NO_SUCH_TOKEN, but that env var is not set', 'an unset authEnv throws naming the var', e2);
      }
      // postNotification alone, with an injected fetch: 4xx is final, 429/5xx/network retry once, never throws.
      {
        const calls = [];
        const fake = (answers) => async (url, init) => { calls.push({ url, init }); const a = answers.shift(); if (a instanceof Error) throw a; return { ok: a >= 200 && a < 300, status: a, arrayBuffer: async () => new ArrayBuffer(0) }; };
        const r404 = await postNotification({ url: 'http://x/', body: '{}', timeoutMs: 1000, fetchImpl: fake([404]) });
        assert(r404.sent === false && r404.httpStatus === 404 && r404.attempts === 1 && r404.error === 'HTTP 404', 'a 404 is final: one attempt', r404);
        const r429 = await postNotification({ url: 'http://x/', body: '{}', timeoutMs: 1000, fetchImpl: fake([429, 200]) });
        assert(r429.sent === true && r429.httpStatus === 200 && r429.attempts === 2 && r429.error === null, '429 then 200: two attempts, sent', r429);
        const rNet = await postNotification({ url: 'http://x/', body: '{}', timeoutMs: 1000, fetchImpl: fake([new Error('fetch failed'), new Error('fetch failed')]) });
        assert(rNet.sent === false && rNet.httpStatus === null && rNet.attempts === 2 && rNet.error === 'fetch failed', 'two network errors: two attempts, failed, never thrown', rNet);
        const rCred = await postNotification({ url: 'http://x/', body: '{}', timeoutMs: 1000, fetchImpl: fake([new Error('connect to https://u:p@h/ refused'), new Error('connect to https://u:p@h/ refused')]) });
        assert(rCred.error === 'connect to https://***@h/ refused', 'a network error message arrives with credentials redacted', rCred.error);
        assert(calls.every(c => c.init.method === 'POST' && c.init.signal && c.init.redirect === 'manual'), 'every attempt is a POST with its own abort signal and no redirect following');
      }
      // (g) unset urlEnv at RUN time → throws naming the var, no record (same class as packB.mcp.authEnv).
      {
        writeFileSync(join(TMP, 'journeys', 'notify-unset.journey.yaml'), [`name: notify-unset`, `packA: { file: ${A} }`, `packB: { file: ${LIVE_B.replaceAll('\\', '/')} }`, 'notify: { urlEnv: OBSERVOGRAM_TEST_NO_SUCH_URL }'].join('\n'));
        let unsetErr = null;
        try { await runJourney(loadJourneyDef('notify-unset')); } catch (e) { unsetErr = e.message; }
        assert(unsetErr === 'journey notify-unset: notify.urlEnv names OBSERVOGRAM_TEST_NO_SUCH_URL, but that env var is not set', 'an unset urlEnv refuses to run and names the env var', unsetErr);
        assert(readJourneyRuns('notify-unset').length === 0 && hits.length === 0, 'an unset urlEnv never reached the wire — no record, no POST');
      }
      // (a) first run: transitions (default) → skipped, nothing on the wire; the record carries notify (env NAME only).
      const n1 = await runJourney(notifyDef('notified', MCP_B));
      assert(n1.outcome === 'pass' && n1.packB.source === `mcp:${mcpUrl}` && n1.notify && n1.notify.status === 'skipped' && n1.notify.reason === 'first run: no previous run to compare against' && n1.notify.attempts === 0 && n1.notify.httpStatus === null && n1.notify.urlEnv === 'OBSERVOGRAM_TEST_WEBHOOK_URL' && n1.notify.error === null,
             'the first run (live source) is skipped as a baseline; notify carries status/reason/attempts and the env NAME', n1.notify);
      assert(hits.length === 0, 'a skipped decision posts nothing');
      await sleep(5);
      const n1b = await runJourney(loadJourneyDef('notified'));
      assert(n1b.transition.any === false && n1b.notify.status === 'skipped' && n1b.notify.reason === `no transition since ${n1.startedAt}` && hits.length === 0, 'an identical second run is skipped, naming the run nothing moved from', n1b.notify);
      assert(!JSON.stringify(n1.notify).includes(rxUrl) && !JSON.stringify(n1.notify).includes('tok-secret'), 'the URL and the token never land on the record');
      assert(Object.keys(n1.notify).join() === 'status,reason,triggers,httpStatus,attempts,tookMs,urlEnv,error', 'record.notify carries the documented shape', Object.keys(n1.notify));
      {
        const keys = Object.keys(n1);
        assert(keys.slice(keys.indexOf('traceability'), keys.indexOf('traceability') + 6).join() === 'traceability,branches,chains,versions,transition,livePack' && keys[keys.length - 1] === 'notify' && keys.indexOf('notify') > keys.indexOf('causes'),
               'notify is the last key, after causes — the pinned key run is untouched', keys);
        assert(n1.grade.schema === 2, 'grade.schema stays 2 with notify: present');
        const persisted = readJourneyRuns('notified').find(r => r.startedAt === n1.startedAt);
        assert(persisted && JSON.stringify(persisted.notify) === JSON.stringify(n1.notify) && Object.keys(persisted).slice(-2).join() === 'causes,notify', 'the on-disk record carries the same notify (second write), as its last key', persisted && { disk: persisted.notify, mem: n1.notify });
      }
      // (i) scored quantities are byte-identical with and without notify:/schedule: on the same inputs.
      {
        writeFileSync(join(TMP, 'journeys', 'plain-twin.journey.yaml'), [`name: plain-twin`, `packA: { file: ${A} }`, MCP_B, 'env: prod'].join('\n'));
        const twin = await runJourney(loadJourneyDef('plain-twin'));
        assert(twin.notify === null, 'a definition without notify: records notify null (not configured — distinct from a missing key)');
        const twinDisk = readJourneyRuns('plain-twin')[0];
        assert('notify' in twinDisk && twinDisk.notify === null, 'notify null is persisted on the first (only) write');
        writeFileSync(join(TMP, 'journeys', 'sched-twin.journey.yaml'), [`name: sched-twin`, `packA: { file: ${A} }`, MCP_B, 'env: prod', 'schedule: "*/15 * * * *"', 'stackBudget: { objective: 0.99, window: 30d }', 'notify: { urlEnv: OBSERVOGRAM_TEST_WEBHOOK_URL, on: always }'].join('\n'));
        const sched = await runJourney(loadJourneyDef('sched-twin'));
        const scored = (r) => JSON.stringify({ grade: r.grade, traceability: r.traceability, branches: r.branches, chains: r.chains, drift: r.drift, conformance: r.conformance, outcome: r.outcome, breaches: r.gate.breaches });
        assert(scored(twin) === scored(n1) && scored(sched) === scored(n1), 'grade, traceability, branches, chains, drift, conformance and outcome are identical with and without notify:/schedule:/stackBudget:', { twin: scored(twin).length, n1: scored(n1).length });
        assert(JSON.stringify(sched.branches) === JSON.stringify(n1.branches) && sched.grade.schema === 2, 'identical inputs record identical branches whatever the delivery keys say');
        assert(sched.notify.status === 'sent' && hits.length === 1 && JSON.parse(hits[0].body).journey === 'sched-twin' && !('schedule' in JSON.parse(hits[0].body)), 'on: always posts the first run; the payload carries no definition keys');
        hits.length = 0;
      }
      // (b) the run after the vantage starts exposing recording rules (unobserved → absent: worse) → one POST, bearer auth, JSON payload, 202, one attempt.
      rulesExposed = true;
      await sleep(5);
      const n2 = await runJourney(loadJourneyDef('notified'));
      assert(n2.outcome === 'pass' && n2.transition.any === true && n2.transition.changed.some(c => c.direction === 'worse'),
             'fixture: exposing the recording-rules family moves chains (worse)', { any: n2.transition.any, dirs: n2.transition.changed.map(c => c.direction), v: n2.causes?.vantage });
      assert(n2.notify.status === 'sent' && n2.notify.httpStatus === 202 && n2.notify.attempts === 1 && n2.notify.error === null && n2.notify.triggers.includes('chain got worse') && n2.notify.triggers[0] === 'chain got worse' && n2.notify.reason === n2.notify.triggers.join(' · ') && typeof n2.notify.tookMs === 'number',
             'the transition is sent: 202 on the first attempt with the triggers named (chain got worse first)', n2.notify);
      assert(n2.notify.triggers.includes('vantage changed') === (n2.causes?.vantage?.changed === true), 'the vantage-changed trigger follows the ranker\'s vantage block', { t: n2.notify.triggers, v: n2.causes?.vantage?.changed });
      assert(hits.length === 1 && hits[0].method === 'POST' && hits[0].url === '/hook' && hits[0].headers.authorization === 'Bearer tok-secret-123' && hits[0].headers['content-type'] === 'application/json',
             'exactly one POST, Authorization: Bearer <authEnv value>, Content-Type: application/json', hits.map(h => [h.method, h.url, h.headers.authorization, h.headers['content-type']]));
      {
        const body = JSON.parse(hits[0].body);
        assert(body.kind === 'observogram.journey' && body.version === 1 && body.journey === 'notified' && body.runId === n2.startedAt.replace(/[:.]/g, '-') && body.startedAt === n2.startedAt && body.outcome === 'pass' && body.previousOutcome === 'pass' && body.reason === n2.notify.reason && body.triggers.join() === n2.notify.triggers.join(),
               'the body parses to the payload: kind, version, journey, runId, outcome, previous outcome, reason, triggers', { kind: body.kind, runId: body.runId, prev: body.previousOutcome, triggers: body.triggers });
        assert(JSON.stringify(body.transition) === JSON.stringify(n2.transition) && JSON.stringify(body.causes) === JSON.stringify(n2.causes) && JSON.stringify(body.chains) === JSON.stringify(n2.chains) && body.stack.length === n2.stackEvidence.rows.length && body.grade.score === n2.grade.score && body.drift.alignmentPct === n2.drift.alignmentPct,
               'transition, causes, chains, stack rows, grade and drift are the record\'s own');
        assert(body.packs.a.name === 'payment-service' && body.packs.b.source === `mcp:${mcpUrl}` && JSON.stringify(body.links) === '{}' && body.text.startsWith('notified: pass · chains ') && (/ · vantage changed: /.test(body.text) === (n2.causes?.vantage?.changed === true)),
               'packs, empty links (no studioUrl) and the one-line text (chain line, vantage line when the vantage moved) ride along', { packs: body.packs, text: body.text });
        assert(!/tok-secret-123|OBSERVOGRAM_TEST_WEBHOOK|urlEnv|authEnv/.test(hits[0].body), 'no env value and no definition key reaches the wire');
      }
      assert(JSON.stringify(readJourneyRuns('notified')[0].notify) === JSON.stringify(n2.notify) && readJourneyRuns('notified')[0].startedAt === n2.startedAt, 'the newest on-disk record carries the same notify');
      // (j) markdown last line and the CLI list tail.
      {
        const md = renderJourneyMarkdown(n2);
        const mdLines = md.split('\n');
        assert(mdLines[mdLines.length - 3] === `notify: sent (202) — ${n2.notify.reason}` && mdLines[mdLines.length - 1] === '_Verification evidence (declared vs observed); not incident-validated._',
               'markdown ends with the notify line right before the evidence footer', mdLines.slice(-4));
        assert(/\nnotify: skipped — first run: no previous run to compare against\n/.test(renderJourneyMarkdown(n1)), 'a skipped delivery prints its reason');
        assert(!/notify:/.test(renderJourneyMarkdown({ ...n1, notify: null })) && !/notify:/.test(renderJourneyMarkdown((({ notify: _n, ...rest }) => rest)(n1))), 'notify null and a record without the key print no notify line (never "skipped")');
        assert(notifyStatusLine(n2) === 'notify sent' && notifyStatusLine(n1) === 'notify skipped' && notifyStatusLine({ notify: null }) === null && notifyStatusLine({}) === null, 'notifyStatusLine reads the status or nothing');
        const cliN = spawnSync(process.execPath, [resolve('tools/cli.mjs'), 'journey', 'list'], { env: { ...process.env, OBSERVOGRAM_WORKSPACE: TMP }, encoding: 'utf8', timeout: 60_000 });
        assert(/^notified\tpass · .* · chains \d+\/\d+ intact · ladder [^\n]* · notify sent$/m.test(cliN.stdout), 'journey list appends notify sent as the last segment (after cause / vantage)', cliN.stdout.split('\n').filter(l => l.startsWith('notified')));
        assert(/^plain-twin\tpass · [^\n]*$/m.test(cliN.stdout) && !/^plain-twin\t.*notify/m.test(cliN.stdout), 'a journey without notify: gets no notify segment');
      }
      // (c) 500 then 202 → two attempts, sent.
      mode = 'flaky'; flakyLeft = 1; hits.length = 0;
      await sleep(5);
      const n3 = await runJourney(notifyDef('notified', MCP_B, ['  on: always']));
      assert(n3.notify.status === 'sent' && n3.notify.attempts === 2 && n3.notify.httpStatus === 202 && hits.length === 2, 'a 500 is retried once: attempts 2, sent on the 202', { n: n3.notify, hits: hits.length });
      // (d) 500-500 → failed after 2 attempts; the CLI exit code follows the outcome only.
      mode = 'down'; hits.length = 0;
      await sleep(5);
      const cliDown = await runCli(['journey', 'run', 'notified']);
      assert(cliDown.status === 0 && /\nnotify: failed after 2 attempts — HTTP 500\n/.test(cliDown.stdout), 'a failed delivery leaves the CLI exit code at 0 (pass) and prints the failure', { status: cliDown.status, tail: cliDown.stdout.split('\n').slice(-4), err: cliDown.stderr });
      const n4 = readJourneyRuns('notified')[0];
      assert(n4.notify.status === 'failed' && n4.notify.attempts === 2 && n4.notify.httpStatus === 500 && n4.notify.error === 'HTTP 500' && hits.length === 2, 'the record says failed after 2 attempts with the last status', n4.notify);
      assert(!/tok-secret-123/.test(cliDown.stdout + cliDown.stderr), 'the CLI output never echoes the token');
      // 4xx is final: one attempt.
      mode = 'reject'; hits.length = 0;
      await sleep(5);
      const n4b = await runJourney(loadJourneyDef('notified'));
      assert(n4b.notify.status === 'failed' && n4b.notify.attempts === 1 && n4b.notify.httpStatus === 400 && hits.length === 1, 'a 400 is final: one attempt, failed', n4b.notify);
      // (e) a hung receiver → failed within 2 × timeout + slack; the record is there.
      mode = 'hang'; hits.length = 0;
      await sleep(5);
      const n5 = await runJourney(loadJourneyDef('notified'));
      assert(n5.notify.status === 'failed' && n5.notify.attempts === 2 && n5.notify.error === 'timeout after 1000ms' && n5.notify.tookMs < 3500 && n5.notify.httpStatus === null,
             'a hung receiver times out per attempt (1000 ms × 2) and the run still lands', n5.notify);
      assert(readJourneyRuns('notified')[0].startedAt === n5.startedAt && readJourneyRuns('notified')[0].notify.status === 'failed', 'the hung delivery is on the record');
      for (const r of hung) r.destroy();
      hung.clear();
      mode = 'ok'; hits.length = 0;
      // A notifier that throws lands in error, never out of runJourney.
      {
        await sleep(5);
        const boom = await runJourney(loadJourneyDef('notified'), { notifier: async () => { throw new Error('boom at https://u:p@h/'); } });
        assert(boom.outcome === 'pass' && boom.notify.status === 'failed' && boom.notify.error === 'boom at https://***@h/' && boom.notify.attempts === 1, 'a thrown notifier is recorded as failed with a redacted error', boom.notify);
      }
      // (f) on: breach — a gate-failed run sends with the criteria as triggers; a passing first run is skipped; text format.
      {
        const bf = await runJourney(notifyDef('notify-breach', FILE_B, ['  on: breach'], ['gate: { minAlignmentPct: 101 }']));
        assert(bf.outcome === 'gate-failed' && bf.notify.status === 'sent' && bf.notify.triggers.join() === 'gate-failed:minAlignmentPct' && bf.notify.reason === 'gate failed: minAlignmentPct' && hits.length === 1,
               'on: breach posts a gate-failed run with one trigger per breached criterion', bf.notify);
        const bfBody = JSON.parse(hits[0].body);
        assert(bfBody.outcome === 'gate-failed' && bfBody.gate.breaches.length === 1 && bfBody.gate.breaches[0].criterion === 'minAlignmentPct' && bfBody.text.startsWith('notify-breach: gate-failed · chains '), 'the breach payload carries the breaches and the text line');
        hits.length = 0;
        const bp = await runJourney(notifyDef('notify-breach-pass', FILE_B, ['  on: breach']));
        assert(bp.outcome === 'pass' && bp.notify.status === 'skipped' && bp.notify.reason === 'outcome pass, no breach to clear' && hits.length === 0, 'on: breach skips a passing run', bp.notify);
        const tx = await runJourney(notifyDef('notify-text', FILE_B, ['  on: always', '  format: text', '  studioUrl: https://studio.example/']));
        assert(tx.notify.status === 'sent' && hits.length === 1 && hits[0].headers['content-type'] === 'text/plain; charset=utf-8' && hits[0].body.startsWith('notify-text: pass · chains ') && /\n\nreason: policy always\n/.test(hits[0].body) && /\nruns: https:\/\/studio\.example\/api\/journeys\/notify-text\/runs\?limit=1\njourney: https:\/\/studio\.example\/#journeys\n$/.test(hits[0].body),
               'format: text posts text/plain — the one-liner, the reason and the studio links', { ct: hits[0]?.headers['content-type'], body: hits[0]?.body.slice(0, 200) });
        hits.length = 0;
      }
      // (j) a vantage-lost run with notify: the loss is posted once (breach), the record carries notify after gate, the list pin holds.
      {
        const lostPort = await closedLoopbackPort();
        writeFileSync(join(TMP, 'journeys', 'lost-notify.journey.yaml'), [`name: lost-notify`, `packA: { file: ${A} }`, `packB: { mcp: { url: http://127.0.0.1:${lostPort}/mcp } }`, 'notify: { urlEnv: OBSERVOGRAM_TEST_WEBHOOK_URL, on: breach, timeoutMs: 1000 }'].join('\n'));
        let lostErr = null;
        try { await runJourney(loadJourneyDef('lost-notify')); } catch (e) { lostErr = e; }
        assert(lostErr && lostErr.vantageLost === true, 'the run still throws (exit 2) after posting the loss');
        const lostRec = readJourneyRuns('lost-notify')[0];
        assert(lostRec && lostRec.outcome === 'vantage-lost' && lostRec.notify && lostRec.notify.status === 'sent' && lostRec.notify.triggers.join() === 'vantage-lost' && Object.keys(lostRec).indexOf('notify') === Object.keys(lostRec).indexOf('gate') + 1,
               'the vantage-lost record carries notify sent right after gate', lostRec && { keys: Object.keys(lostRec), n: lostRec.notify });
        assert(hits.length === 1 && JSON.parse(hits[0].body).outcome === 'vantage-lost' && /ECONNREFUSED|refused|fetch failed/i.test(JSON.parse(hits[0].body).error || '') && JSON.parse(hits[0].body).text.startsWith('lost-notify: vantage-lost · '),
               'the loss is posted once with the error and the text line', hits.map(h => h.body.slice(0, 160)));
        assert(/\nnotify: sent \(202\) — vantage lost$/.test(renderJourneyMarkdown(lostRec)), 'the vantage-lost markdown ends with the notify line');
        const cliL = spawnSync(process.execPath, [resolve('tools/cli.mjs'), 'journey', 'list'], { env: { ...process.env, OBSERVOGRAM_WORKSPACE: TMP }, encoding: 'utf8', timeout: 60_000 });
        assert(/^lost-notify\tvantage-lost · [^\n]* · notify sent$/m.test(cliL.stdout) && /^lost\tvantage-lost · /m.test(cliL.stdout), 'journey list appends notify sent to the vantage-lost line; the plain vantage-lost pin is intact', cliL.stdout.split('\n').filter(l => l.startsWith('lost')));
        hits.length = 0;
        // transitions: a second loss in a row is skipped — nobody is paged twice for one outage.
        writeFileSync(join(TMP, 'journeys', 'lost-notify.journey.yaml'), [`name: lost-notify`, `packA: { file: ${A} }`, `packB: { mcp: { url: http://127.0.0.1:${lostPort}/mcp } }`, 'notify: { urlEnv: OBSERVOGRAM_TEST_WEBHOOK_URL, timeoutMs: 1000 }'].join('\n'));
        await sleep(5);
        try { await runJourney(loadJourneyDef('lost-notify')); } catch { /* vantage lost again */ }
        const again = readJourneyRuns('lost-notify')[0];
        assert(again.startedAt !== lostRec.startedAt && again.notify.status === 'skipped' && again.notify.reason === `still vantage-lost since ${lostRec.startedAt}` && hits.length === 0, 'a repeated vantage loss under transitions is skipped, naming the first loss', again.notify);
      }
    } finally {
      if (typeof rx.closeAllConnections === 'function') rx.closeAllConnections();
      await new Promise(r => rx.close(r));
      if (typeof mcp.closeAllConnections === 'function') mcp.closeAllConnections();
      await new Promise(r => mcp.close(r));
      delete process.env.OBSERVOGRAM_TEST_WEBHOOK_URL;
      delete process.env.OBSERVOGRAM_TEST_WEBHOOK_TOKEN;
    }
  }

  // --- secrets discipline: authEnv must resolve or the run refuses ---
  writeFileSync(join(TMP, 'journeys', 'live.journey.yaml'), [
    'name: live',
    `packA: { file: ${PACK_A.replaceAll('\\', '/')} }`,
    'packB: { mcp: { url: https://example.invalid/mcp, authEnv: OBSERVOGRAM_TEST_NO_SUCH_TOKEN } }',
  ].join('\n'));
  let authErr = null;
  try { await runJourney(loadJourneyDef('live')); } catch (e) { authErr = e.message; }
  assert(/OBSERVOGRAM_TEST_NO_SUCH_TOKEN/.test(authErr || '') && /not set/.test(authErr || ''),
         'unresolved authEnv refuses to run and names the env var');
  assert(readJourneyRuns('live').length === 0, 'an unset authEnv never reached the wire — no vantage-lost record');

  // --- step 5: packc journey run --all and packc journey schedule (own workspaces, file-vs-file: no servers needed) ---
  {
    const TMP2 = mkdtempSync(join(tmpdir(), 'observogram-journey-all-'));
    const TMP3 = mkdtempSync(join(tmpdir(), 'observogram-journey-none-'));
    const A = PACK_A.replaceAll('\\', '/');
    const B = PACK_B.replaceAll('\\', '/');
    const packc = (args, ws, extraEnv = {}) => spawnSync(process.execPath, [resolve('tools/cli.mjs'), ...args], { env: { ...process.env, OBSERVOGRAM_WORKSPACE: ws, ...extraEnv }, encoding: 'utf8', timeout: 120_000 });
    try {
      mkdirSync(join(TMP2, 'journeys'), { recursive: true });
      writeFileSync(join(TMP2, 'journeys', 'all-pass.journey.yaml'), ['name: all-pass', `packA: { file: ${A} }`, `packB: { file: ${B} }`, 'gate: { minAlignmentPct: 1 }', 'schedule: "30 4 * * 1"'].join('\n'));
      writeFileSync(join(TMP2, 'journeys', 'all-fail.journey.yaml'), ['name: all-fail', `packA: { file: ${A} }`, `packB: { file: ${B} }`, 'gate: { minAlignmentPct: 101 }'].join('\n'));
      writeFileSync(join(TMP2, 'journeys', 'all-broken.journey.yaml'), ['name: all-broken', `packA: { file: ${A} }`, `packB: { file: ${B} }`, 'schedule: "*/15 * * *"'].join('\n'));
      // (k) run --all: three sections, the unloadable one on stderr, exit = worst (2).
      const all3 = packc(['journey', 'run', '--all'], TMP2);
      assert(all3.status === 2, 'run --all over pass + gate-failed + unloadable exits 2 (the worst)', { status: all3.status, err: all3.stderr });
      assert((all3.stdout.match(/^## journey /gm) || []).length === 3 && /^## journey all-pass\n\n## ✅ Journey `all-pass` — PASS/m.test(all3.stdout) && /^## journey all-fail\n\n## ❌ Journey `all-fail` — GATE FAILED/m.test(all3.stdout) && /^## journey all-broken\n\n_error: journey all-broken: schedule must be/m.test(all3.stdout),
             'stdout carries one ## journey section per journey, the unloadable one as an error line', all3.stdout.split('\n').filter(l => l.startsWith('## ')));
      assert(/^packc journey all-broken: journey all-broken: schedule must be a 5-field cron expression/m.test(all3.stderr), 'stderr names the unloadable journey and why', all3.stderr);
      assert(readJourneyRunsIn(TMP2, 'all-pass').length === 1 && readJourneyRunsIn(TMP2, 'all-fail').length === 1 && readJourneyRunsIn(TMP2, 'all-broken').length === 0, 'the loadable journeys ran (one record each); the broken one left none');
      rmSync(join(TMP2, 'journeys', 'all-broken.journey.yaml'));
      const all2 = packc(['journey', 'run', '--all'], TMP2);
      assert(all2.status === 1 && (all2.stdout.match(/^## journey /gm) || []).length === 2 && all2.stderr === '', 'pass + gate-failed only → exit 1, two sections, nothing on stderr', { status: all2.status, err: all2.stderr });
      const allJson = packc(['journey', 'run', '--all', '--json'], TMP2);
      const arr = JSON.parse(allJson.stdout);
      assert(allJson.status === 1 && Array.isArray(arr) && arr.map(r => r.name).join() === 'all-fail,all-pass' && arr.map(r => r.exitCode).join() === '1,0' && arr.every(r => r.record && r.error === null) && arr[0].record.outcome === 'gate-failed' && !/^## journey/m.test(allJson.stdout),
             '--json yields an array of { name, record, error, exitCode } and no markdown', { status: allJson.status, arr: arr.map(r => [r.name, r.exitCode, r.error]) });
      assert(readJourneyRunsIn(TMP2, 'all-pass').length === 3, 'each --all run appends to every journey\'s history');
      const none = packc(['journey', 'run', '--all'], TMP3);
      assert(none.status === 0 && /^\(no journeys saved — add \.observogram\/journeys\/<name>\.journey\.yaml\)$/m.test(none.stdout), 'run --all over zero journeys prints the existing no-journeys line and exits 0', { status: none.status, out: none.stdout });
      // (l) schedule: every format, --json, the placeholder + stderr note, the exits.
      writeFileSync(join(TMP2, 'journeys', 'sched-env.journey.yaml'), ['name: sched-env', `packA: { file: ${A} }`, 'packB: { mcp: { url: https://mcp.example.invalid/mcp, authEnv: MY_MCP_TOKEN } }', 'schedule: { cron: "0 */2 * * *", timezone: Europe/Madrid }', 'notify: { urlEnv: MY_HOOK_URL, authEnv: MY_HOOK_TOKEN }'].join('\n'));
      const secretEnv = { MY_HOOK_URL: 'https://hooks.example/s3cr3t-value', MY_HOOK_TOKEN: 's3cr3t-token', MY_MCP_TOKEN: 's3cr3t-mcp' };
      const pkgVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version;
      const sAll = packc(['journey', 'schedule', 'sched-env'], TMP2, secretEnv);
      assert(sAll.status === 0 && sAll.stderr === '' && /^## cron$/m.test(sAll.stdout) && /^## schtasks \(Windows Task Scheduler\)$/m.test(sAll.stdout) && /^## github-actions$/m.test(sAll.stdout) && /^## kubernetes-cronjob$/m.test(sAll.stdout),
             'schedule <name> prints the four snippet sections and nothing on stderr', { status: sAll.status, err: sAll.stderr, heads: sAll.stdout.split('\n').filter(l => l.startsWith('## ')) });
      assert(!/s3cr3t/.test(sAll.stdout), 'no env VALUE reaches the snippets (only names)');
      const sCron = packc(['journey', 'schedule', 'sched-env', '--format', 'cron'], TMP2, secretEnv);
      assert(sCron.status === 0 && /^CRON_TZ=Europe\/Madrid$/m.test(sCron.stdout) && /^0 \*\/2 \* \* \* cd /m.test(sCron.stdout) && /^# export MY_MCP_TOKEN=<set in your environment>$/m.test(sCron.stdout) && /^# export MY_HOOK_URL=<set in your environment>$/m.test(sCron.stdout) && /^# export MY_HOOK_TOKEN=<set in your environment>$/m.test(sCron.stdout) && !/^## /m.test(sCron.stdout),
             '--format cron prints the crontab line with CRON_TZ, the workspace and the env names from packB.mcp.authEnv + notify', sCron.stdout);
      assert(/OBSERVOGRAM_WORKSPACE='?[^ ]*observogram-journey-all-/.test(sCron.stdout), 'the cron line sets the workspace the CLI was run with', sCron.stdout.split('\n').find(l => l.startsWith('0 ')));
      const sTask = packc(['journey', 'schedule', 'sched-env', '--format', 'schtasks'], TMP2, secretEnv);
      assert(sTask.status === 0 && /^schtasks \/Create \/TN "Observogram\\sched-env" \/TR "\\"[^"]*node(\.exe)?\\" \\"[^"]*cli\.mjs\\" journey run sched-env" \/SC HOURLY \/MO 2 \/ST 00:00 \/F$/m.test(sTask.stdout) && /^REM setx MY_HOOK_URL <set in your environment>/m.test(sTask.stdout),
             '--format schtasks prints the Task Scheduler command with the real node and cli paths', sTask.stdout);
      const sAct = packc(['journey', 'schedule', 'sched-env', '--format', 'actions'], TMP2, secretEnv);
      assert(sAct.status === 0 && parseYaml(sAct.stdout).on.schedule[0].cron === '0 */2 * * *' && parseYaml(sAct.stdout).jobs.journey.steps[3].env.MY_HOOK_URL === '${{ secrets.MY_HOOK_URL }}', '--format actions prints a parseable workflow binding the env names to secrets');
      const sK8s = packc(['journey', 'schedule', 'sched-env', '--format', 'k8s'], TMP2, secretEnv);
      const k = parseYaml(sK8s.stdout);
      assert(sK8s.status === 0 && k.kind === 'CronJob' && k.spec.schedule === '0 */2 * * *' && k.spec.timeZone === 'Europe/Madrid' && k.spec.jobTemplate.spec.template.spec.containers[0].image === `observogram:${pkgVersion}` && k.spec.jobTemplate.spec.template.spec.containers[0].env.some(e => e.name === 'MY_HOOK_URL' && e.valueFrom.secretKeyRef.key === 'MY_HOOK_URL'),
             '--format k8s prints a CronJob with the package version as the image tag and secretKeyRefs for the env names', sK8s.stdout.slice(0, 300));
      const sJson = packc(['journey', 'schedule', 'sched-env', '--json'], TMP2, secretEnv);
      const j = JSON.parse(sJson.stdout);
      assert(sJson.status === 0 && j.name === 'sched-env' && j.schedule.cadenceMs === 7200000 && j.schedule.timezone === 'Europe/Madrid' && j.placeholder === false && j.envNames.join() === 'MY_MCP_TOKEN,MY_HOOK_URL,MY_HOOK_TOKEN' && Object.keys(j.snippets).join() === 'cron,schtasks,actions,k8s' && !/s3cr3t/.test(sJson.stdout),
             '--json yields { name, source, schedule, placeholder, envNames, snippets }', { keys: Object.keys(j), sched: j.schedule, env: j.envNames });
      const sJsonOne = packc(['journey', 'schedule', 'sched-env', '--json', '--format', 'k8s'], TMP2, secretEnv);
      assert(Object.keys(JSON.parse(sJsonOne.stdout).snippets).join() === 'k8s', '--json --format k8s narrows the snippets');
      // Fix round 0: the flag-first order took the --format VALUE as the journey name (exit 2, "journey not found: cron").
      const sFlagFirst = packc(['journey', 'schedule', '--format', 'cron', 'sched-env'], TMP2, secretEnv);
      assert(sFlagFirst.status === 0 && sFlagFirst.stdout === sCron.stdout && sFlagFirst.stderr === '', 'schedule --format cron <name> (flag first) prints exactly what <name> --format cron prints', { status: sFlagFirst.status, err: sFlagFirst.stderr });
      const sFlagMid = packc(['journey', 'schedule', '--json', '--format', 'k8s', 'sched-env'], TMP2, secretEnv);
      assert(sFlagMid.status === 0 && JSON.parse(sFlagMid.stdout).name === 'sched-env' && Object.keys(JSON.parse(sFlagMid.stdout).snippets).join() === 'k8s', 'both flags before the name still resolve the journey');
      assert(packc(['journey', 'schedule', '--format', 'cron'], TMP2, secretEnv).status === 2, 'a --format value alone is not a journey name (usage, exit 2)');
      const sPh = packc(['journey', 'schedule', 'all-fail'], TMP2);
      assert(sPh.status === 0 && /^packc journey schedule: all-fail declares no schedule: — printing the placeholder \*\/15 \* \* \* \*; edit before installing$/m.test(sPh.stderr) && (sPh.stdout.match(/placeholder, edit before installing/g) || []).length === 4 && /^\*\/15 \* \* \* \* cd /m.test(sPh.stdout) && /schedule: not set in .*all-fail\.journey\.yaml — placeholder/.test(sPh.stdout),
             'without schedule: every snippet carries the marked placeholder, stderr says so, exit 0', { status: sPh.status, err: sPh.stderr });
      assert(JSON.parse(packc(['journey', 'schedule', 'all-fail', '--json'], TMP2).stdout).placeholder === true && JSON.parse(packc(['journey', 'schedule', 'all-fail', '--json'], TMP2).stdout).schedule === null, '--json reports placeholder true and schedule null');
      assert(packc(['journey', 'schedule', 'sched-env', '--format', 'nope'], TMP2, secretEnv).status === 2 && packc(['journey', 'schedule', 'no-such'], TMP2).status === 2 && packc(['journey', 'schedule'], TMP2).status === 2, 'an unknown format, an unknown journey and a missing name exit 2');
      const help = packc(['help'], TMP2);
      assert(/packc journey {2}run --all/.test(help.stdout) && /packc journey {2}schedule <name>/.test(help.stdout), 'help lists run --all and schedule');
    } finally {
      rmSync(TMP2, { recursive: true, force: true });
      rmSync(TMP3, { recursive: true, force: true });
    }
  }

  // --- STORE_PLAN slice 2: name-only loads over the API, crawl walks scoped to the org ---
  {
    const OUT = mkdtempSync(join(tmpdir(), 'observogram-journey-path-'));
    const scoped = mkdtempSync(join(tmpdir(), 'observogram-journey-scope-'));
    const B = PACK_B.replaceAll('\\', '/');
    const GO = 'package main\nimport "github.com/prometheus/client_golang/prometheus"\nvar c = prometheus.NewCounter(prometheus.CounterOpts{Name: "orders_total"})\n';
    const put = (p, text = GO) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
    const crawlDef = (name, path) => ({ name, packA: { crawl: { path, name: 'svc' } }, packB: { file: B } });
    const tryRun = async (def, opts) => { try { return { rec: await runJourney(def, opts) }; } catch (e) { return { err: e.message }; } };
    try {
      // allowPath: a literal path loads for the CLI, never with allowPath:false (the server).
      const outside = join(OUT, 'elsewhere.journey.yaml');
      writeFileSync(outside, ['name: elsewhere', `packA: { file: ${PACK_A.replaceAll('\\', '/')} }`, `packB: { file: ${B} }`].join('\n'));
      assert(loadJourneyDef(outside).name === 'elsewhere', 'loadJourneyDef: a literal path still loads by default (the CLI)');
      let pathErr = null;
      try { loadJourneyDef(outside, { allowPath: false }); } catch (e) { pathErr = e.message; }
      assert(/^journey not found: /.test(pathErr || ''), 'loadJourneyDef with allowPath:false never resolves a path', pathErr);
      let relErr = null;
      try { loadJourneyDef('../journeys/pay-vs-curated.journey.yaml', { allowPath: false }); } catch (e) { relErr = e.message; }
      assert(/^journey not found: /.test(relErr || ''), 'allowPath:false: a relative path is sanitised into a name that does not exist', relErr);
      assert(loadJourneyDef('pay-vs-curated', { allowPath: false }).name === 'pay-vs-curated', 'allowPath:false: a name under journeys/ still loads');

      // The README's journey: crawl: { path: ../my-service } from <base>/journeys/, default org at the base.
      put(join(TMP, 'my-service', 'main.go'));
      writeFileSync(join(TMP, 'journeys', 'readme-crawl.journey.yaml'), ['name: readme-crawl', 'packA:', '  crawl:', '    path: ../my-service', '    name: my-service', `packB: { file: ${B} }`].join('\n'));
      const readme = await tryRun(loadJourneyDef('readme-crawl', { allowPath: false }), { crawlScope: { base: TMP, ownRoot: TMP } });
      assert(readme.rec?.packA?.source === `crawl:${join(TMP, 'my-service')}`, 'crawlScope: the README journey (default org at the base) walks <base>/my-service', readme.err || readme.rec?.packA);

      // A walk of <base> from the default org never reads under <base>/orgs/.
      const WS = join(scoped, 'ws');
      put(join(WS, 'orgs', 'bravo', 'svc', 'main.go'));
      const baseWalk = crawlDef('scope-base', '.');
      const baseScoped = await tryRun(baseWalk, { baseDir: WS, crawlScope: { base: WS, ownRoot: WS } });
      assert(/no scannable files found/.test(baseScoped.err || ''), 'crawlScope: a walk of <base> from the default org never reads under <base>/orgs/', baseScoped.err || 'ran');
      assert((await tryRun(baseWalk, { baseDir: WS })).rec, 'no scope: the same walk reads <base>/orgs/ (today\'s walk, the CLI)');

      // From orgs/acme: a root in <base>/packs or <base>/orgs/bravo is refused.
      const ACME = join(WS, 'orgs', 'acme');
      put(join(WS, 'packs', 'main.go'));
      put(join(ACME, 'src', 'main.go'));
      const acmeScope = { base: WS, ownRoot: ACME };
      for (const [label, path] of [['<base>/packs', join(WS, 'packs')], ['<base>/orgs/bravo', join(WS, 'orgs', 'bravo')], ['<base> itself', WS]]) {
        const r = await tryRun(crawlDef('scope-refused', path), { baseDir: ACME, crawlScope: acmeScope });
        assert(r.err === `crawl source ${path} belongs to another org's part of the workspace — refused`, `crawlScope: from orgs/acme a crawl root in ${label} is refused`, r.err || 'ran');
      }
      assert((await tryRun(crawlDef('scope-own', 'src'), { baseDir: ACME, crawlScope: acmeScope })).rec, 'crawlScope: from orgs/acme its own root is walked');

      // A crawl root that is an ancestor of the base never enters it.
      const anc = crawlDef('scope-ancestor', scoped);
      const ancScoped = await tryRun(anc, { baseDir: ACME, crawlScope: acmeScope });
      assert(/no scannable files found/.test(ancScoped.err || ''), 'crawlScope: from orgs/acme a root that is an ancestor of the base never enters the base', ancScoped.err || 'ran');
      assert((await tryRun(anc, { baseDir: ACME })).rec, 'no scope: the ancestor walk enters the base');

      // A symlinked file into <base>/orgs/bravo is skipped.
      if (process.platform !== 'win32') {
        mkdirSync(join(ACME, 'linked'), { recursive: true });
        symlinkSync(join(WS, 'orgs', 'bravo', 'svc', 'main.go'), join(ACME, 'linked', 'main.go'));
        const link = crawlDef('scope-link', 'linked');
        const linkScoped = await tryRun(link, { baseDir: ACME, crawlScope: acmeScope });
        assert(/no scannable files found/.test(linkScoped.err || ''), 'crawlScope: a symlinked file into <base>/orgs/bravo is skipped', linkScoped.err || 'ran');
        assert((await tryRun(link, { baseDir: ACME })).rec, 'no scope: the symlinked file is read (today\'s walk)');
      }
    } finally {
      rmSync(OUT, { recursive: true, force: true });
      rmSync(scoped, { recursive: true, force: true });
      rmSync(join(TMP, 'my-service'), { recursive: true, force: true });
      rmSync(join(TMP, 'journeys', 'readme-crawl.journey.yaml'), { force: true });
    }
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

// Run records of a journey in another workspace root (the --all tests use
// their own), newest first — the same shape readJourneyRuns reads.
function readJourneyRunsIn(root, name) {
  try { return readdirSync(join(root, 'runs', name)).filter(f => /^\d{4}-.*Z\.json$/.test(f)).sort().reverse().map(f => JSON.parse(readFileSync(join(root, 'runs', name, f), 'utf8'))); } catch { return []; }
}

report('journey', 'all saved-journey assertions pass.');
