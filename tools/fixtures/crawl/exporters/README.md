# Exporter fixture

A service whose metrics come from a prebuilt exporter (IBM's
mq-metric-samples) that an OTel collector scrapes and ships to Kafka.
Nothing here registers or queries a metric: the crawler learns the names
from the exporter's `metrics-manifest.json`, the families its `config.yaml`
switches on, and the collector's `qmgrs` scrape job. Read by
`tools/test-crawl-exporters.mjs`.

- `mq-exporter/` — the exporter's repository: a Dockerfile (not scanned),
  its config and the manifest `packc emit --exporter` writes.
- `charts/otel-collector/files/collector.yaml` — the collector config a
  Helm chart keeps under `files/`, with no `service:` block.
- `preprod/otel-collector.yaml` — the preprod collector; a `prod` crawl
  leaves it out and says so.
