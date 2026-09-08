# Recorded MCP response fixtures

Real responses recorded 2026-06-12 through 2026-09-08 from the Krystaline
otel-mcp-server, trimmed for size (fewer rules / targets / dashboards /
metric names) with the field structure preserved verbatim — including
authentic extras the adapters must tolerate (`health`, `lastEvaluation`, a
`down` target with a populated `lastError`, dashboard `tags`/`folderUid`, …).

These are the contract-test inputs for `tools/test-contract-shapes.mjs`:
each fixture must satisfy its capability's declared response shape
(`tools/lib/contracts/response-shapes.mjs` — critical fields required,
extras allowed), and `adapt(fixture)` is pinned in `adapted/`.

## Three evidence sources

The fixtures here come from the table's live evidence sources. The
public Krystaline tier answers through the MCP (what that stack happens to
scrape, at its versions — otel-collector 0.154.0, Jaeger v2.18.0, Grafana
12.4.0, Alertmanager 0.27.0, VictoriaMetrics; no Prometheus server, no
blackbox, vmalert not scraped). The **authenticated Krystaline tier**
(`https://www.krystaline.io/mcp`, `MCP_AUTH` bearer; recorded 2026-09-08)
answers the same metrics / vmalert / Alertmanager surface against the same
backends — plus logs and k8s tools the registry has no rows for — but its
otel-mcp-server deployment carries **no Grafana integration at all** (no
`GRAFANA_URL`): it does not advertise `grafana_datasources`,
`grafana_datasource_health`, `grafana_contact_points` or
`grafana_dashboards_search` with any key, so the Grafana-backed fixtures
could not be recorded there either. The third is
`docker/stack.compose.yaml` — every product the alias table names at an
exactly pinned version — which
`npm run test:stack:live` (`tools/test-stack-live.mjs`) checks directly:
every `requires` name on the product's own exposition, every lazily
registered counter after a stimulus, every `expr` on a real Prometheus,
every alias's `verified` stamp against the compose image. Nothing from the
stack is committed as a fixture (its ledger is the git-ignored
`.tmp-stack-live-ledger.json`); the stamp on each alias and the
"Live validation tier" section of `docs/MCP_INTEGRATION.md` carry that
evidence.

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
| `vmalert_rules.json` | `vmalert_rules` | recording_rules + alert_rules | recording | 2026-09-08, Krystaline otel-mcp-server **authenticated tier** (VictoriaMetrics + vmalert); nothing scrubbed — the annotations carry rule descriptions and runbook URLs into the (private) krystalinex-core repo: references, not credentials, and the identical payload the credential-less public tier serves to any caller |
| `metrics_alerts.empty.json` | `metrics_alerts` | the legitimate-empty case (`{groups: []}` — the real VM-ruler response that motivated the cascade order) | recording | 2026-06-12 |
| `grafana_dashboards_search.json` | `grafana_dashboards_search` | dashboards | recording | 2026-06-12 |
| `metrics_targets.json` | `metrics_targets` | scrape_configs | recording | 2026-06-12 (`alertmanager` target `down` with its `lastError`) — kept on purpose; the 2026-09-08 authenticated-tier recording has every target `up` |
| `metrics_label_values.json` | `metrics_label_values` | metric_names | recording, trimmed by the recorder (every name an alias `requires` that the server exposes, the `*_build_info` metrics, and the first 25 others — 43 names of the server's 2,682); it evidences `up`, `scrape_duration_seconds`, `vm_*`, `alertmanager_*`, `otelcol_exporter_queue_*`, `otelcol_exporter_sent_spans`, `otelcol_receiver_accepted_spans` (the lazy-policy siblings), `grafana_proxy_response_status_total`, `grafana_http_request_duration_seconds_count`, `promtail_dropped_entries_total` | 2026-09-07 (re-recorded after the live correction of the table), Krystaline otel-mcp-server **public tier**; the 2026-09-08 authenticated-tier recording is byte-identical |
| `synthetic/metrics_query.instant-vector.json` | `metrics_query` | stack_self_metrics | synthetic (`{ result }`, otel-mcp-server) | 2026-09-07 |
| `synthetic/metrics_query.instant-vector.prometheus-api.json` | `metrics_query` | stack_self_metrics, build_info_versions | synthetic (`{ data: { result } }`, Prometheus API) | 2026-09-07 |
| `alertmanager_status.json` | `alertmanager_status` | alertmanager_status (`status-object`) | recording — `_recorded.scrubbed` lists the trim: `config` (the full Alertmanager configuration: receivers, SMTP settings, internal hostnames) removed by hand, same as the 2026-09-07 recording it replaces; the shape needs only `version` / `uptime` / `cluster` | 2026-09-08, **authenticated tier** (Alertmanager 0.27.0) |
| `synthetic/alertmanager_silences.json` | `alertmanager_silences` | alertmanager_silences (`silences`) | synthetic — the 2026-09-07 and 2026-09-08 recordings both came back `{ count: 0, silences: [] }` (no active silences), which pins nothing about the item fields, so the synthetic file stays until a recording with entries exists | 2026-09-07 |
| `synthetic/grafana_datasources.json` | `grafana_datasources` | grafana_datasources (`datasources`) | synthetic | 2026-09-07 |
| `synthetic/grafana_datasource_health.json` | `grafana_datasource_health` | grafana_datasource_health (`health-object`) | synthetic | 2026-09-07 |
| `synthetic/grafana_contact_points.json` | `grafana_contact_points` | grafana_contact_points (`contact-points`) | synthetic | 2026-09-07 |
| `recorded-stack/<row id>.json` | `metrics_query` | stack_self_metrics — one instant vector per family that answered (`scrape_success_ratio`, `notification_errors`, `tsdb_active_series`, `collector_export_failures_spans` — the lazy-policy alias reading 0 on a collector whose `send_failed_spans` is absent —, `datasource_errors` — on this tier the row's first alias `grafana_datasource_request_total` is `not-in-inventory` (never called) and the row falls through to the proxy alias, so the file's provenance query is the `grafana_proxy_response_status_total` expression —, `log_shipper_drops`; ruler, synthetic and traces have no eligible alias on that tier); otel-mcp-server answers a flat Prometheus-style envelope `{ status, resultType, result }` | recording | 2026-09-08, **authenticated tier** (same six rows and outcomes as the 2026-09-07 public-tier recording it replaces) |

The remaining synthetic files cover the Grafana-backed status tools
(`grafana_datasources`, `grafana_datasource_health`, `grafana_contact_points`)
and the instant-vector envelopes. Neither Krystaline tier can record them:
on the public tier every Grafana-backed tool except `grafana_health` answers
`HTTP 401` from Grafana (the tier carries no Grafana credentials), and the
authenticated tier (recorded 2026-09-08, every issued key tried) does not
advertise the Grafana-backed tools at all — its otel-mcp-server deployment
has no Grafana integration configured. They stay synthetic until a tier that
answers them exists. The 2026-06-12 recordings of `metrics_targets.json` and
`grafana_dashboards_search.json` were kept on purpose: the 2026-09-07 and
2026-09-08 targets payloads have every target `up`, and the `down`
Alertmanager target with its `lastError` is the case the liveness adapters
are pinned against; the dashboard search answers on no recordable tier (401
on public, not advertised on authenticated). Synthetic
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
