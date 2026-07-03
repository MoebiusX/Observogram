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

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHarness } from './lib/harness.mjs';

const { assert, report } = createHarness();

const TMP = mkdtempSync(join(tmpdir(), 'observogram-journey-'));
process.env.OBSERVOGRAM_WORKSPACE = TMP;

const {
  loadJourneyDef, runJourney, listJourneys, readJourneyRuns,
  evaluateGate, renderJourneyMarkdown,
} = await import('./lib/journey.mjs');

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

  // --- markdown report ---
  const md = renderJourneyMarkdown(strictRec);
  assert(/GATE FAILED/.test(md), 'markdown headline states the verdict');
  assert(/payment-service/.test(md) && /production-curated/.test(md), 'markdown names both packs');
  assert(/Gate breaches/.test(md), 'markdown lists the breaches');
  assert(/not incident-validated/.test(md), 'markdown labels the result verification, not validation');
  const mdPass = renderJourneyMarkdown(rec);
  assert(/PASS/.test(mdPass) && !/Gate breaches/.test(mdPass), 'passing report has no breach section');

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
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

report('journey', 'all saved-journey assertions pass.');
