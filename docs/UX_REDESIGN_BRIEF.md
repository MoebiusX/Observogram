# UX Redesign Brief — Diagnose & Remediate

*Commissioned by the maintainer 2026-06-10. This document carries full
context so a fresh session — or an outside reviewer with no history —
can start the design work cold. It is a brief, not a spec: it defines
the problem, the constraints, and how we'll judge proposals. It does
NOT prescribe the solution.*

> **Status 2026-06-11 — synthesis built, gated behind `?proto`.** The
> three divergent directions were converged into ONE design (a menu of
> options was judged "load, not help"); it runs behind any `?proto=`
> value pending maintainer ratification, with production untouched. See
> [UX_DIAGNOSE_REMEDIATE.md](UX_DIAGNOSE_REMEDIATE.md) and
> [docs/img/ux-redesign/](img/ux-redesign/).

## Why this exists

The verdict engine is in good shape: grade schema 2 (seven scored
criteria + informational operability), the instrument-grade ladder
(D…A++ anchored at A > 85%), weighted drift fidelity, partial-live-
evidence detection, journeys, retrofeed, deploy/rollback. The trust
layer is honest and tested.

The presentation is not selling it. The maintainer's words: *"the
second and third tabs are confusing and underwhelming … I need an
awesome user interface … we have a great use case, we only need to
show it properly to be successful."* Months of features were bolted
into the same long scrolls; every screen answers ten questions at once
and therefore none. This brief commissions a design-first pass — no
more incremental patching.

## The product story (unchanged, non-negotiable)

```text
1 DISCOVER   What do we have?      — the observogram
2 DIAGNOSE   Can we trust it?      — coverage & fidelity verdict
3 REMEDIATE  Fix the gaps          — compile & deploy the delta
```

One journey, three questions. The redesign must make each tab answer
ITS question in seconds, with the next action obvious.

## Current state — honest inventory

### Tab 2 · Diagnose (studio/compare-view.mjs, ~3000 lines)

Two sub-tabs: **Diagnostic Grade** (the verdict report) and **Compare**
(raw A-vs-B side-by-side). The grade page stacks, top to bottom:

1. Header: summary rows (Score/Coverage/Trust/Audit/Verified) +
   instrument-grade ladder beside them (recently redesigned — keep).
2. Drift drill: two donuts (weighted health / badness), 4-bucket
   legend with weights, weighted-badness footnote, a 7-layer × 4-bucket
   table with sample artefact keys, scaffold/out-of-scope footnotes,
   action buttons (deploy-the-missing-set, retrofeed shadow signals).
3. Requirement chains (2B.G): per-SLO derivation-integrity cards with
   per-branch deploy/adopt buttons.
4. 2A Coverage table (4 criteria), 2B Trust table (3 criteria, WARN
   banner), 2C Operability (informational).
5. Evidence ledger: 8 rows of field/expected/observed/status.
6. Posture matrix narrative lives in a separate band.

**Problem:** that is an audit DOCUMENT — five reports stapled
together. Nothing tells the user which of the five to read, what the
single biggest problem is, or what to do next. The action buttons
(the most valuable pixels on the page) are buried mid-scroll inside
the drill. Counts repeat across bands (drift buckets appear in the
donuts, the legend, the layer table, and the chains).

### Tab 3 · Remediate (studio/compile-view.mjs)

Remediation plan (A-minus-B rows with checkboxes, deployable vs
manual), live-scope control, compile preview, target/version pickers,
deploy modal (bulk deploy, history, rollback, re-verify countdown).

**Problem:** it reads as a form, not a worklist. No triage framing
(what's high-value vs noise — the weighted badness data exists but
isn't used to ORDER anything here), no sense of progress (you fixed
14 of 90), and the connection back to "this is what moves your grade
from B to A" is never drawn.

### What already works (don't regress)

- Discover tab and the layered observogram.
- The grade header: score rows + ladder side-by-side.
- The honesty machinery: partial-evidence banner, scaffold notes,
  out-of-scope parking, verification-not-validation language.
- The loading spinner / retry on comparison fetch.

## Design principles for proposals

1. **One hero answer per screen.** Diagnose leads with the verdict and
   the ONE thing costing the most grade. Remediate leads with the
   highest-value fix. Everything else is drill-down.
2. **Progressive disclosure.** The five reports remain reachable —
   as chapters/panels you open, not a wall you scroll.
3. **Next action always visible.** Deploy-the-missing-set, retrofeed,
   re-verify — persistent, not buried.
4. **Draw the line from evidence to grade.** "Fixing these 14 takes
   you from B (65%) to A (87%)" is the sentence that sells the
   product. The engines can compute it today (re-run the grade on a
   hypothetical post-fix diff).
5. **Numbers appear once.** Each count has one home; other mentions
   link to it.
6. **Demo-grade aesthetics.** This UI must carry a live dry-run in
   front of stakeholders. Underwhelming is a defect.

## Aesthetic direction — "alien-like" mission control (maintainer-set)

The maintainer's target look is calibrated by his own KrystalineX
Grafana dashboards (GenAI Operations Overview · AI RCA Reliability &
Queue Health · MCP Observability & Trace Coverage — drop screenshots
into `docs/img/ux-refs/` so cold readers see them). What makes those
boards feel advanced is decodable; reproduce the qualities, not the
widgets:

1. **Hero KPI band.** A top row of stat tiles — big number, unit,
   colored sparkline, delta vs a previous window ("▲ 0.62 pp vs 6h
   ago"). Observogram mapping: Score · Coverage · Trust · Drift fidelity
   · Freshness · Verified as tiles, with sparkline + delta powered by
   **journey run history** (the data already exists in
   `.observogram/runs/`). The grade ladder sits beside this band.
2. **Per-tile color identity.** Each tile owns a saturated accent on
   the dark ground (green/blue/purple/amber/red fills) — glanceable
   semantics, not rainbow decoration. Light theme must still hold.
3. **Density done cleanly.** Many panels, but every panel has one
   title, one question, min/avg/max-style micro-stats in the legend.
   No prose inside panels.
4. **Verdict chips everywhere.** Pass/Fail/Warn, FIRING/PENDING/OK —
   colored status chips in tables, exactly like the "Coverage
   Findings" and "Current Alert State" tables in the references.
5. **Actions as a first-class table.** The references end with
   "Recommended Next Actions" — finding, owner, when. That IS
   Remediate's triage queue: drift finding · weighted badness · fix
   (deploy/retrofeed/manual) · one-click act.
6. **Dramatic-but-precise naming.** "MCP Signal Lattice", "Reliability
   Matrix" — names that sound advanced and are literally accurate.
   Observogram already owns the "-gram" — the observogram is the image the instrument draws; lean into the instrument/imaging
   vocabulary (lattice, strata, drill, posture).
7. **Dark-first, glowing accents, zero clutter chrome.** Filter bar
   (env/service/pack/time) styled as quiet chips; "Powered by" footer
   energy — the page should look like an instrument, not a document.

Note: the studio's OBSERVA chrome and Atlas views already trend this
way; the redesign should make Diagnose/Remediate feel like they belong
to that family. Direction B below starts closest to the references —
but all three directions should wear this skin.

## Process — how we'll work

1. **Three divergent prototypes**, built as real clickable HTML pages
   (this codebase is vanilla HTML/CSS/JS — prototype IN the studio,
   e.g. behind `?proto=a|b|c` or a /prototypes route, using real data
   from the loaded packs). Deliberately different, not three shades of
   the same idea:
   - **A · Verdict-first narrative** — hero verdict + "biggest gap"
     callout; chaptered evidence below, collapsed by default.
   - **B · Mission control** — glanceable card grid (grade, drift,
     chains, freshness, actions); each card drills into a focused panel.
   - **C · Guided flow** — Diagnose as steps (verdict → evidence →
     pick gaps → hand off); Remediate as a triage queue ordered by
     weighted badness, with a deploy basket and progress meter.
2. **Judging criteria:** time-to-answer ("can we trust it?" in <10s),
   time-to-action (one click from verdict to doing something),
   demo impact (does the dry-run story land), honesty preserved
   (banners/caveats survive), implementation cost.
3. The maintainer may circulate prototype screenshots to other
   models/people for reactions — feedback should target concrete
   options. Synthesis may freely combine directions.
4. Winning direction is implemented tab-by-tab on its own branch by
   PR. Engines untouched; this is view-layer only.

## Constraints

- **Zero dependencies, no framework.** Vanilla ES modules, the
  existing CSS-variable theme (light + dark), no build step.
- **Engines and APIs untouched.** diff/grade/retrofeed/journeys are
  ratified semantics; the redesign consumes them.
- **Honesty is non-negotiable.** Partial-evidence, scaffold,
  out-of-scope, verification≠validation language must survive any
  redesign verbatim in spirit.
- **The process bar holds:** branch + PR for the rebuild, lint/test
  green last, browser-verified, docs same turn
  (see docs/BRANCHING.md).

## Key files for the implementer

| Surface | File |
|---|---|
| Diagnose view (grade report, drift drill, chains) | studio/compare-view.mjs |
| Remediate view (plan, compile, deploy) | studio/compile-view.mjs |
| Verdict engine (pure, do not modify) | studio/diagnostic-grade.mjs |
| App orchestration / tabs / deploy modal | studio/app.mjs |
| Theme + all styles | studio/app.css |
| Grade contract & scale docs | docs/USER_JOURNEY.md, docs/RELEASE_READINESS.md |

## Definition of done

Tabs 2 and 3 each answer their question in seconds, surface one clear
next action, preserve every honesty mechanism, look demo-grade in
both themes, and the maintainer says "this shows the use case
properly" — not "better than before".
