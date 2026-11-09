# vendor/observability-pack-spec

A pinned copy of the [MoebiusX/otel-observability-pack](https://github.com/MoebiusX/otel-observability-pack)
spec. The studio validates, adapts, and renders against this copy — never against a network fetch — so it
is reproducible offline and drift against upstream is detectable.

## Contents

| Vendor path | Upstream path |
|---|---|
| `v1.5/observability-pack.schema.json` | `schema/observability-pack.schema.json` |
| `v1.5/spec.md` | `spec/ObservabilityPack-Spec.md` |
| `v1.5/examples/payment-service.pack.yaml` | `examples/payment-service.pack.yaml` |
| `v1.5/docs/maturity-model.md` | `docs/maturity-model.md` |

`VERSIONS.json` records the spec version, the upstream ref and commit, the fetch timestamp, and the
per-file SHA-256 and byte count of every vendored file (byte for byte the upstream blob — `git show
<commit>:<upstream path> | sha256sum` reproduces each checksum). Spec 1.5 (RFC-0004, proposed 2026-11-06)
lets a chaos experiment say how it is run — `engine: in-process | custom`, `schedule: on-demand | ci` —
and what its newest run showed (`last_result`, `at` and `outcome` required), so it validates every 1.4
pack unchanged (as 1.4, RFC-0003's `alerting.rules[]`, validated every 1.3 pack, and 1.3, RFC-0002's
`good_when`, every 1.2 pack); one version directory is
vendored at a time — `tools/lib/validator.mjs` `SPEC_VERSION` names it, and every path in the repo is
derived from that constant.

## Refreshing

```bash
# Sync to the upstream default branch (develop) HEAD
node tools/sync-spec.mjs

# Sync to a specific branch, tag or commit
node tools/sync-spec.mjs --ref 5be3baa7

# Verify on-disk files match VERSIONS.json (CI-friendly)
node tools/sync-spec.mjs --check
```

The version directory is read from the fetched spec's own header (`| Spec version | 1.5 |`), never typed:
a spec bump lands in a new `v<x.y>/` and `VERSIONS.json` follows it. The previous directory is removed in
the commit that moves `SPEC_VERSION` (git history keeps it). The sync script uses the `gh` CLI for
authentication and rate-limit headroom; no npm deps.

The studio links into the upstream repository at the vendored commit (`upstream.commit`), never at a branch:
upstream `main` still serves 1.2 while `develop` carries 1.5 (commit 5be3baa7, the RFC-0004 merge), so a link labelled
with the version must open the file the label names. After a refresh, everything that carries the old commit follows
`upstream.commit`:

- the studio hrefs in `studio/index.html` (footer), `studio/schema-view.mjs` (schema and spec links) and
  `studio/conformance-view.mjs` (`RUBRIC_URL`) — `tools/test-validator.mjs` names the ones left behind;
- `SPEC_LINK.href` in `tools/lib/brand.mjs` — brand.mjs builds the footer anchor (`SHELL_ANCHORS.footerLinks`) from it, and
  `tools/test-brand.mjs` asserts that anchor is in `studio/index.html` exactly once, so a stale href fails `anchor footerLinks
  once in studio/index.html` and every branded shell render throws `shell anchor missing or repeated (footer links)`;
- the three audit-report HTML goldens in `tools/fixtures/golden/audit-report/` that carry the spec link —
  `npm run test:golden:audit-report:update`, then check the diff moves one href each and nothing else;
- the conformance-view capture `tools/fixtures/golden/conformance-view/payment-service.bare.html`, which
  `tools/test-waivers.mjs` compares byte for byte and has no update flag — recapture it as that test's header describes
  (the view rendered headless over the document stub) or move its one href by hand.
