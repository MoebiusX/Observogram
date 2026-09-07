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
  const names = ['2026-01-03T00-00-00-000Z.json', '2026-01-01T00-00-00-000Z.json', 'notes.txt', '2026-01-02T00-00-00-000Z.json', '2026-01-04T00-00-00-000Z.json'];
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
  assert(breaches.length === 1 && breaches[0].criterion === 'stack.tsdb_compaction_failures' && /no sample for tsdb_compaction_failures \(absent from this run\)/.test(breaches[0].detail),
         'a threshold on a row absent from the evidence breaches honestly', breaches);
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
  assert(/^stack-gated\tgate-failed · .* · stack sampled 3$/m.test(cliList.stdout), 'journey list prints the stack status (sampled N) per journey', cliList.stdout);
  assert(/^pay-vs-curated\tpass · .* · stack none$/m.test(cliList.stdout), 'journey list prints stack none for a file-sourced journey', cliList.stdout);
  assert(!/^lost\t.*stack/m.test(cliList.stdout), 'a vantage-lost line carries no stack status');

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
