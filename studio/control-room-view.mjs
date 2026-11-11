// studio/control-room-view.mjs — Overview's control room, drawn: a panel at the right of the board.
//
// renderControlRoom(container, model, host)
//   container  the panel's own host element (app.mjs keeps it on <body>, never
//              inside the board, which repaints on every check)
//   model      control-room-model.mjs buildControlRoomModel(...), or null (closed)
//   host       { overview: { closeControlRoom, refreshControlRoom } }
// A panel, not a modal: the board stays usable beside it. Escape inside it
// closes it. A repaint with the same service environment keeps the panel
// element and replaces only the pieces whose words changed (the buttons, the
// strip, the body), so a read that changes nothing leaves the reader's place,
// scroll, rows opened and focus where they were. One live region, outside
// what repaints, says the service environment and its status when they
// change (never again on every read). Every live string is escaped here.
//
// placeControlRoom(head) — the panel starts below the board's context bar
// (`head`, the board's .ov-head), its door in sight: sets --ov-cr-head on the
// document. A host calls it after the board is drawn; without a head the last
// value stays.
//
// Imports util.mjs (escapeHtml), host.mjs and ux-kit-pure.mjs only, as the
// board's renderer does (docs/VENDORING.md).

import { escapeHtml } from './util.mjs';
import { host as appHost } from './host.mjs';
import { wireUxActions } from './ux-kit-pure.mjs';

// ---------- numbers, formatted ----------

const trim = (n, digits) => {
  const s = n.toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};
/**
 * A tile's value in its unit's words. Never a rounded lie: a value above 0 never prints as 0, and a
 * ratio short of 1 never prints as 100%.
 */
export function formatValue(value, unit) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const v = Number(value);
  switch (unit) {
    case 'ratio': {
      const pct = v * 100;
      if (v > 0 && pct < 0.05) return '<0.1%';
      if (v < 1 && pct >= 99.95) return '>99.9%';
      return `${pct >= 99.5 && v < 1 ? trim(Math.floor(pct * 10) / 10, 1) : trim(pct, pct < 10 ? 1 : 0)}%`;
    }
    case 'per-second': {
      if (v === 0) return '0/s';
      if (v < 0.1) return v * 60 < 0.05 ? '<0.1/min' : `${trim(v * 60, 1)}/min`;
      return `${trim(v, v < 10 ? 1 : 0)}/s`;
    }
    case 'seconds': return v > 0 && v < 0.0005 ? '<1 ms' : v < 1 ? `${Math.round(v * 1000)} ms` : `${trim(v, v < 10 ? 2 : 1)} s`;
    case 'bytes': {
      const u = ['B', 'KB', 'MB', 'GB', 'TB'];
      let x = v, i = 0;
      while (x >= 1024 && i < u.length - 1) { x /= 1024; i += 1; }
      return `${trim(x, x < 10 ? 1 : 0)} ${u[i]}`;
    }
    case 'cores': return v > 0 && v < 0.005 ? '<0.01 cores' : `${trim(v, v < 10 ? 2 : 1)} cores`;
    case 'count': return v >= 10000 ? `${trim(v / 1000, 1)}K` : v > 0 && v < 0.5 ? '<1' : String(Math.round(v));
    default: return v > 0 && v < 0.005 ? '<0.01' : trim(v, 2);
  }
}
// A bound exactly as stated (formatValue's "<0.1%" is a value's floor, never a threshold's words).
function exactWords(x, unit) {
  switch (unit) {
    case 'ratio': return `${trim(x * 100, 3)}%`;
    case 'per-second': return x < 0.1 ? `${trim(x * 60, 3)}/min` : `${trim(x, 3)}/s`;
    case 'seconds': return x < 1 ? `${trim(x * 1000, 3)} ms` : `${trim(x, 3)} s`;
    case 'cores': return `${trim(x, 3)} cores`;
    case 'bytes': return formatValue(x, unit);
    default: return trim(x, 3);
  }
}
// A tile's bound in words, as its judge applies it: a count's as the whole number it turns at
// ("amber at 1 or more"), any other in its unit; red only when the bound states one.
export function boundWords(b, unit) {
  if (!b || b.bound === null) return '';
  const src = b.from === 'stated' ? 'a stated default' : b.from.replace(/^library:([^#]+)#(.+)$/, 'the library: $1, $2');
  const at = (x) => {
    if (unit === 'count') return b.kind === 'floor' ? `at ${Math.ceil(x) - 1} or fewer` : `at ${Math.floor(x) + 1} or more`;
    return `${b.kind === 'floor' ? 'below' : 'above'} ${exactWords(x, unit)}`;
  };
  // A bound whose red is its amber turns red at once.
  if (b.critical !== null && b.critical === b.bound) return `Red ${at(b.critical)} (from ${src}).`;
  return `Amber ${at(b.bound)}${b.critical !== null ? `, red ${at(b.critical)}` : ''} (from ${src}).`;
}
const timeOf = (iso) => {
  const d = new Date(iso || '');
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

// ---------- pieces ----------

function sparkHtml(chart) {
  if (!chart || chart.points.length < 2) return '';
  const vals = chart.points.map((p) => p[1]).filter((x) => x !== null);
  if (!vals.length) return '';
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const t0 = chart.points[0][0], t1 = chart.points[chart.points.length - 1][0];
  const tw = t1 - t0 || 1;
  let d = '';
  let pen = false;
  for (const [t, v] of chart.points) {
    if (v === null) { pen = false; continue; }
    const x = ((t - t0) / tw) * 100, y = 22 - ((v - lo) / span) * 20;
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `;
    pen = true;
  }
  const label = `${chart.label}, last ${chart.range}: from ${formatValue(vals[0], chart.unit)} to ${formatValue(vals[vals.length - 1], chart.unit)}, between ${formatValue(lo, chart.unit)} and ${formatValue(hi, chart.unit)}`;
  return `<svg class="ov-cr__spark" viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(label)}"><path d="${d.trim()}"></path></svg>`;
}

function kpiHtml(k) {
  const verdict = k.verdict ? `<span class="ov-cr__verdict ov-cr__verdict--${k.verdict}">${k.verdict === 'met' ? 'within target' : 'over target'}</span>` : '';
  return `
        <div class="ov-cr__kpi ov-cr__kpi--${escapeHtml(k.tone)}">
          <div class="ov-cr__kpi-head"><span class="ov-cr__kpi-label">${escapeHtml(k.label)}</span><span class="ov-cr__kpi-long">${escapeHtml(k.long)}</span></div>
          <div class="ov-cr__kpi-value">${escapeHtml(k.words)}</div>
          <p class="ov-cr__kpi-sub">${escapeHtml(k.sub)}</p>${k.detail ? `
          <p class="ov-cr__kpi-detail">${escapeHtml(k.detail)}</p>` : ''}${k.asOf && timeOf(k.asOf) ? `
          <p class="ov-cr__kpi-detail">${escapeHtml(k.asOfWord || 'History read at')} ${escapeHtml(timeOf(k.asOf))}.</p>` : ''}${k.target ? `
          <p class="ov-cr__kpi-target">${escapeHtml(k.target)}${verdict ? ` · ${verdict}` : ''}</p>` : ''}${k.basis ? `
          <details class="ov-cr__how" data-cr-open="how-${escapeHtml(k.label)}"><summary>How it is measured</summary><p>${escapeHtml(k.basis)}</p></details>` : ''}
        </div>`;
}

function statusHtml(s) {
  const counts = s.counts ? `
        <div class="ov-cr__counts" role="group" aria-label="Firing alerts by severity">
          <span class="ov-cr__count ov-cr__count--fail"><b>${s.counts.critical}</b> critical</span>
          <span class="ov-cr__count ov-cr__count--warn"><b>${s.counts.warning}</b> warning</span>${s.counts.other ? `
          <span class="ov-cr__count ov-cr__count--warn"><b>${s.counts.other}</b> not recognised</span>` : ''}
          <span class="ov-cr__count ov-cr__count--info"><b>${s.counts.info}</b> info</span>
        </div>` : '';
  return `
      <section class="ov-cr__status ov-cr__status--${escapeHtml(s.tone)}" aria-label="Status">
        <span class="ov-cr__dot" aria-hidden="true"></span>
        <div class="ov-cr__status-text"><div class="ov-cr__word">${escapeHtml(s.word)}</div><p class="ov-cr__sentence">${escapeHtml(s.sentence)}</p></div>${counts}
      </section>`;
}

function scrapeHtml(sc) {
  if (!sc) return '';
  const pct = sc.ratio === null ? null : Math.max(0, Math.min(100, sc.ratio * 100));
  return `
      <section class="ov-cr__scrape ov-cr__scrape--${escapeHtml(sc.tone)}" aria-label="Scrape health">
        <div class="ov-cr__scrape-head"><span class="ov-cr__h">Exporters</span><span class="ov-cr__scrape-words">${escapeHtml(sc.words)}</span></div>${pct !== null ? `
        <div class="ov-cr__bar" role="img" aria-label="${escapeHtml(sc.words)}"><span style="width:${pct.toFixed(1)}%"></span></div>` : ''}${sc.declared ? `
        <p class="ov-cr__declared ov-cr__declared--${escapeHtml(sc.declared.tone)}">${escapeHtml(sc.declared.words)}</p>` : ''}${sc.sub ? `
        <p class="ov-cr__muted">${escapeHtml(sc.sub)}</p>` : ''}
      </section>`;
}

const SEV_WORD = { critical: 'Critical', warning: 'Warning', info: 'Info' };
function alertsHtml(al) {
  if (!al.rows.length) return '';
  // An unrecognised severity is said as its own label, never as a warning.
  const row = (r) => `<li class="ov-cr__alert ov-cr__alert--${escapeHtml(r.severity)}"><span class="ov-cr__sev">${escapeHtml(SEV_WORD[r.severity] || r.severityText || 'Unknown')}</span><span class="ov-cr__alert-name">${escapeHtml(r.name)}${r.instances > 1 ? ` <span class="ov-cr__muted">× ${r.instances}</span>` : ''}</span><span class="ov-cr__alert-for">${r.state === 'pending' ? 'pending' : 'firing'}${r.forWords ? ` · ${r.state === 'firing' && r.ageFrom === 'evaluator' ? 'active ' : ''}${escapeHtml(r.forWords)}` : ''}</span></li>`;
  const shown = al.rows.slice(0, 5), rest = al.rows.slice(5);
  return `
      <section class="ov-cr__alerts" aria-label="Active alerts">
        <h3 class="ov-cr__h">Active alerts</h3>
        <ul class="ov-cr__alert-list">${shown.map(row).join('')}</ul>${rest.length || al.more ? `
        <details class="ov-cr__more" data-cr-open="alerts"><summary>${rest.length + al.more} more</summary><ul class="ov-cr__alert-list">${rest.map(row).join('')}</ul>${al.more ? `<p class="ov-cr__muted">And ${al.more} not listed.</p>` : ''}</details>` : ''}
      </section>`;
}

function familyHtml(f) {
  // The closed row's numbers name themselves to a screen reader; its worst tone is a word as well as a mark.
  const head = f.headline.map((t) => `<span class="ov-cr__fam-v ov-cr__tone--${escapeHtml(t.tone)}" title="${escapeHtml(t.label)}"><span class="ov-cr__sr">${escapeHtml(t.label)}: </span>${escapeHtml(formatValue(t.value, t.unit))}</span>`).join('');
  const tiles = f.tiles.map((t) => {
    const bound = t.bound ? boundWords(t.bound, t.unit) : '';
    return `
            <div class="ov-cr__tile ov-cr__tile--${escapeHtml(t.tone)}">
              <span class="ov-cr__tile-l">${escapeHtml(t.label)}</span>
              <span class="ov-cr__tile-v">${escapeHtml(formatValue(t.value, t.unit))}</span>${t.note ? `
              <span class="ov-cr__tile-n">${escapeHtml(t.note)}</span>` : ''}${bound ? `
              <span class="ov-cr__tile-b">${escapeHtml(bound)}</span>` : ''}
            </div>`;
  }).join('');
  // The worst tone in a word as well as a colour (red · amber), its count in the title and for a screen reader.
  const mark = f.toneWords ? `<span class="ov-cr__fam-mark ov-cr__fam-mark--${f.tone === 'bad' ? 'bad' : 'warn'}" title="${escapeHtml(f.toneWords)}" aria-hidden="true">${f.tone === 'bad' ? 'red' : 'amber'}</span><span class="ov-cr__sr">${escapeHtml(f.toneWords)}: </span>` : '';
  return `
        <details class="ov-cr__fam ov-cr__fam--${escapeHtml(f.layer)} ov-cr__fam-tone--${escapeHtml(f.tone)}" data-cr-open="fam-${escapeHtml(f.id)}">
          <summary class="ov-cr__fam-sum"><span class="ov-cr__fam-title">${mark}${escapeHtml(f.title)}</span><span class="ov-cr__fam-head">${head}</span>${sparkHtml(f.chart)}</summary>
          <div class="ov-cr__tiles">${tiles}
          </div>${f.chart ? `
          <p class="ov-cr__muted">The line: ${escapeHtml(f.chart.label.toLowerCase())}, the last ${escapeHtml(f.chart.range)}.</p>` : ''}
        </details>`;
}

function bodyHtml(m) {
  if (m.first) return '<p class="ov-cr__reading" role="status">Reading the live side…</p>';
  if (m.error && !m.status) return `<p class="ov-cr__error">${escapeHtml(m.error.text)}</p><p class="ov-cr__muted">${m.error.final ? 'Reads stopped: Refresh tries again.' : 'Trying again shortly.'}</p>`;
  const stale = m.error ? `<p class="ov-cr__error">The last read failed: ${escapeHtml(m.error.text)} The figures below are from ${escapeHtml(timeOf(m.readAt))}.</p>` : '';
  const insights = m.insights.length ? `<ul class="ov-cr__insights">${m.insights.map((i) => `<li class="ov-cr__insight ov-cr__insight--${escapeHtml(i.tone)}">${escapeHtml(i.text)}</li>`).join('')}</ul>` : '';
  const fams = m.families.rows.length ? `
      <section class="ov-cr__fams" aria-label="Known metrics">
        <h3 class="ov-cr__h">Known metrics</h3>${m.families.rows.map(familyHtml).join('')}
      </section>` : '';
  return `${stale}
      ${statusHtml(m.status)}
      <section class="ov-cr__kpis" aria-label="Detection and resolution">${kpiHtml(m.kpis.mttr)}${kpiHtml(m.kpis.mttd)}
      </section>${m.targets ? `
      <p class="ov-cr__targets"><button type="button" class="og-btn og-btn--text" data-ux-action="cr-targets" aria-label="${escapeHtml(m.targets.aria)}">${escapeHtml(m.targets.label)}</button></p>` : ''}
      ${insights}
      ${scrapeHtml(m.scrape)}
      ${alertsHtml(m.alerts)}
      ${fams}${m.families.note ? `<p class="ov-cr__muted">${escapeHtml(m.families.note)}</p>` : ''}${m.families.absent ? `<p class="ov-cr__muted">${escapeHtml(m.families.absent)}</p>` : ''}`;
}

function stripHtml(m) {
  const parts = [];
  if (m.endpoint) parts.push(`Read through ${escapeHtml(m.endpoint)}`);
  if (m.readAt) parts.push(`at ${escapeHtml(timeOf(m.readAt))}`);
  // The next read as the driver will do it: every minute, later after a failure, none once stopped.
  if (m.next) parts.push(escapeHtml(m.next));
  if (m.outOfTime) parts.push('cut at its time limit: what it had not read is said so');
  if (m.calls) parts.push(`${m.calls.made} queries`);
  return `<p class="ov-cr__strip">${parts.join(' · ')}</p>${m.scope ? `
      <p class="ov-cr__scope">${escapeHtml(m.scope)}</p>` : ''}`;
}
// What the live region says: which service environment, then its status word and sentence, or the
// error. Set only when it changes; naming the panel's title makes another service's same status news.
const liveText = (m) => (m.error ? `${m.title}: the last read failed: ${m.error.text}` : m.status ? `${m.title}: ${m.status.word}. ${m.status.sentence}` : '');

/** The panel's top below the board's context bar (see the header). */
export function placeControlRoom(head, doc = globalThis.document) {
  const root = doc?.documentElement;
  const panel = doc?.querySelector?.('.ov-cr');
  if (!root || !panel || !head) return;
  root.style.setProperty('--ov-cr-head', '0px');
  const natural = panel.getBoundingClientRect().top;
  const headBottom = head.getBoundingClientRect().bottom + (doc.defaultView?.scrollY || 0);
  root.style.setProperty('--ov-cr-head', `${Math.max(0, Math.round(headBottom + 12 - natural))}px`);
}

// ---------- the panel ----------

const opened = new Map(); // key → Set of data-cr-open ids the reader opened
const drawn = new WeakMap(); // panel element → the pieces' words last drawn

export function renderControlRoom(container, model, host = appHost) {
  if (!container) return;
  const ov = host?.overview || {};
  if (!model) { container.innerHTML = ''; return; }
  // Two children of the host: the panel (repainted) and the live region (kept, so a change is announced once).
  let mount = container.querySelector(':scope > .ov-cr-mount');
  let live = container.querySelector(':scope > .ov-cr__live');
  if (!mount || !live) {
    container.innerHTML = '<div class="ov-cr-mount"></div><p class="ov-cr__live ov-cr__sr" role="status" aria-live="polite"></p>';
    mount = container.querySelector(':scope > .ov-cr-mount');
    live = container.querySelector(':scope > .ov-cr__live');
  }
  const was = mount.querySelector('.ov-cr');
  const sameKey = !!was && was.dataset.crKey === model.key;
  if (!opened.has(model.key)) opened.set(model.key, new Set());
  const open = opened.get(model.key);
  // Refresh stays focusable while a read runs (aria-disabled, the click ignored), so the focus never jumps.
  const pieces = {
    titles: `<p class="ov-cr__eyebrow">Control room</p><h2 class="ov-cr__title" id="ov-cr-title">${escapeHtml(model.title)}</h2>`,
    acts: `
          <button type="button" class="og-btn ov-cr__refresh" data-ux-action="cr-refresh" aria-busy="${model.reading ? 'true' : 'false'}"${model.reading ? ' aria-disabled="true"' : ''}>${model.reading ? 'Reading…' : 'Refresh'}</button>
          <button type="button" class="og-btn og-btn--text ov-cr__close" data-ux-action="cr-close" aria-label="Close the control room">Close</button>`,
    strip: stripHtml(model),
    body: bodyHtml(model),
  };
  // The rows the reader opened, opened again in a body just drawn.
  const reopen = (root) => {
    for (const d of root.querySelectorAll('details[data-cr-open]')) {
      if (open.has(d.dataset.crOpen)) d.open = true;
      d.addEventListener('toggle', () => { if (d.open) open.add(d.dataset.crOpen); else open.delete(d.dataset.crOpen); });
    }
  };
  let aside = was;
  if (!sameKey) {
    mount.innerHTML = `
    <aside class="ov-cr" id="ov-cr" role="dialog" aria-modal="false" aria-labelledby="ov-cr-title" tabindex="-1" data-cr-key="${escapeHtml(model.key)}">
      <header class="ov-cr__top">
        <div class="ov-cr__titles">${pieces.titles}</div>
        <div class="ov-cr__acts">${pieces.acts}
        </div>
      </header>
      <div class="ov-cr__head">${pieces.strip}</div>
      <div class="ov-cr__body">${pieces.body}
      </div>
    </aside>`;
    aside = mount.querySelector('.ov-cr');
    drawn.set(aside, { ...pieces });
    reopen(aside);
    aside.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); ov.closeControlRoom?.(); }
    });
  } else {
    // The same panel: only the pieces whose words changed are drawn again; the focus, if it was in one,
    // goes back to the same control or row.
    const last = drawn.get(aside) || {};
    const active = document.activeElement;
    const focusAction = aside.contains(active) ? active?.getAttribute?.('data-ux-action') || active?.closest?.('[data-cr-open]')?.dataset.crOpen || null : null;
    const lostFocus = [];
    for (const [name, sel] of [['titles', '.ov-cr__titles'], ['acts', '.ov-cr__acts'], ['strip', '.ov-cr__head'], ['body', '.ov-cr__body']]) {
      if (last[name] === pieces[name]) continue;
      const el = aside.querySelector(sel);
      if (!el) continue;
      const scroll = name === 'body' ? el.scrollTop : 0;
      if (el.contains(active)) lostFocus.push(name);
      el.innerHTML = name === 'body' ? `${pieces.body}\n      ` : name === 'acts' ? `${pieces.acts}\n        ` : pieces[name];
      if (name === 'body') { reopen(el); if (scroll) el.scrollTop = scroll; }
    }
    drawn.set(aside, { ...pieces });
    if (lostFocus.length) {
      const back = focusAction ? (aside.querySelector(`[data-ux-action="${focusAction}"]`) || aside.querySelector(`[data-cr-open="${focusAction}"] summary`)) : null;
      (back || aside).focus({ preventScroll: true });
    }
  }
  const said = liveText(model);
  if (said && live.textContent !== said) live.textContent = said;
  wireUxActions(aside, {
    'cr-close': () => ov.closeControlRoom?.(),
    'cr-refresh': () => { if (!model.reading) ov.refreshControlRoom?.(); },
    // Set targets… / Change targets…: the service's form at its Targets answer (the panel closes).
    'cr-targets': () => ov.setTargets?.('control-room'),
  });
  // A new service environment takes the focus.
  if (!sameKey) aside.focus({ preventScroll: true });
}
