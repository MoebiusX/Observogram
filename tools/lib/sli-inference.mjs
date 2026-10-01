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
//
// Pure ESM, no Node APIs.

import { symbolSlug } from './slug.mjs';

// `<service>:<metric>:<op>` — Prometheus recording-rule naming convention.
const RULE_NAME_RE = /^([a-z][a-z0-9_]*):([a-z][a-z0-9_]*):([a-z0-9_]+)$/;
// The compiler's policy records (`<service>:errorbudget:burn_5m|1h`, one series
// per SLO) share the metric segment `errorbudget`; it is reserved and never an SLI.
const POLICY_SEGMENT = 'errorbudget';

/** Canonical SLI id contributed by a recording rule, or null. */
export function ruleNameToSliId(name) {
  const m = RULE_NAME_RE.exec(typeof name === 'string' ? name : '');
  if (!m || m[2] === POLICY_SEGMENT) return null;
  return `${m[1]}_${m[2]}`.toLowerCase();
}

/** Canonical SLO id (`<sliId>_99`) a recording rule contributes to, or null. */
export function ruleNameToSloId(name) {
  const sliId = ruleNameToSliId(name);
  return sliId ? `${sliId}_99` : null;
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
    const sliId = `${service}_${metric}`.toLowerCase();
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
      id: `${sliId}_99`,
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
  if (wait) out.push({ short: wait, long: '6h', factor: 6, severity });
  return out;
}

const RECORDED_SERIES_RE = /[a-z][a-z0-9_]*:[a-z][a-z0-9_]*:[a-z0-9_]+/g;

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

/** The entry an alerting rule starts as, keyed by the id its NAME derives. */
export function burnCandidateFromAlertRule(rule) {
  const alertName = rule?.alert || rule?.title || rule?.name || '';
  return {
    slo: symbolSlug(alertName).replace(/-burn-?rate.*$/, '_99'),
    windows: alertRuleWindows(rule),
    expr: typeof rule?.expr === 'string' ? rule.expr : String(rule?.expr || ''),
    alertName,
  };
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
