// tools/lib/chain-history.mjs
//
// REQUIREMENT-CHAIN VERDICTS OVER TIME — pure helpers over journey run
// records (roadmap step 4, slice 3). A journey run keeps, per requirement
// chain (a branch of the traceability graph), the scored verdict, the
// on-wire ladder verdict and the nodes worth recording — the ones that are
// absent, drifted, undeclared, present-but-unhealthy, present-but-stale,
// or that the vantage could not look at — with their blast radius. These
// helpers build that record from a graph comparison, summarise it for the
// surfaces (the journeys view, `GET /api/journeys`, the CLI), diff two
// consecutive records so a run can say what changed since the previous
// one — the transition a live-pack snapshot is kept for — and, when a
// chain got worse, rank the candidate causes the evidence can offer
// (slice 4, `rankCauses` below).
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

// ---------- candidate causes ranked by evidence (step 4, slice 4) ----------
//
// A chain that got worse asks "what changed?". The ranker answers with
// CANDIDATE causes — what the two run records and Observogram's own deploy
// audit can offer as evidence, scored by how directly it touches the nodes
// that moved — never a root-cause verdict. Four kinds, in tie-break order:
// an Observogram deploy that wrote a degraded artefact inside the window,
// a decision-bearing configuration drift on a degraded node, a backend
// version change on the ruler / TSDB path, and a stack self-metric sample
// that is non-zero in the family feeding the degraded kind. A change of
// the vantage itself — a probe family that stopped answering, fewer tools
// exposed, a vantage lost or regained — is reported SEPARATELY in
// `vantage` and never as a cause: a node the vantage could not look at
// (`unobserved`) generates no cause.

export const CAUSE_KINDS = Object.freeze(['observogram-deploy', 'config-drift', 'backend-version', 'stack-self-metric']);
export const CAUSE_NOTE = 'candidate causes ranked by evidence — not a root-cause verdict';

// Scores by evidence strength. Fixed, so a rank is explainable by reading
// the table; a cause is emitted once per distinct evidence and aggregates
// every chain / node that evidence explains.
export const CAUSE_SCORES = Object.freeze({
  deployTouchedNode: 0.9,     // a deploy item names a node that moved
  deployTouchedPack: 0.6,     // a deploy wrote the journey's pack, no item names a node
  driftDecisionBearing: 0.8,  // drifted on objective / expr / route / … fields
  driftCosmetic: 0.4,         // drifted on cosmetic fields only (or fields not recorded)
  versionOnRulerPath: 0.6,    // a version changed and a backend / metric / rule node moved
  versionElsewhere: 0.3,      // a version changed while a chain got worse
  stackSignal: 0.5,           // a non-zero sample in the family feeding a moved node's kind
});

// Which stack self-metric family (contracts/stack-self-metrics.mjs) feeds
// a node kind — the family whose sample can explain that kind going dark.
// Any `pipeline_*` kind reads collector (familyForKind); kinds outside the
// table (metric, remediation, forecast, chaos) have no family.
export const FAMILY_FOR_KIND = Object.freeze({
  scrape_job: 'scrape',
  recording_rule: 'ruler', burn_rate: 'ruler', sli: 'ruler', slo: 'ruler',
  alert_route: 'notify',
  backend: 'tsdb', storage_metrics: 'tsdb',
  pipeline_receiver: 'collector', pipeline_processor: 'collector', pipeline_exporter_metrics: 'collector', otel: 'collector',
  panel: 'dashboards', dashboard: 'dashboards',
  synthetic: 'synthetic',
});

export function familyForKind(kind) {
  const k = str(kind);
  if (Object.prototype.hasOwnProperty.call(FAMILY_FOR_KIND, k)) return FAMILY_FOR_KIND[k];
  return k.startsWith('pipeline_') ? 'collector' : null;
}

// Same vocabulary as the graph's decision-bearing delta test
// (traceability-graph.mjs) — copied, not imported, so this module stays
// zero-import. A delta on one of these fields changes what the artefact
// decides; anything else is cosmetic.
const DECISION_BEARING_DELTA_RE = /(objective|target|threshold|window|duration|severity|burn|budget|expr|query|promql|expression|condition|sli|slo|metric|record|route|receiver|channel|contact|notification|pager|trigger|pipeline|exporter|backend|signal|good|total|mttd|mttr)/i;

// The kinds on the ruler / TSDB path: a backend version change reaches
// them directly (what the ruler evaluates and the TSDB stores).
const RULER_TSDB_KINDS = Object.freeze(['backend', 'metric', 'recording_rule', 'burn_rate']);

const timeMs = (v) => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const labelOf = (node) => str(node.label) || str(node.key);
const ladderStatusOf = (node) => (isRecord(node.ladder) && node.ladder.status != null ? str(node.ladder.status) : null);
const probeList = (v) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : []);
const formatNumber = (v) => (Number.isInteger(v) ? String(v) : String(parseFloat(v.toPrecision(3))));

// Observogram's own deploy audit lines (server/workspace.mjs writes
// { type: 'deploy', deployId, at, … } and { type: 'verify', deployId, at,
// outcome, … }) restricted to the window (since, until] on `at` — since
// null means everything up to until, until null means no upper bound —
// sorted by `at`. The latest verify of a deploy is merged onto it as
// `verify` (the way the workspace reader does) so evidence can name the
// verify outcome. A record without a parseable `at` cannot be placed in
// a window and is left out; non-objects are ignored.
export function deploysInWindow(deploys, sinceIso, untilIso) {
  const list = Array.isArray(deploys) ? deploys.filter(isRecord) : [];
  const since = timeMs(sinceIso);
  const until = timeMs(untilIso);
  const verifies = new Map();
  for (const rec of list) {
    if (rec.type !== 'verify' || rec.deployId == null) continue;
    const id = str(rec.deployId);
    const prev = verifies.get(id);
    if (!prev || cmp(str(rec.at), str(prev.at)) >= 0) verifies.set(id, rec);
  }
  const out = [];
  for (const rec of list) {
    if (rec.type !== 'deploy') continue;
    const at = timeMs(rec.at);
    if (at === null) continue;
    if (since !== null && at <= since) continue;
    if (until !== null && at > until) continue;
    const verify = rec.deployId != null && !isRecord(rec.verify) ? verifies.get(str(rec.deployId)) : null;
    if (verify) {
      const { type: _type, deployId: _deployId, ...rest } = verify;
      out.push({ ...rec, verify: rest });
    } else {
      out.push(rec);
    }
  }
  return out.sort((a, b) => (timeMs(a.at) - timeMs(b.at)) || cmp(str(a.deployId), str(b.deployId)));
}

// The vantage facts a run record carries — null when it carries none (a
// file-sourced Pack B attempts no probe, reads vantage none and counts no
// tools). A vantage-lost record (written before any probe ran) reads
// vantage 'lost' with nothing attempted.
function vantageFacts(record) {
  if (!isRecord(record)) return null;
  const lost = record.outcome === 'vantage-lost';
  const probes = isRecord(record.probes) ? record.probes : null;
  const attempted = probeList(probes?.attempted);
  const failed = probeList(probes?.failed);
  const unsupported = probeList(probes?.unsupported);
  const tools = num(record.toolsExposedCount);
  const declared = typeof record.vantage === 'string' && record.vantage ? record.vantage : null;
  if (!lost && !attempted.length && tools === null && (declared === null || declared === 'none')) return null;
  return {
    vantage: lost ? 'lost' : (declared || 'none'),
    attempted, failed, unsupported,
    toolsExposedCount: tools,
    errors: isRecord(record.probeErrors) ? record.probeErrors : {},
  };
}

const probeState = (facts, family) => (facts.failed.includes(family) ? 'failed'
  : facts.unsupported.includes(family) ? 'unsupported'
  : facts.attempted.includes(family) ? 'answering' : 'not probed');

// What changed about the vantage itself between two records: the vantage
// word, each probe family's state (answering / failed / not exposed / not
// probed — compared only when both sides probed something, so a vantage
// lost before any probe does not read as every family disappearing) and
// the exposed tool count (compared only when both sides counted). null
// when neither side carries vantage facts.
function vantageChange(previous, current) {
  const p = vantageFacts(previous);
  const c = vantageFacts(current);
  if (!p && !c) return null;
  const snapshot = (f) => (f ? { vantage: f.vantage, failed: f.failed, unsupported: f.unsupported, toolsExposedCount: f.toolsExposedCount } : null);
  const bits = [];
  const pv = p ? p.vantage : 'none';
  const cv = c ? c.vantage : 'none';
  if (pv !== cv) bits.push(`vantage ${pv} → ${cv}`);
  if (p && c && p.attempted.length && c.attempted.length) {
    const families = [...new Set([...p.attempted, ...p.failed, ...p.unsupported, ...c.attempted, ...c.failed, ...c.unsupported])].sort();
    for (const family of families) {
      const from = probeState(p, family);
      const to = probeState(c, family);
      if (from === to) continue;
      if (to === 'failed') bits.push(`probe family ${family} newly failed${c.errors[family] != null && str(c.errors[family]) ? ` (${str(c.errors[family])})` : ''}`);
      else if (to === 'unsupported') bits.push(`probe family ${family} no longer exposed`);
      else if (to === 'not probed') bits.push(`probe family ${family} no longer probed`);
      else bits.push(from === 'failed' ? `probe family ${family} answers again` : `probe family ${family} now exposed`);
    }
  }
  const pt = p ? p.toolsExposedCount : null;
  const ct = c ? c.toolsExposedCount : null;
  if (pt !== null && ct !== null && pt !== ct) bits.push(`${pt} → ${ct} MCP tools exposed`);
  return { changed: bits.length > 0, from: snapshot(p), to: snapshot(c), detail: bits.length ? bits.join(' · ') : null };
}

// The degraded nodes of a chain that got worse which the record can say
// moved: new on the current side, or the same identity with a different
// status / ladder status. When the record cannot say which moved (caps, a
// role lost), every degraded node of the chain is considered. Unobserved
// nodes are dropped LAST, so a chain whose only movement is the vantage
// looking away yields no node — that is a vantage change, never a cause.
function movedNodes(currentBranch, previousBranch) {
  const cur = degradedOf(currentBranch);
  let moved = cur;
  if (previousBranch) {
    const before = new Map(degradedOf(previousBranch).map((n) => [nodeIdentity(n), n]));
    moved = cur.filter((n) => {
      const b = before.get(nodeIdentity(n));
      return !b || str(b.status) !== str(n.status) || ladderStatusOf(b) !== ladderStatusOf(n);
    });
    if (!moved.length) moved = cur;
  }
  return moved.filter((n) => ladderStatusOf(n) !== 'unobserved');
}

const isBrokenOrDegraded = (b) => ['partial', 'broken'].includes(str(b.verdict)) || ['degraded', 'broken'].includes(str(b.ladderVerdict));

// The chains whose transition reads worse (plus chains that appeared
// already partial / broken / degraded), each with the nodes it can blame,
// in the current record's order.
function worseChains(transitions, previous, current) {
  if (!transitions) return [];
  const cur = branchesOf(current) || [];
  const prevByKey = new Map();
  for (const b of branchesOf(previous) || []) if (!prevByKey.has(str(b.rootKey))) prevByKey.set(str(b.rootKey), b);
  const curByKey = new Map();
  const order = new Map();
  cur.forEach((b, i) => { if (!curByKey.has(str(b.rootKey))) { curByKey.set(str(b.rootKey), b); order.set(str(b.rootKey), i); } });
  const out = [];
  for (const c of transitions.changed) {
    const branch = curByKey.get(c.rootKey);
    if (c.direction === 'worse' && branch) out.push({ rootKey: c.rootKey, branch, nodes: movedNodes(branch, prevByKey.get(c.rootKey)) });
  }
  for (const key of transitions.appeared) {
    const branch = curByKey.get(key);
    if (branch && isBrokenOrDegraded(branch)) out.push({ rootKey: key, branch, nodes: movedNodes(branch, null) });
  }
  return out.sort((a, b) => (order.get(a.rootKey) ?? 0) - (order.get(b.rootKey) ?? 0));
}

// Does a deploy item's `artifact` name this node? The artefact id recorded
// on the node (aId / bId, when the node carries one) matches exactly;
// otherwise the node's label or key contains the artifact
// case-insensitively (a `dash:` prefix is dropped first). Only that
// direction: an artifact selector is at least as specific as a label, and
// the reverse would let a rule deploy blame every SLI whose short name it
// embeds. The group wildcard 'all' and stubs shorter than three characters
// name nothing — they would match everything.
function artifactMatches(artifact, node) {
  const a = str(artifact).trim();
  if (!a || a.toLowerCase() === 'all') return false;
  const ids = [node.aId, node.bId].map((v) => str(v)).filter(Boolean);
  if (ids.includes(a)) return true;
  const needle = (a.toLowerCase().startsWith('dash:') ? a.slice(5) : a).toLowerCase();
  if (needle.length < 3) return false;
  return [str(node.label), str(node.key)].some((s) => s.toLowerCase().includes(needle));
}

function packMatches(deploy, current) {
  const packA = isRecord(current?.packA) ? current.packA : null;
  const mine = [packA?.name, packA?.id].map((v) => str(v).toLowerCase()).filter(Boolean);
  const theirs = isRecord(deploy.pack) ? [deploy.pack.id, deploy.pack.name].map((v) => str(v).toLowerCase()).filter(Boolean) : [];
  return mine.some((m) => theirs.includes(m));
}

function deployEvidence(deploy, touched) {
  const head = `deploy ${str(deploy.deployId) || '?'} by ${str(deploy.actor) || 'unknown actor'} at ${str(deploy.at) || '?'}`
    + ` (${str(deploy.mode) || 'deploy'}${deploy.rollbackOf ? `, rollback of ${str(deploy.rollbackOf)}` : ''})`;
  const tail = touched.length
    ? ` touched ${touched.join(', ')}`
    : ` wrote pack ${str(deploy.pack?.id) || str(deploy.pack?.name) || '?'} — no item names a degraded artefact`;
  const verify = isRecord(deploy.verify) && deploy.verify.outcome != null ? `; verify: ${str(deploy.verify.outcome)}` : '';
  return head + tail + verify;
}

// Products whose reported version differs between the two records. Only a
// product both sides reported can have changed: a version that appears or
// disappears is a vantage matter, not a change.
function versionChanges(previous, current) {
  const p = isRecord(previous?.versions) ? previous.versions : null;
  const c = isRecord(current?.versions) ? current.versions : null;
  if (!p || !c) return [];
  return Object.keys(c).sort()
    .filter((k) => Object.prototype.hasOwnProperty.call(p, k) && str(p[k]) && str(c[k]) && str(p[k]) !== str(c[k]))
    .map((k) => ({ product: k, from: str(p[k]), to: str(c[k]) }));
}

// Stack rows of the current record that read as a signal: answered data
// and non-zero on a lower-is-comfortable row (the fetcher's `nonzero`
// hint, or the direction and value say so), or below 1 on a
// higher-is-comfortable ratio row.
function stackSignalRows(current) {
  const rows = isRecord(current?.stackEvidence) && Array.isArray(current.stackEvidence.rows) ? current.stackEvidence.rows.filter(isRecord) : [];
  return rows.filter((r) => r.outcome === 'data' && typeof r.value === 'number' && Number.isFinite(r.value)
    && (r.hint === 'nonzero' || (r.direction === 'lower' && r.value > 0) || (r.direction === 'higher' && r.unit === 'ratio' && r.value < 1)));
}

// Rank the candidate causes of the chains that got worse between two
// consecutive run records. `deploys` are Observogram's own deploy records
// for the window (deploysInWindow) — a verify-type record or a dry run
// changed nothing on the wire and is skipped. Returns
//   { transitions, causes: [{ rank, kind, score, evidence, chains, nodes }], vantage, note }
// with causes sorted by score desc, then CAUSE_KINDS order, then evidence;
// `chains` are root keys in the current record's order, `nodes` the labels
// the evidence explains. `causes` is [] when no chain got worse or nothing
// moved but the vantage; `transitions` is null when either record carries
// no chains. Pure and deterministic; malformed input never throws.
export function rankCauses({ previous, current, deploys = [] } = {}) {
  const transitions = diffRunBranches(previous, current);
  const worse = worseChains(transitions, previous, current).filter((w) => w.nodes.length);
  const considered = [];
  for (const w of worse) for (const node of w.nodes) considered.push({ node, rootKey: w.rootKey });
  const chainOrder = new Map();
  (branchesOf(current) || []).forEach((b, i) => { if (!chainOrder.has(str(b.rootKey))) chainOrder.set(str(b.rootKey), i); });

  const acc = new Map();
  const add = (kind, score, evidence, rootKeys, labels) => {
    const id = `${kind} ${evidence}`;
    const entry = acc.get(id) || { kind, score, evidence, chains: new Set(), nodes: new Set() };
    entry.score = Math.max(entry.score, score);
    for (const k of rootKeys) entry.chains.add(k);
    for (const l of labels) if (l) entry.nodes.add(l);
    acc.set(id, entry);
  };

  if (considered.length) {
    // observogram-deploy: an item that names a moved node, else the pack.
    for (const deploy of (Array.isArray(deploys) ? deploys : []).filter(isRecord)) {
      if ((deploy.type !== undefined && deploy.type !== 'deploy') || deploy.dryRun === true) continue;
      const touched = [];
      const keys = [];
      const labels = [];
      for (const item of (Array.isArray(deploy.items) ? deploy.items : []).filter(isRecord)) {
        for (const { node, rootKey } of considered) {
          if (!artifactMatches(item.artifact, node)) continue;
          const name = `${str(item.artifact)}${item.ok === false ? ' (failed)' : ''}`;
          if (!touched.includes(name)) touched.push(name);
          keys.push(rootKey);
          labels.push(labelOf(node));
        }
      }
      if (touched.length) add('observogram-deploy', CAUSE_SCORES.deployTouchedNode, deployEvidence(deploy, touched), keys, labels);
      else if (packMatches(deploy, current)) add('observogram-deploy', CAUSE_SCORES.deployTouchedPack, deployEvidence(deploy, []), worse.map((w) => w.rootKey), []);
    }
    // config-drift: a moved node that drifted, by what it drifted on.
    for (const { node, rootKey } of considered) {
      if (str(node.status) !== 'drifted') continue;
      const fields = (Array.isArray(node.deltaFields) ? node.deltaFields : []).map((f) => str(f)).filter(Boolean);
      const decision = fields.filter((f) => DECISION_BEARING_DELTA_RE.test(f));
      const evidence = `${labelOf(node)} (${str(node.kind, 'unknown')}) drifted on ${fields.length ? fields.join(', ') : 'fields not recorded'}`
        + (decision.length ? ` — decision-bearing: ${decision.join(', ')}` : ' — cosmetic only');
      add('config-drift', decision.length ? CAUSE_SCORES.driftDecisionBearing : CAUSE_SCORES.driftCosmetic, evidence, [rootKey], [labelOf(node)]);
    }
    // backend-version: a product's version moved between the two runs.
    const rulerPath = considered.filter(({ node }) => RULER_TSDB_KINDS.includes(str(node.kind)));
    for (const change of versionChanges(previous, current)) {
      const evidence = `${change.product} ${change.from} → ${change.to}`;
      if (rulerPath.length) add('backend-version', CAUSE_SCORES.versionOnRulerPath, evidence, rulerPath.map((x) => x.rootKey), rulerPath.map((x) => labelOf(x.node)));
      else add('backend-version', CAUSE_SCORES.versionElsewhere, evidence, worse.map((w) => w.rootKey), []);
    }
    // stack-self-metric: a non-zero sample in the family feeding a moved kind.
    for (const row of stackSignalRows(current)) {
      const family = str(row.family);
      const hits = considered.filter(({ node }) => family && familyForKind(node.kind) === family);
      if (!hits.length) continue;
      const evidence = `${str(row.id)} = ${formatNumber(row.value)}${row.unit ? ` ${str(row.unit)}` : ''} (${family}) — point-in-time sample`;
      add('stack-self-metric', CAUSE_SCORES.stackSignal, evidence, hits.map((x) => x.rootKey), hits.map((x) => labelOf(x.node)));
    }
  }

  const byChainOrder = (a, b) => ((chainOrder.get(a) ?? Infinity) - (chainOrder.get(b) ?? Infinity)) || cmp(a, b);
  const causes = [...acc.values()]
    .map((c) => ({ kind: c.kind, score: c.score, evidence: c.evidence, chains: [...c.chains].sort(byChainOrder), nodes: [...c.nodes].sort(cmp) }))
    .sort((a, b) => (b.score - a.score) || (CAUSE_KINDS.indexOf(a.kind) - CAUSE_KINDS.indexOf(b.kind)) || cmp(a.evidence, b.evidence))
    .map((c, i) => ({ rank: i + 1, ...c }));
  return { transitions, causes, vantage: vantageChange(previous, current), note: CAUSE_NOTE };
}

// The rank-1 candidate cause of a run record (its `causes` block, as
// runJourney stores it) or of a rankCauses result; null when there is none.
export function topCause(record) {
  const box = isRecord(record) ? record.causes : null;
  const list = Array.isArray(box) ? box : (isRecord(box) && Array.isArray(box.causes) ? box.causes : null);
  const first = list ? list.find(isRecord) : null;
  return first && CAUSE_KINDS.includes(first.kind) ? first : null;
}
