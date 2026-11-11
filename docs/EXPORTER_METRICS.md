# Metrics from prebuilt exporters (follow-up exporter-metrics)

*Moved from [`DOWNSTREAM.md`](DOWNSTREAM.md) §18, keeping its section numbers.*

A service whose metrics come from a prebuilt exporter — IBM's
mq-metric-samples, a node_exporter, a vendor sidecar — has no client-library
call or PromQL that names them: the exporter's repository is a Dockerfile and
a config file, and the collector that scrapes it lives in another chart. The
crawler (`tools/lib/crawler.mjs`) reads the exporter's metrics from three
places, strongest first, through `tools/lib/exporter-metrics.mjs` (listed,
pure):

| Source | Files | `origin_kind` | Confidence |
|---|---|---|---|
| a metrics manifest | `metrics-manifest.json`, `*.metrics-manifest.json` | `exporter-manifest` | `declared` |
| a saved exposition | `*.prom`, `*.metrics` (never under a test, fixture or mock folder; an OpenMetrics counter or info named as stored, `_total` / `_info`) | `exporter-snapshot` | `declared` |
| the exporter's config, read against the catalogue | any YAML whose top-level keys match a catalogue entry | `exporter-config` | `inferred` (a candidate) |

A metric named in several files reads as the strongest: manifest, snapshot,
source code, source fragment, recording-rule output, PromQL reference, and
an exporter config last. Every exporter the crawl learned from is listed in
`crawler.discovered.exporters` (`{ <exporter>: { sources: [{ origin_kind,
file, metrics, … }] } }`) and counted in `crawler.discovered.exporters_count`.
A manifest and a snapshot are read in every environment; an exporter config
is scoped like any other config, and a crawl whose environment scope leaves
out a file with scrape jobs or exporter evidence says which in a warning.

## 18.1 The manifest

```json
{
  "exporter": "ibm-mq",
  "version": "5.6.0",
  "source": "http://mq-exporter:9157/metrics",
  "generatedAt": "2026-10-01T00:00:00.000Z",
  "metrics": [
    { "name": "ibmmq_queue_depth", "type": "gauge", "help": "Current depth of the queue", "labels": ["qmgr", "queue"] }
  ]
}
```

`exporter` and `metrics` are required; each entry needs a metric name and an
exposition type (`counter`, `gauge`, `histogram`, `summary`, `untyped`,
`unknown`, `gaugehistogram`, `info`, `stateset`). An entry that has neither,
or repeats a name, is not read and the crawl says how many; a file that is not
a manifest is named in a warning. `source` is recorded without userinfo,
query or fragment: tabs and line breaks, everything before the last `@`, and
everything from the first `?` or `#` are dropped (`safeSourceUrl`, textual —
a password may hold `/` or `@`). A value with a `?` or `#` before its last
`@` is not recorded at all.
Label values are never part of a manifest.

An exporter that mints metric names at runtime (one counter per queue, per
event) cannot list them. Its manifest declares them as patterns, in an optional
array written by hand:

```json
{
  "exporter": "demo-exporter",
  "metrics": [{ "name": "demo_up", "type": "gauge" }],
  "dynamicFamilies": [
    { "pattern": "^demo_queue_[a-z0-9_]+_total$", "type": "counter", "help": "One counter per queue", "labels": ["qmgr"] }
  ]
}
```

`pattern` is required; `type`, `help` and `labels` are optional. A name a family
matches reads as declared, so a pattern must say whose names it claims: it opens
with a literal metric-name prefix of at least three characters, more than a
platform's own (`^node_`, `^kube_`, `^go_` are refused, `^node_hwmon_` is not),
and has no alternative outside a group. It runs on every unpaired name of a live
estate, so its shape is bounded too: anchored, 200 characters, no quantified
group, lookaround or backreference, at most three unbounded quantifiers and six
choice points (`|`, `?`), and it must finish within the budget on 256-character
names that open with its prefix. At most 64 families are read. An entry that
breaks a rule is not read and the crawl's warning names its position and the
rule, never its text. Families reach the pack as
`crawler.discovered.metric_families` (`[{ pattern, type, help, labels, exporter,
file }]`, sorted, with `_count`); the first file that declares a pattern keeps
it. The adapter projects each as `METRIC-FAM-NN`, and the diff tests the other
side's unpaired metric names against it (docs/DIFF.md, *Dynamic metric
families*). `packc emit` over an existing manifest keeps its `dynamicFamilies`
as they stand and says how many.

A rules file authored ahead of an environment says so in a comment block that
opens the file, `# observogram-lifecycle:` with `maturity` and a nested `deployment` of
`<env>: deployed | planned | not-deployed`, and its rules read as declared ahead
instead of declared, not live (docs/DIFF.md, *Declared ahead of an environment*).
The crawler carries it as the `observogram.lifecycle` annotation, which a
hand-written pack states directly.

`packc emit --exporter <url>` (`tools/emit-manifest.mjs`) writes one from a
live endpoint — run it in the exporter's build pipeline against the image it
just built:

```bash
packc emit --exporter http://mq-exporter:9157/metrics --name ibm-mq --version 5.6.0 --out mq-exporter/metrics-manifest.json
packc emit --from saved.prom --name ibm-mq --out -     # a saved exposition, to stdout
```

It scrapes once and records each family's name, type, help and label names.
A redirect is refused, not followed: the refusal names its target with the
query as the keys of its `key=value` parts only (`?token=…`) — pass that URL
with the values the exporter expects. A URL with credentials is refused (save the exposition with your own
client and pass it with `--from`). A status other than 200 or a response
with no metric family exits 1.

## 18.2 The catalogue

An exporter config names no metric; the catalogue says which families a
config switches on. The built-in catalogue (`tools/lib/exporter-catalogue.mjs`,
data only, `EXPORTER_CATALOGUE`) carries a small IBM MQ entry. A downstream
carries a larger one as a JSON file of the same shape, never as an engine
diff:

```json
{
  "exporters": [
    {
      "id": "ibm-mq",
      "match": { "keys": ["global", "connection", "objects", "prometheus"] },
      "namespace": { "path": "prometheus.namespace", "default": "ibmmq" },
      "gates": {
        "objectStatus": { "path": "global.useObjectStatus", "default": true },
        "publications": { "path": "global.usePublications", "default": true }
      },
      "scopes": { "queues": { "path": "objects.queues" } },
      "families": [
        { "name": "queue_depth", "type": "gauge", "help": "Messages on the queue", "labels": ["qmgr", "queue"], "gate": "publications", "scope": "queues" }
      ]
    }
  ]
}
```

- `match.keys` — the top-level keys a config must all carry. The first entry
  that matches reads the file.
- `namespace` — the metric-name prefix: the value at `path` in the config,
  else `default`; a family's name is `<namespace>_<name>`.
- `gates` — boolean switches (`true`/`false`, `yes`/`no`, `on`/`off`), the
  `default` when the config is silent; a family with `gate` is emitted only
  when it is on.
- `scopes` — object selections; a family with `scope` is emitted only when
  the value at `path` selects something (a non-empty list, string or
  mapping).

Pass it with `packc x-ray <repo> --exporter-catalogue <file.json>` or
`crawlFiles(files, { exporterCatalogue })`. Its entries replace a built-in
entry with the same `id` and add the rest. An entry that is not well-formed
is dropped with a crawl warning naming what it lacks. A config-inferred
family stays a candidate (`confidence: inferred`): the config says the
exporter is switched on, not that the name is exact. Publish the real list
with `packc emit` and the manifest outranks it.

## 18.3 The collector's scrape jobs

An OTel collector's prometheus receivers (`prometheus`,
`prometheus/<name>`) are read for their `config.scrape_configs`, with or
without a `service:` block (a Helm chart's `files/` copy has none), in a
config file, a Helm ConfigMap, or a chart's `values*.yaml` (at its top level,
under `config:`, or under a subchart's `<key>.config:` unless the subchart
is disabled — its `enabled` toggles merged across the in-scope values files,
an overlay winning).

- Each job is in `crawler.discovered.scrape_jobs`. Its entry in
  `crawler.discovered.scrape_job_origins` adds `via: otel-collector`, the
  `receiver`, the `target_count` of its static targets, and the `exporters`
  its samples leave by: the exporters of the metrics pipelines that list the
  receiver, in the same file or, when none there does, another (a config
  split across `--config` files), or, when none does, the metrics exporter a
  pipeline-less config names. A job that cannot be read is warned about and
  skipped; the rest of the config is read.
  Each exporter is given as `{ name, kind, topic | endpoint }`: a kafka
  exporter's metrics topic, any other's endpoint reduced by `safeSourceUrl`
  (no userinfo, query or fragment).
- That exporter's kind is `spec.pipelines.exporters.metrics`, in place of the
  `prometheusremotewrite` scaffold. A config with no pipelines only proposes
  one: it applies after every file is walked, and only when nothing else set
  the metrics exporter — no pipeline in any file declares one, and no metrics
  backend image implies one. When it names several, the first is taken and
  the crawl warns.
