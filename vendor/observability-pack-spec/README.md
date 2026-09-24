# vendor/observability-pack-spec

A pinned copy of the [MoebiusX/otel-observability-pack](https://github.com/MoebiusX/otel-observability-pack)
spec. The studio validates, adapts, and renders against this copy — never against a network fetch — so it
is reproducible offline and drift against upstream is detectable.

## Contents

| Vendor path | Upstream path |
|---|---|
| `v1.3/observability-pack.schema.json` | `schema/observability-pack.schema.json` |
| `v1.3/spec.md` | `spec/ObservabilityPack-Spec.md` |
| `v1.3/examples/payment-service.pack.yaml` | `examples/payment-service.pack.yaml` |
| `v1.3/docs/maturity-model.md` | `docs/maturity-model.md` |

`VERSIONS.json` records the spec version, the upstream ref and commit, the fetch timestamp, and the
per-file SHA-256 and byte count of every vendored file (byte for byte the upstream blob — `git show
<commit>:<upstream path> | sha256sum` reproduces each checksum). Spec 1.3 (RFC-0002, accepted 2026-09-23)
adds `good_when: below | above` on `threshold` and `distribution` SLIs; it validates every 1.2 pack
unchanged, so one version directory is vendored at a time — `tools/lib/validator.mjs` `SPEC_VERSION`
names it, and every path in the repo is derived from that constant.

## Refreshing

```bash
# Sync to the upstream default branch (develop) HEAD
node tools/sync-spec.mjs

# Sync to a specific branch, tag or commit
node tools/sync-spec.mjs --ref 98be4ae8

# Verify on-disk files match VERSIONS.json (CI-friendly)
node tools/sync-spec.mjs --check
```

The version directory is read from the fetched spec's own header (`| Spec version | 1.3 |`), never typed:
a spec bump lands in a new `v<x.y>/` and `VERSIONS.json` follows it. The previous directory is removed in
the commit that moves `SPEC_VERSION` (git history keeps it). The sync script uses the `gh` CLI for
authentication and rate-limit headroom; no npm deps.

The studio links into the upstream repository at the vendored commit (`upstream.commit`), never at a branch:
upstream `main` still serves 1.2 while `develop` carries 1.3, so a link labelled with the version must open the
file the label names. After a refresh, move the hrefs in `studio/index.html` (footer), `studio/schema-view.mjs`
and `studio/conformance-view.mjs` to the new commit; `tools/test-validator.mjs` names the ones left behind.
