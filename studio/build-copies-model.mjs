// studio/build-copies-model.mjs
//
// The copies of the BUILD journey (docs/BUILD_JOURNEY.md "The seed and the
// copies", "The editor"): the library's values are defaults the user edits in
// place, never links. Pure models over the draft's `overrides` ({ [sliKey]:
// { field: value } }, copy-on-write — only the fields the user edited, keyed
// by the id the library gives the SLI in the pack, so a renamed SLI stays
// attached to its library row) and `custom` (SLIs written from scratch), for
// the L1 rolodex and the pop-up editor (studio/build-editor-view.mjs):
//
//   effectiveSli(row, tier, override)  the values an SLI starts with: the library's at the tier (the index reads
//                                      them through the engine's per-tier walk) under the user's override
//   effectiveId(key, override)         the id the pack carries: the override's rename, else the key
//   sliEditorModel({ item, result, library, build, mode, errors, allKeys })
//                                      the editor over one SLI (edit, or read-only on Verify) or over a new one
//                                      (create): the title chips, the fields per type with value / default /
//                                      overridden / kind / focus key / error / hint, the PromQL RESOLVED (the
//                                      parameters in, read from the instantiated pack) with the parameters line,
//                                      the evidence line, the status line from the last result, the footer's
//                                      switch — and in create mode the form (customFormModel) with canSubmit
//   checkEditorId(text, { key, existingIds })  what a typed id means before the engine is asked: cleared, a slug, a clash
//   existingSliIds({ build, library })  every id an SLI of the pack may not take
//   resolveTemplate(text, params, entry)  a library template with the engine's parameter values in
//   customFormModel(draft, { … })      the create form: the fields per type, the id auto-slugged from the name, the
//                                      engine's usage errors inline, whether it can be added
//   customDefFromDraft(draft)          the definition the engine takes (the percent typed becomes the ratio the
//                                      pack stores; the numbers parsed)
//
// Nothing here re-implements the engine's validation: the engine is the
// authority (a 400 comes back with `override <sli>.<field>: …` / `custom
// <id>.<field>: …`, keyed here per field); this module only says what to
// draw, pre-checks an id the way the engine will (so a clash is said while
// typing, not after a round trip) and converts the studio's percent into the
// engine's ratio. No state reads, no fetches, no DOM (tested under node:test
// in tools/test-build-editor.mjs and tools/test-build-model.mjs). It imports
// nothing from build-model.mjs, so build-model.mjs can import it.

/** The fields an override may carry — the engine's OVERRIDE_FIELDS, spelled once here for the browser. */
export const OVERRIDE_FIELDS = ['id', 'objective', 'window', 'threshold', 'query', 'good', 'total', 'description', 'unit', 'semconv_metric'];
/** The schema's SLO windows: what the window input offers (the engine refuses any other). */
export const SLO_WINDOWS = ['7d', '28d', '30d', '90d'];
/** The fields that replace the library's PromQL — an edit here drops the library's evidence. */
export const PROMQL_FIELDS = ['query', 'good', 'total'];
/** A custom SLI's id, and a rename: the engine's CUSTOM_ID_RE. */
export const CUSTOM_ID_RE = /^[a-z][a-z0-9_]{1,62}$/;
export const SLI_TYPES = ['ratio', 'threshold'];
/** The compiler's reserved policy-record segment: never an SLI id (the engine's POLICY_SEGMENT). */
const RESERVED_ID = 'errorbudget';
const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

/** The override the draft holds for an SLI key: its own entry (never through the prototype chain), copied; {} when none. */
export function overrideFor(build, key) {
  const ov = hasOwn(build?.overrides, key) ? build.overrides[key] : null;
  if (!ov || typeof ov !== 'object') return {};
  const out = {};
  for (const k of OVERRIDE_FIELDS) if (hasOwn(ov, k) && ov[k] !== null && ov[k] !== undefined && String(ov[k]) !== '') out[k] = ov[k];
  return out;
}
/** The override's field names, in the engine's order — what the card's "customised: …" chip reads. */
export function customisedFields(override) {
  return OVERRIDE_FIELDS.filter(k => hasOwn(override, k));
}
/** Whether the override replaces the library's PromQL (the evidence then no longer applies). */
export function promqlEdited(override) {
  return PROMQL_FIELDS.some(k => hasOwn(override, k));
}
/** The id the pack carries for a library SLI: the override's rename when one is set, else the key the library gives it. */
export function effectiveId(key, override = {}) {
  return hasOwn(override, 'id') && typeof override.id === 'string' && override.id ? override.id : key;
}

/**
 * The values a library SLI starts with at a tier under an override: the index row's objective and window at
 * the tier (read through the engine's per-tier walk, so an SLI above the tier has them too), its threshold,
 * PromQL templates, description, unit and metric — each replaced by the override where one is set.
 */
export function effectiveSli(row, tier, override = {}) {
  const pick = (field, dflt) => (hasOwn(override, field) ? override[field] : dflt);
  return {
    objective: pick('objective', row?.objectives?.[tier] ?? null),
    window: pick('window', row?.windows?.[tier] ?? null),
    threshold: pick('threshold', row?.threshold ?? null),
    query: pick('query', row?.query ?? null),
    good: pick('good', row?.good ?? null),
    total: pick('total', row?.total ?? null),
    description: pick('description', row?.description ?? ''),
    unit: pick('unit', row?.unit ?? null),
    semconv_metric: pick('semconv_metric', row?.semconv_metric ?? null),
  };
}
/** A custom SLI's values in the same shape (its definition is all it has). */
export function customEffective(def) {
  return {
    objective: def?.objective ?? null, window: def?.window ?? null, threshold: def?.threshold ?? null,
    query: def?.query ?? null, good: def?.good ?? null, total: def?.total ?? null,
    description: def?.description ?? '', unit: def?.unit ?? null, semconv_metric: def?.semconv_metric ?? null,
  };
}

/** A ratio as the percent the studio shows: 0.995 → '99.5', 0.9999 → '99.99' (up to four decimals, no trailing zeros). */
export function percentText(ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '';
  return Number((ratio * 100).toFixed(4)).toString();
}
/** The percent typed → the ratio the pack stores (NaN when it is not a number); '99.5' → 0.995. */
export function ratioOf(text) {
  const n = Number(String(text ?? '').trim().replace(/%$/, ''));
  if (!Number.isFinite(n)) return NaN;
  return Number((n / 100).toFixed(6));
}

/** The engine's sloIdFor, spelled once here for the browser: `<sli>_<pct>` with the percent's point as `_` (0.995 → `_99_5`). */
export function sloIdFor(sliId, objective) {
  return `${sliId}_${Number((objective * 100).toFixed(4)).toString().replace('.', '_')}`;
}

/** A typed name as an SLI id: lowercase, runs of anything else → '_', a leading letter, at most 63 characters. */
export function slugifySliId(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^[^a-z]+/, '').replace(/_$/, '').slice(0, 63);
}

// ---------- the templates ----------

const PLACEHOLDER_RE = /\$\{([a-zA-Z_][a-zA-Z0-9_.]*)\}/g;
/** The parameter names a library template references (`${job}` → job), once each, in order of appearance. */
export function templateParams(text) {
  return [...new Set([...String(text ?? '').matchAll(PLACEHOLDER_RE)].map(m => m[1]))];
}
/**
 * A library template with the parameter values the engine used in it — `params` is the instantiate result's
 * `provenance.params` (`<entry>.<param>` when several entries compose, the bare `<param>` otherwise): what the pack
 * carries for the expression. `used` lists each parameter with the key it is edited under (the L2 sheet's) and its
 * value; `unresolved` the names no value was found for (left as `${name}` — before the first compilation, or a
 * template the engine never saw). The compiled pack is the authority; this is what the editor shows until it answers.
 */
export function resolveTemplate(text, params = null, entry = null) {
  const used = [], unresolved = [];
  const lookup = (name) => {
    if (!params || typeof params !== 'object') return undefined;
    for (const k of entry ? [`${entry}.${name}`, name] : [name]) if (hasOwn(params, k)) return { key: k, value: String(params[k]) };
    return undefined;
  };
  const out = String(text ?? '').replace(PLACEHOLDER_RE, (m, name) => {
    const hit = lookup(name);
    if (!hit) { if (!unresolved.includes(name)) unresolved.push(name); return m; }
    if (!used.some(u => u.name === name)) used.push({ name, ...hit });
    return hit.value;
  });
  return { text: out, used, unresolved, resolved: unresolved.length === 0 };
}

// ---------- the editor ----------

const FIELD_META = {
  id: { label: 'Id', kind: 'slug', hint: 'the SLI id the pack carries — a rename here; the SLO, the recording rule, the boards and the burn alerts follow' },
  description: { label: 'Description', kind: 'text', hint: 'what the SLI measures, for the cards and the boards' },
  objective: { label: 'Objective', kind: 'percent', hint: 'the SLO objective as a percent (the pack stores the ratio; the SLO id follows it)' },
  window: { label: 'Window', kind: 'window', hint: 'the SLO window — 7d · 28d · 30d · 90d, the schema’s set' },
  threshold: { label: 'Bound', kind: 'number', hint: 'an upper bound in the SLI’s unit (spec v1.2 has no direction: a floor is a ratio SLI)' },
  unit: { label: 'Unit', kind: 'unit', hint: 'the unit of the bound (seconds, requests, per_second, …)' },
  semconv_metric: { label: 'Metric', kind: 'text', hint: 'the semantic-conventions metric the SLI reads (http.server.request.duration) — a claim on the pack, not a query' },
  query: { label: 'Query (PromQL)', kind: 'promql', hint: 'the expression as it runs, the parameters in — an edit replaces the library’s and its evidence no longer applies' },
  good: { label: 'Good events (PromQL)', kind: 'promql', hint: 'the good leg as it runs, the parameters in — an edit replaces the library’s and its evidence no longer applies' },
  total: { label: 'Total events (PromQL)', kind: 'promql', hint: 'the total leg as it runs, the parameters in — an edit replaces the library’s and its evidence no longer applies' },
};
/** The fields an SLI of a type carries, in the editor's reading order: the identity row, the objective row, the bound row, the metric, then the PromQL. */
export function fieldsForType(type) {
  return type === 'threshold'
    ? ['id', 'description', 'objective', 'window', 'threshold', 'unit', 'semconv_metric', 'query']
    : ['id', 'description', 'objective', 'window', 'semconv_metric', 'good', 'total'];
}
// A number as the editor shows it (the objective as a percent); text that did not parse ('abc', '99,5') as typed, so the
// input keeps what the user wrote beside the engine's error instead of going blank or reading 'NaN'.
const display = (field, v) => (v === null || v === undefined ? '' : field === 'objective' && typeof v === 'number' ? percentText(v) : String(v));

/**
 * What a typed id means, before the engine is asked (the engine stays the authority): '' clears the rename (the
 * key stands), an id equal to the key is no rename, otherwise a slug of 2 to 63 characters (CUSTOM_ID_RE, not the
 * compiler's reserved `errorbudget`) that no other SLI of the pack or of a selected product carries (`existingIds`).
 * Returns { ok, id, message } — `id` the value to commit (null clears the rename), `message` what to say under the
 * field when it is not ok (the text stays in the field, nothing is sent).
 */
export function checkEditorId(text, { key = null, existingIds = [] } = {}) {
  const id = String(text ?? '').trim();
  if (!id || id === key) return { ok: true, id: null, message: null };
  if (!CUSTOM_ID_RE.test(id)) return { ok: false, id, message: 'an id is a slug of 2 to 63 characters: a letter, then letters, digits or _' };
  if (id === RESERVED_ID) return { ok: false, id, message: `${RESERVED_ID} is the compiler’s reserved policy-record segment — pick another id` };
  if (existingIds.includes(id)) return { ok: false, id, message: `${id} is already an SLI of the pack or of a selected product — pick another id` };
  return { ok: true, id, message: null };
}

/** The id the library gives an entry's SLI in a pack: prefixed with the entry when several entries compose (the engine's rule; build-model.mjs sliKey spells it too — entry ids are slugs, so the prefix is the id with `_` for `-`). */
const packKey = (entryId, sliId, composed) => (composed ? `${String(entryId).replace(/-/g, '_')}_${sliId}` : sliId);
/**
 * Every id an SLI of the pack may not take: the ids the library gives the selected entries' SLIs (ticked or not — an
 * un-ticked one clashes the moment it is ticked), the renames in the draft, the custom ids; `except` (an SLI's own key
 * and current id, when it is the one being edited) left out.
 */
export function existingSliIds({ build, library, except = [] } = {}) {
  const rows = library?.entries || [];
  const chosen = (build?.entries || []).filter(id => rows.some(r => r.id === id));
  const composed = chosen.length > 1;
  const ids = new Set();
  for (const id of chosen) for (const s of (rows.find(r => r.id === id)?.slis || [])) ids.add(packKey(id, s.id, composed));
  for (const [k, ov] of Object.entries(build?.overrides || {})) { const rid = effectiveId(k, ov && typeof ov === 'object' ? ov : {}); if (rid !== k) ids.add(rid); }
  for (const def of build?.custom || []) if (def?.id) ids.add(def.id);
  for (const x of except) ids.delete(x);
  return [...ids];
}

/** The SLI as the last instantiation compiled it, by the id the pack carries (a rename the engine has not answered yet is not found: the status says applying). */
const compiledSli = (result, id) => (result?.canonical?.spec?.slis || []).find(s => s.id === id) || null;

/** The status line: what happened to the last edit, from the draft's flags and the last result. */
function editorStatus({ build, result, item, id, custom, readOnly, errors, compiled }) {
  const spec = result?.canonical?.spec || null;
  const slo = spec?.slos?.find(s => s.sli === id) || null;
  // The policy carries one entry per SLO with its windows; the compiler emits one burn alert per window.
  const burns = slo ? (spec?.policy?.burn_rate_alerts || []).filter(a => a.slo === slo.id).reduce((n, a) => n + ((a.windows || []).length || 1), 0) : 0;
  const rule = spec?.queries?.recording_rules?.find(r => r.expr === `ref:slis.${id}`)?.name || null;
  const applied = () => `${slo ? `SLO ${slo.id}` : 'SLOs off'}${burns ? ` · ${burns} burn alert${burns === 1 ? '' : 's'}` : ''}${rule ? ` · rule ${rule}` : ''}`;
  if (readOnly) return { kind: 'readonly', text: compiled ? `as compiled · ${applied()}` : 'not in the pack' };
  if (!custom && !item.selected) return { kind: 'off', text: item.entrySelected ? 'not in the pack — switch it on below; your edits wait with it' : `not in the pack — adding it selects ${item.entryTitle} too` };
  const errFields = errors ? Object.keys(errors).filter(Boolean) : [];
  if (errFields.length) return { kind: 'error', text: `rejected — ${errFields[0]}: ${errors[errFields[0]]}` };
  if (errors && hasOwn(errors, '')) return { kind: 'error', text: `rejected — ${errors['']}` };
  if (build?.pending || build?.editorDirty) return { kind: 'pending', text: 'applying…' };
  if (build?.error) return { kind: 'stale', text: 'the last compilation failed elsewhere — the pack shown is the previous one' };
  if (!result) return { kind: 'pending', text: 'compiling…' };
  if (!compiled) return { kind: 'pending', text: 'applying…' };
  return { kind: 'applied', text: `applied · ${applied()}` };
}

/**
 * sliEditorModel({ item, result, library, build, mode, errors, allKeys }) → the pop-up editor over one SLI (a
 * rolodex item — rolodexItems' shape: key, id, entry, entryTitle, type, effective, defaults, override, selected,
 * aboveTier, custom …) or, without an item / with mode 'create', over a new custom SLI (createEditorModel below).
 *
 *   title       the id the pack carries (large), the product and its evidence, the type, the chips (above the tier,
 *               customised / custom, `was <key>` after a rename)
 *   fields      per type (fieldsForType), each with its displayed value (the objective as a percent; the PromQL
 *               RESOLVED — the expression the instantiated pack carries for the SLI, read from result.canonical by
 *               id, else the library template with result.provenance.params in), the library default beside it
 *               (`default`, or `defaultLabel` for the PromQL, whose default is the resolved library expression), whether
 *               it is overridden (a per-field '↺ library default'), the input kind, its focus key (`ov:<key>:<field>` /
 *               `cu:<id>:<field>`), the engine's usage error for the field
 *   parameters  the parameters the PromQL references with their values and where they are edited (the L2 sheet)
 *   evidence    the badge and its line ('edited — …' once the PromQL was edited), `provenance` the line Verify prints
 *   status      what happened to the last edit: applying…, applied · SLO <id> · N burn alerts · rule <name>, the
 *               engine's error, not in the pack, stale — or as compiled on Verify
 *   switch      the SLI's add / remove switch for the footer (null read-only); resetAll when anything is customised
 *   existingIds every id a rename may not take (checkEditorId reads it while typing)
 *
 * `mode`: 'edit' (Define and Compile), 'readonly' (Verify: values, provenance, no input), 'create'. `errors` the
 * engine's usage errors for this SLI keyed by field (splitBuildErrors.byOverride[key] / byCustom[id]). `allKeys` the
 * library keys in the pack now (what an explicit list starts from when the footer switch flips).
 */
export function sliEditorModel({ item = null, result = null, library = null, build = null, mode = 'edit', errors = null, allKeys = [] } = {}) {
  if (!item || mode === 'create') return createEditorModel({ build, library, result, errors });
  const readOnly = mode === 'readonly' || mode === 'verify';
  const custom = !!item.custom;
  const key = item.key;
  const ov = custom ? {} : (item.override || {});
  const id = custom ? item.id : effectiveId(key, ov);
  const prefix = custom ? `cu:${key}` : `ov:${key}`;
  const params = result?.provenance?.params || null;
  const compiled = compiledSli(result, id);
  const eff = item.effective || {};
  const dflt = custom ? null : (item.defaults || {});
  const renamed = !custom && id !== key;
  const used = new Map();   // parameter name → { key, value } across the PromQL fields
  const names = [];
  const fields = fieldsForType(item.type).map(field => {
    const meta = FIELD_META[field];
    const overridden = !custom && hasOwn(ov, field);
    let value, def = custom ? null : display(field, dflt?.[field]), defaultLabel = null;
    if (field === 'id') { value = id; def = custom ? null : key; }
    else if (PROMQL_FIELDS.includes(field)) {
      const template = custom ? eff[field] : dflt?.[field];
      const res = resolveTemplate(template, params, item.entry);
      for (const n of templateParams(template)) if (!names.includes(n)) names.push(n);
      for (const u of res.used) used.set(u.name, u);
      // The library's expression as it runs: what the engine compiled (the parameters in) while the field is the
      // library's, else the template resolved here.
      const libraryExpr = custom ? null : (!overridden && compiled && typeof compiled[field] === 'string' ? compiled[field] : res.text);
      value = overridden ? String(ov[field]) : custom ? String(eff[field] ?? '') : libraryExpr;
      def = libraryExpr;
      defaultLabel = custom ? null : 'the library’s expression, the parameters in';
    } else value = display(field, eff[field]);
    return {
      id: field, ...meta,
      ...(field === 'id' && custom ? { hint: 'your SLI’s id — the SLO, the recording rule and the boards follow a rename' } : {}),
      ...(field === 'semconv_metric' ? { placeholder: 'http.server.request.duration' } : {}),
      value, raw: field === 'id' ? id : (eff[field] ?? null),
      default: def, defaultLabel, overridden, resettable: overridden && !readOnly,
      focusKey: `${prefix}:${field}`, inputId: `build-editor-${field}`,
      error: errors && hasOwn(errors, field) ? errors[field] : null, readOnly,
      ...(field === 'window' ? { options: SLO_WINDOWS } : {}),
    };
  });
  const customised = custom ? [] : customisedFields(ov);
  const edited = !custom && promqlEdited(ov);
  const parameters = names.length ? {
    names,
    values: names.map(n => ({ name: n, key: used.get(n)?.key || null, value: used.get(n)?.value ?? null })),
    text: params
      ? `parameters: ${names.map(n => `${n}=${used.get(n)?.value ?? '?'}`).join(', ')} — edit them in L2`
      : `parameters: ${names.join(', ')} — resolved on the first compilation; edit them in L2`,
  } : null;
  const chips = [
    ...(item.aboveTier ? [{ kind: 'above', text: `from the ${item.profileTier} profile`, title: `this SLI's own tier is ${item.profileTier}: it starts from that profile's objective and window — the tier is a seed, not a gate` }] : []),
    ...(custom ? [{ kind: 'custom', text: 'custom', title: 'written in the studio — not a library SLI' }] : customised.length ? [{ kind: 'customised', text: 'customised', title: `customised: ${customised.join(', ')}` }] : []),
    ...(renamed ? [{ kind: 'renamed', text: `was ${key}`, title: `the library gives this SLI the id ${key}; the pack carries ${id}` }] : []),
  ];
  const provenance = custom ? 'custom — written in the studio' : customised.length ? `customised: ${customised.join(', ')} — the rest is ${item.entryTitle}’s` : `${item.entryTitle}’s defaults`;
  const evidence = {
    status: custom || edited ? 'custom' : (item.libraryEvidence || item.evidence || null),
    note: custom ? 'written in the studio — no library evidence' : edited ? 'edited — the library’s evidence no longer applies' : 'the library’s evidence — its expression is what runs',
  };
  const label = `${id} of ${item.entryTitle}${custom ? ' — remove your SLI from the pack' : item.selected ? ' — remove from the pack' : item.entrySelected ? ' — add to the pack' : ` — add to the pack (selects ${item.entryTitle} too)`}`;
  return {
    create: false, custom, readOnly, mode: readOnly ? 'readonly' : 'edit', key, id, type: item.type, renamed,
    title: { id, product: item.entryTitle, evidence: item.entryEvidence || null, sliEvidence: evidence.status, type: item.type, chips },
    typeHint: 'fixed — a different shape is a new custom SLI (+ Custom SLI on the L1 sheet)',
    fields, customised, parameters, evidence, provenance,
    promqlWarning: item.promqlWarning || null,
    generalError: errors && hasOwn(errors, '') ? errors[''] : null,
    status: editorStatus({ build, result, item, id, custom, readOnly, errors, compiled }),
    resetAll: !custom && !readOnly && customised.length > 0,
    switch: readOnly ? null : {
      on: !!item.selected, label, focusKey: `${item.focusKey}@editor`,
      data: { sli: key, entry: item.entry || '', 'sli-id': item.id, selected: item.selected ? '1' : '0', 'entry-selected': item.entrySelected ? '1' : '0', ...(custom ? { custom: '1' } : {}) },
    },
    allKeys: [...allKeys],
    doneLabel: readOnly ? 'Close' : 'Done',
    existingIds: existingSliIds({ build, library, except: [key, id] }),
  };
}

/** The editor in create mode: the same dialog over the custom form (customFormModel), 'Add to the pack' from its canSubmit. */
function createEditorModel({ build, library, result, errors }) {
  const form = customFormModel(build?.customDraft, { errors, existingKeys: existingSliIds({ build, library }), existingSloIds: (result?.canonical?.spec?.slos || []).map(s => s.id) });
  const d = form.draft;
  return {
    create: true, custom: true, readOnly: false, mode: 'create', key: null, id: d.id || null, type: d.type, renamed: false,
    title: { id: d.id || 'new SLI', product: 'Custom SLI', evidence: 'custom', sliEvidence: 'custom', type: d.type, chips: [{ kind: 'custom', text: 'custom', title: 'written in the studio — no library evidence' }] },
    typeHint: 'ratio: good over total events · threshold: a value under an upper bound',
    fields: form.fields.map(f => ({ ...f, readOnly: false, default: null, defaultLabel: null, overridden: false, resettable: false })),
    customised: [], parameters: null,
    evidence: { status: 'custom', note: 'written in the studio — no library evidence' }, provenance: 'custom — written in the studio',
    promqlWarning: null, generalError: form.generalError,
    status: form.canSubmit
      ? { kind: 'ready', text: 'ready — Add to the pack compiles once and keeps the SLI when the engine accepts it' }
      : { kind: 'idle', text: `fill the required fields: ${form.required.join(', ')}${form.draft.id ? '' : ' — and a name'}` },
    resetAll: false, switch: null, allKeys: [], doneLabel: 'Cancel',
    submit: { label: form.addLabel, enabled: form.canSubmit, focusKey: form.focusKey },
    form,
    existingIds: form.existingKeys,
  };
}

// ---------- the create form ----------

const DRAFT_DEFAULTS = { name: '', id: '', idTouched: false, type: 'ratio', description: '', unit: '', semconv_metric: '', good: '', total: '', query: '', threshold: '', objective: '99.9', window: '30d' };
/** The form's draft with the defaults filled in and the id slugged from the name unless the user typed one. */
export function normalizeDraft(draft) {
  const d = { ...DRAFT_DEFAULTS, ...(draft || {}) };
  if (!SLI_TYPES.includes(d.type)) d.type = 'ratio';
  if (!d.idTouched) d.id = slugifySliId(d.name);
  return d;
}

/**
 * customFormModel(draft, { errors, existingKeys, existingSloIds }) → the editor's create mode: the fields (the name
 * with the id auto-slugged beneath, the type, the description, the objective as a percent, the window, the unit and
 * the bound for a threshold SLI, the metric, the PromQL per type), each with its value, focus key (`cf:<field>`) and
 * the engine's usage error for it (from the 400 of the last 'Add to the pack'); an id that an SLI of the entries owns
 * (`existingKeys`: in the pack or not — the engine refuses both), an id that is not a slug, and an SLO id the pack
 * already carries (`existingSloIds`: `sloIdFor(id, objective)` — the engine refuses two SLIs on one SLO id) are said
 * on the id field before the engine is asked; `canSubmit` needs the required fields filled and none of those. The
 * inputs it was built with come back (`existingKeys`, `existingSloIds`) so the wiring can rebuild it as the user
 * types — one rule, the model's, never a second one in the renderer. The engine remains the authority on every value.
 */
export function customFormModel(draft, { errors = null, existingKeys = [], existingSloIds = [] } = {}) {
  const d = normalizeDraft(draft);
  const errs = errors && (errors[d.id] || errors['']) ? { ...(errors[''] || {}), ...(errors[d.id] || {}) } : {};
  const idClash = d.id && existingKeys.includes(d.id) ? `${d.id} is already an SLI of the pack or of a selected product — pick another name` : null;
  const idBad = d.id && !CUSTOM_ID_RE.test(d.id) ? 'an id is a slug of 2 to 63 characters: a letter, then letters, digits or _' : null;
  const objective = ratioOf(d.objective);
  const sloId = d.id && Number.isFinite(objective) ? sloIdFor(d.id, objective) : null;
  const sloClash = sloId && existingSloIds.includes(sloId) ? `${d.id} at ${String(d.objective).trim()} % would share the SLO id ${sloId} with an SLI of the pack — pick another id or objective` : null;
  const required = ['objective', 'window', ...(d.type === 'ratio' ? ['good', 'total'] : ['query', 'threshold'])];
  const field = (id, label, kind, extra = {}) => ({ id, label, kind, value: String(d[id] ?? ''), focusKey: `cf:${id}`, inputId: `build-custom-${id}`, error: hasOwn(errs, id) ? errs[id] : null, required: required.includes(id), ...extra });
  const fields = [
    field('name', 'Name', 'text', { placeholder: 'Checkout success', hint: d.id ? `id ${d.id}` : 'the id is slugged from the name' }),
    field('id', 'Id', 'slug', { placeholder: 'checkout_success', error: hasOwn(errs, 'id') ? errs.id : idClash || idBad || sloClash, hint: 'the SLI id the pack carries — edit it to keep your own' }),
    field('type', 'Type', 'select', { options: SLI_TYPES, hint: 'ratio: good over total events · threshold: a value under an upper bound' }),
    field('description', 'Description', 'text', { placeholder: 'what it measures' }),
    field('objective', 'Objective', 'percent', { hint: 'percent' }),
    field('window', 'Window', 'window', { options: SLO_WINDOWS }),
    ...(d.type === 'threshold' ? [field('threshold', 'Bound', 'number', { placeholder: '0.5', hint: 'an upper bound in the unit' }), field('unit', 'Unit', 'unit', { placeholder: 'seconds' })] : []),
    field('semconv_metric', 'Metric', 'text', { placeholder: 'http.server.request.duration', hint: 'optional — the semantic-conventions metric the SLI reads' }),
    ...(d.type === 'ratio'
      ? [field('good', 'Good events (PromQL)', 'promql', { placeholder: 'sum(rate(checkout_ok_total[5m]))' }), field('total', 'Total events (PromQL)', 'promql', { placeholder: 'sum(rate(checkout_total[5m]))' })]
      : [field('query', 'Query (PromQL)', 'promql', { placeholder: 'histogram_quantile(0.99, sum by (le)(rate(checkout_seconds_bucket[5m])))' })]),
  ];
  const filled = required.every(k => String(d[k] ?? '').trim() !== '') && !!d.id;
  return {
    draft: d, fields, idClash, sloClash, required, existingKeys: [...existingKeys], existingSloIds: [...existingSloIds],
    canSubmit: filled && !idClash && !idBad && !sloClash,
    generalError: hasOwn(errs, '') ? errs[''] : null,
    addLabel: 'Add to the pack',
    focusKey: 'cf:add',
  };
}

/**
 * A number field as typed → the number the engine takes (the objective's percent → the ratio), or the trimmed text
 * itself when it does not parse ('abc', '99,5'): never NaN, which JSON turns into null — the engine then answered
 * `got null`, the input went blank or read 'NaN', the card printed 'NaN%', a second bad entry equalled the first
 * and was ignored, and the persisted draft carried `objective: null` (measured live). With the text kept, the
 * engine answers `got "abc"`, the input keeps what was typed and every new attempt is a new value.
 */
export function numberOrText(field, text) {
  const t = String(text ?? '').trim();
  const n = field === 'objective' ? ratioOf(t) : Number(t);
  return Number.isFinite(n) ? n : t;
}

/** The definition the engine takes from the form: the percent typed → the ratio, the bound → a number (the text as typed when it is not one), the empty fields left out. */
export function customDefFromDraft(draft) {
  const d = normalizeDraft(draft);
  const def = { id: d.id, type: d.type, objective: numberOrText('objective', d.objective), window: d.window };
  if (d.type === 'ratio') { def.good = d.good; def.total = d.total; } else { def.query = d.query; def.threshold = numberOrText('threshold', d.threshold); if (String(d.unit).trim()) def.unit = d.unit.trim(); }
  if (String(d.description).trim()) def.description = d.description.trim();
  if (String(d.semconv_metric).trim()) def.semconv_metric = d.semconv_metric.trim();
  return def;
}

/**
 * An editor value as the engine takes it for the field: the percent → the ratio, the bound → a number, the id, the
 * window, the unit and the metric trimmed, the rest as typed; '' means "clear" (the caller removes the override).
 * Text that is not a number stays text (numberOrText): the caller passes it on and the engine's usage error names
 * the field and the value in the editor.
 */
export function fieldValueFor(field, text) {
  const t = String(text ?? '').trim();
  if (t === '') return null;
  if (field === 'objective' || field === 'threshold') return numberOrText(field, t);
  if (field === 'window' || field === 'id' || field === 'unit' || field === 'semconv_metric') return t;
  return String(text);
}
