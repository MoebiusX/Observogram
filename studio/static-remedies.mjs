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
// renders; its handler stays and reaches openDeployModal (studio/app.mjs),
// which explains the reason instead of opening the modal.

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
