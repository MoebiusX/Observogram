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
// Pure ESM, no Node APIs.

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
    // Ratio-shaped: we have good + total recording. The presence of
    // `ratio_*` or `error_ratio_*` confirms the ratio family.
    const goodKey = Object.keys(ops).find(k => /^good_/.test(k));
    const totalKey = Object.keys(ops).find(k => /^total_/.test(k));
    const ratioKey = Object.keys(ops).find(k => /^ratio_/.test(k) || /^error_ratio_/.test(k));
    // The compiler's threshold shape: `value_*` plus an `error_ratio_*` whose expr reads
    // the value series (`sum_over_time((max(<value series>) > bool <threshold>)[w:step]) / n`,
    // `< bool` for a floor — spec 1.3 `good_when: above`, tools/lib/burn-rules.mjs). Only that
    // shape flips to a threshold SLI, with the threshold and its direction read back from the
    // comparison; any other value_*/error_ratio_* pair keeps the ratio-family inference.
    const valueKey = Object.keys(ops).find(k => /^value_/.test(k));
    const errorRatioKey = valueKey && Object.keys(ops).find(k => /^error_ratio_/.test(k) && String(ops[k].expr || '').includes(ops[valueKey].name));
    const compiledThreshold = errorRatioKey ? /([<>]) bool (-?\d+(?:\.\d+)?)/.exec(ops[errorRatioKey].expr) : null;
    if (goodKey && totalKey) {
      sli = {
        id: sliId,
        description: `Inferred from recording rules ${service}:${metric}:good/total.`,
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
      const first = Object.values(ops)[0];
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
