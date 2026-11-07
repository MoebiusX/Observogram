#!/usr/bin/env node
/**
 * tools/test-chaos-run-evidence.mjs — the chaos run feed, read live (spec 1.5).
 *
 * The `chaos_run_evidence` capability reads what a certification harness published about the
 * newest run of each experiment (tools/lib/contracts/chaos-run-evidence.mjs) through the MCP's
 * metrics query tool — whose name lives in the registry only. This suite pins:
 *   - the registry row, resolved like every other (no tool name written here);
 *   - chaosRunsFromAnswers: per experiment its outcome (PASS → pass, FAIL → fail, else aborted),
 *     the run's finish time, the slowest expected alert's time, the alerts that fired; an empty
 *     feed, a feed with no finish time and a non-vector answer each said so;
 *   - sampleChaosRuns: not advertised → not attempted, a failing tool → failed with the reason;
 *   - the live pack: `mcp.chaos.feed`, `mcp.chaos.runs` on data, and `observogram.unobserved.chaos`
 *     kept (the live side never holds an experiment's definition) with the feed's answer in it;
 *   - end to end: a declared experiment graded against that live pack is proven, measured.
 *
 * Run: node --test tools/test-chaos-run-evidence.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, capabilityTool } from './lib/contracts/mcp-capabilities.mjs';
import { CHAOS_RUN_PROBES, chaosRunsFromAnswers } from './lib/contracts/chaos-run-evidence.mjs';
import { sampleChaosRuns, buildCanonicalPack } from './fetch-live-pack.mjs';
import { computeDiagnosticGrade, computePostureMatrix } from '../studio/diagnostic-grade.mjs';

const vector = (series) => ({ resultType: 'vector', result: series.map(([metric, v]) => ({ metric, value: [1762400000, String(v)] })) });
const FINISHED = Date.parse('2026-11-05T06:00:00Z') / 1000;
const ANSWERS = {
  pass: vector([[{ experiment: 'api-pod-kill', status: 'PASS', job: 'certification' }, 1], [{ experiment: 'api-latency', status: 'FAIL' }, 0], [{ experiment: 'broker-loss', status: 'ERROR' }, 0]]),
  finished: vector([[{}, FINISHED]]),
  mttd: vector([[{ experiment: 'api-pod-kill', alertname: 'PodDown' }, 42.4], [{ experiment: 'api-pod-kill', alertname: 'ErrorBudgetBurn' }, 95], [{ experiment: 'api-latency', alertname: 'LatencyHigh' }, 400]]),
};

test('the registry row: evidence, an instant vector, the same metrics query tool the stack sampler resolves', () => {
  const row = CAPABILITIES.chaos_run_evidence;
  assert.equal(row.kind, 'evidence');
  assert.equal(row.responseShape, 'instant-vector');
  assert.equal(capabilityTool('chaos_run_evidence'), capabilityTool('stack_self_metrics'));
  assert.deepEqual(CHAOS_RUN_PROBES.map(f => f.id), ['mq-cert']);
  assert.deepEqual(Object.keys(CHAOS_RUN_PROBES[0].queries), ['pass', 'finished', 'mttd']);
});

test('chaosRunsFromAnswers: per experiment its outcome, the run time, the slowest alert and the alerts that fired', () => {
  const read = chaosRunsFromAnswers(ANSWERS);
  assert.equal(read.outcome, 'data');
  assert.deepEqual(read.runs, {
    'api-pod-kill': { at: '2026-11-05T06:00:00Z', outcome: 'pass', observed_mttd: '1m35s', alerts_fired: ['ErrorBudgetBurn', 'PodDown'] },
    'api-latency': { at: '2026-11-05T06:00:00Z', outcome: 'fail', observed_mttd: '6m40s', alerts_fired: ['LatencyHigh'] },
    'broker-loss': { at: '2026-11-05T06:00:00Z', outcome: 'aborted', alerts_fired: [] },
  });
  // The Prometheus API envelope reads the same.
  const wrapped = Object.fromEntries(Object.entries(ANSWERS).map(([k, v]) => [k, { status: 'success', data: v }]));
  assert.deepEqual(chaosRunsFromAnswers(wrapped).runs, read.runs);
  assert.deepEqual(chaosRunsFromAnswers({ ...ANSWERS, pass: vector([]) }), { outcome: 'empty', runs: {}, reason: 'no run is published' });
  assert.deepEqual(chaosRunsFromAnswers({ ...ANSWERS, finished: vector([]) }), { outcome: 'empty', runs: {}, reason: 'the run publishes no finish time' });
  assert.equal(chaosRunsFromAnswers({ ...ANSWERS, pass: { error: 'bad query' } }).outcome, 'failed');
  assert.equal(chaosRunsFromAnswers({ ...ANSWERS, pass: vector([[{ job: 'x' }, 1]]) }).reason, 'no series names an experiment');
});

const fakeTool = (answers, { fail = false } = {}) => {
  const calls = [];
  const byQuery = Object.fromEntries(Object.entries(CHAOS_RUN_PROBES[0].queries).map(([k, q]) => [q, answers[k]]));
  return { calls, callTool: async (tool, args) => { calls.push([tool, args.query]); if (fail) throw new Error('upstream 502'); return byQuery[args.query]; } };
};

test('sampleChaosRuns: three queries through the resolved tool; not advertised → not attempted; a failing tool → failed', async () => {
  const tool = capabilityTool('chaos_run_evidence');
  const ok = fakeTool(ANSWERS);
  const sampled = await sampleChaosRuns({ callTool: ok.callTool, metricsQueryTool: tool, discoveredToolNames: new Set([tool]), hasToolsList: true });
  assert.deepEqual([sampled.status, sampled.outcome, sampled.feed, sampled.callsMade], ['sampled', 'data', 'mq-cert', 3]);
  assert.ok(ok.calls.every(([t]) => t === tool));
  assert.equal(sampled.runs['api-pod-kill'].outcome, 'pass');
  const hidden = await sampleChaosRuns({ callTool: ok.callTool, metricsQueryTool: tool, discoveredToolNames: new Set(), hasToolsList: true });
  assert.deepEqual([hidden.status, hidden.outcome, hidden.callsMade], ['not-attempted', 'unsupported', 0]);
  const broken = fakeTool(ANSWERS, { fail: true });
  const failed = await sampleChaosRuns({ callTool: broken.callTool, metricsQueryTool: tool, hasToolsList: false });
  assert.deepEqual([failed.status, failed.outcome, failed.reason], ['sampled', 'failed', 'upstream 502']);
  assert.equal(broken.calls.length, 1, 'the pass query failing stops the feed: nothing to read the rest against');
});

const live = (chaosRuns) => buildCanonicalPack({
  refreshedAt: '2026-11-06T00:00:00Z', mcpUrl: 'https://fake-mcp.test/observability',
  health: { services: [{ name: 'svc-checkout' }] }, topology: { dependencies: [] }, anomaliesActive: {}, baselinesData: { baselines: [] }, errors: {},
  ...(chaosRuns ? { chaosRuns } : {}),
});

test('the live pack: the feed and the runs as annotations; chaos stays unobserved, with what the feed answered', () => {
  const data = live({ status: 'sampled', outcome: 'data', feed: 'mq-cert', runs: chaosRunsFromAnswers(ANSWERS).runs, reason: null, callsMade: 3 }).metadata.annotations;
  assert.equal(data['mcp.chaos.feed'], 'mq-cert:data');
  assert.deepEqual(JSON.parse(data['mcp.chaos.runs'])['api-pod-kill'].outcome, 'pass');
  assert.match(data['observogram.unobserved.chaos'], /no MCP tool exposes chaos experiment definitions; the mq-cert run feed reports 3 experiment run\(s\)/);
  const empty = live({ status: 'sampled', outcome: 'empty', feed: 'mq-cert', runs: {}, reason: 'no run is published', callsMade: 3 }).metadata.annotations;
  assert.equal(empty['mcp.chaos.feed'], 'mq-cert:empty');
  assert.equal(empty['mcp.chaos.runs'], undefined);
  assert.match(empty['observogram.unobserved.chaos'], /no chaos run feed is published \(no run is published\)/);
  const before = live(null).metadata.annotations;
  assert.equal(before['observogram.unobserved.chaos'], 'no MCP tool exposes chaos experiments', 'a caller that predates the feed: as before');
  assert.equal(before['mcp.chaos.feed'], undefined);
  assert.deepEqual(live(null).spec.validation, {}, 'the live pack declares no experiment from a run record');
});

test('end to end: a declared experiment graded against the live pack is proven by the measured run', () => {
  const runs = chaosRunsFromAnswers(ANSWERS).runs;
  const packB = live({ status: 'sampled', outcome: 'data', feed: 'mq-cert', runs, reason: null, callsMade: 3 });
  const packA = { id: 'repo', meta: { annotations: {} }, layers: { L1: [], L2: [], L4: {}, L5: [
    { id: 'CHAOS-01', title: 'api-pod-kill', spec: { id: 'api-pod-kill', schedule: 'weekly', expected_alerts: ['PodDown'], expected_mttd: '2m' } },
  ] } };
  const nowMs = Date.parse('2026-11-06T00:00:00Z');
  const grade = computeDiagnosticGrade(packA, packB, computePostureMatrix(packA, null), 'production-live', null, { nowMs });
  const c = [...grade.trust.criteria].find(x => x.key === 'chaos-validated');
  assert.equal(c.pass, true);
  assert.equal(c.proof.source, 'measured');
  assert.equal(c.detail, 'recovery proven 2026-11-05 by fault injection: 1 of 1 chaos experiment passed a run within its window (measured by the live run feed)');
  // The same experiment, the feed one week staler than its weekly window: stale.
  const later = computeDiagnosticGrade(packA, packB, computePostureMatrix(packA, null), 'production-live', null, { nowMs: nowMs + 9 * 86400000 });
  assert.equal([...later.trust.criteria].find(x => x.key === 'chaos-validated').proof.state, 'stale');
});
