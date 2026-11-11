# From validates to conformant

*Moved from [`DOWNSTREAM.md`](DOWNSTREAM.md) §11, keeping its section numbers.*

A pack that passes `npm run validate-pack` is *valid*: every schema-required
field holds a value of the right shape. It is *conformant* when every one of
those values is real — none is a placeholder an importer had to invent. The
upconvert of a large layered pack emits hundreds of placeholders; this section
is the paved road from the first state to the second.

## 11.1 The marker contract

A placeholder is **an artefact whose adapter symbol carries a scaffold
marker**: an annotation key `crawler.scaffold.<symbol>` (the upconvert and the
crawler), `mcp.scaffold.<symbol>` (the live fetcher) or `library.todo.<symbol>`
(Build) with a non-empty string value — exactly the three prefixes
`tools/lib/adapter.mjs` reads in `sourceOf`, so what the conformance tool
reports is what the studio parks as **Scaffold**. The key is the contract; the
value is advisory. A library-style value (`<field>: <what> · <field>: <what>`,
with `placeholder '<literal>'` naming the stub) names its own fields; any other
value (the crawler's, the fetcher's, the upconvert's one-line reason) falls
back to the engine's per-family field table. There is no second index: the
keys are the list.

Two kinds of symbol share the grammar. An **artefact symbol** is exactly an id
the adapter passes to `sourceOf` — `slis.<id>`, `slos.<id>`, `otel`,
`telemetry.backends.<id>`, `storage.<key>`, `pipelines.receivers[i]`,
`pipelines.processors[i]`, `pipelines.exporters.<signal>`,
`queries.recording_rules[i]`, `dashboards.<id>`,
`dashboards.<id>.panels.<panel>`, `policy.burn_rate_alerts[i]`,
`alerting.routes[i]`, `alerting.rules[i]`, `remediation[i]`, `baselines`,
`validation.synthetic_checks.<id>`, … — and parks that artefact. Any other
dotted or indexed path under an artefact symbol is a **field symbol**
(`otel.semconv`, `telemetry.backends.<id>.endpoints`,
`alerting.routes[0].channels[1]`, `metadata.owners`): it parks nothing in the
studio or in Compare and exists for the conformance report. Three doors write
`otel` at the artefact level or not at all: the upconvert
(`crawler.scaffold.otel`, `tools/lib/legacy.mjs`) and the fetcher
(`mcp.scaffold.otel`) park OTEL-01; the crawler marks the five otel fields so
a repo-vs-live Compare keeps `otel` in its not-observed bucket. The engine
reads both shapes.

`tools/lib/pack-conformance.mjs` (a listed module, zero-import, browser-safe)
turns the markers into rows:

```
{ path, symbol, field, needs, source, hint, state, marker, writer, rule }
```

`path` is the JSONPath of the artefact in the validator's style
(`$.spec.slis[0]`); `field` the spec field that needs a real value; `needs`
what it needs in one line; `source` where that value normally comes from:

- **crawl** — the value exists in the service repository (rule files,
  dashboards, collector and Alertmanager config, runbooks): `npm run crawl`
  reads it, or copy it from the file;
- **telemetry** — a fact of the running backends (products, versions, semconv,
  endpoints, incident history): the live fetcher (`npm run fetch-live`) or the
  backend's own API;
- **operator** — a decision only the owning team can make (objectives,
  windows, severities, guardrails, cadence, owners, criticality).

`state` is one of **placeholder** (marker present, the value still matches an
upstream stub literal — or the field has no stub test and the marker decides),
**marker-only** (marker present, the value no longer matches a stub: if it is
real, delete the marker), **unmarked** (no marker, but the value is an
importer's stub literal — `0.1.0-legacy`, `binding: legacy`,
`imports[].ref: legacy/…`, `expr: vector(1)`, a `+0-000-` phone stub,
`REPLACE WITH REAL QUERY` in an SLI description; the crawler's `0.1.0-crawled`
and `['team-platform']` only on a crawler-written pack) and **dangling** (a
marker whose symbol names nothing: delete it or fix the symbol). `rule` is the
stable `placeholder.<family>.<field>` string a waiver will scope to (with the
symbol); `writer` says which door wrote the marker. The state heuristics are
advisory — a real `objective: 0.99` under a standing marker still reads
`placeholder` — the marker key is the only contract, and the report says so.

## 11.2 The workflow

```sh
npm run upconvert-legacy -- old.json -o svc.pack.json      # once: the layered archive → canonical
npm run pack-conformance -- svc.pack.json                   # the rows: path · field · source · what it needs
npm run pack-conformance -- svc.pack.json --json > todo.json
# fill the rows by source: crawl → put the value in the repository and re-crawl, or copy it in;
#                          telemetry → read it off the backend; operator → decide it;
# then delete the artefact's marker (the tail line of each group names it) and re-run
npm run pack-conformance -- svc.pack.json --strict          # CI: exit 1 while any row remains
```

`packc conformance <file...>` is the same tool. Exit codes: 0 every pack read,
canonical and schema-valid (rows are informational); 1 a pack is unreadable, a
previous-format (layered) pack — never auto-converted, so every row points
into a file the operator can edit — or schema-invalid, or `--strict` and any
pack has rows (any state: a marker-only artefact is still parked Scaffold, a
dangling marker is a broken contract); 2 usage. The maturity rubric
(`GET /api/packs/:id/conformance`, the Diagnose view) is bridged, not hidden:
one `rubric @ tier` line per pack — the rubric grades what is declared,
placeholders included; the rows are what still has to become real.

**Re-running the upconvert is safe.** `upconvert-legacy` is idempotent in two
ways. A canonical input (apiVersion/kind) is validated and passed through
unchanged. A legacy input whose `-o` target already holds a canonical pack —
or whose `--merge <file>` names one — **merges** under one rule: *the existing
pack wins for every artefact it has; the upconvert only adds artefacts whose
legacy item the existing pack has never seen* (by the
`legacy.artefact.<LAYER>.<ID>` record — a deleted artefact stays deleted, a
schema-required stub is skipped). Added items land at the end of their list
with their marker and type annotation re-indexed to the final position;
existing annotations keep their order and values (a marker you cleared stays
cleared); the whole `legacy.*` block is refreshed to the current source. No
real value can regress to a scaffold by construction
(`tools/test-upconvert-merge.mjs` proves it over every example).
`--overwrite` restores the plain write.

## 11.3 Packs born canonical

The recommended end state is not to upconvert at all: crawl the service
repository with the upstream crawler. See [`CANONICAL_PACKS.md`](CANONICAL_PACKS.md) for what a fresh crawl promises.
