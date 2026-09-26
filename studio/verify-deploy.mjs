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
// validation: { schemaValid: true|false|null,
//               rubric: { conformant, tier, placeholders?, templates? } | null }
//             placeholders = clauses the report says pass only on a template
//             value; templates = template values the pack still carries
//             (library.todo.* annotations, Scaffold artefacts). Either one
//             turns a met rubric into "met on placeholder values", never a
//             plain pass.

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

// The tier rubric informs, never blocks. A met rubric is a plain pass
// ("met with real values") only when nothing says it rests on template
// values; otherwise it is the Represented (placeholder) state.
function rubricCheck(rubric, tierWord) {
  const base = { id: 'rubric', blocking: false, fix: '' };
  if (!rubric) return { ...base, status: 'notEvaluated', label: 'Tier rubric not evaluated' };
  if (!rubric.conformant) return { ...base, status: 'warning', label: `Does not meet ${tierWord}` };
  const placeholders = Number(rubric.placeholders) || 0;
  const templates = Number(rubric.templates) || 0;
  if (placeholders > 0) return { ...base, status: 'placeholder', label: `Meets ${tierWord} on placeholder values` };
  if (templates > 0) return { ...base, status: 'placeholder', label: `Meets ${tierWord}; template values remain` };
  return { ...base, status: 'pass', label: `Meets ${tierWord}` };
}

// The note under "Changed artefacts" when the type filter hides rows. The
// deploy sends only the rows the table shows, so a selected row of a hidden
// type is NOT deployed — the note says that, never "review everything".
//   hiddenTypes     [{ value, label }] for every unchecked type filter
//   hiddenSelected  { [type]: n } selected rows each hidden type holds, when
//                   the modal reports it; null when it does not.
export function hiddenSelectionNote({ hiddenTypes = [], hiddenSelected = null } = {}) {
  if (hiddenSelected && typeof hiddenSelected === 'object') {
    const hidden = new Set((hiddenTypes || []).map(t => t?.value ?? t));
    const parts = Object.entries(hiddenSelected)
      .filter(([t, n]) => hidden.has(t) && Number(n) > 0)
      .map(([t, n]) => {
        const [one, many] = REVIEW_TYPE_WORDS[t] || [t, t];
        return `${n} selected ${Number(n) === 1 ? one : many}`;
      });
    if (!parts.length) return '';
    const total = Object.entries(hiddenSelected)
      .filter(([t]) => hidden.has(t)).reduce((sum, [, n]) => sum + (Number(n) > 0 ? Number(n) : 0), 0);
    const list = parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
    return `${list} ${total === 1 ? 'is' : 'are'} filtered out of the table and will not be deployed. Show every type to include ${total === 1 ? 'it' : 'them'}.`;
  }
  const labels = (hiddenTypes || []).map(t => (t && typeof t === 'object' ? (t.label || t.value) : t)).filter(Boolean);
  if (!labels.length) return '';
  return `Filtered out of the table: ${labels.join(', ')}. Selected rows of a filtered-out type are not deployed; show every type to include them.`;
}

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
    rubricCheck(rubric, tierWord),
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

// ---------- Remediate: the deploy half of the plan ----------
//
// Pure rules the Remediate screen (compile-view.mjs) applies to its counts,
// kept here beside the deploy review so tools/test-verify-deploy.mjs pins
// them. Counts are artefacts unless named "deploy row" (an SLO deploys as
// two rows: recording rules and burn-rate alerts).

// Recommend ONE strategy from the diagnosed gap, or null. Deploy is only
// recommended when something the repository has beyond live can actually be
// deployed (repoDeployable); artefacts that all need a manual fix are never
// a reason to "deploy repository changes to live". In gap mode Pack B is a
// baseline, so the repository's extras are never something to push.
//   { haveB, mode: 'gap'|'drift'|…, liveOnly, repoOnly, repoDeployable, drift }
export function recommendRemediation({ haveB, mode, liveOnly = 0, repoDeployable = 0, drift = 0 } = {}) {
  if (!haveB) return null;
  if (mode === 'gap') {
    if (liveOnly) return { op: 'retrofeed', why: 'the baseline has artefacts your pack lacks' };
    if (drift)    return { op: 'drift', why: 'shared artefacts differ from the baseline' };
    return null;
  }
  if (liveOnly && repoDeployable) return { op: 'all', why: 'each side has artefacts the other lacks' };
  if (liveOnly) return { op: 'retrofeed', why: 'live has artefacts the repository lacks' };
  if (repoDeployable) return { op: 'deploy', why: 'the repository has deployable artefacts live does not have yet' };
  if (drift)    return { op: 'drift', why: 'the only gaps are shared artefacts whose fields differ' };
  return null;
}

// "N to deploy (R deploy rows)" — artefacts first, so it adds up with the
// other artefact counts in the same sentence; rows only qualify it.
//   selected    deployable artefacts still ticked
//   deployable  deployable artefacts in the set
//   rows        deploy rows the ticked artefacts expand to
export function remediationDeployPhrase({ selected = 0, deployable = 0, rows = 0 } = {}) {
  if (!deployable) return '';
  const rowWords = countWords(rows, ['deploy row', 'deploy rows']);
  return selected === deployable
    ? `${deployable} to deploy (${rowWords})`
    : `${selected} of ${deployable} selected to deploy (${rowWords})`;
}

// The deploy button's label, in the same units as the phrase above: ticked
// artefacts first, deploy rows in brackets — never a bare row count beside
// an artefact count.
export function remediationDeployActionLabel({ selected = 0, rows = 0 } = {}) {
  return `Review and deploy ${selected} selected (${countWords(rows, ['deploy row', 'deploy rows'])}) to live`;
}

// The "Only in live/baseline" measure. When Pack B artefacts were parked out
// of the checked scope, a zero only covers that scope: in gap mode the rest
// of the baseline is what the pack may lack, so it is never "nothing to
// import"; in live mode the parked rest is other services' fleet, so the
// zero is bounded to the checked scope.
//   { mode: 'gap'|…, liveOnly, outOfScope } -> { note, tone }
export function remediationSideOnlyMeasure({ mode, liveOnly = 0, outOfScope = 0 } = {}) {
  if (liveOnly) return { note: 'the repository lacks these', tone: 'warn' };
  if (outOfScope && mode === 'gap') return { note: 'none in the checked scope; the rest was not compared', tone: 'warn' };
  if (outOfScope) return { note: 'nothing to import in the checked scope', tone: 'neutral' };
  return { note: 'nothing to import', tone: 'neutral' };
}
