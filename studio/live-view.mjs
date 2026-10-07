// studio/live-view.mjs
//
// The renderers of the live MCP connection's result (rebadge batch 3, C2)
// and of the live panel's gate log and job result (C1):
// render(container, model, host) over pingResultModel's model
// (studio/live-model.mjs) — no state read, no fetch (docs/UI_CONVENTIONS.md
// §2–3). Every string the MCP or the server supplied — the sentence, the
// tool names, the checked and not-checked lines — reaches the DOM through
// textContent, never as markup. Zone `.mcpc-*` (studio/app.css, the "Live
// MCP connection" block the AA scan reads). A null model empties and hides
// the container: a result never describes a target other than the one shown.

import { host as appHost } from './host.mjs';

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

export function renderPingResult(container, model, host = appHost) {
  void host;
  if (!container) return;
  container.replaceChildren();
  if (!model) { container.hidden = true; return; }
  container.hidden = false;
  container.dataset.verdict = model.verdict;
  container.append(el('p', 'mcpc-sentence', model.sentence));
  if (model.timings) container.append(el('p', 'mcpc-meta', model.timings));
  if (model.toolsLine) container.append(el('p', 'mcpc-meta', model.toolsLine));
  if (model.readLine) container.append(el('p', 'mcpc-meta', model.readLine));
  if (model.reads.length) {
    const list = el('ul', 'mcpc-reads');
    list.setAttribute('aria-label', 'What this MCP offers that a fetch reads');
    for (const r of model.reads) {
      const li = el('li', 'mcpc-read');
      li.append(el('span', 'mcpc-read-label', r.label), document.createTextNode(' '));
      r.tools.forEach((t, i) => {
        if (i) li.append(document.createTextNode(', '));
        li.append(el('code', 'mcpc-tool', t));
      });
      list.append(li);
    }
    container.append(list);
  }
  if (model.notOffered) container.append(el('p', 'mcpc-gaps', model.notOffered));
  if (model.checked.length || model.notChecked.length) {
    const details = el('details', 'mcpc-unchecked');
    details.append(el('summary', 'mcpc-unchecked-summary', 'What this did not check'));
    if (model.notChecked.length) {
      const ul = el('ul', 'mcpc-lines');
      for (const line of model.notChecked) ul.append(el('li', null, line));
      details.append(ul);
    }
    if (model.checked.length) {
      details.append(el('p', 'mcpc-meta', 'What it checked:'));
      const ul = el('ul', 'mcpc-lines');
      for (const line of model.checked) ul.append(el('li', null, line));
      details.append(ul);
    }
    container.append(details);
  }
}

// The gate log (gateLogModel's rows): one item per stage — an icon and a
// state word (never colour alone), the label, the counts, the message or
// the gap, each by textContent.
export function renderGateLog(container, rows, host = appHost) {
  void host;
  if (!container) return;
  container.replaceChildren();
  for (const r of rows) {
    const li = el('li', 'mcpc-stage');
    li.dataset.stage = r.id;
    li.dataset.state = r.state;
    li.append(el('span', 'mcpc-stage-icon', r.icon));
    li.lastChild.setAttribute('aria-hidden', 'true');
    li.append(el('span', 'mcpc-stage-label', r.label), el('span', 'mcpc-stage-word', r.word));
    if (r.counts) li.append(el('span', 'mcpc-meta', r.counts));
    if (r.message) li.append(el('span', 'mcpc-stage-message', r.message));
    container.append(li);
  }
}

// A finished job (liveResultModel's model, or { gone: true, sentence }):
// the sentence, and for a registered pack "open it" and, when a Pack A is
// on screen, "compare with <Pack A>". A null model hides the block.
//   actions: { onOpen(id), onCompare(id), compareWith: label | null }
export function renderLiveResult(container, model, actions = {}, host = appHost) {
  void host;
  if (!container) return;
  container.replaceChildren();
  if (!model) { container.hidden = true; return; }
  container.hidden = false;
  container.dataset.state = model.state;
  container.append(el('p', 'mcpc-sentence', model.sentence));
  if (model.registered) {
    const bar = el('div', 'crawl-panel-actions');
    const open = el('button', 'mcp-refresh-btn', 'open it');
    open.type = 'button';
    open.id = 'live-open-btn';
    open.onclick = () => actions.onOpen?.(model.registered.id);
    bar.append(open);
    if (actions.compareWith) {
      const cmp = el('button', 'ctrl-btn', `compare with ${actions.compareWith}`);
      cmp.type = 'button';
      cmp.id = 'live-compare-btn';
      cmp.onclick = () => actions.onCompare?.(model.registered.id);
      bar.append(cmp);
    }
    container.append(bar);
  }
}
