// studio/build-definition-view.mjs
//
// The definition column — the left, sticky column of every BUILD step
// (docs/BUILD_JOURNEY.md "The axis"): what the pack is, compactly. The
// service (name, owners, environment), the criticality tier as a segmented
// control (tier-3 · tier-2 · tier-1, each segment with its MUST · SHOULD
// counts, the chosen tier's one-line blurb beneath, a sliding thumb), the
// library entries as chips in a grid (products, then archetypes: title,
// evidence dot, SLIs at this tier; a selected chip is filled), and the
// conformance summary that replaced the clause rail — the status, the three
// counts (pass · on a placeholder · fail), the failing clauses named, how
// many pass only on a placeholder, the todos, warnings and placeholders
// left. DEFINE's tier cards, entry cards and fields moved here; the stack on
// the right is the main surface on all three steps.
//
// Renderer only (docs/UI_CONVENTIONS.md §2-3): render(container, model, host)
// with buildDefinitionModel's output; host.build.* are the actions — update
// (the text fields), setTier, toggleEntry. No state reads, no fetches.

import { escapeHtml } from './util.mjs';
import { host as appHost } from './host.mjs';
import { MAX_SERVICE_SLUG } from './build-model.mjs';
import { evidenceDot, clauseRowHtml, STATE_GLYPH } from './build-atoms.mjs';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function segmentHtml(t) {
  // The counts stack (MUST over SHOULD): a 100 px segment cannot hold "15 MUST · 1 SHOULD" on one line.
  const counts = t.must == null ? '<b>…</b>' : `<b>${t.must} MUST</b>${t.should ? `<b>${t.should} SHOULD</b>` : ''}`;
  return `
    <button type="button" role="radio" class="build-seg-btn" data-tier="${escapeHtml(t.id)}" aria-checked="${t.selected ? 'true' : 'false'}" tabindex="${t.selected ? '0' : '-1'}"
            title="${escapeHtml(`${t.label} — ${t.word}: ${t.blurb}`)}">
      <span class="build-seg-name">${escapeHtml(t.id)}</span>
      <span class="build-seg-counts" aria-label="${escapeHtml(t.must == null ? 'loading the clauses' : `${t.must} MUST${t.should ? `, ${t.should} SHOULD` : ''}`)}">${counts}</span>
    </button>`;
}

function chipHtml(c) {
  const at = c.sliCountAtTier;
  return `
    <button type="button" class="build-chip${c.selected ? ' is-selected' : ''}" data-entry="${escapeHtml(c.id)}" aria-pressed="${c.selected ? 'true' : 'false'}"
            title="${escapeHtml(`${c.title} — ${c.summary}${c.gaps ? ` · ${plural(c.gaps, 'evidence gap')}` : ''}`)}">
      <span class="build-chip-top">
        <span class="build-chip-title">${escapeHtml(c.title)}</span>
        ${evidenceDot(c.evidence.status, c.evidence.verifiedOn)}
      </span>
      <span class="build-chip-meta">
        <span class="build-chip-slis">${at} SLI${at === 1 ? '' : 's'} at this tier</span>
        ${c.placeholderParams ? `<span class="build-chip-ph" title="params the library cannot know — each left at its default becomes a todo">${c.placeholderParams} ◐</span>` : ''}
      </span>
    </button>`;
}

/** The conformance summary: the block that replaced the rail. */
export function summaryHtml(s) {
  const k = s.counts;
  return `
    <div class="build-summary is-${escapeHtml(s.statusKind)}" data-scroll-key="summary" aria-live="polite">
      <div class="build-def-key">Conformance <span class="build-summary-tier">${escapeHtml(s.tier || '')} · ${k.must.total} MUST${k.should.total ? ` · ${k.should.total} SHOULD` : ''}</span></div>
      <div class="build-summary-status">${escapeHtml(s.status)}</div>
      <div class="build-summary-counts" aria-label="clause states">
        <span class="build-summary-count is-pass" title="passes on the pack as written"><b aria-hidden="true">${STATE_GLYPH.pass}</b> ${k.pass} pass</span>
        <span class="build-summary-count is-placeholder" title="passes, but only on a placeholder value the team still has to fill"><b aria-hidden="true">${STATE_GLYPH.placeholder}</b> ${k.placeholder} on a placeholder</span>
        <span class="build-summary-count is-fail" title="does not pass at this tier"><b aria-hidden="true">${STATE_GLYPH.fail}</b> ${k.fail} fail</span>
      </div>
      ${s.failing.length ? `
      <div class="build-summary-failing">
        <div class="build-summary-sub">failing <span>the red edges on the stack — open the layer to see why</span></div>
        <ul class="build-rail-clauses">${s.failing.map(clauseRowHtml).join('')}</ul>
      </div>` : ''}
      ${s.onPlaceholder ? `<div class="build-summary-ph">${s.onPlaceholder} clause${s.onPlaceholder === 1 ? ' passes' : 's pass'} only on a placeholder — amber on the stack; the todos on those layers are the difference.</div>` : ''}
      <div class="build-summary-foot">
        <span class="build-summary-todos" title="placeholders and scaffold defaults only the team can fill"><b>${s.todoCount}</b> todo${s.todoCount === 1 ? '' : 's'}</span>
        <span class="build-summary-warnings${s.blockingWarnings ? ' is-blocking' : ''}" title="promql (blocking) · sli-excluded · burn-rules"><b>${s.warningCount}</b> warning${s.warningCount === 1 ? '' : 's'}</span>
        <span class="build-summary-left"><b>${s.placeholdersRemaining}</b> placeholder${s.placeholdersRemaining === 1 ? '' : 's'} left</span>
      </div>
    </div>`;
}

/** The column as HTML — the shell embeds it; wireBuildDefinition(container, model, host) wires it once in the DOM. */
export function buildDefinitionHtml(model) {
  const sel = model.selectedCount;
  return `
    <div class="build-def-inner">
      <section class="build-def-group build-def-service" aria-label="Service">
        <div class="build-def-key">Service</div>
        <label class="build-def-field">
          <span class="build-def-label">Name</span>
          <input id="build-name" type="text" data-focus-key="name" value="${escapeHtml(model.name)}" placeholder="orders-api" autocomplete="off" spellcheck="false" aria-describedby="build-name-hint">
          <span class="build-def-hint" id="build-name-hint">${model.name && model.slug !== model.name ? `slugs to <code>${escapeHtml(model.slug)}</code>` : `metadata.name and the metric prefix — at most ${MAX_SERVICE_SLUG} characters once slugged`}</span>
        </label>
        <label class="build-def-field">
          <span class="build-def-label">Owners</span>
          <input id="build-owners" type="text" data-focus-key="owners" value="${escapeHtml(model.owners)}" placeholder="team-orders, sre-platform" autocomplete="off" spellcheck="false">
          <span class="build-def-hint">${model.ownerList.length ? plural(model.ownerList.length, 'owner') : 'comma-separated — empty is a todo'}</span>
        </label>
        <label class="build-def-field">
          <span class="build-def-label">Environment</span>
          <input id="build-env" type="text" data-focus-key="environment" list="build-env-options" value="${escapeHtml(model.environment)}" placeholder="prod" autocomplete="off" spellcheck="false">
          <datalist id="build-env-options"><option value="prod"></option><option value="staging"></option><option value="dev"></option><option value="eks"></option><option value="local-docker"></option></datalist>
          <span class="build-def-hint">the pack’s one environment; its overlay carries the tier</span>
        </label>
      </section>

      <section class="build-def-group build-def-tier" aria-label="Criticality tier">
        <div class="build-def-key">Criticality tier <span class="build-def-sub">the rubric filtered by minTier — the only definition of what the pack must contain</span></div>
        <div class="build-seg" role="radiogroup" aria-label="Criticality tier" style="--seg-index:${model.tierIndex}">
          <span class="build-seg-thumb" aria-hidden="true"></span>
          ${model.tiers.map(segmentHtml).join('')}
        </div>
        <p class="build-seg-blurb"><b>${escapeHtml(model.tier || '')}</b> ${escapeHtml(model.tierBlurb)}</p>
      </section>

      <section class="build-def-group build-def-library" aria-label="Library entries">
        <div class="build-def-key">Library <span class="build-def-sub">${sel ? `${sel} selected — ${model.selectedTitles.map(escapeHtml).join(', ')}` : 'pick one or more; several compose into one pack'}</span></div>
        <div class="build-chip-kind">Products <span>what the service runs on</span></div>
        <div class="build-chips" role="group" aria-label="Products">${model.products.map(chipHtml).join('')}</div>
        <div class="build-chip-kind">Archetypes <span>a service built from scratch</span></div>
        <div class="build-chips" role="group" aria-label="Archetypes">${model.archetypes.map(chipHtml).join('')}</div>
        ${model.libraryErrors.length ? `<div class="build-note build-note-warn">${plural(model.libraryErrors.length, 'library file')} did not load: ${model.libraryErrors.map(e => `<code>${escapeHtml(e.file)}</code>`).join(', ')}</div>` : ''}
        ${!model.valid ? `<div class="build-def-needed">Still needed: ${model.errors.map(escapeHtml).join(' and ')}.</div>` : ''}
      </section>

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

export function wireBuildDefinition(container, model, host = appHost) {
  const act = host.build;
  const byId = (id) => container.querySelector(`#${id}`);
  byId('build-name')?.addEventListener('input', (e) => act.update({ name: e.target.value }));
  byId('build-owners')?.addEventListener('input', (e) => act.update({ owners: e.target.value }));
  byId('build-env')?.addEventListener('input', (e) => act.update({ environment: e.target.value }));
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
}
