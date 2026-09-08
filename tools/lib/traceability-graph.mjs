// tools/lib/traceability-graph.mjs
//
// Requirement-rooted graph comparison for repo-vs-live diagnostics.
//
// The flat diff asks whether two bags of artefacts overlap. This module asks
// whether each reliability commitment has an intact derivation chain:
// SLO/SLI -> telemetry -> insight -> action, with branch-local comparison and
// explicit live-verifiability so "the live connector cannot see this" does not
// masquerade as "missing in production".

import {
  behaviorOf,
  classify,
  deltasOf,
  identityKeyOf,
} from './artefact-model.mjs';
import { extractPromqlMetricNames, parsePromqlDependencies } from './promql-lezer.mjs';
import { blastRadiusIndex } from './blast-radius.mjs';

const LAYER_ORDER = ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV'];

const ALWAYS_LIVE_VERIFIABLE = new Set([
  'sli',
  'slo',
  'recording_rule',
  'metric',
  'scrape_job',
  'backend',
  'burn_rate',
]);

const PARTIAL_LIVE_VERIFIABLE = new Set([
  'alert_route',
  'remediation',
  'forecast',
  'panel',
  'dashboard',
  'chaos',
  'synthetic',
]);

const LIMB_WEIGHTS = {
  slo: 3,
  sli: 3,
  recording_rule: 2,
  metric: 2,
  scrape_job: 1,
  burn_rate: 2,
  backend: 0.5,
  alert_route: 1,
  remediation: 1,
  forecast: 0.75,
  panel: 0.35,
  dashboard: 0.35,
  chaos: 1,
  synthetic: 1,
  pipeline_receiver: 0.5,
  pipeline_processor: 0.5,
  pipeline_exporter_metrics: 0.5,
  storage_metrics: 0.5,
  otel: 0.5,
};

const MISSING_ROLE_WEIGHTS = {
  sli: LIMB_WEIGHTS.sli,
  detection: LIMB_WEIGHTS.recording_rule,
  action: LIMB_WEIGHTS.burn_rate,
};

const DECISION_BEARING_DELTA_RE = /(objective|target|threshold|window|duration|severity|burn|budget|expr|query|promql|expression|condition|sli|slo|metric|record|route|receiver|channel|contact|notification|pager|trigger|pipeline|exporter|backend|signal|good|total|mttd|mttr)/i;
const COSMETIC_DELTA_RE = /(title|label|labels|legend|display|layout|grid|position|folder|tag|tags|description|desc|summary|annotation|annotations|unit|color|schema|uid|source|provider)/i;

export function buildDependencyGraph(adaptedPack = {}) {
  const artefacts = flattenLayerArtefacts(adaptedPack);
  const graph = {
    nodes: new Map(),
    edges: [],
    byIdentity: new Map(),
    byDefines: new Map(),
    byKind: new Map(),
    // Identity keys shared by >1 artefact — same fail-loud surface as
    // diffPacks().collisions; the nodes themselves survive via `#NN` keys.
    collisions: [],
    meta: adaptedPack.meta || {},
  };

  const grouped = new Map();
  for (const { artefact, layer } of artefacts) {
    const identityKey = identityKeyOf(artefact);
    if (!identityKey) continue;
    if (!grouped.has(identityKey)) grouped.set(identityKey, []);
    grouped.get(identityKey).push({ artefact, layer });
  }

  for (const [identityKey, group] of grouped) {
    const suffix = group.length > 1;
    if (suffix) {
      graph.collisions.push({
        key: identityKey,
        kind: classify(group[0].artefact),
        count: group.length,
      });
    }
    group.forEach(({ artefact, layer }, index) => {
      addNode(graph, {
        key: occurrenceKey(identityKey, index, suffix),
        identityKey,
        kind: classify(artefact),
        layer,
        behavior: behaviorOf(artefact),
        artefact,
        virtual: false,
      });
    });
  }

  graph.collisions.sort((x, y) => x.key.localeCompare(y.key));

  resolveContractEdges(graph);
  resolveRecordingRuleEdges(graph);
  resolveMetricSourceEdges(graph);
  resolveMetricExporterEdges(graph);
  resolveMetricBackendEdges(graph);
  resolvePolicyEdges(graph);
  resolveDashboardEdges(graph);
  resolveResponseEdges(graph);
  resolveValidationEdges(graph);

  return graph;
}

export function requirementRoots(graph) {
  const sloRoots = [...(graph.byKind.get('slo') || [])].sort(compareNodeKeys(graph));
  const sliRoots = [...(graph.byKind.get('sli') || [])]
    .filter((sliKey) => !hasIncomingEdge(graph, sliKey, 'sli_of'))
    .sort(compareNodeKeys(graph));
  return [...sloRoots, ...sliRoots];
}

export function buildBranch(graph, rootKey) {
  const root = graph.nodes.get(rootKey);
  if (!root) return null;

  const nodeKeys = new Set([rootKey]);
  const edgeKeys = new Set();

  const includeEdge = (edge) => {
    if (!edge) return;
    edgeKeys.add(edge.key);
    nodeKeys.add(edge.from);
    nodeKeys.add(edge.to);
  };
  const includeEdges = (edges) => edges.forEach(includeEdge);

  const isSlo = root.kind === 'slo';
  const isSli = root.kind === 'sli';
  const sliKeys = new Set();

  if (isSlo) {
    for (const edge of outgoing(graph, rootKey, 'sli_of')) {
      includeEdge(edge);
      sliKeys.add(edge.to);
    }
  } else if (isSli) {
    sliKeys.add(rootKey);
  }

  const ruleKeys = new Set();
  for (const sliKey of sliKeys) {
    for (const edge of incoming(graph, sliKey, 'materialises')) {
      includeEdge(edge);
      ruleKeys.add(edge.from);
    }
  }

  const metricSourceKeys = new Set([...sliKeys, ...ruleKeys]);
  const metricKeys = new Set();
  for (const sourceKey of metricSourceKeys) {
    for (const edge of outgoing(graph, sourceKey, 'sources')) {
      includeEdge(edge);
      metricKeys.add(edge.to);
    }
  }

  for (const metricKey of metricKeys) {
    includeEdges(outgoing(graph, metricKey, 'exported_by'));
    includeEdges(outgoing(graph, metricKey, 'produced_by'));
  }

  const alertKeys = new Set();
  if (isSlo) {
    for (const edge of incoming(graph, rootKey, 'protects')) {
      includeEdge(edge);
      alertKeys.add(edge.from);
    }
    includeEdges(incoming(graph, rootKey, 'forecasts'));
    includeEdges(incoming(graph, rootKey, 'validates'));
  }

  for (const alertKey of alertKeys) {
    includeEdges(incoming(graph, alertKey, 'routes'));
    includeEdges(incoming(graph, alertKey, 'remediates'));
  }

  const visualTargets = new Set([rootKey, ...sliKeys]);
  const panelKeys = new Set();
  for (const targetKey of visualTargets) {
    for (const edge of incoming(graph, targetKey, 'visualises')) {
      includeEdge(edge);
      panelKeys.add(edge.from);
    }
  }

  for (const panelKey of panelKeys) {
    includeEdges(incoming(graph, panelKey, 'contains'));
  }

  const nodes = [...nodeKeys]
    .map((key) => graph.nodes.get(key))
    .filter(Boolean)
    .sort((a, b) => `${a.kind}:${labelOf(a)}`.localeCompare(`${b.kind}:${labelOf(b)}`));
  const edges = graph.edges
    .filter((edge) => edgeKeys.has(edge.key))
    .sort((a, b) => `${a.type}:${a.from}:${a.to}`.localeCompare(`${b.type}:${b.from}:${b.to}`));
  const missingRoles = branchMissingRoles(root, nodes);

  return {
    rootKey,
    rootIdentityKey: root.identityKey,
    rootKind: root.kind,
    title: labelOf(root),
    nodes,
    edges,
    missingRoles,
    edgeProvenance: countEdgeProvenance(edges),
  };
}

export function compareBranches(graphA, graphB) {
  const rootsA = requirementRoots(graphA);
  const rootsB = requirementRoots(graphB);
  const aByRoot = new Map(rootsA.map((key) => [rootCompareKey(graphA.nodes.get(key)), buildBranch(graphA, key)]));
  const bByRoot = new Map(rootsB.map((key) => [rootCompareKey(graphB.nodes.get(key)), buildBranch(graphB, key)]));
  const rootKeys = [...new Set([...aByRoot.keys(), ...bByRoot.keys()])]
    // A live-only branch rooted on a placeholder SLO/SLI (the fetcher's
    // per-service availability guess, `platform_availability`) is not an
    // undeclared commitment production runs — nothing attested it.
    .filter((rootKey) => aByRoot.has(rootKey) || !isScaffoldNode(graphB.nodes.get(bByRoot.get(rootKey).rootKey)))
    .sort();

  // Structural exposure per node, computed once per graph: what would go
  // blind if the node died. Additive beside the scored fields.
  const radiusA = blastRadiusIndex(graphShape(graphA));
  const radiusB = blastRadiusIndex(graphShape(graphB));

  // On-wire liveness (mcp.observed.*, the *_unhealthy lists, probe outcomes)
  // parsed once from the live graph's annotations; feeds the additive
  // per-node ladder beside the scored status.
  const liveness = livenessContext(graphB);

  const branches = rootKeys.map((rootKey) => compareBranch(aByRoot.get(rootKey), bByRoot.get(rootKey), graphB, radiusA, radiusB, liveness));
  const declared = branches.filter((branch) => branch.hasA);
  const declaredTotal = declared.length;
  const integrityMean = declaredTotal
    ? round(declared.reduce((sum, branch) => sum + branch.integrity, 0) / declaredTotal, 4)
    : 1;

  const rollup = {
    intact: branches.filter((branch) => branch.verdict === 'intact').length,
    partial: branches.filter((branch) => branch.verdict === 'partial').length,
    broken: branches.filter((branch) => branch.verdict === 'broken').length,
    undeclared: branches.filter((branch) => branch.verdict === 'undeclared').length,
    declaredTotal,
    total: branches.length,
    integrityMean,
    integrityPct: Math.round(integrityMean * 100),
  };
  // Additive ladder rollup over the same declared branches. integrityMean
  // and the intact/partial/broken/undeclared counts above are the scored
  // quantities and stay exactly as they were.
  rollup.ladder = ladderRollup(declared);

  return { branches, rollup };
}

export function comparePackBranches(packA, packB) {
  const graphA = buildDependencyGraph(packA);
  const graphB = buildDependencyGraph(packB);
  return compareBranches(graphA, graphB);
}

// The plain, artefact-free projection of a graph that the zero-import
// blast-radius module consumes: `{ nodes: [...], edges: [...] }`.
export function graphShape(graph) {
  const nodes = [...(graph?.nodes?.values() || [])].map((node) => ({
    key: node.key,
    identityKey: node.identityKey,
    kind: node.kind,
    layer: node.layer || null,
    label: labelOf(node),
    virtual: !!node.virtual,
    scaffold: isScaffoldNode(node),
  }));
  const edges = (graph?.edges || []).map(({ key, from, to, type, provenance }) => ({ key, from, to, type, provenance }));
  return { nodes, edges };
}

function compareBranch(branchA, branchB, liveGraph, radiusA = new Map(), radiusB = new Map(), liveness = livenessContext(liveGraph)) {
  if (!branchA && !branchB) throw new Error('compareBranch: at least one branch required');

  if (!branchA) {
    // Placeholders on a live-only branch are not undeclared live artefacts.
    const liveNodes = branchB.nodes.filter((node) => !isScaffoldNode(node));
    return {
      rootKey: branchB.rootIdentityKey,
      title: branchB.title,
      rootKind: branchB.rootKind,
      hasA: false,
      hasB: true,
      verdict: 'undeclared',
      integrity: 0,
      integrityPct: 0,
      // The ladder mirrors the scored fields on an undeclared branch.
      ladderVerdict: 'undeclared',
      ladderIntegrity: 0,
      ladderIntegrityPct: 0,
      confidence: branchConfidence(branchB),
      edgeProvenance: branchB.edgeProvenance,
      missingRoles: [],
      counts: { aligned: 0, drifted: 0, declaredOnly: 0, liveOnly: liveNodes.length, unverifiable: 0 },
      nodes: liveNodes.map((node) => nodeVerdict('live_only', null, node, [], radiusFor(radiusB, node), ladderFor('live_only', null, node, liveness))),
    };
  }

  const nodeVerdicts = [];
  const usedB = new Set();
  let achieved = 0;
  let possible = 0;
  // Ladder accounting: same weights, kept beside the scored pair above and
  // never folded into it (docs/SCORING_PROPOSAL_LADDER_INTEGRITY.md).
  let ladderAchieved = 0;
  let ladderPossible = 0;

  const aGroups = groupBranchNodes(branchA.nodes);
  const bGroups = groupBranchNodes(branchB?.nodes || []);
  const allIdentityKeys = [...new Set([...aGroups.keys(), ...bGroups.keys()])].sort();

  for (const identityKey of allIdentityKeys) {
    const aNodes = aGroups.get(identityKey) || [];
    const bNodes = bGroups.get(identityKey) || [];
    const exactB = bNodes.map((node, index) => ({ node, index }));
    const usedA = new Set();

    for (let ai = 0; ai < aNodes.length; ai++) {
      const bi = exactB.findIndex(({ node, index }) =>
        !usedB.has(node.key)
          && !usedA.has(ai)
          && canSatisfyLiveEvidence(node, liveGraph)
          && deltasOf(aNodes[ai].artefact, node.artefact).length === 0
      );
      if (bi === -1) continue;
      const [{ node: bNode }] = exactB.splice(bi, 1);
      usedA.add(ai);
      usedB.add(bNode.key);
      const verdict = nodeVerdict('aligned', aNodes[ai], bNode, [], radiusFor(radiusA, aNodes[ai]), ladderFor('aligned', aNodes[ai], bNode, liveness));
      nodeVerdicts.push(verdict);
      const w = nodeWeight(aNodes[ai]);
      possible += w;
      achieved += w;
      ladderPossible += w;
      ladderAchieved += w * ladderCredit(verdict.ladder);
    }

    const remainingA = aNodes
      .map((node, index) => ({ node, index }))
      .filter(({ index }) => !usedA.has(index));
    const remainingB = bNodes.filter((node) => !usedB.has(node.key) && canSatisfyLiveEvidence(node, liveGraph));

    while (remainingA.length && remainingB.length) {
      const { node: aNode } = remainingA.shift();
      let best = 0;
      let bestDeltas = deltasOf(aNode.artefact, remainingB[0].artefact);
      for (let i = 1; i < remainingB.length; i++) {
        const d = deltasOf(aNode.artefact, remainingB[i].artefact);
        if (d.length < bestDeltas.length) {
          best = i;
          bestDeltas = d;
        }
      }
      const [bNode] = remainingB.splice(best, 1);
      usedB.add(bNode.key);
      const verdict = nodeVerdict('drifted', aNode, bNode, bestDeltas, radiusFor(radiusA, aNode), ladderFor('drifted', aNode, bNode, liveness));
      nodeVerdicts.push(verdict);
      const w = nodeWeight(aNode);
      possible += w;
      achieved += w * driftCredit(bestDeltas);
      ladderPossible += w;
      // A drifted node keeps its drift credit unless the wire says it is
      // not doing its job either — then it earns no more than that.
      ladderAchieved += w * Math.min(driftCredit(bestDeltas), ladderCredit(verdict.ladder));
    }

    for (const { node: aNode } of remainingA) {
      const verifiable = canVerifyKind(aNode.kind, liveGraph);
      const status = verifiable ? 'declared_only' : 'unverifiable';
      const verdict = nodeVerdict(status, aNode, null, [], radiusFor(radiusA, aNode), ladderFor(status, aNode, null, liveness));
      nodeVerdicts.push(verdict);
      if (verifiable) possible += nodeWeight(aNode);
      // A node the vantage could not look for leaves the ladder denominator,
      // exactly as an unverifiable kind leaves both.
      if (verifiable && verdict.ladder.rung !== 'unobserved') {
        ladderPossible += nodeWeight(aNode);
        ladderAchieved += nodeWeight(aNode) * ladderCredit(verdict.ladder);
      }
    }
  }

  for (const bNode of branchB?.nodes || []) {
    if (usedB.has(bNode.key)) continue;
    if (aGroups.has(bNode.identityKey)) continue;
    if (isLiveOnlyInferredMetric(bNode, liveGraph)) continue;
    if (isScaffoldNode(bNode)) continue;
    nodeVerdicts.push(nodeVerdict('live_only', null, bNode, [], radiusFor(radiusB, bNode), ladderFor('live_only', null, bNode, liveness)));
  }

  for (const missing of branchA.missingRoles || []) {
    possible += missing.weight;
    ladderPossible += missing.weight;
  }

  const integrity = possible === 0 ? 1 : round(achieved / possible, 4);
  const ladderIntegrity = ladderPossible === 0 ? 1 : round(ladderAchieved / ladderPossible, 4);
  const counts = {
    aligned: nodeVerdicts.filter((node) => node.status === 'aligned').length,
    drifted: nodeVerdicts.filter((node) => node.status === 'drifted').length,
    declaredOnly: nodeVerdicts.filter((node) => node.status === 'declared_only').length,
    liveOnly: nodeVerdicts.filter((node) => node.status === 'live_only').length,
    unverifiable: nodeVerdicts.filter((node) => node.status === 'unverifiable').length,
  };

  const hasBrokenLoadBearingNode = nodeVerdicts.some((node) =>
    node.status === 'declared_only' && isLoadBearingKind(node.kind)
  );
  const hasMissingLoadBearingRole = (branchA.missingRoles || []).some((role) => role.loadBearing);
  const verdict = hasBrokenLoadBearingNode || hasMissingLoadBearingRole
    ? 'broken'
    : counts.drifted > 0
      ? 'partial'
      : 'intact';
  const ladderVerdict = branchLadderVerdict(nodeVerdicts, counts, hasMissingLoadBearingRole);

  return {
    rootKey: branchA.rootIdentityKey,
    title: branchA.title,
    rootKind: branchA.rootKind,
    hasA: true,
    hasB: !!branchB,
    verdict,
    integrity,
    integrityPct: Math.round(integrity * 100),
    ladderVerdict,
    ladderIntegrity,
    ladderIntegrityPct: Math.round(ladderIntegrity * 100),
    confidence: branchConfidence(branchA, branchB),
    edgeProvenance: combineProvenance(branchA.edgeProvenance, branchB?.edgeProvenance),
    missingRoles: branchA.missingRoles || [],
    counts,
    nodes: nodeVerdicts.sort((a, b) => `${statusRank(a.status)}:${a.kind}:${a.label}`.localeCompare(`${statusRank(b.status)}:${b.kind}:${b.label}`)),
  };
}


function flattenLayerArtefacts(pack) {
  const layers = pack?.layers || {};
  const out = [];
  for (const layer of LAYER_ORDER) {
    if (layer === 'L4') {
      const l4 = layers.L4 || {};
      for (const key of ['policy', 'alerting', 'healing']) {
        for (const artefact of l4[key] || []) out.push({ artefact, layer });
      }
      continue;
    }
    for (const artefact of layers[layer] || []) out.push({ artefact, layer });
  }
  return out;
}

function addNode(graph, node) {
  graph.nodes.set(node.key, node);
  addMapSet(graph.byIdentity, node.identityKey, node.key);
  addMapSet(graph.byKind, node.kind, node.key);
  if (node.artefact?.defines) addMapSet(graph.byDefines, normalizeRef(node.artefact.defines), node.key);
}

function addVirtualMetricNode(graph, metricName) {
  if (!metricish(metricName)) return null;
  const artefact = {
    id: `METRIC-VIRTUAL-${metricName}`,
    title: metricName,
    tool: 'Prometheus metric',
    tags: ['metric', 'inferred'],
    source: 'Inferred',
    spec: { name: metricName, source: 'expression' },
    virtual: true,
  };
  const identityKey = identityKeyOf(artefact);
  const existing = graph.byIdentity.get(identityKey);
  if (existing?.size) return [...existing][0];
  const node = {
    key: identityKey,
    identityKey,
    kind: 'metric',
    layer: 'L2',
    behavior: behaviorOf(artefact),
    artefact,
    virtual: true,
  };
  addNode(graph, node);
  return node.key;
}

function addEdge(graph, from, to, type, provenance = 'inferred') {
  if (!from || !to || from === to) return;
  if (!graph.nodes.has(from) || !graph.nodes.has(to)) return;
  const key = `${type}:${from}->${to}:${provenance}`;
  if (graph.edges.some((edge) => edge.key === key)) return;
  graph.edges.push({ key, from, to, type, provenance });
}

function resolveContractEdges(graph) {
  for (const sloKey of graph.byKind.get('slo') || []) {
    const slo = graph.nodes.get(sloKey);
    const sliRef = normalizeRef(slo.artefact?.spec?.sli, 'slis');
    for (const sliKey of graph.byDefines.get(sliRef) || []) {
      addEdge(graph, sloKey, sliKey, 'sli_of', 'declared');
    }
  }
}

function resolveRecordingRuleEdges(graph) {
  const sliKeys = [...(graph.byKind.get('sli') || [])];
  for (const ruleKey of graph.byKind.get('recording_rule') || []) {
    const rule = graph.nodes.get(ruleKey);
    const refs = new Set([
      ...(rule.artefact?.refs || []).map((ref) => normalizeRef(ref)),
      ...extractRefTokens(rule.artefact?.spec?.expr).map((ref) => normalizeRef(ref)),
    ]);
    let linked = false;
    for (const ref of refs) {
      if (!ref.startsWith('slis.')) continue;
      for (const sliKey of graph.byDefines.get(ref) || []) {
        addEdge(graph, ruleKey, sliKey, 'materialises', 'declared');
        linked = true;
      }
    }
    if (linked) continue;

    const ruleMetrics = new Set(extractPromqlMetricNames([rule.artefact?.spec?.name, rule.artefact?.spec?.expr]));
    const ruleNeedle = compact(`${rule.artefact?.title || ''} ${rule.artefact?.spec?.name || ''}`);
    for (const sliKey of sliKeys) {
      const sli = graph.nodes.get(sliKey);
      const sliMetrics = new Set(metricsFromArtefact(sli.artefact));
      const sliNeedle = compact(labelOf(sli));
      if (intersects(ruleMetrics, sliMetrics)) {
        addEdge(graph, ruleKey, sliKey, 'materialises', 'derived-promql');
      } else if (sliNeedle && ruleNeedle.includes(sliNeedle)) {
        addEdge(graph, ruleKey, sliKey, 'materialises', 'inferred');
      }
    }
  }
}

function resolveMetricSourceEdges(graph) {
  const sourceKinds = ['sli', 'recording_rule'];
  for (const kind of sourceKinds) {
    for (const sourceKey of graph.byKind.get(kind) || []) {
      const source = graph.nodes.get(sourceKey);
      for (const { metric, provenance } of metricDependenciesFromArtefact(source.artefact)) {
        const metricKey = addVirtualMetricNode(graph, metric);
        addEdge(graph, sourceKey, metricKey, 'sources', provenance);
      }
    }
  }
}

function resolveMetricExporterEdges(graph) {
  const exporterKeys = [...(graph.byKind.get('pipeline_exporter_metrics') || [])];
  const scrapeKeys = [...(graph.byKind.get('scrape_job') || [])];
  if (!exporterKeys.length && !scrapeKeys.length) return;
  for (const metricKey of graph.byKind.get('metric') || []) {
    for (const exporterKey of exporterKeys) {
      const exporter = graph.nodes.get(exporterKey);
      addEdge(graph, metricKey, exporterKey, 'exported_by',
        exporter?.artefact?.source === 'Verified' ? 'declared' : 'inferred');
    }
    for (const scrapeKey of scrapeKeys) {
      const metric = graph.nodes.get(metricKey);
      const scrape = graph.nodes.get(scrapeKey);
      if (!metricMatchesScrapeJob(metric, scrape)) continue;
      addEdge(graph, metricKey, scrapeKey, 'exported_by',
        scrape?.artefact?.source === 'Verified' ? 'declared' : 'inferred');
    }
  }
}

function resolveMetricBackendEdges(graph) {
  const backendKeys = [...(graph.byKind.get('backend') || [])];
  const metricBackendKeys = backendKeys.filter((key) => {
    const node = graph.nodes.get(key);
    const signal = String(node.artefact?.spec?.signal || '').toLowerCase();
    return signal === 'metrics';
  });
  if (!metricBackendKeys.length) return;

  const declaredBackend = normalizeBackendId(graph.meta?.backendWiring?.metrics);
  let selected = [];
  let provenance = 'inferred';
  if (declaredBackend) {
    const defineKey = `telemetry.backends.${declaredBackend}`;
    selected = [...(graph.byDefines.get(defineKey) || [])];
    provenance = 'declared';
  }
  if (!selected.length) {
    selected = metricBackendKeys.filter((key) => graph.nodes.get(key).artefact?.spec?.default === true);
    provenance = selected.length ? 'declared' : provenance;
  }
  if (!selected.length && metricBackendKeys.length === 1) selected = metricBackendKeys;
  if (!selected.length) return;

  for (const metricKey of graph.byKind.get('metric') || []) {
    for (const backendKey of selected) addEdge(graph, metricKey, backendKey, 'produced_by', provenance);
  }
}

function resolvePolicyEdges(graph) {
  for (const alertKey of graph.byKind.get('burn_rate') || []) {
    const alert = graph.nodes.get(alertKey);
    const sloRef = normalizeRef(alert.artefact?.spec?.slo, 'slos');
    for (const sloKey of graph.byDefines.get(sloRef) || []) {
      addEdge(graph, alertKey, sloKey, 'protects', 'declared');
    }
  }
  for (const forecastKey of graph.byKind.get('forecast') || []) {
    const forecast = graph.nodes.get(forecastKey);
    const sloRef = normalizeRef(forecast.artefact?.spec?.slo, 'slos');
    for (const sloKey of graph.byDefines.get(sloRef) || []) {
      addEdge(graph, forecastKey, sloKey, 'forecasts', 'declared');
    }
  }
}

function resolveDashboardEdges(graph) {
  for (const panelKey of graph.byKind.get('panel') || []) {
    const panel = graph.nodes.get(panelKey);
    const parentRef = normalizeRef(panel.artefact?.parent);
    for (const dashboardKey of graph.byDefines.get(parentRef) || []) {
      addEdge(graph, dashboardKey, panelKey, 'contains', 'declared');
    }

    const refs = new Set([
      ...(panel.artefact?.refs || []),
      panel.artefact?.spec?.binds_to,
    ].filter(Boolean).map((ref) => normalizeRef(ref)));
    for (const ref of refs) {
      if (!ref.startsWith('slis.') && !ref.startsWith('slos.')) continue;
      for (const targetKey of graph.byDefines.get(ref) || []) {
        addEdge(graph, panelKey, targetKey, 'visualises', 'declared');
      }
    }
  }
}

function resolveResponseEdges(graph) {
  const alerts = [...(graph.byKind.get('burn_rate') || [])].map((key) => graph.nodes.get(key));
  for (const routeKey of graph.byKind.get('alert_route') || []) {
    const route = graph.nodes.get(routeKey);
    const severity = String(route.artefact?.spec?.severity || '').toLowerCase();
    if (!severity) continue;
    for (const alert of alerts) {
      const severities = new Set((alert.artefact?.spec?.windows || [])
        .map((w) => String(w.severity || '').toLowerCase())
        .filter(Boolean));
      if (severities.has(severity)) addEdge(graph, routeKey, alert.key, 'routes', 'inferred');
    }
  }

  for (const remediationKey of graph.byKind.get('remediation') || []) {
    const remediation = graph.nodes.get(remediationKey);
    const trigger = compact(remediation.artefact?.spec?.trigger || remediation.artefact?.title || '');
    if (!trigger) continue;
    for (const alert of alerts) {
      const alertText = compact(`${alert.artefact?.title || ''} ${alert.artefact?.spec?.slo || ''}`);
      if (alertText && (trigger.includes(alertText) || alertText.includes(trigger))) {
        addEdge(graph, remediationKey, alert.key, 'remediates', 'inferred');
      }
    }
  }
}

function resolveValidationEdges(graph) {
  for (const kind of ['chaos', 'synthetic']) {
    for (const key of graph.byKind.get(kind) || []) {
      const node = graph.nodes.get(key);
      const refs = new Set([
        ...(node.artefact?.refs || []),
        node.artefact?.spec?.steady_state_hypothesis,
        node.artefact?.spec?.slo,
      ].filter(Boolean).map((ref) => normalizeRef(ref, 'slos')));
      for (const ref of refs) {
        if (!ref.startsWith('slos.')) continue;
        for (const sloKey of graph.byDefines.get(ref) || []) {
          addEdge(graph, key, sloKey, 'validates', node.artefact?.refs?.includes(ref) ? 'declared' : 'inferred');
        }
      }
    }
  }
}

function branchMissingRoles(root, nodes) {
  const kinds = new Set(nodes.map((node) => node.kind));
  const missing = [];
  if (root.kind === 'slo' && !kinds.has('sli')) {
    missing.push(missingRole('sli', 'SLO has no linked SLI'));
  }
  if ((root.kind === 'slo' || root.kind === 'sli') && !kinds.has('recording_rule') && !kinds.has('metric')) {
    missing.push(missingRole('detection', 'requirement has no metric or recording-rule evidence'));
  }
  if (root.kind === 'slo' && !kinds.has('burn_rate')) {
    missing.push(missingRole('action', 'SLO has no burn-rate alert protecting it'));
  }
  return missing;
}

function missingRole(role, detail) {
  return {
    role,
    detail,
    weight: MISSING_ROLE_WEIGHTS[role] || 1,
    loadBearing: true,
  };
}

function groupBranchNodes(nodes) {
  const out = new Map();
  for (const node of nodes || []) {
    if (!out.has(node.identityKey)) out.set(node.identityKey, []);
    out.get(node.identityKey).push(node);
  }
  return out;
}

function nodeVerdict(status, aNode, bNode, deltas = [], blastRadius = null, ladder = null) {
  const node = aNode || bNode;
  return {
    status,
    key: node?.identityKey || node?.key || '',
    kind: node?.kind || 'unknown',
    layer: node?.layer || null,
    label: labelOf(node),
    weight: nodeWeight(node),
    aId: aNode?.artefact?.id || null,
    bId: bNode?.artefact?.id || null,
    virtual: !!(aNode?.virtual || bNode?.virtual),
    deltas,
    // Structural exposure (blast-radius.mjs summary): what would go blind if
    // this node died. null when the graph index has no entry for it.
    blastRadius,
    // On-wire liveness rung beside the scored status (see ladderFor): is the
    // artefact merely present, or doing its job — or could the vantage not
    // look at all. Unscored; null only when no ladder was computed.
    ladder,
  };
}


function radiusFor(index, node) {
  return index?.get(node?.key) ?? null;
}

function nodeWeight(node) {
  return LIMB_WEIGHTS[node?.kind] ?? 0.5;
}

function isLoadBearingKind(kind) {
  return ['slo', 'sli', 'recording_rule', 'metric', 'burn_rate'].includes(kind);
}

function canVerifyKind(kind, liveGraph) {
  if (ALWAYS_LIVE_VERIFIABLE.has(kind)) return true;
  if (!PARTIAL_LIVE_VERIFIABLE.has(kind)) return false;
  // A placeholder of the kind (the live pack's scaffold SEV1 route or
  // dashboard stub) is not proof the live connector can see that kind.
  return [...(liveGraph?.byKind.get(kind) || [])]
    .some((key) => !isScaffoldNode(liveGraph.nodes.get(key)));
}

// A schema-forced placeholder the crawler or the live fetcher had to
// invent (source 'Scaffold' from a crawler.scaffold.* / mcp.scaffold.*
// marker). Never live evidence, never an undeclared live artefact.
function isScaffoldNode(node) {
  return node?.artefact?.source === 'Scaffold';
}

function canSatisfyLiveEvidence(bNode, liveGraph) {
  if (!bNode) return false;
  // The live pack's fallback burn-rate entry, SEV1 route, backends and
  // collector stages are placeholders: a declared node must fall through
  // to declared_only against them, never read aligned or drifted.
  if (isScaffoldNode(bNode)) return false;
  if (bNode.kind !== 'metric') return true;
  if (!bNode.virtual) return true;
  if (!hasMcpSource(liveGraph)) return true;
  // In a live pack, a PromQL-parsed metric only proves dependency shape. The
  // metric itself is confirmed by MCP-discovered METRIC-* inventory.
  return false;
}

function isLiveOnlyInferredMetric(node, liveGraph) {
  return node?.kind === 'metric' && node.virtual && hasMcpSource(liveGraph);
}

function hasMcpSource(graph) {
  const ann = graph?.meta?.annotations || {};
  return Object.keys(ann).some((key) => key.startsWith('mcp.'));
}

// ---------------------------------------------------------------------------
// Per-node ladder (additive, unscored).
//
// The scored status answers "is the declared artefact in Pack B?". The
// ladder answers the finer monitor-of-monitors question from what the live
// fetcher wrote into Pack B's annotations — mcp.observed.* entries, the
// mcp.discovered.*_unhealthy / scrape_jobs_down lists, mcp.probesFailed and
// mcp.probesUnsupported, mcp.refreshedAt as "now":
//
//   unobserved < absent < exists < alive < healthy
//
// `present_unhealthy` and `present_stale` keep rung `exists`: the artefact
// is on the wire, it is just not doing its job. `unobserved` means the
// vantage could not look (probe family failed or not exposed) — never
// "absent". Nothing here touches integrity / verdict / counts / status.
// ---------------------------------------------------------------------------

// Probe family whose answer would carry the kind. sli/slo are inferred from
// EITHER recording rules or the metric inventory, so they are unobserved
// only when both families are gone. Backends are not in this table: the
// fetcher runs its version probes outside the probe cascade, so they never
// appear in mcp.probesFailed / mcp.probesUnsupported — a backend's
// aliveness is read from mcp.versions.<product> instead.
const PROBE_FAMILIES_BY_KIND = {
  scrape_job: ['scrape_configs'],
  recording_rule: ['recording_rules'],
  burn_rate: ['alert_rules'],
  metric: ['metric_names'],
  sli: ['recording_rules', 'metric_names'],
  slo: ['recording_rules', 'metric_names'],
  panel: ['dashboards'],
  dashboard: ['dashboards'],
};

// The compiler names every burn-rate alerting rule
// `<slo>_burn_<factor>x_<short>_<long>` (compile.mjs) and the fetcher
// recognises the same shape when it maps discovered alerts. The live POL-*
// artefact carries only { slo, windows } — no rule names — so a burn_rate
// node is linked to the observed alert rules by that convention on the SLO
// id, narrowed to the declared (factor, short, long) windows when they
// match. Rules the fetcher mapped through labels (labels.slo / burn_rate /
// window_*) cannot be linked here: the observation entries carry no labels.
const BURN_ALERT_NAME_RE = /^(.+)_burn_(\d+)x_([0-9a-z]+)_([0-9a-z]+)$/;

const DURATION_RE = /^(\d+(?:\.\d+)?(?:ms|s|m|h|d|w))+$/;
const DURATION_PART_RE = /(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g;
const DURATION_UNIT_SECONDS = { ms: 1e-3, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
// A timestamp older than this many intervals reads present_stale.
const STALE_INTERVALS = 2;

function livenessContext(liveGraph) {
  const ann = liveGraph?.meta?.annotations || {};
  const text = (key) => (typeof ann[key] === 'string' && ann[key] ? ann[key] : null);
  return {
    onWire: hasMcpSource(liveGraph),
    refreshedAt: parseTimestamp(ann['mcp.refreshedAt']),
    scrapeTargets: annotationArray(ann['mcp.observed.scrape_targets']),
    recordingRules: annotationArray(ann['mcp.observed.recording_rules']),
    alertRules: annotationArray(ann['mcp.observed.alert_rules']),
    scrapeJobsDown: annotationSet(ann['mcp.discovered.scrape_jobs_down']),
    recordingRulesUnhealthy: annotationSet(ann['mcp.discovered.recording_rules_unhealthy']),
    alertRulesUnhealthy: annotationSet(ann['mcp.discovered.alert_rules_unhealthy']),
    slisUnhealthy: annotationSet(ann['mcp.discovered.slis_unhealthy']),
    probesFailed: annotationSet(ann['mcp.probesFailed']),
    probesUnsupported: annotationSet(ann['mcp.probesUnsupported']),
    probesSucceeded: annotationSet(ann['mcp.probesSucceeded']),
    probesEmpty: annotationSet(ann['mcp.probesEmpty']),
    probeError: (family) => text(`mcp.probeErrors.${family}`),
    version: (product) => text(`mcp.versions.${product}`),
    // Names the MCP metric inventory attested (non-virtual METRIC-* nodes):
    // a declared metric can be in Pack B yet outside a branch whose
    // producing rule is gone — on the wire, not absent.
    liveMetrics: new Set([...(liveGraph?.byKind?.get('metric') || [])]
      .map((key) => liveGraph.nodes.get(key))
      .filter((node) => node && !node.virtual)
      .map((node) => metricName(node))),
  };
}

function metricName(node) {
  return String(node?.artefact?.spec?.name || labelOf(node) || '');
}

function ladder(rung, status, detail) {
  return { rung, status, detail };
}

function ladderFor(status, aNode, bNode, liveness) {
  if (status === 'unverifiable') return ladder('unobserved', null, 'not live-introspectable from any MCP vantage');
  if (status === 'declared_only') return declaredOnlyLadder(aNode, liveness);
  // aligned / drifted / live_only: the artefact is in Pack B — read its
  // spec against what the wire reported about it (A fills a missing
  // interval so freshness can still be judged).
  return presentLadder(bNode, aNode, liveness);
}

function declaredOnlyLadder(aNode, liveness) {
  if (!liveness.onWire) return ladder('absent', null, 'absent from Pack B (file-sourced; no on-wire liveness to consult)');
  // The fetcher withholds some artefacts it DID observe from Pack B — a
  // scrape job whose every target is down lands only in
  // mcp.discovered.scrape_jobs_down. On the wire beats absent.
  const observed = observationFor(aNode, null, liveness);
  if (observed && (observed.found || observed.listed)) {
    const present = presentLadder(aNode, null, liveness);
    return ladder(present.rung, present.status, `on the wire but withheld from Pack B: ${present.detail}`);
  }
  // A metric the inventory attested is in Pack B; it fell out of THIS
  // branch because the rule that sourced it is gone (its own rung says so).
  if (aNode?.kind === 'metric' && liveness.liveMetrics.has(metricName(aNode))) {
    return ladder('exists', null, 'in the live metric inventory, but not reachable from this branch in Pack B');
  }
  const families = PROBE_FAMILIES_BY_KIND[aNode?.kind] || [];
  const blind = families.filter((family) => liveness.probesFailed.has(family) || liveness.probesUnsupported.has(family));
  if (families.length && blind.length === families.length) {
    return ladder('unobserved', 'unobserved', blind.map((family) => probeFamilyDetail(family, liveness)).join('; '));
  }
  const answered = families.filter((family) => !blind.includes(family));
  if (!answered.length) return ladder('absent', null, 'absent from Pack B');
  const outcome = answered.every((family) => liveness.probesSucceeded.has(family) || liveness.probesEmpty.has(family))
    ? 'answered without it'
    : 'is not reported failed or unsupported';
  return ladder('absent', null, `absent from Pack B; probe family ${answered.join(' / ')} ${outcome}`);
}

function probeFamilyDetail(family, liveness) {
  if (liveness.probesFailed.has(family)) {
    const error = liveness.probeError(family);
    return `probe family ${family} failed${error ? ` (${error})` : ''}`;
  }
  return `probe family ${family} not exposed by this MCP tier`;
}

function presentLadder(node, fallbackNode, liveness) {
  if (!liveness.onWire) return ladder('exists', null, 'no on-wire liveness (Pack B is not a live draft)');
  const kind = node?.kind;
  const spec = node?.artefact?.spec || {};
  if (kind === 'sli') {
    return liveness.slisUnhealthy.has(String(spec.id || ''))
      ? ladder('exists', 'present_unhealthy', 'listed in mcp.discovered.slis_unhealthy: a recording rule feeding it is not evaluating')
      : ladder('exists', null, 'liveness rides on its recording rules');
  }
  if (kind === 'slo') return ladder('exists', null, 'declaration; liveness rides on its SLI and alerts');
  if (kind === 'backend') {
    const product = compact(spec.product);
    const version = product ? liveness.version(product) : null;
    return version
      ? ladder('alive', null, `mcp.versions.${product} = ${version}: the backend answered its version probe`)
      : ladder('exists', null, 'no liveness field on the wire for this kind');
  }
  const observed = observationFor(node, fallbackNode, liveness);
  if (!observed) return ladder('exists', null, 'no liveness field on the wire for this kind');
  if (!observed.found) {
    return observed.listed
      ? ladder('exists', 'present_unhealthy', `${observed.name} listed in ${observed.list}`)
      : ladder('exists', null, `no ${observed.what} observation on the wire for ${observed.name}`);
  }
  const error = observed.errors[0] || null;
  if (observed.listed || observed.healthy === false || error) {
    const parts = [];
    if (observed.healthy === false) parts.push(observed.unhealthyDetail);
    else if (observed.listed) parts.push(`listed in ${observed.list}`);
    if (error) parts.push(`lastError "${error}"`);
    return ladder('exists', 'present_unhealthy', parts.join(', '));
  }
  const age = observed.at != null && liveness.refreshedAt != null ? liveness.refreshedAt - observed.at : null;
  const interval = observed.intervalSec;
  if (age != null && interval != null && age > STALE_INTERVALS * interval * 1000) {
    return ladder('exists', 'present_stale', `${observed.timeField} ${formatAge(age)} ago > ${STALE_INTERVALS}× interval ${observed.intervalText}`);
  }
  const freshness = age != null && interval != null
    ? `${observed.timeField} ${formatAge(age)} ago ≤ ${STALE_INTERVALS}× interval ${observed.intervalText}`
    : age != null
      ? `${observed.timeField} ${formatAge(age)} ago; interval unknown, staleness not judged`
      : `no ${observed.timeField} on the wire; staleness not judged`;
  if (observed.healthy === true) return ladder('healthy', null, `${observed.healthyDetail}, ${freshness}`);
  return ladder('alive', null, `health not reported, ${freshness}`);
}

// What the wire says about one node, or null when the kind has no liveness
// field on the wire at all.
function observationFor(node, fallbackNode, liveness) {
  const kind = node?.kind;
  const spec = node?.artefact?.spec || {};
  const fallbackSpec = fallbackNode?.artefact?.spec || {};
  if (kind === 'scrape_job') {
    const job = String(spec.job || fallbackSpec.job || '');
    const targets = liveness.scrapeTargets.filter((target) => String(target?.job || '') === job);
    const down = targets.filter((target) => targetHealth(target?.health) === 'down').length;
    const up = targets.filter((target) => targetHealth(target?.health) === 'up').length;
    const plural = targets.length === 1 ? '' : 's';
    return {
      what: 'scrape target',
      name: `job ${job}`,
      list: 'mcp.discovered.scrape_jobs_down',
      listed: liveness.scrapeJobsDown.has(job),
      found: targets.length > 0,
      healthy: !targets.length ? null : down ? false : up === targets.length ? true : null,
      unhealthyDetail: `health down on ${down}/${targets.length} target${plural}`,
      healthyDetail: `health up on ${up}/${targets.length} target${plural}`,
      errors: targets.map((target) => target?.lastError).filter(Boolean).map(String),
      at: latestTimestamp(targets.map((target) => target?.lastScrape)),
      timeField: 'lastScrape',
      ...intervalOf(spec.interval ?? fallbackSpec.interval),
    };
  }
  if (kind === 'recording_rule') {
    const name = String(spec.name || fallbackSpec.name || '');
    const rules = liveness.recordingRules.filter((rule) => String(rule?.name || '') === name);
    return ruleObservation(rules, `rule ${name}`, liveness.recordingRulesUnhealthy.has(name),
      'mcp.discovered.recording_rules_unhealthy', spec.interval ?? fallbackSpec.interval);
  }
  if (kind === 'burn_rate') {
    const sloId = burnSlug(normalizeRef(spec.slo ?? fallbackSpec.slo, 'slos').replace(/^slos\./, ''));
    const rules = burnAlertRulesFor(sloId, spec.windows ?? fallbackSpec.windows, liveness.alertRules);
    const listed = [...liveness.alertRulesUnhealthy].some((name) => parseBurnAlertName(name)?.slo === sloId);
    // Alert-rule group intervals are not on the wire and the POL-* spec has
    // none, so a burn-rate alert is never judged stale.
    return ruleObservation(rules, `alert rules of slo ${sloId}`, listed, 'mcp.discovered.alert_rules_unhealthy', null);
  }
  return null;
}

function ruleObservation(rules, name, listed, list, interval) {
  const healths = rules.map((rule) => ruleHealth(rule?.health));
  const notOk = healths.filter((health) => health === false).length;
  const firstBad = rules.find((rule) => ruleHealth(rule?.health) === false)?.health;
  return {
    what: 'rule',
    name,
    list,
    listed,
    found: rules.length > 0,
    healthy: !rules.length ? null : notOk ? false : healths.every((health) => health === true) ? true : null,
    unhealthyDetail: `health ${String(firstBad ?? '').trim().toLowerCase() || 'not ok'}${rules.length > 1 ? ` on ${notOk}/${rules.length} rules` : ''}`,
    healthyDetail: rules.length > 1 ? `health ok on ${rules.length}/${rules.length} rules` : 'health ok',
    errors: rules.map((rule) => rule?.lastError).filter(Boolean).map(String),
    at: latestTimestamp(rules.map((rule) => rule?.lastEvaluation)),
    timeField: 'lastEvaluation',
    ...intervalOf(interval),
  };
}

function burnAlertRulesFor(sloId, windows, alertRules) {
  if (!sloId) return [];
  const parsed = alertRules
    .map((rule) => ({ rule, burn: parseBurnAlertName(rule?.name) }))
    .filter(({ burn }) => burn && burn.slo === sloId);
  const declared = new Set((Array.isArray(windows) ? windows : [])
    .map((w) => `${Number(w?.factor)}x_${String(w?.short || '').toLowerCase()}_${String(w?.long || '').toLowerCase()}`));
  const narrowed = parsed.filter(({ burn }) => declared.has(`${burn.factor}x_${burn.short}_${burn.long}`));
  return (narrowed.length ? narrowed : parsed).map(({ rule }) => rule);
}

function parseBurnAlertName(name) {
  const match = BURN_ALERT_NAME_RE.exec(String(name || ''));
  if (!match) return null;
  return { slo: burnSlug(match[1]), factor: Number(match[2]), short: match[3], long: match[4] };
}

// compile.mjs squashes every non-word character of the alert name to `_`,
// so an SLO id with dashes must be compared in the same alphabet.
function burnSlug(id) {
  return String(id || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

// Prometheus target health 'up' | 'down'; anything else is no evidence.
function targetHealth(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return s === 'up' || s === 'down' ? s : null;
}

// Ruler health: true (ok), false (reported and not ok), null (not reported).
function ruleHealth(value) {
  if (value == null || value === '') return null;
  return String(value).trim().toLowerCase() === 'ok';
}

function intervalOf(value) {
  const intervalSec = durationSeconds(value);
  return {
    intervalSec,
    intervalText: intervalSec == null ? null : typeof value === 'number' ? `${value}s` : String(value).trim(),
  };
}

// '10s', '1m', '5m', '1h', '1h30m', a plain number or numeric string
// (seconds — the fetcher's normInterval already renders those as strings).
function durationSeconds(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) > 0 ? Number(s) : null;
  if (!DURATION_RE.test(s)) return null;
  let total = 0;
  for (const match of s.matchAll(DURATION_PART_RE)) total += parseFloat(match[1]) * DURATION_UNIT_SECONDS[match[2]];
  return total > 0 ? total : null;
}

function parseTimestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? (value > 1e12 ? value : value * 1000) : null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

function latestTimestamp(values) {
  const times = values.map(parseTimestamp).filter((t) => t != null);
  return times.length ? Math.max(...times) : null;
}

function formatAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function annotationArray(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry === 'object') : [];
}

function annotationSet(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return new Set(list.map((entry) => String(entry).trim()).filter(Boolean));
}

function ladderCredit(ladder) {
  if (!ladder) return 1;
  if (ladder.status === 'present_unhealthy' || ladder.status === 'present_stale') return 0.25;
  if (ladder.rung === 'absent' || ladder.rung === 'unobserved') return 0;
  return 1;
}

function branchLadderVerdict(nodeVerdicts, counts, hasMissingLoadBearingRole) {
  const loadBearing = nodeVerdicts.filter((node) => isLoadBearingKind(node.kind));
  if (hasMissingLoadBearingRole || loadBearing.some((node) => node.ladder?.rung === 'absent')) return 'broken';
  if (counts.drifted > 0 || loadBearing.some((node) => node.ladder?.status === 'present_unhealthy' || node.ladder?.status === 'present_stale')) return 'degraded';
  if (loadBearing.some((node) => node.ladder?.status === 'unobserved')) return 'unobserved';
  return 'healthy';
}

function ladderRollup(declared) {
  const count = (verdict) => declared.filter((branch) => branch.ladderVerdict === verdict).length;
  const integrityMean = declared.length
    ? round(declared.reduce((sum, branch) => sum + branch.ladderIntegrity, 0) / declared.length, 4)
    : 1;
  return {
    healthy: count('healthy'),
    degraded: count('degraded'),
    broken: count('broken'),
    unobserved: count('unobserved'),
    integrityMean,
    integrityPct: Math.round(integrityMean * 100),
  };
}

function driftCredit(deltas) {
  const fields = (deltas || []).map((delta) => String(delta.field || '')).filter(Boolean);
  if (!fields.length) return 1;
  if (fields.some((field) => DECISION_BEARING_DELTA_RE.test(field))) return 0.25;
  if (fields.every((field) => COSMETIC_DELTA_RE.test(field))) return 0.9;
  return 0.5;
}

function metricsFromArtefact(artefact) {
  return metricDependenciesFromArtefact(artefact).map((dep) => dep.metric);
}

function metricDependenciesFromArtefact(artefact) {
  const spec = artefact?.spec || {};
  const names = new Set();
  for (const key of ['good', 'total', 'query', 'expression', 'expr', 'promql', 'name']) {
    const parsed = parsePromqlDependencies(stripSymbolRefs(spec[key]));
    for (const metric of parsed.metrics) names.add(metric);
  }
  if (metricish(spec.semconv_metric)) names.add(spec.semconv_metric);
  return [...names].sort().map((metric) => ({
    metric,
    provenance: 'derived-promql',
  }));
}

function metricMatchesScrapeJob(metricNode, scrapeNode) {
  const metric = String(metricNode?.artefact?.spec?.name || metricNode?.artefact?.title || '').toLowerCase();
  const scrape = scrapeNode?.artefact?.spec || {};
  const job = String(scrape.job || '').toLowerCase();
  if (!metric || !job) return false;

  const originService = String(metricNode?.artefact?.spec?.origin_service || '').toLowerCase();
  if (originService && compact(job).includes(compact(originService))) return true;
  if (originService && compact(originService).includes(compact(job))) return true;

  const jobCompact = compact(job);
  const metricCompact = compact(metric);
  if (jobCompact && metricCompact.includes(jobCompact)) return true;

  if (/node-exporter|node_exporter/.test(job)) return /^(node_|nodejs_|process_|go_)/.test(metric);
  if (/kube-state|kube_state/.test(job)) return /^(kube_|container_|pod_)/.test(metric);
  if (/kong/.test(job)) return /^kong_/.test(metric);
  if (/rabbit/.test(job)) return /^rabbitmq_/.test(metric);
  if (/postgres|postgresql/.test(job)) return /^(pg_|postgres_)/.test(metric);
  if (/redis/.test(job)) return /^redis_/.test(metric);
  if (/otel|collector/.test(job)) return /^(otelcol_|otel_)/.test(metric);
  if (/alertmanager/.test(job)) return /^alertmanager_/.test(metric);
  if (/grafana/.test(job)) return /^grafana_/.test(metric);
  if (/victoria|prometheus/.test(job)) return /^(vm_|prometheus_)/.test(metric);
  if (/pushgateway/.test(job)) return /^pushgateway_/.test(metric);
  if (/bayesian/.test(job)) return /^bayesian_/.test(metric);
  if (/matcher|payment-processor/.test(job)) return /^kx_matcher_/.test(metric);

  return isApplicationScrapeJob(job) && isApplicationMetric(metric);
}

function isApplicationScrapeJob(job) {
  return !/(node-exporter|kube-state|prometheus|victoria|grafana|alertmanager|loki|jaeger|otel|collector|pushgateway|rabbit|postgres|redis|kong|promtail)/.test(job);
}

function isApplicationMetric(metric) {
  if (/^(node_|nodejs_|process_|go_|kube_|container_|pod_|prometheus_|vm_|grafana_|alertmanager_|loki_|jaeger_|otelcol_|rabbitmq_|pg_|postgres_|redis_|kong_)/.test(metric)) {
    return false;
  }
  return !metric.startsWith('slo:') && !metric.startsWith('finops:');
}

function stripSymbolRefs(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\b(?:ref:)?(?:slis|slos)\.[A-Za-z0-9_-]+\b/g, ' ');
}

function metricish(name) {
  return typeof name === 'string' && /^[A-Za-z_:][A-Za-z0-9_:]*$/.test(name);
}

function extractRefTokens(value) {
  if (typeof value !== 'string') return [];
  const out = [];
  const re = /(ref:[A-Za-z0-9_./-]+|sli[s]\.[A-Za-z0-9_-]+|slo[s]\.[A-Za-z0-9_-]+)/g;
  let match;
  while ((match = re.exec(value)) !== null) out.push(match[1]);
  return out;
}

function normalizeRef(ref, defaultPrefix = '') {
  if (typeof ref !== 'string') return '';
  let s = ref.trim();
  if (!s) return '';
  if (s.startsWith('ref:')) s = s.slice(4);
  if (s.startsWith('sli.')) s = `slis.${s.slice(4)}`;
  if (s.startsWith('slo.')) s = `slos.${s.slice(4)}`;
  if ((defaultPrefix === 'slis' || defaultPrefix === 'slos') && !s.includes('.')) {
    s = `${defaultPrefix}.${s}`;
  }
  return s;
}

function normalizeBackendId(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/^ref:/, '').replace(/^telemetry\.backends\./, '').trim();
}

function outgoing(graph, from, type) {
  return graph.edges.filter((edge) => edge.from === from && (!type || edge.type === type));
}

function incoming(graph, to, type) {
  return graph.edges.filter((edge) => edge.to === to && (!type || edge.type === type));
}

function hasIncomingEdge(graph, to, type) {
  return graph.edges.some((edge) => edge.to === to && edge.type === type);
}

function labelOf(node) {
  const artefact = node?.artefact || {};
  return artefact.title || artefact.spec?.id || artefact.spec?.name || artefact.id || node?.identityKey || '';
}

function rootCompareKey(node) {
  return node?.identityKey || '';
}

function branchConfidence(...branches) {
  const edges = branches.flatMap((branch) => branch?.edges || []);
  if (!edges.length) return 'declared';
  if (edges.some((edge) => edge.provenance === 'inferred')) return 'inferred';
  if (edges.some((edge) => String(edge.provenance || '').startsWith('derived-'))) return 'derived';
  return 'declared';
}

function countEdgeProvenance(edges) {
  return edges.reduce((out, edge) => {
    out[edge.provenance] = (out[edge.provenance] || 0) + 1;
    return out;
  }, { declared: 0, inferred: 0 });
}

function combineProvenance(a = {}, b = {}) {
  const out = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b), 'declared', 'inferred'])) {
    out[key] = (a[key] || 0) + (b[key] || 0);
  }
  return out;
}

function compareNodeKeys(graph) {
  return (a, b) => labelOf(graph.nodes.get(a)).localeCompare(labelOf(graph.nodes.get(b)));
}

function addMapSet(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function occurrenceKey(baseKey, index, suffix) {
  return suffix ? `${baseKey}#${String(index + 1).padStart(2, '0')}` : baseKey;
}

function intersects(a, b) {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

function compact(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function statusRank(status) {
  return {
    declared_only: 0,
    drifted: 1,
    unverifiable: 2,
    live_only: 3,
    aligned: 4,
  }[status] ?? 9;
}

function round(value, places) {
  const mult = 10 ** places;
  return Math.round(value * mult) / mult;
}
