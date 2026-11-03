// studio/overview-view.mjs — the Overview screen, drawn from its model.
//
// render(container, model, host) (docs/UI_CONVENTIONS.md §3): the model is
// studio/overview-model.mjs buildOverviewModel(...) — pure, already worded —
// and the actions ride on host.overview: selectService(id), selectEnv(name),
// checkNow(), openDiscover(), openDiagnose(), openRemediate(), openNeuron(),
// expert(), retry(). A headless host ({ overview: {} }) never throws. The
// pieces are the design kit's (.og-*); the zone is .ov-* (studio/ux.css).
// Exactly one primary button per state.
//
// Two layouts of the same model. The board (model.layout 'board') is three
// columns under Expert's own words — Discover · Diagnose · Remediate — each
// a picture of the machine: the stack's four layers with the kinds of signal
// on each, the grade as a shield with its seven criteria open and the
// specification's rules, the live fidelity as a ring with four counts and
// the promises that hold, the delta as three counts and the one next step.
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
  return `
    <div class="ov-head">
      <label class="og-eyebrow ov-head__label" for="ov-service">Service</label>
      <select class="og-input ov-service" id="ov-service" aria-label="Service">${options}</select>
      ${envs}
    </div>`;
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
          ${g.word ? `<div class="ov-grade__word">${escapeHtml(g.word)}</div>` : ''}
          ${g.source ? `<div class="ov-grade__src og-muted">${escapeHtml(g.source)}</div>` : ''}
        </div>
      </div>
      ${gradeWhyHtml(g)}
    </section>`;
}

// The seven criteria behind the letter: a yes / partly / no pill and one
// sentence each, the points line first. Nothing when the model has no list
// that adds up to the letter. Collapsed in the simple layout, open on the board.
const WHY_MARK = { yes: ['ok', 'Yes'], partly: ['warn', 'Partly'], no: ['fail', 'No'] };
function whyListHtml(g, { open = false } = {}) {
  if (!Array.isArray(g.why) || !g.why.length) return '';
  const items = g.why.map((w) => {
    const [tone, word] = WHY_MARK[w.ok] || ['', w.ok];
    return `<li class="ov-gw ov-gw--${escapeHtml(w.ok)}"><span class="og-pill${tone ? ` og-pill--${tone}` : ''} ov-gw__pill">${escapeHtml(word)}</span><span class="ov-gw__text">${escapeHtml(w.text)}</span></li>`;
  }).join('');
  const points = g.points ? `<p class="ov-grade__points og-muted">${escapeHtml(g.points)}</p>` : '';
  return `${points}<ul class="ov-gw-list${open ? ' ov-gw-list--open' : ''}">${items}</ul>`;
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
            <span class="ov-layer__name">${escapeHtml(r.name)}<span class="ov-layer__hint" title="${escapeHtml(r.hint)}">${escapeHtml(r.hint)}</span></span>
            <span class="og-pill og-pill--${escapeHtml(r.tone)} ov-layer__n">${r.covered} of ${r.of} kinds</span>
            <span class="ov-layer__total" title="declared on this layer"><b>${r.total}</b><small>declared</small></span>
          </div>
          <div class="ov-cells" role="img" aria-label="${escapeHtml(name)}">${cells}</div>
          <div class="ov-layer__kinds og-muted">${present ? escapeHtml(present) : 'nothing declared on this layer'}</div>
        </li>`;
}

function discoverColHtml(L) {
  const body = L
    ? `
      ${kindHeadHtml(L.rows[0].kinds)}
      <ol class="ov-stack" aria-label="The stack, top down">${L.rows.map(layerRowHtml).join('')}</ol>
      <dl class="ov-stats">
        <div class="ov-stat" title="${escapeHtml(L.lead)}"><dt>Declared</dt><dd>${L.declared}</dd></div>
        <div class="ov-stat" title="${escapeHtml(L.coverage)}"><dt>Coverage</dt><dd>${L.coveragePct}<small>%</small></dd></div>
        <div class="ov-stat" title="${escapeHtml(L.unplacedNote || 'Everything found its layer.')}"><dt>Unplaced</dt><dd>${L.unplaced}</dd></div>
      </dl>
      ${L.composition.length ? disclosureHtml('In the repository', `<p class="ov-comp og-muted">${L.composition.map((c) => `<span class="ov-comp__item"><b class="ov-comp__n">${c.count}</b> ${escapeHtml(c.name)}</span>`).join('<span class="ov-comp__sep"> · </span>')}</p>`, { cls: 'ov-comp__wrap' }) : ''}`
    : reading('the repository');
  return `
    <section class="ov-col ov-col--discover og-panel og-panel--pad" aria-labelledby="ov-discover-h">
      <header class="ov-col__head">
        <h2 class="ov-card__h" id="ov-discover-h">Layers</h2>
        <p class="ov-card__sub">The stack, top down, as the repository declares it</p>
        <span class="ov-src" title="What the repository declares">REPO</span>
      </header>
      ${body}
      ${footHtml('ov-open-discover', 'Open in Discover')}
    </section>`;
}

// Diagnose — one status strip for the whole column (what was graded against
// what, when, and which probe families could not be read), then two groups:
// A, are the right signals in place — the letter as a shield, the required
// rules, the seven criteria behind "Why this grade"; B, can you trust what
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

function rulesHtml(r) {
  if (!r) return '';
  if (r.unknown) return `<div class="ov-rules ov-rules--unknown"><span class="ov-rules__text og-muted">${escapeHtml(r.sentence)}</span></div>`;
  const short = escapeHtml(`${r.passed} of ${r.total} required rules met`);
  return `<div class="ov-rules ov-rules--${escapeHtml(r.tone)}" title="${escapeHtml(r.sentence)}"><div class="ov-rules__n"><b>${r.passed}</b><span class="ov-rules__of">/ ${r.total}</span></div><div class="ov-rules__bar" role="img" aria-label="${short}"><span style="width:${Math.max(0, Math.min(100, r.pct))}%"></span></div><span class="ov-rules__text">required rules met${r.tier ? ` · tier ${escapeHtml(r.tier)}` : ''}</span></div>`;
}

const ringTone = (pct) => (pct === null ? 'neutral' : pct >= 85 ? 'ok' : pct >= 50 ? 'warn' : 'fail');
const RING_R = 38;
const RING_C = 2 * Math.PI * RING_R;
function ringHtml(f) {
  const pct = f?.known && f.alignmentPct !== null ? Math.max(0, Math.min(100, f.alignmentPct)) : null;
  const offset = pct === null ? RING_C : RING_C * (1 - pct / 100);
  const label = pct === null ? 'Not known' : `${Math.round(pct)} in 100 aligned`;
  return `
        <svg class="ov-ring ov-ring--${ringTone(pct)}" viewBox="0 0 88 88" role="img" aria-label="${escapeHtml(label)}">
          <circle class="ov-ring__track" cx="44" cy="44" r="${RING_R}"></circle>
          <circle class="ov-ring__arc" cx="44" cy="44" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 44 44)"></circle>
          <text class="ov-ring__pct" x="44" y="42">${pct === null ? '–' : `${Math.round(pct)}%`}</text>
          <text class="ov-ring__word" x="44" y="58">aligned</text>
        </svg>`;
}

function fidelityHtml(f) {
  const tiles = f?.known
    ? `<div class="ov-tiles">${f.tiles.map((t) => `<div class="ov-tile ov-tile--${escapeHtml(t.tone)}" title="${escapeHtml(t.note)}"><span class="ov-tile__n">${t.value}</span><span class="ov-tile__l">${escapeHtml(t.label)}</span></div>`).join('')}</div>`
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

// The seven rows open on a tall monitor, closed behind "Why this grade" on
// a screen whose height the three columns must share (a laptop, a 1080p
// monitor with the browser's chrome); headless, open. The host repaints
// Overview when this query flips (studio/app.mjs), so a window dragged to
// the other monitor gets the other reading.
export const COMPACT_SCREEN_QUERY = '(max-height: 999px)';
function compactScreen() {
  try { return typeof window !== 'undefined' && !!window.matchMedia?.(COMPACT_SCREEN_QUERY)?.matches; } catch { return false; }
}

function boardWhyHtml(g) {
  const list = whyListHtml(g, { open: true });
  if (!list) return '';
  return compactScreen() ? disclosureHtml('Why this grade', list, { cls: 'ov-grade__why' }) : `<div class="ov-grade__why ov-grade__why--open">${list}</div>`;
}

const cardHeadHtml = (badge, id, question, sub) => `
        <header class="ov-card__head">
          <span class="ov-card__badge" aria-hidden="true">${badge}</span>
          <div class="ov-card__titles"><h2 class="ov-card__h" id="${id}">${question}</h2><p class="ov-card__sub">${sub}</p></div>
        </header>`;

function diagnoseColHtml(g, rules, f, s, primary) {
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
            ${g.word ? `<div class="ov-grade__word">${escapeHtml(g.word)}</div>` : ''}
            ${source}
          </div>
          ${rulesHtml(rules)}
        </div>
        ${boardWhyHtml(g)}
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
function remediateColHtml(c, n, primary) {
  const items = c
    ? (c.known
      ? `<div class="ov-changes">${c.items.map((i) => `<div class="ov-change ov-change--${escapeHtml(i.tone)}" title="${escapeHtml(i.note)}">${iconHtml(CHANGE_ICON[i.key] || 'add', 'ov-change__ic')}<span class="ov-change__l">${escapeHtml(i.label)}</span><span class="ov-change__n">${i.value}</span><span class="ov-change__note og-muted">${escapeHtml(CHANGE_SHORT[i.key] || i.note)}</span></div>`).join('')}</div>${c.sentence ? `<p class="ov-col__note og-muted">${escapeHtml(c.sentence)}</p>` : ''}`
      : `<p class="ov-col__lead og-muted">${escapeHtml(c.sentence)}</p>`)
    : reading('the last check');
  return `
    <section class="ov-col ov-col--remediate og-panel og-panel--pad" aria-labelledby="ov-remediate-h">
      <header class="ov-col__head">
        <h2 class="ov-card__h" id="ov-remediate-h">Changes to apply</h2>
        <p class="ov-card__sub">Between the repository and live</p>
      </header>
      ${items}
      ${nextRowHtml(n, primary)}
      ${footHtml('ov-open-remediate', 'Open in Remediate')}
    </section>`;
}

function boardBodyHtml(model) {
  const b = model.board || {};
  return `
    ${stagesHtml()}
    <div class="ov-board">
      ${discoverColHtml(b.layers)}
      ${diagnoseColHtml(model.grade, b.rules, b.fidelity, model.still, model.primary)}
      ${remediateColHtml(b.changes, model.next, model.primary)}
    </div>`;
}

// The board draws a service with a pack of its own; without one there is
// nothing to picture, and the three sentences say so.
export function boardApplies(model) {
  return model?.kind === 'service' && model.layout === 'board' && !['none', 'error'].includes(model.grade?.basis);
}

export function renderOverview(container, model, host = appHost) {
  const ov = host?.overview || {};
  let body;
  let board = false;
  if (model.kind === 'empty') {
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
    'ov-open-discover': () => ov.openDiscover?.(),
    'ov-next-diagnose': () => ov.openDiagnose?.(),
    'ov-open-remediate': () => ov.openRemediate?.(),
    'ov-next-neuron': () => ov.openNeuron?.(),
    'ov-expert': () => ov.expert?.(),
    'ov-retry': () => ov.retry?.(),
  });
  const select = container.querySelector('#ov-service');
  if (select) select.addEventListener('change', () => ov.selectService?.(Number(select.value)));
}
