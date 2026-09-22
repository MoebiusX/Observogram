# Evidence — `observability/prometheus` reference pack

Every non-obvious choice in [`reference-packs/prometheus.pack.yaml`](../../reference-packs/prometheus.pack.yaml) is grounded in a public, citeable source. This document is the audit trail.

**Pack target:** Prometheus 2.45+ (LTS line through 2.55) and 3.x; every SLI query measured live on 3.14.0 (§10).
**Tier:** tier-2 (production BAU floor).
**Last reviewed:** 2026-09-22 (live measurement; content review 2026-06-06).

---

## 1. Meta-observability — why this pack assumes a Meta-Prometheus

A Prometheus instance can scrape its own `/metrics` endpoint, which means it can technically self-monitor. **In production you never rely on this alone.** The canonical pattern is:

- **Prometheus A** — the workload instance, scrapes applications + exposes its own `/metrics`
- **Prometheus B** — the "Meta-Prometheus", scrapes Prometheus A's `/metrics`, fires alerts on A's health

When Prometheus A goes down, A cannot fire an "A is down" alert. Meta-Prometheus B fires it. This pack declares Meta-Prometheus B as `metrics-meta-prom` in the backend catalog; production deployments should have HA pairs of Meta-Prometheus.

**Source:** Prometheus Documentation, *Operational Best Practices* — https://prometheus.io/docs/practices/instrumentation/ (section "Self-monitoring").

---

## 2. SLI selection — why these eight vital signs

### `scrape_success_ratio` (ratio)
**What it measures:** fraction of scrape attempts that succeeded (`up == 1`).

**Rationale:** the foundational SLI for any Prometheus deployment. If scrapes are failing, the entire downstream observability stack is operating on partial data.

**Sources:**
- Prometheus Documentation, *Querying basics* — https://prometheus.io/docs/prometheus/latest/querying/basics/#instant-vector-selectors
- The kube-prometheus-stack mixin — https://github.com/prometheus-operator/kube-prometheus
- Grafana Cloud Mimir self-monitoring docs

### `scrape_duration_p99` (threshold)
**What it measures:** the 99th percentile of the per-target scrape duration over the last 5 minutes, across all targets: `max(quantile_over_time(0.99, scrape_duration_seconds[5m]))`.

**PromQL metric:** `scrape_duration_seconds`, one of the series Prometheus itself generates for every scrape — the Prometheus documentation, *Jobs and instances*, "Automatically generated labels and time series": `up`, `scrape_duration_seconds` ("duration of the scrape"), `scrape_samples_post_metric_relabeling`, `scrape_samples_scraped`, `scrape_series_added` — a per-target **gauge** with no histogram form. `count(scrape_duration_seconds_bucket)` returns 0 series on 3.14.0 (§10; this document claimed a histogram until 2026-09-22), so the percentile is taken over the gauge's samples with `quantile_over_time`, not with `histogram_quantile`.

**Rationale:** slow scrapes are the leading indicator of target degradation, network issues, or oversized exporters. The 5s threshold reflects the Prometheus default `scrape_timeout`; values consistently above this mean targets are about to start failing scrapes outright.

### `wal_corruption_freshness` (ratio)
**What it measures:** fraction of WAL operations free of corruption.

**Rationale:** the Write-Ahead Log is Prometheus's durability story. ANY corruption indicates a disk fault or kernel-level issue that must be investigated before data loss escalates. The 99.99% objective reflects that we want zero corruptions, with budget only for transient events.

**Sources:**
- Prometheus TSDB documentation — https://prometheus.io/docs/prometheus/latest/storage/
- TSDB WAL design RFC

### `rule_evaluation_success_ratio` (ratio)
**What it measures:** fraction of recording / alerting rule evaluations that succeeded.

**Rationale:** failed rule evaluations mean downstream alerts and dashboards see stale data without knowing. This is one of the highest-impact silent-failure modes in a Prometheus deployment.

**Sources:**
- Prometheus Operations Guide — section "Rule files and recording rules"

### `query_latency_p99` (threshold)
**What it measures:** 99th-percentile latency of the query HTTP API: `histogram_quantile(0.99, sum by (le)(rate(prometheus_http_request_duration_seconds_bucket{handler=~"/api/v1/query|/api/v1/query_range"}[5m])))`.

**PromQL metric:** `prometheus_http_request_duration_seconds` (a histogram with a `handler` label and buckets .1 / .2 / .4 / 1 / 3 / 8 / 20 / 60 / 120 s: measured on 3.14.0 — 150 bucket series over 15 handlers, 10 distinct `le`, §10 — and defined the same way at v2.55.1 per `web/web.go`, `prometheus.HistogramOpts{Name: "prometheus_http_request_duration_seconds", Help: "Histogram of latencies for HTTP requests.", Buckets: []float64{.1, .2, .4, 1, 3, 8, 20, 60, 120}}` as a `HistogramVec` over `[]string{"handler"}`, curried per handler through `promhttp.InstrumentHandlerDuration` — source-level for 2.x, not a live measurement). The engine's own `prometheus_engine_query_duration_seconds` is a **summary** (labels `slice`, `quantile`; 12 series on 3.14.0) and has no `_bucket` series, so the `histogram_quantile` over `prometheus_engine_query_duration_seconds_bucket` this document cited until 2026-09-22 could never evaluate. Prometheus 3.x adds `prometheus_engine_query_duration_histogram_seconds` (20 `_bucket` series on 3.14.0) — the engine-side alternative, **3.x only**, noted here and not used because the pack also targets 2.x. The HTTP-handler histogram includes engine time plus response encoding: it is the latency a Grafana panel actually waits for. **What the value means:** the histogram cannot resolve below its first bucket. On a healthy server every `/api/v1/query*` request lands in `le="0.1"` (all ten buckets hold the same count over 5 m and over 6 h, §10), so `histogram_quantile` interpolates inside the lowest bucket and returns 0.99 × 0.1 = **0.099 s** — read it as "p99 ≤ 0.1 s", not as a measured latency (the mean is 0.9 ms and the engine summary's `inner_eval` p99 is 21 ms). The 1 s objective sits exactly on the `le="1.0"` bucket bound, so the recorded `> 1` comparison is exact.

**Rationale:** drives all downstream UX: Grafana dashboard render time, alert firing latency, automated incident-response queries. The 1s threshold is the Grafana recommended ceiling for dashboard interactivity.

**Sources:**
- Grafana Performance Best Practices — https://grafana.com/docs/grafana/latest/best-practices/

### `query_concurrent_saturation` (threshold)
**What it measures:** concurrent query slots in use vs. configured maximum.

**Rationale:** Prometheus rejects new queries when concurrency limit is hit. Sustained saturation above 80% means rejection is imminent. Catching this early lets ops scale before user-visible failures.

**Sources:**
- Prometheus CLI flags documentation — `--query.max-concurrency`
- Robust Perception, *Prometheus Performance Tuning* — https://www.robustperception.io/

### `alertmanager_notification_success_ratio` (ratio)
**What it measures:** fraction of notifications successfully delivered from Prometheus → Alertmanager.

**Rationale:** failures here are the **silent SLO breach** — your service IS firing alerts, but they never reach pagerduty. This SLI catches integration failures that would otherwise only be discovered post-incident.

### `tsdb_compaction_success_ratio` (ratio)
**What it measures:** fraction of TSDB compaction operations that succeeded.

**Rationale:** compaction failures lead to disk bloat, eventually OOM kills. The 1-hour evaluation window reflects that compaction is a periodic operation (not continuous), and a single failure doesn't immediately threaten availability.

---

## 3. SLOs — chosen thresholds

| SLO | Objective | Window | Rationale |
|---|---|---|---|
| `scrape_success_99_9` | 99.9% | 30d | Three-nines is the BAU floor for fundamentals. |
| `wal_integrity_99_99` | 99.99% | 30d | WAL must be near-perfect; data integrity is non-negotiable. |
| `rule_evaluation_99_95` | 99.95% | 30d | Recording rules feed dashboards + alerts; reliability is high-stakes. |
| `query_latency_99_p99_1s` | 99% | 30d | 1% budget over 30d covers known maintenance windows and brief spikes. |
| `alertmanager_delivery_99_9` | 99.9% | 30d | Notification reliability is the alerting contract itself. |
| `tsdb_compaction_99_95` | 99.95% | 30d | Compaction failure is rare; single events are tolerated. |
| `query_concurrency_99_under_80pct` | 99% | 7d | Weekly window because saturation is a planning signal, not a continuous one. |

---

## 4. Burn-rate windows — Google SRE playbook

Multi-window burn-rate alerts follow the **Google SRE Workbook chapter 5** ("Alerting on SLOs") with the standard table 5-1 windows. SEV1 for fast-burn (5m/1h@14x), SEV2 for slow-burn (30m/6h@6x). Query-engine SLO alerts at one severity lower because query latency is high-impact but not data-loss territory.

**Citation:** Google SRE Workbook — https://sre.google/workbook/alerting-on-slos/

---

## 5. Backend choices

### Metrics — Meta-Prometheus + Mimir (long-term)
**Rationale:** Meta-Prometheus is the scraper-of-the-scraper for short-term alerting. Mimir for long-term retention (13mo) so compliance auditors can verify SLO history.

### Logs — Elasticsearch
**Rationale:** Prometheus emits structured logs; we want them queryable for incident retrospectives. 90d ILM hot-warm-cold matches general observability log retention.

### Traces — Tempo
**Rationale:** OTel-instrumented HTTP wrapper exposes query traces. Tempo is the lightweight backend; tail-sampling preserves slow + error traces.

---

## 6. Chaos experiments

| Experiment | Tests | MTTD target | Source |
|---|---|---|---|
| `prom-pod-kill` | scrape continuity through restart | 2m | Prometheus Operator docs, *Maintenance & Upgrades* |
| `prom-disk-pressure` | TSDB compaction under disk pressure | 10m | Prometheus storage docs on disk-full handling |
| `prom-query-flood` | query-engine saturation handling | 5m | Prometheus query-engine concurrency RFC |
| `alertmanager-network-isolate` | notification delivery failure mode | 2m | Alertmanager HA documentation |

All run via Chaos Mesh (CNCF graduated). Steady-state hypothesis ties to the relevant SLO.

---

## 7. Remediation — why one explicit human-only path

The four remediation paths:

- `prometheus-scrape-failures-burn` → restart failing scrapers (idempotent, safe)
- `prometheus-rule-eval-failures-burn` → reload config (config errors are the #1 cause; reload often fixes)
- `prometheus-tsdb-compaction-failures` → trigger manual compaction (safe but slow; conservative cooldown)
- `prometheus-wal-corruption` → **explicit `automation: "manual-only"`**

WAL corruption is **data-loss territory**. Auto-remediation here risks deleting recoverable data. Every production incident I've reviewed where automation was attempted on WAL corruption made it worse. The pack declares this explicitly.

---

## 8. What this pack deliberately does NOT cover

- **Prometheus federation** as a separate observability concern — when federation is used, additional SLIs on federation lag are needed; this pack treats it as out-of-scope for the BAU floor.
- **Thanos/Cortex/Mimir comparison** — these are separate products with their own packs.
- **Prometheus 3.x-only metrics** — every query in the pack uses names measured on 3.14.0 and, for the two latency SLIs re-pointed on 2026-09-22, verified in the v2.55.1 source (§2, §10; no 2.x server was run); the 3.x-only engine histogram `prometheus_engine_query_duration_histogram_seconds` is recorded in §2 as the alternative for `query_latency_p99` and deliberately not used.

These omissions are intentional, not gaps. They keep the pack focused on the operational core that every Prometheus deployment must monitor.

---

## 9. Pack lifecycle

- **Last reviewed:** 2026-09-22 (SLI queries measured live, §10); content review 2026-06-06
- **Review cadence:** monthly (Cowork agent audits citation freshness; quarterly human review for content)
- **Backward compatibility:** SLI / SLO ids and recording-rule names stable (unchanged on 2026-09-22); the two latency SLI queries were re-pointed at names Prometheus exposes

For changes, file a PR against this evidence document AND the pack YAML simultaneously. Reviewers must verify all citations resolve.

---

## 10. Measured live — 2026-09-22

**Where:** the mq-observability-pack lab (loopback-only): Prometheus 3.14.0 scraping itself as job `prometheus-self` (`prometheus_build_info{version="3.14.0", goversion="go1.26.6"}`), the reference pack's recording rules from origin/develop 54223dd loaded as `rules-reference/prometheus.recording.yml`. Read-only instant queries against `/api/v1/query`, 2026-09-22T14:01Z. "N series" is the instant-vector size, values as returned.

| expression | result |
|---|---|
| `count(scrape_duration_seconds_bucket)` | **0 series** — no scrape-duration histogram exists; `scrape_duration_seconds` is a per-target gauge |
| `count(prometheus_engine_query_duration_seconds_bucket)` | **0 series** — the engine metric is a summary |
| `count(prometheus_engine_query_duration_seconds)` | 12 series (slices × quantiles) |
| `count(prometheus_engine_query_duration_histogram_seconds_bucket)` | 20 series — the 3.x-only engine histogram, noted in §2, not used |
| `count(prometheus_http_request_duration_seconds_bucket)` | 150 series (15 handlers × 10 buckets) |
| `max(quantile_over_time(0.99, scrape_duration_seconds[5m]))` | 1 series, **1.213 s** (the slowest of 11 jobs; threshold 5 s) |
| `histogram_quantile(0.99, sum by (le)(rate(prometheus_http_request_duration_seconds_bucket{handler=~"/api/v1/query\|/api/v1/query_range"}[5m])))` | 1 series, **0.099 s = 0.99 × the first bucket bound**, i.e. "p99 ≤ 0.1 s", not a measured latency: every request of the window fell in `le="0.1"` (next row); the same expression over `[6h]` also returns 0.099 (threshold 1 s, on the `le="1.0"` bound) |
| `sum by (le)(increase(prometheus_http_request_duration_seconds_bucket{handler=~"/api/v1/query\|/api/v1/query_range"}[5m]))` (14:40Z) | 10 series, **all ten `le` buckets (0.1 … 120, +Inf) hold the same count** — 81.7 over 5 m, 3045 over 6 h; `le="0.1"` over `_count` = 1 over 6 h; mean latency `_sum / _count` over 6 h = 0.00089 s; the engine summary `prometheus_engine_query_duration_seconds{quantile="0.99",slice="inner_eval"}` = 0.021 s |
| `sum by (handler)(rate(prometheus_http_request_duration_seconds_count{handler=~"/api/v1/query\|/api/v1/query_range"}[5m]))` | 2 series: `/api/v1/query` 0.131/s, `/api/v1/query_range` 0.024/s (Grafana's panels and the lab's own checks are the callers) |
| `prometheus:scrape_duration:p99_5m`, `prometheus:query_latency:p99_5m` (rules of the pack at 54223dd) | **0 series each** — the only two empty `prometheus:*` records of the 21 loaded |

The six other SLIs answered with data on the same run: `sum(up == bool 1) / count(up)` = 1; `sum(rate(prometheus_tsdb_wal_truncations_total[5m]))` = 0.0034/s; rule evaluations good leg = 7.997/s; query-concurrency saturation = 0; notification and compaction legs = 0 with their counters present (no alert sent and no compaction in the window).

**Not verified in this run:** the new expressions on a Prometheus 2.x server (only 3.14.0 was available). `scrape_duration_seconds` was seen on 2.55.1 in the 2026-09-07 inventory kept in `tools/lib/contracts/stack-self-metrics.mjs` and is one of the series every Prometheus generates per scrape (§2); `prometheus_http_request_duration_seconds` was verified in source at v2.55.1 (`web/web.go`: `HistogramVec` `prometheus_http_request_duration_seconds{handler}`, buckets .1–120) — source-level, not a live measurement.
