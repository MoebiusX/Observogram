# The BUILD journey

A second, parallel journey beside Discover · Diagnose · Remediate, for teams that
have no pack yet. Three steps in the same visual language, ending where the
existing journey begins. This document is the contract between the engine
(slice 1, shipped: `tools/lib/library.mjs`, `library/`, `packc init`) and the
studio + API that slice 2 builds on top of it. Precedent, superseded by this
design: [archive/COMPOSE_MODE_PLAN.md](archive/COMPOSE_MODE_PLAN.md) (drag-and-drop
authoring from a block library — the library is now data, the canvas is the
generated pack) and [archive/REFERENCE_CATALOGUE_PLAN.md](archive/REFERENCE_CATALOGUE_PLAN.md)
(the catalogue those blocks came from — the reference packs are now the evidence
behind the entries).

## The three steps

| Step | Question | Input | Output |
|---|---|---|---|
| 1 SELECT | What are we building? | service name, owners, criticality tier-1/2/3, environment, one or more library entries (products it runs on, or an archetype for a service built from scratch) | the entries' params with defaults; the tier's requirements (`tierRequirements`) |
| 2 GENERATE | What should it watch? | per-entry SLI toggles (filtered by tier), params, section toggles (SLOs, policy + routes, dashboards, validation) | the canonical pack + todos + provenance (`instantiatePack`) |
| 3 VALIDATE | Does it hold up? | the pack | which clauses pass, which pass only on a placeholder, which fail (`validationSummary`); the schema verdict; the compiled artifacts through the existing targets (Prometheus rules, OTel Collector, Alertmanager, Grafana dashboards) |

**Hand-off.** "Open in Discover" registers the produced pack in the studio's upload
registry (the same path an uploaded pack takes) and switches to the existing journey:
Discover shows its layers, Diagnose compares it with a live pack, Remediate compiles
and deploys the delta. Nothing in Discover / Diagnose / Remediate changes; a
library-built pack is an ordinary canonical pack with provenance annotations.

## The library

`library/products/<product>.library.yaml` and `library/archetypes/<archetype>.library.yaml`,
format `library: v1`, one entry per product or archetype, each a parameterised pack
fragment. The annotated example and the field list are in
[library/README.md](../library/README.md); the shape in one breath:

```
id · kind (product | archetype) · version · title · product · summary · description · tags · derivedFrom
evidence { status, verifiedOn, sources[], notes, gaps[] }
params[] { id, label, default, description, placeholder? }
otel { languages[], custom_attributes[] }
telemetry { scrape_jobs[] { job_name, scrape_interval, targets[], minTier }, receivers[] }
slis[] { id, type, minTier, description, why, unit, metrics[], evidence { status, source },
         good/total | query/threshold, slo { objective per tier, window per tier }, burn,
         forecast?, chaos?, remediation? { runbook, automation, guardrails, minTier — no trigger: derived } }
views[] · dashboards[] { id, minTier, binds[] } · synthetic[] { …, minTier }
```

Entries shipped in slice 1 and their evidence status:

| Entry | Kind | Evidence | Derived from |
|---|---|---|---|
| kafka, prometheus, grafana | product | recorded-live (2026-09-22) | the reference packs + `docs/catalogue-evidence/*.md` "Measured live" |
| ibm-mq | product | recorded-live (2026-09-16, certified) | mq-observability-pack `packs/ibmmq.pack.yaml` + its evidence docs (read-only) |
| alertmanager, otel-collector | product | recorded-live (2026-09-07) | `tools/lib/contracts/stack-self-metrics.mjs` (pinned stack exposition + PromQL) |
| loki, tempo | product | recorded-live (2026-09-07) | `up` of the lab's scrape job + the collector / promtail rows of the alias table; no `loki_*` / `tempo_*` request metric is in the evidence, so none is named (`evidence.gaps`) |
| http-service, queue-consumer | archetype | semconv (v1.27.0, Prometheus spelling; not verified live in this repo, and the entry says so) | OTel semantic conventions + the Prometheus compatibility naming rules |

## The tier scaffold

One function, `tierScaffold`, shared by every entry. It produces the structural
sections and grows them with the tier so that every MUST clause of
`tools/lib/conformance.mjs` that applies at the tier is satisfied when every toggle
is on — the rubric is the only definition of a tier; `tierRequirements(tier)` is that
rubric filtered by `minTier`.

| Section | tier-3 | tier-2 adds | tier-1 adds |
|---|---|---|---|
| otel | semconv 1.27.0, `service.name` + `deployment.environment`, head sampling 0.1 | `service.namespace`, `service.version`, `log_correlation: true` | `service.instance.id` (5 attrs), head ratio 1.0 (tail sampling decides) |
| telemetry.backends | Prometheus + Loki + Tempo, `gating: warn`; the declared versions are placeholder params (`prometheus_version`, `loki_version`, `tempo_version`), `min` the scaffold floor | — | `gating: enforce` |
| pipelines | otlp receiver, prometheus receiver with the entries' scrape jobs, memory_limiter + batch, three exporters (prometheusremotewrite, otlphttp → Loki, otlp → Tempo) | resource processor | tail_sampling processor |
| storage | 15d / 7d / 3d, head-based | 90d / 30d / 7d | 13mo / 90d / 14d, tail-based |
| queries | one `ref:slis.<id>` recording rule per SLI (`<svc>:<sli>:ratio_5m` / `value_5m`, the compiler's own names, deduplicated by it) + the entries' views | golden-signals view | — |
| dashboards | `<svc>-overview` (every SLI and SLO) + the entries' boards | `<svc>-slo-burn` (burn template, every SLO) | `<svc>-deployment-overlay` (SLIs), `<svc>-customer-impact` (SLOs) |
| policy | two-window burn alerts per SLO from the SLI's profile (availability / latency / saturation / slow), severities demoted one step | severities as declared | forecast on an availability SLO |
| alerting | SEV1/SEV2 → chat, SEV3 → team chat, dedup | SEV1 voice, suppress contexts | SEV2 voice |
| remediation | — | the entries' templates, each triggered by its SLI's fast burn alert under the compiler's name (`alert:<slo>_burn_<factor>x_<short>_<long>`): the alerts a library pack compiles, so the trigger resolves like a chaos `expected_alert` does | a generic manual-only one on the first SLO when the entries have none |
| baselines | tier defaults | + p95 targets, `warn_only` | `block_release_if_either_breaches_target` |
| validation | the entries' probes (or a fallback blackbox probe) | the entries' chaos experiments, monthly in staging (a generic one when none) | one experiment per SLO, the first one again weekly in prod, the first probe `otel_instrumentation: true` |

Severities, windows and factors are the reference packs' (`BURN_PROFILES`); the
retention and baseline numbers are starting points and are reported as todos.

## Toggles and honest gaps

`defaultToggles(entry, tier)` → `{ slis: [ids whose minTier the tier reaches], slos,
policy, routes, dashboards, validation }`, every section on. A section switched off is
**absent** from the pack. The schema then reports the missing required key or the
`minItems: 1` floor (`validateCanonical`), and the rubric reports the clauses the
section satisfied (`evaluateConformance`) — VALIDATE shows both, nothing is faked to
keep a clause green. `slos: false` also drops policy (an SLO-less burn alert is
meaningless); `policy: false` keeps the SLOs and drops the burn alerts and forecasts.

## Placeholders and provenance

**Placeholders** are the values the library cannot know. Every one is a parameter
flagged `placeholder: true` (the scaffold's: `oncall_channel`, `team_channel`,
`pager_service`, `pager_service_low`, `metrics_endpoint`, `remote_write_url`,
`logs_endpoint`, `logs_otlp_endpoint`, `traces_endpoint`, `traces_otlp_endpoint`,
`chaos_target`, `probe_target`, and the backend versions the pack declares —
`prometheus_version`, `loki_version`, `tempo_version` (`version.declared` on each
backend and `storage.<signal>.version`; `min` stays the scaffold's floor 2.53 / 3.0 / 2.5,
what the wiring and the PromQL are known to work from, and tier-1 enforces the block);
the entries': scrape targets, bootstrap addresses,
workloads, canary queues). Left at its default it is written into the pack as a
plausible value **and** reported as a todo at the artefact where it landed, plus the
scaffold's own todos (an unwritten runbook, baseline targets, a generic chaos fault,
defaulted owners). The annotation mirrors the crawler's stub marker
(`crawler.scaffold.<symbol>` → `library.todo.<symbol>`, the symbol being the adapter's
artefact id: `alerting.routes[0]`, `validation.synthetic_checks.<id>`,
`telemetry.backends.<id>`, `pipelines.exporters.metrics`, `remediation[0]`, `baselines`)
and `tools/lib/adapter.mjs` lists `library.todo.` beside `crawler.scaffold.` and
`mcp.scaffold.` in its scaffold prefixes, so the studio parks a placeholder artefact
as *Scaffold* — excluded from drift badness, never "declared and unverified" — exactly
as it parks a crawler stub. The todo list returned by the engine is the same
information structured: `{ path, fields, what, clause, clauses, params }` (one per
artefact, its placeholder fields listed), where
`clauses` names the conformance clauses the placeholder artefact holds up, so
VALIDATE can say "passes, on a placeholder".

**Provenance**: `metadata.annotations['library.source'] = '<entry id>@<entry version>'`
(comma-joined when composed), `library.format`, `library.tier`, `library.environment`,
`library.toggles`, `library.slis`, `library.params` (the overrides), `library.evidence`
and `library.evidence.slis.<id>` (per-SLI status and source), `library.todoCount`,
`library.todo.<symbol>`; `metadata.labels.source = library`. Diff can tell
library-derived from hand-written; a later library release compares
`library.source` with its own version to propose an upgrade (slice 3).

## The evidence bar for entries

`evidence.status` per entry and per SLI: `recorded-live` (the name was read from a
product's own exposition and the expression executed — the reference packs' "Measured
live" sections, the MQ certification, the pinned docker stack of the alias table),
`reference-pack` (taken from a reference pack whose evidence is documentary),
`upstream-docs` (the product's documentation only), `semconv` (a named OpenTelemetry
semantic-conventions version, Prometheus spelling by the compatibility rules). No
metric name is invented: `validateLibraryEntry` checks that every name in
`slis[].metrics` appears in the query, and the library README's quality bar says where
a name may come from. Where a spelling could not be verified in this repository the
entry says so; where a product has no evidence-backed metric for a signal, the SLI
is absent and `evidence.gaps` says why (loki, tempo, alertmanager and otel-collector
have no latency SLI; their tier-2 threshold SLIs are failure / drop rates and say so).

## The engine API (`tools/lib/library.mjs`, pure, browser-safe, served at `/lib`)

```
parseLibraryEntry(textOrObject)                 → entry            (mini-yaml when given text)
validateLibraryEntry(entry)                     → errors: string[] ([] when sound)
libraryIndex(entries)                           → [{ id, kind, title, product, version, summary, tags,
                                                     evidence { status, verifiedOn, sources[], gaps[] },
                                                     params[], slis[] { id, type, minTier, evidence, metrics, objectives },
                                                     sliCountByTier, tiers }]
tierRequirements(tier)                          → the conformance clauses that apply at the tier
                                                  ({ id, dimension, severity, minTier, description, specRef })
defaultToggles(entryOrEntries, tier)            → { slis: [ids], slos, policy, routes, dashboards, validation }
instantiatePack(entryOrEntries, { name, tier, environment, owners, params, toggles, promql })
                                                → { canonical, todos: [{ path, fields, what, clause, clauses, params }],
                                                    provenance: { entry, version, entries, source, tier, environment,
                                                                  toggles, params, placeholders },
                                                    warnings: [{ kind, message, sli?, field? }] }
tierScaffold({ tier, service, environment, owners, fragments, toggles })
                                                → { canonical (with ${param} placeholders), todos }   (the one scaffold)
validationSummary(canonical, todos)             → { tier, conformant, must, should, passing[], onPlaceholder[], failing[] }
symbolOf(path, root)                            → { symbol, field }   (the adapter's artefact id for a pack path)
sloIdFor(sliId, objective)                      → '<sli>_<pct>'        (broker_availability, 0.999 → broker_availability_99_9:
                                                                        the SLO id of an SLI, derived here, never re-implemented)
constants: LIBRARY_FORMAT ('v1'), TIERS, ENTRY_KINDS, EVIDENCE_STATUSES, SLI_TYPES, SLO_WINDOWS, SECTION_TOGGLES,
           BURN_PROFILES, SCAFFOLD_PARAMS, SEMCONV_VERSION
```

`instantiatePack` throws on a usage error (unknown tier, an unknown SLI, no entry, a
param key that is not a parameter of the instantiation, a param value that is not a
string, number or boolean) and never on an entry that validates. A mistyped param is
never dropped silently: the error lists the known keys. A selected SLI whose `minTier`
the tier does not reach is **excluded, not fatal**: it comes back as a `warnings` entry
of kind `sli-excluded` and the rest of the selection builds (the tier changes after the
SLIs were ticked, SELECT then GENERATE); only a selection with nothing left throws.

**Params and PromQL.** A param value is spliced verbatim into label matchers, scrape
targets and endpoints, so a string carrying a double quote, a backslash or a control
character is refused (a usage error; `--param 'broker_job=brokers"}'` once produced
`up{job="brokers"}"} == bool 1` in a pack that validated and passed every MUST). Every
resolved SLI expression is then parsed with the parser given as `promql`: `packc init`
passes the Lezer grammar (`tools/lib/promql-lezer.mjs`, an npm import, Node-only) and a
failure is a `warnings` entry of kind `promql`, which makes the CLI exit 1. The
browser-safe core (`tools/lib/promql.mjs`) extracts dependencies and reports no grammar
error, so a caller with no parser gets no `promql` warning: the studio (slice 2) runs the
instantiation through the API, where Node passes the grammar. `warnings` is what GENERATE
shows beside the todos; its kinds: `promql` (the pack must not ship), `sli-excluded` (an
SLI above the tier was dropped), `burn-rules` (the burn-rule generator's own warnings on
the produced policy — `tools/lib/burn-rules.mjs` compiled once at build time, so a
subtracted good leg without a presence guard or a ratio-unit threshold it reads as an
upper bound is seen when the pack is made, not when its alerts stay silent; the shipped
entries draw none of the guardable ones, the suite checks). Several entries compose
into one pack: ids are prefixed with the entry id (`kafka_broker_availability`,
`http-service-…` boards), entry params are addressed as `<entry>.<param>` (a bare
`<param>` reaches every entry that declares it), the scaffold sections are shared.

Node side, `server/library.mjs`: `loadLibrary({ root })` → `{ root, entries, errors }`
(reads `library/**/*.library.yaml`, parses and validates each, drops duplicates; a root
that is not a directory is one error on the root itself, never an empty library, so an
install without `library/` says why every entry is unknown), `findEntry`,
`listLibraryFiles`, `defaultLibraryRoot`. `library/` ships in the npm package (`files`)
beside `server/` and `tools/`. Nothing under `tools/lib` touches the filesystem.

## The CLI

```
packc init --list                                   the entries table
packc init --show <entry>                           params (entry + scaffold), SLIs per tier, objectives, evidence
packc init --entry <id>[,<id>] --tier tier-2 --name <svc> [--env <env>] [--owner <team>]...
           [--param k=v]... [--slis a,b] [--no-slos|--no-policy|--no-routes|--no-dashboards|--no-validation]
           [--out <file>] [--json] [--library <dir>]
```

YAML to stdout (or `--out`), the todo list, the warnings and the conformance line to
stderr; exit `0` ok, `1` the produced pack does not validate against the v1.2 schema (a
section toggled off), an SLI is not valid PromQL once the `--param` values are in, or an
entry fails validation, `2` usage error (an unknown `--param` key or a value carrying a
quote is one) — the convention of `tools/validate-pack.mjs` and `packc journey`.

## What the next slices add

- **Slice 2 — the studio journey and the API.** `GET /api/library` (`libraryIndex` of
  `loadLibrary`), `GET /api/library/:id`, `GET /api/library/requirements/:tier`,
  `POST /api/library/instantiate` (the `instantiatePack` inputs → `{ canonical, todos,
  provenance, schemaErrors, summary }`), `POST /api/library/register` (the produced pack
  into the upload registry → a pack id for "Open in Discover"). A `BUILD_TABS`
  triple beside `OBSERVA_TABS` in `studio/app.mjs`, one view module per step under the
  loader / model / renderer split of docs/UI_CONVENTIONS.md (the model functions are
  this engine, already testable under `node:test`), the compile previews through the
  existing compile catalog.
- **Slice 3.** Seeding SELECT from a repo scan or a live MCP draft (the crawler's
  discovered backends and scrape jobs pre-select entries and fill params); live
  metric-name verification of an entry's `metrics[]` through the MCP capability
  registry, promoting `semconv` / `upstream-docs` evidence to a recorded one per
  deployment; library-upgrade proposals in Remediate (a pack whose `library.source`
  is behind the shipped entry version gets the diff as a remediation).

## Open questions

- Should a toggled-off section be emitted empty rather than absent, so the pack stays
  schema-valid at the price of a less honest gap? Today: absent (both the schema and
  the rubric report it).
- Parking a whole receiver as Scaffold when only its scrape targets are placeholders
  matches the adapter's artefact granularity; a per-field marker would need the
  adapter to learn one.
- Tier-3 objectives (0.99 where the reference pack says 0.999) are the library's
  judgement, not measured; the per-tier table in each entry is the place to argue.
- The archetypes' semconv spellings need one live exposition (slice 3) before the
  `semconv` status can become `recorded-live`.
