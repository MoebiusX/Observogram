// tools/lib/artefact-classify.mjs — which FAMILY an artefact belongs to, and
// where that family lives on the Discover board.
//
// One vocabulary for every consumer: tools/lib/artefact-model.mjs classify()
// (the diff's identity keys, the traceability graph's node kinds, the
// blast-radius weights) delegates here, and the studio binds this module at
// boot (studio/taxonomy.mjs → discover-board, card-html, drawer). Pure and
// browser-safe: imports nothing, reads no environment; the server mounts it
// at /lib/artefact-classify.mjs and a downstream vendors it verbatim (it is
// in the vendor manifest).
//
// The order of the rules (classifyArtefact):
//   1. `type`    — an explicit family name, or a foreign type name the
//                  taxonomy override maps (`PackSLI` → sli)   via 'type'
//   2. `defines` — the canonical symbol the adapter attaches  via 'defines'
//   3. override  — the taxonomy's id regexes, first match     via 'override'
//   4. ID_RULES  — the adapter's id prefixes                  via 'id'
//   else family 'unknown'                                     via 'none'
// `defines` is Observogram's own symbol and can never be re-homed by an
// operator regex: the override only has to beat the id heuristic, which
// is all a foreign pack (no `defines`) ever reaches.
//
// The taxonomy override (OBSERVOGRAM_TAXONOMY, served at GET /api/taxonomy):
//   { "version": 1,
//     "types": { "PackSLI": "sli",
//                "PrometheusRule": { "family": "alert_rule", "label": "Prometheus rule" } },
//     "ids":   [ { "pattern": "^svc-[a-z]+-slo-", "family": "slo", "flags": "i" } ] }
// Type names match exactly (case-sensitive). A pattern is anchored (^), at
// most 200 characters, flags '' or 'i', no quantified group (the classic
// ReDoS shape), and is matched against the first 256 characters of the
// id; compileTaxonomy also times each pattern against adversarial ids. The
// file is operator-trusted configuration, not user input.
//
// Schema version 2 (TAXONOMY_VERSION_LATEST) adds one optional section, a
// glossary — the definitions the studio shows beside a family label or a
// spec term (studio/glossary.mjs; GAP batch 2, B3.4):
//   { "version": 2, "types": …, "ids": …,
//     "glossary": [ { "term": "Service level indicator", "family": "sli",
//                     "aliases": ["SLI"], "definition": "…", "link": "https://…" } ] }
// An entry is `{ term, definition, family?, aliases?, link? }` within
// GLOSSARY_LIMITS; at most one entry per family, and no term or alias
// defined twice (case-insensitive). A glossary never changes a
// classification: classifyArtefact() reads `types` and `ids` only. A v1
// file stays valid and compiles to the frozen empty glossary; `glossary`
// under `version: 1` is an unknown key, so a downstream that keeps writing
// `version: TAXONOMY_VERSION` (still 1) keeps emitting files its deployed
// server accepts.

// ---------- the vocabulary ----------

// The kind vocabulary of tools/lib/artefact-model.mjs, verbatim.
export const FAMILIES = Object.freeze([
  'sli', 'slo', 'otel', 'backend',
  'pipeline_receiver', 'pipeline_processor',
  'pipeline_exporter_metrics', 'pipeline_exporter_logs', 'pipeline_exporter_traces',
  'storage_metrics', 'storage_logs', 'storage_traces',
  'scrape_job', 'metric',
  'profiling', 'network', 'policy_engine', 'mesh', 'collection',
  'recording_rule', 'derived_view', 'dashboard', 'panel',
  'burn_rate', 'forecast', 'alert_route', 'alert_rule', 'remediation',
  'baselines', 'chaos', 'synthetic', 'imports',
  'unknown',
]);

// Where each family lands on the board (studio/discover-board.mjs
// BOARD_LAYERS: layer → group), with the plain-words kind and role shown
// for an artefact that reaches the board by `type` or by an override (an
// adapted artefact keeps card-html's per-prefix wording).
const home = (layer, group, label, role) => Object.freeze({ layer, group, label, role });
export const FAMILY_HOME = Object.freeze({
  sli:                       home('L1',  'sli',     'Service level indicator',  'Measures how the service behaves.'),
  slo:                       home('L1',  'slo',     'Objective',                'Sets the target an indicator must meet over a window.'),
  otel:                      home('L2',  'otel',    'Instrumentation contract', 'Sets how the service emits traces, metrics and logs.'),
  pipeline_receiver:         home('L2',  'rcv',     'Pipeline receiver',        'Accepts signals into the collector.'),
  scrape_job:                home('L2',  'rcv',     'Scrape job',               'A collection job that pulls signals from the service.'),
  pipeline_processor:        home('L2',  'prc',     'Pipeline processor',       'Transforms signals on their way through the collector.'),
  pipeline_exporter_metrics: home('L2',  'exp',     'Pipeline exporter',        'Sends signals from the collector to a backend.'),
  pipeline_exporter_logs:    home('L2',  'exp',     'Pipeline exporter',        'Sends signals from the collector to a backend.'),
  pipeline_exporter_traces:  home('L2',  'exp',     'Pipeline exporter',        'Sends signals from the collector to a backend.'),
  backend:                   home('L2',  'exp',     'Telemetry backend',        'Stores and serves one kind of signal.'),
  storage_metrics:           home('L2',  'exp',     'Storage',                  'Keeps one kind of signal for a retention period.'),
  storage_logs:              home('L2',  'exp',     'Storage',                  'Keeps one kind of signal for a retention period.'),
  storage_traces:            home('L2',  'exp',     'Storage',                  'Keeps one kind of signal for a retention period.'),
  metric:                    home('L2',  'metrics', 'Metric',                   'A metric the service defines or the platform reports.'),
  profiling:                 home('L2X', 'prof',    'Profiling',                'Collects continuous profiles.'),
  network:                   home('L2X', 'net',     'Network telemetry',        'Observes network flows.'),
  policy_engine:             home('L2X', 'poe',     'Policy engine',            'Enforces telemetry policy.'),
  mesh:                      home('L2X', 'mesh',    'Service mesh telemetry',   'Emits telemetry from the service mesh.'),
  collection:                home('L2X', 'col',     'Collection',               'Collects an additional signal source.'),
  recording_rule:            home('L3',  'qry',     'Recording rule',           'Precomputes a query so dashboards and alerts read it cheaply.'),
  derived_view:              home('L3',  'view',    'Derived view',             'A named query other artefacts bind to.'),
  dashboard:                 home('L3',  'dash',    'Dashboard',                'Shows the signals to people.'),
  panel:                     home('L3',  'panel',   'Dashboard panel',          'One chart on a dashboard.'),
  burn_rate:                 home('L4',  'pol',     'Burn-rate alert',          'Warns when an objective burns its error budget too fast.'),
  forecast:                  home('L4',  'pol',     'Forecast',                 'Predicts when a budget or capacity runs out.'),
  alert_route:               home('L4',  'alr',     'Alert route',              'Sends alerts of one severity to the people who act on them.'),
  alert_rule:                home('L4',  'rule',    'Alert rule',               'An operational alert the engine evaluates: something is wrong now, not a budget burning.'),
  remediation:               home('L4',  'heal',    'Self-healing action',      'Runs a remediation when an alert fires.'),
  baselines:                 home('L5',  'base',    'Baselines',                'Records normal behaviour to compare against.'),
  chaos:                     home('L5',  'chaos',   'Chaos experiment',         'Breaks something on purpose to prove the alerts fire.'),
  synthetic:                 home('L5',  'syn',     'Synthetic check',          'Probes the service the way a user would.'),
  imports:                   home('GOV', 'imp',     'Import',                   'Reuses a shared definition from another pack.'),
});

// The canonical `defines` symbol the adapter attaches, by prefix.
export const DEFINES_RULES = Object.freeze([
  ['slis.',                  'sli'],
  ['slos.',                  'slo'],
  ['telemetry.backends.',    'backend'],
  ['queries.derived_views.', 'derived_view'],
  ['dashboards.',            'dashboard'],
]);

// The adapter's id families (tools/lib/adapter.mjs id templates), by prefix,
// the longer prefix first where one contains another (METRIC-SRC- before
// METRIC-, SCRAPE-SRC- before SCRAPE-). Every rule is a prefix: the ids the
// adapter numbers once (OTEL-01, PIP-EXP-MET, STO-MET-01, PROF-01, NET-01,
// POE-01, BASE-01) are matched by their family prefix, so a second id in
// such a family (BASE-02, STO-MET-02) classifies like the first; a PIP-EXP-
// or STO- id whose signal segment is none of MET/LOG/TRC has no family.
export const ID_RULES = Object.freeze([
  ['SLI-',         'sli'],
  ['SLO-',         'slo'],
  ['OTEL-',        'otel'],
  ['BAK-',         'backend'],
  ['PIP-RCV-',     'pipeline_receiver'],
  ['PIP-PRC-',     'pipeline_processor'],
  ['PIP-EXP-MET',  'pipeline_exporter_metrics'],
  ['PIP-EXP-LOG',  'pipeline_exporter_logs'],
  ['PIP-EXP-TRC',  'pipeline_exporter_traces'],
  ['STO-MET-',     'storage_metrics'],
  ['STO-LOG-',     'storage_logs'],
  ['STO-TRC-',     'storage_traces'],
  ['SCRAPE-SRC-',  'scrape_job'],
  ['SCRAPE-',      'scrape_job'],
  ['METRIC-SRC-',  'metric'],
  ['METRIC-',      'metric'],
  ['PROF-',        'profiling'],
  ['NET-',         'network'],
  ['POE-',         'policy_engine'],
  ['MESH-',        'mesh'],
  ['COL-',         'collection'],
  ['QRY-',         'recording_rule'],
  ['VIEW-',        'derived_view'],
  ['DASH-',        'dashboard'],
  ['PANEL-',       'panel'],
  ['POL-',         'burn_rate'],
  ['FCST-',        'forecast'],
  ['ALR-',         'alert_route'],
  ['RULE-',        'alert_rule'],
  ['HEAL-',        'remediation'],
  ['BASE-',        'baselines'],
  ['CHAOS-',       'chaos'],
  ['SYN-',         'synthetic'],
  ['IMP-',         'imports'],
].map(r => Object.freeze(r)));

// ---------- the override: compile and validate ----------

export const TAXONOMY_VERSION = 1;
// The versions compileTaxonomy accepts, and the latest one (the glossary
// needs `version: 2`). TAXONOMY_VERSION keeps the value 1 on purpose: see
// the header.
export const TAXONOMY_VERSIONS = Object.freeze([1, 2]);
export const TAXONOMY_VERSION_LATEST = 2;
export const PATTERN_MAX_LENGTH = 200;
// The glossary's bounds (schema v2): characters per field, entries per file.
export const GLOSSARY_LIMITS = Object.freeze({ term: 80, definition: 600, alias: 80, link: 2000, entries: 500 });
export const ID_MATCH_LENGTH = 256;
// A quantified group — `(…)+`, `(…)*`, `(…){n,}` — is the shape every
// catastrophic pattern takes; refused outright rather than analysed.
const QUANTIFIED_GROUP = /\)[+*{]/;
// The ids each pattern must finish against within the budget.
const ADVERSARIAL_IDS = Object.freeze([
  'a'.repeat(ID_MATCH_LENGTH),
  'ab'.repeat(ID_MATCH_LENGTH / 2),
  '-'.repeat(ID_MATCH_LENGTH),
  `${'x'.repeat(ID_MATCH_LENGTH - 1)}!`,
]);
const PATTERN_BUDGET_MS = 50;

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isFamily = (f) => typeof f === 'string' && f !== 'unknown' && FAMILIES.includes(f);
// One line of text within [1, max] characters: not blank, no control
// character (U+0000–U+001F, U+007F: a line break, a tab, an escape).
const hasControl = (s) => { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 32 || c === 127) return true; } return false; };
const isLine = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !hasControl(v);
// The key a term or alias is matched by: trimmed, inner whitespace collapsed, lower-cased.
const textKey = (text) => String(text).trim().replace(/\s+/g, ' ').toLowerCase();
const EMPTY = Object.freeze([]);
const EMPTY_GLOSSARY = Object.freeze({ entries: EMPTY, byFamily: new Map(), byText: new Map() });

// One entry — a family string or { family, label?, role? } — to { family, label?, role? }.
function readTarget(value, where, errors) {
  const target = typeof value === 'string' ? { family: value } : value;
  if (!isPlainObject(target)) { errors.push(`taxonomy: ${where}: expected a family name or { family, label?, role? }`); return null; }
  if (!isFamily(target.family)) { errors.push(`taxonomy: ${where}: unknown family ${JSON.stringify(target.family)}`); return null; }
  const out = { family: target.family };
  for (const k of ['label', 'role']) {
    if (target[k] === undefined) continue;
    if (typeof target[k] !== 'string' || !target[k].trim()) { errors.push(`taxonomy: ${where}: ${k} must be a non-empty string`); return null; }
    out[k] = target[k];
  }
  return out;
}

/**
 * The taxonomy's pattern rule as one function, for any file that carries a
 * user-written regex: a non-empty string of at most PATTERN_MAX_LENGTH
 * characters, anchored with `^`, flags `""` or `"i"`, no quantified group,
 * and — unless `timed` is false — finishing the four adversarial
 * ID_MATCH_LENGTH-character ids within the 50 ms budget. `noun` names the
 * pattern in each reason (`pattern` for the taxonomy, so its texts are the
 * ones it always had). `timed: false` skips only the wall-clock run (a
 * browser re-reading a file the server already timed); every static check
 * still runs. A caller matching longer or differently shaped values adds
 * its own bounds on top.
 * @returns {{ re: RegExp } | { reason: string }}
 */
export function compileBoundedPattern(pattern, { flags = '', noun = 'pattern', timed = true } = {}) {
  if (typeof pattern !== 'string' || !pattern) return { reason: `${noun} must be a non-empty string` };
  if (pattern.length > PATTERN_MAX_LENGTH) return { reason: `${noun} longer than ${PATTERN_MAX_LENGTH} characters` };
  if (!pattern.startsWith('^')) return { reason: `${noun} must be anchored (start with ^)` };
  if (flags !== '' && flags !== 'i') return { reason: 'flags must be "" or "i"' };
  if (QUANTIFIED_GROUP.test(pattern)) return { reason: 'nested quantifier' };
  let re;
  try { re = new RegExp(pattern, flags); } catch (e) { return { reason: `invalid regex: ${e.message}` }; }
  if (timed) {
    const t0 = Date.now();
    for (const id of ADVERSARIAL_IDS) re.test(id);
    if (Date.now() - t0 > PATTERN_BUDGET_MS) return { reason: `${noun} too slow against a ${ID_MATCH_LENGTH}-character id` };
  }
  return { re };
}

function compileRule(rule, i, errors) {
  const where = `ids[${i}]`;
  if (!isPlainObject(rule)) { errors.push(`taxonomy: ${where}: expected { pattern, family, flags?, label?, role? }`); return null; }
  const { pattern, flags = '' } = rule;
  const compiled = compileBoundedPattern(pattern, { flags });
  if (compiled.reason) { errors.push(`taxonomy: ${where}: ${compiled.reason}`); return null; }
  const { re } = compiled;
  const target = readTarget({ family: rule.family, label: rule.label, role: rule.role }, where, errors);
  if (!target) return null;
  return Object.freeze({ re, pattern, flags, ...target });
}

// One glossary entry → { term, definition, family, aliases, link } (frozen), or null with the reasons pushed.
const GLOSSARY_KEYS = ['term', 'definition', 'family', 'aliases', 'link'];
function compileGlossaryEntry(raw, i, errors) {
  const where = `glossary[${i}]`;
  if (!isPlainObject(raw)) { errors.push(`taxonomy: ${where}: expected { term, definition, family?, aliases?, link? }`); return null; }
  for (const k of Object.keys(raw)) if (!GLOSSARY_KEYS.includes(k)) { errors.push(`taxonomy: ${where}: unknown key ${JSON.stringify(k)}`); return null; }
  if (!isLine(raw.term, GLOSSARY_LIMITS.term)) { errors.push(`taxonomy: ${where}: term must be one line of 1–${GLOSSARY_LIMITS.term} characters`); return null; }
  if (!isLine(raw.definition, GLOSSARY_LIMITS.definition)) { errors.push(`taxonomy: ${where}: definition must be one line of 1–${GLOSSARY_LIMITS.definition} characters`); return null; }
  let family = null;
  if (raw.family !== undefined) {
    if (!isFamily(raw.family)) { errors.push(`taxonomy: ${where}: unknown family ${JSON.stringify(raw.family)}`); return null; }
    family = raw.family;
  }
  let aliases = EMPTY;
  if (raw.aliases !== undefined) {
    if (!Array.isArray(raw.aliases) || !raw.aliases.every(a => isLine(a, GLOSSARY_LIMITS.alias))) {
      errors.push(`taxonomy: ${where}: aliases must be an array of one-line strings of 1–${GLOSSARY_LIMITS.alias} characters`);
      return null;
    }
    aliases = Object.freeze(raw.aliases.map(a => a.trim()));
  }
  let link = null;
  if (raw.link !== undefined) {
    if (!isLine(raw.link, GLOSSARY_LIMITS.link) || !/^https?:\/\/\S+$/i.test(raw.link.trim())) { errors.push(`taxonomy: ${where}: link must be an http(s) URL of at most ${GLOSSARY_LIMITS.link} characters`); return null; }
    // `https://user:secret@host/…` — the link is served to every viewer (GET /api/taxonomy).
    if (/^https?:\/\/[^/?#]*@/i.test(raw.link.trim())) { errors.push(`taxonomy: ${where}: link must not carry credentials`); return null; }
    link = raw.link.trim();
  }
  return Object.freeze({ term: raw.term.trim(), definition: raw.definition.trim(), family, aliases, link });
}

// The glossary section → { entries, byFamily, byText } (frozen), or null with the reasons pushed.
function compileGlossary(raw, errors) {
  if (!Array.isArray(raw)) { errors.push('taxonomy: glossary must be an array'); return null; }
  if (raw.length > GLOSSARY_LIMITS.entries) { errors.push(`taxonomy: glossary: more than ${GLOSSARY_LIMITS.entries} entries`); return null; }
  const entries = [];
  const byFamily = new Map();
  const byText = new Map();
  const owner = new Map();   // text key / family → the index that defined it
  let ok = true;
  raw.forEach((item, i) => {
    const e = compileGlossaryEntry(item, i, errors);
    if (!e) { ok = false; return; }
    if (e.family !== null) {
      if (byFamily.has(e.family)) { errors.push(`taxonomy: glossary[${i}]: family ${JSON.stringify(e.family)} is already defined by glossary[${owner.get(`family:${e.family}`)}]`); ok = false; return; }
    }
    const seen = new Set();   // an alias repeating the term (or another alias) of the same entry
    for (const text of [e.term, ...e.aliases]) {
      const k = textKey(text);
      if (byText.has(k) || seen.has(k)) { errors.push(`taxonomy: glossary[${i}]: ${JSON.stringify(text)} is already defined by glossary[${owner.get(`text:${k}`) ?? i}]`); ok = false; return; }
      seen.add(k);
    }
    entries.push(e);
    if (e.family !== null) { byFamily.set(e.family, e); owner.set(`family:${e.family}`, i); }
    for (const text of [e.term, ...e.aliases]) { const k = textKey(text); byText.set(k, e); owner.set(`text:${k}`, i); }
  });
  if (!ok) return null;
  return Object.freeze({ entries: Object.freeze(entries), byFamily, byText });
}

// { compiled: { types: Map<name, {family,label?,role?}>, ids: [{ re, pattern, flags, family, label?, role? }], glossary: { entries, byFamily, byText } } | null, errors: string[] }
function compileAll(json) {
  const errors = [];
  if (!isPlainObject(json)) return { compiled: null, errors: ['taxonomy: must be an object'] };
  if (!TAXONOMY_VERSIONS.includes(json.version)) errors.push(`taxonomy: version must be ${TAXONOMY_VERSIONS.join(' or ')}`);
  const allowed = json.version === 2 ? ['version', 'types', 'ids', 'glossary'] : ['version', 'types', 'ids'];
  for (const k of Object.keys(json)) if (!allowed.includes(k)) errors.push(`taxonomy: unknown key ${JSON.stringify(k)}`);
  const types = new Map();
  if (json.types !== undefined) {
    if (!isPlainObject(json.types)) errors.push('taxonomy: types must be an object of type name → family');
    else {
      for (const [name, value] of Object.entries(json.types)) {
        if (!name.trim()) { errors.push('taxonomy: types: a type name must not be empty'); continue; }
        const target = readTarget(value, `types.${name}`, errors);
        if (target) types.set(name, Object.freeze(target));
      }
    }
  }
  const ids = [];
  if (json.ids !== undefined) {
    if (!Array.isArray(json.ids)) errors.push('taxonomy: ids must be an array');
    else json.ids.forEach((rule, i) => { const c = compileRule(rule, i, errors); if (c) ids.push(c); });
  }
  let glossary = EMPTY_GLOSSARY;
  if (json.version === 2 && json.glossary !== undefined) glossary = compileGlossary(json.glossary, errors) || EMPTY_GLOSSARY;
  if (errors.length) return { compiled: null, errors };
  return { compiled: Object.freeze({ types, ids: Object.freeze(ids), glossary }), errors };
}

/** The compiled override, or an Error whose message starts `taxonomy: ` (the first reason). */
export function compileTaxonomy(json) {
  const { compiled, errors } = compileAll(json);
  if (errors.length) throw new Error(errors[0]);
  return compiled;
}

/** Every reason the override is refused ([] when it compiles). Never throws. */
export function validateTaxonomy(json) {
  return compileAll(json).errors;
}

/** `N types, M id rules[, G glossary terms]` — for the one log line an entrypoint prints (the glossary only when it has entries). */
export function describeTaxonomy(compiled) {
  if (!compiled) return 'no override';
  const n = compiled.types.size;
  const m = compiled.ids.length;
  const g = compiled.glossary?.entries.length ?? 0;
  return `${n} type${n === 1 ? '' : 's'}, ${m} id rule${m === 1 ? '' : 's'}${g ? `, ${g} glossary term${g === 1 ? '' : 's'}` : ''}`;
}

// ---------- the active override (module state, default none) ----------

let active = null;

const isCompiled = (t) => isPlainObject(t) && t.types instanceof Map && Array.isArray(t.ids);

/** Install a compiled override process-wide (null restores the defaults). */
export function configureTaxonomy(compiled) {
  if (compiled !== null && compiled !== undefined && !isCompiled(compiled)) {
    throw new Error('taxonomy: configureTaxonomy expects compileTaxonomy() output or null');
  }
  active = compiled ?? null;
  return active;
}

export function activeTaxonomy() { return active; }

// ---------- the glossary (schema v2) ----------
// Every accessor guards `taxonomy?.glossary?.…`: a compiled object from an
// older build (no `glossary` key) installs through isCompiled unchanged and
// reads as the empty glossary.

/** The glossary entry for a family (`sli`, `alert_rule` …), or null. */
export function glossaryFor(family, taxonomy = active) {
  if (typeof family !== 'string' || !family) return null;
  return taxonomy?.glossary?.byFamily?.get(family) ?? null;
}

/** The entry whose term or alias is `text` (trimmed, whitespace collapsed, case-insensitive), or null. */
export function glossaryByText(text, taxonomy = active) {
  if (typeof text !== 'string' || !text.trim()) return null;
  return taxonomy?.glossary?.byText?.get(textKey(text)) ?? null;
}

/** Every entry, in file order (the frozen empty array when there is no glossary). */
export function glossaryEntries(taxonomy = active) {
  return taxonomy?.glossary?.entries ?? EMPTY;
}

// ---------- the classification ----------

const UNKNOWN = Object.freeze({ family: 'unknown', layer: null, group: 'other', label: null, role: null });

function placed(family, via, override) {
  const h = FAMILY_HOME[family];
  return {
    family,
    via,
    layer: h.layer,
    group: h.group,
    label: override?.label ?? h.label,
    role: override?.role ?? h.role,
  };
}

/**
 * { family, via, layer, group, label, role } for an artefact. `via` names
 * the rule that decided: 'type' | 'defines' | 'override' | 'id' | 'none'.
 */
export function classifyArtefact(a, taxonomy = active) {
  if (!a || typeof a !== 'object') return { ...UNKNOWN, via: 'none' };
  if (typeof a.type === 'string') {
    const mapped = taxonomy?.types.get(a.type);
    if (mapped) return placed(mapped.family, 'type', mapped);
    if (isFamily(a.type)) return placed(a.type, 'type', null);
  }
  const defines = typeof a.defines === 'string' ? a.defines : '';
  if (defines) {
    for (const [prefix, family] of DEFINES_RULES) if (defines.startsWith(prefix)) return placed(family, 'defines', null);
  }
  const id = String(a.id ?? '');
  if (taxonomy?.ids.length) {
    const probe = id.slice(0, ID_MATCH_LENGTH);
    for (const rule of taxonomy.ids) if (rule.re.test(probe)) return placed(rule.family, 'override', rule);
  }
  for (const [prefix, family] of ID_RULES) if (id.startsWith(prefix)) return placed(family, 'id', null);
  return { ...UNKNOWN, via: 'none' };
}

/** The family alone — what artefact-model.classify() returns. */
export function familyOf(a, taxonomy = active) {
  return classifyArtefact(a, taxonomy).family;
}
