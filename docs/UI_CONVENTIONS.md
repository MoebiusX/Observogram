# Studio UI conventions

How studio view modules are structured so the studio stays hackable and the
vendorable pieces stay vendorable (docs/VENDORING.md). These are
**adopt-on-touch** conventions: apply them to code you are already changing —
do not sweep the codebase to retrofit them. The natural moment for wholesale
conversion of a view is when it is next redesigned (e.g. ratifying the
`?proto=s` synthesis into production).

The guardrail behind all of them: Observogram is an app, not a UI framework.
The downstream contract is a small set of vendored engine files plus one
ratified view — conventions exist to keep *those seams* clean, not to make
every module pluggable for its own sake.

## 1. Views reach the app through the host seam — never by importing app.mjs

`studio/host.mjs` is a zero-import module holding the app-level orchestration
callbacks. app.mjs fills it once at boot; views import it instead of app.mjs:

```js
import { host as appHost } from './host.mjs';
…
appHost.renderTabs(); appHost.renderMainView();
```

The contract (names promised stable): `loadPackB`, `openDeployModal`,
`renderMainView`, `renderTabs`.

- Import it **as `appHost`** — this codebase uses `host` for DOM container
  locals (`const host = document.createElement(…)`), and the alias keeps the
  two from shadowing each other. The bare name `host` is reserved for the
  render-signature parameter (convention 3).
- App-specific *helpers* (`defaultEnvFor`, `buildSymbolTable`, `runBenchmark`,
  `refresh`, …) are **not** host material — they are data/model concerns that
  should dissolve into the model argument as convention 3 lands. Until then
  they remain direct app.mjs imports (a safe call-time cycle). Do not grow
  the host into a mirror of app.mjs.
- Why a host object and not an event bus: one subscriber ever exists, the
  calls stay greppable and jump-to-definition-able in an untyped codebase,
  and `renderTabs()`-then-`renderMainView()` sequencing stays explicit at the
  call site instead of implicit in listener registration order.

`tools/test-studio-graph.mjs` links the whole studio module graph on every
`npm test`, so a dangling import/export on any of these seams fails CI.

## 2. Loaders and renderers are separate exports — no `api()` inside a renderer

Each view module may export both, but never mixed in one function:

- **Loaders** fetch + normalize (`fetchFn = api` injectable, like
  `verdict-ui.mjs`'s `loadRunHistory`). They own *when* to fetch and may
  trigger a repaint through the host when data lands.
- **Renderers** take pre-computed data and produce DOM. No `state` reads, no
  fetches inside.

The model in between comes from an exported `build*Model()` —
`buildVerdictModel({ pack, packB, diff, compareBId, catalogEntry })` is the
reference shape: every input explicit, no global reads, so the same function
runs under any store (and headlessly under `node:test`, which is where the
engine tests live — the repo has no DOM test harness, so the model layer is
the testable layer).

## 3. Renderer signature: `render(container, model, host)`

- `container` — the DOM element to render into (never called `host`).
- `model` — the pre-computed data (convention 2). Focus state
  (`focusedPack()` et al.) is app-level UI state and arrives *inside the
  model*, not via a `focus.mjs` import.
- `host` — the app callbacks, defaulting to the module-level `appHost` when
  the view isn't vendored.

## 4. CSS: one class-prefix per functional zone, split files only along the vendoring seam

Zone prefixes (`.mc-*` verdict widgets, `.rq-*` triage queue, `.disco-*`
Discover, `.diag-*` Diagnose, `.cpc-*`/`.compare-*` Compare) — keep new
classes inside their zone's prefix. **Never mass-rename existing classes**:
they are referenced from both .css and .mjs template strings and there is no
visual-regression net.

Split a stylesheet out of app.css only when a module crosses the vendoring
boundary — `studio/verdict-ui.css` (the `.mc-*` widget atoms + KPI tiles
emitted by verdict-ui.mjs) is the precedent: it documents the CSS custom
properties it expects from the host theme in its header, and app.css keeps
the shared production styles (`.drift-*`, `.diag-*` banners) verdict-ui also
emits.
