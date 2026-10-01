# ObservabilityPack — Platform Engineering Standard

| | |
|---|---|
| Spec version | 1.3 |
| Status | Draft for review |
| Author | Carlos Montero  |
| First publication | 2026-05-08 |
| Last updated | 2026-09-23 |
| Default binding | `otel-elastic-prometheus-grafana` |
| Audience | Service owners, SREs, platform engineers, security & compliance, leadership |

---

## 1. Introduction

Observability is one of the most fragmented surfaces in modern platform engineering. The contracts that define what "good" means (SLIs and SLOs) tend to live in one place; the dashboards that visualise them live in another; the alerts that fire when they break live in a third; the runbooks operators follow live in a fourth; and the chaos experiments that prove any of it works — if they exist at all — live in a fifth. The result is well known: dashboards drift, alerts go silent or scream pointlessly, on-call engineers chase problems that the policy layer should have caught, and post-incident reviews surface gaps that nobody owned end-to-end.

The ObservabilityPack is the platform's answer to that fragmentation. It is a single, declarative, versioned manifest that binds every observability concern for a given service into one artifact, with referential integrity enforced at change time. One service equals one pack. Anything observable about that service — from the SLI math, to the OTel pipeline that produces the underlying signals, to the dashboard panel that visualises it, to the burn-rate alert that fires, to the channel it routes to, to the automated remediation that runs, to the chaos experiment that periodically validates the loop — is described, reviewed, and shipped together.

This document defines the contract for an ObservabilityPack: its conceptual model, its schema, the lifecycle and governance rules around it, and the reference implementation that the platform provides. The standard pins an explicit **OpenTelemetry binding** as its default realisation — instrumentation is OTel, metrics live in Prometheus, logs and traces live in Elasticsearch, dashboards live in Grafana. The abstract model and the binding are documented separately so additional bindings can land without altering the model.

### 1.1 Goals

- Make observability declarative and reviewable: every change goes through a pull request and is auditable.
- Eliminate drift: dashboards, alerts, recording rules, and runbooks all reference the same SLIs and SLOs by ID.
- Standardise without restricting: the platform supplies sane defaults via inheritance; teams override only what is service-specific.
- Make reliability claims testable: every SLO must be exercised by at least one chaos or synthetic experiment that proves the detection loop works.
- Provide measurable platform health: MTTD and MTTR baselines are first-class, tracked over time, and tied to release gating.

### 1.2 Non-goals

- This standard does not prescribe a single vendor for all time. The default binding pins OTel + Prometheus + Elasticsearch + Grafana, but additional bindings (e.g. `otel-grafanalabs`, `otel-aws-managed`) can be added without altering the abstract model.
- It does not replace incident management, post-mortem, or change management processes. It feeds them; it does not substitute for them.
- It does not cover business KPIs or product analytics. Those belong in a separate analytics surface; the pack covers operational signals.

### 1.3 Versioning

This document — the standard itself — carries an explicit **spec version** (see the header table; currently **1.3**), a two-part `major.minor` number: the minor part moves for backward-compatible additions and clarifications, the major part for breaking changes to the contract. The lineage: **1.0** was the generic observability standard; **1.1** added the OpenTelemetry instrumentation contract as a separate concern; **1.2** consolidates the two into this single unified document; **1.3** gives `threshold` and `distribution` SLIs a direction (`good_when`, §5.1), an additive minor. Because the consolidation and the addition both preserve the manifest contract (`apiVersion` stays `observability.platform/v1`, existing packs still validate and keep their meaning), each is a backward-compatible minor bump rather than a breaking `2.0`. Beyond the spec version, five independent versioning axes appear inside the contract and should not be confused with one another:

- **Spec version** (`1.3`) — the version of this prose standard, in the header table. Owned by the platform engineering team. `major.minor`; bumped whenever this document changes.
- **`apiVersion: observability.platform/v1`** — the stable API surface for pack manifests, in the Kubernetes-style sense. A breaking change to the manifest shape would bump this to `v2`. Tracks the spec's major version but is not identical to it: an editorial spec patch does not move `apiVersion`.
- **`metadata.version`** on each pack — SemVer per pack instance, owned by the service team. Bumped on every pack change. Unrelated to the spec.
- **Binding name** (currently `otel-elastic-prometheus-grafana`) — the realisation contract for a specific stack. Future bindings live as separate documents under `bindings/` and do not bump the `apiVersion`.
- **Backend product versions** — each telemetry backend declares its product version and an optional gating policy (`off` / `warn` / `enforce`). This is a per-backend axis that drives compatibility checking against the platform's capability model, not the pack or spec version. See §5.12.3.

---

## 2. Scope and applicability

**In scope:**
- Any production-bound service, batch job, or platform component owned by an internal team.
- Any environment classed as tier-1 (customer-facing or revenue-impacting), tier-2 (internal critical), or tier-3 (internal non-critical) per the platform tiering policy.
- Any third-party hosted service for which the team is the named operational owner.

**Out of scope:**
- Local development environments and ephemeral preview environments.
- Build infrastructure (CI runners, artifact stores) which has its own platform-level pack maintained by the build platform team.
- Marketing or analytics telemetry.

**Conformance terminology:** RFC 2119. MUST, MUST NOT, SHOULD, SHOULD NOT, MAY. A pack is conformant if every MUST clause is satisfied for its tier; recommended (SHOULD) clauses contribute to the maturity score.

---

## 3. Conceptual model

The pack is organised as four concentric layers, each consuming the previous, with a fifth orthogonal layer that wraps and validates the whole.

| Layer | Concerns | Pack sections |
|---|---|---|
| **L1 — Contract** | What "good" means; the explicit reliability commitment. | `slis`, `slos` |
| **L2 — Telemetry** | Producing, collecting, and persisting raw signals. | `otel`, `pipelines`, `storage` |
| **L3 — Insight** | Turning telemetry into queries, derived signals, and visualisation. | `queries`, `dashboards` |
| **L4 — Action** | Reacting to deviation: alerting, routing, automated remediation. | `policy`, `alerting`, `remediation` |
| **L5 — Validation** | Proving the four layers above actually work as designed. | `baselines`, `validation` |

L1–L4 form a strict consumption hierarchy: a dashboard panel cannot exist without an SLI it visualises; an alert cannot exist without an SLO it protects; a remediation cannot fire without an alert that triggers it. CI rejects any PR that breaks these references. L5 validates the chain end-to-end: a chaos experiment names the SLO it stresses and the alert it expects to fire within the MTTD target.

---

## 4. The pack manifest

Top-level shape:

```yaml
apiVersion: observability.platform/v1
kind: ObservabilityPack
metadata:
  name: <service-slug>
  version: <semver>
  binding: otel-elastic-prometheus-grafana
  owners: [<team-slug>, ...]
  imports:
    - ref: <pack-ref>@<version>
  bindings:
    service: <service-id>
    environments: [prod, staging, ...]
    criticality: tier-1 | tier-2 | tier-3
    default_target: ske | bare-k8s | azure
spec:
  otel:        { ... }    # OTel instrumentation contract
  telemetry:   { ... }    # generalised, multi-product backend catalog (§5.12.1)
  environments:{ ... }    # per-environment overlays (§5.12.2)
  slis:        [ ... ]
  slos:        [ ... ]
  pipelines:   { ... }    # OTel-native (receivers / processors / exporters)
  storage:     { ... }
  queries:     { ... }
  dashboards:  [ ... ]
  profiling:   { ... }    # continuous profiling, e.g. Pyroscope (§5.12.4)
  network:     { ... }    # eBPF / network observability, e.g. Cilium (§5.12.4)
  policy_engine:{ ... }   # policy-as-code, e.g. OPA (§5.12.4)
  mesh:        [ ... ]    # service mesh / gateways: Envoy/Consul/Kong/Traefik (§5.12.4)
  collection:  [ ... ]    # collection pipelines: Fluent Bit/Beats/Vector/Alloy (§5.12.4)
  policy:      { ... }
  alerting:    { ... }
  remediation: [ ... ]
  baselines:   { ... }
  validation:  { ... }
```

See `bindings/otel-elastic-prometheus-grafana.md` for the full binding contract and worked artefact examples.

---

## 5. The ten dimensions

### 5.1 Monitoring requirements: SLIs and SLOs (L1)

Defines the explicit reliability contract. The source of truth from which every downstream artifact derives. No other dimension may define a target value or threshold; targets live here and are referenced by ID.

SLI types: `ratio`, `threshold`, `distribution`, `custom`. Each SLI MUST declare an id, a type, and the underlying query. An optional `semconv_metric` field names the canonical OTel SemConv metric.

A `threshold` or `distribution` SLI declares its bound in `threshold`, in the SLI's `unit` (for a `distribution` the bound applies to the value at `percentile`), and says which side of the bound is good in `good_when`. `below` — the default, and the only meaning a 1.2 pack could express — means a sample is good when it is at or below the bound: latency, lag, error rate, queue age. `above` means the bound is a floor and a sample is good when it is at or above it: in-sync replicas, free capacity, connected consumers, throughput. The bound itself is good in both directions. Every downstream artefact that compares samples with the bound (recording and alerting rules, dashboard threshold colouring) derives its comparison from `good_when`, so a floor no longer has to be encoded as a ratio SLI or as an inverted "headroom" quantity. A ceiling and a floor:

```yaml
slis:
  - id: api_latency_p99                 # a ceiling; good_when: below is the default and may be omitted
    type: threshold
    query: histogram_quantile(0.99, sum by (le)(rate(http_server_request_duration_seconds_bucket{service_name="payment-service"}[5m])))
    threshold: 0.5
    unit: seconds

  - id: settlement_in_sync_replicas     # a floor; fewer than two in-sync replicas is bad
    type: threshold
    good_when: above
    semconv_metric: kafka.partition.replicas_in_sync   # OTel Collector kafkametrics receiver
    query: min(kafka_partition_replicas_in_sync{topic="settlements"})
    threshold: 2
    unit: replicas
```

Each SLO MUST declare id, sli reference, objective (fraction), window (`7d`, `28d`, `30d`, or `90d`), and `error_budget_policy`.

**Conformance:**
- MUST: every tier-1 service declares at least one availability and one latency SLO.
- MUST: every SLO's window is one of the four enumerated values; other windows require platform exception.
- MUST: every SLI is covered by at least one SLO.
- MUST: a `good_when` other than `below` or `above` is invalid, and `good_when` is only valid on `threshold` and `distribution` SLIs; absent means `below`.
- SHOULD: SLO objectives are reviewed against historical data at least quarterly.

### 5.2 Pipelines: OTel-native collection (L2)

Defines how signals reach the platform via OpenTelemetry. The structure mirrors OTel Collector configuration so the operator renders it directly into Collector YAML.

```yaml
pipelines:
  receivers:
    - { name: otlp, protocols: [grpc, http], endpoint: 0.0.0.0:4317 }
    - { name: prometheus, scrape_configs: [...] }
  processors:
    - { name: memory_limiter }
    - { name: batch }
    - { name: resource, attributes: [...] }
    - { name: tail_sampling, policies: [...] }
  exporters:
    metrics: { kind: prometheusremotewrite, endpoint: ... }
    logs:    { kind: elasticsearch, endpoints: [...], logs_index: ... }
    traces:  { kind: elasticsearch, endpoints: [...], traces_index: ... }
```

The operator deploys two Collectors per cluster: an agent DaemonSet (per-node, OTLP receive + local scrape) and a gateway Deployment (tail sampling, heavy processing, export to backends). Pack-declared pipelines are merged per service.

**Conformance:**
- MUST: every pack declares an `otlp` receiver.
- MUST: every exporter is from the binding's allowed list.
- MUST: any traces or logs containing PII declare a redaction pipeline.
- SHOULD: cardinality budget (`expected_series_count`) declared per scrape job.

### 5.3 OTel block (L2)

Required block declaring the OpenTelemetry instrumentation contract:

```yaml
otel:
  semconv: "1.27.0"
  resource_attributes:
    required: [service.name, service.namespace, service.version,
               service.instance.id, deployment.environment]
    custom: [tenant.id, business.domain]
  sdk:
    languages: [java, node]
    sampling: { policy: parentbased_traceidratio, ratio: 0.1 }
    propagators: [tracecontext, baggage]
    log_correlation: true
```

The operator validates emitted telemetry actually carries the required resource attributes; missing attributes flip the pack to Degraded status.

**Conformance:**
- MUST: SemConv version >= binding floor (1.26.0).
- MUST: `service.name` is in `resource_attributes.required`.
- MUST (tier-1): SemConv at currently-tracked version (1.27.0); resource attributes >= 5; `log_correlation: true`.

### 5.4 Storage (L2)

```yaml
storage:
  metrics:
    backend: prometheus       # | mimir | thanos | victoriametrics
    version: "2.55"
    retention: 30d
    remote_write:
      - { url: https://mimir.internal/api/v1/push, tenant: payments }
  logs:
    backend: elasticsearch    # | opensearch | loki
    version: "8.15"
    data_stream: logs-payments-default
    ilm_policy: ref:platform/std-logs-ilm-90d
  traces:
    backend: elasticsearch    # | opensearch | tempo | jaeger
    version: "8.15"
    data_stream: traces-apm-default
    ilm_policy: ref:platform/std-traces-ilm-14d
    sampling: tail-based
```

Default retention by criticality: tier-1 metrics 13mo (via remote_write to Mimir), logs 90d, traces 14d (tail-sampled). Tier-2 and tier-3 are lower per platform policy.

**Conformance:**
- MUST: retention does not exceed any applicable regulatory limit (GDPR, HIPAA, SOX) for the data class.
- MUST: traces or logs with PII declare a redaction pipeline.

### 5.5 Queries (L3)

Recording rules pre-compute SLI ratios and burn rates. Named in the conventional `<service>:<signal>:<aggregation>_<window>` form. Pack MAY reference SLI/SLO IDs symbolically (`expr: ref:slis.api_availability`) rather than re-typing the underlying expression.

**Conformance:**
- MUST: every SLO has a recording rule materialising the SLI at evaluation cadence.
- SHOULD: dashboard panels reference recording rules rather than raw queries.

### 5.6 Dashboards (L3)

Required for every conformant pack: service-overview, SLO-burn, deployment-overlay. Tier-1 additionally requires a customer-impact view.

```yaml
dashboards:
  - id: payment-overview
    provider: { kind: grafana, version: "11.3", schemaVersion: 39 }
    folder: payment-service
    source: file://dashboards/payment-overview.json
    datasources:
      metrics: ref:platform/ds-prometheus
      logs:    ref:platform/ds-elasticsearch-logs
      traces:  ref:platform/ds-elasticsearch-apm
    panel_bindings:
      - { panel: sli-availability, binds_to: slis.api_availability }
```

Dashboards SHOULD be templated; panels declaratively bind to SLIs or SLOs by ID so renames are safe.

### 5.7 Policy: burn-rate alerts and forecasts (L4)

Multi-window, multi-burn-rate is mandatory. Every SLO declares at least two windows (typically a fast-burn pair like 5m/1h@14x and a slow-burn pair like 30m/6h@6x). Single-window threshold alerts are considered an anti-pattern under this standard.

Forecasts project SLO trajectory and trigger leading indicators. Three projection methods: `linear`, `holt-winters`, `percentile-of-history`. Advisory by default; can be upgraded to paging.

**Conformance:**
- MUST: every SLO has at least one fast-burn and one slow-burn window.
- MUST: every SLO references an error-budget policy.
- SHOULD (tier-1): forecast declared on the primary availability SLO.

### 5.8 Alerting (L4)

Routes triggered policy events to humans or automation. The default binding supports `msteams`, `voice` (PagerDuty), `whatsapp`, `email` (audit only), and `webhook` channels. Routes are declared per severity (SEV1–SEV4), with channels ordered chat → voice → out-of-band.

Three suppression contexts: `maintenance_windows`, `deploy_freezes`, `dependency_outage`. Suppression MUST NOT silence the underlying alert in the audit log.

**Conformance:**
- MUST: tier-1 SEV1 routes include at least one voice channel.
- MUST: every alert has at least one routing rule.
- SHOULD: chat-only routing reserved for SEV3 and below.

### 5.9 Self-healing remediation (L4)

Closes the loop from alert to action without human intervention for well-understood failure modes. Every remediation MUST declare its trigger (alert ID), runbook, automation backend (Argo Workflows / Rundeck / StackStorm), and guardrails.

Guardrails: `max_invocations_per_hour` (mandatory), `requires_human_above` (severity), `rollback_on_failure`, `cooldown_after_success`, `circuit_breaker`.

**Conformance:**
- MUST: every remediation references an existing runbook.
- MUST: every remediation declares `max_invocations_per_hour`.
- MUST NOT: irreversible destructive actions without a `requires_human_above` clause set to SEV3 or lower.

### 5.10 Reliability baselines: MTTD and MTTR (L5)

Establishes the quality bar for the detection-and-response loop. Every pack MUST declare MTTD and MTTR p50 targets. Platform recommended baselines:

| Criticality | MTTD p50 | MTTR p50 |
|---|---|---|
| tier-1 | 2 min | 30 min |
| tier-2 | 5 min | 2 h |
| tier-3 | 15 min | 1 business day |

Measured automatically from alert-fired timestamps and SLO ratio time series, joined with incident-management lifecycle records. Regression beyond target triggers `regression_gate` action (warn or block release).

**Conformance:**
- MUST: every pack declares `mttd_target_p50` and `mttr_target_p50`.
- MUST: target meets or exceeds platform default for criticality.
- SHOULD (tier-1): p95 targets and a release-blocking regression gate.

### 5.11 Validation: chaos and synthetic (L5)

Validation is what distinguishes an aspirational observability program from a verified one. Every SLO reasonably exercisable through fault injection MUST be covered by at least one chaos experiment. Synthetic probes provide continuous, vendor-neutral signal independent of the application's own instrumentation.

```yaml
validation:
  chaos_experiments:
    - id: pod-kill
      engine: chaos-mesh
      target: payment-service
      steady_state_hypothesis: ref:slos.api_availability_99_9
      fault: { kind: pod-failure, fraction: 0.5, duration: 60s }
      expected_alerts: [payment-pod-down]
      expected_mttd: 2m
      schedule: weekly
      environment: staging
  synthetic_checks:
    - id: payment-flow-canary
      kind: elastic-synthetics
      target: https://api/payments/canary
      interval: 1m
      otel_instrumentation: true     # propagates traceparent; trace lands in APM
      assertions: [...]
      on_fail_severity: SEV2
```

**Conformance:**
- MUST: every tier-1 SLO covered by a chaos experiment running at least monthly.
- MUST: every tier-1 service has a synthetic probe of the primary user journey.
- MUST: a chaos experiment that fails to trigger the expected alert within `expected_mttd` is recorded as failed.
- SHOULD (tier-1): chaos runs weekly in production with blast-radius controls.
- SHOULD (tier-1): synthetic probes are OTel-instrumented (`otel_instrumentation: true`).

### 5.12 Backends, environments, and version gating (cross-cutting)

The original ten dimensions assume a single default stack. As the platform's observability surface grows — additional trace backends (Zipkin, SkyWalking, Pinpoint), metrics stores (InfluxDB, OpenTSDB), log stores (ClickHouse, Graylog), continuous profiling, eBPF/network observability, policy-as-code, service mesh, API gateways, and collection pipelines — the pack needs a generalised way to name *which product, which version, and which environment*. These cross-cutting blocks supply that without altering the L1–L5 model. They are optional; a minimal pack omits them and inherits the default binding.

#### 5.12.1 Telemetry backend catalog

`spec.telemetry.backends` is a list of named, versioned backend instances. Each declares a `signal` class (`metrics`, `logs`, `traces`, `profiles`, `network`, `policy`, `mesh`, `gateway`, `collection`, `alerting`, `dashboards`), a `product` (open registry — see below), one or more `endpoints` (tried in order for failover), an optional `auth` block, and an optional `version` policy. Backends are referenced elsewhere in the pack by `id`.

```yaml
telemetry:
  backends:
    - id: metrics-prom
      signal: metrics
      product: prometheus
      version: { declared: "2.55", min: "2.53", gating: warn }
      endpoints: [https://prom-a.internal:9090, https://prom-b.internal:9090]   # failover order
      auth: { kind: bearer, secretRef: prometheus-token }
      tenant: payments
      default: true
```

`auth.kind` is one of `none`, `bearer`, `basic`, `header`, `serviceaccount`. Credentials are **never inlined** — `secretRef` names a Kubernetes secret, consistent with the operator's existing credential handling. Named `instances` under a backend model the MCP server's multi-instance, SSRF-safe `target` selection.

**Open product registry.** The `product` field is pattern-validated, not enum-locked. Products the platform's MCP server can address are recognised by lint; an unknown value is **accepted** but flagged (`registry/unknown_product`) so typos surface without blocking a genuinely new backend.

#### 5.12.2 Environments

`spec.environments` replaces the flat environment list with per-environment overlays. Each environment may set its execution `target` (`ske`, `bare-k8s`, `azure`), override `criticality`, wire `backends` by signal to catalog ids, apply dotted-path `overrides` (e.g. retention, sampling), declare `suppress` contexts, and set a `promote_after` window.

```yaml
environments:
  prod:
    target: ske
    criticality: tier-1
    backends: { metrics: metrics-prom, logs: logs-es, traces: traces-es }
    overrides: { storage.metrics.retention: 13mo, otel.sdk.sampling.ratio: 0.1 }
    promote_after: 30d
  staging:
    target: bare-k8s
    criticality: tier-2
    overrides: { otel.sdk.sampling.ratio: 1.0 }
    suppress: [deploy_freezes]
```

#### 5.12.3 Version gating

Every product reference may carry a `version` policy: `declared`, optional `min`/`max` bounds, a `gating` mode, and required protocol `capabilities`. The gating mode maps 1:1 to the MCP server's `MCP_VERSION_GATING`:

| `gating` | Lint behaviour when `declared` is outside `[min, max]` |
|---|---|
| `off` | skipped |
| `warn` (default) | warning finding |
| `enforce` | error finding — blocks the CI gate |

An absent or unparseable version passes optimistically, matching the server's runtime behaviour. Storage blocks accept the same policy via sibling `min_version` / `gating` fields.

**Conformance:**
- MUST: every backend named in `spec.telemetry.backends` declares a `product` and a `signal`.
- MUST: every environment `backends` reference and every signal-dimension `backend` reference resolves to a declared backend id.
- SHOULD: tier-1 backends pin a `min` version with `gating: enforce`.

#### 5.12.4 Extended technology surfaces

Optional dimensions for surfaces the MCP server exposes beyond metrics/logs/traces. Each references a catalog backend by id and may carry its own version policy:

| Block | Products | Purpose |
|---|---|---|
| `profiling` | Pyroscope | Continuous CPU/heap profiling |
| `network` | Cilium | eBPF endpoint/identity/policy/flow observability |
| `policy_engine` | OPA | Policy-as-code bundles and decisions |
| `mesh` | Envoy, Consul, Kong, Traefik | Service mesh proxies, service discovery, API gateways |
| `collection` | Fluent Bit, Beats, Vector, Alloy | Telemetry collection pipelines (alternative/complement to the OTel Collector) |

**Conformance:**
- MUST: every extended-surface `backend` reference resolves to a declared backend.
- SHOULD: products carry a `version` policy when the binding pins a floor for them.

---

## 6. Lifecycle and governance

### 6.1 Authoring

Packs live in the same repository as the service they govern, under `/observability`. Changes go through the same PR process as code changes, with two additional reviewers: an on-call rotation member and the SRE/observability champion for the team's domain.

### 6.2 CI gates

Every PR modifying a pack MUST pass:
1. JSON Schema validation against the schema.
2. Reference integrity: every `binds_to`, `ref:`, `trigger:` resolves.
3. Conformance check against the pack's criticality tier.
4. Cardinality estimation against staging.
5. Burn-rate sanity: alert thresholds not provably unreachable given historical SLI distribution.

### 6.3 Promotion

Same canary pattern as application code: staging first, observe for at least one full SLO evaluation window, then promote to production. Rollback is a Git revert; the operator reconciles automatically. No manual editing of rendered Grafana dashboards or Alertmanager configs.

### 6.4 Deprecation

Removing an SLI is a breaking change requiring major version bump and a 30-day deprecation period.

### 6.5 Emergency change

During an incident, the on-call engineer MAY commit a hotfix with reduced review (single approver from the on-call rotation), provided a follow-up PR returns the pack to standard review within 24 hours.

---

## 7. Maturity model

Three tiers of conformance, mapped to service criticality.

| Service criticality | Required maturity | Onboarding window |
|---|---|---|
| tier-1 | Tier-1 conformance | 180 days from go-live |
| tier-2 | Tier-2 conformance | 90 days from go-live |
| tier-3 | Tier-3 conformance | 30 days from go-live |

Full clause-level rubric in `docs/maturity-model.md`. Summary:

| Dimension | Tier-3 | Tier-2 | Tier-1 |
|---|---|---|---|
| L1 SLIs/SLOs | Availability SLO | + Latency SLO | + Domain SLO |
| L2 Pipelines | Default OTLP receiver | + OTel metrics pipeline | + OTel logs + traces with tail sampling |
| L2 OTel | service.name attr | SemConv >= floor, 1+ language | SemConv current, 5+ attrs, log_correlation |
| L3 Queries | Recording rule per SLO | + Derived view | + Per-tenant rollup |
| L3 Dashboards | Service overview | + SLO burn | + Deployment + customer-impact |
| L4 Policy | Single-window alert | Multi-window burn rate | + Forecast |
| L4 Alerting | Chat | + Voice for SEV1 | + WhatsApp out-of-band |
| L4 Self-healing | Optional | Optional | At least one automation |
| L5 Baselines | Declared | + Regression warning | + Release-block gate |
| L5 Validation | Synthetic probe | + Monthly chaos in staging | + Weekly chaos in prod, OTel-probes |

---

## 8. Compliance and enforcement

The platform runs a daily conformance scan over every registered pack. Each MUST clause that the pack satisfies counts 1 point; SHOULD clauses count 0.5. The score is published to the service catalog alongside the service's other quality metrics.

A pack is **conformant** if every MUST is satisfied (MUST sub-score = 100%). The SHOULD sub-score reports separately.

Audit evidence: the pack manifest itself is the primary artifact. For SOC 2 monitoring controls, ISO 27001 detection requirements, and regulatory equivalents, auditors receive the pack manifests for in-scope services plus conformance-scan history and chaos-experiment pass/fail history.

Exceptions are time-bounded (default 90 days), reviewed by the platform engineering lead, and surface on the conformance dashboard.

---

## 9. Reference implementation mapping

| Pack section | Generated artefact | Backend |
|---|---|---|
| `otel.sdk` | Service env vars + `OpenTelemetryCollector`/`Instrumentation` CR | OTel Operator |
| `pipelines` | OTel Collector YAML (agent + gateway) | OTel Collector |
| `pipelines.exporters.metrics` | `prometheusremotewrite` block | OTel Collector → Prometheus |
| `pipelines.exporters.logs` / `traces` | `elasticsearch` exporter block | OTel Collector → Elasticsearch |
| `storage.metrics` | Prom retention + `remote_write` to Mimir/Thanos | Prometheus 2.55 |
| `storage.logs` / `traces` | ES index template + ILM policy + data stream | Elasticsearch 8.15 |
| `queries.recording_rules` | Prometheus rule group YAML | Prometheus / Mimir ruler |
| `policy.burn_rate_alerts` | Prometheus alerting rules | Alertmanager |
| `dashboards` | Grafana dashboard JSON (schemaVersion >= 39) | Grafana 11 |
| `alerting.routes` | Alertmanager route tree + receivers | Alertmanager / PagerDuty |
| `remediation` | Argo Events Sensor + WorkflowTemplate | Argo Workflows |
| `baselines` | Derived MTTD/MTTR metrics | Platform observability service |
| `validation.chaos` | Chaos Mesh Workflow/Schedule CRDs | Chaos Mesh |
| `validation.synthetic` | Elastic Synthetics monitor (OTel-instrumented) | Elastic Synthetics |

See `bindings/otel-elastic-prometheus-grafana.md` for full artefact examples.

---

## 10. Glossary

| Term | Definition |
|---|---|
| SLI | Service Level Indicator — quantitative measure of an aspect of the service that matters to users |
| SLO | Service Level Objective — a target value for an SLI over a defined window |
| Error budget | Allowed unreliability over the SLO window: 1 - objective |
| Burn rate | Rate at which the error budget is being consumed, expressed as a multiple of the steady-state rate |
| MTTD | Mean time to detect: from failure onset to first alert firing |
| MTTR | Mean time to recover: from first alert to restoration of healthy SLO state |
| Pack | An ObservabilityPack manifest: the unit of declaration for a service's observability |
| Reconciliation | The operator-driven process of rendering a pack into native tool resources |
| Steady-state hypothesis | The asserted condition that a system is in normal operation; the baseline for chaos experiments |
| Tail sampling | Trace sampling decided after spans are collected; rare/interesting traces are retained |
| Cardinality | Number of distinct time series produced by a metric across all label combinations |
| SemConv | OpenTelemetry Semantic Conventions — canonical names and meanings for metric, log, and span fields |
| Binding | Concrete realisation of the abstract spec for a specific stack (e.g. `otel-elastic-prometheus-grafana`) |

---

## Appendix A — JSON Schema

The authoritative machine-readable spec is `schema/observability-pack.schema.json` (JSON Schema 2020-12). It is the contract enforced at CI lint time.

## Appendix B — Worked example

A complete worked example for an HTTP API + Kafka consumer is `examples/payment-service.pack.yaml`. It demonstrates all sections including the `otel:` block, OTel-native `pipelines:`, SemConv metric names, Elastic Synthetics with OTel-instrumented probes, and weekly production chaos.

## Appendix C — OTel binding contract

The full binding contract for the default stack (OTel + Prometheus + Elasticsearch + Grafana) lives in `bindings/otel-elastic-prometheus-grafana.md`. It specifies exact stack version floors, OTel Collector YAML mappings, Elasticsearch ILM templates, Prometheus rule formats, and Grafana provisioning details.

---

*End of spec.*
