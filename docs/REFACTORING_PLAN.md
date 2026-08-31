# Refactoring Plan

Maintainability opportunities identified during the 2026-06-10 codebase
audit. Items are ordered by leverage (how much future work each one makes
cheaper), not urgency — nothing here is broken today. Each entry says what
the smell is, why it matters, and the smallest worthwhile step.

Items already closed by the audit follow-up are not listed (shared slug
module, shared test harness, zip filename guard, fetch timeouts, frontend
promise handling, dialog focus trap).

## 1. Decompose `studio/app.mjs` (~3,100 lines)

`app.mjs` mixes at least four responsibilities: boot/rehydrate, the
pack/env selector chrome, the MCP draft + crawl panels, and the entire
deploy modal (state, manifest table, profiles, bulk deploy — roughly lines
2700–3100). The view modules were already extracted once (compare, compile,
layers, drawer, atlases); the same pattern finishes the job.

- Extract `studio/deploy-modal.mjs` first — it is the most self-contained
  block (own state object, own DOM subtree, clear entry points
  `setupDeployModal`/`openDeployModal`) and removes ~400 lines.
- Then `studio/panels.mjs` for the crawl / draft-from-MCP / refresh-live
  panels, which share open/close/esc wiring.
- Keep orchestration (boot, mode switching, tab rendering) as the residual
  app.mjs.

## 2. Decompose `studio/compare-view.mjs` (~2,800 lines)

It currently contains the compare grid, the benchmark view, the trace view,
the diagnose tools, and shared pickers. These are separate tabs with thin
shared seams (`renderComparePicker`, `loadDiff`). Split per tab; move the
shared pickers into a small `compare-common.mjs`. This also untangles the
import cycle where `atlas-view.mjs` imports from both `app.mjs` and
`compare-view.mjs`.

## 3. Render granularity

Every state change re-renders whole sections via `renderTabs()` +
`renderMainView()`. At current size this is fine; the cost is that async
callbacks must be careful not to render stale state (several already
re-check `state.*` before painting). Before adding more async views,
consider a tiny convention rather than a framework: each view exports
`render(view, state)` and is responsible for cancelling its own in-flight
loads (an `AbortController` per view slot). That removes the stale-render
class of bugs without a rewrite.

## 4. Split `server/index.mjs` (~1,700 lines) into route modules

The server is a thin layer over `tools/lib`, but all ~20 routes live in one
file. Natural seams, in extraction order:

- `server/routes/deploy.mjs` — `/deploy/:target` + `/deploy-bulk` share
  validation (product/version checks, MCP target resolution) that is
  currently duplicated; extracting forces the shared
  `validateDeployTarget()` helper.
- `server/routes/crawl.mjs` — `/api/crawl`, `/api/crawl-github` (the
  GitHub fetch pipeline is ~140 lines on its own).
- `server/routes/mcp.mjs` — `/api/draft-from-mcp`, `/api/refresh-live`.
- Registry (`UPLOADED_PACKS`, `findPackMeta`, `overlaidCanonical`) into
  `server/registry.mjs`, imported by all route modules.

## 5. Deterministic crawler output for committed fixtures

`examples/krystaline-repo-carlos.pack.yaml` is a committed fixture, but any
local crawler run rewrites its `crawler.discoveredAt` timestamp and header
banner, leaving permanent working-tree churn. `crawlToYaml` already accepts
`{ now }` (the tests use it). Expose that as a CLI flag
(`npm run crawl -- ... --now 2026-06-09T00:00:00Z`) and regenerate fixtures
with a pinned timestamp, so a fixture refresh produces a diff only when the
crawler's *behaviour* changes.

Related: `.gitignore` says `*.repo.pack.yaml` crawler drafts "must never
land in this public repo" because they can carry secrets. The committed
fixture used to skirt that pattern via its `.Carlos.yaml` suffix; it is now
named `krystaline-repo-carlos.pack.yaml` — a deliberately non-ignored,
suite-discoverable name (`tools/test-packs.mjs` matches `*.pack.yaml`) — so
the ignore rule keeps guarding fresh crawler drafts while the fixture stays
committed and tested.

## 6. Finish the test-runner migration

`npm test` now runs everything under `node --test`; the suites still report
through the shared script harness (`tools/lib/harness.mjs`), so each file
is pass/fail as a unit with ✓/✗ detail in its output. Two follow-ups:

- Convert suites to per-assertion `t.test()` subtests file by file when
  touched, so failures surface in the runner's own report (and `--test-name-
  pattern` filtering works). No big-bang rewrite needed.
- `server/test-smoke.mjs` binds a fixed port; give it an ephemeral port
  (`listen(0)`) so parallel runners and a running dev server can't collide.

## 7. `tools/lib/mini-yaml.mjs` scope guardrails

The hand-rolled parser is intentionally scoped to canonical pack YAML, but
two gaps are silent rather than loud:

- Single-quoted scalars only handle `''` (line ~376), while double-quoted
  go through `JSON.parse` — escape handling differs between quote styles.
- Folded block scalars (`>`) don't implement YAML folding semantics.

Lowest-cost fix: make the parser *throw* on constructs outside its scope
(folded scalars, anchors, tags) instead of best-effort parsing them, and
state the supported subset in the module header. A user feeding
hand-written YAML should get "unsupported YAML feature at line N", not a
silently different value.

## 8. `drawer.mjs` repeated builders

The dt/dd meta-row pattern is built inline in three places (~lines 62, 233,
254). Extract `metaRows(pairs)` / `tableHead(cols)` helpers so the escaping
discipline lives in one function.

`layers-view.mjs:16` (`renderDiscoverDashboard`, ~268 lines) deserves the
same treatment: pull the per-layer card, the issues table, and the stat
strip into named functions.

## 9. CI and release gaps

- CI `push` triggers only fire on `develop`/`main`; feature branches get CI
  only via PR. Long-lived branches (this one ran 50+ commits) go unvalidated
  between PRs. Add `push: branches: ['**']` or at least `codex/**`.
- `package.json` already declares `bin` + `publishConfig`, but there is no
  publish automation. A tag-triggered workflow (`on: push: tags: v*`)
  running `npm publish --provenance` would close the loop; needs an
  `NPM_TOKEN` secret.

## 10. Import-graph hygiene in `tools/lib`

Most modules import from several core libs (mini-yaml, promql, adapter,
traceability). It works, but refactors are fragile because there is no
stated layering. Adopt and document a simple rule: parsing primitives
(mini-yaml, promql, slug, zip, harness) import nothing from the domain
layer; domain modules (adapter, crawler, compile, diff, conformance,
traceability) may import primitives but not each other except through
explicit, commented seams. An ESLint `no-restricted-imports` block can
enforce it cheaply.
