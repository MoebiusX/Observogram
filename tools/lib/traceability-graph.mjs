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
  const rootKeys = [...new Set([...aByRoot.keys(), ...bByRoot.keys()])].sort();

  const branches = rootKeys.map((rootKey) => compareBranch(aByRoot.get(rootKey), bByRoot.get(rootKey), graphB));
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

  return { branches, rollup };
}

export function comparePackBranches(packA, packB) {
  const graphA = buildDependencyGraph(packA);
  const graphB = buildDependencyGraph(packB);
  return compareBranches(graphA, graphB);
}

function compareBranch(branchA, branchB, liveGraph) {
  if (!branchA && !branchB) throw new Error('compareBranch: at least one branch required');

  if (!branchA) {
    return {
      rootKey: branchB.rootIdentityKey,
      title: branchB.title,
      rootKind: branchB.rootKind,
      hasA: false,
      hasB: true,
      verdict: 'undeclared',
      integrity: 0,
      integrityPct: 0,
      confidence: branchConfidence(branchB),
      edgeProvenance: branchB.edgeProvenance,
      missingRoles: [],
      counts: { aligned: 0, drifted: 0, declaredOnly: 0, liveOnly: branchB.nodes.length, unverifiable: 0 },
      nodes: branchB.nodes.map((node) => nodeVerdict('live_only', null, node)),
    };
  }

  const nodeVerdicts = [];
  const usedB = new Set();
  let achieved = 0;
  let possible = 0;

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
      const verdict = nodeVerdict('aligned', aNodes[ai], bNode);
      nodeVerdicts.push(verdict);
      const w = nodeWeight(aNodes[ai]);
      possible += w;
      achieved += w;
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
      const verdict = nodeVerdict('drifted', aNode, bNode, bestDeltas);
      nodeVerdicts.push(verdict);
      const w = nodeWeight(aNode);
      possible += w;
      achieved += w * driftCredit(bestDeltas);
    }

    for (const { node: aNode } of remainingA) {
      const verifiable = canVerifyKind(aNode.kind, liveGraph);
      const status = verifiable ? 'declared_only' : 'unverifiable';
      nodeVerdicts.push(nodeVerdict(status, aNode, null));
      if (verifiable) possible += nodeWeight(aNode);
    }
  }

  for (const bNode of branchB?.nodes || []) {
    if (usedB.has(bNode.key)) continue;
    if (aGroups.has(bNode.identityKey)) continue;
    if (isLiveOnlyInferredMetric(bNode, liveGraph)) continue;
    nodeVerdicts.push(nodeVerdict('live_only', null, bNode));
  }

  for (const missing of branchA.missingRoles || []) {
    possible += missing.weight;
  }

  const integrity = possible === 0 ? 1 : round(achieved / possible, 4);
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

  return {
    rootKey: branchA.rootIdentityKey,
    title: branchA.title,
    rootKind: branchA.rootKind,
    hasA: true,
    hasB: !!branchB,
    verdict,
    integrity,
    integrityPct: Math.round(integrity * 100),
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

function nodeVerdict(status, aNode, bNode, deltas = []) {
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
  };
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
  return (liveGraph?.byKind.get(kind)?.size || 0) > 0;
}

function canSatisfyLiveEvidence(bNode, liveGraph) {
  if (!bNode) return false;
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
