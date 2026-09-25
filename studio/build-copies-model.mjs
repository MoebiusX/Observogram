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
//   sliSummarySentence(values)         the editor's opening sentence in real units ('… is healthy when its ratio is
//                                      at or below 0.8; target 99.9% of the time over 30 days.')
//   sliRelationshipChecks(values)      direction · bound · unit · objective · window checked as typed, per field
//   sliName(id) · windowText(w)        an id and a window as words; generatedOutputs(result, id) what the pack made
//                                      of an SLI (its SLO, recording rule, burn alerts)
//
// Nothing here re-implements the engine's validation: the engine is the
// authority (a 400 comes back with `override <sli>.<field>: …` / `custom
// <id>.<field>: …`, keyed here per field); this module only says what to
// draw, pre-checks an id the way the engine will (so a clash is said while
// typing, not after a round trip) and converts the studio's percent into the
// engine's ratio. No state reads, no fetches, no DOM (tested under node:test
// in tools/test-build-editor.mjs and tools/test-build-model.mjs). It imports
// nothing from build-model.mjs, so build-model.mjs can import it.

import { goodWhen, GOOD_WHEN } from './sli-direction.mjs';

/** The fields an override may carry — the engine's OVERRIDE_FIELDS, spelled once here for the browser (`good_when`: spec 1.3, the side of a threshold SLI's bound that is good). */
export const OVERRIDE_FIELDS = ['id', 'objective', 'window', 'threshold', 'good_when', 'query', 'good', 'total', 'description', 'unit', 'semconv_metric'];
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
    // the direction of the bound (spec 1.3): the row's (the index normalises it: below where the template says nothing), null on a ratio row; readers ask goodWhen()
    good_when: pick('good_when', row?.good_when ?? null),
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
    objective: def?.objective ?? null, window: def?.window ?? null, threshold: def?.threshold ?? null, good_when: def?.good_when ?? null,
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

// ---------- plain words: the SLI's name, its window, the sentence the editor opens with ----------

// Words an SLI id spells that read better in capitals (or spelled out) when the id is shown as a name.
const NAME_WORDS = { http: 'HTTP', https: 'HTTPS', dlq: 'DLQ', wal: 'WAL', tsdb: 'TSDB', api: 'API', otlp: 'OTLP', sli: 'SLI', slo: 'SLO', mq: 'MQ', qmgr: 'queue manager', grpc: 'gRPC', db: 'DB', ibm: 'IBM', jvm: 'JVM', cpu: 'CPU', gc: 'GC', tls: 'TLS', dns: 'DNS', p99: 'p99', p95: 'p95', ui: 'UI', io: 'I/O' };
/** An SLI id as a name a person reads: `queue_depth_headroom` → 'Queue depth headroom', `http_service_availability` → 'HTTP service availability'. */
export function sliName(id) {
  const words = String(id ?? '').split(/[_\s-]+/).filter(Boolean).map(w => NAME_WORDS[w.toLowerCase()] ?? w);
  if (!words.length) return '';
  const s = words.join(' ');
  return s[0].toUpperCase() + s.slice(1);
}
/** An SLO window as words: '30d' → '30 days', '1d' → '1 day'; anything else as it is ('' when empty). */
export function windowText(w) {
  const t = String(w ?? '').trim();
  const m = /^(\d+)d$/.exec(t);
  return m ? `${m[1]} day${m[1] === '1' ? '' : 's'}` : t;
}
// A bound's unit as it reads after the number: `per_second` → ' per second'; a ratio, a count and no unit read as the bare number.
const UNIT_WORDS = { per_second: 'per second', per_minute: 'per minute', events_per_hour: 'events per hour', percent: '%', '%': '%' };
function unitSuffix(unit) {
  const u = String(unit ?? '').trim();
  if (!u || u === 'ratio' || u === 'count') return '';
  const w = UNIT_WORDS[u] ?? u.replace(/_/g, ' ');
  return w === '%' ? '%' : ` ${w}`;
}
const numberText = (v) => { const t = String(v ?? '').trim().replace(/%$/, '').trim(); return t !== '' && Number.isFinite(Number(t)) ? String(Number(t)) : null; };

/**
 * The editor's opening sentence, in real units, from the values as they stand (the model's, or the inputs as typed):
 * 'Queue depth headroom is healthy when its ratio is at or below 0.8; target 99.9% of the time over 30 days.' — a
 * threshold SLI says which side of its bound is good (the bound itself is good either way, spec 1.3), a ratio SLI says
 * it is the share of good events. `name` (a typed name in create mode) wins over the id. A value missing or not a
 * number reads 'not set yet' instead of being guessed.
 */
export function sliSummarySentence({ id = '', name = '', type = 'ratio', objective = null, window = null, threshold = null, good_when = null, unit = null } = {}) {
  const who = sliName(name || id) || 'This SLI';
  const pct = numberText(objective);
  const win = windowText(window);
  const goal = pct ? `target ${pct}% ${type === 'ratio' ? 'good' : 'of the time'}${win ? ` over ${win}` : ''}` : 'no objective set yet';
  if (type === 'threshold' || type === 'distribution') {
    const u = String(unit ?? '').trim();
    const subject = u === 'ratio' ? 'its ratio is' : u === 'percent' || u === '%' ? 'its percentage is' : 'it is';
    const b = numberText(threshold);
    const side = goodWhen({ good_when }) === 'above' ? 'at or above' : 'at or below';
    return `${who} is healthy when ${b ? `${subject} ${side} ${b}${unitSuffix(u)}` : 'it stays within a bound that is not set yet'}; ${goal}.`;
  }
  return `${who} is the share of good events among all events; ${goal}.`;
}

/**
 * The relationships the editor checks as the user types, before the engine is asked (the engine stays the authority;
 * these catch what it would accept and what would still be wrong): the objective a percent strictly between 0 and 100,
 * the window one of the schema's, and for a threshold SLI a numeric bound that fits its unit (a ratio between 0 and
 * 1, a percent between 0 and 100, never negative in a unit), a direction that does not make every sample good, a unit
 * that is one word. An empty field is not checked here: in the editor it means "the library default", in the create
 * form the required list says it. Returns { [field]: message } — plain sentences a person can act on.
 */
export function sliRelationshipChecks({ type = 'ratio', objective = null, window = null, threshold = null, good_when = null, unit = null } = {}) {
  const out = {};
  const obj = String(objective ?? '').trim();
  if (obj) {
    const n = Number(obj.replace(/%$/, '').trim());
    if (!Number.isFinite(n)) out.objective = 'Enter the objective as a percent, like 99.9';
    else if (n <= 0 || n >= 100) out.objective = 'The objective is a percent above 0 and below 100, like 99.9';
  }
  const win = String(window ?? '').trim();
  if (win && !SLO_WINDOWS.includes(win)) out.window = `The window is one of ${SLO_WINDOWS.slice(0, -1).join(', ')} or ${SLO_WINDOWS.at(-1)}`;
  if (type !== 'threshold' && type !== 'distribution') return out;
  const u = String(unit ?? '').trim();
  if (u && !/^[A-Za-z%][\w%/.-]*$/.test(u)) out.unit = 'A unit is one word, like seconds, ratio or per_second';
  const t = String(threshold ?? '').trim();
  if (!t) return out;
  const b = Number(t);
  const unitLow = u.toLowerCase();
  if (!Number.isFinite(b)) out.threshold = 'Enter the bound as a number, like 0.8';
  else if (unitLow === 'ratio' && (b < 0 || b > 1)) out.threshold = `A ratio bound is between 0 and 1${b > 1 && b <= 100 ? ` — for ${b}%, enter ${Number((b / 100).toFixed(6))}` : ''}`;
  else if ((unitLow === 'percent' || unitLow === '%') && (b < 0 || b > 100)) out.threshold = 'A percent bound is between 0 and 100';
  else if (u && b < 0) out.threshold = `A bound in ${u.replace(/_/g, ' ')} cannot be negative`;
  else if (u && b <= 0 && goodWhen({ good_when }) === 'above') out.good_when = 'Good when above 0 makes every sample good — raise the bound or choose below';
  else if (unitLow === 'ratio' && b >= 1 && goodWhen({ good_when }) === 'below') out.good_when = 'Good when below 1 makes every ratio good — lower the bound or choose above';
  return out;
}
/** The fields sliRelationshipChecks reads: what the editor re-checks on every keystroke. */
export const CHECKED_FIELDS = ['objective', 'window', 'threshold', 'good_when', 'unit'];

// ---------- the editor ----------

// `help` is the short line under a field (an example, a few words); `hint` the longer explanation the field's '?'
// shows on demand — a paragraph under every field had to be read through before the form made sense (the review).
const FIELD_META = {
  id: { label: 'Id', kind: 'slug', help: 'Names the SLO, recording rule, boards and burn alerts', hint: 'the SLI id the pack carries — a rename here; the SLO, the recording rule, the boards and the burn alerts follow' },
  description: { label: 'Description', kind: 'text', help: 'What it measures, in one line', hint: 'what the SLI measures, for the cards and the boards' },
  objective: { label: 'Objective', kind: 'percent', help: 'How often it must be good, e.g. 99.9', hint: 'the SLO objective as a percent (the pack stores the ratio; the SLO id follows it)' },
  window: { label: 'Window', kind: 'window', help: '7d, 28d, 30d or 90d', hint: 'the SLO window — 7d · 28d · 30d · 90d, the schema’s set' },
  threshold: { label: 'Bound', kind: 'number', help: 'The limit in the unit, e.g. 0.8', hint: 'the bound in the SLI’s unit; good when below (a ceiling: latency, lag) or above (a floor: replicas, consumers)' },
  // spec 1.3 good_when: the side of the bound that is good — rendered as a two-segment control in the Bound cell (build-editor-view.mjs)
  good_when: { label: 'Good when', kind: 'direction', options: GOOD_WHEN, help: 'below: a ceiling (latency, lag) · above: a floor (replicas, consumers)', hint: 'below: a ceiling — samples above the bound are bad (latency, lag) · above: a floor — samples under it are bad (replicas, consumers); the bound itself is good either way' },
  unit: { label: 'Unit', kind: 'unit', help: 'e.g. seconds, ratio, per_second', hint: 'the unit of the bound (seconds, requests, per_second, …)' },
  semconv_metric: { label: 'Metric', kind: 'text', help: 'e.g. http.server.request.duration', hint: 'the semantic-conventions metric the SLI reads (http.server.request.duration) — a claim on the pack, not a query' },
  query: { label: 'Query (PromQL)', kind: 'promql', help: 'The expression as it runs, parameters filled in', hint: 'the expression as it runs, the parameters in — an edit replaces the library’s and its evidence no longer applies' },
  good: { label: 'Good events (PromQL)', kind: 'promql', help: 'The good events as they run, parameters filled in', hint: 'the good leg as it runs, the parameters in — an edit replaces the library’s and its evidence no longer applies' },
  total: { label: 'Total events (PromQL)', kind: 'promql', help: 'All events as they run, parameters filled in', hint: 'the total leg as it runs, the parameters in — an edit replaces the library’s and its evidence no longer applies' },
};
/** The fields an SLI of a type carries, in the editor's reading order: the identity row, the objective row, the bound row (the bound with its direction, then the unit), the metric, then the PromQL. */
export function fieldsForType(type) {
  return type === 'threshold'
    ? ['id', 'description', 'objective', 'window', 'threshold', 'good_when', 'unit', 'semconv_metric', 'query']
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

/**
 * What the pack generated from an SLI, by the id it carries: its SLO, the recording rule that materialises it and how
 * many burn alerts the policy gives the SLO (one per window) — the editor's "generated rule details" and its status line.
 */
export function generatedOutputs(result, id) {
  const spec = result?.canonical?.spec || null;
  const slo = spec?.slos?.find(s => s.sli === id) || null;
  // The policy carries one entry per SLO with its windows; the compiler emits one burn alert per window.
  const burns = slo ? (spec?.policy?.burn_rate_alerts || []).filter(a => a.slo === slo.id).reduce((n, a) => n + ((a.windows || []).length || 1), 0) : 0;
  const rule = spec?.queries?.recording_rules?.find(r => r.expr === `ref:slis.${id}`)?.name || null;
  return { slo: slo?.id || null, burns, rule };
}

/** The status line: what happened to the last edit, from the draft's flags and the last result. */
function editorStatus({ build, result, item, id, custom, readOnly, errors, compiled }) {
  const { slo, burns, rule } = generatedOutputs(result, id);
  const applied = () => `${slo ? `SLO ${slo}` : 'SLOs off'}${burns ? ` · ${burns} burn alert${burns === 1 ? '' : 's'}` : ''}${rule ? ` · rule ${rule}` : ''}`;
  if (readOnly) return { kind: 'readonly', text: compiled ? `as compiled · ${applied()}` : 'not in the pack' };
  if (!custom && !item.selected) return { kind: 'off', text: item.entrySelected ? 'not in the pack — tick Include in this pack below; your edits wait with it' : `not in the pack — adding it selects ${item.entryTitle} too` };
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
    } else if (field === 'good_when') {
      // absent means below (the one rule, spelled in sli-direction.mjs): the control always shows a side, and the library default is the row's
      value = goodWhen({ good_when: eff.good_when });
      def = custom ? null : goodWhen({ good_when: dflt?.good_when });
    } else value = display(field, eff[field]);
    const engineError = errors && hasOwn(errors, field) ? errors[field] : null;
    return {
      id: field, ...meta,
      ...(field === 'id' && custom ? { hint: 'your SLI’s id — the SLO, the recording rule and the boards follow a rename' } : {}),
      ...(field === 'semconv_metric' ? { placeholder: 'http.server.request.duration' } : {}),
      value, raw: field === 'id' ? id : (eff[field] ?? null),
      default: def, defaultLabel, overridden, resettable: overridden && !readOnly,
      focusKey: `${prefix}:${field}`, inputId: `build-editor-${field}`,
      // The engine's word on the field first (it is the authority), else the relationship check on what the field holds.
      engineError, error: engineError, readOnly,
      ...(field === 'window' ? { options: SLO_WINDOWS } : {}),
    };
  });
  // The relationships (direction, bound, unit, objective, window) checked on the values the editor shows — the same
  // check the view re-runs on every keystroke, so a problem is said beside its field before the engine answers.
  const valueOf = (fid) => fields.find(f => f.id === fid)?.value ?? null;
  const checks = readOnly ? {} : sliRelationshipChecks({ type: item.type, objective: valueOf('objective'), window: valueOf('window'), threshold: valueOf('threshold'), good_when: valueOf('good_when'), unit: valueOf('unit') });
  for (const f of fields) { f.check = checks[f.id] || null; if (!f.error && f.check) f.error = f.check; }
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
    // The sentence the dialog opens with, in real units (the view repaints it from the inputs as they are typed).
    summary: sliSummarySentence({ id, type: item.type, objective: valueOf('objective'), window: valueOf('window'), threshold: valueOf('threshold'), good_when: valueOf('good_when'), unit: valueOf('unit') }),
    checks, errorList: errorListOf(fields),
    outputs: { ...generatedOutputs(result, id), compiled: !!compiled },
    resetAll: !custom && !readOnly && customised.length > 0,
    switch: readOnly ? null : {
      on: !!item.selected, label, focusKey: `${item.focusKey}@editor`,
      data: { sli: key, entry: item.entry || '', 'sli-id': item.id, selected: item.selected ? '1' : '0', 'entry-selected': item.entrySelected ? '1' : '0', ...(custom ? { custom: '1' } : {}) },
    },
    // Inclusion is its own named control, apart from saving: a library SLI is ticked in or out of the pack (an excluded
    // SLI keeps its edits in the draft — say so); a custom SLI exists only in the pack, so its control removes it.
    inclusion: readOnly ? null : custom
      ? { kind: 'remove', label: 'Remove SLI', help: 'A custom SLI is always in the pack; removing it deletes it.' }
      : { kind: 'include', label: 'Include in this pack', on: !!item.selected,
        help: item.selected ? 'Untick to leave it out: your edits stay with the draft and return when you include it again.'
          : item.entrySelected ? 'Not in the pack. Save SLI keeps your edits with the draft; tick to include it.'
            : `Not in the pack. Ticking also selects ${item.entryTitle}; your edits are kept either way.` },
    allKeys: [...allKeys],
    doneLabel: readOnly ? 'Close' : 'Save SLI',
    saveHelp: readOnly ? null : 'Changes apply as you type; Save SLI checks them and closes the editor.',
    existingIds: existingSliIds({ build, library, except: [key, id] }),
  };
}

/** The fields that carry an error, in the editor's reading order: the linked summary at the top of the dialog (the GOV.UK pattern). */
function errorListOf(fields) {
  return fields.filter(f => f.error).map(f => ({ field: f.id, label: f.label, message: f.error, inputId: f.inputId }));
}

/** The editor in create mode: the same dialog over the custom form (customFormModel), 'Add to the pack' from its canSubmit. */
function createEditorModel({ build, library, result, errors }) {
  const form = customFormModel(build?.customDraft, { errors, existingKeys: existingSliIds({ build, library }), existingSloIds: (result?.canonical?.spec?.slos || []).map(s => s.id) });
  const d = form.draft;
  return {
    create: true, custom: true, readOnly: false, mode: 'create', key: null, id: d.id || null, type: d.type, renamed: false,
    title: { id: d.id || 'new SLI', product: 'Custom SLI', evidence: 'custom', sliEvidence: 'custom', type: d.type, chips: [{ kind: 'custom', text: 'custom', title: 'written in the studio — no library evidence' }] },
    typeHint: TYPE_HINT,
    fields: form.fields.map(f => ({ ...f, readOnly: false, default: null, defaultLabel: null, overridden: false, resettable: false })),
    customised: [], parameters: null,
    evidence: { status: 'custom', note: 'written in the studio — no library evidence' }, provenance: 'custom — written in the studio',
    promqlWarning: null, generalError: form.generalError,
    summary: form.summary, checks: form.checks, errorList: errorListOf(form.fields), outputs: null, inclusion: null, saveHelp: null,
    status: createFormStatus(form),
    resetAll: false, switch: null, allKeys: [], doneLabel: 'Cancel',
    submit: { label: form.addLabel, enabled: form.canSubmit, focusKey: form.focusKey },
    form,
    existingIds: form.existingKeys,
  };
}

// ---------- the create form ----------

/** The create form's status line, one rule for the model and the live repaint: ready, the values to fix, or the required fields left. */
export function createFormStatus(form) {
  if (form.canSubmit) return { kind: 'ready', text: 'ready — Add to the pack compiles once and keeps the SLI when the engine accepts it' };
  const n = Object.keys(form.checks || {}).length;
  const filled = form.required.every(k => String(form.draft[k] ?? '').trim() !== '') && !!form.draft.id;
  if (n && filled) return { kind: 'error', text: `${n === 1 ? 'one value needs' : `${n} values need`} attention — listed at the top` };
  return { kind: 'idle', text: `fill the required fields: ${form.required.join(', ')}${form.draft.id ? '' : ' — and a name'}` };
}

/** The create dialog's word on the two types (its Type select's hint and the fixed Type cell's in create mode). */
const TYPE_HINT = 'ratio: good over total events · threshold: a value against a bound — good when below (a ceiling) or above (a floor)';
const DRAFT_DEFAULTS = { name: '', id: '', idTouched: false, type: 'ratio', description: '', unit: '', semconv_metric: '', good: '', total: '', query: '', threshold: '', good_when: 'below', objective: '99.9', window: '30d' };
/** The form's draft with the defaults filled in, the id slugged from the name unless the user typed one, the direction one of the two (below by default). */
export function normalizeDraft(draft) {
  const d = { ...DRAFT_DEFAULTS, ...(draft || {}) };
  if (!SLI_TYPES.includes(d.type)) d.type = 'ratio';
  if (!GOOD_WHEN.includes(d.good_when)) d.good_when = 'below';
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
  // The relationships the editor checks as typed (sliRelationshipChecks): said beside the field, and the form cannot be added while one stands.
  const checks = sliRelationshipChecks({ type: d.type, objective: d.objective, window: d.window, threshold: d.threshold, good_when: d.good_when, unit: d.unit });
  const field = (id, label, kind, extra = {}) => ({ id, label, kind, value: String(d[id] ?? ''), focusKey: `cf:${id}`, inputId: `build-custom-${id}`, error: hasOwn(errs, id) ? errs[id] : (checks[id] || null), check: checks[id] || null, required: required.includes(id), ...extra });
  const fields = [
    field('name', 'Name', 'text', { placeholder: 'Checkout success', hint: d.id ? `id ${d.id}` : 'the id is slugged from the name' }),
    field('id', 'Id', 'slug', { placeholder: 'checkout_success', error: hasOwn(errs, 'id') ? errs.id : idClash || idBad || sloClash, hint: 'the SLI id the pack carries — edit it to keep your own' }),
    field('type', 'Type', 'select', { options: SLI_TYPES, hint: TYPE_HINT }),
    field('description', 'Description', 'text', { placeholder: 'what it measures' }),
    field('objective', 'Objective', 'percent', { hint: 'percent' }),
    field('window', 'Window', 'window', { options: SLO_WINDOWS }),
    ...(d.type === 'threshold' ? [
      field('threshold', 'Bound', 'number', { placeholder: '0.5', hint: 'the bound in the unit; good when below (a ceiling) or above (a floor)' }),
      field('good_when', 'Good when', 'direction', { options: GOOD_WHEN, hint: FIELD_META.good_when.hint }),
      field('unit', 'Unit', 'unit', { placeholder: 'seconds' }),
    ] : []),
    field('semconv_metric', 'Metric', 'text', { placeholder: 'http.server.request.duration', hint: 'optional — the semantic-conventions metric the SLI reads' }),
    ...(d.type === 'ratio'
      ? [field('good', 'Good events (PromQL)', 'promql', { placeholder: 'sum(rate(checkout_ok_total[5m]))' }), field('total', 'Total events (PromQL)', 'promql', { placeholder: 'sum(rate(checkout_total[5m]))' })]
      : [field('query', 'Query (PromQL)', 'promql', { placeholder: 'histogram_quantile(0.99, sum by (le)(rate(checkout_seconds_bucket[5m])))' })]),
  ];
  const filled = required.every(k => String(d[k] ?? '').trim() !== '') && !!d.id;
  return {
    draft: d, fields, idClash, sloClash, required, existingKeys: [...existingKeys], existingSloIds: [...existingSloIds],
    checks, summary: sliSummarySentence({ id: d.id, name: d.name, type: d.type, objective: d.objective, window: d.window, threshold: d.threshold, good_when: d.good_when, unit: d.unit }),
    canSubmit: filled && !idClash && !idBad && !sloClash && Object.keys(checks).length === 0,
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

/** The definition the engine takes from the form: the percent typed → the ratio, the bound → a number (the text as typed when it is not one), a floor's direction (below is the default and is not written), the empty fields left out. */
export function customDefFromDraft(draft) {
  const d = normalizeDraft(draft);
  const def = { id: d.id, type: d.type, objective: numberOrText('objective', d.objective), window: d.window };
  if (d.type === 'ratio') { def.good = d.good; def.total = d.total; } else { def.query = d.query; def.threshold = numberOrText('threshold', d.threshold); if (goodWhen(d) === 'above') def.good_when = 'above'; if (String(d.unit).trim()) def.unit = d.unit.trim(); }
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
  if (field === 'window' || field === 'id' || field === 'unit' || field === 'semconv_metric' || field === 'good_when') return t;
  return String(text);
}
