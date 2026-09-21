// studio/neuron-view.mjs
//
// Advanced → Neuron — the observability control neuron as ONE surface. Every
// saved journey read together: what the fleet's last runs say (tiles), how
// alignment and grade move over time (trend), which runs passed, breached
// or lost their vantage (outcome heatmap), what breached and what the
// ranker blamed (bars), then ONE journey in focus — its ladder per run, its
// chain integrity, its stack self-metric samples as small multiples, its
// run duration, and the newest record opened up: requirement chains,
// candidate causes, the transition since the run before, the gate, the
// stack evidence, the vantage, backend versions, delivery and the schedule
// snippets. The saved-journey cards (capture, run-now, history) stay at the
// bottom, unchanged.
//
// Conventions (docs/UI_CONVENTIONS.md): the loader (`loadNeuronData`) fetches
// and builds the model through tools/lib/neuron-model.mjs; the renderer
// (`renderNeuron(container, { data, ui }, host)`) is data in, DOM out; the
// dispatcher entry (`renderNeuronView(view)`) composes the two. The model
// and the chart builders are imported at call time from /lib (the server
// exposes tools/lib there), never statically: the studio graph stays
// linkable headless and a failed load degrades to a message, never to a
// broken view.
//
// Honesty rules the surface keeps (see neuron-model.mjs header): gaps stay
// gaps, stack samples are drawn in one ink colour and worded as signals,
// ladder buckets are counts, candidate causes say "not a verdict".

import { state } from './state.mjs';
import { api } from './api.mjs';
import { escapeHtml, toast, fmtRelative } from './util.mjs';
import { host as appHost } from './host.mjs';
import { renderCaptureBar, renderJourneyCards } from './journeys-view.mjs';

const enc = encodeURIComponent;
const POST = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}' };
const OUTCOME_META = {
  'pass': { icon: '✅', cls: 'is-pass', label: 'pass' },
  'gate-failed': { icon: '❌', cls: 'is-fail', label: 'gate failed' },
  'vantage-lost': { icon: '⚠️', cls: 'is-lost', label: 'vantage lost' },
};
const LADDER_KEYS = ['healthy', 'degraded', 'broken', 'unobserved'];
// A neutral ramp: on-wire liveness buckets are counts, not verdicts, so no
// red/green — the accent for healthy, then greys by depth.
const LADDER_COLORS = ['var(--NRN, #0F766E)', 'var(--ink-5, #9AA3AD)', 'var(--ink-2, #1F3A5F)', 'var(--line, #D4D9DF)'];
const ACCENT = 'var(--NRN, #0F766E)';
const MUTED = 'var(--ink-4, #6B6B6B)';
// Blast radius segments: what would go blind if the node died. Structural
// exposure, not a claim that it is blind — so no verdict colour: the accent
// for SLOs, ink for alerts, a light grey for the other consumers.
const BLAST_KEYS = ['SLOs', 'alerts', 'other consumers (panels · dashboards · routes · remediations)'];
const BLAST_COLORS = [ACCENT, 'var(--ink-2, #1F3A5F)', 'var(--ink-5, #9AA3AD)'];
const MAX_BLAST_ROWS = 12;
const blastLegend = () => `<div class="nrn-legend">${BLAST_KEYS.map((k, i) => `<span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${BLAST_COLORS[i]}"></span>${escapeHtml(k)}</span>`).join('')}</div>`;
const blastItem = (n, label) => ({ label, values: [n.slos, n.alerts, Math.max(0, n.total - n.slos - n.alerts)], note: `${n.status || ''}${n.ladderStatus ? ` · ${n.ladderStatus}` : ''} · in ${n.chains.length} chain${n.chains.length === 1 ? '' : 's'}: ${n.chains.join(', ')} · ${n.panels} panels · ${n.dashboards} dashboards · ${n.routes} routes · ${n.remediations} remediations` });
// Integer y ticks for small counts; the chart's own nice ticks above that.
const countTicks = (maxV) => (maxV <= 6 ? { yMax: Math.max(1, maxV), yTicks: Array.from({ length: Math.max(1, maxV) + 1 }, (_, i) => i) } : { yMax: null, yTicks: null });
const MAX_STACK_PANELS = 12;

let _libs = null;
async function neuronLibs() {
  if (!_libs) {
    const [model, charts, stack, sched] = await Promise.all([
      import('/lib/neuron-model.mjs'),
      import('/lib/svg-charts.mjs'),
      import('/lib/stack-evidence.mjs').catch(() => null),
      import('/lib/schedule.mjs').catch(() => null),
    ]);
    _libs = { model, charts, stack, sched };
  }
  return _libs;
}

// ---------- loader ----------

export async function loadNeuronData({ fetchFn = api, window = 50 } = {}) {
  const { model } = await neuronLibs();
  const { journeys = [] } = await fetchFn('/api/journeys');
  const runsByName = {};
  await Promise.all(journeys.map(async (j) => {
    try { runsByName[j.name] = (await fetchFn(`/api/journeys/${enc(j.name)}/runs?limit=${window}`)).runs || []; }
    catch { runsByName[j.name] = []; }
  }));
  return { journeys, runsByName, window, model: model.buildNeuronModel({ journeys, runsByName, window }) };
}

// ---------- dispatcher entry ----------

export function renderNeuronView(view) {
  const section = document.createElement('section');
  section.className = 'section neuron-view';
  section.dataset.layer = 'NRN';
  section.innerHTML = `
    <div class="refs-head nrn-head">
      <h2 class="refs-title">Neuron <span class="nrn-title-sub">observability control</span></h2>
      <p class="refs-sub">The monitor of the monitors. Every saved journey re-checks that the artefacts which
        observe a system are still present, alive and doing their job — this page reads all of them as one
        instrument: the fleet's last word, the trend, what broke, what the evidence points at, and one journey
        opened up. Signals stay signals; verdicts come only from a journey's gate.</p>
    </div>
    <div class="nrn-body" id="nrn-body"><div class="refs-empty">Loading the neuron…</div></div>`;
  view.appendChild(section);
  refreshNeuron(section.querySelector('#nrn-body'));
}

async function refreshNeuron(container, host = appHost) {
  if (!container) return;
  try {
    const data = await loadNeuronData({ window: windowOf(state.neuronWindow) });
    renderNeuron(container, { data, ui: uiFromState(data.model) }, host);
  } catch (e) {
    container.innerHTML = `<div class="refs-empty refs-error">Couldn't load the neuron: ${escapeHtml(e.message)}</div>`;
  }
}

const windowOf = (v) => ([20, 50, 100, 200].includes(Number(v)) ? Number(v) : 50);
function uiFromState(model) {
  const names = Object.keys(model?.perJourney || {});
  let focus = typeof state.neuronJourney === 'string' && names.includes(state.neuronJourney) ? state.neuronJourney : null;
  return { focus, metric: state.neuronMetric === 'grade' ? 'grade' : 'alignment', window: windowOf(state.neuronWindow) };
}

// ---------- renderer ----------

export async function renderNeuron(container, { data, ui }, host = appHost) {
  const { model: mdl, charts, stack: stackLib, sched: schedLib } = await neuronLibs();
  const model = data.model;
  const focus = ui.focus || mdl.defaultFocus(model);
  const names = Object.keys(model.perJourney);

  container.innerHTML = `
    ${renderToolbar(model, { ...ui, focus }, names)}
    ${names.length ? renderTiles(model) : renderEmpty()}
    ${names.length ? renderFleetPanels(model, { ...ui, focus }, charts) : ''}
    ${focus ? renderFocus(model.perJourney[focus], model, charts, stackLib, schedLib) : ''}
    <h3 class="nrn-section-title">Saved journeys</h3>
    <div class="journeys-capture" id="nrn-capture"></div>
    <div class="journeys-list" id="nrn-cards"></div>
    ${renderWhereElse()}`;

  renderCaptureBar(container.querySelector('#nrn-capture'));
  renderJourneyCards(container.querySelector('#nrn-cards'), { journeys: data.journeys, runsByName: data.runsByName, stackLib, schedLib }, { onRun: () => refreshNeuron(container, host) });
  wire(container, { data, ui: { ...ui, focus } }, host);
}

function renderToolbar(model, ui, names) {
  const opt = (v, label, cur) => `<option value="${escapeHtml(v)}"${String(v) === String(cur) ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  return `
    <div class="nrn-toolbar" role="toolbar" aria-label="Neuron controls">
      <label class="nrn-ctl">window <select class="nrn-select" id="nrn-window" title="How many newest runs per journey the series keep">
        ${[20, 50, 100, 200].map((n) => opt(n, `last ${n} runs`, ui.window)).join('')}</select></label>
      <label class="nrn-ctl">trend <select class="nrn-select" id="nrn-metric">
        ${opt('alignment', 'alignment %', ui.metric)}${opt('grade', 'grade score %', ui.metric)}</select></label>
      <label class="nrn-ctl">focus <select class="nrn-select" id="nrn-focus" ${names.length ? '' : 'disabled'}>
        ${names.length ? names.map((n) => opt(n, n, ui.focus)).join('') : '<option>no journeys</option>'}</select></label>
      <span class="nrn-toolbar-spacer"></span>
      <span class="nrn-muted" title="journeys · run records in the window">${model.generatedFrom.journeys} journeys · ${model.generatedFrom.runs} runs in window</span>
      <button type="button" class="ctrl-btn" id="nrn-run-all" ${names.length ? '' : 'disabled'} title="Run every saved journey now, one after the other (the CLI form is packc journey run --all)">▶ run all</button>
      <button type="button" class="ctrl-btn" id="nrn-refresh" title="Re-read the journeys and their run history">↻ refresh</button>
    </div>`;
}

function renderEmpty() {
  return `<div class="refs-note nrn-empty">No journeys saved yet — the neuron has nothing to read. Load Pack A and
    Pack B (Discover → compare) and <strong>save this comparison as a journey</strong> below, or add
    <code>.observogram/journeys/&lt;name&gt;.journey.yaml</code> by hand; then run it here, from
    <code>packc journey run &lt;name&gt;</code>, or on the schedule its <code>schedule:</code> declares.</div>`;
}

// ---------- tiles ----------

const pct = (v) => (v === null || v === undefined ? '—' : `${v}`);
const signed = (v) => (v === null || v === undefined ? '' : v > 0 ? `+${v}` : `${v}`);
function tile({ label, value, unit = '', note = '', delta = null, acc = 'is-gray', warn = false }) {
  return `<div class="mc-tile ${acc}${warn ? ' is-warn' : ''}">
    <div class="mc-tile-label">${escapeHtml(label)}</div>
    <div class="mc-tile-value">${escapeHtml(String(value))}${unit ? `<span class="mc-tile-unit">${escapeHtml(unit)}</span>` : ''}</div>
    ${delta !== null && delta !== undefined ? `<div class="mc-tile-trend"><span class="mc-tile-delta">${escapeHtml(delta)}</span></div>` : ''}
    ${note ? `<div class="mc-tile-note">${note}</div>` : ''}
  </div>`;
}
const few = (list, n = 3) => (list.length <= n ? list.join(', ') : `${list.slice(0, n).join(', ')} +${list.length - n}`);

function renderTiles(model) {
  const f = model.fleet;
  const o = f.outcomes;
  const chainsPct = f.chains.declaredTotal ? Math.round((f.chains.intact / f.chains.declaredTotal) * 100) : null;
  const delivery = Object.fromEntries(f.delivery.map((d) => [d.key, d.count]));
  const noNotify = f.journeys - f.delivery.reduce((s, d) => s + d.count, 0) - o['never-run'];
  return `<div class="mc-tiles nrn-tiles">
    ${tile({ label: 'journeys', value: f.journeys, acc: 'is-cmp', note: `${f.scheduled} scheduled · ${f.notifying} notify · ${f.stackGated} stack-gated${f.loadErrors ? ` · <span class="journey-load-error">${f.loadErrors} broken definition${f.loadErrors === 1 ? '' : 's'}</span>` : ''}` })}
    ${tile({ label: 'last outcomes', value: o.pass, unit: `/ ${f.journeys - o['never-run']} pass`, acc: o['gate-failed'] || o['vantage-lost'] ? 'is-amber' : 'is-green', warn: !!(o['gate-failed'] || o['vantage-lost']),
      note: `${outcomeBar(o)} ${o['gate-failed']} gate-failed · ${o['vantage-lost']} vantage-lost · ${o['never-run']} never run` })}
    ${tile({ label: 'fleet alignment', value: pct(f.alignment.mean), unit: f.alignment.mean === null ? '' : '%', acc: 'is-blue', delta: f.alignment.delta === null ? null : `${signed(f.alignment.delta)} pts vs the run before (paired)`, note: `mean of the last run of ${f.alignment.n} journey${f.alignment.n === 1 ? '' : 's'} with a value` })}
    ${tile({ label: 'fleet grade', value: pct(f.grade.mean), unit: f.grade.mean === null ? '' : '%', acc: 'is-blue', delta: f.grade.delta === null ? null : `${signed(f.grade.delta)} pts vs the run before (paired)`, note: `verification score · ${f.grade.n} journey${f.grade.n === 1 ? '' : 's'}` })}
    ${tile({ label: 'requirement chains', value: f.chains.declaredTotal ? `${f.chains.intact}/${f.chains.declaredTotal}` : '—', unit: chainsPct === null ? '' : `${chainsPct}% intact`, acc: 'is-cyan',
      note: `ladder: ${f.chains.ladder.healthy} healthy · ${f.chains.ladder.degraded} degraded · ${f.chains.ladder.broken} broken · ${f.chains.ladder.unobserved} unobserved${f.chains.integrityPct !== null ? ` · integrity ${f.chains.integrityPct}% scored / ${pct(f.chains.ladderIntegrityPct)}% ladder` : ''}${f.chains.degradedNodes ? ` · ${f.chains.degradedNodes} degraded node${f.chains.degradedNodes === 1 ? '' : 's'}` : ''}` })}
    ${tile({ label: 'getting worse', value: f.chains.worse.length, acc: f.chains.worse.length ? 'is-red' : 'is-gray', warn: !!f.chains.worse.length, note: f.chains.worse.length ? `chains moved down since the run before: ${escapeHtml(few(f.chains.worse))}` : 'no chain moved down on the last runs' })}
    ${tile({ label: 'widest exposure', value: f.topExposure ? f.topExposure.slos : '—', unit: f.topExposure ? `SLO${f.topExposure.slos === 1 ? '' : 's'} blinded` : '', acc: f.topExposure && f.topExposure.slos > 0 ? 'is-amber' : 'is-gray',
      note: f.topExposure ? `${escapeHtml(f.topExposure.label)} (${escapeHtml(f.topExposure.kind)}) · ${escapeHtml(f.topExposure.journey)}${f.topExposure.alerts ? ` · ${f.topExposure.alerts} alerts` : ''}` : 'no degraded node blinds an SLO' })}
    ${tile({ label: 'delivery', value: delivery.sent || 0, unit: 'sent', acc: delivery.failed ? 'is-red' : 'is-gray', warn: !!delivery.failed,
      note: `${delivery.failed || 0} failed · ${delivery.skipped || 0} skipped${delivery.unknown ? ` · ${delivery.unknown} unknown` : ''} · ${Math.max(0, noNotify)} without notify` })}
    ${tile({ label: 'stack signal', value: f.stackSignal.length, unit: `journey${f.stackSignal.length === 1 ? '' : 's'}`, acc: f.stackSignal.length ? 'is-amber' : 'is-gray',
      note: f.stackSignal.length ? `a lower-is-comfortable self-metric read nonzero on the last run: ${escapeHtml(few(f.stackSignal))} — signal, not verdict` : 'no nonzero lower-is-comfortable sample on the last runs' })}
    ${inventoryTile(f.inventory)}
  </div>`;
}

// Inventory coverage across the fleet (neuron-model.mjs fleetInventory): the largest
// enumerated kind headlines as up / inventoried, the other kinds and the counted totals follow,
// and the journeys whose last run could not check are named. No block anywhere: said so.
function inventoryTile(inv) {
  if (!inv || !inv.journeys) {
    return tile({ label: 'inventory coverage', value: '—', acc: 'is-gray', note: 'no journey declares an inventory: block (a gen-site partition\'s site.json) — whether the right number of things is monitored is not being checked' });
  }
  const kinds = Object.entries(inv.kinds).sort((a, b) => b[1].expected - a[1].expected);
  const [k, t] = kinds[0] || [null, null];
  const rest = kinds.slice(1).map(([kk, tt]) => `${tt.up}/${tt.expected} ${escapeHtml(kk)}`);
  const counted = Object.entries(inv.counted).map(([, tt]) => `${tt.total} ${escapeHtml(tt.title)}${tt.total === 1 ? '' : 's'}${tt.below ? ` (${tt.below} below floor)` : ''}`);
  const holes = t ? [t.down ? `${t.down} down` : null, t.silent ? `${t.silent} silent` : null, t.unexpected ? `${t.unexpected} unexpected` : null].filter(Boolean) : [];
  const unchecked = inv.unchecked.length ? `<span class="journey-load-error">${inv.unchecked.length} unchecked: ${escapeHtml(few(inv.unchecked))}</span>` : '';
  const note = [...holes, ...rest, ...counted, unchecked].filter(Boolean).join(' · ') || `${inv.journeys} journey${inv.journeys === 1 ? '' : 's'} checked`;
  return tile({ label: 'inventory coverage', value: t ? `${t.up}/${t.expected}` : '—', unit: t ? `${escapeHtml(k)} up` : '', acc: !t ? 'is-gray' : (t.silent || t.down) ? 'is-amber' : 'is-green', warn: !!(t && (t.silent || t.down)), note });
}

function outcomeBar(o) {
  const total = o.pass + o['gate-failed'] + o['vantage-lost'];
  if (!total) return '';
  const seg = (n, cls) => (n ? `<span class="nrn-bar-seg ${cls}" style="flex:${n}"></span>` : '');
  return `<span class="nrn-bar" aria-hidden="true">${seg(o.pass, 'is-pass')}${seg(o['gate-failed'], 'is-gate-failed')}${seg(o['vantage-lost'], 'is-vantage-lost')}</span>`;
}

// ---------- fleet panels ----------

function panel(title, note, body, extra = '') {
  return `<div class="nrn-panel">
    <div class="nrn-panel-head"><span class="nrn-panel-title">${title}</span>${note ? `<span class="nrn-panel-note">${note}</span>` : ''}</div>
    ${body}${extra}
  </div>`;
}

function renderFleetPanels(model, ui, charts) {
  const series = model.series[ui.metric].map((s, i) => ({ ...s, color: charts.seriesColor(i) }));
  const ordered = [...series.filter((s) => s.name !== ui.focus), ...series.filter((s) => s.name === ui.focus)];
  const trend = charts.lineChart({ series: ordered, yMin: 0, yMax: 100, yTicks: [0, 25, 50, 75, 100], yFormat: (v) => `${v}%`, ariaLabel: `${ui.metric} per journey over the last ${model.window} runs`, markers: true, h: 220 });
  const legend = series.map((s) => `<button type="button" class="nrn-legend-item${s.name === ui.focus ? ' is-focus' : ''}" data-focus="${escapeHtml(s.name)}"><span class="nrn-legend-swatch" style="background:${s.color}"></span>${escapeHtml(s.name)}</button>`).join('');
  const heat = renderHeatmap(model, ui);
  const breach = model.breachFrequency.length
    ? charts.barChartH({ items: model.breachFrequency.map((b) => ({ label: b.key, value: b.count })), ariaLabel: 'breached criteria', color: 'var(--fail-border, #DC2626)' }).svg
    : `<p class="nrn-muted">no gate breach in the window</p>`;
  const causes = model.causeKinds.length
    ? charts.barChartH({ items: model.causeKinds.map((c) => ({ label: c.key, value: c.count })), ariaLabel: 'candidate cause kinds', color: MUTED }).svg
    : `<p class="nrn-muted">no candidate cause ranked in the window (nothing got worse, or nothing to blame)</p>`;
  return `<div class="nrn-grid nrn-grid-fleet">
    ${panel(`${ui.metric === 'grade' ? 'Grade score' : 'Alignment'} over time`, `per journey · gaps = vantage lost · ${trend.xMode === 'time' ? 'time axis' : 'run order'}`, trend.svg, `<div class="nrn-legend">${legend}</div>`)}
    ${panel('Outcomes, newest right', `last ${model.heatmap.columns || 0} runs per journey`, heat)}
    ${panel('Breached criteria', `count over every run in the window`, breach)}
    ${panel('Candidate cause kinds', `ranked by evidence — not root-cause verdicts`, causes)}
    ${renderFleetBlast(model, ui, charts)}
  </div>`;
}

// Blast radius at fleet level: exposure over time (the SLOs the widest
// degraded artefact would blind, per journey) and the widest exposures
// across the newest records, ranked.
function renderFleetBlast(model, ui, charts) {
  const series = model.series.exposure.map((s, i) => ({ ...s, color: charts.seriesColor(i) }));
  const maxV = Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.v ?? 0)));
  const { yMax, yTicks } = countTicks(maxV);
  const hasPoints = series.some((s) => s.points.length);
  const over = hasPoints
    ? charts.lineChart({ series: [...series.filter((s) => s.name !== ui.focus), ...series.filter((s) => s.name === ui.focus)], yMin: 0, yMax, yTicks, yFormat: (v) => String(v), ariaLabel: `SLOs the widest degraded artefact would blind, per journey over the last ${model.window} runs`, h: 180 }).svg
      + `<div class="nrn-legend">${series.map((s) => `<button type="button" class="nrn-legend-item${s.name === ui.focus ? ' is-focus' : ''}" data-focus="${escapeHtml(s.name)}"><span class="nrn-legend-swatch" style="background:${s.color}"></span>${escapeHtml(s.name)}</button>`).join('')}</div>`
    : '<p class="nrn-muted">no run in the window carries requirement chains</p>';
  const ex = model.fleet.exposures;
  const widest = ex.length
    ? charts.stackedBarH({ items: ex.map((n) => blastItem(n, `${n.label} [${n.kind}] · ${n.journey}`)), keys: BLAST_KEYS, colors: BLAST_COLORS, ariaLabel: 'widest exposures across the fleet, newest records' }).svg + blastLegend()
    : '<p class="nrn-muted">no degraded node blinds an SLO or an alert on the newest records</p>';
  return `
    ${panel('Blind-spot exposure over time', 'SLOs the widest degraded artefact would blind · structural, not a claim they are blind', over)}
    ${panel('Widest exposures, newest records', `degraded nodes of declared chains · what goes blind if the node dies${ex.length >= 12 ? ' · top 12' : ''}`, widest)}`;
}

// Blast radius of the journey in focus: every degraded node of the newest
// record's declared chains as a stacked bar, and exposure per run.
function renderBlast(d, charts) {
  const blast = d.blast || [];
  const top = blast.slice(0, MAX_BLAST_ROWS);
  const bars = blast.length
    ? charts.stackedBarH({ items: top.map((n) => blastItem(n, `${n.label} [${n.kind}]`)), keys: BLAST_KEYS, colors: BLAST_COLORS, ariaLabel: `${d.name}: blast radius of the degraded nodes, newest record` }).svg
      + blastLegend()
      + (blast.length > MAX_BLAST_ROWS ? `<p class="nrn-muted">${blast.length - MAX_BLAST_ROWS} more degraded node${blast.length - MAX_BLAST_ROWS === 1 ? '' : 's'} with a narrower radius — the requirement-chains table lists them all.</p>` : '')
    : `<p class="nrn-muted">${d.latest ? 'no degraded node in the newest record\'s declared chains — nothing would go blind that is not already declared missing' : 'no run yet'}</p>`;
  const exp = d.exposure || [];
  const maxV = Math.max(0, ...exp.map((e) => Math.max(e.slos, e.alerts)));
  const { yMax, yTicks } = countTicks(maxV);
  const title = (e) => `${e.slos} SLO${e.slos === 1 ? '' : 's'} · ${e.alerts} alert${e.alerts === 1 ? '' : 's'} · ${e.degradedNodes} degraded node${e.degradedNodes === 1 ? '' : 's'}${e.label ? ` · widest: ${e.label}` : ''}${e.t ? ` · ${new Date(e.t).toLocaleString()}` : ''}`;
  const perRun = exp.length
    ? charts.lineChart({ series: [
      { name: 'SLOs blinded by the widest node', points: exp.map((e) => ({ t: e.t, v: e.slos, title: title(e) })), color: ACCENT },
      { name: 'alerts blinded by the widest node', points: exp.map((e) => ({ t: e.t, v: e.alerts, title: title(e) })), color: MUTED },
    ], yMin: 0, yMax, yTicks, yFormat: (v) => String(v), ariaLabel: `${d.name}: exposure per run`, h: 160 }).svg
      + `<div class="nrn-legend"><span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${ACCENT}"></span>SLOs blinded by the widest degraded node</span><span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${MUTED}"></span>alerts blinded by it</span></div>`
      + `<p class="nrn-muted">latest: ${escapeHtml(title(exp[exp.length - 1]))}</p>`
    : '<p class="nrn-muted">no run in the window carries requirement chains</p>';
  return `<h4 class="nrn-sub-title">Blast radius <span class="nrn-muted">— what would go blind if a degraded artefact died: structural exposure on the requirement graph, never a claim that it is blind</span></h4>
    <div class="nrn-grid nrn-grid-blast">
      ${panel('Degraded nodes by radius, newest record', `${blast.length} degraded node${blast.length === 1 ? '' : 's'} in declared chains · one bar per node, SLOs · alerts · other consumers`, bars)}
      ${panel('Exposure per run', 'the widest degraded node\'s radius, run by run', perRun)}
    </div>`;
}

function renderHeatmap(model, ui) {
  if (!model.heatmap.rows.length) return '<p class="nrn-muted">no journeys</p>';
  const rows = model.heatmap.rows.map((r) => `
    <button type="button" class="nrn-heat-name${r.name === ui.focus ? ' is-focus' : ''}" data-focus="${escapeHtml(r.name)}" title="focus ${escapeHtml(r.name)}">${escapeHtml(r.name)}</button>
    <div class="nrn-heat-row" role="img" aria-label="${escapeHtml(r.name)}: ${r.cells.filter(Boolean).map((c) => c.outcome).join(', ') || 'never run'}">
      ${r.cells.map((c) => (c
    ? `<span class="nrn-cell is-${escapeHtml(c.outcome)}" title="${escapeHtml(`${c.outcome}${c.alignment !== null ? ` · alignment ${c.alignment}%` : ''}${c.grade !== null ? ` · grade ${c.grade}%` : ''}${c.breaches ? ` · ${c.breaches} breach${c.breaches === 1 ? '' : 'es'}` : ''}${c.t ? ` · ${new Date(c.t).toLocaleString()}` : ''}`)}"></span>`
    : '<span class="nrn-cell is-none"></span>')).join('')}
      ${r.cells.length ? '' : '<span class="nrn-muted">never run</span>'}
    </div>`).join('');
  return `<div class="nrn-heat">${rows}</div>
    <div class="nrn-heat-legend"><span class="nrn-cell is-pass"></span> pass <span class="nrn-cell is-gate-failed"></span> gate failed <span class="nrn-cell is-vantage-lost"></span> vantage lost <span class="nrn-cell is-none"></span> no run</div>`;
}

// ---------- the journey in focus ----------

const fmtCadence = (ms) => {
  if (!ms) return null;
  const m = ms / 60e3;
  if (m < 60) return `every ${m % 1 ? m.toFixed(1) : m} min`;
  const h = m / 60;
  if (h < 48) return `every ${h % 1 ? h.toFixed(1) : h} h`;
  return `every ${(h / 24) % 1 ? (h / 24).toFixed(1) : h / 24} d`;
};
const gateBits = (gate) => Object.entries(gate || {}).map(([k, v]) => `${k}=${v && typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') || 'no gate';
const scheduleText = (s) => (!s ? 'no schedule: declared (run on demand)' : `${s.cron ? `cron ${s.cron}` : s.every ? `every ${s.every}` : 'schedule'}${s.timezone ? ` (${s.timezone})` : ''}${s.cadenceMs ? ` · ${fmtCadence(s.cadenceMs)}` : s.cadenceNote ? ` · ${s.cadenceNote}` : ''}`);
const val =(v) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const kv = (pairs) => `<dl class="nrn-kv">${pairs.filter(([, v]) => v !== undefined).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${typeof v === 'string' && v.startsWith('<') ? v : escapeHtml(val(v))}</dd>`).join('')}</dl>`;
const tbl = (headers, rows) => (rows.length
  ? `<table class="nrn-table"><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  : '<p class="nrn-muted">none</p>');
const details = (title, body, { open = false, lazy = null, journey = null } = {}) => `<details class="nrn-details"${open ? ' open' : ''}${lazy ? ` data-lazy="${escapeHtml(lazy)}" data-journey="${escapeHtml(journey || '')}"` : ''}><summary>${title}</summary><div class="nrn-details-body">${body}</div></details>`;

function renderFocus(d, model, charts, stackLib, schedLib) {
  if (!d) return '';
  const last = d.latest;
  const om = last ? (OUTCOME_META[last.outcome] || { icon: '·', cls: '', label: last.outcome }) : null;
  const head = `
    <div class="nrn-focus-head">
      <span class="journey-name">${escapeHtml(d.name)}</span>
      ${last
    ? `<span class="journey-outcome ${om.cls}">${om.icon} ${escapeHtml(om.label)}${last.drift ? ` · alignment ${last.drift.alignmentPct}% · grade ${last.grade?.score ?? '?'}%${last.grade?.letter ? ` (${escapeHtml(last.grade.letter)})` : ''}` : ''} · ${escapeHtml(fmtRelative(last.startedAt) || last.startedAt || '')}</span>`
    : '<span class="journey-outcome">never run</span>'}
      <button type="button" class="ctrl-btn nrn-run-focus" data-journey="${escapeHtml(d.name)}">▶ run now</button>
    </div>
    <div class="journey-card-meta">
      <span title="Pack A source">A: <code>${escapeHtml(d.packA || '?')}</code></span>
      <span title="Pack B source">B: <code>${escapeHtml(d.packB || '?')}</code></span>
      ${d.scope?.env || d.scope?.service ? `<span>scope: ${escapeHtml([d.scope.env && `env ${d.scope.env}`, d.scope.service && `service ${d.scope.service}`, d.scope.scopeMode && `mode ${d.scope.scopeMode}`].filter(Boolean).join(' · '))}</span>` : ''}
      <span title="Gate">gate: ${escapeHtml(gateBits(d.gate))}</span>
      <span title="schedule:">${escapeHtml(scheduleText(d.schedule))}</span>
      ${d.notify ? `<span title="notify: env var NAMES only">notify: ${escapeHtml(d.notify.on || 'transitions')} → $${escapeHtml(d.notify.urlEnv)}${d.notify.authEnv ? ` (bearer $${escapeHtml(d.notify.authEnv)})` : ''} · ${escapeHtml(d.notify.format || 'json')}</span>` : ''}
      <span>${d.runs} run${d.runs === 1 ? '' : 's'} in window: ${d.outcomes.pass} pass · ${d.outcomes['gate-failed']} gate-failed · ${d.outcomes['vantage-lost']} vantage-lost</span>
      ${d.loadError ? `<span class="journey-load-error">definition does not load: ${escapeHtml(d.loadError)}</span>` : ''}
    </div>`;

  if (!d.runs) {
    return `<h3 class="nrn-section-title">In focus</h3><div class="nrn-focus">${head}<p class="nrn-muted">No run yet — nothing to chart. Run it now or wait for its schedule.</p></div>`;
  }

  // Charts: alignment + grade, ladder buckets, chain integrity, duration.
  const ag = charts.lineChart({ series: [{ name: 'alignment', points: d.alignment, color: ACCENT }, { name: 'grade', points: d.grade, color: MUTED }], yMin: 0, yMax: 100, yTicks: [0, 25, 50, 75, 100], yFormat: (v) => `${v}%`, ariaLabel: `${d.name}: alignment and grade per run`, h: 170 });
  const ladderBars = d.ladder.map((l) => ({ t: l.t, values: LADDER_KEYS.map((k) => l[k]), title: `${LADDER_KEYS.map((k) => `${l[k]} ${k}`).join(' · ')} · ${l.intact}/${l.declaredTotal} intact${l.t ? ` · ${new Date(l.t).toLocaleString()}` : ''}` }));
  const ladder = d.ladder.length
    ? charts.stackedBarChart({ bars: ladderBars, keys: LADDER_KEYS, colors: LADDER_COLORS, ariaLabel: `${d.name}: ladder buckets per run`, h: 170 }).svg
      + `<div class="nrn-legend">${LADDER_KEYS.map((k, i) => `<span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${LADDER_COLORS[i]}"></span>${k}</span>`).join('')}</div>`
    : '<p class="nrn-muted">no run in the window carries requirement chains (file-sourced B, or records written before step 4)</p>';
  const integrity = d.ladder.length
    ? charts.lineChart({ series: [{ name: 'scored integrity', points: d.ladder.map((l) => ({ t: l.t, v: l.integrityPct })), color: ACCENT }, { name: 'ladder integrity', points: d.ladder.map((l) => ({ t: l.t, v: l.ladderIntegrityPct })), color: MUTED }], yMin: 0, yMax: 100, yTicks: [0, 50, 100], yFormat: (v) => `${v}%`, ariaLabel: `${d.name}: chain integrity per run`, h: 150 }).svg
      + `<div class="nrn-legend"><span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${ACCENT}"></span>scored (what the grade counts)</span><span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${MUTED}"></span>ladder (on-wire liveness, unscored)</span></div>`
    : '';
  const dur = charts.lineChart({ series: [{ name: 'took', points: d.durations, color: MUTED }], yMin: 0, yFormat: (v) => (v >= 1000 ? `${Number((v / 1000).toFixed(1))}s` : `${v}ms`), ariaLabel: `${d.name}: run duration`, h: 130 });

  // Stack self-metric rows as small multiples, one ink colour.
  const cadenceMs = d.schedule?.cadenceMs || null;
  const budgetWindowMs = schedLib && d.stackBudget?.window ? schedLib.windowMs(d.stackBudget.window) : null;
  const gatedRows = d.gate?.stack?.rows && typeof d.gate.stack.rows === 'object' ? Object.keys(d.gate.stack.rows) : [];
  const stackPanels = d.stackRows.slice(0, MAX_STACK_PANELS).map((row) => {
    const sc = charts.stepChart({ points: row.series, unit: row.unit || '', ariaLabel: `${row.id} per run`, valueFormat: stackLib ? (v) => stackLib.formatStackValue(v, row.unit) : null });
    const latestTxt = row.latest ? (row.latest.value === null ? `last: ${stackLib ? stackLib.stackOutcomeLabel(row.latest.outcome) : row.latest.outcome}` : `last: ${stackLib ? stackLib.formatStackValue(row.latest.value, row.unit) : row.latest.value}${row.latest.hint === 'nonzero' ? ' · nonzero' : ''}`) : '';
    let posture = '';
    if (gatedRows.includes(row.id) && d.stackBudget && cadenceMs && budgetWindowMs && stackLib?.stackPostureBudget) {
      const b = stackLib.stackPostureBudget(row.series, { objective: d.stackBudget.objective, cadenceMs, windowMs: budgetWindowMs });
      posture = `<p class="nrn-muted">posture: ${escapeHtml(b.note)}</p>`;
    } else if (gatedRows.includes(row.id) && d.stackBudget && d.schedule && !cadenceMs && d.schedule.cadenceNote) {
      posture = `<p class="nrn-muted">posture: ${escapeHtml(d.schedule.cadenceNote)}</p>`;
    }
    const gateBand = gatedRows.includes(row.id) ? ` · gate ${escapeHtml(JSON.stringify(d.gate.stack.rows[row.id]))}` : '';
    return panel(`<code>${escapeHtml(row.id)}</code>`, `${escapeHtml([row.family, row.product, row.direction && `${row.direction} is ${row.direction === 'lower' ? 'comfortable' : row.direction === 'higher' ? 'good' : 'info'}`].filter(Boolean).join(' · '))}${gateBand}`,
      sc.svg, `<p class="nrn-muted">${escapeHtml(latestTxt)} · ${row.samples} sample${row.samples === 1 ? '' : 's'}${row.direction === 'lower' ? ` · nonzero in ${row.nonzero} of ${row.samples}` : ''} — point-in-time samples, signal not verdict</p>${posture}`);
  }).join('');
  const stackNote = d.stackRows.length > MAX_STACK_PANELS ? `<p class="nrn-muted">${d.stackRows.length - MAX_STACK_PANELS} more row${d.stackRows.length - MAX_STACK_PANELS === 1 ? '' : 's'} not drawn — the stack evidence table below lists them all.</p>` : '';

  return `<h3 class="nrn-section-title">In focus</h3>
    <div class="nrn-focus">
      ${head}
      <div class="nrn-grid nrn-grid-focus">
        ${panel('Alignment and grade', 'per run · gaps = vantage lost', ag.svg, `<div class="nrn-legend"><span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${ACCENT}"></span>alignment</span><span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${MUTED}"></span>grade</span></div>`)}
        ${panel('Requirement-chain ladder', 'declared chains per run · counts, not colours-as-verdicts', ladder)}
        ${integrity ? panel('Chain integrity', 'mean per run', integrity) : ''}
        ${panel('Run duration', 'wall clock per run', dur.svg)}
      </div>
      ${renderBlast(d, charts)}
      ${renderInventory(d, charts)}
      ${d.stackRows.length ? `<h4 class="nrn-sub-title">Stack self-metrics per run <span class="nrn-muted">— what the monitoring stack said about itself when the journey looked</span></h4><div class="nrn-grid nrn-grid-stack">${stackPanels}</div>${stackNote}` : `<p class="nrn-muted">No stack self-metric samples in the window${last?.stackEvidence?.status === 'not-attempted' ? ` — last run: not attempted (${escapeHtml(last.stackEvidence.reason || 'no reason recorded')})` : ' (file-sourced Pack B, or a tier that exposes no metrics_query)'}.</p>`}
      ${renderLatestDetails(d)}
    </div>`;
}

// Inventory coverage of the journey in focus: per enumerated kind a line of inventoried vs up
// per run (points only where the record checked that kind), then the newest record's table —
// up, down (targeted but every target down), silent (no up series at all), unexpected
// (answering but not inventoried), and the counted kinds' totals against their floors.
function renderInventory(d, charts) {
  const inv = d.inventory;
  if (!inv || (!inv.latest && !Object.keys(inv.series || {}).length)) return '';
  const latest = inv.latest;
  const panels = Object.entries(inv.series || {}).filter(([, s]) => s.length).map(([k, s]) => {
    const spec = latest?.kinds?.[k];
    const maxV = Math.max(1, ...s.map((p) => Math.max(p.expected, p.up + p.unexpected)));
    const { yMax, yTicks } = countTicks(maxV);
    const title = (p) => `${p.up}/${p.expected} up · ${p.down} down · ${p.silent} silent · ${p.unexpected} unexpected${p.t ? ` · ${new Date(p.t).toLocaleString()}` : ''}`;
    const chart = charts.lineChart({ series: [
      { name: 'inventoried', points: s.map((p) => ({ t: p.t, v: p.expected, title: title(p) })), color: MUTED },
      { name: 'up', points: s.map((p) => ({ t: p.t, v: p.up, title: title(p) })), color: ACCENT },
    ], yMin: 0, yMax, yTicks, yFormat: (v) => String(v), ariaLabel: `${d.name}: ${k} inventoried vs up per run`, h: 150 });
    const last = s[s.length - 1];
    return panel(`<code>${escapeHtml(k)}</code> ${escapeHtml(spec?.title || '')}`, `${last.up}/${last.expected} up · ${last.down} down · ${last.silent} silent · ${last.unexpected} unexpected${last.coveragePct !== null ? ` · ${last.coveragePct}%` : ''}`, chart.svg,
      `<div class="nrn-legend"><span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${MUTED}"></span>inventoried</span><span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${ACCENT}"></span>up</span></div>`);
  }).join('');
  return `<h4 class="nrn-sub-title">Inventory coverage <span class="nrn-muted">— the site's expected sets against the live up series: is the right number of things being monitored?</span></h4>
    ${panels ? `<div class="nrn-grid nrn-grid-inventory">${panels}</div>` : ''}
    ${latest ? inventoryTable(latest) : ''}`;
}

function inventoryTable(inv) {
  const head = `<p class="nrn-muted">newest record: <strong>${escapeHtml(inv.status)}</strong>${inv.reason ? ` — ${escapeHtml(inv.reason)}` : ''}${inv.site ? ` · ${escapeHtml(inv.site)}` : ''}${inv.environment ? ` · ${escapeHtml(inv.environment)}` : ''}</p>`;
  const rows = Object.entries(inv.kinds || {}).map(([k, c]) => (c.mode === 'counted'
    ? [
      `<code>${escapeHtml(k)}</code> ${escapeHtml(c.title || '')} <span class="nrn-muted">per ${escapeHtml(c.per || '?')}</span>`,
      `${Object.keys(c.min || {}).length} floor${Object.keys(c.min || {}).length === 1 ? '' : 's'}`,
      c.total === null || c.total === undefined ? '—' : `total ${c.total}`,
      '—', '—',
      (c.below || []).length ? `<em>${escapeHtml(c.below.map((b) => `${b.parent}: ${b.count} < ${b.min}`).join(', '))}</em>` : ((c.missing || []).length ? `<em>no count for ${escapeHtml(c.missing.join(', '))}</em>` : '—'),
      escapeHtml(c.status),
    ]
    : [
      `<code>${escapeHtml(k)}</code> ${escapeHtml(c.title || '')}`,
      String(c.expected ?? '—'),
      c.up === null || c.up === undefined ? '—' : String(c.up),
      (c.down || []).length ? escapeHtml(c.down.join(', ')) : '—',
      (c.silent || []).length ? `<em>${escapeHtml(c.silent.join(', '))}</em>` : '—',
      (c.unexpected || []).length ? escapeHtml(c.unexpected.join(', ')) : '—',
      `${escapeHtml(c.status)}${c.coveragePct !== null && c.coveragePct !== undefined ? ` · ${c.coveragePct}%` : ''}`,
    ]));
  return head + tbl(['kind', 'inventoried', 'up', 'down', 'silent', 'unexpected / below floor', 'status'], rows);
}

function renderLatestDetails(d) {
  const last = d.latest;
  if (!last) return '';
  const when = last.startedAt ? new Date(last.startedAt).toLocaleString() : '?';
  const parts = [];

  if (last.outcome === 'vantage-lost') {
    parts.push(details('Vantage lost', `<p class="nrn-muted">The live source did not answer — no verdict, the loss is a point in the history.</p><pre class="nrn-pre">${escapeHtml(last.error || 'unreachable')}</pre>`, { open: true }));
  }

  // Requirement chains of the newest record.
  const branches = last.branches || [];
  if (branches.length) {
    const rows = branches.map((b) => [
      `<strong>${escapeHtml(b.title || b.rootKey || '?')}</strong><br><span class="nrn-muted">${escapeHtml(b.rootKind || '')}</span>`,
      escapeHtml(b.verdict || '?'),
      escapeHtml(b.ladderVerdict || '?'),
      `${val(b.integrityPct)}% / ${val(b.ladderIntegrityPct)}%`,
      escapeHtml(b.confidence || ''),
      (Array.isArray(b.missingRoles) && b.missingRoles.length) ? escapeHtml(b.missingRoles.join(', ')) : '—',
      (Array.isArray(b.degraded) && b.degraded.length)
        ? `<ul class="nrn-list">${b.degraded.map((n) => `<li>${escapeHtml(n.label || n.key || '?')} <span class="nrn-muted">[${escapeHtml(n.kind || '?')}] ${escapeHtml(n.status || '')}${n.ladder?.status ? ` · ${escapeHtml(n.ladder.status)}${n.ladder.detail ? ` — ${escapeHtml(n.ladder.detail)}` : ''}` : ''}${n.blastRadius && (n.blastRadius.slos || n.blastRadius.alerts) ? ` · blinds ${n.blastRadius.slos || 0} SLO${n.blastRadius.slos === 1 ? '' : 's'}${n.blastRadius.alerts ? `, ${n.blastRadius.alerts} alert${n.blastRadius.alerts === 1 ? '' : 's'}` : ''}` : ''}</span></li>`).join('')}${b.truncated ? '<li class="nrn-muted">list cut at the record cap</li>' : ''}</ul>`
        : '—',
    ]);
    const c = last.chains || {};
    parts.push(details(`Requirement chains <span class="nrn-muted">${c.intact ?? 0}/${c.declaredTotal ?? 0} intact · ladder ${c.ladder?.healthy ?? 0} healthy · ${c.ladder?.degraded ?? 0} degraded · ${c.ladder?.broken ?? 0} broken · ${c.ladder?.unobserved ?? 0} unobserved${c.undeclaredNodes ? ` · ${c.undeclaredNodes} live-only in undeclared chains` : ''}</span>`,
      tbl(['chain', 'verdict', 'ladder', 'integrity scored / ladder', 'confidence', 'missing roles', 'degraded nodes'], rows), { open: true }));
  }

  // Candidate causes + the vantage, beside not among them.
  if (last.causes) {
    const cs = last.causes.causes || [];
    const rows = cs.map((c) => [escapeHtml(String(c.rank ?? '')), escapeHtml(c.kind || ''), escapeHtml(String(c.score ?? '')), escapeHtml(c.evidence || ''), escapeHtml((c.chains || []).join(', ')), escapeHtml((c.nodes || []).join(', '))]);
    const v = last.causes.vantage;
    parts.push(details(`Candidate causes <span class="nrn-muted">${cs.length ? `${cs.length} ranked — ${escapeHtml(last.causes.note || 'ranked by evidence, not a root-cause verdict')}` : 'none ranked'}${v?.changed ? ' · <em>vantage changed</em>' : ''}</span>`,
      `${tbl(['#', 'kind', 'score', 'evidence', 'chains', 'nodes'], rows)}${v ? `<p class="nrn-muted">vantage: ${v.changed ? `changed — ${escapeHtml(v.detail || `${val(v.from)} → ${val(v.to)}`)}` : 'unchanged since the run before'} (reported beside the causes, never as one)</p>` : ''}`, { open: cs.length > 0 }));
  }

  // Transition since the run before.
  if (last.transition) {
    const t = last.transition;
    const body = t.reason
      ? `<p class="nrn-muted">not compared: ${escapeHtml(t.reason)}${Array.isArray(t.skipped) && t.skipped.length ? ` · skipped ${t.skipped.length} record${t.skipped.length === 1 ? '' : 's'} in between` : ''}</p>`
      : `<p class="nrn-muted">since ${escapeHtml(t.since ? new Date(t.since).toLocaleString() : '?')} · ${t.changed?.length || 0} changed · ${t.appeared?.length || 0} appeared · ${t.disappeared?.length || 0} disappeared</p>${tbl(['chain', 'from', 'to', 'direction', 'newly degraded', 'recovered', 'note'], (t.changed || []).map((c) => [escapeHtml(c.title || c.rootKey || '?'), escapeHtml(`${c.from?.verdict}/${c.from?.ladderVerdict}`), escapeHtml(`${c.to?.verdict}/${c.to?.ladderVerdict}`), escapeHtml(c.direction || ''), escapeHtml((c.nodes?.newlyDegraded || []).join(', ') || '—'), escapeHtml((c.nodes?.recovered || []).join(', ') || '—'), escapeHtml(c.note || '')]))}`;
    parts.push(details(`Transition since the run before <span class="nrn-muted">${t.any ? `changed${t.changed?.some((c) => c.direction === 'worse') ? ' · <em>worse</em>' : ''}` : t.reason ? 'not compared' : 'no change'}</span>`, body, { open: !!t.any }));
  }

  // Gate.
  const breaches = last.breaches || [];
  parts.push(details(`Gate <span class="nrn-muted">${breaches.length ? `${breaches.length} breach${breaches.length === 1 ? '' : 'es'}` : last.outcome === 'vantage-lost' ? 'not evaluated' : 'no breach'}</span>`,
    `${tbl(['criterion', 'detail'], breaches.map((b) => [escapeHtml(b.criterion || '?'), escapeHtml(b.detail || val(b))]))}<p class="nrn-muted">thresholds: ${escapeHtml(gateBits(d.gate))}</p>`, { open: breaches.length > 0 }));

  // Drift, grade, conformance, freshness.
  if (last.drift) {
    parts.push(details('Drift, grade, conformance, freshness', kv([
      ['alignment', `${last.drift.alignmentPct}% — ${last.drift.aligned ?? '?'} aligned · ${last.drift.drifted ?? '?'} drifted · ${last.drift.declaredNotLive ?? '?'} declared-not-live · ${last.drift.liveNotDeclared ?? '?'} live-not-declared${last.drift.outOfScope ? ` · ${last.drift.outOfScope} out of scope` : ''}${last.drift.scaffold ? ` · ${last.drift.scaffold} scaffold` : ''}`],
      ['grade', last.grade ? `${last.grade.score}% (${last.grade.pass ? 'PASS' : 'FAIL'} at ${last.grade.threshold ?? '?'}%)${last.grade.letter ? ` · ${last.grade.letter}${last.grade.letterLabel ? ` ${last.grade.letterLabel}` : ''}` : ''} · schema ${last.grade.schema ?? 1}${last.grade.driftConstruct ? ` · ${last.grade.driftConstruct}` : ''}` : '—'],
      ['traceability', last.traceability ? `${last.traceability.integrityPct}% integrity · ${last.traceability.intact} intact · ${last.traceability.partial} partial · ${last.traceability.broken} broken · ${last.traceability.undeclared} undeclared of ${last.traceability.declaredTotal} declared` : '—'],
      ['conformance', last.conformance ? `${last.conformance.scorePercent}% (MUST ${last.conformance.mustPercent}%) · ${last.conformance.conformant ? 'conformant' : 'not conformant'}${last.conformance.declaredTier ? ` · tier ${last.conformance.declaredTier}` : ''}` : '—'],
      ['live freshness', last.freshness ? `${last.freshness.liveAgeHours ?? '?'} h old${last.freshness.refreshedAt ? ` (refreshed ${new Date(last.freshness.refreshedAt).toLocaleString()})` : ''}` : '—'],
      ['took', last.tookMs !== null ? `${last.tookMs} ms` : '—'],
      ['pack A', last.packA ? `${last.packA.name || '?'} ${last.packA.version || ''} · ${last.packA.source || ''}` : '—'],
      ['pack B', last.packB ? `${last.packB.name || '?'} ${last.packB.version || ''} · ${last.packB.source || ''}` : '—'],
    ])));
  }

  // Stack evidence of the newest record.
  if (last.stackEvidence) {
    const se = last.stackEvidence;
    const rows = se.rows.map((r) => [
      `<code>${escapeHtml(r.id)}</code>`, escapeHtml(r.family || ''), escapeHtml(r.product || ''),
      r.outcome === 'data' && typeof r.value === 'number' ? escapeHtml(`${r.value}${r.unit ? ` ${r.unit}` : ''}`) : '—',
      escapeHtml(r.direction || ''), escapeHtml(r.outcome || ''), r.hint ? `<em>${escapeHtml(r.hint)}</em>` : '', escapeHtml(r.referenceSli || ''), escapeHtml(r.reason || ''),
    ]);
    const am = se.alertmanager, gf = se.grafana;
    parts.push(details(`Stack evidence <span class="nrn-muted">${escapeHtml(se.status || '?')}${se.reason ? ` — ${escapeHtml(se.reason)}` : ''} · ${se.rows.length} row${se.rows.length === 1 ? '' : 's'} · point-in-time, signal not verdict</span>`,
      `${tbl(['row', 'family', 'product', 'value', 'direction', 'outcome', 'hint', 'reference SLI', 'reason'], rows)}
       ${am || gf ? kv([
    ['alertmanager', am ? `${am.version || '?'} · cluster ${am.clusterStatus || '?'} · ${am.silencesActive ?? '?'} active silence${am.silencesActive === 1 ? '' : 's'}${am.error ? ` · error: ${am.error}` : ''}` : undefined],
    ['grafana', gf ? `${gf.datasources ?? '?'} datasources · ${Array.isArray(gf.unhealthyDatasources) ? (gf.unhealthyDatasources.length ? `unhealthy: ${gf.unhealthyDatasources.join(', ')}` : 'none unhealthy') : `${gf.unhealthyDatasources ?? '?'} unhealthy`} · ${gf.contactPoints ?? '?'} contact points${gf.error ? ` · error: ${gf.error}` : ''}` : undefined],
  ]) : ''}`));
  }

  // The vantage itself.
  const v = last.vantage || {};
  if (v.vantage || v.probes || v.toolsExposedCount !== null) {
    parts.push(details(`Vantage <span class="nrn-muted">${escapeHtml(val(v.vantage))}${v.toolsExposedCount !== null ? ` · ${v.toolsExposedCount} tools exposed` : ''}${v.scrapeJobsDown !== null ? ` · ${v.scrapeJobsDown} scrape jobs down` : ''}${v.unhealthyRules !== null ? ` · ${v.unhealthyRules} unhealthy rules` : ''}</span>`,
      kv([
        ['probes', v.probes ? Object.entries(v.probes).map(([k, x]) => `${k}: ${val(x)}`).join(' · ') : '—'],
        ['probe errors', v.probeErrors ? val(v.probeErrors) : '—'],
      ])));
  }

  // Versions.
  if (last.versions) {
    parts.push(details(`Backend versions <span class="nrn-muted">${Object.keys(last.versions).length} reported by Pack B</span>`, kv(Object.entries(last.versions))));
  }

  // Delivery.
  const n = last.notify;
  const nTitle = n === null ? 'no notify: block' : n === undefined ? 'unknown — the record was written before delivery' : `${n.status}${n.httpStatus != null ? ` (${n.httpStatus})` : ''}${n.reason ? ` · ${n.reason}` : ''}`;
  parts.push(details(`Delivery <span class="nrn-muted">${escapeHtml(nTitle)}</span>`, n ? kv([
    ['status', n.status], ['http', n.httpStatus], ['reason', n.reason], ['policy', d.notify?.on || n.policy], ['format', d.notify?.format || n.format],
    ['triggers', Array.isArray(n.triggers) ? n.triggers.join(', ') : n.triggers], ['attempts', n.attempts], ['took', n.tookMs !== undefined ? `${n.tookMs} ms` : undefined], ['url env', n.urlEnv || d.notify?.urlEnv], ['auth env', n.authEnv || d.notify?.authEnv], ['error', n.error],
  ]) : `<p class="nrn-muted">${n === null ? 'Add <code>notify: { urlEnv: MY_WEBHOOK_URL }</code> to the journey file to post transitions to a webhook — the URL and token stay env var names.' : 'A crash between the record write and the delivery write leaves no notify key; the next run tells.'}</p>`));

  // Schedule + snippets (lazy).
  parts.push(details(`Schedule <span class="nrn-muted">${escapeHtml(scheduleText(d.schedule))}${d.stackBudget ? ` · posture budget ${d.stackBudget.objective} over ${escapeHtml(String(d.stackBudget.window))}` : ''}</span>`,
    `<p class="nrn-muted">Scheduling is delegated, not built: nothing fires from the studio. The snippets below install the same <code>packc journey run ${escapeHtml(d.name)}</code> under cron, Windows Task Scheduler, GitHub Actions or a Kubernetes CronJob${d.schedule ? '' : ' — with the placeholder cadence, since this journey declares no <code>schedule:</code>'}.</p><div class="nrn-snippets" data-state="idle"><p class="nrn-muted">opening…</p></div>`,
    { lazy: 'schedule', journey: d.name }));

  if (last.historyError) parts.push(`<p class="journey-load-error">history: ${escapeHtml(last.historyError)}</p>`);

  return `<h4 class="nrn-sub-title">Newest record <span class="nrn-muted">— ${escapeHtml(when)}</span></h4>${parts.join('')}`;
}

function renderWhereElse() {
  return `<div class="nrn-where">
    <strong>The neuron elsewhere.</strong> Diagnose (Can We Trust It?) reads the same requirement chains per node —
    present but unhealthy · present but stale · unobserved — and says <em>blinds N SLOs</em> beside a missing or
    drifted artefact. Fix The Gaps compiles the <em>assurance</em> group (Watchdog + instrument liveness) into every
    rules file and deploys it as its own row. From a shell: <code>packc journey run --all</code> ·
    <code>packc journey schedule &lt;name&gt;</code> · <code>packc journey list</code>.
  </div>`;
}

// ---------- events ----------

function wire(container, { data, ui }, host) {
  const rerender = (patch = {}) => renderNeuron(container, { data, ui: { ...ui, ...patch } }, host);
  const focusOn = (name) => { state.neuronJourney = name; rerender({ focus: name }); };

  container.querySelector('#nrn-window')?.addEventListener('change', (e) => {
    state.neuronWindow = windowOf(e.target.value);
    refreshNeuron(container, host);
  });
  container.querySelector('#nrn-metric')?.addEventListener('change', (e) => {
    state.neuronMetric = e.target.value === 'grade' ? 'grade' : 'alignment';
    rerender({ metric: state.neuronMetric });
  });
  container.querySelector('#nrn-focus')?.addEventListener('change', (e) => focusOn(e.target.value));
  container.querySelectorAll('[data-focus]').forEach((el) => el.addEventListener('click', () => focusOn(el.dataset.focus)));
  container.querySelector('#nrn-refresh')?.addEventListener('click', () => refreshNeuron(container, host));

  container.querySelector('#nrn-run-all')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const names = Object.keys(data.model.perJourney);
    btn.disabled = true;
    let i = 0;
    for (const name of names) {
      i++;
      btn.textContent = `… ${i}/${names.length} ${name}`;
      try {
        const r = await api(`/api/journeys/${enc(name)}/run`, POST);
        const rec = r.record;
        toast(rec.outcome === 'pass' ? `${name}: PASS · alignment ${rec.drift?.alignmentPct}%` : `${name}: ${rec.outcome}`, rec.outcome === 'pass' ? '' : 'error');
      } catch (err) {
        toast(`${name}: ${err.message}`, 'error');
      }
    }
    refreshNeuron(container, host);
  });

  container.querySelectorAll('.nrn-run-focus').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '… running';
    try {
      const r = await api(`/api/journeys/${enc(btn.dataset.journey)}/run`, POST);
      const rec = r.record;
      toast(rec.outcome === 'pass' ? `${btn.dataset.journey}: PASS · alignment ${rec.drift?.alignmentPct}%` : `${btn.dataset.journey}: ${rec.outcome}`, rec.outcome === 'pass' ? '' : 'error');
    } catch (err) {
      toast(`Run failed: ${err.message}`, 'error');
    }
    refreshNeuron(container, host);
  }));

  container.querySelectorAll('details[data-lazy="schedule"]').forEach((det) => det.addEventListener('toggle', async () => {
    const box = det.querySelector('.nrn-snippets');
    if (!det.open || !box || box.dataset.state !== 'idle') return;
    box.dataset.state = 'loading';
    try {
      const r = await api(`/api/journeys/${enc(det.dataset.journey)}/schedule`);
      renderSnippets(box, r);
      box.dataset.state = 'done';
    } catch (err) {
      box.innerHTML = `<p class="refs-error">Couldn't load the snippets: ${escapeHtml(err.message)}</p>`;
      box.dataset.state = 'error';
    }
  }));
}

const SNIPPET_TITLES = { cron: 'cron', schtasks: 'schtasks (Windows Task Scheduler)', actions: 'GitHub Actions', k8s: 'Kubernetes CronJob' };
function renderSnippets(box, r) {
  const formats = Object.keys(r.snippets || {});
  if (!formats.length) { box.innerHTML = '<p class="nrn-muted">no snippets</p>'; return; }
  box.innerHTML = `
    ${r.placeholder ? '<p class="journey-load-error">placeholder cadence — this journey declares no schedule:; edit before installing</p>' : ''}
    ${Array.isArray(r.envNames) && r.envNames.length ? `<p class="nrn-muted">env var names the run needs bound: ${r.envNames.map((n) => `<code>${escapeHtml(n)}</code>`).join(' ')}</p>` : ''}
    <div class="nrn-tabs" role="tablist">${formats.map((f, i) => `<button type="button" class="ctrl-btn nrn-tab${i === 0 ? ' is-active' : ''}" role="tab" data-format="${escapeHtml(f)}" aria-selected="${i === 0}">${escapeHtml(SNIPPET_TITLES[f] || f)}</button>`).join('')}</div>
    ${formats.map((f, i) => `<pre class="nrn-pre" data-format="${escapeHtml(f)}"${i === 0 ? '' : ' hidden'}>${escapeHtml(r.snippets[f])}</pre>`).join('')}`;
  box.querySelectorAll('.nrn-tab').forEach((tab) => tab.addEventListener('click', () => {
    box.querySelectorAll('.nrn-tab').forEach((t) => { t.classList.toggle('is-active', t === tab); t.setAttribute('aria-selected', String(t === tab)); });
    box.querySelectorAll('pre[data-format]').forEach((p) => { p.hidden = p.dataset.format !== tab.dataset.format; });
  }));
}
