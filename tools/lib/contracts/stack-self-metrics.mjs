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
//                 inventory for that alias to be eligible — and `verified`,
//                 the pinned product image whose real exposition carried
//                 every required name AND whose PromQL evaluated the expr
//                 (`<image:tag> <exposition|TSDB inventory|probe output> +
//                 PromQL, <date>`; docker/stack.compose.yaml is the stack,
//                 tools/test-stack-live.mjs the suite that re-checks it).
//                 Order is the fallback order (generic first, then by
//                 product).
//   source        which product's upstream documentation the metric names
//                 follow, plus the live evidence that confirmed them.
//
// EVIDENCE (2026-09-07). The table was documentation-grounded when written;
// it now carries two live sources: (1) the disposable stack of the real
// products at pinned versions (docker/stack.compose.yaml — Prometheus
// v2.55.1, Alertmanager v0.27.0, VictoriaMetrics + vmalert v1.113.0,
// otel-collector-contrib 0.115.1, Grafana 12.4.4, blackbox-exporter
// v0.25.0, promtail 3.3.2, Jaeger all-in-one 1.62.0), where every alias's
// required names were read off the product's own exposition and every expr
// evaluated on the real Prometheus; (2) the public Krystaline MCP tier
// (otel-collector 0.154.0, Jaeger v2.18.0 — an otelcol distribution —,
// VictoriaMetrics, Alertmanager 0.27.0, Grafana 12.4.0), read-only through
// `metrics_query`. `tools/record-mcp-fixtures.mjs` re-verifies against any
// MCP; `npm run test:stack:live` re-verifies against the stack.
//
// KNOWN DISCREPANCIES (documented, not fixed — the reference packs are
// out of scope here):
//   1. reference-packs/prometheus `scrape_duration_p99` is written over
//      `scrape_duration_seconds_bucket`, but Prometheus exposes
//      `scrape_duration_seconds` as a per-target GAUGE (no histogram) — the
//      reference pack's histogram_quantile can never answer. Row
//      `scrape_duration_max` therefore samples `max(scrape_duration_seconds)`
//      and points at the reference SLI only for vocabulary.
//   2. reference-packs/prometheus `query_latency_p99` is written over
//      `prometheus_engine_query_duration_seconds_bucket`, but Prometheus
//      registers `prometheus_engine_query_duration_seconds` as a SUMMARY
//      (promql/engine.go: SummaryVec with objectives 0.5 / 0.9 / 0.99 and
//      the label `slice`) — there is no `_bucket` series to quantile over.
//      Row `query_latency_p99` therefore reads the summary's own 0.99
//      quantile for the `inner_eval` slice and points at the reference SLI
//      only for vocabulary.
//   3. reference-packs/grafana `datasource_proxy_success_ratio` is written
//      over `grafana_datasource_request_total`, which Grafana 12.4.4
//      registers only on the first datasource request — a proxied query or
//      a rule evaluation (absent on a Grafana that has made none yet). Row
//      `datasource_errors` therefore reads
//      `grafana_proxy_response_status_total`, which the same Grafana
//      pre-registers at startup with `code="500"` at 0, and keeps the
//      reference name as its second alias.
//
// ROWS THAT MUST READ ZERO WHEN HEALTHY: a PromQL filter that matches
// nothing (`count(up == 0)` on a stack with every target up, or
// `{code=~"5.."}` on a Grafana that never answered a 5xx) yields an EMPTY
// vector, which the sampler records as `empty` — indistinguishable from
// "the metric does not exist here". Such rows therefore carry a guard that
// reads 0 only when the base metric is present:
//   `count(up == 0) or (count(up) * 0)`
//   `sum(rate(m{code=~"5.."}[5m])) or (count(m) * 0)`
// — `count(m) * 0` is 0 whenever any `m` series exists and empty when none
// does, so a healthy stack reads 0 and a stack without the metric still
// reads `empty`. (`or vector(0)` was rejected: it would fabricate "0 down"
// on a backend that never scrapes anything.)
//
// LAZILY-REGISTERED COUNTERS (the same guard, one step further): some
// products create a failure counter only when the first failure (or the
// first operation) happens, so a scraped, healthy product exposes no such
// series at all. Observed on the OpenTelemetry Collector: 0.115.1 registers
// `otelcol_exporter_send_failed_<kind>` together with
// `otelcol_exporter_sent_<kind>` at the FIRST EXPORT (10 metric names at
// startup, 39 after one OTLP request; the never-failing `debug` exporter
// then carries `send_failed_* 0`), and `otelcol_receiver_refused_<kind>`
// together with `otelcol_receiver_accepted_<kind>` at the first receive;
// 0.154.0 (public tier) exposes `sent_spans` / `accepted_spans` and
// `refused_spans` while `send_failed_spans` is absent — registered only on
// the first failure. Strict `requires` on such a counter would read
// not-in-inventory on a healthy collector forever. Policy: the alias
// `requires` the ALWAYS-PRESENT-ONCE-ACTIVE sibling that proves the product
// is scraped and doing that work (`otelcol_exporter_sent_<kind>`,
// `otelcol_receiver_accepted_<kind>`), and the expr ends with the sibling's
// presence-guarded zero — `or (count(<sibling>) * 0)` — so a collector that
// has exported reads 0 failures unless the failure counter exists, a
// collector that never exported that signal reads not-in-inventory (no
// evidence either way), and a backend without the product still reads
// `empty`. A renamed counter on a future collector (e.g. a `_total` suffix)
// also renames the sibling, so the alias falls to not-in-inventory instead
// of a false 0. Counters the product pre-registers at 0 (Prometheus
// client_golang: prometheus_*, alertmanager_*, vmalert_*, vm_*, promtail_*,
// jaeger_collector_* — all observed present at startup) keep strict
// `requires`.
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

// Upstream documentation each alias's metric names follow, with the live
// evidence that confirmed them (2026-09-07: the pinned stack, the public
// Krystaline tier).
const SRC = Object.freeze({
  prometheus:      'Prometheus server self-metrics (/metrics): docs.prometheus.io — "Jobs and instances" (up, scrape_duration_seconds) and the prometheus_* series the server exposes; prometheus_engine_query_duration_seconds is a summary with labels slice / quantile (promql/engine.go). Confirmed on prom/prometheus:v2.55.1 (stack, 2026-09-07) and the public tier',
  victoriametrics: 'VictoriaMetrics docs — vmagent "Monitoring" (vm_promscrape_targets{type,status}), vmalert "Monitoring" (vmalert_recording_rules_errors_total and vmalert_alerting_rules_errors_total — plural "errors", per app/vmalert/rule/recording.go and alerting.go; vmalert_alerts_send_errors_total), VictoriaMetrics "Monitoring" (vm_cache_entries{type="storage/hour_metric_ids"} = active time series). Confirmed on victoriametrics/victoria-metrics:v1.113.0 + vmalert:v1.113.0 (stack, 2026-09-07; every counter pre-registered at 0) and vm_* on the public tier (which does not scrape its vmalert)',
  grafana:         'Grafana docs — "Grafana metrics" (internal /metrics): grafana_proxy_response_status_total{code} (datasource proxy responses; pre-registered at startup with code 200/404/500/unknown at 0), grafana_datasource_request_total{code} (registered on the first datasource request — a proxied query or a rule evaluation), grafana_http_request_duration_seconds{status_code}, grafana_alerting_rule_evaluation_failures_total{org} (registered per org on the first rule evaluation). Confirmed on grafana/grafana:12.4.4 (stack, 2026-09-07) and grafana_proxy_response_status_total / grafana_http_request_duration_seconds_count on the public tier (Grafana 12.4.0)',
  alertmanager:    'Prometheus Alertmanager self-metrics (/metrics): alertmanager_notifications_total, alertmanager_notifications_failed_total{integration,reason}, alertmanager_silences{state}. Confirmed on prom/alertmanager:v0.27.0 (stack, 2026-09-07; pre-registered at 0) and the public tier (Alertmanager 0.27.0)',
  otelcol:         'OpenTelemetry Collector docs — "Internal telemetry": otelcol_exporter_sent_<kind> / otelcol_exporter_send_failed_<kind>, otelcol_receiver_accepted_<kind> / otelcol_receiver_refused_<kind>, otelcol_exporter_queue_size / queue_capacity (kinds: spans, metric_points, log_records). No `_total` suffix on any collector observed (otel/opentelemetry-collector-contrib:0.115.1 on the stack; 0.154.0 on the public tier). Lazy registration observed on otel/opentelemetry-collector-contrib:0.115.1, 2026-09-07 stack: exporter and receiver counters register at the first export / receive (10 names at startup, 39 after one OTLP request); on 0.154.0 (public tier) send_failed_spans is absent while sent_spans is present. otelcol_processor_dropped_<kind> exist on NO current collector (removed by the processorhelper rework — processor/processorhelper/metadata.yaml defines processor_incoming_items / processor_outgoing_items only): absent in both spellings on 0.115.1 and 0.154.0, so the collector_refused_* rows read the receiver counters instead. otelcol_exporter_queue_size carries a data_type label on 0.115.1 that queue_capacity lacks (0.154.0 carries it on both), hence the per-exporter max grouping in collector_queue_saturation',
  blackbox:        'prometheus/blackbox_exporter README: probe_success (on the /probe output the scrape job reads, never on the exporter\'s own /metrics). Confirmed on prom/blackbox-exporter:v0.25.0 (stack, 2026-09-07)',
  promtail:        'Grafana Loki docs — Promtail "Observability": promtail_dropped_entries_total{host,reason}. Confirmed on grafana/promtail:3.3.2 (stack, 2026-09-07; pre-registered at 0) and the public tier',
  jaeger:          'Jaeger docs — collector metrics (admin port 14269, no flag needed): jaeger_collector_spans_dropped_total, beside spans_received_total / spans_rejected_total. Confirmed on jaegertracing/all-in-one:1.62.0 (stack, 2026-09-07). Jaeger v2 (public tier: v2.18.0) is an OpenTelemetry Collector distribution that exposes otelcol_* names instead — its drops surface through the collector rows, and this alias reads not-in-inventory there (honest: v1 names only)',
});

// The pinned images of docker/stack.compose.yaml — the `verified` stamp of
// every alias names the image whose exposition carried its required names
// and whose PromQL evaluated its expr (tools/test-stack-live.mjs re-checks
// both, and that the stamp matches the compose image).
const VERIFIED_ON = '2026-09-07';
const IMG = Object.freeze({
  prometheus: 'prom/prometheus:v2.55.1',
  alertmanager: 'prom/alertmanager:v0.27.0',
  victoriametrics: 'victoriametrics/victoria-metrics:v1.113.0',
  vmalert: 'victoriametrics/vmalert:v1.113.0',
  otelcol: 'otel/opentelemetry-collector-contrib:0.115.1',
  grafana: 'grafana/grafana:12.4.4',
  blackbox: 'prom/blackbox-exporter:v0.25.0',
  promtail: 'grafana/promtail:3.3.2',
  jaeger: 'jaegertracing/all-in-one:1.62.0',
});
const verifiedOn = (image, via = 'exposition') => `${image} ${via} + PromQL, ${VERIFIED_ON}`;

const alias = (product, expr, requires, verified) => Object.freeze({ product, expr, requires: Object.freeze(requires), verified });

const row = (r) => Object.freeze({ ...r, aliases: Object.freeze(r.aliases) });

// otelcol lazily-registered counters (see the header): require the sibling
// that registers with (0.115.1) or before (0.154.0) the counter, and read 0
// on its presence when the counter is absent.
const otelcolLazy = (counter, sibling) => [
  alias('otelcol', `sum(rate(${counter}[5m])) or (count(${sibling}) * 0)`, [sibling], verifiedOn(IMG.otelcol)),
];

export const STACK_SELF_METRIC_PROBES = Object.freeze([
  // ---- scrape ---------------------------------------------------------
  row({
    id: 'scrape_success_ratio', family: 'scrape',
    signal: 'fraction of scrape targets up', unit: 'ratio', direction: 'higher',
    referenceSli: 'prometheus-reference/scrape_success_ratio',
    // `up` is 0/1, so sum/count is the fraction up and an all-down stack
    // reads 0 rather than empty (`sum(up == 1)` would match nothing).
    aliases: [alias('generic', 'sum(up) / count(up)', ['up'], verifiedOn(IMG.prometheus, 'TSDB inventory'))],
    source: SRC.prometheus,
  }),
  row({
    id: 'scrape_targets_down', family: 'scrape',
    signal: 'scrape targets down', unit: 'count', direction: 'lower',
    referenceSli: null,
    aliases: [
      alias('generic', 'count(up == 0) or (count(up) * 0)', ['up'], verifiedOn(IMG.prometheus, 'TSDB inventory')),
      alias('victoriametrics', 'sum(vm_promscrape_targets{status="down"})', ['vm_promscrape_targets'], verifiedOn(IMG.victoriametrics)),
    ],
    source: `${SRC.prometheus}; ${SRC.victoriametrics}`,
  }),
  row({
    id: 'scrape_duration_max', family: 'scrape',
    signal: 'slowest scrape (gauge — see the discrepancy note in the header)', unit: 'seconds', direction: 'lower',
    referenceSli: 'prometheus-reference/scrape_duration_p99',
    aliases: [alias('generic', 'max(scrape_duration_seconds)', ['scrape_duration_seconds'], verifiedOn(IMG.prometheus, 'TSDB inventory'))],
    source: SRC.prometheus,
  }),

  // ---- ruler ----------------------------------------------------------
  row({
    id: 'rule_evaluation_failures', family: 'ruler',
    signal: 'rule evaluation failures per second', unit: 'per-second', direction: 'lower',
    referenceSli: 'prometheus-reference/rule_evaluation_success_ratio',
    aliases: [
      alias('prometheus', 'sum(rate(prometheus_rule_evaluation_failures_total[5m]))', ['prometheus_rule_evaluation_failures_total'], verifiedOn(IMG.prometheus)),
      alias('victoriametrics', 'sum(rate(vmalert_recording_rules_errors_total[5m])) + sum(rate(vmalert_alerting_rules_errors_total[5m]))', ['vmalert_recording_rules_errors_total', 'vmalert_alerting_rules_errors_total'], verifiedOn(IMG.vmalert)),
      // Registered per org on the first rule evaluation: strict requires —
      // a Grafana with no alert rules has no ruler to report on.
      alias('grafana', 'sum(rate(grafana_alerting_rule_evaluation_failures_total[5m]))', ['grafana_alerting_rule_evaluation_failures_total'], verifiedOn(IMG.grafana)),
    ],
    source: `${SRC.prometheus}; ${SRC.victoriametrics}; ${SRC.grafana}`,
  }),
  row({
    id: 'rule_evaluation_staleness', family: 'ruler',
    signal: 'seconds since the oldest rule group last evaluated', unit: 'seconds', direction: 'lower',
    referenceSli: null,
    aliases: [alias('prometheus', 'max(time() - prometheus_rule_group_last_evaluation_timestamp_seconds)', ['prometheus_rule_group_last_evaluation_timestamp_seconds'], verifiedOn(IMG.prometheus))],
    source: SRC.prometheus,
  }),

  // ---- notify ---------------------------------------------------------
  row({
    id: 'notification_errors', family: 'notify',
    signal: 'alert notification send errors per second', unit: 'per-second', direction: 'lower',
    referenceSli: 'prometheus-reference/alertmanager_notification_success_ratio',
    aliases: [
      alias('prometheus', 'sum(rate(prometheus_notifications_errors_total[5m]))', ['prometheus_notifications_errors_total'], verifiedOn(IMG.prometheus)),
      alias('victoriametrics', 'sum(rate(vmalert_alerts_send_errors_total[5m]))', ['vmalert_alerts_send_errors_total'], verifiedOn(IMG.vmalert)),
      alias('alertmanager', 'sum(rate(alertmanager_notifications_failed_total[5m]))', ['alertmanager_notifications_failed_total'], verifiedOn(IMG.alertmanager)),
    ],
    source: `${SRC.prometheus}; ${SRC.victoriametrics}; ${SRC.alertmanager}`,
  }),
  row({
    id: 'notifications_sent', family: 'notify',
    signal: 'notifications sent per second (delivery-path liveness)', unit: 'per-second', direction: 'info',
    referenceSli: null,
    aliases: [
      alias('alertmanager', 'sum(rate(alertmanager_notifications_total[5m]))', ['alertmanager_notifications_total'], verifiedOn(IMG.alertmanager)),
      alias('prometheus', 'sum(rate(prometheus_notifications_sent_total[5m]))', ['prometheus_notifications_sent_total'], verifiedOn(IMG.prometheus)),
    ],
    source: `${SRC.alertmanager}; ${SRC.prometheus}`,
  }),
  row({
    id: 'active_silences', family: 'notify',
    signal: 'active silences', unit: 'count', direction: 'info',
    referenceSli: null,
    aliases: [alias('alertmanager', 'sum(alertmanager_silences{state="active"})', ['alertmanager_silences'], verifiedOn(IMG.alertmanager))],
    source: SRC.alertmanager,
  }),

  // ---- tsdb -----------------------------------------------------------
  row({
    id: 'tsdb_active_series', family: 'tsdb',
    signal: 'active series', unit: 'count', direction: 'info',
    referenceSli: null,
    aliases: [
      alias('prometheus', 'sum(prometheus_tsdb_head_series)', ['prometheus_tsdb_head_series'], verifiedOn(IMG.prometheus)),
      alias('victoriametrics', 'sum(vm_cache_entries{type="storage/hour_metric_ids"})', ['vm_cache_entries'], verifiedOn(IMG.victoriametrics)),
    ],
    source: `${SRC.prometheus}; ${SRC.victoriametrics}`,
  }),
  row({
    id: 'tsdb_compaction_failures', family: 'tsdb',
    signal: 'compaction failures in the last hour', unit: 'per-hour', direction: 'lower',
    referenceSli: 'prometheus-reference/tsdb_compaction_success_ratio',
    aliases: [alias('prometheus', 'sum(increase(prometheus_tsdb_compactions_failed_total[1h]))', ['prometheus_tsdb_compactions_failed_total'], verifiedOn(IMG.prometheus))],
    source: SRC.prometheus,
  }),
  row({
    id: 'wal_corruptions', family: 'tsdb',
    signal: 'WAL corruptions in the last hour', unit: 'per-hour', direction: 'lower',
    referenceSli: 'prometheus-reference/wal_corruption_freshness',
    aliases: [alias('prometheus', 'sum(increase(prometheus_tsdb_wal_corruptions_total[1h]))', ['prometheus_tsdb_wal_corruptions_total'], verifiedOn(IMG.prometheus))],
    source: SRC.prometheus,
  }),
  row({
    id: 'query_latency_p99', family: 'tsdb',
    signal: 'PromQL p99 latency (summary quantile — see discrepancy 2 in the header)', unit: 'seconds', direction: 'lower',
    referenceSli: 'prometheus-reference/query_latency_p99',
    aliases: [alias('prometheus', 'max(prometheus_engine_query_duration_seconds{slice="inner_eval",quantile="0.99"})', ['prometheus_engine_query_duration_seconds'], verifiedOn(IMG.prometheus))],
    source: SRC.prometheus,
  }),

  // ---- collector ------------------------------------------------------
  row({
    id: 'collector_export_failures_metrics', family: 'collector',
    signal: 'failed metric-point exports per second', unit: 'per-second', direction: 'lower',
    referenceSli: null,
    aliases: otelcolLazy('otelcol_exporter_send_failed_metric_points', 'otelcol_exporter_sent_metric_points'),
    source: SRC.otelcol,
  }),
  row({
    id: 'collector_export_failures_spans', family: 'collector',
    signal: 'failed span exports per second', unit: 'per-second', direction: 'lower',
    referenceSli: null,
    aliases: otelcolLazy('otelcol_exporter_send_failed_spans', 'otelcol_exporter_sent_spans'),
    source: `${SRC.otelcol}; the crawled pack examples/krystaline-repo-carlos.pack.yaml writes otelcol_exporter_send_failed_spans_total, a name its own collector (0.154.0) does not expose`,
  }),
  row({
    id: 'collector_export_failures_logs', family: 'collector',
    signal: 'failed log-record exports per second', unit: 'per-second', direction: 'lower',
    referenceSli: null,
    aliases: otelcolLazy('otelcol_exporter_send_failed_log_records', 'otelcol_exporter_sent_log_records'),
    source: SRC.otelcol,
  }),
  // collector_refused_*: data the collector could not accept at the
  // receiver — the current-generation signal for "the collector is losing
  // telemetry". The processor drop counters the table used to read
  // (otelcol_processor_dropped_<kind>) exist on no current collector (see
  // SRC.otelcol), so those rows were retired in favour of these.
  row({
    id: 'collector_refused_metrics', family: 'collector',
    signal: 'metric points refused at the receiver per second', unit: 'per-second', direction: 'lower',
    referenceSli: null,
    aliases: otelcolLazy('otelcol_receiver_refused_metric_points', 'otelcol_receiver_accepted_metric_points'),
    source: SRC.otelcol,
  }),
  row({
    id: 'collector_refused_spans', family: 'collector',
    signal: 'spans refused at the receiver per second', unit: 'per-second', direction: 'lower',
    referenceSli: null,
    aliases: otelcolLazy('otelcol_receiver_refused_spans', 'otelcol_receiver_accepted_spans'),
    source: `${SRC.otelcol}; the crawled pack examples/krystaline-repo-carlos.pack.yaml writes otelcol_processor_dropped_spans_total, a name its own collector (0.154.0) does not expose`,
  }),
  row({
    id: 'collector_refused_logs', family: 'collector',
    signal: 'log records refused at the receiver per second', unit: 'per-second', direction: 'lower',
    referenceSli: null,
    aliases: otelcolLazy('otelcol_receiver_refused_log_records', 'otelcol_receiver_accepted_log_records'),
    source: SRC.otelcol,
  }),
  row({
    id: 'collector_queue_saturation', family: 'collector',
    signal: 'exporter queue fill ratio (fullest queue, max across exporters)', unit: 'ratio', direction: 'lower',
    referenceSli: null,
    // Per-exporter max on both sides: queue_size is per data_type while
    // queue_capacity is per exporter (0.115.1) or per data_type (0.154.0)
    // with the same configured capacity, so the ratio is the fullest
    // queue's fill on either exposition; a plain division matches no pairs
    // on 0.115.1 and `ignoring(data_type) group_left` is many-to-many on a
    // multi-pipeline 0.154.0.
    aliases: [alias('otelcol', 'max(max by (exporter, instance, job) (otelcol_exporter_queue_size) / max by (exporter, instance, job) (otelcol_exporter_queue_capacity))', ['otelcol_exporter_queue_size', 'otelcol_exporter_queue_capacity'], verifiedOn(IMG.otelcol))],
    source: SRC.otelcol,
  }),

  // ---- dashboards -----------------------------------------------------
  row({
    id: 'datasource_errors', family: 'dashboards',
    signal: 'Grafana datasource proxy 5xx per second', unit: 'per-second', direction: 'lower',
    referenceSli: 'grafana-reference/datasource_proxy_success_ratio',
    aliases: [
      alias('grafana', 'sum(rate(grafana_proxy_response_status_total{code=~"5.."}[5m])) or (count(grafana_proxy_response_status_total) * 0)', ['grafana_proxy_response_status_total'], verifiedOn(IMG.grafana)),
      // The reference pack's name (discrepancy 3): registered on the first
      // proxied request, strict requires — eligible once a datasource has
      // been queried through Grafana.
      alias('grafana', 'sum(rate(grafana_datasource_request_total{code=~"5.."}[5m])) or (count(grafana_datasource_request_total) * 0)', ['grafana_datasource_request_total'], verifiedOn(IMG.grafana)),
    ],
    source: SRC.grafana,
  }),
  row({
    id: 'grafana_http_errors', family: 'dashboards',
    signal: 'Grafana HTTP 5xx per second', unit: 'per-second', direction: 'lower',
    referenceSli: 'grafana-reference/http_request_success_ratio',
    aliases: [alias('grafana', 'sum(rate(grafana_http_request_duration_seconds_count{status_code=~"5.."}[5m])) or (count(grafana_http_request_duration_seconds_count) * 0)', ['grafana_http_request_duration_seconds_count'], verifiedOn(IMG.grafana))],
    source: SRC.grafana,
  }),

  // ---- synthetic / logs / traces -------------------------------------
  row({
    id: 'synthetic_probe_failures', family: 'synthetic',
    signal: 'blackbox probes currently failing', unit: 'count', direction: 'lower',
    referenceSli: null,
    aliases: [alias('blackbox', 'count(probe_success == 0) or (count(probe_success) * 0)', ['probe_success'], verifiedOn(IMG.blackbox, 'probe output'))],
    source: SRC.blackbox,
  }),
  row({
    id: 'log_shipper_drops', family: 'logs',
    signal: 'promtail dropped entries per second', unit: 'per-second', direction: 'lower',
    referenceSli: null,
    aliases: [alias('promtail', 'sum(rate(promtail_dropped_entries_total[5m]))', ['promtail_dropped_entries_total'], verifiedOn(IMG.promtail))],
    source: SRC.promtail,
  }),
  row({
    id: 'trace_collector_drops', family: 'traces',
    signal: 'jaeger (v1) collector dropped spans per second', unit: 'per-second', direction: 'lower',
    referenceSli: null,
    aliases: [alias('jaeger', 'sum(rate(jaeger_collector_spans_dropped_total[5m]))', ['jaeger_collector_spans_dropped_total'], verifiedOn(IMG.jaeger))],
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
