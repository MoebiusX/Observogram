// studio/build-atoms.mjs
//
// The small renderer atoms the BUILD steps and the layer stack share: the
// evidence badge, one param as an input (with its commit-on-change wiring),
// and one todo as a card with the params that fill it. Pure HTML-string
// builders plus one wiring helper; no state reads, no fetches
// (docs/UI_CONVENTIONS.md §2). They lived in build-define-view.mjs and
// build-verify-view.mjs; they moved here so the stack view
// (build-stack-view.mjs), which the DEFINE view draws, needs no import back
// into it.

import { escapeHtml } from './util.mjs';

const EVIDENCE_LABEL = {
  'recorded-live': 'recorded live', 'reference-pack': 'reference pack', 'upstream-docs': 'upstream docs', semconv: 'semconv',
};

export function evidenceBadge(status, verifiedOn) {
  if (!status) return '';
  const title = verifiedOn ? `${EVIDENCE_LABEL[status] || status} · verified ${verifiedOn}` : (EVIDENCE_LABEL[status] || status);
  return `<span class="build-evidence build-evidence-${escapeHtml(status)}" title="${escapeHtml(title)}">${escapeHtml(EVIDENCE_LABEL[status] || status)}</span>`;
}

/** The evidence as a dot (the definition column's chips): the badge's colour, the status in the title and for a screen reader. */
export function evidenceDot(status, verifiedOn) {
  if (!status) return '';
  const word = EVIDENCE_LABEL[status] || status;
  const title = verifiedOn ? `${word} · verified ${verifiedOn}` : word;
  return `<span class="build-evidence-dot build-evidence-${escapeHtml(status)}" title="${escapeHtml(title)}" role="img" aria-label="${escapeHtml(`evidence: ${title}`)}"></span>`;
}

/**
 * A real switch (role=switch, a sliding knob) for the section toggles and the rolodex's
 * add / remove: `on` its state, `disabled` with `reason` when it cannot be flipped (an SLI
 * above the tier, policy without SLOs), `label` its accessible name, `data-*` what the
 * wiring reads back. The knob is CSS; the button is the whole control.
 */
export function switchHtml({ on, disabled = false, reason = null, label, focusKey = null, data = {}, small = false } = {}) {
  const attrs = Object.entries(data).map(([k, v]) => ` data-${escapeHtml(k)}="${escapeHtml(v)}"`).join('');
  return `<button type="button" role="switch" class="build-switch${small ? ' is-small' : ''}" aria-checked="${on ? 'true' : 'false'}" aria-label="${escapeHtml(label)}"${disabled ? ` disabled aria-disabled="true"${reason ? ` title="${escapeHtml(reason)}"` : ''}` : ''}${focusKey ? ` data-focus-key="${escapeHtml(focusKey)}"` : ''}${attrs}><span class="build-switch-knob" aria-hidden="true"></span></button>`;
}

// One param as an input (the same param may fill several todos on VERIFY:
// idSuffix keeps the ids and focus keys distinct while they share the key).
// `readOnly` draws the row as the preview and VERIFY show it — the value the
// pack carries as a code span instead of the input, the same label block
// (name, key, the scaffold mark, the placeholder / rejected flag with its
// title), so the two variants cannot drift.
export function paramRowHtml(p, { compact = false, idSuffix = '', readOnly = false } = {}) {
  const focusKey = `param:${p.key}${idSuffix ? `@${idSuffix}` : ''}`;
  const id = `bp-${idSuffix ? `${idSuffix}-` : ''}${p.key}`;
  const cls = `build-param${readOnly ? ' build-param-read' : ''}${p.placeholder ? ' is-placeholder' : ''}${p.atDefault ? '' : ' is-set'}${p.error ? ' is-error' : ''}`;
  return `
    <div class="${cls}" data-param="${escapeHtml(p.key)}">
      ${paramLabelHtml(p, readOnly ? null : id)}
      ${readOnly
        ? `<code class="build-param-value">${escapeHtml(String(p.effective ?? ''))}</code>`
        : `<input id="${escapeHtml(id)}" class="build-param-input" type="text" data-focus-key="${escapeHtml(focusKey)}"${p.error ? ' aria-invalid="true"' : ''}
             value="${escapeHtml(p.value ?? '')}" placeholder="${escapeHtml(String(p.hint ?? p.default ?? ''))}" autocomplete="off" spellcheck="false">`}
      ${p.error ? `<span class="build-param-error" role="alert">${escapeHtml(p.error)}</span>` : ''}
      ${compact || readOnly ? '' : `<span class="build-param-desc">${escapeHtml(p.description)}</span>`}
    </div>`;
}

/** The label block of a param row, written once: a <label for> when the row has an input, a <span> when it is read-only. */
export function paramLabelHtml(p, forId = null) {
  const inner = `
        <span class="build-param-name">${escapeHtml(p.label)}</span>
        <span class="build-param-key">${escapeHtml(p.key)}${p.entry ? '' : ' · scaffold'}</span>
        ${p.error ? '<span class="build-param-flag is-error">rejected</span>' : p.placeholder ? `<span class="build-param-flag" title="left at its default this value is written into the pack AND reported as a todo">${p.atDefault ? 'placeholder → todo' : 'placeholder filled'}</span>` : ''}
      `;
  return forId ? `<label class="build-param-label" for="${escapeHtml(forId)}">${inner}</label>` : `<span class="build-param-label">${inner}</span>`;
}

/**
 * One field of an edit face or of the '+ Custom SLI' form (the L1 sheet's copies), written once for both: the
 * input for its kind (a textarea for PromQL, a datalist for the window, a select for the type, text otherwise),
 * the library default beside the label when the model gives one, '↺ library default' when the field is
 * overridden and resettable, the engine's error under it (role=alert) or the hint. `dataAttr` names the data
 * attribute the wiring reads back (`override-field` / `custom-field` on a face, `custom-draft` on the form),
 * `sli` the card's key, `rows` the textarea height. `readOnly` draws the row as VERIFY shows it — the value the
 * pack carries as a code span in place of the input, the same label block without a `for` — like paramRowHtml's
 * read-only variant, so the two faces cannot drift.
 */
export function editFieldHtml(f, { dataAttr = 'override-field', sli = null, rows = 3, readOnly = false } = {}) {
  const id = escapeHtml(f.inputId);
  const data = ` data-${escapeHtml(dataAttr)}="${escapeHtml(f.id)}"${sli ? ` data-sli="${escapeHtml(sli)}"` : ''}`;
  const dflt = f.default === null || f.default === undefined ? '' : (f.overridden
    ? `<span class="build-edit-default">library <code>${escapeHtml(f.default || '—')}</code></span>`
    : '<span class="build-edit-default">library default</span>');
  const labelInner = `<span>${escapeHtml(f.label)}${f.kind === 'percent' ? ' <em>%</em>' : ''}${f.required ? ' <i title="required">*</i>' : ''}</span>${dflt}`;
  const reset = f.resettable && !readOnly ? `<button type="button" class="build-edit-reset" data-reset="${escapeHtml(f.id)}"${sli ? ` data-sli="${escapeHtml(sli)}"` : ''} data-focus-key="${escapeHtml(f.focusKey)}:reset" title="${escapeHtml(`back to the library default (${f.default || '—'})`)}" aria-label="${escapeHtml(`${f.label}: back to the library default`)}"><span aria-hidden="true">↺</span> library default</button>` : '';
  let control;
  if (readOnly) control = `<code class="build-edit-value"${data}>${escapeHtml(f.value)}</code>`;
  else {
    const common = `class="build-edit-input" id="${id}" data-focus-key="${escapeHtml(f.focusKey)}"${data}${f.error ? ' aria-invalid="true"' : ''}${f.required ? ' required' : ''}`;
    const placeholder = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : '';
    if (f.kind === 'promql') control = `<textarea ${common} rows="${rows}" spellcheck="false" autocomplete="off"${placeholder}>${escapeHtml(f.value)}</textarea>`;
    else if (f.kind === 'select') control = `<select ${common}>${(f.options || []).map(o => `<option value="${escapeHtml(o)}"${o === f.value ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select>`;
    else if (f.kind === 'window') control = `<input type="text" ${common} list="build-window-options" value="${escapeHtml(f.value)}" autocomplete="off" spellcheck="false">`;
    else control = `<input type="text" ${common} value="${escapeHtml(f.value)}"${placeholder} autocomplete="off" spellcheck="false"${f.kind === 'percent' || f.kind === 'number' ? ' inputmode="decimal"' : ''}>`;
  }
  return `
    <div class="build-edit-field${f.overridden ? ' is-overridden' : ''}${f.error ? ' is-error' : ''}${readOnly ? ' is-read' : ''}" data-field="${escapeHtml(f.id)}">
      ${readOnly ? `<span class="build-edit-label">${labelInner}</span>` : `<label class="build-edit-label" for="${id}">${labelInner}${reset}</label>`}
      ${control}
      ${f.error ? `<span class="build-edit-error" role="alert">${escapeHtml(f.error)}</span>` : f.hint && !readOnly ? `<span class="build-edit-hint">${escapeHtml(f.hint)}</span>` : ''}
    </div>`;
}

/** Param inputs commit on change (Enter / blur), so typing never re-renders under the caret. `selector` narrows which inputs (the stack wires only its own). */
export function wireParamInputs(container, act, selector = '.build-param-input') {
  container.querySelectorAll(selector).forEach(inp => {
    const key = inp.closest('.build-param')?.dataset.param;
    inp.addEventListener('change', () => act.setParam(key, inp.value));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  });
}

// ---------- the clause row (the rail and the slabs) ----------

export const STATE_GLYPH = { pass: '✓', placeholder: '◐', fail: '✗', pending: '○', neutral: '·' };
export const STATE_WORD = { pass: 'passes', placeholder: 'passes on a placeholder', fail: 'fails', pending: 'not evaluated yet', neutral: 'no clause applies' };

/**
 * One clause of the checklist as a row — the glyph of its state, the rubric's description,
 * the severity and id, and the todos it rests on (a placeholder pass names them; a failing
 * clause names them when the summary gives any). The rail's lists and a slab's folded clause
 * list draw the same row through this one function.
 */
export function clauseRowHtml(i) {
  const todos = i.todos || [];
  const rest = i.state === 'placeholder' ? ` · <em>on ${todos.length} placeholder${todos.length === 1 ? '' : 's'}: ${escapeHtml(todos.join(', '))}</em>`
    : i.state === 'fail' && todos.length ? ` · <em>${escapeHtml(todos.join(', '))}</em>` : '';
  return `
    <li class="build-rail-clause is-${i.state}" title="${escapeHtml(`${i.id} — ${STATE_WORD[i.state]}${todos.length ? ` · ${todos.join(', ')}` : ''}`)}">
      <span class="build-rail-glyph" aria-hidden="true">${STATE_GLYPH[i.state]}</span>
      <span class="build-rail-text">
        <span class="build-rail-desc">${escapeHtml(i.description)}</span>
        <span class="build-rail-id"><span class="build-sev build-sev-${i.severity.toLowerCase()}">${i.severity}</span> ${escapeHtml(i.id)}${rest}</span>
      </span>
    </li>`;
}

/** Bring a rendered todo into view — scroll, a short flash, the caret in its first input (a pin's click, a jump from another step). */
export function revealTodo(todoEl) {
  if (!todoEl) return false;
  todoEl.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  todoEl.classList.add('is-flash');
  setTimeout(() => todoEl.classList.remove('is-flash'), 1200);
  todoEl.querySelector('.build-param-input')?.focus({ preventScroll: true });
  return true;
}

const PLACEHOLDER_GLYPH = '◐';

// "channels.0.msteams: Chat channel for SEV1/SEV2: placeholder '#x' (param oncall_channel) — The Teams…"
// → the part before the em dash, one line per placeholder field.
export function todoLines(what) {
  return String(what || '').split(' · ').map(part => part.split(' — ')[0].trim()).filter(Boolean);
}

/** One todo as a card: its path, the clauses it holds up, what is placeholder about it, the params that fill it (or that none does). */
export function todoHtml(t, idSuffix) {
  return `
    <li class="build-todo${t.manual ? ' is-manual' : ''}" data-todo="${escapeHtml(t.path)}">
      <div class="build-todo-head">
        <code class="build-todo-path">${escapeHtml(t.path)}</code>
        ${t.artefactId ? `<span class="build-todo-card" title="the artefact card this todo belongs to">${escapeHtml(t.artefactId)}</span>` : ''}
        ${t.clauses.map(c => `<span class="build-todo-clause" title="this placeholder artefact holds up ${escapeHtml(c)}">${PLACEHOLDER_GLYPH} ${escapeHtml(c)}</span>`).join('')}
      </div>
      <ul class="build-todo-what">${todoLines(t.what).map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
      ${t.manual
        ? '<div class="build-todo-manual">no parameter fills this one — a file to write or a number to measure, then edit the pack</div>'
        : `<div class="build-todo-params">${t.params.map(p => paramRowHtml(p, { compact: true, idSuffix })).join('')}</div>`}
    </li>`;
}
