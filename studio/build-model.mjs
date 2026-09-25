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
// artefact each names). The layer names are the studio's constants (a
// slab's colour is its layer token, .section[data-layer], in the
// stylesheet); nothing is invented here.
//
// The axis (docs/BUILD_JOURNEY.md "The axis"): the pack is the axis of the
// Build screen — a definition column on the left (buildDefinitionModel: the
// service, the tier as a segmented control, the entries as chips, the
// conformance summary) and the stack as the main surface, each slab opening
// a per-layer sheet (buildSheetModel: the layer's question, its clauses,
// and its options — the SLI rolodex on L1, the section switches with the
// clauses they drop, the params placed on the layer they shape, the lists
// read from the adapter's projection). The sheet writes through the same
// actions the steps always had (setSli / addSli, setToggle, setParam,
// toggleEntry, setTier); the models here only say what to draw.
//
// The seed and the copies (docs/BUILD_JOURNEY.md "The seed and the copies"):
// the tier is a seed, never a gate — the rolodex never disables an SLI above
// the tier (it says which profile it starts from), addSliSelection never
// refuses one, retargetSlis keeps every SLI of a still-selected entry across
// a tier change and only refreshes the tier's defaults; the library values
// are copies the user edits (build.overrides, build.custom — the pure editor
// and create-form models live in build-copies-model.mjs; buildEditorModel
// below finds the SLI the open editor is over and hands it to them), and
// DEFINE is the seeding step: buildStepReachability opens COMPILE once the
// definition is valid AND seeded, and the definition column becomes a
// read-only seed card there (seedCardModel).

import { LAYER_DEFS, L4_SUBGROUPS } from './constants.mjs';
import { OVERRIDE_FIELDS, overrideFor, effectiveSli, effectiveId, customisedFields, promqlEdited, customEffective, sliEditorModel, sliName } from './build-copies-model.mjs';
import { boundText } from './sli-direction.mjs';

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
  override: { label: 'Override kept aside', blocking: false, hint: 'an override names an SLI that is not in the pack; nothing is applied until it is' },
  'burn-rules': { label: 'Burn rules', blocking: false, hint: 'the burn-rule generator’s own warnings on the produced policy' },
};
/** The one-line note at the top of the DEFINE column once the pack is seeded. */
export const SEEDED_NOTE = 'Seeded. Changing the tier re-grades the pack and refreshes library defaults; your customisations stay. Removing a product drops its SLIs.';
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
 * Whether the definition was seeded ("Seed the pack →" on DEFINE). A draft persisted before the seed existed
 * (no `seeded` field) that sits on COMPILE or VERIFY was seeded in all but name: it counts as seeded, so a
 * reload lands where it was (the controller migrates the field on load; this tolerates it either way).
 */
export function isSeeded(build) {
  if (!build) return false;
  if (typeof build.seeded === 'boolean') return build.seeded;
  return ['compile', 'verify'].includes(LEGACY_STEP[build.step] || build.step);
}

/**
 * Which header cards are reachable: DEFINE always; COMPILE when the definition is valid AND seeded (the
 * definition is a wizard stage: what the pack starts from is confirmed once, then it recedes into the seed
 * card); VERIFY additionally needs a pack with at least one SLI. A usage error keeps the previous pack (the
 * controller marks it stale rather than dropping it), so Verify stays reachable while the field the error
 * names is fixed — on Verify itself, where the param inputs are.
 */
export function buildStepReachability(build) {
  const define = true;
  const compile = defineValid(build) && isSeeded(build);
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
  const byOverride = {};   // { [sliKey]: { [field]: why } } — `override <sli>.<field>: …`, shown on the card's edit face
  const byCustom = {};     // { [id]: { [field | '']: why } } — `custom <id>.<field>: …` / `custom <id>: …`, shown on the custom card
  const general = [];
  for (const e of errors || []) {
    const text = String(e);
    let m;
    if ((m = /^param ([^\s:]+): ([\s\S]+)$/.exec(text))) byParam[m[1]] = m[2];
    else if ((m = /^override ([a-z][a-z0-9_]*)\.([a-z_]+): ([\s\S]+)$/.exec(text))) (byOverride[m[1]] ??= {})[m[2]] = m[3];
    else if ((m = /^custom ([a-z][a-z0-9_]*)(?:\.([a-z_]+))?: ([\s\S]+)$/.exec(text))) (byCustom[m[1]] ??= {})[m[2] || ''] = m[3];
    else if ((m = /^custom\[\d+\](?:\.([a-z_]+))?: ([\s\S]+)$/.exec(text))) (byCustom[''] ??= {})[m[1] || ''] = m[2];
    else general.push(text);
  }
  return { byParam, byOverride, byCustom, general, paramCount: Object.keys(byParam).length, count: (errors || []).length };
}

/** The last instantiation failed while an earlier pack is still shown: what the views mark stale. */
export function isStale(build) { return !!(build?.error && build?.result); }

/** Step ids a draft may carry from before the rename (2026-09-23): they resume on the same step. */
export const LEGACY_STEP = { select: 'define', generate: 'compile', validate: 'verify' };
/** The furthest reachable step at or before `wanted` (a legacy id counts as its current name). */
export function clampStep(build, wanted) {
  wanted = LEGACY_STEP[wanted] || wanted;
  const reach = buildStepReachability(build);
  const idx = Math.max(0, BUILD_STEPS.indexOf(wanted));
  for (let i = idx; i >= 0; i--) if (reach[BUILD_STEPS[i]]) return BUILD_STEPS[i];
  return 'define';
}

const SLI_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;   // the engine's SLI_KEY_RE: what an override may be keyed by
/**
 * A persisted draft (inputs only, `fields` = BUILD_PERSIST_FIELDS) restored over `defaults` (a fresh
 * defaultBuildState()): strings and lists filtered to their types, the toggles merged, the overrides as
 * { key: { field: value } } (own plain objects, SLI keys, known fields only), the custom SLIs as plain objects
 * with a string id, a legacy step id (select · generate · validate) mapped to its current name — it used to be
 * dropped by the step check, which landed a 'validate' draft on DEFINE — and a draft persisted before the seed
 * existed (no `seeded`) that sits on COMPILE or VERIFY marked seeded: it was, in all but name. Pure.
 */
export function restoreBuildDraft(saved, defaults, fields) {
  const next = { ...defaults };
  const src = saved && typeof saved === 'object' ? saved : {};
  for (const k of fields) {
    const v = src[k];
    if (v === undefined || v === null) continue;
    if (k === 'toggles' && typeof v === 'object' && !Array.isArray(v)) { next.toggles = { ...next.toggles, ...v }; continue; }
    if (k === 'params' && typeof v === 'object' && !Array.isArray(v)) { next.params = { ...v }; continue; }
    if (k === 'overrides' && typeof v === 'object' && !Array.isArray(v)) {
      next.overrides = Object.fromEntries(Object.entries(v)
        .filter(([key, ov]) => SLI_KEY_RE.test(key) && ov && typeof ov === 'object' && !Array.isArray(ov))
        .map(([key, ov]) => [key, Object.fromEntries(Object.entries(ov).filter(([field]) => OVERRIDE_FIELDS.includes(field)))]));
      continue;
    }
    if (k === 'custom' && Array.isArray(v)) { next.custom = v.filter(d => d && typeof d === 'object' && !Array.isArray(d) && typeof d.id === 'string').map(d => ({ ...d })); continue; }
    if (k === 'seeded') { if (typeof v === 'boolean') next.seeded = v; continue; }
    if (k === 'entries' && Array.isArray(v)) { next.entries = v.filter(x => typeof x === 'string'); continue; }
    if (k === 'slis' && Array.isArray(v)) { next.slis = v.filter(x => typeof x === 'string'); continue; }
    if (k === 'step') { const step = LEGACY_STEP[v] || v; if (BUILD_STEPS.includes(step)) next.step = step; continue; }
    if (k === 'tier') { if (TIERS.includes(v)) next.tier = v; continue; }
    if (['name', 'owners', 'environment', 'registeredId'].includes(k) && typeof v === 'string') next[k] = v;
  }
  if (typeof src.seeded !== 'boolean' && ['compile', 'verify'].includes(LEGACY_STEP[src.step] || src.step)) next.seeded = true;
  return next;
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
 * filled and disappeared): the selectors to try in order — for an input on the layer
 * sheet, the sheet's first param input then its close control (the sheet stays open); for
 * an input on a slab, the first param input left on the same slab, then the slab's head;
 * for a tier segment (`tier:<id>`) the checked segment, for a library chip (`entry:<id>`)
 * that chip then the first chip — or none for a key that is none of these. The segments
 * and the chips carry their key so an arrow key on the radiogroup or a second Space on a
 * chip still has a focused control after the re-render each one causes.
 */
export function focusFallbackSelectors(key) {
  const k = String(key || '');
  if (/^tier:/.test(k)) return ['.build-seg-btn[aria-checked="true"]'];
  // A per-field '↺ library default' (ov:<sli>:<field>:reset) that vanished — the field is back at its default —
  // hands focus to that field's input first, then stays in the editor.
  const reset = /^((?:ov|cu):[^:]+:[a-z_]+):reset$/.exec(k);
  if (reset) return [`[data-focus-key="${reset[1]}"]`, '.build-editor .build-edit-input', '.build-editor [data-editor-done]', '.build-editor [data-editor-close]'];
  // An editor field (ov:<sli>:<field>, cu:<id>:<field>, cf:<field>) that vanished — the type changed the fields, the
  // SLI left the pack, the editor closed — stays in the editor while it is open, else lands on the sheet.
  if (/^(ov|cu|cf):/.test(k)) return ['.build-editor .build-edit-input', '.build-editor [data-editor-done]', '.build-editor [data-editor-close]', '.build-sheet .build-rolo-card [data-edit-sli]', '.build-sheet-close'];
  // One of the editor's own controls (editor:done / cancel / reset-all / close; Reset all vanishes once nothing is customised) stays in the editor.
  if (/^editor:/.test(k)) return ['.build-editor [data-editor-done]', '.build-editor [data-editor-submit]', '.build-editor [data-editor-close]', '.build-editor .build-edit-input'];
  // A rolodex card's Edit / '+ Custom SLI' (edit:<key>) or switch (sli:<entry>:<id>) that vanished — the SLI was removed — hands focus to the sheet.
  if (/^(edit|sli):/.test(k)) return ['.build-sheet .build-rolo-card [data-edit-sli]', '.build-sheet .build-param-input', '.build-sheet-close'];
  // An L1 stack card (card:<artefact id>, ghost:<key>) that vanished — the SLI left the pack — hands focus to the L1 slab head.
  if (/^(card|ghost):/.test(k)) return ['.build-slab[data-layer="L1"] .build-slab-edge'];
  // A Review suggestion (DEFINE, substep 4) that vanished — its technology was removed — hands focus to the first
  // suggestion left, then to the substep's heading.
  if (/^sugg(-edit)?:/.test(k)) return ['.bd-sugg-box', '[data-focus-key="dpanel:review"]'];
  const entry = /^entry:([\w.-]+)$/.exec(k);
  if (entry) return [`.build-chip[data-entry="${entry[1]}"]`, '.build-chip'];
  const m = /^param:[^@]+@([^/]+)\//.exec(k);
  if (!m) return [];
  const slab = `.build-slab[data-layer="${m[1]}"]`;
  const onSheet = /@[^/]+\/sheet(\/|$)/.test(String(key));
  return [...(onSheet ? ['.build-sheet .build-param-input', '.build-sheet-close'] : []), `${slab} .build-param-input`, `${slab} .build-slab-edge`];
}

/** The focus-key suffix of a param input on a layer sheet: `L4/sheet` (a plain param) or `L4/sheet/<todo path>` (a todo's input on VERIFY). */
export function sheetFocusSuffix(layerId, path = null) {
  return path ? `${layerId}/sheet/${path}` : `${layerId}/sheet`;
}

/** The stack's `expanded` map from the draft: the detail folds (`stackOpen`) plus the layer whose sheet is open. */
export function stackExpanded(build) {
  return { ...(build?.stackOpen || {}), ...(build?.sheetOpen ? { [build.sheetOpen]: true } : {}) };
}

// ---------- the SLI selection across tiers ----------

/** The SLI keys a tier reaches for the selection — the tier's defaults (the engine's defaultToggles). */
export function reachableSliKeys(build, library, tier = build?.tier) {
  const entries = selectedEntries(build, library);
  const composed = entries.length > 1;
  return entries.flatMap(en => (en.slis || []).filter(s => atTier(tier, s.minTier)).map(s => sliKey(en.id, s.id, composed)));
}
/** Every SLI key of the selected entries, at any tier — what an explicit list may contain (the tier is a seed, not a gate). */
export function allSliKeys(build, library) {
  const entries = selectedEntries(build, library);
  const composed = entries.length > 1;
  return entries.flatMap(en => (en.slis || []).map(s => sliKey(en.id, s.id, composed)));
}
/** The library SLI keys in the pack: the explicit list (known keys only) or the tier's defaults. */
export function selectedSliKeys(build, library) {
  const all = allSliKeys(build, library);
  return Array.isArray(build?.slis) ? build.slis.filter(k => all.includes(k)) : reachableSliKeys(build, library);
}
const sameSet = (a, b) => a.length === b.length && a.every(k => b.includes(k));

/**
 * The explicit SLI list after a tier change (`prevTier` → build.tier) or an entry change: every key of a
 * still-selected entry stays — above the new tier too, with its overrides (the tier never forbids; the user
 * chose it) — a key whose entry left the selection drops, and a key the new tier unlocks comes in ticked (the
 * tier refreshes the library's defaults). An explicit list stays explicit: it never collapses to null here —
 * at tier-1 every key is a default, and a list collapsed there lost an above-tier pick on the way back down
 * (measured: tier-2 + controller_election_rate → tier-1 → tier-2 came back without it). null (the defaults)
 * stays null: the defaults follow the tier by themselves. Without `prevTier` it only drops the keys of
 * entries no longer selected.
 */
export function retargetSlis(build, library, prevTier) {
  if (!Array.isArray(build?.slis)) return null;
  const all = allSliKeys(build, library);
  const now = reachableSliKeys(build, library);
  const before = new Set(prevTier ? reachableSliKeys(build, library, prevTier) : now);
  const keep = new Set(build.slis.filter(k => all.includes(k)));
  for (const k of now) if (!before.has(k)) keep.add(k);
  return all.filter(k => keep.has(k));
}

/** The SLI keys of an entry set as that set composes them → [entryId, sliId]: what a key meant before a composition change. */
function sliOwners(entries, library) {
  const rows = library?.entries || [];
  const composed = entries.length > 1;
  const owner = new Map();
  for (const id of entries) for (const s of (rows.find(r => r.id === id)?.slis || [])) owner.set(sliKey(id, s.id, composed), [id, s.id]);
  return owner;
}

/**
 * The explicit SLI list after the entry set changed (`prevEntries` → build.entries): every pick of a
 * still-selected entry stays — re-keyed for the new composition (one entry to two prefixes every id, and
 * back) — a key of an entry that left drops with it (the note on DEFINE says so), and an entry that joins
 * brings the tier's defaults of its own. The list collapses to null only when nothing user-made is left in it
 * (it equals the new composition's defaults); a never-edited list stays null. Nulling the list on every entry
 * change reset the OTHER entries' picks (measured: with kafka + http-service, an above-tier kafka pick and an
 * un-ticked http-service SLI, deselecting and reselecting kafka lost the pick and re-ticked the SLI). Pure.
 */
export function retargetSlisForEntries({ build, library }, prevEntries) {
  if (!Array.isArray(build?.slis)) return null;
  const prev = Array.isArray(prevEntries) ? prevEntries : (build?.entries || []);
  const now = build?.entries || [];
  const composed = now.length > 1;
  const owner = sliOwners(prev, library);
  const keep = new Set();
  for (const k of build.slis) { const hit = owner.get(k); if (hit && now.includes(hit[0])) keep.add(sliKey(hit[0], hit[1], composed)); }
  const joined = { ...build, entries: now.filter(id => !prev.includes(id)) };
  for (const k of reachableSliKeys(joined, library)) keep.add(sliKey(...sliOwners(joined.entries, library).get(k), composed));
  const slis = allSliKeys(build, library).filter(k => keep.has(k));
  return sameSet(slis, reachableSliKeys(build, library)) ? null : slis;
}

/**
 * The overrides after the entry set changed (`prevEntries` → build.entries): the SLI ids the pack carries are
 * prefixed once several entries compose, so an override keyed `broker_availability` becomes
 * `kafka_broker_availability` when a second entry joins (and back). A key of an entry no longer selected
 * drops with its SLI — the note on DEFINE says so; a key of no entry (a custom SLI's, a stale one) is kept as
 * it is (the engine reports an unknown one as a warning). Pure: a new object.
 */
export function retargetOverrides({ build, library }, prevEntries) {
  const prev = Array.isArray(prevEntries) ? prevEntries : (build?.entries || []);
  const owner = sliOwners(prev, library);
  const now = build?.entries || [];
  const composed = now.length > 1;
  const out = {};
  for (const [k, ov] of Object.entries(build?.overrides || {})) {
    const hit = owner.get(k);
    if (!hit) { out[k] = ov; continue; }
    if (!now.includes(hit[0])) continue;
    out[sliKey(hit[0], hit[1], composed)] = ov;
  }
  return out;
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

/**
 * The SLI overrides an instantiate body carries: the fields the user edited (own keys, non-empty), for the
 * SLIs in the current selection when the library is known — an override kept for an SLI that is not in the
 * pack right now (unticked, its entry removed) stays in the draft and comes back with the SLI, and never
 * makes the engine warn about it in the meantime.
 */
export function effectiveOverrides(build, library = null) {
  const inPack = library ? new Set(selectedSliKeys(build, library)) : null;
  const out = {};
  for (const [k, ov] of Object.entries(build?.overrides || {})) {
    if (inPack && !inPack.has(k)) continue;
    const fields = {};
    for (const [field, v] of Object.entries(ov || {})) if (v !== null && v !== undefined && String(v) !== '') fields[field] = v;
    if (Object.keys(fields).length) out[k] = fields;
  }
  return out;
}

/** The body POST /api/library/instantiate takes, from the draft (the overrides filtered to the selection when `library` is given). */
export function instantiateBody(build, library = null) {
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
    overrides: effectiveOverrides(build, library),
    custom: (build?.custom || []).map(def => ({ ...def })),
  };
}

// ---------- DEFINE ----------

/**
 * buildDefineModel({ build, library, requirements }) → what the DEFINE step renders, in
 * four substeps (defineSubsteps): the fields, the three tiers with the clauses each adds
 * and what each asks of the pack (tierConsequences), the entries as cards (selected,
 * evidence, SLI counts per tier, the SLIs each suggests at the tier), the proposed SLIs
 * grouped by technology (defineSuggestions), why they are suggested (defineWhy), the
 * silhouette stack, the selection's params. `requirements` is { [tier]: clauses[] }
 * (whatever tiers have loaded).
 */
export function buildDefineModel({ build, library, requirements = {} }) {
  const rows = library?.entries || [];
  const selected = new Set(build?.entries || []);
  const name = build?.name || '';
  const errors = definitionErrors(name, selected.size);
  const tiers = TIERS.map(tier => {
    const clauses = requirements[tier] || null;
    const adds = clauses ? clauses.filter(c => c.minTier === tier) : [];
    return {
      id: tier, ...TIER_META[tier], selected: build?.tier === tier,
      must: clauses ? clauses.filter(c => c.severity === 'MUST').length : null,
      should: clauses ? clauses.filter(c => c.severity === 'SHOULD').length : null,
      adds: adds.map(c => ({ id: c.id, severity: c.severity, description: c.description })),
      loaded: !!clauses,
      // What choosing it asks of the pack, in plain words, read from the rubric (the tier's blurb until it has loaded).
      consequences: tierConsequences(clauses, tier),
    };
  });
  const card = (r) => ({
    id: r.id, kind: r.kind, title: r.title, summary: r.summary, product: r.product, version: r.version, tags: r.tags || [],
    selected: selected.has(r.id),
    evidence: { status: r.evidence?.status || null, verifiedOn: r.evidence?.verifiedOn || null, gaps: (r.evidence?.gaps || []).length },
    gaps: (r.evidence?.gaps || []).length,
    sliCountByTier: r.sliCountByTier,
    sliCountAtTier: r.sliCountByTier?.[build?.tier] ?? 0,
    placeholderParams: (r.params || []).filter(p => p.placeholder).length,
    // "Adds N suggested SLIs", previewable before the entry is picked: the SLIs the tier recommends from it, named.
    suggested: (r.slis || []).filter(s => atTier(build?.tier, s.minTier)).map(s => ({ id: s.id, name: sliName(s.id), type: s.type })),
    optional: (r.slis || []).filter(s => !atTier(build?.tier, s.minTier)).length,
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
      candidates: sliCandidates({ build, library }), mode: 'define', toggles: build?.toggles || {}, expanded: stackExpanded(build),
    }),
    // The placeholder count the step prints: once a pack exists, the params the
    // engine wrote and reported (provenance.placeholders, what the rail shows) —
    // a flagged param the tier or the selection never writes (pager_service_low
    // below tier-1, chaos_target when every entry brings its own chaos) is no
    // todo, so `flagged` overstates it and is only shown before the first result.
    placeholders: { flagged: params.filter(p => p.placeholder && p.atDefault).length, remaining: r ? placeholdersRemaining(r) : null },
    libraryErrors: library?.errors || [],
    valid: errors.length === 0, errors,
    // DEFINE is the seeding step: its primary action seeds the pack once, then reads as a continue.
    seeded: isSeeded(build),
    nextLabel: isSeeded(build) ? 'Continue to Compile' : 'Seed the pack',
    // The last instantiation's usage errors (a rejected param value is marked on its row).
    error: build?.error ? splitBuildErrors(build.error) : null, stale: isStale(build),
    // The four short substeps (the 2026-09 UX review, "Build / Define"): Service · Criticality · Technology · Review
    // suggestions — the one shown, what each holds, which are done; the proposed SLIs grouped by technology with the
    // recommended set; why these are the suggestions (the tier's rubric, in plain words, then its clauses); and the
    // folds the user opened (UI state on the draft, never persisted).
    ...defineSubsteps({ build, library }),
    suggestions: defineSuggestions({ build, library }),
    why: defineWhy(tierClauses, build?.tier),
    folds: { ...(build?.defineFolds || {}) },
  };
}

// ---------- DEFINE: the four substeps (the 2026-09 UX review, "Build / Define") ----------

/** Define, in short visible substeps within the step; the data behind them is the draft's, unchanged. */
export const DEFINE_SUBSTEPS = [
  { id: 'service', label: 'Service', question: 'Which service is this?' },
  { id: 'criticality', label: 'Criticality', question: 'How critical is it?' },
  { id: 'technology', label: 'Technology', question: 'What does it run on?' },
  { id: 'review', label: 'Review suggestions', question: 'What should the pack measure?' },
];

/** The service in one line — slug · owners · environment — for the progress summary (the view repaints it as the name is typed). */
export function serviceLine({ name = '', owners = '', environment = '' } = {}) {
  const slug = serviceSlug(name);
  const who = parseOwners(owners);
  return slug ? [slug, who.join(', '), environment || 'prod'].filter(Boolean).join(' · ') : 'not named yet';
}

/**
 * defineSubsteps({ build, library }) → { substep, substeps, substepsDone }: the substep shown (the draft's
 * `defineSub`, UI state never persisted — else the first one still needing input: a name, then a technology, then
 * the review) and each substep with what it holds now (`value`), whether it is complete, and what it still needs.
 */
export function defineSubsteps({ build, library }) {
  const name = build?.name || '';
  const entries = selectedEntries(build, library);
  const selected = selectedSliKeys(build, library).length + (build?.custom || []).length;
  const nameErrors = definitionErrors(name, 1);
  const meta = TIER_META[build?.tier] || null;
  const state = {
    service: { complete: nameErrors.length === 0, value: serviceLine(build || {}), needed: nameErrors },
    criticality: { complete: TIERS.includes(build?.tier), value: meta ? `${build.tier} · ${meta.word}` : 'not chosen yet', needed: [] },
    technology: { complete: entries.length > 0, value: entries.length ? entries.map(e => e.title).join(', ') : 'nothing picked yet', needed: entries.length ? [] : ['at least one library entry'] },
    review: { complete: entries.length > 0 && selected > 0, value: entries.length ? `${plural(selected, 'SLI')} in the pack` : 'pick a technology first', needed: [] },
  };
  const ids = DEFINE_SUBSTEPS.map(s => s.id);
  const wanted = ids.includes(build?.defineSub) ? build.defineSub : null;
  const substep = wanted || (!state.service.complete ? 'service' : !state.technology.complete ? 'technology' : 'review');
  const substeps = DEFINE_SUBSTEPS.map((s, i) => ({
    ...s, n: i + 1, ...state[s.id], current: s.id === substep,
    status: s.id === substep ? 'current' : state[s.id].complete ? 'complete' : 'todo',
    focusKey: `dsub:${s.id}`,
  }));
  // `substepPinned`: the draft names the substep. Until it does, the view pins the default on its first render, so a
  // later re-render (an answer, a rubric loading, the first technology picked) never moves the user on by itself.
  return { substep, substepPinned: !!wanted, substeps, substepsDone: substeps.filter(s => s.complete).length };
}

// The rubric, read as what a tier asks of the pack: each theme lists the clauses that bring a word to it. A part
// with `unless` gives way to a clause that says more (a tier that requires logs and traces needs no "OTLP pipeline").
const TIER_THEMES = [
  { id: 'objectives', label: 'Objectives', parts: [['L1.MUST.availability_slo', 'availability'], ['L1.MUST.latency_slo', 'latency'], ['L1.SHOULD.domain_slo', 'a domain objective']] },
  { id: 'signals', label: 'Signals', parts: [['L2.MUST.otlp_receiver', 'an OTLP pipeline', ['L2.MUST.metrics_logs_traces_backends']], ['L2.MUST.metrics_logs_traces_backends', 'metrics, logs and traces'], ['L2.MUST.tail_sampling', 'tail sampling'], ['L2.MUST.log_correlation', 'log correlation']] },
  { id: 'alerting', label: 'Alerting', parts: [['L4.MUST.multi_window_burn_rate', 'burn-rate alerts'], ['L4.MUST.tier1_voice_route', 'voice paging'], ['L4.MUST.tier1_at_least_one_automation', 'self-healing'], ['L4.SHOULD.forecast_on_availability', 'an availability forecast']] },
  { id: 'dashboards', label: 'Dashboards', parts: [['L3.MUST.service_overview_dashboard', 'a service overview', ['L3.MUST.tier1_dashboards']], ['L3.MUST.slo_burn_dashboard', 'an SLO burn board', ['L3.MUST.tier1_dashboards']], ['L3.MUST.tier1_dashboards', 'overview, SLO burn, deployment and customer-impact boards']] },
  { id: 'validation', label: 'Validation', parts: [['L5.MUST.synthetic_probe', 'a synthetic probe'], ['L5.MUST.tier2_chaos_staging', 'chaos in staging'], ['L5.MUST.tier1_weekly_prod_chaos', 'weekly chaos in production'], ['L5.SHOULD.tier1_release_gate', 'a release gate']] },
];
const andList = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * tierConsequences(clauses, tier) → { rows, sentence, derived }: what choosing the tier asks of the pack, in plain
 * words, read from the tier's rubric clauses — rows per theme (objectives · signals · alerting · dashboards ·
 * validation: the required words, then the recommended ones) and one sentence ('availability and latency
 * objectives; metrics, logs and traces; burn-rate alerts; …'). Before the rubric has loaded: the tier's static
 * blurb, `derived: false`, no rows.
 */
export function tierConsequences(clauses, tier = null) {
  if (!Array.isArray(clauses) || !clauses.length) return { rows: [], sentence: TIER_META[tier]?.blurb || '', derived: false };
  const byId = new Map(clauses.map(c => [c.id, c]));
  const rows = TIER_THEMES.map(th => {
    const hits = th.parts.filter(([id, , unless]) => byId.has(id) && !(unless || []).some(u => byId.has(u)));
    const must = hits.filter(([id]) => byId.get(id).severity === 'MUST').map(([, w]) => w);
    const should = hits.filter(([id]) => byId.get(id).severity !== 'MUST').map(([, w]) => w);
    if (!must.length && !should.length) return null;
    const one = must.length === 1 ? `${/^[aeiou]/i.test(must[0]) ? 'an' : 'a'} ${must[0]} objective` : `${andList(must)} objectives`;
    const text = th.id === 'objectives' && must.length ? one : andList(must);
    return { id: th.id, label: th.label, text, recommended: andList(should), must, should, clauses: hits.map(([id]) => id) };
  }).filter(Boolean);
  return { rows, sentence: rows.filter(r => r.text).map(r => r.text).join('; '), derived: true };
}

/**
 * "Why these suggestions?" — the rubric clauses that used to open the step, moved behind a fold: the tier's themes
 * with the clauses behind each (severity, the rubric's description, the id), then the clauses no theme names ("also
 * checked"), and the counts.
 */
export function defineWhy(clauses, tier) {
  const list = Array.isArray(clauses) ? clauses : [];
  const cons = tierConsequences(list, tier);
  const row = (c) => ({ id: c.id, severity: c.severity, description: c.description, dimension: c.dimension });
  const named = new Set(cons.rows.flatMap(r => r.clauses));
  return {
    tier, word: TIER_META[tier]?.word || '', loaded: list.length > 0,
    must: list.filter(c => c.severity === 'MUST').length, should: list.filter(c => c.severity === 'SHOULD').length,
    themes: cons.rows.map(r => ({ id: r.id, label: r.label, text: r.text, clauses: r.clauses.map(id => row(list.find(c => c.id === id))) })),
    also: list.filter(c => !named.has(c.id)).map(row),
  };
}

/** One SLI in a line: the bound (≤ 0.1 seconds) or good ÷ total, then the objective and window it starts with. */
function sliMeta(s) {
  const what = s.type === 'ratio' ? 'good ÷ total events' : (boundText(s) || s.type);
  return `${what} · ${s.objectiveLabel} over ${s.window || '—'}`;
}

/**
 * defineSuggestions({ build, library }) → the Review substep: the proposed SLIs grouped by technology (the entry
 * they come from), each with its checkbox state, whether the tier recommends it (its minTier at or below the tier)
 * or it starts from a higher tier's profile, a one-line meta and its description; the custom SLIs (always in the
 * pack); the counts; the keys an explicit list starts from (`allKeys`, what setSli takes); and what "Select
 * recommended" sets — the current selection plus every recommended SLI, collapsed to null (the tier's defaults)
 * when that is exactly the defaults.
 */
export function defineSuggestions({ build, library }) {
  const groups = sliGroups({ build, library });
  const selected = selectedSliKeys(build, library);
  const recommended = reachableSliKeys(build, library);
  const all = allSliKeys(build, library);
  const union = all.filter(k => selected.includes(k) || recommended.includes(k));
  const custom = (build?.custom || []).map(def => {
    const eff = customEffective(def);
    return { key: def.id, name: sliName(def.id), type: def.type, meta: sliMeta({ type: def.type, ...eff, objectiveLabel: fmtObjective(eff.objective) }), description: eff.description || '', focusKey: `sugg:custom:${def.id}` };
  });
  return {
    groups: groups.map(g => ({
      id: g.id, title: g.title, kind: g.kind, evidence: g.evidence,
      counts: { selected: g.slis.filter(s => s.checked).length, total: g.slis.length },
      items: g.slis.map(s => ({
        key: s.key, id: s.id, name: sliName(s.effectiveId !== s.key ? s.effectiveId : s.id), type: s.type, checked: s.checked,
        recommended: s.reachable, profileTier: s.minTier || 'tier-3', customised: s.customised.length > 0,
        meta: sliMeta(s), description: s.description, focusKey: `sugg:${s.key}`,
      })),
    })),
    custom,
    counts: { selected: selected.length, total: all.length, recommended: recommended.length, recommendedSelected: recommended.filter(k => selected.includes(k)).length, custom: custom.length },
    allKeys: selected,
    allRecommended: recommended.every(k => selected.includes(k)),
    recommendedSlis: sameSet(union, recommended) ? null : union,
  };
}

// ---------- COMPILE ----------

/**
 * The per-entry SLI rows of the selection at the draft's tier: reachable (its minTier at or below the tier —
 * a default) or above the tier (selectable all the same: it starts from its own tier's profile), checked (an
 * explicit list, else the tier's defaults), the objective and window it starts with — the library's at the
 * tier through the engine's walk, or the user's override. COMPILE's counts and DEFINE's L1 candidates read
 * the same list.
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
      const checked = explicit ? explicit.has(key) : reachable;
      const ov = overrideFor(build, key);
      const eff = effectiveSli(s, tier, ov);
      return {
        key, id: s.id, effectiveId: effectiveId(key, ov), type: s.type, minTier: s.minTier, reachable, aboveTier: !reachable, checked, unit: eff.unit ?? null,
        description: eff.description || '', evidence: promqlEdited(ov) ? 'custom' : (s.evidence || null), metrics: s.metrics || [],
        objective: eff.objective, objectiveLabel: fmtObjective(eff.objective), window: eff.window,
        threshold: eff.threshold ?? null, good_when: eff.good_when ?? null,
        customised: customisedFields(ov),
      };
    }),
  }));
}

/** DEFINE's L1 candidates: every SLI in the pack — the checked library ones, then the custom ones — with its entry. */
export function sliCandidates({ build, library }) {
  const tier = build?.tier;
  const custom = (build?.custom || []).map(def => {
    const eff = customEffective(def);
    return { key: def.id, id: def.id, effectiveId: def.id, type: def.type, minTier: tier, reachable: true, aboveTier: false, checked: true, unit: eff.unit ?? null, description: eff.description || '', evidence: 'custom', metrics: [], objective: eff.objective, objectiveLabel: fmtObjective(eff.objective), window: eff.window, threshold: eff.threshold ?? null, good_when: eff.good_when ?? null, customised: [], custom: true, entry: null, entryTitle: 'Custom SLI' };
  });
  return [...sliGroups({ build, library }).flatMap(g => g.slis.filter(s => s.checked).map(s => ({ ...s, entry: g.id, entryTitle: g.title }))), ...custom];
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
  const customCount = (build?.custom || []).length;
  const atLeastOne = all.some(s => s.checked) || customCount > 0;
  const editors = stackCardActions({ build, library });
  const stack = buildStackModel({
    adapted: r?.adapted || null, requirements: clauses, checklist: buildClauseChecklist(clauses, r?.summary || null),
    todos: r?.todos || [], params: paramRows({ build, library }), mode: 'compile', toggles: build?.toggles || {}, expanded: stackExpanded(build),
    customised: customisedMap(r), editors,
  });
  const error = build?.error ? splitBuildErrors(build.error) : null;
  const pending = !!build?.pending;
  const readiness = buildReadiness({ result: r, error, accepted: build?.accepted || {} });
  return {
    tier, composed, groups, toggles,
    counts: { total: all.length, reachable: all.filter(s => s.reachable).length, checked: all.filter(s => s.checked).length, aboveTier: all.filter(s => s.checked && s.aboveTier).length, custom: customCount, customised: all.filter(s => s.checked && s.customised.length).length },
    atLeastOne,
    stack,
    // The result first (docs/UX_SCREEN_GRAMMAR.md; the 2026-09 review, "Build / Compile"): the context, one
    // sentence, the three states kept apart, the action queue, what was produced by layer and type, and which
    // selection of DEFINE produced which artefact.
    context: stepContext(build, r),
    readiness,
    decision: compileDecision({ result: r, readiness, pending, error, atLeastOne, stack }),
    states: compileStates(readiness, stack, r?.summary?.tier || tier),
    queue: r ? compileQueue({ result: r, readiness, editors, stack, accepted: build?.accepted || {} }) : [],
    produced: producedByLayer(stack),
    origins: artefactOrigins({ build, result: r, stack }),
    // Which layers are expanded on COMPILE: null (the overview), 'all', or one layer id — UI state, never persisted.
    // The layer whose sheet is open is expanded too, so the sheet's close returns focus to a slab head that exists.
    expandedLayers: compileExpandedLayers(build, stack),
    result: r ? {
      sliCount: r.canonical?.spec?.slis?.length || 0, sloCount: r.canonical?.spec?.slos?.length || 0,
      todoCount: r.todos?.length || 0, warningCount: r.warnings?.length || 0,
      schemaOk: (r.schemaErrors || []).length === 0, schemaErrors: r.schemaErrors || [],
      yaml: r.canonicalYaml || '', yamlLines: (r.canonicalYaml || '').split('\n').length,
      fileName: `${r.canonical?.metadata?.name || 'pack'}.pack.yaml`,
      warnings: summarizeWarnings(r.warnings || []),
    } : null,
    error, stale: isStale(build), pending,
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

// ---------- the clause checklist (steps 1-3) ----------

/**
 * buildClauseChecklist(clauses, summary) → the tier's clauses with one of three
 * states from the engine's summary — 'pass', 'placeholder' (passes only on a
 * placeholder artefact: summary.onPlaceholder names it), 'fail' — or 'pending'
 * when there is no summary yet. Grouped by dimension, with counts: the slab
 * edges, the definition column's summary and the sheets all read it.
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
    todos: r?.todos || [], params, mode: 'verify', toggles: build?.toggles || {}, expanded: stackExpanded(build),
    customised: customisedMap(r), editors: stackCardActions({ build, library }),
  });
  const s = r?.summary || null;
  const blocking = (r?.warnings || []).some(w => w.kind === 'promql');
  const schemaOk = (r?.schemaErrors || []).length === 0;
  const error = build?.error ? splitBuildErrors(build.error) : null;
  // What the footer says about the hand-off, in priority order.
  const handoff = build?.registeredId ? 'registered' : error ? 'error' : blocking ? 'promql' : !schemaOk ? 'schema' : 'ready';
  const gaps = placeholdersRemaining(r);
  const accepted = build?.accepted || {};
  const readiness = buildReadiness({ result: r, error, accepted });
  const tier = s?.tier || build?.tier;
  const canRegister = !!r && schemaOk && !blocking && !error;
  const remains = r ? verifyRemains({ result: r, checklist, params, editors: stackCardActions({ build, library }), accepted }) : null;
  return {
    ready: !!r, pending: !!build?.pending, error, stale: isStale(build),
    tier,
    // The verdict first (docs/UX_SCREEN_GRAMMAR.md; the 2026-09 review, "Build / Verify", P0): four readiness
    // states displayed independently, one sentence that never lets "meets the tier rubric" mask a placeholder,
    // the smallest list of what remains, and one primary next action at the actual gate.
    context: stepContext(build, r),
    readiness,
    states: readinessStates(readiness, tier),
    decision: verifyDecision(readiness, { tier }),
    remains,
    next: verifyNext(readiness, { canRegister, remains }),
    // "Accept with reason": a per-session acknowledgement of a non-blocking warning, kept on the draft and never
    // persisted or written into the pack — there is no backend for it. `accepting` is the item whose reason form is
    // open, `acceptDraft` the reason being typed (so a re-render does not lose it).
    accepting: build?.accepting || null,
    acceptDraft: build?.acceptDraft || null,
    acceptedMap: accepted,
    verdict: s ? {
      conformant: !!s.conformant, must: s.must, should: s.should,
      mustPercent: s.mustPercent, scorePercent: s.scorePercent,
      pass: checklist.counts.pass, placeholder: checklist.counts.placeholder, fail: checklist.counts.fail,
      onPlaceholder: s.onPlaceholder || [], failing: s.failing || [],
    } : null,
    checklist,
    stack,
    // The per-layer maturity bars on the verdict card: clause counts per dimension.
    maturity: stack.slabs.filter(sl => sl.maturity.total > 0).map(sl => ({ id: sl.id, num: sl.num, name: sl.name, state: sl.state, ...sl.maturity })),
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
    // The hand-off — VERIFY's exits (docs/BUILD_JOURNEY.md "Where it starts"; the review's §1: Verify leads to
    // "Open pack in Discover"): resolve or adjust (back at Define), or open the pack in Discover with the gaps
    // visible — they stay on the pack as library.todo.* annotations, so Diagnose grades them as gaps, never as verified.
    gaps,
    continueLabel: gaps > 0 ? 'Open pack in Discover with visible gaps' : 'Open pack in Discover',
    readyText: gaps > 0
      ? `The generated pack becomes the same kind of pack you inspect and improve in Discover. Its ${gaps} placeholder value${gaps === 1 ? '' : 's'} travel${gaps === 1 ? 's' : ''} with it as visible gaps — Diagnose grades them as gaps, never as verified.`
      : 'The generated pack becomes the same kind of pack you inspect and improve in Discover. No placeholder value remains; opening it registers the pack the way an upload is registered.',
    // A stale pack (the last compilation failed) is never handed off: the error stands until the field is fixed.
    canRegister,
  };
}

// ---------- COMPILE and VERIFY: what the pack produced, what is ready and what remains ----------
//
// The 2026-09 UX review (docs/UX_SCREEN_GRAMMAR.md; "Build / Compile" and "Build / Verify"): COMPILE leads
// with a result and a small action queue; VERIFY with four readiness states displayed independently — schema
// valid, meets the tier rubric, implementation complete, deployment ready — so a conformant pack whose MUST
// clauses pass on placeholders is never read as ready to deploy. Everything is read from the instantiate
// response, the draft and the stack; nothing is invented.

const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
/** A count that opens a sentence: a word up to nine ("Two warnings"), the digits after. */
const sentenceCount = (n) => COUNT_WORDS[n] || String(n);

/** The working context both result screens name first: the service, its environment, the tier, what it is built from. */
function stepContext(build, r) {
  const prov = r?.provenance || {};
  return [
    { key: 'Service', value: r?.canonical?.metadata?.name || serviceSlug(build?.name) || '' },
    { key: 'Environment', value: prov.environment || build?.environment || '' },
    { key: 'Tier', value: prov.tier || build?.tier || '' },
    { key: 'Built from', value: (prov.entries || []).map(e => e.id).join(' + ') || (build?.entries || []).join(' + ') },
  ];
}

/** The key a warning is acknowledged under ("Accept with reason"): stable while the engine says the same thing. */
export function warningKey(w) {
  return `${w?.kind || 'other'}:${w?.sli || ''}:${w?.field || ''}:${w?.message || ''}`;
}

const SLI_IN_MESSAGE = /^(?:threshold )?SLI ([a-z][a-z0-9_]*)[.:]/;
/** The SLI a warning names: the engine's `sli` (promql, override), else the burn-rule generator's "SLI <id>:" prefix; null when none. */
export function warningSli(w) {
  if (w?.sli) return w.sli;
  const m = SLI_IN_MESSAGE.exec(String(w?.message || ''));
  return m ? m[1] : null;
}

/** The correction to suggest for a warning — read from its kind and the engine's words — and the editor field "Fix now" lands on. */
export function warningSuggestion(w) {
  const msg = String(w?.message || '');
  if (w?.kind === 'promql') return { text: `Correct the SLI’s ${w.field || 'expression'}, or the parameter substituted into it, so it parses as PromQL.`, focus: w.field || null };
  if (w?.kind === 'override') return { text: 'Add the SLI back to the pack on L1, or clear its customisation.', focus: null };
  if (/good_when/.test(msg)) return { text: 'Say which side is good: set “Good when” to above (a floor) or below (a ceiling).', focus: 'good_when' };
  if (/matcher names one of the pack/.test(msg)) return { text: 'Add a job="…" matcher that names one of the pack’s scrape jobs.', focus: null };
  if (/legs will not match/.test(msg)) return { text: 'Aggregate the good and total legs the same way.', focus: null };
  if (/counter/.test(msg)) return { text: 'Point the SLI at the counter, not a recorded rate.', focus: null };
  if (/no policy rules/.test(msg)) return { text: 'No burn-rate alert is generated for this SLI until its expression takes a form the policy can count.', focus: null };
  return { text: 'Review the SLI in its editor; the generator’s note says what it assumed.', focus: null };
}

/**
 * warningItems(warnings, { editors, adapted, accepted }) → one actionable item per warning, blocking first: the
 * engine's words, the artefact it impacts (the SLI card the adapter draws for the SLI it names), a suggested
 * correction, where "Fix now" / "Review" opens (the SLI's editor, else the L1 sheet — both on COMPILE, where
 * they edit), whether it may be accepted with a reason (a blocking one may not) and the acceptance if any.
 */
export function warningItems(warnings, { editors = {}, adapted = null, accepted = {} } = {}) {
  const l1 = adapted?.layers?.L1 || [];
  return summarizeWarnings(warnings).flatMap(g => g.items.map(w => {
    const sli = warningSli(w);
    const card = sli ? l1.find(a => /^SLI-/.test(String(a.id || '')) && (a.spec?.id || a.title) === sli) : null;
    const ed = sli ? editors?.[sli] : null;
    const sug = warningSuggestion(w);
    const key = warningKey(w);
    return {
      key, kind: g.kind, label: g.label, blocking: g.blocking, message: w.message || '', sli,
      impact: card ? `${card.id} · ${sli}` : sli ? `SLI ${sli}` : 'the pack',
      suggestion: sug.text,
      fix: ed ? { kind: 'editor', key: ed.key, custom: !!ed.custom, focus: sug.focus, layer: 'L1' } : { kind: 'sheet', layer: 'L1' },
      acceptable: !g.blocking,
      accepted: accepted?.[key] || null,
    };
  }));
}

/** The layer a schema error points at: the section under `$.spec.` by todoLayer's families; L1 when it names none. */
export function schemaErrorLayer(message) {
  const m = /\$\.spec\.([a-z_]+)/.exec(String(message || ''));
  return m ? todoLayer(m[1]).layer : 'L1';
}
const schemaItems = (errors) => (errors || []).map((message, i) => {
  const layer = schemaErrorLayer(message);
  return {
    key: `schema:${i}:${message}`, kind: 'schema', label: 'Schema', blocking: true, message,
    impact: (/\$\.[\w.[\]-]+/.exec(message) || [layer])[0],
    suggestion: 'Switch the section back on, or restore the value the schema requires.',
    fix: { kind: 'sheet', layer }, acceptable: false, accepted: null,
  };
});

/**
 * buildReadiness({ result, error, accepted }) → the facts both result screens state, each on its own: generated,
 * schema valid, meets the tier rubric (every MUST clause passes — possibly on a placeholder), implementation
 * incomplete (placeholder values, todos, clauses resting on a placeholder), and deployment ready — none of the
 * `reasons` left: no failed compilation, no blocking warning, no schema error, the rubric met on real values,
 * nothing to fill, write or measure, no warning left unreviewed. A MUST clause passing only on a placeholder keeps
 * deployment ready at no. null before the first result.
 */
export function buildReadiness({ result, error = null, accepted = {} } = {}) {
  if (!result) return null;
  const s = result.summary || null;
  const warnings = result.warnings || [];
  const isBlocking = (w) => !!WARNING_KINDS[w.kind]?.blocking;
  const blocking = warnings.filter(isBlocking).length;
  const openWarnings = warnings.filter(w => isBlocking(w) || !accepted?.[warningKey(w)]).length;
  const todos = result.todos || [];
  const onPlaceholder = s?.onPlaceholder || [];
  const failing = s?.failing || [];
  const schemaErrors = (result.schemaErrors || []).length;
  const r = {
    generated: !!result.canonical,
    stale: !!error,
    schemaOk: schemaErrors === 0, schemaErrors,
    meets: s ? !!s.conformant : null,
    must: s?.must || null, should: s?.should || null,
    failing: failing.length, mustFail: failing.filter(c => c.severity === 'MUST').length,
    onPlaceholder: onPlaceholder.length, mustOnPlaceholder: onPlaceholder.filter(c => c.severity === 'MUST').length,
    values: placeholdersRemaining(result),
    todos: todos.length,
    manual: todos.filter(t => !(t.params || []).length).length,
    warnings: warnings.length, blocking, openWarnings, acceptedWarnings: warnings.length - openWarnings,
    reviewWarnings: openWarnings - blocking,
  };
  r.incomplete = r.values > 0 || r.todos > 0 || r.onPlaceholder > 0;
  r.blocked = r.stale || blocking > 0 || !r.schemaOk;
  const failN = r.mustFail || r.failing;
  // What stands between the pack and a deployment, the most basic first; deployment ready is none of it.
  r.reasons = [
    r.stale && 'the last compilation failed',
    blocking && `${plural(blocking, 'SLI expression')} ${blocking === 1 ? 'is' : 'are'} not valid PromQL`,
    !r.schemaOk && plural(schemaErrors, 'schema error'),
    r.meets === false && `${plural(failN, 'required clause')} fail${failN === 1 ? 's' : ''}`,
    r.meets === null && 'the rubric is not evaluated yet',
    r.values && `${plural(r.values, 'value')} to fill`,
    r.onPlaceholder && `${plural(r.onPlaceholder, 'clause')} pass${r.onPlaceholder === 1 ? 'es' : ''} only on placeholders`,
    r.manual && `${plural(r.manual, 'item')} to write or measure outside the studio`,
    r.reviewWarnings && `${plural(r.reviewWarnings, 'warning')} to review`,
  ].filter(Boolean);
  r.deployable = r.reasons.length === 0;
  return r;
}

/**
 * readinessStates(readiness, tier) → VERIFY's four states, each displayed on its own: { id, label, value, note,
 * tone }. "Meets tier rubric" (the formal word: conformant) says yes when every MUST clause passes and names how
 * many of those rest on placeholders; "Deployment ready" is its own answer, never inferred from the rubric.
 */
export function readinessStates(r, tier) {
  if (!r) return [];
  const implNote = [r.values && `${plural(r.values, 'value')} to fill`, r.manual && `${r.manual} to write or measure`, r.onPlaceholder && `${plural(r.onPlaceholder, 'clause')} on placeholders`].filter(Boolean).join(' · ');
  return [
    { id: 'schema', label: 'Schema valid', value: r.schemaOk ? 'Yes' : 'No', tone: r.schemaOk ? 'ok' : 'fail',
      note: r.schemaOk ? 'the pack validates against the spec' : plural(r.schemaErrors, 'error') },
    { id: 'rubric', label: 'Meets tier rubric', value: r.meets == null ? 'Not evaluated' : r.meets ? 'Yes' : 'No',
      tone: r.meets == null ? 'neutral' : !r.meets ? 'fail' : r.mustOnPlaceholder ? 'warn' : 'ok',
      note: r.must ? `MUST ${r.must.passed}/${r.must.total}${tier ? ` at ${tier}` : ''}${r.mustOnPlaceholder ? ` · ${r.mustOnPlaceholder} only on placeholders` : ''}` : '' },
    { id: 'implementation', label: 'Implementation', value: r.incomplete ? 'Incomplete' : 'Complete', tone: r.incomplete ? 'warn' : 'ok',
      note: r.incomplete ? implNote : 'every value filled' },
    { id: 'deployment', label: 'Deployment ready', value: r.deployable ? 'Yes' : 'No',
      tone: r.deployable ? 'ok' : (r.blocked || r.meets === false) ? 'fail' : 'warn',
      note: r.deployable ? 'nothing left to fill or review' : `not until: ${r.reasons.slice(0, 2).join('; ')}${r.reasons.length > 2 ? ' …' : ''}` },
  ];
}

/** VERIFY's one sentence, its short verdict word and tone, and the line under it (what remains). */
export function verifyDecision(r, { tier = '' } = {}) {
  if (!r) return { sentence: 'Nothing compiled yet — Compile generates the pack this step reads.', word: '', tone: 'neutral', note: '' };
  const note = r.deployable ? '' : `What remains: ${r.reasons.join(', ')}.`;
  if (r.stale) return { sentence: 'The last change did not compile; the pack shown is the previous one and cannot be handed off.', word: 'Not ready', tone: 'fail', note };
  if (r.blocking) return { sentence: 'Blocked: an SLI expression is not valid PromQL, so the pack must not ship.', word: 'Blocked', tone: 'fail', note };
  if (!r.schemaOk) return { sentence: `Blocked: the pack fails the schema in ${plural(r.schemaErrors, 'place')}.`, word: 'Blocked', tone: 'fail', note };
  const failN = r.mustFail || r.failing;
  if (r.meets === false) return { sentence: `Does not meet the ${tier || 'tier'} rubric: ${plural(failN, 'required clause')} fail${failN === 1 ? 's' : ''}.`, word: 'Below tier', tone: 'fail', note };
  if (r.incomplete) return { sentence: 'Ready for team completion; not ready for deployment.', word: 'Incomplete', tone: 'warn', note };
  if (r.reviewWarnings) return { sentence: `Complete for ${tier || 'this tier'}; ${r.reviewWarnings === 1 ? 'one warning needs' : `${r.reviewWarnings} warnings need`} review before deployment.`, word: 'Review', tone: 'warn', note };
  return { sentence: `Ready for deployment: valid, meets the ${tier || 'tier'} rubric on real values, nothing left to fill.`, word: 'Ready', tone: 'ok', note };
}

/**
 * verifyRemains({ result, checklist, params, editors, accepted }) → the smallest actionable list VERIFY shows:
 * what blocks the hand-off (schema errors, a PromQL warning), the warnings to review (accepted ones set aside),
 * the clauses that pass only on a placeholder ("Requirement represented; real value still needed") with the todos
 * they rest on, the placeholder values to fill grouped by the layer each shapes (there is no owner per item —
 * the pack's owners are one team), and the todos no value fills (a runbook to write, a baseline to measure).
 */
export function verifyRemains({ result, checklist, params = [], editors = {}, accepted = {} }) {
  const all = warningItems(result?.warnings || [], { editors, adapted: result?.adapted || null, accepted });
  const blocking = [...schemaItems(result?.schemaErrors), ...all.filter(w => w.blocking)];
  const warnings = all.filter(w => !w.blocking && !w.accepted);
  const acceptedItems = all.filter(w => w.accepted);
  const todos = result?.todos || [];
  const clauses = (checklist?.items || []).filter(i => i.state === 'placeholder').map(i => ({
    key: `clause:${i.id}`, id: i.id, label: clauseGhostLabel(i.id), description: i.description, severity: i.severity, layer: i.dimension, todos: i.todos || [],
  }));
  const byKey = new Map((params || []).map(p => [p.key, p]));
  const values = (Array.isArray(result?.provenance?.placeholders) ? result.provenance.placeholders : []).map(key => {
    const p = byKey.get(key) || { key, id: key, label: key, entry: null, entryTitle: '', hint: '', effective: '' };
    return {
      key, label: p.label || key, entryTitle: p.entry ? p.entryTitle : 'scaffold', current: String(p.effective ?? p.hint ?? ''),
      layer: paramLayer(p), todos: todos.filter(t => (t.params || []).includes(key)).map(t => t.path),
    };
  });
  const valueGroups = LAYER_DEFS.map(d => ({ layer: d.id, num: d.num, name: d.name, question: LAYER_QUESTIONS[d.id] || '', items: values.filter(v => v.layer === d.id) })).filter(g => g.items.length);
  const manual = todos.filter(t => !(t.params || []).length).map(t => ({ key: `todo:${t.path}`, path: t.path, what: t.what || '', layer: todoLayer(t.path).layer, clauses: t.clauses || [] }));
  return {
    blocking, warnings, accepted: acceptedItems, clauses, values: { total: values.length, groups: valueGroups }, manual,
    counts: { blocking: blocking.length, warnings: warnings.length, accepted: acceptedItems.length, clauses: clauses.length, values: values.length, manual: manual.length },
    empty: !blocking.length && !warnings.length && !clauses.length && !values.length && !manual.length,
  };
}

/**
 * VERIFY's one primary next action at the actual gate, and the quieter alternatives: fix what blocks the hand-off;
 * else resolve a failing requirement; else complete the required values (the hand-off stays a secondary: the pack
 * may travel with visible gaps); else "Open pack in Discover".
 */
export function verifyNext(r, { canRegister = false, remains = null } = {}) {
  if (!r) return { primary: null, secondary: [] };
  const handoff = { id: 'build-verify-open', label: remains?.values?.total ? 'Open in Discover with visible gaps' : 'Open pack in Discover', action: 'open-discover' };
  if (r.blocked) return { primary: { id: 'build-verify-fix', label: 'Fix what blocks the hand-off', action: 'fix-first' }, secondary: [] };
  if (r.meets === false) return { primary: { id: 'build-verify-resolve', label: 'Resolve failing requirements', action: 'resolve-failing' }, secondary: canRegister ? [handoff] : [] };
  if (r.values > 0) return { primary: { id: 'build-verify-complete', label: 'Complete required values', action: 'complete-values' }, secondary: canRegister ? [handoff] : [] };
  return { primary: canRegister ? { ...handoff, label: 'Open pack in Discover' } : null, secondary: [] };
}

/** COMPILE's one sentence: a result ("Pack compiled. Two warnings need review; 17 values remain placeholders."). */
export function compileDecision({ result, readiness: r, pending = false, error = null, atLeastOne = true, stack = null } = {}) {
  if (!atLeastOne) return { sentence: 'No SLI is in the pack — add one on L1 to compile it.', word: 'Not compiled', tone: 'fail' };
  if (!result) {
    if (pending) return { sentence: 'Compiling the pack…', word: '', tone: 'info' };
    if (error) return { sentence: 'The pack did not compile — the rejected value is named below.', word: 'Failed', tone: 'fail' };
    return { sentence: 'Nothing compiled yet — the layers fill in as soon as the pack compiles.', word: '', tone: 'neutral' };
  }
  const head = r.stale ? 'The last change did not compile; this is the previous pack.'
    : r.blocking ? 'Pack compiled, but it must not ship: an SLI expression is not valid PromQL.'
      : !r.schemaOk ? `Pack compiled, but it fails the schema in ${plural(r.schemaErrors, 'place')}.`
        : 'Pack compiled.';
  const review = r.reviewWarnings
    ? `${sentenceCount(r.reviewWarnings)} warning${r.reviewWarnings === 1 ? ' needs' : 's need'} review`
    : 'No warning needs review';
  const values = r.values ? `${r.values} value${r.values === 1 ? ' remains a placeholder' : 's remain placeholders'}` : 'every value is filled';
  const tone = r.blocked || r.meets === false ? 'fail' : (r.reviewWarnings || r.values) ? 'warn' : 'ok';
  const artefacts = stack?.counts?.artefacts || 0;
  return {
    // The sentence says "compiled"; the verdict chip speaks only when something stops the pack.
    sentence: `${head} ${review}; ${values}.`, word: r.stale ? 'Previous pack' : r.blocked ? 'Blocked' : '', tone,
    note: `${plural(artefacts, 'artefact')} on ${stack?.counts?.litSlabs || 0} of ${stack?.counts?.slabs || 0} layers — the same artefacts, ids and titles Discover will show for this pack.`,
  };
}

/**
 * COMPILE's three states, kept apart (the review: "generated successfully", "complete for this tier", "ready to
 * deploy" are different answers): { id, label, value, note, tone }.
 */
export function compileStates(r, stack, tier) {
  if (!r) return [];
  const failN = r.mustFail || r.failing;
  return [
    { id: 'generated', label: 'Generated', value: r.stale ? 'Previous pack' : 'Yes', tone: r.stale ? 'fail' : 'ok',
      note: `${plural(stack?.counts?.artefacts || 0, 'artefact')}${r.schemaOk ? ', schema valid' : `, ${plural(r.schemaErrors, 'schema error')}`}` },
    { id: 'tier', label: 'Complete for this tier', value: r.meets == null ? 'Not evaluated' : !r.meets ? 'No' : r.mustOnPlaceholder ? 'On placeholders' : 'Yes',
      tone: r.meets == null ? 'neutral' : !r.meets ? 'fail' : r.mustOnPlaceholder ? 'warn' : 'ok',
      note: r.meets === false ? `${plural(failN, 'required clause')} fail${failN === 1 ? 's' : ''} at ${tier}` : r.mustOnPlaceholder ? `${r.mustOnPlaceholder} required clause${r.mustOnPlaceholder === 1 ? '' : 's'} represented; real value still needed` : r.must ? `MUST ${r.must.passed}/${r.must.total} at ${tier}` : '' },
    { id: 'deploy', label: 'Ready to deploy', value: r.deployable ? 'Yes' : 'No', tone: r.deployable ? 'ok' : (r.blocked || r.meets === false) ? 'fail' : 'warn',
      note: r.deployable ? 'Verify confirms it' : `not until: ${r.reasons[0]}${r.reasons.length > 1 ? ` (+${r.reasons.length - 1} more on Verify)` : ''}` },
  ];
}

/**
 * COMPILE's action queue, first on the screen: each warning (and schema error) with the artefact it impacts, a
 * suggested correction and where "Review" opens; then, when placeholder values remain, one row that sends them to
 * VERIFY, where each sits on its layer. Accepted warnings stay off the queue.
 */
export function compileQueue({ result, readiness: r, editors = {}, stack = null, accepted = {} }) {
  const items = [...schemaItems(result?.schemaErrors), ...warningItems(result?.warnings || [], { editors, adapted: result?.adapted || null, accepted }).filter(w => !w.accepted)];
  if (r?.values) {
    items.push({
      key: 'placeholders', kind: 'placeholders', label: 'Placeholders', blocking: false,
      message: `${plural(r.values, 'value')} ${r.values === 1 ? 'is' : 'are'} still a placeholder — written into the pack so each requirement is represented, but not real.`,
      impact: `${plural(stack?.counts?.scaffold || 0, 'Scaffold artefact')} · ${plural(r.todos, 'todo')}`,
      suggestion: 'Fill them on Verify, where each value sits on the layer it shapes.',
      fix: { kind: 'step', step: 'verify' }, acceptable: false, accepted: null,
    });
  }
  return items;
}

/** The artefact types the adapter mints, by id prefix: the type and the purpose it serves (COMPILE groups by both). */
export const ARTEFACT_TYPES = [
  { match: /^SLI-/, type: 'SLIs', purpose: 'what the service is measured by' },
  { match: /^SLO-/, type: 'SLOs', purpose: 'the objective each SLI is held to' },
  { match: /^OTEL-/, type: 'Instrumentation', purpose: 'how the service emits telemetry' },
  { match: /^BAK-/, type: 'Backends', purpose: 'where each signal is stored and queried' },
  { match: /^PIP-/, type: 'Collector pipeline', purpose: 'how the signals travel' },
  { match: /^STO-/, type: 'Storage', purpose: 'how long each signal is kept' },
  { match: /^(COL|MESH|PROF|NET|POE)-/, type: 'Extended collection', purpose: 'signals beyond metrics, logs and traces' },
  { match: /^QRY-/, type: 'Recording rules', purpose: 'each SLI, precomputed' },
  { match: /^VIEW-/, type: 'Derived views', purpose: 'reusable queries over the signals' },
  { match: /^DASH-/, type: 'Dashboards', purpose: 'how people see it' },
  { match: /^PANEL-/, type: 'Dashboard panels', purpose: 'the panels inside the dashboards' },
  { match: /^POL-/, type: 'Burn-rate alerts', purpose: 'when an objective is at risk' },
  { match: /^FCST-/, type: 'Forecasts', purpose: 'an objective at risk before it burns' },
  { match: /^ALR-/, type: 'Alert routes', purpose: 'who is told, and how' },
  { match: /^HEAL-/, type: 'Remediations', purpose: 'what runs when it breaks' },
  { match: /^SYN-/, type: 'Synthetic probes', purpose: 'checks that the service answers' },
  { match: /^CHAOS-/, type: 'Chaos experiments', purpose: 'proof that the alerts fire' },
  { match: /^BASE-/, type: 'Baselines', purpose: 'how fast incidents are seen and fixed' },
  { match: /^IMP-/, type: 'Imports', purpose: 'shared policy the pack references' },
];
export function artefactType(a) {
  const hit = ARTEFACT_TYPES.find(t => t.match.test(String(a?.id || '')));
  return hit ? { type: hit.type, purpose: hit.purpose } : { type: a?.tool || 'Other', purpose: '' };
}
/** Artefacts counted by type, in ARTEFACT_TYPES order: [{ type, purpose, count, scaffold, detail }]. */
function typeCounts(artefacts) {
  const by = new Map();
  for (const a of artefacts || []) {
    const t = artefactType(a);
    const g = by.get(t.type) || { ...t, count: 0, scaffold: 0, detail: 0 };
    g.count += 1;
    if (a.source === 'Scaffold') g.scaffold += 1;
    if (a.detail) g.detail += 1;
    by.set(t.type, g);
  }
  const order = (t) => { const i = ARTEFACT_TYPES.findIndex(x => x.type === t); return i < 0 ? ARTEFACT_TYPES.length : i; };
  return [...by.values()].sort((a, b) => order(a.type) - order(b.type) || a.type.localeCompare(b.type));
}

/**
 * producedByLayer(stack) → what the pack produced, one row per slab: its question, the clause verdict, the counts,
 * and its artefacts by type with the purpose of each — the overview COMPILE shows before any card.
 */
export function producedByLayer(stack) {
  return (stack?.slabs || []).map(s => ({
    id: s.id, num: s.num, name: s.name, question: LAYER_QUESTIONS[s.id] || '', state: s.state, stateText: s.stateText,
    artefacts: s.counts.artefacts, scaffold: s.counts.scaffold, missing: s.ghosts.filter(g => g.kind === 'clause').length, todos: s.counts.todos,
    offSections: s.offSections || [], types: typeCounts(s.artefacts),
  }));
}

/**
 * The layers COMPILE expands, in stack order: every slab (`compileView` 'all'), the ones selected (an array of
 * layer ids, or one id), and the one whose sheet is open — the overview alone when nothing is selected.
 */
export function compileExpandedLayers(build, stack) {
  const ids = (stack?.slabs || []).map(s => s.id);
  const view = build?.compileView ?? null;
  if (view === 'all') return ids;
  const chosen = new Set(Array.isArray(view) ? view : view ? [view] : []);
  return ids.filter(id => chosen.has(id) || id === build?.sheetOpen);
}

/**
 * artefactOrigins({ build, result, stack }) → COMPILE's "Changes since Define": which selection produced which
 * artefacts, and what was edited since. Read from the provenance the engine writes (each SLI's library entry,
 * custom, customised, above its tier) and the adapter's own references (an SLO names its SLI, a recording rule
 * `ref:slis.<id>`, a burn alert its SLO, a remediation the alert that triggers it, a chaos experiment the SLO it
 * tests, a panel its board); a board, view or probe named after an entry is that entry's, and what no entry claims
 * is the tier's scaffold. An attribution, not a proof: the engine does not stamp every artefact with its origin.
 */
export function artefactOrigins({ build, result, stack }) {
  if (!result || !stack) return null;
  const prov = result.provenance || {};
  const psli = prov.slis || {};
  const tier = prov.tier || build?.tier || '';
  const slug = serviceSlug(result.canonical?.metadata?.name || build?.name || '');
  const entries = (prov.entries || []).map(e => ({ id: e.id, version: e.version || '', kind: e.kind || '' }));
  const own = (n) => !!slug && (n === slug || n.startsWith(`${slug}-`) || n.startsWith(`${slug.replace(/-/g, '_')}_`));
  const byName = (name) => {
    const n = String(name || '');
    if (!n || own(n)) return null;
    return entries.find(e => [`${e.id}-`, `${e.id}_`, `${e.id.replace(/-/g, '_')}_`].some(p => n.startsWith(p)))?.id || null;
  };
  const sliOrigin = (id) => { const p = id ? psli[id] : null; return p ? (p.custom ? 'custom' : p.library?.entry || null) : null; };
  const artefacts = stack.slabs.flatMap(s => s.artefacts);
  const sloToSli = new Map(artefacts.filter(a => /^SLO-/.test(String(a.id || ''))).map(a => [a.spec?.id || a.title, a.spec?.sli]));
  const sloOrigin = (slo) => (slo ? sliOrigin(sloToSli.get(slo)) : null);
  const ref = (s, re) => { const m = re.exec(String(s || '')); return m ? m[1] : null; };
  const originOf = (a) => {
    const id = String(a.id || '');
    const name = a.spec?.id || a.title;
    if (/^SLI-/.test(id)) return sliOrigin(name);
    if (/^SLO-/.test(id)) return sliOrigin(a.spec?.sli);
    if (/^QRY-/.test(id)) return sliOrigin(ref(a.spec?.expr, /^ref:slis\.(.+)$/));
    if (/^(POL|FCST)-/.test(id)) return sloOrigin(a.spec?.slo);
    if (/^HEAL-/.test(id)) return sloOrigin(ref(a.spec?.trigger, /^alert:(.+?)_burn_/));
    if (/^CHAOS-/.test(id)) return byName(name) || (own(String(name || '')) ? null : sloOrigin(ref(a.spec?.steady_state_hypothesis, /^ref:slos\.(.+)$/)));
    if (/^PANEL-/.test(id)) return byName(String(a.parent || '').replace(/^dashboards\./, ''));
    return byName(name);
  };
  const groups = new Map([
    ...entries.map(e => [e.id, { id: e.id, label: e.id, sub: [e.kind, e.version && `v${e.version}`].filter(Boolean).join(' · '), kind: 'entry', artefacts: [] }]),
    ['custom', { id: 'custom', label: 'Custom SLIs', sub: 'written in the studio', kind: 'custom', artefacts: [] }],
    ['scaffold', { id: 'scaffold', label: `${tier || 'tier'} scaffold`, sub: 'the tier’s structure, shared by every entry', kind: 'scaffold', artefacts: [] }],
  ]);
  for (const a of artefacts) (groups.get(originOf(a)) || groups.get('scaffold')).artefacts.push(a);
  const out = [...groups.values()].filter(g => g.artefacts.length).map(g => ({
    id: g.id, label: g.label, sub: g.sub, kind: g.kind, count: g.artefacts.length, types: typeCounts(g.artefacts),
    slis: g.artefacts.filter(a => /^SLI-/.test(String(a.id || ''))).map(a => a.spec?.id || a.title),
  }));
  const edits = [];
  for (const [id, p] of Object.entries(psli)) if ((p.customised || []).length) edits.push({ kind: 'customised', text: `${id}: ${p.customised.join(', ')} customised` });
  const above = Object.entries(psli).filter(([, p]) => p.aboveTier).map(([id]) => id);
  if (above.length) edits.push({ kind: 'above', text: `${plural(above.length, 'SLI')} added from a higher tier’s profile: ${above.join(', ')}` });
  const set = Object.keys(effectiveParams(build));
  if (set.length) edits.push({ kind: 'params', text: `${plural(set.length, 'value')} set: ${set.join(', ')}` });
  const off = SECTION_TOGGLES.filter(t => build?.toggles?.[t.id] === false).map(t => t.label);
  if (off.length) edits.push({ kind: 'off', text: `Switched off: ${off.join(', ')} — nothing is generated for ${off.length === 1 ? 'it' : 'them'}` });
  return { groups: out, edits, total: artefacts.length };
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
 * Each slab: { id, num, name, state, stateText, clauses, artefacts, ghosts, todos,
 * subgroups (L4), counts, maturity, dimmed, offSections, expanded, why, present }. L2X is
 * present only when it has an artefact or a clause; GOV has no clause and is neutral.
 * Nothing here is invented: the artefacts are the adapter's, untouched (each gains its
 * `symbol` and, when a todo names it, `todoPath`); the ghosts are the rubric; the states
 * are the checklist's.
 */
/**
 * What the provenance says was customised, per SLI id: { [id]: { fields, custom } } for the SLIs that carry
 * an override or were written from scratch — what the L1 cards print as "customised: objective, query".
 */
export function customisedMap(result) {
  const out = {};
  for (const [id, p] of Object.entries(result?.provenance?.slis || {})) {
    if ((p.customised || []).length || p.custom) out[id] = { fields: [...(p.customised || [])], custom: !!p.custom, evidence: p.evidence?.status || null };
  }
  return out;
}

export function buildStackModel({ adapted = null, checklist = null, requirements = null, candidates = [], todos = [], params = [], mode = 'compile', toggles = {}, expanded = {}, customised = {}, editors = {} } = {}) {
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
    // An L1 SLI card whose provenance says it was customised or written from scratch says so (the adapter titles an SLI card with the SLI id).
    const mark = layerId === 'L1' && /^SLI-/.test(String(a.id || '')) && customised?.[a.title] ? customised[a.title] : null;
    // An L1 SLI or SLO card opens the SLI's editor (docs/BUILD_JOURNEY.md "The editor"): the whole card is the control; an SLO card lands on the objective.
    const isSli = layerId === 'L1' && /^SLI-/.test(String(a.id || '')), isSlo = layerId === 'L1' && /^SLO-/.test(String(a.id || ''));
    const target = isSli ? editors?.[a.spec?.id || a.title] : isSlo ? editors?.[a.spec?.sli] : null;
    const edit = target ? { key: target.key, custom: !!target.custom, focus: isSlo ? 'objective' : null } : null;
    return { ...a, symbol, todoPath: todo ? todo.path : null, detail: isDetailArtefact(a, layerId), ...(mark ? { customised: mark.fields, custom: mark.custom, customNote: mark.custom ? 'custom — written in the studio' : `customised: ${mark.fields.join(', ')}` } : {}), ...(edit ? { edit } : {}) };
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
      // The card names the SLI as the pack will carry it (a rename shows); the key stays the library's. Both cards open the SLI's editor.
      // A threshold candidate prints its bound with its direction under the title, as the adapter's card will once the pack exists.
      { kind: 'sli', key: `sli:${c.key}`, title: c.effectiveId || c.key, ...(c.type === 'threshold' && boundText(c) ? { subtitle: boundText(c) } : {}), desc: c.description || `${c.type} SLI`, source: 'Candidate', tool: `${c.type} SLI`, tags: ['sli', c.type, c.entry || 'custom', ...(c.aboveTier ? [`from ${c.minTier}`] : []), ...(c.customised?.length ? ['customised'] : [])].filter(Boolean), evidence: c.evidence || null, state: null, edit: { key: c.key, custom: !!c.custom, focus: null } },
      { kind: 'slo', key: `slo:${c.key}`, title: `SLO on ${c.effectiveId || c.key}`, desc: `${c.objectiveLabel} over ${c.window || '—'}`, source: 'Candidate', tool: 'SLO', tags: ['slo', c.window].filter(Boolean), evidence: null, state: null, edit: { key: c.key, custom: !!c.custom, focus: 'objective' } },
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
    // L2X is optional per the spec: shown only when it has content or a clause of its own.
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
      id: def.id, num: def.num, name: def.name,
      state, stateText: slabStateText(state, m),
      clauses, artefacts, ghosts, todos: slabTodos, subgroups,
      counts: {
        artefacts: artefacts.length, scaffold: artefacts.filter(a => a.source === 'Scaffold').length, verified: artefacts.filter(a => a.source === 'Verified').length,
        detail: artefacts.filter(a => a.detail).length,
        ghosts: ghosts.length, todos: slabTodos.length, clauses: clauses.length,
      },
      maturity,
      dimmed: offSections.length > 0, offSections,
      // A failing clause explained by a section off elsewhere (SLOs off: the chaos experiments have no SLO to test) — a chip on the head says why.
      notes: sectionNotes(clauses, toggles, offSections),
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

// ---------- the axis: the definition column and the layer sheet (docs/BUILD_JOURNEY.md "The axis") ----------

/** The question each layer's sheet asks — the layer's job in one line. */
export const LAYER_QUESTIONS = {
  L1: 'What should we measure?',
  L2: 'Where does the telemetry flow?',
  L2X: 'What else do we collect?',
  L3: 'How do we see it?',
  L4: 'What happens when it breaks?',
  L5: 'How do we prove it?',
  GOV: 'Who owns it?',
};
/**
 * The sheet is one component on the three steps: live on DEFINE and COMPILE (DEFINE is the seeding stage, but its
 * pack is already instantiated — the same sheet, the same actions; the preview mode with "Compose in Compile →" is
 * retired), read-only with the todos on VERIFY.
 */
export const SHEET_MODES = { define: 'edit', compile: 'edit', verify: 'verify' };
export const sheetModeFor = (step) => SHEET_MODES[step] || 'edit';

/**
 * The BUILD journey's three header cards (docs/BUILD_JOURNEY.md): the same shape as the analysis journey's tabs
 * and the same accents, rendered by the same header renderer whenever state.mode is 'build'. `techName` is the
 * step's own name (the tab's title and accessible name read "Define — Choose a service, tier, and starting point",
 * never the engine word behind it; measured: "Library — …"). A card is reachable when the previous step's inputs are valid
 * (buildStepReachability).
 */
export const BUILD_TABS = [
  { id: 'define', n: '1', label: 'What Are We Building For?', sub: 'Define', techName: 'Define', tagline: 'Choose a service, tier, and starting point', accent: 'tab-blue' },
  { id: 'compile', n: '2', label: 'What Did the Pack Produce?', sub: 'Compile', techName: 'Compile', tagline: 'Build SLIs, alerts, dashboards, and checks', accent: 'tab-magenta' },
  { id: 'verify', n: '3', label: 'What Is Ready, and What Remains?', sub: 'Verify', techName: 'Verify', tagline: 'Review coverage and resolve gaps', accent: 'tab-emerald' },
];
/** A header tab's accessible name and title: the step word and its tagline. */
export const tabName = (t) => `${t.techName} — ${t.tagline}`;

/**
 * stackCardActions({ build, library }) → { [sliId]: { key, custom } }: which editor each L1 card of the stack opens,
 * by the SLI id the pack carries (the adapter titles an SLI card with it and an SLO card names it in spec.sli) — the
 * library key behind a renamed SLI, `custom` for one written in the studio. buildStackModel stamps it on the cards
 * (`edit`); an SLO card opens its SLI's editor on the objective.
 */
export function stackCardActions({ build, library }) {
  const out = {};
  for (const it of rolodexItems({ build, library })) out[it.effectiveId || it.key] = { key: it.key, custom: !!it.custom };
  return out;
}
/** The section switches each sheet carries (the sections that live on that layer; L2 has none). */
export const LAYER_SWITCHES = { L1: ['slos'], L3: ['dashboards'], L4: ['policy', 'routes'], L5: ['validation'] };

/** The pop-up editor's mode per step (docs/BUILD_JOURNEY.md "The editor"): editable on DEFINE and COMPILE, read-only on VERIFY. */
export const EDITOR_MODES = { define: 'edit', compile: 'edit', verify: 'readonly' };
export const editorModeFor = (step) => EDITOR_MODES[step] || 'edit';
/**
 * `build.editorDirty` once an instantiate has answered: the editor's last edit is answered — unless a newer edit
 * still waits on the debounce (the controller restarts the timer per keystroke without a request of its own), in
 * which case the flag stays and the status keeps reading applying… instead of 'applied · SLO <the stale id>'.
 */
export const editorDirtyAfterAnswer = (dirty, debouncePending) => (debouncePending ? !!dirty : false);

/**
 * buildEditorModel({ build, library, mode }) → the pop-up editor's model for the SLI the draft's `editor` names
 * (`{ key, custom }`, UI state, never persisted — or `{ create: true }` for a new custom SLI), or null when the
 * editor is closed or its SLI is gone (its entry deselected, a custom one removed: the controller closes it). Finds
 * the rolodex item (every entry's, so an SLI of a product not yet selected opens too), hands the engine's usage
 * errors for that SLI (splitBuildErrors) and the library keys in the pack (what the footer switch's list starts
 * from) to sliEditorModel. `mode` follows the step (editorModeFor).
 */
export function buildEditorModel({ build, library, mode = 'edit' }) {
  const ed = build?.editor;
  if (!ed) return null;
  const r = build?.result || null;
  if (ed.create) return sliEditorModel({ item: null, result: r, library, build, mode: 'create', errors: splitBuildErrors(build?.customDraftErrors).byCustom });
  const items = rolodexItems({ build, library, all: true });
  const item = items.find(i => i.key === ed.key && !!i.custom === !!ed.custom);
  if (!item) return null;
  const errs = splitBuildErrors(build?.error);
  return sliEditorModel({
    item, result: r, library, build, mode, errors: item.custom ? errs.byCustom[item.key] : errs.byOverride[item.key],
    allKeys: items.filter(i => i.selected && !i.custom).map(i => i.key),
  });
}

/** The DEFINE validity errors, spelled once for the define model and the definition column. */
function definitionErrors(name, selectedCount) {
  const errors = [];
  if (!name.trim()) errors.push('a service name');
  else if (serviceSlug(name).length > MAX_SERVICE_SLUG) errors.push(`a service name of at most ${MAX_SERVICE_SLUG} characters once slugged (‘${serviceSlug(name)}’ is ${serviceSlug(name).length})`);
  else if (!isValidServiceName(name)) errors.push(`a service name that slugs (‘${name}’ → ‘${serviceSlug(name)}’ is not one)`);
  if (!selectedCount) errors.push('at least one library entry');
  return errors;
}

/**
 * buildDefinitionModel({ build, library, requirements, checklist }) → the left column
 * on every step: the service fields, the tier as a segmented control (each segment
 * with its MUST · SHOULD counts, the chosen one's blurb), the library entries as
 * chips (products, then archetypes; title, evidence, SLIs at this tier, selected),
 * and the conformance summary that replaced the rail — status, the three counts,
 * the failing clauses, how many pass only on a placeholder, todos, warnings and
 * placeholders left. `requirements` is { [tier]: clauses[] }; `checklist` the
 * current tier's checklist when the caller has it (built here otherwise).
 */
export function buildDefinitionModel({ build, library, requirements = {}, checklist = null }) {
  const rows = library?.entries || [];
  const selected = new Set(build?.entries || []);
  const name = build?.name || '';
  const errors = definitionErrors(name, selected.size);
  const tier = build?.tier;
  const tiers = TIERS.map((t, index) => {
    const clauses = requirements[t] || null;
    return {
      id: t, index, ...TIER_META[t], selected: tier === t, loaded: !!clauses,
      must: clauses ? clauses.filter(c => c.severity === 'MUST').length : null,
      should: clauses ? clauses.filter(c => c.severity === 'SHOULD').length : null,
    };
  });
  const chip = (r) => ({
    id: r.id, kind: r.kind, title: r.title, summary: r.summary || '', product: r.product, version: r.version,
    selected: selected.has(r.id),
    // The status and its date only: the word for each status is the evidence atom's vocabulary (build-atoms.mjs evidenceDot / evidenceBadge), spelled once there.
    evidence: { status: r.evidence?.status || null, verifiedOn: r.evidence?.verifiedOn || null },
    sliCountByTier: r.sliCountByTier || {}, sliCountAtTier: r.sliCountByTier?.[tier] ?? 0,
    placeholderParams: (r.params || []).filter(p => p.placeholder).length,
    gaps: (r.evidence?.gaps || []).length,
  });
  const r = build?.result || null;
  const tierClauses = requirements[tier] || [];
  const check = checklist || buildClauseChecklist(tierClauses, r?.summary || null);
  const k = check.counts;
  const pending = !!build?.pending, error = build?.error || null, stale = isStale(build), ready = !!r, valid = errors.length === 0;
  const statusKind = pending ? 'pending' : error ? 'error' : !valid ? 'idle' : !ready ? 'pending' : check.conformant ? 'ok' : 'fail';
  const status = pending ? 'checking…'
    : error ? (stale ? 'the last compilation failed — showing the previous pack' : 'the last compilation failed')
    : !valid ? 'complete the definition to evaluate'
    : !ready ? 'evaluating…'
    // Plain words first (the 2026-09 review §4): the formal "conformant" is "meets the tier rubric" — which says nothing of placeholders.
    : check.conformant ? `meets the ${tier} rubric` : `${plural(k.must.fail, 'MUST clause')} failing`;
  const seeded = isSeeded(build);
  return {
    name, slug: serviceSlug(name), owners: build?.owners || '', ownerList: parseOwners(build?.owners), environment: build?.environment || 'prod',
    tier, tiers, tierIndex: Math.max(0, TIERS.indexOf(tier)), tierBlurb: TIER_META[tier]?.blurb || '',
    products: rows.filter(x => x.kind === 'product').map(chip),
    archetypes: rows.filter(x => x.kind === 'archetype').map(chip),
    selectedCount: selectedEntries(build, library).length,
    selectedTitles: selectedEntries(build, library).map(e => e.title),
    // The wizard stage: the live form on DEFINE; on COMPILE and VERIFY a read-only, recessed seed card with
    // "Change seed →" (the summary below it stays live on every step — it is the grading, not the seed).
    seeded, mode: (build?.step || 'define') === 'define' ? 'form' : 'seed',
    seededNote: seeded ? SEEDED_NOTE : null,
    seedCard: seedCardModel(build, library, requirements),
    // On DEFINE the column is a sticky progress summary of the four substeps (the form is on the step itself).
    ...defineSubsteps({ build, library }),
    summary: {
      status, statusKind, conformant: check.conformant, tier,
      counts: { pass: k.pass, placeholder: k.placeholder, fail: k.fail, pending: k.pending, total: k.total, must: k.must, should: k.should },
      failing: check.items.filter(i => i.state === 'fail'),
      onPlaceholder: check.items.filter(i => i.state === 'placeholder').length,
      todoCount: r?.todos?.length || 0,
      warningCount: r?.warnings?.length || 0,
      blockingWarnings: (r?.warnings || []).filter(w => w.kind === 'promql').length,
      placeholdersRemaining: placeholdersRemaining(r),
      ready, pending, stale,
    },
    libraryErrors: library?.errors || [],
    valid, errors,
    error: build?.error ? splitBuildErrors(build.error) : null, stale,
  };
}

/**
 * The conformance status in one line for the persistent live region (`#build-status`,
 * outside the re-rendered view): the settled status and the three counts — or null while
 * the engine is still answering or nothing is evaluated yet, so a keystroke's "checking…"
 * is never announced and the region changes once per settled result.
 */
export function buildStatusLine(summary) {
  if (!summary || summary.pending || !summary.ready) return null;
  const k = summary.counts;
  return `${summary.status} · ${k.pass} pass · ${k.placeholder} need real values · ${k.fail} fail`;
}

/**
 * seedCardModel(build, library, requirements) → the read-only seed card the definition column becomes on
 * COMPILE and VERIFY: the service (name, owners, environment) as a definition list, one tier chip
 * ("seeded at tier-2 · 15 MUST · 1 SHOULD"), the entries as small chips, what the pack carries from them
 * (SLIs in the pack, how many from a higher tier's profile, customised, custom) and the way back
 * ("Change seed →" returns to DEFINE). Everything read from the draft and the index; nothing invented.
 */
export function seedCardModel(build, library, requirements = {}) {
  const tier = build?.tier;
  const clauses = requirements?.[tier] || null;
  const must = clauses ? clauses.filter(c => c.severity === 'MUST').length : null;
  const should = clauses ? clauses.filter(c => c.severity === 'SHOULD').length : null;
  const entries = selectedEntries(build, library);
  const groups = sliGroups({ build, library }).flatMap(g => g.slis).filter(x => x.checked);
  const custom = (build?.custom || []).length;
  return {
    name: build?.name || '', slug: serviceSlug(build?.name), owners: parseOwners(build?.owners), environment: build?.environment || 'prod',
    tier, must, should,
    tierChip: `seeded at ${tier || '—'}${must == null ? '' : ` · ${must} MUST${should ? ` · ${should} SHOULD` : ''}`}`,
    entries: entries.map(e => ({ id: e.id, title: e.title, kind: e.kind })),
    counts: { slis: groups.length + custom, aboveTier: groups.filter(x => x.aboveTier).length, customised: groups.filter(x => x.customised.length).length, custom },
    changeLabel: 'Change seed',
  };
}

/**
 * Which sheet a param is edited on: the scaffold's channel and pager params and the
 * runbook directory on L4, its chaos and probe targets on L5, its endpoints and
 * backend versions on L2; an entry's params on L5 when they name a workload, a canary,
 * a probe or a bootstrap address (what the probes and the chaos experiments target),
 * on L2 otherwise (scrape jobs, targets, selectors).
 */
const SCAFFOLD_PARAM_LAYER = {
  oncall_channel: 'L4', team_channel: 'L4', pager_service: 'L4', pager_service_low: 'L4', runbook_dir: 'L4',
  chaos_target: 'L5', probe_target: 'L5',
};
export function paramLayer(row) {
  if (!row) return 'L2';
  if (!row.entry) return SCAFFOLD_PARAM_LAYER[row.id] || 'L2';
  return /workload|canary|health|probe|chaos|bootstrap/i.test(String(row.id)) ? 'L5' : 'L2';
}
/** The L4 sheet splits its params: the channels (routes) and the runbooks (self-healing). */
export function paramSubgroup(row) {
  if (paramLayer(row) !== 'L4') return null;
  return /runbook/.test(String(row.id)) ? 'healing' : 'alerting';
}

/**
 * The clauses a section's absence can fail — its scope: the clauses of the slab(s) it feeds
 * (L4 per subgroup), narrowed where a slab carries more than the section (dashboards off
 * leaves the recording rules and the derived views, validation off leaves the baselines'
 * release gate), and for SLOs everything that references an SLO elsewhere: the policy
 * (dropped with them) and the chaos experiments, whose steady-state hypothesis is an SLO.
 */
const SECTION_SCOPE = {
  slos: (c) => c.dimension === 'L1' || (c.dimension === 'L4' && clauseSubgroup(c.id) === 'policy') || (c.dimension === 'L5' && /chaos/.test(String(c.id))),
  policy: (c) => c.dimension === 'L4' && clauseSubgroup(c.id) === 'policy',
  routes: (c) => c.dimension === 'L4' && clauseSubgroup(c.id) === 'alerting',
  dashboards: (c) => c.dimension === 'L3' && /dashboard/.test(String(c.id)),
  validation: (c) => c.dimension === 'L5' && /probe|chaos|synthetic/.test(String(c.id)),
};
/**
 * Clauses quantified per SLO ("each SLO has …"): with no SLO to check they hold, so SLOs
 * off is not expected to drop them. Measured against tools/lib/conformance.mjs at every
 * tier (tools/test-build-model.mjs instantiates with each section off and compares): the
 * burn-alert clause and the chaos-per-SLO clause keep passing with SLOs off, while the
 * availability / latency / domain SLO clauses, the forecast and the staging / weekly chaos fail.
 */
const VACUOUS_WITHOUT_SLOS = new Set(['L4.MUST.multi_window_burn_rate', 'L5.MUST.tier1_chaos_for_each_slo']);
const evaluated = (clauses) => (clauses || []).some(c => c.state && c.state !== 'pending');

/** The clauses a section off is expected to drop — its scope minus what holds vacuously. */
export function sectionClauses(section, clauses) {
  const inScope = SECTION_SCOPE[section];
  if (!inScope) return [];
  return (clauses || []).filter(c => inScope(c) && !(section === 'slos' && VACUOUS_WITHOUT_SLOS.has(c.id)));
}

/**
 * What a section off actually dropped: the clauses in its scope the checklist marks failing —
 * the engine's answer, never a prediction. Before the engine has answered (no clause carries
 * a state yet) the expectation stands in.
 */
export function sectionDrops(section, clauses) {
  const inScope = SECTION_SCOPE[section];
  if (!inScope) return [];
  if (!evaluated(clauses)) return sectionClauses(section, clauses);
  return (clauses || []).filter(c => inScope(c) && c.state === 'fail');
}

/** A head chip for a slab that fails because of a section switched off elsewhere (SLOs off: the chaos experiments have no SLO to test). */
const SECTION_NOTE = { slos: 'no SLO to test' };
export function sectionNotes(clauses, toggles, offSections = []) {
  const failing = (sec) => (clauses || []).filter(c => c.state === 'fail' && SECTION_SCOPE[sec](c));
  return Object.keys(SECTION_SCOPE)
    .filter(sec => toggles?.[sec] === false && !offSections.includes(sec) && failing(sec).length)
    .map(sec => {
      const labels = failing(sec).map(c => clauseGhostLabel(c.id));
      const def = SECTION_TOGGLES.find(t => t.id === sec);
      return { section: sec, text: SECTION_NOTE[sec] || `${sec} off`, why: `${def?.label || sec} off — ${labels.join(', ')} ${labels.length === 1 ? 'fails' : 'fail'} without it` };
    });
}

/**
 * One section switch as the sheet draws it: its state, whether it is meaningful, and its
 * consequence in one line — while on, what switching it off is expected to drop
 * (`expected`); once off, what the engine actually failed among those (`drops`, from the
 * checklist), so the line never disagrees with the stack.
 */
export function sectionSwitch(section, build, clauses) {
  const def = SECTION_TOGGLES.find(t => t.id === section) || { id: section, label: section, hint: '' };
  // Policy without SLOs is meaningless: the engine drops it, so the switch reads off, and cannot be flipped.
  const disabled = section === 'policy' && build?.toggles?.slos === false;
  const on = !disabled && build?.toggles?.[section] !== false;
  const row = (c) => ({ id: c.id, label: clauseGhostLabel(c.id), severity: c.severity, state: c.state || null });
  const expected = sectionClauses(section, clauses).map(row);
  const measured = !on && evaluated(clauses);
  const drops = on ? expected : sectionDrops(section, clauses).map(row);
  const labels = drops.map(d => d.label).join(', ');
  let consequence;
  if (disabled) consequence = 'meaningless without SLOs — dropped with them';
  else if (on) consequence = drops.length ? `off is expected to drop ${plural(drops.length, 'clause')} of the tier: ${labels}` : 'no clause of the tier rests on it — the section is still absent from the pack when off';
  else if (!measured) consequence = drops.length ? `off — expected to drop ${plural(drops.length, 'clause')} of the tier: ${labels}` : 'off — no clause of the tier rests on it; the section is absent from the pack';
  else consequence = drops.length ? `off — ${plural(drops.length, 'clause')} fail${drops.length === 1 ? 's' : ''} with it: ${labels}` : 'off — no clause of the tier fails with it; the section is absent from the pack';
  return { id: section, label: def.label, hint: def.hint, on, disabled, consequence, drops, expected, measured, focusKey: `toggle:${section}` };
}

/**
 * rolodexItems({ build, library, all }) → the SLI cards of the L1 rolodex: every SLI of the selected entries
 * (in selection order), the custom SLIs (`custom: true`, always in the pack) and, with `all`, every SLI of
 * the entries not yet selected — each with its product and evidence, type, metrics, the objective and window it
 * starts with at the current tier (the library's through the engine's walk, or the user's override) and the
 * library's at the three tiers, whether it is in the pack (`selected`), and — never a reason it cannot be: the
 * tier is a seed — an informational note for an SLI above the tier (`aboveTier`, `note`: "from the tier-1
 * profile"). The copies: `override` (the edited fields), `customised` (their names), `effective` and
 * `defaults` per field, the evidence turned `custom` once the PromQL was edited (`evidenceNote`), the
 * engine's promql warning for the SLI, and whether its Customise face is open. The key of an SLI on an entry
 * not yet selected is the key it would have once that entry composes in (the engine's rule).
 */
export function rolodexItems({ build, library, all = false }) {
  const rows = library?.entries || [];
  const chosen = selectedEntries(build, library);
  const chosenIds = new Set(chosen.map(e => e.id));
  const others = all ? rows.filter(r => !chosenIds.has(r.id)) : [];
  const tier = build?.tier;
  const explicit = Array.isArray(build?.slis) ? new Set(build.slis) : null;
  const promqlWarnings = (build?.result?.warnings || []).filter(w => w.kind === 'promql');
  const warningFor = (key) => promqlWarnings.find(w => w.sli === key)?.message || null;
  // The engine's usage errors on a card's copies (`override <sli>.<field>`, `custom <id>.<field>`), on the card whether
  // or not its face is open: closed, the card carried no mark and the user had to guess which one to Customise.
  const errs = splitBuildErrors(build?.error);
  const errorsFor = (key, custom) => { const e = custom ? errs.byCustom[key] : errs.byOverride[key]; return e && Object.keys(e).length ? e : null; };
  const item = (en, s, entrySelected) => {
    const composed = entrySelected ? chosen.length > 1 : chosen.length + 1 > 1;
    const key = sliKey(en.id, s.id, composed);
    const reachable = atTier(tier, s.minTier);
    const selected = entrySelected && (explicit ? explicit.has(key) : reachable);
    const ov = entrySelected ? overrideFor(build, key) : {};
    const eff = effectiveSli(s, tier, ov);
    const edited = promqlEdited(ov);
    const customised = customisedFields(ov);
    return {
      key, id: s.id, effectiveId: effectiveId(key, ov), entry: en.id, entryTitle: en.title, entryKind: en.kind, entryEvidence: en.evidence?.status || null, entrySelected,
      type: s.type, unit: eff.unit ?? null, description: eff.description || '', metrics: s.metrics || [],
      evidence: edited ? 'custom' : (s.evidence || null), libraryEvidence: s.evidence || null,
      evidenceNote: edited ? 'edited — the library’s evidence no longer applies' : null,
      minTier: s.minTier || 'tier-3', reachable, aboveTier: !reachable, profileTier: s.minTier || 'tier-3',
      note: reachable ? null : `from the ${s.minTier} profile`,
      selected, disabled: false, reason: null, custom: false,
      objective: eff.objective, objectiveLabel: fmtObjective(eff.objective), window: eff.window,
      override: ov, customised, customisedLabel: customised.length ? `customised: ${customised.join(', ')}` : null,
      effective: eff, defaults: effectiveSli(s, tier, {}),
      tiers: TIERS.map(t => ({ tier: t, current: t === tier, reachable: atTier(t, s.minTier), objective: s.objectives?.[t] ?? null, objectiveLabel: fmtObjective(s.objectives?.[t]), window: s.windows?.[t] ?? null })),
      focusKey: `sli:${en.id}:${s.id}`,
      promqlWarning: selected ? warningFor(key) : null,
      errors: selected ? errorsFor(key, false) : null, errorFields: selected ? Object.keys(errorsFor(key, false) || {}) : [],
    };
  };
  const customItem = (def) => {
    const eff = customEffective(def);
    return {
      key: def.id, id: def.id, effectiveId: def.id, entry: null, entryTitle: 'Custom SLI', entryKind: 'custom', entryEvidence: 'custom', entrySelected: true,
      type: def.type, unit: eff.unit ?? null, description: eff.description || '', metrics: [],
      evidence: 'custom', libraryEvidence: null, evidenceNote: 'written in the studio — no library evidence',
      minTier: tier, reachable: true, aboveTier: false, profileTier: null, note: null,
      selected: true, disabled: false, reason: null, custom: true, def: { ...def },
      objective: eff.objective, objectiveLabel: fmtObjective(eff.objective), window: eff.window,
      override: {}, customised: [], customisedLabel: null, effective: eff, defaults: {},
      tiers: [], focusKey: `sli:custom:${def.id}`, promqlWarning: warningFor(def.id),
      errors: errorsFor(def.id, true), errorFields: Object.keys(errorsFor(def.id, true) || {}),
    };
  };
  return [
    ...chosen.flatMap(en => (en.slis || []).map(s => item(en, s, true))),
    ...(build?.custom || []).map(customItem),
    ...others.flatMap(en => (en.slis || []).map(s => item(en, s, false))),
  ];
}

/**
 * addSliSelection({ build, library }, entryId, sliId) → { entries, slis, changed, reason }:
 * the pure part of the controller's addSli — the entry joins the selection when it is not in it yet, the SLI
 * is ticked (above the tier too: it starts from its own tier's profile), and the explicit list is re-keyed
 * for the new composition (going from one entry to two prefixes every id). The other entries keep exactly
 * the SLIs they had; a list equal to the tier's defaults collapses to null. Only an unknown entry or SLI
 * changes nothing.
 */
export function addSliSelection({ build, library }, entryId, sliId) {
  const rows = library?.entries || [];
  const before = { entries: [...(build?.entries || [])], slis: Array.isArray(build?.slis) ? [...build.slis] : null };
  const entry = rows.find(r => r.id === entryId);
  const sli = (entry?.slis || []).find(s => s.id === sliId);
  if (!entry || !sli) return { ...before, changed: false, reason: 'unknown entry or SLI' };
  const entries = before.entries.includes(entryId) ? before.entries : [...before.entries, entryId];
  const composed = entries.length > 1;
  // What is ticked today, re-keyed for the composition after the change.
  const kept = sliGroups({ build, library }).flatMap(g => g.slis.filter(s => s.checked).map(s => sliKey(g.id, s.id, composed)));
  const next = { ...build, entries };
  const all = allSliKeys(next, library);
  const want = new Set([...kept, sliKey(entryId, sliId, composed)]);
  const slis = all.filter(k => want.has(k));
  return { entries, slis: sameSet(slis, reachableSliKeys(next, library)) ? null : slis, changed: true, reason: null };
}

// The lists a sheet draws from the adapter's projection (never a made-up menu).
const listItem = (a, meta = []) => ({ id: a.id, title: a.title || a.id, desc: a.desc || '', meta: meta.filter(Boolean), scaffold: a.source === 'Scaffold', symbol: artefactSymbol(a) });
const layerArtefacts = (adapted, layerId) => {
  const L = adapted?.layers?.[layerId];
  if (!L) return [];
  return Array.isArray(L) ? L : L4_SUBGROUPS.flatMap(sg => L[sg.key] || []);
};
const pick = (list, re) => list.filter(a => re.test(String(a.id || '')));
const channelText = (ch) => Object.entries(ch || {}).map(([kind, v]) => `${kind} ${v}`).join(', ');
const windowText = (w) => `${w.factor}× ${w.short}/${w.long} ${w.severity}`;

/** The per-layer lists: what the pack actually carries on that layer, read from `adapted`; empty with a reason before the first result. */
export function sheetLists(layerId, adapted, { compiled = false } = {}) {
  const A = layerArtefacts(adapted, layerId);
  const empty = compiled ? 'none in the pack as toggled' : 'compiled on the first instantiation — nothing to list yet';
  const list = (id, label, items, sub = '') => ({ id, label, sub, items, empty });
  switch (layerId) {
    case 'L1':
      return [
        list('slos', 'SLOs in the pack', pick(A, /^SLO-/).map(a => listItem(a, (a.tags || []).filter(t => t !== 'slo'))), 'one per selected SLI, the objective and window the tier gives it'),
      ];
    case 'L2': {
      const jobs = pick(A, /^PIP-RCV-/).flatMap(a => (a.spec?.scrape_configs || []).map(j => ({
        id: j.job_name, title: j.job_name, desc: (j.static_configs || []).flatMap(s => s.targets || []).join(', '), meta: [j.scrape_interval ? `every ${j.scrape_interval}` : ''].filter(Boolean), scaffold: a.source === 'Scaffold', symbol: artefactSymbol(a),
      })));
      return [
        list('jobs', 'Scrape jobs', jobs, 'the products’ exporters, as the prometheus receiver scrapes them'),
        list('receivers', 'Receivers', pick(A, /^PIP-RCV-/).filter(a => !a.spec?.scrape_configs).map(a => listItem(a, [(a.spec?.protocols || []).join(' + '), a.spec?.endpoint])), 'what the collector listens on'),
        list('backends', 'Backends', pick(A, /^BAK-/).map(a => listItem(a, [a.spec?.version?.declared ? `declared ${a.spec.version.declared}` : '', a.spec?.version?.min ? `min ${a.spec.version.min}` : '', a.spec?.version?.gating ? `gating ${a.spec.version.gating}` : '', ...(a.spec?.endpoints || [])])), 'metrics, logs and traces — the versions declared are placeholder params'),
        list('exporters', 'Exporters', pick(A, /^PIP-EXP-/).map(a => listItem(a, [a.spec?.endpoint, ...(a.spec?.endpoints || [])])), 'where each signal leaves the collector'),
        list('storage', 'Storage', pick(A, /^STO-/).map(a => listItem(a, [a.spec?.retention ? `retain ${a.spec.retention}` : '', a.spec?.sampling])), 'retention per signal — the tier’s starting points'),
        list('otel', 'Instrumentation', pick(A, /^OTEL-/).map(a => listItem(a, a.tags || [])), 'the SDK contract the tier asks for'),
      ];
    }
    case 'L2X':
      return [list('extended', 'Extended telemetry', A.map(a => listItem(a, a.tags || [])), 'profiling, network, mesh, policy engine — when the pack carries any')];
    case 'L3':
      return [
        list('boards', 'Boards', pick(A, /^DASH-/).map(a => listItem(a, [(a.refs || []).length ? `${(a.refs || []).length} bindings` : ''])), 'the overview, the burn board at tier-2 and above, the entries’ boards, tier-1’s deployment overlay and customer impact'),
        list('views', 'Derived views', pick(A, /^VIEW-/).map(a => listItem(a, (a.tags || []).filter(t => t !== 'view'))), 'golden signals at tier-2, the entries’ per-topic and per-route views'),
        list('rules', 'Recording rules', pick(A, /^QRY-/).map(a => listItem(a, [a.spec?.interval ? `@ ${a.spec.interval}` : ''])), 'one per SLI — the compiler’s own names'),
      ];
    case 'L4':
      return [
        list('policy', 'Burn windows per SLO', pick(A, /^POL-/).map(a => listItem(a, (a.spec?.windows || []).map(windowText))), 'two windows per SLO from the SLI’s burn profile; forecasts at tier-1'),
        list('forecasts', 'Forecasts', pick(A, /^FCST-/).map(a => listItem(a, a.tags || [])), 'a forecast on an availability SLO (tier-1)'),
        list('routes', 'Routes', pick(A, /^ALR-/).map(a => listItem(a, (a.spec?.channels || []).map(channelText))), 'one route per severity — the channels are placeholder params'),
        list('healing', 'Remediation', pick(A, /^HEAL-/).map(a => listItem(a, [a.spec?.runbook, a.spec?.automation])), 'the entries’ templates, each triggered by its SLI’s fast burn alert'),
      ];
    case 'L5':
      return [
        list('probes', 'Probes', pick(A, /^SYN-/).map(a => listItem(a, [a.spec?.kind, a.spec?.target, a.spec?.interval ? `every ${a.spec.interval}` : '', a.spec?.on_fail_severity])), 'synthetic checks — their targets are placeholder params'),
        list('chaos', 'Chaos experiments', pick(A, /^CHAOS-/).map(a => listItem(a, [a.spec?.engine, a.spec?.target ? `on ${a.spec.target}` : '', a.spec?.fault?.kind, a.spec?.schedule, a.spec?.environment, a.spec?.expected_mttd ? `MTTD ${a.spec.expected_mttd}` : ''])), 'tier-2 runs them monthly in staging; tier-1 one per SLO and weekly in prod'),
        list('baselines', 'Baselines', pick(A, /^BASE-/).map(a => listItem(a, a.tags || [])), 'MTTD / MTTR targets — starting points reported as a todo'),
      ];
    case 'GOV':
      return [list('imports', 'Imports', pick(A, /^IMP-/).map(a => listItem(a, a.tags || [])), 'vertical composition — the platform’s budget policy')];
    default:
      return [];
  }
}

/**
 * buildSheetModel({ layerId, build, library, requirements, stack, checklist, mode }) → the
 * per-layer sheet: the title (`L1 · Contract`) and its question, the layer's clauses at
 * the tier with their state (from the step's stack, or built here from `requirements` +
 * `checklist`), then the layer's options — the section switches with the consequence of
 * switching each off, the L1 rolodex (the selected entries' SLIs, every product's behind
 * `build.rolodexAll`), the params the layer shapes (grouped; L4 channels vs runbooks),
 * the lists read from the instantiated pack, and on VERIFY the layer's todos with their
 * param rows. `mode`: 'edit' (DEFINE and COMPILE — the same live sheet on both) | 'verify'
 * (read-only options, editable todos).
 */
export function buildSheetModel({ layerId, build, library, requirements = [], stack = null, checklist = null, mode = 'edit', entering = false }) {
  const def = LAYER_DEFS.find(d => d.id === layerId) || { id: layerId, num: layerId, name: layerId };
  const r = build?.result || null;
  const params = paramRows({ build, library });
  const stackModel = stack || buildStackModel({
    adapted: r?.adapted || null, requirements, checklist: checklist || buildClauseChecklist(requirements, r?.summary || null),
    todos: r?.todos || [], params, mode: mode === 'verify' ? 'verify' : (build?.step === 'define' ? 'define' : 'compile'), toggles: build?.toggles || {},
  });
  const slab = stackModel.slabs.find(s => s.id === layerId) || {
    id: layerId, num: def.num, name: def.name, state: 'neutral', stateText: 'no clause applies', why: [], clauses: [], artefacts: [], ghosts: [], todos: [],
    counts: { artefacts: 0, scaffold: 0, verified: 0, detail: 0, ghosts: 0, todos: 0, clauses: 0 }, maturity: { total: 0, pass: 0, placeholder: 0, fail: 0, pending: 0 }, dimmed: false, offSections: [], notes: [], subgroups: null,
  };
  const layerParams = params.filter(p => paramLayer(p) === layerId);
  const groupsFor = () => {
    if (layerId === 'L4') return [
      { id: 'channels', label: 'Channels', sub: 'oncall and team chat, the pager services — placeholders until the team names them', rows: layerParams.filter(p => paramSubgroup(p) === 'alerting') },
      { id: 'runbooks', label: 'Runbooks', sub: 'where the remediation runbooks live', rows: layerParams.filter(p => paramSubgroup(p) === 'healing') },
    ].filter(g => g.rows.length);
    if (layerId === 'L2') return [
      { id: 'targets', label: 'Scrape targets & selectors', sub: 'the entries’ params: exporter addresses, job labels, selectors', rows: layerParams.filter(p => p.entry) },
      { id: 'endpoints', label: 'Endpoints & versions', sub: 'the scaffold’s: where each signal goes, and the backend versions the pack declares', rows: layerParams.filter(p => !p.entry) },
    ].filter(g => g.rows.length);
    if (layerId === 'L5') return [{ id: 'targets', label: 'Probe & chaos targets', sub: 'what the probes hit and the experiments fault', rows: layerParams }].filter(g => g.rows.length);
    return [];
  };
  const clauses = slab.clauses || [];
  // A switch's consequence spans the tier: SLOs off drops L1's clauses and L4's burn alert.
  const tierClauses = stackModel.slabs.flatMap(s => s.clauses || []);
  const switches = (LAYER_SWITCHES[layerId] || []).map(id => sectionSwitch(id, build, tierClauses));
  const compiled = !!r?.adapted;
  const lists = sheetLists(layerId, r?.adapted || null, { compiled });
  const errors = splitBuildErrors(build?.error);
  const rolodex = layerId === 'L1' ? (() => {
    const items = rolodexItems({ build, library, all: !!build?.rolodexAll });
    const inPack = items.filter(i => i.selected);
    return {
      items, filterAll: !!build?.rolodexAll,
      // The keys an explicit list starts from when the first switch flips: what is in the pack now (library SLIs only; the custom ones are their own list).
      allKeys: inPack.filter(i => !i.custom).map(i => i.key),
      counts: {
        total: items.length, selected: inPack.length, selectable: items.filter(i => i.entrySelected && !i.custom).length,
        aboveTier: inPack.filter(i => i.aboveTier).length, customised: inPack.filter(i => i.customised.length).length, custom: inPack.filter(i => i.custom).length,
        library: (library?.entries || []).length, chosen: selectedEntries(build, library).length,
      },
      // The last card while composing: '+ Custom SLI', which opens the editor in create mode (docs/BUILD_JOURNEY.md "The editor").
      create: mode === 'edit',
      // The editor opens from a card's Edit (View on Verify); the editor's own mode follows the step (editorModeFor).
      editLabel: mode === 'verify' ? 'View' : 'Edit',
    };
  })() : null;
  const { byParam } = errors;
  const rejected = layerParams.filter(p => byParam[p.key]).length;
  return {
    layerId, num: slab.num, name: slab.name, title: `${slab.num} · ${slab.name}`, question: LAYER_QUESTIONS[layerId] || '',
    mode, readOnly: mode !== 'edit', step: build?.step || null, tier: build?.tier || null,
    // True on the render that opens the sheet only (the controller's one-shot): the entrance plays once, never on a re-render.
    entering: !!entering,
    state: slab.state, stateText: slab.stateText, why: slab.why || [], dimmed: !!slab.dimmed, offSections: slab.offSections || [], notes: slab.notes || [],
    clauses, counts: { ...slab.counts, clauses: slab.maturity },
    switches, rolodex, paramGroups: groupsFor(), lists, compiled,
    todos: mode === 'verify' ? (slab.todos || []) : [],
    todoCount: (slab.todos || []).length,
    owners: layerId === 'GOV' ? parseOwners(build?.owners) : null,
    rejected, stale: isStale(build), pending: !!build?.pending,
  };
}
