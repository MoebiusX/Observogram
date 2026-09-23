// studio/build-sheet-view.mjs
//
// The per-layer sheet (docs/BUILD_JOURNEY.md "The axis"): what you can add on
// each layer pops up when you click that layer. A non-modal side panel
// anchored to the right edge over the stack — role=dialog, labelled by its
// title, Esc closes, focus moves in and returns to the slab head, the stack
// stays visible and dimmed, one sheet at a time — with a large title (`L1 ·
// Contract`), the layer's question, the layer's clauses at the tier with
// their state (the same clause row the slabs and the summary draw), then
// the layer's options:
//
//   L1  the SLI rolodex — a scroll-snapping carousel of SLI cards from the
//       selected entries (every product's behind a filter), each with its
//       product and evidence, type, metrics, the objective and window it
//       starts with large and the other tiers muted, an add / remove switch
//       (an SLI above the tier is addable and says which profile it starts
//       from: the tier is a seed, not a gate), a Customise affordance that
//       expands the card in place into its edit face (objective, window,
//       bound, PromQL, description — each with '↺ library default'; an
//       edited expression turns the evidence badge custom), the custom SLIs
//       as cards of their own, and the last card '+ Custom SLI' (an inline
//       form with the engine's errors inline); then the SLOs switch
//   L2  the scrape jobs, receivers, backends, exporters and storage the pack
//       carries, with their params (targets, endpoints, versions) editable
//   L3  the Dashboards switch, the boards, the derived views, the recording rules
//   L4  the Policy switch (the burn windows per SLO), the Routes switch with
//       the channel params, the remediation templates
//   L5  the Validation switch, the probes and chaos experiments with their
//       target params, the baselines
//   GOV the owners and the imports, read-only
//
// One component on the three steps: editable on COMPILE, a preview on DEFINE
// (with "Compose in Compile →"), read-only on VERIFY with the layer's todos
// and their inline params (and the customised / custom cards' read-only
// faces with their provenance line). Everything it changes goes through the
// actions (setSli / addSli, setToggle, setParam, setOverride / clearOverride,
// addCustom / updateCustom / removeCustom); re-instantiation redraws.
//
// Renderer only (docs/UI_CONVENTIONS.md §2-3): render(container, model, host)
// with buildSheetModel's output; host.build.* are the actions.

import { escapeHtml } from './util.mjs';
import { host as appHost } from './host.mjs';
import { sheetFocusSuffix } from './build-model.mjs';
import { customDefFromDraft, normalizeDraft, slugifySliId, SLO_WINDOWS } from './build-copies-model.mjs';
import { evidenceBadge, paramRowHtml, wireParamInputs, clauseRowHtml, todoHtml, switchHtml, editFieldHtml, STATE_GLYPH } from './build-atoms.mjs';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const MODE_WORD = { edit: 'compose', preview: 'preview', verify: 'verify' };
/** How long the rolodex waits for a smooth scroll to move before scrolling instantly instead. */
export const SMOOTH_SCROLL_GRACE_MS = 250;
const READ_ONLY_REASON = { preview: 'a preview — compose it on Compile', verify: 'read-only on Verify — change it on Compile' };

function switchRowHtml(s, model) {
  const readOnly = model.readOnly;
  return `
    <div class="build-switch-row${s.on ? ' is-on' : ''}${s.disabled ? ' is-disabled' : ''}" data-section="${escapeHtml(s.id)}">
      <div class="build-switch-text">
        <span class="build-switch-label" id="build-switch-${escapeHtml(s.id)}">${escapeHtml(s.label)}</span>
        <span class="build-switch-hint">${escapeHtml(s.hint)}</span>
        <span class="build-switch-consequence${s.on ? '' : ' is-off'}">${escapeHtml(s.consequence)}</span>
      </div>
      ${switchHtml({ on: s.on, disabled: s.disabled || readOnly, reason: s.disabled ? 'meaningless without SLOs' : readOnly ? READ_ONLY_REASON[model.mode] : null, label: `${s.label} section`, focusKey: s.focusKey, data: { toggle: s.id } })}
    </div>`;
}

/** The Customise face of a selected card — editable on COMPILE, read-only on VERIFY (the same fields as value spans, no reset, the provenance line). One field is the shared atom (build-atoms.mjs editFieldHtml). */
function editFaceHtml(face) {
  return `
    <div class="build-edit-face${face.readOnly ? ' is-readonly' : ''}" id="${escapeHtml(`build-face-${face.key}`)}" data-face="${escapeHtml(face.key)}">
      <div class="build-edit-head">
        <span class="build-edit-eyebrow">${face.readOnly ? 'as customised' : face.custom ? 'your SLI' : 'customise — a copy of the library’s values'}</span>
        <span class="build-edit-provenance">${escapeHtml(face.provenance)}</span>
      </div>
      ${face.generalError ? `<div class="build-edit-error" role="alert">${escapeHtml(face.generalError)}</div>` : ''}
      ${face.fields.map(f => editFieldHtml(f, { dataAttr: face.custom ? 'custom-field' : 'override-field', sli: face.key, readOnly: face.readOnly })).join('')}
      <div class="build-edit-evidence">${evidenceBadge(face.evidence.status)}${face.evidence.note ? `<span class="build-edit-evidence-note">${escapeHtml(face.evidence.note)}</span>` : '<span class="build-edit-evidence-note">the library’s evidence — its expression is what runs</span>'}</div>
      ${face.promqlWarning ? `<div class="build-edit-error build-edit-promql" role="alert">${escapeHtml(face.promqlWarning)}</div>` : ''}
    </div>`;
}

function rolodexCardHtml(it, model) {
  const cls = ['build-rolo-card', it.selected ? 'is-selected' : '', it.entrySelected ? '' : 'is-foreign', it.aboveTier ? 'is-above' : '', it.custom ? 'is-custom' : '', it.customised.length ? 'is-customised' : '', it.face ? 'is-open' : ''].filter(Boolean).join(' ');
  const readOnly = model.readOnly;
  const stateWord = it.custom ? 'in the pack · custom' : it.selected ? 'in the pack' : it.entrySelected ? 'not in the pack' : `adds ${it.entryTitle}`;
  const label = `${it.id} of ${it.entryTitle}${it.custom ? ' — remove your SLI from the pack' : it.selected ? ' — remove from the pack' : it.entrySelected ? ' — add to the pack' : ` — add to the pack (selects ${it.entryTitle} too)`}${it.aboveTier ? ` (from the ${it.profileTier} profile)` : ''}`;
  const canCustomise = !readOnly && it.selected;
  return `
    <article class="${cls}" data-snap-card data-sli="${escapeHtml(it.key)}" data-entry="${escapeHtml(it.entry || '')}" data-sli-id="${escapeHtml(it.id)}"${it.custom ? ' data-custom="1"' : ''} aria-label="${escapeHtml(label)}">
      <header class="build-rolo-head">
        <span class="build-rolo-id">${escapeHtml(it.id)}</span>
        <span class="build-rolo-chips">
          ${it.aboveTier ? `<span class="build-rolo-chip is-above" title="${escapeHtml(`this SLI's own tier is ${it.profileTier}: it starts from that profile's objective and window — add it if you need it, the tier is a seed, not a gate`)}">${escapeHtml(it.note)}</span>` : ''}
          ${it.custom ? '<span class="build-rolo-chip is-custom" title="written in the studio — not a library SLI">custom</span>' : it.customised.length ? `<span class="build-rolo-chip is-customised" title="${escapeHtml(it.customisedLabel)}">customised</span>` : ''}
          <span class="type-pill build-rolo-type">${escapeHtml(it.type)}</span>
        </span>
      </header>
      <div class="build-rolo-product">${escapeHtml(it.entryTitle)} ${evidenceBadge(it.evidence || it.entryEvidence)}${it.entrySelected ? '' : '<span class="build-rolo-foreign" title="this product is not in the selection yet — adding the SLI selects it">not selected yet</span>'}</div>
      ${it.evidenceNote ? `<div class="build-rolo-evidence-note">${escapeHtml(it.evidenceNote)}</div>` : ''}
      <p class="build-rolo-desc">${escapeHtml(it.description)}</p>
      <div class="build-rolo-metrics">${it.metrics.map(m => `<code>${escapeHtml(m)}</code>`).join('')}</div>
      <div class="build-rolo-objective">
        <b>${escapeHtml(it.objectiveLabel)}</b><span>over ${escapeHtml(it.window || '—')} · ${it.custom ? 'your objective' : it.customised.includes('objective') || it.customised.includes('window') ? 'customised' : it.aboveTier ? `the ${escapeHtml(it.profileTier)} profile` : `at ${escapeHtml(model.tier || '')}`}</span>
      </div>
      ${it.tiers.length ? `<div class="build-rolo-tiers" aria-label="the library's objective per tier">
        ${it.tiers.map(t => `<span class="${t.current ? 'is-current' : 'is-muted'}${t.reachable ? '' : ' is-unreachable'}" title="${escapeHtml(`${t.tier}: ${t.objectiveLabel} over ${t.window || '—'}${t.reachable ? '' : ' — below this SLI’s own tier (a default from ' + it.profileTier + ' up)'}`)}">${escapeHtml(t.tier)} <b>${escapeHtml(t.objectiveLabel)}</b> ${t.window ? escapeHtml(t.window) : ''}</span>`).join('')}
      </div>` : ''}
      ${it.face ? editFaceHtml(it.face) : ''}
      <footer class="build-rolo-foot">
        <span class="build-rolo-state">${escapeHtml(stateWord)}</span>
        <span class="build-rolo-actions">
          ${canCustomise ? `<button type="button" class="build-rolo-customise${it.face ? ' is-on' : ''}" data-customise="${escapeHtml(it.key)}" data-focus-key="customise:${escapeHtml(it.key)}" aria-expanded="${it.face ? 'true' : 'false'}"${it.face ? ` aria-controls="${escapeHtml(`build-face-${it.key}`)}"` : ''}>${it.face ? 'Done' : 'Customise'}</button>` : ''}
          ${switchHtml({ on: it.selected, disabled: readOnly, reason: readOnly ? READ_ONLY_REASON[model.mode] : null, label, focusKey: it.focusKey, data: { sli: it.key, entry: it.entry || '', 'sli-id': it.id, selected: it.selected ? '1' : '0', 'entry-selected': it.entrySelected ? '1' : '0', ...(it.custom ? { custom: '1' } : {}) } })}
        </span>
      </footer>
    </article>`;
}

/** The last card of the rolodex on COMPILE: the '+ Custom SLI' form, the engine's usage errors inline; each field the shared atom. */
function customFormCardHtml(form) {
  const field = (f) => editFieldHtml(f, { dataAttr: 'custom-draft', rows: 2 });
  return `
    <article class="build-rolo-card build-rolo-custom-form" data-snap-card data-custom-form aria-label="Add a custom SLI">
      <header class="build-rolo-head">
        <span class="build-rolo-id">+ Custom SLI</span>
        <span class="type-pill build-rolo-type">${escapeHtml(form.draft.type)}</span>
      </header>
      <div class="build-rolo-product">written from scratch ${evidenceBadge('custom')}</div>
      <p class="build-rolo-desc">An SLI outside any library entry. It gets an SLO, a recording rule, burn alerts from the default profile and a place on the boards like any SLI; the engine checks every value.</p>
      <form class="build-edit-face build-custom-form" data-custom-form-fields novalidate>
        ${form.generalError ? `<div class="build-edit-error" role="alert">${escapeHtml(form.generalError)}</div>` : ''}
        ${form.fields.map(field).join('')}
      </form>
      <footer class="build-rolo-foot">
        <span class="build-rolo-state">not in the pack yet</span>
        <button type="button" class="mcp-refresh-btn build-custom-add" data-add-custom data-focus-key="${escapeHtml(form.focusKey)}"${form.canSubmit ? '' : ' disabled'}>${escapeHtml(form.addLabel)} <span aria-hidden="true">→</span></button>
      </footer>
    </article>`;
}

function rolodexHtml(model) {
  const r = model.rolodex;
  if (!r) return '';
  const c = r.counts;
  return `
    <section class="build-sheet-section build-rolodex-section" aria-labelledby="build-rolodex-title">
      <div class="build-sheet-section-head is-row">
        <h3 id="build-rolodex-title">SLI rolodex <span class="build-sheet-count">${c.selected} in the pack${c.aboveTier ? ` · ${c.aboveTier} from a higher tier` : ''}${c.customised ? ` · ${c.customised} customised` : ''}${c.custom ? ` · ${c.custom} custom` : ''} · ${c.selectable} in the library${r.filterAll ? ` (${r.items.length} across it)` : ''}</span></h3>
        <label class="build-rolodex-filter">
          <span>show every product</span>
          ${switchHtml({ on: r.filterAll, label: 'show every product’s SLIs', focusKey: 'rolodex:all', data: { 'rolodex-all': r.filterAll ? '1' : '0' }, small: true })}
        </label>
      </div>
      ${r.items.length || r.customForm ? `
      <div class="build-rolodex">
        <button type="button" class="build-rolodex-nav is-prev" aria-label="previous SLI" data-nav="-1"><span aria-hidden="true">‹</span></button>
        <div class="build-rolodex-track" role="group" aria-roledescription="carousel" aria-label="SLI cards — arrow keys move" tabindex="0" data-scroll-key="rolodex:${escapeHtml(model.layerId)}">
          ${r.items.map(it => rolodexCardHtml(it, model)).join('')}${r.customForm ? customFormCardHtml(r.customForm) : ''}
        </div>
        <button type="button" class="build-rolodex-nav is-next" aria-label="next SLI" data-nav="1"><span aria-hidden="true">›</span></button>
        <div class="build-rolodex-counter" aria-live="polite">1 / ${r.items.length + (r.customForm ? 1 : 0)}</div>
        <datalist id="build-window-options">${SLO_WINDOWS.map(w => `<option value="${escapeHtml(w)}"></option>`).join('')}</datalist>
      </div>` : '<div class="build-sheet-empty">pick a library entry in the definition column — its SLIs land here</div>'}
      ${model.mode === 'edit' ? '<p class="build-sheet-note">Any SLI of the selected products can be in the pack — the tier only seeds the defaults; one above the tier says which profile it starts from. Adding an SLI from a product that is not selected yet selects that product too. Customise copies the library’s values into your pack: the objective, the window, the bound, the PromQL, the description — each back to the library default in one click; an edited expression carries no library evidence. The last card writes an SLI from scratch.</p>' : ''}
    </section>`;
}

function listHtml(l) {
  return `
    <section class="build-sheet-section build-sheet-list" data-list="${escapeHtml(l.id)}">
      <div class="build-sheet-section-head"><h3>${escapeHtml(l.label)} <span class="build-sheet-count">${l.items.length}</span></h3>${l.sub ? `<span class="build-sheet-sub">${escapeHtml(l.sub)}</span>` : ''}</div>
      ${l.items.length ? `<ul class="build-sheet-items">${l.items.map(it => `
        <li class="build-sheet-item${it.scaffold ? ' is-scaffold' : ''}" title="${escapeHtml(`${it.id}${it.scaffold ? ' — Scaffold: a placeholder value the team fills' : ''}`)}">
          <span class="build-sheet-item-id">${escapeHtml(it.id)}</span>
          <span class="build-sheet-item-main"><span class="build-sheet-item-title">${escapeHtml(it.title)}</span>${it.desc ? `<span class="build-sheet-item-desc">${escapeHtml(it.desc)}</span>` : ''}</span>
          <span class="build-sheet-item-meta">${it.meta.map(m => `<span>${escapeHtml(m)}</span>`).join('')}${it.scaffold ? '<span class="build-sheet-scaffold">scaffold</span>' : ''}</span>
        </li>`).join('')}</ul>` : `<div class="build-sheet-empty">${escapeHtml(l.empty)}</div>`}
    </section>`;
}

function paramGroupHtml(g, model) {
  const editable = model.mode === 'edit';
  return `
    <section class="build-sheet-section build-sheet-params" data-params="${escapeHtml(g.id)}">
      <div class="build-sheet-section-head"><h3>${escapeHtml(g.label)} <span class="build-sheet-count">${g.rows.length}</span></h3>${g.sub ? `<span class="build-sheet-sub">${escapeHtml(g.sub)}</span>` : ''}</div>
      <div class="build-params build-sheet-param-grid">${g.rows.map(p => paramRowHtml(p, { compact: true, readOnly: !editable, idSuffix: sheetFocusSuffix(model.layerId) })).join('')}</div>
    </section>`;
}

function todosHtml(model) {
  if (model.mode !== 'verify') return '';
  return `
    <section class="build-sheet-section build-sheet-todos">
      <div class="build-sheet-section-head"><h3>Todos on this layer <span class="build-sheet-count">${model.todos.length}</span></h3><span class="build-sheet-sub">placeholders and scaffold defaults only the team can fill — fill one here and the pack regenerates</span></div>
      ${model.todos.length ? `<ul class="build-todo-list">${model.todos.map(t => todoHtml(t, sheetFocusSuffix(model.layerId, t.path))).join('')}</ul>` : '<div class="build-sheet-empty">no todo on this layer — nothing here rests on a placeholder</div>'}
    </section>`;
}

/** The sheet as HTML (the scrim and the panel); wireBuildSheet(container, model, host) wires it once in the DOM. */
export function buildSheetHtml(model) {
  const readOnlyWhy = model.mode === 'preview'
    ? 'A preview: the requirements the tier puts on this layer and what the selection brings. Composition happens on Compile.'
    : model.mode === 'verify' ? 'Read-only on Verify: the options as compiled, and the todos that rest on a placeholder.' : '';
  return `
    <div class="build-sheet-scrim${model.entering ? ' is-entering' : ''}" data-close aria-hidden="true"></div>
    <aside class="build-sheet is-${escapeHtml(model.mode)} is-${escapeHtml(model.state)}${model.dimmed ? ' is-dimmed' : ''}${model.entering ? ' is-entering' : ''}" role="dialog" aria-modal="false" aria-labelledby="build-sheet-title" aria-describedby="build-sheet-question" data-layer="${escapeHtml(model.layerId)}" data-mode="${escapeHtml(model.mode)}" tabindex="-1">
      <header class="build-sheet-head">
        <div class="build-sheet-eyebrow">layer · ${escapeHtml(MODE_WORD[model.mode] || model.mode)} · ${escapeHtml(model.tier || '')}</div>
        <h2 class="build-sheet-title" id="build-sheet-title">${escapeHtml(model.title)}</h2>
        <p class="build-sheet-question" id="build-sheet-question">${escapeHtml(model.question)}</p>
        <button type="button" class="build-sheet-close" data-close aria-label="Close the layer sheet (Esc)" title="Close (Esc)"><span aria-hidden="true">esc</span></button>
        <div class="build-sheet-verdict">
          <span class="build-slab-verdict is-${escapeHtml(model.state)}"><b aria-hidden="true">${STATE_GLYPH[model.state]}</b> ${escapeHtml(model.stateText)}</span>
          ${model.offSections.map(s => `<span class="build-slab-off">${escapeHtml(s)} off</span>`).join('')}
          ${model.notes.map(n => `<span class="build-slab-off build-slab-note" title="${escapeHtml(n.why)}">${escapeHtml(n.text)}</span>`).join('')}
          ${model.counts.artefacts ? `<span class="build-sheet-artefacts">${plural(model.counts.artefacts, 'artefact')}${model.counts.scaffold ? ` · ${model.counts.scaffold} scaffold` : ''}</span>` : ''}
        </div>
      </header>
      <div class="build-sheet-body" data-scroll-key="sheet:${escapeHtml(model.layerId)}">
        ${model.compose ? `<div class="build-sheet-compose"><span>${escapeHtml(readOnlyWhy)}</span><button type="button" class="mcp-refresh-btn build-sheet-compose-btn" data-compose>Compose in Compile <span aria-hidden="true">→</span></button></div>` : readOnlyWhy ? `<div class="build-sheet-note">${escapeHtml(readOnlyWhy)}</div>` : ''}
        ${model.rejected ? `<div class="build-note build-note-err" role="alert">${plural(model.rejected, 'parameter value')} on this layer rejected by the last compilation${model.stale ? ' — the pack shown is the previous one' : ''}; the row carries the reason.</div>` : ''}
        <section class="build-sheet-section build-sheet-clauses">
          <div class="build-sheet-section-head"><h3>Clauses at ${escapeHtml(model.tier || 'this tier')} <span class="build-sheet-count">${model.clauses.length}</span></h3>${model.why.length ? `<span class="build-sheet-sub">${escapeHtml(model.why.join(' · '))}</span>` : ''}</div>
          ${model.clauses.length ? `<ul class="build-rail-clauses">${model.clauses.map(clauseRowHtml).join('')}</ul>` : '<div class="build-sheet-empty">no clause of the tier applies to this layer</div>'}
        </section>
        ${rolodexHtml(model)}
        ${model.switches.length ? `
        <section class="build-sheet-section build-sheet-switches">
          <div class="build-sheet-section-head"><h3>Sections</h3><span class="build-sheet-sub">a section switched off is absent from the pack — the schema and the rubric both say what is missing</span></div>
          ${model.switches.map(s => switchRowHtml(s, model)).join('')}
        </section>` : ''}
        ${model.paramGroups.map(g => paramGroupHtml(g, model)).join('')}
        ${model.owners ? `
        <section class="build-sheet-section">
          <div class="build-sheet-section-head"><h3>Owners <span class="build-sheet-count">${model.owners.length}</span></h3><span class="build-sheet-sub">the same field as the definition column — edit it there; empty is a todo</span></div>
          ${model.owners.length ? `<div class="build-sheet-owners">${model.owners.map(o => `<span>${escapeHtml(o)}</span>`).join('')}</div>` : '<div class="build-sheet-empty">no owner yet — the scaffold reports it as a todo</div>'}
        </section>` : ''}
        ${model.lists.map(listHtml).join('')}
        ${todosHtml(model)}
        ${model.mode === 'edit' && model.todoCount ? `<p class="build-sheet-note">${plural(model.todoCount, 'todo')} on this layer — the placeholders are filled on Verify, where each sits under its artefact.</p>` : ''}
      </div>
    </aside>`;
}

/**
 * render(container, model, host) — the sheet on its own. host.build.closeSheet, setStep,
 * setToggle, setSli, addSli, setParam and update are the actions it calls.
 */
export function renderBuildSheet(container, model, host = appHost) {
  container.innerHTML = buildSheetHtml(model);
  wireBuildSheet(container, model, host);
}

/** The sheet's handlers: close (button, scrim, Esc), compose, the switches, the rolodex, the params. */
export function wireBuildSheet(container, model, host = appHost) {
  const act = host.build;
  const sheet = container.querySelector('.build-sheet');
  container.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => act?.closeSheet?.()));
  sheet?.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    // Inside an edit-face or custom-form field the first Esc leaves the field (its change commits) and lands on the
    // card's Customise / Done button; the next Esc closes the sheet. Closing on the first one threw away the sheet
    // under a PromQL textarea mid-edit (measured: the text survived only because Chrome fires change on removal).
    const t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '') && t.closest?.('.build-edit-face, .build-custom-form')) {
      const next = t.closest('.build-rolo-card')?.querySelector?.('[data-customise]') || sheet;
      t.blur?.();
      next.focus?.({ preventScroll: true });
      return;
    }
    act?.closeSheet?.();
  });
  container.querySelector('[data-compose]')?.addEventListener('click', () => act?.setStep?.('compile', { sheet: model.layerId }));
  container.querySelectorAll('.build-switch[data-toggle]').forEach(sw => sw.addEventListener('click', () => {
    if (sw.disabled) return;
    act?.setToggle?.(sw.dataset.toggle, sw.getAttribute('aria-checked') !== 'true');
  }));
  const allKeys = model.rolodex?.allKeys || [];
  container.querySelectorAll('.build-switch[data-sli]').forEach(sw => sw.addEventListener('click', () => {
    if (sw.disabled) return;
    const { sli, entry, sliId, selected, entrySelected, custom } = sw.dataset;
    if (custom === '1') act?.removeCustom?.(sli);
    else if (selected === '1') act?.setSli?.(sli, false, allKeys);
    else if (entrySelected === '1') act?.setSli?.(sli, true, allKeys);
    else act?.addSli?.(entry, sliId);
  }));
  container.querySelector('.build-switch[data-rolodex-all]')?.addEventListener('click', (e) => {
    act?.update?.({ rolodexAll: e.currentTarget.dataset.rolodexAll !== '1' }, { rerender: true, reinstantiate: false });
  });
  wireRolodexCopies(container, model, act);
  wireRolodex(container);
  if (act) wireParamInputs(container, act, '.build-sheet .build-param-input');
}

/**
 * The copies' handlers: Customise opens / closes a card's edit face (UI state on the draft, a re-render, no
 * instantiation); an edit-face input commits on change (Enter on a one-line input, or leaving the field) —
 * setOverride(sli, field, value) for a library SLI, updateCustom(id, field, value) for a custom one, an
 * empty value clearing the override; '↺ library default' → clearOverride; the '+ Custom SLI' form keeps
 * its draft on the draft as typed (no re-render under the caret; the type select re-renders since it
 * changes the fields; the id follows the name until the user edits it), and 'Add to the pack' →
 * addCustom(def) with the definition the engine takes.
 */
export function wireRolodexCopies(container, model, act) {
  if (!act) return;
  const open = Object.fromEntries((model.rolodex?.items || []).filter(i => i.open).map(i => [i.key, true]));
  // Customise opens the face and lands the focus in its first field (the face renders above the footer the
  // button sits in, so Tab from the button walked past every field to the card's switch — measured); Done keeps
  // the focus on the button.
  container.querySelectorAll('[data-customise]').forEach(btn => btn.addEventListener('click', () => {
    const key = btn.dataset.customise;
    const next = { ...open };
    const opening = !next[key];
    if (opening) next[key] = true; else delete next[key];
    const item = (model.rolodex?.items || []).find(i => i.key === key);
    act.update?.({ customOpen: next }, { rerender: true, reinstantiate: false, ...(opening ? { focus: `${item?.custom ? 'cu' : 'ov'}:${key}:objective` } : {}) });
  }));
  // A field commits on change. When the change comes from leaving the field (Tab, a click elsewhere, Enter's
  // explicit blur) the commit is deferred one task so the browser finishes moving the focus first: the re-render
  // then restores whatever is focused by then (Tab's target), and when nothing is — Enter, a click on blank space —
  // the action lands the focus back on the field by its key. Committing inside the change dropped the focus to
  // <body> and destroyed Tab's pending target (measured live: the next Tab landed on the toolbar).
  const commit = (inp) => {
    const { sli } = inp.dataset;
    const value = inp.value;
    const doc = typeof document !== 'undefined' ? document : null;
    const run = () => {
      const lost = !!doc && (!doc.activeElement || doc.activeElement === doc.body);
      const opts = { focusKey: lost ? inp.dataset.focusKey || null : null };
      if (inp.dataset.overrideField) act.setOverride?.(sli, inp.dataset.overrideField, value, opts);
      else if (inp.dataset.customField) act.updateCustom?.(sli, inp.dataset.customField, value, opts);
    };
    if (doc && doc.activeElement !== inp) setTimeout(run, 0); else run();
  };
  container.querySelectorAll('.build-edit-face:not(.build-custom-form) .build-edit-input').forEach(inp => {
    if (inp.readOnly) return;
    inp.addEventListener('change', () => commit(inp));
    if (inp.tagName !== 'TEXTAREA') inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  });
  container.querySelectorAll('[data-reset]').forEach(btn => btn.addEventListener('click', () => act.clearOverride?.(btn.dataset.sli, btn.dataset.reset)));
  // The custom form.
  const form = container.querySelector('[data-custom-form-fields]');
  if (form) {
    // One live draft per wiring: every handler starts from what was typed so far (`cur`, with the fields' current
    // values laid over it), never from the render-time draft — the inputs write the draft to the state without a
    // re-render, so a handler that re-read the stale render-time draft started again with idTouched=false,
    // re-slugged a typed id from the name on the next keystroke and Add sent the slug (measured live:
    // 'my_checkout_id' typed, 'checkout_success' sent and drawn).
    let cur = normalizeDraft(model.rolodex?.customForm?.draft);
    const fieldEls = () => [...(form.querySelectorAll?.('[data-custom-draft]') || [])];
    const read = () => {
      const d = { ...cur };
      for (const el of fieldEls()) d[el.dataset.customDraft] = el.value;
      return d;
    };
    fieldEls().forEach(el => {
      const field = el.dataset.customDraft;
      el.addEventListener('input', () => {
        cur = read();
        if (field === 'id') cur.idTouched = String(el.value).trim() !== '';
        if (!cur.idTouched) {
          cur.id = slugifySliId(cur.name);
          const idEl = fieldEls().find(x => x.dataset.customDraft === 'id');
          if (idEl && idEl !== el) idEl.value = cur.id;
        }
        act.update?.({ customDraft: cur, customDraftErrors: null }, { rerender: false, reinstantiate: false });
        const add = container.querySelector('[data-add-custom]');
        if (add) add.disabled = !customFormCanSubmit(cur, model);
      });
      if (field === 'type') el.addEventListener('change', () => { cur = read(); act.update?.({ customDraft: cur }, { rerender: true, reinstantiate: false }); });
    });
    form.addEventListener?.('submit', (e) => { e.preventDefault(); });
    container.querySelector('[data-add-custom]')?.addEventListener('click', () => {
      cur = read();
      act.addCustom?.(customDefFromDraft(cur), cur);
    });
  }
}

/** Whether the form as typed can be sent: the required fields of its type filled and an id that is not already an SLI of the pack. */
function customFormCanSubmit(d, model) {
  const required = ['objective', 'window', ...(d.type === 'threshold' ? ['query', 'threshold'] : ['good', 'total'])];
  const id = d.idTouched ? d.id : slugifySliId(d.name);
  const existing = (model.rolodex?.items || []).filter(i => i.selected).map(i => i.key);
  return !!id && required.every(k => String(d[k] ?? '').trim() !== '') && !existing.includes(id);
}

/** The rolodex's motion: the buttons and the arrow keys move one card; the card nearest the centre is the current one. */
export function wireRolodex(container) {
  const track = container.querySelector('.build-rolodex-track');
  if (!track) return;
  const cards = () => [...(track.querySelectorAll?.('.build-rolo-card') || [])];
  const counter = container.querySelector('.build-rolodex-counter');
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const step = () => { const c = cards()[0]; return c ? c.offsetWidth + 12 : 320; };
  const mark = () => {
    const list = cards();
    if (!list.length || typeof track.scrollLeft !== 'number') return;
    const mid = track.scrollLeft + track.clientWidth / 2;
    let best = null, bestD = Infinity;
    list.forEach(c => { const d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid); if (d < bestD) { bestD = d; best = c; } });
    list.forEach(c => { c.classList.toggle('is-current', c === best); if (c === best) c.setAttribute('aria-current', 'true'); else c.removeAttribute('aria-current'); });
    if (counter && best) counter.textContent = `${list.indexOf(best) + 1} / ${list.length}`;
  };
  // Some embedded Chromium builds cancel every smooth scroll on a snap track (measured in the
  // desktop app's browser pane: the arrow keys, the buttons and scrollBy all ended at 0 while
  // an instant scroll worked; host Chrome moves fine). If nothing has moved shortly after a
  // smooth scroll, set the offset instantly and let the snap settle.
  const scrollTo = (left) => {
    const before = track.scrollLeft;
    if (left === before) return;
    track.scrollTo?.({ left, behavior: reduced ? 'auto' : 'smooth' });
    if (reduced) return;
    setTimeout(() => {
      if (track.scrollLeft !== before) return;
      const prev = track.style?.scrollBehavior;
      if (track.style) track.style.scrollBehavior = 'auto';
      track.scrollLeft = left;
      if (track.style) track.style.scrollBehavior = prev || '';
    }, SMOOTH_SCROLL_GRACE_MS);
  };
  const move = (dir) => scrollTo(Math.max(0, (track.scrollLeft || 0) + dir * step()));
  container.querySelectorAll('.build-rolodex-nav').forEach(b => b.addEventListener('click', () => move(Number(b.dataset.nav) || 1)));
  track.addEventListener('keydown', (e) => {
    if (e.target !== track) return;   // a switch inside the track keeps its own keys
    if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); scrollTo(0); }
    else if (e.key === 'End') { e.preventDefault(); scrollTo(track.scrollWidth); }
  });
  let raf = 0;
  track.addEventListener('scroll', () => { if (raf) return; raf = (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16))(() => { raf = 0; mark(); }); }, { passive: true });
  mark();
}
