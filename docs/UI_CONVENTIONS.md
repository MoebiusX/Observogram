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
- A journey with its own actions (the BUILD steps: `update`, `setTier`,
  `toggleEntry`, `setParam`, `setSli`, `setToggle`, `setStep`, `openEditor`,
  `closeEditor`, `preview`, `openInDiscover`, …; the services actions `openService`,
  `openIn`, `openBuild`, `openEditor`, `saveService`, …; the Settings actions `open`, `back`,
  `selectSection`, `retry`, `explain`, `openEditor`, `closeEditor`, `save`, `step`, `confirm`,
  `auditApply`, `auditMore`, `pickMcpTarget`, `openMcpEndpoints`) rides them on that argument as a
  namespace (`host.build`, `host.services`, `host.settings`), built by app.mjs's controller and
  handed to the renderer at the call site — never added to `host.mjs`
  (convention 1: the host stays the four stable hooks) and never reached by
  importing app.mjs. The renderer
  stays testable: the models it draws are pure (`studio/build-model.mjs`,
  `tools/test-build-model.mjs`), and the actions are whatever the caller
  passes.
- Chrome text that names the product — the header wordmark and logo, the
  About card, the scanner title, the reset confirm, the API-unreachable
  screen, the origin chip's tip, the atlas compass mark, the version
  tooltip — comes from `state.brand.chrome` (`studio/brand.mjs`, the
  normalized brand `tools/lib/brand.mjs` owns), never from a literal:
  `tools/test-brand.mjs`'s source guard fails the suite on `Observogram` /
  `Observo<` / `OBSERVOGRAM` / `OBSERVO<` in any `studio/*.mjs` outside
  comments. A renderer that cannot reach the state takes the chrome (or
  the one string it needs) as an argument and paints nothing in its place
  when none is given (`renderVersionChrome(container, model, chrome)`,
  the atlas `opts.compassMark`).

## 4. CSS: one class-prefix per functional zone, split files only along the vendoring seam

Zone prefixes (`.mc-*` verdict widgets, `.rq-*` triage queue, `.disco-*`
Discover, `.diag-*` Diagnose, `.cpc-*`/`.compare-*` Compare; `.dvb-verdict`
the Discover board's reviewer-verdict badge and `.ux-chip-verdict` the fifth
status property's chip in `ux.css`, `.verdict-*` the drawer's Verdict
section — all drawn by `studio/verdict-html.mjs` / `studio/verdicts.mjs`,
nothing without a verdict; `.rflow-*` the response path of
`studio/remediation-flow-view.mjs`, one zone in `ux-remediate.css` drawn on
Remediate and on Diagnose alike, nothing for a pack without
`spec.remediation`; `.ux-gloss-*` the glossary marks of `studio/glossary.mjs`
in `ux.css` — a toggletip beside a family label or a spec term, drawn only
when the taxonomy file's v2 `glossary` explains it, `--ux-*` tokens only;
`.conf-exports` the Conformance view's audit-report download row in `app.css`,
drawn only with a focused pack id; `.set-*` Settings and its editors in
`app.css`, under its own `==== Settings` marker the AA scan in
`tools/test-build-model.mjs` reads, each colour measured on its own
background and none restyled by `ux.css` / `reskin.css`) — keep new classes
inside their zone's prefix. The service audit report's `.ar-*` zone is not a studio stylesheet:
it is `REPORT_CSS` in `tools/lib/audit-report.mjs`, inlined into one
standalone document over `design-tokens.css` + `design-kit.css` (it qualifies
kit classes under `.ar-*` and redefines none). **Never mass-rename existing classes**:
they are referenced from both .css and .mjs template strings and there is no
visual-regression net.

Split a stylesheet out of app.css only when a module crosses the vendoring
boundary — `studio/verdict-ui.css` (the `.mc-*` widget atoms + KPI tiles
emitted by verdict-ui.mjs) is the precedent: it documents the CSS custom
properties it expects from the host theme in its header, and app.css keeps
the shared production styles (`.drift-*`, `.diag-*` banners) verdict-ui also
emits.

The other split along that seam is `studio/static-backend.css`: the static
bundle's notice (`.no-backend-notice`, a status row pinned to the bottom of the
window like `.toast`, `role="status"`, dismissable), inlined by
`tools/build-studio-bundle.mjs` after `reskin.css` and never linked by the live
studio. It reads the `--og-*` tokens only and is registered in
`tools/test-studio-layout.mjs`'s EXEMPT list (pinned, but under neither bar).
The notice's text reads the product name from the shell's `#brand-config`
(`studio/static-backend.mjs` `noticeText(n, product)`, defaulting to
`DEFAULT_BRAND.name`), so a `--brand` bundle leaks no upstream name.
