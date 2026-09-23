// studio/util.mjs
//
// Small shared helpers used across the studio views: HTML escaping, the
// transient toast, and relative-time formatting. Leaf module — depends only
// on the $ DOM helper from state.mjs.

import { $ } from './state.mjs';

// Escape a value for safe interpolation into an HTML template string.
export function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// Transient status message in the bottom toast. kind: '' | 'error' | 'ok' …
export function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast' + (kind ? ' is-' + kind : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 4000);
}

// The dialogs the Tab trap covers: every open [role="dialog"] that does not
// declare itself non-modal. A panel with aria-modal="false" (the Build
// layer sheet: a side panel over the stack, the definition column and the
// other slab heads stay live) is left alone — Tab walks the page as usual
// and the panel keeps its own Esc and focus return.
export const TRAPPED_DIALOGS = '[role="dialog"]:not([hidden]):not([aria-modal="false"])';

// Keep keyboard focus inside the topmost open modal dialog. Installed once
// at boot; covers every trapped [role="dialog"] panel without per-dialog
// wiring. `doc` is the document (injectable for the headless test).
export function installDialogFocusTrap(doc = document) {
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const open = doc.querySelectorAll(TRAPPED_DIALOGS);
    const dialog = open[open.length - 1];
    if (!dialog) return;
    const focusables = [...dialog.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter(el => el.offsetParent !== null);
    if (!focusables.length) { e.preventDefault(); dialog.focus?.(); return; }
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (!dialog.contains(doc.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
    if (!e.shiftKey && doc.activeElement === last)       { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && doc.activeElement === first)  { e.preventDefault(); last.focus(); }
  });
}

// Hand the browser a file to save (a pack YAML, a compiled artefact).
export function downloadText(filename, text, contentType = 'text/plain') {
  const blob = new Blob([text], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// "5s ago" / "12m ago" / "3h ago" / "2d ago" from an ISO timestamp.
export function fmtRelative(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 90)        return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 90)        return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 36)       return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
