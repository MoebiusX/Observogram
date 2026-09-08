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
| [`tools/lib/diff.mjs`](../tools/lib/diff.mjs) | imports `artefact-model.mjs` | pack arithmetic — the diff buckets everything downstream consumes |
| [`tools/lib/artefact-model.mjs`](../tools/lib/artefact-model.mjs) | imports `promql-canon.mjs` | behavioural identity + contract projection — `identityKeyOf`, `behaviorOf`, `deltasOf`, `classify` |
| [`tools/lib/promql-canon.mjs`](../tools/lib/promql-canon.mjs) | imports `promql.mjs` | parser-proven PromQL canonicalisation |
| [`tools/lib/promql.mjs`](../tools/lib/promql.mjs) | pure ESM, no Node APIs | PromQL tokeniser/dependency reader |
| [`tools/lib/protocols.mjs`](../tools/lib/protocols.mjs) | pure data | the versioned protocol/feature canon |
| [`tools/lib/stack-evidence.mjs`](../tools/lib/stack-evidence.mjs) | imports `contracts/stack-self-metrics.mjs` only | pure history helpers over journey run records — `stackSeries`, `latestByFamily`, `stackSummary`, `stackPostureBudget`, `nonzeroRuns`, `formatStackValue`, `stackOutcomeLabel`; explicit inputs, no Node APIs, every output a point-in-time signal |
| [`tools/lib/contracts/stack-self-metrics.mjs`](../tools/lib/contracts/stack-self-metrics.mjs) | pure data + lookups | the stack self-metric alias table `stack-evidence.mjs` orders by — copy the two together |
| [`tools/lib/blast-radius.mjs`](../tools/lib/blast-radius.mjs) | **zero-import** (CI-asserted) | the blind-spot blast radius over the requirement graph — `CONSUMER_SIDE` / `PROTECTION_SIDE`, `normalizeGraphShape`, `blastRadiusOf`, `blastRadiusIndex`; input is the plain `{ nodes: [{ key, identityKey, kind, layer, label, virtual, scaffold }], edges: [{ from, to, type, provenance }] }` that `graphShape(graph)` in `traceability-graph.mjs` projects (nodes also accepted as a Map or a keyed object); structural exposure only — what WOULD go blind — it never reads liveness |
| [`tools/lib/chain-history.mjs`](../tools/lib/chain-history.mjs) | **zero-import** (CI-asserted) | requirement-chain verdicts over time — `branchRecordsFromGraph` over a `compareBranches` result, then `chainSummary`, `diffRunBranches`, `rankCauses({ previous, current, deploys, baseline? })`, `deploysInWindow`, `topCause` over journey run records (`{ startedAt, outcome, branches, versions, stackEvidence, probes, … }`) and deploy audit lines, plus the vocabulary tables the ranker reads (`CAUSE_KINDS`, `CAUSE_SCORES`, `FAMILY_FOR_KIND` / `familyForKind`, `PRODUCT_FAMILIES` / `familiesForProduct`, `DEPLOY_GROUP_KINDS`, `deployArtifactNames`); a host that holds the declared pack resolves deploy selectors itself and passes them as `item.resolved` (the way `journey.mjs` does); nothing here scores, every function is pure and never throws |
| [`studio/diagnostic-grade.mjs`](../studio/diagnostic-grade.mjs) | **zero-import** (CI-asserted) | the grade engine: coverage/trust criteria, posture matrix, weighted delta risk, instrument-grade scale |
| [`studio/artifact-model.mjs`](../studio/artifact-model.mjs) | **zero-import** (CI-asserted) | behavioural identity + deploy-surface model per artefact family |
| [`studio/constants.mjs`](../studio/constants.mjs) | pure data | the display vocabulary (layers, domains, grade banding) |
| [`studio/verdict-ui.mjs`](../studio/verdict-ui.mjs) | see below | the normalized verdict model, grade projection, and widget/honesty blocks |
| [`studio/verdict-ui.css`](../studio/verdict-ui.css) | host theme's CSS custom properties (listed in its header) | the styles for the widgets verdict-ui.mjs emits |
| [`studio/compare-catalog.mjs`](../studio/compare-catalog.mjs) | `state.mjs` only | `catalogEntryFor()` + `LAYERS_FOR_DIFF` |
| [`studio/host.mjs`](../studio/host.mjs) | zero-import | the studio-wide host seam: `initHost()` + the live `host` object |
| [`studio/proto-synthesis.mjs`](../studio/proto-synthesis.mjs) | host-injected callbacks | the ratified Diagnose/Remediate synthesis view |

`tools/test-diagnostic-grade.mjs` fails CI if an import ever creeps into the
two studio zero-import modules, and `tools/test-blast-radius.mjs` /
`tools/test-chain-history.mjs` guard theirs the same way (no `import`, no
`node:` module, no `process`), so the seams cannot erode silently.

**Additive keys on `compareBranches` output.** `tools/lib/traceability-graph.mjs`
itself is not in the vendorable set (it imports the PromQL parser), but its
result is the `diff.traceabilityGraph` a vendored `computeDiagnosticGrade`
scores Drift-free on and the input `branchRecordsFromGraph` reads, so its
shape is part of this contract. Since 2026-09 it keeps its original shape
and gains optional keys a downstream host may ignore: on every node verdict
`blastRadius` (the blast-radius `summary` — `{ slos, alerts, panels,
dashboards, routes, remediations, total }` — or `null`) and `ladder`
(`{ rung, status, detail }`), appended after `deltas`; on every branch
`ladderVerdict`, `ladderIntegrity` and `ladderIntegrityPct` beside
`verdict` / `integrity` / `integrityPct`; on the rollup `ladder = { healthy,
degraded, broken, unobserved, integrityMean, integrityPct }`, appended last.
`integrity`, `verdict`, `counts`, node `status` and `rollup.integrityMean`
are byte-identical with and without the annotations the ladder reads
(pinned in `tools/test-traceability-graph.mjs`), and Drift-free still reads
`rollup.integrityMean` — the switch to `rollup.ladder.integrityMean` is a
proposal (`docs/SCORING_PROPOSAL_LADDER_INTEGRITY.md`, gradeSchema 3), not
applied. Keys are only ever added here, never renamed or removed.

**Additive keys on `partialLiveEvidence(packB)`.** The result keeps its
original shape (`isLiveDraft`, `failed`, `empty`, `attempted`, `partial` —
`partial` still means *outright probe failures only*) and gains optional keys
a downstream host may ignore: `unsupported` (probe families the MCP tier does
not expose, from `mcp.probesUnsupported`), `errors` (`{ family: message }`
from `mcp.probeErrors.<family>`), and `vantage` — `'full'` (nothing failed,
nothing unsupported), `'partial'` (some probes failed), `'restricted'` (nothing
failed, some families not exposed), `'lost'` (every attempted family failed or
is unsupported), `'none'` (not a live draft). Keys are only ever added here,
never renamed or removed.

**Optional inputs `computeDiagnosticGrade` reads.** The diff-bucket path
counts a layer bucket's optional `scaffold` array (placeholders `diffPacks`
parks before pairing) into its `N scaffold excluded` note; older diffs without
it still pass through the `isScaffoldDiffEntry` filters. The Fresh criterion
appends the live vantage to its `detail` (`vantage lost …` / `vantage partial
…`) read through `partialLiveEvidence` from the same module — the pass/fail
and every score are unchanged, and no import was added.

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
     tools/lib/diff.mjs tools/lib/artefact-model.mjs \
     tools/lib/promql-canon.mjs tools/lib/promql.mjs \
     tools/lib/protocols.mjs \
     tools/lib/stack-evidence.mjs tools/lib/contracts/stack-self-metrics.mjs \
     tools/lib/blast-radius.mjs tools/lib/chain-history.mjs \
     studio/diagnostic-grade.mjs studio/artifact-model.mjs \
     studio/constants.mjs studio/verdict-ui.mjs studio/verdict-ui.css \
     studio/compare-catalog.mjs studio/host.mjs studio/proto-synthesis.mjs
   ```

   `diff.mjs` → `artefact-model.mjs` → `promql-canon.mjs` → `promql.mjs` is
   one import chain: always re-copy these four together. A mixed-generation
   copy (e.g. a newer `diff.mjs` over an older identity model) is exactly the
   silent drift this contract exists to prevent — a downstream studio's 2026-08
   collision report was filed from such a copy, against engine code this repo
   had replaced on 2026-06-09. Most recent reason to re-copy the pair:
   2026-09 `promql-canon.mjs` tightens whitespace around symbolic binary
   operators (`a / b` ≡ `a/b`) and `artefact-model.mjs` strips a leading
   `ref:` from reference fields before comparing behaviour — an older
   `artefact-model.mjs` over the newer canon (or vice versa) reports drift
   the other half no longer sees.

3. Re-copy the changed files, re-run your adapter's type-check, bump the
   recorded sha. Because the modules take their inputs explicitly, upstream
   changes surface as signature diffs at copy time — not as silent behaviour
   drift at runtime.
