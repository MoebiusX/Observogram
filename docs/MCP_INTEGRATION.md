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
| Baselines | MTTD/MTTR and anomaly-derived evidence when available |
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
    mcp.toolsCalled: "system_health,vmalert_rules,grafana_dashboards_search,grafana_dashboard_get,metrics_label_values,metrics_targets"
    mcp.toolsFailed: ""
    mcp.probesAttempted: "recording_rules,alert_rules,dashboards,metric_names,scrape_configs"
    mcp.probesSucceeded: "recording_rules,alert_rules,dashboards,metric_names,scrape_configs"
    mcp.probesEmpty: ""
    mcp.probesFailed: "dashboards"
    mcp.probesUnsupported: "scrape_configs"        # tools/list exposes no candidate — a restricted tier, not an outage
    mcp.probeErrors.dashboards: "HTTP 502 Bad Gateway"   # last erroring candidate of a failed family (trimmed to 200 chars)

    mcp.verified.otel.metrics: "2026-06-09T00:09:14.730Z"
    mcp.verified.telemetry.scrape: "2026-06-09T00:09:14.730Z"
    mcp.verified.pipelines.exporters.metrics: "2026-06-09T00:09:14.730Z"
    mcp.verified.queries.recording_rules: "2026-06-09T00:09:14.730Z"
    mcp.verified.slis.svc_checkout_availability: "2026-06-09T00:09:14.730Z"
    mcp.verified.dashboards: "2026-06-09T00:09:14.730Z"
    mcp.verified.policy.burn_rate_alerts[0]: "2026-06-09T00:09:14.730Z"

    mcp.verified.queries.recording_rules[0]: "2026-06-09T00:09:14.730Z"

    mcp.discovered.alert_rule_names: "svc_checkout_availability_99_9_burn_14x_5m_1h,..."
    mcp.discovered.alert_rules_unmapped: "svc_payments_latency_99"
    mcp.discovered.alert_rules_severity_inferred: ""
    mcp.discovered.scrape_jobs: "node-exporter,grafana,otel-collector"
    mcp.discovered.scrape_jobs_down: "alertmanager"
    mcp.discovered.recording_rules_unhealthy: ""
    mcp.discovered.alert_rules_unhealthy: "HighLatencyP99"
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
| Per-service availability SLI/SLO guesses, `platform_availability` | `slis.<id>`, `slos.<id>` | never as guesses — SLIs inferred from real recorded rules are `Verified`; an SLO re-identified by a discovered burn-rate group is `Verified` |
| Dashboard stub | `dashboards.platform-overview` | never (discovered dashboards replace it) |
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
re-identifies them; the SLI is `Verified` (the recorded series exist), the SLO
stays `Declared`.

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
| Alerting rules whose reported `health` is not `ok` | `mcp.discovered.alert_rules_unhealthy` | a burn-rate group fed by such a rule still maps but earns no `mcp.verified.policy.burn_rate_alerts[<i>]` stamp (projected `Declared`) |

Health the ruler did not report reads `null` in the observed arrays and is
**not** treated as unhealthy — only an explicit non-`ok` health withholds a
stamp. Older probe results that carried only job names still count as
(health-less) scrape evidence. The draft summary in the studio lists
`N scrape jobs down: …` and `N rules unhealthy: …` when either is non-empty.

Known limitation: an SLI inferred from a recorded rule the ruler reports
unhealthy is still stamped `Verified` (the SLI inference does not yet consult
rule health); the unhealthy rule itself is `Declared` and named in
`mcp.discovered.recording_rules_unhealthy`.

### Burn-rate alerts are mapped, never synthesised

`spec.policy.burn_rate_alerts` is built only from the alerting rules the MCP
actually exposes. Rules emitted by the Observogram compiler carry the
`slo`, `burn_rate`, `window_short`, `window_long` and `severity` labels; any
other rule is recognised by the compiler's `<slo>_burn_<N>x_<short>_<long>`
name. Rules are grouped per SLO (identical windows deduplicated, short window
first) and each emitted entry is stamped `mcp.verified.policy.burn_rate_alerts[<i>]`.

- When the rule names an SLO the fetcher inferred only as a placeholder
  (same SLI base, e.g. inferred `svc_checkout_availability_99` vs. discovered
  `svc_checkout_availability_99_9`), the placeholder is re-identified to the
  discovered id and its placeholder objective/window are replaced from the
  rule's `slo_objective` (`99.900%` → `0.999`) and `slo_window` annotations.
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
