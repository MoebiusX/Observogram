# Pack operations — the verb rule

**Status: design proposal, 2026-10-19. Nothing in this document is built.** It
answers the maintainer's question of the same day — *why can I only export
dashboards from the Build pack? why not from Diagnose? some functions should
always be available* — by generalising a rule the studio already half-keeps.
It extends "What is not simplified: the pack operations" in
[`UX_SCREEN_GRAMMAR.md`](UX_SCREEN_GRAMMAR.md) from a list of header buttons
into a rule every operation can be held to, and it is the frame the UPDATE
journey ([`UPDATE_JOURNEY.md`](UPDATE_JOURNEY.md)) already builds in: `update`
is designed to sit "in the operations row beside `export`", an operation on a
pack, not a stage of a screen.

## The job

> Diagnose just showed me the dashboards my service is missing. I want those
> dashboards — the compiled JSON — without leaving the verdict. And my pack
> was scanned, not built, so Build's download buttons do not exist for it
> anywhere.

## The rule

A pack operation — a *verb*: export, compile, deploy, compare, update — binds
to a pack, never to a screen. Three sentences carry it:

1. **Journeys order verbs; they never gate them.** Discover → Diagnose →
   Remediate and Define → Compile → Verify stay the two guided paths
   ([`UX_SCREEN_GRAMMAR.md`](UX_SCREEN_GRAMMAR.md), "Two journeys, one
   pack"). A journey decides what a screen *leads with*; it does not decide
   what the pack *can do*. A verb reachable on one screen is reachable
   wherever its object is shown.
2. **One verb, one flow.** Summoning a verb from another screen opens the
   same canonical surface — the deploy modal, the compile preview —
   preselected for where it was summoned, never re-implemented. Two flows
   for one verb will disagree, and the honesty machinery (partial-evidence,
   scaffold, verification-not-validation language) travels with the flow or
   not at all.
3. **An unavailable verb says why.** Drawn disabled with the reason — no
   pack loaded, a viewer role, a static bundle, an object it cannot act on —
   never hidden, and never a control that cannot do what its label says.
   `studio/static-remedies.mjs` already does this for deploy in the static
   bundle; the UPDATE journey specifies it for roles (*a viewer sees
   `update` disabled, with the reason*).

## The precedent: deploy already obeys it

The deploy review is one app-level modal. Remediate opens it as its stage;
Diagnose summons it **preselected** with the declared-not-live set
(`drift-deploy-missing`, `studio/compare-view.mjs:1561`) — the same modal,
the same review, nothing duplicated. And where it cannot act, the static
bundle draws every deploy control unavailable with the reason instead of
hiding it (`studio/compare-view.mjs:75`). This document asks the other verbs
to behave like deploy.

## The inventory, on today's code

| Verb | Object | Offered today | Missing | The one flow behind it |
|---|---|---|---|---|
| **export** the pack (YAML + every compiled artefact, one ZIP) | the focused registered pack | header operations row, every workspace screen (`studio/app.mjs:3863`) | nothing — already a verb | `GET /api/packs/:id/export.zip` |
| **export one compiled artefact** (a dashboard's JSON, a rules file, a routes file) | today: only a Build *draft* | Build's Verify, per-target preview + download (`studio/app.mjs:4484`) | everywhere, for every **registered** pack of every origin — built, uploaded, scanned, drafted from live | the compile-preview endpoints; the engine exists, the affordance does not |
| **compile preview** | a Build draft; the focused pack | Build's Verify; Remediate | Discover's artefact drawer; Diagnose | `/compile/:target` and kin |
| **deploy** | the selected artefacts | Remediate; summoned preselected from Diagnose | nothing — the rule's model citizen | the deploy modal |
| **retrofeed** | the A-vs-B comparison | Diagnose | nothing: its object exists only where a comparison does — the rule binds verbs to objects, and this object lives in Diagnose | `POST /api/packs/:id/retrofeed` |
| **compare** (load Pack B) | the workspace | header pickers, every workspace screen | nothing | the header pickers |
| **update** | a pack | not built | designed as a verb from birth ([`UPDATE_JOURNEY.md`](UPDATE_JOURNEY.md), "Where it starts") | Open → Compile → Verify |

The pattern in the gaps: **a verb implemented as a stage of the journey that
first needed it stayed welded to that journey's screen.** Per-artefact export
was built for Build's hand-off, so only a Build draft has it; a scanned pack
— the pack most likely to be handed a gap by Diagnose — has no way to yield
a single compiled file at all.

## What it takes

View-layer only; engines and endpoints untouched, as the redesign brief
requires.

| Slice | What the user gets | How |
|---|---|---|
| **1 · the missing export** | Any registered pack yields one compiled artefact: the artefact drawer gains a *download compiled file* on rows that compile to one. Diagnose's drift actions gain **export the missing set** beside *Deploy repository changes to live* — the same selection the deploy button builds, compiled and downloaded, for what leaves by file (routes, pipelines) and for teams whose hand-off is a repository PR, not a live write. | the existing compile endpoints; the selection logic `deploySelectionFromEntries` already builds |
| **2 · compile preview summonable** | Remediate's compile preview opens from the drawer and from Diagnose, preselected, the way the deploy modal does. | lift the preview to an app-level surface, as the deploy modal already is |
| **3 · one reason grammar** | Every disabled verb states its reason the same way — no pack, role, static bundle, wrong object. | extend `static-remedies.mjs`'s pattern to the other causes |

Build's Verify downloads stay as they are: a draft is not a pack, and the
door from a registered pack back into editing is the UPDATE journey's, not
this rule's.

## What the rule never does

- Fork a second, lighter flow for a verb that has one.
- Drop a banner the canonical flow would show because the verb was summoned
  from somewhere else.
- Offer a verb on an object it cannot act on: `update` on a scan answers
  with what a scan is (the Open table in
  [`UPDATE_JOURNEY.md`](UPDATE_JOURNEY.md)), it does not disappear.
- Turn the operations row into a menu. The grammar's promise holds —
  *buttons, never behind a menu*; verbs beyond the row live on their
  objects (a drawer row, a drift action), not in a dropdown.

## Decisions for the owner

1. **Where the single-artefact export lives.** (a) On the artefact drawer
   row — every screen that opens the drawer gets the verb for free, Discover
   included; Diagnose's *export the missing set* is the bulk form of the
   same verb. (b) Only on Diagnose's drift actions.
   *Recommended:* (a). The drawer is already the one place an artefact is
   the same object on every screen.
2. **Is export offered on Pack B and on reference packs?** Read verbs are
   universal — a reference pack is read-only, not export-less; write verbs
   (deploy, update) follow roles as they do today.
   *Recommended:* yes.
3. **The button's words.** The deploy action says *Deploy repository changes
   to live*; its export twin should name the same set and its different
   destination — *Export repository changes as files*, or plainer. Naming is
   the owner's; the pairing (same set, two destinations, side by side) is
   the design.

## See also

- [`UX_SCREEN_GRAMMAR.md`](UX_SCREEN_GRAMMAR.md) — the screen contract this
  extends; "What is not simplified: the pack operations".
- [`UPDATE_JOURNEY.md`](UPDATE_JOURNEY.md) — the first operation designed
  under this rule, and the owner decisions it already carries.
- [`USER_JOURNEY.md`](USER_JOURNEY.md) — Discover · Diagnose · Remediate.
- [`UX_REDESIGN_BRIEF.md`](UX_REDESIGN_BRIEF.md) — principle 3, "next action
  always visible", which this rule generalises from *the* next action to the
  verb set.
