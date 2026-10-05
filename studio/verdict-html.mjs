// studio/verdict-html.mjs — the pure HTML of a reviewer's verdict (GAP batch
// 2, B3.1): the badge the Discover board draws on an item, the chip a row
// draws beside its status chips, the Refine control's Verdict filter and
// its predicate. No state, no fetch, no DOM: `verdict` is the VerdictView
// the server serves (docs/ADAPTER.md "Verdicts — a reviewer's record per
// artefact") or null, and null renders NOTHING — the byte-identity every
// board golden rests on (tools/test-golden-board.mjs renders entries
// without a verdict). Imports util.mjs and ux-kit.mjs only, so a
// downstream studio can vendor it with the board (docs/VENDORING.md).
//
// A verdict is a reviewer's trust record — trusted · suspect · failed, with
// `unreviewed` the absence of one. Diagnose's "verdict" (studio/verdict-ui.mjs)
// is the engine's grade; this module never reads it and never sums anything.

import { escapeHtml } from './util.mjs';
import { statusChipHtml, statusRecord } from './ux-kit.mjs';

export const VERDICT_STATUSES = Object.freeze(['trusted', 'suspect', 'failed']);

// The Refine control's options: every status, and the absence of one.
export const VERDICT_FILTERS = Object.freeze([
  { id: 'all', label: 'Any verdict' },
  { id: 'trusted', label: 'Trusted' },
  { id: 'suspect', label: 'Suspect' },
  { id: 'failed', label: 'Failed' },
  { id: 'unreviewed', label: 'Unreviewed' },
]);

const isVerdict = (v) => !!v && VERDICT_STATUSES.includes(v.status);

// "Trusted — the window is short (ada, 2026-10-05)": the tooltip of both marks.
export function verdictTip(verdict) {
  const r = statusRecord('verdict', verdict.status);
  const when = typeof verdict.setAt === 'string' ? verdict.setAt.slice(0, 10) : '';
  const who = [verdict.actor, when].filter(Boolean).join(', ');
  return `Verdict: ${r ? r.label : verdict.status}${verdict.reason ? ` — ${verdict.reason}` : ''}${who ? ` (${who})` : ''}${verdict.carriedFrom ? ' · carried from an earlier upload' : ''}`;
}

// The board's badge: a small mark on an item, the status in its colour
// (data-verdict), the record in the tooltip. '' without a verdict.
export function verdictBadgeHtml(verdict) {
  if (!isVerdict(verdict)) return '';
  const r = statusRecord('verdict', verdict.status);
  return `<span class="dvb-verdict" data-verdict="${escapeHtml(verdict.status)}" title="${escapeHtml(verdictTip(verdict))}">`
    + `<span class="sr-text">Verdict: </span>${escapeHtml(r ? r.label : verdict.status)}</span>`;
}

// The row's chip: the fifth status property's chip (ux-kit), the reason and
// the reviewer in the tooltip. '' without a verdict.
export function verdictChipHtml(verdict, { short = false } = {}) {
  if (!isVerdict(verdict)) return '';
  const when = typeof verdict.setAt === 'string' ? verdict.setAt.slice(0, 10) : '';
  const extraTip = [verdict.reason ? `Reason: ${verdict.reason}.` : '', verdict.actor ? `Recorded by ${verdict.actor}${when ? ` on ${when}` : ''}.` : ''].filter(Boolean).join(' ');
  return statusChipHtml('verdict', verdict.status, { extraTip, ...(short ? { label: statusRecord('verdict', verdict.status)?.label } : {}) });
}

// The Refine control's Verdict select; `counts` ({ trusted, suspect,
// failed, unreviewed }) labels each option with how many artefacts it keeps.
export function verdictFilterHtml(value = 'all', counts = {}) {
  const current = VERDICT_FILTERS.some((f) => f.id === value) ? value : 'all';
  return `<label class="dv-refine-verdict">
        <span class="dv-refine-label">Verdict</span>
        <select class="dv-refine-select dv-refine-verdict-select" aria-describedby="dv-refine-hint">
          ${VERDICT_FILTERS.map((f) => `<option value="${f.id}"${f.id === current ? ' selected' : ''}>${escapeHtml(f.label)}${f.id !== 'all' && Number.isInteger(counts[f.id]) ? ` (${counts[f.id]})` : ''}</option>`).join('')}
        </select>
      </label>`;
}

// Does an artefact with this verdict (or none) pass the filter?
export function passesVerdictFilter(verdict, filter = 'all') {
  if (!filter || filter === 'all') return true;
  if (filter === 'unreviewed') return !isVerdict(verdict);
  return isVerdict(verdict) && verdict.status === filter;
}
