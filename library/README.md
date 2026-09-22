# The pack library

Versioned, parameterised pack fragments — one YAML entry per **product** a service
runs on (`products/`) or per **archetype** of a service built from scratch
(`archetypes/`). `packc init` and, in the BUILD journey's next slice, the studio's
SELECT / GENERATE / VALIDATE steps instantiate an entry into a canonical
ObservabilityPack v1.2 at a chosen criticality tier. The engine is
`tools/lib/library.mjs` (pure, browser-safe); the loader is `server/library.mjs`;
the design is [docs/BUILD_JOURNEY.md](../docs/BUILD_JOURNEY.md).

```
library/
  products/<product>.library.yaml      kafka · prometheus · grafana · ibm-mq · alertmanager · loki · tempo · otel-collector
  archetypes/<archetype>.library.yaml  http-service · queue-consumer
```

## What an entry is

An entry contributes only what is product-specific. Everything a tier needs
structurally (OTel block, backends, pipelines, storage, recording rules, the
overview / burn / deployment / customer-impact boards, burn-rate policy, routes,
remediation, baselines, the fallback probe, the chaos set) comes from the one
generic tier scaffold in `tools/lib/library.mjs`, sized so that every MUST clause
of `tools/lib/conformance.mjs` that applies at the tier passes when every toggle is
on. Tier requirements are that rubric — nothing here defines a second one.

```yaml
library: v1                 # entry format version
id: kafka                   # slug; the pack's library.source is "<id>@<version>"
kind: product               # product | archetype
version: 1.0.0
title: Apache Kafka
product: kafka              # products only: the spec Product key (archetypes have none)
summary: one line           # what the studio lists
description: |              # a paragraph
tags: [messaging]
derivedFrom: reference-packs/kafka.pack.yaml@1.0.0   # optional provenance of the fragment
evidence:                   # the entry's evidence bar (below)
  status: recorded-live     # recorded-live | reference-pack | upstream-docs | semconv
  verifiedOn: 2026-09-22    # or null
  sources: [ ... ]          # where every name and number comes from
  notes: |                  # what was and was not measured
  gaps: [ ... ]             # what the entry honestly does not cover
params:                     # values the query templates take; ${id} anywhere in the entry
  - { id: broker_job, label: ..., default: kafka-broker, description: ... }
  - { id: bootstrap, label: ..., default: kafka.kafka:9092, placeholder: true, description: ... }
otel: { languages: [java, go], custom_attributes: [kafka.cluster.id] }
telemetry:
  scrape_jobs: [ { job_name: "${broker_job}", scrape_interval: 30s, targets: ["${broker_targets}"], minTier: tier-3 } ]
slis:
  - id: broker_availability
    type: ratio             # ratio (good/total) | threshold (query/threshold, upper bound)
    minTier: tier-3         # the least stringent tier that includes it
    description: ...
    why: ...                # why this SLI, for the studio
    unit: ratio
    metrics: [up]           # the metric names the query reads (checked against the query)
    evidence: { status: recorded-live, source: "kafka.md §1.4 — ..." }
    good: |
      sum(up{job="${broker_job}"} == bool 1)
    total: |
      count(up{job="${broker_job}"})
    slo:
      objective: { tier-1: 0.999, tier-2: 0.999, tier-3: 0.99 }   # or one number
      window: 30d           # 7d | 28d | 30d | 90d, per tier or one value
    burn: availability      # availability | latency | saturation | slow, or explicit windows
    forecast: { method: holt-winters, horizon: 7d, on_projected_breach: open_ticket, minTier: tier-1 }
    chaos: { id: broker-pod-kill, engine: chaos-mesh, target: "${broker_workload}", fault: { kind: pod-failure, fraction: 0.33, duration: 90s }, expected_mttd: 90s, minTier: tier-2 }
    remediation: { trigger: alert:kafka-broker-down, runbook: broker-down, automation: argo-workflow://..., guardrails: { ... }, minTier: tier-2 }
views:       [ { id: per_topic_throughput, bind: ref:platform/per-resource-rollup, params: { metric: ..., by: [topic] }, minTier: tier-2 } ]
dashboards:  [ { id: kafka-consumer-lag, minTier: tier-3, binds: [slis.consumer_group_lag_seconds, slos.consumer_group_lag_seconds, views.per_consumergroup_lag] } ]
synthetic:   [ { id: produce-consume-canary, kind: k6, target: "${bootstrap}", interval: 1m, assertions: [...], on_fail_severity: SEV2, minTier: tier-3 } ]
```

`slos.<sli id>` in a board binding means "the SLO of that SLI" (SLO ids are derived:
`<sli>_<objective>`, e.g. `broker_availability_99_9`). `${service}`, `${environment}`
and `${tier}` are built-ins; the scaffold's own parameters (`oncall_channel`,
`pager_service`, `metrics_endpoint`, `chaos_target`, …) are listed by
`packc init --show <entry>`. A parameter flagged `placeholder: true` that is left at
its default is written into the pack AND reported as a todo
(`metadata.annotations['library.todo.<symbol>']`) at the artefact where it landed.

YAML is read by `tools/lib/mini-yaml.mjs`: no anchors, no `|-`, no tags, and a
plain list item must not contain `: ` (it would parse as a mapping) — use ` — `.

## The quality bar

1. **Every metric name is evidence.** A name in an SLI must be traceable to a
   reference pack (`reference-packs/*.pack.yaml` + `docs/catalogue-evidence/*.md`),
   the stack self-metric alias table (`tools/lib/contracts/stack-self-metrics.mjs`),
   the MQ repository's evidence documents, or a named OpenTelemetry semantic-conventions
   document with its version and the Prometheus exposition spelling. The evidence
   block says which, per entry and per SLI. If a spelling cannot be verified in this
   repository, the entry says so (`evidence.notes`) rather than guessing; if a
   product has no evidence-backed metric for a signal, the SLI is not written and
   `evidence.gaps` records the hole.
2. **PromQL is derived, not rewritten.** For the four evidence-backed products the
   expressions are the reference / MQ pack's, with scrape jobs and names as parameters;
   for the contract-seeded products they are the alias table's expressions with its
   presence guards; for the archetypes the semconv names in Prometheus spelling. The one
   derivation allowed beyond parameters is the guard the burn-rule generator asks for
   (`(… or vector(0))` on a subtracted failure counter, `== bool` on a comparison),
   stated in the entry's `evidence.notes`; `instantiatePack` returns the generator's
   remaining warnings as `warnings` of kind `burn-rules` and the suite fails an entry
   whose legs still draw the arithmetic or bool warning.
3. **Instantiable at every tier.** Every entry needs at least one ratio SLI at
   `tier-3` (L1.MUST.availability_slo) and one threshold SLI by `tier-2`
   (L1.MUST.latency_slo); with the scaffold, every applicable MUST passes at every
   tier and every SHOULD at tier-1 (`tools/test-library.mjs` proves it).
4. **Values the library cannot know are placeholders**, never plausible-looking
   facts: a pager service, a chaos target, an endpoint. They are parameters with
   `placeholder: true`.
5. **Objectives are tiered** where a lower tier would honestly accept less
   (`0.99` at tier-3 where the reference pack says `0.999`), and burn windows come
   from a named profile so the whole library alerts the same way.

## Adding an entry

1. Copy the closest entry; keep `library: v1`, pick `kind`, set `version: 1.0.0`.
2. Write the evidence block first — the sources you will cite for every name.
3. Write the SLIs with `minTier`, `metrics`, per-SLI `evidence`, per-tier objectives
   and a burn profile; add chaos / remediation / forecast templates where the
   evidence supports a fault and a runbook.
4. Declare the params every `${x}` uses (`validateLibraryEntry` rejects an undeclared
   one) and flag the unknowable ones `placeholder: true`.
5. `packc init --show <id>` to read it back; `packc init --entry <id> --tier tier-1
   --name x` at each tier to see the todos and the conformance line.
6. `npm run test:library` — the suite loads every entry, instantiates it at every
   tier and checks the whole chain (below). Regenerate the goldens only when an
   existing entry's output is meant to change: `node tools/test-library.mjs --update`,
   and explain the diff in the commit.

## How CI proves it

`tools/test-library.mjs` (in `npm test`), for every entry × every tier with default
toggles:

- the entry parses and `validateLibraryEntry` returns no error;
- `validateCanonical` accepts the produced pack (spec v1.2 schema);
- every `compile.mjs` target compiles it without throwing (Prometheus rules, OTel
  Collector, Alertmanager, Grafana dashboard);
- the generic dashboard generator builds every board and `checkBindings` reports
  nothing;
- `evaluateConformance` at that tier: the set of failing MUST clauses is a subset of
  the clauses the todos name (both sets are printed on failure) — with defaults it is
  empty — and at tier-1 every SHOULD passes too;
- the provenance annotations are present and the todos are exactly the
  `library.todo.*` annotations;
- switching dashboards off makes exactly the dashboard clauses fail; switching
  policy off exactly the burn-rate clause;
- three goldens (`tools/fixtures/library/kafka.tier-2.pack.yaml`,
  `ibm-mq.tier-1.pack.yaml`, `http-service.tier-3.pack.yaml`) are byte-stable.

`npm run lint:library` parses the engine, the loader and the CLI.
