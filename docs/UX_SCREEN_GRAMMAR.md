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
   name both sides (the live pack and the selected baseline), not just A/B.
2. **Decision** — one sentence stating the outcome.
3. **Next action** — one prominent button.
4. **Explanation** — a few measures and the reasons behind the decision.
5. **Details** — filters, artefacts, proof, configuration, raw output.

`decisionHeaderHtml()` renders 1–4. Reference material (grade ladders,
scoring formulas, rubric weighting) goes in a collapsed `disclosureHtml()`.
Long pages get a sticky `sectionNavHtml()` with an issue count per section.

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
