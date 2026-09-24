// studio/build-define-view.mjs
//
// BUILD step 1 — DEFINE, "What are we observing?": the silhouette of the
// pack the chosen tier demands — one ghost card per clause the tier applies
// in each dimension, the selected entries' SLIs and the SLO each gets as
// candidates on L1, reshaping with the tier and the entries, the edges
// lighting up as soon as the selection compiles. The service fields, the
// tier control and the library entries live in the definition column on the
// left (build-definition-view.mjs), the selection's params on the layer
// sheets (L2 · L4 · L5, build-sheet-view.mjs); a click on a slab opens its
// sheet in preview with a "Compose in Compile →" action. DEFINE is the
// seeding step (docs/BUILD_JOURNEY.md "The seed and the copies"): its primary
// action is "Seed the pack →" (host.build.seed: seeded, persisted, on to
// COMPILE), "Continue to Compile →" once seeded. Also home to the step head
// and the compilation-error note the three steps share.
//
// Renderer only (docs/UI_CONVENTIONS.md §2-3): render(container, model, host)
// with the model from build-model.mjs's buildDefineModel and the host the
// controller in app.mjs passes — host.build.* are the actions (setStep,
// openSheet through the stack); no state reads, no fetches.

import { escapeHtml } from './util.mjs';
import { host as appHost } from './host.mjs';
import { BUILD_STEPS } from './build-model.mjs';
import { buildStackHtml, wireBuildStack } from './build-stack-view.mjs';

// The atoms the three steps share live in build-atoms.mjs (the stack view draws
// them too); re-exported here so a step view keeps one import for them.
export { evidenceBadge, paramRowHtml, wireParamInputs } from './build-atoms.mjs';

export function stepHeadHtml(step, title, lede) {
  const n = BUILD_STEPS.indexOf(step) + 1;
  return `
    <header class="build-step-head">
      <div class="build-eyebrow">build · step ${n} of ${BUILD_STEPS.length} · ${escapeHtml(step)}</div>
      <h2 class="build-title">${escapeHtml(title)}</h2>
      <p class="build-lede">${lede}</p>
    </header>`;
}

/** The rejected copies of the last instantiation, as `<sli>.<field>` (a custom SLI's whole-SLI error as `<id>`). */
export function rejectedCopies(error) {
  // byCustom[''] holds the '+ Custom SLI' form's own errors (`custom[i]…`): the form shows them, no card does.
  const list = (map, prefix) => Object.entries(map || {}).filter(([sli]) => sli).flatMap(([sli, fields]) => Object.keys(fields || {}).map(f => `${prefix}${sli}${f ? `.${f}` : ''}`));
  return [...list(error?.byOverride, ''), ...list(error?.byCustom, 'custom ')];
}

/**
 * The last instantiation's usage errors as one note: the general ones spelled out, the rejected params counted
 * (their rows carry the reason), the rejected customised values named with the card to open — a closed face or
 * sheet showed only "the last compilation failed" and the user had to guess which card to Customise.
 */
export function instantiateErrorHtml(error, { stale = false, where = 'below' } = {}) {
  if (!error) return '';
  const parts = [...error.general.map(escapeHtml)];
  if (error.paramCount) parts.push(`${error.paramCount} parameter value${error.paramCount === 1 ? '' : 's'} rejected — marked on ${error.paramCount === 1 ? 'its row' : 'their rows'} ${where}`);
  const copies = rejectedCopies(error);
  if (copies.length) parts.push(`${copies.length} customised value${copies.length === 1 ? '' : 's'} rejected — ${escapeHtml(copies.join(', '))}: open ${copies.length === 1 ? 'its card' : 'their cards'} on L1 (the stack or the sheet), the field carries the reason`);
  return `<div class="build-note build-note-err" role="alert"><strong>The last compilation failed${stale ? ' — the pack shown is the previous one' : ''}.</strong> ${parts.join(' · ')}</div>`;
}

/** render(container, model, host) — the DEFINE step: the silhouette, and the way to Compile. */
export function renderBuildDefine(container, model, host = appHost) {
  const act = host.build;
  const entriesCount = model.selectedEntries.length;
  const stack = model.stack;
  const candidates = stack.slabs.reduce((n, s) => n + s.ghosts.filter(g => g.kind === 'sli').length, 0);
  container.innerHTML = `
    <section class="build-step build-define">
      ${stepHeadHtml('define', 'What are we observing?', 'Name the service, pick its criticality tier and the library entries it runs on in the column on the left — products with an evidence bar, or an archetype for a service built from scratch. The tier is a seed: it draws the silhouette of the pack it starts with, layer by layer, and decides which rubric grades it — never which SLIs you may add. The entries drop their SLIs onto L1; the edges light up as soon as the selection compiles. Click a layer to preview what it will carry, then seed the pack.')}

      ${instantiateErrorHtml(model.error, { stale: model.stale, where: 'on its layer sheet (L2 · L4 · L5)' })}

      <div class="build-stack-wrap build-silhouette">
        <div class="build-section-key">The stack ${escapeHtml(model.tier || '')} requires
          <span class="build-section-sub">${stack.counts.clauses.total} clause${stack.counts.clauses.total === 1 ? '' : 's'} over ${stack.slabs.filter(s => s.counts.clauses).length} layers — one ghost card per clause the tier applies in that dimension; ${candidates ? `the selection’s ${candidates} SLI${candidates === 1 ? '' : 's'} and the SLO each gets at ${escapeHtml(model.tier || 'this tier')} on L1 (composing is on Compile)` : 'pick an entry and its SLIs land on L1 with the SLO each gets'}. Change the tier and the silhouette reshapes${stack.counts.clauses.pending < stack.counts.clauses.total ? '; the edges carry the compiled pack’s verdict per layer — click one for its clauses and a preview of its options' : ''}.</span>
        </div>
        ${buildStackHtml(stack)}
      </div>

      <footer class="build-step-actions">
        <span class="build-step-status">${!model.valid ? `Still needed: ${model.errors.map(escapeHtml).join(' and ')}.` : model.error ? 'Selection complete, but the last compilation failed — see the error above.' : model.seeded ? `Seeded — ${entriesCount} entr${entriesCount === 1 ? 'y' : 'ies'}; your customisations wait on Compile.` : `Selection complete — ${entriesCount} entr${entriesCount === 1 ? 'y' : 'ies'}; seeding the pack opens Compile, where you compose it.`}</span>
        <button type="button" class="mcp-refresh-btn build-next" id="build-next" ${model.valid ? '' : 'disabled'}>${escapeHtml(model.nextLabel)} <span aria-hidden="true">→</span></button>
      </footer>
    </section>`;

  wireBuildStack(container, stack, host);
  container.querySelector('#build-next').addEventListener('click', () => (act.seed ? act.seed() : act.setStep('compile')));
}
