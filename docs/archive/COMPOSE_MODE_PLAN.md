# Compose Mode — visual pack authoring

A new mode in Observogram where you build a pack by composing
pre-defined artefact blocks instead of writing YAML. The block library
is sourced from the reference catalogue (curated packs per service
type), the studio's own template inventory, and the user's previous
packs.

User framing:
> "Author packs with the help of the Observogram UI, where from a
> repository of SLIs/SLOs, one would drag and drop to Layer 1, and
> evolve the pack from there."

The core insight: **canonical v1.2 manifests are too much surface area
to hand-write reliably.** The pack is *generated* — via x-ray, MCP
draft, or composition. Compose mode is the third path: a guided
authoring surface where the user composes from known-good blocks.

---

## North-star UX

Three-pane layout, full-screen mode (own view in the view nav):

```
┌──────────────────┬──────────────────────────────────┬────────────────────┐
│                  │                                  │                    │
│   BLOCK LIBRARY  │        LAYERED CANVAS            │  ARTEFACT INSPECTOR│
│                  │                                  │                    │
│  ▼ SLIs          │   L1 — Contract                  │  selected: SLI-04  │
│   • availability │   ┌────┐ ┌────┐ ┌────┐ ┌────┐    │                    │
│   • latency-p99  │   │SLI │ │SLI │ │SLI │ │SLO │    │  id        SLI-04  │
│   • error-rate   │   │ 01 │ │ 02 │ │ 03 │ │ 01 │    │  type      ratio   │
│   • saturation   │   └────┘ └────┘ └────┘ └────┘    │  query     ...     │
│                  │   ┌────┐                         │  unit      ratio   │
│  ▼ SLOs          │   │SLO │   ← drop here           │  threshold 0.999   │
│   • 99.9% / 30d  │   │ 02 │                         │  bound_to  ─       │
│   • 99% / 30d    │   └────┘                         │                    │
│                  │                                  │  ─────────────     │
│  ▼ BACKENDS      │   L2 — Telemetry                 │  references        │
│   • prometheus   │   ┌──────┐ ┌──────┐              │   used by: SLO-02  │
│   • mimir        │   │  BAK │ │  PIP │              │                    │
│   • tempo        │   │ prom │ │ otel │              │  EVIDENCE          │
│   • loki         │   └──────┘ └──────┘              │   inherited from   │
│                  │                                  │   kafka pack tier-2│
│  ▼ DASHBOARDS    │   L3 — Insight                   │                    │
│   • slo-overview │   ┌──────┐                       │  [ remove ]        │
│   • per-svc      │   │ DASH │                       │  [ edit YAML ]     │
│                  │   └──────┘                       │                    │
│  ▼ ALERTS        │                                  │                    │
│   • burn-rate    │   L4 — Action                    │                    │
│     fast / slow  │   policy   alerting   healing    │                    │
│                  │                                  │                    │
│  ▼ FROM CATALOGUE│   L5 — Validation                │                    │
│   • kafka tier-2 │                                  │                    │
│   • ibm-mq tier-2│   GOV                            │                    │
│   • kong tier-2  │                                  │                    │
│                  │                                  │                    │
│  ▼ FROM HISTORY  │   ───────────────────────────    │                    │
│   • my-payments  │   [ Live YAML preview ]          │                    │
│   • my-fraud     │                                  │                    │
│                  │                                  │                    │
└──────────────────┴──────────────────────────────────┴────────────────────┘
```

---

## Interactions

### Drag-and-drop

1. **Drag from library, drop on layer** — adds the artefact to that
   layer with placeholder fields filled.
2. **Drag from library, drop on existing artefact** — creates a binding.
   E.g. drag an SLO onto an SLI card → SLO binds to that SLI.
3. **Drag a "whole pack" from the catalogue** — pre-populates every layer
   with the catalogue pack's artefacts, ready to customize.

### Click-to-edit

- Click any artefact card → inspector panel opens with field-level edit.
- Edit propagates to the live YAML preview at the bottom of the canvas.
- Field validation happens on blur (red border + tooltip on error).

### Remove / reorder

- Click × on a card → removes; if other artefacts referenced it, they
  get a "broken reference" warning.
- Drag a card within its layer → reorders display only (doesn't change
  spec semantics; spec.slis[] is unordered).

### Composition (the killer feature)

- Drag a card from the canvas → drop on the *library* sidebar → saves it
  as a personal template for reuse across packs.
- Drag an entire layer's selection → drop on the library → saves as a
  composable preset.

---

## Block library — sources

| Source | What's in it |
|---|---|
| **Observogram standard library** | ~40 curated atomic templates (availability SLI, latency-p99 SLI, ratio recording rule, burn-rate alert fast / slow, …) shipped with the studio. Versioned alongside the spec. |
| **Reference catalogue** | Each pack in `MoebiusX/otel-observability-pack-catalogue` exposed as a draggable whole-pack + as individual draggable artefacts. "Drag the Kafka tier-2 broker-availability SLI" = the catalogue authoritative version. |
| **User history** | Every pack the user has previously composed. Dragging an artefact from a past pack copies it (deep clone, fresh id) into the new pack. |
| **Inline custom** | "+ Create artefact" button in the library — opens a blank inspector for ad-hoc authoring. |

---

## Architecture

### Server endpoints

```
GET  /api/library/standard          — Observogram's standard library JSON
GET  /api/library/catalogue/:packId — catalogue pack exposed as draggable blocks
GET  /api/library/history           — the user's previously composed packs
POST /api/library/save              — save a card or layer as a personal template
GET  /api/library/personal          — list personal templates

POST /api/compose/preview           — body: { current: <pack-shape>, edits: [...] }
                                       returns: { canonicalYaml, validation, conformance }
POST /api/compose/finalize          — registers a composed pack via the existing
                                       /api/validate flow, returns registered.id
```

The compose mode's authoritative state lives in `state.composedPack`
on the client — a partial canonical structure that mutates as the user
drags / edits. Every mutation triggers a debounced
`/api/compose/preview` call to surface real-time validation +
conformance scoring.

### Client state shape

```js
state.compose = {
  active: false,                  // is compose view open
  composedPack: {                  // partial canonical, server-authoritative on finalize
    apiVersion: 'observability.platform/v1',
    kind: 'ObservabilityPack',
    metadata: { name: '...', bindings: { ... } },
    spec: { slis: [], slos: [], ... }
  },
  selectedCardId: null,           // active inspector target
  library: {                       // cached library data
    standard: [...],
    catalogue: { kafka: {...}, 'ibm-mq': {...}, ... },
    history: [...],
    personal: [...],
  },
  preview: {                       // server-validated state
    canonicalYaml: '...',
    validation: { ok, errors },
    conformance: { mustPercent, ... },
  },
}
```

### Drag-and-drop implementation

Use native HTML5 drag-and-drop API (`draggable="true"`, `dragstart`,
`dragover`, `drop`). No library dependency. Drop targets carry
`data-drop-zone="L1|L2|L2X|L3|L4|L5|GOV"` or
`data-drop-target-id="<artefact-id>"`. On drop, dispatch a reducer
action that updates `state.compose.composedPack`.

### Live YAML preview

Bottom strip of the canvas shows the canonical YAML rendered from the
current composed state, refreshed on every mutation. Click "expand" to
get a full-height YAML editor (for advanced users who want to tweak
freehand). Edits to the YAML are bidirectional — they parse back into
the structured composedPack if valid.

---

## Mental model — what changes

Pre-Compose mode, the studio had three paths to a pack:
1. **Upload** a hand-written YAML
2. **x-ray** a service repo to draft one
3. **Draft from MCP** to derive one from live telemetry

Compose mode adds a fourth that's qualitatively different:
4. **Compose** from atomic + composite blocks

This isn't a replacement for the first three — it's a *follow-on* path.
Users x-ray a repo to get an initial draft, then *open the draft in
Compose mode* to refine, fill gaps from the standard library, and
benchmark against catalogue references by dragging them in. The four
paths feed each other:

```
x-ray a repo  ─┐
draft from MCP ─┼──→  Compose mode (refine + compare)  ──→  validated pack
upload         ─┘
                      ↑
              drag from catalogue
              drag from history
              drag from standard library
```

---

## Demo path — what we'd show

A 2-minute walkthrough:

1. **0:00** — User connects to an MCP, gets a draft pack.
2. **0:20** — Click "Compose" — the studio opens the draft as composable
   cards. Empty-handed, the draft has 3 SLIs and no L5 validation.
3. **0:30** — Library shows "📦 from catalogue: kafka tier-2".
4. **0:40** — User drags the Kafka tier-2 "chaos experiment: kill-broker"
   onto L5. Inspector shows the borrowed experiment with citation
   "inherited from kafka catalogue pack v1.2.0."
5. **0:55** — User drags 2 more SLIs from the catalogue. Conformance
   score jumps from 72% to 91%.
6. **1:20** — User opens the YAML preview, sees the composed canonical,
   exports as `payments.pack.yaml`.
7. **1:45** — Validates against the spec. ✓ Done.

The framing in the demo: *"You don't write packs. You compose them from
proven blocks the catalogue maintains for you, and Observogram keeps the
shape valid as you go."*

---

## MVP — what ships first

### Sprint 1 — read-only library + canvas (2 days)

- New `compose` view in the view nav.
- Three-pane layout (no drag-and-drop yet — read-only browsing).
- Library sidebar fetches `/api/library/standard` + the existing
  `/api/examples` (re-purposed as the catalogue stand-in).
- Canvas renders the *current loaded pack* as cards on each layer.
- Inspector panel opens on card click.

### Sprint 2 — drag-and-drop + live preview

- Native HTML5 drag-and-drop between library and canvas + within
  canvas.
- `state.compose.composedPack` reducer.
- `/api/compose/preview` endpoint and live validation.
- YAML preview strip.

### Sprint 3 — composition primitives

- Drag-from-canvas-to-library saves personal templates.
- `/api/library/personal` + persistence (server-side per-session
  registry, like uploaded packs).
- "Drag whole pack from catalogue" pre-populates the canvas.

### Sprint 4 — finalize + export

- `/api/compose/finalize` — runs the composed pack through the existing
  `/api/validate` registration flow.
- Download canonical YAML.
- "Save to repo" via existing deploy mechanics (if a target is wired).

---

## What this unlocks

- **Authoring without YAML literacy.** Engineers can build conformant
  packs without learning the v1.2 schema by heart.
- **Catalogue as a real library.** The reference packs aren't just
  benchmarks — they're a draggable inventory of best-practice
  primitives.
- **Iteration without re-uploading.** Live preview + reducer-backed
  state means edits are immediate, undo is cheap, and there's no
  paste-the-YAML-back-in cycle.
- **A first-class differentiator.** No other observability tool ships
  visual composition of declarative artefacts. The diagnostic-chain
  model becomes literal: compose the requirement branch once, then
  regenerate, compare, and deploy from the same structured map.

---

## Open questions

1. **Mobile / touch?** Compose mode is unapologetically desktop. Touch
   support is post-MVP.
2. **Collaboration?** Multiple engineers editing the same composed pack
   simultaneously? Not in MVP. Single-user composition; share via the
   exported YAML or PR'd manifest.
3. **Versioning a composed pack?** Auto-generate semver from a
   `metadata.version` field; show "+1 minor" / "+1 patch" buttons in
   the inspector?
4. **Reference packs as base templates vs as draggable parts?** Both —
   "drag whole pack" pre-populates everything; "drag one SLI" copies
   just that piece. Inspector shows the lineage.
5. **What's the import path for a custom block library?** Standard
   library lives in-repo; personal templates live in browser
   localStorage + sync to `/api/library/personal`; catalogue blocks
   come from the catalogue repo. Org-internal block libraries
   (post-MVP) could mount from a configurable URL.

---

## See also

- [`docs/REFERENCE_CATALOGUE_PLAN.md`](REFERENCE_CATALOGUE_PLAN.md) — the catalogue Compose mode draws from
- [`docs/CATALOGUE_SEED_SPRINT.md`](CATALOGUE_SEED_SPRINT.md) — the first 5 packs that seed the library
- [`docs/USER_JOURNEY.md`](../USER_JOURNEY.md) — Compose mode is a new entry point into the journey, sitting between Introspect and Validate
