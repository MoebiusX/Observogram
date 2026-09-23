// studio/build-model.mjs
//
// The pure models of the BUILD journey (docs/BUILD_JOURNEY.md, slice 2):
// Define · Compile · Verify over the pack library. Every function here
// takes its inputs explicitly — the build draft (state.build's shape), the
// library index (GET /api/library), the tier's clauses (GET
// /api/library/requirements/:tier), the last instantiate response — and
// returns plain data for the step renderers. No state reads, no fetches, no
// DOM: this is the layer tools/test-build-model.mjs exercises under
// node:test, against a real instantiate response captured once from the
// running server (tools/fixtures/build/). docs/UI_CONVENTIONS.md §2.
//
// Nothing here re-implements the engine: the tier's clauses are the rubric
// the API returns, an SLI's reachability is its minTier against the tier
// (the engine's atTier), a composed SLI id is `<entry prefix>_<sli>` (the
// engine's naming, spelled once in sliKey), and whether a clause passes,
// passes on a placeholder or fails is read from the engine's summary.
//
// The layer stack (docs/BUILD_JOURNEY.md "The scan") is the same discipline:
// buildStackModel draws the slabs L1 … GOV from the adapter's projection of
// the instantiated pack (`adapted` on the instantiate response — the artefact
// list Discover shows for the same canonical), the rubric filtered by tier
// (the silhouette: one ghost per clause), the clause checklist (the slab
// edges and the maturity bars) and the todo list (pinned to the slab of the
// artefact each names). The layer names and accents are the studio's
// constants; nothing is invented here.

import { LAYER_DEFS, L4_SUBGROUPS, DISCO_SLAB_ACCENT } from './constants.mjs';

export const BUILD_STEPS = ['define', 'compile', 'verify'];
/** Least stringent first — the order the engine lists them and the DEFINE step shows them. */
export const TIERS = ['tier-3', 'tier-2', 'tier-1'];
const TIER_RANK = { 'tier-3': 0, 'tier-2': 1, 'tier-1': 2 };
export const TIER_META = {
  'tier-1': { label: 'Tier 1', word: 'critical', blurb: 'Pages a human: voice routes, tail sampling, weekly production chaos, a release gate.' },
  'tier-2': { label: 'Tier 2', word: 'important', blurb: 'A latency SLO, logs and traces backends, a chaos experiment in staging, a remediation.' },
  'tier-3': { label: 'Tier 3', word: 'standard', blurb: 'An availability SLO, an OTLP pipeline, a board, a probe, a burn-rate alert.' },
};
export const SECTION_TOGGLES = [
  { id: 'slos', label: 'SLOs', hint: 'an objective and a window per SLI (off also drops the policy: a burn alert without an SLO is meaningless)' },
  { id: 'policy', label: 'Policy', hint: 'two-window burn-rate alerts per SLO, forecasts at tier-1' },
  { id: 'routes', label: 'Routes', hint: 'alerting routes per severity, dedup, suppress contexts' },
  { id: 'dashboards', label: 'Dashboards', hint: 'the overview board, the burn board, the entries’ product boards' },
  { id: 'validation', label: 'Validation', hint: 'synthetic probes, chaos experiments, release checks' },
];
export const WARNING_KINDS = {
  promql: { label: 'PromQL', blocking: true, hint: 'an SLI expression does not parse once the params are in — the pack must not ship' },
  'sli-excluded': { label: 'SLI above the tier', blocking: false, hint: 'a selected SLI needs a higher tier and was excluded' },
  'burn-rules': { label: 'Burn rules', blocking: false, hint: 'the burn-rule generator’s own warnings on the produced policy' },
};
/** The artefact families a todo path falls into (grouping for the VERIFY step). */
export const ARTEFACT_GROUPS = [
  { id: 'alerting', label: 'Alerting routes', match: /^alerting\./ },
  { id: 'telemetry', label: 'Telemetry backends', match: /^telemetry\./ },
  { id: 'pipelines', label: 'Collector pipelines', match: /^pipelines\./ },
  { id: 'storage', label: 'Storage', match: /^storage\./ },
  { id: 'validation', label: 'Validation — probes & chaos', match: /^validation\./ },
  { id: 'remediation', label: 'Remediation runbooks', match: /^remediation/ },
  { id: 'baselines', label: 'Baselines', match: /^baselines/ },
  { id: 'metadata', label: 'Metadata', match: /^metadata\./ },
  { id: 'other', label: 'Other', match: /./ },
];

// ---------- small helpers (mirrors of the engine's rules, spelled once) ----------

const SLUG_RE = /^[a-z][a-z0-9_-]*[a-z0-9]$/;
/**
 * The schema's Slug is at most 64 characters and the longest suffix the scaffold appends
 * to the service slug is tier-1's `-deployment-overlay` board id (19), so a slug longer
 * than 45 passes DEFINE and fails the schema two steps later (measured: 46 characters →
 * `$.spec.dashboards[2].id: length 65 > maxLength 64`). Refused where the name is typed.
 */
export const LONGEST_DERIVED_SUFFIX = '-deployment-overlay';
export const MAX_SERVICE_SLUG = 64 - LONGEST_DERIVED_SUFFIX.length;
/** tools/lib/slug.mjs fileSlug: what the engine makes of a typed service name. */
export function serviceSlug(name) {
  if (typeof name !== 'string') return '';
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
export function isValidServiceName(name) {
  const slug = serviceSlug(name);
  return SLUG_RE.test(slug) && slug.length <= MAX_SERVICE_SLUG;
}
/** "team-a, team-b" → ['team-a', 'team-b'] (commas or whitespace). */
export function parseOwners(text) {
  return String(text || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}
export const tierRank = (t) => TIER_RANK[t] ?? 0;
export const atTier = (tier, minTier) => tierRank(tier) >= tierRank(minTier || 'tier-3');
const metricPrefix = (id) => serviceSlug(id).replace(/-/g, '_');
/** The SLI id the pack uses: prefixed with the entry when several entries compose (the engine's rule). */
export function sliKey(entryId, sliId, composed) { return composed ? `${metricPrefix(entryId)}_${sliId}` : sliId; }
/** `<entry>.<param>` when several entries compose, the bare id otherwise (the engine's paramTable). */
export function paramKey(entryId, paramId, composed) { return entryId && composed ? `${entryId}.${paramId}` : paramId; }
const fmtObjective = (o) => (typeof o === 'number' ? `${Number((o * 100).toFixed(4))}%` : '—');

/** The index rows of the selected entries, in selection order (unknown ids dropped). */
export function selectedEntries(build, library) {
  const rows = library?.entries || [];
  return (build?.entries || []).map(id => rows.find(r => r.id === id)).filter(Boolean);
}

/** The DEFINE step's validity: a name that slugs, a known tier, at least one entry. */
export function defineValid(build) {
  return !!build && isValidServiceName(build.name) && TIERS.includes(build.tier) && Array.isArray(build.entries) && build.entries.length >= 1;
}

/**
 * Which header cards are reachable: a step opens when the previous step's inputs
 * are valid. A usage error keeps the previous pack (the controller marks it
 * stale rather than dropping it), so Verify stays reachable while the field
 * the error names is fixed — on Verify itself, where the param inputs are.
 */
export function buildStepReachability(build) {
  const define = true;
  const compile = defineValid(build);
  const r = build?.result;
  const verify = compile && !!r && Array.isArray(r.canonical?.spec?.slis) && r.canonical.spec.slis.length >= 1;
  return { define, compile, verify };
}

// ---------- the last instantiation's errors ----------

/**
 * The engine's usage errors split for the views: `param <key>: <why>` (a value
 * the engine refuses — a quote, a backslash, a control character, too long, not
 * a scalar) keyed by the param so the row that carries it shows it, everything
 * else general (an unknown key, a selection with no SLI left).
 */
export function splitBuildErrors(errors) {
  const byParam = {};
  const general = [];
  for (const e of errors || []) {
    const m = /^param ([^\s:]+): ([\s\S]+)$/.exec(String(e));
    if (m) byParam[m[1]] = m[2]; else general.push(String(e));
  }
  return { byParam, general, paramCount: Object.keys(byParam).length, count: (errors || []).length };
}

/** The last instantiation failed while an earlier pack is still shown: what the views mark stale. */
export function isStale(build) { return !!(build?.error && build?.result); }

/** Step ids a draft may carry from before the rename (2026-09-23): they resume on the same step. */
const LEGACY_STEP = { select: 'define', generate: 'compile', validate: 'verify' };
/** The furthest reachable step at or before `wanted` (a legacy id counts as its current name). */
export function clampStep(build, wanted) {
  wanted = LEGACY_STEP[wanted] || wanted;
  const reach = buildStepReachability(build);
  const idx = Math.max(0, BUILD_STEPS.indexOf(wanted));
  for (let i = idx; i >= 0; i--) if (reach[BUILD_STEPS[i]]) return BUILD_STEPS[i];
  return 'define';
}

/**
 * Entering the journey on a step (a reload, a header card): `step` clamped to what is
 * reachable now, and `wantedStep` the step that was asked for when the clamp demoted it. A
 * reload lands with the inputs and no pack, so VERIFY is unreachable until the first
 * instantiation answers — stepAfterInstantiate honours the wanted step then, once. UI
 * state on the draft, never persisted (the persisted step is the wanted one).
 */
export function enterStep(build, wanted) {
  const asked = LEGACY_STEP[wanted] || wanted || build?.step;
  const step = clampStep(build, asked);
  return { step, wantedStep: BUILD_STEPS.includes(asked) && asked !== step ? asked : null };
}

/** After an instantiation answered: the wanted step if one is pending and now reachable, else the current step clamped; the want is spent either way. */
export function stepAfterInstantiate(build) {
  return { step: clampStep(build, build?.wantedStep || build?.step), wantedStep: null };
}

// ---------- focus across a re-render ----------

/**
 * The focus-key suffix of a todo's param inputs on the stack: the slab, then the todo's
 * path (`L2/telemetry.backends[0]`) — stable while the todo survives a re-render. An index
 * in the slab would shift when a filled todo disappears, and the same param may fill
 * several todos, so an index once restored focus into another todo's input.
 */
export function todoFocusSuffix(layerId, path) {
  return `${layerId}/${path}`;
}

/**
 * Where focus goes when the input that held it is gone after a re-render (its todo was
 * filled and disappeared): the selectors to try in order — the first param input left on
 * the same slab, then the slab's edge — or none for a key that is not a stack input.
 */
export function focusFallbackSelectors(key) {
  const m = /^param:[^@]+@([^/]+)\//.exec(String(key || ''));
  if (!m) return [];
  const slab = `.build-slab[data-layer="${m[1]}"]`;
  return [`${slab} .build-param-input`, `${slab} .build-slab-edge`];
}

// ---------- the SLI selection across tiers ----------

/** The SLI keys a tier reaches for the selection — what an explicit list may contain (the engine's defaultToggles). */
export function reachableSliKeys(build, library, tier = build?.tier) {
  const entries = selectedEntries(build, library);
  const composed = entries.length > 1;
  return entries.flatMap(en => (en.slis || []).filter(s => atTier(tier, s.minTier)).map(s => sliKey(en.id, s.id, composed)));
}

/**
 * The explicit SLI list after a tier change (`prevTier` → build.tier): a key the
 * new tier does not reach is dropped — the engine would exclude it with an
 * `sli-excluded` warning nobody could clear, since its row is disabled and
 * unchecked — a key the new tier unlocks comes in ticked (the user never had
 * that choice at the old tier), and a list equal to the tier's defaults
 * collapses to null. null (the defaults) stays null. Without `prevTier` it only
 * prunes: a draft restored from an older session may list an SLI above its tier.
 */
export function retargetSlis(build, library, prevTier) {
  if (!Array.isArray(build?.slis)) return null;
  const now = reachableSliKeys(build, library);
  const before = new Set(prevTier ? reachableSliKeys(build, library, prevTier) : now);
  const keep = new Set(build.slis.filter(k => now.includes(k)));
  for (const k of now) if (!before.has(k)) keep.add(k);
  const next = now.filter(k => keep.has(k));
  return next.length === now.length ? null : next;
}

// ---------- params ----------

/**
 * A default with the engine's built-ins resolved as it resolves them
 * (`${service}` is the slug of the typed name, `${environment}`, `${tier}`): what
 * the pack will carry, shown as the input's hint instead of the raw template
 * (`#${service}-oncall` beside a todo that reads '#orders-api-oncall'). The
 * fallbacks keep the hint readable before a name is typed.
 */
export function resolveBuiltins(text, { service, environment, tier } = {}) {
  const values = { service: service || 'svc', environment: environment || 'prod', tier: tier || '' };
  return String(text ?? '').replace(/\$\{(service|environment|tier)\}/g, (m, k) => values[k]);
}

/**
 * The parameter table of the selection: the scaffold's params (every
 * instantiation has them) then each selected entry's, keyed as the engine
 * addresses them. `value` is the override (null when at the default),
 * `default` the raw template, `hint` the default with the built-ins resolved,
 * `effective` what the pack will carry, `atDefault` whether a placeholder
 * still becomes a todo, `error` the engine's reason when the last
 * instantiation refused this value.
 */
export function paramRows({ build, library }) {
  const entries = selectedEntries(build, library);
  const composed = entries.length > 1;
  const overrides = build?.params || {};
  const { byParam } = splitBuildErrors(build?.error);
  const builtins = { service: serviceSlug(build?.name), environment: build?.environment, tier: build?.tier };
  const row = (p, entry) => {
    const key = paramKey(entry?.id, p.id, composed);
    const has = Object.prototype.hasOwnProperty.call(overrides, key) && String(overrides[key]) !== '';
    const hint = resolveBuiltins(p.default, builtins);
    return {
      key, id: p.id, entry: entry?.id || null, entryTitle: entry?.title || 'scaffold',
      label: p.label, description: p.description || '', default: p.default, hint, placeholder: !!p.placeholder,
      value: has ? overrides[key] : null, effective: has ? overrides[key] : hint, atDefault: !has,
      error: byParam[key] || null,
    };
  };
  return [
    ...((library?.scaffoldParams || []).map(p => row(p, null))),
    ...entries.flatMap(en => (en.params || []).map(p => row(p, en))),
  ];
}

/** The param overrides an instantiate body carries: non-empty values only. */
export function effectiveParams(build) {
  const out = {};
  for (const [k, v] of Object.entries(build?.params || {})) if (v !== null && v !== undefined && String(v) !== '') out[k] = v;
  return out;
}

/** The body POST /api/library/instantiate takes, from the draft. */
export function instantiateBody(build) {
  const toggles = { ...(build?.toggles || {}) };
  if (Array.isArray(build?.slis)) toggles.slis = build.slis;
  return {
    entries: [...(build?.entries || [])],
    name: build?.name || '',
    tier: build?.tier,
    environment: build?.environment || 'prod',
    owners: parseOwners(build?.owners),
    params: effectiveParams(build),
    toggles,
  };
}

// ---------- DEFINE ----------

/**
 * buildDefineModel({ build, library, requirements }) → what the DEFINE step renders:
 * the fields, the three tiers with the clauses each adds, the entries as cards
 * (selected, evidence, SLI counts per tier), the selection's params.
 * `requirements` is { [tier]: clauses[] } (whatever tiers have loaded).
 */
export function buildDefineModel({ build, library, requirements = {} }) {
  const rows = library?.entries || [];
  const selected = new Set(build?.entries || []);
  const name = build?.name || '';
  const errors = [];
  if (!name.trim()) errors.push('a service name');
  else if (serviceSlug(name).length > MAX_SERVICE_SLUG) errors.push(`a service name of at most ${MAX_SERVICE_SLUG} characters once slugged (‘${serviceSlug(name)}’ is ${serviceSlug(name).length})`);
  else if (!isValidServiceName(name)) errors.push(`a service name that slugs (‘${name}’ → ‘${serviceSlug(name)}’ is not one)`);
  if (!selected.size) errors.push('at least one library entry');
  const tiers = TIERS.map(tier => {
    const clauses = requirements[tier] || null;
    const adds = clauses ? clauses.filter(c => c.minTier === tier) : [];
    return {
      id: tier, ...TIER_META[tier], selected: build?.tier === tier,
      must: clauses ? clauses.filter(c => c.severity === 'MUST').length : null,
      should: clauses ? clauses.filter(c => c.severity === 'SHOULD').length : null,
      adds: adds.map(c => ({ id: c.id, severity: c.severity, description: c.description })),
      loaded: !!clauses,
    };
  });
  const card = (r) => ({
    id: r.id, kind: r.kind, title: r.title, summary: r.summary, product: r.product, version: r.version, tags: r.tags || [],
    selected: selected.has(r.id),
    evidence: { status: r.evidence?.status || null, verifiedOn: r.evidence?.verifiedOn || null, gaps: (r.evidence?.gaps || []).length },
    sliCountByTier: r.sliCountByTier,
    sliCountAtTier: r.sliCountByTier?.[build?.tier] ?? 0,
    placeholderParams: (r.params || []).filter(p => p.placeholder).length,
  });
  const params = paramRows({ build, library });
  const r = build?.result || null;
  const tierClauses = requirements[build?.tier] || [];
  return {
    name, slug: serviceSlug(name), owners: build?.owners || '', ownerList: parseOwners(build?.owners), environment: build?.environment || 'prod',
    tier: build?.tier, tiers,
    products: rows.filter(r => r.kind === 'product').map(card),
    archetypes: rows.filter(r => r.kind === 'archetype').map(card),
    selectedEntries: selectedEntries(build, library).map(card),
    params,
    // The silhouette: the tier's clauses as ghost cards on their slabs, the selection's
    // SLI / SLO candidates on L1, the edges in the clause states once a pack exists.
    stack: buildStackModel({
      requirements: tierClauses, checklist: buildClauseChecklist(tierClauses, r?.summary || null),
      candidates: sliCandidates({ build, library }), mode: 'define', toggles: build?.toggles || {}, expanded: build?.stackOpen || {},
    }),
    // The placeholder count the step prints: once a pack exists, the params the
    // engine wrote and reported (provenance.placeholders, what the rail shows) —
    // a flagged param the tier or the selection never writes (pager_service_low
    // below tier-1, chaos_target when every entry brings its own chaos) is no
    // todo, so `flagged` overstates it and is only shown before the first result.
    placeholders: { flagged: params.filter(p => p.placeholder && p.atDefault).length, remaining: r ? placeholdersRemaining(r) : null },
    libraryErrors: library?.errors || [],
    valid: errors.length === 0, errors,
    // The last instantiation's usage errors (a rejected param value is marked on its row).
    error: build?.error ? splitBuildErrors(build.error) : null, stale: isStale(build),
  };
}

// ---------- COMPILE ----------

/**
 * The per-entry SLI rows of the selection at the draft's tier: reachable (its
 * minTier at or below the tier) or disabled with the tier it needs, checked
 * (an explicit list, else the tier's defaults), the objective and window this
 * tier gives it. COMPILE's rows and DEFINE's L1 candidates read the same list.
 */
export function sliGroups({ build, library }) {
  const entries = selectedEntries(build, library);
  const composed = entries.length > 1;
  const tier = build?.tier;
  const explicit = Array.isArray(build?.slis) ? new Set(build.slis) : null;
  return entries.map(en => ({
    id: en.id, title: en.title, kind: en.kind, evidence: en.evidence?.status || null,
    slis: (en.slis || []).map(s => {
      const key = sliKey(en.id, s.id, composed);
      const reachable = atTier(tier, s.minTier);
      const checked = reachable && (explicit ? explicit.has(key) : true);
      return {
        key, id: s.id, type: s.type, minTier: s.minTier, reachable, checked, unit: s.unit || null,
        description: s.description || '', evidence: s.evidence || null, metrics: s.metrics || [],
        objective: reachable ? s.objectives?.[tier] ?? null : null,
        objectiveLabel: reachable ? fmtObjective(s.objectives?.[tier]) : `needs ${s.minTier}`,
        window: reachable ? s.windows?.[tier] ?? null : null,
      };
    }),
  }));
}

/** DEFINE's L1 candidates: every SLI the tier reaches in the selection, with its entry. */
export function sliCandidates({ build, library }) {
  return sliGroups({ build, library }).flatMap(g => g.slis.filter(s => s.reachable).map(s => ({ ...s, entry: g.id, entryTitle: g.title })));
}

/**
 * buildCompileModel({ build, library, clauses }) → per-entry SLI rows (reachable at
 * the tier or disabled with the tier they need, checked, the objective and window
 * this tier gives them), the section toggles, what the last result said, and the
 * live stack: the instantiated pack's artefacts per layer with the slab edges in
 * the clause states (`clauses` is the tier's rubric; without it the edges are
 * neutral and no ghost is drawn).
 */
export function buildCompileModel({ build, library, clauses = [] }) {
  const tier = build?.tier;
  const groups = sliGroups({ build, library });
  const composed = selectedEntries(build, library).length > 1;
  const all = groups.flatMap(g => g.slis);
  const toggles = SECTION_TOGGLES.map(t => ({
    ...t,
    on: build?.toggles?.[t.id] !== false,
    // policy is meaningless without SLOs: the engine drops it when slos is off.
    disabled: t.id === 'policy' && build?.toggles?.slos === false,
  }));
  const r = build?.result || null;
  return {
    tier, composed, groups, toggles,
    counts: { total: all.length, reachable: all.filter(s => s.reachable).length, checked: all.filter(s => s.checked).length },
    atLeastOne: all.some(s => s.checked),
    stack: buildStackModel({
      adapted: r?.adapted || null, requirements: clauses, checklist: buildClauseChecklist(clauses, r?.summary || null),
      todos: r?.todos || [], params: paramRows({ build, library }), mode: 'compile', toggles: build?.toggles || {}, expanded: build?.stackOpen || {},
    }),
    result: r ? {
      sliCount: r.canonical?.spec?.slis?.length || 0, sloCount: r.canonical?.spec?.slos?.length || 0,
      todoCount: r.todos?.length || 0, warningCount: r.warnings?.length || 0,
      schemaOk: (r.schemaErrors || []).length === 0, schemaErrors: r.schemaErrors || [],
      yaml: r.canonicalYaml || '', yamlLines: (r.canonicalYaml || '').split('\n').length,
      fileName: `${r.canonical?.metadata?.name || 'pack'}.pack.yaml`,
      warnings: summarizeWarnings(r.warnings || []),
    } : null,
    error: build?.error ? splitBuildErrors(build.error) : null, stale: isStale(build), pending: !!build?.pending,
  };
}

/** Warnings grouped by kind, labelled, blocking first. */
export function summarizeWarnings(warnings) {
  const byKind = new Map();
  for (const w of warnings || []) {
    const kind = w.kind || 'other';
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(w);
  }
  return [...byKind.entries()]
    .map(([kind, items]) => ({ kind, label: WARNING_KINDS[kind]?.label || kind, hint: WARNING_KINDS[kind]?.hint || '', blocking: !!WARNING_KINDS[kind]?.blocking, items }))
    .sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.kind.localeCompare(b.kind));
}

// ---------- the clause rail (steps 1-3) ----------

/**
 * buildClauseChecklist(clauses, summary) → the tier's clauses with one of three
 * states from the engine's summary — 'pass', 'placeholder' (passes only on a
 * placeholder artefact: summary.onPlaceholder names it), 'fail' — or 'pending'
 * when there is no summary yet. Grouped by dimension for the rail, with counts.
 */
export function buildClauseChecklist(clauses, summary) {
  const onPlaceholder = new Map((summary?.onPlaceholder || []).map(c => [c.id, c]));
  const failing = new Map((summary?.failing || []).map(c => [c.id, c]));
  const passing = new Set(summary?.passing || []);
  const items = (clauses || []).map(c => {
    let state = 'pending';
    if (summary) {
      if (onPlaceholder.has(c.id)) state = 'placeholder';
      else if (failing.has(c.id)) state = 'fail';
      else if (passing.has(c.id)) state = 'pass';
    }
    return {
      id: c.id, dimension: c.dimension, severity: c.severity, minTier: c.minTier, description: c.description, specRef: c.specRef || '',
      state, todos: onPlaceholder.get(c.id)?.todos || failing.get(c.id)?.todos || [],
    };
  });
  const count = (st, sev) => items.filter(i => i.state === st && (!sev || i.severity === sev)).length;
  const dims = [...new Set(items.map(i => i.dimension))];
  return {
    items,
    groups: dims.map(d => ({ dimension: d, items: items.filter(i => i.dimension === d) })),
    counts: {
      total: items.length, pass: count('pass'), placeholder: count('placeholder'), fail: count('fail'), pending: count('pending'),
      must: { total: items.filter(i => i.severity === 'MUST').length, pass: count('pass', 'MUST') + count('placeholder', 'MUST'), fail: count('fail', 'MUST') },
      should: { total: items.filter(i => i.severity === 'SHOULD').length, pass: count('pass', 'SHOULD') + count('placeholder', 'SHOULD'), fail: count('fail', 'SHOULD') },
    },
    conformant: summary ? !!summary.conformant : null,
  };
}

/**
 * The rail's model: the checklist plus the draft's todo / warning counts and its
 * in-flight state. The rail is a compact summary of the stack (the per-layer
 * clauses live on their slabs): `failing` and `onPlaceholder` are what it lists
 * folded, `expanded` whether the full list is open.
 */
export function buildRailModel({ build, clauses }) {
  const r = build?.result || null;
  const checklist = buildClauseChecklist(clauses || [], r?.summary || null);
  return {
    tier: build?.tier, step: build?.step,
    checklist,
    failing: checklist.items.filter(i => i.state === 'fail'),
    onPlaceholder: checklist.items.filter(i => i.state === 'placeholder'),
    expanded: !!build?.railOpen,
    todoCount: r?.todos?.length || 0,
    warningCount: r?.warnings?.length || 0,
    blockingWarnings: (r?.warnings || []).filter(w => w.kind === 'promql').length,
    placeholdersRemaining: placeholdersRemaining(r),
    pending: !!build?.pending, error: build?.error || null, stale: isStale(build), ready: !!r,
    valid: defineValid(build),
  };
}

/** The placeholder params still at their default (each is a todo): provenance.placeholders. */
export function placeholdersRemaining(result) {
  return Array.isArray(result?.provenance?.placeholders) ? result.provenance.placeholders.length : 0;
}

// ---------- VERIFY ----------

/** One todo as the views draw it: its param rows resolved (an unknown key still gets a row), manual when no param fills it. */
function todoRow(t, byKey) {
  return {
    path: t.path, fields: t.fields || [], what: t.what || '', clauses: t.clauses || [],
    params: (t.params || []).map(k => byKey.get(k) || { key: k, label: k, value: null, default: '', placeholder: true, effective: '', error: null }),
    manual: !(t.params || []).length,   // a runbook to write, a baseline to measure: no param fills it
  };
}

/** Todos grouped by artefact family, each todo carrying the param rows that fill it. */
export function groupTodos(todos, params) {
  const byKey = new Map((params || []).map(p => [p.key, p]));
  const groups = ARTEFACT_GROUPS.map(g => ({ id: g.id, label: g.label, todos: [] }));
  for (const t of todos || []) {
    const g = groups.find(x => ARTEFACT_GROUPS.find(a => a.id === x.id).match.test(t.path));
    g.todos.push(todoRow(t, byKey));
  }
  return groups.filter(g => g.todos.length);
}

/**
 * buildVerifyModel({ build, library, clauses, targets }) → the conformance verdict
 * at the tier with the three clause states, the schema verdict, the warnings,
 * the stack with the todos pinned to their slabs (each with the param rows that
 * fill it) and the per-layer maturity, the todos grouped by artefact family, the
 * compile targets as artefact cards, and the hand-off facts (placeholders
 * remaining, registered id).
 */
export function buildVerifyModel({ build, library, clauses, targets }) {
  const r = build?.result || null;
  const params = paramRows({ build, library });
  const checklist = buildClauseChecklist(clauses || [], r?.summary || null);
  const stack = buildStackModel({
    adapted: r?.adapted || null, requirements: clauses || [], checklist,
    todos: r?.todos || [], params, mode: 'verify', toggles: build?.toggles || {}, expanded: build?.stackOpen || {},
  });
  const s = r?.summary || null;
  const blocking = (r?.warnings || []).some(w => w.kind === 'promql');
  const schemaOk = (r?.schemaErrors || []).length === 0;
  const error = build?.error ? splitBuildErrors(build.error) : null;
  // What the footer says about the hand-off, in priority order.
  const handoff = build?.registeredId ? 'registered' : error ? 'error' : blocking ? 'promql' : !schemaOk ? 'schema' : 'ready';
  const gaps = placeholdersRemaining(r);
  return {
    ready: !!r, pending: !!build?.pending, error, stale: isStale(build),
    tier: s?.tier || build?.tier,
    verdict: s ? {
      conformant: !!s.conformant, must: s.must, should: s.should,
      mustPercent: s.mustPercent, scorePercent: s.scorePercent,
      pass: checklist.counts.pass, placeholder: checklist.counts.placeholder, fail: checklist.counts.fail,
      onPlaceholder: s.onPlaceholder || [], failing: s.failing || [],
    } : null,
    checklist,
    stack,
    // The per-layer maturity bars on the verdict card: clause counts per dimension.
    maturity: stack.slabs.filter(sl => sl.maturity.total > 0).map(sl => ({ id: sl.id, num: sl.num, name: sl.name, accent: sl.accent, state: sl.state, ...sl.maturity })),
    schema: { ok: schemaOk, errors: r?.schemaErrors || [] },
    warnings: summarizeWarnings(r?.warnings || []),
    blocking,
    todoGroups: groupTodos(r?.todos || [], params),
    todoCount: r?.todos?.length || 0,
    placeholdersRemaining: placeholdersRemaining(r),
    artifacts: (targets || []).map(t => ({ id: t.id, label: t.label, description: t.description || '', contentType: t.contentType || '', extension: t.extension || '' })),
    preview: build?.preview || null,
    yaml: r?.canonicalYaml || '', fileName: `${r?.canonical?.metadata?.name || 'pack'}.pack.yaml`,
    packName: r?.canonical?.metadata?.name || build?.name || '',
    source: r?.provenance?.source || '',
    registeredId: build?.registeredId || null,
    handoff,
    // "Ready to continue?" — VERIFY's two exits (docs/BUILD_JOURNEY.md "Where it starts"):
    // resolve or adjust (back at Define), or continue with the gaps visible — they stay on
    // the pack as library.todo.* annotations, so Diagnose grades them as gaps, never as verified.
    gaps,
    continueLabel: gaps > 0 ? 'Continue with visible gaps' : 'Continue to Discover',
    readyText: gaps > 0
      ? `Ready to continue? ${gaps} placeholder${gaps === 1 ? '' : 's'} remain — fill them above, resolve or adjust at Define, or continue: they stay visible in Discover and Diagnose grades them as gaps.`
      : 'Ready to continue? No placeholder remains — continuing registers the pack the way an upload is registered and opens it in Discover.',
    // A stale pack (the last compilation failed) is never handed off: the error stands until the field is fixed.
    canRegister: !!r && schemaOk && !blocking && !error,
  };
}

// ---------- the layer stack (steps 1-3; docs/BUILD_JOURNEY.md "The scan") ----------

/**
 * A short name per rubric clause for its ghost card — the card's title; the clause's
 * description is the card's desc. The rubric is tools/lib/conformance.mjs; an id not
 * listed here is humanised from its last segment. An L4 clause also says which
 * subgroup (policy · alerting · self-healing) it shapes.
 */
export const CLAUSE_GHOSTS = {
  'L1.MUST.availability_slo': { label: 'availability SLO' },
  'L1.MUST.latency_slo': { label: 'latency SLO' },
  'L1.SHOULD.domain_slo': { label: 'domain SLO' },
  'L1.MUST.sli_covered_by_slo': { label: 'every SLI under an SLO' },
  'L2.MUST.otlp_receiver': { label: 'otlp receiver' },
  'L2.MUST.service_name_required': { label: 'service.name required' },
  'L2.MUST.semconv_floor': { label: 'SemConv ≥ 1.26.0' },
  'L2.MUST.semconv_current': { label: 'SemConv 1.27.0' },
  'L2.MUST.resource_attrs_5plus': { label: '5+ resource attributes' },
  'L2.MUST.log_correlation': { label: 'log correlation' },
  'L2.MUST.metrics_exporter': { label: 'metrics exporter' },
  'L2.MUST.logs_and_traces_exporters': { label: 'logs + traces exporters' },
  'L2.MUST.tail_sampling': { label: 'tail sampling' },
  'L2.MUST.metrics_logs_traces_backends': { label: 'metrics + logs + traces backends' },
  'L2.SHOULD.backend_gating_enforce': { label: 'backend gating: enforce' },
  'L2X.MUST.extended_backend_refs_resolve': { label: 'extended backend refs resolve' },
  'L3.MUST.recording_rule_per_slo': { label: 'recording rule per SLO' },
  'L3.SHOULD.derived_view': { label: 'derived view' },
  'L3.MUST.service_overview_dashboard': { label: 'service overview board' },
  'L3.MUST.slo_burn_dashboard': { label: 'SLO burn board' },
  'L3.MUST.tier1_dashboards': { label: 'deployment overlay + customer impact boards' },
  'L4.MUST.multi_window_burn_rate': { label: 'multi-window burn alerts', subgroup: 'policy' },
  'L4.SHOULD.forecast_on_availability': { label: 'forecast on availability', subgroup: 'policy' },
  'L4.MUST.tier1_voice_route': { label: 'SEV1 voice route', subgroup: 'alerting' },
  'L4.MUST.tier1_at_least_one_automation': { label: 'self-healing remediation', subgroup: 'healing' },
  'L5.SHOULD.tier1_release_gate': { label: 'release gate' },
  'L5.MUST.synthetic_probe': { label: 'synthetic probe' },
  'L5.MUST.tier1_chaos_for_each_slo': { label: 'chaos per SLO' },
  'L5.MUST.tier2_chaos_staging': { label: 'chaos in staging' },
  'L5.MUST.tier1_weekly_prod_chaos': { label: 'weekly prod chaos' },
};
const ACRONYMS = { slo: 'SLO', slos: 'SLOs', sli: 'SLI', slis: 'SLIs', otlp: 'OTLP', semconv: 'SemConv', otel: 'OTel', mttd: 'MTTD', mttr: 'MTTR', sev1: 'SEV1' };
/** The ghost's title for a clause id: the table's label, else the id's last segment humanised. */
export function clauseGhostLabel(id) {
  if (CLAUSE_GHOSTS[id]) return CLAUSE_GHOSTS[id].label;
  return String(id || '').split('.').pop().split('_').filter(Boolean).map(w => ACRONYMS[w] || w).join(' ');
}
/** The L4 subgroup an L4 clause shapes: the table's, else by keyword (route → alerting, automation / remediation → healing, the rest policy). */
export function clauseSubgroup(id) {
  if (CLAUSE_GHOSTS[id]?.subgroup) return CLAUSE_GHOSTS[id].subgroup;
  const s = String(id || '').toLowerCase();
  if (/route|voice|channel/.test(s)) return 'alerting';
  if (/automation|remediat|heal|runbook/.test(s)) return 'healing';
  return 'policy';
}

/**
 * Which slab a todo lands on — the artefact family of its path (the adapter symbol the
 * engine writes: `alerting.routes[0]`, `telemetry.backends.<id>`, `validation.synthetic_checks.<id>`,
 * `remediation[0]`, `baselines`, `metadata.owners`) — and, on L4, which subgroup.
 */
export const TODO_LAYERS = [
  { match: /^(slis|slos)\b/, layer: 'L1', subgroup: null },
  { match: /^(otel|telemetry|pipelines|storage)\b/, layer: 'L2', subgroup: null },
  { match: /^(profiling|network|policy_engine|mesh|collection)\b/, layer: 'L2X', subgroup: null },
  { match: /^(queries|dashboards)\b/, layer: 'L3', subgroup: null },
  { match: /^policy\b/, layer: 'L4', subgroup: 'policy' },
  { match: /^alerting\b/, layer: 'L4', subgroup: 'alerting' },
  { match: /^remediation\b/, layer: 'L4', subgroup: 'healing' },
  { match: /^(validation|baselines)\b/, layer: 'L5', subgroup: null },
  { match: /^metadata\b/, layer: 'GOV', subgroup: null },
];
export function todoLayer(path) {
  const hit = TODO_LAYERS.find(t => t.match.test(String(path || '')));
  return hit ? { layer: hit.layer, subgroup: hit.subgroup } : { layer: 'GOV', subgroup: null };
}

/**
 * The adapter symbol of an artefact — the key `library.todo.<symbol>` (and
 * `mcp.verified.<symbol>`) is written under: the artefact's own `defines` when it has
 * one, else rebuilt from the adapter's id scheme (tools/lib/adapter.mjs: `PIP-RCV-02` is
 * `pipelines.receivers[1]`, `ALR-01` `alerting.routes[0]`, `SYN-03` the third synthetic
 * check by its id …). What pins a todo to its card; null when the id is not one the
 * adapter mints from a canonical section.
 */
const SIGNAL_FAMILY = { MET: 'metrics', LOG: 'logs', TRC: 'traces' };
export function artefactSymbol(a) {
  if (!a) return null;
  if (a.defines) return a.defines;
  const id = String(a.id || '');
  const fixed = { 'OTEL-01': 'otel', 'BASE-01': 'baselines', 'PROF-01': 'profiling', 'NET-01': 'network', 'POE-01': 'policy_engine' };
  if (fixed[id]) return fixed[id];
  const indexed = [
    [/^PIP-RCV-(\d+)$/, 'pipelines.receivers'], [/^PIP-PRC-(\d+)$/, 'pipelines.processors'], [/^QRY-(\d+)$/, 'queries.recording_rules'],
    [/^POL-(\d+)$/, 'policy.burn_rate_alerts'], [/^FCST-(\d+)$/, 'policy.forecasts'], [/^ALR-(\d+)$/, 'alerting.routes'],
    [/^HEAL-(\d+)$/, 'remediation'], [/^MESH-(\d+)$/, 'mesh'], [/^COL-(\d+)$/, 'collection'],
  ];
  for (const [re, head] of indexed) { const m = re.exec(id); if (m) return `${head}[${Number(m[1]) - 1}]`; }
  let m;
  if ((m = /^PIP-EXP-(MET|LOG|TRC)$/.exec(id))) return `pipelines.exporters.${SIGNAL_FAMILY[m[1]]}`;
  if ((m = /^STO-(MET|LOG|TRC)-01$/.exec(id))) return `storage.${SIGNAL_FAMILY[m[1]]}`;
  if (/^CHAOS-\d+$/.test(id)) return `validation.chaos_experiments.${a.title}`;
  if (/^SYN-\d+$/.test(id)) return `validation.synthetic_checks.${a.title}`;
  if (/^PANEL-\d+$/.test(id) && a.parent) return `${a.parent}.panels.${a.title}`;
  return null;
}

/**
 * The detail artefacts Discover folds behind a section's Expand toggle (layers-view.mjs
 * expandBucketsFor): anything the adapter marks `expand` (dashboard panels, the metric
 * inventory, scrape evidence) and, on L3, the recording rules and derived views.
 */
export function isDetailArtefact(a, layerId) {
  if (a?.expand) return true;
  if (layerId !== 'L3') return false;
  const tags = a?.tags || [];
  return tags.includes('recording') || tags.includes('view') || tags.includes('derived');
}

/** The sections a toggle switches off, per slab (L4 per subgroup): what dims a slab. */
const SECTION_SLABS = {
  slos: [['L1', null], ['L4', 'policy']],
  policy: [['L4', 'policy']],
  routes: [['L4', 'alerting']],
  dashboards: [['L3', null]],
  validation: [['L5', null]],
};

/** The slab's edge from the clause states of its dimension: fail > pending > placeholder > pass; neutral when no clause applies. */
export function slabState(clauses) {
  if (!clauses.length) return 'neutral';
  if (clauses.some(c => c.state === 'fail')) return 'fail';
  if (clauses.some(c => c.state === 'pending')) return 'pending';
  if (clauses.some(c => c.state === 'placeholder')) return 'placeholder';
  return 'pass';
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function slabStateText(state, m) {
  switch (state) {
    case 'neutral': return 'no clause applies';
    case 'pending': return `${plural(m.total, 'clause')} to evaluate`;
    case 'fail': return `${m.fail} of ${plural(m.total, 'clause')} fail${m.fail === 1 ? 's' : ''}`;
    case 'placeholder': return `${m.pass + m.placeholder} of ${m.total} pass · ${m.placeholder} on a placeholder`;
    default: return `${m.total} of ${plural(m.total, 'clause')} pass`;
  }
}
const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

/**
 * buildStackModel({ adapted, checklist, requirements, candidates, todos, params, mode,
 * toggles, expanded }) → { mode, slabs, counts, compiled }: the layer stack of the pack
 * being compiled, in LAYER_DEFS order.
 *
 *   adapted       the adapter's layered projection (the instantiate response's `adapted`); null before the first result
 *   checklist     buildClauseChecklist(...) of the tier's clauses: the edge states and the maturity
 *   requirements  the tier's clauses (tierRequirements); the checklist's items when absent — the silhouette
 *   candidates    DEFINE only: sliCandidates(...) — the selection's SLIs at the tier, ghosted on L1 with their SLO
 *   todos, params the engine's todos and the param rows that fill them: pinned to the slab of the artefact they name
 *   mode          'define' (silhouette: every clause a ghost, no artefact) | 'compile' | 'verify' (the artefacts;
 *                 a ghost only for a clause still unmet, or for every clause while nothing is compiled yet)
 *   toggles       the section toggles: a slab whose section is off is `dimmed` (its clauses go red on the edge by themselves)
 *   expanded      { [layerId]: true } — which slabs show their clause list
 *
 * Each slab: { id, num, name, accent, state, stateText, clauses, artefacts, ghosts, todos,
 * subgroups (L4), counts, maturity, dimmed, offSections, expanded, why, present }. L2X is
 * present only when it has an artefact or a clause; GOV has no clause and is neutral.
 * Nothing here is invented: the artefacts are the adapter's, untouched (each gains its
 * `symbol` and, when a todo names it, `todoPath`); the ghosts are the rubric; the states
 * are the checklist's.
 */
export function buildStackModel({ adapted = null, checklist = null, requirements = null, candidates = [], todos = [], params = [], mode = 'compile', toggles = {}, expanded = {} } = {}) {
  const stateOf = new Map((checklist?.items || []).map(i => [i.id, i]));
  const clauseList = (requirements || checklist?.items || []).map(c => {
    const st = stateOf.get(c.id);
    return {
      id: c.id, dimension: c.dimension, severity: c.severity, minTier: c.minTier, description: c.description || '',
      label: clauseGhostLabel(c.id), state: st?.state || 'pending', todos: st?.todos || [],
      subgroup: c.dimension === 'L4' ? clauseSubgroup(c.id) : null,
    };
  });
  const byKey = new Map((params || []).map(p => [p.key, p]));
  const todoRows = (todos || []).map(t => ({ ...todoRow(t, byKey), ...todoLayer(t.path), artefactId: null }));
  const todoByPath = new Map(todoRows.map(t => [t.path, t]));
  const layers = adapted?.layers || null;
  const withSymbols = (items, layerId) => (items || []).map(a => {
    const symbol = artefactSymbol(a);
    const todo = symbol ? todoByPath.get(symbol) : null;
    if (todo) todo.artefactId = a.id;
    return { ...a, symbol, todoPath: todo ? todo.path : null, detail: isDetailArtefact(a, layerId) };
  });
  const ghostOf = (c) => ({
    kind: 'clause', key: `clause:${c.id}`, clauseId: c.id, title: c.label, desc: c.description, severity: c.severity, minTier: c.minTier,
    state: c.state, subgroup: c.subgroup,
    // 'Required' while the silhouette is drawn, 'Missing' (Discover's word: required, not present) once a pack exists and the clause fails.
    source: mode === 'define' || !layers ? 'Required' : 'Missing',
    tool: c.id, tags: [c.severity, c.minTier],
  });
  const candidateGhosts = mode === 'define'
    ? (candidates || []).flatMap(c => [
      { kind: 'sli', key: `sli:${c.key}`, title: c.key, desc: c.description || `${c.type} SLI`, source: 'Candidate', tool: `${c.type} SLI`, tags: ['sli', c.type, c.entry].filter(Boolean), evidence: c.evidence || null, state: null },
      { kind: 'slo', key: `slo:${c.key}`, title: `SLO on ${c.key}`, desc: `${c.objectiveLabel} over ${c.window || '—'}`, source: 'Candidate', tool: 'SLO', tags: ['slo', c.window].filter(Boolean), evidence: null, state: null },
    ])
    : [];
  const ghostsFor = (clauses) => {
    if (mode === 'define' || !layers) return clauses.map(ghostOf);
    return clauses.filter(c => c.state === 'fail').map(ghostOf);
  };
  const offFor = (layerId, subgroup) => Object.keys(SECTION_SLABS).filter(sec => toggles?.[sec] === false && SECTION_SLABS[sec].some(([l, sg]) => l === layerId && (sg === null || subgroup === undefined || sg === subgroup)));

  const slabs = [];
  for (const def of LAYER_DEFS) {
    const clauses = clauseList.filter(c => c.dimension === def.id);
    const slabTodos = todoRows.filter(t => t.layer === def.id);
    let artefacts, ghosts, subgroups = null;
    if (def.id === 'L4') {
      subgroups = L4_SUBGROUPS.map(sg => ({
        key: sg.key, label: sg.label,
        artefacts: mode === 'define' ? [] : withSymbols(layers?.L4?.[sg.key], 'L4'),
        ghosts: ghostsFor(clauses.filter(c => c.subgroup === sg.key)),
        todos: slabTodos.filter(t => t.subgroup === sg.key),
        offSections: offFor('L4', sg.key),
      }));
      artefacts = subgroups.flatMap(sg => sg.artefacts);
      ghosts = subgroups.flatMap(sg => sg.ghosts);
    } else {
      artefacts = mode === 'define' ? [] : withSymbols(layers?.[def.id], def.id);
      ghosts = [...(def.id === 'L1' ? candidateGhosts : []), ...ghostsFor(clauses)];
    }
    // L2X is optional per spec v1.2: shown only when it has content or a clause of its own.
    if (def.id === 'L2X' && !artefacts.length && !clauses.length) continue;
    const m = {
      total: clauses.length,
      pass: clauses.filter(c => c.state === 'pass').length,
      placeholder: clauses.filter(c => c.state === 'placeholder').length,
      fail: clauses.filter(c => c.state === 'fail').length,
      pending: clauses.filter(c => c.state === 'pending').length,
    };
    const maturity = {
      ...m,
      pct: m.total ? pct(m.pass + m.placeholder, m.total) : null,
      passPct: pct(m.pass, m.total), placeholderPct: pct(m.placeholder, m.total), failPct: pct(m.fail, m.total), pendingPct: pct(m.pending, m.total),
    };
    const state = slabState(clauses);
    const offSections = offFor(def.id, undefined);
    slabs.push({
      id: def.id, num: def.num, name: def.name, accent: DISCO_SLAB_ACCENT[def.id] || '#64748b',
      state, stateText: slabStateText(state, m),
      clauses, artefacts, ghosts, todos: slabTodos, subgroups,
      counts: {
        artefacts: artefacts.length, scaffold: artefacts.filter(a => a.source === 'Scaffold').length, verified: artefacts.filter(a => a.source === 'Verified').length,
        detail: artefacts.filter(a => a.detail).length,
        ghosts: ghosts.length, todos: slabTodos.length, clauses: clauses.length,
      },
      maturity,
      dimmed: offSections.length > 0, offSections,
      expanded: !!expanded?.[def.id],
      // The detail artefacts Discover folds behind its Expand toggles (panels, queries, live evidence), shown on demand.
      detailOpen: !!expanded?.[`${def.id}/detail`],
      // A red or amber edge says which clause and why.
      why: clauses.filter(c => c.state === 'fail' || c.state === 'placeholder').map(c => `${c.id} — ${c.state === 'fail' ? c.description : `passes on ${plural(c.todos.length, 'placeholder')}: ${c.todos.join(', ')}`}`),
      present: artefacts.length > 0,
    });
  }
  const counts = {
    slabs: slabs.length,
    artefacts: slabs.reduce((n, s) => n + s.counts.artefacts, 0),
    scaffold: slabs.reduce((n, s) => n + s.counts.scaffold, 0),
    ghosts: slabs.reduce((n, s) => n + s.counts.ghosts, 0),
    todos: slabs.reduce((n, s) => n + s.counts.todos, 0),
    clauses: {
      total: clauseList.length,
      pass: clauseList.filter(c => c.state === 'pass').length, placeholder: clauseList.filter(c => c.state === 'placeholder').length,
      fail: clauseList.filter(c => c.state === 'fail').length, pending: clauseList.filter(c => c.state === 'pending').length,
    },
    litSlabs: slabs.filter(s => s.present).length,
  };
  return { mode, slabs, counts, compiled: !!layers };
}
