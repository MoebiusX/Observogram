# Snapshot fixtures (rebadge batch 3, C1)

Inputs of the true-snapshot suite, `tools/test-live-snapshot.mjs`
(`npm run test:golden:snapshot`). Its in-process MCP fake serves the
**recorded** payloads of `tools/fixtures/mcp/` (`vmalert_rules.json`,
`metrics_label_values.json`, `metrics_targets.json`,
`alertmanager_status.json`, `metrics_alerts.empty.json` — provenance in that
directory's README) and the files below. Its goldens are
`tools/fixtures/golden/snapshot/`.

| File | Kind | What it is |
|---|---|---|
| `grafana_dashboards_search.json` | **synthetic** (top-level `_synthetic` marker), 2026-10-07 | A dashboard search answer (`{ count, results }`, the recorded shape of `tools/fixtures/mcp/grafana_dashboards_search.json`) holding five dashboards whose uids are the shapes the fetcher's and the crawler's id rules once slugged differently: `node_exporter_full` (an underscore), `3b5d5c3712955042212316173ccf37be` (a digit-led md5), `a--b` (a double dash), `orders-main` and `9xyz_abc` (digit-led, an underscore). Two folders: `ab12` "Payments" and `cd34` "Orders". Replace it with a recording that carries these shapes. |
| `grafana_dashboard_get.json` | **synthetic** (`_synthetic`), 2026-10-07 | The detail answers (`{ meta, dashboard }`, as the fetcher reads them) keyed by uid under `byUid`, one per dashboard of the search. |
| `repo/` | **synthetic**, 2026-10-07 | The repository side, **crawled** by the suite (never a hand-written pack): the five dashboards' JSON (the same uids, titles and panels), a rule file with two alerting rules copied from the recorded `vmalert_rules.json` (`HighErrorRate`, `ServiceDown`) and three recording rules (one the recording holds, two recorded series an empty rules API leaves to the metric-name inventory), a Prometheus configuration with one scrape job the recorded targets hold up, and a source file declaring three metric names (two under the snapshot's prefixes, one outside them). |

Nothing here is a recording; nothing here may be read as evidence about a
real MCP or Grafana.
