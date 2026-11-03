// studio/update-view.mjs
//
// The UPDATE journey's renderers (docs/UPDATE_JOURNEY.md; docs/UI_CONVENTIONS.md
// §2-3: render(container, model, host), host.build.* are the actions):
//
//   - the Open panel — one panel in the screen grammar when a pack cannot be
//     reopened without a word: context, one sentence, what can and cannot be
//     changed here, one action;
//   - the definition column's add buttons (+ SLI · + SLO · + Route · + Alert rule)
//     and "Changes since v0.1.0", one row per thing the user did, each with undo;
//   - the add editor — the three add forms in the pop-up editor's own shell;
//   - Verify's review — the saved pack beside the pack with the changes, the
//     numbers, two columns per touched artefact, "Also changes", what may still
//     be live, the live-check line;
//   - the home's "Update a pack you have" list.
//
// Zone: `.upd-*` (docs/UI_CONVENTIONS.md §4).

import { escapeHtml } from './util.mjs';
import { host as appHost } from './host.mjs';
import { decisionHeaderHtml, wireUxActions, plural } from './ux-kit.mjs';
import { addFormModel, nextVersionOf } from './update-model.mjs';

const attr = (s) => escapeHtml(String(s ?? ''));

// ---------- 1. the Open panel ----------

/** The Open stage's panel as HTML. */
export function openPanelHtml(decision) {
  const d = decision;
  const list = (title, items, cls = '') => items?.length ? `
      <section class="upd-list ${cls}">
        <h3 class="upd-list-title">${escapeHtml(title)}</h3>
        <ul>${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
      </section>` : '';
  const tone = d.kind === 'error' || d.kind === 'unavailable' ? 'fail' : d.kind === 'busy' || d.kind === 'differs' || d.kind === 'foreign' || d.kind === 'superseded' ? 'warn' : 'info';
  const primary = d.actions.find(a => a.primary) || null;
  const secondary = d.actions.filter(a => !a.primary);
  return `
    <section class="build-step upd-open" aria-labelledby="upd-open-title">
      <header class="build-step-head">
        <div class="build-step-eyebrow">Update · open</div>
        <h2 class="build-step-title" id="upd-open-title">Can the studio reopen this pack without losing anything?</h2>
      </header>
      ${decisionHeaderHtml({
        id: 'upd-open-decision', eyebrow: 'Open · the pack as stored', context: d.context, decision: d.sentence, tone,
        verdict: ({ busy: 'unsaved work', differs: 'not exactly', foreign: 'cannot open yet', origin: 'no definition', superseded: 'newer version', error: 'cannot read', unavailable: 'not this rank' })[d.kind] || '',
        primary: primary ? { id: `upd-open-${primary.id}`, label: primary.label, action: `open:${primary.id}` } : null,
        secondary: secondary.map(a => ({ id: `upd-open-${a.id}`, label: a.label, action: `open:${a.id}` })),
      })}
      ${list(d.kind === 'busy' ? 'The changes, not saved' : d.kind === 'differs' ? 'Pack value → Build’s value' : 'Named', d.items, 'upd-list--items')}
      ${d.notes?.length ? list('What the pack could not say', d.notes, 'upd-list--notes') : ''}
      ${d.adopted?.length ? list('Read in as additions', d.adopted, 'upd-list--adopted') : ''}
      <div class="upd-two">
        ${list('Can be changed here', d.can, 'upd-list--can')}
        ${list('Cannot be changed here yet', d.cannot, 'upd-list--cannot')}
      </div>
    </section>`;
}

/** render(container, decision, host) — the Open panel; host.build.openAction(id) takes the action. */
export function renderUpdateOpen(container, decision, host = appHost) {
  container.innerHTML = openPanelHtml(decision);
  const root = container.querySelector('.upd-open');
  if (!root || typeof root.addEventListener !== 'function') return;
  const handlers = {};
  for (const a of decision.actions) handlers[`open:${a.id}`] = () => host.build.openAction?.(a.id);
  wireUxActions(root, handlers);
}

// ---------- 2. the definition column: add buttons and the changes ----------

const ADD_BUTTONS = [
  { id: 'sli', label: '+ SLI', title: 'An SLI of a library entry, or a custom one — on the L1 sheet' },
  { id: 'slo', label: '+ SLO', title: 'A second objective on an SLI the pack measures, with its burn-rate alert' },
  { id: 'route', label: '+ Route', title: 'A route (severity → channels) beside the generated ones' },
  { id: 'alert_rule', label: '+ Alert rule', title: 'A plain alert rule the engine evaluates (spec 1.4 alerting.rules)' },
];

/** The add buttons and, on an update, "Changes since v0.1.0" — appended under the seed card on Compile. */
export function definitionExtrasHtml({ build, changes, readOnly = false } = {}) {
  const u = build?.update;
  const adds = readOnly ? '' : `
    <section class="upd-adds" aria-label="Add to the pack">
      <div class="upd-adds-title">Add to the pack</div>
      <div class="upd-adds-row">${ADD_BUTTONS.map(b => `<button type="button" class="ctrl-btn upd-add" data-upd-add="${b.id}" data-focus-key="add:${b.id}" title="${attr(b.title)}">${escapeHtml(b.label)}</button>`).join('')}</div>
    </section>`;
  const title = u?.id ? `Changes since v${u.version || '?'}` : 'Changes since the pack was opened';
  const list = !u?.id ? '' : `
    <section class="upd-changes" aria-labelledby="upd-changes-title">
      <div class="upd-adds-title" id="upd-changes-title">${escapeHtml(title)} <span class="build-count">${changes?.count || 0}</span></div>
      ${changes?.rows?.length ? `<ul class="upd-change-rows">${changes.rows.map(r => `
        <li class="upd-change" data-change-key="${attr(r.key)}">
          <span class="upd-change-text">${escapeHtml(r.text)}</span>
          ${readOnly ? '' : `<button type="button" class="ux-link-btn upd-undo" data-upd-undo="${attr(r.key)}" title="Undo this change">undo</button>`}
        </li>`).join('')}</ul>`
        : `<p class="upd-none">Nothing yet. Saving now would register v${nextVersionOf(u.version)} identical to v${u.version || '?'}, so Save waits for a change.</p>`}
    </section>`;
  return `${adds}${list}`;
}

/** Wire the add buttons (host.build.openAdd(kind), 'sli' → the L1 sheet) and the undo buttons (host.build.undoChange(key)). */
export function wireDefinitionExtras(container, { changes } = {}, host = appHost) {
  const act = host.build;
  for (const b of container.querySelectorAll?.('[data-upd-add]') || []) {
    b.addEventListener('click', () => (b.dataset.updAdd === 'sli' ? act.openSheet?.('L1') : act.openAdd?.(b.dataset.updAdd, { opener: `add:${b.dataset.updAdd}` })));
  }
  const byKey = new Map((changes?.rows || []).map(r => [r.key, r]));
  for (const b of container.querySelectorAll?.('[data-upd-undo]') || []) {
    b.addEventListener('click', () => { const r = byKey.get(b.dataset.updUndo); if (r) act.undoChange?.(r); });
  }
}

// ---------- 3. the add editor ----------

const field = (id, label, control, { error = null, hint = null } = {}) => `
      <div class="build-edit-field upd-field${error ? ' is-error' : ''}" data-field="${attr(id)}">
        <div class="build-edit-label-row"><label class="build-edit-label" for="upd-f-${attr(id)}">${escapeHtml(label)}</label>${hint ? `<span class="upd-hint">${escapeHtml(hint)}</span>` : ''}</div>
        ${control}
        ${error ? `<div class="build-edit-msg is-error" role="alert">${escapeHtml(error)}</div>` : ''}
      </div>`;
const select = (id, value, options, extra = '') => `<select class="build-edit-input upd-select" id="upd-f-${attr(id)}" data-upd-field="${attr(id)}" ${extra}>${options.map(o => { const v = typeof o === 'string' ? o : o.value; const l = typeof o === 'string' ? o : o.label; return `<option value="${attr(v)}"${v === value ? ' selected' : ''}>${escapeHtml(l)}</option>`; }).join('')}</select>`;
const input = (id, value, { placeholder = '', inputmode = null, extra = '' } = {}) => `<input class="build-edit-input" id="upd-f-${attr(id)}" data-upd-field="${attr(id)}" type="text" value="${attr(value)}" placeholder="${attr(placeholder)}"${inputmode ? ` inputmode="${inputmode}"` : ''} autocomplete="off" spellcheck="false" ${extra}>`;

function sloFormHtml(m) {
  const d = m.draft;
  const e = m.errors;
  return `
    ${field('sli', 'On the SLI', select('sli', d.sli, m.slis.map(s => ({ value: s.id, label: `${s.id} · ${s.type}` }))), { error: e.sli, hint: 'the SLI keeps its generated SLO; this adds a second objective' })}
    <div class="upd-grid-2">
      ${field('objective', 'Objective (%)', input('objective', d.objective, { placeholder: '99.95', inputmode: 'decimal' }), { error: e.objective, hint: m.id ? `SLO id ${m.id}` : '' })}
      ${field('window', 'Window', select('window', d.window, m.windows), { error: e.window })}
    </div>
    <fieldset class="upd-windows">
      <legend>Burn-rate alert — its windows${e.windows ? ` <span class="upd-err">· ${escapeHtml(e.windows)}</span>` : ''}</legend>
      ${(d.windows || []).map((w, i) => `
      <div class="upd-window-row" data-window="${i}">
        ${field(`windows.${i}.short`, 'short', input(`windows.${i}.short`, w.short, { placeholder: '5m' }), { error: e[`windows.${i}.short`] })}
        ${field(`windows.${i}.long`, 'long', input(`windows.${i}.long`, w.long, { placeholder: '1h' }), { error: e[`windows.${i}.long`] })}
        ${field(`windows.${i}.factor`, 'factor', input(`windows.${i}.factor`, w.factor, { placeholder: '14', inputmode: 'decimal' }), { error: e[`windows.${i}.factor`] })}
        ${field(`windows.${i}.severity`, 'severity', select(`windows.${i}.severity`, w.severity, m.severities), { error: e[`windows.${i}.severity`] })}
      </div>`).join('')}
      <p class="upd-hint">Prefilled from the SLI’s profile at this tier. The alert becomes two rules when compiled; Deploy puts them live.</p>
    </fieldset>`;
}

function routeFormHtml(m) {
  const d = m.draft;
  const e = m.errors;
  return `
    ${field('severity', 'Severity', select('severity', d.severity, m.severities), { error: e.severity, hint: 'goes to these channels as well as to the generated route’s' })}
    <fieldset class="upd-channels">
      <legend>Channels${e.channels ? ` <span class="upd-err">· ${escapeHtml(e.channels)}</span>` : ''}</legend>
      ${(d.channels || []).map((c, i) => `
      <div class="upd-channel-row" data-channel="${i}">
        ${field(`channels.${i}.kind`, 'kind', select(`channels.${i}.kind`, c.kind, m.channelKinds), { error: e[`channels.${i}.kind`] })}
        ${field(`channels.${i}.address`, 'address', input(`channels.${i}.address`, c.address, { placeholder: c.kind === 'webhook' ? 'https://…' : c.kind === 'email' ? 'team@example.com' : c.kind === 'voice' ? 'pagerduty://service' : '#channel' }), { error: e[`channels.${i}.address`] })}
        ${(d.channels || []).length > 1 ? `<button type="button" class="ux-link-btn upd-remove-channel" data-upd-remove-channel="${i}" aria-label="Remove channel ${i + 1}">remove</button>` : ''}
      </div>`).join('')}
      <button type="button" class="ux-link-btn upd-add-channel" data-upd-add-channel>+ channel</button>
    </fieldset>`;
}

function ruleFormHtml(m) {
  const d = m.draft;
  const e = m.errors;
  return `
    ${field('name', 'Name', input('name', d.name, { placeholder: 'QueueDepthHigh' }), { error: e.name, hint: 'the rule’s exact name (alert: in a rule file)' })}
    ${field('expr', 'Condition (expr)', `<textarea class="build-edit-input upd-expr" id="upd-f-expr" data-upd-field="expr" rows="3" placeholder="queue_depth > 1000" spellcheck="false">${escapeHtml(d.expr || '')}</textarea>`, { error: e.expr, hint: 'PromQL, LogQL, or the engine’s own language' })}
    <div class="upd-grid-3">
      ${field('severity', 'Severity', select('severity', d.severity || '', ['', ...m.severities].map(s => ({ value: s, label: s || '— none —' }))), { error: e.severity, hint: 'so the routes apply' })}
      ${field('for', 'For', input('for', d.for, { placeholder: '5m' }), { error: e.for })}
      ${field('engine', 'Engine', select('engine', d.engine || '', ['', ...m.engines].map(s => ({ value: s, label: s || 'prometheus (default)' }))), { error: e.engine })}
    </div>`;
}

/** The add editor as HTML — the pop-up editor's shell (scrim, dialog, head, body, foot) around one of the three forms. */
export function addEditorHtml(model) {
  const m = model;
  const body = m.kind === 'slo' ? sloFormHtml(m) : m.kind === 'route' ? routeFormHtml(m) : ruleFormHtml(m);
  const status = m.serverError ? { kind: 'is-error', text: m.serverError } : m.ok ? { kind: 'is-ready', text: 'Ready to add — the pack regenerates with it.' } : { kind: '', text: `${plural(Object.keys(m.errors).length, 'field')} to complete.` };
  return `
    <div class="build-editor-scrim" data-editor-close aria-hidden="true"></div>
    <div class="build-editor upd-editor" role="dialog" aria-modal="true" aria-labelledby="build-editor-title" aria-describedby="build-editor-status" data-editor-mode="add" data-editor-key="add:${attr(m.kind)}" tabindex="-1">
      <header class="build-editor-head">
        <div class="build-editor-eyebrow">${m.kind === 'slo' ? 'L1 · Signals · an addition' : 'L4 · Alerting · an addition'}</div>
        <div class="build-editor-title-row"><h2 class="build-editor-title" id="build-editor-title">${escapeHtml(m.title)}</h2></div>
        <p class="build-editor-summary">${escapeHtml(m.lede)}</p>
        <button type="button" class="build-editor-close" data-editor-close aria-label="Close (Esc)" title="Close (Esc)" data-focus-key="editor:close"><span aria-hidden="true">esc</span></button>
      </header>
      <div class="build-editor-body"><form class="upd-form" data-upd-form novalidate>${body}</form></div>
      <footer class="build-editor-foot">
        <div class="build-editor-status ${status.kind}" id="build-editor-status" role="status" aria-live="polite">${escapeHtml(status.text)}</div>
        <div class="build-editor-actions">
          <button type="button" class="ctrl-btn build-editor-cancel" data-editor-close data-focus-key="editor:cancel">Cancel</button>
          <button type="button" class="mcp-refresh-btn build-editor-submit" data-upd-submit data-focus-key="editor:submit"${m.ok ? '' : ' disabled'}>Add to the pack <span aria-hidden="true">→</span></button>
        </div>
      </footer>
    </div>`;
}

/**
 * render(container, { draft, build, result, serverError }, host) — the add editor. Every field writes the draft
 * through host.build.updateAddDraft(patch) (no regenerate); Add calls host.build.commitAdd(); Esc, the scrim and
 * Cancel call host.build.closeEditor(). The focused field survives the redraw a keystroke causes.
 */
export function renderAddEditor(container, { draft, build, result, serverError = null } = {}, host = appHost, { focus = null } = {}) {
  const act = host.build;
  const model = { ...addFormModel(draft, { build, result }), serverError };
  const doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const active = doc?.activeElement;
  const keep = active && container.contains?.(active) ? { field: active.dataset?.updField, sel: typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null } : null;
  container.innerHTML = addEditorHtml(model);
  const dialog = container.querySelector('.build-editor');
  if (!dialog || typeof dialog.addEventListener !== 'function') return;
  for (const el of container.querySelectorAll('[data-editor-close]')) el.addEventListener('click', () => act.closeEditor?.());
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); act.closeEditor?.(); }
    if (e.key === 'Enter' && e.target?.tagName === 'INPUT') { e.preventDefault(); if (model.ok) act.commitAdd?.(); }
  });
  const setPath = (path, value) => {
    const next = JSON.parse(JSON.stringify(draft));
    const segs = path.split('.');
    let node = next;
    for (const s of segs.slice(0, -1)) node = node[/^\d+$/.test(s) ? Number(s) : s];
    node[segs.at(-1)] = value;
    return next;
  };
  for (const el of container.querySelectorAll('[data-upd-field]')) {
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      let next = setPath(el.dataset.updField, el.value);
      // The SLI picked changes the alert's default windows (its type's profile) when they were not edited.
      if (el.dataset.updField === 'sli' && draft.kind === 'slo') {
        const sli = model.slis.find(s => s.id === el.value);
        if (sli) next = { ...next, windows: act.defaultWindowsFor?.(sli.type) || next.windows };
      }
      act.updateAddDraft?.(next);
    });
  }
  container.querySelector('[data-upd-add-channel]')?.addEventListener('click', () => act.updateAddDraft?.({ ...draft, channels: [...(draft.channels || []), { kind: 'msteams', address: '' }] }, { focus: `channels.${(draft.channels || []).length}.address` }));
  for (const b of container.querySelectorAll('[data-upd-remove-channel]')) b.addEventListener('click', () => act.updateAddDraft?.({ ...draft, channels: (draft.channels || []).filter((_, i) => i !== Number(b.dataset.updRemoveChannel)) }));
  container.querySelector('[data-upd-submit]')?.addEventListener('click', () => act.commitAdd?.());
  container.querySelector('form')?.addEventListener('submit', (e) => { e.preventDefault(); if (model.ok) act.commitAdd?.(); });
  const want = focus ? container.querySelector(`[data-upd-field="${attr(focus)}"]`) : keep?.field ? container.querySelector(`[data-upd-field="${attr(keep.field)}"]`) : null;
  const target = want || (focus === 'dialog' || !keep ? container.querySelector('[data-upd-field]') : null) || dialog;
  target?.focus?.({ preventScroll: true });
  if (keep?.sel && target === want && typeof target.setSelectionRange === 'function') { try { target.setSelectionRange(keep.sel[0], keep.sel[1]); } catch { /* not a text input */ } }
}

// ---------- 4. Verify's review ----------

const val = (v) => (v == null ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
const fieldsHtml = (fields) => fields?.length ? `<dl class="upd-fields">${fields.slice(0, 8).map(f => `<div><dt>${escapeHtml(f.field || 'value')}</dt><dd class="upd-old">${escapeHtml(val(f.a))}</dd><dd class="upd-new">${escapeHtml(val(f.b))}</dd></div>`).join('')}${fields.length > 8 ? `<div><dt>…</dt><dd colspan="2">${fields.length - 8} more</dd></div>` : ''}</dl>` : '';

function rowHtml(r) {
  const kindWord = { added: 'added', changed: 'changed', removed: 'removed' }[r.kind] || r.kind;
  return `
      <li class="upd-row is-${attr(r.kind)}">
        <div class="upd-row-head"><span class="upd-row-kind">${escapeHtml(kindWord)}</span> <span class="upd-row-label">${escapeHtml(r.label)}</span>${r.why ? ` <span class="upd-row-why">· ${escapeHtml(r.why)}</span>` : ''}</div>
        ${r.kind === 'changed' ? fieldsHtml(r.fields) : `<div class="upd-cols"><div class="upd-col upd-old">${r.kind === 'removed' ? escapeHtml(r.label) : '—'}</div><div class="upd-col upd-new">${r.kind === 'added' ? escapeHtml(r.label) : '—'}</div></div>`}
      </li>`;
}

/** The review block: two cards, the numbers, the rows the changes explain, "Also changes", what may still be live, the live line. */
export function reviewHtml(rv) {
  if (!rv) return '';
  if (rv.error) return `<section class="upd-review" aria-label="Review"><p class="build-note">${escapeHtml(rv.error)}</p></section>`;
  const n = rv.numbers;
  const err = rv.saveError ? `<div class="build-note build-note-err upd-save-error" role="alert">${escapeHtml((rv.saveError.errors || []).join(' '))}${rv.saveError.newer ? ` <button type="button" class="ux-link-btn" data-ux-action="open-newer" data-id="${attr(rv.saveError.newer.id)}">Open v${attr(rv.saveError.newer.version || '?')}</button>` : ''}</div>` : '';
  return `
    <section class="upd-review" aria-labelledby="upd-review-title">
      <div class="build-section-key" id="upd-review-title">Saved beside with your changes <span class="build-section-sub">the pack as stored, artefact by artefact, against the pack this definition makes now — nothing moves silently</span></div>
      ${err}
      <div class="upd-cards">
        <div class="upd-card is-saved"><div class="upd-card-eyebrow">Saved</div><div class="upd-card-title">${escapeHtml(rv.base.name || '')} <b>v${escapeHtml(rv.base.version || '?')}</b></div><div class="upd-card-sub">${plural(rv.base.count, 'artefact')}</div></div>
        <div class="upd-card is-next"><div class="upd-card-eyebrow">With your changes</div><div class="upd-card-title">${escapeHtml(rv.base.name || '')} <b>v${escapeHtml(rv.next.version)}</b></div><div class="upd-card-sub">${plural(rv.next.count, 'artefact')}</div></div>
      </div>
      <p class="upd-numbers"><span>only in saved <b>${n.onlySaved}</b></span> <span>in both <b>${n.both}</b> (${n.changed} changed)</span> <span>only with your changes <b>${n.onlyNext}</b></span></p>
      <p class="upd-sentence">${escapeHtml(rv.sentence)}</p>
      ${rv.rows.length ? `<ol class="upd-rows" aria-label="Your changes">${rv.rows.map(rowHtml).join('')}</ol>` : ''}
      ${rv.also.length ? `<details class="upd-also" open><summary>Also changes <span class="build-count">${rv.also.length}</span> <span class="upd-hint">— moved by the changes above (a renamed SLO is named by its alert, its boards, its rules), the filled values, the tier or a section switch</span></summary><ol class="upd-rows">${rv.also.map(rowHtml).join('')}</ol></details>` : ''}
      ${rv.gone.length ? `<section class="upd-gone"><h4>No longer in the pack, possibly still live</h4><p class="upd-hint">Deploy creates rules and does not delete them: what the saved version put live stays until it is removed there.</p><ul>${rv.gone.map(g => `<li>${escapeHtml(g.label)}</li>`).join('')}</ul></section>` : ''}
      <p class="upd-live"><b>Does it measure anything?</b> ${escapeHtml(rv.live.text)}</p>
    </section>`;
}

// ---------- 5. the home's list ----------

/** "Update a pack you have": this workspace's Build-made packs, `name · version · made in Build`, or why there is none. */
export function homeUpdateListHtml(packs = []) {
  if (!packs.length) return `<p class="upd-home-none">No pack made in Build is in this workspace yet. Start a new pack; once it is registered, it is listed here to update.</p>`;
  return `
    <ul class="upd-home-list" aria-label="Packs you can update">
      ${packs.map(p => `
      <li><button type="button" class="upd-home-pack" data-upd-open="${attr(p.id)}">
        <span class="upd-home-name">${escapeHtml(p.name)}</span>
        <span class="upd-home-meta">v${escapeHtml(p.version)} · ${escapeHtml(p.origin)}${p.earlier ? ` · ${plural(p.earlier, 'earlier version')}` : ''}</span>
        <span class="upd-home-cta">update →</span>
      </button></li>`).join('')}
    </ul>`;
}
