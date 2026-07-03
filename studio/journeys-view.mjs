// studio/journeys-view.mjs
//
// The Journeys view (Advanced) — VALUE_BACKLOG item 11, studio surface.
// Lists every saved journey with its definition summary, last outcome,
// an alignment-over-time sparkline (the drift series the runner has been
// accumulating), a run-now action, and expandable run history. Plus the
// capture affordance: freeze the current A/B comparison as a journey.
//
// The re-render entrypoint comes through the studio host seam (host.mjs);
// all host bindings are call-time only.

import { state } from './state.mjs';
import { api } from './api.mjs';
import { escapeHtml, toast } from './util.mjs';
import { host as appHost } from './host.mjs';

// Tiny inline SVG sparkline over alignment % (0–100). Oldest → newest,
// left → right. Pure presentation; returns '' below two points.
export function journeySparkline(values, { w = 120, h = 28 } = {}) {
  const pts = (values || []).filter(v => Number.isFinite(v));
  if (pts.length < 2) return '';
  const min = 0, max = 100;
  const step = w / (pts.length - 1);
  const y = v => h - 2 - ((v - min) / (max - min)) * (h - 4);
  const poly = pts.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" class="journey-spark" aria-label="alignment trend ${pts.join('%, ')}%">
    <polyline points="${poly}" fill="none" stroke="var(--ok, #16a34a)" stroke-width="1.5"/>
    <circle cx="${((pts.length - 1) * step).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.2" fill="var(--ok, #16a34a)"/>
  </svg>`;
}

const OUTCOME_META = {
  'pass':        { icon: '✅', cls: 'is-pass' },
  'gate-failed': { icon: '❌', cls: 'is-fail' },
};

export function renderJourneysView(view) {
  const section = document.createElement('section');
  section.className = 'section journeys-view';
  section.dataset.layer = 'JRN';
  section.innerHTML = `
    <div class="refs-head">
      <h2 class="refs-title">Saved Journeys</h2>
      <p class="refs-sub">Repeatable, gated drift checks. Each run appends to the
        workspace history — the sparkline is alignment over time. Run them here, or
        schedule the same check externally: <code>packc journey run &lt;name&gt;</code>
        exits 0 (pass) · 1 (gate failed) · 2 (error).</p>
    </div>
    <div class="journeys-capture" id="journeys-capture"></div>
    <div class="journeys-list" id="journeys-list"><div class="refs-empty">Loading journeys…</div></div>
  `;
  view.appendChild(section);
  renderCaptureBar(section.querySelector('#journeys-capture'));
  loadJourneysList(section.querySelector('#journeys-list'));
}

// "Save this comparison as a journey" — enabled when the session holds an
// A/B pair; the server resolves both to durable sources.
function renderCaptureBar(host) {
  if (!host) return;
  const ready = !!(state.selectedPackId && state.compareBId);
  if (!ready) {
    host.innerHTML = `<p class="refs-note">Load Pack A and Pack B (Discover → compare) to enable
      <strong>save this comparison as a journey</strong>.</p>`;
    return;
  }
  host.innerHTML = `
    <div class="journeys-capture-bar">
      <input type="text" id="journey-capture-name" class="layers-search-input" placeholder="journey name (e.g. repo-vs-live)"
             aria-label="New journey name">
      <button type="button" class="ctrl-btn" id="journey-capture-btn"
        title="Freeze the current Pack A vs Pack B comparison (and its env/service scope) as a repeatable journey">
        ⛶ Save this comparison as a journey</button>
    </div>`;
  host.querySelector('#journey-capture-btn').onclick = async () => {
    const name = host.querySelector('#journey-capture-name').value.trim();
    if (!name) { toast('Give the journey a name first', 'error'); return; }
    try {
      const r = await api('/api/journeys/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          name,
          packAId: state.selectedPackId,
          packBId: state.compareBId,
          env: state.selectedEnv || undefined,
          service: state.selectedService || undefined,
          scopeMode: state.diffScopeMode || undefined,
        }),
      });
      toast(`Journey "${r.name}" saved — runnable here or via packc`);
      appHost.renderMainView();
    } catch (e) {
      toast(`Capture failed: ${e.message}`, 'error');
    }
  };
}

async function loadJourneysList(host) {
  if (!host) return;
  let journeys = [];
  try {
    ({ journeys } = await api('/api/journeys'));
  } catch (e) {
    host.innerHTML = `<div class="refs-empty refs-error">Couldn't load journeys: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!journeys.length) {
    host.innerHTML = `<div class="refs-empty">No journeys saved yet. Capture one above, or add
      <code>.observogram/journeys/&lt;name&gt;.journey.yaml</code> by hand.</div>`;
    return;
  }
  // Fetch each journey's recent runs for the sparkline (small N, parallel).
  const runsByName = {};
  await Promise.all(journeys.map(async j => {
    try { runsByName[j.name] = (await api(`/api/journeys/${encodeURIComponent(j.name)}/runs?limit=20`)).runs; }
    catch (_) { runsByName[j.name] = []; }
  }));

  host.innerHTML = journeys.map(j => {
    const runs = runsByName[j.name] || [];
    const series = runs.slice().reverse().map(r => r.drift?.alignmentPct);
    const last = j.lastRun;
    const om = last ? (OUTCOME_META[last.outcome] || { icon: '·', cls: '' }) : null;
    const gateBits = Object.entries(j.gate || {}).map(([k, v]) => `${k}=${v}`).join(' · ') || 'no gate';
    return `
      <article class="journey-card" data-journey="${escapeHtml(j.name)}">
        <div class="journey-card-head">
          <span class="journey-name">${escapeHtml(j.name)}</span>
          ${last ? `<span class="journey-outcome ${om.cls}">${om.icon} ${escapeHtml(last.outcome)} · alignment ${last.alignmentPct}% · grade ${last.gradeScore}%</span>`
                 : '<span class="journey-outcome">never run</span>'}
          ${journeySparkline(series)}
          <button type="button" class="ctrl-btn journey-run-btn" data-journey="${escapeHtml(j.name)}">▶ run now</button>
        </div>
        <div class="journey-card-meta">
          <span title="Pack A source">A: <code>${escapeHtml(j.packA || '?')}</code></span>
          <span title="Pack B source">B: <code>${escapeHtml(j.packB || '?')}</code></span>
          <span title="Gate">gate: ${escapeHtml(gateBits)}</span>
        </div>
        <div class="journey-runs">${renderRunsTable(runs)}</div>
        <div class="journey-result" hidden></div>
      </article>`;
  }).join('');

  host.querySelectorAll('.journey-run-btn').forEach(btn => {
    btn.onclick = () => runJourneyNow(btn.dataset.journey, host, btn);
  });
}

function renderRunsTable(runs) {
  if (!runs.length) return '';
  const rows = runs.slice(0, 8).map(r => {
    const om = OUTCOME_META[r.outcome] || { icon: '·' };
    return `<tr>
      <td>${om.icon}</td>
      <td>${escapeHtml(new Date(r.startedAt).toLocaleString())}</td>
      <td>${r.drift?.alignmentPct ?? '?'}%</td>
      <td>${r.grade?.score ?? '?'}%</td>
      <td>${r.gate?.breaches?.length ? escapeHtml(r.gate.breaches.map(b => b.criterion).join(', ')) : '—'}</td>
      <td>${r.tookMs ?? '?'} ms</td>
    </tr>`;
  }).join('');
  return `<table class="deploy-result-table journey-runs-table">
    <thead><tr><th></th><th>When</th><th>Align</th><th>Grade</th><th>Breaches</th><th>Took</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

async function runJourneyNow(name, listHost, btn) {
  const card = listHost.querySelector(`.journey-card[data-journey="${CSS.escape(name)}"]`);
  const resultEl = card?.querySelector('.journey-result');
  btn.disabled = true;
  btn.textContent = '… running';
  try {
    const r = await api(`/api/journeys/${encodeURIComponent(name)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
    });
    const rec = r.record;
    toast(rec.outcome === 'pass'
      ? `${name}: PASS · alignment ${rec.drift.alignmentPct}%`
      : `${name}: gate failed (${rec.gate.breaches.length} breach${rec.gate.breaches.length === 1 ? '' : 'es'})`,
      rec.outcome === 'pass' ? '' : 'error');
    if (resultEl) {
      resultEl.hidden = false;
      resultEl.innerHTML = `<pre class="journey-result-pre">${escapeHtml(JSON.stringify({
        outcome: rec.outcome, grade: rec.grade, drift: rec.drift, freshness: rec.freshness, breaches: rec.gate.breaches,
      }, null, 2))}</pre>`;
    }
    // Refresh the whole list so the sparkline + history pick up the run.
    loadJourneysList(listHost);
  } catch (e) {
    toast(`Run failed: ${e.message}`, 'error');
    btn.disabled = false;
    btn.textContent = '▶ run now';
  }
}
