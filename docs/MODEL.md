# The ObservabilityPack model

The studio is a faithful renderer of the [ObservabilityPack spec
v1.3](../vendor/observability-pack-spec/v1.3/spec.md). The canonical model
— `apiVersion`, `kind`, `metadata`, `spec`, the ten dimensions L1–L5 — is
defined there; this document covers only the parts the studio adds or
shapes for the display, not the canonical model itself.

For the canonical model, read:

- **[`../vendor/observability-pack-spec/v1.3/spec.md`](../vendor/observability-pack-spec/v1.3/spec.md)** — §3 the conceptual model, §4 the manifest shape, §5 each dimension with conformance, §7 the maturity rubric summary.
- **[`../vendor/observability-pack-spec/v1.3/docs/maturity-model.md`](../vendor/observability-pack-spec/v1.3/docs/maturity-model.md)** — the full tier-3 → tier-2 → tier-1 clause rubric.
- **[`../vendor/observability-pack-spec/v1.3/examples/payment-service.pack.yaml`](../vendor/observability-pack-spec/v1.3/examples/payment-service.pack.yaml)** — the canonical example.

## What the studio projects — L2X (Extended Surfaces)

The canonical spec carves the manifest into ten dimensions across five
layers (L1 Contract, L2 Telemetry, L3 Insight, L4 Action, L5 Validation),
plus governance. The spec also defines optional extended technology
surfaces in `spec.profiling`, `spec.network`, `spec.policy_engine`,
`spec.mesh[]`, and `spec.collection[]`. The studio projects those canonical
fields into **L2X · Extended Surfaces**.

L2X groups the optional, telemetry-adjacent spec sections that the
spec carved out as "extended technology surfaces" in §5.12.4 of the spec:

| Spec section | Artefact ID | Tool family |
|---|---|---|
| `spec.profiling` | `PROF-01` | Pyroscope, parca, … |
| `spec.network` | `NET-01` | Cilium, eBPF observability |
| `spec.policy_engine` | `POE-01` | OPA bundles |
| `spec.mesh[]` | `MESH-NN` | Envoy, Consul, Kong, Traefik |
| `spec.collection[]` | `COL-NN` | Fluent Bit, Beats, Vector, Alloy |

These all consume telemetry the same way L2 does, but they're optional and
they reference backends declared in `spec.telemetry.backends[]`. Rendering
them as a separate L2X tab keeps L2 focused on the core "produce + collect +
persist" loop while still surfacing the extended surfaces when a pack declares
them or when the crawler/live MCP materialises them from discovered backends.
The L2X tab is **hidden when empty** so packs without extended surfaces look
uncluttered.

## What the studio reads on an SLI — the bound and its direction (spec 1.3)

The SLI fields the studio's readers project (`tools/lib/adapter.mjs`, the dashboards, the
burn-rate generator, the library engine, the editor): `id`, `type` (`ratio` | `threshold` |
`distribution` | `custom`), `description`, `semconv_metric`, `good` / `total` (ratio), `query`
(threshold, distribution), `expression` (custom), `threshold` (the bound, in `unit`),
`percentile` (distribution), `unit`, `owner` — and, since spec 1.3, `good_when: below | above`
on `threshold` and `distribution` SLIs: which side of the bound is good. `below` is the
default and the only meaning a 1.2 pack could express (a ceiling: a sample is good at or below
the bound — latency, lag, error rate, queue age); `above` makes the bound a floor (good at or
above it — in-sync replicas, connected consumers, free capacity). The bound itself is good
either way. Absent means `below`, and one helper says so for every reader
(`tools/lib/good-when.mjs` `goodWhen(sli)`; the browser copy `studio/sli-direction.mjs`):
the generator's comparison (`> bool` a ceiling, `< bool` a floor), the tile's colour
orientation, the card's subtitle (`≤ 0.5 seconds`, `≥ 2 consumers`) and the editor's
*good when* control all derive from it. The schema forbids the field on `ratio` and `custom`
SLIs (`matches forbidden 'not' schema`).

## What the studio adds — source tag taxonomy

Each artefact in the layered display carries one of three source tags
derived from canonical content:

| Tag | Derivation |
|---|---|
| `Declared` | The section is present in the manifest. This is the default. |
| `Verified` | The canonical pack has a flat annotation key `metadata.annotations["mcp.verified.<symbol>"]` set to a timestamp. The [refresh-live-pack workflow](../.github/workflows/refresh-live-pack.yml) writes these when MCP confirms an artefact. |
| `Missing` | Computed by the conformance pass: required at the declared `criticality` per the rubric, but absent from the manifest. See [CONFORMANCE.md](CONFORMANCE.md). |

The flat-key form is forced by the schema — `metadata.annotations` is declared as `{string: string}` with `additionalProperties: {type: string}`. Nested-object annotations would not validate.

## What the studio adds — environment overlay

A canonical pack with `spec.environments.<name>.{target, criticality, backends, overrides}` ships to the studio with all environments visible. The adapter takes an environment name (default = first env in the map), applies the env's dotted-path overrides (e.g. `storage.metrics.retention: 13mo`), and rewrites `metadata.bindings.criticality` + `metadata.bindings.default_target` from the env's effective values. Conformance is then scored against the effective tier — e.g. a tier-1 service on its `staging` overlay is scored against tier-2 clauses, because the staging environment declares itself tier-2.

See [ADAPTER.md](ADAPTER.md) for the full canonical → layered mapping.
