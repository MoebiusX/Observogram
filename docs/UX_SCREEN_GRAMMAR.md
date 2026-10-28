# The studio's screen grammar

The 2026-09 UX review of the studio found a strong model — discover a pack,
diagnose it, trace its evidence, compile it, build a new one — behind screens
that asked people to understand that model *before* they could finish a task.
This page is the contract every working screen now follows. The helpers live
in [`studio/ux-kit.mjs`](../studio/ux-kit.mjs), the shared styles in
[`studio/ux.css`](../studio/ux.css).

## Two journeys, one pack

| Journey | Goal | Steps |
| --- | --- | --- |
| Check an existing service or pack | Understand what exists, whether it works, what to fix | Discover → Diagnose → Remediate |
| Build a new pack | Define the service, create its artefacts, assess readiness | Define → Compile → Verify |

Home shows a neutral header and asks one question; the stepper for a journey
appears only once it is chosen. Verify hands off with **Open pack in
Discover**: the generated pack is the same kind of object the check journey
inspects.

## Every screen, in this order

1. **Context** — service, environment, pack and version. Comparison screens
   name both sides (the live pack and the selected baseline) beside the A/B
   letters the header pickers carry.
2. **Decision** — one sentence stating the outcome.
3. **Next action** — one prominent button.
4. **Explanation** — a few measures and the reasons behind the decision.
5. **Details** — filters, artefacts, proof, configuration, raw output.

`decisionHeaderHtml()` renders 1–4. Reference material (grade ladders,
scoring formulas, rubric weighting) goes in a collapsed `disclosureHtml()`.
Long pages get a sticky `sectionNavHtml()` with an issue count per section.

## Discover is a catalogue

Discover lists what the open pack holds, layer by layer, and judges nothing.
With one pack loaded there is no reference: no live evidence was looked for
and nothing was compared, so "0 with live evidence" or "36 need attention"
would be findings about nothing. It has no decision sentence, no next action,
no evidence or attention counts, no task filters and no required-check chips.
Assessment, comparison and what to fix start in Diagnose, where there is
something to judge against.

It is drawn as a board (`studio/discover-board.mjs`), after the
*ObservabilityPack realisation* sheet: a head that names the pack and the
facts its manifest states, then one band per layer in the layer's colour,
each a row of groups holding what the pack has there — SLI tiles and SLO
dials, the telemetry pipeline in flow order, rules → views → dashboards,
detection → routing → remediation, validation. Every item is an artefact and
opens its record; a band opens the layer's full list, where each row still
shows its own source.

## What is not simplified: the pack operations

The grammar simplifies what a screen *shows* — layers, artefacts, evidence.
It does not fold away what the user *does* with a pack:

- The header names the two packs **Pack A** and **Pack B**, each with its
  environment, on every workspace screen (Discover included), and keeps
  **upload**, **scan a repo**, **new from live**, **export**, **mcp**,
  **reset** and **api** as buttons, never behind a menu.
- Compare leads with the two pack cards (their pickers, swap between them)
  and the set arithmetic (only in A · in both · only in B · union · jaccard),
  and opens on **Side by side**. *Changes needing review* and *Summary* (the
  decision header and what each number means) are the other two views.
- An *only in* group says what that costs, where the pack records it: for
  the metrics a repository scan declares, the alert rules, dashboard panels
  and recording rules that read them (`studio/metric-readers.mjs`). It says
  what the two packs show — "reads a metric Pack B does not hold" — never a
  verdict they do not, such as "this alert cannot fire".

## One status vocabulary, four properties

| Property | Values | Question |
| --- | --- | --- |
| Origin | Library, imported, discovered, authored | Where did this come from? |
| Completion | Draft, needs input, complete | Have we filled it in? |
| Evidence | Live evidence found, declared only, unverified, missing | What supports it? |
| Assessment | Pass, represented (on a placeholder), warning, fail, not evaluated, not applicable | Did it meet this check? |

Show only the properties relevant to the screen. `statusChipHtml()` renders
one; `statusFromLegacy()` maps an engine's old word (verified, scaffold, pass
on placeholder, conformant …) to the property it actually describes. Each
property has its own chip shape, so colour is never the only cue.

## Plain language first

The formal term follows the plain meaning, never replaces it:

| Formal | On screen |
| --- | --- |
| Can We Trust It? | How reliable is this pack? |
| Fix The Gaps | Resolve gaps |
| Diagnostic Grade | Assessment |
| Current vs Target | Live pack compared with selected baseline |
| Beyond target | Additional in live pack |
| Retrofeed | Update repository from live |
| Scaffold | Template value needs completion |
| Pass on a placeholder | Requirement represented; real value still needed |
| Conformant (Verify) | Meets tier rubric |
| Is It Ready to Use? | What is ready, and what remains? |

`termHtml()` shows the plain words with the formal term and its definition on
hover and focus; `GLOSSARY` is the single place a definition lives.

The operator's glossary is the other voice beside it: a taxonomy file at
schema version 2 may carry a `glossary` (README "Classify Typed Packs"), and
`studio/glossary.mjs` draws its definitions as a mark (`.ux-gloss`, a real
button that opens the definition; hover and focus preview it, Escape closes
it) beside the family label of a Discover row, a board group title, a head
fact, and the drawer's kind row and section heads. `termHtml` explains the
studio's own words; the glossary mark explains the operator's families and
terms. Neither is drawn when nothing explains the label.

## Interaction rules

- One primary action per state.
- Source and destination are explicit whenever comparing, importing,
  generating patches or deploying.
- Preserve work: selections, filters, scroll context, unsaved values.
- Processing is observable, and announced once per change through the
  `#ux-status` live region (`announce()`).
- Empty states say what was checked and offer the next step
  (`emptyStateHtml()`), never a wall of zero counters.
- A concise overview comes before dense evidence; every underlying claim stays
  one expansion away.
- Severity is consistent: an extra artefact, a drifted field and a missing
  required clause do not share a colour.
- Readable defaults: body copy 15px, labels 13–14px, monospace only for IDs,
  expressions and generated code; muted text meets WCAG 2.2 AA contrast.

## One visual language

The look is decided in one place and is portable (docs/VENDORING.md):
`studio/design-tokens.css` holds every value, `studio/design-kit.css` the
pieces (`.og-*`), `studio/design-bridge.css` themes the older view styles
from the tokens, and `studio/reskin.css` — this studio's adapter, loaded
last — maps the screens that predate the kit onto them. The system:

- **Type** — one sans; monospace for code only (`--code`).
- **Colour** — one page, one panel, one line. Lime: the primary action and
  "where I am" (current step, pressed option, Pack A). Purple: the second
  voice (Pack B, Build). Amber: attention. Rose: what fails or is removed.
  Layer colours (L1–GOV) are data and stay.
- **Surface** — a 1px line and a 9px radius. No glow, no gradient, no wash:
  a tone is a line down the panel's edge and the colour of its numbers.
- **Controls** — a primary button (lime), a secondary (outlined), a text
  button; pills with a 5px radius; inputs on the page colour.

A new screen uses the `.og-*` classes and the `--og-*` tokens; it does not
bring a font, a gradient or a button of its own, and it needs no line in
`reskin.css`.

## Two faces: Overview and Expert

Everything above is Expert: the studio for the people who do the work. Most
people who open it are not those people, and for them there is **Overview**
(`studio/overview-model.mjs`, `overview-view.mjs`): one service at a time,
and the machine drawn as pictures under plain questions — a board of three
columns that carry Expert's own words, so the two faces read as one product.
The same model has a simple layout, the three sentences alone, as the
fallback (`?layout=simple`, remembered; drawn by the renderer itself should
the board fail, and for a service without a pack of its own).

| Column | Question | What is drawn | Where it comes from |
| --- | --- | --- | --- |
| Discover | What is in place | The stack top down (user experience · application · platform · infrastructure), each layer with ten cells, one per kind of signal, lit where the repository declares some and carrying the count; *7 of 10 kinds*; a legend; the pack's own layers as counts; what could not be placed | `computePostureMatrix(pack, null).cells`, distinct declared artefacts per cell; `layerItemsFor` per pack layer; the four layers' average is the Comprehensive criterion |
| Diagnose | Are the right signals in place? | The grade letter in a shield; its ladder name in plain words; whether it was graded against live or from the repository alone; the specification's required rules as a bar (*12 of 15 required rules met for a tier 2 service.*); the seven criteria as one plain sentence each with a *Yes · Partly · No* pill, the yeses first, and the sum with the next band (*4.8 of 7 points. B+ starts at 5.3.*) — open on a tall monitor, behind *Why this grade* under 1000 px | `computeDiagnosticGrade` — the journey's last run when it graded this pack against live, else the pack alone; `GET /api/packs/:id/conformance`; the seven lines from the pack-alone criteria plus the run's chain integrity and live age, withheld unless they add up to the letter |
| Diagnose | Can you trust what the signals show? | The alignment as a ring; four counts — *match · run differently · not running live · live only*; the promises as a bar (*5 of 18 promises hold end to end, 1 in part.*); which probe families could not be read; then one of four words — *Never checked · Unchanged · Changed · Unreachable* — and one sentence with a time, and **Check again**. Withheld with the reason, never as zeros, when nothing live was seen whole | the service's journey and its last run (`/api/journeys`, `…/runs`): `drift`, `traceability`, `probes` |
| Remediate | What to change | *38 to add · 5 to update · 30 to review*, each with its plain note; one sentence, one button, at most three plain items behind *Why* | the run's drift counts; the assessment's causes when nothing live was checked |

Rules Overview adds to the grammar: four status words and no others; never a
percentage, a layer code, an artefact id or an engine word (declared only,
scaffold, candidate, recorded live) in a sentence — the board's ring and bars
carry a number as a picture, the model keeps it a number and the renderer
puts the sign on it; every sentence a projection of an
existing route or engine, and what cannot be known is said (*Never checked
against live.*); exactly one primary button on the screen; each column ends
in the link to its Expert view, bound to the service. A journey whose
Pack B is a recording is worded *against a live recording from 7 Oct* and has
no Check button — re-reading a file proves nothing about production. A live
side that showed less than the check before (a probe family newly failed)
never reads as a count: the sentence says what could not be read, the
letter falls back to the repository's and says why, Check again is the one
thing to do. The service picker lists the rows with a pack of their own; a row that only
appears in a live draft has nothing to grade and is Expert's to show (it
stays listed only while it is the one remembered).

The switch between the two faces sits in the chrome on every screen. Expert
is one click away and unchanged; Overview is the first-run default when the
services table has rows, the home when the workspace is empty. The choice is
the browser's (`studioUiMode.v1`, `?mode=`), never the snapshot's.
