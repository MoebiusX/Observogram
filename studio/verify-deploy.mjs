// studio/verify-deploy.mjs
//
// Post-deploy transition verification (VALUE_BACKLOG item 9) — the pure
// half. Given the items a deploy pushed and a FRESH declared-vs-live diff,
// compute what actually happened to each one:
//
//   verified  the artefact now matches live (inBoth, match: 'aligned')
//   drifted   live has it but the contract differs (inBoth, 'drifted')
//   pending   not visible live yet (onlyInA, or absent) — propagation lag
//             is a first-class state, NOT a failure; per the Phase 1
//             research contract, pending NEVER counts as verified.
//   shadow    found only on the live side (onlyInB) — shouldn't happen for
//             something we just deployed; surfaced, never hidden.
//
// DOM-free and side-effect-free so it unit-tests without an MCP. The modal
// orchestration (re-draft → re-diff → poll) lives in app.mjs.

// Diff bucket keys are `kind::{json}` with an optional `#NN` occurrence
// suffix (see tools/lib/diff.mjs occurrenceKey). Parse defensively: a key
// we can't parse simply never matches.
export function parseDiffKey(key) {
  const raw = String(key || '');
  const m = /^([a-z0-9_]+)::(\{.*\})(?:#\d+)?$/i.exec(raw);
  if (!m) return null;
  try { return { kind: m[1], identity: JSON.parse(m[2]) }; }
  catch (_) { return null; }
}

// A per-SLO rules deploy materialises recording rules named from the SLO's
// SLI (`<service>:<sli>:<op>` — see sli-inference.mjs). We don't recompile
// here; we match on the SLI base: the slo id minus its trailing objective
// suffix (`settlement_latency_99` → `settlement_latency`). Marked 'fuzzy'
// so the UI can say how the match was made.
export function sliBaseOfSloId(sloId) {
  return String(sloId || '').replace(/_\d+(?:_\d+)*$/, '');
}

// Map one deploy-manifest row (studio/artifact-model.mjs shape) to a
// matcher over parsed diff keys.
export function matcherForDeployItem(item) {
  const type = item?.type;
  const id = String(item?.id ?? item?.dashboardId ?? '');
  if (!id) return null;
  if (type === 'dashboard') {
    return { kinds: ['dashboard'], match: 'exact', test: (idn) => idn?.id === id };
  }
  if (type === 'alert') {
    // Step 5: the assurance row (Watchdog + instrument liveness). The graph
    // carries no artefact node for a non-burn alert today (the live fetcher
    // lands them only in mcp.discovered.alert_rule_names), so this matcher
    // is structural: it recognises an alert_rule identity labelled
    // kind=assurance and never a burn alert — an assurance deploy therefore
    // reads `pending` until a diff kind exists for it, never `verified`.
    if (id === 'assurance') {
      return { kinds: ['alert_rule'], match: 'exact', test: (idn) => idn?.labels?.kind === 'assurance' || idn?.kind === 'assurance' };
    }
    return { kinds: ['burn_rate'], match: 'exact', test: (idn) => idn?.slo === id };
  }
  if (type === 'recording') {
    const artifact = String(item?.artifact || '');
    if (artifact.startsWith('declared:')) {
      return { kinds: ['recording_rule'], match: 'exact', test: (idn) => idn?.record === id };
    }
    // Per-SLO recording rules: match any recording rule whose output series
    // embeds the SLI base between separators (`:` or start/end).
    const base = sliBaseOfSloId(id);
    if (!base) return null;
    return {
      kinds: ['recording_rule'],
      match: 'fuzzy',
      test: (idn) => {
        const rec = String(idn?.record || '');
        return rec === base || rec.includes(`:${base}:`) || rec.startsWith(`${base}:`) || rec.endsWith(`:${base}`);
      },
    };
  }
  return null;
}

// Walk every layer bucket of a /api/diff result and classify the entries
// that match `matcher`. Returns { verified, drifted, pending, shadow } as
// arrays of diff keys.
function findMatches(diff, matcher) {
  const hits = { verified: [], drifted: [], pending: [], shadow: [] };
  for (const layer of Object.values(diff?.layers || {})) {
    for (const e of layer?.inBoth || []) {
      const p = parseDiffKey(e.key);
      if (p && matcher.kinds.includes(p.kind) && matcher.test(p.identity)) {
        (e.match === 'aligned' ? hits.verified : hits.drifted).push(e.key);
      }
    }
    for (const e of layer?.onlyInA || []) {
      const p = parseDiffKey(e.key);
      if (p && matcher.kinds.includes(p.kind) && matcher.test(p.identity)) hits.pending.push(e.key);
    }
    for (const e of layer?.onlyInB || []) {
      const p = parseDiffKey(e.key);
      if (p && matcher.kinds.includes(p.kind) && matcher.test(p.identity)) hits.shadow.push(e.key);
    }
  }
  return hits;
}

// Status precedence for an item that matched several diff entries (a per-SLO
// deploy lands ~4 recording rules): any still-missing rule keeps the whole
// item pending; any drifted rule beats verified. Verification credit is
// only granted when EVERYTHING the item maps to is aligned live.
function statusOf(hits) {
  const found = hits.verified.length + hits.drifted.length + hits.pending.length + hits.shadow.length;
  if (found === 0) return 'pending';
  if (hits.pending.length) return 'pending';
  if (hits.drifted.length) return 'drifted';
  if (hits.verified.length) return 'verified';
  return 'shadow';
}

// items: deploy-manifest rows that the deploy reported ok.
// diff:  a fresh /api/diff result (declared pack vs the new live draft).
export function computeDeployTransitions(items, diff) {
  const transitions = (items || []).map(item => {
    const matcher = matcherForDeployItem(item);
    if (!matcher) {
      return { id: item?.id ?? null, type: item?.type ?? null, status: 'unknown', match: null, matched: [] };
    }
    const hits = findMatches(diff, matcher);
    return {
      id: item.id ?? item.dashboardId ?? null,
      type: item.type || null,
      status: statusOf(hits),
      match: matcher.match,
      matched: [...hits.verified, ...hits.drifted, ...hits.pending, ...hits.shadow],
      counts: {
        verified: hits.verified.length, drifted: hits.drifted.length,
        pending: hits.pending.length, shadow: hits.shadow.length,
      },
    };
  });

  const tally = (s) => transitions.filter(t => t.status === s).length;
  const summary = {
    total: transitions.length,
    verified: tally('verified'),
    drifted: tally('drifted'),
    pending: tally('pending'),
    shadow: tally('shadow'),
    unknown: tally('unknown'),
  };
  summary.allVerified = summary.total > 0 && summary.verified === summary.total;
  summary.outcome = summary.allVerified ? 'verified'
    : (summary.pending > 0 ? 'pending' : (summary.total === 0 ? 'nothing-to-verify' : 'partial'));
  return { transitions, summary, alignment: diff?.summary?.alignment ?? null };
}
