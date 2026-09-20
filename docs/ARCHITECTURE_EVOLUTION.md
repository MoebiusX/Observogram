# Architecture Evolution Plan

Status: adopted 2026-06-12. Owner: maintainer. Scope: reduce update friction
(spec bumps, MCP/tool contract changes, product version bands) without
breaking current behaviour. No TypeScript migration, no rewrite, browser-safe
core preserved, dependency footprint unchanged.

Companion docs: [REFACTORING_PLAN.md](REFACTORING_PLAN.md) (hygiene items —
this plan sequences several of them), [BRANCHING.md](BRANCHING.md) (the
per-commit and end-of-turn bar every slice ships under).

---

## 1. Top maintainability risks (ranked)

1. **Compiler output changes ship unverified.** Only the crawler has a golden
   gate; the four target compilers (the artefacts users deploy to production
   alerting) had none. Mitigated by the per-target, per-band golden suite
   (`npm run test:golden:compile`, added in this plan's first slice).
2. **MCP tool names live in three places.** The `PROBES` table in
   `tools/fetch-live-pack.mjs` is data-driven, but core tools are hardcoded at
   call sites, `tools/lib/grafana-mcp-bridge.mjs` carries its own set, and the
   deploy dispatch in `server/index.mjs` a third. A rename upstream can be
   patched in one place and missed in another — fetch works, deploy 404s.
3. **No `exports` map in package.json.** Every shipped file is de-facto
   public API; internal moves are breaking changes, which freezes refactoring.
4. **`server/index.mjs` (~2,400 lines) is the integration bottleneck.**
   Routes, deploy orchestration, pack registry state, SSRF guards and GitHub
   crawl helpers in one file; every feature touches it.
5. **`studio/app.mjs` (~4,000 lines) + `studio/compare-view.mjs` (~3,100)
   god modules.** The upload/crawl panel alone is ~40% of app.mjs; the view
   router is a hardcoded switch.
6. **Capability output shapes have no schema gate.** Each probe's `adapt()`
   normalises, but nothing validates the response; an upstream shape change
   degrades silently to an empty pack instead of failing loudly.
7. **`mini-yaml.mjs` silently accepts unsupported YAML constructs**
   (REFACTORING_PLAN item 7) — input-side correctness risk at the front door.
8. **The upgrade flow is manual steps with no umbrella.** `sync-spec:check`,
   `drift:profiles`, validator pinning and golden updates are separate
   commands a human must remember in order.

## 2. Target architecture (8 components, dependency arrows point down only)

| # | Component | Lives | Browser-safe | Owns |
|---|-----------|-------|--------------|------|
| 1 | contracts | `tools/lib/contracts/` (new) | yes (data-only) | protocol registry, MCP capability/tool registry incl. aliases + deprecation metadata, deploy-tool table, response shapes |
| 2 | core | `tools/lib/` | yes | compile, adapter, crawler, diff, conformance, validator, legacy, retrofeed, profiles, artefact-model + primitives (mini-yaml, promql, slug) |
| 3 | mcp-client | `tools/lib/` (node) | no | JSON-RPC/SSE transport, session, the compatibility facade (`resolveCapability`) |
| 4 | acquisition | `tools/` (node) | no | fetch-live orchestration, GitHub crawl, fetch-validators |
| 5 | server | `server/` | no | thin Express routers per domain; auth/tenancy/workspace stay as-is |
| 6 | studio | `studio/` | yes | view registry, state, views |
| 7 | cli | `tools/cli.mjs` | no | thin wrapper over acquisition + core |
| 8 | upgrade-rig | `tools/` (dev-only) | no | sync-spec, drift-profiles, golden updaters, api-snapshot |

Rules:

- `contracts` imports nothing; data tables plus lookup resolvers only. No
  branching logic — the moment a registry contains control flow, it is code
  again and the boundary is lost.
- `core` imports only `contracts` and its own primitives. Enforced with
  ESLint `no-restricted-imports` (REFACTORING_PLAN item 10, adopted as-is).
- Every external contract fact (tool name, alias, version band, feature knob,
  response shape) lives in exactly one registry row. Code absorbs nothing.

Upgrade friction drops because each upstream change lands in one layer:
tool rename → one `contracts` row; new product band → one `profiles.mjs`
entry + one golden file; spec bump → `sync-spec` + validator + goldens.

## 3. Design decisions

### 3.1 Data-driven contract registries

`tools/lib/contracts/mcp-capabilities.mjs`, modelled on the existing
`PROTOCOLS` shape: one frozen table mapping capability id → candidate tools
(order = fallback order), kind (`core` / `probe` / `deploy` / `version`),
optional deprecation metadata, and a response-shape key. The `PROBES`
candidate lists, the hardcoded core tools, the build-info probe table and the
deploy dispatch map all become rows. `adapt()` functions stay in code — they
are domain logic, keyed by capability id, not registry content.

A coverage guard test asserts no MCP tool-name string literal exists outside
`contracts/` (greps `tools/` and `server/` call sites). It lands in the same
PR as the registry and keeps it honest permanently.

### 3.2 MCP compatibility facade

`resolveCapability(client, id, { advertised })` wraps the existing candidate
cascade without changing semantics: filter to advertised tools, try in
registry order, record the resolution as a pack annotation
(`mcp.toolResolution.<capability>`), warn once per process when a deprecated
alias served the call. Deprecation windows are enforced in CI, not at
runtime: a release whose version exceeds an alias's `removeAfter` fails until
the row is deleted (major) or the window is extended deliberately.

**Schema checks are tolerant by design**: response-shape validation requires
the critical fields a capability's `adapt()` actually consumes and ignores
extra fields entirely. The gate exists to catch *removals and renames* of
fields we depend on, not to pin vendors' full payloads — additive upstream
changes must never break a fetch.

### 3.3 Package and API boundary hardening — two phases

- **Phase 1 (compat, a minor release):** add an `exports` map naming the
  curated surface (`.`, `./compile`, `./crawler`, `./diff`, `./validator`,
  `./profiles`, `./contracts`) **plus a `"./*": "./*"` passthrough** so no
  existing deep import breaks. README documents: import from the named
  subpaths; anything else may move in any release. An API-surface snapshot
  test (`tools/fixtures/api-surface.json`) pins the curated exports; CI fails
  on any undocumented change.
- **Phase 2 (tightening, the next major, only after one full minor has
  shipped with phase 1):** remove the passthrough. Internal files become
  genuinely private; decomposition is free forever after.

### 3.4 Decomposition of large modules — server first, UI conservative

Server (has the better safety net via `server/test-smoke.mjs`), strictly
move-only PRs, risk-ascending order: pure helpers (SSRF guards, GitHub crawl,
token helpers) → deploy cluster (`server/routes/deploy.mjs` +
`server/deploy-helpers.mjs`, gaining first unit tests on the Grafana
transforms) → remaining routers → pack registry last (tenancy-scoped state,
extracted only once index.mjs is small enough to reason about load order).

Studio is sequenced conservatively and **after** the server work proves the
move-only discipline: (1) view registry replacing the switch in `app.mjs`,
one mechanical PR, nothing else; (2) extract the upload/crawl panel; (3)
extract the deploy modal; (4) split `compare-view.mjs` along its existing
internal seams (traceability, benchmark) one view per PR. The shared mutable
`state` object and the call-time render cycles are **kept deliberately** —
they are safe, and replacing them is rewrite bait with no user-visible
payoff. Every studio PR is browser-verified per BRANCHING.md before merge.

## 4. Sprint plan

Sprint = ~2 weeks of maintainer time. Each sprint ends releasable.

### Sprint 1 — safety net and contracts (nothing else)

Deliverables: (a) per-target, per-band compile golden suite wired into
`npm test`; (b) `contracts/mcp-capabilities.mjs` absorbing PROBES + core
tools + build-info probes, with the tool-name guard test; (c) tolerant
response-shape checks for the five discovery probes against recorded
fixtures.

Measurable gates:
- `npm run test:golden:compile` exists, runs in the aggregate, and a
  deliberate knob flip (e.g. vm `keepFiringFor`) fails exactly the affected
  goldens — demonstrated, not assumed.
- Guard test fails on any new tool-name literal outside `contracts/`.
- Zero behaviour change: `fetch-live` output byte-identical (timestamps
  aside) before/after the registry extraction; full suite green.

Rollback: all additive; revert any single PR restores status quo.
Explicitly out of scope (moved to Sprint 2): exports map, upgrade umbrella.

### Sprint 2 — server decomposition, facade, exports phase 1

Deliverables: pure-helper extractions; deploy routes/helpers module with new
unit tests; `resolveCapability()` adopted by fetch-live **and** deploy;
exports map with passthrough + API snapshot test; `npm run upgrade:check`
umbrella (sync-spec:check + drift:profiles + goldens).

Measurable gates:
- `server/index.mjs` under 400 lines; route inventory before/after identical
  (smoke test enumerates and exercises every route).
- One end-to-end deploy + rollback round-trip against a live MCP recorded in
  the PR.
- `npm pack` + install + import of every curated subpath passes in a clean
  temp dir.
- Compile goldens byte-identical across the whole sprint (proof the server
  work had no output-space side effects).

Rollback: move-only PRs revert cleanly; facade PR keeps the legacy cascade
behind `OBSERVOGRAM_LEGACY_MCP_RESOLVE=1` for one release.

### Sprint 3 — studio decomposition (conservative) and release mechanics

Deliverables: view registry PR; upload-panel extraction; deploy-modal
extraction; `compare-view` split (one view per PR, stop early if any PR
proves hairy — the split is severable); weekly scheduled `upgrade:check`
workflow that opens an issue on drift; tag-triggered `npm publish
--provenance`; `docs/DEPRECATIONS.md` adopted.

Measurable gates:
- Each studio PR: `node --check` green, full suite green, browser-verified
  checklist in the PR body (load pack, every tab renders, upload, compare,
  deploy modal opens), zero console errors.
- `app.mjs` reduced by ≥40%; `compare-view.mjs` by ≥50% (move-only — total
  studio line count roughly constant).
- One dry-run release through the new gate end-to-end.

Unchanged intentionally: `state.mjs` contract and persistence whitelist; the
render-cycle pattern; `app.css`; `mini-yaml` (its guardrail fix is a good
standalone PR, not on this critical path).

## 5. CI and test hardening

- **Contract tests:** per capability, recorded response fixtures under
  `tools/fixtures/mcp/`; `adapt(fixture)` produces the expected canonical
  fragment; tolerant shape check (critical fields required, extras allowed).
- **Golden outputs by version band:** `tools/test-golden-compile.mjs` —
  fixture packs × targets × every profile band that changes a knob, byte
  compared, `--update` to regenerate. Rule: a golden diff in a PR is fine;
  an *unexplained* golden diff is a blocker — restate the diff in the PR
  description.
- **API snapshot:** curated export names + kinds pinned in
  `tools/fixtures/api-surface.json`; CI fails on diff; updates require
  `--update` plus a changelog line.
- **Drift guards:** `sync-spec --check` on every PR (blocking);
  `drift:profiles` weekly scheduled, opens a pinned issue (non-blocking);
  tool-name literal guard (blocking); discovery-count-to-zero check between
  consecutive live fetches (warns — catches silent contract breaks).
- **Release gates:** patch = goldens byte-identical, api-surface untouched.
  minor = golden changes explained in release notes, api-surface additive
  only, deprecations may be announced. major = removals only for
  deprecations whose window expired (CI-enforced). Publish only via the
  tag-triggered workflow.

## 6. Deprecation policy

Applies to: npm export subpaths and symbols, CLI commands/flags, HTTP routes
and response fields, MCP capability aliases, pack annotation keys. Not:
studio internals, files outside the exports map, anything marked
experimental.

- **Alias lifetime:** at least 2 minor releases **and** 90 days, whichever is
  longer. MCP aliases carry `removeAfter: <version>` in the registry; CI
  blocks releases past an alias still present.
- **Warning lifecycle:** release N — works + one warning per process naming
  the replacement and removal version + DEPRECATIONS.md row + changelog
  `Deprecated` entry. N+1 — docs show only the new name. Removal — major
  only, window expired, changelog `Removed` with replacement.
- **Semver mapping:** new alias/name = minor. New warning = minor. Removing
  a deprecated name, narrowing exports, dropping a band = major. Output
  corrections ride at least a minor unless a clear correctness fix (state it
  either way).
- **Changelog:** every Deprecated/Removed entry states old → new, first
  warned version, removal version, one-line migration. Nothing is removed
  only in a commit message.
- **Communication:** GitHub release notes section listing each deprecation
  with its migration line; pinned Discussion when anything user-visible is
  deprecated or removed.

## 7. Maintainer upgrade playbook

One pass ≈ 1–3 hours. Run when the weekly drift issue fires or an upstream
release lands.

**Detect**
- [ ] Read the `upgrade:check` output: `drift:profiles` (upstream vs
  `latestKnown`), `sync-spec --check` (vendored spec integrity).
- [ ] For an MCP bump: run `fetch-live`; diff `mcp.toolsExposed` and
  `mcp.discovered.*` annotations against the previous pack.
- [ ] Triage to a layer: protocol feature → `contracts/protocols.mjs`;
  product band → `profiles.mjs`; tool rename/shape → capability registry +
  fixtures; spec bump → `sync-spec` then validator + goldens.

**Absorb (one registry edit per change)**
- [ ] Tool renamed: add the new name as first candidate; mark the old row
  `deprecated: { since, removeAfter, aliasOf }`. Never delete in the same PR.
- [ ] New band: add to `profiles.mjs` newest-first, bind protocols, cite
  `evidence:` like the existing entries.
- [ ] Shape changed: re-record the fixture; adjust `adapt()`; the fixture
  diff is the review.

**Verify**
- [ ] `npm run lint` + `npm test` (includes both golden gates and guards).
- [ ] Every changed golden restated in one sentence in the PR description.
  Unexplained diff = stop.
- [ ] MCP-touching change: live `fetch-live` + one deploy/rollback
  round-trip.

**Decide**
- [ ] New alias → changelog + DEPRECATIONS.md + warning. Removal is a future
  major's problem.
- [ ] CI `removeAfter` fired at release time: extend the window (minor) or
  delete the row (major). Never silently extend.

**Ship**
- [ ] Version per the semver mapping; changelog written; tag pushed; the
  workflow publishes. Close the drift issue with the release link.

Standing rules: registries absorb the outside world; a golden diff is a
conversation, not an obstacle; aliases are cheap, removals are majors; if a
step is not in this loop, it is not part of an upgrade.
