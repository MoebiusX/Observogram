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

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHarness } from './lib/harness.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
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
} = await import('./lib/journey.mjs');
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

const PACK_A = resolve('vendor/observability-pack-spec/v1.2/examples/payment-service.pack.yaml');
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
    assert(b0.degraded.length > 0 && Object.keys(b0.degraded[0]).join() === 'key,kind,label,status,ladder,blastRadius,deltaFields' && b0.degraded[0].ladder.rung && b0.degraded[0].blastRadius && typeof b0.degraded[0].blastRadius.slos === 'number',
           'a persisted degraded node carries status, ladder, blast radius and delta fields', b0.degraded[0]);
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
    assert(liveRec.transition === null, 'the first run of a journey has no transition (nothing to compare against)', liveRec.transition);
    assert(JSON.stringify(liveRec.livePack) === JSON.stringify({ kept: false, path: null, reason: `Pack B is a file (${LIVE_B})` }),
           'a file-sourced Pack B is never snapshotted, and the record says so', liveRec.livePack);
    assert(!readdirSync(join(TMP, 'runs', 'live-synthetic')).includes('live'), 'no live/ directory is created for a file-sourced B');
    const persisted = readJourneyRuns('live-synthetic')[0];
    assert(persisted.branches.length === liveRec.branches.length && JSON.stringify(persisted.chains) === JSON.stringify(liveRec.chains) && persisted.transition === null,
           'branches, chains and transition round-trip through the run history file');
    await new Promise(r => setTimeout(r, 5));
    const liveRec2 = await runJourney(loadJourneyDef('live-synthetic'));
    assert(liveRec2.transition && liveRec2.transition.any === false && liveRec2.transition.since === liveRec.startedAt && liveRec2.transition.changed.length === 0,
           'an identical second run reads transition.any false against the first run', liveRec2.transition);
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
           && chainStatusLine({ outcome: 'vantage-lost' }) === 'chains none' && chainStatusLine({ branches: [] }) === 'chains none' && chainStatusLine({ branches: [{ verdict: 'undeclared', ladderVerdict: 'undeclared' }] }) === 'chains none',
           'chainStatusLine omits zero buckets and reads none for a record without declared chains');
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
    assert(pruneLiveSnapshots(['2026-01-02T00-00-00-000Z.json', 'notes.json', 'live'], ['2026-01-01T00-00-00-000Z.json', '2026-01-02T00-00-00-000Z.json', 'notes.json', '2026-01-03T00-00-00-000Z.json']).join() === '2026-01-01T00-00-00-000Z.json,2026-01-03T00-00-00-000Z.json',
           'pruneLiveSnapshots names the run-shaped live files whose record is gone — never a survivor, never a non-run file');
    assert(pruneLiveSnapshots(null, ['2026-01-01T00-00-00-000Z.json']).join() === '2026-01-01T00-00-00-000Z.json' && pruneLiveSnapshots([], null).length === 0 && pruneLiveSnapshots(['x'], [3, null]).length === 0,
           'pruneLiveSnapshots tolerates missing lists and non-string entries');
    assert(LIVE_PACK_PATH_RE.test('live/2026-01-01T00-00-00-000Z.json') && !LIVE_PACK_PATH_RE.test('live/../x.json') && !LIVE_PACK_PATH_RE.test('2026-01-01T00-00-00-000Z.json'),
           'only live/<run stem>.json is a snapshot path');
  }
  // A fake MCP that answers the core tools (and, when flipped, the
  // recording-rules family) so Pack B is a real `mcp:` source. Answers are
  // identical run to run unless `fakeRules` is set, so a chain transition
  // is under the test's control.
  let fakeRules = false;
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
      return send({ tools: ['system_health', 'system_topology', 'anomalies_active', 'anomalies_baselines', ...(fakeRules ? ['list_recording_rules'] : [])].map(name => ({ name })) });
    }
    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      const result = name === 'system_health' ? { services: [] }
        : name === 'system_topology' ? { dependencies: [] }
        : name === 'anomalies_baselines' ? { baselines: [] }
        : name === 'list_recording_rules' ? { groups: [{ name: 'payment', interval: '1m', rules: [{ record: 'payment:api_availability:ratio_5m', expr: 'sum(rate(http_server_request_duration_seconds_count{code!~"5.."}[5m])) / sum(rate(http_server_request_duration_seconds_count[5m]))', health: 'ok' }] }] }
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
    assert(t1.packB.source === `mcp:${fakeUrl}` && t1.outcome === 'pass' && t1.transition === null, 'the fake MCP answers as a live source; the first run has no transition', { src: t1.packB.source, o: t1.outcome, t: t1.transition });
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
    fakeRules = true;
    await new Promise(r => setTimeout(r, 5));
    const t3 = await runJourney(loadJourneyDef('fake-live'));
    assert(t3.transition && t3.transition.any === true && t3.transition.changed.length > 0 && t3.transition.since === t2.startedAt,
           'exposing the recording-rules family moves chains (unobserved → absent is a ladder transition)', t3.transition && { any: t3.transition.any, changed: t3.transition.changed.map(c => [c.title, c.from, c.to, c.direction]) });
    assert(t3.transition.changed.every(c => c.from.ladderVerdict === 'unobserved' || c.from.verdict !== c.to.verdict) && t3.transition.changed.some(c => c.direction === 'worse'),
           'the vantage that now looks and sees nothing reads worse — not "changed", never a cause', t3.transition.changed.map(c => c.direction));
    assert(t3.livePack.kept === true && new RegExp(`^chains changed since ${t2.startedAt.replace(/[.]/g, '\\.')}: \\d+ changed`).test(t3.livePack.reason) && t3.livePack.path === `live/${stemOf(t3)}`,
           'the moved run keeps its live pack and the reason says what moved', t3.livePack);
    assert(liveFilesOf('fake-live').join() === [stemOf(t1), stemOf(t3)].join(), 'the live directory holds the first and the moved run', liveFilesOf('fake-live'));
    const md3 = renderJourneyMarkdown(t3);
    assert(/### Transitions since previous run/.test(md3) && /→ .*\((worse|better|changed)\)/.test(md3) && /^live pack: kept \(live\/.*\.json, \d+ bytes\) — chains changed since/m.test(md3),
           'markdown lists the transitions with their direction and the kept live pack', md3.split('### Transitions since previous run')[1]?.slice(0, 400));
    const t3json = JSON.parse(JSON.stringify(readJourneyRuns('fake-live')[0]));
    assert(t3json.transition.any === true && t3json.livePack.kept === true && readLivePack('fake-live', t3json)?.metadata?.annotations?.['mcp.url'] === fakeUrl,
           'transition and livePack round-trip through the history file and readLivePack works from the persisted record');
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
    assert(blockedRun.outcome === 'pass' && blockedRun.livePack.kept === false && /^live pack live\/.*\.json: /.test(blockedRun.historyError || '') && blockedRun.livePack.reason === 'keepLivePack: always',
           'a snapshot write failure is noted as historyError on the record, the run still lands and livePack reads not kept', { lp: blockedRun.livePack, he: blockedRun.historyError });
    assert(readJourneyRuns('fake-never')[0]?.startedAt === blockedRun.startedAt && readJourneyRuns('fake-never')[0].historyError === blockedRun.historyError, 'the persisted record carries the same historyError');
    // The CLI line shows the chains segment for a live journey too.
    const cliLive = spawnSync(process.execPath, [resolve('tools/cli.mjs'), 'journey', 'list'], { env: { ...process.env, OBSERVOGRAM_WORKSPACE: TMP }, encoding: 'utf8', timeout: 60_000 });
    assert(/^fake-live\tpass · .* · chains \d+\/\d+ intact · ladder \d+ healthy/m.test(cliLive.stdout), 'journey list prints the chains status for a live journey', cliLive.stdout.split('\n').filter(l => l.startsWith('fake-live')));
  } finally {
    await new Promise(r => fakeSrv.close(r));
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
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

report('journey', 'all saved-journey assertions pass.');
