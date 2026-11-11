# Packs born canonical: the recommended end state

*Moved from [`DOWNSTREAM.md`](DOWNSTREAM.md) §12.*

**Three doors, one pipeline.** Crawl (`tools/lib/crawler.mjs`, `npm run
crawl`), upconvert (`tools/upconvert-legacy.mjs`, for packs from the archived
layered format) and Build (`tools/lib/library.mjs`) all emit the canonical
manifest; validation (`npm run validate-pack`), conformance
(`tools/pack-conformance.mjs`, [`PACK_CONFORMANCE.md`](PACK_CONFORMANCE.md)), compile, deploy and Compare read only
that. The recommendation: crawl the service repository with the upstream
crawler — a fresh crawl validates on exit 0 and needs no upconversion; the
upconvert is for the archive, and a re-crawl supersedes an upconverted pack.

**What a fresh crawl promises.**

1. It validates against the vendored spec or exits 3 — and exit 3 is a bug
   to report, never an input error.
2. Flags that cannot yield a valid pack are refused before the crawl
   (exit 2, the rule in the message, nothing on stdout): `--name`, `--env`
   and each `--owners` entry must be spec Slugs, `--criticality` and
   `--binding` spec values. The programmatic doors (`POST /api/crawl`, the
   studio's folder scan, a journey definition) get the same rule as a
   default-plus-warning: an unknown criticality yields the inferred tier and
   `crawler.criticalityIgnored`, an unknown binding the default and
   `crawler.bindingIgnored`.
3. Names are normalized to the spec Slug and the original kept: the folder
   name in `crawler.nameNormalizedFrom`, the environment in
   `crawler.environmentNormalizedFrom`; owners only in the response's
   `summary.normalized.owners` (an owner string may be an address and never
   reaches the stored pack). A name that does not start with a letter is
   prefixed (`1password` → `svc-1password`), never truncated at the front.
4. What the spec cannot hold is omitted and recorded as evidence, never
   invented and never silently dropped: recording rules that are not
   metric names with a `:` in `crawler.omitted.recording_rules` (name +
   `<file>#<group>/<name>`; their expressions still feed the metric
   inventory), a dashboard `schemaVersion` below 30 in
   `params.schema_version`, a rule-group interval that is not a Duration in
   the response's `summary.omitted.ruleIntervals`.
5. Every value it had to invent is marked (`crawler.scaffold.<symbol>`, the
   table below).

**The scaffold table** — one row per symbol: why the crawler cannot know it,
where the real value comes from ([`PACK_CONFORMANCE.md`](PACK_CONFORMANCE.md) §11.1's three sources), how to make it real.

| Symbol | Why invented | Source | How to make it real |
|---|---|---|---|
| `metadata.owners` | no repository file names the owning team | operator | `--owners` |
| `otel.semconv`, `otel.resource_attributes`, `otel.sdk.sampling`, `otel.sdk.propagators` | the SDK configuration is not in observability files | operator / telemetry | state them in the pack (or `OTEL_*` in the deployment, which a later crawl may read) |
| `otel.sdk.languages` | invented only when the repository has no source files | crawl | the source files name the SDK languages (a heuristic over extensions: a Go service with a `scripts/*.js` helper reports both) |
| `slis.<id>`, `slos.<id>` (stub or alert-derived) | no recording rule or SLO reference found | operator | add `<service>:<metric>:<op>` recording rules, which the crawler reads back as SLIs; or write the SLI |
| `pipelines.receivers[0]`, `pipelines.processors[0]`, `pipelines.exporters.<signal>` | no collector config or backend image | crawl | a collector config, or a backend image in compose/Helm |
| `alerting.routes[0]` (stub) | no Alertmanager config | crawl | an Alertmanager config |
| `alerting.routes[i].channels[j]` | a receiver kind the spec Channel cannot carry, or a config that states no address | operator | the real address (a webhook URL, a Teams channel URL) |
| `dashboards.<svc>-overview` (stub) | no dashboard JSON | crawl | a dashboard JSON in the repository |
| `telemetry.backends.<id>.endpoints` | the compose service or workload states no port (`http://<product>:80` assumed) | telemetry / operator | the port |
| `baselines` | MTTD/MTTR come from incident history, not files | telemetry | measure them |
| `validation.synthetic_checks.<svc>-health-canary` | no probe definition in the repository | operator | the real health URL, interval and severity |

**The symbol grammar** is [`PACK_CONFORMANCE.md`](PACK_CONFORMANCE.md) §11.1's, shared by `crawler.scaffold.*`,
`mcp.scaffold.*` and `library.todo.*`: artefact symbols are the adapter's
`sourceOf` ids and park the artefact as Scaffold (the stub and alert-derived
SLI/SLO pairs — Compare files them in its scaffold bucket, the reading the
live side already applies to its own stubs); field symbols add `.<field>` or
an index and park nothing — they exist for the conformance report. A mark's
value is a one-line reason. The keys are the index: there is no second JSON
list.

**Known unmarked defaults** (the conformance tool's value heuristics carry
them until the named follow-up lands): SLO `objective 0.99 / window 30d /
error_budget_policy ref:platform/default-budget`; SLI `total: '1'`; SLI
`threshold: 1` with `unit: 'ratio'`; burn windows `5m/1h/14/SEV1 +
30m/6h/6/SEV2`. Why unmarked: the live fetcher derives the same values through
`tools/lib/sli-inference.mjs`, and Compare pairs them; marking one side would
park them. The crawler's `version: 0.1.0-crawled` is reported `unmarked` on a
crawler-written pack: a fresh crawl *validates* but is not *conformant* until
the operator names the version.

**The workflow.**

```sh
npm run crawl -- <repo> --name <slug> --env <slug> > pack.yaml
npm run validate-pack -- pack.yaml
npm run pack-conformance -- pack.yaml      # fill the rows: a value a later crawl can read (a rule, a port)
                                           # belongs in the repository, the rest in the pack; delete the mark
npm run pack-conformance -- pack.yaml --strict   # CI, once the pack is conformant
```

**Named follow-ups** (one line each; downstreams plan against these names):

- *Inference defaults marked on both sides* — SLO objective/window/budget
  ref, SLI total/threshold and the default burn windows need a joint change
  in `sli-inference.mjs` applied by the crawler and the fetcher plus a diff
  test; marking one side alone would move every crawled SLO out of Compare's
  `inBoth`.
- *Artefact-level `otel` scaffold on the repo side* — a product decision:
  it would move OTEL-01 from Compare's not-observed bucket to its scaffold
  bucket.
- *Omitting the fabricated synthetic check* — the schema allows an empty
  `validation`, but the rubric's L5 MUST and the studio pin the parked stub;
  a product decision on which reading is the honest one.
- *HTTP 400 for invalid crawl options on `POST /api/crawl`* — today the
  library's default-plus-warning keeps the response a valid pack.
- *`-burn-?rate` suffix handling in `burnCandidateFromAlertRule`* — a
  hyphenated alert name yields `shop-availability_99` while the recording-rule
  derivation yields `shop_availability_99`; unifying the separator renames L1
  ids on both producers.
- *`javaMetricPrefix`'s `solace_` product rule* — kept as a product rule
  (the path or the source literally says `solace`); a generic prefix rule
  read from configuration is the follow-up.
- *`legacy.liveness.mcpUrl` through `stripMcpUrl`* — the upconvert copies a
  legacy liveness URL verbatim into the annotations; a URL carrying userinfo
  or a token query parameter would be stored (none of the shipped examples
  does). A default-output change for such packs, with its own CHANGELOG line.
- *Waivers (GAP batch 2, B3.2)* — delivered ([`RELIABILITY_WORKFLOW.md`](RELIABILITY_WORKFLOW.md) `waivers`): the engine
  honours `opts.waivers` and answers the `waived` partition; `packc
  conformance --waivers <file>` drives it.
- *Service audit report (GAP batch 2, B3.5)* — delivered ([`RELIABILITY_WORKFLOW.md`](RELIABILITY_WORKFLOW.md)
  `service-audit-report`): the report's placeholders section is
  `packConformance(canonical)`'s rows, and `GET /api/packs/:id/placeholders`
  answers the same rows (the static bundle too).
- *Imports as Scaffold* — the adapter hardcodes `source: 'Declared'` for
  `metadata.imports`, so the upconvert's `legacy/<slug>` pseudo-refs are
  reported `unmarked` and never parked; a board change.
