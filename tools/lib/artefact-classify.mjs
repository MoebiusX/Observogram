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
export const PATTERN_MAX_LENGTH = 200;
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

function compileRule(rule, i, errors) {
  const where = `ids[${i}]`;
  if (!isPlainObject(rule)) { errors.push(`taxonomy: ${where}: expected { pattern, family, flags?, label?, role? }`); return null; }
  const { pattern, flags = '' } = rule;
  if (typeof pattern !== 'string' || !pattern) { errors.push(`taxonomy: ${where}: pattern must be a non-empty string`); return null; }
  if (pattern.length > PATTERN_MAX_LENGTH) { errors.push(`taxonomy: ${where}: pattern longer than ${PATTERN_MAX_LENGTH} characters`); return null; }
  if (!pattern.startsWith('^')) { errors.push(`taxonomy: ${where}: pattern must be anchored (start with ^)`); return null; }
  if (flags !== '' && flags !== 'i') { errors.push(`taxonomy: ${where}: flags must be "" or "i"`); return null; }
  if (QUANTIFIED_GROUP.test(pattern)) { errors.push(`taxonomy: ${where}: nested quantifier`); return null; }
  let re;
  try { re = new RegExp(pattern, flags); } catch (e) { errors.push(`taxonomy: ${where}: invalid regex: ${e.message}`); return null; }
  const t0 = Date.now();
  for (const id of ADVERSARIAL_IDS) re.test(id);
  if (Date.now() - t0 > PATTERN_BUDGET_MS) { errors.push(`taxonomy: ${where}: pattern too slow against a ${ID_MATCH_LENGTH}-character id`); return null; }
  const target = readTarget({ family: rule.family, label: rule.label, role: rule.role }, where, errors);
  if (!target) return null;
  return Object.freeze({ re, pattern, flags, ...target });
}

// { compiled: { types: Map<name, {family,label?,role?}>, ids: [{ re, pattern, flags, family, label?, role? }] } | null, errors: string[] }
function compileAll(json) {
  const errors = [];
  if (!isPlainObject(json)) return { compiled: null, errors: ['taxonomy: must be an object'] };
  if (json.version !== TAXONOMY_VERSION) errors.push(`taxonomy: version must be ${TAXONOMY_VERSION}`);
  for (const k of Object.keys(json)) if (!['version', 'types', 'ids'].includes(k)) errors.push(`taxonomy: unknown key ${JSON.stringify(k)}`);
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
  if (errors.length) return { compiled: null, errors };
  return { compiled: Object.freeze({ types, ids: Object.freeze(ids) }), errors };
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

/** `N types, M id rules` — for the one log line an entrypoint prints. */
export function describeTaxonomy(compiled) {
  if (!compiled) return 'no override';
  const n = compiled.types.size;
  const m = compiled.ids.length;
  return `${n} type${n === 1 ? '' : 's'}, ${m} id rule${m === 1 ? '' : 's'}`;
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
