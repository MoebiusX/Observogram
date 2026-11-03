# Version-Aware Compilation — Product Profiles

> The compiler used to be version-blind. It hard-coded one shape per target —
> Grafana `schemaVersion: 41`, the OTel `logging` exporter, a fixed Alertmanager
> receiver — and emitted it no matter what version the pack declared. That makes
> the output a *heuristic*, not a faithful artefact: a dashboard compiled for
> "Grafana 9" came out identical to one for "Grafana 13", and a rule file with
> `keep_firing_for` would fail to load on a Prometheus older than 2.42 or on
> VictoriaMetrics. This document describes the profile system that fixes it.

## The two concerns, kept separate

There are two different jobs and they must not be conflated:

1. **Equality / drift** — *do two packs describe the same behaviour?* This is
   anchored on the **canonical spec**, which is version-independent. It lives in
   [`tools/lib/artefact-model.mjs`](../tools/lib/artefact-model.mjs) and is
   documented in [DIFF.md](DIFF.md). It deliberately does **not** call the
   compiler, so a compiler heuristic can never launder its way into the
   equality check.

2. **Deployment fidelity** — *will the emitted artefact actually load and behave
   on the target product+version?* This is the **compiler's** job, and it is
   what profiles add. A profile is the canon for one product at one version
   range.

`artefact-model.mjs` has no import of `compile.mjs`, and `profiles.mjs` has no
import of `artefact-model.mjs`. The two stay decoupled on purpose.

## Two tiers: protocols (canon) and products (bindings)

The registry is split into two modules because a *version-determining fact*
belongs to a **wire/serialization protocol**, not to any one product:

- [`tools/lib/protocols.mjs`](../tools/lib/protocols.mjs) — the **versioned
  canon**. Each protocol (`prometheus-rule-format`, `promql`,
  `grafana-dashboard-schema`, `grafana-alerting-provisioning`,
  `otel-collector-config`, `alertmanager-config`) has its own version line and a
  set of **features**, each one an evidence-anchored
  `{ value, since, evidence }` record. `keep_firing_for` is a fact of the
  *rule format* at 2.42 — it is written **once**, here.
- [`tools/lib/profiles.mjs`](../tools/lib/profiles.mjs) — the **product
  bindings**. A product at a version band *speaks* a set of
  `(protocol, protocolVersion)` pairs. Multiple products that converge on the
  same protocol version (Prometheus 2.45, Thanos, Mimir all consume the
  Prometheus rule format) share the feature set without duplicating it.

This is why PromQL can be modelled as its own protocol associated with several
products, and why VictoriaMetrics — which consumes the same rule format but
lacks `keep_firing_for` — is expressed as a one-line **dialect override** on its
product band rather than a forked copy of the format.

```
 protocol  prometheus-rule-format @ 2.42  → { keepFiringFor: true,  … }
   ▲ speaks            ▲ speaks                       ▲ speaks + dialect override
 prometheus 2.45    thanos                       victoriametrics (keepFiringFor:false)
```

Grafana deliberately does **not** bind the `promql` protocol: its PromQL
capability depends on the *datasource* Prometheus, not on the Grafana version.
Encoding it on Grafana would be dishonest.

## The product registry

Each product in `profiles.mjs` lists **version bands** newest-first; each band
carries a semver `range`, the protocols it `speaks`, and an optional `dialect`
override. `resolveProfile(product, version)` composes the bound protocol feature
sets into one flat **knobs** map (dialect overrides win), so downstream
`compile*` code reads `profile.knobs.<knob>` exactly as before — the binding
model is invisible to the emitter.

Band selection:

- A version that matches a band's range → that band, `matched: true`.
- A version **newer** than the newest band's floor → the newest band, with
  `matched: false, extrapolated: true` ("treated as the latest line we know").
- Anything else (below all bands, or no/unparseable version) → the
  `default: true` band, `matched: false, extrapolated: false`.

A small pure-JS semver matcher (`satisfies`, `parseVersion`, `compareVersions`,
`rangeFloor`, now living in `protocols.mjs`) drives selection so both modules
stay browser-importable with zero dependencies — they never pull in the
Node-only `semver` package.

### What each profile encodes (real, documented differences)

| Product | Version knob | Why it matters |
| --- | --- | --- |
| **Grafana** | `schemaVersion` (37 → 42), `datasourceForm` (`string` &lt; v10, `object` ≥ v10), `panelTargetDatasource` | Pre-v10 referenced datasources by bare uid string; v10+ requires `{type, uid}`. Emit the wrong form and panels fail to bind. |
| **Prometheus** | `keep_firing_for` (added in 2.42), `rule_query_offset` (3.x) | A rule file using `keep_firing_for` is rejected by Prometheus &lt; 2.42 and by VictoriaMetrics/vmalert. |
| **VictoriaMetrics** | `keep_firing_for: false` always | vmalert consumes Prometheus rule format but never supports `keep_firing_for`. |
| **OTel Collector** | `debugExporter` (`logging` → `debug` rename in 0.86), `telemetryMetricsReaders` (`address` deprecated for `readers`) | A config naming the wrong exporter fails to start on the target version. |
| **Alertmanager** | `msteamsV2` (`msteamsv2_configs` in 0.28), `msteams` (`msteams_configs` in 0.26) | Routing a Teams channel to a receiver the version doesn't have breaks the config. |
| **Grafana-managed rules** | `recordBlock`, `keepFiringFor`, `notificationSettings` | Unified-alerting rule shape evolved across Grafana 9 → 12. |
| **Blackbox exporter** | `grpcProber` (the grpc prober arrived in 0.20) | A `grpc://` synthetic check compiled for an older exporter is skipped with a warning instead of emitted as a module the exporter cannot load. |

## How the compiler selects a version

The compiler reads the declared version straight from the pack — it does not
guess:

- **Grafana dashboard** → `spec.dashboards[].provider.version` (and `kind`).
- **Prometheus rules** → the `version.declared` of the backend serving the
  `metrics` signal (`spec.telemetry.backends[]` where `signal: metrics`).
- **Alertmanager** → the backend whose `product` matches `alertmanager`.
- **OTel Collector** → `spec.otel.collector.version` when present.

Any of these can be overridden explicitly with `compile(canonical, target,
{ product, version })` — e.g. a deploy UI that lets the engineer target a
specific install. The override always wins.

`compile()` returns the resolved profile alongside the output so callers can
show *which* product+version the artefact was shaped for:

```js
const out = compile(pack, 'grafana-dashboard');
// out.profile = { product:'grafana', version:'12.3', band:'grafana-12',
//                 label:'Grafana 12.x', tractability:'native', matched:true,
//                 extrapolated:false,
//                 protocols:[ { protocol:'grafana-dashboard-schema', version:'gds-12', … },
//                             { protocol:'grafana-alerting-provisioning', … } ] }
```

`out.profile.protocols` lists exactly which protocol versions the artefact was
shaped against, each with its own `tractability` — so a UI can show "this rule
file speaks prometheus-rule-format 2.42 (vendored-go-needed)."

## Tractability — JS vs vendored Go schemas

This repo's hard constraint is that everything under `tools/lib/` is **pure ESM,
browser-importable, deps = `express` only**. The studio imports the compiler
directly in the browser. That bounds how faithfully each family can be modelled,
so every **protocol** carries an honest `tractability` marker (and each product
surfaces the markers of the protocols it speaks):

| Marker | Meaning | Protocols |
| --- | --- | --- |
| `native` | The version-determining shape is small and fully expressible in JS — we implement it faithfully. | `grafana-dashboard-schema` (schemaVersion + datasource form) |
| `partial` | We model the high-impact features; the full schema is larger than we encode, and unmodelled fields pass through. | `otel-collector-config`, `alertmanager-config`, `grafana-alerting-provisioning`, `blackbox-exporter-config` |
| `vendored-go-needed` | **Faithful validation** requires the product's own Go schema/parser. We emit best-effort and flag it; we do **not** claim canonical fidelity. | `prometheus-rule-format`, `promql` (`promtool`/`rulefmt`) |

### Why some families need vendored Go schemas

The observability canon is Go-first. The authoritative validators are:

- **Prometheus** — `rulefmt` / `promtool` parse and check rule files. There is
  no official JS port; PromQL parsing alone is a large grammar.
- **Grafana** — `@grafana/schema` is the dashboard schema, but it is heavyweight
  and churns release-to-release; vendoring it would break the no-deps /
  browser-importable constraint.
- **OTel Collector** — the config is validated by the Collector's own Go
  `confmap` unmarshaller against each component's struct tags.

We **shape** these artefacts correctly per version (the knobs above), which is
the part that determines whether they load. We do **not** claim to *validate*
them the way the vendored Go tool would. When that level of fidelity is needed,
it must run **server-side and be optional** — never imported into the browser
bundle. The `tractability` marker is the contract that keeps us honest about the
difference between "shaped for the version" and "validated by the canon."

## Adding a protocol version, product, or band

1. **New protocol feature/version** → add it to `PROTOCOLS` in `protocols.mjs`,
   newest-first, as a `{ value, since, evidence }` record. The `evidence`
   string (changelog/PR/doc reference) is mandatory — facts are anchored.
2. **New product band** → add a band to the product's `bands` array in
   `profiles.mjs`, newest-first, with a semver `range` and a `speaks` map
   binding `(protocolId: selector)`. Use `dialect` only for genuine product
   divergences (e.g. MetricsQL).
3. **New product** → register it under a new key and add aliases to
   `normalizeProduct`.
4. Thread any new knob into the relevant `compile*` function — gate the
   version-specific output on `profile.knobs.<knob>`.
5. Add an assertion to [`tools/test-profiles.mjs`](../tools/test-profiles.mjs)
   proving the compiler emits *differently* across the new boundary. A profile
   with no observable effect on the output is not a profile.
6. Bump the affected `upstream.latestKnown` if you verified against a newer
   release, and run `npm run drift:profiles` to confirm the baseline.

## Keeping in sync as new versions ship

The profile facts are hand-curated — someone has to read a changelog to know a
new feature landed. What **can** be automated is detecting that a new release
exists at all. [`tools/drift-profiles.mjs`](../tools/drift-profiles.mjs)
(`npm run drift:profiles`) reads each registry entry's
`upstream { repo, latestKnown }`, queries the GitHub Releases API for the latest
stable tag, and warns when an upstream has moved past what we've profiled:

```
  ⚠ open-telemetry/opentelemetry-collector: upstream 0.153.0 > profiled 0.96
      referenced by: product:otel-collector, protocol:otel-collector-config
      → review the changelog and add a band/protocol version.
```

It is advisory (not part of the `lint` / `test` / `build` gate): offline it
reports "could not check" and exits 0, so it never blocks a build it can't
evaluate. Pass `--strict` to fail on unreachable upstreams (for a scheduled CI
job), `--json` for machine output, and set `GITHUB_TOKEN` for a higher rate
limit. Exit codes: `0` current, `1` stale, `2` `--strict` + unreachable.

## Public API

From `tools/lib/protocols.mjs`:

- `resolveProtocolVersion(protocolId, selector)` → the resolved protocol version
  with **flattened** features.
- `listProtocols()` → every protocol and its version lines (for UIs / docs /
  the drift checker).
- `parseVersion`, `compareVersions`, `satisfies`, `rangeFloor` → semver
  primitives.

From `tools/lib/profiles.mjs` (also re-exported from `compile.mjs`):

- `resolveProfile(product, version)` → frozen `{ product, family, tractability,
  version, band, label, knobs, protocols, matched, extrapolated }`.
- `listProfiles()` → every product, its bands, and the protocols each speaks.
- `listProtocols`, `satisfies(version, range)`, `parseVersion(v)` —
  re-exported from `protocols.mjs`.

From `tools/lib/compile.mjs`:

- `compile(canonical, target, opts)` now accepts `opts.product` / `opts.version`
  overrides and returns `out.profile`.
- Every `compile*` function accepts an `opts` object and honours
  `opts.profile` (a pre-resolved profile) or resolves one from the pack.
- `listTargets()` entries now include `family`, the registry key used for
  profile resolution.
