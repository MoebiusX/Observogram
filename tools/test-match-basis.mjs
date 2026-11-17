#!/usr/bin/env node
/**
 * tools/test-match-basis.mjs
 *
 * No figure without its basis (the downstream's defects 1, 2 and 7): a match,
 * a health or an integrity figure exists only for what both sides were read
 * for, and a gate never passes on an absent figure.
 *
 *   - an empty union has no alignment / jaccard (null), and so have the
 *     set-asides' summary, the chain rollups with nothing declared, a chain
 *     whose every link was unobservable (its ladder) and the weighted health;
 *   - Drift-free earns nothing where nothing backs it;
 *   - the vantage is lost whenever no probe family returned data, partial when
 *     one failed (or answered in part), else full; a live export that
 *     recorded no probe table has none;
 *   - a lost vantage is a lost run: one record, no grade, no match, thrown on
 *     (exit 2 on the command line);
 *   - a family the endpoint answered it does not serve is not served on
 *     every run it says so, and fails on every run it does not (a 503 is an
 *     outage); a tool the journey saw answer a family never reads "not
 *     served" after;
 *   - the gate fails closed on every absent figure, and on a health count a
 *     failed family leaves a hole in;
 *   - a probe error keeps no query or credential, whatever quotes it.
 *
 * Pack A is the vendored spec example (payment-service), never a crawl: what
 * a scan reads is another track's business. Live sides are built with the
 * fetcher's own buildCanonicalPack or read from a fake MCP.
 *
 *   node --test tools/test-match-basis.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'observogram-match-basis-'));
process.env.OBSERVOGRAM_WORKSPACE = TMP;
delete process.env.OBSERVOGRAM_TRANSPORT_HOOK;
delete process.env.TOMOGRAPH_TRANSPORT_HOOK;
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const { parse: parseYaml } = await import('./lib/mini-yaml.mjs');
const { SPEC_DIR } = await import('./lib/validator.mjs');
const { adapt } = await import('./lib/adapter.mjs');
const { diffPacks } = await import('./lib/diff.mjs');
const { comparePackBranches, compareBranches, buildDependencyGraph } = await import('./lib/traceability-graph.mjs');
const { branchRecordsFromGraph, chainSummary, rankCauses } = await import('./lib/chain-history.mjs');
const { evaluateInventoryGate } = await import('./lib/inventory-coverage.mjs');
const { firstProbeError: firstProbeErrorLib, inStageOrder } = await import('./lib/live-fetch.mjs');
const { applySetAsides } = await import('../studio/set-asides.mjs');
const { computeWeightedDeltaRisk, computeDiagnosticGrade, computePostureMatrix, partialLiveEvidence } = await import('../studio/diagnostic-grade.mjs');
const { buildCanonicalPack } = await import('./fetch-live-pack.mjs');
const { startFakeMcp } = await import('../server/fixtures/fake-mcp.mjs');
const { probeCandidates, candidateTool, capabilityTool } = await import('./lib/contracts/mcp-capabilities.mjs');
const {
  runJourney, loadJourneyDef, readJourneyRuns, evaluateGate, notifyTargetOf, probeMemoryOf, firstProbeError, NO_PROBE_DATA,
} = await import('./lib/journey.mjs');
// How every reader reads a record (the row, the listing, the report): the replays end where a person looks.
const { runBasis } = await import('./lib/run-basis.mjs');

const AT = '2026-11-16T10:00:00.000Z';
const PACK_A_FILE = resolve(__dirname, '..', SPEC_DIR, 'examples/payment-service.pack.yaml');
const repoPack = () => parseYaml(readFileSync(PACK_A_FILE, 'utf8'));
const slash = (p) => p.replaceAll('\\', '/');
const nameOf = (c) => (typeof c === 'string' ? c : c.name);
const T = {
  health: capabilityTool('system_health'),
  topology: capabilityTool('system_topology'),
  names: nameOf(probeCandidates('metric_names')[0]),
  search: candidateTool('dashboards', 'search'),
  rules: nameOf(probeCandidates('alert_rules')[0]),   // serves recording and alert rules
  targets: nameOf(probeCandidates('scrape_configs')[0]),
};

// The fetcher's own pack from pre-populated probe outcomes (an "export of live").
const FAMILIES = ['metric_names', 'recording_rules', 'alert_rules', 'dashboards', 'scrape_configs', 'alerting_routes'];
const outcome = (o, extra = {}) => ({ tool: o === 'data' || o === 'empty' ? 'x' : null, attempted: ['x'], adapted: o === 'empty' ? [] : null, outcome: o, ...extra });
function liveExport(results, { probeFailures = {} } = {}) {
  const probeResults = {};
  for (const f of FAMILIES) probeResults[f] = results[f] ?? outcome('unsupported');
  return buildCanonicalPack({ refreshedAt: AT, mcpUrl: 'https://mcp.example.com/mcp', health: { services: [] }, topology: { dependencies: [] }, probeResults, probeFailures });
}
// Scrape targets answered with data — one job whose every target is down, which Pack A declares
// nothing of — and every other family not offered: the read is whole (vantage full) and holds
// nothing both sides could compare.
const DOWN_JOB = { tool: T.targets, attempted: [T.targets], adapted: [{ job: 'shop-api', targets: [{ instance: 'shop-api:9100', health: 'down', lastScrape: null, lastError: 'connection refused' }] }], outcome: 'data' };
const nothingInCommon = () => liveExport({ scrape_configs: DOWN_JOB });

function journeyFile(name, lines) {
  mkdirSync(join(TMP, 'journeys'), { recursive: true });
  writeFileSync(join(TMP, 'journeys', `${name}.journey.yaml`), [`name: ${name}`, `packA: { file: ${slash(PACK_A_FILE)} }`, ...lines].join('\n'));
  return join(TMP, 'journeys', `${name}.journey.yaml`);
}
function packFile(name, canonical) {
  const p = join(TMP, `${name}.pack.json`);
  writeFileSync(p, JSON.stringify(canonical, null, 2));
  return slash(p);
}

// A fake MCP whose tools answer through `answers` (name → answer, or a function).
async function fakeMcp(answers) {
  const tools = [T.health, T.topology, ...Object.keys(answers)];
  return startFakeMcp(tools, (name, args) => {
    if (name === T.health) return { services: [] };
    if (name === T.topology) return { dependencies: [] };
    const a = answers[name];
    return typeof a === 'function' ? a(args) : (a ?? {});
  });
}
const REFUSED = { __isError: 'Error: HTTP 401: Unauthorized — https://grafana.example.com/api' };

// ---------------------------------------------------------------------------
// Ratios over nothing are no figure (C1)
// ---------------------------------------------------------------------------

test('nothing in common to compare: alignment and jaccard are null, the union 0; a comparison with something in it keeps its ratio', () => {
  const d = diffPacks(adapt(repoPack()), adapt(nothingInCommon()));
  assert.deepEqual([d.summary.union, d.summary.alignment, d.summary.jaccard], [0, null, null]);
  assert.ok(d.summary.notObserved > 0, 'what Pack A declares sits in notObserved, out of the union');
  const self = diffPacks(adapt(repoPack()), adapt(repoPack()));
  assert.ok(self.summary.union > 0 && self.summary.alignment === 1 && self.summary.jaccard === 1, 'a comparison with something in it keeps aligned / union');
  assert.doesNotMatch(readFileSync(resolve(__dirname, 'lib', 'diff.mjs'), 'utf8'), /=== 0\s*\?\s*1\b/, 'acceptance grep: no `=== 0 ? 1` ratio in diff.mjs');
});

test('set-asides that leave nothing to count: the summary ratios and the chain rollup are null', () => {
  const key = 'metric::{"name":"shop_orders_total"}';
  const diff = {
    layers: { L2: { onlyInA: [{ key, artefact: { id: 'METRIC-01' } }], onlyInB: [], inBoth: [] } },
    summary: { onlyInA: 1, onlyInB: 0, inBoth: 0, aligned: 0, drifted: 0, union: 1, aTotal: 1, bTotal: 0, jaccard: 0, alignment: 0 },
    traceabilityGraph: {
      branches: [{ rootKey: 'slo::{"id":"shop"}', title: 'shop', hasA: true, hasB: false, verdict: 'broken', integrity: 0.2, integrityPct: 20, nodes: [{ key: 'slo::{"id":"shop"}', kind: 'slo', status: 'declared_only', weight: 3 }] }],
      rollup: { intact: 0, partial: 0, broken: 1, undeclared: 0, declaredTotal: 1, total: 1, integrityMean: 0.2, integrityPct: 20 },
    },
  };
  const out = applySetAsides(diff, [
    { key, side: 'declared', kind: 'in-development', until: null },
    { key: 'slo::{"id":"shop"}', side: 'declared', kind: 'in-development', until: null },
  ], { now: AT });
  assert.deepEqual([out.summary.union, out.summary.alignment, out.summary.jaccard], [0, null, null]);
  assert.deepEqual([out.traceabilityGraph.rollup.declaredTotal, out.traceabilityGraph.rollup.integrityMean, out.traceabilityGraph.rollup.integrityPct], [0, null, null]);
});

test('no declared commitment: the chain rollup and its ladder have no integrity figure', () => {
  const g = compareBranches(buildDependencyGraph({ layers: {} }), buildDependencyGraph(adapt(repoPack())));
  assert.ok(g.rollup.total > 0 && g.rollup.declaredTotal === 0, 'live-only chains, none declared');
  assert.deepEqual([g.rollup.integrityMean, g.rollup.integrityPct], [null, null]);
  assert.deepEqual([g.rollup.ladder.integrityMean, g.rollup.ladder.integrityPct], [null, null]);
});

test('a chain whose every link the vantage could not look at has no ladder figure; the rollups and the chain history average what has one (A6)', () => {
  const repo = repoPack();
  repo.spec.telemetry.backends = [];   // a backend has no probe family: its ladder reads absent, not unobserved
  const failed = (f) => outcome('failed', { attempted: [f] });
  const blindLive = liveExport(Object.fromEntries(FAMILIES.map((f) => [f, failed(f)])), { probeFailures: Object.fromEntries(FAMILIES.map((f) => [f, 'HTTP 503 Service Unavailable'])) });
  const g = comparePackBranches(adapt(repo), adapt(blindLive));
  const blind = g.branches.filter((b) => b.ladderVerdict === 'unobserved');
  const measured = g.branches.filter((b) => b.ladderIntegrity !== null);
  assert.ok(blind.length > 0 && blind.every((b) => b.ladderIntegrity === null && b.ladderIntegrityPct === null), 'every unobserved chain: null, never 100');
  assert.ok(measured.length > 0, 'fixture: one chain still has a figure (a role it misses counts)');
  const mean = Math.round((measured.reduce((s, b) => s + b.ladderIntegrity, 0) / measured.length) * 1e4) / 1e4;
  assert.equal(g.rollup.ladder.integrityMean, mean, 'the ladder rollup averages the chains that have a figure');
  const records = branchRecordsFromGraph(g);
  assert.ok(records.filter((r) => r.ladderVerdict === 'unobserved').every((r) => r.ladderIntegrityPct === null), 'the run record keeps null');
  assert.equal(chainSummary({ branches: records }).ladderIntegrityPct, Math.round(measured.reduce((s, b) => s + b.ladderIntegrityPct, 0) / measured.length));
  assert.equal(chainSummary({ branches: records.filter((r) => r.ladderIntegrityPct === null) }).ladderIntegrityPct, null, 'no chain with a figure: null');
  repo.spec.slos = repo.spec.slos.filter((s) => !measured.some((b) => b.title === s.id));
  const allBlind = comparePackBranches(adapt(repo), adapt(blindLive));
  assert.ok(allBlind.rollup.declaredTotal > 0);
  assert.deepEqual([allBlind.rollup.ladder.integrityMean, allBlind.rollup.ladder.integrityPct], [null, null], 'every declared chain unobserved: the ladder rollup is null');
});

test('the weighted health of nothing is null; of something, aligned over aligned and badness', () => {
  const none = computeWeightedDeltaRisk({ mode: 'drift', aligned: 0, onlyInA: 0, onlyInB: 0 });
  assert.deepEqual([none.health, none.healthPct], [null, null]);
  const some = computeWeightedDeltaRisk({ mode: 'drift', aligned: 3, onlyInA: 1, onlyInB: 0 });
  assert.deepEqual([some.health, some.healthPct], [0.75, 75]);
});

// ---------------------------------------------------------------------------
// The grade: Drift-free earns nothing where nothing backs it
// ---------------------------------------------------------------------------

test('Drift-free earns nothing when nothing was compared — on the chains and on the buckets — and its detail never prints null%', () => {
  const layeredA = adapt(repoPack());
  const layeredB = adapt(nothingInCommon());
  const posture = computePostureMatrix(layeredA, layeredB);
  const bare = diffPacks(layeredA, layeredB);
  for (const diff of [{ ...bare, traceabilityGraph: comparePackBranches(layeredA, layeredB) }, bare]) {
    const grade = computeDiagnosticGrade(layeredA, layeredB, posture, 'production-live', diff, { nowMs: Date.parse(AT) });
    const drift = grade.trust.criteria.find((c) => c.key === 'drift-free');
    assert.deepEqual([drift.pass, drift.score], [false, 0]);
    assert.match(drift.detail, /^nothing compared - no artefact was found in a family both sides read, so drift cannot be scored/);
    assert.doesNotMatch(drift.detail, /null%|NaN/);
  }
});

test('Drift-free without a diff earns nothing from a live source that recorded no probe table, or whose families returned no data', () => {
  const layeredA = adapt(repoPack());
  const noTable = liveExport({ scrape_configs: DOWN_JOB });
  for (const k of ['mcp.probesAttempted', 'mcp.probesSucceeded', 'mcp.probesEmpty', 'mcp.probesFailed', 'mcp.probesUnsupported']) delete noTable.metadata.annotations[k];
  const allUnsupported = liveExport({});
  for (const [pack, detail] of [[noTable, /^live source connected, but no probe family was asked or recorded/], [allUnsupported, /^no probe family returned data \(6 attempted\)/]]) {
    const layeredB = adapt(pack);
    const grade = computeDiagnosticGrade(layeredA, layeredB, computePostureMatrix(layeredA, layeredB), 'production-live', null, { nowMs: Date.parse(AT) });
    const drift = grade.trust.criteria.find((c) => c.key === 'drift-free');
    assert.deepEqual([drift.pass, drift.score], [false, 0]);
    assert.match(drift.detail, detail);
  }
});

// ---------------------------------------------------------------------------
// The vantage (C3, A1, A2)
// ---------------------------------------------------------------------------

test('the vantage table: lost whenever no family returned data, partial on a hole, full otherwise; none without a probe record', () => {
  const v = (ann) => partialLiveEvidence({ meta: { annotations: { 'mcp.url': 'https://mcp.example.com/mcp', 'mcp.probesAttempted': 'a,b', 'mcp.probesSucceeded': '', 'mcp.probesEmpty': '', 'mcp.probesFailed': '', 'mcp.probesUnsupported': '', ...ann } } });
  assert.equal(v({ 'mcp.probesUnsupported': 'a,b' }).vantage, 'lost', 'all unsupported');
  assert.equal(v({ 'mcp.probesEmpty': 'a,b' }).vantage, 'lost', 'all empty: a read that brought back nothing');
  assert.equal(v({ 'mcp.probesFailed': 'a', 'mcp.probesEmpty': 'b' }).vantage, 'lost', 'failed beside empty: no data at all (defect 2)');
  assert.equal(v({ 'mcp.probesAttempted': '' }).vantage, 'lost', 'a probe table with nothing attempted');
  assert.equal(v({ 'mcp.probesSucceeded': 'a', 'mcp.probesFailed': 'b' }).vantage, 'partial');
  assert.equal(v({ 'mcp.probesSucceeded': 'a', 'mcp.probesUnsupported': 'b' }).vantage, 'full', 'a family not offered never degrades the vantage');
  assert.equal(v({ 'mcp.probesSucceeded': 'a', 'mcp.probesEmpty': 'b' }).vantage, 'full');
  const inPart = v({ 'mcp.probesSucceeded': 'a,b', 'mcp.probesPartial': 'b' });
  assert.deepEqual([inPart.vantage, inPart.partial, inPart.inPart], ['partial', true, ['b']], 'a family answered in part (mcp.probesPartial) is a hole (A2)');
  assert.deepEqual(v({ 'mcp.probesSucceeded': 'a' }).succeeded, ['a'], 'succeeded is returned');
  const noTable = partialLiveEvidence({ meta: { annotations: { 'mcp.url': 'https://mcp.example.com/mcp', 'mcp.refreshedAt': AT } } });
  assert.deepEqual([noTable.vantage, noTable.probeTable, noTable.isLiveDraft], ['none', false, true], 'no probe table: no probe record (A1)');
  assert.equal(partialLiveEvidence({ meta: { annotations: { 'mcp.probesSucceeded': '' } } }).vantage, 'none', 'no mcp.url: not a live draft');
  const served = v({ 'mcp.probesSucceeded': 'a', 'mcp.probesUnsupported': 'b', 'mcp.probeUnsupported.b': JSON.stringify({ reason: 'x: HTTP 404 Not Found', since: AT, tools: ['x'] }) });
  assert.deepEqual(served.notServed, { b: 'x: HTTP 404 Not Found' }, 'a family not served here names what was answered');
});

// ---------------------------------------------------------------------------
// The gate fails closed (C5, A5)
// ---------------------------------------------------------------------------

test('the gate fails closed on every absent figure', () => {
  const nothing = { gradeScore: 40, gradePass: false, alignmentPct: null, compared: 0, setAsideCount: 0, declaredNotLive: 0, drifted: 0, aligned: 0, liveAgeHours: 1 };
  const detail = (gate, facts) => evaluateGate(gate, facts).map((b) => `${b.criterion}: ${b.detail}`);
  assert.deepEqual(detail({ minAlignmentPct: 85, maxDeclaredNotLive: 0, maxDrifted: 0 }, nothing), [
    'minAlignmentPct: nothing was compared — no alignment figure to hold against the required 85%',
    'maxDeclaredNotLive: nothing was compared — no declared artefact was checked against live (max 0)',
    'maxDrifted: nothing was compared — no drift could be counted (max 0)',
  ]);
  assert.deepEqual(detail({ minAlignmentPct: 85, maxDeclaredNotLive: 0 }, { ...nothing, setAsideCount: 2 }), [
    'minAlignmentPct: nothing is left to compare once the 2 set-aside differences are left out — no alignment figure to hold against the required 85%',
  ], 'set-asides that emptied the comparison: the figure is none, the counts are a person\'s true zero');
  assert.deepEqual(detail({ minAlignmentPct: 85 }, { ...nothing, compared: 5, alignmentPct: undefined }), ['minAlignmentPct: no alignment figure was given — the gate cannot pass on an absent figure (required 85%)']);
  assert.deepEqual(detail({ requireGradePass: true }, { alignmentPct: 90 }), ['requireGradePass: no diagnostic grade to hold against the 85% pass bar — the gate cannot pass on an absent grade']);
  assert.deepEqual(detail({ maxDeclaredNotLive: 0, maxDrifted: 1 }, { compared: 4 }), [
    'maxDeclaredNotLive: no declared-not-live count was given — the gate cannot pass on an absent count (max 0)',
    'maxDrifted: no drifted count was given — the gate cannot pass on an absent count (max 1)',
  ]);
  assert.deepEqual(detail({ maxLiveAgeHours: 24 }, {}), ['maxLiveAgeHours: live evidence carries no refresh timestamp — staleness cannot be proven fresh']);
  const fileB = { probes: { attempted: [], succeeded: [], empty: [], failed: [], unsupported: [] }, vantage: 'none', scrapeJobsDown: 0, unhealthyRules: 0 };
  assert.deepEqual(detail({ maxUnhealthy: 0 }, fileB), ['maxUnhealthy: no on-wire health was read — Pack B is not a live read — the gate cannot pass on an absent count (max 0)']);
  assert.deepEqual(detail({ maxUnhealthy: 0 }, { ...fileB, vantage: 'full', probes: { ...fileB.probes, succeeded: ['dashboards'] } }), ['maxUnhealthy: no on-wire health was read — scrape targets, recording rules and alert rules were not read — the gate cannot pass on an absent count (max 0)']);
  assert.deepEqual(detail({ maxUnhealthy: 0 }, { ...fileB, vantage: 'full', probes: { ...fileB.probes, empty: ['scrape_configs'] } }), [], 'an honest zero from a health family is a read');
  assert.deepEqual(detail({ failOnPartialEvidence: true }, fileB), [], 'failOnPartialEvidence passes a Pack B that is no live read (A5)');
  assert.deepEqual(detail({ failOnPartialEvidence: true }, { ...fileB, vantage: 'partial', probes: { ...fileB.probes, succeeded: ['a'], partial: ['alert_rules'] } }), ['failOnPartialEvidence: live evidence is partial: answered in part: alert_rules — verdict not trustworthy']);
  assert.deepEqual(detail({ minAlignmentPct: 50, maxDeclaredNotLive: 3 }, { alignmentPct: 60, declaredNotLive: 2 }), [], 'a host\'s facts without `compared` are read as given');
});

test('maxUnhealthy cannot pass on a health count a failed family, or one answered in part, leaves a hole in; a family not offered or not served here is no hole (E6)', () => {
  const detail = (facts) => evaluateGate({ maxUnhealthy: 0 }, facts).map((b) => `${b.criterion}: ${b.detail}`);
  const facts = (probes, extra = {}) => ({ vantage: 'partial', scrapeJobsDown: 0, unhealthyRules: 0, probes: { attempted: [], succeeded: ['metric_names'], empty: [], failed: [], unsupported: [], ...probes }, ...extra });
  assert.deepEqual(detail(facts({ empty: ['recording_rules'], failed: ['scrape_configs', 'alert_rules'] })), [
    'maxUnhealthy: on-wire health was read in part — scrape targets were not read; alert rules were not read — the gate cannot pass on a partial count (0 scrape job(s) down + 0 unhealthy rule(s) seen, max 0)',
  ], 'the targets and the alert rules failed beside an empty recording-rule read: no count to hold');
  assert.deepEqual(detail(facts({ succeeded: ['metric_names', 'recording_rules', 'alert_rules'], failed: ['scrape_configs'] })), [
    'maxUnhealthy: on-wire health was read in part — scrape targets were not read — the gate cannot pass on a partial count (0 scrape job(s) down + 0 unhealthy rule(s) seen, max 0)',
  ], 'healthy rules say nothing of the jobs down');
  assert.deepEqual(detail(facts({ succeeded: ['metric_names', 'scrape_configs', 'recording_rules', 'alert_rules'], partial: ['alert_rules'] })), [
    'maxUnhealthy: on-wire health was read in part — alert rules were read in part — the gate cannot pass on a partial count (0 scrape job(s) down + 0 unhealthy rule(s) seen, max 0)',
  ]);
  assert.deepEqual(detail(facts({ succeeded: ['metric_names', 'scrape_configs'], failed: ['recording_rules', 'alert_rules'] }, { scrapeJobsDown: 1, scrapeJobsDownNames: ['shop-api'] })), [
    'maxUnhealthy: 1 scrape job(s) down + 0 unhealthy rule(s) observed on the wire (max 0): job shop-api down — a lower bound: recording rules were not read; alert rules were not read',
  ], 'a count already over the max says so, and that it is a lower bound');
  assert.deepEqual(detail(facts({ empty: ['recording_rules', 'alert_rules'], unsupported: ['scrape_configs'] }, { vantage: 'full', probeUnsupported: { scrape_configs: { reason: 'x: HTTP 404 Not Found' } } })), [],
    'scrape targets not served here: the store keeps none — the rules are the count');
  assert.deepEqual(detail(facts({ succeeded: ['metric_names', 'scrape_configs'], unsupported: ['recording_rules', 'alert_rules'] }, { vantage: 'full' })), [],
    'rule families this MCP does not offer: the jobs are the count');
});

test('inventory coverage over a kind the site expects none of: a kind the gate names cannot pass; an unnamed one is left out', () => {
  const inventory = { status: 'checked', kinds: { host: { mode: 'enumerated', title: 'host', status: 'checked', expected: 0, up: 0, down: [], silent: [], unexpected: [], coveragePct: null } } };
  const run = (gate) => { const out = []; evaluateInventoryGate(gate, inventory, (criterion, detail) => out.push(`${criterion}: ${detail}`)); return out; };
  assert.deepEqual(run({ minCoveragePct: 90, kinds: ['host'] }), ['inventory.host.coverage: no host is expected by the site, so there is no coverage figure (min 90%)']);
  assert.deepEqual(run({ minCoveragePct: 90 }), []);
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

test('a run that compared nothing has no match figure, fails its gate, and its notification says so', async () => {
  journeyFile('mb-nothing', [
    `packB: { file: ${packFile('mb-nothing-b', nothingInCommon())} }`,
    'gate: { minAlignmentPct: 85, maxDeclaredNotLive: 0, maxDrifted: 0 }',
    'notify: { urlEnv: MB_HOOK_URL, on: always, format: text }',
  ]);
  const posted = [];
  const rec = await runJourney(loadJourneyDef('mb-nothing'), {
    resolveNotify: (n) => notifyTargetOf(n, { url: 'https://hooks.example.com/journey' }),
    notifier: async ({ body }) => { posted.push(body); return { sent: true, httpStatus: 200, attempts: 1, tookMs: 1 }; },
  });
  assert.deepEqual([rec.drift.alignmentPct, rec.drift.compared, rec.vantage, rec.outcome], [null, 0, 'full', 'gate-failed']);
  assert.deepEqual(rec.gate.breaches, [
    { criterion: 'minAlignmentPct', detail: 'nothing was compared — no alignment figure to hold against the required 85%' },
    { criterion: 'maxDeclaredNotLive', detail: 'nothing was compared — no declared artefact was checked against live (max 0)' },
    { criterion: 'maxDrifted', detail: 'nothing was compared — no drift could be counted (max 0)' },
  ]);
  assert.equal(posted.length, 1);
  assert.ok(posted[0].startsWith('mb-nothing: gate-failed · nothing compared · '), posted[0].split('\n')[0]);
  journeyFile('mb-self', [`packB: { file: ${slash(PACK_A_FILE)} }`, 'gate: { minAlignmentPct: 85 }']);
  const selfRec = await runJourney(loadJourneyDef('mb-self'));
  assert.ok(selfRec.drift.compared > 0 && selfRec.drift.alignmentPct === 100 && selfRec.outcome === 'pass', 'a comparison with something in it records its union and its figure');
});

test('a live read whose every probe family was refused is a lost run: one record, the vantage breach, no grade, no match (defect 1)', async () => {
  const fake = await fakeMcp({ [T.names]: REFUSED, [T.search]: REFUSED, [T.rules]: REFUSED, [T.targets]: REFUSED });
  try {
    journeyFile('mb-refused', [`packB: { mcp: { url: ${fake.url} } }`, 'gate: { minAlignmentPct: 85 }']);
    let err = null;
    try { await runJourney(loadJourneyDef('mb-refused')); } catch (e) { err = e; }
    assert.ok(err && err.vantageLost === true && err.vantageRecorded === true, 'thrown on as a lost vantage, already recorded');
    assert.equal(err.message, `${T.names}: Error: HTTP 401: Unauthorized — https://grafana.example.com/api`, 'the first probe error, in stage order');
    const runs = readJourneyRuns('mb-refused');
    assert.equal(runs.length, 1, 'exactly one record');
    const lost = runs[0];
    assert.deepEqual(Object.keys(lost), ['journey', 'startedAt', 'tookMs', 'outcome', 'error', 'packA', 'packB', 'scope', 'vantage', 'probes', 'probeErrors', 'toolsExposedCount', 'gate', 'notify']);
    assert.deepEqual([lost.outcome, lost.vantage, lost.packB.liveScope], ['vantage-lost', 'lost', null]);
    assert.deepEqual([...lost.probes.failed].sort(), ['alert_rules', 'dashboards', 'metric_names', 'recording_rules', 'scrape_configs']);
    assert.deepEqual(lost.gate.breaches, [{ criterion: 'vantage', detail: 'vantage lost: no probe family returned data (failed: metric_names, recording_rules, alert_rules, dashboards, scrape_configs; not exposed: alerting_routes) — nothing was compared' }]);
    assert.ok(!('grade' in lost) && !('drift' in lost), 'no grade, no match');
    assert.deepEqual(firstProbeError(lost), { family: 'metric_names', error: lost.probeErrors.metric_names });
    // Where a person looks: Live did not answer with the first probe error — never "100% match" (defect 1).
    const read = runBasis(lost);
    assert.deepEqual([read.state, read.text, read.alignmentPct, read.reading], ['unreachable', `Live did not answer — ${err.message}`, null, 'vantage-lost']);

    // The command line: exit 2, the error on stderr, one more record.
    const child = spawn(process.execPath, [resolve(__dirname, 'cli.mjs'), 'journey', 'run', join(TMP, 'journeys', 'mb-refused.journey.yaml')], { env: { ...process.env, OBSERVOGRAM_WORKSPACE: TMP } });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    const status = await new Promise((done) => child.on('close', done));
    assert.equal(status, 2, stderr);
    assert.match(stderr, new RegExp(`packc journey: ${T.names}: Error: HTTP 401`));
    assert.equal(readJourneyRuns('mb-refused').length, 2);
  } finally {
    await fake.close();
  }
});

test('no family returned data — one failed beside the empty ones — is lost, never partial (defect 2)', async () => {
  const fake = await fakeMcp({ [T.names]: { __isError: 'HTTP 503 Service Unavailable' }, [T.rules]: { groups: [] }, [T.search]: { count: 0, results: [] } });
  try {
    journeyFile('mb-failed-empty', [`packB: { mcp: { url: ${fake.url} } }`]);
    await assert.rejects(runJourney(loadJourneyDef('mb-failed-empty')), (e) => e.vantageLost === true && e.message === `${T.names}: HTTP 503 Service Unavailable`);
    const [lost] = readJourneyRuns('mb-failed-empty');
    assert.deepEqual([lost.outcome, lost.vantage, lost.error], ['vantage-lost', 'lost', `${T.names}: HTTP 503 Service Unavailable`]);
    assert.deepEqual([...lost.probes.empty].sort(), ['alert_rules', 'dashboards', 'recording_rules']);
    // Its gate failed on the vantage, and a person reads Live did not answer — never "14%" or "0% match" (defect 2).
    assert.deepEqual(lost.gate.breaches.map((b) => b.criterion), ['vantage']);
    assert.ok(!('grade' in lost) && !('drift' in lost), 'no grade, no match');
    const read = runBasis(lost);
    assert.deepEqual([read.state, read.text, read.alignmentPct], ['unreachable', `Live did not answer — ${T.names}: HTTP 503 Service Unavailable`, null]);
  } finally {
    await fake.close();
  }
});

test('a file holding a live export whose probe table says no family returned data is a lost run too; one with no probe table is graded (A1)', async () => {
  const empty = liveExport(Object.fromEntries(FAMILIES.map((f) => [f, outcome('empty')])));
  const path = packFile('mb-empty-export', empty);
  journeyFile('mb-empty-export', [`packB: { file: ${path} }`]);
  await assert.rejects(runJourney(loadJourneyDef('mb-empty-export')), (e) => e.vantageLost === true && e.message === NO_PROBE_DATA);
  const [lost] = readJourneyRuns('mb-empty-export');
  assert.deepEqual([lost.outcome, lost.error, lost.vantage, lost.packB.source], ['vantage-lost', NO_PROBE_DATA, 'lost', resolve(path)]);
  assert.ok(!('liveScope' in lost.packB), 'a file has no live scope');
  assert.equal(lost.gate.breaches[0].detail, 'vantage lost: no probe family returned data (empty: metric_names, recording_rules, alert_rules, dashboards, scrape_configs, alerting_routes) — nothing was compared');
  const legacy = repoPack();
  legacy.metadata.name = 'payment-service-live';
  legacy.metadata.annotations = { ...(legacy.metadata.annotations || {}), 'mcp.url': 'https://mcp.example.com/mcp', 'mcp.refreshedAt': AT };
  journeyFile('mb-legacy-export', [`packB: { file: ${packFile('mb-legacy-export', legacy)} }`]);
  const graded = await runJourney(loadJourneyDef('mb-legacy-export'));
  assert.deepEqual([graded.vantage, typeof graded.grade.score, graded.outcome], ['none', 'number', 'pass'], 'no probe record: graded on its comparison as before');
});

test('the run a run compares against is the newest that checked something: a stopped Run on a partial scan is passed over (A10)', async () => {
  journeyFile('mb-stopped', [`packB: { file: ${slash(PACK_A_FILE)} }`, 'notify: { urlEnv: MB_HOOK_URL, on: transitions, format: json }']);
  const opts = { resolveNotify: (n) => notifyTargetOf(n, { url: 'https://hooks.example.com/journey' }), notifier: async () => ({ sent: true, httpStatus: 200, attempts: 1, tookMs: 1 }) };
  const first = await runJourney(loadJourneyDef('mb-stopped'), opts);
  await new Promise((r) => setTimeout(r, 5));
  const stoppedAt = new Date().toISOString();
  writeFileSync(join(TMP, 'runs', 'mb-stopped', `${stoppedAt.replace(/[:.]/g, '-')}.json`), JSON.stringify({
    journey: 'mb-stopped', startedAt: stoppedAt, outcome: 'scan-partial', error: '1 of 2 files not read: HTTP 403',
    packA: { source: first.packA.source }, packB: { source: first.packB.source }, scope: first.scope, gate: { thresholds: {}, breaches: [] }, notify: null,
  }));
  await new Promise((r) => setTimeout(r, 5));
  const second = await runJourney(loadJourneyDef('mb-stopped'), opts);
  assert.deepEqual([second.notify.status, second.notify.reason], ['skipped', `no transition since ${first.startedAt}`], 'compared against the run before the stopped one, never "outcome changed scan-partial → pass"');
});

test('scrape targets the store does not keep: unsupported on every answer that says so, the first instant kept; a 503 is an outage, never absorbed by the memory (P6, E1)', async () => {
  const NOT_FOUND = { __isError: 'Error: HTTP 404: Not Found — http://grafana.example.com/api/datasources/proxy/uid/x/api/v1/targets' };
  let answer = NOT_FOUND;
  const fake = await fakeMcp({ [T.names]: { label: '__name__', values: ['up'] }, [T.targets]: () => answer });
  try {
    journeyFile('mb-targets', [`packB: { mcp: { url: ${fake.url} } }`, 'gate: { failOnPartialEvidence: true }']);
    const targetCalls = () => fake.calls.filter((c) => c.name === T.targets).length;
    const r1 = await runJourney(loadJourneyDef('mb-targets'));
    assert.deepEqual([r1.vantage, r1.probes.unsupported.includes('scrape_configs'), r1.probes.failed.includes('scrape_configs'), r1.outcome], ['full', true, false, 'pass'], 'unsupported after the first answer, the vantage full');
    const first = r1.probeUnsupported.scrape_configs;
    assert.deepEqual([first.reason, first.tools, first.remembered], [`${T.targets}: HTTP 404 Not Found`, [T.targets], undefined]);
    const r2 = await runJourney(loadJourneyDef('mb-targets'));
    assert.deepEqual([r2.vantage, r2.probeUnsupported.scrape_configs.since], ['full', first.since], 'the same answer again: not served since the first answer');
    answer = { __isError: 'Error: HTTP 503: Service Unavailable' };
    const before = targetCalls();
    const r3 = await runJourney(loadJourneyDef('mb-targets'));
    assert.ok(targetCalls() > before, 'asked again');
    assert.deepEqual([r3.vantage, r3.probes.failed.includes('scrape_configs'), 'probeUnsupported' in r3, r3.outcome, r3.gate.breaches.map((b) => b.criterion)],
      ['partial', true, false, 'gate-failed', ['failOnPartialEvidence']], 'a 503 is an outage: a failure, whatever the journey remembers');
    assert.equal(r3.probeErrors.scrape_configs, `${T.targets}: Error: HTTP 503: Service Unavailable`);
  } finally {
    await fake.close();
  }
});

test('a store that answered with scrape targets and answers 404 an hour later is failed, the probe error saying when it answered — never "not served" (E2)', async () => {
  let answer = { targets: [{ job: 'shop-api', instance: 'shop-api:9100', health: 'up' }] };
  const fake = await fakeMcp({ [T.names]: { label: '__name__', values: ['up'] }, [T.targets]: () => answer });
  try {
    journeyFile('mb-lost-route', [`packB: { mcp: { url: ${fake.url} } }`, 'gate: { failOnPartialEvidence: true }']);
    const r1 = await runJourney(loadJourneyDef('mb-lost-route'));
    assert.deepEqual([r1.probes.succeeded.includes('scrape_configs'), r1.probeAnsweredBy], [true, { scrape_configs: [T.targets] }], 'the record keeps the tool that answered');
    answer = { __isError: 'Error: HTTP 404: Not Found — http://grafana.example.com/api/datasources/proxy/uid/x/api/v1/targets' };
    for (const run of [2, 3]) {
      const rec = await runJourney(loadJourneyDef('mb-lost-route'));
      assert.deepEqual([rec.vantage, rec.probes.failed.includes('scrape_configs'), rec.probes.unsupported.includes('scrape_configs'), 'probeUnsupported' in rec, rec.outcome],
        ['partial', true, false, false, 'gate-failed'], `run ${run}: the store served its targets — a 404 now is a lost route or a changed datasource`);
      assert.equal(rec.probeErrors.scrape_configs,
        `${T.targets}: it answered on ${r1.startedAt.slice(0, 10)}; now Error: HTTP 404: Not Found — http://grafana.example.com/api/datasources/proxy/uid/x/api/v1/targets`);
    }
  } finally {
    await fake.close();
  }
});

test('defect 7 replayed: scrape targets the store cannot serve beside a metric-names tool that needs a metric — every run full, the targets unsupported, metrics_metadata never called', async () => {
  // The backend of the request's defect 7: a federated store behind a datasource proxy (its targets
  // API answers 404) and an MCP whose only metric-names tool is metrics_metadata, which requires a
  // metric (called without one it answered -32602). Both read as failures before, so every run said
  // vantage partial, for ever. The rules answer, so the read is no lost one.
  const RULES = { groups: [{ name: 'shop', rules: [{ name: 'CheckoutDown', type: 'alerting', query: 'up{job="checkout"} == 0', labels: { severity: 'critical' } }] }] };
  const fake = await fakeMcp({
    metrics_metadata: (args) => (args?.metric ? { data: {} } : { __isError: 'MCP error -32602: Input validation error: metric is required' }),
    [T.targets]: { __isError: 'Error: HTTP 404: Not Found — http://grafana.example.com/api/datasources/proxy/uid/x/api/v1/targets' },
    [T.rules]: RULES,
  });
  try {
    journeyFile('mb-defect7', [`packB: { mcp: { url: ${fake.url} } }`]);
    for (const run of [1, 2]) {
      const rec = await runJourney(loadJourneyDef('mb-defect7'));
      assert.deepEqual([rec.vantage, rec.probes.failed], ['full', []], `run ${run}: the vantage is full, no family failed`);
      assert.ok(rec.probes.unsupported.includes('scrape_configs') && rec.probes.unsupported.includes('metric_names'), `run ${run}: the targets not served here, the metric names not offered`);
      assert.equal(rec.probeUnsupported.scrape_configs.reason, `${T.targets}: HTTP 404 Not Found`, `run ${run}: the tool and the status, the reason`);
      assert.ok(rec.drift.compared > 0 && Number.isFinite(rec.drift.alignmentPct) && typeof rec.grade.score === 'number', `run ${run}: graded, a figure over what was compared`);
      assert.equal(runBasis(rec).state, 'checked', `run ${run}: a person reads Checked, never Checked (partial)`);
    }
    assert.ok(!fake.calls.some((c) => c.name === 'metrics_metadata'), 'metrics_metadata is never called without its metric');
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------------------
// The helpers
// ---------------------------------------------------------------------------

test('probeMemoryOf: the newest record of the same live source that carries a probe table decides', () => {
  const entry = { reason: 'x: HTTP 404 Not Found', since: AT, tools: ['x'] };
  const rec = (source, extra) => ({ packB: { source }, probes: { attempted: [] }, ...extra });
  assert.deepEqual(probeMemoryOf([rec('mcp:a', { probeUnsupported: { scrape_configs: entry } })], 'mcp:a'), { unsupported: { scrape_configs: entry } });
  assert.equal(probeMemoryOf([rec('mcp:b', { probeUnsupported: { scrape_configs: entry } })], 'mcp:a'), null, 'another source');
  assert.deepEqual(probeMemoryOf([{ packB: { source: 'mcp:a' }, outcome: 'vantage-lost' }, rec('mcp:a', { probeUnsupported: { scrape_configs: entry } })], 'mcp:a'),
    { unsupported: { scrape_configs: entry } }, 'a read that threw carries no probe table: passed over');
  assert.equal(probeMemoryOf([rec('mcp:a', {}), rec('mcp:a', { probeUnsupported: { scrape_configs: entry } })], 'mcp:a'), null, 'the newest answered: nothing remembered');
  assert.equal(probeMemoryOf([rec('mcp:a', { probeUnsupported: { scrape_configs: { reason: '', tools: ['x'] }, alerting_routes: { reason: 'y', tools: [] } } })], 'mcp:a'), null, 'a malformed entry is passed over');
  assert.equal(probeMemoryOf(null, 'mcp:a'), null);
});

test('probeMemoryOf: every record read names the tools that answered a family — data or an honest empty — and an older record that did not say which answers for every tool (E2)', () => {
  const rec = (source, startedAt, probes, extra = {}) => ({ packB: { source }, startedAt, probes: { attempted: [], succeeded: [], empty: [], failed: [], unsupported: [], ...probes }, ...extra });
  const records = [
    rec('mcp:a', '2026-11-16T10:00:00.000Z', { failed: ['scrape_configs'] }),
    rec('mcp:a', '2026-11-16T09:00:00.000Z', { empty: ['scrape_configs'] }, { probeAnsweredBy: { scrape_configs: ['t2'] } }),
    rec('mcp:b', '2026-11-16T08:30:00.000Z', { succeeded: ['scrape_configs'] }, { probeAnsweredBy: { scrape_configs: ['other'] } }),
    rec('mcp:a', '2026-11-16T08:00:00.000Z', { succeeded: ['scrape_configs'] }, { probeAnsweredBy: { scrape_configs: ['t1'] } }),
  ];
  assert.deepEqual(probeMemoryOf(records, 'mcp:a'), { answered: { scrape_configs: { tools: ['t2', 't1'], at: '2026-11-16T09:00:00.000Z' } } },
    'the newest answer\'s start, every tool that answered; another source is not this one');
  assert.deepEqual(probeMemoryOf([rec('mcp:a', '2026-11-16T08:00:00.000Z', { succeeded: ['scrape_configs'] })], 'mcp:a'),
    { answered: { scrape_configs: { tools: [], at: '2026-11-16T08:00:00.000Z', anyTool: true } } }, 'a record written before the tool was recorded');
  const entry = { reason: 'x: HTTP 404 Not Found', since: AT, tools: ['x'] };
  assert.deepEqual(probeMemoryOf([rec('mcp:a', AT, {}, { probeUnsupported: { scrape_configs: entry } }), records[3]], 'mcp:a'),
    { unsupported: { scrape_configs: entry }, answered: { scrape_configs: { tools: ['t1'], at: '2026-11-16T08:00:00.000Z' } } }, 'both memories, side by side');
});

test('firstProbeError: the first failed family in stage order, a lost run\'s own error, or null; one rule for the studio and the server', () => {
  const rec = { probes: { failed: ['dashboards', 'metric_names'] }, probeErrors: { dashboards: 'd: HTTP 502', metric_names: 'm: HTTP 503' } };
  assert.deepEqual(firstProbeError(rec), { family: 'metric_names', error: 'm: HTTP 503' });
  assert.equal(firstProbeErrorLib, firstProbeError, 'the server and the command line read the browser-safe rule');
  assert.deepEqual(firstProbeError({ outcome: 'vantage-lost', error: 'connect ECONNREFUSED' }), { family: null, error: 'connect ECONNREFUSED' });
  assert.deepEqual(firstProbeError({ probes: { failed: ['alert_rules'] }, probeErrors: {} }), { family: 'alert_rules', error: null });
  assert.equal(firstProbeError({ probes: { failed: [] } }), null);
  assert.deepEqual(inStageOrder(['alerting_routes', 'zz', 'metric_names', 'dashboards']), ['metric_names', 'dashboards', 'alerting_routes', 'zz']);
});

test('an old record that says restricted reads full: no vantage change after the upgrade; a family newly not served says what was answered (S3)', () => {
  const probes = { attempted: ['a', 'b'], succeeded: ['a'], empty: [], failed: [], unsupported: ['b'] };
  const before = { outcome: 'pass', vantage: 'restricted', probes, toolsExposedCount: 5, branches: [] };
  const after = { outcome: 'pass', vantage: 'full', probes, toolsExposedCount: 5, branches: [] };
  assert.equal(rankCauses({ previous: before, current: after }).vantage.changed, false);
  const failedTargets = { outcome: 'pass', vantage: 'partial', probes: { attempted: ['a', 'scrape_configs'], succeeded: ['a'], empty: [], failed: ['scrape_configs'], unsupported: [] }, toolsExposedCount: 5, branches: [] };
  const notServed = { outcome: 'pass', vantage: 'full', probes: { attempted: ['a', 'scrape_configs'], succeeded: ['a'], empty: [], failed: [], unsupported: ['scrape_configs'] }, probeUnsupported: { scrape_configs: { reason: 'metrics_targets: HTTP 404 Not Found', since: AT, tools: ['metrics_targets'] } }, toolsExposedCount: 5, branches: [] };
  assert.equal(rankCauses({ previous: failedTargets, current: notServed }).vantage.detail, 'vantage partial → full · probe family scrape_configs not served here (metrics_targets: HTTP 404 Not Found) — not counted as a failure');
});

test('the requirement-chain ladder says a family not served here, not "not exposed" (S3)', () => {
  const live = liveExport({
    scrape_configs: DOWN_JOB,
    metric_names: outcome('unsupported', { notServed: { reason: 'm: HTTP 404 Not Found', since: AT, tools: ['m'] } }),
  });
  const g = comparePackBranches(adapt(repoPack()), adapt(live));
  const metric = g.branches.flatMap((b) => b.nodes).find((n) => n.kind === 'metric' && n.status === 'declared_only');
  assert.equal(metric.ladder.detail, 'probe family metric_names not served here (m: HTTP 404 Not Found) — not counted as a failure');
});

// ---------------------------------------------------------------------------
// The record gains nothing secret (P7): a URL in a probe error keeps no query,
// no fragment and no userinfo — masked where the fetcher writes it
// ---------------------------------------------------------------------------

test('a probe error keeps no query string, userinfo or token of a URL — in the pack, the lost run\'s record and its notification (P7)', async () => {
  const { fetchMcp, maskProbeErrorUrls } = await import('./fetch-live-pack.mjs');
  const leakyNames = { __isError: 'Error: HTTP 401: Unauthorized — https://viewer:pw-mb-1@grafana.example.com/api/datasources/proxy/uid/x/api/v1/labels?match[]=up&api_key=KEY-MB-2&token=TOK-MB-3#frag' };
  const leakySearch = { __isError: 'HTTP 403: Forbidden — https://grafana.example.com/api/search?limit=100&sessionid=SID-MB-4' };
  const hidden = ['pw-mb-1', 'viewer', 'KEY-MB-2', 'TOK-MB-3', 'SID-MB-4', 'api_key', 'sessionid', 'match[]', 'limit=100', '#frag'];
  const leaks = (v) => hidden.filter((s) => (typeof v === 'string' ? v : JSON.stringify(v)).includes(s));
  const fake = await fakeMcp({ [T.names]: leakyNames, [T.search]: leakySearch, [T.rules]: REFUSED, [T.targets]: REFUSED });
  try {
    // The pack: the probe errors and the reasons a declared artefact is not checked.
    const fetched = await fetchMcp({ mcpUrl: fake.url, refreshedAt: AT });
    const ann = buildCanonicalPack({ refreshedAt: AT, mcpUrl: fake.url, ...fetched }).metadata.annotations;
    assert.equal(ann['mcp.probeErrors.metric_names'], `${T.names}: Error: HTTP 401: Unauthorized — https://grafana.example.com/api/datasources/proxy/uid/x/api/v1/labels`, 'the reason stays: the tool, the status, where the read went');
    assert.equal(ann['mcp.probeErrors.dashboards'].split(' · ')[0], `${T.search}: HTTP 403: Forbidden — https://grafana.example.com/api/search`);
    assert.deepEqual(leaks(ann), [], 'no query, fragment or userinfo of a URL reaches the pack');
    // The lost run the read makes (every family refused): its record and its notification.
    journeyFile('mb-leaky', [`packB: { mcp: { url: ${fake.url} } }`, 'notify: { urlEnv: MB_HOOK_URL, on: always, format: json }']);
    const posted = [];
    let err = null;
    try {
      await runJourney(loadJourneyDef('mb-leaky'), {
        resolveNotify: (n) => notifyTargetOf(n, { url: 'https://hooks.example.com/journey' }),
        notifier: async ({ body }) => { posted.push(body); return { sent: true, httpStatus: 200, attempts: 1, tookMs: 1 }; },
      });
    } catch (e) { err = e; }
    assert.ok(err?.vantageLost === true && leaks(err.message).length === 0, 'a lost run, its thrown error masked too');
    const [lost] = readJourneyRuns('mb-leaky');
    assert.equal(lost.error, ann['mcp.probeErrors.metric_names'], 'the lost run names the masked first probe error');
    assert.deepEqual(leaks(lost), [], 'nothing of a query, a fragment or userinfo in the run record');
    assert.equal(posted.length, 1, 'the loss was posted');
    assert.deepEqual(leaks(posted[0]), [], 'nor in the notification');
  } finally {
    await fake.close();
  }
  // The rule's edges: a URL with nothing to drop is left as written (no normalising); one that does
  // not parse keeps what precedes its query, its userinfo masked.
  assert.equal(maskProbeErrorUrls('see https://grafana.example.com and http://h.example.test:9090/api/v1/targets'), 'see https://grafana.example.com and http://h.example.test:9090/api/v1/targets');
  assert.equal(maskProbeErrorUrls('dial http://u:p@[bad/x?token=1 failed'), 'dial http://***@[bad/x failed');
});

test('a probe error that quotes its request without a scheme — urllib3\'s "Max retries exceeded with url: /path?api_key=…" — keeps no query or credential in the pack, the lost run\'s record, its thrown error or its notification (E3)', async () => {
  const { maskProbeErrorUrls } = await import('./fetch-live-pack.mjs');
  const SECRET = 'QueryValue-mb-5';
  const urllib3 = (path) => ({ __isError: `HTTPSConnectionPool(host='prom.example.com', port=443): Max retries exceeded with url: ${path}?api_key=${SECRET}&limit=5 (Caused by NewConnectionError('<urllib3.connection.HTTPSConnection object at 0x7f>: Failed to establish a new connection: [Errno 111] Connection refused'))` });
  const fake = await fakeMcp({ [T.names]: urllib3('/api/v1/label/__name__/values'), [T.search]: urllib3('/api/search'), [T.rules]: urllib3('/api/v1/rules'), [T.targets]: urllib3('/api/v1/targets') });
  const posted = [];
  let err = null;
  try {
    journeyFile('mb-urllib3', [`packB: { mcp: { url: ${fake.url} } }`, 'gate: { minAlignmentPct: 85 }', 'notify: { urlEnv: MB_HOOK_URL, on: breach, format: text }']);
    try {
      await runJourney(loadJourneyDef('mb-urllib3'), {
        resolveNotify: (n) => notifyTargetOf(n, { url: 'https://hooks.example.com/journey' }),
        notifier: async ({ body }) => { posted.push(body); return { sent: true, httpStatus: 200, attempts: 1, tookMs: 1 }; },
      });
    } catch (e) { err = e; }
  } finally {
    await fake.close();
  }
  const [lost] = readJourneyRuns('mb-urllib3');
  assert.equal(lost.outcome, 'vantage-lost');
  assert.equal(lost.error, `${T.names}: HTTPSConnectionPool(host='prom.example.com', port=443): Max retries exceeded with url: /api/v1/label/__name__/values (Caused by NewConnectionError('<urllib3.connection.HTTPSConnection object at 0x7f>: Failed to establish a new connection: [Errno 111] Connection refused'))`.slice(0, 200),
    'the reason stays — the host, the path, the cause — cut at 200 characters; the query goes');
  for (const [where, text] of [['the record', JSON.stringify(lost)], ['the thrown error (the 502 body)', String(err?.message)], ['the notification', posted.join('\n')]]) {
    assert.ok(!text.includes(SECRET) && !text.includes('api_key') && !text.includes('limit=5'), `${where} keeps no query`);
  }
  assert.equal(posted.length, 1, 'the loss was posted');
  // The rule's new edges: a credential-named pair anywhere, a Bearer or Basic value, a //user:pass@ link
  // with no scheme; idempotent; nothing else touched.
  const masked = maskProbeErrorUrls('connect failed: host=db user=shop password=hunter2 sslmode=require; Authorization: Bearer abc.def-123 at //viewer:pw@grafana/x (read timeout=10)');
  assert.equal(masked, 'connect failed: host=db user=shop password=*** sslmode=require; Authorization: Bearer *** at //***@grafana/x (read timeout=10)');
  assert.equal(maskProbeErrorUrls(masked), masked, 'masking twice changes nothing');
  for (const kept of ['metrics_label_values: MCP error -32602: Input validation error: is the label set?', 'x: HTTP 404: Not Found — http://grafana.example.com/api/v1/targets', '[GET /search][403] searchForbidden']) {
    assert.equal(maskProbeErrorUrls(kept), kept, kept);
  }
  assert.equal(maskProbeErrorUrls('[GET /search?limit=1&token=t-mb-6][403] searchForbidden'), '[GET /search][403] searchForbidden');
});

// ---------------------------------------------------------------------------
// The readers read the lost run the engine writes (tools/lib/run-basis.mjs,
// its studio copy, the notification, the Neuron model, the Run's toast)
// ---------------------------------------------------------------------------

test('the readers read the lost run the engine writes: the breach by its criterion, the first probe error by live-fetch\'s rule, no data said as no data, the 502\'s outcome', async () => {
  const rb = await import('./lib/run-basis.mjs');
  const om = await import('../studio/overview-model.mjs');
  const { buildNotifyPayload, renderNotifyText } = await import('./lib/journey-notify.mjs');
  const { buildJourneyDetail } = await import('./lib/neuron-model.mjs');
  const { servicesRefusal } = await import('../studio/services-api.mjs');
  // A read whose every family failed (an error to name) and an export whose every family answered
  // empty (none to name).
  const fake = await fakeMcp({ [T.names]: { __isError: 'HTTP 502 Bad Gateway' }, [T.search]: REFUSED, [T.rules]: REFUSED, [T.targets]: REFUSED });
  let refused;
  try {
    journeyFile('mb-read-refused', [`packB: { mcp: { url: ${fake.url} } }`]);
    await assert.rejects(runJourney(loadJourneyDef('mb-read-refused')), (e) => e.vantageLost === true);
    [refused] = readJourneyRuns('mb-read-refused');
  } finally {
    await fake.close();
  }
  journeyFile('mb-read-empty', [`packB: { file: ${packFile('mb-read-empty', liveExport(Object.fromEntries(FAMILIES.map((f) => [f, outcome('empty')]))))} }`]);
  await assert.rejects(runJourney(loadJourneyDef('mb-read-empty')), (e) => e.vantageLost === true && e.message === NO_PROBE_DATA);
  const [empty] = readJourneyRuns('mb-read-empty');

  // The first probe error: the family live-fetch's rule names (the one the engine wrote the lost
  // run's error by), its first entry, on one line — the same in run-basis and in the studio's copy.
  const first = firstProbeErrorLib(refused);
  assert.deepEqual([first.family, refused.error], ['metric_names', first.error]);
  for (const read of [rb.firstProbeErrorOf, om.firstProbeErrorOf]) assert.equal(read(refused), rb.safeErrorText(first.error.split(' · ')[0]));
  assert.deepEqual([rb.runBasis(refused).state, rb.runBasis(refused).text], ['unreachable', `Live did not answer — ${T.names}: HTTP 502 Bad Gateway`]);
  // In the stage order whatever order a record lists its families in (every probe family and one unknown).
  const reversed = [...FAMILIES, 'zz_unknown'].reverse();
  assert.deepEqual(rb.basisFactsOf({ probes: { failed: reversed } }).probesFailed, inStageOrder(reversed).slice(0, 8));
  assert.deepEqual(om.basisFactsOf({ probes: { failed: reversed } }).probesFailed, inStageOrder(reversed).slice(0, 8));
  // No data: the lost run's own error (no probe family returned data) is no probe error to show.
  assert.equal(empty.error, NO_PROBE_DATA);
  assert.equal(firstProbeErrorLib(empty)?.error, NO_PROBE_DATA, 'the engine\'s rule falls back to the lost run\'s own error');
  for (const read of [rb.firstProbeErrorOf, om.firstProbeErrorOf]) assert.equal(read(empty), null);
  assert.deepEqual([rb.runBasis(empty).state, rb.runBasis(empty).text, rb.basisSummary(empty).liveLoss], ['unreachable', 'Live returned no data', 'no-data']);

  // The one breach a lost run carries, read by its criterion.
  for (const rec of [refused, empty]) {
    assert.deepEqual(rec.gate.breaches.map((b) => b.criterion), ['vantage']);
    const text = renderNotifyText(buildNotifyPayload({ record: rec, decision: { reason: 'vantage lost', triggers: ['vantage-lost'] } }));
    assert.match(text, /\n- vantage — vantage lost: no probe family returned data/, 'the notification names the breach by its criterion');
    const detail = buildJourneyDetail({ name: rec.journey }, [rec]);
    assert.deepEqual(detail.breachFrequency, [{ key: 'vantage', count: 1 }], 'the Neuron model counts it by its criterion');
  }
  assert.deepEqual([buildJourneyDetail({ name: 'e' }, [empty]).latest.noData, buildJourneyDetail({ name: 'r' }, [refused]).latest.firstProbeError], [true, rb.firstProbeErrorOf(refused)]);

  // The 502's outcome: the studio's error carries it, and the Run's toast says the run was recorded —
  // from the refreshed listing when it shows the record, from the 502 when it does not yet.
  const e = servicesRefusal(502, JSON.stringify({ ok: false, outcome: 'vantage-lost', error: NO_PROBE_DATA }));
  assert.deepEqual([e.status, e.outcome, e.message], [502, 'vantage-lost', `502: ${NO_PROBE_DATA}`]);
  assert.equal(servicesRefusal(502, { ok: false, error: 'x' }).outcome, undefined, 'a 502 that recorded nothing names no outcome');
  const listedEmpty = { name: 'shop.prod', lastRun: { startedAt: empty.startedAt, outcome: empty.outcome, ...rb.basisSummary(empty) } };
  assert.deepEqual(om.runRecordedToast({ name: 'Shop', env: 'prod', before: null, after: listedEmpty, outcome: e.outcome, error: e.message }), { text: 'Shop · prod: Live returned no data.', tone: 'error' });
  assert.deepEqual(om.runRecordedToast({ name: 'Shop', env: 'prod', before: null, after: null, outcome: e.outcome, error: e.message }),
    { text: `Shop · prod: Unreachable — ${NO_PROBE_DATA}.`, tone: 'error', unlisted: true }, 'recorded, though the listing does not show it yet');
  assert.equal(om.runRecordedToast({ name: 'Shop', env: 'prod', before: null, after: null, outcome: null, error: '502: fetch failed' }), null, 'nothing says it was recorded: the run did not finish');
});
