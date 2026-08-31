// tools/lib/compile.mjs
//
// Canonical ObservabilityPack v1.2 → real, ingestable platform artefacts.
//
// The pack is the source of truth. This module compiles it into the
// native formats the platform actually runs on:
//
//   prometheus-rules   Prometheus recording + multi-window burn-rate alerts
//   otel-collector     OTel Collector config (receivers/processors/exporters)
//   alertmanager       Alertmanager route tree + receivers
//   grafana-dashboard  Grafana 12/13 dashboard JSON (one pack section per call)
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

// ============================================================
// Helpers — ref resolution, slug normalisation, expression building
// ============================================================

const RATE_WINDOW_RECORD = '5m';   // default record window for ratio SLIs
const DEFAULT_DATASOURCE_UID = '${DS_PROMETHEUS}';

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

function serviceSlug(canonical) {
  return slug(nameOf(canonical)).replace(/-/g, '_');
}

function findSli(canonical, sliId) {
  if (!sliId) return null;
  const id = String(sliId).replace(/^slis\./, '');
  return (canonical?.spec?.slis || []).find(x => x.id === id) || null;
}

function findSlo(canonical, sloId) {
  if (!sloId) return null;
  const id = String(sloId).replace(/^slos\./, '').replace(/^ref:/, '');
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

// One leg (good or total) of an SLI ratio, evaluated at burn window `w`.
// Packs declare the legs in two shapes:
//   - a bare series selector (`http_requests_total{...}`) — wrap it in
//     the standard sum(rate(sel[w]));
//   - a full rate expression (`sum(rate(sel[5m]))`) — swap its range
//     windows for `w` instead. Wrapping a rate in another rate is not
//     valid PromQL (promtool: "could not parse expression"), which is
//     exactly what the old unconditional wrap emitted.
// Only simple range selectors (`[5m]`, no subquery colon) are swapped.
const RANGE_SELECTOR_RE = /\[\s*\d+(?:\.\d+)?(?:ms|s|m|h|d|w|y)\s*\]/g;
function sliLegAt(expr, w) {
  const e = strip(expr);
  if (!e) return e;
  // A scalar literal leg (live-drafted packs declare `total: "1"` when
  // `good` is already a complete ratio) — wrapping a scalar in rate()
  // is a promtool parse error ("ranges only allowed for vector
  // selectors"); use it verbatim.
  if (/^\d+(?:\.\d+)?$/.test(e)) return e;
  if (RANGE_SELECTOR_RE.test(e)) {
    RANGE_SELECTOR_RE.lastIndex = 0;
    return `(${e.replace(RANGE_SELECTOR_RE, `[${w}]`)})`;
  }
  return `sum(rate(${e}[${w}]))`;
}

// Prometheus metric/rule names accept only [a-zA-Z0-9_:] without the
// UTF-8 quoting syntax — an SLI id like `latência` embedded raw into a
// recording-rule name is a promtool parse error. Labels keep the raw id
// (label VALUES are full UTF-8); only name positions sanitize.
function metricSafe(id) {
  return String(id ?? '').replace(/[^a-zA-Z0-9_]/g, '_');
}

// The error-ratio expression for an SLI at burn window `w`.
function burnErrorRatioAt(sli, w) {
  return `(1 - ${sliLegAt(sli.good, w)} / ${sliLegAt(sli.total, w)})`;
}

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

export function compilePrometheusRules(canonical, opts = {}) {
  const svc = serviceSlug(canonical);
  const profile = opts.profile || profileForTarget(canonical, 'prometheus-rules', opts);
  const groups = [];

  // ----- recording rules -----
  // (a) Per-SLO ratio rule at the standard record window. This is the
  // "ground truth" series everything else hangs off.
  const recordingRules = [];
  for (const slo of canonical?.spec?.slos || []) {
    const sli = findSli(canonical, slo.sli);
    if (!sli) continue;
    const expr = sliExpression(sli);
    if (!expr) continue;
    if (sli.type === 'ratio') {
      // Materialise good/total/ratio so downstream alerts read the
      // recorded series, not the raw expression each evaluation.
      recordingRules.push({
        record: `${svc}:${metricSafe(sli.id)}:good_${RATE_WINDOW_RECORD}`,
        expr: strip(sli.good),
        labels: { slo: slo.id, sli: sli.id, service: nameOf(canonical) },
      });
      recordingRules.push({
        record: `${svc}:${metricSafe(sli.id)}:total_${RATE_WINDOW_RECORD}`,
        expr: strip(sli.total),
        labels: { slo: slo.id, sli: sli.id, service: nameOf(canonical) },
      });
      recordingRules.push({
        record: `${svc}:${metricSafe(sli.id)}:ratio_${RATE_WINDOW_RECORD}`,
        expr: `${svc}:${metricSafe(sli.id)}:good_${RATE_WINDOW_RECORD} / ${svc}:${metricSafe(sli.id)}:total_${RATE_WINDOW_RECORD}`,
        labels: { slo: slo.id, sli: sli.id, service: nameOf(canonical) },
      });
      recordingRules.push({
        record: `${svc}:${metricSafe(sli.id)}:error_ratio_${RATE_WINDOW_RECORD}`,
        expr: `1 - ${svc}:${metricSafe(sli.id)}:ratio_${RATE_WINDOW_RECORD}`,
        labels: { slo: slo.id, sli: sli.id, service: nameOf(canonical) },
      });
    } else {
      recordingRules.push({
        record: `${svc}:${metricSafe(sli.id)}:value_${RATE_WINDOW_RECORD}`,
        expr,
        labels: { slo: slo.id, sli: sli.id, service: nameOf(canonical) },
      });
    }
  }

  // (b) Author-declared recording rules — resolve symbolic refs.
  for (const rule of canonical?.spec?.queries?.recording_rules || []) {
    recordingRules.push({
      record: rule.name,
      expr: resolveRefs(rule.expr, canonical),
      ...(rule.interval ? { } : {}),
      ...(rule.labels ? { labels: rule.labels } : {}),
    });
  }

  if (recordingRules.length) {
    groups.push({
      name: `${svc}_recording`,
      interval: '30s',
      rules: recordingRules,
    });
  }

  // ----- burn-rate alerts -----
  // The pack expresses these declaratively as (slo, [{short, long, factor,
  // severity}]). We emit one alert per window: multi-window correlation
  // (short AND long both burning at factor×budget) per the Google SRE
  // burn-rate playbook.
  for (const ba of canonical?.spec?.policy?.burn_rate_alerts || []) {
    const slo = findSlo(canonical, ba.slo);
    if (!slo) continue;
    const sli = findSli(canonical, slo.sli);
    if (!sli || sli.type !== 'ratio') continue;
    const budget = 1 - slo.objective;
    if (!(budget > 0)) continue;

    const rules = [];
    for (const w of ba.windows || []) {
      const short = w.short, long = w.long;
      const factor = w.factor || 1;
      const sev = w.severity || 'SEV3';
      const alertName = `${slo.id}_burn_${factor}x_${short}_${long}`.replace(/[^a-zA-Z0-9_]/g, '_');
      const shortErr = burnErrorRatioAt(sli, short);
      const longErr  = burnErrorRatioAt(sli, long);
      const threshold = (factor * budget).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
      rules.push({
        alert: alertName,
        expr: `(${shortErr} > ${threshold}) and (${longErr} > ${threshold})`,
        for: shortFor(short),
        // `keep_firing_for` debounces resolution so a burn alert doesn't
        // flap as the ratio crosses the threshold. It was added in
        // Prometheus 2.42; VictoriaMetrics/vmalert and older Prometheus
        // reject the field, so only the profiles that support it emit it.
        ...(profile.knobs.keepFiringFor ? { keep_firing_for: long } : {}),
        labels: {
          severity: sev,
          slo: slo.id,
          sli: sli.id,
          service: nameOf(canonical),
          burn_rate: String(factor),
          window_short: short,
          window_long: long,
        },
        annotations: {
          summary: `Burn rate ${factor}× on ${slo.id}`,
          description: `Both the ${short} and ${long} error rates exceed ${factor}× of the ${(budget * 100).toFixed(3)}% error budget for ${slo.id}.`,
          slo_objective: `${(slo.objective * 100).toFixed(3)}%`,
          slo_window: slo.window,
          runbook: '(supply runbook URL)',
        },
      });
    }

    if (rules.length) {
      groups.push({
        name: `${svc}_${slo.id}_burn`,
        interval: '30s',
        rules,
      });
    }
  }

  // ----- forecast alerts -----
  // The spec carves a separate `forecasts` block; we emit them as
  // alerting rules using `predict_linear` (the standard PromQL forecasting
  // primitive). They're advisory by default; the on_projected_breach
  // field rides into annotations so Alertmanager can route accordingly.
  const forecastRules = [];
  for (const f of canonical?.spec?.policy?.forecasts || []) {
    const slo = findSlo(canonical, f.slo);
    if (!slo) continue;
    const sli = findSli(canonical, slo.sli);
    if (!sli || sli.type !== 'ratio') continue;
    const horizonSec = durationSeconds(f.horizon || '7d') || (7 * 86400);
    const budget = (1 - slo.objective).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    forecastRules.push({
      alert: `${slo.id}_forecast_breach`,
      expr: `predict_linear(${svc}:${metricSafe(sli.id)}:error_ratio_${RATE_WINDOW_RECORD}[1h], ${horizonSec}) > ${budget}`,
      for: '15m',
      labels: { severity: 'SEV3', slo: slo.id, kind: 'forecast', service: nameOf(canonical) },
      annotations: {
        summary: `${slo.id} projected to breach within ${f.horizon || '7d'}`,
        method: f.method || 'linear',
        on_projected_breach: f.on_projected_breach || 'open_ticket',
      },
    });
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

function shortFor(d) {
  // 2 minutes is a reasonable default for `for:` on a 5m short-window
  // burn-rate alert. Otherwise pin it to short / 2 if we can parse.
  const s = durationSeconds(d);
  if (!s) return '2m';
  if (s <= 300) return '2m';
  if (s <= 1800) return '5m';
  return '10m';
}

// ----------------------------------------------------------------
// Per-SLO rules builders — used by both Prometheus and
// Grafana-managed compilers, and by the per-artifact selection UI.
// Returned arrays are the same in-memory rule shape the dispatcher
// then formats for each platform.
// ----------------------------------------------------------------

function buildRecordingRulesForSlo(canonical, slo) {
  const sli = findSli(canonical, slo.sli);
  if (!sli) return [];
  const svc = serviceSlug(canonical);
  const expr = sliExpression(sli);
  if (!expr) return [];
  const labels = { slo: slo.id, sli: sli.id, service: nameOf(canonical) };

  if (sli.type === 'ratio') {
    return [
      { record: `${svc}:${metricSafe(sli.id)}:good_${RATE_WINDOW_RECORD}`, expr: strip(sli.good), labels },
      { record: `${svc}:${metricSafe(sli.id)}:total_${RATE_WINDOW_RECORD}`, expr: strip(sli.total), labels },
      { record: `${svc}:${metricSafe(sli.id)}:ratio_${RATE_WINDOW_RECORD}`, expr: `${svc}:${metricSafe(sli.id)}:good_${RATE_WINDOW_RECORD} / ${svc}:${metricSafe(sli.id)}:total_${RATE_WINDOW_RECORD}`, labels },
      { record: `${svc}:${metricSafe(sli.id)}:error_ratio_${RATE_WINDOW_RECORD}`, expr: `1 - ${svc}:${metricSafe(sli.id)}:ratio_${RATE_WINDOW_RECORD}`, labels },
    ];
  }
  return [{ record: `${svc}:${metricSafe(sli.id)}:value_${RATE_WINDOW_RECORD}`, expr, labels }];
}

function buildBurnRateAlertsForSlo(canonical, slo, burnRateBlock) {
  const sli = findSli(canonical, slo.sli);
  if (!sli || sli.type !== 'ratio') return [];
  const budget = 1 - slo.objective;
  if (!(budget > 0)) return [];
  const svc = serviceSlug(canonical);
  const out = [];
  for (const w of burnRateBlock?.windows || []) {
    const short = w.short, long = w.long;
    const factor = w.factor || 1;
    const sev = w.severity || 'SEV3';
    const alertName = `${slo.id}_burn_${factor}x_${short}_${long}`.replace(/[^a-zA-Z0-9_]/g, '_');
    const shortErr = burnErrorRatioAt(sli, short);
    const longErr  = burnErrorRatioAt(sli, long);
    const threshold = (factor * budget).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    out.push({
      alert: alertName,
      expr: `(${shortErr} > ${threshold}) and (${longErr} > ${threshold})`,
      for: shortFor(short),
      labels: { severity: sev, slo: slo.id, sli: sli.id, service: nameOf(canonical), burn_rate: String(factor), window_short: short, window_long: long },
      annotations: {
        summary: `Burn rate ${factor}× on ${slo.id}`,
        description: `Both the ${short} and ${long} error rates exceed ${factor}× of the ${(budget * 100).toFixed(3)}% error budget for ${slo.id}.`,
        slo_objective: `${(slo.objective * 100).toFixed(3)}%`,
        slo_window: slo.window,
        runbook: '(supply runbook URL)',
      },
    });
  }
  return out;
}

function buildForecastAlertForSlo(canonical, slo, forecast) {
  const sli = findSli(canonical, slo.sli);
  if (!sli || sli.type !== 'ratio') return null;
  const svc = serviceSlug(canonical);
  const horizonSec = durationSeconds(forecast.horizon || '7d') || (7 * 86400);
  const budget = (1 - slo.objective).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return {
    alert: `${slo.id}_forecast_breach`,
    expr: `predict_linear(${svc}:${metricSafe(sli.id)}:error_ratio_${RATE_WINDOW_RECORD}[1h], ${horizonSec}) > ${budget}`,
    for: '15m',
    labels: { severity: 'SEV3', slo: slo.id, kind: 'forecast', service: nameOf(canonical) },
    annotations: {
      summary: `${slo.id} projected to breach within ${forecast.horizon || '7d'}`,
      method: forecast.method || 'linear',
      on_projected_breach: forecast.on_projected_breach || 'open_ticket',
    },
  };
}

// ----------------------------------------------------------------
// Per-artifact Prometheus compilers — emit a SUBSET of the
// rules file scoped to one SLO or one author-declared rule.
// The output is still a valid Prometheus rules YAML file so it
// drops into Mimir/Prometheus ruler the same way.
// ----------------------------------------------------------------

export function compileSloPrometheusRules(canonical, sloId) {
  const slo = findSlo(canonical, sloId);
  if (!slo) throw new Error(`SLO not found: ${sloId}`);
  const svc = serviceSlug(canonical);
  const groups = [];

  const recording = buildRecordingRulesForSlo(canonical, slo);
  if (recording.length) groups.push({ name: `${svc}_${slo.id}_recording`, interval: '30s', rules: recording });

  for (const ba of (canonical?.spec?.policy?.burn_rate_alerts || []).filter(b => b.slo === slo.id)) {
    const alerts = buildBurnRateAlertsForSlo(canonical, slo, ba);
    if (alerts.length) groups.push({ name: `${svc}_${slo.id}_burn`, interval: '30s', rules: alerts });
  }
  for (const f of (canonical?.spec?.policy?.forecasts || []).filter(x => x.slo === slo.id)) {
    const fa = buildForecastAlertForSlo(canonical, slo, f);
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

function buildGrafanaRecordingRule(rec) {
  // Grafana-managed recording rule: title + record block + a single
  // Prometheus query that returns the materialised metric.
  return {
    uid: grafanaRuleUid('rec', rec.record),
    title: rec.record,
    condition: 'A',
    data: [grafanaPromQuery('A', rec.expr, false)],
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

export function compileGrafanaManagedRules(canonical) {
  const svc = serviceSlug(canonical);
  const groups = [];

  // Recording rules (per-SLO ratios + author-declared)
  const recordingRules = [];
  for (const slo of canonical?.spec?.slos || []) {
    for (const r of buildRecordingRulesForSlo(canonical, slo)) {
      recordingRules.push(buildGrafanaRecordingRule(r));
    }
  }
  for (const decl of canonical?.spec?.queries?.recording_rules || []) {
    recordingRules.push(buildGrafanaRecordingRule({
      record: decl.name,
      expr: resolveRefs(decl.expr, canonical),
      labels: decl.labels || {},
    }));
  }
  if (recordingRules.length) groups.push(grafanaGroupOf(`${svc}_recording`, recordingRules, '30s'));

  // Burn-rate alerts (per SLO)
  for (const ba of canonical?.spec?.policy?.burn_rate_alerts || []) {
    const slo = findSlo(canonical, ba.slo);
    if (!slo) continue;
    const rules = buildBurnRateAlertsForSlo(canonical, slo, ba).map(buildGrafanaAlertRule);
    if (rules.length) groups.push(grafanaGroupOf(`${svc}_${slo.id}_burn`, rules, '30s'));
  }

  // Forecast alerts
  const forecastRules = [];
  for (const f of canonical?.spec?.policy?.forecasts || []) {
    const slo = findSlo(canonical, f.slo);
    if (!slo) continue;
    const fa = buildForecastAlertForSlo(canonical, slo, f);
    if (fa) forecastRules.push(buildGrafanaAlertRule(fa));
  }
  if (forecastRules.length) groups.push(grafanaGroupOf(`${svc}_forecast`, forecastRules, '5m'));

  return bannerForGrafana('Grafana-managed rules', canonical) + emitYaml({ apiVersion: 1, groups });
}

export function compileSloGrafanaManagedRules(canonical, sloId) {
  const slo = findSlo(canonical, sloId);
  if (!slo) throw new Error(`SLO not found: ${sloId}`);
  const svc = serviceSlug(canonical);
  const groups = [];

  const recording = buildRecordingRulesForSlo(canonical, slo).map(buildGrafanaRecordingRule);
  if (recording.length) groups.push(grafanaGroupOf(`${svc}_${slo.id}_recording`, recording, '30s'));

  for (const ba of (canonical?.spec?.policy?.burn_rate_alerts || []).filter(b => b.slo === slo.id)) {
    const rules = buildBurnRateAlertsForSlo(canonical, slo, ba).map(buildGrafanaAlertRule);
    if (rules.length) groups.push(grafanaGroupOf(`${svc}_${slo.id}_burn`, rules, '30s'));
  }
  for (const f of (canonical?.spec?.policy?.forecasts || []).filter(x => x.slo === slo.id)) {
    const fa = buildForecastAlertForSlo(canonical, slo, f);
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
    for (const slo of canonical.spec.slos || []) {
      const sli = findSli(canonical, slo.sli);
      const recCount = sli ? (sli.type === 'ratio' ? 4 : 1) : 0;
      const burnCount = (canonical?.spec?.policy?.burn_rate_alerts || [])
        .filter(b => b.slo === slo.id)
        .reduce((s, b) => s + (b.windows?.length || 0), 0);
      const forecastCount = (canonical?.spec?.policy?.forecasts || [])
        .filter(f => f.slo === slo.id).length;
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

export function compileArtifact(canonical, { group, flavor, artifact, dashboardId }) {
  if (group === 'rules') {
    if (flavor === 'prometheus' || !flavor) {
      if (!artifact || artifact === 'all') {
        return { contentType: 'application/x-yaml', filename: `${serviceSlug(canonical)}.rules.yaml`, content: compilePrometheusRules(canonical) };
      }
      if (artifact.startsWith('slo:')) {
        const sloId = artifact.slice(4);
        return { contentType: 'application/x-yaml', filename: `${serviceSlug(canonical)}.${slug(sloId)}.rules.yaml`, content: compileSloPrometheusRules(canonical, sloId) };
      }
      if (artifact.startsWith('declared:')) {
        const idx = parseInt(artifact.slice(9), 10);
        return { contentType: 'application/x-yaml', filename: `${serviceSlug(canonical)}.declared-${idx}.rules.yaml`, content: compileDeclaredPrometheusRule(canonical, idx) };
      }
    }
    if (flavor === 'grafana-managed') {
      if (!artifact || artifact === 'all') {
        return { contentType: 'application/x-yaml', filename: `${serviceSlug(canonical)}.grafana-rules.yaml`, content: compileGrafanaManagedRules(canonical) };
      }
      if (artifact.startsWith('slo:')) {
        const sloId = artifact.slice(4);
        return { contentType: 'application/x-yaml', filename: `${serviceSlug(canonical)}.${slug(sloId)}.grafana-rules.yaml`, content: compileSloGrafanaManagedRules(canonical, sloId) };
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
  return {
    target,
    contentType: t.contentType,
    filename: t.suggestedFile(canonical, opts),
    content: t.compile(canonical, { ...opts, profile }),
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
