// studio/mcp-settings-view.mjs
//
// The renderer of the MCP panel's Server settings modal (rebadge batch 4,
// D2): renderServerSettings(container, model, host) draws the dialog into
// its host (#mss-host, appended last to <body>, so it is the dialog the Tab
// trap picks). A true modal in the .set-editor pattern: a scrim,
// role="dialog" aria-modal="true", Escape stopped on the dialog, and a
// document Escape that closes it when the focus is outside it (on <body>
// after a repaint) and nothing is on top of it.
//
// Every node is built with createElement and every string set with
// textContent: what the modal shows of a server (its labels, help, the
// reasons it is refused, its answer) is data, never markup — the studio has
// no Content-Security-Policy, so one slip would be script on its origin. The
// only innerHTML this file assigns is the host's emptying (pinned by
// server/test-authz.mjs).
//
// Inputs carry data-field, never name, and there is no <form>: nothing a
// browser fills from a saved login or submits natively. No input is ever
// given a value here: what the reader types stays in the inputs, which the
// controller (studio/app.mjs) reads at send and empties.
//
// Rendered again with the same `model.key`, only the status line, the
// primary's state, the actions' notes, the outcome, the extra buttons, the
// generic form's field names and the settings policy's findings are
// patched: what was typed, a ticked acknowledgement and the focus stay. The
// actions go to host.mcpSettings: close, send, action(name), retry,
// useGeneric, input, generic, ack, test, openLive.

import { host as appHost } from './host.mjs';

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

const act = (host) => host?.mcpSettings || {};

export function renderServerSettings(container, model, host = appHost) {
  if (!container) return;
  const mounted = container.querySelector('.mss');
  if (mounted && mounted.getAttribute('data-mss-key') === model.key) {
    patch(container, model, host);
    return;
  }
  container.innerHTML = '';
  const scrim = el('div', 'mss-scrim');
  scrim.setAttribute('data-mss-close', '');
  scrim.setAttribute('aria-hidden', 'true');
  scrim.addEventListener('click', () => act(host).close?.());
  const dialog = el('div', 'mss');
  for (const [k, v] of Object.entries({ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mss-title', 'aria-describedby': 'mss-status', tabindex: '-1', 'data-mss-key': model.key })) dialog.setAttribute(k, v);
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    act(host).close?.();
  });

  const head = el('header', 'mss-head');
  head.append(el('span', 'mss-eyebrow', model.eyebrow));
  const title = el('h2', 'mss-title', 'Server settings');
  title.id = 'mss-title';
  head.append(title);
  const close = el('button', 'mss-close');
  close.type = 'button';
  close.setAttribute('data-mss-close', '');
  close.setAttribute('aria-label', 'Close server settings (Esc)');
  const esc = el('span', null, 'esc');
  esc.setAttribute('aria-hidden', 'true');
  close.append(esc);
  close.addEventListener('click', () => act(host).close?.());
  head.append(close);
  dialog.append(head);

  if (model.lede) dialog.append(el('p', 'mss-lede', model.lede));

  if (model.fields) dialog.append(formOf(model, host));

  const foot = el('footer', 'mss-foot');
  const status = el('div', 'mss-status');
  status.id = 'mss-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  foot.append(status);
  if (model.primary) {
    const actions = el('div', 'mss-actions');
    const primary = el('button', 'mss-primary', model.primary.label);
    primary.type = 'button';
    primary.addEventListener('click', () => act(host).send?.());
    actions.append(primary);
    foot.append(actions);
  }
  if (model.actions?.length) {
    const wrap = el('div', 'mss-server-actions');
    for (const a of model.actions) {
      const row = el('div', 'mss-server-action');
      row.setAttribute('data-action-row', a.name);
      const b = el('button', 'mss-action', a.label);
      b.type = 'button';
      b.setAttribute('data-action', a.name);
      b.addEventListener('click', () => act(host).action?.(a.name));
      row.append(b, el('span', 'mss-action-note'), el('p', 'mss-action-confirm'));
      wrap.append(row);
    }
    foot.append(wrap);
  }
  foot.append(el('div', 'mss-more'));
  const outcome = el('section', 'mss-outcome');
  outcome.setAttribute('aria-labelledby', 'mss-outcome-title');
  outcome.hidden = true;
  foot.append(outcome);
  dialog.append(foot);

  container.append(scrim, dialog);
  bindDocumentEscape(container, host);
  patch(container, model, host);
  const first = dialog.querySelector('input');
  if (first) first.focus();
  else { status.setAttribute('tabindex', '-1'); status.focus(); }
}

function formOf(model, host) {
  const form = el('div', 'mss-form');
  form.setAttribute('role', 'group');
  form.setAttribute('aria-labelledby', 'mss-title');
  model.fields.forEach((f, i) => {
    const label = el('label', f.type === 'boolean' ? 'mss-field is-check' : 'mss-field');
    const key = el('span', 'mss-field-key', f.label);
    if (f.required) { key.append(' '); key.append(el('span', 'mss-req', 'required')); }
    const input = document.createElement('input');
    input.type = f.spec.type;
    for (const [k, v] of Object.entries(f.spec.attrs)) input.setAttribute(k, v);
    input.className = 'mss-input';
    input.addEventListener('input', () => act(host).input?.());
    input.addEventListener('change', () => act(host).input?.());
    if (f.type !== 'boolean') {
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        act(host).send?.();
      });
    }
    if (f.type === 'boolean') label.append(input, key);
    else label.append(key, input);
    if (f.help) {
      const help = el('span', 'mss-help', f.help);
      help.id = `mss-help-${i}`;
      input.setAttribute('aria-describedby', help.id);
      label.append(help);
    }
    form.append(label);
  });
  if (model.generic) form.append(genericOf(model.generic, host));
  const policy = el('div', 'mss-policy');
  policy.setAttribute('aria-live', 'polite');
  form.append(policy);
  return form;
}

// "What the server expects": the generic form's field names, path and where
// the API key goes — editable here, never kept.
function genericOf(g, host) {
  const box = el('details', 'mss-generic');
  box.append(el('summary', 'mss-generic-summary', 'What the server expects'));
  const grid = el('div', 'mss-generic-grid');
  const row = (labelText, attr, value) => {
    const label = el('label', 'mss-field');
    label.append(el('span', 'mss-field-key', labelText));
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'mss-input';
    for (const [k, v] of Object.entries({ 'data-generic': attr, maxlength: '128', autocomplete: 'off', spellcheck: 'false', 'data-1p-ignore': '', 'data-lpignore': 'true', 'data-bwignore': '' })) input.setAttribute(k, v);
    input.value = value;
    input.addEventListener('input', () => act(host).generic?.());
    label.append(input);
    grid.append(label);
  };
  row('Settings path', 'path', g.path);
  row('Backend URL field name', 'url', g.names.url);
  row('User field name', 'user', g.names.user);
  row('Password field name', 'secret', g.names.secret);
  row('API key field name', 'apiKey', g.names.apiKey);
  const fs = el('fieldset', 'mss-generic-auth');
  fs.append(el('legend', 'mss-field-key', 'API key goes in'));
  for (const [value, text] of [['body', 'the body'], ['bearer', 'Authorization: Bearer']]) {
    const label = el('label', 'mss-radio');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'mss-generic-auth';
    input.value = value;
    input.setAttribute('data-generic', 'auth');
    input.checked = g.auth === value;
    input.addEventListener('change', () => act(host).generic?.());
    label.append(input, el('span', null, text));
    fs.append(label);
  }
  grid.append(fs);
  box.append(grid);
  box.append(el('p', 'mss-generic-why'));
  return box;
}

function patch(container, model, host) {
  const status = container.querySelector('#mss-status');
  if (status) {
    status.textContent = model.status?.text ?? '';
    status.className = `mss-status${model.status?.kind ? ` is-${model.status.kind}` : ''}`;
  }
  const form = container.querySelector('.mss-form');
  if (form) {
    for (const input of form.querySelectorAll('input[data-field]')) input.disabled = !!model.busy;
    if (model.fields) {
      const inputs = [...form.querySelectorAll('input[data-field]')];
      model.fields.forEach((f, i) => { if (inputs[i] && inputs[i].getAttribute('data-field') !== f.name) inputs[i].setAttribute('data-field', f.name); });
    }
    const why = form.querySelector('.mss-generic-why');
    if (why) why.textContent = model.generic?.reason ?? '';
    const policy = form.querySelector('.mss-policy');
    if (policy) paintPolicy(policy, model.policy ?? [], host);
    for (const tick of form.querySelectorAll('input[data-ack]')) tick.disabled = !!model.busy;
  }
  const primary = container.querySelector('.mss-primary');
  if (primary && model.primary) {
    primary.textContent = model.primary.label;
    if (model.primary.blocked || model.busy) primary.setAttribute('aria-disabled', 'true'); else primary.removeAttribute('aria-disabled');
    primary.classList.toggle('is-unavailable', !!model.primary.blocked);
  }
  for (const a of model.actions ?? []) {
    const row = container.querySelector(`[data-action-row="${CSS.escape(a.name)}"]`);
    if (!row) continue;
    const b = row.querySelector('.mss-action');
    b.textContent = a.confirming ? `Confirm: ${a.label}` : a.label;
    if (model.busy || a.blocked) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
    row.querySelector('.mss-action-note').textContent = a.note ?? '';
    const confirm = row.querySelector('.mss-action-confirm');
    confirm.textContent = a.confirming && a.confirm ? a.confirm : '';
    confirm.hidden = !(a.confirming && a.confirm);
  }
  const more = container.querySelector('.mss-more');
  if (more) {
    const want = (model.buttons ?? []).join(',');
    if (more.getAttribute('data-buttons') !== want) {
      more.textContent = '';
      more.setAttribute('data-buttons', want);
      for (const id of model.buttons ?? []) {
        const spec = BUTTONS[id];
        if (!spec) continue;
        const b = el('button', 'mss-more-btn', spec.label);
        b.type = 'button';
        b.setAttribute('data-mss', id);
        b.addEventListener('click', () => act(host)[spec.action]?.());
        more.append(b);
      }
    }
  }
  const outcome = container.querySelector('.mss-outcome');
  if (outcome) paintOutcome(outcome, model.outcome);
}

// The settings policy's findings (A.3.4), one block per rule in rule order:
// the word "Policy:", the rule's warning and its notes, then its
// acknowledgement box. A rule still found keeps its block and its box as
// they are (ticked stays ticked); a rule no longer found loses both, so a
// rule found again brings its box back unticked. The ticks live in these
// boxes only — the host empties them on close.
function paintPolicy(slot, rules, host) {
  const want = new Set(rules.map((r) => String(r.rule)));
  for (const box of [...slot.children]) if (!want.has(box.getAttribute('data-rule'))) box.remove();
  let prev = null;
  for (const r of rules) {
    const id = String(r.rule);
    let box = [...slot.children].find((b) => b.getAttribute('data-rule') === id);
    if (!box) {
      box = el('div', 'mss-rule');
      box.setAttribute('data-rule', id);
      const warn = el('div', 'mss-warn');
      warn.setAttribute('role', 'note');
      box.append(warn);
      if (r.ack) {
        const label = el('label', 'mss-ack');
        const tick = document.createElement('input');
        tick.type = 'checkbox';
        tick.setAttribute('data-ack', id);
        tick.addEventListener('change', () => act(host).ack?.());
        label.append(tick, el('span', 'mss-ack-text', r.ack));
        box.append(label);
      }
    }
    const warn = box.querySelector('.mss-warn');
    const sig = JSON.stringify([r.warn, r.notes]);
    if (warn.getAttribute('data-sig') !== sig) {
      warn.setAttribute('data-sig', sig);
      warn.textContent = '';
      const line = el('p', 'mss-warn-line');
      line.append(el('span', 'mss-warn-key', 'Policy:'), ' ', el('span', 'mss-warn-text', r.warn));
      warn.append(line);
      for (const note of r.notes) warn.append(el('p', 'mss-warn-note', note));
    }
    const at = prev ? prev.nextElementSibling : slot.firstElementChild;
    if (at !== box) slot.insertBefore(box, at);
    prev = box;
  }
}

const BUTTONS = Object.freeze({
  retry: { label: 'Try again', action: 'retry' },
  generic: { label: 'Use the generic form', action: 'useGeneric' },
  test: { label: 'Test the connection', action: 'test' },
  openLive: { label: 'Open the live panel', action: 'openLive' },
});

// The server's answer, as returned (redacted), as text — or, through the
// studio server, its outcome shape and the note that no other body passes.
function paintOutcome(section, o) {
  const key = o ? o.serial : '';
  if (section.getAttribute('data-outcome') === String(key)) return;
  section.setAttribute('data-outcome', String(key));
  section.textContent = '';
  section.hidden = !o;
  if (!o) return;
  const title = el('h3', 'mss-outcome-title', 'What the server answered');
  title.id = 'mss-outcome-title';
  section.append(title);
  if (o.message) section.append(el('p', 'mss-outcome-message', o.message));
  if (o.checks?.length) {
    const ul = el('ul', 'mss-checks');
    for (const c of o.checks) {
      const li = el('li', 'mss-check');
      li.append(el('span', 'mss-check-label', c.label), el('span', `mss-check-status is-${c.status}`, c.status));
      if (c.detail) li.append(el('span', 'mss-check-detail', c.detail));
      ul.append(li);
    }
    section.append(ul);
  }
  if (o.note) section.append(el('p', 'mss-outcome-note', o.note));
  if (o.redacted > 0) section.append(el('p', 'mss-outcome-note', `${o.redacted} value${o.redacted === 1 ? '' : 's'} the server echoed back ${o.redacted === 1 ? 'was' : 'were'} hidden.`));
  if (o.raw) {
    const details = el('details', 'mss-raw');
    details.open = o.tone === 'error';
    details.append(el('summary', 'mss-raw-summary', 'The body as returned'));
    details.append(el('pre', 'mss-raw-body', o.raw));
    section.append(details);
  }
  if (o.capped) section.append(el('p', 'mss-outcome-note', o.capped === 'read' ? 'The answer was longer than 64 KiB; the studio read the first 64 KiB.' : 'The answer is longer than 8 KiB; the first 8 KiB are shown.'));
}

// One document listener per host (bound once; idle while nothing is
// mounted): Escape closes the modal when the focus is outside it and no
// other modal is on top of it.
const DOC_ESC = new WeakMap();
function bindDocumentEscape(container, host) {
  const bound = DOC_ESC.has(container);
  DOC_ESC.set(container, host);
  if (bound) return;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const dialog = container.querySelector('.mss');
    if (!dialog || (e.target && dialog.contains(e.target))) return;
    const open = document.querySelectorAll('[role="dialog"]:not([hidden]):not([aria-modal="false"])');
    if (open.length && open[open.length - 1] !== dialog) return;
    e.preventDefault();
    e.stopPropagation();
    act(DOC_ESC.get(container)).close?.();
  });
}
