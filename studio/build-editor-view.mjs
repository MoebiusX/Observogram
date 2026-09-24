// studio/build-editor-view.mjs
//
// The pop-up SLI editor (docs/BUILD_JOURNEY.md "The editor"): editing an SLI
// and its SLO is one centered modal dialog over the page — role=dialog,
// aria-modal=true (the studio's Tab trap, util.mjs installDialogFocusTrap,
// covers the topmost such dialog and leaves the non-modal layer sheet
// underneath alone), labelled by the SLI id, a scrim over everything, Esc
// closes (a focused field is left first, so its change commits), focus lands
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
// Live apply: every field commits ON INPUT through the actions (setOverride /
// updateCustom with `live: true` — the debounced instantiate); the controller
// re-renders the dialog in place when the pack answers, and renderBuildEditor
// keeps the focused field's text, focus and caret across that render (so
// typing three characters quickly loses none, and a value the engine rejects
// stays as typed beside its message). The id field is pre-checked
// (checkEditorId) and an invalid id is kept in the field with its message,
// never sent.
//
// Renderer only (docs/UI_CONVENTIONS.md §2-3): render(container, model, host)
// with sliEditorModel's output (build-model.mjs buildEditorModel assembles
// it); host.build.* are the actions.

import { escapeHtml } from './util.mjs';
import { host as appHost } from './host.mjs';
import { editFieldHtml, evidenceBadge, switchHtml } from './build-atoms.mjs';
import { checkEditorId, customFormModel, customDefFromDraft, normalizeDraft, slugifySliId, SLO_WINDOWS } from './build-copies-model.mjs';

const attr = (s) => String(s).replace(/["\\]/g, '\\$&');
/** How tall a PromQL textarea may grow before it scrolls inside (about eight lines of 12 px mono). */
export const PROMQL_MAX_HEIGHT = 168;
/** The fields that span the grid: one PromQL expression; good and total sit side by side. */
const WIDE = new Set(['query']);

function chipHtml(c) {
  return `<span class="build-rolo-chip is-${escapeHtml(c.kind)}"${c.title ? ` title="${escapeHtml(c.title)}"` : ''}>${escapeHtml(c.text)}</span>`;
}

function fieldCellHtml(f, model) {
  const dataAttr = model.create ? 'custom-draft' : model.custom ? 'custom-field' : 'override-field';
  return `<div class="build-editor-cell is-${escapeHtml(f.id)}${WIDE.has(f.id) ? ' is-wide' : ''}">${editFieldHtml(f, { dataAttr, sli: model.create ? null : model.key, rows: 2, readOnly: !!model.readOnly })}</div>`;
}

/** The type as a field-shaped cell: fixed in edit and read-only modes (create mode carries the real select among its fields). */
function typeCellHtml(model) {
  return `
    <div class="build-editor-cell is-type">
      <div class="build-edit-field is-read" data-field="type">
        <div class="build-edit-label-row"><span class="build-edit-label"><span>Type</span></span></div>
        <code class="build-edit-value">${escapeHtml(model.type)}</code>
        <span class="build-edit-hint" id="build-editor-type-hint">${escapeHtml(model.typeHint)}</span>
      </div>
    </div>`;
}

/** The dialog as HTML (the scrim and the panel); wireBuildEditor(container, model, host) wires it once in the DOM. */
export function buildEditorHtml(model) {
  const t = model.title;
  const cells = [];
  for (const f of model.fields) {
    cells.push(fieldCellHtml(f, model));
    if (f.id === 'semconv_metric' && !model.create) cells.push(typeCellHtml(model));
  }
  const eyebrow = model.create ? 'L1 · Contract · a new SLI' : `L1 · Contract · ${model.readOnly ? 'as compiled' : 'edit'} · ${model.type} SLI`;
  const footActions = model.create
    ? `<button type="button" class="ctrl-btn build-editor-cancel" data-editor-close>${escapeHtml(model.doneLabel)}</button><button type="button" class="mcp-refresh-btn build-editor-submit" data-editor-submit data-focus-key="${escapeHtml(model.submit.focusKey)}"${model.submit.enabled ? '' : ' disabled'}>${escapeHtml(model.submit.label)} <span aria-hidden="true">→</span></button>`
    : `${model.resetAll ? '<button type="button" class="ctrl-btn build-editor-reset-all" data-editor-reset-all title="every field back to the library default"><span aria-hidden="true">↺</span> Reset all</button>' : ''}<button type="button" class="mcp-refresh-btn build-editor-done" data-editor-done data-editor-close>${escapeHtml(model.doneLabel)}</button>`;
  return `
    <div class="build-editor-scrim" data-editor-close aria-hidden="true"></div>
    <div class="build-editor is-${escapeHtml(model.mode)}${model.custom ? ' is-custom' : ''}" role="dialog" aria-modal="true" aria-labelledby="build-editor-title" aria-describedby="build-editor-status" data-editor-key="${escapeHtml(model.key || '')}" data-editor-mode="${escapeHtml(model.mode)}" tabindex="-1">
      <header class="build-editor-head">
        <div class="build-editor-eyebrow">${escapeHtml(eyebrow)}</div>
        <div class="build-editor-title-row">
          <h2 class="build-editor-title" id="build-editor-title">${escapeHtml(t.id)}</h2>
          <span class="build-editor-chips">
            <span class="build-editor-product">${escapeHtml(t.product)} ${evidenceBadge(t.sliEvidence || t.evidence)}</span>
            <span class="type-pill build-rolo-type">${escapeHtml(t.type)}</span>
            ${t.chips.map(chipHtml).join('')}
          </span>
        </div>
        <button type="button" class="build-editor-close" data-editor-close aria-label="Close the editor (Esc)" title="Close (Esc)"><span aria-hidden="true">esc</span></button>
      </header>
      <div class="build-editor-body">
        ${model.generalError ? `<div class="build-edit-error build-editor-general" role="alert">${escapeHtml(model.generalError)}</div>` : ''}
        <div class="build-editor-grid">${cells.join('')}</div>
        ${model.parameters ? `<p class="build-editor-params">${escapeHtml(model.parameters.text)}</p>` : ''}
        <div class="build-editor-evidence">${evidenceBadge(model.evidence.status)}<span class="build-edit-evidence-note">${escapeHtml(model.evidence.note)}</span>${model.readOnly ? `<span class="build-editor-provenance">${escapeHtml(model.provenance)}</span>` : ''}</div>
        ${model.promqlWarning ? `<div class="build-edit-error build-edit-promql" role="alert">${escapeHtml(model.promqlWarning)}</div>` : ''}
        <datalist id="build-window-options">${SLO_WINDOWS.map(w => `<option value="${escapeHtml(w)}"></option>`).join('')}</datalist>
      </div>
      <footer class="build-editor-foot">
        <div class="build-editor-status is-${escapeHtml(model.status.kind)}" id="build-editor-status" role="status" aria-live="polite">${escapeHtml(model.status.text)}</div>
        <div class="build-editor-actions">
          ${model.switch ? `<span class="build-editor-switch"><span class="build-editor-switch-text">${model.switch.on ? 'in the pack' : 'not in the pack'}</span>${switchHtml({ on: model.switch.on, label: model.switch.label, focusKey: model.switch.focusKey, data: model.switch.data })}</span>` : ''}
          ${footActions}
        </div>
      </footer>
    </div>`;
}

/** A PromQL textarea sized to its text, up to PROMQL_MAX_HEIGHT (then it scrolls inside). */
export function growTextarea(ta) {
  if (!ta || !ta.style) return;
  ta.style.height = 'auto';
  const h = Number(ta.scrollHeight) || 0;
  if (h) ta.style.height = `${Math.min(h, PROMQL_MAX_HEIGHT)}px`;
  ta.style.overflowY = h > PROMQL_MAX_HEIGHT ? 'auto' : 'hidden';
}

/**
 * render(container, model, host, { focus }) — the editor into its persistent host (the controller keeps one outside
 * the re-rendered view). `focus` names the field to land on (a field id, or 'dialog'): the render that opens the
 * editor. Without it the render keeps what the user has: when the active element is a field of this editor, its
 * TEXT, focus and caret survive the re-render — the model's value is not written over what is being typed (a
 * re-render of '99.' from the stored 0.99 lost the dot; measured) — so a re-render on the pack's answer never eats
 * a keystroke, and a value the engine rejected stays as typed beside its message.
 */
export function renderBuildEditor(container, model, host = appHost, { focus = null } = {}) {
  const doc = typeof document !== 'undefined' ? document : null;
  const active = doc?.activeElement || null;
  const inside = !!active && active !== doc?.body && typeof container.contains === 'function' && container.contains(active) && !!active.dataset?.focusKey;
  const keep = inside ? { key: active.dataset.focusKey, value: 'value' in active ? active.value : null, sel: typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null } : null;
  container.innerHTML = buildEditorHtml(model);
  wireBuildEditor(container, model, host);
  for (const ta of container.querySelectorAll('textarea.build-edit-input') || []) growTextarea(ta);
  const byKey = (k) => container.querySelector(`[data-focus-key="${attr(k)}"]`);
  let target = null;
  if (focus) {
    // Read-only (Verify) has no field to land on: the dialog itself takes the focus, so its title is read.
    target = focus === 'dialog' || model.readOnly ? container.querySelector('.build-editor')
      : container.querySelector(`.build-editor [data-field="${attr(focus)}"] .build-edit-input`) || container.querySelector('.build-editor .build-edit-input') || container.querySelector('.build-editor');
  } else if (keep) target = byKey(keep.key);
  if (!target) return;
  const kept = keep && target === byKey(keep.key);
  if (kept && keep.value != null && 'value' in target && target.value !== keep.value) {
    target.value = keep.value;
    if (target.tagName === 'TEXTAREA') growTextarea(target);
  }
  target.focus?.({ preventScroll: true });
  if (typeof target.setSelectionRange !== 'function') return;
  try {
    if (kept && keep.sel) target.setSelectionRange(keep.sel[0], keep.sel[1]);
    else if (focus && focus !== 'dialog' && typeof target.value === 'string') target.setSelectionRange(target.value.length, target.value.length);   // the caret at the end: typing appends
  } catch { /* not a text input */ }
}

/**
 * The editor's handlers: close (the scrim, the esc button, Done / Cancel, Esc — a focused field is left first so its
 * change commits), a field's live commit on input (setOverride / updateCustom, `live: true`, the id pre-checked),
 * Enter on a one-line input leaving it, '↺ library default' → clearOverride(key, field), Reset all →
 * clearOverride(key), the footer switch (setSli / addSli / removeCustom, as the rolodex's), the create form
 * (the draft kept on the state as typed, the id following the name until typed, the id / name messages and the
 * submit button repainted from the model, the type re-rendering the fields, Add → addCustom).
 */
export function wireBuildEditor(container, model, host = appHost) {
  const act = host.build;
  const dialog = container.querySelector('.build-editor');
  if (!act || !dialog) return;
  for (const el of container.querySelectorAll('[data-editor-close]') || []) el.addEventListener('click', () => act.closeEditor?.());
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    const t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')) t.blur?.();
    act.closeEditor?.();
  });
  if (model.readOnly) return;
  if (model.create) { wireCreateForm(container, model, act); return; }
  const statusEl = container.querySelector('#build-editor-status');
  const say = (text, kind) => { if (statusEl) { statusEl.textContent = text; statusEl.className = `build-editor-status is-${kind}`; } };
  const idField = model.fields.find(f => f.id === 'id');
  for (const inp of container.querySelectorAll('.build-editor .build-edit-input') || []) {
    const field = inp.dataset?.overrideField || inp.dataset?.customField;
    if (!field) continue;
    let last = inp.value;
    const commit = () => {
      if (inp.value === last) return;   // a change after an input (Enter, blur, a datalist pick of the same text) is not a second edit
      last = inp.value;
      let text = inp.value;
      if (field === 'id') {
        const check = checkEditorId(inp.value, { key: model.key, existingIds: model.existingIds });
        paintFieldMessage(container, 'id', check.ok ? null : check.message, idField?.hint);
        if (!check.ok) { say(`not applied — ${check.message}`, 'error'); return; }
        // What the check made of the text: the key itself (or nothing) clears the rename — never an override that
        // restates the key, which the studio showed as "customised: id" while the engine treated it as no rename.
        text = check.id ?? '';
      }
      const changed = inp.dataset.overrideField ? act.setOverride?.(model.key, field, text, { live: true }) : act.updateCustom?.(model.key, field, text, { live: true });
      // The action says whether anything changed: a text that means the committed value sends nothing, and the
      // status stays the model's — never 'applying…' with no request behind it (measured: still applying 4 s later).
      if (changed === false) say(model.status.text, model.status.kind); else say('applying…', 'pending');
    };
    inp.addEventListener('input', () => { if (inp.tagName === 'TEXTAREA') growTextarea(inp); commit(); });
    inp.addEventListener('change', commit);
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
      statusEl.textContent = live.canSubmit ? 'ready — Add to the pack compiles once and keeps the SLI when the engine accepts it' : `fill the required fields: ${live.required.join(', ')}${live.draft.id ? '' : ' — and a name'}`;
      statusEl.className = `build-editor-status is-${live.canSubmit ? 'ready' : 'idle'}`;
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
