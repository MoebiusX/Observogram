# Adapter — canonical → layered

The adapter (`tools/lib/adapter.mjs`) projects a canonical ObservabilityPack v1.4 manifest into the studio's layered display object. Pure ESM, no Node APIs — the Express server, the `npm run adapt` CLI, and (potentially) browser-side consumers all import the same module.

## Public API

```js
import { adapt, listEnvironments, applyEnvironmentOverlay, overlaidCanonical } from './tools/lib/adapter.mjs';

const layered = adapt(canonical, { environment: 'staging' });
// layered = { id, name, badge, description, meta, layers: { L1, L2, L2X, L3, L4: {policy,alerting,healing}, L5, GOV }, traceability }

const envs = listEnvironments(canonical);
// e.g. ['prod', 'staging']

const { spec, effective } = applyEnvironmentOverlay(canonical.spec, 'staging');
// spec = deep-cloned spec with dotted-path overrides applied
// effective = { target, criticality, backendWiring }

const { canonical: overlaid } = overlaidCanonical(canonical, 'staging');
// the same overlay applied to a copy of the whole manifest, with the effective
// criticality / default_target propagated up to metadata.bindings — what the
// conformance scorer, the compilers and the export read for one environment
// (the server, the static bundle and the CLIs share this one helper)
```

## Layered output shape

```
{
  id: string,
  name: string,
  badge: string | undefined,            // e.g. "TIER-1"
  description: string,
  meta: {
    apiVersion, kind, binding, version,
    owners: string[],
    criticality, target,
    environment, environments,          // current + all
    backendWiring,                      // { signal-class: backend-id } from env
  },
  layers: {
    L1: artefact[],
    L2: artefact[],
    L2X: artefact[],                     // canonical §5.12.4 extended surfaces
    L3: artefact[],
    L4: { policy: artefact[], alerting: artefact[], healing: artefact[] },
    L5: artefact[],
    GOV: artefact[],
  },
  traceability: {
    summary: object,
    chains: requirementTrace[],
  },
}
```

Each `artefact` is:

```
{
  id: string,                            // family + index, e.g. "SLI-01"
  title: string,
  desc: string,                          // one-line summary
  subtitle?: string,                     // a threshold / distribution SLI's bound with its direction (spec 1.3 good_when): '≤ 0.5 seconds', '≥ 2 consumers'
  tool: string,                          // implementation tool/family
  tags: string[],
  source: 'Declared' | 'Verified' | 'Scaffold',
                                          // 'Missing' added by Phase 3b conformance pass
  type?: string,                         // the declared type, only when metadata.annotations["observogram.artefact.type.<symbol>"] names one (see "Id families and the classifier")
  defines?: string,                      // symbol it defines, e.g. "slis.api_availability"
  refs?: string[],                       // symbols it references (for cross-ref checker)
  spec: object,                          // raw canonical section/item (drawer detail)
  mcp?: string,                          // verification timestamp from metadata.annotations.mcp.verified.<id>
}
```

## Mapping table

The adapter walks each top-level spec section into a deterministic family of layered artefacts:

| Canonical location | Layer | ID family | Notes |
|---|---|---|---|
| `spec.slis[]` | L1 | `SLI-{NN}` | `defines` = `slis.<id>` |
| `spec.slos[]` | L1 | `SLO-{NN}` | `refs` includes the SLI's symbol |
| `spec.otel` | L2 | `OTEL-01` | Single artefact summarising the OTel contract |
| `spec.telemetry.backends[]` | L2 | `BAK-{NN}` | `tags` include `signal`, `gating-{off\|warn\|enforce}`, `default` from `VersionSpec` |
| `spec.pipelines.receivers[]` | L2 | `PIP-RCV-{NN}` | |
| `spec.pipelines.processors[]` | L2 | `PIP-PRC-{NN}` | |
| `spec.pipelines.exporters.{metrics\|logs\|traces}` | L2 | `PIP-EXP-{MET\|LOG\|TRC}` | |
| `spec.storage.{metrics\|logs\|traces}` | L2 | `STO-{MET\|LOG\|TRC}-01` | |
| `spec.profiling` | **L2X** | `PROF-01` | Extended surface from spec §5.12.4 |
| `metadata.annotations.mcp.discovered.scrape_jobs` | L2 | `SCRAPE-{NN}` | Expand-level live scrape evidence |
| `metadata.annotations.mcp.discovered.metric_names_sample` | L2 | `METRIC-{NN}` | Expand-level live metric inventory |
| `spec.network` | **L2X** | `NET-01` | |
| `spec.policy_engine` | **L2X** | `POE-01` | |
| `spec.mesh[]` | **L2X** | `MESH-{NN}` | |
| `spec.collection[]` | **L2X** | `COL-{NN}` | |
| `spec.queries.recording_rules[]` | L3 | `QRY-{NN}` | `refs` extracted from `expr` via `ref:slis.X` regex |
| `spec.queries.derived_views[]` | L3 | `VIEW-{NN}` | |
| `spec.dashboards[]` | L3 | `DASH-{NN}` | `refs` from `panel_bindings.binds_to` (clickable in drawer) |
| `spec.policy.burn_rate_alerts[]` | L4 . policy | `POL-{NN}` | `refs` includes the bound SLO |
| `spec.policy.forecasts[]` | L4 . policy | `FCST-{NN}` | |
| `spec.alerting.routes[]` | L4 . alerting | `ALR-{NN}` | One per severity route |
| `spec.alerting.rules[]` | L4 . alerting | `RULE-{NN}` | One per operational alert rule (spec 1.4), titled by the rule's exact name; `tool` by engine (`PrometheusRule`, `Grafana alerting`, `Loki ruler`); the artefact model keys it on the name, so a repository's rule and a live listing's rule pair |
| `spec.remediation[]` | L4 . healing | `HEAL-{NN}` | `refs` includes the trigger alert |
| `spec.baselines` | L5 | `BASE-01` | |
| `spec.validation.chaos_experiments[]` | L5 | `CHAOS-{NN}` | `refs` = steady-state SLO + each `expected_alerts` entry |
| `spec.validation.synthetic_checks[]` | L5 | `SYN-{NN}` | |
| `metadata.imports[]` | GOV | `IMP-{NN}` | |

## Id families and the classifier

The id families above are the adapter's output vocabulary; the one place
that reads them back is `tools/lib/artefact-classify.mjs` — `ID_RULES`
(every prefix of the table, the longer first; the ids the adapter numbers
once — `OTEL-01`, `PIP-EXP-MET`, `STO-MET-01`, `PROF-01`, `NET-01`,
`POE-01`, `BASE-01` — are prefix rules, so a second id in such a family
classifies like the first) and `DEFINES_RULES` (the `defines` symbol, read
before any id). `artefact-model.classify()` delegates to it, so the diff's
identity keys, the traceability graph's node kinds and the blast-radius
weights share the Discover board's grouping (`FAMILY_HOME`: family → layer,
group, label, role). Add an id family here and in `ID_RULES` together — the
coverage test in `tools/test-artefact-classify.mjs` fails on a template
`ID_RULES` does not match, and `npm run test:golden:board` pins every
family of the catalogue packs.

The classifier reads an explicit `type` before anything else. **`adapt()`
emits no `type` on its own** — it carries one through only when the
canonical manifest declares it:

```
metadata.annotations["observogram.artefact.type.<symbol>"] = "<TypeName>"
```

where `<symbol>` is the canonical symbol the artefact's `source` is read for
(`slis.<id>`, `slos.<id>`, `telemetry.backends.<id>`, `storage.<family>`,
`dashboards.<id>`, `queries.recording_rules[i]`, `policy.burn_rate_alerts[i]`,
`alerting.routes[i]`, `remediation[i]`, `validation.synthetic_checks.<id>`,
`imports[i]` …; `DECLARED_TYPE_PREFIX` in `adapter.mjs`). The legacy
upconvert writes that annotation for a layered item that carried a `type`,
so a typed pack from another toolchain uploaded in the layered shape keeps
its types through the one canonical pipeline (`tools/test-declared-type.mjs`).
Nothing the crawler, the live fetcher or the library produces declares one,
so every pack of the catalogue adapts without a `type` key — the guard the
classifier's inert-by-default argument rests on. A family name in `type`
(`sli`, `alert_rule` …) classifies by itself; a foreign name (`PackSLI`)
needs the operator override (`OBSERVOGRAM_TAXONOMY` on a server, `--taxonomy`
for the static bundle; README "Classify Typed Packs"), which can also place
foreign ids by pattern — but never an
artefact that carries `defines`.

## Cross-references and the symbol table

The client builds a symbol table from every artefact's `defines`. Each artefact's `refs` is classified:

- **Internal** (`slis.X`, `slos.Y`, `telemetry.backends.Z`, `dashboards.W`, …) — must resolve against the symbol table. Unresolved → red outline on the card + drawer warning + ⚠ marker.
- **External imports** (`ref:platform/...`, `ref:something/...@version`) — accepted without resolving.
- **Alert references** (`alert:<name>`) — accepted. Alerts aren't first-class symbols in the spec (alerting routes don't `defines:` anything); a future spec rev could change this.

`ref-link`s in drawer panels are clickable — clicking jumps to the defining artefact's drawer (switches active layer tab, opens it, scrolls into view).

## Requirement traceability

The adapter also attaches `traceability` to the layered pack. Each chain starts
from an SLO, follows its SLI, extracts metric names from PromQL expressions,
links related recording rules, metrics exporters, live scrape evidence,
dashboard panels, and burn-rate/live alert names. The chain intentionally keeps
scrape evidence honest: when the MCP confirms scrape jobs but the pack cannot
map a specific metric back to a job, the chain records the observed job count
and a `scrape_jobs_observed_but_not_metric_specific` note instead of inventing
a dependency.

This powers the studio Traceability tab and the SLI/SLO drawer panel.

## Environment overlay

When `spec.environments` is non-empty, `applyEnvironmentOverlay(spec, envName)`:

1. Deep-clones the spec (adapter is pure — no shared mutable state across env switches).
2. Applies `env.overrides` as **dotted-path writes** — `storage.metrics.retention: 13mo` rewrites `spec.storage.metrics.retention`.
3. Surfaces the env's `target`, `criticality`, and `backends` wiring as `effective`.

Downstream consumers (adapter + conformance scorer) read the env-overlaid spec, so `metadata.bindings.criticality` reflects the env's declared tier. A tier-1 service on its staging overlay is scored against tier-2 clauses.

## CLI form

```bash
node tools/adapt-spec-pack.mjs <pack.yaml> [--env <name>] [--pretty]
```

Outputs the layered JSON to stdout. Same module that the server and the studio use.

## Regression suite

`tools/test-adapt.mjs` exercises the vendored canonical example plus a focused
requirements-traceability fixture — layer counts, `defines`/`refs` shape,
gating tags, env overlay, adapter purity (no mutation across calls), and the
SLO -> SLI -> metrics -> exporter/scrape -> dashboard -> alert chain.

`tools/test-packs.mjs` runs the adapter against every `packs/*.pack.yaml`, validates schema + asserts pack-specific conformance bands.

## Previous format — layered JSON (upconvert)

The inverse-direction sibling lives in `tools/lib/legacy.mjs`: it detects the
pre-v1.2 layered "studio-shape" JSON (the original pack format — working
examples in `examples/legacy/`) and upconverts it into a canonical v1.4
manifest, so the one canonical pipeline serves old packs too.

```js
import { isLegacyLayeredPack, upconvertLegacyPack } from './tools/lib/legacy.mjs';

if (isLegacyLayeredPack(parsed)) {
  const { canonical, report, provenance } = upconvertLegacyPack(parsed);
  // report = { format, service, mapped, scaffolded, notes }
  // provenance = { '<symbol>': 'legacy.artefact.<LAYER>.<ID>' | null }  (null: a schema-required stub)
}
```

Wired in at the ingestion gate (`POST /api/validate` — uploads convert
transparently; the response carries the `legacy` report) and as a CLI
(`npm run upconvert-legacy <file> [-o out.pack.json] [--merge <existing>] [--overwrite]`).
A canonical input is never converted: `isLegacyLayeredPack` is false on
anything with `apiVersion`/`kind`, the gate passes it through and the CLI
echoes it (exit 0). A legacy input whose `-o` target already holds a canonical
pack merges into it (`mergeUpconvert({ canonical, provenance }, existing)`):
the existing pack wins for every artefact it has, the upconvert only adds
artefacts whose legacy record the existing pack has never seen, added items
get their marker re-indexed to their final position, and the `legacy.*` block
is refreshed — so a real value never regresses to a scaffold; `--overwrite`
restores the plain write. `report.scaffolded` and `legacy.scaffoldCount` count
every `crawler.scaffold.*` key, the six shared-section markers (`otel`,
`pipelines.*`) included. `npm run pack-conformance -- <pack>` lists the
placeholders that remain ([`DOWNSTREAM.md`](DOWNSTREAM.md) §11).

Conversion contract:

- **Lossless** — every legacy artefact is kept verbatim in
  `metadata.annotations["legacy.artefact.<LAYER>.<ID>"]`; an item's `type`,
  when it has one, is also kept as the declared type of the symbol it maps to
  (`observogram.artefact.type.<symbol>`, see "Id families and the
  classifier"), so the adapter emits it again.
- **Honest** — the layered format never carried machine detail (exprs,
  windows, channels); every placeholder a schema-required field forces is
  marked `crawler.scaffold.<symbol>` so it projects as Scaffold, never
  Declared. Legacy `GAP` items are always scaffolds. (`sourceOf` honours a
  second prefix, `mcp.scaffold.<symbol>`, for the placeholders the live
  fetcher is forced to invent — see `MCP_INTEGRATION.md`.)
- **Two kinds of symbol.** An *artefact symbol* is exactly an id `sourceOf`
  is asked for (`slis.<id>`, `slos.<id>`, `otel`, `telemetry.backends.<id>`,
  `pipelines.receivers[i]`, `pipelines.exporters.<signal>`,
  `queries.recording_rules[i]`, `dashboards.<id>`,
  `dashboards.<id>.panels.<panel>`, `policy.burn_rate_alerts[i]`,
  `alerting.routes[i]`, `alerting.rules[i]`, `remediation[i]`, `baselines`,
  `validation.synthetic_checks.<id>`, …); a marker on it parks the artefact as
  Scaffold. Any other dotted or indexed path under one — a *field symbol*
  such as `otel.semconv`, `telemetry.backends.<id>.endpoints`,
  `alerting.routes[0].channels[1]`, `metadata.owners` — matches nothing in
  `sourceOf` and is conformance evidence only: the crawler writes those for
  the values it invents without moving the artefact in Discover or Compare
  (`tools/lib/pack-conformance.mjs` reads both; `DOWNSTREAM.md` §11.1).
- **Deterministic** — same input, same manifest (timestamps only via
  `opts.now`).

`tools/test-legacy-pack.mjs` gates the four restored examples on every
`npm test`; `tools/test-upconvert-merge.mjs` gates the merge. The lossless
record key does not say which L4 sublist (policy / alerting / healing) an item
came from, so two L4 items sharing an id across sublists collide in the record
and in the merge provenance — left as is, because changing the key would break
the record of packs already upconverted downstream.
