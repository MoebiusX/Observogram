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

export const SCOPE_LIMITS = Object.freeze({ prefixes: 32, prefixLength: 100, folders: 32, uidLength: 40, excludes: 32, excludeLength: 200, groups: 32, groupLength: 100 });
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

// The capability ids in the order the stages read them — the probe families'
// order wherever a record names "the first" of them.
const STAGE_CAPABILITY_ORDER = Object.freeze(LIVE_STAGES.flatMap((stage) => stage.capabilities));
const familyRank = (family) => {
  const i = STAGE_CAPABILITY_ORDER.indexOf(family);
  return i === -1 ? STAGE_CAPABILITY_ORDER.length : i;
};
// `families` in stage order (an unknown family last, by name); a copy.
export function inStageOrder(families) {
  return [...(Array.isArray(families) ? families : [])]
    .sort((x, y) => familyRank(x) - familyRank(y) || String(x).localeCompare(String(y), 'en'));
}

const isPlainRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// The first probe error a run record carries (or the live facts a journey
// derives from Pack B: { probes, probeErrors }), in stage order:
// { family, error } for the first failed family that names one; a lost run's
// own `error` when no failed family does (the read failed before any probe,
// or no family failed and none returned data); { family, error: null } when
// a family failed without a message; null when nothing failed and the run
// was not lost. A reader shows it as the reason a row reads "did not answer".
export function firstProbeError(record) {
  const failed = inStageOrder((Array.isArray(record?.probes?.failed) ? record.probes.failed : []).filter((f) => typeof f === 'string' && f));
  const errors = isPlainRecord(record?.probeErrors) ? record.probeErrors : {};
  for (const family of failed) {
    if (typeof errors[family] === 'string' && errors[family]) return { family, error: errors[family] };
  }
  if (record?.outcome === 'vantage-lost' && typeof record.error === 'string' && record.error) return { family: failed[0] ?? null, error: record.error };
  return failed.length ? { family: failed[0], error: null } : null;
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
const SCOPE_FIELDS = Object.freeze(['metricPrefixes', 'folderUids', 'datasourceUid', 'metricExclude', 'ruleGroups']);
// A refused value is quoted, cut so a pasted blob never fills the sentence.
const quoted = (value) => {
  const s = String(value);
  return JSON.stringify(s.length > 60 ? `${s.slice(0, 60)}…` : s);
};
const listOf = (value) => (typeof value === 'string' ? value.split(',') : value);
// Exclude patterns in a variable are separated by white space, never by a
// comma: a metric name has no white space, a regex may well have a comma.
const wordsOf = (value) => (typeof value === 'string' ? value.split(/\s+/) : value);

function normalizeList(raw, field, { limit, check, split = listOf }, errors) {
  if (raw === undefined || raw === null || raw === '') return [];
  const list = split(raw);
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
// An exclude pattern: the static half of the bounded-regex rule every
// user-written regex in this repository obeys (tools/lib/artefact-classify.mjs
// compileBoundedPattern — anchored, short, no quantified group, compiles).
// This module imports nothing, so the rule is restated here; the fetcher runs
// the timed half against adversarial names before a pattern touches a list.
// A pattern is matched against every metric name a scope reads, on the
// server's own thread (the fetcher's filter, the diff's and the scope check's
// inScope), so its work is bounded too, statically: no backreference, and at
// most EXCLUDE_WORK_MAX ways to split a name of EXCLUDE_NAME_MAX characters
// (excludeWork) — `^q*q*q*q*q*q*q*q*q*q*q*q*$`, which every timed id fails at
// its first character, crawls for seconds over a 24-character name and is
// refused here, in the timed half's words. A name longer than EXCLUDE_NAME_MAX
// is never matched by an exclude pattern (excludedBy).
const QUANTIFIED_GROUP = /\)[+*{]/;
export const EXCLUDE_NAME_MAX = 256;
const EXCLUDE_WORK_MAX = 1_000_000;
const EXCLUDE_TOO_SLOW = `is too slow to match (it crawls over a ${EXCLUDE_NAME_MAX}-character name)`;
const checkExclude = (value) => {
  if (value.length > SCOPE_LIMITS.excludeLength) return `is longer than ${SCOPE_LIMITS.excludeLength} characters`;
  if (!value.startsWith('^')) return 'is not anchored (an exclude pattern starts with ^)';
  if (QUANTIFIED_GROUP.test(value)) return 'has a quantified group (nested quantifier)';
  try { new RegExp(value); } catch (e) { return `is not a regular expression (${e.message})`; }
  const terms = excludeTerms(value);
  if (terms && hasBackreference(terms)) return 'refers back to a group (a backreference has no bound on its work)';
  if (excludeWork(value) > EXCLUDE_WORK_MAX) return EXCLUDE_TOO_SLOW;
  return null;
};
// The static half as a sentence for a pattern (null when it passes): the same rule normalizeScope
// applies, for a caller that checks one pattern (the fetcher's timed half, before it times).
export const excludeProblem = (pattern) => (typeof pattern === 'string' && pattern !== '' ? checkExclude(pattern) : 'is not a pattern');

// Whether an exclude pattern drops `name`: one of `matchers` (compiled patterns that passed the
// rule above) matches it, and it is at most EXCLUDE_NAME_MAX characters long — a longer name is
// never dropped, so no pattern works over more than the bound counts. The fetcher's filter and the
// diff's inScope read names by this one rule.
export function excludedBy(matchers, name) {
  return typeof name === 'string' && name.length <= EXCLUDE_NAME_MAX && (Array.isArray(matchers) ? matchers : []).some((re) => re.test(name));
}

// ---------- an exclude pattern's work ----------
//
// The pattern read as terms (a source new RegExp accepted, no flags): an alternation of sequences,
// each term { type: 'char', src, min, max } (a literal, an escape, a class or '.', with its
// repetition), { type: 'group', look, alts, min, max }, { type: 'assert', src } (^, $, \b, \B) or
// { type: 'backref' }. null when it does not read so.
const HEX_DIGIT = /[0-9a-fA-F]/;
function excludeTerms(pattern) {
  let i = 0;
  const quantify = (term) => {
    let q = null;
    if (pattern[i] === '*') q = [0, Infinity, 1];
    else if (pattern[i] === '+') q = [1, Infinity, 1];
    else if (pattern[i] === '?') q = [0, 1, 1];
    else if (pattern[i] === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
      if (m) q = [Number(m[1]), m[2] === undefined ? Number(m[1]) : m[3] === '' ? Infinity : Number(m[3]), m[0].length];
    }
    if (!q) return;
    i += q[2];
    if (pattern[i] === '?') i += 1;   // lazy: the same splits, tried in another order
    term.min = q[0];
    term.max = q[1];
  };
  const atom = () => {
    const start = i;
    const c = pattern[i];
    if (c === '(') {
      i += 1;
      let look = false;
      if (pattern[i] === '?') {
        if (pattern.startsWith('?:', i)) i += 2;
        else if (pattern.startsWith('?=', i) || pattern.startsWith('?!', i)) { i += 2; look = true; }
        else if (pattern.startsWith('?<=', i) || pattern.startsWith('?<!', i)) { i += 3; look = true; }
        else if (pattern.startsWith('?<', i) && pattern.indexOf('>', i) > i) i = pattern.indexOf('>', i) + 1;
        else throw new SyntaxError('group');
      }
      const alts = alternation(true);
      if (pattern[i] !== ')') throw new SyntaxError('group');
      i += 1;
      return { type: 'group', look, alts, min: 1, max: 1 };
    }
    if (c === '[') {
      let j = i + 1;
      if (pattern[j] === '^') j += 1;
      while (j < pattern.length && pattern[j] !== ']') j += pattern[j] === '\\' ? 2 : 1;
      if (j >= pattern.length) throw new SyntaxError('class');
      i = j + 1;
      return { type: 'char', src: pattern.slice(start, i), min: 1, max: 1 };
    }
    if (c === '\\') {
      const d = pattern[i + 1];
      if (d === undefined) throw new SyntaxError('escape');
      if (/[1-9k]/.test(d)) { i += 2; return { type: 'backref' }; }
      if (d === 'b' || d === 'B') { i += 2; return { type: 'assert', src: pattern.slice(start, i) }; }
      let len = 2;
      if (d === 'x' && HEX_DIGIT.test(pattern[i + 2] ?? '') && HEX_DIGIT.test(pattern[i + 3] ?? '')) len = 4;
      else if (d === 'u' && [2, 3, 4, 5].every((k) => HEX_DIGIT.test(pattern[i + k] ?? ''))) len = 6;
      else if (d === 'c' && /[A-Za-z]/.test(pattern[i + 2] ?? '')) len = 3;
      i += len;
      return { type: 'char', src: pattern.slice(start, i), min: 1, max: 1 };
    }
    i += 1;
    if (c === '^' || c === '$') return { type: 'assert', src: c };
    return { type: 'char', src: c, min: 1, max: 1 };
  };
  const alternation = (inGroup) => {
    const alts = [[]];
    while (i < pattern.length && !(inGroup && pattern[i] === ')')) {
      if (pattern[i] === '|') { alts.push([]); i += 1; continue; }
      if (pattern[i] === ')') throw new SyntaxError('group');
      const term = atom();
      quantify(term);
      alts[alts.length - 1].push(term);
    }
    return alts;
  };
  try {
    const alts = alternation(false);
    return i === pattern.length ? alts : null;
  } catch { return null; }
}
const hasBackreference = (alts) => alts.some((seq) => seq.some((t) => t.type === 'backref' || (t.type === 'group' && hasBackreference(t.alts))));

// The most work a backtracking matcher does to test `pattern` on a name of `n` characters: the ways
// it can split the name among the quantified atoms and the alternatives, counted from the end — an
// atom that can only stop before a character it cannot take, or at the end of the name (`$`, or the
// end of the pattern, where the test succeeds), costs its own steps once (added); one whose next
// term can take what it takes is tried once per way the rest can be split (multiplied). The same
// characters are compared over every ASCII one and every one the pattern writes, so two sets that
// share a character share one of those. Infinity for what does not read as terms, a backreference,
// a repeated group, or more than EXCLUDE_WORK_MAX.
function excludeWork(pattern, n = EXCLUDE_NAME_MAX) {
  const alts = excludeTerms(pattern);
  if (!alts) return Infinity;
  const sample = new Set();
  for (let c = 0; c < 128; c += 1) sample.add(String.fromCharCode(c));
  for (const ch of pattern) sample.add(ch);
  for (const m of pattern.matchAll(/\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g)) sample.add(String.fromCharCode(parseInt(m[1] ?? m[2], 16)));
  for (const ch of '        　﻿') sample.add(ch);
  const chars = [...sample];
  const setOf = (t) => {
    if (t.set === undefined) {
      let re = null;
      try { re = new RegExp(`^(?:${t.src})$`); } catch { /* not read alone: never disjoint */ }
      t.set = re ? chars.filter((ch) => re.test(ch)) : null;
    }
    return t.set;
  };
  const disjoint = (a, b) => {
    const sa = setOf(a);
    const sb = setOf(b);
    return !!sa && !!sb && !sa.some((ch) => sb.includes(ch));
  };
  const stops = (t, next, atEnd) => (!next ? atEnd
    : next.type === 'assert' ? next.src === '$'
      : next.type === 'char' && next.min >= 1 && disjoint(t, next));
  const seqWork = (seq, atEnd) => {
    let w = 1;
    for (let k = seq.length - 1; k >= 0; k -= 1) {
      const t = seq[k];
      if (t.type === 'backref') return Infinity;
      if (t.type === 'char') {
        const reps = Math.min(t.max, n) - Math.min(t.min, n) + 1;
        if (reps > 1) w = stops(t, seq[k + 1], atEnd) ? reps + w : reps * w;
      } else if (t.type === 'group') {
        if (t.max > 1) return Infinity;
        let inner = 0;
        for (const alt of t.alts) inner += seqWork(alt, false);
        w = t.look ? inner + w : ((t.min === 0 ? 1 : 0) + inner) * w;
      }
      if (!(w <= EXCLUDE_WORK_MAX)) return Infinity;
    }
    return w;
  };
  let total = 0;
  for (const seq of alts) total += seqWork(seq, true);
  const anchored = alts.every((seq) => seq[0]?.type === 'assert' && seq[0].src === '^');
  const work = anchored ? total : total * (n + 1);
  return work <= EXCLUDE_WORK_MAX ? work : Infinity;
}

// Names to time an exclude pattern on (the fetcher's timed half), so the clock times the pattern's
// own work: a name that opens with the literal text the pattern opens with, then one character
// over and over, then a line break no pattern takes at the end — one name per character the
// pattern writes (and a letter, a digit, `_`, `:`, `-`) — beside the four adversarial ids every
// bounded pattern is timed on. A pattern that must open with `q` fails every one of those at its
// first character, and was timed doing nothing.
export function excludeProbes(pattern) {
  const n = EXCLUDE_NAME_MAX;
  const out = ['a'.repeat(n), 'ab'.repeat(n / 2), '-'.repeat(n), `${'x'.repeat(n - 1)}!`];
  const alts = typeof pattern === 'string' ? excludeTerms(pattern) : null;
  if (!alts) return out;
  let prefix = '';
  const first = alts[0] || [];
  for (const t of first.slice(first[0]?.type === 'assert' && first[0].src === '^' ? 1 : 0)) {
    if (t.type !== 'char' || t.min !== 1 || t.max !== 1) break;
    const ch = t.src.length === 1 && t.src !== '.' ? t.src : t.src.length === 2 && t.src[0] === '\\' && !/[A-Za-z0-9]/.test(t.src[1]) ? t.src[1] : null;
    if (ch === null) break;
    prefix += ch;
  }
  prefix = prefix.slice(0, n - 2);
  const fills = new Set(['a', '0', '_', ':', '-']);
  for (const ch of pattern) if (!'\\^$|()[]{}*+?.'.includes(ch) && ch.trim()) fills.add(ch);
  for (const c of [...fills].slice(0, 24)) out.push(`${prefix}${c.repeat(n - prefix.length - 1)}\n`);
  return out;
}
// A rule group's name as the engine lists it (`ruleGroup` of a Grafana-managed
// rule, `groups[].name` of a Prometheus or vmalert listing): any text without
// a control character, up to the limit. Compared exactly, case and all.
const hasControlChar = (value) => [...value].some((ch) => { const c = ch.codePointAt(0); return c < 0x20 || c === 0x7f; });
const checkGroup = (value) => {
  if (value === '') return 'is empty (a rule-group name has at least one character)';
  if (value.length > SCOPE_LIMITS.groupLength) return `is longer than ${SCOPE_LIMITS.groupLength} characters`;
  if (hasControlChar(value)) return 'has a control character';
  return null;
};

// A scope from a request body or the configuration → { scope, errors }. The
// list fields take an array or a comma list (the configuration's form; the
// exclude patterns a white-space list, since a regex may carry a comma); the
// values are trimmed and deduplicated in order. `errors` holds one sentence
// per refused field or value, naming it and the rule; the scope keeps only the
// values that passed, and a caller refuses the whole scope when `errors` is
// not empty.
export function normalizeScope(input) {
  const errors = [];
  const scope = { metricPrefixes: [], folderUids: [], datasourceUid: null, metricExclude: [], ruleGroups: [] };
  if (input === undefined || input === null) return { scope, errors };
  if (typeof input !== 'object' || Array.isArray(input)) return { scope, errors: [`scope is not an object (${SCOPE_FIELDS.join(', ')})`] };
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
  scope.metricExclude = normalizeList(input.metricExclude, 'metricExclude', { limit: SCOPE_LIMITS.excludes, check: checkExclude, split: wordsOf }, errors);
  scope.ruleGroups = normalizeList(input.ruleGroups, 'ruleGroups', { limit: SCOPE_LIMITS.groups, check: checkGroup }, errors);
  return { scope, errors };
}

// A scope as a journey file and a run record keep it: only the fields set (a
// normalized scope → { metricPrefixes?, folderUids?, datasourceUid?,
// metricExclude?, ruleGroups? }), or null when none is.
export function compactScope(scope) {
  if (!scope || scopeIsEmpty(scope)) return null;
  const out = {};
  for (const key of SCOPE_FIELDS) {
    const v = scope[key];
    if (Array.isArray(v) ? v.length : (typeof v === 'string' && v !== '')) out[key] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

export function scopeIsEmpty(scope) {
  return !scope || ((scope.metricPrefixes || []).length === 0 && (scope.folderUids || []).length === 0 && !scope.datasourceUid
    && (scope.metricExclude || []).length === 0 && (scope.ruleGroups || []).length === 0);
}

// The families each scope field may apply to. Metric prefixes and exclude
// patterns narrow the metric family; folder uids the dashboards, and the rule
// families only when every rule the answers carry names its folder (the
// fetcher decides and says so in `learned.applied`); rule groups the rule
// families only when every rule names its group (`learned.appliedGroups`).
export const SCOPE_FAMILIES = Object.freeze({
  metricPrefixes: Object.freeze(['metric']),
  folderUids: Object.freeze(['dashboard', 'alert_rule', 'recording_rule']),
  metricExclude: Object.freeze(['metric']),
  ruleGroups: Object.freeze(['alert_rule', 'recording_rule']),
});

export const LIVE_SCOPE_ANNOTATION = 'observogram.live.scope';
export const SCOPE_ANNOTATION_PREFIX = 'observogram.scope.';
const FOLDER_TITLE_CHARS = 100;

// The annotations a snapshot records for its scope. `learned` is what the
// fetch found out: `applied` — the families the scope was actually applied
// to (default: the metric family when prefixes or exclude patterns are set,
// dashboards when folders are) — `appliedGroups`, the rule families the rule
// groups were applied to (default none: only the fetcher can tell that every
// rule named its group), and `folderTitles` ({ <uid>: <title> }, from the
// dashboard search answers). `observogram.live.scope` is always written (an
// unscoped snapshot says so; `metricExclude`, `ruleGroups` and their
// `appliesTo` entries appear only when set, so a pack without them reads as
// before); a family's `observogram.scope.<kind>` only when the scope was
// applied to it, so the diff parks nothing the fetch did not narrow. The
// metric entry carries the prefixes as `values` and, when set, the patterns as
// `exclude`; a rule family's entry the folders as `values` with the groups as
// `groups` when both were applied, or `{ by: 'group', values: [name] }` when
// only the groups were.
export function scopeAnnotations(scope, learned = {}) {
  const s = scope || {};
  const prefixes = [...(s.metricPrefixes || [])];
  const folders = [...(s.folderUids || [])];
  const excludes = [...(s.metricExclude || [])];
  const groups = [...(s.ruleGroups || [])];
  const defaults = [...(prefixes.length || excludes.length ? ['metric'] : []), ...(folders.length ? ['dashboard'] : [])];
  const applied = new Set(Array.isArray(learned.applied) ? learned.applied : defaults);
  const appliedGroups = new Set(Array.isArray(learned.appliedGroups) ? learned.appliedGroups : []);
  const titles = learned.folderTitles && typeof learned.folderTitles === 'object' ? learned.folderTitles : {};
  const appliesTo = {
    metricPrefixes: prefixes.length ? SCOPE_FAMILIES.metricPrefixes.filter((k) => applied.has(k)) : [],
    folderUids: folders.length ? SCOPE_FAMILIES.folderUids.filter((k) => applied.has(k)) : [],
    ...(excludes.length ? { metricExclude: SCOPE_FAMILIES.metricExclude.filter((k) => applied.has(k)) } : {}),
    ...(groups.length ? { ruleGroups: SCOPE_FAMILIES.ruleGroups.filter((k) => appliedGroups.has(k)) } : {}),
  };
  const out = {
    [LIVE_SCOPE_ANNOTATION]: JSON.stringify({
      metricPrefixes: prefixes, folderUids: folders, datasourceUid: s.datasourceUid || null,
      ...(excludes.length ? { metricExclude: excludes } : {}),
      ...(groups.length ? { ruleGroups: groups } : {}),
      appliesTo,
    }),
  };
  const metricKinds = new Set([...appliesTo.metricPrefixes, ...(appliesTo.metricExclude || [])]);
  for (const kind of metricKinds) {
    out[`${SCOPE_ANNOTATION_PREFIX}${kind}`] = JSON.stringify({ by: 'prefix', values: prefixes, ...(excludes.length ? { exclude: excludes } : {}) });
  }
  const folderValues = folders.map((uid) => {
    const title = typeof titles[uid] === 'string' && titles[uid] !== '' ? titles[uid].slice(0, FOLDER_TITLE_CHARS) : null;
    return { uid, title };
  });
  const groupKinds = new Set(appliesTo.ruleGroups || []);
  for (const kind of appliesTo.folderUids) {
    out[`${SCOPE_ANNOTATION_PREFIX}${kind}`] = JSON.stringify({ by: 'folder', values: folderValues, ...(groupKinds.has(kind) ? { groups } : {}) });
  }
  for (const kind of groupKinds) {
    if (!appliesTo.folderUids.includes(kind)) out[`${SCOPE_ANNOTATION_PREFIX}${kind}`] = JSON.stringify({ by: 'group', values: groups });
  }
  return out;
}

// The rule-group names of an entry's `groups` or `values`: strings, trimmed,
// non-empty, within the scope's own rule, capped.
function groupNamesOf(list) {
  return (Array.isArray(list) ? list : [])
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v !== '' && checkGroup(v) === null)
    .slice(0, SCOPE_LIMITS.groups);
}

// A pack's scope, read back from its annotations (an adapted pack carries
// them on meta.annotations, a canonical on metadata.annotations): kind →
// { by: 'prefix', values: [prefix], exclude?: [pattern] } | { by: 'folder',
// values: [{ uid, title }], groups?: [name] } | { by: 'group', values: [name] }.
// A value that does not parse, or has no value, is ignored — the family is
// then compared as if unscoped, never parked on a guess; an exclude pattern
// that does not pass the scope's own rule is dropped the same way, and so is a
// group name.
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
      const exclude = (Array.isArray(parsed.exclude) ? parsed.exclude : [])
        .filter((v) => typeof v === 'string' && v !== '' && checkExclude(v) === null)
        .slice(0, SCOPE_LIMITS.excludes);
      if (values.length || exclude.length) {
        out.set(key.slice(SCOPE_ANNOTATION_PREFIX.length), { by: 'prefix', values, ...(exclude.length ? { exclude } : {}) });
      }
    } else if (parsed.by === 'folder') {
      const values = parsed.values
        .map((v) => (typeof v === 'string' ? { uid: v, title: null } : v))
        .filter((v) => v && typeof v.uid === 'string' && v.uid !== '')
        .map((v) => ({ uid: v.uid, title: typeof v.title === 'string' && v.title !== '' ? v.title : null }));
      const groups = groupNamesOf(parsed.groups);
      if (values.length) out.set(key.slice(SCOPE_ANNOTATION_PREFIX.length), { by: 'folder', values, ...(groups.length ? { groups } : {}) });
    } else if (parsed.by === 'group') {
      const values = groupNamesOf(parsed.values);
      if (values.length) out.set(key.slice(SCOPE_ANNOTATION_PREFIX.length), { by: 'group', values });
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
// `folderUid`; a Grafana-managed rule its `grafana.folderUid` (the adapter's
// reading of observogram.grafana_rule.*). A crawled dashboard states one only
// when the repository says where it is provisioned (its `folder` is a name).
export function folderUidOf(artefact) {
  const spec = artefact?.spec || {};
  for (const v of [spec.params?.folderUid, spec.folderUid, spec.params?.folder_uid, spec.folder_uid, artefact?.grafana?.folderUid]) {
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

// The folder TITLE a repository states for an artefact, or null: a Grafana
// provisioning file's group `folder` (a rule's `grafana.folder`), the folder a
// dashboard provider files a crawled dashboard under (`params.folderTitle`).
// Never a dashboard's `folder`, which may be a tag the crawler guessed.
export function folderTitleOf(artefact) {
  const t = artefact?.grafana?.folder ?? artefact?.spec?.params?.folderTitle;
  return typeof t === 'string' && t.trim() ? t.trim() : null;
}

// The rule group a rule artefact states, or null. A rule read from an engine
// carries `group` (the snapshot's adapters keep the group a listing names); a
// crawled rule states it only through its `source`, which the spec writes as
// `<file>#<group>/<name>` (`_` when the file's group has no name) — read back
// here, as provenance that happens to name the group, never for matching. A
// rule's name (a Grafana title) may itself carry `/`, so the name is taken
// off the end first — the rule's own `name`, never a guess at the last `/` —
// and the group is what follows the last `#` of the rest (a file path with a
// `#` reads right; a group name with one reads short, and then simply fails
// to match); a source that does not end in the rule's name says nothing.
export function ruleGroupOf(artefact) {
  const spec = artefact?.spec || {};
  if (typeof spec.group === 'string' && spec.group.trim() !== '') return spec.group.trim();
  // A Grafana-managed rule states its group beside the spec (observogram.grafana_rule.*).
  if (typeof artefact?.grafana?.group === 'string' && artefact.grafana.group.trim() !== '') return artefact.grafana.group.trim();
  const source = typeof spec.source === 'string' ? spec.source : '';
  const name = typeof spec.name === 'string' ? spec.name : '';
  if (!name || !source.endsWith(`/${name}`)) return null;
  const rest = source.slice(0, source.length - name.length - 1);
  const hash = rest.lastIndexOf('#');
  if (hash < 0) return null;
  const group = rest.slice(hash + 1).trim();
  return group === '' || group === '_' ? null : group;
}

// Whether a scope entry covers an artefact of `kind`: true (inside), false
// (outside: the snapshot did not read it) or null (the artefact does not say
// what the scope needs — a metric without a name, a dashboard without a
// folder uid, a rule without a group). No entry: true, nothing was narrowed.
// A folder entry that also names groups asks both: outside either is outside;
// inside the folders but silent on the group is not known. An artefact that
// states its folder only by TITLE (a provisioning file's rule, a provisioned
// dashboard) is inside when the live read named one of its folders so, outside
// when it named every folder and none so, and not known otherwise.
export function inScope(kind, artefact, scopeEntry) {
  if (!scopeEntry) return true;
  if (scopeEntry.by === 'prefix') {
    const names = metricNamesOf(artefact);
    if (!names.length) return null;
    const excluded = excludeMatchers(scopeEntry);
    // A name is inside when it carries a prefix (any name, when no prefix was
    // set) and no exclude pattern drops it (excludedBy: a name over the bound
    // never is): the fetcher kept exactly those.
    return names.some((n) => (scopeEntry.values.length === 0 || scopeEntry.values.some((p) => n.startsWith(p)))
      && !excludedBy(excluded, n));
  }
  if (scopeEntry.by === 'folder') {
    const uid = folderUidOf(artefact);
    const title = uid === null ? folderTitleOf(artefact) : null;
    const verdicts = [uid !== null ? scopeEntry.values.some((v) => v.uid === uid)
      : title === null ? null
        : scopeEntry.values.some((v) => v.title === title) ? true
          : scopeEntry.values.every((v) => v.title !== null) ? false : null];
    if (Array.isArray(scopeEntry.groups) && scopeEntry.groups.length) verdicts.push(groupVerdict(artefact, scopeEntry.groups));
    if (verdicts.includes(false)) return false;
    return verdicts.includes(null) ? null : true;
  }
  if (scopeEntry.by === 'group') return groupVerdict(artefact, scopeEntry.values);
  return null;
}

function groupVerdict(artefact, groups) {
  const group = ruleGroupOf(artefact);
  if (group === null) return null;
  return groups.includes(group);
}

// The compiled exclude patterns of a prefix entry, once per entry (scopeOf
// let through only patterns that pass checkExclude, so these compile).
const EXCLUDE_MATCHERS = new WeakMap();
function excludeMatchers(scopeEntry) {
  const patterns = Array.isArray(scopeEntry.exclude) ? scopeEntry.exclude : [];
  if (!patterns.length) return [];
  let compiled = EXCLUDE_MATCHERS.get(scopeEntry);
  if (!compiled) {
    compiled = [];
    for (const p of patterns) { try { compiled.push(new RegExp(p)); } catch { /* refused by checkExclude; skipped */ } }
    EXCLUDE_MATCHERS.set(scopeEntry, compiled);
  }
  return compiled;
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
// read, and that the holder pack does not say where this artefact is (or, with
// `folderTitle`, that the folder it names is not known to be one of them).
// `holder` is the side holding the artefact ('a' or 'b'). `true` has no reason.
export function scopeReason(kind, verdict, scopeEntry, { holder = 'a', folderTitle = null } = {}) {
  if (verdict === true || !scopeEntry) return null;
  const [one, many] = nounOf(kind);
  const pack = `Pack ${String(holder).toUpperCase() === 'B' ? 'B' : 'A'}`;
  if (scopeEntry.by === 'prefix') {
    const prefixes = scopeEntry.values.length ? `prefixes ${scopeEntry.values.join(', ')}` : '';
    const excluded = Array.isArray(scopeEntry.exclude) && scopeEntry.exclude.length ? `excluded ${scopeEntry.exclude.join(' ')}` : '';
    const list = [prefixes, excluded].filter(Boolean).join('; ');
    const read = [scopeEntry.values.length ? `with the prefixes ${scopeEntry.values.join(', ')}` : '', excluded ? `not matching ${scopeEntry.exclude.join(' ')}` : ''].filter(Boolean).join(' and ');
    return verdict === false
      ? `outside the snapshot's ${one} scope (${list})`
      : `the snapshot read only ${many} ${read}; ${pack} gives this ${one} no name, so it was not checked`;
  }
  if (scopeEntry.by === 'folder') {
    const list = folderNames(scopeEntry.values);
    const groups = Array.isArray(scopeEntry.groups) && scopeEntry.groups.length ? scopeEntry.groups.join(', ') : '';
    const titled = verdict === null && typeof folderTitle === 'string' && folderTitle !== '';
    if (titled) {
      return groups
        ? `the snapshot read only the folders ${list} and the rule groups ${groups}; ${pack} puts this ${one} in the folder "${folderTitle}", which is not known to be one of them, so it was not checked`
        : `the snapshot read only the folders ${list}; ${pack} puts this ${one} in the folder "${folderTitle}", which is not known to be one of them (the live read did not give every folder's title), so it was not checked`;
    }
    if (!groups) {
      return verdict === false
        ? `outside the snapshot's ${one} folders (${list})`
        : `the snapshot read only the folders ${list}; ${pack} does not say which folder this ${one} is in, so it was not checked`;
    }
    return verdict === false
      ? `outside the snapshot's ${one} scope (folders ${list}; rule groups ${groups})`
      : `the snapshot read only the folders ${list} and the rule groups ${groups}; ${pack} does not say which folder and group this ${one} is in, so it was not checked`;
  }
  if (scopeEntry.by === 'group') {
    const list = scopeEntry.values.join(', ');
    return verdict === false
      ? `outside the snapshot's ${one} groups (${list})`
      : `the snapshot read only the rule groups ${list}; ${pack} does not say which group this ${one} is in, so it was not checked`;
  }
  return null;
}
