# Evidence — `messaging/kafka` reference pack

Every non-obvious choice in [`reference-packs/kafka.pack.yaml`](../../reference-packs/kafka.pack.yaml) is grounded in a public, citeable source, and every metric name the pack queries was read from a live broker. This document is the audit trail. Reviewers can — and should — follow every link, confirm the citation, and verify the pack content matches.

**Pack target:** Apache Kafka 3.x in KRaft mode (broker + controller + clients), Strimzi 0.40+ operator-managed deployments; JMX names as the Strimzi `kafka-metrics.yaml` rule set renders them.
**Tier:** tier-2 (production BAU floor).
**Last reviewed:** 2026-09-22 (live measurement, §1; content review 2026-06-06).

---

## 1. Measured live — 2026-09-22

Until this date the JMX-side expressions of this pack had never been executed against a broker, and three of them named families that do not exist (§1.5). Everything below was read from one live cluster.

### 1.1 The lab

- **Kafka:** Apache Kafka 3.9.2 (`apache/kafka` image), KRaft, one node carrying both roles (broker + controller), replication factor 1. Topics `orders` (3 partitions, ~50 msg/s from `kafka-producer-perf-test`, consumer group `orders-consumers`, auto-commit) and `payments` (3 partitions, ~10 msg/s, group `payments-consumers`).
- **Broker metrics:** `jmx_prometheus_javaagent` 1.6.0 with the Strimzi rule set verbatim — strimzi-kafka-operator `examples/metrics/kafka-metrics.yaml`, ConfigMap key `kafka-metrics-config.yml`, `main` @ 4286954 (2026-08-20), `lowercaseOutputName: true` — scraped by Prometheus 3.14.0 as job `kafka-broker` (target `kafka:9404`, static label `service="kafka"`).
- **Cluster metrics:** `kafka_exporter` (danielqsj) 1.10.0 — `kafka_exporter_build_info{version="1.10.0", goversion="go1.27.1", revision="d0347318…"}` — as job `kafka-exporter` (`kafka-exporter:9308`, `service="kafka"`).
- Both scrapes since 2026-09-22T13:50Z. Instant queries (read-only, `/api/v1/query`) at 2026-09-22T14:01Z; the two `/metrics` expositions were saved the same afternoon (JMX: 6834 lines, 240 families; kafka_exporter: 16 families). "N series" below is the instant-vector size.
- The reference pack's recording rules from origin/develop 54223dd were loaded as `rules-reference/kafka.recording.yml`.

### 1.2 The JMX families the pack uses (quoted from the saved exposition)

```
# HELP kafka_network_requestmetrics_totaltimems Attribute exposed for management kafka.network:name=TotalTimeMs,type=RequestMetrics,attribute=50thPercentile
# TYPE kafka_network_requestmetrics_totaltimems gauge
kafka_network_requestmetrics_totaltimems{quantile="0.50",request="Produce"} 1.0
kafka_network_requestmetrics_totaltimems{quantile="0.99",request="Produce"} 4.0
kafka_network_requestmetrics_totaltimems{quantile="0.999",request="Produce"} 19.971000000000004
kafka_network_requestmetrics_totaltimems_count_total{request="Produce"} 3240.0
# HELP kafka_network_requestmetrics_localtimems Attribute exposed for management kafka.network:name=LocalTimeMs,type=RequestMetrics,attribute=50thPercentile
# TYPE kafka_network_requestmetrics_localtimems gauge
kafka_network_requestmetrics_localtimems_count_total{request="FetchConsumer"} 3167.0
# HELP kafka_controller_kafkacontroller_newactivecontrollerscount Attribute exposed for management kafka.controller:name=NewActiveControllersCount,type=KafkaController,attribute=Value
# TYPE kafka_controller_kafkacontroller_newactivecontrollerscount gauge
kafka_controller_kafkacontroller_newactivecontrollerscount 1.0
# HELP kafka_controller_controllerstats_uncleanleaderelections_total Attribute exposed for management kafka.controller:name=UncleanLeaderElectionsPerSec,type=ControllerStats,attribute=Count
# TYPE kafka_controller_controllerstats_uncleanleaderelections_total counter
# HELP kafka_server_brokertopicmetrics_messagesin_total Attribute exposed for management kafka.server:name=MessagesInPerSec,type=BrokerTopicMetrics,attribute=Count
# TYPE kafka_server_brokertopicmetrics_messagesin_total counter
kafka_server_brokertopicmetrics_messagesin_total 3702.0
kafka_server_brokertopicmetrics_messagesin_total{topic="__consumer_offsets"} 320.0
kafka_server_brokertopicmetrics_messagesin_total{topic="orders"} 2818.0
kafka_server_brokertopicmetrics_messagesin_total{topic="payments"} 558.0
# HELP kafka_server_raftmetrics_current_state The current state of this member; possible values are leader, candidate, voted, follower, unattached, observer kafka.server:name=null,type=raft-metrics,attribute=current-state
# TYPE kafka_server_raftmetrics_current_state untyped
```

What that shape means:

- **Kafka request-time "histograms" are per-quantile gauges.** Each Yammer histogram comes out as one gauge per quantile (`quantile` ∈ 0.50 / 0.75 / 0.95 / 0.98 / 0.99 / 0.999, in **milliseconds**) plus a `_count_total` counter, per `request`. **There is no `_bucket` family for any Kafka request metric:** `count({__name__=~".*_bucket", job="kafka-broker"})` = 0 series. `histogram_quantile` has nothing to read; the p99 is the `quantile="0.99"` gauge itself.
- The same shape exists for `requestqueuetimems`, `remotetimems`, `responsequeuetimems`, `responsesendtimems`, `throttletimems`, `messageconversionstimems`, `requestbytes` and `temporarymemorybytes` (each with `_count_total`), next to `kafka_network_requestmetrics_requests_total{request}` and `kafka_network_requestmetrics_errors_total`.
- `count by (request)(kafka_network_requestmetrics_totaltimems{quantile="0.99"})` = **88 series**, `Produce` and `FetchConsumer` among them.
- **KRaft controller:** `kafka_controller_kafkacontroller_newactivecontrollerscount` (1.0 after a clean start; the Strimzi rules type it as a gauge although the MBean value only grows), `activecontrollercount` 1, `globalpartitioncount`, `offlinepartitionscount`. `kafka_controller_controllerstats_uncleanleaderelections_total` (0) is the **only** `ControllerStats` family on a KRaft broker — the ZooKeeper-era `LeaderElectionRateAndTimeMs` meter is not registered, and nothing named `election_rate` exists.
- **Raft:** `kafka_server_raftmetrics_current_state{current_state="leader"} 1`, `current_epoch` 1, `current_leader`.
- **Replicas:** `kafka_server_replicamanager_underreplicatedpartitions`, `partitioncount`, `leadercount` gauges.
- **Throughput:** `kafka_server_brokertopicmetrics_messagesin_total` and `bytesin_total` are counters (the meter's `Count` attribute), one series per `topic` plus one **without** the label — the broker-wide MBean.

### 1.3 The kafka_exporter families the pack uses

```
# HELP kafka_topic_partition_in_sync_replica Number of In-Sync Replicas for this Topic/Partition
# HELP kafka_topic_partition_replicas Number of Replicas for this Topic/Partition
# HELP kafka_consumergroup_lag Current Approximate Lag of a ConsumerGroup at Topic/Partition
# HELP kafka_consumergroup_current_offset Current Offset of a ConsumerGroup at Topic/Partition
```

- `kafka_topic_partition_in_sync_replica{topic, partition}` and `kafka_topic_partition_replicas{topic, partition}`: 56 series each (all 1 — replication factor 1; `__consumer_offsets` has 50 partitions).
- `kafka_consumergroup_lag{consumergroup, topic, partition}` and `kafka_consumergroup_current_offset{consumergroup, topic, partition}`: 6 series each (2 groups × 3 partitions). Both carry `instance`, `job`, `service` as well, so the lag division matches one-to-one.
- The full family list: `kafka_broker_info`, `kafka_brokers`, `kafka_consumergroup_current_offset[_sum]`, `kafka_consumergroup_lag[_sum]`, `kafka_consumergroup_members`, `kafka_exporter_build_info`, `kafka_topic_partition_{current_offset, in_sync_replica, leader, leader_is_preferred, oldest_offset, replicas, under_replicated_partition}`, `kafka_topic_partitions`.

### 1.4 The pack's expressions, executed

| SLI / view | expression | result |
|---|---|---|
| `produce_latency_p99` | `max(kafka_network_requestmetrics_totaltimems{request="Produce",quantile="0.99"}) / 1000` | 1 series, **0.002 s** (2 ms at query time, 4 ms in the saved exposition; threshold 0.1 s) |
| `fetch_latency_p99` | `max(kafka_network_requestmetrics_localtimems{request="FetchConsumer",quantile="0.99"}) / 1000` | 1 series, **0 s** (0 ms at millisecond resolution; threshold 0.05 s) |
| — why not TotalTimeMs | `max(kafka_network_requestmetrics_totaltimems{request="FetchConsumer",quantile="0.99"}) / 1000` | **0.103 s** on a healthy broker: a consumer fetch's total time includes the long-poll wait (`fetch.max.wait.ms`) whenever the partition has nothing new, so it would breach the 50 ms objective on any idle topic |
| — Produce local time, for scale | `max(kafka_network_requestmetrics_localtimems{request="Produce",quantile="0.99"}) / 1000` | 0.001 s |
| `controller_election_rate` | `max(rate(kafka_controller_kafkacontroller_newactivecontrollerscount[1h])) * 3600` | 1 series, **0** — the count has been 1 since start (min and max over 6 h = 1, 0 resets). `sum(...)` returns the same 0: `count(kafka_controller_kafkacontroller_newactivecontrollerscount)` = 1 (one combined node), so the lab cannot show the per-node multiplication `max` exists for (§1.6, §2). Prometheus 3.14 annotates the query "metric might not be a counter, name does not end in _total" — cosmetic: the Strimzi rules type the MBean's growing `Value` as a gauge |
| `per_topic_throughput` | `sum by (topic)(rate(kafka_server_brokertopicmetrics_messagesin_total{topic!=""}[5m]))` | 3 series: `orders` 49.0/s, `payments` 9.81/s, `__consumer_offsets` 5.99/s (14:40Z). Without the selector the same query returns a fourth series `{}` = 64.8/s — the broker-wide MBean, exported without a `topic` label, equal to the sum of the three (5.99 + 49.0 + 9.81 = 64.8) — which doubled the panel's visual total; the view filters it |
| `broker_availability` | `sum(up{job="kafka-broker"} == bool 1) / count(up{job="kafka-broker"})` | 1 series, **1** |
| `partition_replica_health` | `sum(kafka_topic_partition_in_sync_replica == bool kafka_topic_partition_replicas) / count(kafka_topic_partition_replicas)` | 1 series, **1**. The filter form the pack carried until the review of 2026-09-22 (`==` without `bool`, which the live Prometheus had loaded verbatim as `kafka:partition_health:ratio_5m` from `rules-reference/kafka.recording.yml`) also reads 1 here, because every ISR count is 1 (`count_values("isr", kafka_topic_partition_in_sync_replica)` → `{isr="1"}` 56); on replication factor 3 it sums ISR counts and reads 3. The semantics, shown live on a metric whose values are not 1: `sum(kafka_consumergroup_current_offset == kafka_consumergroup_current_offset)` = 182740, `sum(... == bool ...)` = 6 = `count(...)` (14:40Z) |
| `consumer_group_lag_seconds` | `max by (consumergroup)(kafka_consumergroup_lag / (rate(kafka_consumergroup_current_offset[5m]) > 0))` | 2 series: `orders-consumers` **1.76 s**, `payments-consumers` **1.57 s** (per-partition offset rates 16.0–16.5/s and 2.8–3.8/s; lags 0–29 messages; threshold 60 s) |
| the pack at 54223dd | `kafka:produce_latency:p99_5m`, `kafka:fetch_latency:p99_5m`, `kafka:controller_elections:rate_1h` | **0 series each**; `kafka:consumer_lag:seconds_max_5m` 2 series, `kafka:broker_availability:ratio_5m` 1, `kafka:partition_health:ratio_5m` 1 (13 `kafka:*` records loaded) |
| the pack's former names | `kafka_server_RequestMetrics_localtime_ms_bucket`, `kafka_controller_ControllerStats_election_rate`, `kafka_server_BrokerTopicMetrics_messagesinpersec` | **0 series each** |

The burn-rate rules (`reference-packs/rules/kafka.burn.yml`) did not change with this correction: a threshold SLI is read through its `kafka:<sli>:…` recording rule, so only the pack's SLI queries and the dashboard tiles carry the new names. Nor did they change with the review's `== bool` and `max()` corrections: the generator already emitted the bool form for the state-style ratio, and the election rate is read through `kafka:controller_elections:rate_1h`.

### 1.5 What this document claimed before 2026-09-22 that was wrong

1. *"JMX exposes per-request-type histograms"* queried as `histogram_quantile(0.99, … rate(kafka_server_RequestMetrics_localtime_ms_bucket{request="Produce"}[5m]))`. No `_bucket` family exists for any request metric; the name (mixed case, `_ms`, `kafka_server_`) matches no rule of the Strimzi set (the MBean is in `kafka.network`, names are lower-cased). The p99 is the `quantile="0.99"` gauge, in milliseconds.
2. `kafka_controller_ControllerStats_election_rate` — the ZooKeeper-era `kafka.controller:type=ControllerStats,name=LeaderElectionRateAndTimeMs` meter. A KRaft controller registers only `UncleanLeaderElectionsPerSec` under `ControllerStats`; elections are counted by `kafka.controller:type=KafkaController,name=NewActiveControllersCount`.
3. `kafka_server_BrokerTopicMetrics_messagesinpersec` — the Strimzi rules export a `*PerSec` meter's `Count` attribute as the lower-cased counter `kafka_server_brokertopicmetrics_messagesin_total`; the meter's one-minute rate is not exported, `rate()` over the counter is the throughput.
4. `fetch_latency_p99` described as "server-side latency" with no choice between local and total time: `TotalTimeMs` includes the long-poll wait and breaches the 50 ms objective on an idle topic (§1.4); the SLI reads `LocalTimeMs`.
5. `produce_latency_p99` "broken out by broker" — the SLI takes `max` across brokers; the per-broker view belongs in a derived view.
6. §7 said `automation: null` for controller churn; the pack says `automation: "manual-only"`.
7. A "next planned revision" tied to a Kafka KIP about metric standardisation whose content this document had not verified; removed.

### 1.6 Not verified in this run

- Multi-broker behaviour: one node, replication factor 1, so `partition_replica_health` can never see an ISR shortfall here and `broker_availability` has one target.
- A real controller election (the count stayed at 1); `max(rate(...[1h])) * 3600` (and the `sum` form) were executed but the step from 1 to 2 was not observed.
- The per-node semantics of `NewActiveControllersCount`: one combined node, so `sum` and `max` across nodes are indistinguishable here. The choice of `max` rests on the 3.9 ops documentation and on `QuorumController.handleLeaderChange` in the 3.9.2 source (§2), not on a measurement.
- `partition_replica_health` on replication factor > 1: the filter form would sum ISR counts (§1.4); not observable on RF 1, the PromQL semantics were shown live on another metric.
- Strimzi-managed discovery labels (`strimzi_io_*`, the operator's PodMonitor): the lab scrapes static targets.
- The ZooKeeper-mode `ControllerStats` families on a 3.x broker with ZooKeeper (not run).

---

## 2. SLI selection — why these five vital signs

The pack declares six SLIs as the *operational vital signs* of a Kafka cluster. The rationale per SLI cites OTel semantic conventions, Confluent's production monitoring guide and the Apache Kafka monitoring documentation; the metric names are the ones read live in §1.

### `broker_availability` (ratio)
**What it measures:** fraction of declared brokers reporting `up`.

**Rationale:** Confluent's official monitoring guide names *broker availability* as the #1 metric to watch: *"if brokers are down, every other Kafka metric is downstream of that fact."*

**Sources:**
- Confluent, *Monitoring Kafka in Production* — https://docs.confluent.io/platform/current/kafka/monitoring.html (section "Cluster health metrics")
- Apache Kafka documentation, *Monitoring* — https://kafka.apache.org/documentation/#monitoring
- Strimzi *Metrics for the Cluster Operator* — https://strimzi.io/docs/operators/latest/deploying.html#cluster_operator_metrics

**PromQL metric:** `up{job="kafka-broker"}` — the standard Prometheus scrape success marker. With Strimzi the labels are auto-applied via the operator's `PodMonitor`.

### `partition_replica_health` (ratio)
**What it measures:** fraction of partitions with all in-sync replicas (ISRs) present.

**Rationale:** Under-replicated partitions are the lead indicator for partition loss. Replication is the contract Kafka makes to consumers; when ISRs degrade, that contract is silently breaking before consumers notice latency or lag. Confluent's production guide treats ISR shortfall as a SEV2-equivalent.

**Sources:**
- Confluent, *Monitoring Kafka in Production* — section "Replication and ISR metrics"
- Apache Kafka KIP-101 (Leader epoch + replication safety) — https://cwiki.apache.org/confluence/display/KAFKA/KIP-101+-+Alter+Replication+Protocol+to+use+Leader+Epoch+rather+than+High+Watermark+for+Truncation

**PromQL metrics:** `kafka_topic_partition_in_sync_replica` and `kafka_topic_partition_replicas` from `kafka_exporter` (§1.3), matched one-to-one on `topic` / `partition`. The good leg compares with `== bool` so each healthy partition counts 1: a filter comparison (`==` alone) keeps the left-hand value — the ISR count — and sums to 3 × partitions on a healthy replication-factor-3 cluster (§1.4 shows the semantics live). The burn-rate generator always rewrote the filter form to `== bool` in the burn rules; the pack's own recording rule `kafka:partition_health:ratio_5m` does **not** get that rewrite (a ratio SLI is expanded verbatim) and carried the filter form until 2026-09-22.

### `consumer_group_lag_seconds` (threshold)
**What it measures:** maximum consumer-group lag, expressed as seconds (message-count lag divided by the consumer's rolling commit rate).

**Rationale:** lag in message count is misleading — 10,000 messages of lag is meaningless without knowing the consumer's rate. Converting to seconds gives a unit that's comparable across consumers and aligned with downstream business SLOs ("the settler must process events within 60s").

**Sources:**
- OpenTelemetry Semantic Conventions for Messaging — https://opentelemetry.io/docs/specs/semconv/messaging/ (specifically `messaging.kafka.consumer.lag`)
- LinkedIn Engineering, *Kafka Lag Monitoring at Scale* (Burrow's design paper) — https://engineering.linkedin.com/apache-kafka/burrow-kafka-consumer-monitoring-reinvented
- Google SRE Book, *Service Level Objectives*, chapter 4 — converting lag-as-count to lag-as-time

**PromQL metrics:** `kafka_consumergroup_lag` over `rate(kafka_consumergroup_current_offset[5m]) > 0` from `kafka_exporter`, both keyed by `consumergroup`, `topic`, `partition` (§1.3, §1.4). A partition whose consumer commits nothing in 5 minutes drops out of the division (its rate is not `> 0`) rather than reading as infinite lag; a consumer that has stopped entirely is the synthetic check `consumer-group-health`'s job (§8).

**Threshold of 60s:** chosen as the tier-2 BAU floor. Tier-1 production deployments commonly tighten to 5-10s for critical consumers (e.g., settlement, fraud detection).

### `produce_latency_p99` (threshold)
**What it measures:** the broker's 99th-percentile **total** time for `Produce` requests (request queue + local + remote/replication wait + response queue + send), in seconds: what a producer waits for its acknowledgement.

**Rationale:** Produce latency is the producer-visible signal of broker health; the 99th percentile catches tail-latency events that p50 hides. Total time is the right measure for Produce because with `acks=all` the replication wait (`RemoteTimeMs`) is part of what the producer experiences.

**Sources:**
- Apache Kafka, *Operations — Monitoring* — https://kafka.apache.org/documentation/#monitoring (`kafka.network:type=RequestMetrics,name=TotalTimeMs,request={Produce|FetchConsumer|FetchFollower}` and the per-phase breakdown)
- Confluent, *Monitoring Kafka in Production* — section "Broker request latency"

**PromQL metric:** `kafka_network_requestmetrics_totaltimems{request="Produce",quantile="0.99"}` (milliseconds; divided by 1000) — the Strimzi rule set's rendering of that MBean's `99thPercentile` attribute (§1.2).

**Threshold of 100ms:** Confluent recommends <50ms for healthy clusters under normal load; 100ms is the BAU floor before SLO breach. Tier-1 deployments commonly target 25ms. Measured 2–4 ms on the lab broker.

### `fetch_latency_p99` (threshold)
**What it measures:** the broker's 99th-percentile **local** processing time for `FetchConsumer` requests, in seconds.

**Rationale:** fetch latency drives consumer-side lag. A degrading fetch latency on the broker side is the upstream cause of the consumer-lag SLO miss before lag has even risen. `LocalTimeMs` rather than `TotalTimeMs` because a consumer fetch is a long poll: with nothing new to read the broker parks the request for up to `fetch.max.wait.ms` (500 ms by default), so total time on an idle topic sits around 100 ms (measured 103 ms, §1.4) and would breach the objective without any fault.

**Sources:** same as produce latency; `fetch.max.wait.ms` — https://kafka.apache.org/documentation/#consumerconfigs_fetch.max.wait.ms

**PromQL metric:** `kafka_network_requestmetrics_localtimems{request="FetchConsumer",quantile="0.99"}` (milliseconds; divided by 1000).

**Threshold of 50ms:** Confluent's "healthy cluster" floor. Measured 0–1 ms on the lab broker.

### `controller_election_rate` (threshold)
**What it measures:** number of controller elections per hour. Healthy clusters elect once at startup and never again.

**Rationale:** controller churn signals broker instability (network partitions, KRaft quorum instability, OOM kills of the controller). It's a leading indicator that often precedes broker-availability degradation by minutes.

**Sources:**
- Apache Kafka KIP-500 (KRaft / Controller Quorum) — https://cwiki.apache.org/confluence/display/KAFKA/KIP-500%3A+Replace+ZooKeeper+with+a+Self-Managed+Metadata+Quorum
- Apache Kafka, *Operations — Monitoring*, KRaft controller metrics (`kafka.controller:type=KafkaController,name=NewActiveControllersCount`)
- Confluent, *Monitoring Kafka in Production* — section "Controller metrics"

**PromQL metric:** `kafka_controller_kafkacontroller_newactivecontrollerscount` — exported by the Strimzi rules as a gauge although the MBean's value only grows (1 after a clean start). **The count is per node.** The Kafka 3.9 operations documentation (`docs/ops.html`, row *Number Of New Controller Elections*) says: "Counts the number of times this node has seen a new controller elected. A transition to the "no leader" state is not counted here. If the same controller as before becomes active, that still counts." In the 3.9.2 source, `QuorumController.handleLeaderChange` calls `controllerMetrics.incrementNewActiveControllers()` whenever `newLeader.leaderId().isPresent()`, outside the `newLeader.isLeader(nodeId)` branches — the raft listener every controller node runs, active and standby. One election therefore moves the count on every controller node, and the SLI takes `max(rate(...))` across nodes: `sum` would report N elections per election on an N-controller quorum (3 on the Strimzi deployment the rule set ships with, `KafkaNodePool controller replicas: 3`) and breach the 1/h threshold on a single election. Not measured — the lab has one node (§1.6). The ZooKeeper-era `ControllerStats` election meter the pack named until 2026-09-22 does not exist on KRaft (§1.2, §1.5).

**Threshold of 1 election/hour:** any non-zero rate over a sustained window indicates instability; 1/hour is the BAU alert floor.

---

## 3. SLOs — chosen windows and objectives

### `broker_availability_99_9` (99.9% over 30d)
**Rationale:** Confluent recommends 99.9% for production brokers; 99.95% is tier-1 territory. 30d window aligns with monthly business review cadence.
**Citation:** Confluent SLO calculator — https://www.confluent.io/learn-more/observability-for-kafka/

### `partition_health_99_95` (99.95% over 30d)
**Rationale:** partition replication is the contract; tightening above broker SLO reflects that ISR health should NOT degrade even when individual brokers do (replication absorbs broker loss).
**Citation:** Strimzi *Replication Configuration* docs.

### `consumer_lag_99_under_60s` (99% over 7d)
**Rationale:** 7d window because lag SLOs are tied to weekly business cycles (most batch and settler workloads are weekly). 99% means ~1.7h budget per week.

### `produce_latency_99_p99_100ms` (99% over 30d)
**Rationale:** under normal load 99% under-threshold is achievable; the 1% budget covers GC pauses and disk spikes.

### `fetch_latency_99_p99_50ms` (99% over 30d)
**Rationale:** same shape as produce, tighter threshold reflects fetch being on the consumer-critical path.

### `controller_stability_99_under_1ph` (99% over 7d)
**Rationale:** a planned rolling restart elects once; the 1% weekly budget covers it, a sustained rate does not fit.

---

## 4. Burn-rate alert windows

All multi-window burn-rate alerts follow the **Google SRE Workbook chapter 5** ("Alerting on SLOs") pattern:

- 5m/1h short/long with 14× factor → SEV1
- 30m/6h short/long with 6× factor → SEV2

**Citation:** Google SRE Workbook, chapter 5 — https://sre.google/workbook/alerting-on-slos/ (specifically table 5-1: "Multiwindow, multi-burn-rate alerts").

The consumer-lag alert uses 10m/1h@10x SEV2 and 1h/6h@4x SEV3, reflecting that consumer-lag burn-rate over short windows is noisy (driven by upstream producer spikes the consumer hasn't yet caught up on). Controller stability uses 15m/2h@8x SEV2 and 1h/6h@3x SEV3: a single planned election is transient, sustained churn is not.

---

## 5. Telemetry backend choice

### Metrics — Prometheus + Mimir (long-term)
**Rationale:** Prometheus is the de facto Kafka metrics backend (kafka_exporter and the JMX Prometheus exporter are both Prometheus-native). Mimir is the standard long-retention store; we declare 13mo retention because regulated fintech workloads typically require >12mo for SOC2 / audit. The pack also declares a fall-back to vanilla Prometheus for staging-class environments.

**Citation:**
- Strimzi `KafkaExporter` resource type — https://strimzi.io/docs/operators/latest/configuring.html#type-KafkaExporter-reference
- Strimzi JMX exporter rule set — https://github.com/strimzi/strimzi-kafka-operator/blob/main/examples/metrics/kafka-metrics.yaml (the names in this pack are what it renders; a different rule set renders different names)
- Grafana Mimir long-term retention configuration — https://grafana.com/docs/mimir/latest/manage/run-production-environment/

### Logs — Elasticsearch
**Rationale:** structured log destination; `logs-kafka-default` data stream + ILM policy (90d hot, 1y warm, 7y cold-archive) matches financial-services audit standards.

### Traces — Tempo
**Rationale:** Kafka client-side traces (Java + Go + Node OTel SDKs) carry `messaging.*` semconv. Tempo is the lightweight backend; tail-sampling at 5% probability + 100% error+slow keeps trace volumes manageable while preserving incident-relevant samples.

**Citation:** OpenTelemetry SDK messaging semconv — https://opentelemetry.io/docs/specs/semconv/messaging/

---

## 6. Chaos experiments

The four declared chaos experiments correspond to the standard Kafka failure modes:

| Experiment | What it tests | MTTD target | Citation |
|---|---|---|---|
| `broker-pod-kill` | broker failure tolerance | 90s | Strimzi *broker failure recovery* docs |
| `broker-network-partition` | split-brain + ISR shrinkage | 2m | Jepsen Kafka analysis (Aphyr 2013) |
| `consumer-group-overload` | producer-flood → consumer lag | 5m | LinkedIn Burrow design |
| `produce-latency-spike` | disk-IO degradation surface | 5m | Confluent capacity planning guide |

All experiments run via Chaos Mesh (CNCF graduated) with explicit steady-state hypothesis tying to the relevant SLO. Production scheduling is monthly with explicit window declarations. The pack declares no certification pipeline (no scrape job named `certification`), so the unified board's §10 row says so instead of showing empty MTTD / MTTR tiles.

**Citation:** Chaos Mesh project — https://chaos-mesh.org/ — and the chaos engineering principles at https://principlesofchaos.org/

---

## 7. Remediation — guardrail rationale

The four remediation paths declare `automation` only where automation is *known to be safe*:

- **`kafka-broker-down`** → auto-restart with quorum check. Safe because Kafka tolerates broker loss; restart-with-quorum-check ensures no split brain. Guardrail: 2/h max, 30m cooldown, circuit breaker at 2 failures.
- **`kafka-partition-under-replicated`** → reassign partitions with throttled rebalance. Safe because Kafka's reassignment is online; throttling prevents producer impact. Guardrail: 1/h, 1h cooldown.
- **`kafka-consumer-lag-burn`** → consumer scale-out via HPA bump. Safe for stateless consumers; pack DOES NOT recommend automation for stateful consumers (declared via `requires_human_above: SEV2` for tier-2).
- **`kafka-controller-churn`** → **explicit `automation: "manual-only"`**. Controller churn never auto-remediates.

**Citation:** Confluent, *Operating Kafka Reliably* — section on automated remediation pitfalls.

---

## 8. Synthetic checks

Two end-to-end probes complete the validation surface:

- `produce-consume-canary`: a synthetic producer + consumer with a timestamped payload, round-trip latency assertion, payload-match assertion. Runs every minute, fires SEV2 on failure.
- `consumer-group-health`: per-consumer-group probe asserting that current offset is advancing (catches stuck consumers, which the lag SLI cannot see once their commit rate is zero — §2).

Both probes are OTel-instrumented so their failures land in the same tracing backend as live consumer failures, allowing same-tool RCA.

---

## 9. What the pack deliberately does NOT cover

To stay honest:

- **Cross-cluster mirroring** (MirrorMaker 2.0): tier-2 packs assume single-cluster operation. Tier-1 variants would extend this.
- **Schema Registry health**: not part of the Kafka core. A separate `messaging/confluent-schema-registry` pack should cover this.
- **Per-topic SLOs**: the pack defines cluster-level SLOs only. Topic-level SLOs require explicit per-topic parameterization, which is left to the application pack to define (e.g., `payment-service` declares its own consumer-group lag SLO bound to its specific consumer).
- **ZooKeeper-mode clusters**: the controller SLI reads the KRaft controller's count; a ZooKeeper-mode broker exposes the `ControllerStats` election meter instead (not measured here).

These omissions are intentional, not gaps — the catalogue model is composable. The Kafka pack is the foundation; application packs layer their own specifics on top.

---

## 10. Pack lifecycle

- **Last reviewed:** 2026-09-22 (every SLI query executed live, §1); content review 2026-06-06
- **Review cadence:** monthly (Cowork agent audits citation freshness; quarterly human review for content)
- **Backward compatibility:** SLI / SLO ids and recording-rule names stable (unchanged on 2026-09-22); PromQL expressions follow the Strimzi rule set and `kafka_exporter`, and change when those do

For changes, file a PR against this evidence document AND the pack YAML simultaneously. Reviewers must verify all citations resolve, and re-run §1.4 against a broker.
