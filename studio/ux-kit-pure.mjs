// studio/ux-kit-pure.mjs — the part of the screen grammar that reads no
// studio state (docs/VENDORING.md, "The Overview board").
//
// studio/ux-kit.mjs re-exports everything here, so the studio's own views
// keep importing from the kit. A downstream that vendors the Overview board
// copies this file instead of the kit: its one import is `escapeHtml` from
// util.mjs — the same one-line stub docs/VENDORING.md names for
// verdict-ui.mjs (any HTML escaper satisfies it).
//
//   GLOSSARY, termHtml   the plain-language glossary and the inline term
//   disclosureHtml       collapsed reference material (<details>)
//   emptyStateHtml       an empty state that says what was checked
//   wireUxActions        [data-ux-action] clicks → handlers (one listener per root)

import { escapeHtml } from './util.mjs';

// ---------- the glossary ----------
//
// The review's wording table (docs/UX_SCREEN_GRAMMAR.md §4) plus the studio's
// recurring formal terms. The glossary is the ONE place an explanation lives;
// labels link to it with termHtml instead of repeating a paragraph in every
// panel.
export const GLOSSARY = {
  'diagnostic-grade': { term: 'Diagnostic grade', plain: 'Assessment', def: 'A letter grade for how well the pack is backed by evidence and how closely it matches the selected baseline. It combines coverage, trust and the audit gate.' },
  coverage:     { term: 'Coverage', plain: 'Coverage', def: 'How much of the service the pack observes: the grade’s coverage checks (signal types, correlation, calibration, breadth) that pass.' },
  trust:        { term: 'Trust', plain: 'Trust', def: 'The share of this pack’s claims backed by live evidence rather than declaration alone.' },
  'audit-gate': { term: 'Audit gate', plain: 'Audit requirement', def: 'The minimum evidence the tier requires. A pack can have live signals and still fail it when required evidence is incomplete.' },
  baseline:     { term: 'Target', plain: 'Selected baseline', def: 'The pack you are comparing against — usually the curated repository pack.' },
  retrofeed:    { term: 'Retrofeed', plain: 'Update repository from live', def: 'Copies signals that exist on the live platform into the repository pack, as a patch you review and commit.' },
  deploy:       { term: 'Deploy', plain: 'Deploy repository changes to live', def: 'Pushes compiled artefacts from the pack to a live backend (for example Grafana).' },
  reconcile:    { term: 'Reconcile', plain: 'Review differences individually', def: 'Walk each difference between repository and live and decide per item.' },
  bidirectional:{ term: 'Bidirectional', plain: 'Sync in both directions', def: 'Deploy repository-only items and adopt live-only items in one plan.' },
  scaffold:     { term: 'Scaffold', plain: 'Template value needs completion', def: 'A value generated from a template so the requirement is represented; a person must supply the real value.' },
  placeholder:  { term: 'Pass on a placeholder', plain: 'Requirement represented; real value still needed', def: 'The rubric clause is satisfied structurally, but by a template value, not a real one.' },
  conformant:   { term: 'Conformant', plain: 'Meets tier rubric', def: 'Every MUST clause for the tier is satisfied — possibly on placeholders. It says nothing about deployment readiness.' },
  jaccard:      { term: 'Jaccard similarity', plain: 'Overlap', def: 'Shared artefacts divided by all artefacts in either pack. Useful to spot two packs that describe different things; the counts are usually more telling.' },
  tier:         { term: 'Criticality tier', plain: 'Criticality', def: 'How critical the service is. Higher tiers require more objectives, signals and alerting.' },
  sli:          { term: 'SLI', plain: 'Service level indicator', def: 'A measurement of how the service behaves, such as the ratio of good requests.' },
  slo:          { term: 'SLO', plain: 'Service level objective', def: 'The target for an SLI over a window, such as 99.9% good over 30 days.' },
  vantage:      { term: 'Vantage point', plain: 'Where the check observes from', def: 'The probe or MCP endpoint a Neuron journey uses to see the platform. When it is lost the check cannot observe, which is different from the check failing.' },
};

// An inline term: the plain wording, with the formal term and definition on
// hover/focus. `text` overrides the visible words.
export function termHtml(key, text = null) {
  const g = GLOSSARY[key];
  if (!g) return escapeHtml(text ?? key);
  const shown = text ?? g.plain;
  const formal = g.term !== shown ? `${g.term}: ` : '';
  return `<span class="ux-term" tabindex="0" title="${escapeHtml(formal + g.def)}">${escapeHtml(shown)}</span>`;
}

// ---------- actions ----------

// Route [data-ux-action] clicks inside root to handlers[action](event, el).
// Idempotent per root: a re-render replaces the markup, the listener stays.
export function wireUxActions(root, handlers = {}) {
  if (!root) return;
  root._uxHandlers = handlers;
  if (root._uxWired) return;
  root._uxWired = true;
  root.addEventListener('click', (ev) => {
    const el = ev.target?.closest?.('[data-ux-action]');
    if (!el || !root.contains(el)) return;
    const fn = root._uxHandlers?.[el.dataset.uxAction];
    if (fn) { ev.preventDefault(); fn(ev, el); }
  });
}

// ---------- empty states that explain ----------
//
// title:   what the empty result means, in plain words
// checked: what scope was checked (so "nothing" is not mistaken for "not run")
// actions: [{ id?, action?, label }] — the relevant next steps
export function emptyStateHtml({ title, checked = '', body = '', actions = [], tone = 'neutral' } = {}) {
  return `
    <div class="ux-empty ux-tone-${escapeHtml(tone)}" role="note">
      <p class="ux-empty-title">${escapeHtml(title)}</p>
      ${checked ? `<p class="ux-empty-checked"><span class="ux-empty-key">Checked:</span> ${escapeHtml(checked)}</p>` : ''}
      ${body ? `<p class="ux-empty-body">${escapeHtml(body)}</p>` : ''}
      ${actions.length ? `<div class="ux-empty-actions">${actions.map(a => `<button type="button" class="ux-secondary-btn"${a.id ? ` id="${escapeHtml(a.id)}"` : ''}${a.action ? ` data-ux-action="${escapeHtml(a.action)}"` : ''}>${escapeHtml(a.label)}</button>`).join('')}</div>` : ''}
    </div>`;
}

// ---------- reference material, collapsed ----------

export function disclosureHtml(summary, bodyHtml, { open = false, cls = '' } = {}) {
  return `<details class="ux-disclosure${cls ? ` ${escapeHtml(cls)}` : ''}"${open ? ' open' : ''}><summary>${escapeHtml(summary)}</summary><div class="ux-disclosure-body">${bodyHtml}</div></details>`;
}
