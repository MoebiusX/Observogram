# Diagnose & Remediate — the redesign synthesis (behind ?proto)

*The converged design for [UX_REDESIGN_BRIEF.md](UX_REDESIGN_BRIEF.md),
2026-06-11. **Gated behind any `?proto=` value** (e.g.
`http://localhost:8000/?proto=1`) pending maintainer ratification —
without the query param the production tabs render untouched, except the
restored grade narrative (chip · blurb · ladder note), which is a
ratified-state fix, not part of the redesign. Implementation:
`studio/proto-synthesis.mjs` + `studio/verdict-ui.mjs`, reusing the
production renderers (chain cards, posture stack, retrofeed POST) via
exports so no semantics are duplicated. Screenshots (krystaline repo vs
production-live MCP draft, both themes):
[docs/img/ux-redesign/](img/ux-redesign/).*

## Diagnose — "Can we trust it?"

One page, top to bottom, each band answering before the next deepens:

1. **Verdict header (ratified — narrative restored).** The
   `B · Industrial Grade` chip beside the eyebrow, the blurb sentence
   ("Suitable for production… Diagnostic-grade (A) begins above 85% —
   this pack is 21.0 pp below the bar"), the Score/Coverage/Trust/Audit/
   Verified summary rows, the **biggest-drag callout** (the badness
   bucket costing the most units, with the engine-projected effect of
   fixing it), and the full labelled instrument ladder with its
   derivation note. A grade is never shown without its sentence.
2. **Action strip (sticky).** Deploy-the-missing-set (deploy modal,
   preselected) · Retrofeed shadow signals (the real `/retrofeed` POST
   with downloads) · Re-verify (Journeys) · Open Remediate. The most
   valuable pixels are never buried mid-scroll again.
3. **Partial-evidence banner** — before anyone reads numbers.
4. **Trend tiles.** Score trend and Drift fidelity with sparkline +
   "▲/▼ pp vs previous run" from journey run history
   (`.observogram/runs/`); Chain integrity and Freshness as stat tiles.
   No history → an honest "no run history yet" note, never a fake trend.
5. **Panel grid** — every report focused, glanceable, expandable (⤢):
   *Signal Lattice* (weighted health/badness donuts + legend; risk-note,
   scaffold/out-of-scope notes and the widen-scope action in the detail) ·
   *Strata Drill* (per-layer heat counts; sample artefact keys + drifted
   fields in the detail) · *Requirement Chains 2B.G* (rollup cells; the
   full ratified chain cards **with per-branch deploy/adopt buttons** in
   the detail) · *Coverage 2A* / *Trust 2B* / *Operability 2C* (verdict
   chips; full observed-vs-expected tables in the detail; WARN/INFO
   banners intact) · *Evidence Ledger* (failing assertions at a glance;
   full field-by-field trail in the detail) · *Posture Matrix* (the
   complete ratified stack — headline verdict word, per-layer pies,
   matrix, narrative — in the detail).

The Compare sub-tab (raw A-vs-B side-by-side) is unchanged.

## Remediate — "Fix the gaps"

A triage queue, not a form:

1. **KPI band.** Findings (with total weighted badness) · Selected ·
   Deployable (identities · rows) · **Projected grade** — "from B (64%)
   to A (87%)" recomputed by the verdict engine on the hypothetical
   post-fix diff for the current basket.
2. **The queue.** Every finding from the same scoped diff Diagnose
   graded, ordered by the engine's own weights (declared-not-live 1.0 ·
   drifted 0.5/1.0 decision-bearing/0.1 cosmetic · live-not-declared
   0.15). Each row: class chip, badness, fix path (DEPLOY / RETROFEED /
   FIELD DECISION / MANUAL), one-click deploy on deployable rows,
   checkbox basket. Fix-path filters with counts; live-scope control on
   the band.
3. **Retrofeed patch.** The basket's retrofeed rows emit the same
   ReconcilePatch YAML as before, scoped to the selection.
4. **Sticky deploy bar.** Deploy N selected + the projection sentence.
5. The per-artefact **compiler drill-down** below is unchanged.

## Honesty (non-negotiable, verified)

Partial-live-evidence banner on both tabs; scaffold and out-of-scope
notes (with the widen-scope reclassify action); 2C informational-never-
scored framing; verification ≠ validation language; the projection's
honesty fence — requirement-chain integrity held constant,
freshness/chaos never projected, and when the drift criterion is
anchored on chain integrity the UI says *"repairs chains on the next
live verification (not projected here)"* instead of faking a delta.

## Implementation map

| Piece | File |
|---|---|
| Synthesis prototype (verdict page + triage queue) | studio/proto-synthesis.mjs |
| ?proto gate + switcher pill | studio/proto-view.mjs |
| Shared model/projection/widgets | studio/verdict-ui.mjs |
| Mission-control styles (`.mc-*`, `.rq-*`, `.diag-head-drag`) | studio/app.css |
| Ratified renderers reused via export (chains, posture, retrofeed) | studio/compare-view.mjs, studio/compile-view.mjs |

Engines untouched; production views untouched without `?proto`. The
three divergent prototypes that preceded this synthesis (`?proto=a|b|c`)
were retired — see UX_PROTOTYPES.md and git history.
