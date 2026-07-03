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
| Alert rules | Grafana/Prometheus alerting rules and burn-rate alerts |
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
    mcp.probesFailed: ""

    mcp.verified.otel: "2026-06-09T00:09:14.730Z"
    mcp.verified.telemetry.scrape: "2026-06-09T00:09:14.730Z"
    mcp.verified.queries.recording_rules: "2026-06-09T00:09:14.730Z"
    mcp.verified.dashboards: "2026-06-09T00:09:14.730Z"
    mcp.verified.policy.burn_rate_alerts: "2026-06-09T00:09:14.730Z"
```

The adapter promotes artifacts with matching `mcp.verified.<symbol>` keys to
`Verified`. The Diagnostic Grade uses these annotations to decide whether a
fresh live signal exists.

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
