// studio/glossary.mjs — the glossary marks (GAP batch 2, B3.4): a definition
// beside the label it explains, sourced from the taxonomy file's v2
// `glossary` section (tools/lib/artefact-classify.mjs, bound through
// studio/taxonomy.mjs). Pure HTML builders plus one DOM wiring; no fetch,
// no state, no clock. Imports escapeHtml and the taxonomy passthroughs only.
//
// The mark is a toggletip, not a tooltip: a real <button> (keyboard
// reachable, a name of its own — "What is <term>?"), aria-expanded,
// aria-controls and aria-describedby on the definition, which is `hidden`
// until opened. Hover and :focus-visible preview it through CSS (ux.css
// `.ux-gloss*`) so nothing is hover-only: a click or Enter/Space opens it
// for good, Escape closes it (and is swallowed only when it closed a mark —
// the drawer's own Escape, studio/app.mjs, stays untouched otherwise), a
// click elsewhere closes it. The definition is text; `link` is an anchor
// for the operator's http(s) URL only (the classifier refuses anything
// else), opened in a new tab.
//
// The byte-identity rule every call site rests on: with no matching entry —
// no glossary bound (a v1 file, no file, before boot), or a label the
// glossary does not know — glossaryLabelHtml(text) === escapeHtml(text),
// glossaryMarkFor() === '' and glossaryGroupMarkHtml() === ''. The 24
// board goldens and tools/test-discover-rows.mjs pin it; wireGlossary()
// returns before touching anything when a root holds no mark.

import { escapeHtml } from './util.mjs';
import { glossaryFor, glossaryByText, familiesAt } from './taxonomy.mjs';

// ---------- ids ----------

// Each mark's definition carries an id the button points at. The counter
// is module state so a render is deterministic from a known start: the
// golden-board gate calls resetGlossaryIds() before rendering.
let seq = 0;
export function resetGlossaryIds() { seq = 0; }
const nextId = () => `ux-gloss-${++seq}`;

// ---------- lookups ----------

/**
 * The entry for a label: the family's entry when `family` names one, else
 * the entry whose term or alias is the text; null when nothing matches.
 */
export function glossaryEntryFor(text, { family = null } = {}) {
  return (family ? glossaryFor(family) : null) || glossaryByText(text) || null;
}

/**
 * The entry for a Discover board group: the first family whose home is that
 * group and that has an entry, else the group's title as a term or alias.
 */
export function glossaryEntryForGroup(layerId, groupId, title) {
  for (const family of familiesAt(layerId, groupId)) {
    const e = glossaryFor(family);
    if (e) return e;
  }
  return glossaryByText(title) || null;
}

// ---------- the mark ----------

/**
 * One toggletip for `entry` (a compiled glossary entry); '' for none.
 * `label` is what the mark explains, for the button's name.
 */
export function glossaryMarkHtml(entry, { label = entry?.term } = {}) {
  if (!entry || typeof entry.term !== 'string' || typeof entry.definition !== 'string') return '';
  const id = nextId();
  const what = String(label || entry.term);
  const link = typeof entry.link === 'string' && /^https?:\/\//i.test(entry.link)
    ? ` <a class="ux-gloss-link" href="${escapeHtml(entry.link)}" target="_blank" rel="noopener noreferrer">Learn more<span class="sr-text"> about ${escapeHtml(entry.term)} (opens in a new tab)</span></a>`
    : '';
  return `<span class="ux-gloss"><button type="button" class="ux-gloss-btn" aria-label="${escapeHtml(`What is ${what}?`)}" aria-expanded="false" aria-controls="${id}" aria-describedby="${id}">?</button><span class="ux-gloss-def" id="${id}" role="note" hidden><strong class="ux-gloss-term">${escapeHtml(entry.term)}</strong> <span class="ux-gloss-text">${escapeHtml(entry.definition)}</span>${link}</span></span>`;
}

/** The mark for a label, or '' — the escaped label itself is the caller's. */
export function glossaryMarkFor(text, { family = null } = {}) {
  const e = glossaryEntryFor(text, { family });
  return e ? glossaryMarkHtml(e, { label: text }) : '';
}

/** The escaped label followed by its mark; === escapeHtml(text) when nothing matches. */
export function glossaryLabelHtml(text, { family = null } = {}) {
  return `${escapeHtml(text)}${glossaryMarkFor(text, { family })}`;
}

/** The mark for a board group's title, or ''. */
export function glossaryGroupMarkHtml(layerId, groupId, title) {
  const e = glossaryEntryForGroup(layerId, groupId, title);
  return e ? glossaryMarkHtml(e, { label: title }) : '';
}

// ---------- the wiring ----------

const OPEN = '.ux-gloss-btn[aria-expanded="true"]';

function setOpen(btn, open) {
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  const def = btn.nextElementSibling;
  if (def && def.classList.contains('ux-gloss-def')) def.hidden = !open;
}

/** Close every open mark under `root`; returns how many were open. */
export function closeGlossaryMarks(root) {
  const open = root?.querySelectorAll?.(OPEN) || [];
  for (const btn of open) setOpen(btn, false);
  return open.length;
}

/**
 * Wire the marks under `root` once: a click on a mark toggles it (closing
 * any other), Escape closes the open one and gives the focus back to its
 * button — and is stopped there, so the drawer or a modal above does not
 * close too; with no mark open the key passes untouched — and a click
 * anywhere else under the root closes them. Returns false when the root
 * holds no mark (nothing is wired, nothing is listened to).
 */
export function wireGlossary(root) {
  if (!root || typeof root.querySelector !== 'function' || !root.querySelector('.ux-gloss-btn')) return false;
  if (root.dataset && root.dataset.uxGlossWired === '1') return true;
  if (root.dataset) root.dataset.uxGlossWired = '1';
  root.addEventListener('click', (ev) => {
    const btn = ev.target?.closest?.('.ux-gloss-btn');
    if (btn && root.contains(btn)) {
      ev.preventDefault();
      ev.stopPropagation();
      const open = btn.getAttribute('aria-expanded') === 'true';
      closeGlossaryMarks(root);
      if (!open) setOpen(btn, true);
      return;
    }
    if (ev.target?.closest?.('.ux-gloss-def')) return;   // reading the definition (or following its link) keeps it open
    closeGlossaryMarks(root);
  });
  root.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const open = root.querySelector(OPEN);
    if (!open) return;                                     // untouched: the drawer's Escape is next in line
    closeGlossaryMarks(root);
    ev.preventDefault();
    ev.stopPropagation();
    open.focus?.();
  });
  return true;
}

// ---------- the proof helper ----------

/**
 * `html` with every mark removed — a balanced walk over the `<span`/`</span>`
 * tags from each `<span class="ux-gloss">`, so a definition's own spans and
 * anchor go with it. The golden gate asserts stripGlossaryMarks(board with a
 * glossary) === the board without one.
 */
export function stripGlossaryMarks(html) {
  const MARK = '<span class="ux-gloss">';
  let out = String(html);
  let at = out.indexOf(MARK);
  while (at >= 0) {
    let depth = 0;
    let i = at;
    let end = -1;
    const re = /<span\b|<\/span>/g;
    re.lastIndex = at;
    for (let m = re.exec(out); m; m = re.exec(out)) {
      if (m[0] === '</span>') { depth--; if (depth === 0) { end = m.index + m[0].length; break; } } else depth++;
      i = m.index;
    }
    if (end < 0) throw new Error(`stripGlossaryMarks: an unbalanced mark at ${at} (${i})`);
    out = out.slice(0, at) + out.slice(end);
    at = out.indexOf(MARK, at);
  }
  return out;
}
