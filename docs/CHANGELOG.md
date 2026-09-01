# Changelog

## Unreleased

### Studio Diagnose views rejoin the behavioural engine
- **Diagnose → Compare cards classify from the diff again.** The side-by-side view derived its in-both / only-in chips by recomputing keys client-side as `defines || id` — a lossy approximation of the old diff keyspace that stopped matching entirely once the engine moved to behavioural identity keys (`kind::{identity}`): the summary band said N matched while all cards below rendered unclassified and the "In both" / "A − B" slice filters returned nonsense. Cards and slice filters now classify by the artefact ids embedded in the diff entries themselves (unique per pack side) — no client-side key math to drift again.
- **Traceability (Advanced) is diff-driven.** Its repo-vs-live buckets were re-derived locally by raw id match + whole-object JSON equality (only `annotations`/`_sub` stripped), so behaviourally-identical artefacts with different ids double-counted as declared-not-verified *and* verified-not-declared, and endpoint/expression-formatting differences flagged Stale. The four buckets now re-bin the server diff — aligned = inBoth-aligned, stale = inBoth-drifted (with the engine's delta fields named on each row) — and reconcile with the drift drill's **unlensed** totals: out-of-scope artefacts and scaffold placeholders are parked the same way (counts + live-scope control shown), while the drill additionally applies the active product lens. Panels stay compared at dashboard granularity (the engine's rule), now stated in the view. The view fetches the diff itself when it isn't loaded yet. Suppress/resolve prefs now key on behavioural identity keys (collision entries append the artefact symbol so `#NN` ordinal reshuffles don't migrate a suppression), so previously-saved entries no longer match and reset once.
- **Stale-diff hardening.** `state.diff` is stamped with the selection it was computed for (`packs + envs + scope + service`) and every consumer treats a mismatch as *no diff*, refetching instead of rendering — previously a Pack A/env switch could leave the views classifying the new pack against the old diff's positional ids. Late responses for a superseded selection are discarded, concurrent renders share one in-flight fetch, and the three loading branches only re-render on progress (an unregistered Pack A now gets an honest error instead of a render loop).
- `prettyDiffKey` learned the behavioural keyspace (`kind::{identity-json}` with `#NN` occurrence ordinals) — backend, pipeline-stage, storage, mesh/collection, product-keyed, scrape-job, imports, and remediation identities render as readable labels instead of raw JSON, and forecast alerts are no longer mislabelled as burn-rate alerts.

### Account menu: profile, change password, sign out
- The identity chip in the studio header is now an **account menu**: who you're signed in as (and the auth mode), **change password…** (stand-alone mode — OIDC passwords belong to the IdP), and **sign out**. It renders in identity postures only; the open posture (`OBSERVOGRAM_AUTH=off` or no users file) has no accounts to manage.
- **Signed-in users can finally change their password**: `/auth/change-password` now also accepts a session. The current password is required — that knowledge is the CSRF defence — and wrong guesses share the login damper (5 failures → 30s lockout). The mid-login forced-change flow (flow cookie, skip) is behaviourally preserved, with one deliberate alignment: a user deleted mid-flow now gets "unknown user" before password validation, matching the session path.
- **Login now clears a leftover pwchange flow cookie.** An abandoned forced change (admin/admin typed on a shared browser, then closed) used to leave a 10-minute flow cookie that shadowed the session on `/auth/change-password` — the account menu's link could silently target the *other* account. A normal login expires it.
- Known limitation (stateless sessions, pre-existing model): rotating a password does **not** revoke other outstanding sessions — an already-stolen cookie rides out its TTL (default 8h). Real revocation needs a per-user epoch in `users.json` checked at session verification.
- Suite: 15 new assertions in `server/test-auth-local.mjs` — the session variant of the page (current-password field, no skip control; the flow variant is pinned to *lack* the field), wrong-current 401 in JSON and HTML, short-replacement 400, rotation in JSON and HTML (302 home), old password dead / new signs in, deleted-user GET/POST with a live session, the stale-flow-cookie clear on login, the 429 lockout, and the damper being shared with `/auth/login`.

### "Skip for now" on the forced password change
- The first-boot change-password page now offers **Skip for now — ask again next sign-in**: a session is issued without replacing `admin/admin`, the forced-change flags stay set, and every subsequent sign-in re-prompts. New `POST /auth/change-password/skip`, credentialed by the same signed flow cookie as the change itself.
- **Deliberately narrow**: skipping works only while the record still holds the *seeded default* — an admin-set temporary password (`mustChange` without `seededDefault`) stays a forced change, and the loopback guard is unaffected (a skipped default still refuses to bind beyond loopback).
- Suite: 12 new assertions in `server/test-auth-local.mjs` — skip control rendering, no-cookie rejection, session issuance with flags intact (JSON and browser-form paths), network-bind refusal after a skip, re-prompt at next sign-in, and the temporary-password 403 (JSON and HTML, skip control absent).

### Explicit collision reporting + collision-proof coverage
- **New top-level `collisions` on the `diffPacks()` result** (`{ layer, kind, key, aCount, bCount }`) and `graph.collisions` on `buildDependencyGraph()` (`{ key, kind, count }`): every identity key held by more than one artefact, surfaced explicitly so callers can fail loud instead of inferring collisions from `#NN` occurrence suffixes. Additive — no existing bucket, key, or summary count changes.
- **Alert-route identity deliberately stays severity-keyed.** Widening it with channel kinds was prototyped and declined: the live connector and crawler fabricate a channel kind when routing cannot be introspected (fetch-live's SEV1 msteams placeholder, unmapped-receiver stubs), so channel-kind identity would split declared routes from their live placeholders and report them falsely missing in production. Channel changes stay decision-bearing *drift* on the paired route; a new regression test pins the placeholder pairing.
- `otel`/`baselines` empty identities and pipeline-stage `{name}` identity are now documented invariants (spec-singular objects; collector `batch/2`-style duplicates survive via occurrence ordinals), in code comments and docs/DIFF.md.
- **Vendoring contract hardened** (docs/VENDORING.md): `tools/lib/artefact-model.mjs`, `promql-canon.mjs`, and `promql.mjs` join the vendorable table and the staying-current diff command — they were always `diff.mjs`'s import closure, but a downstream copy that missed them could silently mix engine generations (the root cause behind a downstream studio's 2026-08 collision report, filed against code replaced on 2026-06-09).
- **Compiler: duplicate-severity routes now emit a valid, complete Alertmanager config.** Bringing the crawled pack into strict CI validation exposed the same severity-collision bug in `compileAlertmanager()`: one receiver per route *named by severity*, so N same-severity routes emitted N identically-named receivers (`amtool check-config` rejects the file) — and their identical-matcher sibling routes meant only the first could ever fire. Duplicates now get ordinal receiver names (`svc-sev2-2`, …) and identical-matcher groups chain with `continue: true`, so every declared channel notifies. Regression-tested in `tools/test-compile.mjs`.
- Suite: the collision fixture grew same-named pipeline stages and a fourth same-severity route; `tools/test-packs.mjs` now asserts the self-diff invariant (every artefact preserved, alignment/Jaccard 1.0) for **every** bundled pack; `examples/krystaline.repo.pack.Carlos.yaml` renamed to `krystaline-repo-carlos.pack.yaml` so the one crawled real-world pack (324 artefacts) finally enters the suite, with its genuine collisions pinned in `PACK_EXPECTATIONS`; `tools/test-traceability-graph.mjs` gained duplicate-identity-key coverage.

### Chronicled retroactively: the identity-collision safety net (2026-06-09)
- Never changelogged when it landed (commit `4c5bae4`, between 0.3.0 and this line): `diffPacks` groups identity keys instead of last-write-wins `Map.set`, pairs exact behavioural matches first, and preserves duplicates with stable `#NN` occurrence suffixes; `canonicalize()` began treating empty arrays like absent fields in the same commit. `buildDependencyGraph` (created the same day in `6fcb7ef`) has had the grouped behaviour from birth. If a vendored `diff.mjs` still contains `aByKey.set(keyOf(a), a)`, it predates 2026-06-09 — re-vendor the full engine closure.

### Ships like Grafana: default admin on first boot
- **First boot with nothing configured now seeds a default `admin` user (password `admin`)** and the login page is live — the studio is a signed-in app out of the box, no CLI setup. The password change is **forced at first sign-in** (new `/auth/change-password`, signed short-lived flow cookie, no session until the change lands). _Softened later in this release: skippable per session for the seeded default — see the "Skip for now" entry above._
- **The default credential never crosses loopback**: a network boot never seeds `admin/admin` (it refuses to start and names the options), and `start()` refuses to bind beyond loopback while an already-seeded default is unchanged. Container/network boots set `OBSERVOGRAM_ADMIN_PASSWORD=<secret>` to seed a real credential (no forced change); the same env var also *replaces* a still-default admin record, so a workspace seeded on loopback can be moved behind the network without a deadlock.
- The seed backs off from any expressed intent: OIDC configured, an existing users file, `OBSERVOGRAM_API_TOKEN` (the token-only 10B contract is unchanged), or armed tenancy.
- **New `OBSERVOGRAM_AUTH=off`** — the one switch that disables identity entirely (no login, no seeding, `/auth/*` answers 404): the pre-0.5 open posture, kept for dev shells, scripts and CI. This is a **default-behaviour change**: `npm start` on a fresh workspace now lands on a login page.
- Stand-alone auth arming is now per-request (routes register once, posture follows the users file), so the seed at `start()` and `npm run users` both take effect without a re-import; `npm run users -- passwd` clears a pending forced-change flag.
- Suite: `server/test-auth-local.mjs` grew 18 assertions — seed shape, 401-by-default, loopback guard, the full forced-change flow, `OBSERVOGRAM_ADMIN_PASSWORD` (fresh seed + rescue), never-seed-on-network-boot, and the off switch; `server/test-smoke.mjs` runs under `OBSERVOGRAM_AUTH=off` and is the open-posture regression.

### Tomograph → Observogram (rebrand, backwards-compatible)
- Every user-facing name is now **Observogram**: package name and npm bin (`observogram`; `packc` unchanged), studio shell, login page, CLI help, Docker image (`observogram:<version>`), k8s manifests, docs, and diagrams.
- **Nothing breaks on upgrade** — the legacy spellings keep working via `tools/lib/brand-env.mjs` (drop planned for 0.6):
  - Env vars: every knob reads `OBSERVOGRAM_*` first, then the legacy `TOMOGRAPH_*` (`WORKSPACE`, `API_TOKEN[_LABEL]`, `OIDC_*`, `SESSION_*`, `USERS_FILE`, `INSECURE_NO_AUTH`, `ALLOW_LOCAL_MCP`, `STRICT_SNAPSHOT`, `BUILD`, `DEBUG`, `DIFF_SCOPE`, `MCP_TIMEOUT_MS`, `GRAFANA_*`).
  - Workspace: the default directory is `.observogram/`, but an existing `.tomograph/` keeps being used as-is (no migration needed, no data orphaned).
  - HTTP: the studio sends `X-Observogram-Org` / `X-Observogram-CSRF`; the server accepts the `X-Tomograph-*` spellings too and echoes `X-Observogram-Org`.
  - Sessions: the cookie is `observogram_session`; sessions issued pre-rebrand under `tomo_session` stay valid (same HMAC secret), and logout clears both.
  - Pack annotations: writers emit `observogram.*` (`diff.scopeMode`, `retrofeed.*`, `services`); readers accept the `tomograph.*` namespace from pre-rebrand packs, new key wins when both exist.
- Legacy-compat is CI-asserted (workspace env fallback, org/CSRF headers, session cookie, annotation namespace).

### Vendorable verdict engines (downstream-studio decoupling)
- `studio/diagnostic-grade.mjs` is now **zero-dependency** (`L4_SUBGROUPS` inlined) — vendorable verbatim, like `tools/lib/diff.mjs` and `tools/lib/protocols.mjs`.
- `studio/verdict-ui.mjs` no longer reads global state: `buildVerdictModel()` / `projectGrade()` take `{ pack, packB, diff, compareBId, catalogEntry }` explicitly and `loadRunHistory()` accepts an injectable `fetchFn`.
- New `studio/compare-catalog.mjs` — `catalogEntryFor()` + `LAYERS_FOR_DIFF` extracted from the 3000-line compare-view (which re-exports them), so verdict modules import the small catalog module instead of the whole view.
- See the new [docs/VENDORING.md](VENDORING.md) for the downstream contract.

### The studio host seam (no view imports app.mjs for orchestration)
- New `studio/host.mjs` — a zero-import module holding the app-level callbacks (`loadPackB`, `openDeployModal`, `renderMainView`, `renderTabs`); app.mjs fills it once at boot via `initHost()`. Every view module (compare, compile, layers, drawer, journeys, references, atlas, all protos) now calls these through `host` (imported as `appHost`) instead of importing app.mjs — app-specific *helpers* remain direct imports until each view adopts the model-passing convention.
- New `tools/test-studio-graph.mjs` in `npm test` — links the entire studio ES-module graph headlessly, so a dangling import/export anywhere in the studio fails CI (node --check is parse-only and cannot catch it).
- New `studio/verdict-ui.css` — the `.mc-*` widget styles verdict-ui.mjs emits, split out of app.css along the vendoring seam (the file header documents the theme variables it expects).
- New [docs/UI_CONVENTIONS.md](UI_CONVENTIONS.md) — the adopt-on-touch conventions: host seam, loader/renderer split with injectable `fetchFn`, `render(container, model, host)` signature, and per-zone CSS prefixes.
- Rebrand follow-through: the last "tomogram" vocabulary is now "observogram" (Discover's scan title/tagline, hero-asset path `assets/observogram-hero.png`, docs).

### Fixed: comparing legacy imports (and any cross-service packs)
- The PACK B picker filtered out every pack whose service didn't match the active one — two legacy imports (each deriving its own service from the old pack id) could never be compared. Cross-service packs are now selectable under an "other services" group; same-service packs and live aggregates still lead the list, and the diff's service scope keeps cross-service comparisons honest.

### Stage 2 tenancy — workspace-per-org
- New `server/tenancy.mjs`: org registry in `<workspace>/orgs.json` (the file existing arms tenancy, mirroring `users.json`), per-request org context via AsyncLocalStorage, idempotent flat → `orgs/default/` boot migration. Requires identity; refuses to boot otherwise (fail-closed).
- `workspaceRoot()` is context-aware: registry, deploys, snapshots, journeys, runs all answer from `<workspace>/orgs/<orgId>/` inside a request. The in-memory upload registry and workspace index cache are keyed per org.
- Org selection via `X-Observogram-Org` (default: first membership); membership enforced in middleware; bearer token = deployment-level service account. New `GET /api/orgs`; `/auth/me` carries memberships; roles recorded for Stage 3 (not yet enforced).
- New CLI `npm run orgs -- create|remove|add-member|remove-member|list`.
- Studio: active org resolved before the first catalog fetch; ORG chip (switcher when multi-org) in the OBSERVA bar.
- New suite `server/test-tenancy.mjs` — the isolation gate: org B reads/writes nothing of org A (API + filesystem-path assertions), migration, per-org reset, fail-closed posture.

### Previous pack format (layered JSON) supported again
- New `tools/lib/legacy.mjs` — detects the pre-v1.2 layered "studio-shape" JSON and upconverts it to a canonical v1.2 manifest. Lossless (every legacy artefact kept verbatim in `legacy.artefact.*` annotations), honest (every schema-forced placeholder marked `crawler.scaffold.*` → projects as Scaffold, never Declared), deterministic.
- `POST /api/validate` upconverts legacy uploads transparently; the studio toast reports the conversion (`N artefacts mapped, M scaffolds`).
- New CLI `npm run upconvert-legacy <file> [-o out.pack.json]`.
- The four original layered JSON packs restored from git history as working examples: `examples/legacy/` (+ README documenting the format).
- New suite `tools/test-legacy-pack.mjs` gates all four examples on every `npm test`; the validator's gatekeeper error now points legacy packs at the converter.

## 0.3.0 — 2026-06-08

**The spec v1.2 migration.** Studio now reads, renders, validates, scores, and lives on the canonical [ObservabilityPack spec v1.2](https://github.com/MoebiusX/otel-observability-pack/blob/main/spec/ObservabilityPack-Spec.md). All studio-shape v0.1/v0.2 artefacts are gone.

### Phase 0 — vendored spec
- New `vendor/observability-pack-spec/v1.2/` with the upstream schema, spec, maturity rubric, and worked example, each checksumed into `VERSIONS.json`.
- New `tools/sync-spec.mjs` — refresh + `--check` drift detection (zero deps, uses `gh` CLI).
- Deleted the old `schema/pack.schema.json` (studio-original display schema replaced by the canonical one).

### Phase 1 — canonical-only validator
- Rewrote `tools/validate-pack.mjs` against the vendored canonical schema.
- Gatekeeper rejects pre-1.2 input with a migration-pointer error.
- Extended the JSON Schema 2020-12 walker to cover `const`, `allOf` / `oneOf` / `anyOf`, `if`/`then`/`else`, `contains`, `propertyNames`, `min/maxProperties`, `exclusiveMin/Max`, `format: uri | date-time`, `patternProperties`.
- New `tools/lib/mini-yaml.mjs` — minimal browser-friendly YAML reader.

### Phase 2 — canonical → layered adapter
- New `tools/lib/adapter.mjs` — pure ESM, no Node APIs. Exports `adapt()`, `listEnvironments()`, `applyEnvironmentOverlay()`.
- Maps every spec section to a deterministic family of layered artefacts with `defines` / `refs` for cross-reference checking.
- Environment overlay: deep-clone + dotted-path overrides + effective `target` / `criticality` / `backendWiring`.
- New CLI `node tools/adapt-spec-pack.mjs <pack.yaml> [--env <name>] [--pretty]`.

### Phase 3a — Express + thin client refresh
- **Architectural shift:** the 5,310-line single-file HTML monolith is gone. The studio now ships as:
  - `server/index.mjs` — Express 5 server with a JSON API.
  - `studio/{index.html, app.css, app.mjs}` — thin client that fetches `/api/packs/:id` and renders.
- First runtime npm dep: `express`.
- New visual identity: hairline grid, monospaced data, layer-numbered tabs (L1, L2, L2X, L3, L4 with sub-tabs, L5, GOV), slide-in drawer.
- API: `GET /healthz`, `/api/packs`, `/api/packs/:id?env=<name>`, `/api/packs/:id/canonical?env=<name>`, `POST /api/validate`.
- The four atlases (Stratigraphy, Periodic Table, Constellation, Skyline) and the old source-tag taxonomy (BAU / SLA / NEW / GAP / PLANNED / LIVE) are retired.
- `pages.yml` disabled — Pages can't host a server-backed studio without a build target.

### Phase 3b — UI enrichment + conformance
- Shared `tools/lib/validator.mjs` — CLI + server both import it; ~150 LoC of duplication removed.
- New `tools/lib/conformance.mjs` — 29 hand-curated rubric clauses from spec §5 + §7. Tier-aware scoring (MUST = 1, SHOULD = 0.5; cumulative tier-3 → tier-2 → tier-1).
- New API: `GET /api/packs/:id/conformance?env=<name>`, `GET /api/maturity-rubric`. `POST /api/validate` now also returns `.conformance`.
- Drawer enrichment for 18 artefact families — SLI / SLO / OTel / Backend / Storage / Pipeline / Dashboard / Recording rule / Derived view / Burn-rate / Forecast / Route / Remediation / Baselines / Chaos / Synthetic / Extended / Import.
- Cross-reference checker — symbol table from `defines`; broken refs → red outline + ⚠; clickable ref-links jump to the defining artefact.
- Version-gating chips (off / warn / enforce) on backend cards.
- Conformance tab with headline + per-dimension grid + full clause list.
- File-upload + drag-and-drop loader (drops to `POST /api/validate`).

### Phase 4 — canonical-only fetcher
- Rewrote `tools/fetch-live-pack.mjs` to build a canonical v1.2 manifest from MCP responses, validate it against the schema, and emit it as YAML. No `EMIT_FORMAT` flag, no studio-shape output.
- Added `emit()` to `tools/lib/mini-yaml.mjs` — round-trips with the parser on the canonical example.
- Adapter now reads flat `metadata.annotations["mcp.verified.<symbol>"]` keys (the schema constrains annotations to `{string: string}`).
- Workflow `refresh-live-pack.yml` builds the YAML and publishes it as a workflow artifact; live snapshots are not committed fixtures.
- Server live-status reads a local ignored `examples/production-live.pack.yaml` when a dev refresh creates one.
- New `tools/test-fetch-live.mjs` — 36-assertion offline test across rich + empty MCP cases.

### Phase 5 — bundled canonical packs
- Three new hand-curated canonical YAML packs:
  - `packs/demo-skeleton.pack.yaml` — tier-3 minimum, 100% MUST (8/8).
  - `packs/production-curated.pack.yaml` — tier-2 partial BAU, 86% MUST (12/14), three honest gaps.
  - `packs/target-advanced.pack.yaml` — tier-1 aspirational reference, 100% MUST (24/24) + 100% SHOULD (5/5).
- New `tools/test-packs.mjs` — auto-discovers `packs/*.pack.yaml`, validates + adapts + scores + asserts per-pack expectations.
- Server catalog grows to five entries.
- Legacy studio-shape JSON packs deleted.

### Phase 6 — docs + version bump
- README rewritten for the new architecture, API, and bundled packs.
- New `docs/ADAPTER.md` — full canonical → layered mapping reference.
- New `docs/CONFORMANCE.md` — all 29 rubric clauses + scoring formula + bundled-pack scores.
- Refreshed `docs/MODEL.md` (thin pointer to vendored spec + L2X documentation) and `docs/MCP_INTEGRATION.md` (canonical YAML emission).
- Deleted `docs/ATLAS.md` (atlases removed in Phase 3a).
- Bumped `0.3.0-dev` → `0.3.0`.

## 0.2.0

### Added
- **Atlas** — four-metaphor visualisation tab (Stratigraphy, Periodic Table, Constellation, Skyline). _Removed in 0.3.0._
- **Live MCP integration** — `tools/fetch-live-pack.mjs` reads from an MCP-exposed observability surface and writes a JSON file. _Rewritten for canonical YAML in 0.3.0._
- **`LIVE` source tag**. _Replaced by Declared / Verified / Missing in 0.3.0._
- **Liveness badge** in the header. _Removed in 0.3.0; conformance + source tags supersede._
- **File picker + drag-and-drop**. _Retained in 0.3.0 against `POST /api/validate`._
- **JSON Schema** for pack validation (`schema/pack.schema.json`). _Replaced by the canonical vendored schema in 0.3.0._
- **CI cron example** — `.github/workflows/refresh-live-pack.yml`. _Retained, updated for YAML output in 0.3.0._

### Changed
- Single-file studio split into a real repo with `studio/`, `packs/`, `tools/`, `schema/`, `docs/`.
- Embedded packs extracted as standalone JSON in `packs/`. _Replaced by canonical YAML in 0.3.0._

## 0.1.0

Initial release. Single-file HTML studio with the 5-layer ObservabilityPack model (L1 Contract → L2 Telemetry → L3 Insight → L4 Action, L5 Validation as orthogonal column, Governance underneath). Views: Current, Target, Compare, Schema. Drawer drilldown. Print stylesheet.
