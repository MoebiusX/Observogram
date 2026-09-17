// tools/lib/compile.mjs
//
// Canonical ObservabilityPack v1.2 → real, ingestable platform artefacts.
//
// The pack is the source of truth. This module compiles it into the
// native formats the platform actually runs on:
//
//   prometheus-rules   Prometheus recording + multi-window burn-rate alerts
//                      (policy PromQL from ./burn-rules.mjs; the per-SLO and
//                      Grafana-managed files are slices of the same builders,
//                      so a per-SLO file carries keep_firing_for exactly where
//                      the full file does, gated by the same profile knob)
//   otel-collector     OTel Collector config (receivers/processors/exporters)
//   alertmanager       Alertmanager route tree + receivers
//   grafana-dashboard  Grafana 12/13 dashboard JSON (one pack section per call)
//
// Two policy facts that cross artefacts:
//   - Forecast alerts carry the severity of their `on_projected_breach`
//     (page_oncall → SEV1, open_ticket → SEV2, else SEV3; burn-rules.mjs
//     deviation 5) instead of a fixed SEV3, and compileAlertmanager routes on
//     `severity` (`group_by: [slo, severity, alertname]`, `repeat_interval` 1h
//     for SEV1): a forecast declared page_oncall reaches the SEV1 receiver and
//     repeats hourly, exactly as its declaration asks. A pack that wants
//     forecasts on a ticket channel declares them open_ticket / post_warning.
//     Forecast rules also carry `kind: forecast` for a pack route to match on.
//   - `<svc>:<sli>:error_ratio_5m` is recorded only for SLIs the policy can
//     express (bad-over-expected samples or bad-over-happened events); an SLI
//     without an error-ratio form has no such record (the former `1 - ratio_5m`
//     fallback was empty during a 100 % outage and is not emitted any more).
//
// Pure ESM, browser-friendly. No Node APIs.
//
// The unifying contract:
//
//   compile(canonical, target, opts) → {
//     contentType: 'application/x-yaml' | 'application/json',
//     filename: '<service>.<target>.<ext>',
//     content: '<string>',
//   }
//
// Per-target functions are exported too so the UI can render previews
// without going through the dispatcher.

import { emit as emitYaml } from './mini-yaml.mjs';
import { resolveProfile } from './profiles.mjs';
import { fileSlug as slug } from './slug.mjs';
import {
  metricSafe, metricPrefix, packStepSeconds, sliLegs, burnAlertExpr, errorBudgetRecordingRules,
  sliErrorRatioRule, forecastExpr, forecastHorizon, forecastSeverity, forFor, MIN_BAD_SAMPLES,
} from './burn-rules.mjs';

// ============================================================
// Helpers — ref resolution, slug normalisation, expression building
// ============================================================

const RATE_WINDOW_RECORD = '5m';   // default record window for ratio SLIs
const RECORDING_INTERVAL = '30s';  // the `<svc>_recording` group interval
const RECORDING_INTERVAL_SEC = 30; // the sample step of every <svc>:<sli>:value_5m series
const DEFAULT_DATASOURCE_UID = '${DS_PROMETHEUS}';
// `0.014` from 14 × 0.001: fixed six decimals, trailing zeros trimmed.
const fmt = (x) => Number(x).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');

// ------------------------------------------------------------
// Version resolution — find the declared product version a target should be
// compiled against, then resolve its profile. The version is read from the
// pack (the backend serving a signal, or a dashboard's provider) and can be
// overridden explicitly via opts (e.g. the deploy UI's targetVersion).
// ------------------------------------------------------------

// The declared version of the backend serving a given signal (metrics/logs/
// traces/profiles). This is the product the artefact actually lands on.
function backendForSignal(canonical, signal) {
  const bs = canonical?.spec?.telemetry?.backends || [];
  return bs.find((b) => b.signal === signal) || null;
}

// Resolve the profile for a target family from the pack's declared versions,
// honouring an explicit override. `opts.product` / `opts.version` win; then we
// read the version from the most relevant declared backend/provider.
function profileForTarget(canonical, family, opts = {}) {
  if (opts.product || opts.version) {
    return resolveProfile(opts.product || family, opts.version);
  }
  switch (family) {
    case 'grafana-dashboard':
    case 'grafana': {
      const dash = (canonical?.spec?.dashboards || [])[0];
      return resolveProfile(dash?.provider?.kind || 'grafana', dash?.provider?.version);
    }
    case 'grafana-managed':
      return resolveProfile('grafana-managed', opts.version);
    case 'prometheus-rules':
    case 'prometheus': {
      const b = backendForSignal(canonical, 'metrics');
      return resolveProfile(b?.product || 'prometheus', b?.version?.declared);
    }
    case 'alertmanager': {
      const b = (canonical?.spec?.telemetry?.backends || []).find((x) => /alertmanager/i.test(x.product || ''));
      return resolveProfile('alertmanager', b?.version?.declared);
    }
    case 'otel-collector': {
      // The collector version is declared on the otel block when present.
      const v = canonical?.spec?.otel?.collector?.version || canonical?.spec?.pipelines?.collector_version;
      return resolveProfile('otel-collector', v);
    }
    default:
      return resolveProfile(family, opts.version);
  }
}

function nameOf(canonical) {
  return canonical?.metadata?.name || canonical?.metadata?.bindings?.service || 'pack';
}

// Metric-name prefix of the pack (`payment-service` → `payment_service`); shared with
// burn-rules.mjs so both generators name the same series.
function serviceSlug(canonical) {
  return metricPrefix(nameOf(canonical));
}

function findSli(canonical, sliId) {
  if (!sliId) return null;
  const id = String(sliId).replace(/^slis\./, '');
  return (canonical?.spec?.slis || []).find(x => x.id === id) || null;
}

function findSlo(canonical, sloId) {
  if (!sloId) return null;
  // `ref:slos.x`, `slos.x` and `x` all name the SLO x.
  const id = String(sloId).replace(/^ref:/, '').replace(/^slos\./, '');
  return (canonical?.spec?.slos || []).find(x => x.id === id) || null;
}

// Materialise an SLI's value as PromQL — used in recording rules and as
// the substitution target for `ref:slis.X` in any expression.
function sliExpression(sli) {
  if (!sli) return null;
  if (sli.type === 'ratio') {
    if (!sli.good || !sli.total) return null;
    return `(\n  ${strip(sli.good)}\n) / (\n  ${strip(sli.total)}\n)`;
  }
  if (sli.type === 'threshold' || sli.type === 'distribution') {
    return strip(sli.query);
  }
  if (sli.type === 'custom') return strip(sli.expression);
  return null;
}

function strip(s) {
  if (s == null) return '';
  return String(s).replace(/\n\s*$/g, '').trim();
}

// The policy PromQL (error ratios, burn-rate alert expressions, error-budget
// records, forecasts) comes from ./burn-rules.mjs: the forms measured on a live
// queue manager. Nothing in this module builds a burn expression itself.

// Substitute `ref:slis.X` and `ref:slos.X` in an expression with their
// materialised PromQL. The recording-rule shorthand the spec encourages.
function resolveRefs(expr, canonical) {
  if (typeof expr !== 'string') return expr;
  // Id class is deliberately wider than ASCII: pack ids may carry
  // unicode (the spec doesn't forbid it), and a ref the regex skips
  // stays in the output as literal `ref:slis.x` — invalid PromQL.
  return expr.replace(/ref:slis\.([a-zA-Z0-9_\--￿]+)/g, (_, id) => {
    const e = sliExpression(findSli(canonical, id));
    return e ? `(${e})` : `ref:slis.${id}`;
  }).replace(/ref:slos\.([a-zA-Z0-9_\--￿]+)/g, (_, id) => {
    // SLO recording-rule references resolve to the SLO's underlying SLI
    // ratio; the resolved expression is "the SLI value".
    const slo = findSlo(canonical, id);
    const sli = slo ? findSli(canonical, slo.sli) : null;
    const e = sliExpression(sli);
    return e ? `(${e})` : `ref:slos.${id}`;
  });
}

// Convert a duration like "5m", "1h", "6h", "1d" to its integer value in
// seconds. Used to drive `for:` durations and window arithmetic.
const DURATION_UNITS = { ns: 1e-9, us: 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600, d: 86400, w: 604800, mo: 2628000, y: 31536000 };
function durationSeconds(d) {
  if (typeof d !== 'number' && typeof d !== 'string') return null;
  if (typeof d === 'number') return d;
  let total = 0;
  const re = /([0-9]+(?:\.[0-9]+)?)(ns|us|ms|s|m|h|d|w|mo|y)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    total += parseFloat(m[1]) * (DURATION_UNITS[m[2]] || 0);
  }
  return total || null;
}

// ============================================================
// 1) Prometheus rules — recording + burn-rate alerts
// ============================================================

// The policy context every rules builder reads: naming, the profile's
// keep_firing_for gate, the sample step, lab/production `for:` durations,
// the min-bad-samples floor, runbooks and a de-duplicating warning sink.
//   opts.step           seconds between raw samples (default: the pack's smallest
//                       scrape_interval, else 30) — baked into state-style legs only
//   opts.lab            lab `for:` durations (30s / 2m / 5m) instead of 2m / 5m / 10m
//   opts.minBadSamples  floor on the short window (default MIN_BAD_SAMPLES)
//   opts.runbooks       { sliId: url } for the runbook annotation
//   opts.onWarning      (msg) => void, called once per distinct message
//   opts.keepFiringFor  overrides the profile knob
function policyContext(canonical, opts = {}) {
  const profile = opts.profile || profileForTarget(canonical, 'prometheus-rules', opts);
  const sink = typeof opts.onWarning === 'function' ? opts.onWarning : null;
  const seen = new Set();
  return {
    svc: serviceSlug(canonical),
    service: nameOf(canonical),
    keepFiringFor: opts.keepFiringFor ?? !!profile.knobs.keepFiringFor,
    step: Number(opts.step) || packStepSeconds(canonical),
    // without an explicit step, state-style legs are sampled at the scrape interval of the job
    // they select (burn-rules.mjs sliStepSeconds); the pack is what that lookup reads
    stepPack: Number(opts.step) ? null : canonical,
    lab: !!opts.lab,
    minBadSamples: opts.minBadSamples ?? MIN_BAD_SAMPLES,
    runbooks: opts.runbooks || {},
    warn: (m) => { if (!sink || seen.has(m)) return; seen.add(m); sink(m); },
  };
}
// Threshold SLIs are read from the compiler's own recorded value series, sampled
// at the recording interval (30 s): a 15 s subquery would read each recorded point
// twice and a single bad point would satisfy the two-sample floor.
const thresholdSeries = (ctx, sli) => `${ctx.svc}:${metricSafe(sli.id)}:value_${RATE_WINDOW_RECORD}`;
const legsCtx = (ctx, sli) => ({ step: ctx.step, pack: ctx.stepPack, series: thresholdSeries(ctx, sli), seriesStep: RECORDING_INTERVAL_SEC, warn: ctx.warn });
// An SLO takes part in the policy when its SLI has an error-ratio form and it has a budget.
const policyEligible = (slo, sli, ctx) => !!sli && (1 - slo.objective) > 0 && !!sliLegs(sli, RATE_WINDOW_RECORD, legsCtx(ctx, sli));

export function compilePrometheusRules(canonical, opts = {}) {
  const ctx = policyContext(canonical, opts);
  const svc = ctx.svc;
  const groups = [];

  // ----- recording rules -----
  // (a) Per-SLO rules at the standard record window: the SLI's own series
  // (good/total/ratio or value) followed by the policy records the burn
  // alerts, forecasts and dashboards read (<sli>:error_ratio_5m once per SLI,
  // errorbudget:burn_5m / burn_1h per SLO). Prometheus commits each rule's
  // samples before evaluating the next in the group, so the error-budget rules
  // may read value_5m from the same group.
  // (b) Author-declared recording rules — resolve symbolic refs. A declared rule that
  // names a generated record with the same label set (a pack that pasted the
  // generator's --pack-snippet) wins over the generated one: Prometheus rejects two
  // rules writing one series (promtool: "duplicate rule(s) found").
  const declaredRules = declaredRecordingRules(canonical);
  const recordingRules = [
    ...dedupeGeneratedRecords(
      (canonical?.spec?.slos || []).flatMap(slo => buildRecordingRulesForSlo(canonical, slo, ctx)), declaredRules, ctx),
    ...declaredRules,
  ];

  if (recordingRules.length) {
    groups.push({
      name: `${svc}_recording`,
      interval: RECORDING_INTERVAL,
      rules: recordingRules,
    });
  }

  // ----- burn-rate alerts -----
  // The pack expresses these declaratively as (slo, [{short, long, factor,
  // severity}]). We emit one alert per window: multi-window correlation
  // (short AND long both burning at factor×budget, plus the min-bad-samples
  // floor on the short window) per the Google SRE burn-rate playbook.
  for (const ba of canonical?.spec?.policy?.burn_rate_alerts || []) {
    const slo = findSlo(canonical, ba.slo);
    if (!slo) continue;
    const rules = buildBurnRateAlertsForSlo(canonical, slo, ba, ctx);
    if (rules.length) {
      groups.push({
        name: `${svc}_${slo.id}_burn`,
        interval: '30s',
        rules,
      });
    }
  }

  // ----- forecast alerts -----
  // The spec carves a separate `forecasts` block; we emit them as alerting
  // rules on the recorded 1h burn rate (predict_linear over 1d, sustained
  // above 1× for 2h). The on_projected_breach field decides the severity
  // and rides into annotations so Alertmanager can route accordingly.
  const forecastRules = [];
  for (const f of canonical?.spec?.policy?.forecasts || []) {
    const slo = findSlo(canonical, f.slo);
    if (!slo) continue;
    const fa = buildForecastAlertForSlo(canonical, slo, f, ctx);
    if (fa) forecastRules.push(fa);
  }
  if (forecastRules.length) {
    groups.push({ name: `${svc}_forecast`, interval: '5m', rules: forecastRules });
  }

  const out = {
    // A header comment marks provenance so a Promtool-validated rules
    // file is also traceable back to the canonical pack that emitted it.
    groups,
  };

  return banner('Prometheus rules', canonical) + emitYaml(out);
}

// ----------------------------------------------------------------
// Per-SLO rules builders — used by both Prometheus and
// Grafana-managed compilers, and by the per-artifact selection UI.
// Returned arrays are the same in-memory rule shape the dispatcher
// then formats for each platform. Every builder takes the policy
// context from policyContext(), so all outputs share one PromQL.
// ----------------------------------------------------------------

// The SLI's own per-SLO series: good/total/ratio for a ratio SLI, value for
// everything else (layout-preserving strip). Labels { slo, sli, service }.
function buildSliRecordingRules(canonical, slo, ctx) {
  const sli = findSli(canonical, slo.sli);
  if (!sli) return [];
  const svc = ctx.svc;
  const expr = sliExpression(sli);
  if (!expr) return [];
  const labels = { slo: slo.id, sli: sli.id, service: ctx.service };

  if (sli.type === 'ratio') {
    return [
      { record: `${svc}:${metricSafe(sli.id)}:good_${RATE_WINDOW_RECORD}`, expr: strip(sli.good), labels },
      { record: `${svc}:${metricSafe(sli.id)}:total_${RATE_WINDOW_RECORD}`, expr: strip(sli.total), labels },
      { record: `${svc}:${metricSafe(sli.id)}:ratio_${RATE_WINDOW_RECORD}`, expr: `${svc}:${metricSafe(sli.id)}:good_${RATE_WINDOW_RECORD} / ${svc}:${metricSafe(sli.id)}:total_${RATE_WINDOW_RECORD}`, labels },
    ];
  }
  return [{ record: `${svc}:${metricSafe(sli.id)}:value_${RATE_WINDOW_RECORD}`, expr, labels }];
}

// The SLI-level record `<svc>:<sli>:error_ratio_5m` (labels { sli, service }, no
// slo: it is a property of the SLI, recorded once however many SLOs read it):
// the policy's own error ratio over 5 m — bad events over the events that
// happened for counter SLIs, bad samples over the expected samples for state
// and threshold SLIs — which is what the dashboards' "Error ratio · 5 m, per
// SLI" panel describes. An SLI the policy cannot express (irate legs, an
// aggregation without a range, distribution/custom) has no such record: the
// former `1 - <sli>:ratio_5m` fallback was empty during a 100 % outage and
// carried none of the policy's semantics, so a missing series is the honest
// answer (the dashboards then show none for that SLI).
function buildSliErrorRatioRule(canonical, sli, ctx) {
  if (!sli) return null;
  const labels = { sli: sli.id, service: ctx.service };
  return sliErrorRatioRule(sli, { prefix: ctx.svc, ...legsCtx(ctx, sli), labels });
}

// The per-SLO policy records: errorbudget:burn_5m / burn_1h — empty for SLOs
// without a budget or whose SLI has no error-ratio form (distribution, custom).
function buildErrorBudgetRules(canonical, slo, ctx) {
  const sli = findSli(canonical, slo.sli);
  if (!sli || !((1 - slo.objective) > 0)) return [];
  return errorBudgetRecordingRules(slo, sli, {
    prefix: ctx.svc,
    ...legsCtx(ctx, sli),
    labels: { slo: slo.id, sli: sli.id, service: ctx.service },
  });
}

// Every record an SLO brings to the full file, in file order: its SLI series,
// the SLI-level error ratio (dedupeGeneratedRecords drops the repeat when a
// later SLO reads the same SLI), then its error-budget burn rates.
function buildRecordingRulesForSlo(canonical, slo, ctx) {
  const ratio = buildSliErrorRatioRule(canonical, findSli(canonical, slo.sli), ctx);
  return [...buildSliRecordingRules(canonical, slo, ctx), ...(ratio ? [ratio] : []), ...buildErrorBudgetRules(canonical, slo, ctx)];
}

// The two halves of a per-SLO file: what belongs to the SLI (the SLI-level
// error ratio, in a per-SLI group `<svc>_<sli>_sli_recording` that the per-SLO
// files of every SLO on that SLI share verbatim, so a ruler keyed by group and
// a Grafana keyed by uid both converge on one rule) and what belongs to the SLO
// (`<svc>_<slo>_recording`). Both halves go through the same de-duplication as
// the full file: a record the pack declares itself is the pack's and is never
// emitted here either (a per-SLO deploy must not overwrite the pack's rule).
function splitRecordingRulesForSlo(canonical, slo, ctx) {
  const declared = declaredRecordingRules(canonical);
  const ratio = buildSliErrorRatioRule(canonical, findSli(canonical, slo.sli), ctx);
  return {
    sliLevel: dedupeGeneratedRecords(ratio ? [ratio] : [], declared, ctx),
    sloLevel: dedupeGeneratedRecords([...buildSliRecordingRules(canonical, slo, ctx), ...buildErrorBudgetRules(canonical, slo, ctx)], declared, ctx),
  };
}
// The group the SLI-level record of `sli` lives in, in every per-SLO file.
const sliRecordingGroup = (ctx, sli) => `${ctx.svc}_${metricSafe(sli.id)}_sli_recording`;

// The pack's own spec.queries.recording_rules, refs resolved (`interval` is a
// group property in Prometheus and is dropped, as before).
function declaredRecordingRules(canonical) {
  return (canonical?.spec?.queries?.recording_rules || []).map(rule => ({
    record: rule.name,
    expr: resolveRefs(rule.expr, canonical),
    ...(rule.labels ? { labels: rule.labels } : {}),
  }));
}

// (record, label set) identity of a rule: what promtool's duplicate-rule lint keys on.
const recordKey = (r) => `${r.record}|${Object.entries(r.labels || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join(',')}`;

// The generated records of a full rules file, minus
//  (1) SLI-level records (no `slo` label: an SLI's error_ratio_5m) that an earlier
//      SLO on the same SLI already produced;
//  (2) records the pack declares itself with the same (record, labels) — the
//      pack's definition is kept and the collision is warned about;
//  (3) SLI-level records whose metric NAME the pack declares under any label set
//      (a pack of the generator's lineage declares `<svc>:<sli>:error_ratio_5m`
//      itself, with its own labels and sample step): the name is the SLI's one
//      metric, so the pack's definition is the definition — kept, warned about
//      as in (2), never emitted twice with two denominators.
// A declared rule that shares only the metric NAME with a generated per-SLO
// record is kept alongside and warned about only when the two can write the same
// series: the declared rule carries no `slo` label (an unlabelled
// `<svc>:errorbudget:burn_1h` reading `<svc>:<sli>:error_ratio_5m` propagates the
// input's `slo`/`sli`/`service` into its output) or the same `slo` value. Static
// label sets that differ on `slo` cannot collide (promtool's identity is the
// static label set, Prometheus's the resulting series).
function dedupeGeneratedRecords(generated, declared, ctx) {
  const declaredKeys = new Set(declared.map(recordKey));
  const declaredByName = new Map();
  for (const d of declared) declaredByName.set(d.record, [...(declaredByName.get(d.record) || []), d]);
  const labelsOf = (r) => `{${Object.entries(r.labels || {}).map(([k, v]) => `${k}="${v}"`).join(',')}}`;
  const seen = new Set();
  return generated.filter(r => {
    const key = recordKey(r);
    const sameName = declaredByName.get(r.record) || [];
    if (declaredKeys.has(key)) {
      ctx.warn(`recording rule ${r.record}${labelsOf(r)} is declared by the pack and generated by the policy; keeping the pack's`);
      return false;
    }
    if (!r.labels?.slo) {
      if (sameName.length) {
        ctx.warn(`recording rule ${r.record}${labelsOf(sameName[0])} is declared by the pack and generated by the policy as ${r.record}${labelsOf(r)}; keeping the pack's`);
        return false;
      }
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }
    for (const d of sameName) {
      if (d.labels?.slo && d.labels.slo !== r.labels.slo) continue;
      ctx.warn(`declared ${r.record}${labelsOf(d)} and generated ${r.record}${labelsOf(r)} write the same metric name; series may collide at runtime`);
    }
    return true;
  });
}

function buildBurnRateAlertsForSlo(canonical, slo, burnRateBlock, ctx) {
  const sli = findSli(canonical, slo.sli);
  if (!policyEligible(slo, sli, ctx)) return [];
  const budget = 1 - slo.objective;
  const out = [];
  for (const w of burnRateBlock?.windows || []) {
    const short = w.short, long = w.long;
    if (!durationSeconds(short) || !durationSeconds(long)) {
      ctx.warn(`${slo.id}: window ${short}/${long} not parseable, skipped`);
      continue;
    }
    const factor = w.factor || 1;
    const sev = w.severity || 'SEV3';
    const threshold = fmt(factor * budget);
    const alertName = `${slo.id}_burn_${factor}x_${short}_${long}`.replace(/[^a-zA-Z0-9_]/g, '_');
    const expr = burnAlertExpr(sli, { short, long, threshold, ...legsCtx(ctx, sli), minBadSamples: ctx.minBadSamples });
    if (!expr) continue;
    out.push({
      alert: alertName,
      expr,
      for: forFor(short, { lab: ctx.lab }),
      // `keep_firing_for` debounces resolution so a burn alert doesn't
      // flap as the ratio crosses the threshold. It was added in
      // Prometheus 2.42; VictoriaMetrics/vmalert and older Prometheus
      // reject the field, so only the profiles that support it emit it.
      ...(ctx.keepFiringFor ? { keep_firing_for: long } : {}),
      labels: {
        severity: sev,
        slo: slo.id,
        sli: sli.id,
        service: ctx.service,
        burn_rate: String(factor),
        window_short: short,
        window_long: long,
        pack: ctx.service,
      },
      annotations: {
        summary: `Burn rate ${factor}× on ${slo.id}`,
        description: `Both the ${short} and ${long} error ratios exceed ${factor}× of the ${(budget * 100).toFixed(3)}% error budget for ${slo.id}, with at least ${ctx.minBadSamples} bad samples in the ${short} window.`,
        slo_objective: `${(slo.objective * 100).toFixed(3)}%`,
        slo_window: slo.window,
        runbook: ctx.runbooks[sli.id] ?? '(supply runbook URL)',
      },
    });
  }
  return out;
}

function buildForecastAlertForSlo(canonical, slo, forecast, ctx) {
  const sli = findSli(canonical, slo.sli);
  // The forecast reads the SLO's burn_1h record, which exists iff the policy records do.
  if (!policyEligible(slo, sli, ctx)) return null;
  const declared = durationSeconds(forecast.horizon) ? String(forecast.horizon) : '7d';
  const h = forecastHorizon(declared);
  const burn = `${ctx.svc}:errorbudget:burn_1h{slo="${slo.id}"}`;
  const action = forecast.on_projected_breach || 'open_ticket';
  return {
    alert: `${slo.id}_forecast_breach`,
    expr: forecastExpr(burn, h.seconds),
    for: '15m',
    labels: { severity: forecastSeverity(action), slo: slo.id, kind: 'forecast', service: ctx.service, sli: sli.id, pack: ctx.service },
    annotations: {
      summary: `${slo.id} has burned faster than its budget for 2h and its 1d trend projects a breach within ${h.capped ? '1d' : h.declared}`,
      method: `linear on the 1h burn rate${forecast.method && forecast.method !== 'linear' ? ` (pack declares ${forecast.method})` : ''}`,
      on_projected_breach: action,
      horizon: h.capped ? '1d' : h.declared,
      horizon_declared: h.declared,
    },
  };
}

// ----------------------------------------------------------------
// Per-artifact Prometheus compilers — emit a SUBSET of the
// rules file scoped to one SLO or one author-declared rule.
// The output is still a valid Prometheus rules YAML file so it
// drops into Mimir/Prometheus ruler the same way.
// ----------------------------------------------------------------

// Policy entries naming an SLO, whichever spelling the pack uses
// (`api_availability_99_9`, `slos.x`, `ref:slos.x`).
const policyEntriesFor = (entries, canonical, slo) => (entries || []).filter(e => findSlo(canonical, e.slo)?.id === slo.id);

// Contract (deliberate, since the builders were unified): a per-SLO file is the
// SLO's slice of the full file, so it follows the same profile knob and carries
// `keep_firing_for` exactly where the full file would — resolved from the pack's
// declared metrics backend unless opts.product/version name the deploy target
// (compileArtifact forwards them; server/routes/deploy.mjs does not pass them
// yet, so a per-SLO deploy is shaped by the pack's declaration, as the full
// file always was). Before, per-SLO files never emitted the field.
// Group names: a per-SLO file uses only `<svc>_<sli>_sli_recording` (the
// SLI-level error ratio, identical bytes in the per-SLO files of every SLO on
// that SLI, so a ruler keyed by (namespace, group) converges on one rule) and
// `<svc>_<slo>_recording` / `_burn` / `_forecast` — never the full file's
// `<svc>_recording`, so a per-SLO file next to the full file in one ruler
// namespace replaces nothing of it. The full file and per-SLO files still
// record the same series, so deploy one or the other into a namespace, not both
// (server/routes/deploy.mjs deploys the items the modal selected).
export function compileSloPrometheusRules(canonical, sloId, opts = {}) {
  const slo = findSlo(canonical, sloId);
  if (!slo) throw new Error(`SLO not found: ${sloId}`);
  const ctx = policyContext(canonical, opts);
  const svc = ctx.svc;
  const groups = [];

  const { sliLevel, sloLevel } = splitRecordingRulesForSlo(canonical, slo, ctx);
  if (sliLevel.length) groups.push({ name: sliRecordingGroup(ctx, findSli(canonical, slo.sli)), interval: RECORDING_INTERVAL, rules: sliLevel });
  if (sloLevel.length) groups.push({ name: `${svc}_${slo.id}_recording`, interval: RECORDING_INTERVAL, rules: sloLevel });

  for (const ba of policyEntriesFor(canonical?.spec?.policy?.burn_rate_alerts, canonical, slo)) {
    const alerts = buildBurnRateAlertsForSlo(canonical, slo, ba, ctx);
    if (alerts.length) groups.push({ name: `${svc}_${slo.id}_burn`, interval: '30s', rules: alerts });
  }
  for (const f of policyEntriesFor(canonical?.spec?.policy?.forecasts, canonical, slo)) {
    const fa = buildForecastAlertForSlo(canonical, slo, f, ctx);
    if (fa) groups.push({ name: `${svc}_${slo.id}_forecast`, interval: '5m', rules: [fa] });
  }

  return banner(`Prometheus rules — SLO ${slo.id}`, canonical) + emitYaml({ groups });
}

export function compileDeclaredPrometheusRule(canonical, indexOrName) {
  const decl = canonical?.spec?.queries?.recording_rules || [];
  const rule = typeof indexOrName === 'number' ? decl[indexOrName] : decl.find(r => r.name === indexOrName);
  if (!rule) throw new Error(`Declared recording rule not found: ${indexOrName}`);
  const svc = serviceSlug(canonical);
  const groups = [{
    name: `${svc}_declared`,
    interval: '30s',
    rules: [{ record: rule.name, expr: resolveRefs(rule.expr, canonical), ...(rule.labels ? { labels: rule.labels } : {}) }],
  }];
  return banner(`Prometheus rule — ${rule.name}`, canonical) + emitYaml({ groups });
}

// ----------------------------------------------------------------
// Grafana-managed rules — emitted as Grafana provisioning YAML
// (the format Grafana 9+ accepts under provisioning/alerting/*.yaml
// and the unified-alerting `/api/ruler/grafana/api/v1/rules/<ns>`
// endpoint).
//
// Recording rules use the modern Grafana-managed `record:` block
// (metric + from refId). Alerting rules use the `condition` + `data`
// shape with a threshold expression on a refId.
// ----------------------------------------------------------------

const GRAFANA_FOLDER_DEFAULT = 'observability-pack';

// Deterministic 6-char FNV-1a fingerprint — appended to over-long uids
// so truncation can never make two different names collide. (T4 caught
// the bare slice: `…consumer_processing_success:good_5m` and `…:ratio_5m`
// truncated to the SAME 40 chars, so successive deploys upserted over
// each other and only the last rule survived in Grafana.)
function uidFingerprint(name) {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0').slice(0, 7);
}

// Grafana wants stable, ≤40-char uids. Deterministic from name so
// re-emits don't churn; names that overflow keep a unique fingerprint.
function grafanaUid(prefix, name) {
  const full = `${prefix}-${slug(name)}`;
  if (full.length <= 40) return full;
  return `${full.slice(0, 32)}-${uidFingerprint(full)}`;
}

function grafanaRuleUid(prefix, name) {
  return grafanaUid(prefix, name);
}

function grafanaPromQuery(refId, expr, instant = true) {
  return {
    refId,
    queryType: '',
    relativeTimeRange: { from: 600, to: 0 },
    datasourceUid: DEFAULT_DATASOURCE_UID,
    model: {
      refId,
      expr,
      instant,
      range: !instant,
      intervalMs: 1000,
      maxDataPoints: 43200,
    },
  };
}

function grafanaThresholdExpr(refId, target, gt) {
  return {
    refId,
    queryType: '',
    relativeTimeRange: { from: 0, to: 0 },
    datasourceUid: '__expr__',
    model: {
      refId,
      type: 'threshold',
      expression: target,
      conditions: [{ type: 'query', evaluator: { type: 'gt', params: [gt] } }],
    },
  };
}

// Grafana provisioning rejects a file whose rule uids (or titles) repeat, and
// one metric NAME is legitimately written by several rules here: every per-SLO
// record (`value_5m`, `good_5m`, ..., `errorbudget:burn_*`) once per SLO on the
// same SLI, and a pack-declared unlabelled `x:ratio_5m` next to the generated
// labelled one (the T4 class the fingerprint above fixed). Stable by default: a
// record is keyed by its bare name while that name is unique in the file (every
// uid and title a deployed pack already carries stays byte-identical), and only
// a name that repeats is re-keyed — `record{slo="…"}` for the records carrying an
// `slo` label, then the full (record, static labels) identity, then an ordinal
// (a duplicate dedupeGeneratedRecords could not remove). A pack that gains a
// second SLO on an SLI therefore changes the uids of THAT SLI's per-SLO records
// only; every other rule keeps its uid.
function grafanaRecordingUidKeys(records) {
  const withSlo = (r) => (r.labels?.slo ? `${r.record}{slo="${r.labels.slo}"}` : r.record);
  const full = (r) => `${r.record}{${Object.entries(r.labels || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}="${v}"`).join(',')}}`;
  const count = (keys) => keys.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
  let keys = records.map(r => r.record);
  for (const rekey of [withSlo, full]) {
    const dup = count(keys);
    keys = keys.map((k, i) => (dup.get(k) > 1 ? rekey(records[i]) : k));
  }
  const dup = count(keys);
  const seen = new Map();
  return keys.map((k) => {
    if (dup.get(k) <= 1) return k;
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    return n === 1 ? k : `${k}#${n}`;
  });
}
// uid keys of every record of the FULL Grafana-managed file, by (record, labels)
// identity: a per-SLO file looks its records up here so the uid it deploys is the
// one the full file deploys (and the one the other per-SLO files sharing an SLI
// deploy), never a key that is unique only within the smaller file.
function grafanaRecordingUidMap(canonical, ctx) {
  const declaredRules = declaredRecordingRules(canonical).map(r => ({ ...r, labels: r.labels || {} }));
  const generated = dedupeGeneratedRecords(
    (canonical?.spec?.slos || []).flatMap(slo => buildRecordingRulesForSlo(canonical, slo, ctx)), declaredRules, { ...ctx, warn: () => {} });
  const all = [...generated, ...declaredRules];
  const keys = grafanaRecordingUidKeys(all);
  return new Map(all.map((r, i) => [recordKey(r), keys[i]]));
}
// With a uidMap, a record the full file does not carry (one the pack declares itself, which
// dedupeGeneratedRecords dropped there) is dropped here too — its bare name would hash to the
// uid of the pack's own rule and a per-SLO deploy would overwrite the pack's definition.
const grafanaRecordingRules = (records, uidMap = null) => {
  const kept = uidMap ? records.filter(r => uidMap.has(recordKey(r))) : records;
  const keys = uidMap ? kept.map(r => uidMap.get(recordKey(r))) : grafanaRecordingUidKeys(kept);
  return kept.map((r, i) => buildGrafanaRecordingRule(r, { uidKey: keys[i] }));
};

// Grafana-managed recording rule: title + record block + a single Prometheus
// query that returns the materialised metric. The query is INSTANT: Grafana's
// recording-rule writer accepts only reduced numeric frames (one value per
// series), which is what an instant Prometheus query returns; a range query
// yields time-series frames that need a Reduce expression and are otherwise
// rejected ("only reduced data can be alerted on"), so the metric would never
// be written and every threshold burn alert and forecast reading it would be
// blind.
function buildGrafanaRecordingRule(rec, { uidKey = rec.record } = {}) {
  return {
    uid: grafanaRuleUid('rec', uidKey),
    title: uidKey,
    condition: 'A',
    data: [grafanaPromQuery('A', rec.expr, true)],
    no_data_state: 'OK',
    exec_err_state: 'Error',
    for: '0s',
    labels: rec.labels || {},
    annotations: {},
    record: { metric: rec.record, from: 'A' },
    is_paused: false,
  };
}

function buildGrafanaAlertRule(alert) {
  // Grafana-managed alert rule: a Prometheus query in refId A and a
  // threshold expression in refId B that evaluates A > 0. The original
  // expr already encodes the threshold, so we test "result > 0".
  return {
    uid: grafanaRuleUid('alr', alert.alert),
    title: alert.alert,
    condition: 'B',
    data: [
      grafanaPromQuery('A', alert.expr, true),
      grafanaThresholdExpr('B', 'A', 0),
    ],
    no_data_state: 'OK',
    exec_err_state: 'Error',
    for: alert.for || '5m',
    labels: alert.labels || {},
    annotations: alert.annotations || {},
    is_paused: false,
  };
}

function grafanaGroupOf(name, rules, interval = '30s') {
  return {
    orgId: 1,
    name,
    folder: GRAFANA_FOLDER_DEFAULT,
    interval,
    rules,
  };
}

function bannerForGrafana(target, canonical) {
  return (
    `# ${target} compiled from ObservabilityPack v1.2\n` +
    `# Pack: ${nameOf(canonical)} · version ${canonical?.metadata?.version || '?'}\n` +
    `# Format: Grafana 9+ provisioning YAML (apiVersion: 1).\n` +
    `# Apply via: copy under provisioning/alerting/ OR POST to /api/v1/provisioning/alert-rules\n` +
    `# Source of truth — DO NOT hand-edit. Re-emit from the pack.\n`
  );
}

// The Grafana rule shape never carried keep_firing_for; the policy PromQL is
// otherwise the Prometheus flavour's, verbatim.
export function compileGrafanaManagedRules(canonical, opts = {}) {
  const ctx = policyContext(canonical, { ...opts, keepFiringFor: false });
  const svc = ctx.svc;
  const groups = [];

  // Recording rules (per-SLO series + policy records + author-declared), the
  // same de-duplication as the Prometheus flavour.
  const declaredRules = declaredRecordingRules(canonical).map(r => ({ ...r, labels: r.labels || {} }));
  const generated = dedupeGeneratedRecords(
    (canonical?.spec?.slos || []).flatMap(slo => buildRecordingRulesForSlo(canonical, slo, ctx)), declaredRules, ctx);
  const recordingRules = grafanaRecordingRules([...generated, ...declaredRules]);
  if (recordingRules.length) groups.push(grafanaGroupOf(`${svc}_recording`, recordingRules, '30s'));

  // Burn-rate alerts (per SLO)
  for (const ba of canonical?.spec?.policy?.burn_rate_alerts || []) {
    const slo = findSlo(canonical, ba.slo);
    if (!slo) continue;
    const rules = buildBurnRateAlertsForSlo(canonical, slo, ba, ctx).map(buildGrafanaAlertRule);
    if (rules.length) groups.push(grafanaGroupOf(`${svc}_${slo.id}_burn`, rules, '30s'));
  }

  // Forecast alerts
  const forecastRules = [];
  for (const f of canonical?.spec?.policy?.forecasts || []) {
    const slo = findSlo(canonical, f.slo);
    if (!slo) continue;
    const fa = buildForecastAlertForSlo(canonical, slo, f, ctx);
    if (fa) forecastRules.push(buildGrafanaAlertRule(fa));
  }
  if (forecastRules.length) groups.push(grafanaGroupOf(`${svc}_forecast`, forecastRules, '5m'));

  return bannerForGrafana('Grafana-managed rules', canonical) + emitYaml({ apiVersion: 1, groups });
}

// A per-SLO Grafana-managed file deploys by uid (server/deploy-helpers.mjs
// upserts one rule per uid, ruleGroup = the group name), so its recording rules
// carry the uids of the FULL file (grafanaRecordingUidMap) and the SLI-level
// error ratio sits in the per-SLI group `<svc>_<sli>_sli_recording`, the same in
// the per-SLO files of every SLO on that SLI: a bulk deploy of two such SLOs
// converges on one rule (same uid, same group) instead of moving it between
// two groups. A record the pack declares itself is not emitted (see
// grafanaRecordingRules).
export function compileSloGrafanaManagedRules(canonical, sloId, opts = {}) {
  const slo = findSlo(canonical, sloId);
  if (!slo) throw new Error(`SLO not found: ${sloId}`);
  const ctx = policyContext(canonical, { ...opts, keepFiringFor: false });
  const svc = ctx.svc;
  const groups = [];

  const uidMap = grafanaRecordingUidMap(canonical, ctx);
  const { sliLevel, sloLevel } = splitRecordingRulesForSlo(canonical, slo, ctx);
  if (sliLevel.length) groups.push(grafanaGroupOf(sliRecordingGroup(ctx, findSli(canonical, slo.sli)), grafanaRecordingRules(sliLevel, uidMap), '30s'));
  if (sloLevel.length) groups.push(grafanaGroupOf(`${svc}_${slo.id}_recording`, grafanaRecordingRules(sloLevel, uidMap), '30s'));

  for (const ba of policyEntriesFor(canonical?.spec?.policy?.burn_rate_alerts, canonical, slo)) {
    const rules = buildBurnRateAlertsForSlo(canonical, slo, ba, ctx).map(buildGrafanaAlertRule);
    if (rules.length) groups.push(grafanaGroupOf(`${svc}_${slo.id}_burn`, rules, '30s'));
  }
  for (const f of policyEntriesFor(canonical?.spec?.policy?.forecasts, canonical, slo)) {
    const fa = buildForecastAlertForSlo(canonical, slo, f, ctx);
    if (fa) groups.push(grafanaGroupOf(`${svc}_${slo.id}_forecast`, [buildGrafanaAlertRule(fa)], '5m'));
  }

  return bannerForGrafana(`Grafana-managed rules — SLO ${slo.id}`, canonical) + emitYaml({ apiVersion: 1, groups });
}

// ----------------------------------------------------------------
// Compile catalog — enumerates every individually compilable
// artifact in the pack. The studio renders this as a left-nav tree;
// each leaf identifies its target platform explicitly so the
// engineer can SEE whether they're looking at Prometheus or
// Grafana-managed output before they ship it.
// ----------------------------------------------------------------

export function compileCatalog(canonical) {
  const sloIds = (canonical?.spec?.slos || []).map(s => s.id);
  const declared = canonical?.spec?.queries?.recording_rules || [];
  const dashboards = canonical?.spec?.dashboards || [];

  const groups = [];

  // ---- Rules group: two flavors, multiple selectable items ----
  if (sloIds.length || declared.length) {
    const rulesItems = [
      { id: 'all', kind: 'rules-bundle', label: 'All rules · full file', subtitle: `${sloIds.length} SLO(s) · ${declared.length} declared` },
    ];
    // Counts come from the builders themselves so the subtitle is true for
    // threshold SLOs (which now burn), for distribution/custom ones (which don't)
    // and for records the pack declares itself (deduplicated, as in the files).
    const ctx = policyContext(canonical);
    for (const slo of canonical.spec.slos || []) {
      const { sliLevel, sloLevel } = splitRecordingRulesForSlo(canonical, slo, ctx);
      const recCount = sliLevel.length + sloLevel.length;
      const burnCount = policyEntriesFor(canonical?.spec?.policy?.burn_rate_alerts, canonical, slo)
        .reduce((s, b) => s + buildBurnRateAlertsForSlo(canonical, slo, b, ctx).length, 0);
      const forecastCount = policyEntriesFor(canonical?.spec?.policy?.forecasts, canonical, slo)
        .reduce((s, f) => s + (buildForecastAlertForSlo(canonical, slo, f, ctx) ? 1 : 0), 0);
      rulesItems.push({
        id: `slo:${slo.id}`,
        kind: 'rules-slo',
        label: `SLO · ${slo.id}`,
        subtitle: `${recCount} recording · ${burnCount} burn-rate · ${forecastCount} forecast`,
        sloId: slo.id,
        objective: slo.objective,
        window: slo.window,
      });
    }
    for (let i = 0; i < declared.length; i++) {
      rulesItems.push({
        id: `declared:${i}`,
        kind: 'rules-declared',
        label: `declared · ${declared[i].name}`,
        subtitle: 'author-declared recording rule',
        ruleIndex: i,
        ruleName: declared[i].name,
      });
    }
    groups.push({
      id: 'rules',
      label: 'Recording + alerting rules',
      blurb: 'PromQL recording rules and multi-window burn-rate alerts derived from each SLO.',
      flavors: [
        { id: 'prometheus',      label: 'Prometheus (Mimir-compatible)', platform: 'Prometheus / Mimir / Grafana Cloud Metrics',
          description: 'Standard Prometheus rules YAML. Drop into `rule_files:` on a Prometheus server, or POST to Mimir’s ruler API.',
          contentType: 'application/x-yaml', extension: 'yaml', deployable: true },
        { id: 'grafana-managed', label: 'Grafana-managed (12 / 13)',     platform: 'Grafana 9+ unified alerting',
          description: 'Grafana provisioning YAML (apiVersion: 1). Copy under provisioning/alerting/ or POST to /api/v1/provisioning/alert-rules.',
          contentType: 'application/x-yaml', extension: 'yaml', deployable: true },
      ],
      items: rulesItems,
    });
  }

  // ---- Dashboards group ----
  if (dashboards.length) {
    const dashItems = [
      { id: 'all', kind: 'dashboards-bundle', label: 'All dashboards · bundle', subtitle: `${dashboards.length} dashboard(s)` },
    ];
    for (const d of dashboards) {
      dashItems.push({
        id: `dash:${d.id}`,
        kind: 'dashboard',
        label: d.id,
        subtitle: `${d.folder || 'unfiled'} · schemaVersion ${d.provider?.schemaVersion || '—'}`,
        dashboardId: d.id,
      });
    }
    groups.push({
      id: 'dashboards',
      label: 'Dashboards',
      blurb: 'Grafana 12/13 dashboard JSON, one per spec.dashboards[] entry.',
      flavors: [{ id: 'grafana', label: 'Grafana 12 / 13', platform: 'Grafana dashboards API',
                  description: 'Native Grafana dashboard JSON. Import via Grafana UI, dashboards API, or grafana-cli.',
                  contentType: 'application/json', extension: 'json', deployable: true }],
      items: dashItems,
    });
  }

  // ---- Pipelines (OTel Collector) ----
  if (canonical?.spec?.pipelines) {
    groups.push({
      id: 'pipelines',
      label: 'OTel Collector',
      blurb: 'OpenTelemetry Collector configuration — receivers, processors, exporters, pipelines.',
      flavors: [{ id: 'collector-yaml', label: 'Collector YAML', platform: 'OpenTelemetry Collector (contrib or core)',
                  description: 'Single collector config file. Mount and pass via `--config`. Not directly deployable via Grafana — env-specific.',
                  contentType: 'application/x-yaml', extension: 'yaml', deployable: false }],
      items: [{ id: 'all', kind: 'collector', label: 'Full collector config', subtitle: 'receivers · processors · exporters · service.pipelines' }],
    });
  }

  // ---- Alertmanager (standalone) ----
  if (canonical?.spec?.alerting) {
    groups.push({
      id: 'alertmanager',
      label: 'Alertmanager',
      blurb: 'Standalone Alertmanager configuration. Folded into Grafana unified alerting at deploy time — emit here for hand-off.',
      flavors: [{ id: 'alertmanager-yaml', label: 'Alertmanager YAML', platform: 'Prometheus Alertmanager (standalone)',
                  description: 'Standalone Alertmanager config — route tree + receivers. Not deployable from the studio for now; Grafana unified alerting routes are configured in Grafana itself.',
                  contentType: 'application/x-yaml', extension: 'yaml', deployable: false }],
      items: [{ id: 'all', kind: 'alertmanager', label: 'Full routes + receivers', subtitle: `${(canonical.spec.alerting.routes || []).length} route(s)` }],
    });
  }

  return { groups };
}

// ----------------------------------------------------------------
// Dispatch: compile a (group, flavor, artifact) tuple to bytes.
// This is the new entry the per-artifact UI uses.
// ----------------------------------------------------------------

// Extra keys (step, lab, minBadSamples, runbooks, onWarning, product, version, ...)
// are forwarded to the rules compilers.
export function compileArtifact(canonical, { group, flavor, artifact, dashboardId, ...opts }) {
  if (group === 'rules') {
    if (flavor === 'prometheus' || !flavor) {
      if (!artifact || artifact === 'all') {
        return { contentType: 'application/x-yaml', filename: `${serviceSlug(canonical)}.rules.yaml`, content: compilePrometheusRules(canonical, opts) };
      }
      if (artifact.startsWith('slo:')) {
        const sloId = artifact.slice(4);
        return { contentType: 'application/x-yaml', filename: `${serviceSlug(canonical)}.${slug(sloId)}.rules.yaml`, content: compileSloPrometheusRules(canonical, sloId, opts) };
      }
      if (artifact.startsWith('declared:')) {
        const idx = parseInt(artifact.slice(9), 10);
        return { contentType: 'application/x-yaml', filename: `${serviceSlug(canonical)}.declared-${idx}.rules.yaml`, content: compileDeclaredPrometheusRule(canonical, idx) };
      }
    }
    if (flavor === 'grafana-managed') {
      if (!artifact || artifact === 'all') {
        return { contentType: 'application/x-yaml', filename: `${serviceSlug(canonical)}.grafana-rules.yaml`, content: compileGrafanaManagedRules(canonical, opts) };
      }
      if (artifact.startsWith('slo:')) {
        const sloId = artifact.slice(4);
        return { contentType: 'application/x-yaml', filename: `${serviceSlug(canonical)}.${slug(sloId)}.grafana-rules.yaml`, content: compileSloGrafanaManagedRules(canonical, sloId, opts) };
      }
      if (artifact.startsWith('declared:')) {
        const idx = parseInt(artifact.slice(9), 10);
        const decl = (canonical?.spec?.queries?.recording_rules || [])[idx];
        if (!decl) throw new Error(`Declared rule not found: ${idx}`);
        const rule = buildGrafanaRecordingRule({ record: decl.name, expr: resolveRefs(decl.expr, canonical), labels: decl.labels || {} });
        const body = { apiVersion: 1, groups: [grafanaGroupOf(`${serviceSlug(canonical)}_declared`, [rule], '30s')] };
        return { contentType: 'application/x-yaml', filename: `${serviceSlug(canonical)}.declared-${idx}.grafana-rules.yaml`, content: bannerForGrafana(`Grafana-managed rule — ${decl.name}`, canonical) + emitYaml(body) };
      }
    }
  }
  if (group === 'dashboards') {
    if (artifact === 'all' || !artifact) {
      // Bundle: concatenate every dashboard as a multi-doc with header
      // comments naming each. The output is one file the engineer can
      // split, not multi-file (kept simple for the v1 of per-artifact UI).
      const parts = [];
      for (const d of canonical?.spec?.dashboards || []) {
        parts.push(`/* === ${d.id} === */`);
        parts.push(compileGrafanaDashboard(canonical, d.id));
      }
      return { contentType: 'application/json', filename: `${serviceSlug(canonical)}.dashboards.bundle.json`, content: parts.join('\n\n') };
    }
    if (artifact.startsWith('dash:')) {
      const id = artifact.slice(5);
      return { contentType: 'application/json', filename: `${serviceSlug(canonical)}.${slug(id)}.json`, content: compileGrafanaDashboard(canonical, id) };
    }
  }
  if (group === 'pipelines') {
    return { contentType: 'application/x-yaml', filename: `${serviceSlug(canonical)}.otel-collector.yaml`, content: compileOtelCollector(canonical) };
  }
  if (group === 'alertmanager') {
    return { contentType: 'application/x-yaml', filename: `${serviceSlug(canonical)}.alertmanager.yaml`, content: compileAlertmanager(canonical) };
  }
  throw new Error(`unknown compile group: ${group}`);
}

// ============================================================
// 2) Alertmanager routes + receivers
// ============================================================

const CHANNEL_TO_RECEIVER = {
  msteams:  'msteams_configs',
  voice:    'pagerduty_configs',
  whatsapp: 'webhook_configs',
  email:    'email_configs',
  webhook:  'webhook_configs',
};

export function compileAlertmanager(canonical, opts = {}) {
  const routes = canonical?.spec?.alerting?.routes || [];
  const suppress = canonical?.spec?.alerting?.suppress || [];
  const svc = nameOf(canonical);
  const profile = opts.profile || profileForTarget(canonical, 'alertmanager', opts);

  const receivers = [];
  const childRoutes = [];

  // Alertmanager requires notification-config names to be unique, and packs
  // can legally declare several routes of one severity (the diff engine's
  // collision handling exists for the same reason) — later duplicates get an
  // occurrence ordinal.
  const recNameCounts = new Map();

  routes.forEach((route, i) => {
    const baseRecName = `${slug(svc)}-${(route.severity || 'sev').toLowerCase()}`;
    const seq = (recNameCounts.get(baseRecName) || 0) + 1;
    recNameCounts.set(baseRecName, seq);
    const recName = seq > 1 ? `${baseRecName}-${seq}` : baseRecName;
    const recCfg = { name: recName };
    for (const ch of route.channels || []) {
      const kind = Object.keys(ch)[0];
      const target = ch[kind];
      // Microsoft Teams: v0.28 introduced the `msteamsv2_configs` receiver
      // (Power Automate workflows); older Alertmanager only has
      // `msteams_configs`, and pre-0.26 has neither. Route to the form the
      // resolved profile actually supports.
      let key = CHANNEL_TO_RECEIVER[kind] || 'webhook_configs';
      if (kind === 'msteams') {
        if (profile.knobs.msteamsV2) key = 'msteamsv2_configs';
        else if (profile.knobs.msteams === false) key = 'webhook_configs';
      }
      recCfg[key] = recCfg[key] || [];
      // Secrets are referenced as *_file paths (the Alertmanager-native
      // pattern: mount the secret at deploy time), never inlined and
      // never pseudo-commented — a "# secret: …" string in a URL field
      // is not a URL and amtool check-config rejects the whole file.
      // Only schema-valid fields are emitted; channel identity that has
      // no schema home (the Teams room name) rides in a template field.
      const secretFile = (id) => `/etc/alertmanager/secrets/${id}`;
      if (kind === 'msteams') {
        if (key === 'webhook_configs') {
          recCfg[key].push({ url_file: secretFile(`msteams_${slug(target)}`), send_resolved: true });
        } else {
          recCfg[key].push({ webhook_url_file: secretFile(`msteams_${slug(target)}`), send_resolved: true, title: `${target} · {{ .CommonLabels.alertname }}` });
        }
      }
      else if (kind === 'voice')   recCfg[key].push({ service_key_file: secretFile(`pagerduty_${slug(target.replace(/^.*:\/\//, ''))}`), details: { channel: target } });
      else if (kind === 'whatsapp')recCfg[key].push({ url_file: secretFile(`whatsapp_${slug(target)}`), send_resolved: true });
      else if (kind === 'email')   recCfg[key].push({ to: target, send_resolved: true });
      else if (kind === 'webhook') recCfg[key].push({ url: target, send_resolved: true });
    }
    receivers.push(recCfg);

    const match = {
      severity: route.severity,
      service: svc,
      ...(route.match || {}),
    };
    childRoutes.push({
      receiver: recName,
      group_by: ['slo', 'severity', 'alertname'],
      group_wait: '30s',
      group_interval: '5m',
      repeat_interval: route.severity === 'SEV1' ? '1h' : '4h',
      matchers: Object.entries(match).filter(([_, v]) => !!v).map(([k, v]) => `${k}="${v}"`),
    });
  });

  // Alertmanager stops at the first matching sibling route, so duplicate-
  // severity routes with identical matchers would leave every receiver after
  // the first silently unreachable. Chain each identical-matcher group with
  // `continue: true` (all but its last member) so every declared channel
  // actually fires.
  const routesByMatchers = new Map();
  for (const r of childRoutes) {
    const sig = r.matchers.join('|');
    if (!routesByMatchers.has(sig)) routesByMatchers.set(sig, []);
    routesByMatchers.get(sig).push(r);
  }
  for (const group of routesByMatchers.values()) {
    for (const r of group.slice(0, -1)) r.continue = true;
  }

  // Default "null" receiver for unmatched alerts so the config doesn't
  // claim a route to nowhere.
  if (!receivers.find(r => r.name === 'null')) {
    receivers.unshift({ name: 'null' });
  }

  const inhibit_rules = suppress.includes('maintenance_windows') ? [
    {
      source_matchers: ['maintenance="true"'],
      target_matchers: [`service="${svc}"`],
      equal: ['service'],
    },
  ] : undefined;

  // email_configs are unusable without SMTP settings — Alertmanager
  // rejects the config outright ("no global SMTP smarthost set"). Emit
  // deploy-time placeholders only when an email receiver exists.
  const hasEmail = receivers.some(r => (r.email_configs || []).length);
  const out = {
    global: {
      resolve_timeout: '5m',
      ...(hasEmail ? {
        smtp_smarthost: 'smtp.example.internal:587',   // replace at deploy time
        smtp_from: `alertmanager@${slug(svc)}.example.internal`,
      } : {}),
    },
    route: {
      receiver: 'null',
      group_by: ['alertname', 'severity'],
      group_wait: '15s',
      group_interval: '5m',
      repeat_interval: '12h',
      routes: childRoutes,
    },
    receivers,
    ...(inhibit_rules ? { inhibit_rules } : {}),
  };
  return banner('Alertmanager config', canonical) + emitYaml(out);
}

// ============================================================
// 3) OTel Collector — receivers + processors + exporters + service.pipelines
// ============================================================

export function compileOtelCollector(canonical, opts = {}) {
  const p = canonical?.spec?.pipelines || {};
  const otel = canonical?.spec?.otel || {};
  const profile = opts.profile || profileForTarget(canonical, 'otel-collector', opts);
  const kc = profile.knobs;

  // Receivers
  const receivers = {};
  for (const r of p.receivers || []) {
    const name = r.name;
    if (name === 'otlp') {
      receivers.otlp = {
        protocols: {
          grpc: { endpoint: r.endpoint || '0.0.0.0:4317' },
          http: { endpoint: '0.0.0.0:4318' },
        },
      };
    } else if (name === 'prometheus' && r.scrape_configs) {
      receivers.prometheus = { config: { scrape_configs: r.scrape_configs } };
    } else {
      // Round-trip whatever else the pack declares.
      const { name: _n, ...rest } = r;
      receivers[name] = Object.keys(rest).length ? rest : {};
    }
  }

  // Processors — inject the OTel-block-derived resource processor first
  // so service.name etc. land on every signal.
  const processors = {};
  const required = otel.resource_attributes?.required || [];
  if (required.length) {
    processors.resource = {
      attributes: required.map(k => ({ key: k, action: 'upsert', from_context: 'auto.populate' })),
    };
  }
  if (otel.sdk?.sampling?.policy?.startsWith('parentbased_') && otel.sdk?.sampling?.ratio != null) {
    processors.probabilistic_sampler = {
      sampling_percentage: Math.round(otel.sdk.sampling.ratio * 100),
    };
  }
  // Processors with schema-required knobs cannot round-trip as empty
  // blocks — the collector rejects e.g. memory_limiter without a
  // check_interval. Inject the documented sane defaults when the pack
  // declares the processor bare.
  const PROCESSOR_REQUIRED_DEFAULTS = {
    memory_limiter: { check_interval: '1s', limit_percentage: 80, spike_limit_percentage: 25 },
  };
  for (const proc of p.processors || []) {
    const { name, ...rest } = proc;
    const defaults = PROCESSOR_REQUIRED_DEFAULTS[name] || {};
    processors[name] = { ...defaults, ...rest };
    if (!Object.keys(processors[name]).length) processors[name] = {};
  }

  // Exporters. Two corrections keep the emitted config loadable by a
  // current collector (attested by `otelcol-contrib validate` in
  // tools/test-backend-validate.mjs):
  //  - kinds whose dedicated exporter was REMOVED from the collector
  //    map to their modern equivalent (jaeger → otlp: the jaeger
  //    exporter was deleted in v0.86; Jaeger ≥1.35 ingests OTLP);
  //  - exporters with schema-required fields get deploy-time
  //    placeholder values when the pack doesn't declare them — the
  //    collector refuses to load e.g. an elasticsearch exporter with
  //    no endpoint, so an empty block is not a valid hand-off.
  const EXPORTER_KIND_RENAMES = { jaeger: 'otlp' };
  const EXPORTER_REQUIRED_DEFAULTS = {
    prometheusremotewrite: { endpoint: 'http://prometheus:9090/api/v1/write' },
    elasticsearch: { endpoints: ['http://elasticsearch:9200'] },
    otlp: { endpoint: 'otel-gateway:4317', tls: { insecure: true } },
    otlphttp: { endpoint: 'http://otel-gateway:4318' },
    loki: { endpoint: 'http://loki:3100/loki/api/v1/push' },
    zipkin: { endpoint: 'http://zipkin:9411/api/v2/spans' },
  };
  const exporters = {};
  const exporterNames = { metrics: '', logs: '', traces: '' };
  for (const sig of ['metrics', 'logs', 'traces']) {
    const e = p.exporters?.[sig];
    if (!e) continue;
    const exporterName = EXPORTER_KIND_RENAMES[e.kind] || e.kind;
    exporterNames[sig] = exporterName;
    const { kind, ...rest } = e;
    exporters[exporterName] = Object.assign(exporters[exporterName] || {}, rest);
  }
  for (const [name, cfg] of Object.entries(exporters)) {
    const defaults = EXPORTER_REQUIRED_DEFAULTS[name];
    if (!defaults) continue;
    const hasTarget = cfg.endpoint || cfg.endpoints || cfg.cloudid;
    for (const [k, v] of Object.entries(defaults)) {
      if (hasTarget && (k === 'endpoint' || k === 'endpoints')) continue;
      if (cfg[k] === undefined) cfg[k] = v;
    }
  }

  // The console/debug exporter was renamed `logging` → `debug` in Collector
  // v0.86. A config that names the wrong one fails to start on the target
  // version, so rewrite to the form the resolved profile expects.
  const renameExporter = (from, to) => {
    if (exporters[from] && !exporters[to]) {
      exporters[to] = exporters[from];
      delete exporters[from];
      for (const sig of ['metrics', 'logs', 'traces']) {
        if (exporterNames[sig] === from) exporterNames[sig] = to;
      }
    }
  };
  if (kc.debugExporter) renameExporter('logging', 'debug');
  else renameExporter('debug', 'logging');

  // service.pipelines
  const pipelineNames = Object.keys(receivers);
  const processorNames = Object.keys(processors);
  // The Collector's self-telemetry metrics block changed: the bare
  // `address` was deprecated in favour of the OpenTelemetry `readers`
  // form. Emit whichever the resolved profile speaks.
  const metricsTelemetry = kc.telemetryMetricsReaders
    ? { readers: [{ pull: { exporter: { prometheus: { host: '0.0.0.0', port: 8888 } } } }] }
    : { address: '0.0.0.0:8888' };
  const service = {
    telemetry: {
      logs: { level: 'info', development: false },
      metrics: metricsTelemetry,
    },
    pipelines: {},
  };
  // Receivers and processors can be signal-restricted — the collector
  // refuses to build e.g. a metrics pipeline containing
  // probabilistic_sampler, or a traces pipeline fed by the prometheus
  // receiver ("telemetry type is not supported"). Filter per pipeline;
  // components not listed here support every signal.
  const RECEIVER_SIGNALS = {
    prometheus: new Set(['metrics']),
    filelog: new Set(['logs']),
    zipkin: new Set(['traces']),
    jaeger: new Set(['traces']),
  };
  const PROCESSOR_SIGNALS = {
    probabilistic_sampler: new Set(['traces', 'logs']),
    tail_sampling: new Set(['traces']),
    span: new Set(['traces']),
    spanmetrics: new Set(['traces']),
  };
  for (const sig of ['metrics', 'logs', 'traces']) {
    if (!exporterNames[sig]) continue;
    const sigReceivers = pipelineNames.filter(r => !RECEIVER_SIGNALS[r] || RECEIVER_SIGNALS[r].has(sig));
    if (!sigReceivers.length) continue;   // a pipeline with no receiver cannot exist
    service.pipelines[sig] = {
      receivers: sigReceivers,
      processors: processorNames.filter(p => !PROCESSOR_SIGNALS[p] || PROCESSOR_SIGNALS[p].has(sig)),
      exporters: [exporterNames[sig]],
    };
  }

  const out = {
    receivers,
    processors,
    exporters,
    service,
  };
  return banner('OTel Collector', canonical) + emitYaml(out);
}

// ============================================================
// 4) Grafana dashboard JSON — one per dashboards[] entry.
//
// Target: Grafana 12 / 13 (the spec's required-support floor). The
// default schemaVersion is GRAFANA_DEFAULT_SCHEMA_VERSION below; packs
// MAY pin their own via `dashboards[].provider.schemaVersion` (the
// schema floor is 30, so older Grafana installs still validate) but
// the compiler's default emits a dashboard whose schema lines up with
// Grafana 12's migration table and is forward-compatible with 13.
//
// Panel format pinned to features stable across 12 → 13:
//   - datasource as `{type, uid}` (object form, mandatory since v10)
//   - fieldConfig.defaults.thresholds in `mode: 'absolute'` with steps
//   - timeseries options/legend in the post-v10 shape
// ============================================================

const GRAFANA_DEFAULT_SCHEMA_VERSION = 41;   // Grafana 12.x baseline

export function compileGrafanaDashboard(canonical, dashboardId, opts = {}) {
  const dash = (canonical?.spec?.dashboards || []).find(d => d.id === dashboardId);
  if (!dash) throw new Error(`dashboard not found: ${dashboardId}`);
  const svc = nameOf(canonical);
  const svcS = serviceSlug(canonical);

  // Resolve the Grafana version profile from the dashboard's declared
  // provider (or an explicit override). The profile decides the datasource
  // form (object since v10, bare string before) and the dashboard
  // schemaVersion floor when the pack doesn't pin one.
  const profile = opts.profile || resolveProfile(dash.provider?.kind || 'grafana', opts.version ?? dash.provider?.version);
  const k = profile.knobs;
  // Pre-v10 Grafana referenced datasources by their bare uid string; v10+
  // requires the { type, uid } object. Emitting the wrong form makes panels
  // fail to bind on the real install — a genuine version behaviour.
  const dsMetrics = k.datasourceForm === 'string'
    ? DEFAULT_DATASOURCE_UID
    : { type: 'prometheus', uid: DEFAULT_DATASOURCE_UID };
  // Whether each query target repeats its datasource (post-v10) or inherits
  // it from the panel (pre-v10).
  const targetDs = k.panelTargetDatasource === false ? undefined : dsMetrics;
  const panels = [];
  let panelId = 0;
  let row = 0;
  const cols = 2;
  const w = 12, h = 8;

  const bindings = dash.panel_bindings || [];
  for (let i = 0; i < bindings.length; i++) {
    const b = bindings[i];
    const target = b.binds_to || '';
    const isSli = /^slis\./.test(target);
    const isSlo = /^slos\./.test(target);
    const sli = isSli ? findSli(canonical, target) : (isSlo ? findSli(canonical, findSlo(canonical, target)?.sli) : null);
    const slo = isSlo ? findSlo(canonical, target) : null;
    const sliId = sli?.id;

    panelId++;
    const x = (i % cols) * w;
    const y = Math.floor(i / cols) * h;

    const panel = {
      id: panelId,
      title: b.panel || target,
      type: 'timeseries',
      datasource: dsMetrics,
      gridPos: { x, y, w, h },
      targets: [{
        refId: 'A',
        datasource: targetDs,
        expr: sli && sli.type === 'ratio'
          ? `${svcS}:${sliId}:ratio_${RATE_WINDOW_RECORD}`
          : (sli ? sliExpression(sli) : `# unresolved: ${target}`),
        legendFormat: sliId || target,
      }],
      fieldConfig: {
        defaults: {
          ...(sli && sli.type === 'ratio'
            ? { unit: 'percentunit', min: 0, max: 1 }
            : { unit: sli?.unit === 'seconds' ? 's' : 'short' }),
          custom: { drawStyle: 'line', fillOpacity: 12, lineWidth: 2, pointSize: 3 },
        },
        overrides: [],
      },
      options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
    };

    // SLO panels get the objective rendered as a threshold line.
    if (slo) {
      panel.fieldConfig.defaults.thresholds = {
        mode: 'absolute',
        steps: [
          { color: 'red',   value: null },
          { color: 'green', value: slo.objective },
        ],
      };
      panel.fieldConfig.defaults.custom.thresholdsStyle = { mode: 'line' };
    }

    panels.push(panel);
  }

  // Always lead with a "SLO status" stat row when the dashboard binds at
  // least one SLO — it's the at-a-glance the on-call wants first.
  const sloBindings = bindings.filter(b => /^slos\./.test(b.binds_to));
  if (sloBindings.length) {
    const statPanels = sloBindings.map((b, i) => {
      const slo = findSlo(canonical, b.binds_to);
      const sli = slo ? findSli(canonical, slo.sli) : null;
      panelId++;
      return {
        id: panelId,
        title: slo?.id || b.binds_to,
        type: 'stat',
        datasource: dsMetrics,
        gridPos: { x: (i % 4) * 6, y: 0, w: 6, h: 4 },
        targets: [{
          refId: 'A',
          datasource: targetDs,
          expr: sli && sli.type === 'ratio' ? `${svcS}:${metricSafe(sli.id)}:ratio_${RATE_WINDOW_RECORD}` : '',
          legendFormat: slo?.id,
        }],
        fieldConfig: {
          defaults: {
            unit: 'percentunit', decimals: 2,
            thresholds: {
              mode: 'absolute',
              steps: [
                { color: 'red',   value: null },
                { color: 'orange', value: (slo?.objective || 0.99) - 0.005 },
                { color: 'green', value: slo?.objective || 0.99 },
              ],
            },
          },
        },
        options: { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'background', graphMode: 'area' },
      };
    });
    // Shift the rest of the panels down by 4 rows.
    for (const p of panels) p.gridPos.y += 4;
    panels.unshift(...statPanels);
  }

  const out = {
    title: dash.id,
    // Grafana rejects uids over 40 chars — same capped builder as rules
    // (T4 caught the uncapped template: every payment-service dashboard
    // uid was 41+ chars and the dashboards API refused all of them).
    uid: grafanaUid('obs-pack', `${svcS}-${dash.id}`),
    description: `Compiled from ${nameOf(canonical)} pack. Do not hand-edit — re-emit from the pack.`,
    // The obs-pack-id tag carries the pack-declared identity THROUGH the
    // platform: uids are capped/fingerprinted, so the live fetcher reads
    // this tag to give the dashboard the same canonical id the source
    // pack declares — that's what makes the deploy→fetch→diff round trip
    // close as ALIGNED instead of an id-mismatched pair.
    tags: ['observability-pack', svcS, `obs-pack-id:${dash.id}`],
    timezone: 'browser',
    // The pack MAY pin schemaVersion explicitly; otherwise the resolved
    // Grafana profile supplies the version-correct value.
    schemaVersion: dash.provider?.schemaVersion ?? k.schemaVersion ?? GRAFANA_DEFAULT_SCHEMA_VERSION,
    version: 1,
    refresh: '30s',
    time: { from: 'now-6h', to: 'now' },
    panels,
    templating: { list: [] },
    annotations: { list: [{ datasource: dsMetrics, enable: true, name: 'Annotations & Alerts', target: { matchAny: false, tags: [], type: 'dashboard' } }] },
  };
  return JSON.stringify(out, null, 2);
}

// ============================================================
// Banner — small provenance comment at the top of YAML outputs.
// ============================================================

function banner(target, canonical) {
  return (
    `# ${target} compiled from ObservabilityPack v1.2\n` +
    `# Pack: ${nameOf(canonical)} · version ${canonical?.metadata?.version || '?'}\n` +
    `# Source of truth — DO NOT hand-edit. Re-emit from the pack.\n` +
    `# Generated by tools/lib/compile.mjs\n`
  );
}

// ============================================================
// Dispatcher
// ============================================================

export const TARGETS = {
  'prometheus-rules': {
    label: 'Prometheus rules',
    description: 'Recording + multi-window burn-rate alerting rules. Ingestible by Prometheus or Mimir ruler.',
    contentType: 'application/x-yaml',
    extension: 'yaml',
    family: 'prometheus-rules',
    suggestedFile: (canonical) => `${serviceSlug(canonical)}.rules.yaml`,
    compile: (canonical, opts) => compilePrometheusRules(canonical, opts),
  },
  'otel-collector': {
    label: 'OTel Collector',
    description: 'OpenTelemetry Collector config (receivers / processors / exporters / service.pipelines).',
    contentType: 'application/x-yaml',
    extension: 'yaml',
    family: 'otel-collector',
    suggestedFile: (canonical) => `${serviceSlug(canonical)}.otel-collector.yaml`,
    compile: (canonical, opts) => compileOtelCollector(canonical, opts),
  },
  'alertmanager': {
    label: 'Alertmanager',
    description: 'Route tree + receivers per severity. Inhibit rules from suppress contexts.',
    contentType: 'application/x-yaml',
    extension: 'yaml',
    family: 'alertmanager',
    suggestedFile: (canonical) => `${serviceSlug(canonical)}.alertmanager.yaml`,
    compile: (canonical, opts) => compileAlertmanager(canonical, opts),
  },
  'grafana-dashboard': {
    label: 'Grafana dashboard',
    description: 'Grafana dashboard JSON, emitted at the schemaVersion of the pack-declared Grafana version. One per `spec.dashboards[]` entry; pass the dashboard id as an arg.',
    contentType: 'application/json',
    extension: 'json',
    family: 'grafana-dashboard',
    suggestedFile: (canonical, opts) => `${serviceSlug(canonical)}.${slug(opts?.dashboardId || 'dashboard')}.json`,
    compile: (canonical, opts) => compileGrafanaDashboard(canonical, opts?.dashboardId || canonical?.spec?.dashboards?.[0]?.id, opts),
  },
};

export function compile(canonical, target, opts = {}) {
  const t = TARGETS[target];
  if (!t) throw new Error(`unknown compile target: ${target}. Try one of: ${Object.keys(TARGETS).join(', ')}`);
  // Resolve the version profile this target compiles against so callers can
  // see which product+version the artefact was shaped for (and whether the
  // declared version actually matched a known band).
  const profile = profileForTarget(canonical, t.family || target, opts);
  // Compile-time warnings (an SLI without an error-ratio form, a comparison
  // rewritten to bool form, ...) are collected unless the caller sinks them.
  const warnings = [];
  const onWarning = opts.onWarning || ((m) => warnings.push(m));
  return {
    target,
    contentType: t.contentType,
    filename: t.suggestedFile(canonical, opts),
    content: t.compile(canonical, { ...opts, profile, onWarning }),
    warnings,
    profile: {
      product: profile.product,
      version: profile.version,
      band: profile.band,
      label: profile.label,
      tractability: profile.tractability,
      matched: profile.matched,
      extrapolated: profile.extrapolated,
      protocols: profile.protocols,
    },
  };
}

export function listTargets() {
  return Object.entries(TARGETS).map(([id, t]) => ({
    id,
    label: t.label,
    description: t.description,
    contentType: t.contentType,
    extension: t.extension,
    family: t.family || id,
  }));
}

// Re-export the profile API so callers that already import compile.mjs can
// inspect/select version profiles without a second import.
export { resolveProfile, listProfiles, listProtocols, satisfies, parseVersion } from './profiles.mjs';
