// studio/proto-view.mjs
//
// Gate for the Diagnose/Remediate redesign prototypes. ANY ?proto value
// activates prototype space; without the query param the production tabs
// render untouched. The maintainer's 2026-06-11 call: redesign stays in
// prototype space until ratified.
//
// Variants — ?proto=a | b | c picks an original divergent prototype
// (kept around while ideas are still being extracted from them);
// anything else (?proto=1, ?proto=s, …) lands on the synthesis.
//   A — verdict-first narrative      (proto-a.mjs)
//   B — mission-control grid         (proto-b.mjs)
//   C — guided flow / triage queue   (proto-c.mjs)
//   S — the consolidated synthesis   (proto-synthesis.mjs)

import { renderSynthDiagnose, renderSynthRemediate } from './proto-synthesis.mjs';
import { renderProtoDiagnoseA, renderProtoRemediateA } from './proto-a.mjs';
import { renderProtoDiagnoseB, renderProtoRemediateB } from './proto-b.mjs';
import { renderProtoDiagnoseC, renderProtoRemediateC } from './proto-c.mjs';

const VARIANTS = {
  a: { label: 'A', title: 'Prototype A — verdict-first narrative', diagnose: renderProtoDiagnoseA, remediate: renderProtoRemediateA },
  b: { label: 'B', title: 'Prototype B — mission-control grid', diagnose: renderProtoDiagnoseB, remediate: renderProtoRemediateB },
  c: { label: 'C', title: 'Prototype C — guided flow / triage queue', diagnose: renderProtoDiagnoseC, remediate: renderProtoRemediateC },
  s: { label: 'SYNTHESIS', title: 'The consolidated synthesis', diagnose: renderSynthDiagnose, remediate: renderSynthRemediate },
};

function activeVariant() {
  try {
    const v = (new URLSearchParams(window.location.search).get('proto') || '').toLowerCase();
    return VARIANTS[v] ? v : (v ? 's' : null);
  } catch (_) { return null; }
}

export function protoActive() { return activeVariant() !== null; }

export function renderProtoDiagnose(view) {
  mountSwitcher();
  view.classList.add('proto-host');
  VARIANTS[activeVariant() || 's'].diagnose(view);
}

export function renderProtoRemediate(view) {
  mountSwitcher();
  view.classList.add('proto-host');
  VARIANTS[activeVariant() || 's'].remediate(view);
}

// Floating pill, bottom-left (the toast lives bottom-right): one button
// per variant, one click exits back to production.
function mountSwitcher() {
  const current = activeVariant() || 's';
  const existing = document.getElementById('proto-switcher');
  if (existing) {
    if (existing.dataset.variant === current) return;
    existing.remove();
  }
  const el = document.createElement('nav');
  el.id = 'proto-switcher';
  el.className = 'proto-switcher';
  el.dataset.variant = current;
  el.setAttribute('aria-label', 'UX prototype switcher');
  const link = (v) =>
    `<a class="proto-switcher-btn${v === current ? ' is-active' : ''}" href="${window.location.pathname}?proto=${v}" title="${VARIANTS[v].title}">${VARIANTS[v].label}</a>`;
  el.innerHTML = `
    <span class="proto-switcher-key">PROTOTYPE</span>
    ${['a', 'b', 'c', 's'].map(link).join('')}
    <a class="proto-switcher-btn is-exit" href="${window.location.pathname}" title="Leave prototype mode — back to the production tabs">×</a>
  `;
  document.body.appendChild(el);
}
