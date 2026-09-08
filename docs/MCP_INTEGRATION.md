# MCP Integration

Observogram uses MCP for two jobs:

1. **Read live production posture** and reconstruct it as an ObservabilityPack.
2. **Write selected remediation artifacts** back to the observability platform.

The read path powers Diagnose. The write path powers Remediate.

## Read Path: Live Pack Generation

`tools/fetch-live-pack.mjs` interrogates an MCP endpoint and emits a canonical
ObservabilityPack v1.2 manifest. By default it writes the ignored local file:

```text
examples/production-live.pack.yaml
```

That file is runtime evidence, not a committed fixture. Upload it through the
studio or generate it locally when you need a live Pack B.

The studio can also call the same flow through `POST /api/draft-from-mcp`.
Successful drafts are registered in memory and become selectable as Pack B.

```bash
MCP_URL=https://otel-mcp.example.com/mcp \
MCP_AUTH=$MCP_CLIENT_KEY \
npm run fetch-live
```

## What The Live Pack Contains

The live pack is not just a health summary. It carries the artifacts needed for
diagnostic-grade drift:

| Area | Live evidence |
|---|---|
| Services and topology | discovered services, service graph hints, OTel backend evidence |
| Metrics | metric inventory and names observed from the live platform |
| Scrape jobs | Prometheus/VictoriaMetrics scrape evidence |
| Recording rules | full rule names and expressions where the MCP exposes them |
| Alert rules | Grafana/Prometheus alerting rules; burn-rate alerts are mapped from them per SLO, never synthesised |
| Dashboards | Grafana dashboard metadata plus dashboard bodies, panels, variables, and targets |
| Baselines | none yet — MTTD/MTTR are platform defaults stamped `Scaffold`; anomaly baselines are only counted (`mcp.baselinesComputed`) |
| Backend versions | observed platform products and versions |

This is what lets Observogram compare declared repo artifacts against live
production artifacts instead of only checking whether a live endpoint responded.

## Verification Annotations

The schema constrains `metadata.annotations` to flat string keys, so MCP
attestation is stored as annotations:

```yaml
metadata:
  annotations:
    mcp.refreshedAt: "2026-06-09T00:09:14.730Z"
    mcp.url: "https://otel-mcp.example.com/mcp"
    mcp.toolsCalled: "system_health,vmalert_rules,metrics_label_values,metrics_targets"
    mcp.toolsFailed: ""                              # core tools only; probe families are accounted below
    mcp.toolsExposed: "system_health,vmalert_rules,metrics_label_values,metrics_targets,grafana_dashboards_search,…"
    mcp.toolsExposedCount: "14"
    mcp.toolsUnmatched: "logs_search"                # advertised, no probe pattern yet
    mcp.probesAttempted: "recording_rules,alert_rules,dashboards,metric_names,scrape_configs"
    mcp.probesSucceeded: "recording_rules,alert_rules,metric_names,scrape_configs"
    mcp.probesEmpty: ""                              # a probe answered with an empty list
    mcp.probesFailed: "dashboards"                   # every candidate errored — a hole of unknown size
    mcp.probesUnsupported: ""                        # e.g. "traces_services" when tools/list exposes no candidate — a restricted tier, not an outage
    mcp.probeErrors.dashboards: "HTTP 502 Bad Gateway"   # last erroring candidate of a FAILED family only (trimmed to 200 chars)

    mcp.verified.otel.metrics: "2026-06-09T00:09:14.730Z"
    mcp.verified.telemetry.scrape: "2026-06-09T00:09:14.730Z"
    mcp.verified.pipelines.exporters.metrics: "2026-06-09T00:09:14.730Z"
    mcp.verified.queries.recording_rules: "2026-06-09T00:09:14.730Z"      # aggregate: at least one rule earned an indexed stamp
    mcp.verified.queries.recording_rules[0]: "2026-06-09T00:09:14.730Z"   # per rule, withheld when the ruler reports it unhealthy
    mcp.verified.slis.svc_checkout_availability: "2026-06-09T00:09:14.730Z"   # withheld when a feeding rule is unhealthy
    mcp.verified.slos.svc_checkout_availability_99_9: "2026-06-09T00:09:14.730Z"   # bound by a discovered burn-rate group (exact id or re-identified)
    mcp.verified.policy.burn_rate_alerts[0]: "2026-06-09T00:09:14.730Z"  # per mapped entry, never unindexed
    mcp.verified.dashboards: "2026-06-09T00:09:14.730Z"                   # aggregate
    mcp.verified.dashboards.kx-genai-operations: "2026-06-09T00:09:14.730Z"   # per discovered dashboard (the symbol the adapter reads)

    mcp.discovered.alert_rule_names: "svc_checkout_availability_99_9_burn_14x_5m_1h,..."
    mcp.discovered.alert_rules_unmapped: "svc_payments_latency_99"
    mcp.discovered.scrape_jobs: "node-exporter,grafana,otel-collector"
    mcp.discovered.scrape_jobs_down: "alertmanager"
    mcp.discovered.alert_rules_unhealthy: "HighLatencyP99"
    mcp.discovered.slis_unhealthy: "svc_payments_latency"      # SLIs whose feeding recorded rule is unhealthy (only when non-empty; likewise recording_rules_unhealthy, alert_rules_severity_inferred)
    mcp.observed.scrape_targets: '[{"job":"alertmanager","instance":"kx-alertmanager:9093","health":"down","lastScrape":"…","lastError":"dial tcp4 …: connection refused"}, …]'
    mcp.observed.recording_rules: '[{"name":"finops:cpu:usage_per_pod_5m","health":"ok","lastError":null,"lastEvaluation":"…","evaluationTime":0.0009}, …]'
    mcp.observed.alert_rules: '[{"name":"HighLatencyP99","health":"err","lastError":"…","lastEvaluation":"…","state":"inactive","activeAt":null}, …]'
    mcp.baselinesComputed: "2"

    mcp.scaffold.otel: "schema-required fallback; not attested by any MCP tool"
    mcp.scaffold.pipelines.receivers[0]: "schema-required fallback; not attested by any MCP tool"
    mcp.scaffold.pipelines.processors[0]: "schema-required fallback; not attested by any MCP tool"
    mcp.scaffold.pipelines.exporters.logs: "schema-required fallback; not attested by any MCP tool"
    mcp.scaffold.pipelines.exporters.traces: "schema-required fallback; not attested by any MCP tool"
    mcp.scaffold.telemetry.backends.logs-elastic: "schema-required fallback; not attested by any MCP tool"
    mcp.scaffold.alerting.routes[0]: "schema-required fallback; not attested by any MCP tool"
    mcp.scaffold.baselines: "schema-required fallback; not attested by any MCP tool"
    mcp.scaffold.policy.burn_rate_alerts[0]: "schema-required fallback; no burn-rate alerting rule discovered via MCP"
```

The adapter promotes artifacts with matching `mcp.verified.<symbol>` keys to
`Verified`, and projects `mcp.scaffold.<symbol>` keys (the live-side
counterpart of `crawler.scaffold.<symbol>`) as `Scaffold` — a schema-forced
placeholder the MCP did not attest, parked by the grade rather than counted.
The Diagnostic Grade uses these annotations to decide whether a fresh live
signal exists.

### Annotation reference

Every key the fetcher writes, by family. Comma lists are capped at 64 names;
JSON arrays (`annotationJson`) at 200 entries; error strings at 200 chars.

| Key | Value | Meaning |
|---|---|---|
| `mcp.refreshedAt`, `mcp.url` | ISO time, URL | when and from where the pack was fetched |
| `mcp.toolsCalled`, `mcp.toolsFailed` | comma list | core tools (`system_health`, …) called / errored |
| `mcp.toolsExposed`, `mcp.toolsExposedCount`, `mcp.toolsUnmatched` | comma list, count | the `tools/list` inventory, and advertised tools with no probe pattern |
| `mcp.probesAttempted` / `Succeeded` / `Empty` / `Failed` / `Unsupported` | comma list of probe families | outcome per family: answered with data / answered empty / every candidate errored / no candidate advertised by `tools/list` |
| `mcp.probeErrors.<family>` | string | last erroring candidate's message, written only for a family whose outcome is `failed` (a family whose later candidate answered carries none — it is in `probesSucceeded`) |
| `mcp.verified.<symbol>` | `refreshedAt` | the adapter projects the artefact as `Verified`; indexed for per-entry lists (`queries.recording_rules[<i>]`, `policy.burn_rate_alerts[<i>]`), per id for dashboards (`dashboards.<id>`, beside the aggregate `dashboards`) |
| `mcp.scaffold.<symbol>` | note string (same convention as `crawler.scaffold.*`) | schema-forced placeholder no tool attested; projects as `Scaffold` |
| `mcp.discovered.<family>` | count | array length of a probe's adapted result, `"0"` when it answered empty |
| `mcp.discovered.scrape_jobs` / `scrape_jobs_down` | comma list of job names | jobs with at least one target up (or of unknown health) / jobs whose every target is down |
| `mcp.discovered.recording_rules_unhealthy` / `alert_rules_unhealthy` | comma list of rule names | rules whose reported `health` is not `ok` |
| `mcp.discovered.alert_rule_names` | comma list | every alerting rule name the MCP exposed |
| `mcp.discovered.alert_rules_unmapped` / `alert_rules_severity_inferred` | comma list | burn-rate groups the schema cannot represent / rules whose severity came from the burn factor |
| `mcp.discovered.metric_names`, `_count`, `_sample` | JSON, count, comma list | the metric inventory |
| `mcp.discovered.dashboard_panels`, `dashboard_raw_json`, `dashboard_detail_errors` | counts, comma list | dashboard body capture |
| `mcp.discovered.alerts_firing.*`, `recording_rules_via_inventory.*` | counts, names, source | `ALERTS` series and rule names recovered from the metric inventory |
| `mcp.discovered.extended_surfaces`, `extended_surface_refs` | count, comma list | level-2 evidence surfaces |
| `mcp.observed.scrape_targets` | JSON `[{job, instance, health, lastScrape, lastError}]` | every scrape target's on-wire health |
| `mcp.observed.recording_rules` | JSON `[{name, health, lastError, lastEvaluation, evaluationTime}]` | every recording rule's evaluation state |
| `mcp.observed.alert_rules` | JSON `[{name, state, health, lastError, lastEvaluation, activeAt}]` | every alerting rule's evaluation state |
| `mcp.servicesDiscovered`, `mcp.activeAnomalies`, `mcp.baselinesComputed` | comma list, counts | `system_health` / anomaly tools answered (not a measurement of anything in `spec.baselines`) |
| `mcp.capabilities.*`, `mcp.versions.<product>[.*]` | strings | `backend_capabilities` inventory and observed product versions |
| `mcp.stack.status` | `sampled` \| `not-attempted` | the stack self-metrics panel (step 2, "Stack self-metrics (sampling)"): whether it was sampled at all — signals, never verdicts; written whenever the fetcher ran the step-2 sampler (a caller that predates step 2 writes nothing) |
| `mcp.stack.reason` | string | only when `not-attempted`: why (`metrics_query not exposed by this MCP (restricted tier)`) |
| `mcp.stack.sampled` / `empty` / `failed` / `notInInventory` / `notAttempted` | counts (strings) | rows per outcome (`data` rows are `sampled`) |
| `mcp.stack.families` | comma list of `<family>:<best outcome>` | best outcome per family, `data > empty > failed > not-in-inventory > not-attempted` |
| `mcp.observed.stack_metrics` | JSON `[{id, family, product, expr, value, unit, direction, at, outcome, reason?}]` | attempted and `not-in-inventory` rows (cap 64); `not-attempted` rows are counted, not listed |
| `mcp.observed.alertmanager` | JSON `{version, uptime, clusterStatus, silences, error?}` | written when `alertmanager_status` / `alertmanager_silences` was ADVERTISED; `error` carries the trimmed failure of an advertised tool that did not answer — a failure, not a tier limit |
| `mcp.observed.grafana.datasources`, `mcp.observed.grafana.contact_points` | JSON `[{uid, name, type, health: ok\|error\|unknown, message}]`, `{count, names}` | `unknown` health means NOT CHECKED (health tool not exposed / errored / beyond the 10-uid cap), never "not unhealthy" |
| `mcp.observed.grafana.error` | string | the trimmed failure of an advertised Grafana status tool that did not answer |
| `mcp.observed.alertmanager` | JSON `{version, uptime, clusterStatus, silences: {active, total} \| null}` | Alertmanager status surface (`alertmanager_status` + `alertmanager_silences`) |
| `mcp.observed.grafana.datasources` | JSON `[{uid, name, type, health, message}]` | Grafana datasources with their health (`ok` \| `error` \| `unknown`, message trimmed to 200 chars) |
| `mcp.observed.grafana.contact_points` | JSON `{count, names}` | Grafana contact points (names capped at 32) |

### What the fetcher invents, and how it says so

The pack schema forces sections no MCP tool can attest. Every such entry the
fetcher has to invent is stamped `mcp.scaffold.<symbol>` (the symbol is the
one the adapter passes to `sourceOf`) and never `mcp.verified.<symbol>`:

| Placeholder | Symbol | Becomes `Verified` when |
|---|---|---|
| `spec.otel` (semconv, SDK languages, sampling, propagators) | `otel` | never — only `otel.metrics` is stamped, from the metric inventory |
| Collector receiver / processors | `pipelines.receivers[0]`, `pipelines.processors[<i>]` | never |
| Logs / traces exporters | `pipelines.exporters.logs`, `pipelines.exporters.traces` | never |
| Metrics exporter | `pipelines.exporters.metrics` | scrape targets or a metric inventory came back |
| Fallback backends (no `backend_capabilities`) | `telemetry.backends.metrics-prom` / `logs-elastic` / `traces-jaeger` | a `*_build_info` capture for prometheus/victoriametrics/mimir; the topology names jaeger or `traces_services` answered; never for elasticsearch |
| Per-service availability SLI/SLO guesses, `platform_availability` | `slis.<id>`, `slos.<id>` | never as guesses — SLIs inferred from real recorded rules are `Verified` (unless a feeding rule is unhealthy); an SLO bound by a discovered burn-rate group — exact id or re-identified — drops its scaffold marker and is `Verified` unless that group is fed by an unhealthy rule (then `Declared`) |
| Dashboard stub | `dashboards.platform-overview` | never (discovered dashboards replace it, each stamped `dashboards.<id>`) |
| SEV1 → Teams route | `alerting.routes[0]` | never |
| Baselines | `baselines` | never |
| Burn-rate placeholder | `policy.burn_rate_alerts[0]` | never (mapped rules replace it) |

`spec.baselines` is always the platform default for the declared criticality
(`measurement_source: platform-default`). Earlier builds derived
`mttd_target_p50` from the smallest `anomalies_baselines` `thresholdMs` — a
latency-anomaly threshold is not a time-to-detect target, so that derivation is
gone. `mcp.baselinesComputed` still counts the anomaly baselines the tool
returned: it is evidence the tool answered, **not** an MTTD measurement.

Known limitation: SLOs inferred from recorded rules carry a placeholder
objective (`0.99`) and window (`30d`) unless a discovered burn-rate group
binds them (exact id or re-identification, which also applies the rule's
`slo_objective` / `slo_window` evidence); the SLI is `Verified` (the recorded
series exist and evaluate), the SLO stays `Declared` — the rule evidences the
measurement, the objective is a guess until a burn-rate rule names it.

### On-wire liveness: scrape targets and rule health

Existing is not the same as working. The probes keep what the MCP reports
about whether each artefact is currently doing its job, and the fetcher
withholds `Verified` where it is not:

| Signal | Annotation | Effect on evidence |
|---|---|---|
| Every scrape target's `job`, `instance`, `health`, `lastScrape`, `lastError` (trimmed to 200 chars; at most 200 entries) | `mcp.observed.scrape_targets` (JSON) | none — the record |
| Scrape jobs with at least one target `up` (or of unknown health) | `mcp.discovered.scrape_jobs` | attest `telemetry.scrape` and `pipelines.exporters.metrics` |
| Scrape jobs whose **every** target is `down` | `mcp.discovered.scrape_jobs_down` | no stamp; when no job is up the metrics exporter falls back to its scaffold marker |
| Each recording rule's `health`, `lastError`, `lastEvaluation`, `evaluationTime` (at most 200) | `mcp.observed.recording_rules` (JSON) | none — the record |
| Recording rules whose reported `health` is not `ok` | `mcp.discovered.recording_rules_unhealthy` | no `mcp.verified.queries.recording_rules[<i>]` stamp for that index (the rule still lands in `spec.queries`, projected `Declared`); the group stamp `mcp.verified.queries.recording_rules` is kept only when at least one rule is healthy or carries no health |
| Each alerting rule's `state`, `health`, `lastError`, `lastEvaluation`, `activeAt` (at most 200) | `mcp.observed.alert_rules` (JSON) | none — the record |
| Alerting rules whose reported `health` is not `ok` | `mcp.discovered.alert_rules_unhealthy` | a burn-rate group fed by such a rule still maps but earns no `mcp.verified.policy.burn_rate_alerts[<i>]` stamp (projected `Declared`), and the SLO it bound is not stamped either; the requirement chain lists the rule with `verified: false` / `health: err` and does not let it close `missing_alert_evidence` |
| SLIs inferred from recorded rules of which at least one is unhealthy | `mcp.discovered.slis_unhealthy` | no `mcp.verified.slis.<id>` stamp (projected `Declared`) — an SLI whose total/ratio series are not being produced is not measuring anything |

Health the ruler did not report reads `null` in the observed arrays and is
**not** treated as unhealthy — only an explicit non-`ok` health withholds a
stamp. Older probe results that carried only job names still count as
(health-less) scrape evidence. The draft summary in the studio lists
`N scrape jobs down: …` and `N rules unhealthy: …` when either is non-empty.

Rule health is keyed by rule NAME with any-unhealthy-wins semantics: when the
ruler reports the same name from two groups (one evaluating, one failing) the
rule is unhealthy, so neither spec entry is stamped and the SLI inferred from
it stays `Declared`.

### Burn-rate alerts are mapped, never synthesised

`spec.policy.burn_rate_alerts` is built only from the alerting rules the MCP
actually exposes. Rules emitted by the Observogram compiler carry the
`slo`, `burn_rate`, `window_short`, `window_long` and `severity` labels; any
other rule is recognised by the compiler's `<slo>_burn_<N>x_<short>_<long>`
name. Rules are grouped per SLO (identical windows deduplicated, short window
first) and each emitted entry is stamped `mcp.verified.policy.burn_rate_alerts[<i>]`.

- Groups are resolved in two passes. A group whose id exactly matches an
  inferred SLO binds it first and claims it. Only then does a group that
  merely shares an SLI base (inferred `svc_checkout_availability_99` vs.
  discovered `svc_checkout_availability_99_9`) re-identify a still-unclaimed
  placeholder to the discovered id — so with tiered SLOs on one SLI (`_99`
  and `_99_9`) the exact group keeps its SLO and the other is reported
  unmapped, never a dangling `slo` ref. Both paths replace the placeholder
  objective/window from the rule's `slo_objective` (`99.900%` → `0.999`) and
  `slo_window` annotations, drop the SLO's scaffold marker and stamp
  `mcp.verified.slos.<id>` — unless the group is fed by an unhealthy rule.
  A re-id is refused (group unmapped) when the discovered id is not a valid
  schema Slug (`^[a-z][a-z0-9_-]*[a-z0-9]$`, at most 64 chars).
- Forecast rules (`labels.kind=forecast`) and plain threshold alerts are not
  burn-rate alerts; their names still surface in `mcp.discovered.alert_rule_names`.
- A burn group for an SLO nobody inferred, or one with a single window (the
  schema requires two), is not representable and is listed in
  `mcp.discovered.alert_rules_unmapped` instead of being padded.
- A rule with no recognisable severity gets one from its burn factor
  (`>= 10x` SEV1, `>= 5x` SEV2, else SEV3) and is listed in
  `mcp.discovered.alert_rules_severity_inferred`.
- When nothing maps, the schema still forces one entry: a two-window
  placeholder on the first SLO, stamped `mcp.scaffold.policy.burn_rate_alerts[0]`
  and never `Verified`.

Dashboard search alone is not enough for diagnostic drift. The fetcher uses
`grafana_dashboards_search` to find dashboard UIDs, then calls
`grafana_dashboard_get` for each UID so Observogram captures panels, variables,
targets, and sanitized dashboard JSON.

### Journeys read the vantage, and can gate on it

A saved journey (`tools/lib/journey.mjs`, `packc journey run`) whose Pack B is
an `mcp:` source reads the annotations above into its run record:

| Record field | Source annotations |
|---|---|
| `probes.attempted / succeeded / empty / failed / unsupported` | `mcp.probesAttempted`, `mcp.probesSucceeded`, `mcp.probesEmpty`, `mcp.probesFailed`, `mcp.probesUnsupported` (family names) |
| `probeErrors.<family>` | `mcp.probeErrors.<family>` |
| `vantage` | derived — `full` / `partial` / `restricted` / `lost` / `none` (same rule as `partialLiveEvidence`) |
| `toolsExposedCount` | `mcp.toolsExposedCount` (`null` when absent) |
| `scrapeJobsDown` | count of `mcp.discovered.scrape_jobs_down` |
| `unhealthyRules` | count of `mcp.discovered.recording_rules_unhealthy` + `mcp.discovered.alert_rules_unhealthy` |

A file-sourced Pack B carries none of these: the lists are empty, the counts
`0`, the vantage `none` — absence of evidence is reported as absence.

Two gate keys act on them:

```yaml
gate:
  failOnPartialEvidence: true   # breach when any probe family FAILED (a hole of unknown size),
                                # or when the vantage is entirely lost; EMPTY and UNSUPPORTED
                                # families never breach on their own
  maxUnhealthy: 0               # breach when scrapeJobsDown + unhealthyRules exceeds N
```

When the fetch itself fails (endpoint unreachable, core tools unavailable) the
journey writes a run record with `outcome: vantage-lost` and the error before
rethrowing — the CLI still exits `2`, the studio still answers 502 — so a total
loss of the observation point shows in the drift history instead of leaving a
gap. Configuration errors (missing pack file, unset `authEnv`) never reach the
wire and leave no record.

The journey grades on the same construct as the studio: the requirement-chain
comparison (`comparePackBranches`) is attached to the diff as
`traceabilityGraph` before `computeDiagnosticGrade`, and the record's
`grade.driftConstruct` says which construct scored Drift-free
(`requirement-chain` when declared commitments exist, else `diff-buckets`).

#### Run-history retention

Every run appends one JSON record under `runs/<journey>/` in the workspace;
the filename is the ISO start time, so lexical order is chronological order.
Continuity is the goal (a cron cadence of minutes is the intended use), so
the directory is bounded: after each write `writeRunRecord` prunes it to the
newest `OBSERVOGRAM_JOURNEY_RUN_RETENTION` files (`brandEnv`, legacy
`TOMOGRAPH_*` spelling honoured; default `1000`; `0` = unlimited; anything
that is not a non-negative integer falls back to the default). The policy is
the pure `pruneRunFiles(files, keep)` (returns the names to delete, oldest
first; only names of the run-record shape `JOURNEY_RUN_FILE_RE` —
`<ISO start time with : and . as ->.json` — are candidates or counted, so a
hand-dropped `notes.json` neither displaces a record nor is deleted) and the knob is read at
write time by `journeyRunRetention()`. A file that cannot be deleted is
recorded on the run as `historyError`, never thrown — the verdict already
exists. `readJourneyRuns(name, { limit })` is unchanged: newest first, at
most `limit` parsed.

#### Stack-health evidence on the run record (`stackEvidence`)

Next to the step-2 `stack` counts, each record keeps the samples the run saw
so the history is the time series (step 3). `stackEvidence` is `null` when
Pack B carries no `mcp.stack.status` (file-sourced, or a pre-step-2
refresh) — never an empty "healthy" panel — and otherwise:

| Field | Source | Notes |
|---|---|---|
| `status`, `reason` | `mcp.stack.status`, `mcp.stack.reason` | `not-attempted` keeps its reason (a restricted tier reads not-attempted, never absent) |
| `rows[]` | `mcp.observed.stack_metrics` (cap 64) | `{ id, family, product, value, unit, direction, outcome, hint, at, referenceSli, reason? }` — `expr` is dropped; `hint` is the contracts' display-only `displayHint` and `referenceSli` the table's reference-pack SLI, both looked up by `id` in `STACK_SELF_METRIC_PROBES`; a row the table no longer declares keeps `referenceSli: null` |
| `alertmanager` | `mcp.observed.alertmanager` | `{ version, clusterStatus, silencesActive, error }` or `null` when the surface was not advertised |
| `grafana` | `mcp.observed.grafana.datasources` / `.contact_points` / `.error` | `{ datasources, unhealthyDatasources: [names], contactPoints, error }` or `null`; only a health verdict of `error` is unhealthy (`unknown` was never checked) |

Malformed JSON in any of those annotations degrades to `rows: []` /
`null` for that surface — the status survives, nothing is fabricated. A row
outcome the contracts do not declare is kept verbatim (a missing one reads
`unknown`) — never relabelled as a probe failure nothing reported; it is
still never `data`. The `stack` gate key below is the only *gate* reader
(the history helpers, `GET /api/journeys` and the studio chips read the
record too, none of them as a verdict); a sample stays a signal, and a
breach is an early warning, not a verdict.

#### Gate key `stack`: thresholds on the samples

```yaml
gate:
  stack:
    requireSampled: true          # breach unless the panel was sampled AND a row answered data
    rows:                         # per row id of STACK_SELF_METRIC_PROBES (case-sensitive)
      scrape_success_ratio: { min: 0.9 }
      scrape_targets_down: { max: 0 }
      tsdb_active_series: { max: 2000000 }   # an `info` row may carry a threshold too
```

`loadJourneyDef` validates the block (`validateGateStack(stack, name)`):
an unknown row id throws `journey <name>: gate.stack.rows names unknown row
<id>; known rows: …`, `min` / `max` must be finite numbers when present, an
entry with neither is refused (nothing to check), `min > max` is refused,
and `requireSampled` must be a boolean. `POST /api/journeys/capture` runs
the same validation on a captured gate before saving (400 with the message),
so a capture never creates a journey that cannot load; a definition on disk
that fails to load is still listed by `GET /api/journeys` with `loadError`
(and by `packc journey list` as `definition does not load: …`) rather than
looking like a healthy never-run journey. The studio's capture default gate
stays `{ minAlignmentPct: 85 }`; the block is opt-in and every existing key
is unchanged.

`evaluateGate` reads `facts.stackEvidence` and breaches with the criteria
`stack` and `stack.<id>`:

| Condition | Criterion | Detail |
|---|---|---|
| `requireSampled` and `stackEvidence` is `null` (file-sourced B) | `stack` | `stack self-metrics not sampled (Pack B is not a live draft) — the vantage cannot prove stack health` |
| `requireSampled` and `status` is `not-attempted` | `stack` | `stack self-metrics not sampled (<reason>) — the vantage cannot prove stack health` |
| `requireSampled` and no row has outcome `data` | `stack` | `stack self-metrics not sampled (sampled, but no row answered with data) — …` |
| `rows.<id>` and the entry is not a finite band (a bound that is not a finite number, neither bound, `min > max`, not a mapping) — a gate object composed without `loadJourneyDef` | `stack.<id>` | `threshold invalid (<why>) — cannot be checked` |
| `rows.<id>` and the row's outcome is not `data` (or `data` with no number) | `stack.<id>` | `no sample for <id> (<outcome>[: reason]) — threshold cannot be checked` |
| `rows.<id>` and the row is absent from the record | `stack.<id>` | `no sample for <id> (no stack evidence)` for a file-sourced B; `no sample for <id> (not-attempted: <reason>)` on a not-attempted panel (the tier reason, so the breach reads as a tier limit, not a fetch hole); `no sample for <id> (not attempted by the sampler — call budget exhausted or row not observed)` on a sampled panel |
| `rows.<id>` and `value < min` or `value > max` | `stack.<id>` | `<id> = <value> <unit> outside [min … max] — point-in-time sample, not an SLO verdict`; when display rounding prints the value equal to the bound it broke (`0.0004/s` against `max: 0`) the raw number follows: `<id> = 0.000/s (raw 0.0004) per-second outside [-∞ … 0.000/s]` |

Honesty rules: thresholds compare numbers only and equality passes
(`< min` / `> max`); a file-sourced Pack B never breaches `stack.rows` unless
a threshold is declared — then it breaches with `no sample (no stack
evidence)` instead of passing by absence; nothing here touches the grade or
creates a `Verified` stamp. Values print through the pure
`formatStackValue(value, unit)` (`ratio` → `83.3%`, `per-second` →
`0.004/s`, `per-hour` → `0.0/h`, `seconds` → `7.4s`, `count` → `1`; a
non-number prints `—`), bounds in the same unit.

Surfaces: `renderJourneyMarkdown` adds a `Stack self-metrics — point-in-time
samples` table (`id | family | value unit | outcome | hint | reference SLI`,
capped at 24 rows, only when the run has rows) and lists stack breaches
with the others; `packc journey list` appends `stackStatusLine(record)` —
`stack sampled N` (rows that answered data), `stack not attempted`, or
`stack none` — to each line.

#### History helpers: the run history as a time series

`tools/lib/stack-evidence.mjs` is the browser-safe reader of that history
(pure functions, imports only the contracts table; the studio loads it
from `/lib/stack-evidence.mjs`, the server and a vendoring studio import
it directly — see `docs/VENDORING.md`):

| Helper | Returns | Honesty rule |
|---|---|---|
| `stackSeries(runs, rowId)` | oldest → newest `[{ at, value, outcome, hint }]` for one row (`runs` may be newest-first as `readJourneyRuns` returns them; sorted by `startedAt`) | a run without `stackEvidence` or without that row is a gap and is skipped, never interpolated; a non-data outcome is kept with `value: null` so the series shows when the probe stopped answering |
| `latestByFamily(record)` | `{ <family>: { id, value, unit, direction, outcome, hint, referenceSli, reason? } }` | per family the row that answered `data` (with a number) wins; among data rows the early-warning signal surfaces first — a `nonzero` hint, then a row the table declares before a retired one, then `lower` before `higher` / `info` — and the contracts table order breaks the rest, so a leading `higher` / `info` row (`scrape_success_ratio`, `tsdb_active_series`) never hides a lower-is-better row that carries signal; among non-answers the table order decides; `{}` without evidence |
| `stackSummary(record)` | `{ status, reason, sampled, families }` or `null` | `null` when the record has no `stackEvidence` — an absence, never a healthy stack; `sampled` counts rows that answered data |
| `nonzeroRuns(series)` | count of data samples with the display hint `nonzero` | a count of runs, not a verdict — "nonzero in N of the last M runs" is an early-warning phrase |
| `stackPostureBudget(series, { objective, cadenceMs, windowMs, isBad? })` | `{ samples, bad, fraction, allowance, measurable, note }` | the cadence heuristic: the window allows `(1 − objective) × window / cadence` bad samples and a sampled posture is only `measurable` when that allowance is ≥ 10 (99.99 % over 30 d at a 15 min cadence allows 0.29 — not measurable; 99 % over 7 d at 5 min allows 20.16 — measurable); `fraction = good / samples`, `null` with no data sample; the note says "signal, not verdict" in every branch |
| `formatStackValue(value, unit)`, `stackOutcomeLabel(outcome)` | the shared display vocabulary (`83.3%`, `0.004/s`, `0.0/h`, `7.4s`, `1`, `—`; `empty` / `probe failed` / `not in inventory` / `not attempted`) | one formatter for the CLI, the report and the studio |

Surfaces: `GET /api/journeys` puts `stackSummary(lastRun)` on
`lastRun.stack` (`null` for a file-sourced B); the studio's Journeys view
renders a `stack self-metrics — point-in-time samples` line under each
card — one chip per family (value in its unit, or the honest non-answer),
the `nonzero` hint as a muted marker, the row id and reference SLI in the
chip's title, and for lower-is-comfortable rows `nonzero in N of last M
runs` over the 20 fetched runs; a `not-attempted` panel is one muted chip
with the reason; a `sampled` panel where no row answered is one muted
`sampled, but no row answered` chip. No chip carries an ok/error colour: a
sample is a signal, and the runs table lists `stack` / `stack.<id>`
breaches like any other. The families are always taken from the newest
fetched run — an older run's evidence never stands in for a last run that
carried none (vantage lost, file-sourced B), so a file-vs-file journey
renders no stack line at all. The view loads the helper module at call
time from the server's `/lib` mount; a host that does not mount
`tools/lib` at `/lib` still renders the chips from `lastRun.stack`
(families only: no `nonzero in N of last M runs` history, and values print
as raw numbers — a ratio reads `0.95`, not `95.0%` — because the formatter
lives in the helper module). A card whose definition fails to load shows
`definition does not load: <loadError>` under its meta line.

### Stack self-metrics (registry)

`tools/lib/contracts/stack-self-metrics.mjs` is the data-only alias table the
step-2 sampler reads to acquire the observability stack's *own* health
signals through `metrics_query`: 24 rows across nine families (`scrape`,
`ruler`, `notify`, `tsdb`, `collector`, `dashboards`, `synthetic`, `logs`,
`traces`), each with a plain-English `signal`, a `unit`, a display-only
`direction`, an optional `referenceSli` naming the reference-pack SLI whose
vocabulary it follows (`prometheus-reference/scrape_success_ratio`, …), an
ordered list of product `aliases` (`{ product, expr, requires, verified }` —
an alias is eligible only when every name in `requires` is in the metric
inventory; `verified` is the pinned product image whose real exposition
carried every required name and whose PromQL evaluated the `expr`, as
`<image:tag> <exposition|TSDB inventory|probe output> + PromQL, <date>`),
and a `source` naming the upstream documentation the metric names come from
plus the live evidence that confirmed them. The registry rows
`stack_self_metrics`, `alertmanager_status`, `alertmanager_silences`,
`grafana_datasources`, `grafana_datasource_health` and
`grafana_contact_points` carry the tool names; the response shapes
`instant-vector`, `status-object`, `silences`, `datasources`,
`health-object` and `contact-points` pin the critical fields against the
fixtures in `tools/fixtures/mcp/` — recordings from the Krystaline tiers
(public, and since 2026-09-08 the authenticated tier) where a tier answers,
hand-written `synthetic/` files where none can (see that directory's
README). Every sampled number is a
point-in-time **signal, never a verdict**: nothing in this table creates a
`Verified` stamp, an SLO verdict or a grade change, and on a restricted tier
the answer is "not attempted" with the reason.

Three known discrepancies, documented rather than fixed (the reference packs
are out of scope): (1) the reference pack's `scrape_duration_p99` is written
over `scrape_duration_seconds_bucket`, but Prometheus exposes
`scrape_duration_seconds` as a per-target gauge with no histogram, so the
row `scrape_duration_max` samples `max(scrape_duration_seconds)` and points
at the reference SLI for vocabulary only; (2) the reference pack's
`query_latency_p99` is written over
`prometheus_engine_query_duration_seconds_bucket`, but Prometheus registers
`prometheus_engine_query_duration_seconds` as a **summary** (objectives 0.5 /
0.9 / 0.99, labels `slice` / `quantile`) with no `_bucket` series, so the
row `query_latency_p99` reads
`max(prometheus_engine_query_duration_seconds{slice="inner_eval",quantile="0.99"})`;
(3) the reference pack's `datasource_proxy_success_ratio` is written over
`grafana_datasource_request_total`, which Grafana 12.4.4 registers only on
the first datasource request — but that request is any rule evaluation, any
`/api/ds/query` (the path dashboards and Grafana-managed rules use) or any
legacy proxied query, so every Grafana with one dashboard or one rule has
it. The row `datasource_errors` reads the reference name
`grafana_datasource_request_total{code=~"5.."}` **first** (strict
`requires`) and keeps the pre-registered `grafana_proxy_response_status_total`
(present at startup with `code="500"` at 0) as the **fallback** for a
Grafana whose inventory lacks the reference name, because the proxy counter
observes only the legacy `/api/datasources/proxy/...` path: on 12.4.4 an
`/api/ds/query` increments `grafana_datasource_request_total` and leaves
every proxy counter untouched, and the sampler stops at the first alias
with data — the other order would read a systematically blind 0 on a
Grafana whose queries fail through `/api/ds/query`.

Rows that must read zero when healthy carry a **presence-guarded zero** —
`count(up == 0) or (count(up) * 0)` for the count rows
(`scrape_targets_down`, `synthetic_probe_failures`),
`sum(rate(m{code=~"5.."}[5m])) or (count(m) * 0)` for the Grafana 5xx rate
rows — so a healthy stack reads `0` rather than an empty vector while a
backend without the metric still reads `empty` (`or vector(0)` would
fabricate "0 down" where nothing is scraped); the ratio is
`sum(up) / count(up)` for the same reason. **Lazily-registered counters**
take the same guard one step further. The OpenTelemetry Collector creates
`otelcol_exporter_send_failed_<kind>` and `otelcol_receiver_refused_<kind>`
only when the first export / receive happens (0.115.1, observed
before/after a forced failure: registered together with `sent_<kind>` /
`accepted_<kind>`; 10 metric names at startup — a stable count — and 39 the
moment the three `send_failed_*` names register after one OTLP request per
kind, with more following as the dead exporter retries: 48 families some
minutes later) or, on 0.154.0, plausibly only on the first failure
(`send_failed_spans` absent while `sent_spans` is present on the public
tier, read-only — consistent with registration on the first failure; no
failure was forced there), so strict `requires` on the counter
would read `not-in-inventory` on a healthy collector forever. Those six
aliases therefore `require` the sibling that registers with or before the
counter (`otelcol_exporter_sent_<kind>`, `otelcol_receiver_accepted_<kind>`)
and end with `or (count(<sibling>) * 0)`: a collector that has exported
reads 0 failures unless the counter exists, a collector that never exported
that signal reads `not-in-inventory` (no evidence either way), and a renamed
counter on a future collector renames the sibling too, so the alias falls to
`not-in-inventory` instead of a false 0. Every other counter the table reads
is pre-registered at 0 by its product and keeps strict `requires`:
client_golang registers `prometheus_*`, `alertmanager_*`, `promtail_*` and
`jaeger_collector_*` at startup; VictoriaMetrics' own `metrics` library
registers `vm_*` at startup and vmalert's `*_rules_errors_total` per
**loaded** rule (per-rule label sets — a rule-less vmalert exposes none,
which is an honest `not-in-inventory`: no ruler work to observe). All are
present on the pinned stack's exposition; the live suite asserts
startup-vs-stimulus only for the collector and Grafana (the two services it
recreates), the other products' startup state was observed by hand once.

Names pinned against live exposition (2026-09-07, see "Live validation
tier" below): no `_total` suffix on any otelcol internal-telemetry name
(0.115.1 and 0.154.0 alike); `otelcol_processor_dropped_*` exist on no
current collector in either spelling (removed by the processorhelper
rework), so the former `collector_dropped_*` rows are now
`collector_refused_{metrics,spans,logs}` over the receiver counters — the
current-generation "the collector is losing telemetry" signal;
`collector_queue_saturation` takes the per-exporter max on both sides
(`queue_size` carries `data_type` and `queue_capacity` does not on 0.115.1,
both do on 0.154.0); vmalert's plural `vmalert_*_rules_errors_total`;
`jaeger_collector_spans_dropped_total` on Jaeger v1's admin port (a Jaeger
v2 is an otelcol distribution and answers through the collector rows, the
jaeger alias reading an honest `not-in-inventory` there). Resolvers:
`probeRows()`, `rowsForFamily(family)`, `eligibleAliases(row, inventory)`,
`productPreferenceOrder(row, seenProducts)`, `displayHint(row, value)`,
`bestOutcome(outcomes)`; integrity is pinned by `npm run test:stack`, the
live evidence by `npm run test:stack:live`.

### Stack self-metrics (sampling)

`sampleStackSelfMetrics(...)` in `tools/fetch-live-pack.mjs` walks the alias
table once per fetch, after the version probes (so the product preference
knows what is already seen). The policy:

- **Attempt only when `metrics_query` is available.** When `tools/list`
  answered, it must advertise the tool; a server with no `tools/list` at all
  (older servers) is attempted. Otherwise the panel is `not-attempted` with
  the reason `metrics_query not exposed by this MCP (restricted tier)` — every
  row carries that outcome, zero calls are made, nothing is "absent".
- **Inventory: evidence of presence, never of absence.** When the
  `metric_names` probe answered with data, its list is the inventory: an
  alias is eligible when *every* name in its `requires` is present, and
  eligible aliases are tried first — all of them, since the inventory is
  evidence they exist (no per-row cap on that path). A row with **no**
  eligible alias is `not-in-inventory` (no call; the reason names the
  inventory size and the required names) **only when the inventory is
  trusted**: `stackInventoryTrust(inventory)` trusts a list that carries `up`
  (present on every Prometheus-compatible backend). The `metric_names` tool
  has no completeness contract (no `limit`, no truncation marker; the
  recorded reference fixture is a 25-name subset without `up`), so an
  inventory without `up` — or an empty one — is treated as incomplete and
  gates nothing: those rows fall back to the bounded cascade and read
  `empty` / `failed` / `data` honestly, with `queried anyway` and the
  inventory size in the reason of an empty answer. Without an inventory at
  all (probe failed / empty / unsupported) every alias is eligible on the
  bounded cascade. The sampler result carries `inventory: { size, trusted,
  reason }` (not annotated) and the recorder prints the same verdict.
- **Product preference.** A row's eligible aliases are ordered `generic`
  first, then products already seen in `liveVersions` (build_info,
  `grafana_health`, `traces_services`) or in the `backend_capabilities`
  inventory, then the rest in declared order.
- **Bounded cascade.** Without a trusted inventory at most 2 calls per row,
  stopping at the first alias that returns data; an `empty` or `failed`
  answer falls through to the next alias and the last outcome is recorded.
- **Global budget.** 48 `metrics_query` calls per panel; rows beyond it are
  `not-attempted` with the reason `call budget exhausted`.
- **Every call goes through `quiet()`** under the family name
  `stack_self_metrics` (so `probeFailures.stack_self_metrics` keeps the first
  error); each row keeps its own last error as `reason`.
- **Parsing.** An instant vector in either envelope (`{ result }` or
  `{ data: { result } }`); the value is `Number(result[0].value[1])`. An empty
  array, a series without a sample, or `NaN` / `+Inf` / `-Inf` is `empty`
  (value `null`) — for every unit: a series-only answer is never counted as
  a value, because every `count` row is an aggregation returning one series
  and "1" would be a fabricated number; a non-vector answer is `failed` with
  the shape reason. The count rows' presence-guarded zero (registry section
  above) is what lets a healthy stack read `0` instead of `empty`.
- **Outcomes** are exactly `data | empty | failed | not-in-inventory |
  not-attempted` — a row is never "ok". No `Verified` stamp, no `Scaffold`
  marker, no grade input is produced by any of it; `displayHint(row, value)`
  (`nonzero` for a lower-is-better row above zero) is a display helper the
  server may compute, never something the pack stores.

The Alertmanager and Grafana status rows ride the same fetch
(`observeAlertmanager`, `observeGrafana`), each tool guarded by the
`tools/list` inventory when one exists and called through `quiet()`:
`alertmanager_status` → `{ version, uptime, clusterStatus }`;
`alertmanager_silences` → `{ active, total }`; `grafana_datasources` →
`[{ uid, name, type }]` then `grafana_datasource_health` per uid (at most 10,
called with `{ uid }`) → `health: ok | error | unknown` plus a message trimmed
to 200 chars (`unknown` means NOT CHECKED — the health tool is not
advertised, errored, or the datasource is beyond the cap — and is never
folded into "not unhealthy"); `grafana_contact_points` → a count and up to 32
names. Object payloads are located **envelope-first** (`locateObjectPayload`,
the same rule `validateResponseShape` applies): a Prometheus-API-style
`{ status: 'success', data: {...} }` wrapper is read from its inner document,
so a wrapped `{ status: 'ERROR' }` health verdict reads `error`, never `ok`.
Each observer returns `null` only when none of its tools is advertised (a
tier fact); an advertised tool that fails (HTTP error, timeout, bad shape)
yields a non-null result carrying `error` — annotated as
`mcp.observed.alertmanager.error` / `mcp.observed.grafana.error` — so the
surfaces say "probe failed", never "not exposed". Tools that answered join
`mcp.toolsCalled`; the sampler's tool joins only when at least one row
returned data or an honest empty. `hasToolsList` is whether the `tools/list`
RPC succeeded: a server advertising an empty list reads `not-attempted`
(tier), not a string of `tools/call` failures.

The table has three live evidence sources: the public Krystaline tier
(2026-09-07) and the authenticated Krystaline tier (2026-09-08,
`MCP_URL=https://www.krystaline.io/mcp` + `MCP_AUTH`) through this recorder,
and the pinned stack of the real products through
the live validation tier below; re-record when a product version moves.
The authenticated tier answers the same metrics / vmalert / Alertmanager
surface as the public one (14 aliases `data` · 0 `failed` on the same
2,682-name inventory) but advertises **no Grafana-backed tools** — its
otel-mcp-server deployment carries no Grafana integration — so the Grafana
status fixtures remain synthetic.
`npm run record-fixtures`
(`tools/record-mcp-fixtures.mjs`, `MCP_URL` + optional `MCP_AUTH`) is the
verification path — it reuses the fetcher's client and the registry for
every tool name, never prints or stores the token, and by default only
**reports**: the `tools/list` surface with its drift against the registry,
the metric inventory, and for every alias of every row whether its
`requires` are all in the inventory plus the value read the way the sampler
reads it (`data <value>` / `empty` / `FAILED <reason>` /
`not-in-inventory (missing …)` / `not-attempted (restricted tier)`), then the
status tools. `-- --write` records the fixtures `tools/fixtures/mcp/README.md`
prescribes (the trimmed inventory that keeps every required name, the probe
payloads, one instant vector per family under `recorded-stack/`, the status
tools) and a recorded file takes precedence over its synthetic copy in the
shapes suite; the full inventory goes to the git-ignored
`.tmp-mcp-metric-names.json`. Afterwards: `node
tools/test-contract-shapes.mjs --update`, then `npm test`.

The annotation keys the sampler writes (`mcp.stack.*`,
`mcp.observed.stack_metrics`, `mcp.observed.alertmanager`,
`mcp.observed.grafana.*`) are listed once, in the annotation reference
above; they are written only when the fetch sampled — a caller that predates
step 2 writes none of them.

### Live validation tier

`docker/stack.compose.yaml` (`name: observogram-stack`; every port bound to
127.0.0.1, every image tag pinned, the port block disjoint from the validate
stack's) runs every product the table names: Prometheus v2.55.1 scraping all
of them plus a blackbox probe job, Alertmanager v0.27.0 with a dead webhook
receiver, VictoriaMetrics v1.113.0 scraping itself and a dead target, vmalert
v1.113.0, otel-collector-contrib 0.115.1 with a `debug` exporter beside an
OTLP exporter to a dead endpoint, Grafana 12.4.4 with a provisioned
Prometheus datasource and one always-firing alert rule, blackbox-exporter
v0.25.0, promtail 3.3.2 tailing a sample file into a dead Loki, and Jaeger
all-in-one 1.62.0 — deliberate faults so every failure counter exists and
moves on a fresh stack. `npm run test:stack:live` (`tools/test-stack-live.mjs`;
`:strict` turns the no-Docker skip into a failure; **not** part of
`npm test`) brings it up, recreates the collector and Grafana so neither
carries a previous run's stimulus (the collector's "at startup" name set is
then exact; Grafana's is snapshotted the moment its recreate returns, which
is "before the suite's stimulus" — the provisioned 10s rule is Grafana's
own first datasource request, so `grafana_datasource_request_total` /
`grafana_alerting_rule_*` can already be present on a slow start; reported,
never asserted), waits for every scrape job and for the rate windows, then
for **every alias of every row** asserts: (a) every `requires`
name is a metric family on the product's own exposition — `/metrics`, the
Prometheus TSDB name inventory for the scrape-synthesised `up` /
`scrape_duration_seconds` (which never appear on Prometheus' own
`/metrics`), the blackbox `/probe` output for `probe_success`, the vmalert
service for `vmalert_*`; (b) every lazily-registered counter the `expr`
reads beyond `requires` is present **after** the stimulus (one OTLP/HTTP
request per signal kind into the collector; one query through Grafana's
legacy datasource proxy and one through `/api/ds/query`, so both counter
paths are exercised) — that is what proves the counter's name; (c) the alias's
`verified` stamp names the compose image of the product it was checked on;
(d) the `expr` evaluates on the real Prometheus with no PromQL error, the
answer read through the fetcher's own `sampleFromInstantVector`. The
collector's and Grafana's name sets before and after the stimulus are
printed (the lazy-registration probe), and the ledger — alias |
product@version | exposition | query — goes to the git-ignored
`.tmp-stack-live-ledger.json`. The stack is left running (`docker compose
-f docker/stack.compose.yaml down -v` removes it); run one suite at a time —
two concurrent runs recreate the collector and Grafana under each other.
Note that `otel/opentelemetry-collector-contrib:0.115.1` self-reports
`service_version="0.115.0"` in `target_info` and on every `otelcol_*`
series; the `verified` stamps and the ledger's product@version use the
image tag.

Verification ledger, 2026-09-07 — 32 aliases: 32 ✓ exposition (lazy
counters included), 32 stamps matching their image, 32 `data` / 0 `empty` /
0 PromQL errors:

| product @ version | aliases verified |
|---|---|
| Prometheus `prom/prometheus:v2.55.1` | `scrape_success_ratio`, `scrape_targets_down` [generic], `scrape_duration_max` (TSDB inventory); `rule_evaluation_failures` [prometheus], `rule_evaluation_staleness`, `notification_errors` [prometheus], `notifications_sent` [prometheus], `tsdb_active_series` [prometheus], `tsdb_compaction_failures`, `wal_corruptions`, `query_latency_p99` |
| VictoriaMetrics `victoriametrics/victoria-metrics:v1.113.0` | `scrape_targets_down` [victoriametrics], `tsdb_active_series` [victoriametrics] |
| vmalert `victoriametrics/vmalert:v1.113.0` | `rule_evaluation_failures` [victoriametrics], `notification_errors` [victoriametrics] |
| Alertmanager `prom/alertmanager:v0.27.0` | `notification_errors` [alertmanager], `notifications_sent` [alertmanager], `active_silences` |
| OpenTelemetry Collector `otel/opentelemetry-collector-contrib:0.115.1` | `collector_export_failures_{metrics,spans,logs}`, `collector_refused_{metrics,spans,logs}` (six lazy counters, present after the stimulus), `collector_queue_saturation` |
| Grafana `grafana/grafana:12.4.4` | `rule_evaluation_failures` [grafana], `datasource_errors` (both aliases: the reference `grafana_datasource_request_total` first, the proxy-only counter as fallback), `grafana_http_errors` |
| blackbox-exporter `prom/blackbox-exporter:v0.25.0` | `synthetic_probe_failures` (probe output) |
| promtail `grafana/promtail:3.3.2` | `log_shipper_drops` |
| Jaeger `jaegertracing/all-in-one:1.62.0` | `trace_collector_drops` |

The public Krystaline tier (read-only:
`MCP_URL=https://www.krystaline.io/mcp/public npm run record-fixtures`) is
the second evidence source, at other versions (otel-collector 0.154.0,
Jaeger v2.18.0, Grafana 12.4.0, Alertmanager 0.27.0): after the correction it
reads 14 aliases `data` · 0 `empty` · 0 `failed` · 18 honest
`not-in-inventory` on its 2,682-name inventory (no Prometheus server, no
blackbox, vmalert not scraped, a traces-only collector, a v2 Jaeger), 13 of 24
rows with data. The authenticated tier (2026-09-08, `MCP_AUTH` bearer) is the
third: the same backends and the same alias outcomes, recorded into
`vmalert_rules.json`, `alertmanager_status.json` and `recorded-stack/`.

### Stack self-metrics (surfaces)

The same annotations are read back, never re-sampled, on three surfaces:

- `POST /api/draft-from-mcp` — `summary.stack = { status, reason, sampled, empty, failed, notInInventory, notAttempted, families: { <family>: <best outcome> }, rows: [{ id, family, product, value, unit, direction, outcome, hint, reason? }] }` parsed from `mcp.stack.*` and `mcp.observed.stack_metrics`; `hint` is the contracts' display-only `displayHint` (`'nonzero'` when a lower-is-comfortable row is above zero, else `null`) and is computed here, never stored. `summary.alertmanager = { version, uptime, clusterStatus, silences, error }` and `summary.grafana = { datasources, healthChecked, contactPoints, error }` come from the `mcp.observed.*` JSON; each is `null` only when the surface was not advertised (or the fetcher predates step 2) — an advertised tool that failed keeps the summary with `error` set, and the server adds a `… status probe failed — <error>` warning. `healthChecked` counts the datasources that actually got a verdict; `health: 'unknown'` stays visible as "not checked". A `not-attempted` panel adds the warning `Stack self-metrics not attempted — metrics_query not exposed by this MCP tier.` (or `— <reason>.` for any other reason).
- `GET /api/live-status` — `stackStatus` (`sampled` | `not-attempted` | `null`) and `stackSampled` (number).
- The studio draft summary renders a "stack self-metrics — point-in-time sample, signal not verdict" block under the discovery rows: one row per family in `families` showing the family's best row (ratios as a percent, per-second to three decimals, seconds to one, counts as integers, `· nonzero` when hinted) or its outcome (`— empty`, `— probe failed: …`, `— not in inventory`; a family with no observed row reads `— not attempted: call budget exhausted`), a single `— not attempted: <summary.stack.reason>` row on a not-attempted panel, then `alertmanager: v<version> · N active silences` (`— probe failed: <error>` when advertised but failing), `datasources: N · M error: <names> · K unchecked: <names>` — or `N · health not checked (grafana_datasource_health not exposed or did not answer)` when no datasource got a verdict; `0 unhealthy`-style wording is never printed for a surface nothing checked — and `contact points: N`. `— not exposed` is reserved for a surface the MCP did not advertise.
- Journeys — `liveEvidenceFacts(canonicalB).stack = { status, reason, sampled, empty, failed, notAttempted }` (status `null` and zero counts for a file-sourced Pack B) rides on the run record as `stack` and prints one `Stack self-metrics` line in the markdown report; since step 3 the record also keeps the samples themselves as `stackEvidence` (see "Stack-health evidence on the run record" above), the report prints them as a table, and the opt-in `gate.stack` block (`requireSampled`, per-row `min` / `max`) breaches on them as an early warning — the counts are never gated on, and no breach is an SLO verdict.

## Diagnostic Drift Semantics

When Pack B is live-like, Diagnose treats the comparison as declared vs live:

| Bucket | Meaning |
|---|---|
| Aligned | Same artifact identity and same behavior. |
| Drifted | Same identity, different behavior. |
| Declared, not live | Pack A declares it, but Pack B did not confirm it. |
| Live, not declared | Production has it, but Pack A does not declare it. |
| Out of scope | Live platform inventory from families Pack A does not participate in. |

The Diagnostic Grade passes when the total score is greater than 85%. Drift is
still rendered as evidence and usually becomes the Remediate plan.

## Write Path: Deploy Through MCP

The Remediate deploy flow compiles selected pack artifacts and sends them to an
MCP write target. For Grafana, Observogram uses:

| Observogram artifact | MCP tool |
|---|---|
| Grafana-managed recording rules | `grafana_create_alert_rule` |
| Grafana-managed alerting rules | `grafana_create_alert_rule` |
| Grafana dashboards | `grafana_create_dashboard` |

Prometheus, Alertmanager, and OTel Collector compile outputs remain available
for download even when no write tool is configured.

## Required Server Configuration For Writes

Writes are intentionally explicit. The Grafana token belongs on the MCP server,
not in the browser.

```bash
MCP_ENABLE_WRITES=true
GRAFANA_URL=https://grafana.example.net
GRAFANA_AUTH_TOKEN=glsa_...
MCP_AUTH_KEYS='{"keys":[{"id":"observogram","key":"sk-observogram-prod"}]}'
```

The Observogram deploy modal receives the MCP client key, for example:

```text
sk-observogram-prod
```

Grafana permissions:

| Operation | Required permission |
|---|---|
| Managed rule write | `alert.provisioning:write` |
| Dashboard write | `dashboards:write` |
| Folder management | `folders:write` |

## Deploy Safety Rules

- Deploy only source-backed artifacts by default.
- Treat inferred artifacts as guidance unless the compiler materialized them
  from a source-backed contract.
- Prefer scoped deltas over full regeneration for dry runs.
- Re-run live generation after deploy and compare again.
- Never store Grafana service-account tokens in the browser or pack.

## Useful Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/draft-from-mcp` | Generate and register a live pack from MCP |
| `GET` | `/api/packs/:id/compile-catalog` | Enumerate deployable compile items |
| `GET` | `/api/packs/:id/compile-artifact` | Compile one selected artifact |
| `POST` | `/api/packs/:id/deploy-bulk` | Deploy selected artifacts |
| `POST` | `/api/packs/:id/deploy/:target` | Deploy one compiled target |

## Offline Test

```bash
npm run test:fetch
```

The test suite exercises rich and partial MCP responses, validates the emitted
pack, checks verification markers, and confirms adapter integration.
