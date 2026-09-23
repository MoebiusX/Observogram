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
  return {
    name, slug: serviceSlug(name), owners: build?.owners || '', ownerList: parseOwners(build?.owners), environment: build?.environment || 'prod',
    tier: build?.tier, tiers,
    products: rows.filter(r => r.kind === 'product').map(card),
    archetypes: rows.filter(r => r.kind === 'archetype').map(card),
    selectedEntries: selectedEntries(build, library).map(card),
    params,
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
 * buildCompileModel({ build, library }) → per-entry SLI rows (reachable at the
 * tier or disabled with the tier they need, checked, the objective and window
 * this tier gives them), the section toggles, and what the last result said.
 */
export function buildCompileModel({ build, library }) {
  const entries = selectedEntries(build, library);
  const composed = entries.length > 1;
  const tier = build?.tier;
  const explicit = Array.isArray(build?.slis) ? new Set(build.slis) : null;
  const groups = entries.map(en => ({
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

/** The rail's model: the checklist plus the draft's todo / warning counts and its in-flight state. */
export function buildRailModel({ build, clauses }) {
  const r = build?.result || null;
  return {
    tier: build?.tier, step: build?.step,
    checklist: buildClauseChecklist(clauses || [], r?.summary || null),
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

/** Todos grouped by artefact family, each todo carrying the param rows that fill it. */
export function groupTodos(todos, params) {
  const byKey = new Map((params || []).map(p => [p.key, p]));
  const groups = ARTEFACT_GROUPS.map(g => ({ id: g.id, label: g.label, todos: [] }));
  for (const t of todos || []) {
    const g = groups.find(x => ARTEFACT_GROUPS.find(a => a.id === x.id).match.test(t.path));
    g.todos.push({
      path: t.path, fields: t.fields || [], what: t.what || '', clauses: t.clauses || [],
      params: (t.params || []).map(k => byKey.get(k) || { key: k, label: k, value: null, default: '', placeholder: true, effective: '', error: null }),
      manual: !(t.params || []).length,   // a runbook to write, a baseline to measure: no param fills it
    });
  }
  return groups.filter(g => g.todos.length);
}

/**
 * buildVerifyModel({ build, targets }) → the conformance verdict at the tier
 * with the three clause states, the schema verdict, the warnings, the todos
 * grouped by artefact with their params, the compile targets as artefact
 * cards, and the hand-off facts (placeholders remaining, registered id).
 */
export function buildVerifyModel({ build, library, clauses, targets }) {
  const r = build?.result || null;
  const params = paramRows({ build, library });
  const checklist = buildClauseChecklist(clauses || [], r?.summary || null);
  const s = r?.summary || null;
  const blocking = (r?.warnings || []).some(w => w.kind === 'promql');
  const schemaOk = (r?.schemaErrors || []).length === 0;
  const error = build?.error ? splitBuildErrors(build.error) : null;
  // What the footer says about the hand-off, in priority order.
  const handoff = build?.registeredId ? 'registered' : error ? 'error' : blocking ? 'promql' : !schemaOk ? 'schema' : 'ready';
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
    // A stale pack (the last compilation failed) is never handed off: the error stands until the field is fixed.
    canRegister: !!r && schemaOk && !blocking && !error,
  };
}
