# ObservabilityPack Maturity Model

**Audience:** Service owners, SREs, platform engineers, compliance.

---

## 1. Purpose

The maturity model defines what conformance with the ObservabilityPack standard means at each criticality tier and provides a concrete, machine-checkable rubric that the platform's conformance scanner evaluates daily. It exists for three reasons:

1. **Gradient of expectation.** Not every service needs the full standard. A tier-3 internal tool would not benefit from production chaos engineering; a tier-1 customer-facing API absolutely needs it. The maturity tiers express the gradient explicitly so service teams know exactly what is asked of them.
2. **Onboarding clarity.** A team new to the standard can target tier-3 conformance in a week and grow into tier-2 and tier-1 as the service matures, rather than facing a single all-or-nothing bar.
3. **Audit evidence.** The conformance score, scanned daily and stored alongside the service catalog entry, is the audit artefact for monitoring and detection controls. It replaces ad-hoc "do we monitor X" questionnaires.

---

## 2. Tier mapping

A pack's expected maturity tier is determined by the service's criticality binding:

| Service criticality | Required maturity tier | Onboarding window |
|---|---|---|
| tier-1 (customer-facing or revenue-impacting) | **Tier-1 conformance** | 180 days from go-live |
| tier-2 (internal critical) | **Tier-2 conformance** | 90 days from go-live |
| tier-3 (internal non-critical) | **Tier-3 conformance** | 30 days from go-live |

Services may exceed their required tier voluntarily. They may not fall short without an explicit time-bounded exception, reviewed by the platform engineering lead and surfaced on the conformance dashboard.

---

## 3. Conformance rubric

The three tiers are cumulative: tier-2 includes everything in tier-3 plus its own additions; tier-1 includes everything in tier-2 plus its own additions. The tables below list only the deltas at each tier.

### 3.1 Tier-3 (minimum conformance)

A tier-3 pack is the floor. Anything below this is non-conformant and not allowed in production.

| # | Dimension | Requirement | Conformance check |
|---|---|---|---|
| 3.1 | SLIs/SLOs | At least one SLI and one SLO declared. The SLO MUST cover availability or its closest proxy for the service type. | `len(spec.slis) >= 1 and len(spec.slos) >= 1` |
| 3.2 | Pipelines | Default OTel Collector pipeline present (OTLP receiver → prometheusremotewrite exporter); metrics endpoint or OTLP endpoint exposed. | `spec.pipelines.receivers[].name` includes `otlp` or `prometheus`. |
| 3.2b | OTel | Mandatory resource attributes declared and emitted (`service.name` at minimum). | `spec.otel.resource_attributes.required` contains `service.name`. |
| 3.3 | Storage | Platform-default retention applied (no override). | `spec.storage` is absent or matches platform default for tier-3. |
| 3.4 | Queries | Recording rule present for every SLO. | For every SLO id, a recording rule referencing it exists. |
| 3.5 | Dashboards | Service-overview dashboard present, displaying the declared SLI(s). | `dashboard.id == 'service-overview'` and panel bindings cover every SLI. |
| 3.6 | Policy | At least one alert rule per SLO. | `len(spec.policy.burn_rate_alerts) >= len(spec.slos)` |
| 3.7 | Alerting | At least one chat channel route for SEV3 or above. | A route exists with a `msteams:` channel. |
| 3.8 | Self-healing | Optional. | Always passes. |
| 3.9 | Baselines | MTTD and MTTR p50 targets declared. | `spec.baselines.mttd_target_p50` and `mttr_target_p50` are set. |
| 3.10 | Validation | At least one synthetic probe of a primary endpoint. | `len(spec.validation.synthetic_checks) >= 1` |

### 3.2 Tier-2 additions

Tier-2 packs are appropriate for internal-critical services where chat-only paging is acceptable but multi-window alerting and active validation are needed.

| # | Dimension | Additional requirement | Conformance check |
|---|---|---|---|
| 2.1 | SLIs/SLOs | At least one latency SLI in addition to availability. | At least one SLI of type `threshold` or `distribution` exists. The check is by type, not by direction: since spec 1.3 a floor SLI (`good_when: above`, e.g. connected consumers) satisfies it as well. |
| 2.2 | Pipelines | OTel Collector metrics pipeline present (otlp or prometheus receiver → prometheusremotewrite exporter). | `spec.pipelines.exporters.metrics.kind == "prometheusremotewrite"` |
| 2.2b | OTel | SemConv version pinned to ≥ binding floor; auto-instrumentation declared for at least one language. | `spec.otel.semconv >= "1.26.0"` and `len(spec.otel.sdk.languages) >= 1` |
| 2.3 | Queries | At least one derived view referencing a platform template. | `len(spec.queries.derived_views) >= 1` |
| 2.4 | Dashboards | SLO-burn dashboard present in addition to service-overview. | `dashboard.id == 'slo-burn'` exists. |
| 2.5 | Policy | Multi-window burn-rate alerts for every availability SLO (fast-burn + slow-burn pair). | Every burn-rate alert for an availability SLO has at least 2 windows with distinct factors. |
| 2.6 | Alerting | Voice channel routed for SEV1. | A SEV1 route includes a `voice:` channel. |
| 2.7 | Baselines | Regression detection enabled (warn-only acceptable). | `spec.baselines.regression_gate` is set, any value. |
| 2.8 | Validation | Monthly chaos experiment in staging covering the primary SLO. | A chaos experiment exists with `schedule: monthly` (or finer) and `steady_state_hypothesis` referencing an SLO. |

### 3.3 Tier-1 additions

Tier-1 packs are mandatory for customer-facing or revenue-impacting services. The bar is high because the consequences of detection or response failure are concrete and measurable.

| # | Dimension | Additional requirement | Conformance check |
|---|---|---|---|
| 1.1 | SLIs/SLOs | At least one domain SLI beyond availability and latency (freshness, durability, throughput, or business-domain signal). | At least three distinct SLI types or domain-tagged SLIs declared. |
| 1.2 | Pipelines | OTel logs + traces pipelines present in addition to metrics, with tail sampling on traces. | `spec.pipelines.exporters.logs.kind` and `.traces.kind` both `"elasticsearch"`; processors include `tail_sampling`. |
| 1.2b | OTel | SemConv pinned to current tracked version (not just floor); resource attributes include `service.namespace`, `service.version`, `service.instance.id`, `deployment.environment`; log-correlation enabled. | `spec.otel.semconv == "1.27.0"` and `spec.otel.sdk.log_correlation == true` and required attrs ≥ 5. |
| 1.2c | OTel | Synthetic probes are OTel-instrumented (propagate `traceparent`). | At least one synthetic check has `otel_instrumentation: true`. |
| 1.3 | Queries | Per-tenant or per-region rollup view present. | A derived view binds a `per-tenant-rollup` or equivalent template. |
| 1.4 | Dashboards | Deployment overlay and customer-impact dashboards present in addition to the others. | Both `deployment` and `customer-impact` dashboard IDs exist. |
| 1.5 | Policy | Forecast declared on the primary availability SLO. | At least one entry in `spec.policy.forecasts` referencing an availability SLO. |
| 1.6 | Alerting | Out-of-band escalation channel (WhatsApp or equivalent) on SEV1. | SEV1 route includes a third channel beyond chat and voice. |
| 1.7 | Self-healing | At least one automated remediation declared with full guardrails. | `len(spec.remediation) >= 1` and every remediation has `max_invocations_per_hour` set. |
| 1.8 | Baselines | Regression release-gating enabled (block, not warn) and p95 targets declared. | `regression_gate` starts with `block_release_if_` and `mttd_target_p95` / `mttr_target_p95` are set. |
| 1.9 | Validation | Weekly chaos in production for at least one fault class, with blast-radius controls. | A chaos experiment has `schedule: weekly` and `environment: prod`. |
| 1.10 | Validation | Synthetic probe of the primary user journey at 1-minute interval or finer. | A synthetic check has `interval` <= `1m`. |

---

## 4. Scoring and reporting

### 4.1 Score computation

Each MUST clause that the pack satisfies counts 1 point. Each SHOULD clause from the standard that the pack satisfies counts 0.5 points. The denominator is the count of clauses applicable at the pack's required tier. The score is published as a percentage rounded to one decimal.

```
score = sum(MUST_satisfied) + 0.5 * sum(SHOULD_satisfied)
total = count(MUST_at_tier) + 0.5 * count(SHOULD_at_tier)
percent = round(100.0 * score / total, 1)
```

A pack is **conformant** if every MUST is satisfied — i.e. the MUST sub-score is 100%. The SHOULD sub-score is reported separately and contributes to the team's reliability culture metric, not to a binary conformance verdict.

### 4.2 Reporting cadence

- **Per-pack scan:** every 24 hours, on the pack's last-applied effective manifest.
- **Score storage:** time-series in the platform's TSDB (yes, the conformance score is itself a metric — it has its own SLO).
- **Drift surfacing:** any regression in a pack's MUST sub-score (i.e. a previously-passing clause now failing) opens an automatic ticket against the pack's primary owner.
- **Cohort reporting:** monthly rollup by team, by domain, by criticality tier — published to platform leadership.

### 4.3 Conformance dashboard

The platform maintains a top-level dashboard with the following views:

- All packs, sorted by MUST sub-score ascending (worst first).
- Packs with active exceptions, with countdown to expiry.
- Packs failing tier-1 clause 1.9 (production chaos) more than 30 days running.
- Trend of organisation-wide conformance over time.

---

## 5. Exception process

A team that cannot satisfy a particular MUST clause may file an exception. Exceptions are not failures — they are explicit, time-bounded, reviewed acknowledgements that something is non-standard right now.

### 5.1 Exception lifecycle

1. **Filing.** The team opens a ticket in the platform exception tracker, naming the clause, the reason, the planned remediation date, and a compensating control if applicable.
2. **Review.** The platform engineering lead reviews within 5 business days. Approval defaults to 90 days; longer windows require a written justification.
3. **Tagging.** On approval the pack receives an `exception:<clause-id>:<expiry-date>` annotation. The conformance scanner treats the clause as satisfied for the duration but flags it on the dashboard.
4. **Renewal.** Exceptions may be renewed once. A second renewal is escalated for resolution rather than further extension.

### 5.2 Compensating controls

When an exception is granted, the pack SHOULD declare a compensating control in its annotations. Examples:

- "Cannot run production chaos for clause 1.9; running every release-candidate build through a staging chaos suite prior to promotion."
- "Cannot hit MTTD p50 of 2m for tier-1 (clause 1.8) while the legacy paging adapter is in place; on-call engineer is paged from a backup PagerDuty integration that meets the target."

These annotations become part of the audit record.

---

## 6. Onboarding playbook

For a service team adopting the standard for the first time, the recommended path is:

### Week 1 — Tier-3 baseline
- Author the pack's metadata block and a single availability SLI/SLO.
- Add the default scrape job; verify metrics flow.
- Generate the service-overview dashboard from the platform template.
- Add a chat-only SEV3 route.
- Declare MTTD/MTTR baselines using platform defaults for the criticality tier.
- Add a single synthetic probe.
- File the pack PR; get to a passing tier-3 conformance score.

### Weeks 2–8 — Toward tier-2
- Add a latency SLI/SLO.
- Convert single-window alerts to multi-window burn-rate alerts.
- Wire up PagerDuty for SEV1.
- Add an OpenTelemetry collector pipeline.
- Add an SLO-burn dashboard.
- Schedule the first staging chaos experiment.

### Weeks 8–24 — Toward tier-1 (only for tier-1 services)
- Add a domain SLI (freshness, throughput, etc.).
- Define and enable at least one self-healing remediation.
- Wire up the WhatsApp out-of-band channel.
- Promote the chaos experiment to weekly production with blast-radius limits.
- Switch baselines from warn-only to a release-blocking gate.

The platform's observability champion programme assigns a partner to each onboarding team for the first 90 days.

---

## 7. Programmatic check (reference)

The conformance scanner is a stateless service that takes an effective pack and returns a structured result. The shape is below for teams that want to run the same checks locally during development.

```yaml
# packscan-result.yaml
pack: payment-service@1.4.0
tier_required: tier-1
must:
  satisfied: 24
  total: 26
  failures:
    - clause: 1.7
      message: "no remediation declared with max_invocations_per_hour guardrail"
    - clause: 1.10
      message: "synthetic check 'api-checkout-canary' interval is 1m, want <=1m"
should:
  satisfied: 18.0
  total: 22.0
score_percent: 92.3
verdict: NON_CONFORMANT   # because MUST sub-score < 100%
exceptions: []
generated_at: 2026-05-08T14:00:00Z
```

The CLI `packscan ./payment-service.pack.yaml` produces the same output, useful in CI gates as `packscan --tier=tier-1 --strict`.

---

## 8. Evolution

The maturity model is versioned alongside the standard. Adding a new MUST clause is a major version bump and triggers a 90-day grace window during which the new clause is reported but not enforced. Removing a MUST clause requires only a minor bump.

The platform team reviews the model annually against incident-review themes — if a class of incident keeps surfacing root causes that the model would not have flagged, that is a signal that a new clause should be considered.
