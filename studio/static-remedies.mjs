// studio/static-remedies.mjs — what the studio says, and which controls it
// draws unavailable, when no server is behind the page (the static posture:
// state.access.posture === 'static', set by the bundle's 501 on GET
// /api/orgs; tools/build-studio-bundle.mjs).
//
// A pure view model in the docs/UI_CONVENTIONS.md sense: zero imports, no
// state read, no DOM — a view asks whether it is static and takes its text
// and its selector from here. The live studio's texts are the views' own and
// do not change.
//
// serverNeeded is the sentence the shim's 501 carries for the same feature,
// character for character (tools/test-static-remedies.mjs holds the two
// equal; no live studio module may import the shim, so the text is written
// twice and compared).
//
// DEPLOY_CONTROLS: every deploy control outside prototype space, by the id,
// class or data-* attribute its view writes — Compare's and Diagnose's drift
// action (#drift-deploy-missing), chain cards (.diag-chain-deploy) and pack
// picker cards ([data-action="deploy"]); Remediate's decision-header actions
// ([data-ux-action="rm-deploy"], [data-ux-action="rm-deploy-all"]), the
// response path's per-SLO buttons (.rflow-deploy) and the compiler's button
// (#deploy-compiled). The view that draws one marks it unavailable after it
// renders and drops its title, which says what it would open; its handler
// stays and reaches openDeployModal (studio/app.mjs), which explains the
// reason instead of opening the modal.
//
// staticRemedy(key, { product, liveBuiltIn, packALive, packsBuiltIn }) is the
// text a view shows in the static posture where its own names a server action
// the reader cannot take here. Each is addressed to the reader, who did not
// build the file: what is built in, what the reader can do here, and what
// needs a server or whoever builds the bundle. `liveBuiltIn` says whether a
// live pack (a scaffold or a snapshot) other than Pack A is built in,
// `packALive` whether Pack A is itself one (then a text that says the bundle
// carries no live pack says none besides Pack A), `packsBuiltIn` whether any
// pack loads (staticInputOf reads all three from the catalogue). Keys
// (STATIC_REMEDY_KEYS), the design's rows (A.8), each shown by the view
// named:
//   retrofeed-result (row 11) — the note under a computed repository update
//     (studio/compare-view.mjs runRetrofeed), where a server's says to scan
//     again.
//   drift-partial (row 2) — the drift drill's partial-live-evidence banner,
//     where a server's says to draft the live pack once more.
//   compare-one-pack (row 4) — Compare with no second pack to compare with,
//     where a server's says to load or scan one from Discover.
//   drift-free-fix, live-missing-fix (row 12) — the Assessment's drift-free
//     and live-missing blockers' fixes, where a server's also offers
//     deploying the missing artefacts.
//   trace-no-b (row 1) — Traceability with no requirement and no Pack B.
//   diagnose-banner (row 3) — Diagnose's banner over a pack nothing live
//     backs.
//   fresh-fix (row 5), drift-free-no-live (row 6), live-evidence-fix (row
//     7) — the Assessment's fresh, nothing-live and partial-evidence
//     blockers' fixes (compare-view.mjs buildAssessmentDecision's `remedy`).
//   live-measure (row 8) — the Live measure's note when nothing live is
//     checked.
//   no-live-hint (row 13) — the drift-free check's detail
//     (studio/diagnostic-grade.mjs computeDiagnosticGrade's noLiveHint),
//     where a server's names a live draft or a scan.
//   flow-not-compared-diagnose, flow-not-compared-remediate (rows 16, 17) —
//     the response path's note before a comparison
//     (studio/remediation-flow-view.mjs's notComparedNote), on Diagnose and
//     on Remediate (studio/compile-view.mjs).
//   remediate-no-b (row 18) — Remediate's decision note with no Pack B
//     (compile-view.mjs).
//   need-pack (row 19) — Diagnose's and Remediate's prompt before a pack is
//     chosen (studio/app.mjs renderNeedPackPrompt), where a server's names
//     the ways to bring one in.
//   Remediate's deploy texts (rows 20–27, compile-view.mjs), where a
//   server's describe the review a deploy control opens — which never opens
//   in the static posture:
//   remediate-deploy-hint (row 20) — the hint beside each of the decision's
//     Review and deploy buttons.
//   remediate-next-deploy, remediate-next-both (rows 21, 22) — the deploy
//     and bidirectional strategy cards' next step.
//   remediate-effect-live, remediate-effect-both (rows 23, 24) — the active
//     strategy's effect note.
//   remediate-deploy-meaning (row 25) — what the deploy strategy covers.
//   remediate-rows-hint (row 26) — the proposed changes' hint over the
//     deployable rows' boxes, which the static posture draws disabled.
//   remediate-not-compared-summary (row 27) — the proposed changes' summary
//     with no Pack B.
//
// staticTraceActions(product) is the set of Traceability's live-evidence
// texts for the static posture (rows 14, 15): the same keys as
// studio/trace-chain.mjs LIVE_ACTION_TEXT, which the views pass as
// readTraceability's, readChain's and traceIssue's `actions`.

export function serverNeeded(feature, product) {
  return `${feature} needs the ${product} server; this studio is a static bundle built without one.`;
}

export const DEPLOY_CONTROLS = [
  '#drift-deploy-missing',
  '.diag-chain-deploy',
  '[data-action="deploy"]',
  '[data-ux-action="rm-deploy"]',
  '[data-ux-action="rm-deploy-all"]',
  '.rflow-deploy',
  '#deploy-compiled',
].join(', ');

// "the Observogram server", as serverNeeded names it: no article before the
// product's name, which is the brand's and free-form — a rule by its spelling
// reads "an Unity Watch server" or "a Hour Watch server".
const theServer = (product) => `the ${product} server`;
// What a reader of a bundle without a live pack other than Pack A is told
// (NOLIVE; with a live Pack A, none besides it), and where a new live draft
// comes from (NEWDRAFT): a server drafts it, whoever builds the bundle builds
// it in.
const noLive = (product, packALive) => `this bundle carries no live pack${packALive ? ' besides Pack A' : ''}; whoever builds it can add one (a live draft made on ${theServer(product)}, built in with --pack)`;
const newDraft = (product) => `a new live draft, made on ${theServer(product)} and built into the bundle by whoever builds it (--pack)`;

const STATIC_REMEDIES = {
  'retrofeed-result': ({ product }) => `commit the updated pack to the service repo (it carries observogram.retrofeed.* provenance); whether the gap closed shows against a new live draft — on ${theServer(product)}, or in a bundle whoever builds it rebuilds with that draft and the updated pack`,
  'drift-partial': ({ product }) => `Before acting on this drift, get a complete live draft: drafting needs ${theServer(product)}, and whoever builds this bundle builds the new draft in (--pack).`,
  'compare-one-pack': () => 'This bundle carries no other pack that loads, so there is nothing to compare this one with; whoever builds the bundle can add another with --pack (a live draft, or a curated repository pack).',
  'drift-free-fix': ({ product }) => `Review the differences, then update the repository from live; deploying what is missing needs ${theServer(product)}.`,
  'live-missing-fix': ({ product }) => `Review them, then update the repository from live; deploying what is missing needs ${theServer(product)}.`,
  'trace-no-b': ({ product, liveBuiltIn, packALive }) => `Traceability follows each objective to the metrics, rules, scrape jobs, dashboards and alerts that prove it. ${liveBuiltIn
    ? 'Declare an SLO, or pick a live pack as Pack B to compare the repository with live.'
    : `Declare an SLO. To compare the repository with live, pick a live pack as Pack B: ${noLive(product, packALive)}.`}`,
  'diagnose-banner': ({ product, liveBuiltIn, packALive }) => `Nothing live backs this pack. “Drift-free” and “Fresh” need a live pack: ${liveBuiltIn ? 'choose the live pack built into this bundle as Pack B.' : `${noLive(product, packALive)}.`}`,
  'fresh-fix': ({ product }) => `The live pack in this bundle is as fresh as when it was drafted; a fresh look needs ${newDraft(product)}.`,
  'drift-free-no-live': ({ product, liveBuiltIn }) => (liveBuiltIn
    ? 'Choose the live pack built into this bundle as the baseline (Pack B) to compare.'
    : `Nothing live is built into this bundle; whoever builds it can add a live draft made on ${theServer(product)} (--pack), to choose as the baseline (Pack B).`),
  'live-evidence-fix': ({ product }) => `A complete live pack needs ${newDraft(product)}, once the endpoint is healthy.`,
  'live-measure': ({ liveBuiltIn }) => (liveBuiltIn ? 'compare with the live pack built in to verify' : 'no live pack is built in to verify against'),
  'no-live-hint': ({ liveBuiltIn }) => (liveBuiltIn ? 'choose the live pack built into this bundle as Pack B' : 'no live pack is built into this bundle'),
  'flow-not-compared-diagnose': ({ product, liveBuiltIn, packALive }) => `Not compared yet: every alert reads as declared. ${liveBuiltIn
    ? 'Pick the live pack built into this bundle as Pack B to see which alerts are live.'
    : `Seeing which alerts are live needs a live pack: ${noLive(product, packALive)}.`}`,
  'flow-not-compared-remediate': ({ product }) => `Not compared with live: every alert reads as declared; deploying needs ${theServer(product)}.`,
  'remediate-no-b': ({ product, liveBuiltIn, packALive }) => `${liveBuiltIn ? 'Compare with the live pack built into this bundle to get a recommendation' : `A recommendation needs a live pack: ${noLive(product, packALive)}`}; deploying needs ${theServer(product)}.`,
  'need-pack': ({ product, packsBuiltIn }) => (packsBuiltIn
    ? 'Head to Discover and open one of the packs built into this bundle — then come back here.'
    : `This bundle carries no pack; whoever builds it can add one with --pack (a curated repository pack, or a live draft made on ${theServer(product)}).`),
  'remediate-deploy-hint': ({ product }) => `Deploying needs ${theServer(product)}; nothing is written to live from this bundle.`,
  'remediate-next-deploy': ({ product }) => `Deploy, on ${theServer(product)}`,
  'remediate-next-both': ({ product }) => `Generate patch; deploying needs ${theServer(product)}`,
  'remediate-effect-live': ({ product }) => `only from ${theServer(product)}; nothing is written to live from this bundle`,
  'remediate-effect-both': ({ product }) => `the patch is made here; the deploy needs ${theServer(product)}`,
  'remediate-deploy-meaning': ({ product }) => `Deploying the ticked rows needs ${theServer(product)}`,
  'remediate-rows-hint': ({ product }) => `Ticked rows can be deployed from ${theServer(product)}; this bundle deploys nothing, so the boxes cannot be changed here. Rows without a box need a repository patch, a decision or a manual fix.`,
  'remediate-not-compared-summary': ({ product }) => `not compared with live; deploying them needs ${theServer(product)}`,
};

export const STATIC_REMEDY_KEYS = Object.freeze(Object.keys(STATIC_REMEDIES));

export function staticRemedy(key, { product, liveBuiltIn = false, packALive = false, packsBuiltIn = false } = {}) {
  const text = STATIC_REMEDIES[key];
  if (!text) throw new Error(`staticRemedy: no static text for ${JSON.stringify(key)}`);
  return text({ product, liveBuiltIn: !!liveBuiltIn, packALive: !!packALive, packsBuiltIn: !!packsBuiltIn });
}

// The inputs staticRemedy reads, from what a view holds: the product's name,
// the catalogue (GET /api/packs — the bundle's packs) and Pack A's id.
// liveBuiltIn: a live pack (catalogue `live`: a scaffold or a snapshot) other
// than Pack A loads; packALive: Pack A is a live pack that loads;
// packsBuiltIn: any pack loads.
export function staticInputOf(product, catalog, selectedPackId) {
  const loaded = (Array.isArray(catalog) ? catalog : []).filter((p) => p && p.ok);
  return {
    product,
    liveBuiltIn: loaded.some((p) => p.live && p.id !== selectedPackId),
    packALive: loaded.some((p) => p.live && p.id === selectedPackId),
    packsBuiltIn: loaded.length > 0,
  };
}

// Traceability's live-evidence texts in the static posture (rows 14, 15) —
// studio/trace-chain.mjs LIVE_ACTION_TEXT's keys, each saying where a live
// draft comes from instead of asking the reader to refresh one.
export function staticTraceActions(product) {
  return Object.freeze({
    scrapeEvidenceFix: `Declare the scrape configuration, then check again; observing it live needs ${newDraft(product)}.`,
    sliRulesHealthy: 'Check the rules behind the SLI are healthy (a new live draft confirms it)',
    sliMeasured: `Confirm the SLI is measured with a live draft (made on ${theServer(product)})`,
    metricConfirm: (metric) => `Confirm ${metric} with a live draft (made on ${theServer(product)})`,
    scrapeEvidence: `Capture scrape evidence with a live draft (made on ${theServer(product)})`,
    dashboardDeploy: `Deploy the dashboard on ${theServer(product)}; a new live draft confirms it`,
    alertDeploy: `Deploy the burn-rate alert on ${theServer(product)}; a new live draft confirms it`,
  });
}
