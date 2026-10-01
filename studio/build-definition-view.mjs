// studio/build-definition-view.mjs
//
// The definition column — the left, sticky column of every BUILD step
// (docs/BUILD_JOURNEY.md "The axis"): what the pack is, compactly.
//
// On DEFINE it is a sticky progress summary (the 2026-09 UX review, "Build /
// Define": a narrow form that scrolled on its own beside a long canvas was
// nested scrolling): the four substeps of the step — Service · Criticality ·
// Technology · Review suggestions — each a button with what it holds now
// (orders-api · team-orders · prod; tier-2 · important; …) and whether it is
// done, what is still needed, and the conformance summary that replaced the
// clause rail — the status in plain words ("meets the tier-2 rubric"), the
// three counts (pass · need real values · fail), the failing clauses named,
// how many are represented but still need a real value, the todos, warnings
// and placeholders left. The form itself — the service
// fields, the tier cards with their consequences, the technology cards — is
// on the step (build-define-view.mjs), one substep at a time; this module
// keeps its wiring (wireBuildDefinition), so the two share one set of
// handlers.
//
// The definition is a wizard stage (docs/BUILD_JOURNEY.md "The seed and the
// copies"): the progress on DEFINE (with a one-line note once seeded); on
// COMPILE and VERIFY a read-only, recessed SEED card — the service as a
// definition list, one tier chip, the entries as muted chips (each opens the
// L1 sheet on that product's SLIs), "Change seed →" back to DEFINE — with the
// conformance summary live beneath it on every step.
//
// Renderer only (docs/UI_CONVENTIONS.md §2-3): render(container, model, host)
// with buildDefinitionModel's output; host.build.* are the actions — update
// (the text fields, the substep), setTier, toggleEntry. No state reads, no fetches.

import { escapeHtml } from './util.mjs';
import { host as appHost } from './host.mjs';
import { serviceLine } from './build-model.mjs';
import { clauseRowHtml, STATE_GLYPH } from './build-atoms.mjs';
import { termHtml } from './ux-kit.mjs';

/**
 * The progress summary (DEFINE): the four substeps in order, each a button to it with what it holds now and whether
 * it is done — the current one marked aria-current="step" — then what is still needed. The service line repaints
 * as the name is typed (data-progress-val), before any re-render.
 */
export function progressHtml(model) {
  const items = model.substeps || [];
  return `
      <nav class="build-def-group bd-progress" aria-label="Define progress">
        <div class="build-def-key">Your pack <span class="build-def-sub">${model.substepsDone ?? 0} of ${items.length} steps done</span></div>
        <ol class="bd-progress-list">${items.map(s => `
          <li class="bd-progress-item is-${escapeHtml(s.status)}${s.complete && s.status !== 'complete' ? ' is-complete' : ''}">
            <button type="button" class="bd-progress-btn" data-define-sub="${escapeHtml(s.id)}" data-focus-key="dprog:${escapeHtml(s.id)}"${s.current ? ' aria-current="step"' : ''}>
              <span class="bd-progress-n" aria-hidden="true">${s.complete && !s.current ? '✓' : s.n}</span>
              <span class="bd-progress-text">
                <span class="bd-progress-label">${escapeHtml(s.label)}<span class="sr-text">${s.complete ? ' — done' : ' — needs input'}</span></span>
                <span class="bd-progress-val" data-progress-val="${escapeHtml(s.id)}">${escapeHtml(s.value)}</span>
              </span>
            </button>
          </li>`).join('')}
        </ol>
        ${!model.valid ? `<div class="build-def-needed">Still needed: ${model.errors.map(escapeHtml).join(' and ')}.</div>` : ''}
      </nav>`;
}

/** The conformance summary: the block that replaced the rail. */
export function summaryHtml(s) {
  const k = s.counts;
  return `
    <div class="build-summary is-${escapeHtml(s.statusKind)}" data-scroll-key="summary">
      <div class="build-def-key">${termHtml('conformant', 'Tier rubric')} <span class="build-summary-tier">${escapeHtml(s.tier || '')} · ${k.must.total} MUST${k.should.total ? ` · ${k.should.total} SHOULD` : ''}</span></div>
      <div class="build-summary-status">${escapeHtml(s.status)}</div>
      <div class="build-summary-counts" aria-label="clause states">
        <span class="build-summary-count is-pass" title="passes on the pack as written"><b aria-hidden="true">${STATE_GLYPH.pass}</b> ${k.pass} pass</span>
        <span class="build-summary-count is-placeholder" title="Requirement represented; real value still needed — it passes the rubric on a placeholder value the team still has to fill"><b aria-hidden="true">${STATE_GLYPH.placeholder}</b> ${k.placeholder} need real values</span>
        <span class="build-summary-count is-fail" title="does not pass at this tier"><b aria-hidden="true">${STATE_GLYPH.fail}</b> ${k.fail} fail</span>
      </div>
      ${s.failing.length ? `
      <div class="build-summary-failing">
        <div class="build-summary-sub">failing <span>the red edges on the stack — open the layer to see why</span></div>
        <ul class="build-rail-clauses">${s.failing.map(clauseRowHtml).join('')}</ul>
      </div>` : ''}
      ${s.onPlaceholder ? `<div class="build-summary-ph">${s.onPlaceholder} requirement${s.onPlaceholder === 1 ? ' is' : 's are'} represented but still need${s.onPlaceholder === 1 ? 's' : ''} a real value — amber on the stack; the todos on those layers are what remains.</div>` : ''}
      <div class="build-summary-foot">
        <span class="build-summary-todos" title="placeholders and scaffold defaults only the team can fill"><b>${s.todoCount}</b> todo${s.todoCount === 1 ? '' : 's'}</span>
        <span class="build-summary-warnings${s.blockingWarnings ? ' is-blocking' : ''}" title="promql (blocking) · sli-excluded · burn-rules"><b>${s.warningCount}</b> warning${s.warningCount === 1 ? '' : 's'}</span>
        <span class="build-summary-left"><b>${s.placeholdersRemaining}</b> placeholder${s.placeholdersRemaining === 1 ? '' : 's'} left</span>
      </div>
    </div>`;
}

/** The seed card: the definition, read-only and recessed, once the pack is seeded (COMPILE and VERIFY). */
export function seedCardHtml(card) {
  const k = card.counts;
  const from = [
    `${k.slis} SLI${k.slis === 1 ? '' : 's'} in the pack`,
    k.aboveTier ? `${k.aboveTier} from a higher tier` : '',
    k.customised ? `${k.customised} customised` : '',
    k.custom ? `${k.custom} custom` : '',
  ].filter(Boolean).join(' · ');
  return `
    <section class="build-seed" aria-label="Seed">
      <div class="build-seed-eyebrow">Seed</div>
      <dl class="build-seed-dl">
        <dt>Service</dt><dd><code>${escapeHtml(card.slug || card.name || '—')}</code></dd>
        <dt>Owners</dt><dd>${card.owners.length ? card.owners.map(o => `<span>${escapeHtml(o)}</span>`).join(', ') : '<em>none — a todo</em>'}</dd>
        <dt>Environment</dt><dd>${escapeHtml(card.environment)}</dd>
      </dl>
      <div class="build-seed-tier"><span class="build-seed-chip is-tier" data-tier="${escapeHtml(card.tier || '')}">${escapeHtml(card.tierChip)}</span></div>
      <div class="build-seed-entries" aria-label="Library entries">${card.entries.map(e => `<button type="button" class="build-seed-chip is-entry" data-seed-entry="${escapeHtml(e.id)}" data-focus-key="seed:${escapeHtml(e.id)}" aria-haspopup="dialog" title="${escapeHtml(`${e.kind} — open the L1 sheet on its SLIs`)}">${escapeHtml(e.title)}</button>`).join('')}</div>
      <div class="build-seed-from">${escapeHtml(from)}</div>
      <button type="button" class="build-seed-change" data-change-seed data-focus-key="seed:change">${escapeHtml(card.changeLabel)} <span aria-hidden="true">→</span></button>
    </section>`;
}

/** The column as HTML — the shell embeds it; wireBuildDefinition(container, model, host) wires it once in the DOM. */
export function buildDefinitionHtml(model) {
  // Seeded and past DEFINE: the definition recedes into the seed card; the summary stays live below it.
  if (model.mode === 'seed') {
    return `
    <div class="build-def-inner is-seeded">
      ${seedCardHtml(model.seedCard)}
      <section class="build-def-group" aria-label="Conformance summary">
        ${summaryHtml(model.summary)}
      </section>
    </div>`;
  }
  // DEFINE: the progress summary of the substeps (the form is on the step), the conformance summary beneath.
  return `
    <div class="build-def-inner is-progress">
      ${model.seededNote ? `<p class="build-def-seeded" role="note">${escapeHtml(model.seededNote)}</p>` : ''}
      ${progressHtml(model)}
      <section class="build-def-group" aria-label="Conformance summary">
        ${summaryHtml(model.summary)}
      </section>
    </div>`;
}

/**
 * render(container, model, host) — the definition column. host.build.update carries the
 * text fields (re-instantiation after a pause), setTier and toggleEntry the structural ones.
 */
export function renderBuildDefinition(container, model, host = appHost) {
  container.innerHTML = buildDefinitionHtml(model);
  wireBuildDefinition(container, model, host);
}

/**
 * The definition's handlers, wherever the controls are drawn — the column (the progress, the seed card) and the
 * DEFINE step (the service fields, the tier cards, the technology cards): the text fields update the draft as typed
 * (and repaint the progress summary's service line at once), a tier card or an arrow key sets the tier, a technology
 * card toggles its entry, a substep button (the step's indicator, the column's progress) moves to that substep.
 */
export function wireBuildDefinition(container, model, host = appHost) {
  const act = host.build;
  const byId = (id) => container.querySelector(`#${id}`);
  // The service line of the progress summary follows the fields as typed (a keystroke re-renders nothing).
  const paintService = () => {
    const text = serviceLine({ name: byId('build-name')?.value ?? model?.name, owners: byId('build-owners')?.value ?? model?.owners, environment: byId('build-env')?.value ?? model?.environment });
    for (const el of container.ownerDocument?.querySelectorAll?.('[data-progress-val="service"]') || []) el.textContent = text;
  };
  byId('build-name')?.addEventListener('input', (e) => { act.update({ name: e.target.value }); paintService(); });
  byId('build-owners')?.addEventListener('input', (e) => { act.update({ owners: e.target.value }); paintService(); });
  byId('build-env')?.addEventListener('input', (e) => { act.update({ environment: e.target.value }); paintService(); });
  // A substep: the draft remembers which one is shown (UI state, never persisted); the focus lands on its heading.
  // The indicator is brought into view first, so the render that follows keeps the page where the substep starts.
  container.querySelectorAll('[data-define-sub]').forEach(b => b.addEventListener('click', () => {
    container.ownerDocument?.querySelector?.('.bd-substeps')?.scrollIntoView?.({ block: 'nearest' });
    act.update?.({ defineSub: b.dataset.defineSub }, { rerender: true, reinstantiate: false, focus: `dpanel:${b.dataset.defineSub}` });
  }));
  // The segmented control: a click picks; arrow keys move within the group (a radiogroup's keyboard contract).
  const segs = [...container.querySelectorAll('.build-seg-btn')];
  segs.forEach((btn, i) => {
    btn.addEventListener('click', () => act.setTier(btn.dataset.tier));
    btn.addEventListener('keydown', (e) => {
      const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!delta) return;
      e.preventDefault();
      const next = segs[(i + delta + segs.length) % segs.length];
      next.focus();
      act.setTier(next.dataset.tier);
    });
  });
  container.querySelectorAll('.build-chip').forEach(b => b.addEventListener('click', () => act.toggleEntry(b.dataset.entry)));
  container.querySelector('[data-change-seed]')?.addEventListener('click', () => act.setStep('define'));
  // A product chip on the seed card opens the L1 sheet on that product's SLIs.
  container.querySelectorAll('[data-seed-entry]').forEach(b => b.addEventListener('click', () => act.openSheet?.('L1', { entry: b.dataset.seedEntry })));
}
