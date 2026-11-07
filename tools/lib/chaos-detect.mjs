// ============================================================
// chaos-detect.mjs — the chaos experiments a repository holds.
//
// Spec 1.5 (RFC-0004) lets a pack declare an experiment however it is run
// (`engine: in-process | custom` beside chaos-mesh, litmus, gremlin; a
// `schedule` of on-demand or ci beside the calendar) and record its newest
// run (`last_result`). This module reads the experiments a repository holds,
// for the crawler (crawler.mjs, crawlFiles) to declare:
//
//   - Chaos Mesh resources (`chaos-mesh.org/*`: every `*Chaos` kind,
//     `Schedule`, `Workflow`) and Litmus ones (`litmuschaos.io/*`:
//     `ChaosEngine`, `ChaosSchedule`; a `ChaosExperiment` is a hub template,
//     counted, never declared);
//   - an in-process system: a file with `chaos` in its path that holds a
//     scenario table — entries keyed by a slug, each with `durationSeconds`
//     and `delayMs` or `errorRate` (snake_case accepted). One experiment per
//     entry.
//
// The control surface of an in-process system — `/chaos/(start|stop|status)`
// routes, an `X-Chaos-Key` header, a `chaos.enabled` chart toggle, a
// `CHAOS_API_KEY` variable — corroborates; it annotates how the experiments
// are triggered and gated and creates none on its own.
//
// What code cannot say is filled from the strongest evidence the scan has and
// marked, field by field (`crawler.scaffold.validation.chaos_experiments.<id>.
// <field>` — a field mark parks nothing; the conformance report shows it):
// the expected alerts are the alert rules the scenario's own text names, the
// expected MTTD the slowest one's `for:` plus one evaluation interval, the
// steady-state hypothesis the SLO that fits the fault.
//
// Pure ESM, no Node APIs — browser-safe (the studio runs the crawler on a
// picked folder). The spec's closed vocabularies are mirrored by hand, as
// crawler.mjs mirrors its own; tools/test-chaos-detect.mjs pins the mirrors,
// and chaosExperimentErrors, against the vendored schema.
// ============================================================

import { parseAll as parseYamlAll } from './mini-yaml.mjs';

// ---------- spec 1.5 mirrors ($defs/Validation.chaos_experiments, $defs/ChaosRunResult) ----------

export const CHAOS_ENGINES = Object.freeze(['chaos-mesh', 'litmus', 'gremlin', 'in-process', 'custom']);
export const CHAOS_SCHEDULES = Object.freeze(['daily', 'weekly', 'monthly', 'on-demand', 'ci']);
export const CHAOS_RUN_OUTCOMES = Object.freeze(['pass', 'fail', 'aborted']);
export const CHAOS_REQUIRED = Object.freeze(['id', 'engine', 'target', 'steady_state_hypothesis', 'expected_alerts', 'expected_mttd', 'schedule']);
/** The expected alert an experiment declares when nothing in the repository names one. */
export const UNRESOLVED_EXPECTED_ALERT = 'unresolved:not-in-code';

const SLUG_RE = /^[a-z][a-z0-9_-]*[a-z0-9]$/;
const DURATION_RE = /^([0-9]+(\.[0-9]+)?(ns|us|ms|s|m|h|d|w|mo|y))+$/;
const REF_RE = /^(ref:[A-Za-z0-9_./-]+(@[0-9.]+)?|slis\.[a-z][a-z0-9_-]*|slos\.[a-z][a-z0-9_-]*|[a-z][a-z0-9_-]*)$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
export const CHAOS_PATTERNS = Object.freeze({ Slug: SLUG_RE.source, Duration: DURATION_RE.source, Ref: REF_RE.source });

const ITEM_KEYS = new Set([...CHAOS_REQUIRED, 'fault', 'environment', 'last_result']);
const RUN_KEYS = new Set(['at', 'outcome', 'environment', 'observed_mttd', 'alerts_fired', 'evidence']);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isSlug = (v) => typeof v === 'string' && v.length >= 2 && v.length <= 64 && SLUG_RE.test(v);

/**
 * The reasons `entry` is not a valid spec 1.5 chaos experiment, `[]` when it
 * is. The schema's item, by hand: required keys, closed properties, the
 * engine and schedule enums, Slug / Ref / Duration patterns, `fault.kind`
 * required, `last_result` closed with `at` (date-time) and `outcome`.
 */
export function chaosExperimentErrors(entry) {
  const errors = [];
  if (!isObj(entry)) return ['not an object'];
  for (const k of CHAOS_REQUIRED) if (!(k in entry)) errors.push(`missing required key '${k}'`);
  for (const k of Object.keys(entry)) if (!ITEM_KEYS.has(k)) errors.push(`unknown key '${k}'`);
  if ('id' in entry && !isSlug(entry.id)) errors.push(`id ${JSON.stringify(entry.id)} is not a spec Slug`);
  if ('engine' in entry && !CHAOS_ENGINES.includes(entry.engine)) errors.push(`engine ${JSON.stringify(entry.engine)} is not one of ${CHAOS_ENGINES.join(', ')}`);
  if ('target' in entry && typeof entry.target !== 'string') errors.push('target is not a string');
  if ('steady_state_hypothesis' in entry && !(typeof entry.steady_state_hypothesis === 'string' && REF_RE.test(entry.steady_state_hypothesis))) errors.push('steady_state_hypothesis is not a Ref');
  if ('expected_alerts' in entry && !(Array.isArray(entry.expected_alerts) && entry.expected_alerts.length >= 1 && entry.expected_alerts.every(a => typeof a === 'string'))) errors.push('expected_alerts is not a non-empty list of names');
  if ('expected_mttd' in entry && !(typeof entry.expected_mttd === 'string' && DURATION_RE.test(entry.expected_mttd))) errors.push('expected_mttd is not a Duration');
  if ('schedule' in entry && !CHAOS_SCHEDULES.includes(entry.schedule)) errors.push(`schedule ${JSON.stringify(entry.schedule)} is not one of ${CHAOS_SCHEDULES.join(', ')}`);
  if ('environment' in entry && !isSlug(entry.environment)) errors.push('environment is not a spec Slug');
  if ('fault' in entry) {
    const f = entry.fault;
    if (!isObj(f)) errors.push('fault is not an object');
    else {
      if (typeof f.kind !== 'string') errors.push("fault: missing required key 'kind'");
      if ('duration' in f && !(typeof f.duration === 'string' && DURATION_RE.test(f.duration))) errors.push('fault.duration is not a Duration');
      if ('fraction' in f && !(typeof f.fraction === 'number' && f.fraction >= 0 && f.fraction <= 1)) errors.push('fault.fraction is not a number in [0, 1]');
    }
  }
  if ('last_result' in entry) errors.push(...chaosRunErrors(entry.last_result).map(e => `last_result: ${e}`));
  return errors;
}

/** The reasons `run` is not a valid `last_result`, `[]` when it is. */
export function chaosRunErrors(run) {
  if (!isObj(run)) return ['not an object'];
  const errors = [];
  for (const k of ['at', 'outcome']) if (!(k in run)) errors.push(`missing required key '${k}'`);
  for (const k of Object.keys(run)) if (!RUN_KEYS.has(k)) errors.push(`unknown key '${k}'`);
  if ('at' in run && !(typeof run.at === 'string' && DATE_TIME_RE.test(run.at))) errors.push('at is not a date-time');
  if ('outcome' in run && !CHAOS_RUN_OUTCOMES.includes(run.outcome)) errors.push(`outcome ${JSON.stringify(run.outcome)} is not one of ${CHAOS_RUN_OUTCOMES.join(', ')}`);
  if ('environment' in run && !isSlug(run.environment)) errors.push('environment is not a spec Slug');
  if ('observed_mttd' in run && !(typeof run.observed_mttd === 'string' && DURATION_RE.test(run.observed_mttd))) errors.push('observed_mttd is not a Duration');
  if ('alerts_fired' in run && !(Array.isArray(run.alerts_fired) && run.alerts_fired.every(a => typeof a === 'string'))) errors.push('alerts_fired is not a list of names');
  if ('evidence' in run && typeof run.evidence !== 'string') errors.push('evidence is not a string');
  return errors;
}

// ---------- durations ----------

const UNIT_S = { ns: 1e-9, us: 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600, d: 86400, w: 604800, mo: 2592000, y: 31536000 };
/** Seconds in a spec / Prometheus duration (`5m`, `1h30m`, `90s`), or null. */
export function durationSeconds(text) {
  const s = String(text ?? '').trim();
  if (!s || !DURATION_RE.test(s)) return null;
  let total = 0;
  for (const m of s.matchAll(/([0-9]+(?:\.[0-9]+)?)(ns|us|ms|mo|s|m|h|d|w|y)/g)) total += Number(m[1]) * UNIT_S[m[2]];
  return total;
}
/** A whole number of seconds as a spec Duration: `6m`, `3m30s`, `1h`, `45s`. */
export function formatDuration(seconds) {
  let s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s === 0) return '0s';
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return `${h ? `${h}h` : ''}${m ? `${m}m` : ''}${s ? `${s}s` : ''}`;
}

// ---------- in-process scenario tables ----------

const CODE_EXT_RE = /\.(?:cjs|mjs|js|jsx|ts|tsx|py|go|java|kt|rs|cs)$/i;
/** A code file whose path names chaos: where an in-process scenario table may live. */
export function isChaosCodePath(relPath) {
  const p = String(relPath ?? '').replace(/\\/g, '/');
  return CODE_EXT_RE.test(p) && /chaos/i.test(p) && !/(^|\/)(node_modules|dist|build)\//i.test(p) && !/\.d\.ts$/i.test(p);
}

// The index just past the string literal starting at `i` (quote at content[i]).
function skipString(content, i) {
  const q = content[i];
  let j = i + 1;
  while (j < content.length) {
    const c = content[j];
    if (c === '\\') { j += 2; continue; }
    if (c === q) return j + 1;
    if (q !== '`' && c === '\n') return j;   // an unterminated '…' / "…" ends at the line
    j++;
  }
  return j;
}

// The index of the brace that closes the one at `open`, skipping strings and
// comments; -1 when it never closes.
function matchBrace(content, open) {
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    const c = content[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(content, i) - 1; continue; }
    if (c === '/' && content[i + 1] === '/') { const nl = content.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue; }
    if (c === '/' && content[i + 1] === '*') { const end = content.indexOf('*/', i + 2); if (end < 0) return -1; i = end + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// The body with every nested {…} emptied: what sits at the object's own level.
function ownLevel(body) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') { const j = skipString(body, i); if (depth === 0) out += body.slice(i, j); i = j - 1; continue; }
    if (c === '{') { depth++; if (depth === 1) out += '{'; continue; }
    if (c === '}') { depth--; if (depth === 0) out += '}'; continue; }
    if (depth === 0) out += c;
  }
  return out;
}

const NUM = '([0-9]+(?:\\.[0-9]+)?)';
const prop = (camel, snake) => new RegExp(`(?:^|[^A-Za-z0-9_$])["']?(?:${camel}|${snake})["']?\\s*[:=]\\s*${NUM}`, 'g');
const DURATION_PROP = prop('durationSeconds', 'duration_seconds');
const DELAY_PROP = prop('delayMs', 'delay_ms');
const RATE_PROP = prop('errorRate', 'error_rate');
const CODE_PROP = prop('errorCode', 'error_code');
const ROUTES_PROP = /["']?(?:targetRoutes|target_routes)["']?\s*[:=]\s*\[([^\]]*)\]/g;
const PHASE_PROP = /["']?(?:atSeconds|at_seconds)["']?\s*[:=]/g;
const ENTRY_KEY_RE = /(["']?)([a-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*)\1\s*:\s*\{/g;
const STRING_RE = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

const allNums = (re, text) => [...text.matchAll(re)].map(m => Number(m[1])).filter(Number.isFinite);

/**
 * The scenario table entries in one file: `[{ key, table, line,
 * durationSeconds, delayMs, errorRate, errorCodes, routes, phases, text }]`.
 * An entry is an object literal keyed by a slug whose OWN level carries
 * `durationSeconds` and whose body carries `delayMs` or `errorRate` — a
 * nested config or phase list is read as part of it. `text` is every string
 * literal in the entry (its name, its description, its messages): what the
 * scenario says about itself.
 */
export function scenarioTablesIn(relPath, content) {
  if (!isChaosCodePath(relPath) || typeof content !== 'string') return [];
  if (!/duration_?seconds/i.test(content) || !/(delay_?ms|error_?rate)/i.test(content)) return [];
  const out = [];
  let resumeAt = 0;
  ENTRY_KEY_RE.lastIndex = 0;
  for (let m = ENTRY_KEY_RE.exec(content); m; m = ENTRY_KEY_RE.exec(content)) {
    if (m.index < resumeAt) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBrace(content, open);
    if (close < 0) continue;
    const body = content.slice(open + 1, close);
    const own = ownLevel(body);
    const durations = allNums(DURATION_PROP, own);
    if (!durations.length) continue;
    const delays = allNums(DELAY_PROP, body);
    const rates = allNums(RATE_PROP, body);
    if (!delays.length && !rates.length) continue;
    const routes = [...new Set([...body.matchAll(ROUTES_PROP)].flatMap(r => [...r[1].matchAll(STRING_RE)].map(s => s[2])).filter(Boolean))];
    const text = [...body.matchAll(STRING_RE)].map(s => s[2]).join(' \n ');
    const before = content.slice(0, m.index);
    const tables = [...before.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)|^\s*([A-Z_][A-Z0-9_]*)\s*[:=]/gm)];
    const table = tables.length ? (tables.at(-1)[1] || tables.at(-1)[2]) : null;
    out.push({
      key: m[2],
      table,
      line: before.split('\n').length,
      durationSeconds: durations[0],
      delayMs: delays.length ? Math.max(...delays) : 0,
      errorRate: rates.length ? Math.max(...rates) : 0,
      errorCodes: [...new Set(allNums(CODE_PROP, body).filter(n => n >= 100 && n <= 599))],
      routes,
      phases: (body.match(PHASE_PROP) || []).length,
      text,
    });
    resumeAt = close;
  }
  return out;
}

// ---------- the control surface ----------

/**
 * Whether detectChaos reads anything from this file: a scenario table's
 * chaos code path, a code file that names chaos (its control surface), or a
 * Chaos Mesh / Litmus resource. These are the files the chaos pass reads
 * beside the artefacts, which a door that sends only what the scan uses must
 * still send (crawler.mjs scanUsesFile).
 */
export function chaosPassReads(relPath, content) {
  if (typeof content !== 'string') return false;
  const p = String(relPath ?? '').replace(/\\/g, '/');
  if (isChaosCodePath(p)) return true;
  if (CODE_EXT_RE.test(p) && /chaos/i.test(content)) return true;
  return /\.ya?ml$/i.test(p) && /(chaos-mesh\.org|litmuschaos\.io)\//.test(content);
}

/** The chaos control surface a code file shows: routes, header, API-key variable. */
export function chaosControlIn(relPath, content) {
  const out = { routes: [], header: false, keyVariable: false };
  if (!CODE_EXT_RE.test(String(relPath ?? '')) || typeof content !== 'string' || !/chaos/i.test(content)) return out;
  const routes = new Set();
  for (const m of content.matchAll(/["'`][^"'`\n]*\/chaos\/(start|stop|status)\b[^"'`\n]*["'`]/g)) routes.add(m[1]);
  out.routes = ['start', 'stop', 'status'].filter(r => routes.has(r));
  out.header = /x-chaos-key/i.test(content);
  out.keyVariable = /\bCHAOS_API_KEY\b/.test(content);
  return out;
}

/**
 * The `chaos.enabled` toggle across Helm values documents in override order
 * (base values first, overlays last — the last one wins): `{ path, enabled,
 * file }` or null. Any depth: `server.chaos.enabled`, `chaos.enabled`.
 */
export function chaosToggleIn(valuesFiles) {
  let found = null;
  const visit = (node, path, file) => {
    if (!isObj(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (!isObj(v)) continue;
      if (k.toLowerCase() === 'chaos' && typeof v.enabled === 'boolean') found = { path: [...path, k, 'enabled'].join('.'), enabled: v.enabled, file };
      if (path.length < 6) visit(v, [...path, k], file);
    }
  };
  for (const f of valuesFiles) {
    let docs;
    try { docs = parseYamlAll(f.content); } catch { continue; }
    for (const d of docs) visit(d, [], f.relPath);
  }
  return found;
}

// ---------- Chaos Mesh and Litmus resources ----------

const MESH_CHAOS_KINDS = new Set(['PodChaos', 'NetworkChaos', 'StressChaos', 'IOChaos', 'TimeChaos', 'HTTPChaos', 'DNSChaos', 'KernelChaos', 'JVMChaos', 'AWSChaos', 'GCPChaos', 'AzureChaos', 'BlockChaos', 'PhysicalMachineChaos']);

/** A cron line or Chaos Mesh `@every`/`@daily` as the spec's calendar, or null. */
export function scheduleOfCron(cron) {
  const c = String(cron ?? '').trim();
  if (!c) return null;
  if (/^@(hourly|daily|midnight)$/.test(c)) return 'daily';
  if (c === '@weekly') return 'weekly';
  if (/^@(monthly|yearly|annually)$/.test(c)) return 'monthly';
  const every = c.match(/^@every\s+(\S+)$/);
  if (every) {
    const s = durationSeconds(every[1]);
    if (s === null) return null;
    return s <= 86400 ? 'daily' : s <= 7 * 86400 ? 'weekly' : 'monthly';
  }
  const f = c.split(/\s+/);
  if (f.length < 5) return null;
  const [, , dom, , dow] = f.length === 6 ? f.slice(1) : f;
  if (dom !== '*' && dom !== '?') return 'monthly';
  if (dow !== '*' && dow !== '?') return 'weekly';
  return 'daily';
}

const kebab = (s) => String(s ?? '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
function meshFault(kind, spec) {
  const base = kebab(String(kind).replace(/Chaos$/, ''));
  const action = typeof spec?.action === 'string' ? spec.action : null;
  const fault = { kind: action ? (action.startsWith(`${base}-`) ? action : `${base}-${action}`) : base };
  if (typeof spec?.duration === 'string' && DURATION_RE.test(spec.duration)) fault.duration = spec.duration;
  if (spec?.mode === 'fixed-percent' || spec?.mode === 'random-max-percent') {
    const v = Number(spec.value);
    if (Number.isFinite(v) && v >= 0 && v <= 100) fault.fraction = v / 100;
  }
  return fault;
}
function meshTarget(spec) {
  const sel = spec?.selector || {};
  const labels = sel.labelSelectors || {};
  return labels.app || labels['app.kubernetes.io/name'] || labels['app.kubernetes.io/instance'] || (Array.isArray(sel.namespaces) ? sel.namespaces[0] : null) || null;
}
const lowerFirst = (s) => String(s).charAt(0).toLowerCase() + String(s).slice(1);

/**
 * The experiments one manifest's documents declare: `{ resources:
 * [{ engine, name, kind, fault, target, schedule, source }], templates }` —
 * a Litmus `ChaosExperiment` counts as a template and declares nothing.
 */
export function chaosResourcesIn(relPath, docs) {
  const resources = [];
  let templates = 0;
  for (const d of docs || []) {
    if (!isObj(d) || typeof d.apiVersion !== 'string' || typeof d.kind !== 'string') continue;
    const name = d.metadata?.name;
    if (typeof name !== 'string' || !name) continue;
    const source = `${relPath}#${d.kind}/${name}`;
    if (/^chaos-mesh\.org\//.test(d.apiVersion)) {
      if (MESH_CHAOS_KINDS.has(d.kind)) {
        resources.push({ engine: 'chaos-mesh', name, kind: d.kind, fault: meshFault(d.kind, d.spec), target: meshTarget(d.spec), schedule: 'on-demand', source });
      } else if (d.kind === 'Schedule') {
        const type = d.spec?.type;
        const inner = type ? d.spec?.[lowerFirst(type)] : null;
        const fault = type === 'Workflow' ? { kind: 'workflow' } : meshFault(type || 'Chaos', inner);
        resources.push({ engine: 'chaos-mesh', name, kind: 'Schedule', fault, target: meshTarget(inner), schedule: scheduleOfCron(d.spec?.schedule) || 'on-demand', source });
      } else if (d.kind === 'Workflow') {
        const steps = Array.isArray(d.spec?.templates) ? d.spec.templates.filter(t => MESH_CHAOS_KINDS.has(t?.templateType)).length : 0;
        resources.push({ engine: 'chaos-mesh', name, kind: 'Workflow', fault: { kind: 'workflow', ...(steps ? { steps } : {}) }, target: null, schedule: 'on-demand', source });
      }
    } else if (/^litmuschaos\.io\//.test(d.apiVersion)) {
      if (d.kind === 'ChaosExperiment') { templates++; continue; }
      const engineSpec = d.kind === 'ChaosSchedule' ? d.spec?.engineTemplateSpec : d.kind === 'ChaosEngine' ? d.spec : null;
      if (!engineSpec) continue;
      const appLabel = String(engineSpec.appinfo?.applabel || '');
      const target = appLabel.includes('=') ? appLabel.split('=').pop() : (engineSpec.appinfo?.appns || null);
      let schedule = 'on-demand';
      if (d.kind === 'ChaosSchedule') {
        const repeat = d.spec?.schedule?.repeat;
        const interval = durationSeconds(repeat?.properties?.minChaosInterval);
        if (repeat) schedule = interval === null || interval <= 86400 ? 'daily' : interval <= 7 * 86400 ? 'weekly' : 'monthly';
      }
      const experiments = Array.isArray(engineSpec.experiments) ? engineSpec.experiments.filter(e => typeof e?.name === 'string') : [];
      for (const e of experiments) {
        const env = Array.isArray(e.spec?.components?.env) ? e.spec.components.env : [];
        const total = Number(env.find(v => v?.name === 'TOTAL_CHAOS_DURATION')?.value);
        const fault = { kind: e.name, ...(Number.isFinite(total) && total > 0 ? { duration: formatDuration(total) } : {}) };
        resources.push({ engine: 'litmus', name: experiments.length === 1 ? name : `${name}-${e.name}`, kind: d.kind, fault, target, schedule, source: `${source}/${e.name}` });
      }
    }
  }
  return { resources, templates };
}

// ---------- the whole repository ----------

/**
 * Everything chaos the repository's files show. `files` is a Map of relPath →
 * content (the scan's in-scope files), `valuesFiles` the Helm values files in
 * override order.
 */
export function detectChaos(files, { valuesFiles = [] } = {}) {
  const scenarios = [];
  const resources = [];
  let templates = 0;
  const control = { routes: new Set(), header: false, keyVariable: false, files: new Set() };
  for (const [relPath, content] of files) {
    if (typeof content !== 'string') continue;
    for (const s of scenarioTablesIn(relPath, content)) scenarios.push({ ...s, relPath });
    const c = chaosControlIn(relPath, content);
    c.routes.forEach(r => control.routes.add(r));
    control.header ||= c.header;
    control.keyVariable ||= c.keyVariable;
    // The files that serve or gate the API; a script that only names the key variable is not one.
    if (c.routes.length || c.header) control.files.add(relPath);
    if (/\.ya?ml$/i.test(relPath) && /(chaos-mesh\.org|litmuschaos\.io)\//.test(content)) {
      let docs;
      try { docs = parseYamlAll(content); } catch { docs = []; }
      const r = chaosResourcesIn(relPath, docs);
      resources.push(...r.resources);
      templates += r.templates;
    }
  }
  if (valuesFiles.some(f => /CHAOS_API_KEY/.test(f.content || ''))) control.keyVariable = true;
  return {
    scenarios,
    resources,
    templates,
    control: { routes: ['start', 'stop', 'status'].filter(r => control.routes.has(r)), header: control.header, keyVariable: control.keyVariable, files: [...control.files].sort() },
    toggle: chaosToggleIn(valuesFiles),
  };
}

// ---------- detected → declared ----------

const LATENCY_SLI_RE = /latenc|duration|p9\d|response.?time|slow/i;
const ERROR_SLI_RE = /availab|error|success|5xx|uptime/i;
const isLatencyFault = (kind) => /latenc|delay|slow|degrad|stress|io-|time-/i.test(kind);

function hypothesisFor(faultKind, { matchedSlos, slos, slis }) {
  if (matchedSlos.length) return { ref: `ref:slos.${matchedSlos[0]}`, how: `the SLO the matched burn-rate alert protects (${matchedSlos[0]})` };
  const sliOf = (slo) => slis.get(slo.sli) || {};
  const latencyFit = slos.find(s => LATENCY_SLI_RE.test(`${s.id} ${s.sli}`) && ['threshold', 'distribution'].includes(sliOf(s).type));
  const errorFit = slos.find(s => ERROR_SLI_RE.test(`${s.id} ${s.sli}`) && sliOf(s).type === 'ratio') || slos.find(s => sliOf(s).type === 'ratio');
  const fit = isLatencyFault(faultKind) ? (latencyFit || errorFit) : (errorFit || latencyFit);
  if (fit) return { ref: `ref:slos.${fit.id}`, how: `the SLO whose SLI fits a ${faultKind} fault (${fit.id}); the code names no SLO` };
  const first = slos[0];
  return first ? { ref: `ref:slos.${first.id}`, how: `the pack's first SLO (${first.id}); nothing fits the fault and the code names no SLO` } : null;
}

const EVAL_INTERVAL_S = 60;
const nameRe = (n) => new RegExp(`(^|[^A-Za-z0-9_])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`);

/**
 * The spec experiments for what detectChaos found. `ctx`:
 *   repoName     the service (every experiment's target unless a resource names one)
 *   alertRules   [{ name, for, slo }] — every alert rule the scan found, with
 *                the SLO it protects when it is a burn-rate alert (else null)
 *   slos, slis   the pack's SLOs (array) and SLIs (Map id → sli)
 *   mttdFallback the pack's baselines.mttd_target_p50
 * → { experiments, marks: [[symbol, note]], evidence: { symbol: source },
 *     discovered: [{ id, engine, source, from }], notes: [string] }
 */
export function chaosExperimentsFrom(detected, ctx = {}) {
  const { repoName = 'service', alertRules = [], slos = [], slis = new Map(), mttdFallback = '15m' } = ctx;
  const ids = new Set();
  const uniqueId = (raw) => {
    let base = kebab(raw).replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^[^a-z]+/, '').slice(0, 60).replace(/[^a-z0-9]+$/, '');
    if (base.length < 2) base = 'chaos-experiment';
    let id = base, n = 2;
    while (ids.has(id)) id = `${base.slice(0, 60)}-${n++}`;
    ids.add(id);
    return id;
  };
  const experiments = [], marks = [], evidence = {}, discovered = [], notes = [];
  const sym = (id, field) => `validation.chaos_experiments.${id}.${field}`;

  const declare = ({ rawId, engine, target, fault, schedule, text, source, from, scheduleNote }) => {
    const id = uniqueId(rawId);
    const named = text ? alertRules.filter(r => r.name && r.name.length >= 3 && nameRe(r.name).test(text)) : [];
    const matched = [...new Map(named.map(r => [r.name, r])).values()];
    const matchedSlos = [...new Set(matched.map(r => r.slo).filter(Boolean))];
    const hyp = hypothesisFor(fault.kind, { matchedSlos, slos, slis });
    const exp = {
      id, engine, target: target || repoName,
      steady_state_hypothesis: hyp ? hyp.ref : `ref:slos.${repoName.replace(/-/g, '_')}`,
      fault,
      expected_alerts: matched.length ? matched.map(r => r.name) : [UNRESOLVED_EXPECTED_ALERT],
      expected_mttd: mttdFallback,
      schedule,
    };
    if (matched.length) {
      const slowest = Math.max(...matched.map(r => durationSeconds(r.for) ?? 0));
      exp.expected_mttd = formatDuration(slowest + EVAL_INTERVAL_S);
      marks.push([sym(id, 'expected_mttd'), `inferred: the slowest expected alert's for: (${formatDuration(slowest)}) plus one evaluation interval (1m)`]);
    } else {
      marks.push([sym(id, 'expected_alerts'), from === 'code' ? "the scenario's own text names no alert rule the scan found" : 'the resource names no alert it expects']);
      marks.push([sym(id, 'expected_mttd'), `the pack's baselines.mttd_target_p50 (${mttdFallback}); no expected alert to time`]);
    }
    marks.push([sym(id, 'steady_state_hypothesis'), hyp ? `inferred: ${hyp.how}` : 'no SLO in the pack']);
    if (scheduleNote) marks.push([sym(id, 'schedule'), scheduleNote]);
    experiments.push(exp);
    evidence[`validation.chaos_experiments.${id}`] = source;
    discovered.push({ id, engine, source, from });
    return exp;
  };

  for (const s of detected.scenarios || []) {
    const kind = s.errorRate > 0 ? (s.delayMs >= 1000 ? 'latency-and-errors' : 'http-errors') : 'latency';
    const fault = { kind, duration: formatDuration(s.durationSeconds) };
    if (s.delayMs) fault.delay_ms = s.delayMs;
    if (s.errorRate) fault.error_rate = s.errorRate;
    if (s.errorRate && s.errorCodes.length) fault.error_codes = s.errorCodes;
    if (s.routes.length) fault.routes = s.routes;
    if (s.phases) fault.phases = s.phases;
    declare({
      rawId: s.key, engine: 'in-process', fault, schedule: 'on-demand', text: s.text, from: 'code',
      source: `${s.relPath}#${s.table ? `${s.table}.` : ''}${s.key}`,
      scheduleNote: 'the code starts it on request and holds no timer: on-demand',
    });
  }
  for (const r of detected.resources || []) {
    declare({
      rawId: r.name, engine: r.engine, target: r.target, fault: r.fault, schedule: r.schedule, text: null, from: 'resource', source: r.source,
      scheduleNote: r.schedule === 'on-demand' ? `a ${r.kind} runs once when it is applied: on-demand` : null,
    });
  }
  if (!experiments.length && (detected.control?.routes?.length || detected.control?.header)) {
    notes.push(`A chaos control API was found (${detected.control.files.join(', ')}) but no scenario table: no experiment is declared.`);
  }
  if (detected.templates) notes.push(`${detected.templates} Litmus ChaosExperiment template(s) found: a template is a hub definition, not an experiment, and declares nothing.`);
  if (detected.toggle && detected.toggle.enabled === false && detected.scenarios?.length) {
    notes.push(`The chaos API is switched off in this environment (${detected.toggle.path}: false in ${detected.toggle.file}); its experiments are declared, and cannot run here as configured.`);
  }
  return { experiments, marks, evidence, discovered, notes };
}

/** One line on how an in-process system is triggered and gated, or null. */
export function chaosControlSummary(detected) {
  const c = detected?.control;
  if (!c) return null;
  const parts = [];
  if (c.routes.length) parts.push(`API /chaos/${c.routes.join('|')}`);
  if (c.header) parts.push('gated by the X-Chaos-Key header');
  if (c.keyVariable) parts.push('keyed by CHAOS_API_KEY');
  if (!parts.length) return null;
  return `${parts.join(', ')}${c.files.length ? ` (${c.files.join(', ')})` : ''}`;
}
