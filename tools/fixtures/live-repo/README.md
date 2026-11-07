# The live-repository fixture

This folder is what the GitHub and Azure DevOps test repositories hold, at
their root, for `npm run test:live:repos` (`tools/test-live-repos.mjs`).
`docs/LIVE_REPO_TESTS.md` says how to create them and push it.

A service's Run reads these three files and nothing else:

| File | What the scan finds |
|---|---|
| `prometheus/rules.yml` | two recording rules and two alerts for `checkout` |
| `grafana/dashboards/checkout.json` | one dashboard with three panels |
| `otel/collector.yaml` | an OpenTelemetry collector with a metrics and a traces pipeline |

This README is not read: the scan takes YAML, JSON and code files only. The
live suite compares what each host returns with this folder, file by file, so
push this folder's content unchanged. A README or a licence that the host
adds when it creates the repository is not read either, so it can stay.
