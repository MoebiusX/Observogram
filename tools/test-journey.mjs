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
} = await import('./lib/journey.mjs');

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
  assert(!liveRec.gate.breaches.some(b => /stack/i.test(b.criterion)), 'no gate criterion reads the stack sample — signal, not verdict');
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
