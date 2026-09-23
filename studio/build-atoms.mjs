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

// One param as an input (the same param may fill several todos on VERIFY:
// idSuffix keeps the ids and focus keys distinct while they share the key).
export function paramRowHtml(p, { compact = false, idSuffix = '' } = {}) {
  const focusKey = `param:${p.key}${idSuffix ? `@${idSuffix}` : ''}`;
  const id = `bp-${idSuffix ? `${idSuffix}-` : ''}${p.key}`;
  return `
    <div class="build-param${p.placeholder ? ' is-placeholder' : ''}${p.atDefault ? '' : ' is-set'}${p.error ? ' is-error' : ''}" data-param="${escapeHtml(p.key)}">
      <label class="build-param-label" for="${escapeHtml(id)}">
        <span class="build-param-name">${escapeHtml(p.label)}</span>
        <span class="build-param-key">${escapeHtml(p.key)}${p.entry ? '' : ' · scaffold'}</span>
        ${p.error ? '<span class="build-param-flag is-error">rejected</span>' : p.placeholder ? `<span class="build-param-flag" title="left at its default this value is written into the pack AND reported as a todo">${p.atDefault ? 'placeholder → todo' : 'placeholder filled'}</span>` : ''}
      </label>
      <input id="${escapeHtml(id)}" class="build-param-input" type="text" data-focus-key="${escapeHtml(focusKey)}"${p.error ? ' aria-invalid="true"' : ''}
             value="${escapeHtml(p.value ?? '')}" placeholder="${escapeHtml(String(p.hint ?? p.default ?? ''))}" autocomplete="off" spellcheck="false">
      ${p.error ? `<span class="build-param-error" role="alert">${escapeHtml(p.error)}</span>` : ''}
      ${compact ? '' : `<span class="build-param-desc">${escapeHtml(p.description)}</span>`}
    </div>`;
}

/** Param inputs commit on change (Enter / blur), so typing never re-renders under the caret. */
export function wireParamInputs(container, act) {
  container.querySelectorAll('.build-param-input').forEach(inp => {
    const key = inp.closest('.build-param')?.dataset.param;
    inp.addEventListener('change', () => act.setParam(key, inp.value));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  });
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
