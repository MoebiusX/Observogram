// tools/lib/sli-inference.mjs
//
// Shared SLI / SLO derivation from Prometheus-convention recording rules.
//
// This is the single inverse of the compiler. compile.mjs emits each SLI
// in spec.slis as recording rules named `<service>:<sli>:<op>`; reading
// those names back is the exact inverse. Both the live-system
// reconstruction (tools/fetch-live-pack.mjs) and the repo decompiler
// (tools/lib/crawler.mjs) import this module, so a pack that is compiled
// to recording rules and then reconstructed — whether from a live MCP
// server or by crawling the repo it was deployed from — round-trips to
// the SAME L1 (SLI/SLO) identities. diff.mjs keys L1 on the artefact's
// `defines` symbol (`slis.<id>`), so these ids MUST be derived identically
// on every path or the comparison reports false drift.
//
// The same holds one layer up. Which burn-rate entry an alerting rule
// contributes (the SLO it guards, its window) is derived here too, so the
// rules a repository declares and the rules a ruler reports turn into the
// SAME spec.policy.burn_rate_alerts — see burnAlertsFromAlertRules below.
// And the rules that guard no SLO — the operational alerts spec 1.4 keeps
// in spec.alerting.rules — are read into that shape here as well
// (operationalAlertRule), so a rule file and a ruler's listing of the same
// rule become the same entry, name for name.
// The third shared reading is a Grafana-managed rule's own terms
// (grafanaRuleCondition, grafanaRuleFacts): its threshold and the other
// expression steps, its uid, folder and group — what the closed AlertRule
// cannot hold — read the same way from a provisioning file, the
// provisioning API and the ruler, so the two sides compare them.
//
// Pure ESM, no Node APIs.

import { symbolSlug } from './slug.mjs';
import { normalizeSeverity } from './alert-routes.mjs';

// `<service>:<metric>:<op>` — the Prometheus recording-rule naming convention
// an SLI is read back from. The spec recommends it (a SHOULD, §5.5).
const RULE_NAME_RE = /^([a-z][a-z0-9_]*):([a-z][a-z0-9_]*):([a-z0-9_]+)$/;

// The spec's `queries.recording_rules[].name` pattern, mirrored by hand (a
// browser-safe module cannot read the schema file); tools/test-crawl-canonical.mjs
// pins the mirror.
export const SPEC_RECORDING_RULE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(:[a-zA-Z0-9_]+)+$/;

/** True when a recording rule's name is one the spec can declare: a metric name with at least one `:` and no empty segment. The one reading for the crawler and the live fetcher. */
export function isSpecRecordingRuleName(name) {
  return SPEC_RECORDING_RULE_NAME_RE.test(typeof name === 'string' ? name : '');
}

// The spec's `$defs.Duration` pattern, mirrored by hand (a browser-safe module
// cannot read the schema file); tools/test-crawl-canonical.mjs pins the mirror.
export const SPEC_DURATION_RE = /^([0-9]+(\.[0-9]+)?(ns|us|ms|s|m|h|d|w|mo|y))+$/;
// The compiler's policy records (`<service>:errorbudget:burn_5m|1h`, one series
// per SLO) share the metric segment `errorbudget`; it is reserved and never an SLI.
const POLICY_SEGMENT = 'errorbudget';

// An id a recorded name derives is a spec Slug (`$defs.Slug`, at most 64
// characters). An SLI id is cut to 61, so its SLO id, `<sli>_99`, fits
// too: every reader that strips the `_99` to find the SLI (the deploy
// verifier, chain history, lifecycle blocks) keeps working. An id cut
// ends in a fingerprint of the whole name (FNV-1a, 8 hex, as compile.mjs's
// grafanaUid does), so recorded bases that share their first characters
// (the mixins' `<labels>:<metric>_bucket|_sum|_count:*`) never become one
// id. kube-prometheus-stack's `node_namespace_pod_container:
// container_cpu_usage_seconds_total:*` gave a 65-character SLO id, a pack
// the schema refuses. The live fetch derives its ids with the same
// functions, so both sides agree; an id that fits is unchanged.
const SLI_ID_MAX = 61;
// Never all digits: those readers strip every trailing digit group (`_99_9`),
// so an all-digit hash's first digit is spelt as a letter past hex (0 → g).
const fingerprint = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  const hex = h.toString(16).padStart(8, '0');
  return /^\d+$/.test(hex) ? `${'ghijklmnop'[hex[0]]}${hex.slice(1)}` : hex;
};
/** An SLI id from its text: a spec Slug with room for its SLO's `_99`, cut with a fingerprint when it is longer. */
export function sliSlug(text) {
  const id = String(text ?? '').toLowerCase();
  return id.length <= SLI_ID_MAX
    ? id.replace(/[^a-z0-9]+$/, '')
    : `${id.slice(0, SLI_ID_MAX - 9).replace(/[^a-z0-9]+$/, '')}_${fingerprint(id)}`;
}
const sliIdOf = (service, metric) => sliSlug(`${service}_${metric}`);
const sloIdOf = (sliId) => `${sliId}_99`;

/** Canonical SLI id contributed by a recording rule, or null. */
export function ruleNameToSliId(name) {
  const m = RULE_NAME_RE.exec(typeof name === 'string' ? name : '');
  if (!m || m[2] === POLICY_SEGMENT) return null;
  return sliIdOf(m[1], m[2]);
}

/** Canonical SLO id (`<sliId>_99`) a recording rule contributes to, or null. */
export function ruleNameToSloId(name) {
  const sliId = ruleNameToSliId(name);
  return sliId ? sloIdOf(sliId) : null;
}

// Parse Prometheus-convention recording rules into SLI / SLO pairs.
// Names that follow `service:metric:op` are a strong SLO signal — the
// convention is that "SLIs are reflected in recording rules". We only
// infer SLIs from rules whose name matches the canonical ratio / latency
// shape; anything ambiguous flows through to spec.queries verbatim so the
// engineer can decide.
export function inferSlisFromRecordingRules(rules) {
  if (!Array.isArray(rules)) return [];
  // Group rules by (service, metric) — the `op` (good/total/ratio/...)
  // tells us what KIND of SLI it likely encodes.
  const byBase = new Map();
  for (const r of rules) {
    if (!r?.name) continue;
    const m = RULE_NAME_RE.exec(r.name);
    if (!m) continue;
    const [, service, metric, op] = m;
    if (metric === POLICY_SEGMENT) continue;
    const key = `${service}:${metric}`;
    if (!byBase.has(key)) byBase.set(key, { service, metric, ops: {} });
    byBase.get(key).ops[op] = r;
  }
  const out = [];
  for (const { service, metric, ops } of byBase.values()) {
    const sliId = sliIdOf(service, metric);
    let sli, slo;
    // Every choice below is made over the op names in SORTED order, never in
    // the order the rules arrived. A repository lists its rules in file
    // order and a ruler reports them in group order; picking "the first" by
    // arrival made the same rule set infer a different expression for the
    // same SLI on each side, which the diff then reported as drift.
    const opKeys = Object.keys(ops).sort();
    // Ratio-shaped: we have good + total recording. The presence of
    // `ratio_*` or `error_ratio_*` confirms the ratio family.
    const goodKey = opKeys.find(k => /^good_/.test(k));
    const totalKey = opKeys.find(k => /^total_/.test(k));
    const ratioKey = opKeys.find(k => /^ratio_/.test(k) || /^error_ratio_/.test(k));
    // The compiler's threshold shape: `value_*` plus an `error_ratio_*` whose expr reads
    // the value series (`sum_over_time((max(<value series>) > bool <threshold>)[w:step]) / n`,
    // `< bool` for a floor — spec 1.3 `good_when: above`, tools/lib/burn-rules.mjs). Only that
    // shape flips to a threshold SLI, with the threshold and its direction read back from the
    // comparison; any other value_*/error_ratio_* pair keeps the ratio-family inference.
    const valueKey = opKeys.find(k => /^value_/.test(k));
    const errorRatioKey = valueKey && opKeys.find(k => /^error_ratio_/.test(k) && String(ops[k].expr || '').includes(ops[valueKey].name));
    const compiledThreshold = errorRatioKey ? /([<>]) bool (-?\d+(?:\.\d+)?)/.exec(ops[errorRatioKey].expr) : null;
    if (goodKey && totalKey) {
      sli = {
        id: sliId,
        description: `Inferred from recording rules ${ops[goodKey].name} and ${ops[totalKey].name}.`,
        type: 'ratio',
        good:  ops[goodKey].expr,
        total: ops[totalKey].expr,
      };
    } else if (errorRatioKey) {
      sli = {
        id: sliId,
        description: `Inferred from recording rules ${ops[valueKey].name} and ${ops[errorRatioKey].name}.`,
        type: 'threshold',
        query: ops[valueKey].expr,
        threshold: compiledThreshold ? Number(compiledThreshold[2]) : 1,
        // `< bool` counts the samples UNDER the bound: a floor. Absent means below, so a ceiling states nothing.
        ...(compiledThreshold?.[1] === '<' ? { good_when: 'above' } : {}),
        ...(compiledThreshold ? {} : { unit: 'ratio' }),
      };
    } else if (ratioKey) {
      // We have a ratio recording rule directly. Treat it as the SLI's
      // canonical expression (the engineer can decompose later).
      sli = {
        id: sliId,
        description: `Inferred from recording rule ${ops[ratioKey].name}.`,
        type: 'ratio',
        good:  ops[ratioKey].expr,
        total: '1',   // placeholder; engineer to refine
      };
    } else {
      // Threshold-shaped (latency p95, queue depth, etc).
      const first = ops[opKeys[0]];
      sli = {
        id: sliId,
        description: `Inferred from recording rule ${first.name}.`,
        type: 'threshold',
        query: first.expr,
        // Spec requires a numeric threshold; we can't infer it from a
        // flat recording rule — engineer to set per the SLO objective.
        // Use 1 as the conservative placeholder; the rule's `expr` is
        // already preserved in spec.queries.recording_rules.
        threshold: 1,
        unit: 'ratio',
      };
    }
    slo = {
      id: sloIdOf(sliId),
      sli: sliId,
      objective: 0.99,
      window: '30d',
      error_budget_policy: 'ref:platform/default-budget',
    };
    out.push({ sli, slo });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Alerting rules -> spec.policy.burn_rate_alerts
//
// The compiler only ever emits a burn-rate alert FROM an SLO, on top of the
// SLO's recorded series. The inverse therefore reads an alerting rule as a
// burn-rate entry only when its expression references a recorded series
// (`ns:metric:op`) that already produced an SLO: the entry binds to that
// SLO. An operational alert (CPU, disk, queue down) references none and is
// not an SLO contract.
//
// The repo crawler (rule files) and the live fetcher (the ruler's API) both
// go through these helpers, so one rule set yields one policy whichever way
// it was read.
// ---------------------------------------------------------------------------

const DURATION_UNIT_SECONDS = { ms: 1e-3, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };

/**
 * A rule's `for` in one spelling: `120s`, `2m` and the ruler's `120`
 * (seconds) are the same wait. Returns the Prometheus duration with the
 * largest unit that divides it exactly; null when there is no wait (absent
 * or zero). A string that is not a duration is returned as it stands.
 */
export function canonicalRuleDuration(value) {
  let seconds = null;
  if (typeof value === 'number') seconds = value;
  else if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) seconds = Number(value);
  else if (typeof value === 'string') {
    let total = 0;
    let rest = value.trim();
    const re = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)/;
    while (rest) {
      const m = re.exec(rest);
      if (!m) return value.trim() || null;
      total += Number(m[1]) * DURATION_UNIT_SECONDS[m[2]];
      rest = rest.slice(m[0].length);
    }
    seconds = total;
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  for (const [unit, size] of [['w', 604800], ['d', 86400], ['h', 3600], ['m', 60]]) {
    if (seconds % size === 0) return `${seconds / size}${unit}`;
  }
  return Number.isInteger(seconds) ? `${seconds}s` : `${Math.round(seconds * 1000)}ms`;
}

/**
 * The single window an alerting rule states: its `for` and its severity.
 * Multi-window decomposition cannot be recovered from one rule; what is
 * there is recorded and the caller fills the rest (defaultBurnWindows).
 */
export function alertRuleWindows(rule) {
  const out = [];
  const sev = rule?.labels?.severity?.toString()?.toUpperCase();
  const severity = /^SEV[123]$/.test(sev) ? sev : 'SEV2';
  const wait = canonicalRuleDuration(rule?.for);
  // A wait that is no spec Duration — a value a chart or a deploy step fills
  // in (`for: {{ .Values.pageFor }}`, `${PAGE_FOR}`) — gives no window: the
  // caller fills the rest (defaultBurnWindows) and the scan says it left the
  // wait out (summary.omitted.ruleWaits). A live wait is a number of seconds.
  if (wait && SPEC_DURATION_RE.test(wait)) out.push({ short: wait, long: '6h', factor: 6, severity });
  return out;
}

// Every recorded series an expression names, whole: only a whole name is looked
// up, so a four-segment or mixed-case name never answers for an SLO by a part of it.
const RECORDED_SERIES_RE = /[a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z0-9_]+)+/g;

/**
 * The SLO an alert expression guards: the first recorded series it
 * references whose SLO `hasSlo` knows. Null when it references none.
 */
export function recordedSloForExpr(expr, hasSlo) {
  if (typeof expr !== 'string' || !expr) return null;
  for (const m of expr.matchAll(RECORDED_SERIES_RE)) {
    const sloId = ruleNameToSloId(m[0]);
    if (sloId && hasSlo(sloId)) return sloId;
  }
  return null;
}

// Grafana expression-node types: a `data[]` node of one of these is a
// reduce / math / threshold step over another node, not the query itself.
const GRAFANA_EXPRESSION_TYPES = new Set(['reduce', 'math', 'threshold', 'classic_conditions', 'resample', 'sql']);

/** A Grafana-managed (unified alerting) rule as provisioning YAML or the ruler API spells it: `title` + `data[]`. */
export function isGrafanaManagedRule(rule) {
  return !!rule && typeof rule === 'object' && typeof rule.title === 'string' && Array.isArray(rule.data);
}

// A Grafana data node's `model`: an object in provisioning YAML, sometimes a
// JSON string on the wire. Unparseable is `null`, never a throw — one bad
// node must not lose the rule.
function grafanaModel(node) {
  const m = node?.model;
  if (m && typeof m === 'object') return m;
  if (typeof m === 'string') { try { return JSON.parse(m); } catch { return null; } }
  return null;
}

/**
 * The condition an alerting rule evaluates, in the engine's own words.
 * A Prometheus or Loki rule says it in `expr`. A Grafana-managed rule
 * says it in its query node (`data[].model.expr`, the first node that is
 * not an expression step); a rule built from expression nodes only has no
 * query text, and its `condition` reference (`C`) stands for it, as spec
 * 1.4 §5.8 allows. Empty when the rule states none.
 */
export function alertRuleExpr(rule) {
  if (typeof rule?.expr === 'string' && rule.expr.trim()) return rule.expr;
  if (rule?.expr != null && typeof rule.expr !== 'object') return String(rule.expr);
  if (typeof rule?.query === 'string' && rule.query.trim()) return rule.query;
  if (Array.isArray(rule?.data)) {
    for (const node of rule.data) {
      const model = grafanaModel(node);
      if (!model || typeof model.expr !== 'string' || !model.expr.trim()) continue;
      if (GRAFANA_EXPRESSION_TYPES.has(model.type) || node?.datasourceUid === '__expr__' || model.datasource?.uid === '__expr__') continue;
      return model.expr;
    }
    if (typeof rule.condition === 'string' && rule.condition.trim()) return rule.condition.trim();
    const first = rule.data.find(n => typeof n?.refId === 'string' && n.refId.trim())?.refId;
    if (first) return first.trim();
  }
  return '';
}

// ---- A Grafana-managed rule's own terms ----
//
// The threshold of a Grafana-managed rule is not in its query: it sits in an
// expression node (`threshold`, `classic_conditions`, …) beside it, and the
// condition reference names the node that alerts. `alertRuleExpr` reads the
// query alone, so a threshold changed in Grafana read as the same rule.
// grafanaRuleCondition states every step from the query to the alert as one
// text, the same for a provisioning file, the provisioning API and the ruler.
// What it leaves out on purpose: a query's time range and datasource uid (per
// environment), the no-data and error states, keep_firing_for and the
// notification settings — a file that omits one and a Grafana that defaults it
// would read as a difference that is not there.
const GRAFANA_CONDITION_MAX = 2000;
const EVALUATOR_OPS = Object.freeze({ gt: '>', lt: '<', gte: '>=', lte: '<=', eq: '==', ne: '!=' });
const RANGE_EVALUATORS = Object.freeze({
  within_range: 'within', outside_range: 'outside',
  within_range_included: 'within (included)', outside_range_included: 'outside (included)',
});
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// A threshold's number as both readers print it, or null when the value is
// none: a placeholder a chart fills in at deploy time (the scan reads a Helm
// template's `{{ .Values.x }}` as `helmvalue`), a `${VAR}` a deploy step
// substitutes, an empty or missing param. Such a node states no threshold, so
// the rule states no condition (never `NaN`, which reads as a difference from
// the number Grafana runs).
const numberText = (x) => {
  if (typeof x === 'number') return Number.isFinite(x) ? String(x) : null;
  if (typeof x === 'string' && x.trim() && Number.isFinite(Number(x))) return String(Number(x));
  return null;
};

// JSON with its keys sorted at every depth: one text for one value, whatever
// order a side wrote its keys in.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// An evaluator as text, or null when a number it needs is not stated (numberText).
function evaluatorText(ev) {
  const type = oneLine(ev?.type);
  const params = Array.isArray(ev?.params) ? ev.params : [];
  const stated = (...xs) => (xs.every((x) => x !== null) ? xs : null);
  if (EVALUATOR_OPS[type]) {
    const n = stated(numberText(params[0]));
    return n ? `${EVALUATOR_OPS[type]} ${n[0]}` : null;
  }
  if (RANGE_EVALUATORS[type]) {
    const n = stated(numberText(params[0]), numberText(params[1]));
    return n ? `${RANGE_EVALUATORS[type]} ${n[0]}..${n[1]}` : null;
  }
  if (type === 'no_value') return 'no value';
  const n = stated(...params.map(numberText));
  return n ? `${type || '?'}${n.length ? ` ${n.join(' ')}` : ''}` : null;
}

const isExpressionNode = (node, model) => node?.datasourceUid === '__expr__' || model?.datasource?.uid === '__expr__' || GRAFANA_EXPRESSION_TYPES.has(model?.type);

const without = (model, keys) => Object.fromEntries(Object.entries(model || {}).filter(([k]) => !keys.includes(k)));
const NODE_PLUMBING = ['refId', 'datasource', 'intervalMs', 'maxDataPoints', 'hide'];

// An expression node as text, or null when a number it needs is not stated (numberText).
function expressionText(model) {
  const type = oneLine(model?.type);
  const input = oneLine(model?.expression);
  if (type === 'threshold') {
    const c = Array.isArray(model?.conditions) ? model.conditions[0] : null;
    const alert = evaluatorText(c?.evaluator);
    const back = c?.unloadEvaluator ? evaluatorText(c.unloadEvaluator) : '';
    if (alert === null || back === null) return null;
    return `threshold(${input} ${alert}${back ? `, recover ${back}` : ''})`;
  }
  if (type === 'reduce') {
    const mode = oneLine(model?.settings?.mode);
    const replaceWith = mode === 'replaceNN' ? numberText(model.settings.replaceWithValue) : '';
    if (replaceWith === null) return null;
    const how = mode === 'replaceNN' ? `, replaceNN ${replaceWith}` : mode ? `, ${mode}` : '';
    return `reduce(${oneLine(model?.reducer) || '?'}, ${input}${how})`;
  }
  if (type === 'math') return `math(${input})`;
  if (type === 'sql') return `sql(${input})`;
  if (type === 'resample') return `resample(${input}, ${oneLine(model?.window)}, ${oneLine(model?.downsampler)}, ${oneLine(model?.upsampler)})`;
  if (type === 'classic_conditions') {
    const parts = (Array.isArray(model?.conditions) ? model.conditions : []).map((c, i) => {
      const op = i === 0 ? '' : `${oneLine(c?.operator?.type) || 'and'} `;
      const ref = Array.isArray(c?.query?.params) ? oneLine(c.query.params[0]) : '';
      const ev = evaluatorText(c?.evaluator);
      return ev === null ? null : `${op}${oneLine(c?.reducer?.type) || '?'}(${ref}) ${ev}`;
    });
    return parts.includes(null) ? null : `classic(${parts.join(' ')})`;
  }
  return `${type || 'expression'}(${canonicalJson(without(model, NODE_PLUMBING))})`;
}

function queryText(model) {
  if (typeof model?.expr === 'string' && model.expr.trim()) return oneLine(model.expr);
  return canonicalJson(without(model, [...NODE_PLUMBING, 'instant', 'range', 'editorMode', 'legendFormat']));
}

/**
 * What a Grafana-managed rule does beyond its query, as one text: each
 * expression node (`<ref> = threshold(B > 0.5)`, `reduce(last, A)`, `math(…)`,
 * `classic(…)`, `resample(…)`, `sql(…)`), each query but the one `expr` already
 * states (`<ref> = query(…)`), the condition reference (`condition C`) and
 * `paused` — joined with `; `, cut at 2000 characters. The rule as a
 * provisioning file or the provisioning API spells it, or the ruler's
 * (`grafana_alert`). Null when the rule is not Grafana-managed, states none of
 * it, or a node cannot be read (a model that does not parse, a node with no ref,
 * a threshold or replacement value that is not a number — a chart's or a
 * deploy step's placeholder: the repository does not state what Grafana runs).
 */
export function grafanaRuleCondition(rule) {
  const r = rule?.grafana_alert && typeof rule.grafana_alert === 'object' ? rule.grafana_alert : rule;
  if (!r || typeof r !== 'object' || !Array.isArray(r.data) || !r.data.length) return null;
  let queryRef = null;
  for (const node of r.data) {
    const model = grafanaModel(node);
    if (!model || typeof model.expr !== 'string' || !model.expr.trim() || isExpressionNode(node, model)) continue;
    queryRef = oneLine(node?.refId ?? model.refId);
    break;
  }
  const parts = [];
  for (const node of r.data) {
    const model = grafanaModel(node);
    if (!model) return null;
    const ref = oneLine(node?.refId ?? model.refId);
    if (!ref) return null;
    if (isExpressionNode(node, model)) {
      const step = expressionText(model);
      if (step === null) return null;
      parts.push(`${ref} = ${step}`);
    } else if (ref !== queryRef) parts.push(`${ref} = query(${queryText(model)})`);
  }
  const condition = oneLine(r.condition);
  if (condition) parts.push(`condition ${condition}`);
  if (r.isPaused === true || r.is_paused === true) parts.push('paused');
  if (!parts.length) return null;
  const text = parts.join('; ');
  return text.length > GRAFANA_CONDITION_MAX ? `${text.slice(0, GRAFANA_CONDITION_MAX - 1)}…` : text;
}

/**
 * What a Grafana-managed rule states that spec 1.4's closed AlertRule cannot
 * hold: { uid?, folder?, folderUid?, group?, condition? }. `where` gives what a
 * provisioning file states on the rule's group, not the rule (the folder — a
 * title — the folder uid, the group's name); else the rule's own `folderUID` /
 * `namespace_uid`, `ruleGroup` / `rule_group`. A rule a reader already read
 * carries it as `grafana`. A value over its length (uid and folder uid 100,
 * folder and group 190) is left out. Null for a rule that is not
 * Grafana-managed, or one that states none of it.
 */
export function grafanaRuleFacts(rule, where = {}) {
  if (rule?.grafana && typeof rule.grafana === 'object' && !Array.isArray(rule.grafana)) return rule.grafana;
  const r = rule?.grafana_alert && typeof rule.grafana_alert === 'object' ? rule.grafana_alert : rule;
  if (!isGrafanaManagedRule(r)) return null;
  const text = (v, max) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);
  const out = {};
  const uid = text(r.uid, 100);
  const folder = text(where?.folder, 190);
  const folderUid = text(where?.folderUid ?? r.folderUID ?? r.namespace_uid, 100);
  const group = text(where?.group ?? r.ruleGroup ?? r.rule_group, 190);
  const condition = grafanaRuleCondition(r);
  if (uid) out.uid = uid;
  if (folder) out.folder = folder;
  if (folderUid) out.folderUid = folderUid;
  if (group) out.group = group;
  if (condition) out.condition = condition;
  return Object.keys(out).length ? out : null;
}

/** The entry an alerting rule starts as, keyed by the id its NAME derives. */
export function burnCandidateFromAlertRule(rule) {
  const alertName = rule?.alert || rule?.title || rule?.name || '';
  return {
    slo: symbolSlug(alertName).replace(/-burn-?rate.*$/, '_99'),
    windows: alertRuleWindows(rule),
    expr: alertRuleExpr(rule),
    alertName,
  };
}

// A label / annotation map as the schema wants it: string values only.
function stringMap(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

/**
 * An operational (non-SLO) alert rule as spec 1.4 `alerting.rules[]`
 * declares it, read from a rule as a rule file (`alert:` / `title:`) or a
 * ruler (`name`, `query`, `duration`) spells it — the one reading for the
 * repository and for live, so the two sides pair by name:
 *   name        the rule's exact name (the join key; never slugged)
 *   expr        alertRuleExpr: PromQL / LogQL, or a Grafana query node
 *   severity    the pack's SEV1..SEV4 from labels.severity (normalizeSeverity),
 *               only when the rule states a severity label
 *   for         canonicalRuleDuration: `600s` in a file and `duration: 600`
 *               from a ruler are one `10m`; none / zero is omitted
 *   labels, annotations   verbatim (string values), the engine's severity
 *               word among them
 *   engine, source        what the caller knows: the evaluator and the
 *               provenance (`<file>#<group>/<name>`)
 * Null when the rule has no name or no expression — nothing to declare.
 */
export function operationalAlertRule(rule, { engine, source } = {}) {
  const name = String(rule?.alert ?? rule?.title ?? rule?.name ?? '').trim();
  const expr = alertRuleExpr(rule).trim();
  if (!name || !expr) return null;
  const out = { name, expr };
  const labels = stringMap(rule?.labels);
  const annotations = stringMap(rule?.annotations);
  if (labels.severity) out.severity = normalizeSeverity(labels.severity);
  const wait = canonicalRuleDuration(rule?.for ?? rule?.duration);
  if (wait) out.for = wait;
  if (Object.keys(labels).length) out.labels = labels;
  if (Object.keys(annotations).length) out.annotations = annotations;
  if (engine) out.engine = engine;
  if (source) out.source = source;
  return out;
}

/**
 * Operational rules among `rules`: the ones whose expression references
 * no recorded series of an SLO `hasSlo` knows — the complement of the
 * burn-rate classification (recordedSloForExpr), so a rule is one or the
 * other, never both. Each is read with operationalAlertRule; `engineOf`
 * and `sourceOf` supply what only the caller knows. Rules with no name or
 * expression are skipped and returned in `skipped`; `keptRules` holds the
 * rule each `kept` entry was read from, in the same order.
 */
export function operationalAlertRules(rules, hasSlo, { engineOf = () => undefined, sourceOf = () => undefined } = {}) {
  const kept = [];
  const keptRules = [];
  const skipped = [];
  for (const rule of rules || []) {
    if (recordedSloForExpr(alertRuleExpr(rule), hasSlo)) continue;
    const entry = operationalAlertRule(rule, { engine: engineOf(rule), source: sourceOf(rule) });
    if (entry) { kept.push(entry); keptRules.push(rule); }
    else skipped.push(String(rule?.alert ?? rule?.title ?? rule?.name ?? '').trim() || '(unnamed)');
  }
  return { kept, skipped, keptRules };
}

/**
 * The alerting rules a reading folds into burn-rate entries, each with its
 * own terms, by the SLO it guards.
 *
 * A burn-rate entry keeps { slo, windows } and nothing else (the spec closes
 * it), and its windows are the reading's — a rule's `for` as `short`, the
 * rest constants, the default pair when fewer than two survive. Nothing of
 * the rule itself is left there: its expression (the threshold), its wait
 * and its severity. So both readings state, beside the entry, the rules it
 * was read from (`observogram.source_rules.<symbol>`, artefact-model.mjs),
 * and the comparison holds each to its counterpart as it holds an
 * operational rule.
 *
 * The rules are exactly the ones operationalAlertRules leaves out: named,
 * with an expression that references a recorded series of an SLO `hasSlo`
 * knows. Decided rule by rule, never from the fold's candidates — those keep
 * the first rule of a name and drop the others. Each is read with
 * operationalAlertRule, the one reading of a rule's terms for a rule file
 * and for a ruler's listing, and reduced to what is compared:
 *   { name, expr, for?, severity?, labels?, condition?, engine? }
 * (`condition`: a Grafana-managed rule's threshold and other steps,
 * grafanaRuleCondition, when the rule states them; `engine: 'grafana'` for a
 * Grafana-managed rule — the store it lives in, which a comparison reads
 * against the stores the other side's read did not cover, never a term held
 * to its counterpart.)
 * `partialOf(rule)` adds what the reader was shown of the rule only in part,
 * in the shape an artefact's `partial` has (`{ labels: [keys shown] }`).
 *
 * Returns Map<sloId, terms[]>, each list sorted by the rules' own content
 * (name, expression, wait, severity, labels), so a rule file and a listing
 * that hold the same rules state the same list whatever order they give them in.
 */
export function sourceRuleTerms(rules, hasSlo, { partialOf = () => null } = {}) {
  const bySlo = new Map();
  for (const rule of rules || []) {
    const read = operationalAlertRule(rule);
    if (!read) continue;
    const slo = recordedSloForExpr(alertRuleExpr(rule), hasSlo);
    if (!slo) continue;
    const terms = { name: read.name, expr: read.expr };
    if (read.for) terms.for = read.for;
    if (read.severity) terms.severity = read.severity;
    if (read.labels) terms.labels = read.labels;
    const facts = grafanaRuleFacts(rule);
    if (facts?.condition) terms.condition = facts.condition;
    if (facts) terms.engine = 'grafana';
    const partial = partialOf(rule);
    if (partial && typeof partial === 'object' && !Array.isArray(partial) && Object.keys(partial).length) terms.partial = partial;
    if (!bySlo.has(slo)) bySlo.set(slo, []);
    bySlo.get(slo).push(terms);
  }
  const byText = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const labelsOf = (r) => JSON.stringify(Object.entries(r.labels || {}).sort(([x], [y]) => byText(x, y)));
  for (const list of bySlo.values()) {
    list.sort((x, y) => byText(x.name, y.name) || byText(x.expr, y.expr) || byText(x.for || '', y.for || '')
      || byText(x.severity || '', y.severity || '') || byText(labelsOf(x), labelsOf(y)) || byText(x.condition || '', y.condition || '')
      || byText(x.engine || '', y.engine || ''));
  }
  return bySlo;
}

/**
 * Fold entries that share an SLO into one, unioning their windows
 * (de-duplicated by short/long/factor). MUTATES and returns `alerts`.
 */
export function mergeBurnAlertsBySlo(alerts) {
  const bySlo = new Map();
  for (const a of alerts) {
    if (!bySlo.has(a.slo)) { bySlo.set(a.slo, a); continue; }
    const tgt = bySlo.get(a.slo);
    const seen = new Set((tgt.windows || []).map(w => `${w.short}|${w.long}|${w.factor}`));
    for (const w of a.windows || []) {
      const k = `${w.short}|${w.long}|${w.factor}`;
      if (!seen.has(k)) { tgt.windows.push(w); seen.add(k); }
    }
    a._drop = true;
  }
  for (let i = alerts.length - 1; i >= 0; i--) {
    if (alerts[i]._drop) alerts.splice(i, 1);
  }
  return alerts;
}

/** The two-window default an entry takes when its rules state fewer than two. */
export function defaultBurnWindows() {
  return [
    { short: '5m',  long: '1h', factor: 14, severity: 'SEV1' },
    { short: '30m', long: '6h', factor: 6,  severity: 'SEV2' },
  ];
}

/**
 * Alerting rules -> burn-rate entries bound to recorded SLOs.
 *
 * `rules` are alerting rules in discovery order ({ alert | title | name,
 * expr, for, labels }); `hasSlo(id)` says which SLO ids exist. A rule name
 * seen twice contributes once (the first), exactly as the crawler reads a
 * rule file. Returns { alerts: [{ slo, windows, alertNames }], unlinked }
 * where `unlinked` names the rules that guard no recorded SLO.
 */
export function burnAlertsFromAlertRules(rules, hasSlo) {
  const candidates = [];
  for (const rule of rules || []) {
    const c = burnCandidateFromAlertRule(rule);
    if (!c.alertName || candidates.some(x => x.slo === c.slo)) continue;
    candidates.push(c);
  }
  const linked = [];
  const unlinked = [];
  const names = new Map();
  for (const c of candidates) {
    const slo = recordedSloForExpr(c.expr, hasSlo);
    if (!slo) { unlinked.push(c.alertName); continue; }
    linked.push({ slo, windows: c.windows });
    names.set(slo, [...(names.get(slo) || []), c.alertName]);
  }
  mergeBurnAlertsBySlo(linked);
  for (const a of linked) {
    a.alertNames = names.get(a.slo) || [];
    if (!a.windows || a.windows.length < 2) a.windows = defaultBurnWindows();
  }
  return { alerts: linked, unlinked };
}
