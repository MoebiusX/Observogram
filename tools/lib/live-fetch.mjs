// tools/lib/live-fetch.mjs — the live fetch's contract: its stages, the plan a
// ping's inventory implies, the snapshot scope and the pack annotations that
// record it.
//
// Read by the fetcher (tools/fetch-live-pack.mjs: the stages it reports, the
// scope it applies), the live jobs (the stage rows of a gate log), the diff
// (tools/lib/diff.mjs: `scopeOf`, `inScope`, `scopeReason` — an artefact the
// snapshot's scope left out is "not checked", never "missing") and the studio
// (`/lib/live-fetch.mjs`: the plan before a fetch, the gate log during it).
//
// The stage ids are a downstream contract (docs/DOWNSTREAM.md §15.2): a
// downstream maps its own progress names onto them, so an id never changes
// meaning; a new stage is a new id.
//
// Browser-safe by construction: pure functions, no import, no `process.env`.
// A stage names the CAPABILITY ids it reads (tools/lib/contracts/
// mcp-capabilities.mjs), never a tool name; tools/test-contract-guard.mjs and
// tools/test-live-snapshot.mjs pin both.

// The stages, in the order a fetch runs them. `capabilities` are the
// capability ids whose advertised candidates make the stage runnable; a stage
// with none (connect, signals, build, register) always runs. `kinds` says
// which fetch has the stage: a snapshot does not read the stack signals (they
// feed the badge and annotations, not inventory).
export const LIVE_STAGES = Object.freeze([
  { id: 'connect',         label: 'Connect (initialize, tools/list)', capabilities: [], kinds: ['snapshot', 'draft'] },
  { id: 'services',        label: 'Services (health, topology)',      capabilities: ['system_health', 'system_topology', 'anomalies_active', 'anomalies_baselines'], kinds: ['snapshot', 'draft'] },
  { id: 'backends',        label: 'Backends and versions',            capabilities: ['backend_capabilities', 'grafana_version', 'build_info_versions', 'traces_alive'], kinds: ['snapshot', 'draft'] },
  { id: 'metric_names',    label: 'Metric names',                     capabilities: ['metric_names'], kinds: ['snapshot', 'draft'] },
  { id: 'recording_rules', label: 'Recording rules',                  capabilities: ['recording_rules'], kinds: ['snapshot', 'draft'] },
  { id: 'alert_rules',     label: 'Alert rules',                      capabilities: ['alert_rules'], kinds: ['snapshot', 'draft'] },
  { id: 'dashboards',      label: 'Dashboards',                       capabilities: ['dashboards', 'dashboard_detail'], kinds: ['snapshot', 'draft'] },
  { id: 'scrape_targets',  label: 'Scrape targets',                   capabilities: ['scrape_configs'], kinds: ['snapshot', 'draft'] },
  { id: 'alerting_routes', label: 'Alerting routes',                  capabilities: ['alerting_routes'], kinds: ['snapshot', 'draft'] },
  { id: 'signals',         label: 'Stack signals (self-metrics, Alertmanager, Grafana, rule evidence)', capabilities: [], kinds: ['draft'] },
  { id: 'build',           label: 'Build and validate the pack',      capabilities: [], kinds: ['snapshot', 'draft'] },
  { id: 'register',        label: 'Register the pack',                capabilities: [], kinds: ['snapshot', 'draft'] },
].map((stage) => Object.freeze({ ...stage, capabilities: Object.freeze([...stage.capabilities]), kinds: Object.freeze([...stage.kinds]) })));

export const LIVE_KINDS = Object.freeze(['snapshot', 'draft']);
export const STAGE_STATES = Object.freeze(['pending', 'running', 'done', 'failed', 'skipped']);

export const SCOPE_LIMITS = Object.freeze({ prefixes: 32, prefixLength: 100, folders: 32, uidLength: 40 });
export const SNAPSHOT_LIMITS = Object.freeze({ metricNames: 20_000, packBytes: 16 * 1024 * 1024, messageChars: 300 });

// The rows of one kind of fetch, in order.
export function stagesFor(kind) {
  if (!LIVE_KINDS.includes(kind)) throw new TypeError(`unknown live fetch kind ${JSON.stringify(kind)} (snapshot or draft)`);
  return LIVE_STAGES.filter((stage) => stage.kinds.includes(kind));
}

// A stage's name inside a sentence: the label, lower case, without its
// parenthesis ("Services (health, topology)" → "services").
export function stageNoun(stage) {
  return String(stage.label).replace(/\s*\(.*\)\s*$/, '').toLowerCase();
}

// What a fetch of `kind` will do, from an MCP's mapped inventory
// (capabilityInventory(names).capabilities: { <capabilityId>: [advertised
// names] }). `complete` is false when tools/list was not read whole (a cursor
// was left): an absent capability is then `unknown`, never a claimed gap. A
// null inventory (no tools/list at all) makes every reading stage unknown.
export function fetchPlan(capabilities, { kind, complete = true } = {}) {
  const inventory = capabilities && typeof capabilities === 'object' ? capabilities : null;
  const whole = inventory !== null && complete !== false;
  return stagesFor(kind).map((stage) => {
    if (stage.capabilities.length === 0) return { stage: stage.id, will: 'run', reason: null };
    const offered = inventory !== null && stage.capabilities.some((id) => Array.isArray(inventory[id]) && inventory[id].length > 0);
    if (offered) return { stage: stage.id, will: 'run', reason: null };
    const noun = stageNoun(stage);
    const a = /^[aeiou]/.test(noun) ? 'an' : 'a';
    if (whole) return { stage: stage.id, will: 'gap', reason: `this MCP offers no ${noun} tool` };
    return {
      stage: stage.id,
      will: 'unknown',
      reason: inventory === null
        ? `tools/list was not read, so whether this MCP offers ${a} ${noun} tool is not known`
        : `tools/list did not list every tool (a page was left), so whether this MCP offers ${a} ${noun} tool is not known`,
    };
  });
}

// ---------------------------------------------------------------------------
// The snapshot scope
// ---------------------------------------------------------------------------

const PREFIX_RE = /^[A-Za-z_:][A-Za-z0-9_:]*$/;
const UID_RE = /^[A-Za-z0-9_-]+$/;
const SCOPE_FIELDS = Object.freeze(['metricPrefixes', 'folderUids', 'datasourceUid']);
// A refused value is quoted, cut so a pasted blob never fills the sentence.
const quoted = (value) => {
  const s = String(value);
  return JSON.stringify(s.length > 60 ? `${s.slice(0, 60)}…` : s);
};
const listOf = (value) => (typeof value === 'string' ? value.split(',') : value);

function normalizeList(raw, field, { limit, check }, errors) {
  if (raw === undefined || raw === null || raw === '') return [];
  const list = listOf(raw);
  if (!Array.isArray(list)) { errors.push(`scope.${field} is not a list`); return []; }
  const out = [];
  list.forEach((item, i) => {
    if (typeof item !== 'string') { errors.push(`scope.${field}[${i}] is not a string`); return; }
    const value = item.trim();
    if (value === '' && typeof raw === 'string') return;   // "a,,b" or a trailing comma in a variable
    const problem = check(value);
    if (problem) { errors.push(`scope.${field}[${i}] ${quoted(value)} ${problem}`); return; }
    if (!out.includes(value)) out.push(value);
  });
  if (out.length > limit) errors.push(`scope.${field} has ${out.length} entries; at most ${limit}`);
  return out.slice(0, limit);
}

const checkPrefix = (value) => {
  if (value.length > SCOPE_LIMITS.prefixLength) return `is longer than ${SCOPE_LIMITS.prefixLength} characters`;
  return PREFIX_RE.test(value) ? null : 'is not a metric-name prefix (letters, digits, _ and :, not starting with a digit)';
};
const checkUid = (what) => (value) => (value.length <= SCOPE_LIMITS.uidLength && UID_RE.test(value)
  ? null
  : `is not a ${what} uid (1–${SCOPE_LIMITS.uidLength} letters, digits, _ and -)`);

// A scope from a request body or the configuration → { scope, errors }. The
// list fields take an array or a comma list (the configuration's form); the
// values are trimmed and deduplicated in order. `errors` holds one sentence
// per refused field or value, naming it and the rule; the scope keeps only the
// values that passed, and a caller refuses the whole scope when `errors` is
// not empty.
export function normalizeScope(input) {
  const errors = [];
  const scope = { metricPrefixes: [], folderUids: [], datasourceUid: null };
  if (input === undefined || input === null) return { scope, errors };
  if (typeof input !== 'object' || Array.isArray(input)) return { scope, errors: ['scope is not an object (metricPrefixes, folderUids, datasourceUid)'] };
  for (const key of Object.keys(input)) {
    if (!SCOPE_FIELDS.includes(key)) errors.push(`scope.${key} is not a scope field (${SCOPE_FIELDS.join(', ')})`);
  }
  scope.metricPrefixes = normalizeList(input.metricPrefixes, 'metricPrefixes', { limit: SCOPE_LIMITS.prefixes, check: checkPrefix }, errors);
  scope.folderUids = normalizeList(input.folderUids, 'folderUids', { limit: SCOPE_LIMITS.folders, check: checkUid('folder') }, errors);
  const ds = input.datasourceUid;
  if (ds !== undefined && ds !== null && ds !== '') {
    if (typeof ds !== 'string') errors.push('scope.datasourceUid is not a string');
    else {
      const value = ds.trim();
      const problem = checkUid('datasource')(value);
      if (problem) errors.push(`scope.datasourceUid ${quoted(value)} ${problem}`);
      else scope.datasourceUid = value;
    }
  }
  return { scope, errors };
}

export function scopeIsEmpty(scope) {
  return !scope || ((scope.metricPrefixes || []).length === 0 && (scope.folderUids || []).length === 0 && !scope.datasourceUid);
}

// The families each scope field may apply to. Metric prefixes narrow the
// metric family; folder uids the dashboards, and the rule families only when
// every rule the answers carry names its folder (the fetcher decides and
// says so in `learned.applied`).
export const SCOPE_FAMILIES = Object.freeze({
  metricPrefixes: Object.freeze(['metric']),
  folderUids: Object.freeze(['dashboard', 'alert_rule', 'recording_rule']),
});

export const LIVE_SCOPE_ANNOTATION = 'observogram.live.scope';
export const SCOPE_ANNOTATION_PREFIX = 'observogram.scope.';
const FOLDER_TITLE_CHARS = 100;

// The annotations a snapshot records for its scope. `learned` is what the
// fetch found out: `applied` — the families the scope was actually applied
// to (default: the metric family when prefixes are set, dashboards when
// folders are) — and `folderTitles` ({ <uid>: <title> }, from the dashboard
// search answers). `observogram.live.scope` is always written (an unscoped
// snapshot says so); a family's `observogram.scope.<kind>` only when the
// scope was applied to it, so the diff parks nothing the fetch did not narrow.
export function scopeAnnotations(scope, learned = {}) {
  const s = scope || {};
  const prefixes = [...(s.metricPrefixes || [])];
  const folders = [...(s.folderUids || [])];
  const defaults = [...(prefixes.length ? ['metric'] : []), ...(folders.length ? ['dashboard'] : [])];
  const applied = new Set(Array.isArray(learned.applied) ? learned.applied : defaults);
  const titles = learned.folderTitles && typeof learned.folderTitles === 'object' ? learned.folderTitles : {};
  const appliesTo = {
    metricPrefixes: prefixes.length ? SCOPE_FAMILIES.metricPrefixes.filter((k) => applied.has(k)) : [],
    folderUids: folders.length ? SCOPE_FAMILIES.folderUids.filter((k) => applied.has(k)) : [],
  };
  const out = {
    [LIVE_SCOPE_ANNOTATION]: JSON.stringify({ metricPrefixes: prefixes, folderUids: folders, datasourceUid: s.datasourceUid || null, appliesTo }),
  };
  for (const kind of appliesTo.metricPrefixes) out[`${SCOPE_ANNOTATION_PREFIX}${kind}`] = JSON.stringify({ by: 'prefix', values: prefixes });
  const folderValues = folders.map((uid) => {
    const title = typeof titles[uid] === 'string' && titles[uid] !== '' ? titles[uid].slice(0, FOLDER_TITLE_CHARS) : null;
    return { uid, title };
  });
  for (const kind of appliesTo.folderUids) out[`${SCOPE_ANNOTATION_PREFIX}${kind}`] = JSON.stringify({ by: 'folder', values: folderValues });
  return out;
}

// A pack's scope, read back from its annotations (an adapted pack carries
// them on meta.annotations, a canonical on metadata.annotations): kind →
// { by: 'prefix', values: [prefix] } | { by: 'folder', values: [{ uid, title }] }.
// A value that does not parse, or has no value, is ignored — the family is
// then compared as if unscoped, never parked on a guess.
export function scopeOf(annotations) {
  const out = new Map();
  if (!annotations || typeof annotations !== 'object') return out;
  for (const [key, raw] of Object.entries(annotations)) {
    if (!key.startsWith(SCOPE_ANNOTATION_PREFIX) || key.length === SCOPE_ANNOTATION_PREFIX.length) continue;
    let parsed;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.values)) continue;
    if (parsed.by === 'prefix') {
      const values = parsed.values.filter((v) => typeof v === 'string' && v !== '');
      if (values.length) out.set(key.slice(SCOPE_ANNOTATION_PREFIX.length), { by: 'prefix', values });
    } else if (parsed.by === 'folder') {
      const values = parsed.values
        .map((v) => (typeof v === 'string' ? { uid: v, title: null } : v))
        .filter((v) => v && typeof v.uid === 'string' && v.uid !== '')
        .map((v) => ({ uid: v.uid, title: typeof v.title === 'string' && v.title !== '' ? v.title : null }));
      if (values.length) out.set(key.slice(SCOPE_ANNOTATION_PREFIX.length), { by: 'folder', values });
    }
  }
  return out;
}

// The metric names an adapted metric artefact stands for: its name and, for a
// folded family, the series it carries (tools/lib/artefact-model.mjs).
function metricNamesOf(artefact) {
  const names = [];
  const name = artefact?.spec?.name ?? artefact?.title;
  if (typeof name === 'string' && name !== '') names.push(name);
  for (const s of Array.isArray(artefact?.series) ? artefact.series : []) if (typeof s === 'string' && s !== '') names.push(s);
  return names;
}

// The folder uid an artefact states, or null. A dashboard read from Grafana
// carries `params.folderUid`; a rule read through the provisioning API its
// `folderUid`. A crawled dashboard states none (its `folder` is a name).
export function folderUidOf(artefact) {
  const spec = artefact?.spec || {};
  for (const v of [spec.params?.folderUid, spec.folderUid, spec.params?.folder_uid, spec.folder_uid]) {
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

// Whether a scope entry covers an artefact of `kind`: true (inside), false
// (outside: the snapshot did not read it) or null (the artefact does not say
// what the scope needs — a metric without a name, a dashboard without a
// folder uid). No entry: true, nothing was narrowed.
export function inScope(kind, artefact, scopeEntry) {
  if (!scopeEntry) return true;
  if (scopeEntry.by === 'prefix') {
    const names = metricNamesOf(artefact);
    if (!names.length) return null;
    return names.some((n) => scopeEntry.values.some((p) => n.startsWith(p)));
  }
  if (scopeEntry.by === 'folder') {
    const uid = folderUidOf(artefact);
    if (uid === null) return null;
    return scopeEntry.values.some((v) => v.uid === uid);
  }
  return null;
}

const FAMILY_NOUNS = Object.freeze({
  metric: ['metric', 'metrics'],
  dashboard: ['dashboard', 'dashboards'],
  alert_rule: ['alert rule', 'alert rules'],
  recording_rule: ['recording rule', 'recording rules'],
});
const nounOf = (kind) => FAMILY_NOUNS[kind] || [String(kind).replace(/_/g, ' '), `${String(kind).replace(/_/g, ' ')}s`];
const folderNames = (values) => values.map((v) => v.title || v.uid).join(', ');

// The diff's notObserved reason for a verdict of inScope: `false` states what
// the snapshot read; `null` states only what is known — which folders were
// read, and that the holder pack does not say where this artefact is. `holder`
// is the side holding the artefact ('a' or 'b'). `true` has no reason.
export function scopeReason(kind, verdict, scopeEntry, { holder = 'a' } = {}) {
  if (verdict === true || !scopeEntry) return null;
  const [one, many] = nounOf(kind);
  const pack = `Pack ${String(holder).toUpperCase() === 'B' ? 'B' : 'A'}`;
  if (scopeEntry.by === 'prefix') {
    const list = scopeEntry.values.join(', ');
    return verdict === false
      ? `outside the snapshot's ${one} scope (prefixes ${list})`
      : `the snapshot read only ${many} with the prefixes ${list}; ${pack} gives this ${one} no name, so it was not checked`;
  }
  if (scopeEntry.by === 'folder') {
    const list = folderNames(scopeEntry.values);
    return verdict === false
      ? `outside the snapshot's ${one} folders (${list})`
      : `the snapshot read only the folders ${list}; ${pack} does not say which folder this ${one} is in, so it was not checked`;
  }
  return null;
}
