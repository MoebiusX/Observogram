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
//
// The pre-deploy half lives here too (deployReviewModel, at the end): the
// one review panel that states destination, environment, the artefacts that
// change and the validation state before anything is written to live.

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

// ---------- pre-deploy review ----------
//
// Before a deploy, one panel says where it goes, what changes and whether it
// is ready (docs/UX_SCREEN_GRAMMAR.md: source and destination explicit). The
// deploy modal reads its form and hands the values in; this stays pure so
// tools/test-verify-deploy.mjs pins the rules:
//
//   blocking     no artefact selected · no MCP gateway URL · no target
//                product · a pack that fails schema validation
//   informative  the tier rubric — conformance is not deployment readiness,
//                so a non-conformant pack warns but never blocks
//
// target:     { product, version, url, folder, mcpUrl, profile }
// source:     { id, label, version }
// env:        the environment the artefacts are compiled for
// rows:       the SELECTED manifest rows ({ type, id, name })
// validation: { schemaValid: true|false|null, rubric: { conformant, tier } | null }

const REVIEW_TYPE_WORDS = {
  alert:     ['alert rule', 'alert rules'],
  recording: ['recording rule', 'recording rules'],
  dashboard: ['dashboard', 'dashboards'],
};

// Host only: a gateway URL can carry credentials in its userinfo or query,
// and the review never shows more than where the write goes.
export function reviewHostOf(url) {
  const s = String(url ?? '').trim();
  if (!s) return '';
  try { return new URL(s).host || ''; }
  catch { return s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].split('@').pop(); }
}

function countWords(n, [one, many]) { return `${n} ${n === 1 ? one : many}`; }

export function deployReviewModel({ target = {}, source = {}, env = null, rows = [], validation = {} } = {}) {
  const selected = (rows || []).filter(Boolean);
  const byType = {};
  for (const r of selected) {
    const t = r.type || 'other';
    byType[t] = (byType[t] || 0) + 1;
  }
  const typeSummary = Object.entries(byType)
    .map(([t, n]) => countWords(n, REVIEW_TYPE_WORDS[t] || [t, t]))
    .join(', ');

  const product = String(target.product ?? '').trim();
  const version = String(target.version ?? '').trim();
  const destination = {
    platform: [product, version].filter(Boolean).join(' ') || null,
    host: reviewHostOf(target.url) || null,
    folder: String(target.folder ?? '').trim() || null,
    gateway: reviewHostOf(target.mcpUrl) || null,
    profile: String(target.profile ?? '').trim() || null,
  };

  const total = selected.length;
  const schema = validation?.schemaValid;
  const rubric = validation?.rubric || null;
  const tierWord = rubric?.tier ? `${rubric.tier} rubric` : 'tier rubric';
  const checks = [
    { id: 'selection', blocking: true, status: total ? 'pass' : 'fail',
      label: total ? `${countWords(total, ['artefact', 'artefacts'])} selected` : 'No artefacts selected',
      fix: 'select at least one artefact' },
    { id: 'gateway', blocking: true, status: destination.gateway ? 'pass' : 'fail',
      label: destination.gateway ? 'MCP gateway set' : 'MCP gateway URL missing',
      fix: 'add the MCP gateway URL' },
    { id: 'target', blocking: true, status: product ? 'pass' : 'fail',
      label: product ? 'Target product chosen' : 'No target product',
      fix: 'choose a target product' },
    { id: 'schema', blocking: true,
      status: schema === true ? 'pass' : (schema === false ? 'fail' : 'notEvaluated'),
      label: schema === true ? 'Pack schema valid' : (schema === false ? 'Pack schema invalid' : 'Pack schema not checked'),
      fix: 'fix the pack’s schema errors' },
    { id: 'rubric', blocking: false,
      status: !rubric ? 'notEvaluated' : (rubric.conformant ? 'pass' : 'warning'),
      label: !rubric ? 'Tier rubric not evaluated' : (rubric.conformant ? `Meets ${tierWord}` : `Does not meet ${tierWord}`),
      fix: '' },
  ];
  const blockers = checks.filter(c => c.blocking && c.status === 'fail');
  const ready = blockers.length === 0;

  const where = destination.platform || 'the live platform';
  const envText = env ? ` (${env})` : '';
  let headline;
  if (ready) {
    headline = `Ready to deploy ${countWords(total, ['artefact', 'artefacts'])} to ${where}${envText}.`;
  } else {
    const fixes = blockers.map(b => b.fix);
    const said = fixes.length <= 1 ? fixes.join('') : `${fixes.slice(0, -1).join(', ')} and ${fixes[fixes.length - 1]}`;
    headline = `Not ready to deploy: ${said}.`;
  }

  return {
    ready,
    headline,
    destination,
    environment: env || null,
    source: {
      id: source?.id || null,
      label: source?.label || source?.id || null,
      version: source?.version ? String(source.version).replace(/^v/i, '') : null,
    },
    changes: {
      total,
      byType,
      summary: typeSummary,
      sample: selected.slice(0, 5).map(r => String(r.name || r.id || '')).filter(Boolean),
      more: Math.max(0, total - 5),
    },
    checks,
    blockers,
  };
}
