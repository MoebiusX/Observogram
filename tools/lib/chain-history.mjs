// tools/lib/chain-history.mjs
//
// REQUIREMENT-CHAIN VERDICTS OVER TIME — pure helpers over journey run
// records (roadmap step 4, slice 3). A journey run keeps, per requirement
// chain (a branch of the traceability graph), the scored verdict, the
// on-wire ladder verdict and the nodes worth recording — the ones that are
// absent, drifted, undeclared, present-but-unhealthy, present-but-stale,
// or that the vantage could not look at — with their blast radius. These
// helpers build that record from a graph comparison, summarise it for the
// surfaces (the journeys view, `GET /api/journeys`, the CLI) and diff two
// consecutive records so a run can say what changed since the previous
// one — the transition a live-pack snapshot is kept for.
//
// THESIS LINE: nothing here scores. `verdict`, `integrityPct` and the node
// `status` are copied from the graph verbatim; the ladder fields ride
// beside them (docs/SCORING_PROPOSAL_LADDER_INTEGRITY.md). A transition
// is a change between two point-in-time observations, never a cause; the
// honesty vocabulary is kept: `unobserved` means the vantage could not
// look, never "absent".
//
// Zero-import by construction (vendorable verbatim — docs/VENDORING.md):
// no Node APIs, no environment, no state. Every function is pure,
// deterministic and tolerant of malformed input — it never throws.

// The node statuses and ladder statuses worth recording on a run: a node
// is "degraded" when its scored status is one of `node` OR its ladder
// status is one of `ladder`. Aligned nodes whose ladder is healthy, and
// `unverifiable` nodes (not live-introspectable from any MCP — an honest
// blind spot of the vantage, not a degradation), are not recorded.
export const DEGRADED_STATUSES = Object.freeze({
  node: Object.freeze(['declared_only', 'drifted', 'live_only']),
  ladder: Object.freeze(['present_unhealthy', 'present_stale', 'unobserved']),
});

export const BRANCH_RECORD_CAPS = Object.freeze({ maxBranches: 64, maxNodes: 16, maxDeltaFields: 6 });

// Verdict rank tables for `diffRunBranches`: intact/healthy best →
// partial/degraded → unobserved → broken worst. `undeclared` has no rank
// (a live-only chain is neither better nor worse than a declared one).
export const VERDICT_RANK = Object.freeze({ intact: 0, partial: 1, broken: 3 });
export const LADDER_VERDICT_RANK = Object.freeze({ healthy: 0, degraded: 1, unobserved: 2, broken: 3 });

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, fallback = '') => (typeof v === 'string' ? v : (v == null ? fallback : String(v)));
const num = (v, fallback = null) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function isDegradedNode(node) {
  if (!isRecord(node)) return false;
  if (DEGRADED_STATUSES.node.includes(node.status)) return true;
  const ladderStatus = isRecord(node.ladder) ? node.ladder.status : null;
  return DEGRADED_STATUSES.ladder.includes(ladderStatus);
}

// Worst-first severity of a degraded node: absent (declared, not on the
// wire), present but unhealthy, present but stale, drifted, unobserved
// (the vantage could not look — reported after the wire's own findings),
// live-only (an undeclared artefact — exposure, not a loss).
export function degradedSeverity(node) {
  const status = isRecord(node) ? node.status : null;
  const ladderStatus = isRecord(node) && isRecord(node.ladder) ? node.ladder.status : null;
  if (status === 'declared_only' && !DEGRADED_STATUSES.ladder.includes(ladderStatus)) return 0;
  if (ladderStatus === 'present_unhealthy') return 1;
  if (ladderStatus === 'present_stale') return 2;
  if (status === 'drifted') return 3;
  if (ladderStatus === 'unobserved') return 4;
  if (status === 'live_only') return 5;
  return 6;
}

function blastSummary(radius) {
  if (!isRecord(radius)) return null;
  const out = {};
  for (const k of ['slos', 'alerts', 'panels', 'dashboards', 'routes', 'remediations', 'total']) out[k] = num(radius[k], 0);
  return out;
}

function ladderOf(node) {
  const ladder = isRecord(node) ? node.ladder : null;
  if (!isRecord(ladder)) return null;
  return {
    rung: ladder.rung == null ? null : str(ladder.rung),
    status: ladder.status == null ? null : str(ladder.status),
    detail: ladder.detail == null ? null : str(ladder.detail),
  };
}

function degradedNodeRecord(node, maxDeltaFields) {
  const fields = [];
  for (const delta of Array.isArray(node.deltas) ? node.deltas : []) {
    const field = isRecord(delta) ? str(delta.field) : str(delta);
    if (field && !fields.includes(field)) fields.push(field);
    if (fields.length >= maxDeltaFields) break;
  }
  return {
    key: str(node.key),
    kind: str(node.kind, 'unknown'),
    label: str(node.label),
    status: str(node.status),
    ladder: ladderOf(node),
    blastRadius: blastSummary(node.blastRadius),
    deltaFields: fields,
  };
}

function compareDegraded(a, b) {
  return degradedSeverity(a) - degradedSeverity(b)
    || (num(b.blastRadius?.total, 0) - num(a.blastRadius?.total, 0))
    || cmp(str(a.label), str(b.label))
    || cmp(str(a.key), str(b.key));
}

function missingRoleNames(roles) {
  return (Array.isArray(roles) ? roles : [])
    .map((r) => (isRecord(r) ? str(r.role || r.kind || r.label) : str(r)))
    .filter(Boolean);
}

// The per-branch record kept on a run: identity + verdicts + the degraded
// nodes, worst first (severity, then blast-radius total desc, then label).
// Branches keep the graph's order. `maxNodes` caps each branch's degraded
// list and `maxBranches` the branch list; a cut list carries
// `truncated: true` (on the branch for its nodes, on the returned array for
// the branches — the array marker is in-memory only: JSON drops it, so a
// persisted record of exactly `maxBranches` branches may have been cut).
// [] when the graph has no branches.
export function branchRecordsFromGraph(traceabilityGraph, { maxBranches = BRANCH_RECORD_CAPS.maxBranches, maxNodes = BRANCH_RECORD_CAPS.maxNodes } = {}) {
  const branches = isRecord(traceabilityGraph) && Array.isArray(traceabilityGraph.branches) ? traceabilityGraph.branches.filter(isRecord) : [];
  const branchCap = Math.max(0, Math.floor(num(maxBranches, BRANCH_RECORD_CAPS.maxBranches)));
  const nodeCap = Math.max(0, Math.floor(num(maxNodes, BRANCH_RECORD_CAPS.maxNodes)));
  const out = [];
  for (const branch of branches.slice(0, branchCap)) {
    const degraded = (Array.isArray(branch.nodes) ? branch.nodes : [])
      .filter(isDegradedNode)
      .map((node) => degradedNodeRecord(node, BRANCH_RECORD_CAPS.maxDeltaFields))
      .sort(compareDegraded);
    const record = {
      rootKey: str(branch.rootKey),
      title: str(branch.title),
      rootKind: str(branch.rootKind, 'unknown'),
      verdict: str(branch.verdict, 'unknown'),
      ladderVerdict: str(branch.ladderVerdict, 'unknown'),
      integrityPct: num(branch.integrityPct, 0),
      ladderIntegrityPct: num(branch.ladderIntegrityPct, 0),
      confidence: str(branch.confidence, 'declared'),
      missingRoles: missingRoleNames(branch.missingRoles),
      degraded: degraded.slice(0, nodeCap),
    };
    if (degraded.length > nodeCap) record.truncated = true;
    out.push(record);
  }
  if (branches.length > branchCap) out.truncated = true;
  return out;
}

const branchesOf = (record) => (isRecord(record) && Array.isArray(record.branches) ? record.branches.filter(isRecord) : null);
const degradedOf = (branch) => (Array.isArray(branch.degraded) ? branch.degraded.filter(isRecord) : []);

// The summary a listing shows per journey — counts by verdict and ladder
// verdict over the declared chains, the mean integrities, how many nodes
// are degraded and the one degraded node with the widest exposure (most
// SLOs, then alerts, then total — null when no degraded node would blind an
// SLO or an alert). Integrities are means of the recorded per-branch
// percentages (null with no declared chain: an empty set is not 100 %
// healthy). null when the record carries no `branches`.
export function chainSummary(record) {
  const branches = branchesOf(record);
  if (!branches) return null;
  const declared = branches.filter((b) => b.verdict !== 'undeclared');
  const count = (list, field, value) => list.filter((b) => b[field] === value).length;
  const mean = (field) => (declared.length ? Math.round(declared.reduce((s, b) => s + num(b[field], 0), 0) / declared.length) : null);
  let degradedNodes = 0;
  let top = null;
  const better = (a, b) => (a.slos - b.slos) || (a.alerts - b.alerts) || (a.total - b.total) || cmp(b.label, a.label) || cmp(b.kind, a.kind);
  for (const branch of branches) {
    for (const node of degradedOf(branch)) {
      degradedNodes++;
      const radius = blastSummary(node.blastRadius);
      if (!radius || (radius.slos <= 0 && radius.alerts <= 0)) continue;
      const candidate = { label: str(node.label), kind: str(node.kind, 'unknown'), slos: radius.slos, alerts: radius.alerts, total: radius.total };
      if (!top || better(candidate, top) > 0) top = candidate;
    }
  }
  return {
    declaredTotal: declared.length,
    intact: count(declared, 'verdict', 'intact'),
    partial: count(declared, 'verdict', 'partial'),
    broken: count(declared, 'verdict', 'broken'),
    undeclared: branches.length - declared.length,
    ladder: {
      healthy: count(declared, 'ladderVerdict', 'healthy'),
      degraded: count(declared, 'ladderVerdict', 'degraded'),
      broken: count(declared, 'ladderVerdict', 'broken'),
      unobserved: count(declared, 'ladderVerdict', 'unobserved'),
    },
    integrityPct: mean('integrityPct'),
    ladderIntegrityPct: mean('ladderIntegrityPct'),
    degradedNodes,
    topExposure: top ? { label: top.label, kind: top.kind, slos: top.slos, alerts: top.alerts } : null,
  };
}

// Direction of a verdict pair change on the rank tables: 'worse' when no
// rank improved and one got worse, 'better' the mirror, 'changed' when the
// two moved against each other or either side is undeclared / unknown.
export function transitionDirection(from, to) {
  const rank = (table, v) => (Object.prototype.hasOwnProperty.call(table, v) ? table[v] : null);
  const fv = rank(VERDICT_RANK, from?.verdict), tv = rank(VERDICT_RANK, to?.verdict);
  const fl = rank(LADDER_VERDICT_RANK, from?.ladderVerdict), tl = rank(LADDER_VERDICT_RANK, to?.ladderVerdict);
  if (fv === null || tv === null || fl === null || tl === null) return 'changed';
  const dv = tv - fv, dl = tl - fl;
  if (dv >= 0 && dl >= 0 && (dv > 0 || dl > 0)) return 'worse';
  if (dv <= 0 && dl <= 0 && (dv < 0 || dl < 0)) return 'better';
  return 'changed';
}

const nodeIdentity = (node) => str(node.key) || str(node.label);

// What changed between two consecutive run records' chains. A chain is
// `changed` when its verdict or ladder verdict differs; `appeared` /
// `disappeared` list root keys present on one side only; `any` is true
// when anything moved. Node lists name the degraded nodes that are new on
// the current side / gone from the previous side of a changed chain.
// null when either record carries no `branches` (a vantage-lost or
// pre-chain record cannot be compared). Order follows the current record.
export function diffRunBranches(previous, current) {
  const prev = branchesOf(previous);
  const cur = branchesOf(current);
  if (!prev || !cur) return null;
  const prevByKey = new Map();
  for (const b of prev) if (!prevByKey.has(str(b.rootKey))) prevByKey.set(str(b.rootKey), b);
  const curKeys = new Set();
  const changed = [];
  const appeared = [];
  for (const b of cur) {
    const key = str(b.rootKey);
    if (curKeys.has(key)) continue;
    curKeys.add(key);
    const before = prevByKey.get(key);
    if (!before) { appeared.push(key); continue; }
    const from = { verdict: str(before.verdict, 'unknown'), ladderVerdict: str(before.ladderVerdict, 'unknown') };
    const to = { verdict: str(b.verdict, 'unknown'), ladderVerdict: str(b.ladderVerdict, 'unknown') };
    if (from.verdict === to.verdict && from.ladderVerdict === to.ladderVerdict) continue;
    const beforeNodes = new Map(degradedOf(before).map((n) => [nodeIdentity(n), n]));
    const afterNodes = new Map(degradedOf(b).map((n) => [nodeIdentity(n), n]));
    changed.push({
      rootKey: key,
      title: str(b.title) || str(before.title),
      from,
      to,
      direction: transitionDirection(from, to),
      nodes: {
        newlyDegraded: [...afterNodes].filter(([id]) => !beforeNodes.has(id)).map(([, n]) => str(n.label) || str(n.key)),
        recovered: [...beforeNodes].filter(([id]) => !afterNodes.has(id)).map(([, n]) => str(n.label) || str(n.key)),
      },
    });
  }
  const disappeared = [...prevByKey.keys()].filter((key) => !curKeys.has(key));
  return {
    // The previous record's start time, so a surface can say "since when".
    since: typeof previous.startedAt === 'string' ? previous.startedAt : null,
    changed,
    appeared,
    disappeared,
    any: changed.length > 0 || appeared.length > 0 || disappeared.length > 0,
  };
}
