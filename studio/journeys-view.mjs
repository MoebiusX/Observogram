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

// tools/lib/stack-evidence.mjs — the browser-safe history helpers over the
// run records (step 3). The server exposes tools/lib at /lib (the same
// path app.mjs loads the crawler from), so it is imported at call time by
// URL, never statically: the module graph stays linkable headless and a
// failed load degrades to "no chips", never to a broken view.
let _stackLib = null;
async function stackEvidenceLib() {
  if (!_stackLib) _stackLib = await import('/lib/stack-evidence.mjs');
  return _stackLib;
}

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
  'pass':         { icon: '✅', cls: 'is-pass' },
  'gate-failed':  { icon: '❌', cls: 'is-fail' },
  // The live source did not answer at all — no verdict, recorded so the
  // loss shows up in the history instead of leaving a gap.
  'vantage-lost': { icon: '⚠️', cls: 'is-lost' },
};

function outcomeLabel(last) {
  if (last.outcome === 'vantage-lost') return `${last.outcome} · live source unreachable`;
  return `${last.outcome} · alignment ${last.alignmentPct}% · grade ${last.gradeScore}%`;
}

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
  let stackLib = null;
  await Promise.all([
    ...journeys.map(async j => {
      try { runsByName[j.name] = (await api(`/api/journeys/${encodeURIComponent(j.name)}/runs?limit=20`)).runs; }
      catch (_) { runsByName[j.name] = []; }
    }),
    (async () => { try { stackLib = await stackEvidenceLib(); } catch { stackLib = null; } })(),
  ]);

  host.innerHTML = journeys.map(j => {
    const runs = runsByName[j.name] || [];
    const series = runs.slice().reverse().map(r => r.drift?.alignmentPct);
    const last = j.lastRun;
    const om = last ? (OUTCOME_META[last.outcome] || { icon: '·', cls: '' }) : null;
    // gate.stack is a nested block (requireSampled / rows) — print it as JSON, not [object Object].
    const gateBits = Object.entries(j.gate || {}).map(([k, v]) => `${k}=${v && typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') || 'no gate';
    return `
      <article class="journey-card" data-journey="${escapeHtml(j.name)}">
        <div class="journey-card-head">
          <span class="journey-name">${escapeHtml(j.name)}</span>
          ${last ? `<span class="journey-outcome ${om.cls}">${om.icon} ${escapeHtml(outcomeLabel(last))}</span>`
                 : '<span class="journey-outcome">never run</span>'}
          ${journeySparkline(series)}
          <button type="button" class="ctrl-btn journey-run-btn" data-journey="${escapeHtml(j.name)}">▶ run now</button>
        </div>
        <div class="journey-card-meta">
          <span title="Pack A source">A: <code>${escapeHtml(j.packA || '?')}</code></span>
          <span title="Pack B source">B: <code>${escapeHtml(j.packB || '?')}</code></span>
          <span title="Gate">gate: ${escapeHtml(gateBits)}</span>
        </div>
        ${j.loadError ? `<div class="journey-card-meta"><span class="journey-load-error" title="loadJourneyDef">definition does not load: ${escapeHtml(j.loadError)}</span></div>` : ''}
        ${renderStackChips(last?.stack ?? null, runs, stackLib)}
        ${renderChainsLine(last)}
        ${renderCauseLine(last)}
        <div class="journey-runs">${renderRunsTable(runs)}</div>
        <div class="journey-result" hidden></div>
      </article>`;
  }).join('');

  host.querySelectorAll('.journey-run-btn').forEach(btn => {
    btn.onclick = () => runJourneyNow(btn.dataset.journey, host, btn);
  });
}

// Stack self-metric chips — the samples the last run saw, one chip per
// family present. Every chip is a point-in-time SIGNAL: no ok/err colour,
// the 'nonzero' hint is a muted marker, and a row that did not answer
// says which honest non-answer it gave. For lower-is-comfortable rows the
// fetched history adds "nonzero in N of last M runs" (M = runs that
// carried a sample for that row). `lastStack` is GET /api/journeys'
// lastRun.stack (null when the last run has no evidence); with the helper
// module loaded the families are recomputed from the newest fetched run
// with the same function the server uses, so both read alike.
function renderStackChips(lastStack, runs, lib) {
  // The newest run only: an older run's evidence must never stand in for a
  // last run that carried none (vantage lost, file-sourced B).
  const newest = runs[0]?.stackEvidence ? runs[0] : null;
  const families = lib && newest ? lib.latestByFamily(newest) : (lastStack?.families || null);
  const status = newest?.stackEvidence?.status || lastStack?.status || null;
  if (!status) return '';
  const label = '<span class="journey-stack-label">stack self-metrics — point-in-time samples:</span>';
  if (status === 'not-attempted') {
    const reason = newest?.stackEvidence?.reason || lastStack?.reason || 'no reason recorded';
    return `<div class="journey-stack">${label}
      <span class="journey-stack-chip is-muted" title="mcp.stack.status = not-attempted">not attempted — ${escapeHtml(reason)}</span></div>`;
  }
  const entries = Object.entries(families || {});
  if (!entries.length) {
    return `<div class="journey-stack">${label}
      <span class="journey-stack-chip is-muted">sampled, but no row answered</span></div>`;
  }
  const fmt = (v, u) => (lib ? lib.formatStackValue(v, u) : (typeof v === 'number' ? String(v) : '—'));
  const outcomeText = (o) => (lib ? lib.stackOutcomeLabel(o) : String(o ?? 'unknown'));
  const chips = entries.map(([family, row]) => {
    const title = `${row.id}${row.referenceSli ? ` · reference SLI ${row.referenceSli}` : ''}${row.reason ? ` · ${row.reason}` : ''}`;
    const fam = `<span class="journey-stack-family">${escapeHtml(family)}</span>`;
    if (row.outcome !== 'data' || typeof row.value !== 'number') {
      return `<span class="journey-stack-chip is-muted" title="${escapeHtml(title)}">${fam} ${escapeHtml(outcomeText(row.outcome))}</span>`;
    }
    const mark = row.hint === 'nonzero' ? ' <span class="journey-stack-mark">nonzero</span>' : '';
    let history = '';
    if (lib && row.direction === 'lower') {
      const series = lib.stackSeries(runs, row.id);
      if (series.length) history = ` <span class="journey-stack-runs">· nonzero in ${lib.nonzeroRuns(series)} of last ${series.length} runs</span>`;
    }
    return `<span class="journey-stack-chip" title="${escapeHtml(title)}">${fam} ${escapeHtml(fmt(row.value, row.unit))}${mark}${history}</span>`;
  }).join('');
  return `<div class="journey-stack">${label}${chips}</div>`;
}

// Requirement chains of the last run (step 4) — one plain-text line from
// GET /api/journeys' lastRun.chains (chainSummary over the record) and
// lastRun.transition. Counts, not colours: the ladder buckets are on-wire
// liveness beside the scored verdict, `unobserved` means the vantage could
// not look, and "changed since previous run" is a transition between two
// observations — a muted marker, never a cause. Nothing when the last run
// carries no chains.
function renderChainsLine(last) {
  const c = last?.chains;
  if (!c || typeof c !== 'object') return '';
  const l = c.ladder || {};
  const bits = [
    `requirement chains: ${c.intact ?? 0}/${c.declaredTotal ?? 0} intact`,
    `ladder: ${l.healthy ?? 0} healthy · ${l.degraded ?? 0} degraded · ${l.broken ?? 0} broken · ${l.unobserved ?? 0} unobserved`,
  ];
  if (c.topExposure && typeof c.topExposure === 'object') {
    const t = c.topExposure;
    bits.push(`top exposure: ${t.label} (${t.kind}) blinds ${t.slos} SLO${t.slos === 1 ? '' : 's'}`);
  }
  const tr = last.transition;
  const mark = tr && tr.any
    ? ` <span class="journey-stack-mark">changed since previous run (${tr.worse ?? 0} worse)</span>`
    : '';
  return `<div class="journey-stack journey-chains"><span class="journey-stack-label">${escapeHtml(bits.join(' · '))}</span>${mark}</div>`;
}

// The rank-1 candidate cause of the last run (step 4) from GET
// /api/journeys' lastRun.topCause — one muted line, worded as what it is:
// a candidate ranked by evidence, not a verdict. A vantage change
// (lastRun.vantageChanged) is a muted marker beside it, never a cause.
// Nothing when the last run carries neither.
function renderCauseLine(last) {
  const top = last?.topCause && typeof last.topCause === 'object' ? last.topCause : null;
  const vantage = last?.vantageChanged === true;
  if (!top && !vantage) return '';
  const cause = top
    ? `<span class="journey-stack-label">candidate cause: [${escapeHtml(String(top.kind ?? '?'))}] ${escapeHtml(String(top.evidence ?? ''))} — not a verdict</span>`
    : '';
  const mark = vantage ? `${top ? ' ' : ''}<span class="journey-stack-mark">vantage changed</span>` : '';
  return `<div class="journey-stack journey-cause">${cause}${mark}</div>`;
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
      <td>${r.outcome === 'vantage-lost' ? escapeHtml(`vantage lost: ${r.error || 'unreachable'}`)
            : r.gate?.breaches?.length ? escapeHtml(r.gate.breaches.map(b => b.criterion).join(', ')) : '—'}</td>
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
    // A live source that did not answer still left a vantage-lost record.
    loadJourneysList(listHost);
  }
}
