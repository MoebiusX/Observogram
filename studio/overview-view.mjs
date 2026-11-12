// studio/overview-view.mjs — the Overview screen, drawn from its model.
//
// render(container, model, host) (docs/UI_CONVENTIONS.md §3): the model is
// studio/overview-model.mjs buildOverviewModel(...) — pure, already worded —
// and the actions ride on host.overview: selectService(id), selectEnv(name),
// checkNow(), openDiscover(compare), openDiagnose(compare), openRemediate(compare),
// openRules(compare) (Expert's Conformance: the specification's rules)
// (compare: the model's — the live pack the board's check graded, or null), openNeuron(),
// expert(), retry(), backToList() (a host with the service list), and with no
// service yet scan(), live(), upload(slot), resetStart(), explain(reason). The
// service list (renderServiceList, at the end) has its own. A headless host ({ overview: {} }) never throws. The
// pieces are the design kit's (.og-*); the zone is .ov-* (studio/ux.css).
// Exactly one primary button per state.
//
// Two layouts of the same model. The board (model.layout 'board') is three
// columns under Expert's own words — Discover · Diagnose · Remediate — each
// a picture of the machine: the stack's four layers with the kinds of signal
// on each, the grade as a shield with its seven criteria behind a click, the live
// fidelity as a ring with four counts and the promises that hold, the delta as
// three counts, the specification's rules not met and the one next step.
// The simple layout is the three sentences alone. Should the board ever fail
// to draw, the simple layout is drawn instead and the error logged: the
// screen never goes blank.

import { escapeHtml } from './util.mjs';
import { host as appHost } from './host.mjs';
import { termHtml, disclosureHtml, emptyStateHtml, wireUxActions } from './ux-kit-pure.mjs';

const toneClass = (prefix, tone) => (tone && tone !== 'neutral' ? ` ${prefix}--${tone}` : '');

function headHtml(model) {
  const options = model.options.map((o) => `<option value="${escapeHtml(String(o.id))}"${o.selected ? ' selected' : ''}>${escapeHtml(o.name)}</option>`).join('');
  const envs = model.envs.length > 1 ? `
      <div class="og-seg ov-envs" role="group" aria-label="Environment">
        ${model.envs.map((e) => `<button type="button" class="og-btn ov-env" data-ux-action="ov-env" data-env="${escapeHtml(e.name)}" aria-pressed="${e.selected ? 'true' : 'false'}">${escapeHtml(e.name)}</button>`).join('')}
      </div>` : (model.env ? `<span class="og-pill ov-env-one">${escapeHtml(model.env)}</span>` : '');
  const back = model.back ? '<button type="button" class="og-btn og-btn--text ov-link ov-head__back" data-ux-action="ov-back"><span class="ov-link__arrow" aria-hidden="true">←</span> Services</button>' : '';
  return `
    <div class="ov-head">
      ${back}
      <label class="og-eyebrow ov-head__label" for="ov-service">Service</label>
      <select class="og-input ov-service" id="ov-service" aria-label="Service">${options}</select>
      ${envs}${model.controlRoom ? `
      ${controlRoomButtonHtml(model.controlRoom)}` : ''}
    </div>`;
}

// The control room's door, at the end of the context bar: a secondary
// button (the board keeps its one primary). Unavailable, it says why.
function controlRoomButtonHtml(cr) {
  if (!cr) return '';
  const icon = '<svg class="ov-ic ov-head__live-ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 12h4l2.5-6 4 12 2.5-6h5"></path></svg>';
  if (!cr.offered) {
    return `<button type="button" class="og-btn ov-head__live" aria-disabled="true" data-ux-action="ov-explain" data-reason="${escapeHtml(cr.reason || '')}" title="${escapeHtml(cr.reason || '')}">${icon}Control room</button>`;
  }
  return `<button type="button" class="og-btn ov-head__live" data-ux-action="ov-control-room" aria-expanded="${cr.open ? 'true' : 'false'}" aria-controls="ov-cr">${icon}Control room</button>`;
}

// ---------- the simple layout ----------

function gradeHtml(g) {
  return `
    <section class="ov-grade og-panel og-panel--pad${toneClass('og-panel', g.tone)}" aria-labelledby="ov-grade-eyebrow">
      <div class="og-eyebrow" id="ov-grade-eyebrow">${termHtml('diagnostic-grade', 'How well is it observed?')}</div>
      <div class="ov-grade__row">
        <div class="ov-grade__letter ov-tone-${escapeHtml(g.tone || 'neutral')}"${g.title ? ` title="${escapeHtml(g.title)}"` : ''} aria-label="Grade ${escapeHtml(g.letter)}">${escapeHtml(g.letter)}</div>
        <div class="ov-grade__text">
          <div class="ov-grade__label og-h1">${escapeHtml(g.label)}</div>
          ${g.word ? `<div class="ov-grade__word">${escapeHtml(g.word)}</div>` : ''}${g.criteria ? `
          <div class="ov-grade__criteria og-muted">${escapeHtml(g.criteria)}</div>` : ''}
          ${g.source ? `<div class="ov-grade__src og-muted">${escapeHtml(g.source)}</div>` : ''}
        </div>
      </div>
      ${gradeWhyHtml(g)}
    </section>`;
}

// The seven criteria behind the letter: a yes / partly / no pill and one
// sentence each, the points line first. Nothing when the model has no list
// that adds up to the letter. Collapsed in both layouts until the reader
// opens it; on the board the rows are set larger (`open`).
// A service may leave a criterion out of its grade. The criteria that are off
// (the model's `notGraded`) are listed under the reasons in both layouts, each
// with why, who and when. On the board, where the host wires the switch (the
// model's `switches`), every reason's row ends with "Not for this service…" —
// it asks why first, in place — and every criterion off with "Grade it again";
// a reader who may not switch gets the same words, explaining why when pressed.
// With nothing off and no switch the list is what it always was, byte for byte.
const WHY_MARK = { yes: ['ok', 'Yes'], partly: ['warn', 'Partly'], no: ['fail', 'No'] };
// Which criterion is being switched off, and what has been typed as the reason:
// the view's own, kept through the board's repaints, dropped with the service.
let gradeAsk = null;
const switchHtml = (sw, action, key, words, label) => (sw.enabled
  ? `<button type="button" class="ov-gw__switch" data-ux-action="${action}" data-key="${escapeHtml(key)}" aria-label="${escapeHtml(label)}">${words}</button>`
  : `<button type="button" class="ov-gw__switch" data-ux-action="ov-explain" aria-disabled="true" data-reason="${escapeHtml(sw.reason || '')}" title="${escapeHtml(sw.reason || '')}" aria-label="${escapeHtml(label)}">${words}</button>`);
function whyListHtml(g, { open = false, serviceId = null } = {}) {
  const lines = Array.isArray(g.why) ? g.why : [];
  const off = Array.isArray(g.notGraded) ? g.notGraded : [];
  const sw = open && g.switches ? g.switches : null;
  // Where the reasons are not offered (they would not add up to the letter), the criteria graded,
  // by name, so each can still be switched off.
  const plain = !lines.length && sw && Array.isArray(g.graded) ? g.graded : [];
  if (!lines.length && !off.length && !plain.length) return '';
  const ask = sw?.enabled && gradeAsk && gradeAsk.service === serviceId ? gradeAsk : null;
  const switchOf = (key, name) => (sw && key ? switchHtml(sw, 'ov-grade-ask', key, 'Not for this service…', `Stop grading ${name} for this service`) : '');
  const askingOf = (key, name) => (ask && ask.key === key ? `<li class="ov-gw ov-gw--ask"><label class="ov-gw__ask"><span class="ov-gw__ask-l">Why is ${escapeHtml(name)} not graded for this service?</span><input class="og-input" data-grade-reason="${escapeHtml(key)}" value="${escapeHtml(ask.reason || '')}" maxlength="200" autocomplete="off" placeholder="e.g. this project runs no fault injection"></label><button type="button" class="og-btn" data-ux-action="ov-grade-off" data-key="${escapeHtml(key)}">Stop grading it</button><button type="button" class="og-btn og-btn--text" data-ux-action="ov-grade-ask-cancel">Cancel</button></li>` : '');
  const items = lines.map((w) => {
    const [tone, word] = WHY_MARK[w.ok] || ['', w.ok];
    const name = w.label || w.key || '';
    return `<li class="ov-gw ov-gw--${escapeHtml(w.ok)}"><span class="og-pill${tone ? ` og-pill--${tone}` : ''} ov-gw__pill">${escapeHtml(word)}</span><span class="ov-gw__text">${escapeHtml(w.text)}</span>${switchOf(w.key, name)}</li>${askingOf(w.key, name)}`;
  }).join('');
  const points = g.points ? `<p class="ov-grade__points og-muted">${escapeHtml(g.points)}</p>` : '';
  const plainList = plain.length ? `<p class="ov-gw-off__h og-muted">Graded for this service</p><ul class="ov-gw-list ov-gw-list--plain ov-gw-list--open">${plain.map((c) => `<li class="ov-gw ov-gw--plain"><span class="ov-gw__text">${escapeHtml(c.label)}</span>${switchOf(c.key, c.label)}</li>${askingOf(c.key, c.label)}`).join('')}</ul>` : '';
  const list = lines.length ? `<ul class="ov-gw-list${open ? ' ov-gw-list--open' : ''}">${items}</ul>` : plainList;
  const offList = off.length ? `<p class="ov-gw-off__h og-muted">Not graded for this service</p><ul class="ov-gw-list ov-gw-list--off${open ? ' ov-gw-list--open' : ''}">${off.map((x) => `<li class="ov-gw ov-gw--off"><span class="og-pill ov-gw__pill">Off</span><span class="ov-gw__text">${escapeHtml(x.text)}${x.by ? ` <span class="ov-gw__by og-muted">${escapeHtml(x.by)}</span>` : ''}</span>${sw ? switchHtml(sw, 'ov-grade-on', x.key, 'Grade it again', `Grade ${x.label || x.key} for this service again`) : ''}</li>`).join('')}</ul>` : '';
  return `${points}${list}${offList}`;
}
function gradeWhyHtml(g) {
  const list = whyListHtml(g);
  return list ? disclosureHtml('Why this grade', list, { cls: 'ov-grade__why' }) : '';
}

// The still-true row: the status pill, the timed sentence, the Check button.
function liveRowHtml(s, primary) {
  const button = s.canCheck
    ? `<button type="button" class="og-btn${primary === 'check' ? ' og-btn--primary' : ''} ov-check" data-ux-action="ov-check"${s.checkLabel === 'Checking…' ? ' aria-busy="true" disabled' : ''}>${escapeHtml(s.checkLabel)}</button>`
    : (s.retry ? '<button type="button" class="og-btn ov-retry" data-ux-action="ov-retry">Retry</button>' : '');
  const pill = s.pill ? `<span class="og-pill${toneClass('og-pill', s.tone)} ov-live__pill">${escapeHtml(s.pill)}</span>` : '';
  const sentence = s.sentence.replace('live side', '\u0000');
  const sentenceHtml = sentence.includes('\u0000')
    ? escapeHtml(sentence).replace('\u0000', termHtml('vantage', 'live side'))
    : escapeHtml(s.sentence);
  // No leading newline: the simple layout's bytes stay those of its first release.
  return `<div class="ov-live__row">
        ${pill}
        <p class="ov-live__sentence">${sentenceHtml}</p>
        ${button}
      </div>
      ${s.error ? `<div class="og-callout og-callout--warn ov-live__error" role="status">The check could not start: ${escapeHtml(s.error)}</div>` : ''}
      ${s.cadence ? `<p class="ov-live__cadence og-muted">${escapeHtml(s.cadence)}</p>` : ''}`;
}

function stillHtml(s, primary) {
  return `
    <section class="ov-live og-panel og-panel--pad${toneClass('og-panel', s.tone)}" aria-labelledby="ov-live-eyebrow" aria-live="polite">
      <div class="og-eyebrow" id="ov-live-eyebrow">Is that still true right now?</div>
      ${liveRowHtml(s, primary)}
    </section>`;
}

// The next step: the sentence, the button, the why — shared by both layouts.
function nextRowHtml(n, primary) {
  if (!n || (!n.sentence && !n.button)) return '';
  const button = n.button
    ? `<button type="button" class="og-btn${primary === 'next' ? ' og-btn--primary' : ''} ov-next__btn" data-ux-action="${escapeHtml(n.button.action)}">${escapeHtml(n.button.label)}</button>`
    : '';
  const why = n.why && n.why.length
    ? disclosureHtml('Why', `<ul class="ov-why">${n.why.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`, { cls: 'ov-next__why' })
    : '';
  return `<div class="ov-next__row">
        <p class="ov-next__sentence">${escapeHtml(n.sentence)}</p>
        ${button}
      </div>
      ${why}`;
}

function nextHtml(n, primary) {
  const row = nextRowHtml(n, primary);
  if (!row) return '';
  return `
    <section class="ov-next og-panel og-panel--pad" aria-labelledby="ov-next-eyebrow">
      <div class="og-eyebrow" id="ov-next-eyebrow">What to do next</div>
      ${row}
    </section>`;
}

function simpleBodyHtml(model) {
  return gradeHtml(model.grade) + stillHtml(model.still, model.primary) + nextHtml(model.next, model.primary);
}

// ---------- the board ----------
//
// Three numbered stages under Expert's own words, one over each column —
// Discover · Diagnose · Remediate — a compact context bar for the service,
// then the columns in a 30 / 40 / 30 rhythm. Colour has two roles here: a
// layer keeps one identity colour wherever it appears (the plate, its cells),
// a result reads green, amber or red with words beside it; lime stays the
// brand's accent, for the one primary button and the pressed state. One
// outline icon family (24-unit grid, 1.6 stroke, currentColor), drawn inline.

const reading = (what) => `<p class="ov-reading og-muted" role="status">Reading ${what}…</p>`;
const footHtml = (action, label) => `<div class="ov-col__foot"><button type="button" class="og-btn og-btn--text ov-link" data-ux-action="${action}">${label} <span class="ov-link__arrow" aria-hidden="true">→</span></button></div>`;

const ICON_PATHS = {
  discover: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm9.5 16-4.4-4.4',
  diagnose: 'M3 12h4l2.5-6 4 12 2.5-6h5',
  remediate: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-2.4 2.6-2.6Z',
  ux: 'M4 5h16v11H4zM9 20h6M12 16v4',
  app: 'M8 7 4 12l4 5M16 7l4 5-4 5M14 4l-4 16',
  platform: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  infra: 'M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01',
  add: 'M12 5v14M5 12h14',
  update: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  review: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  exporters: 'M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0V7ZM12 16v5',
  alerts: 'M6 16v-5a6 6 0 1 1 12 0v5l2 2H4l2-2ZM10 20a2 2 0 0 0 4 0',
  dashboards: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  mttx: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2',
};
const iconHtml = (name, cls = '') => `<svg class="ov-ic${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${ICON_PATHS[name] || ''}"></path></svg>`;

// The workflow header: three numbered stages, one over each column, in the
// words the Expert tabs use.
const STAGES = [
  { n: 1, key: 'discover', word: 'Discover', ask: 'What is in place?' },
  { n: 2, key: 'diagnose', word: 'Diagnose', ask: 'Is it diagnostic-grade?' },
  { n: 3, key: 'remediate', word: 'Remediate', ask: 'What to change?' },
];
function stagesHtml() {
  return `<ol class="ov-stages" aria-label="The three stages">${STAGES.map((s) => `
      <li class="ov-stage ov-stage--${s.key}">
        <span class="ov-stage__n" aria-hidden="true">${s.n}</span>
        <span class="ov-stage__text"><span class="ov-stage__word">${iconHtml(s.key, 'ov-stage__ic')}${s.word}</span><span class="ov-stage__ask">${s.ask}</span></span>
      </li>`).join('')}</ol>`;
}

// Discover — the stack, top down. Each layer: its plate in its own colour,
// its name and hint, how many kinds of signal the repository declares on it
// (a result: green, amber, red) and how many things; then the ten cells, lit
// in the layer's colour where the repository declares that kind, with the
// count. The kinds are labelled once, above the first row.
const KIND_SHORT = { sli: 'SLI', slo: 'SLO', metric: 'Met', log: 'Log', trace: 'Trc', dashboard: 'Dash', alert: 'Alrt', runbook: 'Run', chaos: 'Chaos', synthetic: 'Syn' };
const plateHtml = (key) => `<span class="ov-plate" aria-hidden="true"><svg class="ov-plate__svg" viewBox="0 0 56 36"><path class="ov-plate__side" d="M2 16v5l26 13 26-13v-5"></path><path class="ov-plate__top" d="M28 3 54 16 28 29 2 16Z"></path></svg>${iconHtml(key, 'ov-plate__ic')}</span>`;

function kindHeadHtml(kinds) {
  return `<div class="ov-cells ov-cells--head" aria-hidden="true">${kinds.map((k) => `<span class="ov-cell-h" title="${escapeHtml(k.word)}">${escapeHtml(KIND_SHORT[k.key] || k.word)}</span>`).join('')}</div>`;
}

function layerRowHtml(r) {
  // A cell lit by live evidence alone (no declaration to count) shows a dot.
  const cells = r.kinds.map((k) => `<span class="ov-cell${k.present ? ' ov-cell--on' : ''}" title="${escapeHtml(k.label)}">${k.count > 0 ? k.count : (k.present ? '•' : '')}</span>`).join('');
  const present = r.kinds.filter((k) => k.present).map((k) => k.label).join(' · ');
  // The picture's name carries the kinds too: on the compact screen the
  // line under it is hidden from sight, never from assistive technology.
  const name = `${r.name}: ${r.covered} of ${r.of} kinds of signal${present ? ` — ${present}` : ''}`;
  return `
        <li class="ov-layer ov-layer--${escapeHtml(r.key)} ov-layer--${escapeHtml(r.tone)}">
          <div class="ov-layer__head">
            ${plateHtml(r.key)}
            <span class="ov-layer__name">${escapeHtml(r.name)}</span>
            <span class="ov-layer__hint">${escapeHtml(r.hint)}</span>
            <span class="og-pill og-pill--${escapeHtml(r.tone)} ov-layer__n">${r.covered} of ${r.of} kinds</span>
            <span class="ov-layer__total" title="declared on this layer"><b>${r.total}</b><small>declared</small></span>
          </div>
          <div class="ov-cells" role="img" aria-label="${escapeHtml(name)}">${cells}</div>
          <div class="ov-layer__kinds og-muted">${present ? escapeHtml(present) : 'nothing declared on this layer'}</div>
        </li>`;
}

// Discover opens on the summary — what the repository declares, by kind —
// and the summary opens to the stack: the kinds labelled once, then the four
// layers top down. The three stats stay in view either way. Open or closed
// is the person's choice and survives a repaint (a check, a fact read).
let layersOpen = false;
function repoSummaryHtml(L) {
  // One row per kind, its name and its count — a list to read down, not a
  // sentence to parse. Spans: a summary holds phrasing content only.
  const counts = L.composition.length
    ? `<span class="ov-comp">${L.composition.map((c) => `<span class="ov-comp__row"><span class="ov-comp__name">${escapeHtml(c.name)}</span><b class="ov-comp__n">${c.count}</b></span>`).join('')}</span>`
    : '<span class="ov-comp ov-comp--none og-muted">Nothing declared yet.</span>';
  return `
      <details class="ov-repo"${layersOpen ? ' open' : ''}>
        <summary class="ov-repo__sum">
          <span class="ov-repo__head"><span class="ov-repo__title">In the repository</span><span class="ov-repo__toggle" aria-hidden="true"><span class="ov-repo__show">Show the layers</span><span class="ov-repo__hide">Hide the layers</span></span></span>
          ${counts}
        </summary>
        <div class="ov-repo__layers">
          ${kindHeadHtml(L.rows[0].kinds)}
          <ol class="ov-stack" aria-label="The stack, top down">${L.rows.map(layerRowHtml).join('')}</ol>
        </div>
      </details>`;
}
// What the last Run's scan read and left out (overview-model.mjs scanModel):
// one line, and behind it each group of files left out with why.
function scanHtml(S) {
  if (!S) return '';
  const rows = (g) => g.rows.length
    ? `<ul class="ov-scan__files">${g.rows.map((r) => `<li><code>${escapeHtml(r.path)}</code>${r.why ? ` <span class="og-muted">${escapeHtml(r.why)}</span>` : ''}</li>`).join('')}${g.more ? `<li class="og-muted">… and ${g.more} more</li>` : ''}</ul>`
    : '';
  const groups = S.groups.map((g) => `<div class="ov-scan__group ov-scan__group--${escapeHtml(g.key)}"><p class="ov-scan__h">${g.count ? `<b>${g.count}</b> ` : ''}${escapeHtml(g.title)}</p>${rows(g)}</div>`).join('');
  const warnings = S.warnings.length ? `<div class="ov-scan__group ov-scan__group--warnings"><p class="ov-scan__h"><b>${S.warnings.length}</b> warning${S.warnings.length === 1 ? '' : 's'} from the scan</p><ul class="ov-scan__files">${S.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>` : '';
  const body = groups + warnings;
  return body
    ? `<details class="ov-scan ov-scan--${escapeHtml(S.tone)}"><summary class="ov-scan__sum">${escapeHtml(S.sentence)}</summary><div class="ov-scan__body">${body}</div></details>`
    : `<p class="ov-scan ov-scan--${escapeHtml(S.tone)} ov-scan__sum">${escapeHtml(S.sentence)}</p>`;
}

// The chain (overview-model.mjs chainModel): what people know — the
// exporters scraped, the alerts that fire, the dashboards they open — as
// three tiles in the order a signal travels, then the MTTD / MTTR the team
// holds itself to. A link's warning (objectives no alert covers, none found)
// is a line under the row: the tiles stay a picture.
function chainHtml(C) {
  const tiles = C.links.map((l, i) => `${i ? '<span class="ov-chain__arrow" aria-hidden="true">→</span>' : ''}
          <div class="ov-clink ov-clink--${escapeHtml(l.tone)}" role="listitem" title="${escapeHtml(`${l.count} ${l.words} — ${l.hint}`)}">
            <span class="ov-clink__head">${iconHtml(l.key, 'ov-clink__ic')}<span class="ov-clink__name">${escapeHtml(l.name)}</span></span>
            <span class="ov-clink__n">${l.count}</span>${l.parts ? `
            <span class="ov-clink__parts og-muted">${escapeHtml(l.parts)}</span>` : ''}
          </div>`).join('');
  const notes = C.links.filter((l) => l.note).map((l) => `<li class="ov-chain__note ov-chain__note--${escapeHtml(l.tone)}">${escapeHtml(l.note)}</li>`).join('');
  const m = C.mttx;
  return `
      <div class="ov-chain" role="list" aria-label="The chain: exporters, alerts, dashboards">${tiles}
      </div>${notes ? `
      <ul class="ov-chain__notes">${notes}</ul>` : ''}
      <div class="ov-mttx ov-mttx--${escapeHtml(m.tone)}" title="${escapeHtml(m.hint)}">
        ${iconHtml('mttx', 'ov-mttx__ic')}
        <span class="ov-mttx__name">MTTD / MTTR</span>
        <span class="ov-mttx__val">${escapeHtml(m.targets || 'Not declared')}</span>
        <span class="ov-mttx__note">${escapeHtml(m.origin === 'studio' ? m.note : (m.measured || m.note))}</span>${m.recommended ? mttxRecommendedHtml(m.recommended) : ''}${m.action || m.record ? `
        <span class="ov-mttx__acts">${m.action ? `<button type="button" class="og-btn og-btn--text ov-mttx__set" data-ux-action="ov-mttx-set">${escapeHtml(m.action)}</button>` : ''}${m.record ? `<button type="button" class="og-btn og-btn--text ov-mttx__set" data-ux-action="ov-mttx-record">${escapeHtml(m.record)}</button>` : ''}</span>` : ''}
      </div>`;
}

// No targets anywhere: what to aim for — the recommended profile in words, the others behind a fold
// with the incidents each one fits. Set targets… (the tile's button) chooses one.
function mttxRecommendedHtml(r) {
  return `
        <span class="ov-mttx__rec">Recommended: <b>${escapeHtml(r.words)}</b> <span class="og-muted">(${escapeHtml(r.name.toLowerCase())}: ${escapeHtml(r.conditions.toLowerCase())})</span></span>
        <details class="ov-mttx__more">
          <summary>Other profiles</summary>
          <ul class="ov-mttx__profiles">${r.profiles.map((p) => `
            <li><span class="ov-mttx__pname">${escapeHtml(p.name)}</span> <b>${escapeHtml(p.words)}</b> <span class="og-muted">— ${escapeHtml(p.conditions.toLowerCase())}</span></li>`).join('')}
          </ul>
        </details>`;
}

// Under the chain, the detail in one line; the machinery and the layers
// behind one disclosure, which stays open or closed through a repaint.
function machineryHtml(C, L) {
  const machinery = C.machinery.count ? `<span class="ov-repo__line">${escapeHtml(C.machinery.line)}</span>` : '<span class="ov-repo__line og-muted">No machinery declared.</span>';
  const layers = L ? `
        <div class="ov-repo__layers">
          ${kindHeadHtml(L.rows[0].kinds)}
          <ol class="ov-stack" aria-label="The stack, top down">${L.rows.map(layerRowHtml).join('')}</ol>
          <p class="ov-repo__cov og-muted">${escapeHtml(L.coverage)}${L.unplacedNote ? ` ${escapeHtml(L.unplacedNote)}` : ''}</p>
        </div>` : '';
  return `
      <details class="ov-repo"${layersOpen ? ' open' : ''}>
        <summary class="ov-repo__sum">
          <span class="ov-repo__head"><span class="ov-repo__title">The machinery and the layers</span><span class="ov-repo__toggle" aria-hidden="true"><span class="ov-repo__show">Show</span><span class="ov-repo__hide">Hide</span></span></span>
          ${machinery}
        </summary>${layers}
      </details>`;
}

function discoverColHtml(L, S = null, C = null) {
  const body = C
    ? `${chainHtml(C)}
      ${C.detail.count ? `<p class="ov-detail"><span class="ov-detail__h">Under it</span> ${escapeHtml(C.detail.line)}</p>` : ''}
      ${machineryHtml(C, L)}
      ${scanHtml(S)}`
    : L
      ? `${repoSummaryHtml(L)}
      <dl class="ov-stats">
        <div class="ov-stat" title="${escapeHtml(L.lead)}"><dt>Declared</dt><dd>${L.declared}</dd></div>
        <div class="ov-stat" title="${escapeHtml(L.coverage)}"><dt>Coverage</dt><dd>${L.coveragePct}<small>%</small></dd></div>
        <div class="ov-stat" title="${escapeHtml(L.unplacedNote || 'Everything found its layer.')}"><dt>Unplaced</dt><dd>${L.unplaced}</dd></div>
      </dl>
      ${scanHtml(S)}`
      : reading('the repository');
  const [title, sub] = C
    // Targets set in the studio are not the repository's: the subtitle says where each part comes from.
    ? ['The chain', C.mttx?.origin === 'studio'
      ? 'Exporters, alerts and dashboards as the repository declares them; MTTD / MTTR set in the studio'
      : 'Exporters, alerts, dashboards and MTTD / MTTR, as the repository declares them']
    : ['Layers', 'The stack, top down, as the repository declares it'];
  return `
    <section class="ov-col ov-col--discover og-panel og-panel--pad" aria-labelledby="ov-discover-h">
      <header class="ov-col__head">
        <h2 class="ov-card__h" id="ov-discover-h">${title}</h2>
        <p class="ov-card__sub">${sub}</p>
        <span class="ov-src" title="What the repository declares">REPO</span>
      </header>
      ${body}
      ${footHtml('ov-open-discover', 'Open in Discover')}
    </section>`;
}

// Diagnose — one status strip for the whole column (what was graded against
// what, when, and which probe families could not be read), then two groups:
// A, are the right signals in place — the letter as a shield and the seven
// criteria behind "Why this grade" (the grade alone: the specification's
// rules are Remediate's, things to add, never a second verdict here); B, can you trust what
// the signals show — the alignment as a ring, the four counts, the promises
// that hold, and the still-true row with its Check button.
function statusStripHtml(g, s, f) {
  const partial = f?.known && Array.isArray(f.partial) && f.partial.length ? f.partial : [];
  const tone = !s ? 'neutral'
    : s.status === 'unreachable' ? 'fail'
      : (s.status === 'never' || s.pending) ? 'neutral'
        : (s.stale || partial.length) ? 'warn' : 'ok';
  const parts = [];
  if (g?.basis === 'live') parts.push(['source', 'Graded against live']);
  else if (g?.basis === 'recording') parts.push(['source', 'Graded against a recording']);
  else if (g?.basis === 'repository') parts.push(['source', 'Graded from the repository']);
  // A letter over fewer criteria says so beside its source ("on 6 of 7 criteria").
  if (g?.criteria) parts.push(['criteria', String(g.criteria).replace(/^Graded /, '')]);
  if (s?.running) parts.push(['when', 'checking now…']);
  else if (s?.ago) parts.push(['when', `checked ${s.ago}`]);
  else if (s?.status === 'never') parts.push(['when', 'never checked against live']);
  if (partial.length) parts.push(['partial', `live side partial: ${partial.join(', ')} not read`]);
  if (s?.stale) parts.push(['stale', 'older than a day']);
  // The cadence rides at the end; a short screen drops it (it is a fact about
  // the journey, not about this reading).
  if (s?.cadence) parts.push(['cadence', s.cadence.replace(/\.$/, '').replace(/^Checks run only when you click$/, 'checks run when you click').replace(/^Checks run/, 'checks run')]);
  if (!parts.length) return '';
  const spans = parts.map(([k, text], i) => `${i ? `<span class="ov-status__sep ov-status__part--${k}" aria-hidden="true">·</span> ` : ''}<span class="ov-status__part ov-status__part--${k}">${escapeHtml(text)}</span>`).join(' ');
  return `<div class="ov-status ov-status--${tone}" role="status"><span class="ov-status__dot" aria-hidden="true"></span><span class="ov-status__text">${spans}</span></div>`;
}

// Remediate's rules: what the specification requires of the service's tier and
// the pack does not declare — the count, the first three by the clause's own
// words (the rest counted), and the way to all of them in Expert's Conformance.
const RULES_SHOWN = 3;
function rulesHtml(r) {
  if (!r) return '';
  const head = '<h3 class="ov-rules__h">Required by the specification</h3>';
  if (r.unknown) return `<div class="ov-rules ov-rules--unknown">${head}<p class="ov-col__note og-muted">${escapeHtml(r.sentence)}</p></div>`;
  const shown = r.missing.slice(0, RULES_SHOWN);
  const more = r.missing.length - shown.length;
  const list = shown.length ? `<ul class="ov-rules__list">${shown.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}${more ? `<li class="ov-rules__more og-muted">and ${more} more</li>` : ''}</ul>` : '';
  const link = r.unmet ? '<button type="button" class="og-btn og-btn--text ov-link ov-rules__link" data-ux-action="ov-open-rules">See the rules in Expert <span class="ov-link__arrow" aria-hidden="true">→</span></button>' : '';
  return `<div class="ov-rules ov-rules--${escapeHtml(r.tone)}">${head}<p class="ov-col__note">${escapeHtml(r.sentence)}</p>${list}${link}</div>`;
}

const ringTone = (pct) => (pct === null ? 'neutral' : pct >= 85 ? 'ok' : pct >= 50 ? 'warn' : 'fail');
const RING_R = 38;
const RING_C = 2 * Math.PI * RING_R;
function ringHtml(f) {
  // With the chain counted, the ring is the chain's alignment, not everything's.
  const raw = f?.known ? (f.chain ? f.chain.pct : f.alignmentPct) : null;
  const pct = raw !== null && raw !== undefined ? Math.max(0, Math.min(100, raw)) : null;
  const offset = pct === null ? RING_C : RING_C * (1 - pct / 100);
  const label = pct === null ? 'Not known' : `${Math.round(pct)} in 100${f.chain ? ' of the chain' : ''} aligned`;
  return `
        <svg class="ov-ring ov-ring--${ringTone(pct)}" viewBox="0 0 88 88" role="img" aria-label="${escapeHtml(label)}">
          <circle class="ov-ring__track" cx="44" cy="44" r="${RING_R}"></circle>
          <circle class="ov-ring__arc" cx="44" cy="44" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 44 44)"></circle>
          <text class="ov-ring__pct" x="44" y="42">${pct === null ? '–' : `${Math.round(pct)}%`}</text>
          <text class="ov-ring__word" x="44" y="58">aligned</text>
        </svg>`;
}

// The chain against live, one line per link: its name, what else holds in
// words ("7 not read live"), and how many of the declared run live (21/21).
function chainLiveHtml(chain) {
  return `<ul class="ov-clive">${chain.links.map((l) => `<li class="ov-clive__row ov-clive__row--${escapeHtml(l.tone)}"${l.of ? ` title="${escapeHtml(`${l.live} of ${l.of} declared ${l.name.toLowerCase()} live`)}"` : ''}>${iconHtml(l.key, 'ov-clive__ic')}<span class="ov-clive__name">${escapeHtml(l.name)}</span><span class="ov-clive__line og-muted">${escapeHtml(l.line)}</span><span class="ov-clive__n">${l.of ? `${l.live}<small>/${l.of}</small>` : '–'}</span></li>`).join('')}</ul>`;
}

function fidelityHtml(f) {
  const tiles = f?.known
    ? (f.chain
      ? chainLiveHtml(f.chain)
      : `<div class="ov-tiles">${f.tiles.map((t) => `<div class="ov-tile ov-tile--${escapeHtml(t.tone)}" title="${escapeHtml(t.note)}"><span class="ov-tile__n">${t.value}</span><span class="ov-tile__l">${escapeHtml(t.label)}</span></div>`).join('')}</div>`)
    : `<p class="ov-fid__note og-muted">${escapeHtml(f?.note || 'Reading…')}</p>`;
  const c = f?.known ? f.chains : null;
  const chains = c ? `
      <div class="ov-chains" title="${escapeHtml(`${c.intact} intact · ${c.partial} in part · ${c.broken} broken`)}">
        <div class="ov-chains__bar" role="img" aria-label="${escapeHtml(c.sentence)}">
          ${c.intact ? `<span class="ov-chains__seg ov-chains__seg--ok" style="flex-grow:${c.intact}"></span>` : ''}
          ${c.partial ? `<span class="ov-chains__seg ov-chains__seg--warn" style="flex-grow:${c.partial}"></span>` : ''}
          ${c.broken ? `<span class="ov-chains__seg ov-chains__seg--fail" style="flex-grow:${c.broken}"></span>` : ''}
        </div>
        <p class="ov-chains__text og-muted">${escapeHtml(c.sentence)}</p>
      </div>` : '';
  // A stale reading is said beside the counts; the families not read are in the status strip.
  const stale = f?.known && /older than a day/.test(f.note || '') ? `<p class="ov-fid__partial og-muted">${escapeHtml(f.note.split('. ').find((p) => /older than a day/.test(p)) || f.note)}</p>` : '';
  return `
      <div class="ov-fid">
        ${ringHtml(f)}
        ${tiles}
      </div>
      ${chains}
      ${stale}`;
}

// The seven rows are more detail than the letter: always behind "Why this
// grade", closed until the reader opens it, whatever room the screen has.
// Opened, it stays open through the board's repaints (a check finishing),
// as the Discover layers do.
let whyOpen = false;
function boardWhyHtml(g, serviceId = null) {
  const list = whyListHtml(g, { open: true, serviceId });
  if (!list) return '';
  // No reasons to give, only the criteria to switch: the disclosure says so.
  const title = Array.isArray(g.why) && g.why.length ? 'Why this grade' : 'The criteria graded';
  return disclosureHtml(title, list, { cls: 'ov-grade__why', open: whyOpen });
}

const cardHeadHtml = (badge, id, question, sub) => `
        <header class="ov-card__head">
          <span class="ov-card__badge" aria-hidden="true">${badge}</span>
          <div class="ov-card__titles"><h2 class="ov-card__h" id="${id}">${question}</h2><p class="ov-card__sub">${sub}</p></div>
        </header>`;

function diagnoseColHtml(g, f, s, primary, serviceId = null) {
  // The source line under the shield repeats the status strip when the
  // letter is the live one; it stays for the other sources, which it explains.
  const source = g.source && g.basis !== 'live' ? `<div class="ov-grade__src og-muted">${escapeHtml(g.source)}</div>` : '';
  return `
    <div class="ov-col ov-col--diagnose">
      ${statusStripHtml(g, s, f)}
      <section class="ov-card ov-card--a ov-grade og-panel og-panel--pad${toneClass('og-panel', g.tone)}" aria-labelledby="ov-grade-eyebrow">
        ${cardHeadHtml('A', 'ov-grade-eyebrow', termHtml('diagnostic-grade', 'Are the right signals in place?'), 'The repository against what good looks like')}
        <div class="ov-result">
          <div class="ov-shield ov-tone-${escapeHtml(g.tone || 'neutral')}"${g.title ? ` title="${escapeHtml(g.title)}"` : ''} aria-label="Grade ${escapeHtml(g.letter)}"><span class="ov-shield__letter">${escapeHtml(g.letter)}</span></div>
          <div class="ov-result__text">
            <div class="ov-grade__label">${escapeHtml(g.label)}</div>
            ${g.word ? `<div class="ov-grade__word">${escapeHtml(g.word)}</div>` : ''}${g.criteria ? `
            <div class="ov-grade__criteria og-muted">${escapeHtml(g.criteria)}</div>` : ''}
            ${source}
          </div>
        </div>
        ${boardWhyHtml(g, serviceId)}
      </section>
      <section class="ov-card ov-card--b ov-live og-panel og-panel--pad${toneClass('og-panel', s.tone)}" aria-labelledby="ov-live-eyebrow" aria-live="polite">
        ${cardHeadHtml('B', 'ov-live-eyebrow', 'Can you trust what the signals show?', 'The repository against live')}
        ${fidelityHtml(f)}
        ${liveRowHtml(s, primary)}
        ${footHtml('ov-next-diagnose', 'Open in Diagnose')}
      </section>
    </div>`;
}

// Remediate — the delta as three tiles (what Remediate compiles, what runs
// differently, what runs live unasked — to review, never to remove) and the
// one next step with its one primary button.
const CHANGE_ICON = { add: 'add', update: 'update', review: 'review' };
const CHANGE_SHORT = { add: 'declared, not live', update: 'live, not as declared', review: 'live, not declared' };
// A tile's count by link, in the chain's words (Exporters 0 · Alerts 2 · Dashboards not read); a record
// counted before the tiers has no parts and keeps the short caption.
const changePartsHtml = (i) => (Array.isArray(i.parts) && i.parts.length
  ? `<ul class="ov-change__parts" aria-label="${attr(`${i.label} by link`)}">${i.parts.map((p) => `<li${p.value ? ' class="is-some"' : ''}>${iconHtml(p.key, 'ov-change__pic')}<span class="ov-change__pname">${escapeHtml(p.name)}</span><span class="ov-change__pn">${p.unread ? '<span class="og-muted" title="not read live" aria-hidden="true">–</span><span class="ov-sr">not read live</span>' : p.value}</span></li>`).join('')}</ul>`
  : `<span class="ov-change__note og-muted">${escapeHtml(CHANGE_SHORT[i.key] || i.note)}</span>`);
function remediateColHtml(c, n, primary, rules = null) {
  const items = c
    ? (c.known
      ? `<div class="ov-changes">${c.items.map((i) => `<div class="ov-change ov-change--${escapeHtml(i.tone)}" title="${escapeHtml(i.note)}">${iconHtml(CHANGE_ICON[i.key] || 'add', 'ov-change__ic')}<span class="ov-change__l">${escapeHtml(i.label)}</span><span class="ov-change__n">${i.value === null ? '<span aria-hidden="true">–</span><span class="ov-sr">not read live</span>' : i.value}</span>${changePartsHtml(i)}</div>`).join('')}</div>${c.sentence ? `<p class="ov-col__note og-muted">${escapeHtml(c.sentence)}</p>` : ''}${c.beyond ? `<p class="ov-col__note ov-beyond og-muted">${escapeHtml(c.beyond)}</p>` : ''}`
      : `<p class="ov-col__lead og-muted">${escapeHtml(c.sentence)}</p>`)
    : reading('the last check');
  return `
    <section class="ov-col ov-col--remediate og-panel og-panel--pad" aria-labelledby="ov-remediate-h">
      <header class="ov-col__head">
        <h2 class="ov-card__h" id="ov-remediate-h">Changes to apply</h2>
        <p class="ov-card__sub">Between the repository and live</p>
      </header>
      ${items}
      ${rulesHtml(rules)}
      ${nextRowHtml(n, primary)}
      ${footHtml('ov-open-remediate', 'Open in Remediate')}
    </section>`;
}

function boardBodyHtml(model) {
  const b = model.board || {};
  return `
    ${stagesHtml()}
    <div class="ov-board">
      ${discoverColHtml(b.layers, b.scan, b.chain)}
      ${diagnoseColHtml(model.grade, b.fidelity, model.still, model.primary, model.service?.id ?? null)}
      ${remediateColHtml(b.changes, model.next, model.primary, b.rules)}
    </div>`;
}

// The board draws a service with a pack of its own; without one there is
// nothing to picture, and the three sentences say so.
export function boardApplies(model) {
  return model?.kind === 'service' && model.layout === 'board' && !['none', 'error'].includes(model.grade?.basis);
}

// No service yet: the drift check starts here, not in Expert. The three steps
// are Discover's own words; each step offers its own ways in — Pack A (what
// the repository declares) from a scan or an upload, Pack B (what live
// verifies) from the MCP server or an upload — through Expert's own flows
// (the host proxies them). Step 2 waits for Pack A; with both in, step 3 is
// the comparison, opened by the host. A rank that cannot load a pack sees
// the cards drawn unavailable with the reason, and each activation explains
// (the honesty rule: drawn, never removed).
const START_STEPS = [
  { n: 1, label: 'Scan a repo', sub: 'what the service <em>declares</em> — Pack A' },
  { n: 2, label: 'Generate from live', sub: 'what the platform <em>verifies</em> — Pack B' },
  { n: 3, label: 'Diagnose drift', sub: 'where declared and live disagree — automatic' },
];
const START_CARDS = {
  a: [
    { action: 'ov-scan', glyph: '↻', label: 'Scan a repository', sub: 'walk Prom / OTel / Grafana / Alertmanager configs — local folder or a GitHub URL' },
    { action: 'ov-upload-a', glyph: '▤', label: 'Upload a pack', sub: 'an existing canonical v1.5 YAML or JSON manifest, as Pack A' },
  ],
  b: [
    { action: 'ov-live', glyph: '⟳', label: 'Generate live from MCP', sub: 'interrogate a live OpenTelemetry MCP server for backends, baselines and anomalies' },
    { action: 'ov-upload-b', glyph: '▤', label: 'Upload a pack', sub: 'a live snapshot or another v1.5 manifest, as Pack B' },
  ],
};
// The hook each card calls (host.overview): a host that does not supply one
// gets that card drawn unavailable, never a card that does nothing.
const START_HOOK = { 'ov-scan': 'scan', 'ov-upload-a': 'upload', 'ov-live': 'live', 'ov-upload-b': 'upload' };
function startCardHtml(c, reason) {
  const off = !!reason;
  return `
          <button type="button" class="ov-start__card${off ? ' ov-start__card--off' : ''}" data-ux-action="${off ? 'ov-explain' : c.action}"${off ? ` aria-disabled="true" data-reason="${escapeHtml(reason)}"` : ''}>
            <span class="ov-start__glyph" aria-hidden="true">${c.glyph}</span>
            <span class="ov-start__label">${escapeHtml(c.label)}</span>
            <span class="ov-start__sub">${escapeHtml(c.sub)}</span>${off ? `
            <span class="ov-start__why">${escapeHtml(reason)}</span>` : ''}
          </button>`;
}
function startHtml(sources, start, serviceName = null, ov = {}) {
  const denied = sources && sources.enabled === false ? (sources.reason || 'Not available for your role here.') : '';
  const offered = (c) => (typeof ov[START_HOOK[c.action]] === 'function' ? '' : 'Not offered here.');
  const a = start?.a || null;
  const steps = START_STEPS.map((st) => `
        <li class="ov-step${st.n === 1 && a ? ' ov-step--done' : ''}">
          <span class="ov-step__num">${st.n === 1 && a ? '✓' : st.n}</span>
          <span class="ov-step__body">
            <span class="ov-step__label">${escapeHtml(st.label)}</span>
            <span class="ov-step__sub">${st.sub}</span>
          </span>
        </li>`).join('');
  const colA = a
    ? `
          <div class="ov-start__done og-panel" role="status">
            <span class="ov-start__label">Pack A: ${escapeHtml(a.label)}</span>
            <span class="ov-start__sub">loaded — now its live side, in step 2</span>
            <button type="button" class="ov-start__expert" data-ux-action="ov-start-reset">Change Pack A</button>
          </div>`
    : START_CARDS.a.map((c) => startCardHtml(c, denied || offered(c))).join('');
  const colB = START_CARDS.b.map((c) => startCardHtml(c, denied || offered(c) || (a ? '' : 'Load Pack A first, in step 1.'))).join('');
  return `
    <section class="ov-start" aria-labelledby="ov-start-h">
      <header class="ov-start__head">
        <h2 class="ov-card__h" id="ov-start-h">${a ? 'Pack A is in — now its live side.' : (serviceName ? `No pack for ${escapeHtml(serviceName)} yet.` : 'No service to show yet.')}</h2>
        <p class="ov-start__lede og-muted">${a ? 'Load what live verifies in step 2, and the drift opens by itself.' : (serviceName ? `Nothing to grade until a pack that names ${escapeHtml(serviceName)} is registered — start the drift check here.` : 'A service appears here once a pack that names it is registered — start the drift check here.')}</p>
      </header>
      <ol class="ov-steps" aria-label="The drift check, in three steps">${steps}
      </ol>
      <div class="ov-start__cols">
        <div class="ov-start__col" role="group" aria-label="Step 1: Pack A">${colA}
        </div>
        <div class="ov-start__col" role="group" aria-label="Step 2: Pack B">${colB}
        </div>
        <div class="ov-start__col" role="group" aria-label="Step 3: the comparison">
          <p class="ov-start__auto og-muted">Runs by itself once both packs are in: what the repository declares, checked against what runs live.</p>
        </div>
      </div>
      <p class="ov-start__foot og-muted">Already have packs? <button type="button" class="ov-start__expert" data-ux-action="ov-expert">Open Expert mode</button></p>
    </section>`;
}

export function renderOverview(container, model, host = appHost) {
  const ov = host?.overview || {};
  // A reason being typed belongs to the service it was asked for.
  if (gradeAsk && gradeAsk.service !== (model.service?.id ?? null)) gradeAsk = null;
  // …and keeps its focus and caret through a repaint (a check finishing redraws the board).
  const typing = container.querySelector?.('[data-grade-reason]') || null;
  const typingFocus = typing && typing.ownerDocument?.activeElement === typing
    ? { start: typing.selectionStart ?? null, end: typing.selectionEnd ?? null } : null;
  const redraw = () => renderOverview(container, model, host);
  // "Stop grading it": the reason is required — an empty one keeps the ask open, marked.
  function switchOff(key) {
    const input = container.querySelector?.('[data-grade-reason]') || null;
    const reason = String(input?.value ?? gradeAsk?.reason ?? '').trim();
    if (!reason) { input?.setAttribute?.('aria-invalid', 'true'); input?.focus?.({ preventScroll: true }); return; }
    gradeAsk = null;
    ov.setGradeCriterion?.(key, { graded: false, reason });
  }
  let body;
  let board = false;
  if (model.kind === 'empty' && model.start) {
    body = startHtml(model.sources, model.start, null, ov);
  } else if (model.kind === 'empty') {
    body = emptyStateHtml({
      title: 'No service to show yet.',
      checked: 'the services table of this organisation',
      body: 'A service appears here once a pack that names it is registered.',
      actions: [{ action: 'ov-expert', label: 'Open Expert mode' }],
    });
  } else if (model.kind === 'error') {
    body = emptyStateHtml({
      title: 'The services could not be read.',
      checked: model.error || '',
      actions: [{ action: 'ov-retry', label: 'Retry' }, { action: 'ov-expert', label: 'Open Expert mode' }],
      tone: 'warn',
    });
  } else if (model.kind === 'loading') {
    body = '<p class="ov-loading og-muted" role="status">Reading the services…</p>';
  } else if (model.kind === 'service' && model.start) {
    body = headHtml(model) + startHtml(model.sources, model.start, model.service?.name, ov);
  } else if (boardApplies(model)) {
    try { body = headHtml(model) + boardBodyHtml(model); board = true; }
    catch (e) {
      // The simple layout is the fallback: never a blank screen.
      if (typeof console !== 'undefined') console.error('[overview] the board could not be drawn; the simple layout instead', e);
      body = headHtml(model) + simpleBodyHtml(model);
    }
  } else {
    body = headHtml(model) + simpleBodyHtml(model);
  }
  container.innerHTML = `<div class="ov-page${board ? ' ov-page--board' : ''}">${body}</div>`;

  wireUxActions(container, {
    'ov-env': (ev, el) => ov.selectEnv?.(el.dataset.env),
    'ov-check': () => ov.checkNow?.(),
    // Each carries the comparison the board graded (model.compare: the
    // live pack its check read, or null) — a host that ignores it opens
    // Expert on the repository alone, as before.
    'ov-open-discover': () => ov.openDiscover?.(model.compare || null),
    'ov-next-diagnose': () => ov.openDiagnose?.(model.compare || null),
    'ov-open-remediate': () => ov.openRemediate?.(model.compare || null),
    'ov-open-rules': () => ov.openRules?.(model.compare || null),
    'ov-next-neuron': () => ov.openNeuron?.(),
    'ov-expert': () => ov.expert?.(),
    'ov-retry': () => ov.retry?.(),
    'ov-scan': () => ov.scan?.(),
    'ov-upload-a': () => ov.upload?.('a'),
    'ov-live': () => ov.live?.(),
    'ov-upload-b': () => ov.upload?.('b'),
    'ov-start-reset': () => ov.resetStart?.(),
    'ov-explain': (ev, el) => ov.explain?.(el.dataset.reason),
    'ov-control-room': () => ov.toggleControlRoom?.(),
    'ov-back': () => ov.backToList?.(),
    // The MTTD / MTTR tile's Set targets… / Change targets…: the service's form at its Targets answer.
    'ov-mttx-set': () => ov.setTargets?.('board'),
    // Record a chaos run…: the service's chaos run form, on the service list where its form lives.
    'ov-mttx-record': () => ov.recordChaosRun?.('board'),
    // A criterion's switch (the model's `switches`): ask why in place, then the host's setGradeCriterion.
    'ov-grade-ask': (ev, el) => { gradeAsk = { service: model.service?.id ?? null, key: el.dataset.key, reason: '', focus: true }; whyOpen = true; redraw(); },
    'ov-grade-ask-cancel': () => { gradeAsk = null; redraw(); },
    'ov-grade-off': (ev, el) => switchOff(el.dataset.key),
    'ov-grade-on': (ev, el) => ov.setGradeCriterion?.(el.dataset.key, { graded: true }),
  });
  // The reason as it is typed stays with the view, so a repaint (a check finishing) keeps it;
  // Enter switches the criterion off, Escape gives up.
  const reasonInput = container.querySelector?.('[data-grade-reason]') || null;
  if (reasonInput) {
    reasonInput.addEventListener?.('input', () => { if (gradeAsk) gradeAsk.reason = reasonInput.value; });
    reasonInput.addEventListener?.('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault?.(); switchOff(reasonInput.dataset.gradeReason); }
      else if (ev.key === 'Escape') { ev.preventDefault?.(); gradeAsk = null; redraw(); }
    });
    if (gradeAsk?.focus || typingFocus) {
      if (gradeAsk) gradeAsk.focus = false;
      reasonInput.focus?.({ preventScroll: true });
      if (typingFocus) { try { reasonInput.setSelectionRange?.(typingFocus.start, typingFocus.end); } catch { /* a field that takes no range */ } }
    }
  }
  const select = container.querySelector('#ov-service');
  if (select) select.addEventListener('change', () => ov.selectService?.(Number(select.value)));
  const repo = container.querySelector('.ov-repo');
  if (repo) repo.addEventListener('toggle', () => { layersOpen = repo.open; });
  const why = container.querySelector('.ov-board .ov-grade__why');
  if (why) why.addEventListener('toggle', () => { whyOpen = why.open; });
}

// ---------- the service list: Overview's front door ----------
//
// renderServiceList(container, list, form, host): `list` is overview-model.mjs
// serviceListModel(...), `form` its formModel(...). The actions ride on
// host.overview: addService(), editService(serviceId, env), runService(key),
// openService(serviceId, env), formInput(field, value), saveService({ run,
// repoAuth }) — `repoAuth` the person's own token when the form's field holds
// one (drawn only where the model offers it: formModel's `heldTokens`), with
// signInRepoHost(kind, null, { fromForm: true }) before it where the host
// offers sign-in —
// closeForm(), showAll(), compare(), runService(key, { repoAuth }) — a row's
// Run with the person's own token (asked for on the row when its host wants
// it) — and forgetRepoToken(kind); and the Folder answer's panel when the
// model offers Browse…: browseFolders() (Browse…, which closes an open
// panel), openFolder(path) (a folder, Up, Start from the top — null is the
// top), chooseFolder(path), closeFolders(); and Upload's when the model
// offers it: pickRepositoryFolder(), pickRepositoryZip(),
// dropRepository(dataTransfer). One primary button: Add a service, or — with
// the form open — Save and run.

const SVC_ICONS = {
  github: 'M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21',
  ado: 'M4 7 14 3l6 3v12l-6 3-10-4 10 1V6L7 9v7l-3-1Z',
  path: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  live: 'M5 12a7 7 0 0 1 14 0M8.5 12a3.5 3.5 0 0 1 7 0M12 12v8M2 12h0M22 12h0',
  clock: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
};
const svcIcon = (name) => `<svg class="ov-ic ov-svc__ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${SVC_ICONS[name] || ''}"></path></svg>`;
const attr = (v) => escapeHtml(String(v ?? ''));

// One environment of one service, in its column: the endpoint that reads it live (its name; the
// host beneath, cut short, whole on hover), the branch its Run reads, the grade with how much
// matches live, when it was last checked, Run and Open. The endpoint's name opens the form on
// this environment (its endpoint, its branch). A column the service does not declare says so,
// with Add for a person who may.
function mxCellHtml(r, col, svc, canWrite) {
  if (!r) {
    const add = canWrite ? ` <button type="button" class="ov-mx__add" data-ux-action="ov-svc-edit" data-service="${attr(svc.serviceId)}" data-env="${attr(col)}" aria-label="Add ${attr(col)} to ${attr(svc.name)}">Add</button>` : '';
    return `<div class="ov-mx__cell ov-mx__cell--none" data-col="${attr(col)}"><span class="ov-sr">${escapeHtml(col)}: </span><span class="ov-mx__none"><span class="ov-mx__dot" aria-hidden="true"></span>Not declared</span>${add}</div>`;
  }
  const host = r.live?.origin ? r.live.origin.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
  const ep = r.live
    ? `<button type="button" class="ov-mx__ep" data-ux-action="ov-svc-edit" data-service="${attr(r.serviceId)}" data-env="${attr(r.env)}" title="Change ${attr(r.name)} in ${attr(r.env)}: its endpoint and branch">${escapeHtml(r.live.name)}</button>${host ? `<span class="ov-mx__host og-muted" title="${attr(r.live.origin)}">${escapeHtml(host)}</span>` : ''}`
    : `<button type="button" class="ov-svc__fill" data-ux-action="ov-svc-edit" data-service="${attr(r.serviceId)}" data-env="${attr(r.env)}">Choose the MCP endpoint</button>`;
  const branch = r.branch ? `<span class="ov-mx__ref og-muted" title="${attr(r.branch.own ? `The branch ${r.env} reads` : "The repository's branch")}">${escapeHtml(r.branch.name || 'default branch')}</span>` : '';
  const l = r.last;
  let grade;
  if (r.run.running) grade = '<span class="ov-mx__grade" role="status"><span class="ov-svc__letter ov-svc__letter--none" aria-hidden="true">…</span><b>Running…</b></span>';
  else {
    const letter = l.letter ? `<span class="ov-svc__letter ov-tone-${attr(l.tone)}" aria-label="Grade ${attr(l.letter)}"${l.gradeLabel ? ` title="${attr(l.gradeLabel)}"` : ''}>${escapeHtml(l.letter)}</span>` : '<span class="ov-svc__letter ov-svc__letter--none" aria-hidden="true">–</span>';
    const what = l.state === 'checked' && l.alignmentPct !== null ? `${Math.round(l.alignmentPct)}% match`
      : l.state === 'unreachable' ? 'Live did not answer'
        : l.state === 'never' ? 'Not checked yet' : l.state === 'checked' ? 'Match not known' : l.word;
    grade = `<span class="ov-mx__grade">${letter}<b>${escapeHtml(what)}</b></span>`;
  }
  const when = !r.run.running && l.ago ? `<span class="ov-mx__when og-muted">${svcIcon('clock')}${escapeHtml(l.state === 'unreachable' ? `Tried ${l.ago}` : `Checked ${l.ago}`)}</span>` : '';
  const runBtn = r.run.enabled || r.run.running
    ? `<button type="button" class="og-btn ov-svc__run" data-ux-action="ov-svc-run" data-key="${attr(r.key)}"${r.run.running ? ' aria-busy="true" disabled' : ''} aria-label="Run ${attr(r.name)} in ${attr(r.env)}">${r.run.running ? 'Running…' : 'Run'}</button>`
    : `<button type="button" class="og-btn ov-svc__run" data-ux-action="ov-explain" aria-disabled="true" data-reason="${attr(r.run.reason)}" title="${attr(r.run.reason)}" aria-label="Run ${attr(r.name)} in ${attr(r.env)}">Run</button>`;
  const openBtn = r.open.enabled
    ? `<button type="button" class="og-btn ov-svc__open" data-ux-action="ov-svc-open" data-service="${attr(r.serviceId)}" data-env="${attr(r.env)}" aria-label="Open ${attr(r.name)} in ${attr(r.env)}">Open</button>` : '';
  return `<div class="ov-mx__cell${r.complete ? '' : ' ov-mx__cell--incomplete'}" data-col="${attr(col)}">
            <span class="ov-sr">${escapeHtml(col)}: </span><div class="ov-mx__where">${ep}${branch}</div>
            ${grade}${when}
            <div class="ov-mx__acts">${runBtn}${openBtn}</div>
          </div>`;
}

// The repository column: where it is declared. A GitHub or Azure DevOps repository's branch is
// each environment's, in its column; a folder says where it is, an upload when it came.
function mxRepoHtml(svc, first) {
  if (!svc.repository) {
    return `<button type="button" class="ov-svc__fill" data-ux-action="ov-svc-edit" data-service="${attr(svc.serviceId)}" data-env="${attr(first?.env ?? '')}">Add the repository</button>`;
  }
  const p = svc.repository;
  const remote = p.kind === 'github' || p.kind === 'ado';
  return `<span class="ov-svc__place" title="${attr(p.title)}">${svcIcon(p.kind)}<span class="ov-svc__place-text"><span class="ov-svc__kind">${escapeHtml(p.kindText)}</span><span class="ov-svc__loc">${escapeHtml(p.text)}</span>${!remote && p.detail ? `<span class="ov-svc__ref">${escapeHtml(p.detail)}</span>` : ''}${p.off ? '<span class="ov-svc__ref">switched off in Settings</span>' : ''}</span></span>`;
}

// The person's own token for a repository its host may not show without it:
// one field and Run with it, sent with this Run (the host keeps it in memory
// for the tab's next Runs of that host) — after Sign in to …, when the host
// offers sign-in here (the Run starts again once the person is signed in).
// Drawn from the start on a row that may need it (`auth.offered`), so no Run
// has to fail to be asked; the row's own Run sends what the field holds too.
function svcAuthHtml(r) {
  const id = `ov-auth-${String(r.key).replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const signIn = r.auth.signIn ? `
          <button type="button" class="og-btn" data-ux-action="ov-svc-sign-in" data-kind="${attr(r.auth.signIn.kind)}" data-key="${attr(r.key)}">${escapeHtml(r.auth.signIn.label)}</button>
          <span class="ov-svc__auth-or og-muted">or</span>` : '';
  return `
        <div class="ov-svc__auth${r.auth.refused ? ' ov-svc__auth--refused' : ''}${r.auth.offered ? ' ov-svc__auth--offered' : ''}" role="group" aria-label="${attr(`Your ${r.auth.label} for ${r.name}`)}">${signIn}
          <label class="ov-svc__auth-f"><span class="ov-svc__auth-l">Your ${escapeHtml(r.auth.label)}</span><input class="og-input" type="password" data-auth-input="${attr(r.key)}" data-auth-service="${attr(r.serviceId)}" autocomplete="one-time-code" spellcheck="false" aria-describedby="${id}"></label>
          <button type="button" class="og-btn" data-ux-action="ov-svc-auth-run" data-key="${attr(r.key)}">Run with it</button>
          <span class="ov-svc__auth-note og-muted" id="${id}">${escapeHtml(r.auth.text)}</span>
        </div>`;
}

// One service: its name, its repository, a cell per environment column, then Run all (two or more
// environments that can run) and Change; beneath, a Run's error naming its environment, and the
// token or sign-in ask once for the service — the token is the person's for the host, so one field
// serves every environment (its Run with it runs the first environment that asked). An ask only
// offered (no Run asked yet) folds under the repository; one a Run asked for is open, beneath.
function mxRowHtml(svc, columns, canWrite) {
  const first = columns.map((c) => svc.cells[c]).find(Boolean) || svc.bare;
  const name = `<span class="ov-svc__name">${escapeHtml(svc.name)}</span>${svc.bare ? `<button type="button" class="ov-svc__fill" data-ux-action="ov-svc-edit" data-service="${attr(svc.serviceId)}" data-env="">Add an environment</button>` : ''}`;
  const all = svc.runAll.keys.length > 1 || (svc.runAll.running && svc.rows.length > 1)
    ? `<button type="button" class="og-btn ov-mx__all" data-ux-action="ov-svc-run-all" data-keys="${attr(svc.runAll.keys.map(encodeURIComponent).join(','))}"${svc.runAll.running ? ' aria-busy="true" disabled' : ''} aria-label="Run ${attr(svc.name)} in every environment">${svc.runAll.running ? 'Running…' : 'Run all'}</button>` : '';
  const change = `<button type="button" class="ov-svc__edit" data-ux-action="ov-svc-edit" data-service="${attr(svc.serviceId)}" data-env="${attr(first?.env ?? '')}" aria-label="Change ${attr(svc.name)}: where it is declared, where it runs, its MTTD / MTTR targets" title="Where it is declared, where it runs, its MTTD / MTTR targets">Change</button>`;
  const errors = svc.rows.filter((r) => r.error).map((r) => `
        <p class="ov-svc__error ov-mx__note" role="alert">${r.env ? `<b>${escapeHtml(r.env)}:</b> ` : ''}${escapeHtml(r.error)}</p>`).join('');
  // An ask a Run answered (refused, signed in as another) before one only offered.
  const asked = svc.rows.filter((r) => r.auth);
  const ask = asked.find((r) => !r.auth.offered) || asked[0] || null;
  const folded = !!ask && ask.auth.offered && !ask.auth.refused;
  const notes = `${errors}${ask && !folded ? svcAuthHtml(ask) : ''}`;
  const tokenFold = folded ? `<details class="ov-mx__token"><summary>Your ${escapeHtml(ask.auth.label)}…</summary>${svcAuthHtml(ask)}</details>` : '';
  return `
      <li class="ov-mx__row${svc.complete ? '' : ' ov-mx__row--incomplete'}">
        <div class="ov-mx__svc">${name}</div>
        <div class="ov-mx__repo" data-col="Repository">${mxRepoHtml(svc, first)}${tokenFold}</div>
        ${columns.map((c) => mxCellHtml(svc.cells[c] || null, c, svc, canWrite)).join('')}
        <div class="ov-mx__rowacts">${all}${change}</div>${notes}
      </li>`;
}

// The grade's letters and where each starts, under the matrix: the letter is the grade; the
// match beside it is how much of what the repository declares runs live.
function mxLegendHtml(legend) {
  if (!Array.isArray(legend) || !legend.length) return '';
  const range = (g, i) => (g.from > 0 ? `${g.above ? '>' : '≥'} ${g.from}%` : `< ${legend[i - 1]?.from ?? 0}%`);
  return `<p class="ov-mx__legend og-muted"><span class="ov-mx__legend-l">Grade, by its score</span>${legend.map((g, i) => `<span class="ov-mx__legend-g"><span class="ov-svc__letter ov-tone-${attr(g.tone)}" aria-hidden="true">${escapeHtml(g.letter)}</span>${escapeHtml(range(g, i))}</span>`).join('')}<span class="ov-mx__legend-g"><span class="ov-mx__dot" aria-hidden="true"></span>Not declared</span><span class="ov-mx__legend-n">The letter comes from the grade's score over its checks; the match beside it is a separate measure — how much of what the repository declares runs live.</span></p>`;
}

const fieldErr = (f, key, shown) => (shown && f.problems[key] ? `<span class="ov-form__err">${escapeHtml(f.problems[key])}</span>` : '');

// Browse… beside the Folder answer — drawn only when the model offers it
// (the host passed the `folders` fact and the server takes a folder here).
function browseBtnHtml(f) {
  if (!f.browse?.offered) return '';
  return `<button type="button" class="og-btn ov-form__browse" data-ux-action="ov-form-browse" aria-expanded="${f.browse.open ? 'true' : 'false'}" aria-controls="ov-folders"${f.saving ? ' disabled' : ''}>Browse…</button>`;
}

// Upload: the folder or .zip from the person's own machine — two buttons and
// a drop target, the state as the model words it. A host that does not wire
// it (the model's `offered`) gets the words without the buttons.
function uploadHtml(f) {
  const u = f.upload || {};
  const off = f.saving || u.state === 'reading' ? ' disabled' : '';
  const acts = u.offered ? `
              <div class="ov-form__upload-acts">
                <button type="button" class="og-btn" data-ux-action="ov-form-upload-folder"${off}>Choose a folder</button>
                <button type="button" class="og-btn" data-ux-action="ov-form-upload-zip"${off}>Choose a .zip</button>
                <span class="ov-form__upload-drop og-muted" aria-hidden="true">or drop it here</span>
              </div>` : '';
  const state = u.state === 'reading' ? ' role="status"' : '';
  return `
            <div class="ov-form__upload${u.state ? ` ov-form__upload--${attr(u.state)}` : ''}" data-upload-drop="${u.offered ? 'on' : 'off'}">${acts}
              <span class="ov-form__upload-state"${state} data-field-focus="upload" tabindex="-1">${escapeHtml(u.text || '')}</span>${u.note ? `
              <span class="ov-form__upload-note og-muted">${escapeHtml(u.note)}</span>` : ''}${u.error ? `
              <span class="ov-form__err" role="alert">${escapeHtml(u.error)}</span>` : ''}
            </div>`;
}

const UP_ICON = '<svg class="ov-ic ov-folders__up-ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 19V5M5 12l7-7 7 7"></path></svg>';

// The folders on the server: Up, where the panel is, the folders inside (a
// click opens one; a repository is marked), Use this folder, Close.
function folderPanelHtml(p) {
  const off = p.loading ? ' disabled' : '';
  const items = p.folders.map((x) => `
                <li><button type="button" class="ov-folders__item" data-ux-action="ov-folders-open" data-path="${attr(x.path)}" title="${attr(x.path)}"${off}>${svcIcon('path')}<span class="ov-folders__name">${escapeHtml(x.name)}</span>${x.repository ? '<span class="og-pill ov-folders__repo">repository</span>' : ''}</button></li>`).join('');
  return `
            <div class="ov-folders" id="ov-folders" role="group" aria-label="Folders on the server"${p.loading ? ' aria-busy="true"' : ''}>
              <div class="ov-folders__bar">
                <button type="button" class="og-btn og-btn--text ov-folders__up" data-ux-action="ov-folders-open" data-path="${attr(p.up?.path ?? '')}" aria-label="Up one folder"${p.up && !p.loading ? '' : ' disabled'}>${UP_ICON}Up</button>
                <span class="ov-folders__path" title="${attr(p.path || p.title)}"><bdi>${escapeHtml(p.title)}</bdi></span>
              </div>${p.loading ? `
              <p class="ov-folders__status og-muted" role="status">Reading the folder…</p>` : ''}${p.error ? `
              <p class="ov-folders__error" role="alert">${escapeHtml(p.error)}</p>` : ''}${items ? `
              <ul class="ov-folders__list" aria-label="Folders inside">${items}
              </ul>` : ''}${p.empty ? `
              <p class="ov-folders__status og-muted">No folder inside.</p>` : ''}${p.note ? `
              <p class="ov-folders__note og-muted">${escapeHtml(p.note)}</p>` : ''}
              <div class="ov-folders__acts">
                <button type="button" class="og-btn" data-ux-action="ov-folders-choose" data-path="${attr(p.choose.path)}"${p.choose.enabled ? '' : ' disabled'}>Use this folder</button>${p.restart ? `
                <button type="button" class="og-btn og-btn--text" data-ux-action="ov-folders-open" data-path="">Start from the top</button>` : ''}
                <button type="button" class="og-btn og-btn--text" data-ux-action="ov-folders-close">Close</button>${p.here ? `
                <span class="ov-folders__here og-muted">${escapeHtml(p.here)}</span>` : ''}
              </div>
            </div>`;
}

// The Targets answer: the dropdown, the custom minutes when chosen, what they mean. `n` is its
// number in the whole form; the board's Set targets… form has it alone, unnumbered.
function targetsStepHtml(f, v, shown, n = '') {
  return `
        <li class="ov-form__step ov-form__step--targets">${n ? `
          <span class="ov-form__n">${n}</span>` : ''}
          <div class="ov-form__f">
            <span class="ov-form__l" id="ov-form-targets-l">Targets — how fast an incident is detected and resolved</span>
            <select class="og-input" data-field="targetProfile" aria-labelledby="ov-form-targets-l" aria-describedby="ov-form-targets-hint">
              ${f.targets.options.map((o) => `<option value="${attr(o.value)}"${o.selected ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
            </select>${f.targets.custom ? `
            <div class="ov-form__sub ov-form__mins">
              <label class="ov-form__f"><span class="ov-form__l">MTTD, minutes</span><input class="og-input" data-field="targetMttd" value="${attr(v.targetMttd)}" inputmode="numeric" placeholder="1" autocomplete="off">${fieldErr(f, 'targetMttd', shown)}</label>
              <label class="ov-form__f"><span class="ov-form__l">MTTR, minutes</span><input class="og-input" data-field="targetMttr" value="${attr(v.targetMttr)}" inputmode="numeric" placeholder="5" autocomplete="off">${fieldErr(f, 'targetMttr', shown)}</label>
            </div>` : ''}${fieldErr(f, 'targetProfile', shown)}
            <span class="ov-form__hint og-muted" id="ov-form-targets-hint">${escapeHtml(f.targets.hint)}</span>
          </div>
        </li>`;
}

// The board's Set targets… / Change targets…: the Targets answer alone, Save (Enter too) and Cancel —
// never a Run, and nothing else of the record to answer.
function targetsFormHtml(f) {
  const off = !f.canWrite;
  return `
    <form class="ov-form ov-form--targets og-panel" aria-labelledby="ov-form-h" novalidate data-targets-only="1">
      <header class="ov-form__head">
        <h2 class="ov-card__h" id="ov-form-h">${escapeHtml(f.title)}</h2>
        <p class="ov-card__sub">How fast an incident on this service should be detected and resolved. Save brings the board back with them.</p>
      </header>
      <ol class="ov-form__steps">${targetsStepHtml(f, f.values, !!f.error)}
      </ol>${f.error ? `
      <p class="ov-form__error" role="alert">${escapeHtml(f.error)}</p>` : ''}
      <div class="ov-form__acts">
        <button type="submit" class="og-btn og-btn--primary" data-ux-action="ov-form-save"${f.saving || off ? ' disabled' : ''}${off ? ` title="${attr(f.reason)}"` : ''}>${f.saving ? 'Saving…' : 'Save'}</button>
        <button type="button" class="og-btn og-btn--text" data-ux-action="ov-form-close"${f.saving ? ' disabled' : ''}>Cancel</button>
      </div>
    </form>`;
}

// Record a chaos run…: which experiment ran, when, how it went, how fast its alerts fired, which of
// the expected ones fired, a note. Save checks the service again; Cancel goes back. The runs already
// recorded here are listed under it, each with Forget.
function chaosRunFormHtml(f) {
  const off = !f.canWrite;
  const v = f.values;
  const shown = !!f.error;   // the field notes appear once a save was tried
  const opts = (list) => list.map((o) => `<option value="${attr(o.value ?? o.id)}"${o.selected ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
  const fired = f.fired.length ? `
        <fieldset class="ov-form__fired">
          <legend class="ov-form__l">The expected alerts that fired</legend>${f.fired.map((x) => `
          <label class="ov-form__check"><input type="checkbox" data-field="${attr(x.field)}"${x.checked ? ' checked' : ''}> ${escapeHtml(x.alert)}</label>`).join('')}
        </fieldset>` : '';
  const recent = f.recent.length ? `
      <div class="ov-form__recent">
        <h3 class="ov-form__l">Recorded here</h3>
        <ul class="ov-form__runs">${f.recent.map((r) => `
          <li><span>${escapeHtml(r.experiment)} · ${escapeHtml(r.words)}${r.note ? ` <span class="og-muted">— ${escapeHtml(r.note)}</span>` : ''}</span><button type="button" class="og-btn og-btn--text" data-ux-action="ov-cr-forget" data-run="${attr(encodeURIComponent(r.id))}"${f.saving || off ? ' disabled' : ''} aria-label="Forget the run of ${attr(r.experiment)}: ${attr(r.words)}">Forget</button></li>`).join('')}
        </ul>
      </div>` : '';
  return `
    <form class="ov-form ov-form--chaos og-panel" aria-labelledby="ov-form-h" novalidate data-chaos-run="1">
      <header class="ov-form__head">
        <h2 class="ov-card__h" id="ov-form-h">${escapeHtml(f.title)}</h2>
        <p class="ov-card__sub">${escapeHtml(f.hint)}</p>
      </header>
      <div class="ov-form__grid">
        <label class="ov-form__f"><span class="ov-form__l">Experiment</span>
          <select class="og-input" data-field="crExperiment">${opts(f.experiments)}</select>${fieldErr(f, 'crExperiment', shown)}</label>
        <label class="ov-form__f"><span class="ov-form__l">When it ran <em>(your time)</em></span>
          <input class="og-input" type="datetime-local" data-field="crAt" value="${attr(v.crAt)}">${fieldErr(f, 'crAt', shown)}</label>
        <label class="ov-form__f"><span class="ov-form__l">How it went</span>
          <select class="og-input" data-field="crOutcome">${opts(f.outcomes)}</select>${fieldErr(f, 'crOutcome', shown)}</label>
        <label class="ov-form__f"><span class="ov-form__l">Measured MTTD <em>(from the fault to the slowest expected alert)</em></span>
          <input class="og-input" data-field="crMttd" value="${attr(v.crMttd)}" placeholder="45s, 2m30s or 45" inputmode="text" autocomplete="off">${fieldErr(f, 'crMttd', shown)}</label>${fired}
        <label class="ov-form__f ov-form__note"><span class="ov-form__l">Note <em>(optional)</em></span>
          <input class="og-input" data-field="crNote" value="${attr(v.crNote)}" maxlength="280" autocomplete="off">${fieldErr(f, 'crNote', shown)}</label>
      </div>${f.error ? `
      <p class="ov-form__error" role="alert">${escapeHtml(f.error)}</p>` : ''}
      <div class="ov-form__acts">
        <button type="submit" class="og-btn og-btn--primary" data-ux-action="ov-form-save"${f.saving || off ? ' disabled' : ''}${off ? ` title="${attr(f.reason)}"` : ''}>${f.saving ? 'Saving…' : 'Save and check again'}</button>
        <button type="button" class="og-btn og-btn--text" data-ux-action="ov-form-close"${f.saving ? ' disabled' : ''}>Cancel</button>
      </div>${recent}
    </form>`;
}

function svcFormHtml(f) {
  if (f.chaosRun) return chaosRunFormHtml(f);
  if (f.targetsOnly) return targetsFormHtml(f);
  const v = f.values;
  const shown = !!f.error;   // the field notes appear once a save was tried
  const kinds = f.kinds.map((k) => `<button type="button" class="og-btn ov-form__kind" data-ux-action="ov-form-kind" data-kind="${attr(k.kind)}" aria-pressed="${k.selected ? 'true' : 'false'}">${svcIcon(k.kind)}${escapeHtml(k.label)}${k.off ? '<span class="og-muted"> · off</span>' : ''}</button>`).join('');
  const eps = f.endpoints.map((e) => `<option value="${attr(e.id)}"${e.selected ? ' selected' : ''}>${escapeHtml(e.name)}${e.origin ? ` — ${escapeHtml(e.origin.replace(/^https?:\/\//, ''))}` : ''}</option>`).join('');
  const newOpt = `<option value="new"${f.newEndpoint.selected ? ' selected' : ''}${f.newEndpoint.allowed ? '' : ' disabled'}>A new MCP endpoint…${f.newEndpoint.allowed ? '' : ' (not here)'}</option>`;
  const newFields = f.newEndpoint.selected ? `
          <div class="ov-form__sub">
            <label class="ov-form__f"><span class="ov-form__l">Endpoint URL</span><input class="og-input" data-field="epUrl" value="${attr(v.epUrl)}" placeholder="https://mcp.example.com/mcp" autocomplete="off" spellcheck="false">${fieldErr(f, 'epUrl', shown)}</label>
            <label class="ov-form__f"><span class="ov-form__l">Its name</span><input class="og-input" data-field="epName" value="${attr(v.epName)}" placeholder="prod-mcp" autocomplete="off">${fieldErr(f, 'epName', shown)}</label>
            <label class="ov-form__f"><span class="ov-form__l">Token variable <em>optional</em></span><input class="og-input" data-field="epToken" value="${attr(v.epToken)}" placeholder="the server's variable holding its token" autocomplete="off" spellcheck="false"></label>
          </div>` : '';
  const off = !f.canWrite;
  // The person's own token for the repository's host, where the model offers it: a password
  // field with nothing in it — what is typed is read when Save is pressed, never drawn.
  // Sign in to … comes first where the host offers it here, as on a row.
  const authField = f.auth ? `<label class="ov-form__f"><span class="ov-form__l">Your ${escapeHtml(f.auth.label)}${f.auth.optional ? ' <em>optional</em>' : ''}</span><input class="og-input" type="password" data-form-auth="${attr(f.auth.kind)}" autocomplete="one-time-code" spellcheck="false" aria-describedby="ov-form-auth-note"></label>` : '';
  const auth = f.auth ? `
            <div class="ov-form__auth">${f.auth.signIn ? `
              <div class="ov-form__auth-ways">
                <button type="button" class="og-btn" data-ux-action="ov-form-sign-in" data-kind="${attr(f.auth.signIn.kind)}"${f.saving ? ' disabled' : ''}>${escapeHtml(f.auth.signIn.label)}</button>
                <span class="ov-form__auth-or og-muted">or</span>
                ${authField}
              </div>` : `
              ${authField}`}
              <span class="ov-form__hint og-muted" id="ov-form-auth-note">${escapeHtml(f.auth.text)}</span>
            </div>` : '';
  return `
    <form class="ov-form og-panel" aria-labelledby="ov-form-h" novalidate>
      <header class="ov-form__head">
        <h2 class="ov-card__h" id="ov-form-h">${escapeHtml(f.title)}</h2>
        <p class="ov-card__sub">${f.mode === 'edit' ? 'Change where it is declared, where it runs or its targets. Each Run reads both places again.' : 'Five answers, then Run: the repository is scanned and checked against live, now and whenever you run it again.'}</p>
      </header>
      <ol class="ov-form__steps">
        <li class="ov-form__step">
          <span class="ov-form__n">1</span>
          <label class="ov-form__f"><span class="ov-form__l">Service</span><input class="og-input" data-field="name" value="${attr(v.name)}" placeholder="checkout" autocomplete="off"${f.nameFixed ? ' readonly' : ''}>${fieldErr(f, 'name', shown)}</label>
        </li>
        <li class="ov-form__step">
          <span class="ov-form__n">2</span>
          <label class="ov-form__f"><span class="ov-form__l">Environment</span><input class="og-input" data-field="env" value="${attr(v.env)}" placeholder="prod" autocomplete="off"${f.envFixed ? ' readonly' : ''}>${fieldErr(f, 'env', shown)}</label>
        </li>
        <li class="ov-form__step">
          <span class="ov-form__n">3</span>
          <div class="ov-form__f">
            <span class="ov-form__l">Repository — where it is declared</span>
            <div class="og-seg ov-form__kinds" role="group" aria-label="Where the repository is">${kinds}</div>${f.kind.kind === 'upload' ? uploadHtml(f) : `
            <div class="ov-form__pair">
              <input class="og-input ov-form__loc" data-field="location" value="${attr(v.location)}" placeholder="${attr(f.kind.placeholder)}" aria-label="${attr(f.kind.label)} location" autocomplete="off" spellcheck="false">
              ${f.kind.kind === 'path' ? browseBtnHtml(f) : `<input class="og-input ov-form__ref" data-field="ref" value="${attr(v.ref)}" placeholder="${attr(f.branch?.placeholder || 'branch (default)')}" aria-label="Branch" autocomplete="off" spellcheck="false">`}
            </div>`}${f.browse?.panel ? folderPanelHtml(f.browse.panel) : ''}
            <span class="ov-form__hint og-muted">${escapeHtml(f.browse?.hint || f.kind.hint)}</span>${fieldErr(f, 'kind', shown)}${fieldErr(f, 'location', shown)}
            ${f.branch?.note && f.kind.kind !== 'path' && f.kind.kind !== 'upload' ? `<span class="ov-form__hint og-muted">${escapeHtml(f.branch.note)}</span>` : ''}
            ${f.sourcesNote ? `<span class="ov-form__hint og-muted">${escapeHtml(f.sourcesNote)}</span>` : ''}${auth}
          </div>
        </li>
        <li class="ov-form__step">
          <span class="ov-form__n">4</span>
          <div class="ov-form__f">
            <span class="ov-form__l">Live — where it runs</span>
            <select class="og-input" data-field="endpointId" aria-label="The MCP endpoint that reads it live">
              ${f.endpoints.length ? '' : '<option value="" disabled>No MCP endpoint is registered yet</option>'}${f.endpoints.length && !v.endpointId ? '<option value="" selected disabled>Choose an MCP endpoint</option>' : ''}${eps}${newOpt}
            </select>${f.newEndpoint.allowed ? '' : `
            <span class="ov-form__hint og-muted">${escapeHtml(f.newEndpoint.reason)}</span>`}${fieldErr(f, 'endpointId', shown)}${newFields}
          </div>
        </li>${f.targets ? targetsStepHtml(f, v, shown, 5) : ''}
      </ol>${f.error ? `
      <p class="ov-form__error" role="alert">${escapeHtml(f.error)}</p>` : ''}
      <div class="ov-form__acts">
        <button type="submit" class="og-btn og-btn--primary" data-ux-action="ov-form-run"${f.saving || off ? ' disabled' : ''}${off ? ` title="${attr(f.reason)}"` : ''}>${f.saving ? 'Saving…' : 'Save and run'}</button>
        <button type="button" class="og-btn" data-ux-action="ov-form-save"${f.saving || off ? ' disabled' : ''}>Save</button>
        <button type="button" class="og-btn og-btn--text" data-ux-action="ov-form-close"${f.saving ? ' disabled' : ''}>Cancel</button>
      </div>
    </form>`;
}

export function serviceListHtml(list, form, ov = {}) {
  const f = form?.open ? form : null;
  const add = f ? '' : (list.canWrite
    ? '<button type="button" class="og-btn og-btn--primary ov-svcs__add" data-ux-action="ov-svc-add">Add a service</button>'
    : `<button type="button" class="og-btn og-btn--primary ov-svcs__add" data-ux-action="ov-explain" aria-disabled="true" data-reason="${attr(list.reason)}" title="${attr(list.reason)}">Add a service</button>`);
  let body;
  if (list.kind === 'loading') body = '<p class="ov-loading og-muted" role="status">Reading the services…</p>';
  else if (list.kind === 'error') {
    body = emptyStateHtml({ title: 'The services could not be read.', checked: list.error || '', actions: [{ action: 'ov-retry', label: 'Retry' }], tone: 'warn' });
  } else if (list.empty) {
    body = f ? '' : `
      <div class="ov-svcs__empty og-panel">
        <p class="ov-col__lead">No service yet.</p>
        <p class="ov-col__note og-muted">A service is checked in two places: its repository, where what it should have is declared, and its live MCP endpoint, where what it has is read. Add one to start.</p>
      </div>`;
  } else {
    // One row per service, a column per environment (the model's serviceMatrix).
    const m = list.matrix || { columns: [], services: [], legend: [] };
    body = `
      <div class="ov-svcs__table ov-mx" style="--ov-envs: ${Math.max(1, m.columns.length)}">
        <div class="ov-mx__cols" aria-hidden="true"><span>Service</span><span>Repository</span>${m.columns.map((c) => `<span class="ov-mx__colh">${escapeHtml(c)}</span>`).join('')}<span></span></div>
        <ul class="ov-svcs__rows" aria-label="Services">${m.services.map((svc) => mxRowHtml(svc, m.columns, list.canWrite)).join('')}
        </ul>
      </div>${mxLegendHtml(m.legend)}`;
  }
  const more = list.hidden ? `
      <p class="ov-svcs__more og-muted">${list.hidden} more ${list.hidden === 1 ? 'service was' : 'services were'} seen live with no repository yet. <button type="button" class="ov-start__expert" data-ux-action="ov-svc-all">Show ${list.hidden === 1 ? 'it' : 'them'}</button></p>` : '';
  const held = [
    ...(Array.isArray(list.tokens) ? list.tokens : []).map((t) => `
        <p class="ov-svcs__token og-muted">${escapeHtml(t.text)} <button type="button" class="ov-start__expert" data-ux-action="ov-svc-forget-token" data-kind="${attr(t.kind)}">Forget it</button></p>`),
    ...(Array.isArray(list.accounts) ? list.accounts : []).map((a) => `
        <p class="ov-svcs__token og-muted">${escapeHtml(a.text)} <button type="button" class="ov-start__expert" data-ux-action="ov-svc-sign-out" data-kind="${attr(a.kind)}">Sign out of ${escapeHtml(a.host)}</button></p>`),
  ];
  const tokens = held.length ? `
      <div class="ov-svcs__tokens">${held.join('')}
      </div>` : '';
  const compare = typeof ov.compare === 'function' ? `
      <p class="ov-svcs__foot og-muted">Already have the packs? <button type="button" class="ov-start__expert" data-ux-action="ov-svc-compare">Upload one or compare two instead</button></p>` : '';
  return `
    <section class="ov-svcs" aria-labelledby="ov-svcs-h">
      <header class="ov-svcs__head">
        <div class="ov-svcs__titles">
          <h1 class="ov-svcs__h" id="ov-svcs-h">Services</h1>
          <p class="ov-svcs__lede og-muted">Each one is checked where it is declared — its repository — against where it runs, read through each environment's live MCP endpoint: a row per service, a column per environment.</p>
        </div>
        ${add}
      </header>${tokens}${f ? svcFormHtml(f) : ''}${body}${more}${compare}
    </section>`;
}

// What a person typed into a token field and has not sent yet. The list is
// drawn again whenever a fact arrives — a Run that ends, the endpoints read,
// a select in the form — and a token is never written into the markup, so a
// host that clears the page before a draw reads the fields first
// (readTokenDrafts) and hands the answer to renderServiceList (`drafts`),
// which puts each in the field drawn in its place: a row's by the row's key,
// the form's by its host, with the caret where it was. A draft whose field is
// not drawn again (the row runs, the kind changed, the form closed) is
// dropped. Nothing is kept between two draws but that hand-over.
const TOKEN_FIELDS = '[data-auth-input], [data-form-auth]';
export function readTokenDrafts(container) {
  const out = [];
  for (const el of container?.querySelectorAll?.(TOKEN_FIELDS) || []) {
    const focused = !!el.ownerDocument && el.ownerDocument.activeElement === el;
    const value = String(el.value ?? '');
    if (!value && !focused) continue;
    const row = el.dataset?.authInput ?? null;
    out.push({ row, service: el.dataset?.authService ?? null, form: row === null ? (el.dataset?.formAuth ?? null) : null, value, focused, start: el.selectionStart ?? null, end: el.selectionEnd ?? null });
  }
  return out.length ? out : null;
}

function restoreTokenDrafts(container, drafts) {
  if (!Array.isArray(drafts) || !drafts.length) return;
  const fields = [...(container.querySelectorAll?.(TOKEN_FIELDS) || [])];
  for (const d of drafts) {
    // A row's field by its row; else the service's one field, which may have moved to another environment's row.
    const el = fields.find((x) => (d.row !== null ? x.dataset?.authInput === d.row : x.dataset?.authInput === undefined && x.dataset?.formAuth === d.form))
      || (d.service ? fields.find((x) => x.dataset?.authService === d.service) : null);
    if (!el) continue;
    el.closest?.('details')?.setAttribute?.('open', '');
    el.value = d.value;
    if (!d.focused) continue;
    el.focus?.({ preventScroll: true });
    try { el.setSelectionRange?.(d.start, d.end); } catch { /* a field that takes no range */ }
  }
}

// Draws the list into `container` and wires it to host.overview. `drafts`:
// what readTokenDrafts read from the page before it was cleared, or nothing.
export function renderServiceList(container, list, form, host = appHost, { drafts = null } = {}) {
  const ov = host?.overview || {};
  container.innerHTML = `<div class="ov-page ov-page--list">${serviceListHtml(list, form, ov)}</div>`;
  restoreTokenDrafts(container, drafts);
  const svcEnv = (el) => (el.dataset.env ? el.dataset.env : null);
  // The token typed on a row (read when Run with it is pressed, never kept by the view).
  // The row's field, else its service's one field (the matrix draws one per service): rowKey is "<serviceId>:<env>".
  const authInput = (key) => container.querySelector?.(`[data-auth-input="${String(key).replace(/["\\]/g, '')}"]`)
    || container.querySelector?.(`[data-auth-service="${String(key).split(':')[0].replace(/["\\]/g, '')}"]`) || null;
  const authValue = (key) => String(authInput(key)?.value ?? '').trim();
  // The token typed in the form: read when Save is pressed, sent only when there is one.
  const saveWith = (run) => {
    const repoAuth = String(container.querySelector?.('[data-form-auth]')?.value ?? '').trim();
    return repoAuth ? { run, repoAuth } : { run };
  };
  wireUxActions(container, {
    'ov-svc-add': () => ov.addService?.(),
    'ov-svc-edit': (ev, el) => ov.editService?.(Number(el.dataset.service), svcEnv(el)),
    // Run sends the token the row's field holds, when it holds one: the field is there to be used.
    'ov-svc-run': (ev, el) => { const repoAuth = authValue(el.dataset.key); return repoAuth ? ov.runService?.(el.dataset.key, { repoAuth }) : ov.runService?.(el.dataset.key); },
    'ov-svc-auth-run': (ev, el) => ov.runService?.(el.dataset.key, { repoAuth: authValue(el.dataset.key) }),
    // Run all: every environment of the service that can run, in the columns' order.
    'ov-svc-run-all': (ev, el) => {
      const keys = String(el.dataset.keys || '').split(',').filter(Boolean).map(decodeURIComponent);
      // The service's token field, when it holds one: the first Run sends it, and the host keeps it for the rest.
      const repoAuth = keys.length ? authValue(keys[0]) : '';
      if (typeof ov.runServices === 'function') return repoAuth ? ov.runServices(keys, { repoAuth }) : ov.runServices(keys);
      keys.forEach((k, i) => (i === 0 && repoAuth ? ov.runService?.(k, { repoAuth }) : ov.runService?.(k)));
      return undefined;
    },
    'ov-svc-forget-token': (ev, el) => ov.forgetRepoToken?.(el.dataset.kind),
    'ov-svc-sign-in': (ev, el) => ov.signInRepoHost?.(el.dataset.kind, el.dataset.key || null),
    'ov-svc-sign-out': (ev, el) => ov.signOutRepoHost?.(el.dataset.kind),
    'ov-svc-open': (ev, el) => ov.openService?.(Number(el.dataset.service), svcEnv(el)),
    'ov-svc-all': () => ov.showAll?.(),
    'ov-svc-compare': () => ov.compare?.(),
    'ov-form-kind': (ev, el) => ov.formInput?.('kind', el.dataset.kind, { redraw: true }),
    'ov-form-run': (ev) => { ev?.preventDefault?.(); ov.saveService?.(saveWith(true)); },
    // Save: on the targets-only form it is the submit button, so the click's own submit is not a second save.
    'ov-form-save': (ev) => { ev?.preventDefault?.(); ov.saveService?.(saveWith(false)); },
    'ov-form-close': () => ov.closeForm?.(),
    // A run recorded here, forgotten (the chaos run form's list).
    'ov-cr-forget': (ev, el) => ov.forgetChaosRun?.(decodeURIComponent(el.dataset.run || '')),
    // No row to run again afterwards (null), and the host keeps the form's answers while the sign-in is under way.
    'ov-form-sign-in': (ev, el) => ov.signInRepoHost?.(el.dataset.kind, null, { fromForm: true }),
    'ov-form-browse': () => ov.browseFolders?.(),
    'ov-folders-open': (ev, el) => ov.openFolder?.(el.dataset.path ? el.dataset.path : null),
    'ov-folders-choose': (ev, el) => ov.chooseFolder?.(el.dataset.path),
    'ov-folders-close': () => ov.closeFolders?.(),
    'ov-form-upload-folder': () => ov.pickRepositoryFolder?.(),
    'ov-form-upload-zip': () => ov.pickRepositoryZip?.(),
    'ov-retry': () => ov.retry?.(),
    'ov-explain': (ev, el) => ov.explain?.(el.dataset.reason),
  });
  // Enter in a row's token field runs it, as Run with it does.
  container.querySelectorAll?.('[data-auth-input]').forEach((input) => {
    input.addEventListener?.('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault?.();
      ov.runService?.(input.dataset.authInput, { repoAuth: String(input.value ?? '').trim() });
    });
  });
  const formEl = container.querySelector('.ov-form');
  if (formEl) {
    // Enter submits: Save and run on the whole form; Save alone on the board's targets-only one.
    const targetsOnly = !!form?.targetsOnly;
    formEl.addEventListener('submit', (ev) => { ev.preventDefault(); ov.saveService?.(saveWith(!targetsOnly)); });
    formEl.querySelectorAll('[data-field]').forEach((input) => {
      // The select re-draws the form (the new-endpoint fields); typing keeps the host's copy in step.
      // A box (the chaos run's alerts that fired) is '1' ticked, '' not.
      const box = input.type === 'checkbox';
      const event = input.tagName === 'SELECT' || box ? 'change' : 'input';
      input.addEventListener(event, () => ov.formInput?.(input.dataset.field, box ? (input.checked ? '1' : '') : input.value, { redraw: input.tagName === 'SELECT' }));
    });
    // Escape closes the folder panel, not the form.
    const panel = formEl.querySelector('.ov-folders');
    panel?.addEventListener?.('keydown', (ev) => { if (ev.key === 'Escape') { ev.preventDefault?.(); ov.closeFolders?.(); } });
    // Upload's drop target: a folder or a .zip dropped on it is the host's to read.
    const drop = formEl.querySelector('.ov-form__upload[data-upload-drop="on"]');
    if (drop?.addEventListener) {
      const over = (on) => (ev) => { ev.preventDefault?.(); drop.classList?.toggle('is-dragover', on); };
      drop.addEventListener('dragenter', over(true));
      drop.addEventListener('dragover', over(true));
      drop.addEventListener('dragleave', over(false));
      drop.addEventListener('drop', (ev) => { ev.preventDefault?.(); drop.classList?.remove('is-dragover'); ov.dropRepository?.(ev.dataTransfer); });
    }
    // The field the host asks for (the form just opened, the kind or the endpoint just changed);
    // 'folders' is the panel's first folder, else its first live button (a listing just drawn);
    // 'upload' (or the location, which Upload has none of) is Upload's state, else its first button.
    const uploading = !!formEl.querySelector('.ov-form__upload');
    // 'kind' (a save stopped by a source switched off) is the chosen kind's button.
    const want = form?.focus === 'kind'
      ? (formEl.querySelector('.ov-form__kind[aria-pressed="true"]') || formEl.querySelector('.ov-form__kind'))
      : form?.focus === 'folders'
      ? (formEl.querySelector('.ov-folders__item:not([disabled])') || formEl.querySelector('.ov-folders button:not([disabled])'))
      : (form?.focus === 'upload' || (form?.focus === 'location' && uploading))
        ? (form.focus === 'upload' ? formEl.querySelector('[data-field-focus="upload"]') : null) || formEl.querySelector('.ov-form__upload button:not([disabled])')
        : form?.focus ? formEl.querySelector(`[data-field="${form.focus}"]`) : null;
    if (want) {
      want.focus({ preventScroll: true });
      if (want.value && typeof want.select === 'function') want.select();
      // Asked for by the host (Set targets… opens on the Targets answer, Custom shows its minutes): into view.
      if (form.scroll) want.scrollIntoView?.({ block: 'nearest' });
    }
  }
}
