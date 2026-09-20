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
  CAUSE_KINDS, CAUSE_NOTE, CAUSE_SCORES, FAMILY_FOR_KIND, familyForKind, deploysInWindow, rankCauses, topCause,
  DEPLOY_GROUP_KINDS, deployArtifactNames, PRODUCT_FAMILIES, familiesForProduct,
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
assert(Object.keys(d0).join() === 'key,kind,label,status,ladder,blastRadius,deltaFields,aId,bId', 'a degraded node carries exactly key, kind, label, status, ladder, blastRadius, deltaFields, aId, bId', Object.keys(d0));
assert(d0.key === 'sli::checkout_sli' && d0.kind === 'sli' && d0.status === 'declared_only' && d0.ladder.rung === 'absent' && d0.ladder.status === null && d0.ladder.detail === 'absent from Pack B',
       'the node record keeps key, kind, status and the ladder triple', d0);
assert(d0.aId === null && d0.bId === null, 'a node without artefact ids records null for both (never an empty string)', { a: d0.aId, b: d0.bId });
{
  const withIds = branchRecordsFromGraph({ branches: [branch('slo::ids', { nodes: [node('drifted', 'recording_rule', 'r', { aId: 'QRY-01', bId: 'QRY-07' }), node('declared_only', 'panel', 'p', { aId: 'PANEL-03' })] })] })[0].degraded;
  assert(withIds.map(d => `${d.aId}/${d.bId}`).join() === 'PANEL-03/null,QRY-01/QRY-07', 'the adapter artefact ids on each side are persisted on the degraded node', withIds.map(d => [d.label, d.aId, d.bId]));
}
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
assert(Object.keys(summary).join() === 'declaredTotal,intact,partial,broken,undeclared,ladder,integrityPct,ladderIntegrityPct,degradedNodes,undeclaredNodes,topExposure',
       'chainSummary carries exactly the listing fields', Object.keys(summary));
assert(summary.declaredTotal === 3 && summary.intact === 1 && summary.partial === 1 && summary.broken === 1 && summary.undeclared === 1, 'chainSummary counts verdicts over the declared chains', summary);
assert(Object.keys(summary.ladder).join() === 'healthy,degraded,broken,unobserved' && summary.ladder.healthy === 1 && summary.ladder.degraded === 1 && summary.ladder.broken === 1 && summary.ladder.unobserved === 0,
       'chainSummary counts ladder verdicts over the declared chains', summary.ladder);
assert(summary.integrityPct === 73 && summary.ladderIntegrityPct === 67, 'integrities are the rounded means of the declared per-branch percentages', { i: summary.integrityPct, l: summary.ladderIntegrityPct });
assert(summary.degradedNodes === 9 && summary.undeclaredNodes === 2, 'degradedNodes counts the recorded nodes of the declared chains only; the live-only nodes of undeclared chains are inventory, counted apart as undeclaredNodes', { d: summary.degradedNodes, u: summary.undeclaredNodes });
{
  const onlyUndeclared = chainSummary({ branches: [recs[3]] });
  assert(onlyUndeclared.degradedNodes === 0 && onlyUndeclared.undeclaredNodes === 2 && onlyUndeclared.topExposure === null, 'a live-only node of an undeclared chain is never the top exposure, however many SLOs it would blind', onlyUndeclared);
}
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
assert(Object.keys(ca).join() === 'rootKey,title,from,to,direction,nodes,note' && ca.title === 'a' && ca.from.verdict === 'intact' && ca.from.ladderVerdict === 'healthy' && ca.to.verdict === 'broken' && ca.to.ladderVerdict === 'broken' && ca.direction === 'worse' && ca.note === null,
       'a changed entry carries from / to pairs, the direction and a null note when the declared side did not move', ca);
{
  const roleMoved = diffRunBranches({ branches: [{ rootKey: 'r', verdict: 'partial', ladderVerdict: 'degraded', missingRoles: [], degraded: [] }, { rootKey: 't', verdict: 'partial', ladderVerdict: 'degraded', degraded: [] }] },
                                    { branches: [{ rootKey: 'r', verdict: 'broken', ladderVerdict: 'broken', missingRoles: ['action', 'sli'], degraded: [] }, { rootKey: 't', verdict: 'broken', ladderVerdict: 'broken', degraded: [], truncated: true }] });
  assert(roleMoved.changed[0].note === 'declared side: missingRoles none → action, sli', 'a changed entry whose missing roles moved carries a declared-side note naming before and after', roleMoved.changed[0].note);
  assert(roleMoved.changed[1].note === 'degraded list truncated (cap 16) — a node that moved may be unrecorded', 'a changed entry whose degraded list was cut on either side says so', roleMoved.changed[1].note);
  const both = diffRunBranches({ branches: [{ rootKey: 'r', verdict: 'intact', ladderVerdict: 'healthy', missingRoles: ['sli'], degraded: [], truncated: true }] }, { branches: [{ rootKey: 'r', verdict: 'broken', ladderVerdict: 'broken', missingRoles: [], degraded: [] }] });
  assert(both.changed[0].note === 'declared side: missingRoles sli → none · degraded list truncated (cap 16) — a node that moved may be unrecorded', 'both notes join with a middle dot', both.changed[0].note);
}
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

// --- the cause tables ---
assert(CAUSE_KINDS.join() === 'observogram-deploy,config-drift,backend-version,stack-self-metric', 'CAUSE_KINDS is the tie-break order: deploy, drift, version, stack sample', CAUSE_KINDS);
assert(CAUSE_NOTE === 'candidate causes ranked by evidence — not a root-cause verdict', 'the note keeps the honesty vocabulary');
assert(CAUSE_SCORES.deployTouchedNode === 0.9 && CAUSE_SCORES.deployTouchedPack === 0.6 && CAUSE_SCORES.driftDecisionBearing === 0.8 && CAUSE_SCORES.driftCosmetic === 0.4
       && CAUSE_SCORES.versionFeedsMovedKind === 0.6 && CAUSE_SCORES.versionElsewhere === 0.3 && CAUSE_SCORES.stackSignal === 0.5, 'the scoring table is the documented one', CAUSE_SCORES);
assert(PRODUCT_FAMILIES.prometheus.join() === 'scrape,ruler,tsdb' && PRODUCT_FAMILIES.victoriametrics.join() === 'scrape,ruler,tsdb' && PRODUCT_FAMILIES.thanos.join() === 'scrape,ruler,tsdb' && PRODUCT_FAMILIES.mimir.join() === 'scrape,ruler,tsdb'
       && PRODUCT_FAMILIES.grafana.join() === 'dashboards' && PRODUCT_FAMILIES.alertmanager.join() === 'notify' && PRODUCT_FAMILIES.otel.join() === 'collector' && PRODUCT_FAMILIES.otelcol.join() === 'collector'
       && PRODUCT_FAMILIES.loki.join() === 'logs' && PRODUCT_FAMILIES.promtail.join() === 'logs' && PRODUCT_FAMILIES.jaeger.join() === 'traces' && PRODUCT_FAMILIES.tempo.join() === 'traces',
       'PRODUCT_FAMILIES maps each product whose version the fetcher reports to the stack families it feeds', PRODUCT_FAMILIES);
assert(familiesForProduct('Prometheus').join() === 'scrape,ruler,tsdb' && familiesForProduct('unknown-product').length === 0 && familiesForProduct(null).length === 0, 'familiesForProduct is case-insensitive and knows no family for an unknown product');
assert(FAMILY_FOR_KIND.scrape_job === 'scrape' && FAMILY_FOR_KIND.recording_rule === 'ruler' && FAMILY_FOR_KIND.burn_rate === 'ruler' && FAMILY_FOR_KIND.sli === 'ruler' && FAMILY_FOR_KIND.slo === 'ruler'
       && FAMILY_FOR_KIND.alert_route === 'notify' && FAMILY_FOR_KIND.backend === 'tsdb' && FAMILY_FOR_KIND.otel === 'collector' && FAMILY_FOR_KIND.panel === 'dashboards' && FAMILY_FOR_KIND.dashboard === 'dashboards' && FAMILY_FOR_KIND.synthetic === 'synthetic',
       'FAMILY_FOR_KIND maps every kind to the stack family that feeds it', FAMILY_FOR_KIND);
assert(familyForKind('pipeline_exporter_logs') === 'collector' && familyForKind('pipeline_receiver') === 'collector' && familyForKind('metric') === null && familyForKind(null) === null && familyForKind('bogus') === null,
       'familyForKind reads any pipeline_* kind as collector and knows no family for metric or unknown kinds');

// --- deploysInWindow ---
{
  const dep = (deployId, at, patch = {}) => ({ type: 'deploy', deployId, at, actor: 'ci', pack: { id: 'p' }, mode: 'upsert', items: [], ...patch });
  const log = [
    dep('dep_b', '2026-09-08T10:10:00.000Z'), dep('dep_a', '2026-09-08T10:10:00.000Z'),
    dep('dep_since', '2026-09-08T10:00:00.000Z'), dep('dep_until', '2026-09-08T10:15:00.000Z'), dep('dep_after', '2026-09-08T10:15:00.001Z'), dep('dep_before', '2026-09-08T09:59:59.999Z'),
    { type: 'verify', deployId: 'dep_a', at: '2026-09-08T10:11:00.000Z', outcome: 'pending' }, { type: 'verify', deployId: 'dep_a', at: '2026-09-08T10:12:00.000Z', outcome: 'verified', transitions: {} },
    dep('dep_noat', undefined), dep('dep_badat', 'yesterday'), { deployId: 'dep_notype', at: '2026-09-08T10:11:00.000Z' }, null, 'x', 7,
  ];
  const w = deploysInWindow(log, '2026-09-08T10:00:00.000Z', '2026-09-08T10:15:00.000Z');
  assert(w.map(d => d.deployId).join() === 'dep_a,dep_b,dep_until', 'the window is (since, until]: since excluded, until included, sorted by at then deployId; verify lines, missing / unparseable at and non-objects left out', w.map(d => d.deployId));
  assert(w[0].verify && w[0].verify.outcome === 'verified' && !('type' in w[0].verify) && !('deployId' in w[0].verify) && w[1].verify === undefined,
         'the latest verify of a deploy is merged onto it as `verify` (type and deployId stripped); a deploy without one carries none', w[0].verify);
  assert(!('verify' in log[1]), 'the merge never mutates the input record');
  assert(deploysInWindow(log, null, '2026-09-08T10:15:00.000Z').map(d => d.deployId).join() === 'dep_before,dep_since,dep_a,dep_b,dep_until', 'since null → everything up to until', deploysInWindow(log, null, '2026-09-08T10:15:00.000Z').map(d => d.deployId));
  assert(deploysInWindow(log, '2026-09-08T10:15:00.000Z', null).map(d => d.deployId).join() === 'dep_after', 'until null → everything after since');
  assert(deploysInWindow(log, 'not a date', 'nor this').length === 6, 'unparseable bounds read as no bound (every deploy with a parseable at)', deploysInWindow(log, 'not a date', 'nor this').map(d => d.deployId));
  assert(deploysInWindow(null, null, null).length === 0 && deploysInWindow('x', null, null).length === 0 && deploysInWindow([], null, null).length === 0, 'no log → []');
  const kept = { ...dep('dep_v', '2026-09-08T10:10:00.000Z'), verify: { outcome: 'already' } };
  assert(deploysInWindow([kept, { type: 'verify', deployId: 'dep_v', at: '2026-09-08T10:11:00.000Z', outcome: 'later' }], null, null)[0].verify.outcome === 'already', 'a deploy that already carries a verify keeps it');
}

// --- rankCauses ---
const dn = (kind, label, patch = {}) => ({ key: `${kind}::${label}`, kind, label, status: 'declared_only', ladder: { rung: 'absent', status: null, detail: 'absent from Pack B' }, blastRadius: radius(1), deltaFields: [], ...patch });
const fullProbes = { attempted: ['recording_rules', 'alert_rules', 'dashboards'], succeeded: ['recording_rules', 'alert_rules', 'dashboards'], empty: [], failed: [], unsupported: [] };
const runBase = { outcome: 'pass', packA: { source: 'x', name: 'payment-service', version: '1.5.0' }, probes: fullProbes, probeErrors: {}, vantage: 'full', toolsExposedCount: 12 };
const prevRun = { ...runBase, startedAt: '2026-09-08T10:00:00.000Z', versions: { prometheus: '2.53.0', grafana: '11.1.0' }, branches: [
  { rootKey: 'slo::checkout', title: 'checkout', verdict: 'intact', ladderVerdict: 'healthy', degraded: [] },
  { rootKey: 'slo::payments', title: 'payments', verdict: 'partial', ladderVerdict: 'degraded', degraded: [dn('panel', 'pay-panel')] },
  { rootKey: 'slo::orders', title: 'orders', verdict: 'intact', ladderVerdict: 'healthy', degraded: [] },
] };
const curRun = { ...runBase, startedAt: '2026-09-08T10:15:00.000Z', versions: { prometheus: '2.54.0', grafana: '11.1.0' },
  stackEvidence: { status: 'sampled', reason: null, rows: [
    { id: 'rule_evaluation_failures', family: 'ruler', product: 'prometheus', value: 0.2, unit: 'per-second', direction: 'lower', outcome: 'data', hint: 'nonzero', at: null, referenceSli: null },
    { id: 'notification_errors', family: 'notify', product: 'alertmanager', value: 3, unit: 'per-second', direction: 'lower', outcome: 'data', hint: 'nonzero', at: null, referenceSli: null },
    { id: 'scrape_targets_down', family: 'scrape', product: 'prometheus', value: 0, unit: 'count', direction: 'lower', outcome: 'data', hint: null, at: null, referenceSli: null },
    { id: 'tsdb_compaction_failures', family: 'tsdb', product: 'prometheus', value: null, unit: 'per-hour', direction: 'lower', outcome: 'empty', hint: null, at: null, referenceSli: null },
  ], alertmanager: null, grafana: null },
  branches: [
    { rootKey: 'slo::checkout', title: 'checkout', verdict: 'broken', ladderVerdict: 'broken', degraded: [
      dn('recording_rule', 'checkout:ratio'),
      dn('burn_rate', 'burn-rate alert: checkout', { status: 'drifted', ladder: { rung: 'exists', status: null, detail: 'no liveness field' }, deltaFields: ['objective', 'labels.team'] }),
    ] },
    { rootKey: 'slo::payments', title: 'payments', verdict: 'partial', ladderVerdict: 'degraded', degraded: [dn('panel', 'pay-panel')] },
    { rootKey: 'slo::orders', title: 'orders', verdict: 'intact', ladderVerdict: 'healthy', degraded: [] },
  ] };
const deployLog = [
  { type: 'deploy', deployId: 'dep_in', at: '2026-09-08T10:05:00.000Z', actor: 'carlos', pack: { id: 'payment-service' }, mode: 'upsert', dryRun: false, items: [{ artifact: 'checkout:ratio', group: 'rules', ok: true, tookMs: 3 }], summary: { total: 1, ok: 1, failed: 0 } },
  { type: 'verify', deployId: 'dep_in', at: '2026-09-08T10:06:00.000Z', outcome: 'verified' },
  { type: 'deploy', deployId: 'dep_pack', at: '2026-09-08T10:07:00.000Z', actor: 'ci', pack: { id: 'payment-service' }, mode: 'upsert', items: [{ artifact: 'all', group: 'dashboards', ok: true }] },
  { type: 'deploy', deployId: 'dep_other', at: '2026-09-08T10:08:00.000Z', actor: 'ci', pack: { id: 'other-pack' }, mode: 'upsert', items: [{ artifact: 'unrelated', ok: true }] },
  { type: 'deploy', deployId: 'dep_dry', at: '2026-09-08T10:09:00.000Z', actor: 'ci', pack: { id: 'payment-service' }, mode: 'upsert', dryRun: true, items: [{ artifact: 'checkout:ratio', ok: true }] },
  { type: 'deploy', deployId: 'dep_late', at: '2026-09-08T10:16:00.000Z', actor: 'ci', pack: { id: 'payment-service' }, mode: 'upsert', items: [{ artifact: 'checkout:ratio', ok: true }] },
];
const rc = rankCauses({ previous: prevRun, current: curRun, deploys: deploysInWindow(deployLog, prevRun.startedAt, curRun.startedAt) });
assert(rc && Object.keys(rc).join() === 'transitions,causes,vantage,note' && rc.note === CAUSE_NOTE, 'rankCauses returns transitions, causes, vantage, note', Object.keys(rc || {}));
assert(rc.transitions && rc.transitions.since === prevRun.startedAt && rc.transitions.changed.length === 1 && rc.transitions.changed[0].direction === 'worse', 'transitions is the diff of the two records', rc.transitions);
assert(rc.causes.map(c => `${c.rank}:${c.kind}:${c.score}`).join() === '1:observogram-deploy:0.9,2:config-drift:0.8,3:observogram-deploy:0.6,4:backend-version:0.6,5:stack-self-metric:0.5',
       'causes rank by score desc, then CAUSE_KINDS order on a tie (deploy 0.6 before version 0.6); ranks are 1-based', rc.causes.map(c => `${c.rank}:${c.kind}:${c.score}`));
const c1 = rc.causes[0];
assert(Object.keys(c1).join() === 'rank,kind,score,evidence,chains,rootKeys,nodes', 'a cause carries exactly rank, kind, score, evidence, chains, rootKeys, nodes', Object.keys(c1));
assert(c1.evidence === 'deploy dep_in by carlos at 2026-09-08T10:05:00.000Z (upsert) touched checkout:ratio; verify: verified', 'deploy evidence names deployId, actor, at, mode, the matching artifact and the verify outcome', c1.evidence);
assert(c1.chains.join() === 'checkout' && c1.rootKeys.join() === 'slo::checkout' && c1.nodes.join() === 'checkout:ratio', 'a deploy cause lists the chains it touched by title, their identity keys apart, and the nodes', { chains: c1.chains, rootKeys: c1.rootKeys, nodes: c1.nodes });
assert(rc.causes[1].evidence === 'burn-rate alert: checkout (burn_rate) drifted on objective, labels.team — decision-bearing: objective' && rc.causes[1].chains.join() === 'checkout' && rc.causes[1].nodes.join() === 'burn-rate alert: checkout',
       'a decision-bearing drift scores 0.8 and its evidence lists the fields', rc.causes[1].evidence);
assert(rc.causes[2].evidence === 'deploy dep_pack by ci at 2026-09-08T10:07:00.000Z (upsert) wrote pack payment-service (all dashboards) — no item names a moved artefact' && rc.causes[2].chains.join() === 'checkout' && rc.causes[2].nodes.length === 0,
       'a deploy of the journey\'s pack whose only item is the group wildcard scores 0.6 over every chain that got worse and names the wildcard', rc.causes[2]);
assert(rc.causes[3].evidence === 'prometheus 2.53.0 → 2.54.0' && rc.causes[3].nodes.join() === 'burn-rate alert: checkout,checkout:ratio', 'a version change of the product feeding the moved nodes\' family (prometheus → ruler) scores 0.6 and names them; an unchanged product (grafana) is no cause', rc.causes[3]);
assert(rc.causes[4].evidence === 'rule_evaluation_failures = 0.2 per-second (ruler) — point-in-time sample' && rc.causes[4].nodes.join() === 'burn-rate alert: checkout,checkout:ratio',
       'a non-zero stack row in the family feeding the moved kinds scores 0.5, phrased as a sample', rc.causes[4].evidence);
assert(!rc.causes.some(c => /notification_errors|scrape_targets_down|tsdb_compaction/.test(c.evidence)), 'a non-zero row in an unrelated family (notify, no alert_route moved), a zero row and an empty row are no cause');
assert(!rc.causes.some(c => /dep_other|dep_dry|dep_late/.test(c.evidence)), 'a deploy of another pack naming nothing, a dry run and a deploy outside the window are no cause');
assert(rc.vantage && rc.vantage.changed === false && rc.vantage.detail === null && rc.vantage.from.vantage === 'full' && rc.vantage.to.toolsExposedCount === 12, 'an unchanged vantage reads changed: false with no detail', rc.vantage);
assert(JSON.stringify(rankCauses({ previous: prevRun, current: curRun, deploys: deploysInWindow(deployLog, prevRun.startedAt, curRun.startedAt) })) === JSON.stringify(rc), 'rankCauses is deterministic');
assert(JSON.stringify(rankCauses({ previous: prevRun, current: curRun, deploys: deploysInWindow(deployLog.slice().reverse(), prevRun.startedAt, curRun.startedAt) })) === JSON.stringify(rc), 'the deploy log order does not change the ranking');
{
  // Ties inside a kind break on evidence; the same evidence explaining two chains is one cause.
  const cur2 = { ...curRun, branches: [...curRun.branches, { rootKey: 'slo::second', title: 'second', verdict: 'broken', ladderVerdict: 'broken', degraded: [dn('recording_rule', 'checkout:ratio')] }] };
  const two = rankCauses({ previous: { ...prevRun, branches: [...prevRun.branches, { rootKey: 'slo::second', title: 'second', verdict: 'intact', ladderVerdict: 'healthy', degraded: [] }] }, current: cur2, deploys: [
    { type: 'deploy', deployId: 'dep_z', at: '2026-09-08T10:05:00.000Z', actor: 'zed', pack: { id: 'x' }, mode: 'upsert', items: [{ artifact: 'checkout:ratio', ok: true }] },
    { type: 'deploy', deployId: 'dep_a', at: '2026-09-08T10:05:00.000Z', actor: 'amy', pack: { id: 'x' }, mode: 'upsert', items: [{ artifact: 'checkout:ratio', ok: false, error: 'boom' }] },
  ] });
  assert(two.causes[0].evidence.startsWith('deploy dep_a by amy') && two.causes[0].evidence.includes('touched checkout:ratio (failed)') && two.causes[1].evidence.startsWith('deploy dep_z by zed'),
         'two deploys at the same score order by evidence; a failed item is marked', two.causes.map(c => c.evidence));
  assert(two.causes[0].chains.join() === 'checkout,second' && two.causes[0].rootKeys.join() === 'slo::checkout,slo::second' && two.causes[0].nodes.join() === 'checkout:ratio', 'one evidence explaining two chains is one cause listing both, in record order', two.causes[0].chains);
  // Rollbacks are named; an artefact id matches exactly (and the evidence says what it resolved to); 'all' and a name that is not a label match nothing.
  const rb = rankCauses({ previous: prevRun, current: { ...curRun, branches: [{ ...curRun.branches[0], degraded: [dn('recording_rule', 'checkout:ratio', { aId: 'rr-123' })] }, ...curRun.branches.slice(1)] }, deploys: [
    { type: 'deploy', deployId: 'dep_rb', at: '2026-09-08T10:05:00.000Z', actor: 'carlos', pack: { id: 'x' }, mode: 'rollback', rollbackOf: 'dep_in', items: [{ artifact: 'rr-123', ok: true }, { artifact: 'all', ok: true }, { artifact: 'ch', ok: true }] },
  ] });
  const deployCauses = (r) => r.causes.filter(c => c.kind === 'observogram-deploy');
  assert(deployCauses(rb).length === 1 && rb.causes[0].evidence === 'deploy dep_rb by carlos at 2026-09-08T10:05:00.000Z (rollback, rollback of dep_in) touched rr-123 → checkout:ratio', 'a rollback is named as such; aId matches exactly and the evidence names the node; all and a bare prefix of a label match nothing', rb.causes.map(c => c.evidence));
  // A deploy naming an artefact whose label embeds the SLI's name does not blame the SLI (matching is exact, never by substring).
  const oneWay = rankCauses({ previous: prevRun, current: { ...curRun, branches: [{ ...curRun.branches[0], degraded: [dn('recording_rule', 'payment:api_availability:ratio_5m'), dn('sli', 'api_availability')] }, ...curRun.branches.slice(1)] }, deploys: [
    { type: 'deploy', deployId: 'dep_rule', at: '2026-09-08T10:05:00.000Z', actor: 'ci', pack: { id: 'x' }, mode: 'upsert', items: [{ artifact: 'payment:api_availability:ratio_5m', ok: true }] },
  ] });
  assert(deployCauses(oneWay).length === 1 && oneWay.causes[0].kind === 'observogram-deploy' && oneWay.causes[0].nodes.join() === 'payment:api_availability:ratio_5m', 'exact matching: the rule deploy names the rule, not the SLI whose name it embeds', oneWay.causes[0]?.nodes);
  // The server's real selector strings, resolved against Pack A by the caller (`resolved`) or pack-free by the ranker; group ↔ kind compatibility; never a substring.
  {
    const jn = (kind, label, identity, patch = {}) => dn(kind, label, { key: `${kind}::${JSON.stringify(identity)}`, ...patch });
    const wire = [
      jn('recording_rule', 'payment:api_availability:ratio_5m', { record: 'payment:api_availability:ratio_5m' }),
      jn('sli', 'api_availability', { id: 'api_availability' }),
      jn('scrape_job', 'payment', { job: 'payment' }),
      jn('slo', 'checkout', { id: 'checkout' }),
      jn('metric', 'http_requests_total', { name: 'http_requests_total' }),
      jn('dashboard', 'payment', { id: 'payment' }),
      jn('burn_rate', 'burn-rate alert: checkout', { slo: 'checkout' }),
      jn('dashboard', 'api', { id: 'api' }),
    ];
    const wireCur = { ...curRun, versions: null, stackEvidence: null, branches: [{ rootKey: 'slo::{"id":"checkout"}', title: 'checkout', verdict: 'broken', ladderVerdict: 'broken', degraded: wire }, ...curRun.branches.slice(1)] };
    const wirePrev = { ...prevRun, versions: null, branches: [{ rootKey: 'slo::{"id":"checkout"}', title: 'checkout', verdict: 'intact', ladderVerdict: 'healthy', degraded: [] }, ...prevRun.branches.slice(1)] };
    const sel = (deployId, items, patch = {}) => ({ type: 'deploy', deployId, at: '2026-09-08T10:05:00.000Z', actor: 'ci', pack: { id: 'payment-service' }, mode: 'upsert', items, ...patch });
    const rank = (items, patch) => deployCauses(rankCauses({ previous: wirePrev, current: wireCur, deploys: [sel('dep_sel', items, patch)] }));
    const declared = rank([{ artifact: 'declared:0', group: 'rules', ok: true, resolved: ['payment:api_availability:ratio_5m'] }]);
    assert(declared.length === 1 && declared[0].score === 0.9 && declared[0].nodes.join() === 'payment:api_availability:ratio_5m' && declared[0].evidence.endsWith('touched declared:0 → payment:api_availability:ratio_5m'),
           'declared:<i> resolved by the caller to the rule name scores 0.9 on that rule and the evidence names both', declared);
    const unresolved = rank([{ artifact: 'declared:0', group: 'rules', ok: true }]);
    assert(unresolved.length === 1 && unresolved[0].score === 0.6 && /wrote pack payment-service — no item names a moved artefact/.test(unresolved[0].evidence), 'declared:<i> without a pack to resolve it names nothing — the pack-level 0.6, never a substring guess', unresolved);
    const slo = rank([{ artifact: 'slo:checkout', group: 'rules', ok: true }]);
    assert(slo.length === 1 && slo[0].score === 0.9 && slo[0].nodes.join() === 'burn-rate alert: checkout,checkout' && slo[0].evidence.endsWith('touched slo:checkout → burn-rate alert: checkout, checkout'),
           'slo:<id> resolves pack-free to the SLO id: it names the SLO (label) and its burn-rate alert (identity slo), never the scrape job or the SLI of another name', slo);
    const sloResolved = rank([{ artifact: 'slo:checkout', group: 'rules', ok: true, resolved: ['checkout', 'api_availability'] }]);
    assert(sloResolved[0].nodes.join() === 'api_availability,burn-rate alert: checkout,checkout', 'a caller-resolved SLI id reaches the SLI node too', sloResolved[0]?.nodes);
    const all = rank([{ artifact: 'all', group: 'rules', ok: true }]);
    assert(all.length === 1 && all[0].score === 0.6 && all[0].nodes.length === 0 && /wrote pack payment-service \(all rules\) — no item names a moved artefact/.test(all[0].evidence), 'the group wildcard all names nothing by itself: a pack-level touch at 0.6 naming the wildcard', all);
    const rollback = rank([{ artifact: 'payment', group: 'restore', ok: true }], { mode: 'rollback', rollbackOf: 'dep_x' });
    assert(rollback.length === 1 && rollback[0].nodes.join() === 'payment' && rollback[0].evidence.includes('(rollback, rollback of dep_x) touched payment') && !rollback[0].evidence.includes('→'),
           'a rollback ref (bare dashboard uid, group restore) blames the dashboard payment and not the scrape job payment', rollback);
    const dash = rank([{ artifact: 'dash:payment', group: 'dashboards', ok: true }]);
    assert(dash.length === 1 && dash[0].nodes.join() === 'payment' && dash[0].evidence.endsWith('touched dash:payment → payment'), 'dash:payment blames the dashboard payment only — not scrape_job payment, not the rule embedding payment', dash);
    const short = rank([{ artifact: 'dash:api', group: 'dashboards', ok: true }]);
    assert(short.length === 1 && short[0].nodes.join() === 'api', 'a three-letter dashboard id blames exactly the dashboard of that id and nothing that contains it', short);
    const nothing = rank([{ artifact: 'dash:pay', group: 'dashboards', ok: true }, { artifact: 'ratio_5m', group: 'rules', ok: true }, { artifact: 'sli', group: 'rules', ok: true }, { artifact: 'payment', group: 'dashboards', ok: true, resolved: ['pay'] }]);
    assert(nothing.length === 1 && nothing[0].score === 0.6, 'prefixes, suffixes and short words that are not a label match nothing (pack-level 0.6 only)', nothing);
    const wrongGroup = rank([{ artifact: 'payment:api_availability:ratio_5m', group: 'dashboards', ok: true }, { artifact: 'checkout', group: 'alertmanager', ok: true }]);
    assert(wrongGroup.length === 1 && wrongGroup[0].score === 0.6, 'a group that cannot write the node kind never matches (rules under dashboards, an SLO under alertmanager)', wrongGroup);
    const noGroup = rank([{ artifact: 'payment', ok: true }]);
    assert(noGroup.length === 1 && noGroup[0].nodes.join() === 'payment' && noGroup[0].evidence.endsWith('touched payment'), 'an item without a group is constrained by nothing but the exact name (the scrape job and the dashboard both called payment)', noGroup[0]);
    assert(DEPLOY_GROUP_KINDS.dashboards.join() === 'dashboard,panel' && DEPLOY_GROUP_KINDS.restore.join() === 'dashboard,panel' && DEPLOY_GROUP_KINDS.delete.join() === 'dashboard,panel'
           && DEPLOY_GROUP_KINDS.rules.join() === 'recording_rule,burn_rate,sli,slo' && DEPLOY_GROUP_KINDS.alerts.join() === 'burn_rate,alert_route' && DEPLOY_GROUP_KINDS.alertmanager.join() === 'alert_route'
           && DEPLOY_GROUP_KINDS.pipelines.includes('pipeline_receiver') && DEPLOY_GROUP_KINDS.pipelines.includes('otel'),
           'DEPLOY_GROUP_KINDS maps the server\'s deploy groups and rollback actions to the node kinds they can write', DEPLOY_GROUP_KINDS);
    assert(deployArtifactNames({ artifact: 'dash:x' }).join() === 'x' && deployArtifactNames({ artifact: 'slo:settlement_latency_99' }).join() === 'settlement_latency_99,settlement_latency'
           && deployArtifactNames({ artifact: 'declared:2' }).length === 0 && deployArtifactNames({ artifact: 'all' }).length === 0 && deployArtifactNames({ artifact: ' bare ' }).join() === 'bare'
           && deployArtifactNames({ artifact: 'declared:2', resolved: ['r', 'r', ''] }).join() === 'r' && deployArtifactNames(null).length === 0,
           'deployArtifactNames: caller resolution wins, else the pack-free part of the selector (dash id, SLO id + SLI base, bare name; declared and all → nothing)');
    // branchRecordsFromGraph output satisfies the id match: a deploy naming the artefact id of a recorded node touches it.
    const fromGraph = branchRecordsFromGraph({ branches: [branch('slo::g', { verdict: 'broken', ladderVerdict: 'broken', nodes: [node('drifted', 'recording_rule', 'checkout:ratio', { aId: 'QRY-04', deltas: [{ field: 'expr' }] })] })] });
    const byId = deployCauses(rankCauses({ previous: { ...prevRun, branches: [{ rootKey: 'slo::g', title: 'g', verdict: 'intact', ladderVerdict: 'healthy', degraded: [] }] }, current: { ...curRun, branches: fromGraph }, deploys: [sel('dep_id', [{ artifact: 'QRY-04', group: 'rules', ok: true }])] }));
    assert(byId.length === 1 && byId[0].score === 0.9 && byId[0].nodes.join() === 'checkout:ratio' && byId[0].evidence.endsWith('touched QRY-04 → checkout:ratio'), 'a persisted degraded node carries the artefact id the id match needs', byId);
  }
  // Cosmetic drift 0.4; version 0.3 when the changed product feeds no moved node's family; a ratio row below 1 is a signal.
  const cosmetic = rankCauses({ previous: { ...prevRun, versions: { ...prevRun.versions, alertmanager: '0.26.0' } }, current: { ...curRun, versions: { prometheus: '2.53.0', grafana: '11.1.0', alertmanager: '0.27.0' }, stackEvidence: { status: 'sampled', rows: [
      { id: 'scrape_success_ratio', family: 'scrape', value: 0.75, unit: 'ratio', direction: 'higher', outcome: 'data', hint: null }] },
    branches: [{ ...curRun.branches[0], degraded: [dn('panel', 'checkout-panel', { status: 'drifted', deltaFields: ['title', 'gridPos'] }), dn('scrape_job', 'checkout-scrape')] }, ...curRun.branches.slice(1)] } });
  assert(cosmetic.causes.map(c => `${c.kind}:${c.score}`).join() === 'stack-self-metric:0.5,config-drift:0.4,backend-version:0.3', 'a cosmetic-only drift scores 0.4, a version change of a product feeding no moved kind (alertmanager → notify; a panel and a scrape job moved) 0.3 with no node named, a ratio row below 1 is a scrape signal', cosmetic.causes.map(c => `${c.kind}:${c.score}:${c.evidence}`));
  assert(cosmetic.causes[1].evidence === 'checkout-panel (panel) drifted on title, gridPos — cosmetic only' && cosmetic.causes[2].evidence === 'alertmanager 0.26.0 → 0.27.0' && cosmetic.causes[2].nodes.length === 0 && cosmetic.causes[2].chains.join() === 'checkout' && cosmetic.causes[0].evidence === 'scrape_success_ratio = 0.75 ratio (scrape) — point-in-time sample',
         'evidence wording for cosmetic drift, an unrelated product version and a ratio sample', cosmetic.causes.map(c => c.evidence));
  assert(rankCauses({ previous: prevRun, current: { ...curRun, branches: [{ ...curRun.branches[0], degraded: [dn('panel', 'checkout-panel', { status: 'drifted', deltaFields: [] })] }] } }).causes[0].evidence === 'checkout-panel (panel) drifted on fields not recorded — cosmetic only',
         'a drifted node without recorded fields reads cosmetic (0.4), never decision-bearing');
  // Product → family: a Grafana-only change is not 0.6 on a Prometheus rule; a Prometheus change is 0.6 on a scrape job; a flip to / from the literal `live` is a vantage matter, never a cause.
  {
    const grafanaOnly = rankCauses({ previous: prevRun, current: { ...curRun, versions: { prometheus: '2.53.0', grafana: '11.2.0' }, stackEvidence: null } });
    const gv = grafanaOnly.causes.filter(c => c.kind === 'backend-version');
    assert(gv.length === 1 && gv[0].score === 0.3 && gv[0].evidence === 'grafana 11.1.0 → 11.2.0' && gv[0].nodes.length === 0, 'a Grafana-only version change scores 0.3 when only rule nodes moved (grafana feeds dashboards, not the ruler)', gv);
    const scrapeMoved = rankCauses({ previous: prevRun, current: { ...curRun, stackEvidence: null, branches: [{ ...curRun.branches[0], degraded: [dn('scrape_job', 'checkout-scrape')] }, ...curRun.branches.slice(1)] } });
    const pv = scrapeMoved.causes.filter(c => c.kind === 'backend-version');
    assert(pv.length === 1 && pv[0].score === 0.6 && pv[0].nodes.join() === 'checkout-scrape', 'a Prometheus version change scores 0.6 on a moved scrape job (prometheus feeds scrape)', pv);
    const unknownProduct = rankCauses({ previous: { ...prevRun, versions: { thing: '1' } }, current: { ...curRun, versions: { thing: '2' }, stackEvidence: null } });
    assert(unknownProduct.causes.filter(c => c.kind === 'backend-version').map(c => c.score).join() === '0.3', 'an unknown product feeds no family: 0.3');
    const toLive = rankCauses({ previous: prevRun, current: { ...curRun, versions: { prometheus: 'live', grafana: '11.1.0' }, stackEvidence: null } });
    assert(!toLive.causes.some(c => c.kind === 'backend-version') && toLive.vantage.changed === true && toLive.vantage.detail === 'mcp.versions.prometheus changed to live',
           'a version that flips to the literal live is no cause; the vantage block reports it', { causes: toLive.causes.map(c => c.kind), vantage: toLive.vantage });
    const fromLive = rankCauses({ previous: { ...prevRun, versions: { prometheus: 'live', grafana: 'live' } }, current: { ...curRun, versions: { prometheus: '2.54.0', grafana: '11.1.0' }, stackEvidence: null } });
    assert(!fromLive.causes.some(c => c.kind === 'backend-version') && fromLive.vantage.detail === 'mcp.versions.grafana changed from live · mcp.versions.prometheus changed from live',
           'a version that flips from live is no cause either (the product did not move; the vantage learned to read it), listed per product', fromLive.vantage);
    const liveBoth = rankCauses({ previous: { ...prevRun, versions: { prometheus: 'live' } }, current: { ...curRun, versions: { prometheus: 'live' }, stackEvidence: null } });
    assert(!liveBoth.causes.some(c => c.kind === 'backend-version') && liveBoth.vantage.changed === false, 'live on both sides is neither a cause nor a vantage change');
    const withProbes = rankCauses({ previous: prevRun, current: { ...curRun, versions: { prometheus: 'live', grafana: '11.1.0' }, toolsExposedCount: 9, stackEvidence: null } });
    assert(withProbes.vantage.detail === '12 → 9 MCP tools exposed · mcp.versions.prometheus changed to live', 'a live flip joins the probe facts in the vantage detail', withProbes.vantage.detail);
  }
  // The stored display hint is never consulted: a zero sample with a stale `nonzero` hint is no signal; a non-zero sample without a hint is.
  {
    const staleHint = rankCauses({ previous: prevRun, current: { ...curRun, versions: null, stackEvidence: { status: 'sampled', rows: [
      { id: 'rule_evaluation_failures', family: 'ruler', value: 0, unit: 'per-second', direction: 'lower', outcome: 'data', hint: 'nonzero' },
      { id: 'tsdb_compaction_failures', family: 'tsdb', value: 0, unit: 'per-hour', direction: 'lower', outcome: 'data', hint: 'nonzero' }] } } });
    assert(!staleHint.causes.some(c => c.kind === 'stack-self-metric'), 'a zero sample with a stale nonzero hint is not a signal — direction and value decide', staleHint.causes.map(c => c.evidence));
    const noHint = rankCauses({ previous: prevRun, current: { ...curRun, versions: null, stackEvidence: { status: 'sampled', rows: [{ id: 'rule_evaluation_failures', family: 'ruler', value: 1, unit: 'per-second', direction: 'lower', outcome: 'data', hint: null }] } } });
    assert(noHint.causes.some(c => c.kind === 'stack-self-metric' && c.evidence === 'rule_evaluation_failures = 1 per-second (ruler) — point-in-time sample'), 'a non-zero lower-is-comfortable sample is a signal with or without a hint');
  }
  // A node already degraded and unchanged in a chain that got worse is never blamed: neither when another node moved, nor when nothing recorded moved (the change is on the declared side — the transition entry says so).
  const stayed = { ...prevRun, branches: [{ rootKey: 'slo::checkout', title: 'checkout', verdict: 'partial', ladderVerdict: 'degraded', missingRoles: [], degraded: [dn('metric', 'old_metric')] }] };
  const movedOne = { ...curRun, branches: [{ rootKey: 'slo::checkout', title: 'checkout', verdict: 'broken', ladderVerdict: 'broken', degraded: [dn('metric', 'old_metric'), dn('recording_rule', 'checkout:ratio')] }] };
  const touchOld = [{ type: 'deploy', deployId: 'dep_old', at: '2026-09-08T10:05:00.000Z', actor: 'ci', pack: { id: 'x' }, mode: 'upsert', items: [{ artifact: 'old_metric', ok: true }] }];
  assert(deployCauses(rankCauses({ previous: stayed, current: movedOne, deploys: touchOld })).length === 0, 'a deploy naming a node that did not move is no cause when the record says which node moved');
  const sameNodes = { ...curRun, branches: [{ rootKey: 'slo::checkout', title: 'checkout', verdict: 'broken', ladderVerdict: 'broken', missingRoles: ['action'], degraded: [dn('metric', 'old_metric')] }] };
  const sameRanked = rankCauses({ previous: stayed, current: sameNodes, deploys: touchOld });
  assert(sameRanked.causes.length === 0 && sameRanked.transitions.changed[0].direction === 'worse' && sameRanked.transitions.changed[0].note === 'declared side: missingRoles none → action',
         'when the chain got worse but no recorded node moved, nothing is blamed — the transition entry notes the declared side (a role went missing)', { causes: sameRanked.causes, note: sameRanked.transitions.changed[0]?.note });
  const cut = { ...curRun, branches: [{ rootKey: 'slo::checkout', title: 'checkout', verdict: 'broken', ladderVerdict: 'broken', missingRoles: [], degraded: [dn('metric', 'old_metric')], truncated: true }] };
  const cutRanked = rankCauses({ previous: stayed, current: cut, deploys: touchOld });
  assert(cutRanked.causes.length === 0 && cutRanked.transitions.changed[0].note === 'degraded list truncated (cap 16) — a node that moved may be unrecorded',
         'a chain that got worse with an identical degraded list cut at the cap blames nobody and says the moved node may be unrecorded', cutRanked.transitions.changed[0]?.note);
  const ladderMoved = { ...curRun, branches: [{ rootKey: 'slo::checkout', title: 'checkout', verdict: 'partial', ladderVerdict: 'broken', degraded: [dn('metric', 'old_metric', { ladder: { rung: 'exists', status: 'present_unhealthy', detail: 'down' } }), dn('recording_rule', 'checkout:ratio')] }] };
  assert(deployCauses(rankCauses({ previous: stayed, current: ladderMoved, deploys: touchOld }))[0]?.nodes.join() === 'old_metric', 'a node whose ladder status changed counts as moved');
  // A chain that appeared already broken is considered with every degraded node.
  const appeared = rankCauses({ previous: prevRun, current: { ...curRun, branches: [...prevRun.branches, { rootKey: 'slo::new', title: 'new', verdict: 'broken', ladderVerdict: 'broken', degraded: [dn('recording_rule', 'new:ratio')] }] }, deploys: [
    { type: 'deploy', deployId: 'dep_new', at: '2026-09-08T10:05:00.000Z', actor: 'ci', pack: { id: 'x' }, mode: 'upsert', items: [{ artifact: 'new:ratio', ok: true }] }] });
  assert(appeared.causes.map(c => `${c.kind}:${c.chains}`).join() === 'observogram-deploy:new,backend-version:new,stack-self-metric:new',
         'a chain that appeared broken contributes its degraded nodes (the deploy, the version change and the ruler sample on its rule)', appeared.causes.map(c => `${c.kind}:${c.chains}`));
  // A baseline apart from the previous record: the chain diff, versions and deploys read against the baseline, the vantage against the previous record.
  {
    const lostBetween = { startedAt: '2026-09-08T10:10:00.000Z', outcome: 'vantage-lost', error: 'ECONNREFUSED', packA: prevRun.packA };
    const viaBaseline = rankCauses({ previous: lostBetween, baseline: prevRun, current: curRun, deploys: deploysInWindow(deployLog, prevRun.startedAt, curRun.startedAt) });
    assert(viaBaseline.transitions && viaBaseline.transitions.since === prevRun.startedAt && viaBaseline.transitions.changed[0].direction === 'worse', 'with a baseline the chain diff is against the baseline (since = baseline start)', viaBaseline.transitions);
    assert(viaBaseline.causes.map(c => `${c.kind}:${c.score}`).join() === rc.causes.map(c => `${c.kind}:${c.score}`).join(), 'the causes read exactly as they would against the baseline directly', viaBaseline.causes.map(c => `${c.kind}:${c.score}`));
    assert(viaBaseline.vantage.changed === true && viaBaseline.vantage.detail === 'vantage lost → full' && viaBaseline.vantage.from.vantage === 'lost', 'the vantage is compared against the previous record: lost → full', viaBaseline.vantage);
    assert(JSON.stringify(rankCauses({ previous: prevRun, baseline: 'x', current: curRun, deploys: deploysInWindow(deployLog, prevRun.startedAt, curRun.startedAt) })) === JSON.stringify(rc), 'a non-object baseline reads as none (previous is the baseline)');
  }
  assert(rankCauses({ previous: prevRun, current: { ...curRun, branches: [...prevRun.branches, { rootKey: 'slo::new', title: 'new', verdict: 'intact', ladderVerdict: 'healthy', degraded: [] }] } }).causes.length === 0, 'a chain that appeared healthy contributes nothing');
}
{
  // Unobserved nodes never generate a cause — that movement is the vantage's, reported separately.
  const lookedAway = { ...curRun, probes: { attempted: ['recording_rules', 'alert_rules', 'dashboards'], succeeded: ['alert_rules'], empty: [], failed: ['recording_rules'], unsupported: ['dashboards'] },
    probeErrors: { recording_rules: 'HTTP 502' }, vantage: 'partial', toolsExposedCount: 9,
    branches: [{ rootKey: 'slo::checkout', title: 'checkout', verdict: 'intact', ladderVerdict: 'unobserved', degraded: [dn('recording_rule', 'checkout:ratio', { ladder: { rung: 'unobserved', status: 'unobserved', detail: 'probe family recording_rules failed (HTTP 502)' } })] }, ...curRun.branches.slice(1)] };
  const v = rankCauses({ previous: prevRun, current: lookedAway, deploys: deploysInWindow(deployLog, prevRun.startedAt, curRun.startedAt) });
  assert(v.transitions.changed[0].direction === 'worse' && v.causes.length === 0, 'a chain that got worse only because the vantage looked away yields no cause — not the deploy in the window, not the version change', v.causes);
  assert(v.vantage && Object.keys(v.vantage).join() === 'changed,from,to,detail' && v.vantage.changed === true, 'the vantage block reads changed', v.vantage);
  assert(v.vantage.detail === 'vantage full → partial · probe family dashboards no longer exposed · probe family recording_rules newly failed (HTTP 502) · 12 → 9 MCP tools exposed',
         'the vantage detail names the vantage word, each probe family that moved (with its error) and the tool count', v.vantage.detail);
  assert(v.vantage.from.vantage === 'full' && v.vantage.from.failed.length === 0 && v.vantage.to.failed.join() === 'recording_rules' && v.vantage.to.unsupported.join() === 'dashboards' && v.vantage.to.toolsExposedCount === 9,
         'from / to are the probe snapshots', v.vantage);
  const back = rankCauses({ previous: lookedAway, current: { ...curRun, branches: prevRun.branches } });
  assert(back.causes.length === 0 && back.vantage.detail === 'vantage partial → full · probe family dashboards now exposed · probe family recording_rules answers again · 9 → 12 MCP tools exposed',
         'the way back reads answers again / now exposed; a better transition has no cause', back.vantage.detail);
  // A previous run that lost its vantage: no chains to diff, causes [], vantage lost → full.
  const lost = rankCauses({ previous: { startedAt: '2026-09-08T09:45:00.000Z', outcome: 'vantage-lost', error: 'ECONNREFUSED' }, current: curRun, deploys: deploysInWindow(deployLog, null, curRun.startedAt) });
  assert(lost.transitions === null && lost.causes.length === 0 && lost.vantage.changed === true && lost.vantage.detail === 'vantage lost → full' && lost.vantage.from.vantage === 'lost',
         'after a vantage loss there is nothing to diff: no cause, vantage lost → full (no per-family noise)', lost);
  // File-sourced on both sides: no probe facts → vantage null.
  const fileRun = (r) => ({ ...r, probes: { attempted: [], succeeded: [], empty: [], failed: [], unsupported: [] }, vantage: 'none', toolsExposedCount: null });
  const files = rankCauses({ previous: fileRun(prevRun), current: fileRun(curRun) });
  assert(files.vantage === null && files.causes.map(c => c.kind).join() === 'config-drift,backend-version,stack-self-metric', 'two file-sourced records carry no vantage block (null) while causes still rank (no deploys passed → drift, version, sample)', { v: files.vantage, kinds: files.causes.map(c => c.kind) });
  assert(rankCauses({ previous: fileRun(prevRun), current: curRun }).vantage.detail === 'vantage none → full', 'a file-sourced previous and a live current read vantage none → full');
}
// No worse transition → no cause, whatever the deploys and versions say.
assert(rankCauses({ previous: curRun, current: curRun, deploys: deploysInWindow(deployLog, null, null) }).causes.length === 0, 'an identical record has no cause');
assert(rankCauses({ previous: curRun, current: prevRun, deploys: deploysInWindow(deployLog, null, null) }).causes.length === 0, 'a better transition has no cause');
assert(rankCauses({ previous: null, current: curRun, deploys: deploysInWindow(deployLog, null, null) }).causes.length === 0 && rankCauses({ previous: null, current: curRun }).transitions === null, 'no previous record → no transitions, no cause');
{
  // Malformed input never throws.
  let threw = null;
  let out = null;
  try {
    rankCauses();
    rankCauses({});
    rankCauses({ previous: 'x', current: 3, deploys: 'nope' });
    out = rankCauses({
      previous: { branches: [{ rootKey: 'k', verdict: 'intact', ladderVerdict: 'healthy', degraded: 'x' }], versions: 'v', probes: 'p', stackEvidence: 4 },
      current: { branches: [{ rootKey: 'k', verdict: 'broken', ladderVerdict: 'broken', degraded: [null, 4, { label: 3, kind: 7, status: 'drifted', deltaFields: 'objective', ladder: 'x' }, { key: 'metric::m', kind: 'metric' }] }], versions: { prometheus: 5 }, probes: { attempted: 'x', failed: [3] }, probeErrors: 'e', stackEvidence: { rows: [null, { id: 1, family: 2, value: 'x', outcome: 'data' }, { id: 'r', family: 'ruler', value: 1, outcome: 'data', direction: 'lower' }] }, toolsExposedCount: '9' },
      deploys: [null, 5, 'x', { items: 'x' }, { type: 'deploy', at: 7, items: [null, { artifact: 9 }, { artifact: 'metric::m' }] }, { type: 'deploy', deployId: 3, actor: null, items: [{ artifact: 'm' }], pack: 'p', verify: 'v' }],
    });
    topCause(null); topCause('x'); topCause({ causes: 'x' }); topCause({ causes: { causes: 'x' } }); topCause({ causes: { causes: [null, 3] } });
  } catch (e) { threw = e; }
  assert(threw === null, 'malformed records, nodes, deploys, versions and stack rows never throw', threw && threw.message);
  assert(out && out.causes.length >= 1 && out.causes.every(c => typeof c.evidence === 'string' && Array.isArray(c.chains) && Array.isArray(c.nodes)), 'malformed input still ranks what it can', out && out.causes);
}
// --- topCause ---
assert(topCause({ causes: rc }) === rc.causes[0] && topCause(rc) === rc.causes[0], 'topCause reads the rank-1 cause from a run record (its causes block) or from a rankCauses result');
assert(topCause({ causes: null }) === null && topCause({}) === null && topCause({ causes: { causes: [] } }) === null && topCause({ causes: { causes: [{ kind: 'bogus', evidence: 'x' }] } }) === null,
       'topCause is null without causes, with an empty list and for an unknown kind');

report('chain-history', 'all chain-history assertions pass.');
