// tools/lib/contracts/stack-self-metrics.mjs
//
// STACK SELF-METRIC ALIAS TABLE — the observability stack's own health
// metrics, one row per signal Observogram samples through the MCP's
// `metrics_query` tool (roadmap step 2: acquisition).
//
// THESIS LINE: every number sampled from this table is a point-in-time
// SIGNAL, never a verdict. Nothing here (and nothing built on it) creates a
// `Verified` stamp, an SLO verdict, or a grade change; on a restricted MCP
// tier the answer is "not attempted" with the reason, never "absent".
// The sampler policy lives in the fetcher; this file is data + lookups.
//
// Row fields:
//   id            stable signal id (unique)
//   family        scrape | ruler | notify | tsdb | collector | dashboards |
//                 synthetic | logs | traces
//   signal        plain-English "what it measures"
//   unit          ratio | count | per-second | per-hour | seconds
//   direction     lower | higher | info — a DISPLAY hint only (which way is
//                 comfortable); never a threshold, never a verdict
//   referenceSli  "<pack>/<sli id>" naming the reference-pack SLI whose
//                 vocabulary the row follows (reference-packs/*.pack.yaml),
//                 or null when no reference SLI covers it
//   aliases       ORDERED product-specific expressions; each carries
//                 `requires` — the metric names that must exist in the
//                 inventory for that alias to be eligible. Order is the
//                 fallback order (generic first, then by product).
//   source        which product's upstream documentation the metric names
//                 follow — nothing in this table was re-recorded against a
//                 live stack in the session that wrote it (no credentials,
//                 no Docker); the recorder script lets a maintainer verify
//                 each row later against a real MCP.
//
// KNOWN DISCREPANCY (documented, not fixed): reference-packs/prometheus
// `scrape_duration_p99` is written over `scrape_duration_seconds_bucket`,
// but Prometheus exposes `scrape_duration_seconds` as a per-target GAUGE
// (no histogram) — the reference pack's histogram_quantile can never
// answer. Row `scrape_duration_max` therefore samples
// `max(scrape_duration_seconds)` and points at the reference SLI only for
// vocabulary.
//
// Pure ESM, data + lookup resolvers only. No control flow beyond mapping
// and filtering, no Node APIs — browser-safe by construction.

export const STACK_FAMILIES = Object.freeze([
  'scrape', 'ruler', 'notify', 'tsdb', 'collector', 'dashboards', 'synthetic', 'logs', 'traces',
]);
export const STACK_UNITS = Object.freeze(['ratio', 'count', 'per-second', 'per-hour', 'seconds']);
export const STACK_DIRECTIONS = Object.freeze(['lower', 'higher', 'info']);

// Per-row sample outcomes, best first — the order `bestOutcome` ranks by
// when the fetcher summarises a family (`mcp.stack.families`). Rows are
// never "ok": a sample is data, or it is one of the honest non-answers.
export const STACK_OUTCOMES = Object.freeze(['data', 'empty', 'failed', 'not-in-inventory', 'not-attempted']);

// Upstream documentation each alias's metric names follow.
const SRC = Object.freeze({
  prometheus:      'Prometheus server self-metrics (/metrics): docs.prometheus.io — "Jobs and instances" (up, scrape_duration_seconds) and the prometheus_* series the server exposes',
  victoriametrics: 'VictoriaMetrics docs — vmagent "Monitoring" (vm_promscrape_targets), vmalert "Monitoring" (vmalert_*_error_total, vmalert_alerts_send_errors_total), VictoriaMetrics "Monitoring" (vm_cache_entries{type="storage/hour_metric_ids"} = active time series)',
  grafana:         'Grafana docs — "Grafana metrics" (internal /metrics): grafana_alerting_rule_evaluation_failures_total, grafana_datasource_request_total, grafana_http_request_duration_seconds',
  alertmanager:    'Prometheus Alertmanager self-metrics (/metrics): alertmanager_notifications_total, alertmanager_notifications_failed_total, alertmanager_silences{state}',
  otelcol:         'OpenTelemetry Collector docs — "Internal telemetry": otelcol_exporter_send_failed_*, otelcol_processor_dropped_*, otelcol_exporter_queue_size / queue_capacity; the `_total` suffix is added by the Prometheus exposition of newer collectors, older ones expose the bare name',
  blackbox:        'prometheus/blackbox_exporter README: probe_success',
  promtail:        'Grafana Loki docs — Promtail "Observability": promtail_dropped_entries_total',
  jaeger:          'Jaeger docs — collector metrics: jaeger_collector_spans_dropped_total',
});

const alias = (product, expr, requires) => Object.freeze({ product, expr, requires: Object.freeze(requires) });

const row = (r) => Object.freeze({ ...r, aliases: Object.freeze(r.aliases) });

// One row per otelcol counter pair: the `_total`-suffixed exposition first
// (current collectors), the bare name second (older collectors).
const otelcolPair = (metric) => [
  alias('otelcol', `sum(rate(${metric}_total[5m]))`, [`${metric}_total`]),
  alias('otelcol', `sum(rate(${metric}[5m]))`, [metric]),
];

export const STACK_SELF_METRIC_PROBES = Object.freeze([
  // ---- scrape ---------------------------------------------------------
  row({
    id: 'scrape_success_ratio', family: 'scrape',
    signal: 'fraction of scrape targets up', unit: 'ratio', direction: 'higher',
    referenceSli: 'prometheus-reference/scrape_success_ratio',
    aliases: [alias('generic', 'sum(up == 1) / count(up)', ['up'])],
    source: SRC.prometheus,
  }),
  row({
    id: 'scrape_targets_down', family: 'scrape',
    signal: 'scrape targets down', unit: 'count', direction: 'lower',
    referenceSli: null,
    aliases: [
      alias('generic', 'count(up == 0)', ['up']),
      alias('victoriametrics', 'sum(vm_promscrape_targets{status="down"})', ['vm_promscrape_targets']),
    ],
    source: `${SRC.prometheus}; ${SRC.victoriametrics}`,
  }),
  row({
    id: 'scrape_duration_max', family: 'scrape',
    signal: 'slowest scrape (gauge — see the discrepancy note in the header)', unit: 'seconds', direction: 'lower',
    referenceSli: 'prometheus-reference/scrape_duration_p99',
    aliases: [alias('generic', 'max(scrape_duration_seconds)', ['scrape_duration_seconds'])],
    source: SRC.prometheus,
  }),

  // ---- ruler ----------------------------------------------------------
  row({
    id: 'rule_evaluation_failures', family: 'ruler',
    signal: 'rule evaluation failures per second', unit: 'per-second', direction: 'lower',
    referenceSli: 'prometheus-reference/rule_evaluation_success_ratio',
    aliases: [
      alias('prometheus', 'sum(rate(prometheus_rule_evaluation_failures_total[5m]))', ['prometheus_rule_evaluation_failures_total']),
      alias('victoriametrics', 'sum(rate(vmalert_recording_rules_error_total[5m])) + sum(rate(vmalert_alerting_rules_error_total[5m]))', ['vmalert_recording_rules_error_total', 'vmalert_alerting_rules_error_total']),
      alias('grafana', 'sum(rate(grafana_alerting_rule_evaluation_failures_total[5m]))', ['grafana_alerting_rule_evaluation_failures_total']),
    ],
    source: `${SRC.prometheus}; ${SRC.victoriametrics}; ${SRC.grafana}`,
  }),
  row({
    id: 'rule_evaluation_staleness', family: 'ruler',
    signal: 'seconds since the oldest rule group last evaluated', unit: 'seconds', direction: 'lower',
    referenceSli: null,
    aliases: [alias('prometheus', 'max(time() - prometheus_rule_group_last_evaluation_timestamp_seconds)', ['prometheus_rule_group_last_evaluation_timestamp_seconds'])],
    source: SRC.prometheus,
  }),

  // ---- notify ---------------------------------------------------------
  row({
    id: 'notification_errors', family: 'notify',
    signal: 'alert notification send errors per second', unit: 'per-second', direction: 'lower',
    referenceSli: 'prometheus-reference/alertmanager_notification_success_ratio',
    aliases: [
      alias('prometheus', 'sum(rate(prometheus_notifications_errors_total[5m]))', ['prometheus_notifications_errors_total']),
      alias('victoriametrics', 'sum(rate(vmalert_alerts_send_errors_total[5m]))', ['vmalert_alerts_send_errors_total']),
      alias('alertmanager', 'sum(rate(alertmanager_notifications_failed_total[5m]))', ['alertmanager_notifications_failed_total']),
    ],
    source: `${SRC.prometheus}; ${SRC.victoriametrics}; ${SRC.alertmanager}`,
  }),
  row({
    id: 'notifications_sent', family: 'notify',
    signal: 'notifications sent per second (delivery-path liveness)', unit: 'per-second', direction: 'info',
    referenceSli: null,
    aliases: [
      alias('alertmanager', 'sum(rate(alertmanager_notifications_total[5m]))', ['alertmanager_notifications_total']),
      alias('prometheus', 'sum(rate(prometheus_notifications_sent_total[5m]))', ['prometheus_notifications_sent_total']),
    ],
    source: `${SRC.alertmanager}; ${SRC.prometheus}`,
  }),
  row({
    id: 'active_silences', family: 'notify',
    signal: 'active silences', unit: 'count', direction: 'info',
    referenceSli: null,
    aliases: [alias('alertmanager', 'sum(alertmanager_silences{state="active"})', ['alertmanager_silences'])],
    source: SRC.alertmanager,
  }),

  // ---- tsdb -----------------------------------------------------------
  row({
    id: 'tsdb_active_series', family: 'tsdb',
    signal: 'active series', unit: 'count', direction: 'info',
    referenceSli: null,
    aliases: [
      alias('prometheus', 'sum(prometheus_tsdb_head_series)', ['prometheus_tsdb_head_series']),
      alias('victoriametrics', 'sum(vm_cache_entries{type="storage/hour_metric_ids"})', ['vm_cache_entries']),
    ],
    source: `${SRC.prometheus}; ${SRC.victoriametrics}`,
  }),
  row({
    id: 'tsdb_compaction_failures', family: 'tsdb',
    signal: 'compaction failures in the last hour', unit: 'per-hour', direction: 'lower',
    referenceSli: 'prometheus-reference/tsdb_compaction_success_ratio',
    aliases: [alias('prometheus', 'sum(increase(prometheus_tsdb_compactions_failed_total[1h]))', ['prometheus_tsdb_compactions_failed_total'])],
    source: SRC.prometheus,
  }),
  row({
    id: 'wal_corruptions', family: 'tsdb',
    signal: 'WAL corruptions in the last hour', unit: 'per-hour', direction: 'lower',
    referenceSli: 'prometheus-reference/wal_corruption_freshness',
    aliases: [alias('prometheus', 'sum(increase(prometheus_tsdb_wal_corruptions_total[1h]))', ['prometheus_tsdb_wal_corruptions_total'])],
    source: SRC.prometheus,
  }),
  row({
    id: 'query_latency_p99', family: 'tsdb',
    signal: 'PromQL p99 latency', unit: 'seconds', direction: 'lower',
    referenceSli: 'prometheus-reference/query_latency_p99',
    aliases: [alias('prometheus', 'histogram_quantile(0.99, sum by (le)(rate(prometheus_engine_query_duration_seconds_bucket[5m])))', ['prometheus_engine_query_duration_seconds_bucket'])],
    source: SRC.prometheus,
  }),

  // ---- collector ------------------------------------------------------
  row({
    id: 'collector_export_failures_metrics', family: 'collector',
    signal: 'failed metric-point exports per second', unit: 'per-second', direction: 'lower',
    referenceSli: null,
    aliases: otelcolPair('otelcol_exporter_send_failed_metric_points'),
    source: SRC.otelcol,
  }),
  row({
    id: 'collector_export_failures_spans', family: 'collector',
    signal: 'failed span exports per second', unit: 'per-second', direction: 'lower',
    referenceSli: null,
    aliases: otelcolPair('otelcol_exporter_send_failed_spans'),
    source: `${SRC.otelcol}; the _total name is used by the crawled pack examples/krystaline-repo-carlos.pack.yaml`,
  }),
  row({
    id: 'collector_export_failures_logs', family: 'collector',
    signal: 'failed log-record exports per second', unit: 'per-second', direction: 'lower',
    referenceSli: null,
    aliases: otelcolPair('otelcol_exporter_send_failed_log_records'),
    source: SRC.otelcol,
  }),
  row({
    id: 'collector_dropped_metrics', family: 'collector',
    signal: 'metric points dropped by processors per second', unit: 'per-second', direction: 'lower',
    referenceSli: null,
    aliases: otelcolPair('otelcol_processor_dropped_metric_points'),
    source: SRC.otelcol,
  }),
  row({
    id: 'collector_dropped_spans', family: 'collector',
    signal: 'spans dropped by processors per second', unit: 'per-second', direction: 'lower',
    referenceSli: null,
    aliases: otelcolPair('otelcol_processor_dropped_spans'),
    source: `${SRC.otelcol}; the _total name is used by the crawled pack examples/krystaline-repo-carlos.pack.yaml`,
  }),
  row({
    id: 'collector_dropped_logs', family: 'collector',
    signal: 'log records dropped by processors per second', unit: 'per-second', direction: 'lower',
    referenceSli: null,
    aliases: otelcolPair('otelcol_processor_dropped_log_records'),
    source: SRC.otelcol,
  }),
  row({
    id: 'collector_queue_saturation', family: 'collector',
    signal: 'exporter queue fill ratio (max across exporters)', unit: 'ratio', direction: 'lower',
    referenceSli: null,
    aliases: [alias('otelcol', 'max(otelcol_exporter_queue_size / otelcol_exporter_queue_capacity)', ['otelcol_exporter_queue_size', 'otelcol_exporter_queue_capacity'])],
    source: SRC.otelcol,
  }),

  // ---- dashboards -----------------------------------------------------
  row({
    id: 'datasource_errors', family: 'dashboards',
    signal: 'Grafana datasource proxy 5xx per second', unit: 'per-second', direction: 'lower',
    referenceSli: 'grafana-reference/datasource_proxy_success_ratio',
    aliases: [alias('grafana', 'sum(rate(grafana_datasource_request_total{code=~"5.."}[5m]))', ['grafana_datasource_request_total'])],
    source: SRC.grafana,
  }),
  row({
    id: 'grafana_http_errors', family: 'dashboards',
    signal: 'Grafana HTTP 5xx per second', unit: 'per-second', direction: 'lower',
    referenceSli: 'grafana-reference/http_request_success_ratio',
    aliases: [alias('grafana', 'sum(rate(grafana_http_request_duration_seconds_count{status_code=~"5.."}[5m]))', ['grafana_http_request_duration_seconds_count'])],
    source: SRC.grafana,
  }),

  // ---- synthetic / logs / traces -------------------------------------
  row({
    id: 'synthetic_probe_failures', family: 'synthetic',
    signal: 'blackbox probes currently failing', unit: 'count', direction: 'lower',
    referenceSli: null,
    aliases: [alias('blackbox', 'count(probe_success == 0)', ['probe_success'])],
    source: SRC.blackbox,
  }),
  row({
    id: 'log_shipper_drops', family: 'logs',
    signal: 'promtail dropped entries per second', unit: 'per-second', direction: 'lower',
    referenceSli: null,
    aliases: [alias('promtail', 'sum(rate(promtail_dropped_entries_total[5m]))', ['promtail_dropped_entries_total'])],
    source: SRC.promtail,
  }),
  row({
    id: 'trace_collector_drops', family: 'traces',
    signal: 'jaeger collector dropped spans per second', unit: 'per-second', direction: 'lower',
    referenceSli: null,
    aliases: [alias('jaeger', 'sum(rate(jaeger_collector_spans_dropped_total[5m]))', ['jaeger_collector_spans_dropped_total'])],
    source: SRC.jaeger,
  }),
]);

// ---------------------------------------------------------------------------
// Resolvers — lookup only, no control flow beyond mapping and filtering.
// ---------------------------------------------------------------------------

export function probeRows() {
  return STACK_SELF_METRIC_PROBES;
}

export function rowsForFamily(family) {
  return STACK_SELF_METRIC_PROBES.filter((r) => r.family === family);
}

const toSet = (v) => (v == null ? null : v instanceof Set ? v : new Set(Array.isArray(v) ? v : [v]));

// The aliases of `row` whose every required metric name is present in the
// inventory. A null/undefined inventory means "no inventory known" and
// returns every alias (the caller then tries them in order).
export function eligibleAliases(row, inventorySet) {
  const inv = toSet(inventorySet);
  if (!inv) return row.aliases;
  return row.aliases.filter((a) => a.requires.every((name) => inv.has(name)));
}

// A row's aliases reordered by product preference: `generic` first, then
// the products the fetch has already seen (liveVersions / backend
// capabilities), then the rest — each tier keeping the row's declared
// order. Pure: returns a new array, never mutates the row.
export function productPreferenceOrder(row, seenProducts) {
  const seen = toSet(seenProducts) || new Set();
  const tier = (a) => (a.product === 'generic' ? 0 : seen.has(a.product) ? 1 : 2);
  return row.aliases
    .map((a, i) => ({ a, i, t: tier(a) }))
    .sort((x, y) => x.t - y.t || x.i - y.i)
    .map((x) => x.a);
}

// Display hint only — never stored as a verdict, never a threshold:
// 'nonzero' when a lower-is-comfortable signal is above zero, else null.
export function displayHint(row, value) {
  return row.direction === 'lower' && typeof value === 'number' && value > 0 ? 'nonzero' : null;
}

// The best outcome among a family's rows, by STACK_OUTCOMES rank
// (data > empty > failed > not-in-inventory > not-attempted). Unknown
// outcomes rank last; an empty list yields null.
export function bestOutcome(outcomes) {
  const rank = (o) => { const i = STACK_OUTCOMES.indexOf(o); return i < 0 ? STACK_OUTCOMES.length : i; };
  return [...(outcomes || [])].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}
