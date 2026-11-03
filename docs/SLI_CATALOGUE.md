# The KrystalineX rules, as a catalogue — and the generic base underneath them

Source: `kx-krystalinex-victoriametrics-config` (Helm chart krystalinex-0.2.10): `alerting-rules.yml` (14 groups, 76 alert rules), `recording-rules.yml` (7 groups, 41 recording rules), `scrape.yml` (20 scrape jobs).

Two asks: **(1)** a catalogue of the SLIs, SLOs and alerts the file holds, by group; **(2)** which of them are generic — the base every service needs, in every dimension, whatever it runs on.

Vocabulary is the pack library's (`library/README.md`): an **SLI** is a ratio (good/total) or a threshold (query against a bound); an **SLO** is an SLI with an objective over a window; a **burn-rate alert** is the SLO's policy; a **forecast** is `predict_linear` over a budget or a resource; a **symptom alert** is a plain rule the engine evaluates (spec 1.4 `alerting.rules`, what `+ Alert rule` adds now). **Dimension** is the signal the rule reads: *metrics*, *events* (counters of discrete occurrences — security, business), *traces*, *logs*, *platform* (the workload the service runs in).

---

## 1. What the file holds

### 1.1 SLIs — the recording rules

| SLI | Dimension | Reads | Windows | Generic? |
|---|---|---|---|---|
| `slo:http_requests:error_ratio_*` — 5xx share of requests | metrics | `http_request_errors_total{status_code=~"5.."}` / `http_requests_total` | 5m · 30m · 1h · 2h · 6h · 1d · 3d | **yes** — the availability SLI of any request-serving service |
| `slo:http_request_duration:ratio_below_500ms_*` — good-latency share | metrics | histogram bucket `le="0.5"` / `_count` | 5m · 1h · 1d | **yes** — the latency SLI, as a ratio (the right shape for a burn rate) |
| `slo:http_request_duration:ratio_below_2s_5m` | metrics | bucket `le="2"` | 5m | yes (a second objective on the same SLI — recorded, used by nothing) |
| `slo:http_request_duration:p95_*`, `p99_*` | metrics | `histogram_quantile` | 5m · 1h | yes — a threshold SLI (the latency ceiling the symptom alerts read) |
| `slo:server:probe_success_ratio_*` — scrape-level liveness | metrics | `avg_over_time(up{job="krystalinex-server"})` | 5m · 1h · 1d | **yes** — the probe SLI a request-based SLI cannot replace (a total outage has no requests) |
| `slo:availability:composite_*` = (1 − error ratio) × probe ratio | metrics | the two above | 1h · 1d | **yes** — the pattern worth keeping: composite availability |
| `slo:availability:error_budget_remaining` (99.9 %, over **1d**) | metrics | composite 1d | — | yes (but see §4: the budget window is one day) |
| `slo:latency:error_budget_remaining` (95 % < 500 ms, over 1d) | metrics | ratio_below_500ms 1d | — | yes |
| `genai:client_operation_duration:p95_5m`, `p99_5m` | metrics | `gen_ai_client_operation_duration_seconds` by provider/model/operation | 5m | per dependency kind — a *client-call latency* SLI toward any downstream |
| `genai:client_operation:error_ratio_5m` | metrics | `gen_ai_client_operations_total{status=~"error\|timeout"}` | 5m | per dependency kind — *client-call error ratio* |
| `genai:client_token_usage:rate_1h` | metrics | `gen_ai_client_token_usage_sum` | 1h | specific (cost of one dependency) |
| `genai:rca_analysis_duration:p95_5m`, `genai:rca_analysis:failure_ratio_5m` | metrics | `kx_llm_analysis_*` | 5m | specific (the AI-SRE loop) |
| `finops:requests:rate_per_service_5m`, `finops:errors:rate_per_service_5m` | metrics | `http_requests_total`, `http_request_errors_total` by job | 5m | yes — traffic and error rate per service (views, not objectives) |
| `finops:spans:exported_rate_5m`, `dropped_rate_5m`, `sampling_ratio` | **traces** (pipeline) | `otelcol_exporter_sent_spans_total`, `otelcol_processor_dropped_spans_total` | 5m | **yes** — the only trace-dimension rules in the file, and they are about the pipeline, not the service |
| `finops:logs:bytes_rate_per_component_5m` | **logs** (pipeline) | `promtail_read_bytes_total` by filename | 5m | yes — the only log-dimension rule; a volume view |
| `finops:cost:request_units_per_service_1h`, `finops:cost:telemetry_index_1h` | metrics | derived | 1h | specific (a cost model with made-up unit prices) |
| `finops:cpu:usage_per_pod_5m`, `finops:memory:usage_per_pod_gb_hours` | platform | cAdvisor by pod, namespace `krystalinex` | 5m | yes — workload resource views |
| `finops:kong:overhead_seconds` | metrics | `kong_kong_latency_ms_bucket` p99 | 5m | per dependency kind (gateway overhead) |

### 1.2 SLOs — two, both on the HTTP surface

| SLO | Objective | Window the file uses | Burn-rate ladder |
|---|---|---|---|
| Availability | 99.9 % (budget 0.1 %) | 1d for the budget; alerts on 5m/1h, 30m/6h, 2h/1d | 14.4× critical (2m) · 6× warning (5m) · 3× warning (15m) |
| Latency | 95 % of requests < 500 ms | 1d | 14.4× critical (2m) · 3× warning (15m) — no 6× rung |

Nothing else in the file is an SLO. Trading, cold wallet, database, queue, cache, security and traffic are symptom alerts with hand-set thresholds.

### 1.3 Forecasts (`predict_linear`)

| Forecast | Horizon | Dimension | Generic? |
|---|---|---|---|
| `ErrorBudgetExhaustionForecast` — availability budget < 0 | 24h over a 6h trend | metrics | **yes** — one per SLO |
| `LatencyBudgetExhaustionForecast` | 24h | metrics | **yes** |
| `DiskExhaustionForecast` — `node_filesystem_avail_bytes{mountpoint="/"}` | 7d | platform | **yes** — any node |
| `MemoryExhaustionForecast` — `node_memory_MemAvailable_bytes` | 4h | platform | **yes** — any node |
| `LatencyDegradationTrend` — p99 predicted > 2 s while still < 2 s | 1h | metrics | yes — a "trending toward breach" pattern |
| `ErrorRateTrendUp` — error ratio predicted > 5 % while still < 5 % | 1h | metrics | yes |

### 1.4 Symptom alerts, by group

**`krystalinex.application`** — generic, any request-serving service

| Alert | Condition | For | Sev |
|---|---|---|---|
| `HighErrorRate` | 5xx / total > 5 % | 2m | critical |
| `HighLatencyP99` / `…Critical` | p99 > 2 s / > 5 s | 5m / 2m | warning / critical |
| `ServiceDown` | `up{job=~"krystalinex-server\|payment-processor"} == 0` | 1m | critical |
| `NoTraffic` | request rate == 0 | 10m | warning |

**`krystalinex.trading`** — domain (KrystalineX only), but three generic *shapes*

| Alert | Condition | Generic shape |
|---|---|---|
| `OrderProcessingFailures` | `rate(orders_failed_total) > 0.1/s` | business-operation failure rate |
| `OrderQueueBackup` / `…Critical` | `rabbitmq_queue_messages{queue="orders"}` > 100 / > 500 | **queue backlog** (two rungs) |
| `PriceFeedUnavailable` | `absent(ts) or time() − ts > 60 s` | **data freshness** (staleness of a feed) |

**`krystalinex.cold-wallet`** — domain, 13 rules (one alertname at two severities for the inhibit). Generic shapes inside: a guarded failure ratio (`ColdWithdrawalFailureRate`: ratio > 30 % *and* ≥ 10 terminal events — the right way to alert on a low-volume ratio), an in-flight gauge stuck above zero (`ColdWithdrawalStuckInFlight`), a settlement latency p95 guarded by a count (`ColdWithdrawalSettlementSlow`), security-event spikes (`…PolicyBlockSpike`, `…StepUpLockoutSpike`, `…VerificationFailureSpike`, `CustodyWebhookSignatureFailures` warning + critical), a human-review event (`ColdWalletFrozen`), an attribution-unknown counter, a deprecated-route counter.

**`krystalinex.database`** — per dependency kind (PostgreSQL)

| Alert | Condition | Generic shape |
|---|---|---|
| `PostgreSQLDown` | `pg_up == 0` | dependency down |
| `DatabaseConnectionsHigh` / `…Critical` | connections / max > 80 % / > 95 % | **pool saturation**, two rungs |
| `SlowQueries` | `rate(pg_stat_statements_mean_time_seconds) > 1` | query latency ceiling (the expression is doubtful — §4) |

**`krystalinex.rabbitmq`** — per dependency kind (broker)

| Alert | Condition | Generic shape |
|---|---|---|
| `RabbitMQDown` | `rabbitmq_up == 0` | dependency down |
| `RabbitMQHighMemory` | resident / limit > 80 % | broker memory saturation |
| `RabbitMQNoConsumers` | consumers of `orders` == 0 | **no consumer** on a queue |
| `RabbitMQConsumerLag` | ready messages on `orders` > 50 | **consumer lag** / backlog |

**`krystalinex.resilience`** — generic where circuit breakers exist: `CircuitBreakerOpen` (critical, 1m), `CircuitBreakerHalfOpen` (warning, 5m).

**`krystalinex.security`** — **events** dimension (counters of security events), generic for any service with an authentication surface

| Alert | Condition (count in window) | Sev | Generic? |
|---|---|---|---|
| `AuthenticationFailures` | `rate(auth_failures_total) > 10/s` | warning | yes |
| `RateLimitExceeded` | 429 rate > 1/s | warning | yes |
| `BruteForceAttack` | `login_failed` > 20 / 5m | critical | yes |
| `CredentialStuffingAttack` | `login_failed` > 100 / 15m | critical | yes |
| `TwoFactorAuthBypass` | `2fa_failed` > 10 / 10m | critical | yes, where 2FA exists |
| `RateLimitAbuse` | `*rate_limit*` > 50 / 5m | critical | yes |
| `AuthEndpointAbuse` | `auth_rate_limit_exceeded` > 20 / 5m | critical | yes |
| `SensitiveOperationAbuse` | `sensitive_rate_limit_exceeded` > 5 / 5m | critical | yes |
| `TokenEnumerationAttack` | `invalid_token\|token_expired` > 30 / 5m | warning | yes |
| `HighSeveritySecurityEvents` | `severity=~"high\|critical"` > 25 / 10m | critical | yes — the one rule that needs only an event taxonomy |

**`krystalinex.traffic`** — generic anomaly rules (relative to the previous hour)

| Alert | Condition | Sev |
|---|---|---|
| `TrafficSpike` | rate > 5× last hour's (baseline > 1/s) | warning |
| `SustainedHighTraffic` | rate > 50/s for 15m | warning (absolute — specific) |
| `TrafficFlood` | rate > 10× baseline | critical |
| `UnusualErrorSpike` | 4xx rate > 5× baseline (baseline > 0.5/s) | warning |

**`krystalinex.genai`** — a dependency (local Ollama) plus the AI-SRE loop: client p95 > 120 s, client error ratio > 10 %, RCA failure ratio > 10 %, queue depth > 25, dropped events > 0, token burn (info, no page). Generic shape: *client-call latency and error ratio toward a downstream*, *work-queue depth*, *dropped work*.

**`krystalinex.redis`** — per dependency kind (cache): down, memory > 85 %, clients > 100, evictions > 0.

**`krystalinex.container_health`** — **platform** dimension, generic for any Kubernetes workload: `ContainerCrashLooping` (> 3 restarts / 15m), `ContainerOOMKilled`, `PodNotReady` (10m), `DeploymentReplicasMismatch` (10m) — all scoped to namespace `krystalinex`.

**`krystalinex.predictive`** — §1.3.

### 1.5 Scrape jobs (what feeds the above)

Application: `krystalinex-server`, `payment-processor`, `krystalinex-frontend` (build info only). Dependencies: `rabbitmq`, `postgres-exporter`, `redis`, `kong`. Platform: `node-exporter`, `kube-state-metrics`. Observability stack self-monitoring: `victoriametrics`, `otel-collector`, `jaeger`, `grafana`, `alertmanager`, `loki`, `promtail`, `otel-mcp-server`, `mcp-public`, `bayesian-service`, `pushgateway`. (Ollama deliberately not scraped.)

---

## 2. Generic, per-dependency, or KrystalineX-only

| Class | What falls in it | How it should travel |
|---|---|---|
| **A. The base** — true for every service, whatever it runs on | request availability (5xx ratio) · request latency (good-ratio + p99 ceiling) · probe liveness (`up`) and the composite · traffic absence · traffic anomaly vs baseline · the burn-rate ladder and budget forecasts for every SLO · security-event rates (where there is an auth surface) · workload health (crash loop, OOM, not ready, replicas) · node capacity forecasts (disk, memory) · telemetry pipeline health (spans/logs exported vs dropped) | **always present, depth by tier** — the scaffold, not an entry someone has to pick |
| **B. Per dependency kind** — the same shape whatever the product | queue: backlog two rungs · consumer lag · no consumers · broker down/memory (RabbitMQ ↔ Kafka ↔ IBM MQ) · datastore: down · pool saturation two rungs · slow queries (PostgreSQL ↔ any DB) · cache: down · memory · evictions · clients (Redis) · gateway overhead (Kong) · client-call latency/error ratio toward a downstream (GenAI, or any HTTP/gRPC client) · circuit breaker state · data freshness of a feed | **a library product entry per product**, each implementing the kind's standard SLIs with its own metric names |
| **C. KrystalineX-only** | trading (orders, price feed), cold wallet (13), the AI-SRE loop, the finops cost model | **the pack's own additions** — alert rules and SLOs on top of the generated pack (the update journey's `+ Alert rule` / `+ SLO`), never in the library |

Of the 76 alert rules: 19 are class A, 24 class B, 33 class C. Of the 41 recording rules: 19 A, 6 B (the genai client/kong ones), 16 C.

---

## 3. The generic multi-dimensional base set

What should be in **every** pack, at a depth that grows with the tier. The columns are the dimensions you named plus the two the file forgets.

| Dimension | Base SLI / SLO (tier-3 — always) | Added at tier-2 | Added at tier-1 | In the file today |
|---|---|---|---|---|
| **Metrics · availability** | request success ratio SLO (99 / 99.5 / 99.9 by tier) **composited with probe liveness** (`up`) | burn-rate ladder 14.4× / 6× / 3× | budget-exhaustion forecast (24h) | yes — the best-built part of the file |
| **Metrics · latency** | good-ratio SLO (share of requests under the bound) | p99 ceiling symptom alert (two rungs) + burn ladder | degradation-trend forecast | yes |
| **Metrics · traffic** | absence alert (no requests for N min) | anomaly vs previous-hour baseline (5× warn, 10× crit), 4xx anomaly | per-route/per-caller views | yes |
| **Metrics · saturation** | one saturation SLI per dependency the pack declares (pool %, queue backlog, in-flight, memory %) with two rungs | consumer lag / no-consumer where a queue exists | node capacity forecasts (disk 7d, memory 4h) | yes, spread across groups |
| **Events · security** | security-event emission is alive (absence of `*_security_events_total` is itself a finding) + high-severity event count | auth failure rate · brute force · credential stuffing · rate-limit abuse · token enumeration | 2FA failures · sensitive-operation abuse · human-review events (freeze, unattributed) | yes, 10 rules — **none in the library today** |
| **Events · business** | one *operation failure ratio*, guarded by a minimum count (the cold-wallet pattern) | one *stuck in flight* gauge · one *freshness* check per feed | business SLOs with their own budgets | domain rules only; the **shapes** are generic |
| **Traces** | span export health: exporter sent vs failed/dropped, sampling ratio floor | RED from span metrics per service (`calls_total{status_code=ERROR}` / `calls_total`, duration p99) — the same availability/latency as metrics, from a second source | dependency latency per peer service; trace-error budget | **only the pipeline rules (finops)** — no service SLI reads a trace |
| **Logs** | log pipeline health (shipper errors / drops, ingestion failures) | error-log rate per service (LogQL `rate({service} \|= "level=error")`) · log absence | log-derived security events where metrics have none | **only `promtail_read_bytes_total`** — nothing reads a log |
| **Platform** | workload health: crash loop, OOM, not ready, replicas mismatch (any Kubernetes workload) | dependency liveness (`pg_up`, `rabbitmq_up`, `redis_up`, …) | capacity forecasts; resource per pod | yes |
| **Resilience** | — | circuit breaker open / half-open where breakers exist | retry/timeout budgets | yes |

Three rules for the base, so it stays generic:

1. **Thresholds are parameters, never literals.** Every absolute number in the file (5 %, 2 s, 50 req/s, 20 failed logins, 100 messages) becomes a library param with the file's value as the default and `placeholder: true` where the number is the team's to decide.
2. **Metric names are the product's, the shape is the kind's.** "Queue backlog" is one SLI with three implementations (`rabbitmq_queue_messages`, `kafka_consumergroup_lag`, `ibmmq_queue_depth`); the pack never knows which until an entry is picked.
3. **Relative beats absolute for anomalies.** The traffic rules that compare with the previous hour travel to any service; `SustainedHighTraffic > 50/s` does not.

---

## 4. Things in the file worth fixing while catalogueing

- **The budgets are computed over one day** (`composite_1d`, `ratio_below_500ms_1d`) while the burn-rate windows reach 1d and a `error_ratio_3d` rule is recorded and unused: a 30d window is what the ladder's 14.4× / 6× / 3× factors assume; over 1d the 3× rung fires on almost any bad hour.
- **Two different series for one SLI.** `HighErrorRate` reads `http_requests_total{status=~"5.."}`, the recording rules read `http_request_errors_total{status_code=~"5.."}` — the symptom alert and the SLO can disagree. Pick one series.
- **The latency alert thresholds do not match the objective.** The SLO says 95 % under 500 ms; the symptom alerts fire at p99 > 2 s and > 5 s. Either is defensible; together they tell two stories.
- **`ServiceDown` hardcodes two jobs** and `PodNotReady` / replicas hardcode the namespace — both become params.
- **`or vector(0)` / `or vector(1)` fallbacks** make a dead pipeline look like a perfect one (no requests → error ratio 0, probe ratio 1). Keep them for the ratio arithmetic, but add the absence rule beside them (the file has `NoTraffic`; it has no "no scrape" rule).
- **`SlowQueries`** takes `rate()` of a mean-time gauge; the metric is already an average and `rate()` of it measures its drift, not slowness.
- **Burn-rate alerts carry `for:`** (2m on the 14.4× rung): the fast window already is the dwell; `for:` delays paging twice.
- **The library's HTTP archetype speaks semconv names** (`http_server_request_duration_seconds_*`); the file speaks client-library names (`http_requests_total`, `http_request_duration_seconds_bucket`). The archetype's `duration_metric` param covers the histogram; the error counter needs an override today.

---

## 5. What this means for Observogram

- **Already there before this catalogue:** the HTTP archetype (availability, latency p99, in-flight saturation, error rate), the scaffold's burn ladder, forecasts, routes and boards, products for Kafka, IBM MQ, Prometheus, Grafana, Alertmanager, Loki, Tempo, the collector.
- **Built with this catalogue (2026-10-28; `library/README.md` "The service base, and the dimensions"):** the entry format's `alerts:` (symptom alert rules per entry, tiered, compiled by the rules target under `<svc>_declared_alerts`); **`service-base`** — class A as an archetype every service built from scratch carries (`packc init` adds it unless `--no-base`; DEFINE lists it first and offers it): probe liveness, security-event pressure, the security-event rules of §1.4 with the counter's name and the taxonomy as parameters; the traffic rules on `http-service` and `queue-consumer`; the class B products **`rabbitmq`, `postgresql`, `redis`, `k8s-workload`, `node`**, each with §2's kind-standard SLIs and the file's thresholds as parameter defaults.
- **Still missing:** trace-derived RED (span metrics the base cannot assume), log-derived SLIs (LogQL — the Loki ruler is an engine the rules format already names), a `kong` entry (gateway overhead), and the `up`-composited availability as one SLI (today it is two SLOs, the request's and the probe's, beside each other).
- **KrystalineX's own rules (class C)** are what the update journey is for: the trading, cold-wallet and AI-SRE rules become `+ Alert rule` / `+ SLO` additions on the generated pack, kept across every regenerate, exported with it.
