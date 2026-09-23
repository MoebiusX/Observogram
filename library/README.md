# The pack library

Versioned, parameterised pack fragments — one YAML entry per **product** a service
runs on (`products/`) or per **archetype** of a service built from scratch
(`archetypes/`). `packc init` and the studio's DEFINE / COMPILE / VERIFY steps
instantiate an entry into a canonical ObservabilityPack v1.2 at a chosen criticality
tier. The engine is `tools/lib/library.mjs` (pure, browser-safe); the loader is
`server/library.mjs`; the design is [docs/BUILD_JOURNEY.md](../docs/BUILD_JOURNEY.md).

**The library's values are defaults, never constraints.** The tier is a seed: it decides
which SLIs a pack starts with (`minTier`) and which rubric grades it, and any SLI of an
entry may be selected at any tier. Once an entry is instantiated its values are copies
the caller may edit — an objective, a window, a bound, an expression — through
`overrides` and `custom` ("The seed and the copies" below).

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
    minTier: tier-3         # the least stringent tier that includes it BY DEFAULT — never a gate: any SLI may be selected at any tier
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
      objective: { tier-1: 0.999, tier-2: 0.999, tier-3: 0.99 }   # or one number; a tier below minTier may be left out
      window: 30d           # 7d | 28d | 30d | 90d, per tier or one value
    burn: availability      # availability | latency | saturation | slow, or explicit windows
    forecast: { method: holt-winters, horizon: 7d, on_projected_breach: open_ticket, minTier: tier-1 }
    chaos: { id: broker-pod-kill, engine: chaos-mesh, target: "${broker_workload}", fault: { kind: pod-failure, fraction: 0.33, duration: 90s }, expected_mttd: 90s, minTier: tier-2 }
    remediation: { runbook: broker-down, automation: argo-workflow://..., guardrails: { ... }, minTier: tier-2 }
                            # no trigger: it is derived — alert:<slo>_burn_<factor>x_<short>_<long>, this SLI's fast burn alert
views:       [ { id: per_topic_throughput, bind: ref:platform/per-resource-rollup, params: { metric: ..., by: [topic] }, minTier: tier-2 } ]
dashboards:  [ { id: kafka-consumer-lag, minTier: tier-3, binds: [slis.consumer_group_lag_seconds, slos.consumer_group_lag_seconds, views.per_consumergroup_lag] } ]
synthetic:   [ { id: produce-consume-canary, kind: k6, target: "${bootstrap}", interval: 1m, assertions: [...], on_fail_severity: SEV2, minTier: tier-3 } ]
```

`slos.<sli id>` in a board binding means "the SLO of that SLI" (SLO ids are derived:
`<sli>_<objective>`, e.g. `broker_availability_99_9`). A remediation template names no
trigger: a library pack compiles burn-rate and forecast alerts and nothing else, so the
scaffold keys every remediation to its SLI's fast burn alert under the compiler's name
(`alert:broker_availability_99_9_burn_14x_5m_1h`), and `validateLibraryEntry` rejects a
`trigger` in the template — the reference packs' symptom-alert names resolve in their own
repositories only because those ship rule files. `${service}`, `${environment}`
and `${tier}` are built-ins; the scaffold's own parameters (`oncall_channel`,
`pager_service`, `metrics_endpoint`, `chaos_target`, …) are listed by
`packc init --show <entry>`. A parameter flagged `placeholder: true` that is left at
its default is written into the pack AND reported as a todo
(`metadata.annotations['library.todo.<symbol>']`) at the artefact where it landed.

YAML is read by `tools/lib/mini-yaml.mjs`: no anchors, no `|-`, no tags, and a
plain list item must not contain `: ` (it would parse as a mapping) — use ` — `.

## The seed and the copies

**The per-tier walk.** A value declared per tier (`slo.objective`, `slo.window`) is read
at the pack's tier, then walking towards the stricter tiers to the first value declared:
a tier-2 pack that adds an SLI declared for `tier-1` only starts with the tier-1
objective; a tier-3 pack adding one declared for tier-2 and tier-1 takes tier-2's. Where
the map declares a value for the lower tier anyway (the shipped entries do), that value
stands. `validateLibraryEntry` requires the objective for the tiers the SLI reaches and
lets a tier below its `minTier` be left out. An SLI's own tier features — a `forecast`,
a `chaos` or a `remediation` template with a `minTier` — keep their gating against the
pack's tier: they are tier features, not the SLI. The rubric still grades the pack at
its tier; an extra SLI simply counts.

**Overrides** — copy-on-write over an SLI's template, keyed by the SLI id as the pack
carries it (prefixed when several entries compose: `kafka_produce_latency_p99`):

```js
instantiatePack(entries, { name, tier, overrides: {
  kafka_produce_latency_p99: { objective: 0.995, window: '7d', threshold: 0.25 },
  http_service_availability: { good: 'sum(rate(http_ok_total[5m]))', total: 'sum(rate(http_total[5m]))' },
} })
```

The fields (`OVERRIDE_FIELDS`): `objective` (a number in (0, 1) — the ratio the pack
stores; the studio shows a percent), `window` (one of the schema's SLO windows `7d | 28d
| 30d | 90d` — the schema's enum, not any duration), `threshold` (a finite number, a
threshold SLI only; it is an upper bound: spec v1.2 has no direction field, so
`comparison` is refused with that reason — a floor is a ratio SLI), `query` (threshold)
or `good` / `total` (ratio) — non-empty strings within `MAX_PARAM_LENGTH` (4096) that
carry no `${…}` placeholder, since an override replaces the library's expression *after*
the params are in — `description` and `unit` (bounded strings). An unknown field, a wrong
type, a key that is not an SLI id (`^[a-z][a-z0-9_]{0,63}$`; `__proto__`, `constructor`
and `prototype` refused, nothing read through the prototype chain) are usage errors that
name the field: `override <sli>.<field>: …`. An override for an SLI that is not in the
pack is a **warning** of kind `override`, never an error. An overridden objective flows
into the SLO (its id follows: `sloIdFor`), the burn alerts and the boards' bindings; an
overridden window into the SLO. **An overridden expression drops the library's evidence
honestly**: the SLI's evidence becomes `{ status: 'custom', source: 'edited in the studio',
note: 'the library evidence no longer applies' }` and the template's `semconv_metric` goes
with it; a bound, an objective or a window keeps the library's evidence (the expression is
still the library's). The result says what was customised: `provenance.slis[<id>]
.customised` (the fields), `provenance.overrides`, and on the pack
`library.customised.slis.<id>` and `library.overrides`.

**Custom SLIs** — written from scratch, outside any entry:

```js
instantiatePack(entries, { name, tier, custom: [
  { id: 'checkout_success', type: 'ratio', good: 'sum(rate(checkout_ok_total[5m]))', total: 'sum(rate(checkout_total[5m]))', objective: 0.999, window: '30d' },
  { id: 'checkout_p99', type: 'threshold', query: 'histogram_quantile(0.99, sum by (le)(rate(checkout_seconds_bucket[5m])))', threshold: 0.3, unit: 'seconds', objective: 0.99, window: '7d' },
] })
```

The id a slug `^[a-z][a-z0-9_]{1,62}$` (not `errorbudget`) that no SLI of the chosen
entries owns — a clash with a library SLI (ticked or not: an un-ticked one would clash the
moment it is ticked) or with another custom one is a usage error naming both;
`objective` and `window` required; the PromQL required per type; every field checked as
above (`custom <id>.<field>: …`). A custom SLI gets an SLO, a recording rule, burn alerts
from the **default burn profile** (`DEFAULT_BURN_PROFILE`: `availability` for a ratio,
`latency` for a threshold — the profile a template without `burn` takes), SLI and SLO
bindings on the overview board, the evidence `{ status: 'custom', source: 'written in the
studio' }`, `provenance.slis[<id>].library.source = 'custom'`, `provenance.custom` and
the annotation `library.custom`. The rubric counts it like any SLI, nothing more.

**Where.** The API (`POST /api/library/instantiate`, `/compile`, `/register` take
`overrides` and `custom`; at most 64 override entries and 16 custom SLIs per request,
400 beyond, every value validated by the engine; `/compile` and `/register` accept the
instantiate inputs in place of `canonical`), the studio (the L1 sheet's Customise face
and its + Custom SLI card), and the CLI for the scalar overrides only:
`packc init … --override <sli>.<objective|window|threshold>=<value>` (repeatable; a query,
good or total is edited in the studio or in the pack file; the CLI takes no custom SLI in
this slice). `--slis a,b` / `--sli <id>` takes any SLI of the chosen entries, above the
tier too.

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
   from a named profile so the whole library alerts the same way. They are defaults:
   a caller may override them per SLI, and the pack then says so.

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
- the seed and the copies: an SLI above the tier instantiates with its own profile's
  objective and no warning; the per-tier walk; overrides change the SLO id, the window,
  the threshold; an overridden expression drops the evidence to `custom` and the
  provenance lists the field; the usage errors and the `override` warning; a custom ratio
  and a custom threshold SLI in `slis`, `slos`, the recording rules, the policy and the
  bindings, schema-valid, counted by the rubric; a duplicate custom id refused;
  `defaultToggles` unchanged;
- three goldens (`tools/fixtures/library/kafka.tier-2.pack.yaml`,
  `ibm-mq.tier-1.pack.yaml`, `http-service.tier-3.pack.yaml`) are byte-stable.

`npm run lint:library` parses the engine, the loader and the CLI.
