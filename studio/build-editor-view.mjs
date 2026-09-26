// studio/build-editor-view.mjs
//
// The pop-up SLI editor (docs/BUILD_JOURNEY.md "The editor"): editing an SLI
// and its SLO is one centered modal dialog over the page — role=dialog,
// aria-modal=true (the studio's Tab trap, util.mjs installDialogFocusTrap,
// covers the topmost such dialog and leaves the non-modal layer sheet
// underneath alone), labelled by the SLI id, a scrim over everything, Esc
// closes (a focused field is left first, so its change commits; a document
// listener closes it too when nothing inside has the focus), focus lands
// on the first field when it opens and returns to the opener when it closes
// (the controller's job: buildActions.openEditor / closeEditor), one editor
// at a time, its state on the draft (`build.editor`, never persisted). It
// replaces the in-card Customise face and the '+ Custom SLI' form card the
// L1 rolodex used to carry.
//
// A title row (the id large, the product and its evidence, the type pill, the
// chips) and, under it, one sentence in real units that follows the fields as
// they are typed ('Queue depth headroom is healthy when its ratio is at or
// below 0.8; target 99.9% of the time over 30 days.'). Then the fields in four
// groups (the 2026-09 UX review, "Build / SLI editor"): Behavior — the
// description, and for a threshold SLI the Bound with its direction (spec 1.3
// good_when, a two-segment control below · above in the same cell: the tier
// control's idiom, a radiogroup the arrow keys move) and the Unit; Objective —
// objective and window; Data source — the metric, the fixed Type (a different
// shape is a new custom SLI), the evidence line, and folded under "Advanced:
// PromQL" the expressions as monospace textareas that grow, showing the
// RESOLVED expression (the parameters in, read from the instantiated pack)
// with the parameters line; Generated outputs — the id, and folded the SLO,
// recording rule and burn alerts the pack generated. Each field carries a
// short help line; its longer explanation is behind its '?'. The relationships
// (direction, bound, unit, objective, window) are checked as typed: the
// problem beside its field and in a linked summary at the top (the GOV.UK
// pattern), the values kept as typed. The footer: a status line that says
// what happened ('applying…' → 'applied · SLO …', or the engine's error, which
// also sits under its field), "Include in this pack" (a checkbox, apart from
// saving; a custom SLI's "Remove SLI"), Reset all and Save SLI — which checks
// first and, with a problem standing, moves the focus to the summary instead
// of closing. Create mode is the same dialog over the custom form (Name → id,
// Type, …, 'Add to the pack' from the model's canSubmit). On VERIFY it is
// read-only: the values as spans, the provenance, no input.
//
// Live apply: every field but the id commits ON INPUT through the actions
// (setOverride / updateCustom with `live: true` — the debounced instantiate);
// the status reads 'applying…' only when the action reports a change. The id
// is a RENAME — the SLO, the recording rule, the boards and the burn alerts
// follow it — so it is pre-checked on input (checkEditorId: the message under
// the field and in the status while typing) and committed when the field is
// left (Enter, Tab, Esc, a click away): committing every keystroke renamed
// the SLI to each valid prefix and left it at 'error_rat' when the final
// 'error_rate' clashed (measured). An invalid id stays in the field with its
// message, never sent, and keeps it across the pack's answer.
//
// The controller re-renders the dialog in place when the pack answers.
// renderBuildEditor keeps the dialog node, the scrim and the status node (a
// polite live region: a text change in an existing node is what assistive
// technology announces; a freshly inserted one is not) when the same editor
// is already mounted — the head, the body and the footer's actions are
// redrawn — and keeps the focused control's TEXT, focus and caret across the
// render: a field by its focus key, or by its field name when the key
// changed under it (a custom SLI's keys carry its id, which a rename
// changes), the footer controls by their own keys (editor:done, editor:cancel,
// editor:reset-all, editor:close). So typing three characters quickly loses
// none and a value the engine rejects stays as typed beside its message.
//
// Renderer only (docs/UI_CONVENTIONS.md §2-3): render(container, model, host)
// with sliEditorModel's output (build-model.mjs buildEditorModel assembles
// it); host.build.* are the actions.

import { escapeHtml, TRAPPED_DIALOGS } from './util.mjs';
import { host as appHost } from './host.mjs';
import { editFieldHtml, evidenceBadge, fieldHelp, moreToggleHtml, moreTextHtml } from './build-atoms.mjs';
import { checkEditorId, customFormModel, customDefFromDraft, createFormStatus, normalizeDraft, slugifySliId, SLO_WINDOWS, sliSummarySentence, sliRelationshipChecks, CHECKED_FIELDS } from './build-copies-model.mjs';

const attr = (s) => String(s).replace(/["\\]/g, '\\$&');
/** How tall a PromQL textarea may grow before it scrolls inside (about eight lines of 12 px mono). */
export const PROMQL_MAX_HEIGHT = 168;
/** The fields that span the grid: the description and one PromQL expression; good and total sit side by side. */
const WIDE = new Set(['query', 'description']);
const fieldOf = (model, id) => model.fields.find(f => f.id === id) || null;

/**
 * The dialog's four groups (the 2026-09 UX review, "Build / SLI editor"): Behavior (what counts as good), Objective,
 * Data source, Generated outputs — the decision fields visible, the PromQL and the generated names folded under
 * Advanced. `cells` are field ids in reading order ('@type' is the fixed Type cell of an existing SLI; the direction
 * of a bound is drawn inside the Bound cell), `advanced` the fields of the group's fold. Create mode groups its form
 * the same way (Name and Type are behaviour there; the id it slugs is an output).
 */
export function editorGroups(model) {
  const has = new Set(model.fields.map(f => f.id));
  const pick = (ids) => ids.filter(id => has.has(id));
  return [
    { id: 'behavior', title: 'Behavior', note: model.type === 'threshold' ? 'what counts as good' : 'what it measures', cells: pick(['name', 'type', 'description', 'threshold', 'unit']), advanced: [] },
    { id: 'objective', title: 'Objective', note: 'how often it must be good, over which window', cells: pick(['objective', 'window']), advanced: [] },
    { id: 'source', title: 'Data source', note: 'where the numbers come from', cells: [...pick(['semconv_metric']), ...(model.create ? [] : ['@type'])], advanced: pick(['query', 'good', 'total']) },
    { id: 'outputs', title: 'Generated outputs', note: 'what the pack names after this SLI', cells: pick(['id']), advanced: [] },
  ];
}
/** The fields in the order the dialog draws them (the error summary lists them so). */
export function editorFieldOrder(model) {
  return editorGroups(model).flatMap(g => [...g.cells, ...g.advanced]).flatMap(id => (id === 'threshold' ? ['threshold', 'good_when'] : [id]))
    .map(id => fieldOf(model, id)).filter(Boolean);
}
/** The focus keys of the dialog's own controls: they survive a re-render like a field's (build-model.mjs focusFallbackSelectors knows them). */
export const EDITOR_CONTROL_KEYS = { close: 'editor:close', done: 'editor:done', cancel: 'editor:cancel', resetAll: 'editor:reset-all' };
/** The focus the controller asks for when it opens an existing SLI (app.mjs openEditor's default): the dialog's first field. */
const OPENING_FOCUS = 'first';

function chipHtml(c) {
  return `<span class="build-rolo-chip is-${escapeHtml(c.kind)}"${c.title ? ` title="${escapeHtml(c.title)}"` : ''}>${escapeHtml(c.text)}</span>`;
}

const dataAttrOf = (model) => (model.create ? 'custom-draft' : model.custom ? 'custom-field' : 'override-field');

function fieldCellHtml(f, model) {
  return `<div class="build-editor-cell is-${escapeHtml(f.id)}${WIDE.has(f.id) ? ' is-wide' : ''}">${editFieldHtml(f, { dataAttr: dataAttrOf(model), sli: model.create ? null : model.key, rows: 2, readOnly: !!model.readOnly })}</div>`;
}

/** The Bound cell: the number input and, beside it, the direction of the bound (the model's good_when field, when the type carries one). */
function boundCellHtml(f, model) {
  const dir = model.fields.find(x => x.id === 'good_when') || null;
  return `<div class="build-editor-cell is-threshold${dir ? ' has-direction' : ''}">${editFieldHtml(f, { dataAttr: dataAttrOf(model), sli: model.create ? null : model.key, rows: 2, readOnly: !!model.readOnly })}${dir ? directionHtml(dir, model) : ''}</div>`;
}

/**
 * The direction of a threshold SLI's bound (spec 1.3 good_when): a two-segment control, below · above — the tier
 * control's idiom (role=radiogroup, one role=radio per side with aria-checked, the checked one in the tab order,
 * arrow keys move, a sliding thumb driven by --dir-index), labelled 'Good when' and described by the library default
 * and the hint like any field (the same label row, '↺ library default' when overridden). The group carries the data
 * attribute the wiring reads back (override-field / custom-field / custom-draft) and `data-dir-group`, so the generic
 * input wiring passes it by; each segment carries a focus key of its own (`<field key>:<side>`), so the focus survives
 * a re-render on it. Read-only: the side as a code span.
 */
function directionHtml(f, model) {
  const id = escapeHtml(f.inputId);
  const hasDefault = !(f.default === null || f.default === undefined);
  const dflt = hasDefault ? `<span class="build-edit-default" id="${id}-default">${f.overridden ? `library <code>${escapeHtml(f.default)}</code>` : 'library default'}</span>` : '';
  const reset = f.resettable && !model.readOnly ? `<button type="button" class="build-edit-reset" data-reset="${escapeHtml(f.id)}"${model.key ? ` data-sli="${escapeHtml(model.key)}"` : ''} data-focus-key="${escapeHtml(f.focusKey)}:reset" title="${escapeHtml(`back to the library default (${f.default})`)}" aria-label="${escapeHtml(`${f.label}: back to the library default`)}"><span aria-hidden="true">↺</span> library default</button>` : '';
  const { line, more } = fieldHelp(f);
  const moreShown = !!more && !model.readOnly;
  const hintShown = !!line && !f.error;
  const describedBy = [hasDefault ? `${id}-default` : '', f.error ? `${id}-error` : hintShown ? `${id}-hint` : ''].filter(Boolean).join(' ');
  const options = f.options || ['below', 'above'];
  const control = model.readOnly
    ? `<code class="build-edit-value">${escapeHtml(f.value)}</code>`
    : `<div class="build-edit-dir" role="radiogroup" aria-labelledby="${id}-label"${describedBy ? ` aria-describedby="${describedBy}"` : ''} data-dir-group="${escapeHtml(f.id)}" data-${escapeHtml(dataAttrOf(model))}="${escapeHtml(f.id)}"${model.create ? '' : ` data-sli="${escapeHtml(model.key)}"`} style="--dir-index:${Math.max(0, options.indexOf(f.value))}"><span class="build-edit-dir-thumb" aria-hidden="true"></span>${options.map(o => `<button type="button" role="radio" class="build-edit-dir-btn" data-dir="${escapeHtml(o)}" aria-checked="${o === f.value ? 'true' : 'false'}" tabindex="${o === f.value ? '0' : '-1'}" data-focus-key="${escapeHtml(f.focusKey)}:${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('')}</div>`;
  return `
    <div class="build-edit-field build-edit-direction${f.overridden ? ' is-overridden' : ''}${f.error ? ' is-error' : ''}${model.readOnly ? ' is-read' : ''}" data-field="${escapeHtml(f.id)}">
      <div class="build-edit-label-row"><span class="build-edit-label" id="${id}-label"><span>${escapeHtml(f.label)}</span></span>${dflt}${reset}${moreShown ? moreToggleHtml(f) : ''}</div>
      ${control}
      ${f.error ? `<span class="build-edit-error" id="${id}-error" role="alert">${escapeHtml(f.error)}</span>` : hintShown ? `<span class="build-edit-hint" id="${id}-hint">${escapeHtml(line)}</span>` : ''}
      ${moreShown ? moreTextHtml(f, more) : ''}
    </div>`;
}

/** The two segments repainted for a side (aria-checked, the tab order, the thumb) — what a re-render would draw, without one. */
export function paintDirection(group, value, btns = null) {
  const list = btns || [...(group?.querySelectorAll?.('[data-dir]') || [])];
  list.forEach((b, i) => {
    const on = b.dataset?.dir === value;
    b.setAttribute?.('aria-checked', on ? 'true' : 'false');
    b.setAttribute?.('tabindex', on ? '0' : '-1');
    if (on) group?.style?.setProperty?.('--dir-index', String(i));
  });
}

/**
 * The direction control's handlers, in edit mode and in create mode alike: a click picks a segment, ArrowLeft / Up
 * and ArrowRight / Down move to the other one and pick it (a radiogroup's keyboard contract, as the tier control);
 * `commit(field, value)` is what a pick does once the segments are repainted. A pick of the side already chosen does
 * nothing.
 */
function wireDirectionGroups(container, commit) {
  for (const group of container.querySelectorAll('.build-editor .build-edit-dir[data-dir-group]') || []) {
    const field = group.dataset?.dirGroup;
    const btns = [...(group.querySelectorAll?.('[data-dir]') || [])];
    const current = () => btns.find(b => b.getAttribute?.('aria-checked') === 'true')?.dataset?.dir ?? null;
    const pick = (value) => {
      if (!value || value === current()) return;
      paintDirection(group, value, btns);
      commit(field, value, group);
    };
    btns.forEach((btn, i) => {
      btn.addEventListener('click', () => pick(btn.dataset?.dir));
      btn.addEventListener('keydown', (e) => {
        const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!delta) return;
        e.preventDefault();
        const next = btns[(i + delta + btns.length) % btns.length];
        next.focus?.();
        pick(next.dataset?.dir);
      });
    });
  }
}

/** The type as a field-shaped cell through the same atom, read-only with its hint (fixed in edit and read-only modes; create mode carries the real select among its fields). */
function typeCellHtml(model) {
  return `<div class="build-editor-cell is-type">${editFieldHtml({ id: 'type', label: 'Type', kind: 'text', value: model.type, hint: model.typeHint, inputId: 'build-editor-type', focusKey: '' }, { readOnly: true, showHint: true, dataAttr: null })}</div>`;
}

const dialogClass = (model) => `build-editor is-${escapeHtml(model.mode)}${model.custom ? ' is-custom' : ''}`;
const statusClass = (kind) => `build-editor-status is-${escapeHtml(kind)}`;

/** The header's inner HTML: the eyebrow, the title row, the esc button. */
function headHtml(model) {
  const t = model.title;
  const eyebrow = model.create ? 'L1 · Contract · a new SLI' : `L1 · Contract · ${model.readOnly ? 'as compiled' : 'edit'} · ${model.type} SLI`;
  return `
        <div class="build-editor-eyebrow">${escapeHtml(eyebrow)}</div>
        <div class="build-editor-title-row">
          <h2 class="build-editor-title" id="build-editor-title">${escapeHtml(t.id)}</h2>
          <span class="build-editor-chips">
            <span class="build-editor-product">${escapeHtml(t.product)} ${evidenceBadge(t.sliEvidence || t.evidence)}</span>
            <span class="type-pill build-rolo-type">${escapeHtml(t.type)}</span>
            ${t.chips.map(chipHtml).join('')}
          </span>
        </div>
        ${model.summary ? `<p class="build-editor-summary" id="build-editor-summary">${escapeHtml(model.summary)}</p>` : ''}
        <button type="button" class="build-editor-close" data-editor-close aria-label="Close the editor (Esc)" title="Close (Esc)" data-focus-key="${EDITOR_CONTROL_KEYS.close}"><span aria-hidden="true">esc</span></button>`;
}

/** One cell by id: '@type' the fixed Type, the bound with its direction, any other field. */
function cellHtml(id, model) {
  if (id === '@type') return typeCellHtml(model);
  const f = fieldOf(model, id);
  if (!f) return '';
  return f.id === 'threshold' ? boundCellHtml(f, model) : fieldCellHtml(f, model);
}

/**
 * The problems the dialog knows of, listed at its top and linked to their fields (the GOV.UK error summary): each
 * link moves the focus to its field (opening the fold it sits in). Always drawn — hidden while empty — so the live
 * check can fill it as the user types, and Save SLI can move the focus to it.
 */
function errorSummaryHtml(list) {
  const n = list.length;
  return `<div class="build-editor-errors" id="build-editor-errors" tabindex="-1" aria-labelledby="build-editor-errors-title"${n ? '' : ' hidden'}>${errorSummaryInner(list)}</div>`;
}
function errorSummaryInner(list) {
  const n = list.length;
  return `<p class="build-editor-errors-title" id="build-editor-errors-title">${n === 1 ? 'One value needs attention' : `${n} values need attention`}</p>`
    + `<ul class="build-editor-errors-list">${list.map(e => `<li><a href="#${escapeHtml(e.inputId)}" data-editor-jump="${escapeHtml(e.field)}">${escapeHtml(e.label)}: ${escapeHtml(e.message)}</a></li>`).join('')}</ul>`;
}
/** The error list in the dialog's reading order. */
function orderedErrors(model, list = model.errorList || []) {
  const order = editorFieldOrder(model).map(f => f.id);
  return [...list].sort((a, b) => order.indexOf(a.field) - order.indexOf(b.field));
}

/** What the pack generated from this SLI: the SLO, the recording rule, the burn alerts — folded under Advanced. */
function outputsHtml(model) {
  const o = model.outputs;
  if (!o) return '';
  const rows = o.compiled
    ? `<dl class="build-editor-outputs">
            <div><dt>SLO</dt><dd>${o.slo ? `<code>${escapeHtml(o.slo)}</code>` : 'none — SLOs are off'}</dd></div>
            <div><dt>Recording rule</dt><dd>${o.rule ? `<code>${escapeHtml(o.rule)}</code>` : 'none'}</dd></div>
            <div><dt>Burn-rate alerts</dt><dd>${o.burns}</dd></div>
          </dl>`
    : '<p class="build-editor-outputs-note">Generated once the pack compiles with this SLI in it.</p>';
  return `<details class="build-editor-advanced" data-editor-fold="outputs"><summary>Advanced: generated rule details</summary>${rows}</details>`;
}

/** One group: its title and note, its visible cells, its fold (the PromQL of the data source, the outputs' names). */
function groupHtml(g, model) {
  const cells = g.cells.map(id => cellHtml(id, model)).join('');
  let fold = '';
  if (g.id === 'source' && g.advanced.length) {
    // Folded unless it must show: the create form needs its PromQL, and an error or a PromQL warning opens it.
    const required = !!(model.create || model.promqlWarning || g.advanced.some(id => fieldOf(model, id)?.error));
    fold = `<details class="build-editor-advanced" data-editor-fold="promql"${required ? ' open data-fold-required' : ''}><summary>Advanced: PromQL${model.create ? '' : ' as it runs'}</summary>
          <div class="build-editor-grid">${g.advanced.map(id => cellHtml(id, model)).join('')}</div>
          ${model.parameters ? `<p class="build-editor-params">${escapeHtml(model.parameters.text)}</p>` : ''}
        </details>`;
  }
  const evidence = g.id === 'source'
    ? `<div class="build-editor-evidence">${evidenceBadge(model.evidence.status)}<span class="build-edit-evidence-note">${escapeHtml(model.evidence.note)}</span>${model.readOnly ? `<span class="build-editor-provenance">${escapeHtml(model.provenance)}</span>` : ''}</div>
        ${model.promqlWarning ? `<div class="build-edit-error build-edit-promql" role="alert">${escapeHtml(model.promqlWarning)}</div>` : ''}`
    : '';
  if (!cells && !fold && !evidence && !(g.id === 'outputs' && model.outputs)) return '';
  return `
        <section class="build-editor-group is-${g.id}" aria-labelledby="build-editor-g-${g.id}">
          <h3 class="build-editor-group-title" id="build-editor-g-${g.id}">${escapeHtml(g.title)} <span class="build-editor-group-note">${escapeHtml(g.note)}</span></h3>
          ${cells ? `<div class="build-editor-grid">${cells}</div>` : ''}
          ${evidence}
          ${fold}
          ${g.id === 'outputs' ? outputsHtml(model) : ''}
        </section>`;
}

/** The body's inner HTML: the error summary, the general error, the four groups, the window datalist. */
function bodyHtml(model) {
  return `
        ${errorSummaryHtml(orderedErrors(model))}
        ${model.generalError ? `<div class="build-edit-error build-editor-general" role="alert">${escapeHtml(model.generalError)}</div>` : ''}
        ${editorGroups(model).map(g => groupHtml(g, model)).join('')}
        <datalist id="build-window-options">${SLO_WINDOWS.map(w => `<option value="${escapeHtml(w)}"></option>`).join('')}</datalist>`;
}

/**
 * Inclusion, as its own named control (the review: saving and inclusion were one switch and one DONE): a library SLI
 * gets the checkbox "Include in this pack" — its help says an excluded SLI keeps its edits with the draft; a custom
 * SLI, which exists only in the pack, gets "Remove SLI". The control carries the data the wiring reads back (the
 * rolodex switch's) and its focus key, so the focus survives the re-render a toggle causes.
 */
function inclusionHtml(model) {
  const inc = model.inclusion;
  if (!inc || !model.switch) return '';
  const help = `<span class="build-editor-include-help" id="build-editor-include-help">${escapeHtml(inc.help)}</span>`;
  if (inc.kind === 'remove') {
    return `<span class="build-editor-include"><button type="button" class="ctrl-btn build-editor-remove" data-editor-remove data-sli="${escapeHtml(model.key)}" data-focus-key="${escapeHtml(model.switch.focusKey)}" aria-describedby="build-editor-include-help">${escapeHtml(inc.label)}</button>${help}</span>`;
  }
  const data = Object.entries(model.switch.data || {}).map(([k, v]) => ` data-${escapeHtml(k)}="${escapeHtml(v)}"`).join('');
  return `<span class="build-editor-include"><label class="build-editor-switch"><input type="checkbox" class="build-editor-include-box" data-editor-include${data} data-focus-key="${escapeHtml(model.switch.focusKey)}"${inc.on ? ' checked' : ''} aria-describedby="build-editor-include-help"><span class="build-editor-switch-text">${escapeHtml(inc.label)}</span></label>${help}</span>`;
}

/** The footer's actions: inclusion, then Reset all + Save SLI (edit), Close (read-only) or Cancel + Add to the pack (create). */
function actionsHtml(model) {
  let footActions;
  if (model.create) footActions = `<button type="button" class="ctrl-btn build-editor-cancel" data-editor-close data-focus-key="${EDITOR_CONTROL_KEYS.cancel}">${escapeHtml(model.doneLabel)}</button><button type="button" class="mcp-refresh-btn build-editor-submit" data-editor-submit data-focus-key="${escapeHtml(model.submit.focusKey)}"${model.submit.enabled ? '' : ' disabled'}>${escapeHtml(model.submit.label)} <span aria-hidden="true">→</span></button>`;
  else if (model.readOnly) footActions = `<button type="button" class="mcp-refresh-btn build-editor-done" data-editor-done data-editor-close data-focus-key="${EDITOR_CONTROL_KEYS.done}">${escapeHtml(model.doneLabel)}</button>`;
  else {
    // Save SLI checks the values first: with a problem standing it moves the focus to the summary at the top instead of closing.
    footActions = `${model.resetAll ? `<button type="button" class="ctrl-btn build-editor-reset-all" data-editor-reset-all data-focus-key="${EDITOR_CONTROL_KEYS.resetAll}" title="every field back to the library default"><span aria-hidden="true">↺</span> Reset all</button>` : ''}`
      + `${model.saveHelp ? `<span class="build-editor-save-help" id="build-editor-save-help">${escapeHtml(model.saveHelp)}</span>` : ''}`
      + `<button type="button" class="mcp-refresh-btn build-editor-done" data-editor-done data-editor-save data-focus-key="${EDITOR_CONTROL_KEYS.done}"${model.saveHelp ? ' aria-describedby="build-editor-save-help"' : ''}>${escapeHtml(model.doneLabel)}</button>`;
  }
  return `
          ${inclusionHtml(model)}
          ${footActions}`;
}

/** The dialog as HTML (the scrim and the panel); wireBuildEditor(container, model, host) wires it once in the DOM. */
export function buildEditorHtml(model) {
  return `
    <div class="build-editor-scrim" data-editor-close aria-hidden="true"></div>
    <div class="${dialogClass(model)}" role="dialog" aria-modal="true" aria-labelledby="build-editor-title" aria-describedby="build-editor-status" data-editor-key="${escapeHtml(model.key || '')}" data-editor-mode="${escapeHtml(model.mode)}" tabindex="-1">
      <header class="build-editor-head">${headHtml(model)}
      </header>
      <div class="build-editor-body">${bodyHtml(model)}
      </div>
      <footer class="build-editor-foot">
        <div class="${statusClass(model.status.kind)}" id="build-editor-status" role="status" aria-live="polite">${escapeHtml(model.status.text)}</div>
        <div class="build-editor-actions">${actionsHtml(model)}
        </div>
      </footer>
    </div>`;
}

/**
 * The same editor already on screen, redrawn in place: the head, the body and the footer's actions are replaced,
 * the dialog node, the scrim and the status node (the live region) stay. False when the mounted dialog has not
 * the shape (the caller then renders it whole).
 */
function patchEditor(dialog, model) {
  const head = dialog.querySelector('.build-editor-head'), body = dialog.querySelector('.build-editor-body');
  const actions = dialog.querySelector('.build-editor-actions'), status = dialog.querySelector('#build-editor-status');
  if (!head || !body || !actions || !status) return false;
  dialog.className = dialogClass(model);
  if (dialog.dataset) dialog.dataset.editorKey = model.key || '';
  // The folds and the '?' explanations the user opened stay as they were across the redraw (a keystroke's answer
  // redraws the body; closing the PromQL fold under the caret would drop the focus). A fold an error requires stays open.
  const kept = foldState(body);
  head.innerHTML = headHtml(model);
  body.innerHTML = bodyHtml(model);
  actions.innerHTML = actionsHtml(model);
  restoreFoldState(body, kept);
  paintStatus(status, model.status.text, model.status.kind);
  return true;
}

/** Which folds of the body are open and which '?' explanations are shown: what a redraw keeps. */
function foldState(root) {
  const folds = {};
  for (const d of root?.querySelectorAll?.('details[data-editor-fold]') || []) folds[d.dataset?.editorFold] = !!d.open;
  const more = [...(root?.querySelectorAll?.('[data-more][aria-expanded="true"]') || [])].map(b => b.dataset?.more).filter(Boolean);
  return { folds, more };
}
function restoreFoldState(root, { folds, more }) {
  for (const d of root?.querySelectorAll?.('details[data-editor-fold]') || []) {
    const was = folds[d.dataset?.editorFold];
    if (was === true) d.open = true;
    else if (was === false && !d.hasAttribute?.('data-fold-required')) d.open = false;
  }
  for (const id of more) { const b = root?.querySelector?.(`[data-more="${attr(id)}"]`); if (b) setMore(root, b, true); }
}
/** A field's '?' opened or closed: the button's aria-expanded, the explanation's hidden. */
function setMore(root, btn, open) {
  btn.setAttribute?.('aria-expanded', open ? 'true' : 'false');
  const p = root?.querySelector?.(`#${btn.dataset?.more}-more`);
  if (p) p.hidden = !open;
}

/** A PromQL textarea sized to its text, up to PROMQL_MAX_HEIGHT (then it scrolls inside). */
export function growTextarea(ta) {
  if (!ta || !ta.style) return;
  ta.style.height = 'auto';
  const h = Number(ta.scrollHeight) || 0;
  if (h) ta.style.height = `${Math.min(h, PROMQL_MAX_HEIGHT)}px`;
  ta.style.overflowY = h > PROMQL_MAX_HEIGHT ? 'auto' : 'hidden';
}

function paintStatus(el, text, kind) {
  if (!el) return;
  if (el.textContent !== text) el.textContent = text;   // an unchanged text is not a new announcement
  el.className = statusClass(kind);
}
/** The status line said in place (the live region keeps its node): what happened to the last edit. */
export function sayStatus(container, text, kind) {
  paintStatus(container.querySelector('#build-editor-status'), text, kind);
}

/**
 * What the focused control of this editor is, before a re-render replaces it: its focus key, its field name (an
 * input's data-override-field / data-custom-field / data-custom-draft — the stable handle when the key changes
 * under it), its text and its caret. Null when nothing of the editor has the focus.
 */
function keptFocus(container, doc) {
  const active = doc?.activeElement || null;
  if (!active || active === doc.body || typeof container.contains !== 'function' || !container.contains(active)) return null;
  const ds = active.dataset || {};
  const key = ds.focusKey || null;
  const field = ds.overrideField || ds.customField || ds.customDraft || null;
  if (!key && !field) return null;
  return { key, field, value: 'value' in active ? active.value : null, sel: typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null };
}

/**
 * render(container, model, host, { focus }) — the editor into its persistent host (the controller keeps one outside
 * the re-rendered view). `focus` names the field to land on (a field id, or 'dialog'): the render that opens the
 * editor. Without it the render keeps what the user has: when the active element is a control of this editor, its
 * TEXT, focus and caret survive the re-render — the model's value is not written over what is being typed (a
 * re-render of '99.' from the stored 0.99 lost the dot; measured) — so a re-render on the pack's answer never eats
 * a keystroke, and a value the engine rejected stays as typed beside its message (an id, re-checked and its message
 * repainted). The same editor already mounted (the key and the mode, or a custom SLI just renamed under the
 * focused field) is redrawn in place — the dialog node, the scrim and the status live region stay.
 */
export function renderBuildEditor(container, model, host = appHost, { focus = null } = {}) {
  const doc = typeof document !== 'undefined' ? document : null;
  const keep = keptFocus(container, doc);
  const mounted = container.querySelector?.('.build-editor') || null;
  const prevKey = mounted?.dataset?.editorKey ?? null;
  const key = model.key || '';
  // A custom SLI's editor is keyed by its id, which a rename changes under the focused field (cu:<old id>:<field> →
  // cu:<new id>:<field>): the dialog is the same one, and the kept key is re-keyed before the lookup.
  const renamed = !!(model.custom && !model.create && prevKey && prevKey !== key && keep?.key?.startsWith(`cu:${prevKey}:`));
  let same = !!mounted && typeof mounted.querySelector === 'function' && mounted.dataset?.editorMode === model.mode && (prevKey === key || renamed);
  if (same && !patchEditor(mounted, model)) same = false;
  if (!same) container.innerHTML = buildEditorHtml(model);
  wireBuildEditor(container, model, host, { shell: !same });
  for (const ta of container.querySelectorAll('textarea.build-edit-input') || []) growTextarea(ta);
  const byKey = (k) => container.querySelector(`[data-focus-key="${attr(k)}"]`);
  const byField = (f) => container.querySelector(`.build-editor [data-field="${attr(f)}"] .build-edit-input`);
  let target = null, kept = false;
  const firstField = () => container.querySelector('.build-editor .build-edit-input');
  if (focus) {
    // Read-only (Verify) has no field to land on: the dialog itself takes the focus, so its title is read. The
    // controller opens an existing SLI on 'first' — the dialog's first field (the id is a generated output, last).
    const opening = focus === OPENING_FOCUS;
    target = focus === 'dialog' || model.readOnly ? container.querySelector('.build-editor')
      : (opening ? firstField() || byField(focus) : byField(focus)) || firstField() || container.querySelector('.build-editor');
  } else if (keep) {
    const k = renamed ? `cu:${key}:${keep.key.slice(prevKey.length + 4)}` : keep.key;
    // The same editor: a control by its key, else a field by its name (its key changed under it); another editor:
    // nothing to keep — the controller lands the focus.
    target = (k && byKey(k)) || (keep.field && (renamed || prevKey === key || !prevKey) ? byField(keep.field) : null);
    kept = !!target;
  }
  if (!target) return;
  if (kept && keep.value != null && 'value' in target && target.value !== keep.value) {
    target.value = keep.value;
    if (target.tagName === 'TEXTAREA') growTextarea(target);
    // A typed id the model does not carry (not committed, or refused): its message and the status say so again.
    if (keep.field === 'id' && !model.readOnly && !model.create) paintIdState(container, model, keep.value);
  }
  target.focus?.({ preventScroll: true });
  if (typeof target.setSelectionRange !== 'function') return;
  try {
    if (kept && keep.sel) target.setSelectionRange(keep.sel[0], keep.sel[1]);
    else if (focus && focus !== 'dialog' && typeof target.value === 'string') target.setSelectionRange(target.value.length, target.value.length);   // the caret at the end: typing appends
  } catch { /* not a text input */ }
}

/**
 * The id field's message and the status for the text as typed, before the engine is asked (checkEditorId): a
 * refused id under the field and 'not applied — …'; a valid rename 'rename to <id> — Enter, Tab or Esc applies
 * it'; the id the pack carries → the status the model says. Returns the check (the change handler commits on it).
 */
export function paintIdState(container, model, text) {
  const check = checkEditorId(text, { key: model.key, existingIds: model.existingIds });
  const f = model.fields.find(x => x.id === 'id');
  paintFieldMessage(container, 'id', check.ok ? null : check.message, fieldHelp(f).line);
  const current = f ? String(f.value) : String(model.id ?? model.key);
  const next = check.id ?? model.key;
  if (!check.ok) sayStatus(container, `not applied — ${check.message}`, 'error');
  else if (next !== current) sayStatus(container, `rename to ${next} — Enter, Tab or Esc applies it`, 'pending');
  else sayStatus(container, model.status.text, model.status.kind);
  return check;
}

// One document listener per editor host (bound once, never removed: it does nothing while no dialog is mounted):
// Esc closes the editor when nothing inside it has the focus — a re-render once dropped the focus to <body> and
// Esc then did nothing (measured). The dialog's own handler takes an Esc from inside (and stops it here).
const DOC_ESC = new WeakMap();
function bindDocumentEscape(container, host) {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  const bound = DOC_ESC.has(container);
  DOC_ESC.set(container, host);
  if (bound) return;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const dialog = container.querySelector('.build-editor');
    if (!dialog || (e.target && dialog.contains?.(e.target))) return;
    const open = document.querySelectorAll(TRAPPED_DIALOGS);
    if (open.length && open[open.length - 1] !== dialog) return;   // another modal is on top: its Esc
    e.preventDefault();
    DOC_ESC.get(container)?.build?.closeEditor?.();
  });
}

/**
 * The editor's handlers: close (the scrim, the esc button, Done / Cancel, Esc — a focused field is left first so its
 * change commits), a field's live commit on input (setOverride / updateCustom, `live: true`; 'applying…' only when
 * the action reports a change), the id pre-checked on input and committed on change, Enter on a one-line input
 * leaving it, '↺ library default' → clearOverride(key, field), Reset all → clearOverride(key), the footer switch
 * (setSli / addSli / removeCustom, as the rolodex's), the create form (the draft kept on the state as typed, the id
 * following the name until typed, the id / name messages and the submit button repainted from the model, the type
 * re-rendering the fields, Add → addCustom). `shell: false` re-wires the redrawn parts of a mounted dialog only
 * (the scrim, the dialog's keydown and the document listener stay bound).
 */
export function wireBuildEditor(container, model, host = appHost, { shell = true } = {}) {
  const act = host.build;
  const dialog = container.querySelector('.build-editor');
  if (!act || !dialog) return;
  if (shell) {
    container.querySelector('.build-editor-scrim')?.addEventListener('click', () => act.closeEditor?.());
    dialog.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      const t = e.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')) t.blur?.();
      act.closeEditor?.();
    });
    bindDocumentEscape(container, host);
  }
  for (const el of container.querySelectorAll('.build-editor [data-editor-close]') || []) el.addEventListener('click', () => act.closeEditor?.());
  if (model.readOnly) return;
  wireHelpAndErrors(container);
  if (model.create) { wireCreateForm(container, model, act); return; }
  const say = (text, kind) => sayStatus(container, text, kind);
  for (const inp of container.querySelectorAll('.build-editor .build-edit-input') || []) {
    const field = inp.dataset?.overrideField || inp.dataset?.customField;
    if (!field) continue;
    let last = inp.value;
    const send = (text) => {
      const changed = inp.dataset.overrideField ? act.setOverride?.(model.key, field, text, { live: true }) : act.updateCustom?.(model.key, field, text, { live: true });
      // Nothing changed (the text means the committed value): the status stays the model's, never 'applying…' for nothing.
      if (changed === false) say(model.status.text, model.status.kind); else say('applying…', 'pending');
    };
    if (field === 'id') {
      // A rename commits when the field is left, never per keystroke (header comment); the pre-check paints while typing.
      inp.addEventListener('input', () => paintIdState(container, model, inp.value));
      inp.addEventListener('change', () => {
        if (inp.value === last) return;
        const check = paintIdState(container, model, inp.value);
        if (!check.ok) return;
        last = inp.value;
        if (check.id === null && model.custom) { say(model.status.text, model.status.kind); return; }   // a custom SLI's id as it is: nothing to rename
        // The commit waits for the browser's own focus move (Tab, a click away): the render it causes redraws the
        // field, and a Tab computed from a field that was gone landed the focus nowhere (measured). A field left by
        // Enter (blur) has <body> active meanwhile: the fresh field gets the focus back.
        const focusKey = inp.dataset.focusKey;
        setTimeout(() => {
          send(check.id ?? '');   // the key itself (or nothing) clears the rename — never an override that restates the key
          if (typeof document === 'undefined' || (document.activeElement && document.activeElement !== document.body)) return;
          container.querySelector(`[data-focus-key="${attr(focusKey)}"]`)?.focus?.({ preventScroll: true });
        }, 0);
      });
    } else {
      const commit = () => {
        if (inp.value === last) return;   // a change after an input (Enter, blur, a datalist pick of the same text) is not a second edit
        last = inp.value;
        send(inp.value);
        // The sentence at the top and the relationship checks follow the text as typed, before the engine answers.
        liveCheck(container, model, { [field]: inp.value });
      };
      inp.addEventListener('input', () => { if (inp.tagName === 'TEXTAREA') growTextarea(inp); commit(); });
      inp.addEventListener('change', commit);
    }
    if (inp.tagName !== 'TEXTAREA') inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur?.(); } });
  }
  // The direction control commits like a field (setOverride / updateCustom, live) — except that picking the library's
  // own side on a library SLI clears the override, as ↺ would: the library's direction is no customisation.
  wireDirectionGroups(container, (field, value, group) => {
    const f = model.fields.find(x => x.id === field);
    liveCheck(container, model, { [field]: value });
    if (group.dataset?.customField) {
      const changed = act.updateCustom?.(model.key, field, value, { live: true });
      if (changed === false) say(model.status.text, model.status.kind); else say('applying…', 'pending');
      return;
    }
    if (f && f.default !== null && f.default !== undefined && value === f.default) { act.clearOverride?.(model.key, field); return; }
    const changed = act.setOverride?.(model.key, field, value, { live: true });
    if (changed === false) say(model.status.text, model.status.kind); else say('applying…', 'pending');
  });
  for (const btn of container.querySelectorAll('[data-reset]') || []) btn.addEventListener('click', () => act.clearOverride?.(btn.dataset.sli || model.key, btn.dataset.reset));
  container.querySelector('[data-editor-reset-all]')?.addEventListener('click', () => act.clearOverride?.(model.key, null));
  // Inclusion: the checkbox ticks a library SLI in or out of the pack (an SLI of a product not selected yet selects the
  // product too); a custom SLI's Remove deletes it. Neither closes the editor — saving is Save SLI's.
  const inc = container.querySelector('.build-editor [data-editor-include]');
  inc?.addEventListener('change', () => {
    const { sli, entry, sliId, selected, entrySelected } = inc.dataset;
    if (selected === '1') act.setSli?.(sli, false, model.allKeys || []);
    else if (entrySelected === '1') act.setSli?.(sli, true, model.allKeys || []);
    else act.addSli?.(entry, sliId);
  });
  const rm = container.querySelector('.build-editor [data-editor-remove]');
  rm?.addEventListener('click', () => act.removeCustom?.(rm.dataset?.sli || model.key));
  // Save SLI: the edits are already applied as typed, so saving is a check and a close — with a problem standing (the
  // live checks, or the engine's word on a field) the focus moves to the linked summary at the top instead.
  container.querySelector('.build-editor [data-editor-save]')?.addEventListener('click', () => {
    const list = liveCheck(container, model) ?? orderedErrors(model);
    if (list.length) {
      const box = container.querySelector('#build-editor-errors');
      if (box) { box.hidden = false; box.focus?.(); }
      say(`not closed — ${list.length === 1 ? 'one value needs' : `${list.length} values need`} attention, listed at the top`, 'error');
      return;
    }
    act.closeEditor?.();
  });
}

/** The fields' '?' explanations and the error summary's links (both modes that take input). */
function wireHelpAndErrors(container) {
  for (const btn of container.querySelectorAll('.build-editor [data-more]') || []) {
    btn.addEventListener('click', () => setMore(container, btn, btn.getAttribute?.('aria-expanded') !== 'true'));
  }
  container.querySelector('#build-editor-errors')?.addEventListener('click', (e) => {
    const a = e.target?.closest?.('[data-editor-jump]');
    if (!a) return;
    e.preventDefault();   // a plain #hash would also move the studio's router
    jumpToField(container, a.dataset.editorJump);
  });
}

/** An error summary link followed: the fold the field sits in opens, the field takes the focus (a direction: its chosen side). */
export function jumpToField(container, fieldId) {
  const box = container.querySelector(`.build-editor [data-field="${attr(fieldId)}"]`);
  if (!box) return false;
  const fold = box.closest?.('details');
  if (fold && !fold.open) fold.open = true;
  const target = box.querySelector?.('.build-edit-input') || box.querySelector?.('[data-dir][aria-checked="true"]');
  target?.focus?.();
  target?.scrollIntoView?.({ block: 'center' });
  return !!target;
}

/** A field's value as it stands in the dialog: the text being typed (`typed`), the input's, the chosen side, else the model's. */
function valueNow(container, model, fid, typed) {
  if (typed && Object.prototype.hasOwnProperty.call(typed, fid)) return typed[fid];
  if (fid === 'good_when') {
    const side = container.querySelector?.('.build-editor [data-field="good_when"] [data-dir][aria-checked="true"]');
    if (side?.dataset?.dir) return side.dataset.dir;
  } else {
    const inp = container.querySelector?.(`.build-editor [data-field="${attr(fid)}"] .build-edit-input`);
    if (inp && typeof inp.value === 'string') return inp.value;
  }
  return fieldOf(model, fid)?.value ?? null;
}

/**
 * The live check of an existing SLI's editor: the relationships (sliRelationshipChecks) re-run on the values as they
 * stand — a field left empty reads its library default — each relationship field's message repainted in place (its
 * check, else the engine's word while the value is the one the engine answered, else its help line), the error summary
 * refilled and the opening sentence rewritten. Nothing is sent and nothing re-rendered. Returns the problems in reading
 * order (Save SLI reads them), or null read-only.
 */
export function liveCheck(container, model, typed = {}) {
  if (model.readOnly || model.create) return null;
  const values = {};
  for (const fid of CHECKED_FIELDS) {
    const f = fieldOf(model, fid);
    if (!f) continue;
    let v = valueNow(container, model, fid, typed);
    if (String(v ?? '').trim() === '' && f.default != null) v = f.default;   // empty is the library default in the editor
    values[fid] = v;
  }
  const checks = sliRelationshipChecks({ type: model.type, ...values });
  const list = [];
  for (const f of editorFieldOrder(model)) {
    let err = f.error;
    if (f.id === 'id') {
      // The id is pre-checked as typed (paintIdState paints it); a refused one is a problem Save SLI must not close over.
      const typedId = String(valueNow(container, model, 'id', typed) ?? '');
      const c = checkEditorId(typedId, { key: model.key, existingIds: model.existingIds });
      err = c.ok ? (typedId.trim() === String(f.value ?? '') || typedId.trim() === '' ? f.engineError : null) : c.message;
    } else if (CHECKED_FIELDS.includes(f.id)) {
      const unchanged = String(values[f.id] ?? '') === String(f.value ?? '');
      err = checks[f.id] || (unchanged ? f.engineError : null) || null;
      paintFieldMessage(container, f.id, err, fieldHelp(f).line);
    }
    if (err) list.push({ field: f.id, label: f.label, message: err, inputId: f.inputId });
  }
  paintErrorSummary(container, list);
  const id = String(valueNow(container, model, 'id', typed) ?? '').trim() || model.id;
  paintSummary(container, sliSummarySentence({ id, type: model.type, ...values }));
  return list;
}

/** The error summary refilled in place (hidden while empty). */
function paintErrorSummary(container, list) {
  const box = container.querySelector?.('#build-editor-errors');
  if (!box) return;
  box.innerHTML = errorSummaryInner(list);
  box.hidden = list.length === 0;
}
/** The opening sentence rewritten in place. */
function paintSummary(container, text) {
  const el = container.querySelector?.('#build-editor-summary');
  if (el && el.textContent !== text) el.textContent = text;
}

/** The create form's handlers (one live draft per wiring: every handler starts from what was typed so far, never from the render-time draft). */
function wireCreateForm(container, model, act) {
  let cur = normalizeDraft(model.form.draft);
  // The inputs of the form (the direction control is a group with no value to read back: it writes the draft itself, below).
  const fieldEls = () => [...(container.querySelectorAll('.build-editor [data-custom-draft]') || [])].filter(el => !el.dataset?.dirGroup);
  const read = () => { const d = { ...cur }; for (const el of fieldEls()) d[el.dataset.customDraft] = el.value; return d; };
  const submit = container.querySelector('[data-editor-submit]');
  const statusEl = container.querySelector('#build-editor-status');
  const title = container.querySelector('#build-editor-title');
  // The model's rule, rebuilt on the draft as typed (no re-render under the caret): the submit button follows its
  // canSubmit, the id field shows its clash / not-a-slug / SLO-id message while typing, the title follows the id.
  const repaint = () => {
    const live = customFormModel(cur, { existingKeys: model.form.existingKeys, existingSloIds: model.form.existingSloIds });
    if (submit) submit.disabled = !live.canSubmit;
    for (const id of ['id', 'name', ...CHECKED_FIELDS]) { const f = live.fields.find(x => x.id === id); if (f) paintFieldMessage(container, id, f.error, fieldHelp(f).line); }
    // The relationships and the sentence follow the form as typed, like the edit mode's live check.
    const shape = { create: true, type: live.draft.type, fields: live.fields };
    paintErrorSummary(container, orderedErrors(shape, live.fields.filter(f => f.error).map(f => ({ field: f.id, label: f.label, message: f.error, inputId: f.inputId }))));
    paintSummary(container, live.summary);
    if (statusEl) {
      const st = createFormStatus(live);
      paintStatus(statusEl, st.text, st.kind);
    }
    if (title) title.textContent = live.draft.id || 'new SLI';
  };
  for (const el of fieldEls()) {
    const field = el.dataset.customDraft;
    el.addEventListener('input', () => {
      if (el.tagName === 'TEXTAREA') growTextarea(el);
      cur = read();
      if (field === 'id') cur.idTouched = String(el.value).trim() !== '';
      if (!cur.idTouched) {
        cur.id = slugifySliId(cur.name);
        const idEl = fieldEls().find(x => x.dataset.customDraft === 'id');
        if (idEl && idEl !== el) idEl.value = cur.id;
      }
      act.update?.({ customDraft: cur, customDraftErrors: null }, { rerender: false, reinstantiate: false });
      repaint();
    });
    if (field === 'type') el.addEventListener('change', () => { cur = read(); act.update?.({ customDraft: cur }, { rerender: true, reinstantiate: false }); });
    if (el.tagName === 'INPUT') el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (submit && !submit.disabled) submit.click?.(); } });
  }
  // The direction of a threshold SLI's bound: a pick lands in the draft as typed (no re-render), the model repainted.
  wireDirectionGroups(container, (field, value) => {
    cur = { ...read(), [field]: value };
    act.update?.({ customDraft: cur, customDraftErrors: null }, { rerender: false, reinstantiate: false });
    repaint();
  });
  submit?.addEventListener('click', () => { cur = read(); act.addCustom?.(customDefFromDraft(cur), cur); });
}

/**
 * One field's message repainted in place (error or hint, the is-error class, the input's aria-invalid /
 * aria-describedby / aria-errormessage) — what a re-render would draw, without the re-render.
 */
export function paintFieldMessage(container, fieldId, error, hint) {
  const box = container.querySelector(`.build-editor [data-field="${attr(fieldId)}"]`);
  // The control: an input, or the direction's radiogroup (which carries the same describedby / invalid attributes).
  const inp = box?.querySelector?.('.build-edit-input') || box?.querySelector?.('.build-edit-dir');
  let msg = box?.querySelector?.('.build-edit-error, .build-edit-hint');
  if (!box || !inp) return;
  if (!msg) {
    // A field drawn with no line under it (no hint, no error) gets one when a check has something to say.
    if (!error) return;
    msg = box.ownerDocument?.createElement?.('span');
    if (!msg) return;
    inp.insertAdjacentElement?.('afterend', msg);
  }
  const base = inp.id || String(inp.getAttribute?.('aria-labelledby') || '').replace(/-label$/, '') || `build-editor-${fieldId}`;
  const err = error || null;
  msg.className = err ? 'build-edit-error' : 'build-edit-hint';
  msg.id = `${base}-${err ? 'error' : 'hint'}`;
  if (err) msg.setAttribute('role', 'alert'); else msg.removeAttribute('role');
  msg.textContent = err || hint || '';
  box.classList?.toggle('is-error', !!err);
  if (err) { inp.setAttribute('aria-invalid', 'true'); inp.setAttribute('aria-errormessage', msg.id); } else { inp.removeAttribute('aria-invalid'); inp.removeAttribute('aria-errormessage'); }
  const described = [...(box.querySelector?.('.build-edit-default')?.id ? [box.querySelector('.build-edit-default').id] : []), msg.id];
  inp.setAttribute('aria-describedby', described.join(' '));
}
