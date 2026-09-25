# Hand-over note — for the next session (cloud or local)

*Written 2026-09-24 by the desktop session that shipped PRs #100–#106 with the maintainer
(Carlos Montero, GitHub MoebiusX). It says where the three repos stand, how the maintainer
wants work done, what is on the backlog and which debts we knowingly left. Read it with
`docs/BUILD_JOURNEY.md`, `docs/VALUE_BACKLOG.md` and `docs/CHANGELOG.md` (Unreleased).*

## 1. Where things stand

### Observogram (this repo) — `develop` at the merge of #106

The last two days built the second studio journey, **Build** (Define · Compile · Verify),
next to Discover · Diagnose · Remediate. In order:

| PR | What it did |
|---|---|
| #100 | Build number in the footer, the CLI and `/api/version` (`server/build-info.mjs`). |
| #101 | The pack library (`library/products/*.library.yaml`, `library/archetypes/*`), the engine (`tools/lib/library.mjs`: tier requirements, scaffold, `instantiatePack`, placeholders as `library.todo.*` annotations, provenance), `packc init`, the `/api/library/*` routes and the studio journey with the first decision on the landing (*Check an existing service or pack* / *Build a new pack*). |
| #102 | Build is a live scan: the layer stack (L1 … L5, GOV) on every step, drawn by the same adapter as Discover. |
| #103 | The pack is the axis: a definition column on the left, the stack as the main surface, a per-layer sheet with the L1 SLI rolodex. |
| #104 | The tier is a **seed**, not a constraint: any SLI at any tier; library SLIs are editable **copies** (`overrides`), custom SLIs from scratch; the definition column becomes a wizard stage (Seed the pack → a read-only seed card with *Change seed*). |
| #105 | The **pop-up SLI editor**: one modal over an SLI and its SLO (id, description, metric, objective, window, bound, unit, resolved PromQL), opened from any L1 card on the stack or in the rolodex, live-applied on Define and Compile; `id` and `semconv_metric` overrides in the engine. |
| #106 | **Spec 1.3** adopted: `good_when: below \| above` on threshold SLIs, vendored under `vendor/observability-pack-spec/v1.3/`, `SPEC_VERSION = '1.3'`, the burn-rate generator, the boards, the cards and the editor's Bound row know the direction. |

`npm test` passes on Node 22.16+ (the `package.json` `engines` floor, for `node:sqlite`;
the Node 22.22 pipe truncation in `packc journey run --all --json` that failed
`tools/test-journey.mjs` was fixed in [STORE_PLAN.md](STORE_PLAN.md) slice 1). `npm run lint`:
0 errors, 181 warnings (a baseline of `preserve-caught-error`-style warnings; slice 2a
removed five with the file readers it deleted; do not add to it). CI on a PR: `validate`
(includes the vendored-spec check) and `backend-live` on the
latest 22, `node-floor` (`npm test` on exactly 22.16.0), `store-prestore` (from slice 2b:
the Export gate against a `v0.4.0` worktree). `refresh-live-pack` runs only on
demand or when the fetcher changes.

**The store (backlog 0) — slice 2 complete once 2a and 2b merge; slice 3 is next.**
Slice 1 (the store foundation: `server/store/*`, `packc store backup` / `restore`, the k8s
store volume) is PR #109. Slice 2a (PR #111, branch `codex/store-identity`, stacked on it)
moves identity onto the store: `start()` runs `bootStore()` (`server/boot.mjs`: the boot
order, the one-time import of `users.json` / `orgs.json`, the seed and the fail-closed
checks), sessions carry a per-user epoch, OIDC users are recorded under an issuer key,
tenancy is always on, and `npm run users` / `npm run orgs` are entry points over
`server/identity-admin.mjs`. Slice 2b (branch `codex/store-offline-ops`, stacked on 2a)
adds the offline operations in `server/store/ops.mjs`: `packc store export` (the rollback:
to a directory, or in place with the default org's move), `import --replace` (the request;
the replace itself is boot step 3 in `server/store/import.mjs`), `rekey-issuer --to` /
`--clear`, `purge-org`, and `restore`'s warning when the marker names another store. The
boot's step-2 refusals now name `import --replace` (edited files) and both `rekey-issuer`
commands (a changed issuer); `server/test-store-boot.mjs` and `server/test-store-import.mjs`
pin those texts. The Export gate runs in `npm test` through
`server/fixtures/pre-store-build.mjs`, and against the real `v0.4.0` build in the CI job
`store-prestore` (`tools/test-store-prestore-live.mjs`). README "Upgrade And Roll Back" and
`deploy/k8s/README.md` state the upgrade and the clean rollback (export in place first,
with the server stopped). `develop` is promoted to `main` only once 2b has merged. Next is
slice 3 (roles enforced, the identity API, the live pack per org — STORE_PLAN §7).

### otel-observability-pack (the spec) — `develop` at the merge of PR #8

Spec **1.3**: `good_when` with `default: below`, RFC-0002 accepted 2026-09-23, Go type
`SLI.GoodWhen` + `EffectiveGoodWhen()`, seven linter tests, a floor SLI in the example.
Upstream `main` still serves 1.2 until the maintainer promotes `develop`; the studio's
"spec v1.3" links therefore point at the vendored commit, not at `main`.

### mq-observability-pack (the IBM MQ lab) — `develop` == `main` (7b22792)

Untouched by this chain. It vendors Observogram's generators under `vendor/observogram/`
and must re-vendor for 1.3 (see backlog D). It is a **live** lab on the maintainer's
machine (Docker Desktop, IBM MQ, 20+ containers); a cloud session should limit itself to
its static parts (site templates, docs, check-rules) and never run the harness.

## 2. How the maintainer wants work done

These are the rules we learned the hard way; treat them as standing instructions.

- **Proof, not claims.** Every feature is driven live before it is reported (a real
  browser or the API), with exact labels and numbers. "Tests pass" is not evidence that
  the UI works. When he says "where can I test it?", the answer is a URL or a branch to
  pull, never a PR link alone.
- **The tier is a seed, not a cage.** `minTier` decides what the seed pre-selects and
  which rubric grades; it never forbids an SLI. Everything the library copied in is the
  user's to edit (copy-on-write over the library default, per-field reset); an edited
  PromQL drops the library's evidence claim honestly.
- **Editing is a pop-up**, not a form that scrolls inside a card. Five fields fit in one
  dialog; live apply with a status line that names what changed.
- **Apple-like restraint** in the studio: generous spacing, 14–16 px radii, real switches
  and segmented controls, one accent per layer, 200 ms motion under
  `prefers-reduced-motion`, WCAG AA in both themes (a test scans the stylesheet).
- **Honesty rules** (from the run records and the Build journey): "pass on a placeholder"
  is never plain green; a gap is a gap, never a zero; a section switched off says which
  clauses fail with it (read from the engine, never predicted); stack samples are
  signals, not verdicts.
- **The spec is his standard.** A change that needs a new field goes through the spec repo
  first (schema + spec text + RFC + Go linter + example), then Observogram vendors it with
  checksums (`node tools/sync-spec.mjs --ref <commit>` / `--check`), then the MQ lab
  re-vendors the generators.
- **Branching** (`docs/BRANCHING.md`): `codex/<topic>` → PR against `develop`; `main`
  advances only by promotion PR. Single-concern commits, each green alone, bodies that
  say why. He merges within minutes: check a PR's state before pushing follow-ups, and
  open a new PR for work that lands after a merge rather than pushing to the merged branch.
- **Studio conventions** (`docs/UI_CONVENTIONS.md`): views import `studio/host.mjs`, never
  `app.mjs`; loaders, pure models and renderers are separate exports; models read no state
  and fetch nothing and are tested under `node:test`; `tools/lib` stays free of `node:*`
  (it is served to the browser at `/lib`, imported at call time, never statically);
  `tools/test-studio-graph.mjs` links the module graph on `npm test`.
- **Reviews before he sees it.** The pattern that worked: implementer → two parallel
  reviewers (one drives the thing as a user and tries to break it; one checks conventions,
  accessibility, tests, per-commit hygiene, docs vs code) → a fixer that reproduces each
  finding before changing anything, one commit per finding with the test that would have
  caught it. Findings that were not reproduced are not fixed.

## 3. Running and checking things

```bash
npm test                 # node:test suites (Node 22.16+), the studio graph, the AA scan
npm run lint             # eslint: 0 errors is the bar, 186 warnings the baseline
node tools/sync-spec.mjs --check   # vendored spec files match VERSIONS.json
PORT=8013 OBSERVOGRAM_AUTH=off OBSERVOGRAM_WORKSPACE=/tmp/ws node server/index.mjs
```

`OBSERVOGRAM_AUTH=off` removes the sign-in; the workspace must be a throwaway directory.
The server binds 127.0.0.1. For pictures and real-input drives use headless Chromium over
CDP from a Node script (`--headless=new --remote-debugging-port=93xx --user-data-dir=<tmp>
--window-size=1920,1080`, then `Page.navigate`, `Runtime.evaluate`, `Page.captureScreenshot`
with `captureBeyondViewport`); in the cloud sandbox Chromium lives at
`/opt/pw-browsers/chromium`. Useful API truth checks: `POST /api/library/instantiate`
(`entries, name, tier, environment, owners, params, toggles, overrides, custom`) returns
`canonical, todos, provenance, warnings, schemaErrors, summary, conformance, adapted`;
`POST /api/library/compile` takes the same inputs plus `target`.

## 4. Backlog, in the order the maintainer has been steering

**0. Make it feel like a product — first.** The maintainer's steer of 2026-09-24, verbatim:
*"making it feel like a product is the most important. Maybe it's time to deploy our own
in-mem SQL DB for user, services and environment management."* This supersedes the
"file-first, not a database + user accounts" constraint written into
`docs/VALUE_BACKLOG.md` item 10 and moves items 10 and 12 (workspace persistence · auth ·
audit · rollback; identity · tenancy · hosted posture) to the front. What existed then:
`server/auth.mjs` keeps users in `<workspace>/users.json` (seeded admin / admin on first
boot, OIDC optional), `server/tenancy.mjs` scopes a workspace per org, packs live as
`<workspace>/packs/<id>.pack.yaml`, and "service" and "environment" are not first-class
records at all — a service is a pack registration plus the landing's service picker, an
environment is a pack binding or a gen-site partition. The shape to build, keeping the
repo's zero-new-dependency rule: an embedded SQL store on Node's built-in `node:sqlite`
(`DatabaseSync`; present in the Node 22.16 the studio runs on, behind an experimental
warning — the Node floor is now pinned in `package.json` engines and the README), file-backed
under the workspace for persistence with `:memory:` for tests and demos, one schema module
with versioned migrations, tables for users (with roles), orgs, services (name, owners,
criticality tier, the pack it carries, its environments), environments (name, bindings,
endpoints, the MCP it is checked through), pack registrations, and the audit log; the
existing `requireAuth` / `observogramActor` / `workspaceRoot()` seams stay the integration
points so OIDC and the file workspace keep working during the migration. The studio side is
what he means by "feel like a product": sign in, land in your org, see your services and
their environments as the axis (the landing's *Check an existing service* picks from this
table; Build's seed writes into it), a settings surface for users and environments, and
Discover · Diagnose · Remediate · Build hanging off a service record rather than a pack
file. Design it against `docs/VALUE_BACKLOG.md` items 10 and 12 and
`docs/RELEASE_READINESS.md`, and put the plan in front of him before the first commit —
he ratifies plans for this stream (item 12 says so). *Planned 2026-09-24:*
[STORE_PLAN.md](STORE_PLAN.md) — schema, import, roles, slices and gates; the seven
decisions are ratified; its §9b lists the refinements made since, which merging it confirms.
*Status:* slice 1 (the foundation) is PR #109; slice 2 is complete once 2a (identity on the
store, PR #111) and 2b (export, `import --replace`, `rekey-issuer`, `purge-org`) merge; slice 3
(roles enforced) is next — see §1.

**A. Decide: "the draft becomes the pack".** The root cause of every remaining Build gap is
that the draft is a set of inputs re-instantiated from the seed on each change, with
`overrides` and `custom` patched on top. Consequences today: one SLO per SLI with a derived
id and no budget-policy or label editing; the SLI type is fixed; L2–L5 can only be
switched and parametrised, never composed (no own dashboard, route, probe, chaos
experiment, scrape job or backend). The proposal on the table: seeding instantiates once
into a real pack document held in the draft; every edit is an edit of that pack against
the schema; the engine's job per change becomes validate + grade at the tier + compile;
"Change seed" becomes "reapply library defaults" per item. The pop-up editor was built so
it does not care which it writes to. The maintainer has not yet said go; it is the next
big slice and should start after his answer, not before.

Two design constraints he gave for it on 2026-09-24:

- *Every layer's `+` adds an artefact, two faces:* a parameterised form (the pop-up idiom)
  and a paste box for the artefact itself — a pack fragment in YAML on any layer, Grafana
  dashboard JSON on L3 (stored as a source file the pack references, uid and bindings read
  from the JSON), a scrape config or a Collector pipeline fragment on L2, an Alertmanager
  route on L4 — parsed, validated, shown as a card with source "pasted" and no evidence
  claim, refused with the parser's message otherwise. A raw Prometheus alerting rule has no
  slot in the pack (L4 is declarative); pasting one needs an additive spec field first.
- *Backpropagate the chain with virtual artefacts.* When a downstream artefact arrives
  (a pasted dashboard, a rule, a probe), derive the upstream ones it implies as **virtual**
  nodes — metric → SLI → SLO (and the policy an SLO implies) — so the chain is complete and
  gradable at once; when the user later defines one explicitly, the explicit artefact
  **supersedes the virtual one of the same identity** (merge: the virtual's identity and
  what was inferred become the defaults of the explicit form; or ignore: the virtual node
  simply drops out). The precedent already in the engine: `tools/lib/traceability-graph.mjs`
  adds `METRIC-VIRTUAL-<name>` nodes (`virtual: true`) for metrics an SLI's PromQL references
  but no L2 artefact declares, and the comparison lets a real node of the same identity
  satisfy a virtual one; `tools/lib/sli-inference.mjs` is the compiler's inverse (recording
  rule names → SLI/SLO identities) on which such inference keys. Virtual artefacts must stay
  honest on the stack and in the summary: a clause that passes only on a virtual node reads
  like "pass on a placeholder", never plain green.

**B. Neuron SLO ledger.** He wants Pyrra's one thing — every SLO's availability, remaining
budget and burn in one place — inside *Advanced → Neuron*, paired with the integrity of
each SLO's measurement chain (Neuron already computes blast radius). Prerequisite in the
compiler: window-long error-ratio and budget-remaining recording rules per SLO (today only
`<svc>:errorbudget:burn_5m` / `burn_1h` and the threshold `error_ratio_5m` exist); then a
journey run samples them through the MCP metrics tool the inventory check uses and records
them per run; then the Neuron tile, table and small multiples.

**C. The scan, slices 2 and 3** (`docs/BUILD_JOURNEY.md` "The scan"): per-layer visuals
(L1 SLO gauges, L2 pipeline flow strip, L3 dashboard wireframes from the compiled Grafana
JSON, L4 chain, L5 cards) and the isometric slab stack with the acquisition animation plus
landing miniatures. Own PRs, after his go.

**D. MQ lab re-vendor for spec 1.3** (in mq-observability-pack, on the live host): copy
`tools/lib/burn-rules.mjs`, `tools/lib/dashboards/*` and `good-when.mjs` into
`vendor/observogram/lib`, `npm run generate`, paste the `--pack-snippet`, decide whether
`queue_depth_headroom` becomes a plain depth floor with `good_when: above`, run
`check-rules`, promtool, and `certify:quick` against the live stack. Not for a cloud session.

**E. Library entries and `good_when`.** No shipped entry declares a direction yet; every
bound is a ceiling and the generator's "looks like a floor — declare good_when" hint still
fires on ratio-unit ceilings (e.g. ibm-mq's headroom). Rewrite the entries that inverted a
floor, with catalogue evidence for any new metric.

**F. Spec repo follow-ups:** the shipped example fails its own tier-1 rubric on seven
pre-existing clauses (3.4, 3.5, 3.6, 2.4, 1.1, 1.4, 1.9) plus six unknown-alert warnings;
maturity clause 2.1 counts a "latency SLI" by type, so a floor SLI satisfies it (documented,
rubric unchanged — his call); promote `develop` → `main` so upstream `main` serves 1.3.

**G. Smaller studio items:** the seed card's product chips only open the L1 sheet; the
DEFINE silhouette's clickable cards are candidate ghosts, not artefacts; VERIFY's dialog is
read-only by design; the SLI rolodex shows the bare library id until a rename.

## 5. Technical debt we knowingly left

- **A browser twin of a tools/lib helper.** `studio/sli-direction.mjs` duplicates
  `tools/lib/good-when.mjs` because the studio cannot import `tools/lib` statically
  (unserved relative path; `/lib/` unresolvable under `node:test`). A test holds the two
  equal input for input. The studio's own pattern for this is a call-time `import('/lib/…')`
  (Neuron does it); the twin could go that way.
- **`tools/lib/validator.mjs` skips boolean sub-schemas** (`"x": false`). The 1.3 schema
  therefore uses `{ "not": {} }` to forbid `good_when` on ratio/custom SLIs. Fixing the
  validator would let upstream use the idiomatic form.
- **`POST /api/library/compile` on library packs warns** "declared … and generated … write
  the same metric name": the library declares the `ref:slis.*` recording rules the compiler
  also generates. Pre-existing; decide which side owns them.
- **`packc init` has no custom SLIs** and `--override` takes only the scalar fields and
  `id` / `semconv_metric` / `good_when`; PromQL edits are studio/API only. Documented in
  `library/README.md`.
- **Records are half on the store.** Users, orgs, memberships, the owner and the audit live
  in the store from slice 2a; `users.json` / `orgs.json` are imported once and never read
  again. `packs/index.json` (pack registrations), services and environments are still files
  or not records at all until the later slices of `docs/STORE_PLAN.md`; artefacts
  (`packs/*.pack.yaml`, snapshots, journeys, runs, `deploys.jsonl`) stay files by design.
  The rollback to a pre-store build is `packc store export` in place, with the server
  stopped, and the way back after one is `packc store import --replace` (slice 2b).
- **The Build state is inputs + overrides** (see backlog A). Until that changes, every new
  editable thing needs its own special case in the engine and the state.
- **Distribution SLIs** get no burn rules (null legs) and no direction handling beyond the
  schema; nothing in the studio creates one.
- **Golden churn.** `tools/fixtures/golden/compile/*` and `reference-packs/dashboards/*.json`
  carry the spec version in a banner line and the direction glyph in descriptions; every
  spec bump regenerates them. The drift-scan test in `tools/test-validator.mjs` carries an
  explicit allow-list of historical documents.
- **The repo-root `index.html`** (the v0.3-era landing page) still says "Spec v1.2" and
  links upstream `main`; it is not scanned by the drift guard.
- **Lint baseline**: 186 warnings, mostly `preserve-caught-error`; each new file should
  add none.
- **The MQ lab's `sites/lab/`** (the rendering `npm run site` writes) is untracked and
  unignored in that repo; it is a copy of `stack/` plus site-only files, not something to
  commit. A `.gitignore` line is the fix.
- **Windows-only traps** the desktop session hit (a junction for `node_modules` that
  `rm -rf` follows; `MAX_PATH` breaking `git worktree add` under long scratch paths;
  `go test -race` needing CGO) do not apply in the cloud sandbox, but a local session on
  the maintainer's machine will meet them again.

## 6. Pointers

- `docs/BUILD_JOURNEY.md` — the Build contract end to end: the library format, the seed and
  the copies, the axis, the sheet, the editor, the API and the CLI.
- `library/README.md` — the entry format, `instantiatePack` inputs (`overrides`, `custom`,
  `good_when`), the caps, the CLI flags.
- `docs/STORE_PLAN.md` — backlog 0: the embedded store, its import from today's files,
  roles and owners, the slices and their gates.
- `docs/VALUE_BACKLOG.md` — the product backlog the maintainer curates (P1–P4); items A–C
  above are the Build-journey additions to it and should be filed there when he ratifies them.
- `docs/CHANGELOG.md` (Unreleased) — one entry per PR above, with the review findings each
  pass closed.
- `docs/UI_CONVENTIONS.md`, `docs/BRANCHING.md`, `docs/VENDORING.md`,
  `vendor/observability-pack-spec/README.md` — the conventions this note assumes.
- otel-observability-pack: `docs/rfcs/0002-threshold-direction.md`, `spec/ObservabilityPack-Spec.md` §5.1.
- mq-observability-pack: `CLAUDE.md` (the rules of the live lab) and `STATUS.md` (its own
  cross-session hand-over).
