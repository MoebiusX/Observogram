// tools/lib/control-room.mjs — what a service's live side shows right now, and how fast its alerts clear.
//
// Overview's control room reads it through the service environment's live
// MCP endpoint (server/routes/control-room.mjs). Four parts, each with an
// honest outcome — data · empty · failed · not-attempted — and never a
// number the read did not see:
//
//   alerts    what is firing and pending now, by severity, each with how
//             long its condition has held (ALERTS, ALERTS_FOR_STATE). An
//             empty answer is "quiet" only when the store shows an alert
//             history at all (`evidence`): with none, quiet cannot be told
//             from unwatched
//   scrape    the targets up of all scraped, and of the scrape jobs the
//             repository declares (the chain's exporters)
//             An abort (the route's deadline) keeps every part already read
//             and says the others were not read: it ran out of time
//   timing    how long incidents took to clear over the window, rebuilt
//             from the rule evaluator's own firing history (ALERTS): one
//             incident per alert name, steps `stepSeconds` apart, a pause
//             of at most `mergeSeconds` merged (an evaluator restart, a
//             flap), its severity the highest it fired at; an incident
//             still firing, or begun before the history, has no known
//             duration and is named, never averaged in; an info notice is
//             counted apart. This is how long ALERTS stayed firing — a
//             proxy for MTTR, said as one. MTTD needs a known fault start,
//             which no alert history holds: it is not measured here (the
//             repository's chaos runs are).
//   families  the known metric families the endpoint exposes
//             (tools/lib/contracts/control-room-families.mjs), a few tiles
//             and one chart each
//
// Why the rule evaluator's history and not Alertmanager or Grafana's
// alerting: Alertmanager's API answers only alerts still open, and
// Grafana's state history covers Grafana-managed rules only. The
// evaluator (Prometheus, vmalert, a ruler) writes ALERTS on every
// evaluation, into the store the query capability reads.
//
// The scope (`scope`: { jobs, alerts }): the service's own, as its repository
// declares it — its scrape jobs and its alert rules' names. With a scope,
// every part reads only what is the service's: the alerts and the firing
// history of the alerts it names or that fire on its jobs, the targets of
// its jobs, the families' series of its jobs (scopeSelectors adds the job
// matcher to every selector). An endpoint shared by several services (one
// store) then shows each its own. A scope that names nothing reads nothing
// and says why; with no scope (an older caller) the read is the endpoint's
// whole, as before.
//
// Every query is this module's: nothing from the request reaches PromQL
// but the repository's declared job and alert names, regex-escaped. The PromQL tool
// is the `control_room_query` capability's (never named here). One answer
// is read up to `answerBytes` (the firing history up to
// `historyAnswerBytes`); past it that part says so.
//
// Pure ESM; the MCP client (./mcp-client.mjs) is the only I/O.

import { createMcpClient, MCP_PROTOCOL_VERSION } from './mcp-client.mjs';
import { capabilityTool } from './contracts/mcp-capabilities.mjs';
import { CONTROL_ROOM_FAMILIES, CONTROL_ROOM_UNITS, CONTROL_ROOM_LAYERS } from './contracts/control-room-families.mjs';

export const CONTROL_ROOM_LIMITS = Object.freeze({
  windowDays: 30,
  // 2 min over 30 days is 21,600 steps a series — under VictoriaMetrics'
  // default 30,000 points a series (a 1-minute step is refused there).
  stepSeconds: 120,
  // The longest pause between two firings of one alert that is still one incident.
  mergeSeconds: 300,
  minIncidents: 5,
  // The history-start probe's subquery step: its first point lands up to this far after the window opens,
  // and a second probe over those first hours, at the history's own step, places the start exactly.
  historyStartStepSeconds: 21_600,
  chartRange: '6h',
  chartStep: '10m',
  maxCalls: 64,
  // Two at a time: a public endpoint behind a rate-limited ingress answered 503
  // to most of six parallel reads (krystaline, 2026-11-11) and to none of two.
  concurrency: 2,
  // Alerts listed at most; the rest are counted.
  activeShown: 12,
  // Declared jobs read at most (a longer regex is cut, and said).
  declaredJobs: 60,
  // Declared alert names read at most, the same way.
  declaredAlerts: 200,
  toolsListMaxPages: 10,
  // One answer's size: a few KiB is usual; the 30-day firing history is the one large one.
  answerBytes: 4 * 1024 * 1024,
  historyAnswerBytes: 16 * 1024 * 1024,
});

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
// null, undefined and '' are no number (Number(null) is 0: a value never read must not read as 0).
const num = (x) => { if (x === null || x === undefined || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; };
// Seconds since the epoch as an ISO time, or null when it is no time.
const iso = (seconds) => { const n = num(seconds); if (n === null) return null; const d = new Date(n * 1000); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

// ---------- the parts' small rules ----------

const SEVERITY_WORDS = {
  critical: ['CRITICAL', 'CRIT', 'PAGE', 'P0', 'P1', 'SEV0', 'SEV1', 'EMERGENCY', 'FATAL', 'DISASTER', 'URGENT'],
  warning: ['WARNING', 'WARN', 'HIGH', 'MAJOR', 'MEDIUM', 'AVERAGE', 'TICKET', 'P2', 'P3', 'SEV2', 'SEV3', 'ERROR'],
  info: ['INFO', 'INFORMATION', 'LOW', 'MINOR', 'NONE', 'P4', 'P5', 'SEV4', 'SEV5', 'NOTICE'],
};
/** A severity label in four words: critical · warning · info · other ("sev-1" reads as SEV1). */
export function normaliseSeverity(value) {
  const s = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (const [word, aliases] of Object.entries(SEVERITY_WORDS)) if (aliases.includes(s)) return word;
  return 'other';
}
const SEVERITY_RANK = { critical: 0, warning: 1, other: 2, info: 3 };
const RANKED = ['critical', 'warning', 'other', 'info'];

/**
 * The status word from firing alerts: critical · firing (a severity not recognised: never called a
 * warning) · warning · quiet; unknown when the alerts were not read whole, or when nothing fires and
 * the store shows no alert history (quiet or unwatched?).
 */
export function statusWord(alerts) {
  if (!alerts || alerts.outcome === 'failed' || alerts.outcome === 'not-attempted') return 'unknown';
  const by = alerts.bySeverity || {};
  if (by.critical > 0) return 'critical';
  if (by.other > 0) return 'firing';
  if (by.warning > 0) return 'warning';
  if (alerts.outcome === 'empty' && alerts.evidence !== true) return 'unknown';
  return 'quiet';
}

/**
 * A tile's tone from its judge: good · warn · bad · info. Red only past a stated critical. A count is
 * judged as the whole number it is shown as (increase() answers 3.4 restarts for 3).
 */
export function judgeValue(judge, raw, unit = null) {
  if (!isObj(judge) || judge.kind === 'info' || raw === null || raw === undefined || !Number.isFinite(raw)) return 'info';
  const value = unit === 'count' ? Math.round(raw) : raw;
  const bound = num(judge.bound);
  if (bound === null) return 'info';
  const critical = num(judge.critical);
  if (judge.kind === 'ceiling') return critical !== null && value > critical ? 'bad' : value > bound ? 'warn' : 'good';
  if (judge.kind === 'floor') return critical !== null && value < critical ? 'bad' : value < bound ? 'warn' : 'good';
  return 'info';
}

/** Job names as one anchored PromQL regex alternation, each escaped. */
export function jobsRegex(jobs) {
  return [...new Set((jobs || []).map(String).filter(Boolean))]
    .map((j) => j.replace(/[\\.^$|?*+()[\]{}]/g, '\\$&'))
    .join('|');
}
const promString = (s) => JSON.stringify(String(s));

// An MCP or backend error in a few words: no URL and no network address (the
// backend's own host, port and resolver ride in its error text: Go's dial and
// lookup, Node's getaddrinfo and connect codes, a certificate's names), no
// page markup, no stack, at most 160 characters. A bare word before a colon
// and a number ("code:500") is not an address: a host has a dot, or is localhost.
export function cleanError(message) {
  return String(message ?? 'no answer')
    .replace(/<title>([^<]*)<\/title>/i, ' $1 ')
    .replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\blookup\s+[^\s:]+(?:\s+on\s+(?:\[[^\]]+\]|[^\s:]+)(?::\d+)?)?/gi, 'lookup of the backend')
    .replace(/\bdial\s+(?:tcp|udp)[46]?\s+(?:\[[^\]]+\]|[^\s:]+)(?::\d+)?/gi, 'dial to the backend')
    // A connect code takes the address after it, never a plain word ("ECONNRESET while reading").
    .replace(/\b(?:getaddrinfo\s+)?(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\s+((?:\d{1,3}\.){3}\d{1,3}(?::\d+)?|[0-9a-f]*::?[0-9a-f:]*[0-9a-f](?::\d+)?|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?|[a-z0-9-]+:\d{2,5})(?![\w.-])/gi, (m, code) => `${code} the backend`)
    .replace(/\b(?:getaddrinfo\s+)?(ENOTFOUND|EAI_AGAIN)\s+(?!the backend\b)[a-z0-9-]+(?![\w.:-])/gi, '$1 the backend')
    .replace(/\bcertificate is valid for .*?, not \S+/gi, 'certificate is not valid for the backend')
    .replace(/\[[0-9a-f:.]+\](?::\d+)?/gi, 'the backend')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, 'the backend')
    .replace(/\blocalhost:\d{2,5}\b/gi, 'the backend')
    // A dotted host with a port — never a source file and line ("query.go:42": one dot, a source
    // extension); a host with more labels (store.acme.cc:8428) is a host, whatever its last label.
    .replace(/\b(?=[a-z0-9.-]*[a-z])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+:\d{2,5}\b/gi, (m) => (/^[a-z0-9_-]+\.(?:go|js|mjs|cjs|ts|py|rs|java|kt|c|cc|cpp|h|rb|php|cs):\d+$/i.test(m) ? m : 'the backend'))
    // An in-cluster single-label name with a port: one with a hyphen or a digit (vmstorage-0:8401,
    // prometheus-k8s:9090), or any with a port of four or five digits after "to", "from", "at",
    // "Addr:" or before "->" — never "code:500" or "line:42".
    .replace(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+:\d{2,5}\b|\b[a-z]+\d[a-z0-9]*:\d{2,5}\b/gi, 'the backend')
    .replace(/\b(to|from|at|Addr:)\s+[a-z][a-z0-9-]*:\d{4,5}\b/gi, '$1 the backend')
    .replace(/\b[a-z][a-z0-9-]*:\d{2,5}(?=->)/gi, 'the backend')
    .replace(/^[a-z_]+:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .replace(/\s+[—-]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || 'no answer';
}

// ---------- incidents from the firing history ----------

// incidentsFrom(series, { stepSeconds, mergeSeconds, nowSeconds, windowStartSeconds, severityOf })
//   series  a matrix: [{ metric: { alertname, severity? }, values: [[t, v], ...] }] — the steps an
//           alert fired; one alert name may come as several series, one per severity
//   → [{ name, severity, start, end, seconds, open, before }] sorted by start
//     an alert name's firing steps make one incident while the pause between two of them is at most
//     `mergeSeconds` (gap minus one step); its severity is the highest any of its steps fired at
//     (`metric.severity`, else severityOf(name))
//     open    still firing at the read (its last step within two steps of now)
//     before  already firing when the history starts: its true start is unknown
export function incidentsFrom(series, { stepSeconds, mergeSeconds, nowSeconds, windowStartSeconds = null, beforeSlackSeconds = 2 * stepSeconds, severityOf = () => 'other' } = {}) {
  const byName = new Map(); // name → Map(t → severity rank)
  for (const s of Array.isArray(series) ? series : []) {
    if (!isObj(s)) continue;
    const name = String(s.metric?.alertname ?? '');
    if (!name) continue;
    const label = isObj(s.metric) && s.metric.severity !== undefined ? normaliseSeverity(s.metric.severity) : severityOf(name);
    const rank = SEVERITY_RANK[label] ?? SEVERITY_RANK.other;
    const steps = byName.get(name) || new Map();
    byName.set(name, steps);
    for (const p of Array.isArray(s.values) ? s.values : []) {
      if (!Array.isArray(p)) continue;
      const at = num(p[0]), v = num(p[1]);
      if (at === null || v === null || v <= 0) continue;
      steps.set(at, Math.min(steps.get(at) ?? rank, rank));
    }
  }
  const out = [];
  for (const [name, steps] of byName) {
    const ts = [...steps.keys()].sort((a, b) => a - b);
    if (!ts.length) continue;
    const spans = [];
    let start = ts[0], last = ts[0], best = steps.get(ts[0]);
    for (const at of ts.slice(1)) {
      if (at - last - stepSeconds > mergeSeconds) { spans.push([start, last, best]); start = at; best = steps.get(at); }
      else best = Math.min(best, steps.get(at));
      last = at;
    }
    spans.push([start, last, best]);
    for (const [a, b, r] of spans) {
      out.push({
        name, severity: RANKED[r] || 'other', start: a, end: b, seconds: b - a + stepSeconds,
        open: nowSeconds - b <= 2 * stepSeconds,
        // Two steps by default: the store aligns the history's steps on its own clock, a few seconds
        // after the read's (none when the start is the history's own first step).
        before: windowStartSeconds !== null && a - windowStartSeconds <= beforeSlackSeconds,
      });
    }
  }
  return out.sort((x, y) => x.start - y.start || x.name.localeCompare(y.name, 'en'));
}

const nearestRank = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : null);

// timingSummary(incidents, { minIncidents }) → the MTTR proxy over the closed incidents (info notices apart):
//   { incidents, closed, notices, medianSeconds, p95Seconds, tooFew,
//     bySeverity: { critical|warning|other: { closed, medianSeconds (null below the minimum), longestSeconds } },
//     busiest: { name, incidents } | null, open: [{ name, since, severity, began }] (an info notice too:
//     its age is a row's; the panel never says it as a problem), before, beforeNames (no notice),
//     lastFiredAt: the newest end of an incident that is no notice, or null }
export function timingSummary(incidents, { minIncidents = CONTROL_ROOM_LIMITS.minIncidents } = {}) {
  const list = Array.isArray(incidents) ? incidents : [];
  const closed = list.filter((i) => !i.open && !i.before);
  const done = closed.filter((i) => i.severity !== 'info');
  const sorted = done.map((i) => i.seconds).sort((a, b) => a - b);
  const bySeverity = {};
  for (const sev of ['critical', 'warning', 'other']) {
    const own = done.filter((i) => i.severity === sev).map((i) => i.seconds).sort((a, b) => a - b);
    if (own.length) bySeverity[sev] = { closed: own.length, medianSeconds: own.length >= minIncidents ? nearestRank(own, 0.5) : null, longestSeconds: own[own.length - 1] };
  }
  const counts = new Map();
  for (const i of done) counts.set(i.name, (counts.get(i.name) || 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))[0] || null;
  const before = list.filter((i) => i.before && !i.open && i.severity !== 'info');
  const ends = list.filter((i) => i.severity !== 'info').map((i) => i.end);
  return {
    incidents: list.length,
    closed: done.length,
    notices: closed.length - done.length,
    tooFew: done.length < minIncidents,
    medianSeconds: done.length >= minIncidents ? nearestRank(sorted, 0.5) : null,
    p95Seconds: done.length >= minIncidents ? nearestRank(sorted, 0.95) : null,
    bySeverity,
    busiest: top ? { name: top[0], incidents: top[1] } : null,
    open: list.filter((i) => i.open).map((i) => ({ name: i.name, severity: i.severity, since: iso(i.start), began: i.before ? 'before the window' : null })),
    before: before.length,
    beforeNames: [...new Set(before.map((i) => i.name))].slice(0, 5),
    lastFiredAt: ends.length ? iso(Math.max(...ends)) : null,
  };
}

// ---------- the families: the catalogue, and a downstream's rows ----------

const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const METRIC_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const JUDGE_KINDS = ['ceiling', 'floor', 'info'];

/** Why a family row is not one: a list of reasons, empty when it is. */
export function familyRowErrors(row) {
  const errors = [];
  if (!isObj(row)) return ['not an object'];
  if (typeof row.id !== 'string' || !ID_RE.test(row.id)) errors.push('id is not a lower-case slug of at most 40 characters');
  if (typeof row.title !== 'string' || !row.title.trim() || row.title.length > 60) errors.push('title is not a text of at most 60 characters');
  if (!CONTROL_ROOM_LAYERS.includes(row.layer)) errors.push(`layer is none of ${CONTROL_ROOM_LAYERS.join(', ')}`);
  if (!Array.isArray(row.variants) || !row.variants.length || row.variants.length > 4) return [...errors, 'variants is not a list of 1 to 4'];
  row.variants.forEach((v, i) => {
    const at = `variants[${i}]`;
    if (!isObj(v)) { errors.push(`${at} is not an object`); return; }
    if (!Array.isArray(v.requires) || !v.requires.length || v.requires.length > 8 || !v.requires.every((n) => typeof n === 'string' && METRIC_RE.test(n))) errors.push(`${at}.requires is not 1 to 8 metric names`);
    if (!Array.isArray(v.tiles) || !v.tiles.length || v.tiles.length > 6) { errors.push(`${at}.tiles is not a list of 1 to 6`); return; }
    const exprOk = (e) => typeof e === 'string' && e.trim() && e.length <= 800 && !/[\r\n]/.test(e);
    v.tiles.forEach((tile, j) => {
      const tat = `${at}.tiles[${j}]`;
      if (!isObj(tile)) { errors.push(`${tat} is not an object`); return; }
      if (typeof tile.id !== 'string' || !ID_RE.test(tile.id)) errors.push(`${tat}.id is not a slug`);
      if (typeof tile.label !== 'string' || !tile.label.trim() || tile.label.length > 48) errors.push(`${tat}.label is not a text of at most 48 characters`);
      if (!CONTROL_ROOM_UNITS.includes(tile.unit)) errors.push(`${tat}.unit is none of ${CONTROL_ROOM_UNITS.join(', ')}`);
      if (!exprOk(tile.expr)) errors.push(`${tat}.expr is not one line of PromQL of at most 800 characters`);
      if (tile.empty !== undefined && (typeof tile.empty !== 'string' || !tile.empty.trim() || tile.empty.length > 80)) errors.push(`${tat}.empty is not a text of at most 80 characters`);
      const j2 = tile.judge;
      if (!isObj(j2) || !JUDGE_KINDS.includes(j2.kind)) errors.push(`${tat}.judge.kind is none of ${JUDGE_KINDS.join(', ')}`);
      else if (j2.kind !== 'info' && (num(j2.bound) === null || (j2.critical !== undefined && num(j2.critical) === null) || typeof j2.from !== 'string' || !j2.from || j2.from.length > 80)) errors.push(`${tat}.judge needs a numeric bound (and critical, when given) and a "from" naming its source`);
    });
    if (v.chart !== null && v.chart !== undefined) {
      const c = v.chart;
      if (!isObj(c) || typeof c.label !== 'string' || !c.label.trim() || c.label.length > 48 || !CONTROL_ROOM_UNITS.includes(c.unit) || !exprOk(c.expr)) errors.push(`${at}.chart is not { label, unit, expr }`);
    }
  });
  return errors;
}

// controlRoomFamilies(custom) → { families, warnings }
//   custom  a downstream's { families: [row, ...] } (the server's
//           OBSERVOGRAM_CONTROL_ROOM_FAMILIES file), or null. A row whose id
//           is a built-in one replaces it, any other is added after the
//           built-in rows; a row that is not one is dropped with a warning.
export function controlRoomFamilies(custom = null) {
  const families = [...CONTROL_ROOM_FAMILIES];
  const warnings = [];
  if (custom === null || custom === undefined) return { families, warnings };
  const rows = isObj(custom) && Array.isArray(custom.families) ? custom.families : null;
  if (!rows) return { families, warnings: ['the control-room families file holds no "families" list; only the built-in families are read'] };
  rows.slice(0, 40).forEach((row, i) => {
    const errors = familyRowErrors(row);
    if (errors.length) { warnings.push(`family ${isObj(row) && typeof row.id === 'string' ? row.id : `#${i + 1}`}: ${errors[0]}; dropped.`); return; }
    const at = families.findIndex((f) => f.id === row.id);
    if (at >= 0) families[at] = row; else families.push(row);
  });
  if (rows.length > 40) warnings.push(`only the first 40 of ${rows.length} families are read`);
  return { families, warnings };
}

/** The one query that says which families' metric names the endpoint exposes (with `matcher`, among the scope's series). */
export function detectionQuery(families, matcher = '') {
  const names = [...new Set(families.flatMap((f) => f.variants.flatMap((v) => v.requires)))].sort();
  return `count by (__name__) ({__name__=~${promString(names.join('|'))}${matcher ? `, ${matcher}` : ''}})`;
}

// ---------- the scope: a service's own series ----------

// Words of PromQL that are no metric name: keywords, and the lists that follow some of them.
const PROMQL_KEYWORDS = new Set(['by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'bool', 'offset', 'and', 'or', 'unless', 'atan2', 'inf', 'nan', 'start', 'end']);
const PROMQL_LISTS = new Set(['by', 'without', 'on', 'ignoring', 'group_left', 'group_right']);
// The index of the character that closes the bracket opened at `at` (quotes skipped), or the end.
function closing(s, at, open, close) {
  let depth = 0;
  for (let i = at; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = quoteEnd(s, i); continue; }
    if (ch === open) depth += 1;
    else if (ch === close && --depth === 0) return i;
  }
  return s.length - 1;
}
function quoteEnd(s, at) {
  const q = s[at];
  for (let i = at + 1; i < s.length; i += 1) {
    if (s[i] === '\\' && q !== '`') { i += 1; continue; }
    if (s[i] === q) return i;
  }
  return s.length - 1;
}

/**
 * The expression with `matcher` (e.g. `job=~"a|b"`) added to every vector selector: `x` → `x{m}`,
 * `x{a="b"}` → `x{m, a="b"}`, `{__name__=~"…"}` → `{m, __name__=~"…"}`. Functions, keywords, the
 * label lists of by / without / on / ignoring / group_*, numbers, durations, ranges and strings are
 * left as they are. The families' queries are this repository's (or a downstream's validated rows),
 * so this reads PromQL as they write it, not every PromQL there is.
 */
export function scopeSelectors(expr, matcher) {
  const s = String(expr ?? '');
  if (!matcher) return s;
  const withMatcher = (inner) => `{${matcher}${inner.trim() ? `, ${inner.trim()}` : ''}}`;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === '`') { const e = quoteEnd(s, i); out += s.slice(i, e + 1); i = e + 1; continue; }
    // A range or a subquery: copied as it is.
    if (ch === '[') { const e = s.indexOf(']', i); const end = e < 0 ? s.length - 1 : e; out += s.slice(i, end + 1); i = end + 1; continue; }
    // A selector with no name.
    if (ch === '{') { const e = closing(s, i, '{', '}'); out += withMatcher(s.slice(i + 1, e)); i = e + 1; continue; }
    // A number or a duration (5m, 0.99, 1e3).
    if (/[0-9.]/.test(ch)) { let j = i; while (j < s.length && /[0-9a-zA-Z._]/.test(s[j])) j += 1; out += s.slice(i, j); i = j; continue; }
    if (/[a-zA-Z_:]/.test(ch)) {
      let j = i;
      while (j < s.length && /[a-zA-Z0-9_:]/.test(s[j])) j += 1;
      const word = s.slice(i, j);
      let k = j;
      while (k < s.length && /\s/.test(s[k])) k += 1;
      const lower = word.toLowerCase();
      if (PROMQL_LISTS.has(lower) && s[k] === '(') { const e = closing(s, k, '(', ')'); out += s.slice(i, e + 1); i = e + 1; continue; }
      // An aggregation written "sum by (le) (…)" or "max without (x) (…)": the word before by / without is no metric.
      const nextWord = /^[a-zA-Z_]+/.exec(s.slice(k))?.[0]?.toLowerCase() || '';
      if (PROMQL_KEYWORDS.has(lower) || s[k] === '(' || nextWord === 'by' || nextWord === 'without') { out += word; i = j; continue; }
      if (s[k] === '{') { const e = closing(s, k, '{', '}'); out += `${word}${withMatcher(s.slice(k + 1, e))}`; i = e + 1; continue; }
      out += `${word}{${matcher}}`;
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * The scope in PromQL: { jobs, alerts, cut: { jobs, alerts }, job, alertsSel(extra), alertsParts(extra), forStateSel(), empty }.
 * `job` is the job matcher (or ''); `alertsSel('alertstate="firing"')` the ALERTS selector of the
 * alerts the service names or that fire on its jobs (or null when it names neither).
 */
export function scopeQueries(scope, limits = CONTROL_ROOM_LIMITS) {
  const L = { ...CONTROL_ROOM_LIMITS, ...limits };
  const clean = (xs) => [...new Set((Array.isArray(xs) ? xs : []).map((x) => String(x ?? '').trim()).filter(Boolean))].sort();
  const allJobs = clean(scope?.jobs), allAlerts = clean(scope?.alerts);
  const jobs = allJobs.slice(0, L.declaredJobs), alerts = allAlerts.slice(0, L.declaredAlerts);
  const job = jobs.length ? `job=~${promString(jobsRegex(jobs))}` : '';
  // A named alert is the service's on its own jobs (the job arm has those) or with no job at all (a
  // burn-rate alert over a summed series): another service's alert of the same name, on its own job,
  // is not. With no jobs to tie it to, the name alone (the scope line says what that counts).
  const named = alerts.length ? `alertname=~${promString(jobsRegex(alerts))}${jobs.length ? ', job=""' : ''}` : '';
  // Each selector apart (a range applies to one selector, never to an "or"), and joined.
  const parts = (metric, extra = '') => {
    const pre = extra ? `${extra}, ` : '';
    return [named && `${metric}{${pre}${named}}`, job && `${metric}{${pre}${job}}`].filter(Boolean);
  };
  const sel = (metric, extra = '') => {
    const p = parts(metric, extra);
    return p.length ? (p.length === 1 ? p[0] : `(${p.join(' or ')})`) : null;
  };
  return {
    jobs, alerts, cut: { jobs: allJobs.length - jobs.length, alerts: allAlerts.length - alerts.length },
    job, empty: !jobs.length && !alerts.length,
    alertsSel: (extra = '') => sel('ALERTS', extra),
    alertsParts: (extra = '') => parts('ALERTS', extra),
    forStateSel: () => sel('ALERTS_FOR_STATE'),
  };
}

/** For each family, the first variant whose required names are all exposed, or null. */
export function pickVariant(family, exposed) {
  return family.variants.find((v) => v.requires.every((n) => exposed.has(n))) || null;
}

// ---------- reading ----------

const resultOf = (answer) => (Array.isArray(answer?.result) ? answer.result : Array.isArray(answer?.data?.result) ? answer.data.result : null);
// The series of an answer that are objects (a malformed entry is skipped, never thrown on).
const seriesOf = (r) => (Array.isArray(r?.result) ? r.result.filter(isObj) : []);
const labelOf = (s, name) => String((isObj(s.metric) ? s.metric[name] : undefined) ?? '');
const valueOf = (s) => (Array.isArray(s.value) ? num(s.value[1]) : null);
// An instant answer's number: the first series that holds one.
const scalarOf = (r) => { for (const s of seriesOf(r)) { const v = valueOf(s); if (v !== null) return v; } return null; };

// The query that says whether this store holds any alert history at all (with
// a scope, of the service's alerts): an ALERTS series anywhere in the window.
// Without one, "nothing fired" cannot be told from "nothing writes alerts here".
const evidenceQuery = (window, sels = ['ALERTS']) => `count(${sels.map((x) => `last_over_time(${x}[${window}])`).join(' or ')})`;

// A pool that runs at most `size` reads at once and stops starting new ones
// past `budget` calls; once `signal` aborts, every read still queued is
// refused. Three lanes: the headline's follow-ups (an alert age by name, the
// alert-history evidence, the history's exact start) before anything else,
// then the status, the targets and the history, the families' tiles and
// charts last — a read cut at its deadline loses the tiles, not what the
// headline rests on.
function readPool({ size, budget, signal }) {
  let running = 0, made = 0;
  const lanes = { now: [], first: [], later: [] };
  const next = () => lanes.now.shift() || lanes.first.shift() || lanes.later.shift();
  const refuseQueued = () => { for (let job = next(); job; job = next()) job.reject(signal.reason || new Error('aborted')); };
  if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', refuseQueued, { once: true });
  const pump = () => {
    while (running < size && (lanes.now.length || lanes.first.length || lanes.later.length)) {
      const job = next();
      if (signal?.aborted) { job.reject(signal.reason || new Error('aborted')); continue; }
      if (made >= budget) { job.resolve({ skipped: true }); continue; }
      running += 1; made += 1;
      job.run().then(job.resolve, job.reject).finally(() => { running -= 1; pump(); });
    }
  };
  return {
    run: (fn, lane = 'first') => new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason || new Error('aborted')); return; }
      lanes[lane in lanes ? lane : 'first'].push({ run: fn, resolve, reject }); pump();
    }),
    get made() { return made; },
  };
}

// readControlRoom({ callTool, callHistoryTool, tool, families, declaredJobs, scope, nowSeconds, limits, signal, timing })
//   callTool         an initialised client's callTool(name, args)
//   callHistoryTool  the same for the firing history (a client with the larger answer cap); callTool when not given
//   tool             the PromQL query tool's name (the control_room_query capability's)
//   scope            { jobs, alerts } — the service's own (its repository's scrape jobs and alert rule
//                    names): every part reads only those (above); null reads the endpoint's whole,
//                    with `declaredJobs` beside it as before
//   → { calls, scope?, alerts, scrape, timing, families, absent }
//      scope  { kind: 'service', jobs, alerts, cut: { jobs, alerts } } — only with a scope (the counts read)
//   timing    false skips the firing history (the route keeps it longer than the rest); the answer's timing is then null
// A part that cannot be made sense of fails alone ({ outcome: 'failed', reason }); a transport hook
// fault, or the signal's abort, fails the whole read.
export async function readControlRoom({ callTool, callHistoryTool = null, tool, families = CONTROL_ROOM_FAMILIES, declaredJobs = [], scope = null, nowSeconds = Date.now() / 1000, limits = CONTROL_ROOM_LIMITS, signal = null, timing: withTiming = true } = {}) {
  const L = { ...CONTROL_ROOM_LIMITS, ...limits };
  // The service's own series, when the caller names them.
  const S = scope ? scopeQueries(scope, L) : null;
  // Said only for a scoped read: an older caller's own answer keeps its own scope key.
  const scopeOut = S ? { kind: 'service', jobs: S.jobs.length, alerts: S.alerts.length, cut: S.cut } : null;
  const alertsSel = (extra = '') => (S ? S.alertsSel(extra) : `ALERTS${extra ? `{${extra}}` : ''}`);
  const NOTHING_NAMED = 'the repository declares no alert rule and no scrape job: nothing live is known to be this service\'s';
  const NO_JOBS = 'the repository declares no scrape job: no target or metric is known to be this service\'s';
  // The pool's own stop: the caller's abort, or a transport hook fault (which fails the whole read:
  // nothing queued after it may still reach the endpoint).
  const stop = new AbortController();
  const stopWith = (reason) => { if (!stop.signal.aborted) stop.abort(reason); };
  if (signal) { if (signal.aborted) stopWith(signal.reason); else signal.addEventListener?.('abort', () => stopWith(signal.reason), { once: true }); }
  const pool = readPool({ size: L.concurrency, budget: L.maxCalls, signal: stop.signal });
  // A follow-up the headline needs, asked ahead of the rest; cut by the deadline it is "not read",
  // and what was already read stands (only a transport hook fault fails the whole read).
  const askSoon = (query) => ask(query, callTool, 'now').catch((e) => {
    if (e?.name === 'TransportHookError') throw e;
    return { outcome: 'not-attempted', result: null, reason: 'the read ran out of time' };
  });
  // One query: { outcome, result, reason }. `lane` 'later' for a family's tiles and chart, 'now' for a follow-up.
  const ask = async (query, call = callTool, lane = 'first') => {
    const r = await pool.run(async () => {
      try { return { answer: await call(tool, { query }) }; }
      catch (e) {
        if (e?.name === 'TransportHookError') { stopWith(e); throw e; }
        if (signal?.aborted) throw e;
        return { error: e };
      }
    }, lane);
    if (r.skipped) return { outcome: 'not-attempted', result: null, reason: 'the read reached its budget of calls' };
    if (r.error) return { outcome: 'failed', result: null, reason: cleanError(r.error?.message) };
    const result = resultOf(r.answer);
    if (result === null) return { outcome: 'failed', result: null, reason: 'the answer is not a query result' };
    return { outcome: result.length ? 'data' : 'empty', result, reason: null };
  };
    // A part's body; a throw fails that part alone — the abort's (the route's deadline) as "not read:
  // out of time", any other as failed; only a transport hook's fails the whole read.
  const part = async (fn, failed) => {
    try { return await fn(); }
    catch (e) {
      if (e?.name === 'TransportHookError') throw e;
      if (signal?.aborted) return { ...failed, outcome: 'not-attempted', reason: 'the read ran out of time' };
      return { ...failed, outcome: 'failed', reason: cleanError(e?.message) };
    }
  };
  const W = `${L.windowDays}d`;
  const windowStart = nowSeconds - L.windowDays * 86400;

  // Whether the store holds any alert history (asked once, only when an empty answer needs it):
  // true · false · null (could not be read).
  let evidenceP = null;
  const evidence = () => {
    evidenceP ||= askSoon(evidenceQuery(W, S ? S.alertsParts() : ['ALERTS'])).then((r) => (r.outcome === 'data' ? (scalarOf(r) ?? 0) > 0 : r.outcome === 'empty' ? false : null));
    return evidenceP;
  };

  // The families the endpoint exposes (with a scope, among the service's jobs' series), first (their tiles depend on it).
  const detect = S && !S.job ? Promise.resolve({ outcome: 'not-attempted', result: null, reason: NO_JOBS }) : ask(detectionQuery(families, S ? S.job : ''));

  // Alerts now: a name firing and pending at once is two rows, never one, each with its own age
  // (ALERTS_FOR_STATE carries no state: joined to ALERTS for it; by name alone where the join fails).
  const alertsP = part(async () => {
    if (S?.empty) return { outcome: 'not-attempted', reason: NOTHING_NAMED, evidence: null, bySeverity: null, pending: 0, active: [], more: 0, otherSeverities: [] };
    const forState = S ? S.forStateSel() : 'ALERTS_FOR_STATE';
    const [states, since] = await Promise.all([
      ask(`count by (alertname, severity, alertstate) (${alertsSel()})`),
      ask(`min by (alertname, alertstate) (${forState} * ignoring(alertstate) group_left(alertstate) ${alertsSel()})`),
    ]);
    if (states.outcome === 'failed' || states.outcome === 'not-attempted') return { outcome: states.outcome, reason: states.reason, evidence: null, bySeverity: null, pending: 0, active: [], more: 0, otherSeverities: [] };
    // By name alone (the join failed): the name's earliest activeAt is its firing instance's, so a
    // pending row of a name that also fires gets no age rather than its twin's.
    const byName = since.outcome === 'failed' ? await askSoon(`min by (alertname) (${forState})`) : null;
    const firingNames = new Set(seriesOf(states).filter((s) => labelOf(s, 'alertstate') === 'firing').map((s) => labelOf(s, 'alertname')));
    const sinceOf = new Map(byName
      ? seriesOf(byName).flatMap((s) => {
        const name = labelOf(s, 'alertname');
        return [['firing', valueOf(s)], ['pending', firingNames.has(name) ? null : valueOf(s)]].map(([st, v]) => [`${st}\u0000${name}`, v]);
      })
      : seriesOf(since).map((s) => [`${labelOf(s, 'alertstate') === 'firing' ? 'firing' : 'pending'}\u0000${labelOf(s, 'alertname')}`, valueOf(s)]));
    const byKey = new Map();
    for (const s of seriesOf(states)) {
      const name = labelOf(s, 'alertname');
      if (!name) continue;
      const state = labelOf(s, 'alertstate') === 'firing' ? 'firing' : 'pending';
      const raw = labelOf(s, 'severity');
      const severity = normaliseSeverity(raw);
      const key = `${state}\u0000${name}`;
      const was = byKey.get(key);
      const n = valueOf(s) || 0;
      if (!was) byKey.set(key, { name, severity, label: raw.slice(0, 24), state, instances: n });
      else {
        if (SEVERITY_RANK[severity] < SEVERITY_RANK[was.severity]) { was.severity = severity; was.label = raw.slice(0, 24); }
        was.instances += n;
      }
    }
    const all = [...byKey.values()].map((a) => {
      const at = sinceOf.get(`${a.state}\u0000${a.name}`);
      const known = at !== null && at !== undefined && iso(at) !== null;
      return { ...a, since: known ? iso(at) : null, seconds: known ? Math.max(0, Math.round(nowSeconds - at)) : null };
    }).sort((a, b) => (a.state === b.state ? 0 : a.state === 'firing' ? -1 : 1) || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.seconds ?? 0) - (a.seconds ?? 0) || a.name.localeCompare(b.name, 'en'));
    const firing = all.filter((a) => a.state === 'firing');
    const bySeverity = { critical: 0, warning: 0, info: 0, other: 0 };
    for (const a of firing) bySeverity[a.severity] += 1;
    // The labels as they came; '' is an alert with no severity label (the panel words it).
    const otherSeverities = [...new Set(firing.filter((a) => a.severity === 'other').map((a) => a.label))].slice(0, 4);
    // Something is firing or pending: an evaluator writes here. Nothing is: ask whether one ever did.
    const ev = states.outcome === 'data' ? true : await evidence();
    return { outcome: states.outcome, reason: null, evidence: ev, bySeverity, pending: all.length - firing.length, active: all.slice(0, L.activeShown), more: Math.max(0, all.length - L.activeShown), otherSeverities };
  }, { evidence: null, bySeverity: null, pending: 0, active: [], more: 0, otherSeverities: [] });

  // Scrape health: everything (with a scope, the service's jobs only), then the repository's
  // declared jobs one by one. A count is shown only as read: a failed `sum(up)` is "not read", never 0 up.
  const declared = S ? S.jobs : [...new Set((declaredJobs || []).map(String).filter(Boolean))];
  const upSel = S ? `up{${S.job}}` : 'up';
  const scrapeP = part(async () => {
    if (S && !S.job) return { outcome: 'not-attempted', reason: NO_JOBS, up: null, total: null, downJobs: [], downRead: false };
    const read = declared.slice(0, L.declaredJobs);
    const [total, up, down, mine] = await Promise.all([
      ask(`count(${upSel})`), ask(`sum(${upSel})`), ask(`count by (job) (${upSel} == 0)`),
      read.length ? ask(`sum by (job) (up{job=~${promString(jobsRegex(read))}}) / count by (job) (up{job=~${promString(jobsRegex(read))}})`) : Promise.resolve(null),
    ]);
    const t = scalarOf(total), u = up.outcome === 'data' ? scalarOf(up) : null;
    const out = (total.outcome === 'data' && t !== null)
      ? {
        outcome: 'data', reason: null, up: u, upReason: u === null ? (up.reason || 'the targets up were not read') : null, total: t,
        downJobs: down.outcome === 'data' ? seriesOf(down).map((s) => labelOf(s, 'job')).filter(Boolean).sort().slice(0, 8) : [],
        downRead: down.outcome === 'data' || down.outcome === 'empty',
      }
      : {
        outcome: total.outcome === 'empty' ? 'empty' : total.outcome === 'data' ? 'failed' : total.outcome,
        reason: total.outcome === 'empty'
          ? (S ? `no target of its ${S.jobs.length === 1 ? 'scrape job' : `${S.jobs.length} scrape jobs`} answers here` : 'the endpoint answers no up series')
          : total.outcome === 'data' ? 'the answer holds no number' : total.reason,
        up: null, total: null, downJobs: [], downRead: false,
      };
    if (mine) {
      if (mine.outcome === 'data' || mine.outcome === 'empty') {
        // Per job, the share of its targets up: 1 all, 0 none, between some.
        const seen = new Map(seriesOf(mine).map((s) => [labelOf(s, 'job'), valueOf(s)]));
        const share = (j) => seen.get(j);
        out.declared = {
          outcome: 'data', jobs: read.length,
          up: read.filter((j) => share(j) === 1).length,
          partly: read.filter((j) => share(j) !== null && share(j) !== undefined && share(j) > 0 && share(j) < 1).slice(0, 8),
          partlyCount: read.filter((j) => share(j) !== null && share(j) !== undefined && share(j) > 0 && share(j) < 1).length,
          down: read.filter((j) => share(j) === 0).slice(0, 8),
          downCount: read.filter((j) => share(j) === 0).length,
          missing: read.filter((j) => !seen.has(j)).slice(0, 8),
          missingCount: read.filter((j) => !seen.has(j)).length,
          cut: S ? S.cut.jobs : declared.length - read.length,
        };
      } else out.declared = { outcome: mine.outcome, reason: mine.reason, jobs: read.length, cut: S ? S.cut.jobs : declared.length - read.length };
    }
    return out;
  }, { up: null, total: null, downJobs: [], downRead: false });

  // How fast incidents cleared: the firing history over the window, one series an alert name and severity.
  const timingP = withTiming ? part(async () => {
    if (S?.empty) return { windowDays: L.windowDays, stepSeconds: L.stepSeconds, mergeSeconds: L.mergeSeconds, minIncidents: L.minIncidents, outcome: 'not-attempted', reason: NOTHING_NAMED, historyFrom: null, coversDays: null };
    const step = `${Math.round(L.stepSeconds / 60)}m`;
    const [history, from] = await Promise.all([
      ask(`max by (alertname, severity) (${alertsSel('alertstate="firing"')})[${W}:${step}]`, callHistoryTool || callTool),
      ask(`min(min_over_time(timestamp(up)[${W}:${Math.round(L.historyStartStepSeconds / 3600)}h]))`),
    ]);
    const base = { windowDays: L.windowDays, stepSeconds: L.stepSeconds, mergeSeconds: L.mergeSeconds, minIncidents: L.minIncidents };
    let read = from.outcome === 'data' ? scalarOf(from) : null;
    // The probe's first point lands up to one of its steps after the window opens. Within that, a
    // second probe over the window's first hours, at the history's own step, says where the data
    // begins: from the window's start (all of it kept), or later (the start is that point).
    if (read !== null && read <= windowStart + L.historyStartStepSeconds + L.stepSeconds) {
      const firstHours = Math.round(L.historyStartStepSeconds / 3600);
      const near = await askSoon(`min(min_over_time(timestamp(up)[${firstHours}h:${step}] offset ${L.windowDays * 24 - firstHours}h))`);
      const exact = near.outcome === 'data' ? scalarOf(near) : null;
      if (exact !== null) read = exact;
    }
    const fullWindow = read !== null && read <= windowStart + L.stepSeconds;
    const historyFrom = read === null ? null : fullWindow ? windowStart : read;
    const covers = historyFrom !== null ? Math.min(L.windowDays, Math.max(0, (nowSeconds - historyFrom) / 86400)) : null;
    if (history.outcome === 'failed' || history.outcome === 'not-attempted') return { ...base, outcome: history.outcome, reason: history.reason, historyFrom: iso(historyFrom), coversDays: covers };
    // How far back the store keeps data is not known: the history's own first step stands in, so an
    // incident already firing there counts as begun before it (never averaged in with a cut start).
    let start = historyFrom;
    if (start === null) {
      const firsts = seriesOf(history).flatMap((s) => (Array.isArray(s.values) && Array.isArray(s.values[0]) ? [num(s.values[0][0])] : [])).filter((x) => x !== null);
      start = firsts.length ? Math.min(...firsts) : null;
    }
    // The slack for the store's own step alignment applies to a start from the clock (the window, the
    // probe); a start that is the history's own first step needs none.
    const incidents = incidentsFrom(seriesOf(history), { stepSeconds: L.stepSeconds, mergeSeconds: L.mergeSeconds, nowSeconds, windowStartSeconds: start, beforeSlackSeconds: historyFrom === null ? 0 : 2 * L.stepSeconds });
    if (!incidents.length) {
      const ev = await evidence();
      // With a scope the history is the service's alerts': none of them in the store says nothing of the store's others.
      const reason = ev === true ? 'no alert fired in the window'
        : ev === false ? (S ? 'none of its alerts has a history in this store' : 'the store shows no alert history')
          : 'whether the store holds an alert history was not read';
      return { ...base, outcome: 'empty', reason, evidence: ev, historyFrom: iso(historyFrom), coversDays: covers, ...timingSummary([], { minIncidents: L.minIncidents }) };
    }
    return {
      ...base, outcome: 'data', reason: null, evidence: true,
      historyFrom: iso(historyFrom), coversDays: covers,
      ...timingSummary(incidents, { minIncidents: L.minIncidents }),
    };
  }, { windowDays: L.windowDays, stepSeconds: L.stepSeconds, mergeSeconds: L.mergeSeconds, minIncidents: L.minIncidents, historyFrom: null, coversDays: null }) : Promise.resolve(null);

  // The families: the tiles of each exposed one, and its chart.
  const familiesP = part(async () => {
    const d = await detect;
    if (d.outcome === 'failed' || d.outcome === 'not-attempted') return { outcome: d.outcome, reason: d.reason, rows: [], absent: [] };
    const exposed = new Set(seriesOf(d).map((s) => labelOf(s, '__name__')).filter(Boolean));
    const picked = families.map((f) => ({ f, v: pickVariant(f, exposed) }));
    const rows = await Promise.all(picked.filter((p) => p.v).map(async ({ f, v }) => {
      const tiles = await Promise.all(v.tiles.map(async (tile) => {
        const r = await ask(S ? scopeSelectors(tile.expr, S.job) : tile.expr, callTool, 'later');
        const value = r.outcome === 'data' ? scalarOf(r) : null;
        const outcome = r.outcome === 'data' && value === null ? 'empty' : r.outcome;
        return {
          id: tile.id, label: tile.label, unit: tile.unit, value, outcome,
          reason: r.reason || (outcome === 'empty' && tile.empty ? tile.empty : null),
          tone: judgeValue(tile.judge, value, tile.unit), judge: tile.judge.kind === 'info' ? null : { kind: tile.judge.kind, bound: tile.judge.bound, critical: tile.judge.critical ?? null, from: tile.judge.from },
        };
      }));
      let chart = null;
      if (v.chart) {
        const r = await ask(`(${S ? scopeSelectors(v.chart.expr, S.job) : v.chart.expr})[${L.chartRange}:${L.chartStep}]`, callTool, 'later');
        const first = seriesOf(r)[0];
        const pts = r.outcome === 'data' && first && Array.isArray(first.values)
          ? first.values.filter(Array.isArray).map(([at, val]) => [num(at), num(val)]).filter(([at]) => at !== null)
          : [];
        chart = { label: v.chart.label, unit: v.chart.unit, range: L.chartRange, outcome: pts.length ? 'data' : (r.outcome === 'data' ? 'empty' : r.outcome), reason: r.reason, points: pts };
      }
      return { id: f.id, title: f.title, layer: f.layer, outcome: tiles.some((x) => x.outcome === 'data') ? 'data' : (tiles.every((x) => x.outcome === 'empty') ? 'empty' : 'failed'), tiles, chart };
    }));
    return { outcome: 'data', reason: null, rows, absent: picked.filter((p) => !p.v).map((p) => ({ id: p.f.id, title: p.f.title })) };
  }, { rows: [], absent: [] });

  const [alerts, scrape, timing, fam] = await Promise.all([alertsP, scrapeP, timingP, familiesP]);
  return {
    calls: { made: pool.made, budget: L.maxCalls, ...(signal?.aborted ? { outOfTime: true } : {}) },
    ...(scopeOut ? { scope: scopeOut } : {}),
    alerts, scrape, timing,
    families: { outcome: fam.outcome, reason: fam.reason, rows: fam.rows },
    absent: fam.absent,
  };
}

// openControlRoom({ mcpUrl, mcpAuth, transport, timeoutMs, signal, limits }) → { callTool, callHistoryTool, tool, advertised, tools, end }
// Initialise, list the tools (page by page), and say whether the query
// capability's tool is advertised. Throws on a transport, HTTP or protocol
// failure (the route says it as the endpoint's). Every answer is read up to
// `answerBytes`; the firing history goes through a second client, opened on
// its first call, that reads up to `historyAnswerBytes`. end() ends both
// sessions (an MCP DELETE each; never throws): a panel left open reads every
// minute, and a server keeping every session until its DELETE would keep them all.
export async function openControlRoom({ mcpUrl, mcpAuth = null, transport = null, timeoutMs = 10_000, signal = null, limits = CONTROL_ROOM_LIMITS } = {}) {
  const L = { ...CONTROL_ROOM_LIMITS, ...limits };
  // A client, initialised; a session opened and then failed (an error after initialize) is ended, not left.
  const open = async (maxAnswerBytes) => {
    const client = createMcpClient({ mcpUrl, mcpAuth, timeoutMs, transport, signal, maxAnswerBytes });
    try {
      const init = await client.rpc('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'observogram-control-room', version: '1' } });
      if (!isObj(init)) throw new Error('MCP initialize: the answer is not a JSON-RPC result');
      await client.notify('notifications/initialized');
      return client;
    } catch (e) { client.end().catch(() => {}); throw e; }
  };
  const client = await open(L.answerBytes);
  const names = new Set();
  try {
    let cursor;
    for (let page = 0; page < L.toolsListMaxPages; page += 1) {
      const res = await client.rpc('tools/list', cursor === undefined ? {} : { cursor });
      if (!isObj(res) || !Array.isArray(res.tools)) throw new Error('MCP tools/list: the answer is not a JSON-RPC result');
      for (const tl of res.tools) if (typeof tl?.name === 'string') names.add(tl.name);
      if (typeof res.nextCursor !== 'string' || !res.nextCursor) break;
      cursor = res.nextCursor;
    }
  } catch (e) { client.end().catch(() => {}); throw e; }
  const tool = capabilityTool('control_room_query');
  let history = null;
  let ended = false;
  const callHistoryTool = async (name, args) => {
    // After end(), no new session is opened (a late query of a read already given up on).
    if (ended) throw new Error('MCP: the read has ended');
    history ||= open(L.historyAnswerBytes);
    return (await history).callTool(name, args);
  };
  // Both sessions at once: a history client still opening never holds the main one's end.
  const end = async () => {
    ended = true;
    await Promise.allSettled([client.end(), history ? history.then((h) => h.end(), () => false) : null]);
  };
  return { callTool: client.callTool, callHistoryTool, tool, advertised: names.has(tool), tools: names.size, end };
}
