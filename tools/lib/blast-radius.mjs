// tools/lib/blast-radius.mjs
//
// Blind-spot blast radius over the requirement-rooted traceability graph.
//
// Thesis. Observogram monitors the artefacts that monitor the system. When
// one of them dies — a scrape job stops, a recording rule fails, a route is
// deleted — every artefact that consumes its assurance goes blind with it.
// The blast radius of a node is the set of reliability commitments (SLOs),
// detections (alerts), views (panels, dashboards) and responses (routes,
// remediations) that would go blind, transitively, if that node died.
//
// Consumer table. Assurance flows along the declared edges; the consumer is
// the side that goes blind when the other side dies. For every edge type the
// consumer is the `from` side, except `materialises`, where the SLI consumes
// the recording rule's series:
//
//   edge type     from -> to                        consumer
//   sli_of        slo -> sli                        from  (the SLO consumes its SLI)
//   materialises  recording_rule -> sli             to    (the SLI consumes the rule's series)
//   sources       sli | recording_rule -> metric    from
//   exported_by   metric -> scrape_job | exporter   from
//   produced_by   metric -> backend                 from
//   protects      burn_rate -> slo                  from  (the alert consumes the SLO's data path)
//   forecasts     forecast -> slo                   from
//   visualises    panel -> sli | slo                from
//   contains      dashboard -> panel                from
//   routes        alert_route -> burn_rate          from
//   remediates    remediation -> burn_rate          from
//   validates     chaos | synthetic -> slo          from
//
// Protection is a second, separate relation. The `to` side LOSES when the
// `from` side dies: an SLO loses its protection when its alert dies
// (protects), an alert loses delivery when its route dies (routes) and loses
// its remediation when the remediation dies (remediates). It is transitive —
// a dead route means an undelivered alert means an unprotected SLO.
//
// Honesty rule. A blast radius is structural exposure computed from declared
// edges. It says what WOULD go blind if a node died — never that something IS
// blind. Liveness is a separate observation; this module never reads it.
// Edge types outside the table carry no known direction and are ignored.
// Scaffold placeholders (schema-forced stand-ins the crawler or the live
// fetcher had to invent) never blind anything, are never traversed and are
// never listed.
//
// Zero-import on purpose: downstream studios vendor this file verbatim
// (docs/VENDORING.md). Inputs are explicit; no Node APIs, no environment.

// Which side of an edge consumes the other side's assurance.
export const CONSUMER_SIDE = Object.freeze({
  sli_of: 'from',
  materialises: 'to',
  sources: 'from',
  exported_by: 'from',
  produced_by: 'from',
  protects: 'from',
  forecasts: 'from',
  visualises: 'from',
  contains: 'from',
  routes: 'from',
  remediates: 'from',
  validates: 'from',
});

// Which side of an edge LOSES protection / delivery / remediation when the
// other side dies.
export const PROTECTION_SIDE = Object.freeze({
  protects: 'to',
  routes: 'to',
  remediates: 'to',
});

// Listing order for blinded nodes of equal hop distance; kinds outside the
// table follow, alphabetically.
export const KIND_ORDER = Object.freeze([
  'slo',
  'sli',
  'burn_rate',
  'recording_rule',
  'metric',
  'scrape_job',
  'backend',
  'alert_route',
  'remediation',
  'forecast',
  'panel',
  'dashboard',
  'chaos',
  'synthetic',
]);

// A copy of the traceability graph's limb weights (LIMB_WEIGHTS in
// tools/lib/traceability-graph.mjs); an unknown kind weighs 0.5.
export const DEFAULT_WEIGHTS = Object.freeze({
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
});

export const UNKNOWN_KIND_WEIGHT = 0.5;

// `blinded.nodes` is a listing, not the count: it is capped here after
// sorting; `blinded.total` and `blinded.byKind` stay uncapped.
export const BLINDED_NODES_CAP = 64;

// Accepts `{ nodes, edges }` where `nodes` is an Array of plain nodes, a Map
// keyed by node key, or an object keyed by node key. A node needs at least a
// `key` and a `kind`; `identityKey`, `layer`, `label`, `virtual` and
// `scaffold` are optional (a node whose `artefact.source === 'Scaffold'` is
// scaffold too). Edges lacking `from`, `to` or `type` are dropped.
export function normalizeGraphShape(input) {
  const nodes = new Map();
  for (const [fallbackKey, raw] of nodeEntries(input?.nodes)) {
    const node = normalizeNode(raw, fallbackKey);
    if (node) nodes.set(node.key, node);
  }
  const edges = [];
  for (const edge of Array.isArray(input?.edges) ? input.edges : []) {
    if (!edge || typeof edge !== 'object') continue;
    const from = str(edge.from);
    const to = str(edge.to);
    const type = str(edge.type);
    if (!from || !to || !type) continue;
    edges.push({
      key: str(edge.key) || `${type}:${from}->${to}`,
      from,
      to,
      type,
      provenance: str(edge.provenance) || null,
    });
  }
  return { nodes, edges };
}

// The blast radius of one node: what would go blind (transitive consumers)
// and what would lose protection (transitive protection losers) if it died.
// `null` for an unknown key.
export function blastRadiusOf(shape, key, { weights } = {}) {
  const prepared = prepare(normalizeGraphShape(shape));
  if (typeof key !== 'string' || !prepared.nodes.has(key)) return null;
  return radius(prepared, key, weightTable(weights));
}

// Map key -> summary for every non-scaffold node, in sorted key order.
export function blastRadiusIndex(shape, { weights } = {}) {
  const prepared = prepare(normalizeGraphShape(shape));
  const table = weightTable(weights);
  const out = new Map();
  for (const key of [...prepared.nodes.keys()].sort(cmp)) {
    if (prepared.nodes.get(key).scaffold) continue;
    out.set(key, radius(prepared, key, table).summary);
  }
  return out;
}

// ---------------------------------------------------------------------------

function radius(prepared, key, table) {
  const { nodes } = prepared;
  const origin = nodes.get(key);
  // A placeholder never existed as a monitoring artefact: its death blinds
  // nothing, and its listing is empty rather than null (the key is known).
  const blindedHops = origin.scaffold ? new Map() : walk(prepared.consumers, nodes, key);
  const lostHops = origin.scaffold ? new Map() : walk(prepared.losers, nodes, key);

  const blindedNodes = [...blindedHops]
    .map(([nodeKey, hop]) => listing(nodes.get(nodeKey), hop))
    .sort(compareListing);
  const counts = {};
  let weight = 0;
  for (const node of blindedNodes) {
    counts[node.kind] = (counts[node.kind] || 0) + 1;
    weight += table[node.kind] ?? UNKNOWN_KIND_WEIGHT;
  }
  const byKind = {};
  for (const kind of Object.keys(counts).sort(compareKinds)) byKind[kind] = counts[kind];

  // Protection losers are walked through blinded nodes (a blind alert
  // protects nothing either) but only nodes not already blinded are listed.
  const unprotectedNodes = [...lostHops]
    .filter(([nodeKey]) => !blindedHops.has(nodeKey))
    .map(([nodeKey, hop]) => listing(nodes.get(nodeKey), hop))
    .sort(compareListing);
  const slos = unprotectedNodes.filter((node) => node.kind === 'slo').map(unprotectedEntry);
  const alerts = unprotectedNodes.filter((node) => node.kind === 'burn_rate').map(unprotectedEntry);

  const summary = {
    slos: (counts.slo || 0) + slos.length,
    alerts: (counts.burn_rate || 0) + alerts.length,
    panels: counts.panel || 0,
    dashboards: counts.dashboard || 0,
    routes: counts.alert_route || 0,
    remediations: counts.remediation || 0,
    total: blindedNodes.length + slos.length + alerts.length,
  };

  return {
    key,
    kind: origin.kind,
    label: origin.label,
    blinded: {
      total: blindedNodes.length,
      weight: round(weight, 4),
      byKind,
      nodes: blindedNodes.slice(0, BLINDED_NODES_CAP),
    },
    unprotected: { slos, alerts },
    summary,
  };
}

// Reverse adjacency: for every node, who goes blind (consumers) and who
// loses protection (losers) when it dies. Edges whose endpoints are unknown
// or whose type carries no known direction are ignored.
function prepare(shape) {
  const { nodes, edges } = shape;
  const consumers = new Map();
  const losers = new Map();
  for (const edge of edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    const consumer = CONSUMER_SIDE[edge.type];
    if (consumer === 'from') link(consumers, edge.to, edge.from);
    else if (consumer === 'to') link(consumers, edge.from, edge.to);
    const loser = PROTECTION_SIDE[edge.type];
    if (loser === 'to') link(losers, edge.from, edge.to);
    else if (loser === 'from') link(losers, edge.to, edge.from);
  }
  return { nodes, consumers, losers };
}

// Breadth-first over a reverse adjacency: Map key -> hop distance from the
// origin, origin excluded. Cycle-safe (a node is visited once); scaffold
// nodes are neither recorded nor expanded.
function walk(adjacency, nodes, origin) {
  const hops = new Map();
  const visited = new Set([origin]);
  let frontier = [origin];
  let hop = 0;
  while (frontier.length) {
    hop += 1;
    const next = [];
    for (const key of frontier) {
      for (const dependant of adjacency.get(key) || []) {
        if (visited.has(dependant)) continue;
        visited.add(dependant);
        if (nodes.get(dependant)?.scaffold) continue;
        hops.set(dependant, hop);
        next.push(dependant);
      }
    }
    frontier = next;
  }
  return hops;
}

function listing(node, hop) {
  return { key: node.key, kind: node.kind, label: node.label, hop };
}

function unprotectedEntry({ key, label, hop }) {
  return { key, label, hop };
}

function compareListing(a, b) {
  return (a.hop - b.hop)
    || compareKinds(a.kind, b.kind)
    || cmp(a.label, b.label)
    || cmp(a.key, b.key);
}

function compareKinds(a, b) {
  return (kindRank(a) - kindRank(b)) || cmp(a, b);
}

function kindRank(kind) {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

function weightTable(weights) {
  return weights && typeof weights === 'object' ? { ...DEFAULT_WEIGHTS, ...weights } : DEFAULT_WEIGHTS;
}

function nodeEntries(nodes) {
  if (nodes instanceof Map) return [...nodes.entries()];
  if (Array.isArray(nodes)) return nodes.map((node) => [null, node]);
  if (nodes && typeof nodes === 'object') return Object.entries(nodes);
  return [];
}

function normalizeNode(raw, fallbackKey) {
  if (!raw || typeof raw !== 'object') return null;
  const key = str(raw.key) || str(fallbackKey);
  const kind = str(raw.kind);
  if (!key || !kind) return null;
  const identityKey = str(raw.identityKey) || key;
  return {
    key,
    identityKey,
    kind,
    layer: raw.layer == null ? null : String(raw.layer),
    label: str(raw.label) || labelFromArtefact(raw.artefact) || identityKey,
    virtual: raw.virtual === true,
    scaffold: raw.scaffold === true || raw.artefact?.source === 'Scaffold',
  };
}

function labelFromArtefact(artefact) {
  if (!artefact || typeof artefact !== 'object') return '';
  return str(artefact.title) || str(artefact.spec?.id) || str(artefact.spec?.name) || str(artefact.id) || '';
}

function link(map, from, to) {
  if (from === to) return;
  if (!map.has(from)) map.set(from, new Set());
  map.get(from).add(to);
}

function str(value) {
  return typeof value === 'string' ? value : '';
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function round(value, places) {
  const mult = 10 ** places;
  return Math.round(value * mult) / mult;
}
