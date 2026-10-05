// studio/verdicts.mjs — the studio's side of a reviewer's verdicts (GAP batch
// 2, B3.1): the per-pack load into state.verdicts (never persisted; a Map
// artefact id → VerdictView, or null when the server has none to say), the
// lookups the Discover board, the rows and the Refine control read, and the
// drawer's Verdict section — the record as it stands and, for whoever may
// record one, the form (PUT / DELETE /api/packs/:id/verdicts/:artefact
// through api(), so the CSRF header and the active org travel). Re-renders
// go through the host seam (host.mjs), never app.mjs.
//
// A verdict is a reviewer's trust record — trusted · suspect · failed, with
// `unreviewed` the absence of one. Diagnose's "verdict" (studio/verdict-ui.mjs)
// is the engine's grade; nothing here feeds it. Inert: with no verdicts
// (every catalogue pack, every pack nobody reviewed) nothing renders, and a
// server that cannot answer leaves the studio as it was (one console.warn).
//
// Who sees the form: in the open postures (no sign-in — /auth/me answers
// no identity) everyone; with sign-in, an operator or admin of the active
// org (`effectiveRole` of /auth/me's org list: an owner is an admin
// everywhere). A viewer reads the record. A pack that is not registered (a
// catalogue or example pack, or any pack of the static bundle) takes no
// verdict — the section says so and names the way (upload it) instead of
// showing a form the server would refuse.

import { state } from './state.mjs';
import { api, getActiveOrg } from './api.mjs';
import { host } from './host.mjs';
import { escapeHtml } from './util.mjs';
import { VERDICT_STATUSES, verdictChipHtml, verdictTip } from './verdict-html.mjs';

const REASON_MAX = 2000;
const warned = new Set();

// The body's `error` from an api() failure (`<status> <text> on <path>: {"ok":false,"error":"…"}`), else the message.
export function refusalText(e) {
  const m = /:\s*(\{[\s\S]*\})\s*$/.exec(e?.message || '');
  if (m) {
    try { const body = JSON.parse(m[1]); if (typeof body?.error === 'string') return body.error; } catch { /* not JSON */ }
  }
  return e?.message || String(e);
}

export function emptyVerdicts() {
  state.verdicts = null;
  state.verdictsPack = null;
}

// The pack's verdicts into state — a Map by artefact id, or null when the
// document is empty or the server could not answer. Never throws.
export async function loadVerdicts(packId) {
  emptyVerdicts();
  if (!packId) return null;
  try {
    const doc = await api(`/api/packs/${encodeURIComponent(packId)}/verdicts`);
    const rows = Array.isArray(doc?.verdicts) ? doc.verdicts.filter((v) => v && !v.orphaned) : [];
    state.verdictsPack = packId;
    state.verdicts = rows.length ? new Map(rows.map((v) => [v.artefact, v])) : null;
  } catch (e) {
    if (!warned.has(packId)) {
      warned.add(packId);
      console.warn(`verdicts: ${packId}: ${e.message}`);
    }
    state.verdicts = null;
    state.verdictsPack = packId;
  }
  return state.verdicts;
}

export function verdictOf(artefactId) {
  return state.verdicts?.get(artefactId) ?? null;
}

export function hasVerdicts() {
  return !!(state.verdicts && state.verdicts.size);
}

// The counts the Refine control labels its options with, over the given
// artefacts: { trusted, suspect, failed, unreviewed }.
export function verdictCounts(artefacts) {
  const counts = { trusted: 0, suspect: 0, failed: 0, unreviewed: 0 };
  for (const a of artefacts) {
    const v = verdictOf(a.id);
    counts[v && counts[v.status] !== undefined ? v.status : 'unreviewed']++;
  }
  return counts;
}

// The pack a verdict is recorded on: the selected pack (the catalogue id
// the server addresses), as the verdicts were loaded for.
function packIdForVerdicts() {
  return state.verdictsPack || state.selectedPackId || null;
}

// A registered pack (the upload registry's source word in the catalogue
// entry); a catalogue, example or bundled pack is not.
function packIsRegistered(packId) {
  const entry = (state.catalog || []).find((p) => p.id === packId);
  return entry?.source === 'uploaded';
}

// May the signed-in person (or anyone, without sign-in) record a verdict?
export function canRecordVerdict() {
  const me = state.identity;
  if (!me || me.authenticated !== true) return true;   // the open postures
  const org = getActiveOrg();
  const orgs = Array.isArray(me.orgs) ? me.orgs : [];
  const here = (org ? orgs.find((o) => o.id === org) : orgs[0]) || null;
  return here ? ['operator', 'admin'].includes(here.effectiveRole) : me.user?.isOwner === true;
}

const section = (html) => {
  const sec = document.createElement('section');
  sec.className = 'drawer-section verdict-section';
  sec.innerHTML = html;
  return sec;
};

const recordLineHtml = (v) => (v
  ? `<p class="verdict-record">${verdictChipHtml(v)} <span class="verdict-record-by">${escapeHtml(`${v.actor || 'someone'} · ${typeof v.setAt === 'string' ? v.setAt.slice(0, 10) : ''}${v.carriedFrom ? ' · carried from an earlier upload' : ''}`)}</span></p>${v.reason ? `<p class="verdict-reason">${escapeHtml(v.reason)}</p>` : ''}`
  : '<p class="verdict-record"><span class="ux-chip ux-chip-neutral ux-chip-verdict" title="Verdict — Does a reviewer trust it? No verdict is recorded: nobody has reviewed this artefact.">Unreviewed</span></p>');

// The drawer's Verdict section for one artefact: the record as it stands
// and, for whoever may record one on a registered pack, the form.
// `onSaved` runs after a successful save or clear (the board repaints).
export function verdictPanel(artefact, { onSaved = () => host.renderMainView() } = {}) {
  const packId = packIdForVerdicts();
  const current = verdictOf(artefact.id);
  const registered = packIsRegistered(packId);
  const may = canRecordVerdict();
  const sec = section(`<h3>Verdict</h3>
    <p class="verdict-what">A reviewer's record on this artefact — trusted, suspect or failed, with a reason. It never changes the conformance score or the grade.</p>
    <div class="verdict-current">${recordLineHtml(current)}</div>
    ${!packId || !registered
    ? '<p class="verdict-note">A verdict is recorded on a registered pack. Upload this pack (Validate or upload) and record the verdict on the registered copy.</p>'
    : may
      ? `<form class="verdict-form">
        <fieldset class="verdict-statuses">
          <legend class="sr-text">Status</legend>
          ${VERDICT_STATUSES.map((s) => `<label class="verdict-choice"><input type="radio" name="verdict-status" value="${s}"${current?.status === s ? ' checked' : ''}> ${escapeHtml(s[0].toUpperCase() + s.slice(1))}</label>`).join('')}
        </fieldset>
        <label class="verdict-reason-field"><span class="sr-text">Reason</span>
          <textarea name="verdict-reason" class="verdict-reason-input" rows="3" maxlength="${REASON_MAX}" placeholder="Why — one paragraph, optional">${escapeHtml(current?.reason || '')}</textarea></label>
        <div class="verdict-actions">
          <button type="submit" class="ux-primary-btn verdict-save">Save verdict</button>
          ${current ? '<button type="button" class="ux-secondary-btn verdict-clear">Clear verdict</button>' : ''}
        </div>
        <div class="verdict-status" role="status"></div>
      </form>`
      : '<p class="verdict-note">Operators and admins record verdicts; this record is read-only for your role.</p>'}`);

  const form = sec.querySelector('.verdict-form');
  if (!form) return sec;
  const status = form.querySelector('.verdict-status');
  const fail = (message) => { status.innerHTML = `<p class="ux-empty ux-tone-fail verdict-refused">${escapeHtml(message)}</p>`; };
  const busy = (on) => { for (const b of form.querySelectorAll('button')) b.disabled = on; };
  const after = (view) => {
    if (!state.verdicts) state.verdicts = new Map();
    if (view) state.verdicts.set(artefact.id, view); else state.verdicts.delete(artefact.id);
    if (!state.verdicts.size) state.verdicts = null;
    onSaved();
  };
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const chosen = form.querySelector('input[name="verdict-status"]:checked')?.value;
    if (!chosen) { fail('Pick trusted, suspect or failed first.'); return; }
    const reason = form.querySelector('.verdict-reason-input').value.trim();
    busy(true);
    try {
      const res = await api(`/api/packs/${encodeURIComponent(packId)}/verdicts/${encodeURIComponent(artefact.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: chosen, ...(reason ? { reason } : {}) }),
      });
      after(res.verdict);
      sec.querySelector('.verdict-current').innerHTML = recordLineHtml(res.verdict);
      status.innerHTML = `<p class="verdict-saved">${escapeHtml(res.changed?.length ? `Saved: ${res.changed.join(' and ')} changed.` : 'Nothing changed.')} <span class="sr-text">${escapeHtml(verdictTip(res.verdict))}</span></p>`;
    } catch (e) {
      fail(refusalText(e));
    } finally {
      busy(false);
    }
  });
  form.querySelector('.verdict-clear')?.addEventListener('click', async () => {
    busy(true);
    try {
      await api(`/api/packs/${encodeURIComponent(packId)}/verdicts/${encodeURIComponent(artefact.id)}`, { method: 'DELETE' });
      after(null);
      sec.querySelector('.verdict-current').innerHTML = recordLineHtml(null);
      form.querySelector('.verdict-clear')?.remove();
      for (const r of form.querySelectorAll('input[name="verdict-status"]')) r.checked = false;
      form.querySelector('.verdict-reason-input').value = '';
      status.innerHTML = '<p class="verdict-saved">Cleared: the artefact is unreviewed again.</p>';
    } catch (e) {
      fail(refusalText(e));
    } finally {
      busy(false);
    }
  });
  return sec;
}
