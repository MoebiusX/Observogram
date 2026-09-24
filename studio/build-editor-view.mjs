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
// chips), a compact two-column grid of fields — Id · Description, Objective ·
// Window, Bound · Unit for a threshold SLI, Metric · Type (fixed: a different
// shape is a new custom SLI), then the PromQL as monospace textareas that
// grow, showing the RESOLVED expression (the parameters in, read from the
// instantiated pack) with the parameters line under it — the evidence line,
// a status line that says what happened ('applying…' → 'applied · SLO …', or
// the engine's error, which also sits under its field), per-field '↺ library
// default', Reset all, Done and the SLI's add / remove switch in the footer.
// Create mode is the same dialog over the custom form (Name → id, Type, …,
// 'Add to the pack' from the model's canSubmit). On VERIFY it is read-only:
// the values as spans, the provenance, no input.
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
import { editFieldHtml, evidenceBadge, switchHtml } from './build-atoms.mjs';
import { checkEditorId, customFormModel, customDefFromDraft, normalizeDraft, slugifySliId, SLO_WINDOWS } from './build-copies-model.mjs';

const attr = (s) => String(s).replace(/["\\]/g, '\\$&');
/** How tall a PromQL textarea may grow before it scrolls inside (about eight lines of 12 px mono). */
export const PROMQL_MAX_HEIGHT = 168;
/** The fields that span the grid: one PromQL expression; good and total sit side by side. */
const WIDE = new Set(['query']);
/** The focus keys of the dialog's own controls: they survive a re-render like a field's (build-model.mjs focusFallbackSelectors knows them). */
export const EDITOR_CONTROL_KEYS = { close: 'editor:close', done: 'editor:done', cancel: 'editor:cancel', resetAll: 'editor:reset-all' };

function chipHtml(c) {
  return `<span class="build-rolo-chip is-${escapeHtml(c.kind)}"${c.title ? ` title="${escapeHtml(c.title)}"` : ''}>${escapeHtml(c.text)}</span>`;
}

function fieldCellHtml(f, model) {
  const dataAttr = model.create ? 'custom-draft' : model.custom ? 'custom-field' : 'override-field';
  return `<div class="build-editor-cell is-${escapeHtml(f.id)}${WIDE.has(f.id) ? ' is-wide' : ''}">${editFieldHtml(f, { dataAttr, sli: model.create ? null : model.key, rows: 2, readOnly: !!model.readOnly })}</div>`;
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
        <button type="button" class="build-editor-close" data-editor-close aria-label="Close the editor (Esc)" title="Close (Esc)" data-focus-key="${EDITOR_CONTROL_KEYS.close}"><span aria-hidden="true">esc</span></button>`;
}

/** The body's inner HTML: the general error, the grid, the parameters and evidence lines, the PromQL warning, the window datalist. */
function bodyHtml(model) {
  const cells = [];
  for (const f of model.fields) {
    cells.push(fieldCellHtml(f, model));
    if (f.id === 'semconv_metric' && !model.create) cells.push(typeCellHtml(model));
  }
  return `
        ${model.generalError ? `<div class="build-edit-error build-editor-general" role="alert">${escapeHtml(model.generalError)}</div>` : ''}
        <div class="build-editor-grid">${cells.join('')}</div>
        ${model.parameters ? `<p class="build-editor-params">${escapeHtml(model.parameters.text)}</p>` : ''}
        <div class="build-editor-evidence">${evidenceBadge(model.evidence.status)}<span class="build-edit-evidence-note">${escapeHtml(model.evidence.note)}</span>${model.readOnly ? `<span class="build-editor-provenance">${escapeHtml(model.provenance)}</span>` : ''}</div>
        ${model.promqlWarning ? `<div class="build-edit-error build-edit-promql" role="alert">${escapeHtml(model.promqlWarning)}</div>` : ''}
        <datalist id="build-window-options">${SLO_WINDOWS.map(w => `<option value="${escapeHtml(w)}"></option>`).join('')}</datalist>`;
}

/** The footer's actions: the switch, then Reset all + Done (edit), Close (read-only) or Cancel + Add to the pack (create). */
function actionsHtml(model) {
  const footActions = model.create
    ? `<button type="button" class="ctrl-btn build-editor-cancel" data-editor-close data-focus-key="${EDITOR_CONTROL_KEYS.cancel}">${escapeHtml(model.doneLabel)}</button><button type="button" class="mcp-refresh-btn build-editor-submit" data-editor-submit data-focus-key="${escapeHtml(model.submit.focusKey)}"${model.submit.enabled ? '' : ' disabled'}>${escapeHtml(model.submit.label)} <span aria-hidden="true">→</span></button>`
    : `${model.resetAll ? `<button type="button" class="ctrl-btn build-editor-reset-all" data-editor-reset-all data-focus-key="${EDITOR_CONTROL_KEYS.resetAll}" title="every field back to the library default"><span aria-hidden="true">↺</span> Reset all</button>` : ''}<button type="button" class="mcp-refresh-btn build-editor-done" data-editor-done data-editor-close data-focus-key="${EDITOR_CONTROL_KEYS.done}">${escapeHtml(model.doneLabel)}</button>`;
  return `
          ${model.switch ? `<span class="build-editor-switch"><span class="build-editor-switch-text">${model.switch.on ? 'in the pack' : 'not in the pack'}</span>${switchHtml({ on: model.switch.on, label: model.switch.label, focusKey: model.switch.focusKey, data: model.switch.data })}</span>` : ''}
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
  head.innerHTML = headHtml(model);
  body.innerHTML = bodyHtml(model);
  actions.innerHTML = actionsHtml(model);
  paintStatus(status, model.status.text, model.status.kind);
  return true;
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
  if (focus) {
    // Read-only (Verify) has no field to land on: the dialog itself takes the focus, so its title is read.
    target = focus === 'dialog' || model.readOnly ? container.querySelector('.build-editor')
      : byField(focus) || container.querySelector('.build-editor .build-edit-input') || container.querySelector('.build-editor');
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
  paintFieldMessage(container, 'id', check.ok ? null : check.message, f?.hint);
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
        send(check.id ?? '');   // the key itself (or nothing) clears the rename — never an override that restates the key
      });
    } else {
      const commit = () => {
        if (inp.value === last) return;   // a change after an input (Enter, blur, a datalist pick of the same text) is not a second edit
        last = inp.value;
        send(inp.value);
      };
      inp.addEventListener('input', () => { if (inp.tagName === 'TEXTAREA') growTextarea(inp); commit(); });
      inp.addEventListener('change', commit);
    }
    if (inp.tagName !== 'TEXTAREA') inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur?.(); } });
  }
  for (const btn of container.querySelectorAll('[data-reset]') || []) btn.addEventListener('click', () => act.clearOverride?.(btn.dataset.sli || model.key, btn.dataset.reset));
  container.querySelector('[data-editor-reset-all]')?.addEventListener('click', () => act.clearOverride?.(model.key, null));
  const sw = container.querySelector('.build-editor .build-switch[data-sli]');
  sw?.addEventListener('click', () => {
    if (sw.disabled) return;
    const { sli, entry, sliId, selected, entrySelected, custom } = sw.dataset;
    if (custom === '1') act.removeCustom?.(sli);
    else if (selected === '1') act.setSli?.(sli, false, model.allKeys || []);
    else if (entrySelected === '1') act.setSli?.(sli, true, model.allKeys || []);
    else act.addSli?.(entry, sliId);
  });
}

/** The create form's handlers (one live draft per wiring: every handler starts from what was typed so far, never from the render-time draft). */
function wireCreateForm(container, model, act) {
  let cur = normalizeDraft(model.form.draft);
  const fieldEls = () => [...(container.querySelectorAll('.build-editor [data-custom-draft]') || [])];
  const read = () => { const d = { ...cur }; for (const el of fieldEls()) d[el.dataset.customDraft] = el.value; return d; };
  const submit = container.querySelector('[data-editor-submit]');
  const statusEl = container.querySelector('#build-editor-status');
  const title = container.querySelector('#build-editor-title');
  // The model's rule, rebuilt on the draft as typed (no re-render under the caret): the submit button follows its
  // canSubmit, the id field shows its clash / not-a-slug / SLO-id message while typing, the title follows the id.
  const repaint = () => {
    const live = customFormModel(cur, { existingKeys: model.form.existingKeys, existingSloIds: model.form.existingSloIds });
    if (submit) submit.disabled = !live.canSubmit;
    for (const id of ['id', 'name']) { const f = live.fields.find(x => x.id === id); if (f) paintFieldMessage(container, id, f.error, f.hint); }
    if (statusEl) {
      paintStatus(statusEl, live.canSubmit ? 'ready — Add to the pack compiles once and keeps the SLI when the engine accepts it' : `fill the required fields: ${live.required.join(', ')}${live.draft.id ? '' : ' — and a name'}`, live.canSubmit ? 'ready' : 'idle');
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
  submit?.addEventListener('click', () => { cur = read(); act.addCustom?.(customDefFromDraft(cur), cur); });
}

/**
 * One field's message repainted in place (error or hint, the is-error class, the input's aria-invalid /
 * aria-describedby / aria-errormessage) — what a re-render would draw, without the re-render.
 */
export function paintFieldMessage(container, fieldId, error, hint) {
  const box = container.querySelector(`.build-editor [data-field="${attr(fieldId)}"]`);
  const msg = box?.querySelector?.('.build-edit-error, .build-edit-hint');
  const inp = box?.querySelector?.('.build-edit-input');
  if (!box || !msg || !inp) return;
  const base = inp.id || `build-editor-${fieldId}`;
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
