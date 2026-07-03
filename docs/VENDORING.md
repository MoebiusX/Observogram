# Vendoring Observogram modules downstream

Some teams build their own studio around Observogram's scoring engines — a
different shell, a different stack (e.g. a TypeScript "ADO studio"), but the
same verdict semantics. Reimplementing the grade engine is the fastest way to
drift from it, so the supported path is to **vendor the engine files verbatim**
(e.g. into a `packages/upstream/` directory downstream) and re-copy them when
this repo moves.

This document is the contract that makes that safe: which files are
vendorable, what each one needs from the host, and which seams this repo
promises to keep stable.

## The vendorable set

| Module | Dependencies | Notes |
| --- | --- | --- |
| [`tools/lib/diff.mjs`](../tools/lib/diff.mjs) | pure ESM, no Node APIs | pack arithmetic — the diff buckets everything downstream consumes |
| [`tools/lib/protocols.mjs`](../tools/lib/protocols.mjs) | pure data | the versioned protocol/feature canon |
| [`studio/diagnostic-grade.mjs`](../studio/diagnostic-grade.mjs) | **zero-import** (CI-asserted) | the grade engine: coverage/trust criteria, posture matrix, weighted delta risk, instrument-grade scale |
| [`studio/artifact-model.mjs`](../studio/artifact-model.mjs) | **zero-import** (CI-asserted) | behavioural identity + deploy-surface model per artefact family |
| [`studio/constants.mjs`](../studio/constants.mjs) | pure data | the display vocabulary (layers, domains, grade banding) |
| [`studio/verdict-ui.mjs`](../studio/verdict-ui.mjs) | see below | the normalized verdict model, grade projection, and widget/honesty blocks |
| [`studio/verdict-ui.css`](../studio/verdict-ui.css) | host theme's CSS custom properties (listed in its header) | the styles for the widgets verdict-ui.mjs emits |
| [`studio/compare-catalog.mjs`](../studio/compare-catalog.mjs) | `state.mjs` only | `catalogEntryFor()` + `LAYERS_FOR_DIFF` |
| [`studio/host.mjs`](../studio/host.mjs) | zero-import | the studio-wide host seam: `initHost()` + the live `host` object |
| [`studio/proto-synthesis.mjs`](../studio/proto-synthesis.mjs) | host-injected callbacks | the ratified Diagnose/Remediate synthesis view |

`tools/test-diagnostic-grade.mjs` fails CI if an import ever creeps into the
two zero-import modules, so the seam cannot erode silently.

## What the host supplies

**`verdict-ui.mjs` reads no global state.** Its imports are the vendorable
modules above plus two one-line stubs a host can satisfy trivially:

- `escapeHtml` from `util.mjs` — any HTML escaper.
- `api` from `api.mjs` — only used as the *default* fetcher of
  `loadRunHistory(onReady, { fetchFn })`; pass your own `fetchFn(path) →
  Promise<json>` and the stub never runs.

The engines take their inputs explicitly:

```js
buildVerdictModel({ pack, packB, diff, compareBId, catalogEntry, passesLens });
projectGrade(uids, { pack, packB, diff, compareBId });
```

`pack`/`packB` are adapted layered packs, `diff` is a `/api/diff` result,
`catalogEntry` is whatever row your catalog holds for `compareBId` (only
`.label` is read). Observogram binds these from its own `state` in
`proto-synthesis.mjs` (`verdictInputs()`); a downstream studio binds them from
its own store.

**View modules never import the app shell.** The four app-level callbacks
live in `studio/host.mjs` (zero-import), filled once at boot:

```js
import { initHost } from './host.mjs';
initHost({ loadPackB, openDeployModal, renderMainView, renderTabs });
```

Views import the live object as `import { host as appHost } from './host.mjs'`
(see docs/UI_CONVENTIONS.md for the naming rule). A TypeScript host writes a
~10-line adapter object with its own implementations of those four hooks.
(The synthesis view also reuses production renderers from `compare-view.mjs`
— those are Observogram-specific; port them or swap in your own panels.)

## Contracts this repo keeps stable

- **The state-slice signatures above.** New inputs arrive as new optional
  keys, never as global reads.
- **The `initHost` hook names** (`loadPackB`, `openDeployModal`,
  `renderMainView`, `renderTabs`) — the host object never becomes a mirror
  of app.mjs (docs/UI_CONVENTIONS.md).
- **Pack annotation namespace** — writers emit `observogram.*`
  (`observogram.diff.scopeMode`, `observogram.retrofeed.*`,
  `observogram.services`); readers keep accepting the pre-rebrand
  `tomograph.*` keys.
- **`L4_SUBGROUPS`** is intentionally duplicated: `constants.mjs` owns the
  display copy, `diagnostic-grade.mjs` inlines a private copy so it stays
  zero-import. Change both or neither.
- **Env/header compat** for downstream servers proxying Observogram: every
  `OBSERVOGRAM_*` env var also honors its `TOMOGRAPH_*` spelling
  (`tools/lib/brand-env.mjs`), and the server accepts both
  `X-Observogram-Org`/`X-Observogram-CSRF` and the legacy `X-Tomograph-*`
  headers (echoing `X-Observogram-Org`).

## Staying current

1. Record the Observogram commit you vendored from (e.g. in a
   `packages/upstream/UPSTREAM_SHA` file).
2. To update:

   ```sh
   git -C observogram diff <UPSTREAM_SHA>..HEAD -- \
     tools/lib/diff.mjs tools/lib/protocols.mjs \
     studio/diagnostic-grade.mjs studio/artifact-model.mjs \
     studio/constants.mjs studio/verdict-ui.mjs studio/verdict-ui.css \
     studio/compare-catalog.mjs studio/host.mjs studio/proto-synthesis.mjs
   ```

3. Re-copy the changed files, re-run your adapter's type-check, bump the
   recorded sha. Because the modules take their inputs explicitly, upstream
   changes surface as signature diffs at copy time — not as silent behaviour
   drift at runtime.
