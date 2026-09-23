// studio/build-copies-model.mjs
//
// The copies of the BUILD journey (docs/BUILD_JOURNEY.md "The seed and the
// copies"): the library's values are defaults the user edits in place, never
// links. Pure models over the draft's `overrides` ({ [sliKey]: { field:
// value } }, copy-on-write — only the fields the user edited) and `custom`
// (SLIs written from scratch), for the L1 rolodex's Customise face and its
// '+ Custom SLI' card:
//
//   effectiveSli(row, tier, override)  the values an SLI starts with: the library's at the tier
//                                      (the index reads them through the engine's per-tier walk)
//                                      under the user's override
//   editFaceModel(item, { errors })    the fields of a card's edit face — value, default, overridden,
//                                      the input kind, the focus key, the engine's error for the field
//   customFormModel(draft, { … })      the '+ Custom SLI' form — the fields per type, the id auto-slugged
//                                      from the name, the engine's usage errors inline, whether it can be
//                                      added
//   customDefFromDraft(draft)          the definition the engine takes (the percent typed becomes the
//                                      ratio the pack stores; the numbers parsed)
//
// Nothing here re-implements the engine's validation: the engine is the
// authority (a 400 comes back with `override <sli>.<field>: …` / `custom
// <id>.<field>: …`, keyed here per field); this module only says what to
// draw and converts the studio's percent into the engine's ratio. No state
// reads, no fetches, no DOM (tested under node:test in
// tools/test-build-model.mjs). It imports nothing from build-model.mjs, so
// build-model.mjs can import it.

/** The fields an override may carry — the engine's OVERRIDE_FIELDS, spelled once here for the browser. */
export const OVERRIDE_FIELDS = ['objective', 'window', 'threshold', 'query', 'good', 'total', 'description', 'unit'];
/** The schema's SLO windows: what the window input offers (the engine refuses any other). */
export const SLO_WINDOWS = ['7d', '28d', '30d', '90d'];
/** The fields that replace the library's PromQL — an edit here drops the library's evidence. */
export const PROMQL_FIELDS = ['query', 'good', 'total'];
/** A custom SLI's id: the engine's CUSTOM_ID_RE. */
export const CUSTOM_ID_RE = /^[a-z][a-z0-9_]{1,62}$/;
const SLI_TYPES = ['ratio', 'threshold'];
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

/**
 * The values a library SLI starts with at a tier under an override: the index row's objective and window at
 * the tier (read through the engine's per-tier walk, so an SLI above the tier has them too), its threshold,
 * PromQL templates, description and unit — each replaced by the override where one is set.
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
  };
}
/** A custom SLI's values in the same shape (its definition is all it has). */
export function customEffective(def) {
  return {
    objective: def?.objective ?? null, window: def?.window ?? null, threshold: def?.threshold ?? null,
    query: def?.query ?? null, good: def?.good ?? null, total: def?.total ?? null,
    description: def?.description ?? '', unit: def?.unit ?? null,
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

/** A typed name as an SLI id: lowercase, runs of anything else → '_', a leading letter, at most 63 characters. */
export function slugifySliId(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^[^a-z]+/, '').replace(/_$/, '').slice(0, 63);
}

// ---------- the edit face ----------

const FIELD_META = {
  objective: { label: 'Objective', kind: 'percent', hint: 'the SLO objective as a percent (the pack stores the ratio; the SLO id follows it)' },
  window: { label: 'Window', kind: 'window', hint: 'the SLO window — 7d · 28d · 30d · 90d, the schema’s set' },
  threshold: { label: 'Bound', kind: 'number', hint: 'an upper bound in the SLI’s unit (spec v1.2 has no direction: a floor is a ratio SLI)' },
  query: { label: 'Query (PromQL)', kind: 'promql', hint: 'replaces the library’s expression — its evidence no longer applies' },
  good: { label: 'Good events (PromQL)', kind: 'promql', hint: 'replaces the library’s good leg — its evidence no longer applies' },
  total: { label: 'Total events (PromQL)', kind: 'promql', hint: 'replaces the library’s total leg — its evidence no longer applies' },
  description: { label: 'Description', kind: 'text', hint: 'what the SLI measures, for the cards and the boards' },
  unit: { label: 'Unit', kind: 'unit', hint: 'the unit of the bound (seconds, requests, per_second, …)' },
};
/** The fields an SLI of a type carries, in the order the face shows them. */
export function fieldsForType(type) {
  return type === 'threshold' ? ['objective', 'window', 'threshold', 'unit', 'query', 'description'] : ['objective', 'window', 'good', 'total', 'description'];
}
// A number as the face shows it (the objective as a percent); text that did not parse ('abc', '99,5') as typed, so the
// input keeps what the user wrote beside the engine's error instead of going blank or reading 'NaN'.
const display = (field, v) => (v === null || v === undefined ? '' : field === 'objective' && typeof v === 'number' ? percentText(v) : String(v));

/**
 * editFaceModel(item, { errors, readOnly }) → the Customise face of a rolodex card: the fields the SLI's type
 * carries, each with its displayed value (the objective as a percent), the library default beside it (null
 * for a custom SLI: it has none), whether it is overridden (a per-field '↺ library default' resets it), the
 * input kind, its focus key (`ov:<key>:<field>`, or `cu:<id>:<field>` for a custom SLI) and the engine's
 * usage error for the field; the evidence line ('edited — …' once the PromQL was edited), the promql
 * warning the engine reported for the SLI, and the provenance line VERIFY prints.
 */
export function editFaceModel(item, { errors = null, readOnly = false } = {}) {
  const custom = !!item.custom;
  const prefix = custom ? `cu:${item.key}` : `ov:${item.key}`;
  const fields = fieldsForType(item.type).map(field => {
    const value = item.effective?.[field];
    const dflt = custom ? null : item.defaults?.[field];
    const overridden = custom ? false : hasOwn(item.override, field);
    return {
      id: field, ...FIELD_META[field], value: display(field, value), raw: value ?? null,
      default: custom ? null : display(field, dflt), overridden, resettable: overridden && !readOnly,
      focusKey: `${prefix}:${field}`, inputId: `build-edit-${item.key}-${field}`,
      error: errors && hasOwn(errors, field) ? errors[field] : null,
      ...(field === 'window' ? { options: SLO_WINDOWS } : {}),
    };
  });
  const edited = custom ? false : promqlEdited(item.override || {});
  return {
    key: item.key, custom, type: item.type, readOnly,
    fields,
    customised: custom ? [] : customisedFields(item.override || {}),
    evidence: {
      status: custom ? 'custom' : edited ? 'custom' : (item.libraryEvidence || item.evidence || null),
      note: custom ? 'written in the studio — no library evidence' : edited ? 'edited — the library’s evidence no longer applies' : null,
    },
    promqlWarning: item.promqlWarning || null,
    generalError: errors && hasOwn(errors, '') ? errors[''] : null,
    provenance: custom ? 'custom — written in the studio' : (customisedFields(item.override || {}).length ? `customised: ${customisedFields(item.override || {}).join(', ')} — the rest is ${item.entryTitle}’s` : `${item.entryTitle}’s defaults`),
  };
}

// ---------- the '+ Custom SLI' form ----------

const DRAFT_DEFAULTS = { name: '', id: '', idTouched: false, type: 'ratio', description: '', unit: '', good: '', total: '', query: '', threshold: '', objective: '99.9', window: '30d' };
/** The form's draft with the defaults filled in and the id slugged from the name unless the user typed one. */
export function normalizeDraft(draft) {
  const d = { ...DRAFT_DEFAULTS, ...(draft || {}) };
  if (!SLI_TYPES.includes(d.type)) d.type = 'ratio';
  if (!d.idTouched) d.id = slugifySliId(d.name);
  return d;
}

/**
 * customFormModel(draft, { errors, existingKeys }) → the last rolodex card on COMPILE: the fields (the name
 * with the id auto-slugged beneath, the type, the description, the PromQL per type, the unit and the bound
 * for a threshold SLI, the objective as a percent, the window), each with its value, focus key (`cf:<field>`)
 * and the engine's usage error for it (from the 400 of the last 'Add to the pack'); an id clash with an SLI
 * already in the pack is said before the engine is asked; `canSubmit` needs the required fields filled.
 * The engine remains the authority on every value.
 */
export function customFormModel(draft, { errors = null, existingKeys = [] } = {}) {
  const d = normalizeDraft(draft);
  const errs = errors && (errors[d.id] || errors['']) ? { ...(errors[''] || {}), ...(errors[d.id] || {}) } : {};
  const idClash = d.id && existingKeys.includes(d.id) ? `${d.id} is already an SLI of the pack — pick another name` : null;
  const idBad = d.id && !CUSTOM_ID_RE.test(d.id) ? 'an id is a slug of 2 to 63 characters: a letter, then letters, digits or _' : null;
  const required = ['objective', 'window', ...(d.type === 'ratio' ? ['good', 'total'] : ['query', 'threshold'])];
  const field = (id, label, kind, extra = {}) => ({ id, label, kind, value: String(d[id] ?? ''), focusKey: `cf:${id}`, inputId: `build-custom-${id}`, error: hasOwn(errs, id) ? errs[id] : null, required: required.includes(id), ...extra });
  const fields = [
    field('name', 'Name', 'text', { placeholder: 'Checkout success', hint: d.id ? `id ${d.id}` : 'the id is slugged from the name' }),
    field('id', 'Id', 'slug', { placeholder: 'checkout_success', error: hasOwn(errs, 'id') ? errs.id : idClash || idBad, hint: 'the SLI id the pack carries — edit it to keep your own' }),
    field('type', 'Type', 'select', { options: SLI_TYPES, hint: 'ratio: good over total events · threshold: a value under an upper bound' }),
    field('description', 'Description', 'text', { placeholder: 'what it measures' }),
    ...(d.type === 'ratio'
      ? [field('good', 'Good events (PromQL)', 'promql', { placeholder: 'sum(rate(checkout_ok_total[5m]))' }), field('total', 'Total events (PromQL)', 'promql', { placeholder: 'sum(rate(checkout_total[5m]))' })]
      : [field('query', 'Query (PromQL)', 'promql', { placeholder: 'histogram_quantile(0.99, sum by (le)(rate(checkout_seconds_bucket[5m])))' }), field('threshold', 'Bound', 'number', { placeholder: '0.5', hint: 'an upper bound in the unit' }), field('unit', 'Unit', 'unit', { placeholder: 'seconds' })]),
    field('objective', 'Objective', 'percent', { hint: 'percent' }),
    field('window', 'Window', 'window', { options: SLO_WINDOWS }),
  ];
  const filled = required.every(k => String(d[k] ?? '').trim() !== '') && !!d.id;
  return {
    draft: d, fields, idClash, required,
    canSubmit: filled && !idClash && !idBad,
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
  return def;
}

/**
 * An edit-face value as the engine takes it for the field: the percent → the ratio, the bound → a number, a
 * string trimmed; '' means "clear" (the caller removes the override). Text that is not a number stays text
 * (numberOrText): the caller passes it on and the engine's usage error names the field and the value on the card.
 */
export function fieldValueFor(field, text) {
  const t = String(text ?? '').trim();
  if (t === '') return null;
  if (field === 'objective' || field === 'threshold') return numberOrText(field, t);
  return field === 'window' ? t : String(text);
}
