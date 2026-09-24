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
