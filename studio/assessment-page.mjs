// studio/assessment-page.mjs
//
// Expert's Assessment (Diagnose → Assessment) as one screen: the verdict, the
// checks the grade is made of — one row each — and everything else folded into
// closed rows. The page used to say the seven checks five times over (causes,
// measures, gaps, two tables and a ledger) down six screens; here a check is
// said once, in its row, and its row opens for the why, the fix and where it
// was read.
//
// Each scored row carries a switch. Flipping one is a WHAT-IF: the grade on
// screen is taken again without (or with) that criterion, at once, and nothing
// is saved. "Keep" saves the set for the service (one reason for the criteria
// newly left out); "Reset" goes back to what is saved. The differences with
// live are rows too (setAsideListHtml), each with a switch that sets it aside
// (studio/set-asides.mjs) — the same what-if, kept by the same Keep.
//
// Pure: facts in, strings out. compare-view.mjs gathers the facts (the engine's
// diagnostic, buildAssessmentDecision's `checks`), draws these and routes the
// actions (diag-check-*, diag-whatif-*); the host saves a kept set
// (host.setGradeCriteria).

import { escapeHtml } from './util.mjs';
import { termHtml } from './ux-kit-pure.mjs';
import { GRADE_CRITERIA, GRADE_CRITERION_KEYS, INSTRUMENT_GRADE_SCALE, POSTURE_LAYERS, POSTURE_MECHANISMS_PER_LAYER } from './diagnostic-grade.mjs';
import { KIND_WORDS, SET_ASIDE_KINDS, setAsideId } from './set-asides.mjs';

const LABEL = Object.fromEntries(GRADE_CRITERIA.map((c) => [c.key, c.label]));

// What each check asks, in plain words: the line under its name in every row.
export const CHECK_ASKS = Object.freeze({
  'multi-modal': 'Are metrics, logs and traces all declared?',
  correlated: 'Can the signals of one request be joined?',
  calibrated: 'Is normal defined with numbers?',
  comprehensive: 'Is every layer observed?',
  'chaos-validated': 'Is recovery proven under a fault?',
  'drift-free': 'Does the declaration match what runs?',
  fresh: 'Was it verified in the last 24 hours?',
  actionable: 'Does an alert lead to a response?',
});

// The three groups, under the questions the board asks.
export const CHECK_GROUPS = Object.freeze([
  Object.freeze({ key: 'coverage', letter: 'A', question: 'Are the right signals in place?', term: 'coverage', name: 'Coverage' }),
  Object.freeze({ key: 'trust', letter: 'B', question: 'Can you trust what the signals show?', term: 'trust', name: 'Trust' }),
  Object.freeze({ key: 'operability', letter: 'C', question: 'Can oncall act on what it sees?', term: null, name: 'Operability' }),
]);

const joinAnd = (words) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);
// 2 · 0.25 · 2.25 — a count of checks, which a part-credit check makes a fraction.
export const fmtChecks = (n) => (Number.isInteger(n) ? String(n) : Number(n).toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));
const pctOf = (p, t) => (t ? Math.round((p / t) * 100) : 0);

// ---------- the what-if set ----------

// The criteria left out, in the engine's order, from keys or { key } records;
// what names no scored criterion is dropped.
export function offSet(off) {
  const asked = new Set((Array.isArray(off) ? off : []).map((x) => (x && typeof x === 'object' ? x.key : x)));
  return GRADE_CRITERION_KEYS.filter((k) => asked.has(k));
}

// Flip one criterion in a set: { off, refused }. A grade stands on at least one
// criterion, so the last one graded cannot be switched off (`refused`).
export function toggleOff(off, key) {
  const now = offSet(off);
  if (!GRADE_CRITERION_KEYS.includes(key)) return { off: now, refused: false };
  if (now.includes(key)) return { off: now.filter((k) => k !== key), refused: false };
  if (now.length + 1 >= GRADE_CRITERION_KEYS.length) return { off: now, refused: true };
  return { off: offSet([...now, key]), refused: false };
}

// What a what-if changes against the saved set: { turnedOff, turnedOn, same }.
export function whatIfChanges(saved, whatIf) {
  const a = offSet(saved);
  const b = offSet(whatIf);
  const turnedOff = b.filter((k) => !a.includes(k));
  const turnedOn = a.filter((k) => !b.includes(k));
  return { turnedOff, turnedOn, same: !turnedOff.length && !turnedOn.length };
}

// "without Chaos-validated and Fresh" · "with Fresh graded again" · "with 31 set aside" ·
// "with 2 no longer set aside" — joined. `asideAdded` / `asideRemoved`: how many
// differences the what-if sets aside, and takes back.
export function whatIfWords({ turnedOff = [], turnedOn = [], asideAdded = 0, asideRemoved = 0 } = {}) {
  const parts = [];
  if (turnedOff.length) parts.push(`without ${joinAnd(turnedOff.map((k) => LABEL[k] || k))}`);
  if (turnedOn.length) parts.push(`with ${joinAnd(turnedOn.map((k) => LABEL[k] || k))} graded again`);
  if (asideAdded) parts.push(`with ${asideAdded} set aside`);
  if (asideRemoved) parts.push(`with ${asideRemoved} no longer set aside`);
  return parts.join(', and ');
}

// What a set-aside what-if changes against the saved list (records, by side and key):
// { added, removed, changed, same } — `changed`: the same difference, set aside another way.
export function asideChanges(saved, tried) {
  const byId = (list) => new Map((Array.isArray(list) ? list : []).filter((r) => r && r.key && r.side).map((r) => [setAsideId(r.side, r.key), r]));
  const a = byId(saved);
  const b = byId(tried);
  const added = [...b.keys()].filter((id) => !a.has(id));
  const removed = [...a.keys()].filter((id) => !b.has(id));
  const changed = [...b.keys()].filter((id) => a.has(id) && (a.get(id).kind !== b.get(id).kind || (a.get(id).until ?? null) !== (b.get(id).until ?? null) || (a.get(id).note || '') !== (b.get(id).note || '')));
  return { added, removed, changed, same: !added.length && !removed.length && !changed.length };
}

// ---------- the grade scale ----------

// The score-reachable rungs, lowest first, each with the span of the score it covers.
export function gradeScale() {
  const rungs = INSTRUMENT_GRADE_SCALE.filter((g) => g.minPct !== null).sort((x, y) => x.minPct - y.minPct);
  return rungs.map((g, i) => ({ letter: g.letter, tier: g.tier, label: g.label, from: g.minPct, to: i + 1 < rungs.length ? rungs[i + 1].minPct : 100 }));
}

// The scale as one bar: a segment per grade, as wide as its span, the grade the
// score lands on lit, a mark at the score.
export function gradeScaleHtml(scorePct, letter) {
  const at = Math.max(0, Math.min(100, Number(scorePct) || 0));
  const segs = gradeScale().map((s) => `<span class="diag-scale-seg tier-${escapeHtml(s.tier)}${s.letter === letter ? ' is-current' : ''}" style="flex:${s.to - s.from} 1 0" title="${escapeHtml(`${s.letter} · ${s.label}: ${s.from}% to ${s.to}%`)}"><span class="diag-scale-letter">${escapeHtml(s.letter)}</span></span>`).join('');
  return `<div class="diag-scale" role="img" aria-label="${escapeHtml(`Grade scale from D to A+: this pack is at ${Math.round(at)}%, grade ${letter}`)}">${segs}<span class="diag-scale-mark" style="left:${at}%"></span></div>`;
}

// ---------- the verdict ----------

// verdictBarHtml({ … }) — the one band that answers "is it good enough?":
//   contextHtml    the working context line (service · pack · baseline), drawn above
//   tone           'ok' | 'warn' | 'fail' | 'info'
//   letter, gradeName, gradeTitle     C · Field grade (and the tooltip)
//   sentence       the outcome in one sentence
//   scorePct, scoreExact, threshold, passes
//   graded, total  the criteria the grade stands on, of how many
//   aside          how many differences with live the grade leaves out (0: nothing said)
//   whatIf         true while a what-if is on screen
//   facts          [{ labelHtml, value, note, tone }] — coverage, trust, live signals, chains
//   actions        [{ label, action }] — quieter next steps
export function verdictBarHtml({
  contextHtml = '', tone = 'info', letter = '', gradeName = '', gradeTitle = '', sentence = '',
  scorePct = 0, scoreExact = null, threshold = 85, passes = false, graded = 7, total = 7, aside = 0, whatIf = false, facts = [], actions = [],
} = {}) {
  const exact = scoreExact == null ? scorePct : scoreExact;
  const gap = passes
    ? `Grade A begins above ${threshold}%`
    : `${(threshold - exact).toFixed(1)} points below grade A, which begins above ${threshold}%`;
  const on = (graded === total ? `on all ${total} criteria` : `on ${graded} of ${total} criteria`) + (aside ? ` · ${aside} set aside` : '');
  const factHtml = facts.filter(Boolean).map((f) => `
        <div class="diag-fact ux-tone-${escapeHtml(f.tone || 'neutral')}"${f.title ? ` title="${escapeHtml(f.title)}"` : ''}>
          <dt>${f.labelHtml ?? escapeHtml(f.label || '')}</dt>
          <dd><span class="diag-fact-val">${escapeHtml(f.value)}</span>${f.note ? `<span class="diag-fact-note">${escapeHtml(f.note)}</span>` : ''}</dd>
        </div>`).join('');
  const actionHtml = actions.length
    ? `<div class="diag-verdict-actions">${actions.map((a) => `<button type="button" class="ux-secondary-btn"${a.action ? ` data-ux-action="${escapeHtml(a.action)}"` : ''}>${escapeHtml(a.label)}</button>`).join('')}</div>`
    : '';
  return `
    <section class="diag-verdict ux-tone-${escapeHtml(tone)}${whatIf ? ' is-whatif' : ''} ux-section-target" id="diag-summary" tabindex="-1" aria-label="${whatIf ? 'Assessment, as a what-if' : 'Assessment'}">
      ${contextHtml}
      <div class="diag-verdict-main">
        <div class="diag-verdict-id">
          <span class="diag-verdict-letter"${gradeTitle ? ` title="${escapeHtml(gradeTitle)}"` : ''}>${escapeHtml(letter)}</span>
          <div class="diag-verdict-words">
            <span class="ux-eyebrow">${whatIf ? 'What if' : 'Assessment'}</span>
            <p class="diag-verdict-name">${escapeHtml(gradeName)}</p>
            <p class="diag-verdict-sentence">${escapeHtml(sentence)}</p>
          </div>
        </div>
        <div class="diag-verdict-score">
          <p class="diag-verdict-pct"><span class="diag-verdict-num">${escapeHtml(String(scorePct))}</span><span class="diag-verdict-unit">%</span> <span class="diag-verdict-on">${escapeHtml(on)}</span></p>
          ${gradeScaleHtml(exact, letter)}
          <p class="diag-verdict-gap">${escapeHtml(gap)}</p>
        </div>
        <dl class="diag-verdict-facts">${factHtml}
        </dl>
      </div>
      ${actionHtml}
    </section>`;
}

// ---------- the what-if bar ----------

// whatIfBarHtml({ … }) — shown only while a what-if is on screen, pinned under
// the bars so the grade it gives stays in view while switches are flipped:
//   words        whatIfWords(...)
//   now, saved   { letter, pct, graded, total }
//   keep         null (nothing to save to: no service, or a static bundle), or
//                { enabled, reason, serviceName, needsReason, ask: null | {
//                    count, reason,     the criteria newly left out, and why (count 0: no reason asked)
//                    aside: null | { declared, live, kind: { declared, live }, until, note } } }
//                — `aside`: the differences newly set aside on each side, how (the kinds,
//                the review date of those under development) and an optional note
export function whatIfBarHtml({ words = '', now = {}, saved = {}, keep = null } = {}) {
  const grade = (g) => `${escapeHtml(g.letter || '')} · ${escapeHtml(String(g.pct ?? 0))}%`;
  const on = (g) => (g.graded === g.total ? `all ${g.total} criteria` : `${g.graded} of ${g.total} criteria`);
  const name = keep ? escapeHtml(keep.serviceName || 'this service') : '';
  const savedWords = keep ? `Saved for ${name}` : 'As it is graded';
  const keepBtn = !keep ? '<span class="diag-whatif-note">Not saved: a what-if only.</span>'
    : keep.ask ? ''
      : keep.enabled
        ? `<button type="button" class="ux-secondary-btn diag-whatif-keep" data-ux-action="diag-whatif-keep">Keep for ${name}${keep.needsReason ? '…' : ''}</button>`
        : `<button type="button" class="ux-secondary-btn diag-whatif-keep" data-ux-action="diag-whatif-explain" aria-disabled="true" title="${escapeHtml(keep.reason || '')}">Keep for ${name}</button>`;
  const ask = keep?.ask ? `
      <div class="diag-whatif-ask">
        ${keep.ask.count ? `<label class="diag-whatif-ask-l"><span>Why ${keep.ask.count === 1 ? 'is it' : 'are they'} not graded for ${name}?</span>
          <input class="og-input" data-diag-keep-reason value="${escapeHtml(keep.ask.reason || '')}" maxlength="200" autocomplete="off" placeholder="e.g. this project runs no fault injection"></label>` : ''}${keep.ask.aside ? asideAskHtml(keep.ask.aside) : ''}
        <button type="button" class="ux-secondary-btn" data-ux-action="diag-whatif-save">Save</button>
        <button type="button" class="ux-link-btn" data-ux-action="diag-whatif-keep-cancel">Cancel</button>
      </div>` : '';
  return `
    <div class="diag-whatif" role="region" aria-label="What if">
      <p class="diag-whatif-text"><span class="diag-whatif-tag">What if</span> <span class="diag-whatif-words">${escapeHtml(words.charAt(0).toUpperCase() + words.slice(1))}:</span> <strong class="diag-whatif-now">${grade(now)}</strong> on ${escapeHtml(on(now))}. <span class="diag-whatif-saved">${savedWords}: ${grade(saved)} on ${escapeHtml(on(saved))}.</span></p>
      <div class="diag-whatif-actions">${keepBtn}<button type="button" class="ux-link-btn" data-ux-action="diag-whatif-reset">Reset</button></div>${ask}
    </div>`;
}

// How the differences newly set aside are set aside: a kind per side (the
// default the side's), the review date while one is under development, a note.
function asideAskHtml(a) {
  const kindSelect = (side, n, words) => (n ? `
          <label class="diag-whatif-ask-l diag-whatif-ask-kind"><span>${n} ${words}</span>
            <select class="og-input" data-diag-keep-kind="${side}">${SET_ASIDE_KINDS.map((k) => `<option value="${k}"${a.kind?.[side] === k ? ' selected' : ''}>${escapeHtml(KIND_WORDS[k])}</option>`).join('')}</select></label>` : '');
  const dated = (a.declared && a.kind?.declared === 'in-development') || (a.live && a.kind?.live === 'in-development');
  return `<fieldset class="diag-whatif-aside"><legend>Set aside as</legend>${kindSelect('declared', a.declared, 'declared, not live')}${kindSelect('live', a.live, 'live, not declared')}${dated ? `
          <label class="diag-whatif-ask-l diag-whatif-ask-date"><span>Review on</span><input class="og-input" type="date" data-diag-keep-until value="${escapeHtml(a.until || '')}"></label>` : ''}
          <label class="diag-whatif-ask-l"><span>Note <span class="diag-whatif-optional">(optional)</span></span><input class="og-input" data-diag-keep-note value="${escapeHtml(a.note || '')}" maxlength="200" autocomplete="off" placeholder="e.g. lands with the next release"></label></fieldset>`;
}

// ---------- the differences, to set aside ----------

const dayMonth = (iso) => {
  const t = Date.parse(`${String(iso || '').slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '';
};

// What a set-aside says beside its difference.
export function setAsideWords(rec, state = 'active') {
  if (!rec) return '';
  if (state === 'due') return `Review due since ${dayMonth(rec.until)}`;
  const kind = KIND_WORDS[rec.kind] || rec.kind;
  return rec.kind === 'in-development' && rec.until ? `${kind} · review ${dayMonth(rec.until)}` : kind;
}

// setAsideListHtml({ … }) — the differences with live a person can set aside, by
// side, then by layer (a closed row each, a switch for the whole layer), a row
// per difference with its switch (on: set aside):
//   declared, live   setAsideCandidates(...)'s rows, each with `tried` (the record
//                    that sets it aside on screen, or null), `saved` (the saved one
//                    that holds, or null) and `due` (a record whose review date has
//                    passed, so the difference counts again, or null)
//   stale            saved set-asides that match no difference now (retired, gone)
//   open             the ids of the layers drawn open ('declared:L2')
//   layerTitle(L)    a layer's name ("L2 Metrics/Logs/Traces")
export function setAsideListHtml({ declared = [], live = [], stale = [], open = [], layerTitle = (L) => L } = {}) {
  const opened = new Set(open);
  const total = declared.length + live.length;
  if (!total && !stale.length) return '';
  const asideN = [...declared, ...live].filter((x) => x.tried).length;
  const item = (x) => {
    const on = !!x.tried;
    const changed = on !== !!x.saved || (on && x.saved && (x.saved.kind !== x.tried.kind || (x.saved.until ?? null) !== (x.tried.until ?? null)));
    const state = on ? setAsideWords(x.tried) : x.due ? setAsideWords(x.due, 'due') : '';
    const cls = `diag-aside-item${on ? ' is-aside' : ''}${!on && x.due ? ' is-due' : ''}${changed ? ' is-changed' : ''}`;
    return `
          <li class="${cls}">
            <span class="diag-aside-words"><span class="diag-aside-label">${escapeHtml(x.label)}</span><span class="diag-aside-kind">${escapeHtml(x.kind)}</span>${changed ? '<span class="diag-visually-hidden"> (what if)</span>' : ''}</span>
            <span class="diag-aside-state">${escapeHtml(state)}${!on && x.due ? ` <button type="button" class="ux-link-btn" data-ux-action="diag-aside-forget:${escapeHtml(x.id)}">Forget it</button>` : ''}</span>
            <button type="button" role="switch" class="diag-switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${escapeHtml(`Set aside ${x.label}`)}" data-ux-action="diag-aside-toggle:${escapeHtml(x.id)}"><span class="diag-switch-knob" aria-hidden="true"></span></button>
          </li>`;
  };
  const side = (key, rows, words) => {
    if (!rows.length) return '';
    const layers = [...new Set(rows.map((x) => x.layer))];
    const groups = layers.map((L) => {
      const own = rows.filter((x) => x.layer === L);
      const n = own.filter((x) => x.tried).length;
      const all = n === own.length;
      const gid = `${key}:${L}`;
      return `
        <details class="diag-aside-layer"${opened.has(gid) ? ' open' : ''} data-aside-group="${escapeHtml(gid)}">
          <summary class="diag-aside-sum"><span class="diag-more-caret" aria-hidden="true"></span><span class="diag-aside-layer-name">${escapeHtml(layerTitle(L))}</span><span class="diag-aside-layer-n">${own.length}${n ? ` · ${n} set aside` : ''}</span>
            <button type="button" role="switch" class="diag-switch" aria-checked="${all ? 'true' : 'false'}" aria-label="${escapeHtml(`Set aside all ${own.length} in ${layerTitle(L)}`)}" title="${all ? 'Every one is set aside: switch off to count them again.' : 'Set every one of them aside.'}" data-ux-action="diag-aside-group:${escapeHtml(gid)}"><span class="diag-switch-knob" aria-hidden="true"></span></button></summary>
          <ul class="diag-aside-items">${own.map(item).join('')}
          </ul>
        </details>`;
    }).join('');
    return `
      <div class="diag-aside-side" data-side="${key}">
        <h4 class="diag-aside-side-title">${escapeHtml(words)} <span class="diag-aside-side-n">${rows.length}</span></h4>${groups}
      </div>`;
  };
  const staleHtml = stale.length ? `
      <p class="diag-aside-stale">${stale.length} set-aside${stale.length === 1 ? ' matches' : 's match'} no difference now (${escapeHtml(joinAnd([...new Set(stale.map((x) => (x.state === 'retired' ? 'now on both sides' : 'in neither pack')))]))}). <button type="button" class="ux-link-btn" data-ux-action="diag-aside-forget-stale">Forget ${stale.length === 1 ? 'it' : 'them'}</button></p>` : '';
  return `
    <section class="diag-aside" id="diag-aside" tabindex="-1" aria-labelledby="diag-aside-title">
      <header class="diag-aside-head">
        <h3 class="diag-aside-title" id="diag-aside-title">The differences — set aside what does not count against this service</h3>
        <p class="diag-aside-lede">${total} ${total === 1 ? 'difference' : 'differences'}${asideN ? `, ${asideN} set aside` : ''}. Switch one on to see the grade without it: under development (declared, not running yet) or not this service's (found live, someone else's). Nothing is saved until you keep it.</p>
      </header>${side('declared', declared, 'Declared, not live')}${side('live', live, 'Live, not declared')}${staleHtml}
    </section>`;
}

// ---------- the checks ----------

const CHIP = {
  pass: '<span class="ux-chip ux-chip-ok ux-chip-assessment" title="Met this check with real values.">Pass</span>',
  fail: '<span class="ux-chip ux-chip-fail ux-chip-assessment" title="Did not meet this check.">Fail</span>',
  off: '<span class="ux-chip ux-chip-muted ux-chip-assessment" title="Left out of the grade: shown, never scored.">Off</span>',
};
const chipOf = (row) => {
  if (row.state === 'partial') return `<span class="ux-chip ux-chip-warn ux-chip-assessment" title="${escapeHtml(`Partial credit: ${Math.round((row.worth ? row.earned / row.worth : 0) * 100)}% of this check.`)}">Partial</span>`;
  if (row.state === 'info') return `<span class="ux-chip ux-chip-neutral ux-chip-assessment" title="Shown for context; never scored.">Not scored · ${row.met ? 'yes' : 'no'}</span>`;
  if (row.state === 'also') return `<span class="ux-chip ux-chip-${row.tone === 'fail' ? 'fail' : 'warn'} ux-chip-assessment" title="Found beside the checks: it does not change the grade.">${row.tone === 'fail' ? 'Gap' : 'Caution'}</span>`;
  return CHIP[row.state] || '';
};

// A criterion's switch: on = graded. `last`: the only one still graded, which stays on.
export function checkSwitchHtml(row, { last = false } = {}) {
  const on = row.state !== 'off';
  const label = `Grade ${row.label}`;
  const tip = last ? 'A grade stands on at least one criterion.'
    : on ? `${row.label} is graded. Switch it off to see the grade without it.`
      : `${row.label} is not graded. Switch it on to see the grade with it.`;
  return `<button type="button" role="switch" class="diag-switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${escapeHtml(label)}" title="${escapeHtml(tip)}" data-ux-action="diag-check-toggle:${escapeHtml(row.key)}"${last ? ' aria-disabled="true"' : ''}><span class="diag-switch-knob" aria-hidden="true"></span></button>`;
}

const pointsHtml = (row) => (row.state === 'off' || row.state === 'info' || row.state === 'also'
  ? '<span class="dc-none" aria-label="no points">—</span>'
  : `<span class="dc-earned">${Math.round(row.earned)}</span><span class="dc-worth"> / ${Math.round(row.worth)}</span>`);

// What the row says under "Observed": the engine's words, or for a criterion
// left out, that it is — with why, who and when once that is saved.
const observedHtml = (row) => {
  if (row.state !== 'off') return escapeHtml(row.observed || '');
  if (row.saved) return `Not graded for this service: ${escapeHtml(row.saved.reason || '')}${row.saved.by ? ` <span class="dc-by">${escapeHtml(row.saved.by)}</span>` : ''}`;
  return 'Not graded in this what-if.';
};

const col = (key, body) => `<div class="dcm-col"><span class="dcm-key">${escapeHtml(key)}</span>${body}</div>`;
const para = (text, cls = '') => (text ? `<p${cls ? ` class="${cls}"` : ''}>${escapeHtml(text)}</p>` : '');
const actionBtn = (row) => (row.actionId && row.actionLabel
  ? `<div class="dcm-actions"><button type="button" class="ux-secondary-btn" data-ux-action="${escapeHtml(row.actionId)}">${escapeHtml(row.actionLabel)}</button></div>` : '');

// The row, opened: what failed, why it matters, the fix, and where it was read.
export function checkDetailHtml(row) {
  const failing = row.state === 'fail' || row.state === 'partial' || row.state === 'also';
  const first = failing
    ? col('What failed', para(row.title, 'dcm-title') + para(row.observed) + para(row.cost, 'dcm-cost'))
    : row.state === 'off'
      ? col('Not graded', para(row.saved ? `${row.label} is left out of the grade for this service: ${row.saved.reason || ''}` : `${row.label} is left out of the grade in this what-if; nothing is saved.`)
        + (row.saved?.by ? para(row.saved.by, 'dcm-by') : '') + para(row.observed ? `What the pack shows: ${row.observed}` : ''))
      : col('What it found', para(row.observed));
  const why = row.why ? col('Why it matters', para(row.why)) : '';
  const fix = failing && (row.fix || row.actionId) ? col('Fix', para(row.fix) + actionBtn(row)) : '';
  const read = row.expected || row.field
    ? col('Expected', para(row.expected) + (row.field ? `<span class="dcm-key dcm-key-2">Read from</span><p><code>${escapeHtml(row.field)}</code></p>` : ''))
    : '';
  return `<div class="diag-check-more">${first}${why}${fix}${read}</div>`;
}

const rowHtml = (row, { open, last, switches }) => {
  const id = `diag-check-detail-${row.key}`;
  const scored = row.state !== 'info' && row.state !== 'also';
  const ask = CHECK_ASKS[row.key] || '';
  return `
        <tr class="diag-check is-${escapeHtml(row.state)}${row.changed ? ' is-changed' : ''}" data-key="${escapeHtml(row.key)}">
          <td class="dc-result">${chipOf(row)}</td>
          <th scope="row" class="dc-name">
            <button type="button" class="diag-check-open" data-ux-action="diag-check-open:${escapeHtml(row.key)}" aria-expanded="${open ? 'true' : 'false'}" aria-controls="${escapeHtml(id)}">
              <span class="diag-check-caret" aria-hidden="true"></span>
              <span class="diag-check-words"><span class="diag-check-label">${escapeHtml(row.label)}${row.changed ? ' <span class="diag-check-tag">what if</span>' : ''}</span>${ask ? `<span class="diag-check-ask">${escapeHtml(ask)}</span>` : ''}</span>
            </button>
          </th>
          <td class="dc-obs">${observedHtml(row)}</td>
          <td class="dc-points">${pointsHtml(row)}</td>
          <td class="dc-switch">${scored && switches ? checkSwitchHtml(row, { last }) : ''}</td>
        </tr>
        <tr class="diag-check-detail" id="${escapeHtml(id)}"${open ? '' : ' hidden'}>
          <td colspan="5">${checkDetailHtml(row)}</td>
        </tr>`;
};

// checksTableHtml({ groups, also, open, switches }) — the page's centre:
//   groups    [{ key, passed, total, note, rows }] by CHECK_GROUPS' keys; a row is
//             { key, label, state: 'pass'|'partial'|'fail'|'off'|'info', met, observed, expected, field,
//               earned, worth, title, why, fix, cost, actionLabel, actionId, saved: { reason, by } | null, changed }
//   also      rows found beside the checks ({ state: 'also', tone, … }): they do not change the grade
//   open      the keys of the rows drawn open
//   switches  false draws no switch (never the case in the studio; a host may want none)
export function checksTableHtml({ groups = [], also = [], open = [], switches = true } = {}) {
  const opened = new Set(open);
  const gradedKeys = groups.flatMap((g) => g.rows).filter((r) => ['pass', 'partial', 'fail'].includes(r.state)).map((r) => r.key);
  const last = gradedKeys.length === 1 ? gradedKeys[0] : null;
  const head = (g, def) => {
    const meta = def.key === 'operability' ? 'shown, never scored'
      : g.total ? `${fmtChecks(g.passed)} of ${g.total} ${g.total === 1 ? 'check' : 'checks'} · ${pctOf(g.passed, g.total)}%`
        : 'not graded';
    return `
        <tr class="diag-check-group" data-group="${escapeHtml(def.key)}">
          <th colspan="5" scope="colgroup">
            <span class="diag-check-group-letter">${escapeHtml(def.letter)}</span>
            <span class="diag-check-group-q">${escapeHtml(def.question)}</span>
            <span class="diag-check-group-term">${def.term ? termHtml(def.term) : escapeHtml(def.name)}</span>
            <span class="diag-check-group-meta">${escapeHtml(meta)}</span>
            ${g.note ? `<span class="diag-check-group-note">${g.note}</span>` : ''}
          </th>
        </tr>`;
  };
  const body = CHECK_GROUPS.map((def) => {
    const g = groups.find((x) => x.key === def.key);
    if (!g || !g.rows.length) return '';
    return head(g, def) + g.rows.map((r) => rowHtml(r, { open: opened.has(r.key), last: r.key === last, switches })).join('');
  }).join('');
  const alsoHtml = also.length ? `
        <tr class="diag-check-group" data-group="also">
          <th colspan="5" scope="colgroup">
            <span class="diag-check-group-letter" aria-hidden="true">+</span>
            <span class="diag-check-group-q">Also found</span>
            <span class="diag-check-group-meta">does not change the grade</span>
          </th>
        </tr>${also.map((r) => rowHtml({ ...r, state: 'also' }, { open: opened.has(r.key), last: false, switches: false })).join('')}` : '';
  return `
    <section class="diag-checks-block ux-section-target" id="diag-evidence" tabindex="-1" aria-labelledby="diag-checks-title">
      <header class="diag-checks-head">
        <h2 class="diag-checks-title" id="diag-checks-title">The checks behind the grade</h2>
        <p class="diag-checks-lede">One row per check. Open a row for the why and the fix${switches ? '; switch a check off to see the grade without it' : ''}.</p>
      </header>
      <table class="diag-checks">
        <thead>
          <tr>
            <th class="dc-result" scope="col">Result</th>
            <th class="dc-name" scope="col">Check</th>
            <th class="dc-obs" scope="col">Observed</th>
            <th class="dc-points" scope="col" title="The points of the score each check earns, of those it is worth">Points</th>
            <th class="dc-switch" scope="col">${switches ? 'Graded' : ''}</th>
          </tr>
        </thead>
        <tbody>${body}${alsoHtml}
        </tbody>
      </table>
    </section>`;
}

// ---------- everything else, folded ----------

// The closed row's one line: its title, what it holds in a few words (HTML, already
// escaped by the caller) and an issue count, said by `countTitle` ("thin layers").
export function moreSummaryHtml({ title, metaHtml = '', count = null, countTitle = '', tone = 'neutral' } = {}) {
  return `<summary class="diag-more-sum"><span class="diag-more-caret" aria-hidden="true"></span><span class="diag-more-title">${escapeHtml(title)}</span>`
    + `<span class="diag-more-meta">${metaHtml}</span>`
    + (count ? `<span class="ux-section-count diag-more-count ux-tone-${escapeHtml(tone)}"${countTitle ? ` title="${escapeHtml(countTitle)}"` : ''}>${escapeHtml(String(count))}${countTitle ? `<span class="diag-visually-hidden"> ${escapeHtml(countTitle)}</span>` : ''}</span>` : '')
    + '</summary>';
}

// How many of the expected mechanisms each layer observes (declared or seen as evidence).
export function layerCoverage(posture) {
  const per = POSTURE_MECHANISMS_PER_LAYER.length;
  const layers = POSTURE_LAYERS.map((l) => {
    const observed = POSTURE_MECHANISMS_PER_LAYER.filter((m) => (posture?.cells?.[`${l.key}:${m.key}`] || []).length > 0).length;
    const pct = Math.round((observed / per) * 100);
    return { key: l.key, label: l.label, observed, total: per, pct, verdict: pct >= 70 ? 'strong' : pct >= 40 ? 'partial' : pct >= 20 ? 'thin' : 'dark' };
  });
  return { layers, observed: layers.reduce((n, l) => n + l.observed, 0), total: layers.length * per };
}

// The layers as four small bars on the closed row: name, bar, share.
export function layerMiniHtml(cov) {
  const tone = { strong: 'ok', partial: 'warn', thin: 'fail', dark: 'fail' };
  return `<span class="diag-layer-minis">${cov.layers.map((l) => `<span class="diag-layer-mini ux-tone-${tone[l.verdict]}" title="${escapeHtml(`${l.label}: ${l.observed} of ${l.total} mechanisms observed`)}"><span class="diag-layer-mini-name">${escapeHtml(l.label)}</span><span class="diag-layer-mini-bar" aria-hidden="true"><span style="width:${l.pct}%"></span></span><span class="diag-layer-mini-pct">${l.pct}%</span></span>`).join('')}</span>`;
}
