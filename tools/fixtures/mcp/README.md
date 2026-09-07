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

## Provenance

Every file here is one of two kinds, and the kind is part of what the suite
asserts. A **recording** is a real payload from a real server, trimmed. A
**synthetic** file is hand-written: it carries a top-level `"_synthetic"`
marker naming its date and the replacement path, the shape contract
tolerates the marker like any other extra, and `tools/test-contract-shapes.mjs`
asserts the marker is present — so the file can only be replaced by a
recording that drops it.

| Fixture | Tool | Capabilities | Kind | Recorded / written |
|---|---|---|---|---|
| `vmalert_rules.json` | `vmalert_rules` | recording_rules + alert_rules | recording | 2026-06-12, Krystaline otel-mcp-server (VictoriaMetrics + vmalert) |
| `metrics_alerts.empty.json` | `metrics_alerts` | the legitimate-empty case (`{groups: []}` — the real VM-ruler response that motivated the cascade order) | recording | 2026-06-12 |
| `grafana_dashboards_search.json` | `grafana_dashboards_search` | dashboards | recording | 2026-06-12 |
| `metrics_targets.json` | `metrics_targets` | scrape_configs | recording | 2026-06-12 (`alertmanager` target `down` with its `lastError`) |
| `metrics_label_values.json` | `metrics_label_values` | metric_names | recording, trimmed by the recorder (every name an alias `requires` that the server exposes, the `*_build_info` metrics, and the first 25 others — 40 names of the server's 2,682); it now evidences `up`, `scrape_duration_seconds`, `vm_*`, `alertmanager_*`, `otelcol_exporter_queue_*`, `grafana_http_request_duration_seconds_count`, `promtail_dropped_entries_total` | 2026-09-07, Krystaline otel-mcp-server **public tier** |
| `synthetic/metrics_query.instant-vector.json` | `metrics_query` | stack_self_metrics | synthetic (`{ result }`, otel-mcp-server) | 2026-09-07 |
| `synthetic/metrics_query.instant-vector.prometheus-api.json` | `metrics_query` | stack_self_metrics, build_info_versions | synthetic (`{ data: { result } }`, Prometheus API) | 2026-09-07 |
| `alertmanager_status.json` | `alertmanager_status` | alertmanager_status (`status-object`) | recording — `config` (the full Alertmanager configuration: receivers, internal hostnames) omitted by hand; the shape needs only `version` / `uptime` / `cluster` | 2026-09-07, public tier (Alertmanager 0.27.0) |
| `synthetic/alertmanager_silences.json` | `alertmanager_silences` | alertmanager_silences (`silences`) | synthetic — the 2026-09-07 recording came back `{ count: 0, silences: [] }` (no active silences), which pins nothing about the item fields, so the synthetic file stays until a recording with entries exists | 2026-09-07 |
| `synthetic/grafana_datasources.json` | `grafana_datasources` | grafana_datasources (`datasources`) | synthetic | 2026-09-07 |
| `synthetic/grafana_datasource_health.json` | `grafana_datasource_health` | grafana_datasource_health (`health-object`) | synthetic | 2026-09-07 |
| `synthetic/grafana_contact_points.json` | `grafana_contact_points` | grafana_contact_points (`contact-points`) | synthetic | 2026-09-07 |
| `recorded-stack/<row id>.json` | `metrics_query` | stack_self_metrics — one instant vector per family (`scrape_success_ratio`, `notification_errors`, `tsdb_active_series`, `collector_queue_saturation`, `grafana_http_errors`, `log_shipper_drops`); otel-mcp-server answers a flat Prometheus-style envelope `{ status, resultType, result }` | recording | 2026-09-07, public tier |

The remaining synthetic files cover the Grafana-backed status tools
(`grafana_datasources`, `grafana_datasource_health`, `grafana_contact_points`)
and the instant-vector envelopes: on the public Krystaline tier every
Grafana-backed tool except `grafana_health` answers `HTTP 401` from Grafana
(the tier carries no Grafana credentials), so they could not be recorded
there — run the recorder against the authenticated tier to replace them. The
2026-06-12 recordings of `metrics_targets.json`, `vmalert_rules.json` and
`grafana_dashboards_search.json` were kept on purpose: the 2026-09-07 targets
payload has every target `up`, and the `down` Alertmanager target with its
`lastError` is the case the liveness adapters are pinned against. Synthetic
fixtures pin **shape only** (critical fields, tolerance, removal gate) — no
`adapted/` goldens, because these capabilities have no `PROBES` adapter (the
fetcher's `observeAlertmanager` / `observeGrafana` parse them directly).

## Recording against your MCP (`npm run record-fixtures`)

`tools/record-mcp-fixtures.mjs` verifies the alias table and records these
fixtures from a live server. It reuses the fetcher's JSON-RPC client and
resolves **every** tool name through the contract registry (the guard suite
scans it for literals), is read-only against the MCP (`initialize`,
`tools/list`, `tools/call`), and never prints or stores the bearer token
(every string that leaves the process is redacted).

    MCP_URL=https://your-mcp/path MCP_AUTH=$TOKEN npm run record-fixtures

**Report mode (default) writes nothing.** It prints the `tools/list` surface
with its drift against the registry (advertised tools with no registry row;
the six step-2 tools and whether each is advertised), the metric-name
inventory (which candidate answered, how many names), then — for every
alias of every row — whether all of its `requires` are in the inventory and,
for the eligible ones, the sampled value read exactly the way the fetcher
reads it (`sampleFromInstantVector`: `data <value>`, `empty`, `FAILED
<reason>`). Ineligible aliases read `not-in-inventory (missing <names>)` and
are never called by the recorder; the report also prints the fetcher's
inventory-trust verdict (an inventory without `up` is treated as incomplete
by the fetcher, which then queries such rows anyway) and the inventory size
beside the not-in-inventory count, so a capped list is visible on the first
live run. On a restricted tier (no `metrics_query`) every alias reads
`not-attempted (metrics_query not exposed by this MCP (restricted tier))`.
The Alertmanager / Grafana status tools and the probe families follow, each
with its shape verdict. Committed fixtures carry `_recorded` provenance of
tool + timestamp (+ query) only — the MCP hostname goes to the git-ignored
review copy alone.

**`--write` records the fixtures** (`npm run record-fixtures -- --write`;
`--out <dir>` redirects everything, the recorder suite uses it):

| Written | Content | Trimming |
|---|---|---|
| `.tmp-mcp-metric-names.json` (repo root, git-ignored) | the FULL metric-name list with `recordedAt`, server origin, tool, count | none — the review copy |
| `<metric_names tool>.json` (e.g. `metrics_label_values.json`) | the inventory payload | the list is replaced where the adapter found it: every name any alias `requires` (plus the `*_build_info` metrics) and the first 25 others, in the server's order |
| `<tool>.json` for scrape targets, the winning rule tool(s), dashboard search | the raw payload | every list capped at 6 entries, recursively; keys and scalars untouched (a `count` may then disagree with its list — the existing convention) |
| `recorded-stack/<row id>.json` | one `metrics_query` instant vector per family — the first row with data, else the first honest empty | lists capped at 6; `_recorded` provenance (`tool`, `family`, `row`, `product`, `query`, `outcome`, `value`) |
| `alertmanager_status.json`, `alertmanager_silences.json`, `grafana_datasources.json`, `grafana_datasource_health.json` (first uid that answered), `grafana_contact_points.json` | the status payloads, only when the tool was advertised | lists capped at 6; `_recorded` provenance on object payloads |

A recorded `<tool>.json` at this top level **takes precedence** over
`synthetic/<tool>.json` in `tools/test-contract-shapes.mjs`: the recorded
file is tested with the same shape / tolerance / critical assertions plus
"carries no `_synthetic` marker", and the synthetic copy is ignored (delete
it once the recording is committed). Every file in `recorded-stack/` must be
a valid instant vector for a row the alias table still declares.

**Afterwards:**

1. Review the diff — the report already told you which aliases answered;
   an alias that `FAILED` with a parse error, or a row that never answers on
   a stack that runs the product, is a wrong metric name in the alias table
   (fix the row, cite the upstream doc in its `source`).
2. `node tools/test-contract-shapes.mjs --update` — re-pins `adapted/` for
   the probe fixtures you replaced; review that diff too, it is the
   canonical-fragment changelog of the upstream change.
3. `npm test` — the guard, shapes, stack and recorder suites, then everything
   else.
4. Update the provenance table above (date, server) and remove the
   `synthetic/` files the recording replaced.

## Re-recording a single fixture by hand

When an upstream MCP changes its payload shape on purpose: capture the new
response (any MCP client; the payload is the parsed `content[0].text` of the
`tools/call` result), trim it the same way, replace the fixture, then run

    node tools/test-contract-shapes.mjs --update

and review the `adapted/` diff. If the shape check itself fails, the upstream
removed or renamed a critical field: update the shape row AND the adapter
together, in the same commit.
