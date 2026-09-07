# Recorded MCP response fixtures

Real responses recorded 2026-06-12 from the Krystaline otel-mcp-server,
trimmed for size (fewer rules / targets / dashboards / metric names) with
the field structure preserved verbatim — including authentic extras the
adapters must tolerate (`health`, `lastEvaluation`, a `down` target with a
populated `lastError`, dashboard `tags`/`folderUid`, …).

These are the contract-test inputs for `tools/test-contract-shapes.mjs`:
each fixture must satisfy its capability's declared response shape
(`tools/lib/contracts/response-shapes.mjs` — critical fields required,
extras allowed), and `adapt(fixture)` is pinned in `adapted/`.

| Fixture | Tool | Capabilities |
|---|---|---|
| `vmalert_rules.json` | `vmalert_rules` | recording_rules + alert_rules |
| `metrics_alerts.empty.json` | `metrics_alerts` | the legitimate-empty case (`{groups: []}` — the real VM-ruler response that motivated the cascade order) |
| `grafana_dashboards_search.json` | `grafana_dashboards_search` | dashboards |
| `metrics_targets.json` | `metrics_targets` | scrape_configs |
| `metrics_label_values.json` | `metrics_label_values` | metric_names |

## Recorded vs synthetic

Everything in this directory's top level is a **recording** — a real payload
from a real server, trimmed. `synthetic/` is different: **hand-written**
samples for the step-2 surfaces (stack self-metrics, Alertmanager status and
silences, Grafana datasources, datasource health, contact points) that no
recording exists for yet — the session that added them had neither
credentials nor Docker, so nothing could be captured. Each synthetic file
carries a top-level `"_synthetic"` marker naming the date and the
replacement path; the shape contract tolerates the marker like any other
extra, and `tools/test-contract-shapes.mjs` asserts it is present so a
recording that replaces the file must also drop the marker (and move the
case into the recorded `CASES` list with its `adapted/` pin).

| Synthetic fixture | Tool | Capability | Shape |
|---|---|---|---|
| `synthetic/metrics_query.instant-vector.json` | `metrics_query` | stack_self_metrics | `instant-vector` (otel-mcp-server `{ result }`) |
| `synthetic/metrics_query.instant-vector.prometheus-api.json` | `metrics_query` | stack_self_metrics, build_info_versions | `instant-vector` (Prometheus API `{ data: { result } }`) |
| `synthetic/alertmanager_status.json` | `alertmanager_status` | alertmanager_status | `status-object` |
| `synthetic/alertmanager_silences.json` | `alertmanager_silences` | alertmanager_silences | `silences` |
| `synthetic/grafana_datasources.json` | `grafana_datasources` | grafana_datasources | `datasources` |
| `synthetic/grafana_datasource_health.json` | `grafana_datasource_health` | grafana_datasource_health | `health-object` |
| `synthetic/grafana_contact_points.json` | `grafana_contact_points` | grafana_contact_points | `contact-points` |

Synthetic fixtures pin **shape only** (critical fields, tolerance, removal
gate) — no `adapted/` goldens, because the fetcher's parsers for these
capabilities land with the sampler. The markers name `npm run
record-fixtures` as the replacement path; that recorder script ships with
the sampler slice, so until then re-record the same way as below (any MCP
client, parsed `content[0].text`).

## Re-recording

When an upstream MCP changes its payload shape on purpose: capture the new
response (any MCP client; the payload is the parsed `content[0].text` of the
`tools/call` result), trim it the same way, replace the fixture, then run

    node tools/test-contract-shapes.mjs --update

and review the `adapted/` diff — it is the canonical-fragment changelog of
the upstream change. If the shape check itself fails, the upstream removed
or renamed a critical field: update the shape row AND the adapter together,
in the same commit.
