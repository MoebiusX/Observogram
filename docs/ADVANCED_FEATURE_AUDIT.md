# Advanced Feature Audit

Audit of the six **Advanced** menu views and the Advanced-adjacent header
controls, as shipped on 2026-06-10. For each: what it does today, why a user
reaches for it, where the code lives, known gaps, what tests cover it, and a
readiness call. Hardening applied in the same pass is marked **(fixed this
pass)**.

Readiness scale: **Ready** (use it, trust it) · **Ready with caveats**
(works; listed gaps are cosmetic or edge-case) · **Needs work** (value is
real but a listed gap blocks confident daily use).

---

## 1. References

- **Current state.** Curated, evidence-cited best-practice packs (Kafka,
  Prometheus, Grafana) rendered as cards; each card offers "Benchmark vs …"
  which loads the reference as Pack B and opens the drift drill in
  Diagnose → Compare. Renders without a pack loaded; benchmarking needs
  Pack A plus a product lens.
- **User value.** "How does my pack compare to a known-good posture for
  this component?" — the only view that answers against an external
  standard rather than the user's own packs.
- **Code surface.** [studio/references-view.mjs](../studio/references-view.mjs)
  (~115 lines), `loadAndCacheReferences()` in
  [studio/app.mjs](../studio/app.mjs), `GET /api/references`
  ([server/index.mjs](../server/index.mjs)), pack sources in
  [reference-packs/](../reference-packs/), evidence in
  [docs/catalogue-evidence/](catalogue-evidence/).
- **Known gaps.**
  - A failed `/api/references` load left the view on "Loading reference
    packs…" forever **(fixed this pass** — failures now render an error
    state with an explicit Retry; an empty catalogue states that honestly;
    neither errors nor a settled-empty catalogue auto-refetch on render**)**.
  - The "Benchmark vs …" CTA was dead: it drove the Pack B picker, but
    reference packs were deliberately removed from that picker, so the
    value assignment silently reset to "— none —" **(fixed this pass** —
    the CTA drives state directly via `loadPackB()`, and the picker always
    represents the *active* Pack B even when it wouldn't pass the service
    filter**)**.
  - Benchmarking is limited to packs with a product lens
    (`LENS_PRODUCTS` in compare-view.mjs); reference packs without one
    show "No product lens for this pack" with no path forward.
  - Catalogue has three entries; growth process is manual (see
    `docs/archive/REFERENCE_CATALOGUE_PLAN.md` for the original intent).
- **Test coverage.** Server smoke asserts `/api/references` shape and that
  reference packs validate. No UI-level tests.
- **Readiness: Ready.**

## 2. Conformance

- **Current state.** Maturity-rubric scorecard for the focused pack, in the
  screen grammar ([UX_SCREEN_GRAMMAR.md](UX_SCREEN_GRAMMAR.md)): the
  governing result first ("Not conformant at tier 2: three required clauses
  need attention"), the top blockers each with a reason and a fix, then the
  clauses split into blocking · recommended not met · passes on placeholders
  (when the report carries `onPlaceholder`) · passed · not applicable at this
  tier (drawn as excluded, never as failed), a per-layer grid (L1–L5 and
  L2X), and the weighting in a collapsed "Scoring rules". Supports the A|B
  focus toggle.
- **User value.** "How mature is this pack against spec v1.2, and exactly
  which clause fails?" — the actionable detail behind the Diagnose grade.
- **Code surface.** [studio/conformance-view.mjs](../studio/conformance-view.mjs)
  (the view, plus `readConformance`, the pure clause grouping tested in
  `test-library`), scoring in [tools/lib/conformance.mjs](../tools/lib/conformance.mjs),
  `GET /api/packs/:id/conformance` with env overlays. Rubric documented in
  [docs/CONFORMANCE.md](CONFORMANCE.md).
- **Known gaps.**
  - `GET /api/packs/:id/conformance` does not carry `onPlaceholder`, so the
    "Passes on placeholders" group only appears for a report that does (the
    library's validation summary); otherwise the view says passes may rest on
    the pack's template values instead of claiming "real values".
  - When Pack B's conformance hasn't loaded yet the view shows a bare
    "conformance report unavailable" placeholder with no retry affordance.
  - Clause list has no filter (pass/fail/severity) — long lists at tier-1.
- **Test coverage.** Strong at the engine level: server smoke asserts tier,
  score shape, clause IDs, env-overlay behavior; `test-crawl` asserts
  specific clause outcomes; `test-diagnostic-grade` exercises the adjacent
  grading. No UI tests.
- **Readiness: Ready.**

## 3. Schema

- **Current state.** The canonical manifest as the studio sees it: identity
  block (apiVersion/kind/name/version/binding/criticality/env/target/
  owners), a validation provenance note, and the lazily-fetched canonical
  YAML with copy + download. Supports the A|B focus toggle. Proper error
  state on a failed YAML fetch.
- **User value.** "What exactly does the canonical pack say?" — escape
  hatch from the rendered views to ground truth, plus a clean download.
- **Code surface.** [studio/schema-view.mjs](../studio/schema-view.mjs)
  (~150 lines), `GET /api/packs/:id/canonical?format=yaml`.
- **Known gaps.**
  - The validation block is a static "✓ validates" — true by construction
    (packs that fail validation never enter the catalog, and the code says
    so), but it re-validates nothing; a regression in the registration path
    would not surface here.
  - Per `pack::env` YAML cache (`state._schemaYaml`) is unbounded for the
    session (minor; packs are small).
- **Test coverage.** Canonical route (JSON + YAML form, env overlays)
  covered by server smoke. No UI tests.
- **Readiness: Ready.**

## 4. OTLP Coverage

- **Current state.** Spec §3 wire analysis for the focused pack: OTLP
  receiver MUST check with protocols/endpoint, per-signal in/out matrix
  (traces/metrics/logs/profiles) with end-to-end-OTLP verdicts, SDK
  contract (semconv, propagators, languages, sampling, log↔trace
  correlation, resource attributes), and a summary block. Reads the
  canonical manifest, cached per `pack::env`, with an error state on fetch
  failure.
- **User value.** "Is this service actually on OTLP-shaped wire, signal by
  signal — and where does it drop to native protocols?"
- **Code surface.** [studio/otlp-view.mjs](../studio/otlp-view.mjs)
  (~220 lines). Self-contained; no orchestrator calls.
- **Known gaps.**
  - The view supported focused Pack A/Pack B internally but the A|B focus
    toggle was never shown for it **(fixed this pass** — `otlp` joins
    conformance/compile/schema in the toggle's view list**)**.
  - "Receiver (in)" assumes a declared OTLP receiver carries every signal;
    per-signal receiver pipelines aren't modelled (matches the spec's
    granularity today).
  - Profiles are special-cased via `spec.profiling` since the spec doesn't
    put profiles in `pipelines.exporters`.
- **Test coverage.** None direct. The canonical route it reads is
  smoke-tested; the matrix derivation logic is untested.
- **Readiness: Ready with caveats** (derivation logic deserves a unit test
  before it's load-bearing in reviews).

## 5. Traceability

- **Current state.** Two parts: (1) requirement chains for Pack A — a
  decision header, a table separating what exists somewhere from what is
  linked and proven for each requirement, and a list sorted worst first
  (name · chain state · first broken link · next action) where one
  requirement at a time expands into its proof chain, each link read as
  proven / inferred / unverified / missing / not required with the engine's
  codes beside plain-language labels, and a filter grouping every
  requirement that shares a gap (the reading is
  [studio/trace-chain.mjs](../studio/trace-chain.mjs)); (2) with Pack B
  loaded, underneath as details, the repo-vs-live groups (aligned /
  declared, not seen live / live only / declared differently) with
  per-finding suppress and resolve preferences persisted in state.
- **User value.** "Show me the evidence chain for every requirement, and
  what production does or doesn't confirm" — the audit trail behind the
  drift verdicts.
- **Code surface.** `renderTraceabilityView` in
  [studio/compare-view.mjs](../studio/compare-view.mjs) (~220 onward),
  engines in [tools/lib/traceability.mjs](../tools/lib/traceability.mjs) and
  [tools/lib/traceability-graph.mjs](../tools/lib/traceability-graph.mjs).
  Spec: [docs/TRACEABILITY_GRAPH_COMPARISON_SPEC.md](TRACEABILITY_GRAPH_COMPARISON_SPEC.md).
- **Known gaps.**
  - Requirement-branch *reconciliation* (acting on a divergent branch from
    this view) is not built — tracked in [VALUE_BACKLOG.md](VALUE_BACKLOG.md).
  - Suppress/resolve prefs are local to the browser (by design today) —
    no shared team state.
- **Test coverage.** `test-traceability-graph` covers the graph engine and
  the studio's chain reading (a job-level scrape is never proof, a
  declaration alone is never proven, every engine code has a label);
  bucket categorisation is exercised indirectly. UI rendering untested.
- **Readiness: Ready.**

## 6. Atlas

- **Current state.** Six visual atlas variants (strata · periodic ·
  constellation · skyline · transit · arbor) rendered as SVG over Pack A,
  or cross-pack where the variant supports it; constellation gets an A→B
  morph slider; artefact click opens the detail drawer. Falls back to a
  single-pack variant when Pack B is absent; lazy-loads Pack B/diff with an
  error state on failure.
- **User value.** Orientation and communication — the shape of a pack (and
  of drift) at a glance, for humans who don't read clause lists.
- **Code surface.** [studio/atlas-view.mjs](../studio/atlas-view.mjs)
  (~120 lines) over [studio/atlases.mjs](../studio/atlases.mjs)
  (~1,360 lines, all six renderers).
- **Known gaps.**
  - No tests at all on the 1,360-line renderer module; regressions surface
    only visually.
  - Variant availability rules (cross-pack vs single) live in two places
    (atlas-view fallback + pill filtering).
- **Test coverage.** Server smoke asserts the module exports its renderers
  (presence only). Nothing functional.
- **Readiness: Ready with caveats** (fine as an orientation tool; don't
  treat atlas output as evidence until renderers have tests).

---

## Advanced-adjacent controls

Header controls audited for completeness; **no material changes** were made
to them in this pass.

| Control | What it does | Notes |
|---|---|---|
| **api** | Link to `GET /api/packs` (catalog JSON) in a new tab | Read-only; fine. |
| **mcp** | Opens the refresh-production-live panel (`POST /api/refresh-live`) with freshness age chip | MCP URL now validated server-side (SSRF guard); panel has its own status line. |
| **export** | Downloads the focused pack + every compiled artefact as a ZIP (`/api/packs/:id/export.zip`) | STORE-only writer, zip-slip-guarded, smoke- and unit-tested. Hidden until a pack is loaded. |
| **scan a repo** | Crawl panel — drag a folder / pick files / GitHub URL → `POST /api/crawl(-github)` draft pack | Drafts are explicitly marked; 16 MB / 200-file caps server-side. |
| **new from live** | Draft-from-MCP panel → `POST /api/draft-from-mcp` | Same MCP URL validation; draft registered in the upload registry (capped at 20, LRU). |
| **upload** | Validate + register a canonical YAML/JSON pack (`POST /api/validate`), plus two quick-start cases | Schema validation is the gatekeeper. |
| **reset** | Clears uploaded packs (`DELETE /api/uploads`) + saved local state, reloads | Destructive but scoped to session artefacts; no confirm dialog — acceptable since nothing irreplaceable lives in the registry. |
| **theme** | Light/dark toggle | Persisted. |

## Cross-cutting observations

1. **Per-view canonical caches** (`_otlpCanonical`, `_schemaYaml`,
   `_referencesCache`) are independent and session-unbounded. Fine at
   current sizes; a single keyed cache with invalidation on pack reload
   would be the tidier shape (see REFACTORING_PLAN.md §3).
2. **The Advanced menu** now has a stable id (`observa-adv-menu`),
   `aria-controls` on the trigger, focus-on-open to the first item,
   focus-restore to the trigger on Escape/activation, and arrow-key
   navigation **(this pass)**. Outside click closes without stealing focus.
3. **UI test gap is universal.** Every Advanced view relies on engine-level
   tests plus the server smoke suite; none has a DOM-level test. The
   highest-value first target is the OTLP matrix derivation (pure function
   over canonical JSON — easily extracted and unit-tested).
