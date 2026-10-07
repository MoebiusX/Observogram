// studio/live-view.mjs
//
// The renderer of the live MCP connection's result (rebadge batch 3, C2):
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
