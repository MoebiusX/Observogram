# Changelog

## Unreleased

### Ships like Grafana: default admin on first boot
- **First boot with nothing configured now seeds a default `admin` user (password `admin`)** and the login page is live — the studio is a signed-in app out of the box, no CLI setup. The password change is **forced at first sign-in** (new `/auth/change-password`, signed short-lived flow cookie, no session until the change lands).
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
