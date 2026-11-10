// studio/set-asides.mjs
//
// A service's set-asides: differences between what the repository declares
// and what runs live that a person has said are not to count against the
// service — yet ("under development": declared, not deployed) or at all
// ("not this service's": found live, someone else's). The comparison assumes
// everything it finds belongs to the service; nothing tells it otherwise, so
// the person confirms or adapts that assumption while diagnosing.
//
// A set-aside names ONE difference by its behavioural key (the comparison's
// `kind::identity`, tools/lib/diff.mjs — the same key the requirement chains
// use, tools/lib/traceability-graph.mjs), which holds from one scan to the
// next, and the side it was found on:
//   { key, side: 'declared' | 'live', layer, label, kind: 'in-development' |
//     'not-this-service', note, until: 'YYYY-MM-DD' | null, by, at }
// Its state is computed, never stored:
//   active   it applies: the difference it names is left out of the counts
//            and of the grade, and said beside them;
//   due      its review date has passed: the difference counts again, and the
//            set-aside is listed as due for review;
//   retired  what it names is no longer a difference (now live, or now
//            declared): nothing to set aside;
//   gone     what it names is in neither pack now.
//
// applySetAsides never rewrites the engine's result: it returns a new diff in
// which the active set-asides' differences sit in a `setAside` bucket of
// their layer (out of onlyInA / onlyInB), the summary counted again without
// them, and the requirement chains scored again without them — a chain whose
// root is set aside leaves the rollup; a set-aside declared link leaves its
// chain's accounting, so a chain broken only by things set aside is intact.
// The engine's own summary and rollup ride beside (`setAsides.engine`).
//
// Pure ESM, no DOM: the studio's Diagnose and Remediate, the board and the
// server's runs (tools/lib/journey.mjs) read the same rules.

export const SET_ASIDE_SIDES = Object.freeze(['declared', 'live']);
export const SET_ASIDE_KINDS = Object.freeze(['in-development', 'not-this-service']);
export const SET_ASIDE_LAYERS = Object.freeze(['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV']);
export const SET_ASIDE_MAX = 1000;
// An "under development" set-aside is reviewed after this many days by default.
export const REVIEW_DAYS = 30;
export const KIND_WORDS = Object.freeze({ 'in-development': 'Under development', 'not-this-service': "Not this service's" });
// The kind a difference found on each side is most likely set aside for.
export const DEFAULT_KIND = Object.freeze({ declared: 'in-development', live: 'not-this-service' });

// The load-bearing kinds of a requirement chain — tools/lib/traceability-graph.mjs
// isLoadBearingKind, kept identical (tools/test-overview-model.mjs reads both).
const LOAD_BEARING = new Set(['slo', 'sli', 'recording_rule', 'metric', 'burn_rate']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const round4 = (n) => Math.round(n * 10000) / 10000;

// A difference's key without its occurrence suffix (diff.mjs occurrenceKey:
// `#01`, `#02` when several artefacts share one identity): a set-aside names
// the identity, and holds for every artefact that has it.
export const baseKeyOf = (key) => String(key ?? '').replace(/#\d{2,}$/, '');
export const setAsideId = (side, key) => `${side}:${baseKeyOf(key)}`;

// 'YYYY-MM-DD' of a time (UTC).
export const dayOf = (now) => new Date(typeof now === 'number' ? now : Date.parse(now ?? new Date().toISOString())).toISOString().slice(0, 10);
// The default review date of an "under development" set-aside made at `now`.
export function reviewDate(now, days = REVIEW_DAYS) {
  const ms = typeof now === 'number' ? now : Date.parse(now ?? new Date().toISOString());
  return new Date(ms + days * 86400000).toISOString().slice(0, 10);
}

// 'active' or 'due': a set-aside holds through its review date (inclusive).
export function setAsideState(rec, now) {
  if (!isObj(rec)) return 'due';
  return typeof rec.until === 'string' && rec.until < dayOf(now) ? 'due' : 'active';
}

// The records that are set-asides (a key, a side), at most one per side and key, in order.
export function setAsideList(list) {
  const out = [];
  const seen = new Set();
  for (const rec of Array.isArray(list) ? list : []) {
    if (!isObj(rec) || typeof rec.key !== 'string' || !rec.key || !SET_ASIDE_SIDES.includes(rec.side)) continue;
    const id = setAsideId(rec.side, rec.key);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...rec, key: baseKeyOf(rec.key) });
  }
  return out;
}

// The set-asides that hold at `now`, by id.
export function activeSetAsides(list, now) {
  return new Map(setAsideList(list).filter((r) => setAsideState(r, now) === 'active').map((r) => [setAsideId(r.side, r.key), r]));
}

// A short, stable name for the set-asides that hold at `now` ('' for none): a
// run records it, and the board tells a run graded on other set-asides apart.
export function setAsideFingerprint(list, now) {
  const ids = [...activeSetAsides(list, now).keys()].sort();
  if (!ids.length) return '';
  let h = 0x811c9dc5;
  const s = ids.join('\n');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${ids.length}:${h.toString(16).padStart(8, '0')}`;
}

// The summary's counts again over the buckets as they are now, by the
// engine's own formulas (tools/lib/diff.mjs); the pairs are not touched.
function summaryOver(layers, engine) {
  let onlyInA = 0, onlyInB = 0;
  for (const bucket of Object.values(layers)) {
    if (!isObj(bucket)) continue;
    onlyInA += (bucket.onlyInA || []).length;
    onlyInB += (bucket.onlyInB || []).length;
  }
  const inBoth = Number(engine.inBoth) || 0;
  const aligned = Number(engine.aligned) || 0;
  const union = onlyInA + onlyInB + inBoth;
  return {
    ...engine,
    onlyInA, onlyInB,
    union, aTotal: onlyInA + inBoth, bTotal: onlyInB + inBoth,
    jaccard: union === 0 ? 1 : Math.round((inBoth / union) * 100) / 100,
    alignment: union === 0 ? 1 : Math.round((aligned / union) * 100) / 100,
  };
}

// A chain scored again without the links set aside (see the header). Only a
// declared link that is not live (declared_only) is taken out of the
// accounting; a set-aside live link (live_only) never counted. The ladder's
// fields are unscored and stay as the engine left them.
function branchWithout(branch, declared, live, ids) {
  const matches = (side, node) => (side === 'declared'
    ? declared.has(node.key) || (node.aId && ids.declared.has(node.aId))
    : live.has(node.key) || (node.bId && ids.live.has(node.bId)));
  if (!branch.hasA) {
    return live.has(branch.rootKey) ? { ...branch, setAside: true } : branch;
  }
  // A requirement set aside takes its chain out only while it is not live: one now live is retired.
  const root = (branch.nodes || []).find((n) => n.key === branch.rootKey);
  if (declared.has(branch.rootKey) && (!branch.hasB || root?.status === 'declared_only')) return { ...branch, setAside: true };
  let removed = 0;
  let marked = 0;
  const nodes = (branch.nodes || []).map((node) => {
    if (node.status === 'declared_only' && matches('declared', node)) { removed += Number(node.weight) || 0; marked++; return { ...node, setAside: true }; }
    if (node.status === 'live_only' && matches('live', node)) { marked++; return { ...node, setAside: true }; }
    return node;
  });
  if (!marked) return branch;
  if (!removed) return { ...branch, nodes };
  const counted = (branch.nodes || []).filter((n) => n.status === 'aligned' || n.status === 'drifted' || n.status === 'declared_only');
  const possible = counted.reduce((s, n) => s + (Number(n.weight) || 0), 0)
    + (branch.missingRoles || []).reduce((s, r) => s + (Number(r.weight) || 0), 0);
  const achieved = (Number(branch.integrity) || 0) * possible;
  const left = possible - removed;
  const integrity = left <= 0 ? 1 : round4(Math.max(0, Math.min(1, achieved / left)));
  const broken = nodes.some((n) => n.status === 'declared_only' && !n.setAside && LOAD_BEARING.has(n.kind))
    || (branch.missingRoles || []).some((r) => r.loadBearing);
  const drifted = nodes.filter((n) => n.status === 'drifted').length;
  const verdict = broken ? 'broken' : drifted > 0 ? 'partial' : 'intact';
  const counts = { ...branch.counts, declaredOnly: nodes.filter((n) => n.status === 'declared_only' && !n.setAside).length, setAside: marked };
  return { ...branch, nodes, counts, integrity, integrityPct: Math.round(integrity * 100), verdict, engine: { verdict: branch.verdict, integrity: branch.integrity } };
}

function graphWithout(graph, declared, live, ids) {
  if (!isObj(graph) || !Array.isArray(graph.branches)) return graph;
  const branches = graph.branches.map((b) => (isObj(b) ? branchWithout(b, declared, live, ids) : b));
  const counted = branches.filter((b) => isObj(b) && !b.setAside);
  const declaredBranches = counted.filter((b) => b.hasA);
  const integrityMean = declaredBranches.length ? round4(declaredBranches.reduce((s, b) => s + (Number(b.integrity) || 0), 0) / declaredBranches.length) : 1;
  const rollup = {
    ...(graph.rollup || {}),
    intact: counted.filter((b) => b.verdict === 'intact').length,
    partial: counted.filter((b) => b.verdict === 'partial').length,
    broken: counted.filter((b) => b.verdict === 'broken').length,
    undeclared: counted.filter((b) => b.verdict === 'undeclared').length,
    declaredTotal: declaredBranches.length,
    total: counted.length,
    integrityMean,
    integrityPct: Math.round(integrityMean * 100),
    setAside: branches.filter((b) => isObj(b) && b.setAside).length,
  };
  return { ...graph, branches, rollup };
}

// applySetAsides(diff, list, { now }) → the comparison without the active set-asides
// (see the header), with `setAsides`:
//   { declared, live            the differences left out, by side
//     chains                     the requirement chains left out (their root set aside)
//     records: [{ ...rec, state, matched }]   every set-aside and what it matched
//     due, fingerprint, engine: { summary, rollup } }
// A diff with no layers, or a list with nothing in it, comes back as it was.
export function applySetAsides(diff, list, { now = new Date().toISOString() } = {}) {
  const records = setAsideList(list);
  if (!isObj(diff) || !isObj(diff.layers) || !records.length) return diff;
  const active = activeSetAsides(records, now);
  const declared = new Set([...active.values()].filter((r) => r.side === 'declared').map((r) => r.key));
  const live = new Set([...active.values()].filter((r) => r.side === 'live').map((r) => r.key));
  const matched = new Map();
  const ids = { declared: new Set(), live: new Set() };
  const where = new Map();   // base key → 'onlyInA' | 'onlyInB' | 'inBoth', for retired / gone
  const layers = {};
  let nDeclared = 0, nLive = 0;
  for (const [layer, bucket] of Object.entries(diff.layers)) {
    if (!isObj(bucket)) { layers[layer] = bucket; continue; }
    const aside = [];
    const keep = (entries, side) => (entries || []).filter((e) => {
      const base = baseKeyOf(e?.key);
      where.set(`${side}:${base}`, true);
      if (!(side === 'declared' ? declared : live).has(base)) return true;
      const id = setAsideId(side, base);
      matched.set(id, (matched.get(id) || 0) + 1);
      const artId = e?.artefact?.id;
      if (artId) ids[side].add(artId);
      aside.push({ ...e, side: side === 'declared' ? 'a' : 'b', setAside: active.get(id) });
      return false;
    });
    for (const e of bucket.inBoth || []) where.set(`both:${baseKeyOf(e?.key)}`, true);
    const onlyInA = keep(bucket.onlyInA, 'declared');
    const onlyInB = keep(bucket.onlyInB, 'live');
    nDeclared += aside.filter((e) => e.side === 'a').length;
    nLive += aside.filter((e) => e.side === 'b').length;
    layers[layer] = aside.length ? { ...bucket, onlyInA, onlyInB, setAside: aside } : bucket;
  }
  const graph = diff.traceabilityGraph ? graphWithout(diff.traceabilityGraph, declared, live, ids) : diff.traceabilityGraph;
  // The chains a set-aside took out, by its id: it holds even when its requirement is no difference of its own.
  const chainRoots = new Set((graph?.branches || []).filter((b) => isObj(b) && b.setAside).map((b) => setAsideId(b.hasA ? 'declared' : 'live', b.rootKey)));
  const out = records.map((rec) => {
    const id = setAsideId(rec.side, rec.key);
    const state = setAsideState(rec, now) === 'due' ? 'due'
      : matched.has(id) || chainRoots.has(id) ? 'active'
        : where.has(`both:${rec.key}`) ? 'retired'
          : 'gone';
    return { ...rec, state, matched: matched.get(id) || 0 };
  });
  return {
    ...diff,
    layers,
    summary: summaryOver(layers, diff.summary || {}),
    ...(graph ? { traceabilityGraph: graph } : {}),
    setAsides: {
      declared: nDeclared,
      live: nLive,
      chains: graph?.rollup?.setAside || 0,
      records: out,
      due: out.filter((r) => r.state === 'due').length,
      fingerprint: setAsideFingerprint(records, now),
      engine: { summary: diff.summary || null, rollup: diff.traceabilityGraph?.rollup || null },
    },
  };
}

// The differences of a comparison a person can set aside, by side, each with
// what a row shows of it — the active set-asides' first, then the rest, in the
// engine's order: { declared: [...], live: [...] }, an item being
//   { id, key, side, layer, label, kind, setAside: rec | null }
// `label(entry)` names an entry (the studio's diffEntryLabel).
export function setAsideCandidates(diff, label = (e) => String(e?.key ?? '')) {
  const out = { declared: [], live: [] };
  if (!isObj(diff) || !isObj(diff.layers)) return out;
  const seen = new Set();
  for (const [layer, bucket] of Object.entries(diff.layers)) {
    if (!isObj(bucket)) continue;
    const add = (e, side, rec) => {
      const key = baseKeyOf(e?.key);
      const id = setAsideId(side, key);
      if (!key || seen.has(id)) return;
      seen.add(id);
      out[side].push({ id, key, side, layer, label: label(e), kind: key.includes('::') ? key.slice(0, key.indexOf('::')) : '', setAside: rec || null });
    };
    for (const e of bucket.setAside || []) add(e, e.side === 'b' ? 'live' : 'declared', e.setAside);
    for (const e of bucket.onlyInA || []) add(e, 'declared', null);
    for (const e of bucket.onlyInB || []) add(e, 'live', null);
  }
  return out;
}
