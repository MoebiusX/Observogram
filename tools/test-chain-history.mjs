#!/usr/bin/env node
/**
 * tools/test-chain-history.mjs
 *
 * Unit test for tools/lib/chain-history.mjs — the zero-import helpers that
 * persist requirement-chain verdicts per journey run (step 4, slice 3).
 * Pure functions over hand-built graph results and run records: which
 * nodes are recorded, worst-first ordering, the caps and their truncated
 * markers, the listing summary with its top exposure, and the diff of two
 * consecutive records (directions, appeared / disappeared, node lists,
 * malformed input). Exit 0 = pass.
 */

import { readFileSync } from 'node:fs';
import { createHarness } from './lib/harness.mjs';
import {
  DEGRADED_STATUSES, BRANCH_RECORD_CAPS, VERDICT_RANK, LADDER_VERDICT_RANK,
  isDegradedNode, degradedSeverity, branchRecordsFromGraph, chainSummary, transitionDirection, diffRunBranches,
} from './lib/chain-history.mjs';

const { assert, report } = createHarness();

// --- vendoring guard: zero-import, no Node APIs, no environment ---
const src = readFileSync(new URL('./lib/chain-history.mjs', import.meta.url), 'utf8');
assert(!/^\s*import\s/m.test(src), 'chain-history.mjs is zero-import (vendored verbatim downstream)');
assert(!/from\s+'node:/.test(src) && !/process\.env/.test(src) && !/\bprocess\./.test(src), 'chain-history.mjs reads no node: module and no environment');

// --- the tables ---
assert(DEGRADED_STATUSES.node.join() === 'declared_only,drifted,live_only' && DEGRADED_STATUSES.ladder.join() === 'present_unhealthy,present_stale,unobserved',
       'DEGRADED_STATUSES names the node statuses and ladder statuses worth recording');
assert(BRANCH_RECORD_CAPS.maxBranches === 64 && BRANCH_RECORD_CAPS.maxNodes === 16 && BRANCH_RECORD_CAPS.maxDeltaFields === 6, 'caps: 64 branches × 16 nodes × 6 delta fields');
assert(VERDICT_RANK.intact < VERDICT_RANK.partial && VERDICT_RANK.partial < VERDICT_RANK.broken && !('undeclared' in VERDICT_RANK), 'verdict rank: intact < partial < broken; undeclared unranked');
assert(LADDER_VERDICT_RANK.healthy < LADDER_VERDICT_RANK.degraded && LADDER_VERDICT_RANK.degraded < LADDER_VERDICT_RANK.unobserved && LADDER_VERDICT_RANK.unobserved < LADDER_VERDICT_RANK.broken,
       'ladder rank: healthy < degraded < unobserved < broken');

// --- fixtures: a hand-built compareBranches result ---
const radius = (slos, alerts = 0, total = slos + alerts) => ({ slos, alerts, panels: 0, dashboards: 0, routes: 0, remediations: 0, total });
const ladder = (rung, status, detail) => ({ rung, status, detail });
const node = (status, kind, label, patch = {}) => ({
  status, key: `${kind}::${label}`, kind, layer: null, label, weight: 1, aId: null, bId: null, virtual: false,
  deltas: [], blastRadius: radius(0), ladder: ladder('exists', null, 'no liveness field on the wire for this kind'), ...patch,
});
const branch = (rootKey, patch = {}) => ({
  rootKey, title: rootKey.replace(/^slo::/, ''), rootKind: 'slo', hasA: true, hasB: true,
  verdict: 'intact', integrity: 1, integrityPct: 100, ladderVerdict: 'healthy', ladderIntegrity: 1, ladderIntegrityPct: 100,
  confidence: 'declared', edgeProvenance: {}, missingRoles: [], counts: {}, nodes: [], ...patch,
});

const nodes = [
  node('aligned', 'slo', 'checkout', { ladder: ladder('exists', null, 'declaration') }),                                   // healthy: not recorded
  node('unverifiable', 'chaos', 'pod-kill', { ladder: ladder('unobserved', null, 'not live-introspectable from any MCP vantage') }), // honest blind spot: not recorded
  node('live_only', 'metric', 'extra_metric', { blastRadius: radius(1, 1) }),
  node('declared_only', 'panel', 'slo-panel', { ladder: ladder('unobserved', 'unobserved', 'probe family dashboards failed (HTTP 502)') }),
  node('drifted', 'burn_rate', 'burn-rate alert: checkout', { deltas: [{ field: 'windows[0].long' }, { field: 'windows[0].short' }, { field: 'windows[0].long' }], blastRadius: radius(1, 0, 3) }),
  node('aligned', 'recording_rule', 'checkout:ratio', { ladder: ladder('exists', 'present_stale', 'lastEvaluation 12m ago > 2× interval 1m'), blastRadius: radius(1, 1, 5) }),
  node('aligned', 'scrape_job', 'payment', { ladder: ladder('exists', 'present_unhealthy', 'target payment:9090 down'), blastRadius: radius(2, 2, 9) }),
  node('declared_only', 'metric', 'http_requests_total', { ladder: ladder('absent', null, 'absent from Pack B; probe family metric_names answered without it'), blastRadius: radius(1, 1, 4) }),
  node('declared_only', 'sli', 'checkout_sli', { ladder: ladder('absent', null, 'absent from Pack B'), blastRadius: radius(1, 1, 6) }),
  node('declared_only', 'scrape_job', 'orders', { ladder: ladder('exists', 'present_unhealthy', 'on the wire but withheld from Pack B: every target down'), blastRadius: radius(1, 1, 2) }),
];
const graph = {
  branches: [
    branch('slo::a', { verdict: 'broken', integrityPct: 40, ladderVerdict: 'broken', ladderIntegrityPct: 30, confidence: 'inferred',
      missingRoles: [{ role: 'action', detail: 'SLO has no burn-rate alert protecting it', weight: 2, loadBearing: true }], nodes }),
    branch('slo::b', { verdict: 'partial', integrityPct: 80, ladderVerdict: 'degraded', ladderIntegrityPct: 70, nodes: [node('drifted', 'burn_rate', 'burn-rate alert: b', { deltas: [{ field: 'objective' }] })] }),
    branch('slo::c'),
    { rootKey: 'slo::live', title: 'live', rootKind: 'slo', hasA: false, hasB: true, verdict: 'undeclared', integrity: 0, integrityPct: 0,
      ladderVerdict: 'undeclared', ladderIntegrity: 0, ladderIntegrityPct: 0, confidence: 'inferred', missingRoles: [], counts: {},
      nodes: [node('live_only', 'slo', 'live', { blastRadius: radius(0, 1) }), node('live_only', 'sli', 'live_sli', { blastRadius: radius(1, 1, 3) })] },
  ],
  rollup: { intact: 1, partial: 1, broken: 1, undeclared: 1, declaredTotal: 3, total: 4, integrityMean: 0.7333, integrityPct: 73, ladder: { healthy: 1, degraded: 1, broken: 1, unobserved: 0, integrityMean: 0.6667, integrityPct: 67 } },
};

// --- isDegradedNode / degradedSeverity ---
assert(isDegradedNode(nodes[2]) && isDegradedNode(nodes[3]) && isDegradedNode(nodes[4]) && isDegradedNode(nodes[5]) && isDegradedNode(nodes[6]),
       'live_only, declared_only, drifted, present_stale and present_unhealthy nodes are recorded');
assert(!isDegradedNode(nodes[0]) && !isDegradedNode(nodes[1]), 'an aligned-and-healthy node and an unverifiable node are not recorded');
assert(!isDegradedNode(null) && !isDegradedNode('drifted') && !isDegradedNode({ status: 'aligned', ladder: 'broken' }), 'isDegradedNode tolerates non-objects and a non-object ladder');
assert(degradedSeverity(nodes[8]) === 0 && degradedSeverity(nodes[9]) === 1 && degradedSeverity(nodes[5]) === 2 && degradedSeverity(nodes[4]) === 3 && degradedSeverity(nodes[3]) === 4 && degradedSeverity(nodes[2]) === 5,
       'severity: absent 0 < present_unhealthy 1 < present_stale 2 < drifted 3 < unobserved 4 < live_only 5',
       [nodes[8], nodes[9], nodes[5], nodes[4], nodes[3], nodes[2]].map(degradedSeverity));
assert(degradedSeverity(nodes[0]) === 6 && degradedSeverity(null) === 6, 'a node outside the table ranks last');

// --- branchRecordsFromGraph ---
const recs = branchRecordsFromGraph(graph);
assert(Array.isArray(recs) && recs.length === 4 && recs.truncated === undefined, 'one record per branch, in graph order, no truncated marker under the cap', recs.length);
assert(recs.map(r => r.rootKey).join() === 'slo::a,slo::b,slo::c,slo::live', 'records keep the graph order', recs.map(r => r.rootKey));
const a = recs[0];
assert(Object.keys(a).join() === 'rootKey,title,rootKind,verdict,ladderVerdict,integrityPct,ladderIntegrityPct,confidence,missingRoles,degraded',
       'a branch record carries exactly the persisted fields', Object.keys(a));
assert(a.title === 'a' && a.rootKind === 'slo' && a.verdict === 'broken' && a.ladderVerdict === 'broken' && a.integrityPct === 40 && a.ladderIntegrityPct === 30 && a.confidence === 'inferred',
       'verdicts, integrities and confidence are copied verbatim', a);
assert(a.missingRoles.join() === 'action', 'missingRoles are the role names only', a.missingRoles);
assert(a.degraded.length === 8, 'the degraded list holds every recorded node of the branch (aligned-healthy and unverifiable left out)', a.degraded.map(d => d.label));
assert(a.degraded.map(d => d.label).join() === 'checkout_sli,http_requests_total,payment,orders,checkout:ratio,burn-rate alert: checkout,slo-panel,extra_metric',
       'degraded nodes sort worst first: absent (by blast total desc), present_unhealthy (by total), present_stale, drifted, unobserved, live_only', a.degraded.map(d => d.label));
const d0 = a.degraded[0];
assert(Object.keys(d0).join() === 'key,kind,label,status,ladder,blastRadius,deltaFields', 'a degraded node carries exactly key, kind, label, status, ladder, blastRadius, deltaFields', Object.keys(d0));
assert(d0.key === 'sli::checkout_sli' && d0.kind === 'sli' && d0.status === 'declared_only' && d0.ladder.rung === 'absent' && d0.ladder.status === null && d0.ladder.detail === 'absent from Pack B',
       'the node record keeps key, kind, status and the ladder triple', d0);
assert(Object.keys(d0.blastRadius).join() === 'slos,alerts,panels,dashboards,routes,remediations,total' && d0.blastRadius.slos === 1 && d0.blastRadius.total === 6,
       'blastRadius is the summary shape', d0.blastRadius);
const drifted = a.degraded.find(d => d.status === 'drifted');
assert(drifted.deltaFields.join() === 'windows[0].long,windows[0].short', 'deltaFields are the unique delta field names', drifted.deltaFields);
assert(a.degraded.find(d => d.label === 'slo-panel').ladder.detail === 'probe family dashboards failed (HTTP 502)', 'an unobserved node keeps the probe-family detail');
assert(recs[2].degraded.length === 0 && recs[2].verdict === 'intact' && recs[2].missingRoles.length === 0, 'an intact branch records an empty degraded list');
assert(recs[3].verdict === 'undeclared' && recs[3].degraded.map(d => d.label).join() === 'live_sli,live', 'an undeclared branch records its live-only nodes (blast total desc)', recs[3].degraded.map(d => d.label));
{
  // The delta-field cap.
  const many = branchRecordsFromGraph({ branches: [branch('slo::d', { nodes: [node('drifted', 'slo', 'd', { deltas: Array.from({ length: 10 }, (_, i) => ({ field: `f${i}` })) })] })] });
  assert(many[0].degraded[0].deltaFields.length === 6 && many[0].degraded[0].deltaFields.join() === 'f0,f1,f2,f3,f4,f5', 'deltaFields are capped at 6', many[0].degraded[0].deltaFields);
  // A node without a ladder or blast radius records null for both; a missing kind reads unknown.
  const bare = branchRecordsFromGraph({ branches: [branch('slo::e', { nodes: [{ status: 'declared_only', label: 'x' }] })] });
  assert(bare[0].degraded[0].ladder === null && bare[0].degraded[0].blastRadius === null && bare[0].degraded[0].kind === 'unknown' && bare[0].degraded[0].key === '',
         'a bare node records null ladder / blast radius and kind unknown', bare[0].degraded[0]);
}
// Caps + truncated markers.
{
  const big = { branches: Array.from({ length: 70 }, (_, i) => branch(`slo::${String(i).padStart(2, '0')}`, {
    nodes: Array.from({ length: 20 }, (_, j) => node('declared_only', 'metric', `m${String(j).padStart(2, '0')}`, { ladder: ladder('absent', null, 'absent from Pack B'), blastRadius: radius(20 - j) })),
  })) };
  const capped = branchRecordsFromGraph(big);
  assert(capped.length === 64 && capped.truncated === true, 'branches are capped at 64 with truncated: true on the array', { n: capped.length, t: capped.truncated });
  assert(capped[0].degraded.length === 16 && capped[0].truncated === true, 'degraded nodes are capped at 16 with truncated: true on the branch', { n: capped[0].degraded.length, t: capped[0].truncated });
  assert(capped[0].degraded[0].label === 'm00' && capped[0].degraded[15].label === 'm15', 'the cap keeps the worst 16 (highest blast total first)', capped[0].degraded.map(d => d.label));
  assert(capped.map(r => r.rootKey)[63] === 'slo::63', 'the cap keeps the first 64 branches in graph order');
  const custom = branchRecordsFromGraph(big, { maxBranches: 2, maxNodes: 3 });
  assert(custom.length === 2 && custom.truncated === true && custom[1].degraded.length === 3 && custom[1].truncated === true, 'custom caps apply', { b: custom.length, n: custom[1].degraded.length });
  assert(!('truncated' in branchRecordsFromGraph(big, { maxBranches: 70, maxNodes: 20 })[0]) && branchRecordsFromGraph(big, { maxBranches: 70, maxNodes: 20 }).truncated === undefined,
         'exactly at the cap nothing is marked truncated');
}
assert(branchRecordsFromGraph(null).length === 0 && branchRecordsFromGraph({}).length === 0 && branchRecordsFromGraph({ branches: 'x' }).length === 0 && branchRecordsFromGraph({ branches: [null, 3] }).length === 0,
       'branchRecordsFromGraph is [] for a missing graph, no branches, a non-array and non-object entries');
assert(JSON.stringify(branchRecordsFromGraph(graph)) === JSON.stringify(recs), 'branchRecordsFromGraph is deterministic');

// --- chainSummary ---
const summary = chainSummary({ branches: recs });
assert(Object.keys(summary).join() === 'declaredTotal,intact,partial,broken,undeclared,ladder,integrityPct,ladderIntegrityPct,degradedNodes,topExposure',
       'chainSummary carries exactly the listing fields', Object.keys(summary));
assert(summary.declaredTotal === 3 && summary.intact === 1 && summary.partial === 1 && summary.broken === 1 && summary.undeclared === 1, 'chainSummary counts verdicts over the declared chains', summary);
assert(Object.keys(summary.ladder).join() === 'healthy,degraded,broken,unobserved' && summary.ladder.healthy === 1 && summary.ladder.degraded === 1 && summary.ladder.broken === 1 && summary.ladder.unobserved === 0,
       'chainSummary counts ladder verdicts over the declared chains', summary.ladder);
assert(summary.integrityPct === 73 && summary.ladderIntegrityPct === 67, 'integrities are the rounded means of the declared per-branch percentages', { i: summary.integrityPct, l: summary.ladderIntegrityPct });
assert(summary.degradedNodes === 11, 'degradedNodes counts every recorded node across every branch (undeclared included)', summary.degradedNodes);
assert(summary.topExposure && Object.keys(summary.topExposure).join() === 'label,kind,slos,alerts' && summary.topExposure.label === 'payment' && summary.topExposure.kind === 'scrape_job' && summary.topExposure.slos === 2 && summary.topExposure.alerts === 2,
       'topExposure is the degraded node that blinds the most SLOs (then alerts)', summary.topExposure);
assert(chainSummary({ branches: [recs[2]] }).topExposure === null && chainSummary({ branches: [recs[2]] }).degradedNodes === 0, 'no degraded node → topExposure null');
assert(chainSummary({ branches: [] }).declaredTotal === 0 && chainSummary({ branches: [] }).integrityPct === null && chainSummary({ branches: [] }).ladderIntegrityPct === null,
       'an empty branch list summarises to zero chains with null integrities — never 100 %');
assert(chainSummary({}) === null && chainSummary(null) === null && chainSummary({ branches: 'x' }) === null && chainSummary({ outcome: 'vantage-lost' }) === null,
       'chainSummary is null when the record carries no branches (vantage lost, pre-chain record)');
{
  const zeroRadius = chainSummary({ branches: [{ verdict: 'broken', ladderVerdict: 'broken', integrityPct: 0, ladderIntegrityPct: 0, degraded: [{ label: 'x', kind: 'panel', status: 'declared_only', blastRadius: radius(0, 0, 3) }, { label: 'y', kind: 'panel', status: 'declared_only', blastRadius: null }] }] });
  assert(zeroRadius.topExposure === null && zeroRadius.degradedNodes === 2, 'a node that blinds neither an SLO nor an alert is never the top exposure');
  const tie = chainSummary({ branches: [{ verdict: 'intact', ladderVerdict: 'healthy', integrityPct: 100, ladderIntegrityPct: 100, degraded: [
    { label: 'zeta', kind: 'metric', status: 'live_only', blastRadius: radius(1, 1, 2) }, { label: 'alpha', kind: 'metric', status: 'live_only', blastRadius: radius(1, 1, 2) }] }] });
  assert(tie.topExposure.label === 'alpha', 'ties on exposure break by label', tie.topExposure);
}

// --- transitionDirection ---
const v = (verdict, ladderVerdict) => ({ verdict, ladderVerdict });
assert(transitionDirection(v('intact', 'healthy'), v('broken', 'broken')) === 'worse' && transitionDirection(v('intact', 'healthy'), v('intact', 'degraded')) === 'worse'
       && transitionDirection(v('partial', 'degraded'), v('partial', 'unobserved')) === 'worse', 'a rank that only goes up is worse');
assert(transitionDirection(v('broken', 'broken'), v('intact', 'healthy')) === 'better' && transitionDirection(v('intact', 'unobserved'), v('intact', 'healthy')) === 'better', 'a rank that only goes down is better');
assert(transitionDirection(v('partial', 'healthy'), v('intact', 'degraded')) === 'changed', 'ranks moving against each other read changed');
assert(transitionDirection(v('undeclared', 'undeclared'), v('intact', 'healthy')) === 'changed' && transitionDirection(v('intact', 'healthy'), v('undeclared', 'undeclared')) === 'changed',
       'undeclared on either side is changed, never better or worse');
assert(transitionDirection(v('bogus', 'healthy'), v('intact', 'healthy')) === 'changed' && transitionDirection(null, undefined) === 'changed', 'unknown verdicts and missing pairs read changed');
assert(transitionDirection(v('intact', 'healthy'), v('intact', 'healthy')) === 'changed', 'an identical pair has no direction (callers only ask for differing pairs)');

// --- diffRunBranches ---
const prevRecord = { startedAt: '2026-09-08T10:00:00.000Z', branches: [
  { rootKey: 'slo::a', title: 'a', verdict: 'intact', ladderVerdict: 'healthy', degraded: [] },
  { rootKey: 'slo::b', title: 'b', verdict: 'partial', ladderVerdict: 'degraded', degraded: [{ key: 'burn_rate::b', label: 'burn b', status: 'drifted' }] },
  { rootKey: 'slo::gone', title: 'gone', verdict: 'intact', ladderVerdict: 'healthy', degraded: [] },
  { rootKey: 'slo::same', title: 'same', verdict: 'broken', ladderVerdict: 'broken', degraded: [{ key: 'sli::s', label: 's', status: 'declared_only' }] },
] };
const curRecord = { startedAt: '2026-09-08T10:15:00.000Z', branches: [
  { rootKey: 'slo::a', title: 'a', verdict: 'broken', ladderVerdict: 'broken', degraded: [{ key: 'sli::a', label: 'a_sli', status: 'declared_only' }, { key: 'metric::m', label: 'm', status: 'declared_only' }] },
  { rootKey: 'slo::b', title: 'b', verdict: 'intact', ladderVerdict: 'healthy', degraded: [] },
  { rootKey: 'slo::same', title: 'same', verdict: 'broken', ladderVerdict: 'broken', degraded: [{ key: 'sli::s', label: 's', status: 'declared_only' }, { key: 'metric::new', label: 'new', status: 'declared_only' }] },
  { rootKey: 'slo::new', title: 'new', verdict: 'intact', ladderVerdict: 'unobserved', degraded: [] },
] };
const t = diffRunBranches(prevRecord, curRecord);
assert(t && Object.keys(t).join() === 'since,changed,appeared,disappeared,any', 'diffRunBranches returns since, changed, appeared, disappeared, any', Object.keys(t || {}));
assert(t.since === '2026-09-08T10:00:00.000Z' && t.any === true, 'the diff names the previous start time and says something moved', { since: t.since, any: t.any });
assert(t.changed.length === 2 && t.changed.map(c => c.rootKey).join() === 'slo::a,slo::b', 'only chains whose verdict or ladder verdict differ are changed, in current order', t.changed.map(c => c.rootKey));
const ca = t.changed[0];
assert(Object.keys(ca).join() === 'rootKey,title,from,to,direction,nodes' && ca.title === 'a' && ca.from.verdict === 'intact' && ca.from.ladderVerdict === 'healthy' && ca.to.verdict === 'broken' && ca.to.ladderVerdict === 'broken' && ca.direction === 'worse',
       'a changed entry carries from / to pairs and the direction', ca);
assert(ca.nodes.newlyDegraded.join() === 'a_sli,m' && ca.nodes.recovered.length === 0, 'newlyDegraded lists the labels new on the current side', ca.nodes);
assert(t.changed[1].direction === 'better' && t.changed[1].nodes.recovered.join() === 'burn b' && t.changed[1].nodes.newlyDegraded.length === 0, 'recovered lists the labels gone from the previous side', t.changed[1]);
assert(t.appeared.join() === 'slo::new' && t.disappeared.join() === 'slo::gone', 'appeared / disappeared are the root keys present on one side only', { a: t.appeared, d: t.disappeared });
assert(!t.changed.some(c => c.rootKey === 'slo::same'), 'a chain with the same verdicts but a new degraded node is not a verdict transition');
const same = diffRunBranches(curRecord, curRecord);
assert(same.any === false && same.changed.length === 0 && same.appeared.length === 0 && same.disappeared.length === 0, 'an identical record diffs to any: false', same);
assert(diffRunBranches({ branches: [] }, { branches: [] }).any === false, 'two empty branch lists diff to any: false');
assert(diffRunBranches(null, curRecord) === null && diffRunBranches(prevRecord, null) === null && diffRunBranches({ outcome: 'vantage-lost' }, curRecord) === null && diffRunBranches(prevRecord, { branches: 'x' }) === null,
       'diffRunBranches is null when either side carries no branches');
assert(diffRunBranches({ branches: [{ rootKey: 'x', verdict: 'undeclared', ladderVerdict: 'undeclared', degraded: [] }] }, { branches: [{ rootKey: 'x', verdict: 'intact', ladderVerdict: 'healthy', degraded: [] }] }).changed[0].direction === 'changed',
       'an undeclared chain that becomes declared is a changed transition');
{
  // Malformed input never throws.
  let threw = null;
  try {
    diffRunBranches({ branches: [null, 'x', {}, { rootKey: 5, degraded: 'nope' }] }, { branches: [{}, { rootKey: 5, verdict: 'intact', degraded: [null, { label: 3 }] }] });
    branchRecordsFromGraph({ branches: [{ nodes: [null, 1, { deltas: 'x', ladder: 'y', blastRadius: 'z', status: 'drifted' }] }] });
    chainSummary({ branches: [{ degraded: [null, 4, { blastRadius: 7 }] }, 'x'] });
    transitionDirection('a', 2);
  } catch (e) { threw = e; }
  assert(threw === null, 'malformed branches, nodes and records never throw', threw && threw.message);
  const dupe = diffRunBranches({ branches: [{ rootKey: 'd', verdict: 'intact', ladderVerdict: 'healthy' }, { rootKey: 'd', verdict: 'broken', ladderVerdict: 'broken' }] },
                               { branches: [{ rootKey: 'd', verdict: 'partial', ladderVerdict: 'degraded' }, { rootKey: 'd', verdict: 'intact', ladderVerdict: 'healthy' }] });
  assert(dupe.changed.length === 1 && dupe.changed[0].from.verdict === 'intact' && dupe.changed[0].to.verdict === 'partial', 'a duplicated root key is compared once, first occurrence on each side', dupe.changed);
}
assert(JSON.stringify(diffRunBranches(prevRecord, curRecord)) === JSON.stringify(t), 'diffRunBranches is deterministic');

report('chain-history', 'all chain-history assertions pass.');
