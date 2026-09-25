// studio/layers-view.mjs
//
// Discover — the observogram scan dashboard (legacy, unrouted) — plus the
// Discover screen proper (renderLayersView): a decision header, the task
// filters, a layer overview that opens one layer at a time, and the artefact
// rows (renderCard/cardKey, shared with the drawer and compare views).
// Re-renders via the host seam (host.mjs); still imports scan helpers back
// from app.mjs and the drawer opener (safe cycles).

import { state, persistence } from './state.mjs';
import { LAYER_DEFS, L4_SUBGROUPS, DOMAIN_DEFS, DISCO_SLAB_ACCENT, discoGradeLetter, discoGradeWord } from './constants.mjs';
import { focusedConformance } from './focus.mjs';
import { escapeHtml } from './util.mjs';
import { openDrawer } from './drawer.mjs';
import { artefactRowHtml, artefactStatus, matchesTask, inferredFrom, DISCOVER_TASKS } from './card-html.mjs';
import { LENS_PRODUCTS } from './compare-view.mjs';
import { buildSymbolTable, defaultEnvFor, layerArtefactCount, refresh, runBenchmark } from './app.mjs';
import { host as appHost } from './host.mjs';
import { decisionHeaderHtml, wireUxActions, statusChipHtml, emptyStateHtml, LAYER_PURPOSE, plural, announce } from './ux-kit.mjs';

export function renderDiscoverDashboard(view) {
  view.innerHTML = '';
  const pack = state.pack;
  const meta = pack?.meta || {};
  const conf = focusedConformance();
  const sym  = state.symbolTable || buildSymbolTable(pack);

  // ---- reference check (real, from symbol table) ----
  let refTotal = 0, refBroken = 0;
  const brokenLines = [];
  if (sym?.refsFrom) for (const refs of sym.refsFrom.values()) refTotal += refs.length;
  if (sym?.broken) for (const [key, refs] of sym.broken) {
    refBroken += refs.length;
    for (const r of refs) brokenLines.push({ from: key, ref: r });
  }
  const refResolved = Math.max(0, refTotal - refBroken);

  // ---- conformance summary (real) ----
  const scorePct = conf ? conf.scorePercent : 0;
  const grade = discoGradeLetter(scorePct);
  const gradeWord = discoGradeWord(scorePct);
  const mustP  = conf?.must   || { passed: 0, total: 0 };
  const shouldP = conf?.should || { passed: 0, total: 0 };

  // ---- maturity by dimension (real) ----
  // Dimension names come straight from the canonical LAYER_DEFS — the
  // spec layer model, never an invented one.
  const DIM_NAMES = Object.fromEntries(LAYER_DEFS.map(d => [d.id, d.name]));
  const dims = [];
  for (const d of ['L1','L2','L3','L4','L5','GOV']) {
    const s = conf?.byDimension?.[d];
    if (!s) continue;
    const weight = (s.mustTotal || 0) + 0.5 * (s.shouldTotal || 0);
    const got    = (s.mustPassed || 0) + 0.5 * (s.shouldPassed || 0);
    const pct = weight > 0 ? Math.round((got / weight) * 100) : null;
    dims.push({ key: d, name: `${d} ${DIM_NAMES[d] || ''}`.trim(), pct });
  }

  // ---- top issues (real: failing conformance clauses + broken refs) ----
  const issues = [];
  if (conf?.clauses) for (const cl of conf.clauses) {
    if (cl.applies && !cl.pass) {
      issues.push({
        sev: cl.severity === 'MUST' ? 'HIGH' : 'MEDIUM',
        type: cl.severity === 'MUST' ? 'missing' : 'advisory',
        ref: cl.id,
        detail: cl.description,
      });
    }
  }
  for (const b of brokenLines) {
    issues.push({ sev: 'HIGH', type: 'broken_ref', ref: b.from.split('::').pop() || b.from, detail: `${b.ref} not found` });
  }
  const sevRank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  issues.sort((a, b) => (sevRank[a.sev] ?? 9) - (sevRank[b.sev] ?? 9));

  // ---- provenance (real, from annotations) ----
  const ann = meta.annotations || pack?.metadata?.annotations || {};
  const provRows = [];
  const src = pack?.source || (ann['mcp.refreshedAt'] ? 'mcp' : 'file');
  provRows.push(['source', escapeHtml(String(src))]);
  if (ann['mcp.refreshedAt']) provRows.push(['refreshed', escapeHtml(ann['mcp.refreshedAt'])]);
  const pa = (ann['mcp.probesAttempted'] || '').split(',').filter(Boolean).length;
  const ps = (ann['mcp.probesSucceeded'] || '').split(',').filter(Boolean).length;
  if (pa) provRows.push(['probes', `${ps}/${pa} returned data`]);
  const tools = (ann['mcp.toolsCalled'] || '').split(',').filter(Boolean).length;
  if (tools) provRows.push(['mcp tools', `${tools} called`]);
  provRows.push(['validated', conf ? 'schema v1.3 · conformance scored' : 'schema v1.3']);

  // ---- catalog lists (real) ----
  const uploaded = (state.catalog || []).filter(p => p.ok && p.id !== undefined);
  const examples = (state._examplesCache || []).filter(p => p.ok);

  const catRow = (p, withTier) => `
    <button type="button" class="disco-cat-row${p.id === state.selectedPackId ? ' is-active' : ''}" data-pack-id="${escapeHtml(p.id)}" data-is-example="${withTier ? '1' : '0'}">
      <span class="disco-cat-dot" data-ok="${p.ok ? '1' : '0'}"></span>
      <span class="disco-cat-name">${escapeHtml(p.label || p.name || p.id)}</span>
      <span class="disco-cat-tag">${withTier ? escapeHtml(p.criticality || '') : ('v' + escapeHtml(p.version || '?'))}</span>
    </button>
  `;

  // ---- layer index (real artefact counts + ids) ----
  const layerIndex = LAYER_DEFS.map(def => {
    const count = layerArtefactCount(def.id);
    return { id: def.id, name: def.name, count };
  });

  view.innerHTML = `
    <div class="disco">
      <!-- LEFT -->
      <aside class="disco-left">
        <section class="disco-panel">
          <h2 class="disco-panel-title">Pack Overview</h2>
          <dl class="disco-meta">
            <dt>name</dt><dd class="disco-meta-strong">${escapeHtml(meta.name || pack?.id || '—')}</dd>
            <dt>version</dt><dd>${escapeHtml(meta.version || '—')}</dd>
            <dt>apiVersion</dt><dd>${escapeHtml(meta.apiVersion || '—')}</dd>
            <dt>kind</dt><dd>${escapeHtml(meta.kind || '—')}</dd>
            <dt>binding</dt><dd>${escapeHtml(meta.binding || '—')}</dd>
            <dt>target</dt><dd>${escapeHtml(meta.target || '—')}</dd>
            <dt>criticality</dt><dd><span class="disco-tier">${escapeHtml(meta.criticality || '—')}</span></dd>
            <dt>environments</dt><dd>${escapeHtml((meta.environments || []).join(' · ') || '—')}</dd>
            <dt>owners</dt><dd>${escapeHtml((meta.owners || []).join(' · ') || '—')}</dd>
          </dl>
        </section>

        <section class="disco-panel disco-catalog">
          <h2 class="disco-panel-title">Pack Catalog</h2>
          <input type="search" class="disco-cat-search" placeholder="Search packs…" aria-label="Search packs">
          ${uploaded.length ? `<div class="disco-cat-group">Uploaded &amp; drafted</div>${uploaded.map(p => catRow(p, false)).join('')}` : ''}
          ${examples.length ? `<div class="disco-cat-group">Examples (${examples.length})</div>${examples.map(p => catRow(p, true)).join('')}` : ''}
        </section>
      </aside>

      <!-- CENTER -->
      <main class="disco-center">
        <section class="disco-panel disco-scanner-panel">
          <div class="disco-scanner-head">
            <div>
              <div class="disco-scanner-title">OBSERVOGRAM SCAN</div>
              <div class="disco-scanner-sub">layered observability view</div>
            </div>
            <div class="disco-scan-status">
              <span class="disco-scan-status-key">SCAN</span>
              <span class="disco-scan-status-val">COMPLETE</span>
              <span class="disco-scan-status-slice">${layerIndex.reduce((n,l)=>n+l.count,0)} artefacts · ${layerIndex.filter(l=>l.count>0).length}/${layerIndex.length} layers</span>
            </div>
          </div>

          <div class="disco-scanner-stage">
            <img class="disco-scanner-img" src="/assets/observogram-hero.png" alt="Observogram scan"
                 onerror="this.classList.add('is-missing')">
            <div class="disco-scanner-fallback">
              ${LAYER_DEFS.filter(d => d.id !== 'L2X' || layerArtefactCount('L2X') > 0).map(d => {
                const cnt = layerArtefactCount(d.id);
                return `
                  <div class="disco-slab" style="--slab:${DISCO_SLAB_ACCENT[d.id] || '#64748b'}">
                    <span class="disco-slab-id">${escapeHtml(d.num)}</span>
                    <span class="disco-slab-label">${escapeHtml(d.name)}</span>
                    <span class="disco-slab-count">${cnt}</span>
                  </div>`;
              }).join('')}
            </div>
          </div>

          <div class="disco-slice">
            <span class="disco-slice-key">RESOLUTION</span>
            <span class="disco-slice-track"><span class="disco-slice-fill" style="width:21%"></span></span>
            <span class="disco-slice-val">deep slice · canonical v1.3</span>
          </div>
        </section>

        <div class="disco-center-row">
          <section class="disco-panel">
            <h2 class="disco-panel-title">Top Issues <span class="disco-panel-badge">${issues.length}</span></h2>
            ${issues.length ? `
              <table class="disco-issues">
                <thead><tr><th>sev</th><th>type</th><th>reference</th><th>detail</th></tr></thead>
                <tbody>
                  ${issues.slice(0, 8).map(i => `
                    <tr data-sev="${i.sev}">
                      <td class="di-sev">${i.sev}</td>
                      <td class="di-type">${escapeHtml(i.type)}</td>
                      <td class="di-ref">${escapeHtml(i.ref)}</td>
                      <td class="di-detail">${escapeHtml(i.detail)}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
              ${issues.length > 8 ? `<div class="disco-issues-more">+${issues.length - 8} more — see Diagnose</div>` : ''}
            ` : `<div class="disco-empty">No issues found. Pack is clean against its declared tier.</div>`}
          </section>

          <section class="disco-panel">
            <h2 class="disco-panel-title">Scan Provenance</h2>
            <dl class="disco-meta">
              ${provRows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('')}
            </dl>
          </section>
        </div>
      </main>

      <!-- RIGHT -->
      <aside class="disco-right">
        <section class="disco-panel">
          <h2 class="disco-panel-title">Conformance Score</h2>
          <div class="disco-score">
            <div class="disco-score-grade" data-grade="${grade[0]}">
              <div class="disco-score-letter">${grade}</div>
              <div class="disco-score-num">${scorePct} / 100</div>
              <div class="disco-score-word">${gradeWord}</div>
            </div>
            <div class="disco-score-breakdown">
              <div class="disco-score-line"><span>MUST</span><strong>${mustP.passed}/${mustP.total}</strong><span class="disco-score-pct">${mustP.total ? Math.round(mustP.passed/mustP.total*100) : 0}%</span></div>
              <div class="disco-score-line"><span>SHOULD</span><strong>${shouldP.passed}/${shouldP.total}</strong><span class="disco-score-pct">${shouldP.total ? Math.round(shouldP.passed/shouldP.total*100) : 0}%</span></div>
            </div>
          </div>
        </section>

        ${dims.length ? `
        <section class="disco-panel">
          <h2 class="disco-panel-title">Maturity by Dimension</h2>
          <div class="disco-dims">
            ${dims.map(d => `
              <div class="disco-dim">
                <span class="disco-dim-name">${escapeHtml(d.name)}</span>
                <span class="disco-dim-bar"><span class="disco-dim-fill" data-band="${d.pct == null ? 'na' : d.pct >= 80 ? 'hi' : d.pct >= 60 ? 'mid' : 'lo'}" style="width:${d.pct == null ? 0 : d.pct}%"></span></span>
                <span class="disco-dim-pct">${d.pct == null ? 'n/a' : d.pct + '%'}</span>
              </div>`).join('')}
          </div>
        </section>` : ''}

        <section class="disco-panel">
          <h2 class="disco-panel-title">Reference Check</h2>
          <div class="disco-ref-stats">
            <div class="disco-ref-stat"><div class="disco-ref-num">${refTotal}</div><div class="disco-ref-key">total</div></div>
            <div class="disco-ref-stat is-ok"><div class="disco-ref-num">${refResolved}</div><div class="disco-ref-key">resolved</div></div>
            <div class="disco-ref-stat is-bad"><div class="disco-ref-num">${refBroken}</div><div class="disco-ref-key">broken</div></div>
          </div>
          ${brokenLines.length ? `
            <div class="disco-ref-broken-head">Broken references</div>
            <ul class="disco-ref-broken">
              ${brokenLines.slice(0, 5).map(b => `<li><span class="disco-ref-from">${escapeHtml((b.from.split('::').pop() || b.from))}</span> → <span class="disco-ref-to">${escapeHtml(b.ref)}</span></li>`).join('')}
            </ul>
            ${brokenLines.length > 5 ? `<div class="disco-issues-more">+${brokenLines.length - 5} more</div>` : ''}
          ` : `<div class="disco-empty">All references resolve.</div>`}
        </section>

        <section class="disco-panel">
          <h2 class="disco-panel-title">Artefact Sourcing</h2>
          <ul class="disco-legend">
            <li><span class="disco-legend-dot" data-src="declared"></span><span class="disco-legend-name">Declared</span><span class="disco-legend-desc">present in manifest</span></li>
            <li><span class="disco-legend-dot" data-src="verified"></span><span class="disco-legend-name">Verified</span><span class="disco-legend-desc">MCP attested</span></li>
            <li><span class="disco-legend-dot" data-src="missing"></span><span class="disco-legend-name">Missing</span><span class="disco-legend-desc">required, not present</span></li>
          </ul>
        </section>
      </aside>
    </div>
  `;

  // ---- wire catalog clicks → load as Pack A ----
  view.querySelectorAll('.disco-cat-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.packId;
      if (!id || id === state.selectedPackId) return;
      // Ensure the pack is in the catalog (examples live only in cache).
      if (!state.catalog.find(p => p.id === id)) {
        const ex = (state._examplesCache || []).find(p => p.id === id);
        if (ex) state.catalog.push(ex);
      }
      state.selectedPackId = id;
      state.selectedEnv = defaultEnvFor(id);
      refresh();
    });
  });

  // ---- catalog search filter ----
  const search = view.querySelector('.disco-cat-search');
  search?.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    view.querySelectorAll('.disco-cat-row').forEach(row => {
      const name = (row.querySelector('.disco-cat-name')?.textContent || '').toLowerCase();
      row.style.display = !q || name.includes(q) ? '' : 'none';
    });
  });
}

// ============================================================
// DISCOVER — the layer overview (the 2026-09 UX review, docs/UX_SCREEN_GRAMMAR.md)
//
// The screen answers what am I looking at, what needs my attention, and what
// can I do next, before any artefact is listed:
//
//   1. decision header   context (service · environment · pack + version ·
//                        tier), one sentence ("36 of 92 artefacts need
//                        attention across 4 layers"), one primary action,
//                        the causes behind it and a few defined counts
//   2. filters           Show (task filters, one pressed) and Refine (domain
//                        and search), each labelled with what it does
//   3. layer overview    one row per layer: code + plain purpose, the
//                        artefact count, the evidence split, what needs
//                        attention, the rubric checks not met. ONE layer
//                        expands at a time (state.layerFilter; 'all' = none)
//   4. the open layer    a readable list (at most three columns) of rows that
//                        lead with name + what it does + status; ids, tags and
//                        symbols sit in each row's Details, the full record in
//                        the drawer
//
// Counts have one definition each (COUNT_DEF): "artefacts in this layer" is
// every item the adapter projects there, including detail-level evidence; the
// evidence split partitions the same artefacts; "needs attention" is the
// subset a person must act on. Filters never change those counts — the
// "N match" pill and the open layer's "Showing N of M" say what a filter does.
//
// The expanded layer, the task filter, the domain/search refinement and the
// detail toggles live in `state` (persisted); the scroll position is kept per
// pack and restored when the user comes back from Diagnose or Remediate.

const TASK_IDS = new Set(DISCOVER_TASKS.map(t => t.id));
const TASK_BY_ID = Object.fromEntries(DISCOVER_TASKS.map(t => [t.id, t]));
// Rows drawn before "Show all N" in an open layer (a production pack's L2
// metric inventory runs to thousands; the task filters are the real answer).
const ROW_CAP = 60;
// Open layers whose full list the user asked for, per pack.
const shownAll = new Set();

const COUNT_DEF = 'Artefacts in a layer: every item the pack projects onto it, including detail-level evidence (metric inventory, scrape jobs, dashboard panels, recording rules). '
  + 'The evidence split (live evidence found · declared only · template value · missing) divides the same artefacts, so it adds up to the layer total. '
  + 'Needs attention counts the artefacts a person must act on: a template value to complete, a reference that does not resolve, or a required artefact that is missing; each counts once. '
  + 'Required checks are clauses of the tier rubric, not artefacts. Filters never change these counts.';

// What "no artefacts" means on each layer: what the adapter looked for.
const LAYER_CHECKED = {
  L1:  'the pack’s indicators (SLIs) and objectives (SLOs)',
  L2:  'the OpenTelemetry contract, backends, pipelines, storage, and any metric inventory or scrape jobs the scan found',
  L2X: 'profiling, network, policy engine, service mesh and additional collection',
  L3:  'recording rules, derived views, dashboards and their panels',
  L4:  'burn-rate alerts, forecasts, alert routes and self-healing actions',
  L5:  'baselines, chaos experiments and synthetic checks',
  GOV: 'the pack’s imports',
};

// The detail-level artefacts an open layer folds behind its own toggle on
// the broad views (All, Missing evidence) — the per-section Expand model, now
// inside the open layer. The keys are the persisted state flags;
// build-model.mjs isDetailArtefact mirrors this classification.
const DETAIL_BUCKETS = {
  L2: [{ key: 'expandL2', label: 'metric inventory and scrape jobs', test: (a) => !!a.expand,
         tip: 'Detail-level evidence: every metric and scrape job the scan found. Folded by default so the layer’s main artefacts come first.' }],
  L3: [{ key: 'expandL3Panels', label: 'dashboard panels', test: (a) => !!a.tags?.includes('panel'),
         tip: 'One row per dashboard panel. Folded by default so the dashboards themselves come first.' },
       { key: 'expandL3Queries', label: 'recording rules and derived views', test: (a) => !!(a.tags?.includes('recording') || a.tags?.includes('view') || a.tags?.includes('derived')),
         tip: 'The queries behind the dashboards and alerts. Folded by default; an inferred indicator links straight to its rule.' }],
};

function packKey() {
  return `${state.selectedPackId || state.pack?.id || ''}@${state.selectedEnv || ''}`;
}

// Every artefact on a layer with its L4 subgroup (null elsewhere).
function layerEntries(layerId) {
  const layers = state.pack?.layers || {};
  if (layerId === 'L4') {
    const out = [];
    for (const sg of L4_SUBGROUPS) for (const a of (layers.L4?.[sg.key] || [])) out.push({ a, sub: sg.key });
    return out;
  }
  return (layers[layerId] || []).map(a => ({ a, sub: null }));
}

// The whole-pack model the header, the filters and the overview read. Pure
// over state.pack / state.symbolTable / state.conformance; filters do not
// enter it, so its counts are stable.
function discoverModel() {
  const broken = state.symbolTable?.broken;
  const clauses = state.conformance?.clauses || [];
  const failing = clauses.filter(cl => cl.applies && cl.pass === false && cl.severity === 'MUST');
  const layers = [];
  for (const def of LAYER_DEFS) {
    const entries = layerEntries(def.id).map(({ a, sub }) => {
      const key = cardKey(def.id, sub, a.id);
      return { a, sub, key, status: artefactStatus(a, { broken: broken?.get(key)?.length || 0 }) };
    });
    // L2X is optional in the spec: no row when the pack has nothing there.
    if (def.id === 'L2X' && !entries.length) continue;
    const counts = { total: entries.length, live: 0, declared: 0, needsInput: 0, missing: 0, attention: 0, broken: 0 };
    for (const e of entries) {
      if (e.status.live) counts.live++;
      else if (e.status.completion === 'needsInput') counts.needsInput++;
      else if (e.status.evidence === 'missing') counts.missing++;
      else counts.declared++;
      if (e.status.attention) counts.attention++;
      if (e.status.broken) counts.broken++;
    }
    layers.push({ id: def.id, def, entries, counts, rubricFails: failing.filter(cl => cl.dimension === def.id) });
  }
  const sum = (k) => layers.reduce((n, L) => n + L.counts[k], 0);
  const totals = {
    total: sum('total'), live: sum('live'), declared: sum('declared'), needsInput: sum('needsInput'),
    missing: sum('missing'), attention: sum('attention'), broken: sum('broken'),
  };
  const taskCounts = {
    attention: totals.attention, missingEvidence: totals.total - totals.live,
    scaffold: totals.needsInput, live: totals.live, all: totals.total,
  };
  return { layers, totals, taskCounts, rubricFails: failing };
}

// The pressed task filter: the user's choice, else Needs attention when
// anything needs it, else All.
function activeTask(model) {
  const t = state.discoverTask;
  if (t && TASK_IDS.has(t)) return t;
  return model.totals.attention > 0 ? 'attention' : 'all';
}

function refineActive() {
  return !!(state.layersSearch || '').trim() || (!!state.layersDomain && state.layersDomain !== 'all');
}

const matches = (e, layerId, task) => matchesTask(e.status, task) && passesLayersFilter(e.a, layerId);

// ---------- the view ----------

// Layers view — the Discover screen. Keeps its name and signature: app.mjs's
// renderMainView calls it for state.view === 'layers'.
export function renderLayersView(view) {
  const model = discoverModel();
  // A remembered scroll position belongs to one pack; a different pack starts at the top.
  if (state.discoverScroll && state.discoverScroll.pack !== packKey()) state.discoverScroll = null;
  // Arriving on an artefact (Traceability, Conformance or Diagnose set
  // state.activeCardKey, usually with state.layerFilter): its layer opens.
  // A caller's explicit layer wins; with none, the card's own layer opens.
  // Whatever the task filter, the card itself is always listed (fillLayerPanel
  // pins it, marked "outside this filter").
  if (state.activeCardKey && (!state.layerFilter || state.layerFilter === 'all')) {
    const layerId = String(state.activeCardKey).split('/')[0];
    if (model.layers.some(L => L.id === layerId)) {
      state.layerFilter = layerId;
      state.activeLayer = layerId;
    }
  }

  const root = document.createElement('div');
  root.className = 'dv-root';
  root.innerHTML = `
    ${summaryHtml(model)}
    <section class="dv-overview" aria-labelledby="dv-overview-title">
      <div class="dv-overview-head">
        <h2 class="dv-h2" id="dv-overview-title">Layers</h2>
        <p class="dv-overview-sub">Open one layer at a time to see its artefacts.
          <span class="ux-term" tabindex="0" title="${escapeHtml(COUNT_DEF)}">How the counts are defined</span></p>
      </div>
      <div class="dv-filters">
        <div class="dv-filter-row dv-show">
          <span class="dv-filter-key" id="dv-show-key">Show</span>
          <div class="dv-tasks"></div>
        </div>
        <div class="dv-filter-row dv-refine"></div>
      </div>
      <ol class="dv-layers" aria-label="Layers of this pack"></ol>
    </section>`;
  view.appendChild(root);

  const ctx = { root, model };
  renderTasks(ctx);
  renderRefine(ctx);
  renderLayerList(ctx);
  wireUxActions(root, discoverHandlers(ctx));
  wireScrollMemory();

  // Arriving on an artefact (the traceability "open" action sets the layer
  // and the active card): bring its row into view. Otherwise, coming back
  // from Diagnose / Remediate (or any repaint): put the user back where they
  // were in this pack.
  if (typeof requestAnimationFrame !== 'function') return;
  const activeRow = state.activeCardKey ? root.querySelector('.dv-row.is-active') : null;
  const saved = state.discoverScroll;
  if (activeRow) {
    requestAnimationFrame(() => { if (activeRow.isConnected) activeRow.scrollIntoView({ block: 'center' }); });
  } else if (saved && saved.y > 0) {
    requestAnimationFrame(() => {
      if (root.isConnected && Math.abs(window.scrollY - saved.y) > 2) window.scrollTo(0, saved.y);
    });
  }
}

// 1–4 of the screen grammar.
function summaryHtml(model) {
  const meta = state.pack?.meta || {};
  const t = model.totals;
  const withArtefacts = model.layers.filter(L => L.counts.total > 0).length;
  const attnLayers = model.layers.filter(L => L.counts.attention > 0).length;
  const rubricN = model.rubricFails.length;
  const withoutLive = t.total - t.live;
  const evidenceNote = `Evidence is counted separately: ${t.live} with live evidence, ${withoutLive} without.`;
  const rubricNote = rubricN
    ? ` The tier rubric has ${plural(rubricN, 'required check')} not met; the assessment explains ${rubricN === 1 ? 'it' : 'them'}.`
    : '';

  let decision, note, tone, primary, secondary = [], causes = [];
  if (!t.total) {
    decision = 'This pack has no artefacts yet.';
    note = `Checked every layer, L1 Contract to GOV Governance.${rubricNote}`;
    tone = 'info';
    primary = { id: 'dv-assess', label: 'Open the assessment', action: 'dv-assess' };
  } else if (t.attention) {
    decision = `${t.attention} of ${plural(t.total, 'artefact')} ${t.attention === 1 ? 'needs' : 'need'} attention across ${plural(attnLayers, 'layer')}.`;
    note = `Needs attention means a template value still to complete, a reference that does not resolve, or a required artefact that is missing. ${evidenceNote}${rubricNote}`;
    tone = 'warn';
    primary = { id: 'dv-review', label: 'Review what needs attention', action: 'dv-review' };
    secondary = [{ id: 'dv-assess', label: 'Open the assessment', action: 'dv-assess' }];
    const c = [];
    if (t.needsInput) c.push({ n: t.needsInput, tone: 'warn', actionId: 'dv-show-scaffold',
      title: `${plural(t.needsInput, 'template value')} to complete`,
      why: 'Generated from a template so the requirement is represented; a person must supply the real value.' });
    if (t.broken) c.push({ n: t.broken, tone: 'fail', actionId: 'dv-show-broken',
      title: `${plural(t.broken, 'artefact')} with unresolved references`,
      why: 'Each names something this pack does not define, so the chain between them is broken.' });
    if (t.missing) c.push({ n: t.missing, tone: 'fail', actionId: 'dv-show-missing',
      title: `${plural(t.missing, 'required artefact')} missing`,
      why: 'Required, and neither declared nor observed.' });
    causes = c.sort((x, y) => y.n - x.n).slice(0, 3).map(x => ({ ...x, actionLabel: 'Show them' }));
  } else {
    decision = `None of the ${plural(t.total, 'artefact')} across ${plural(withArtefacts, 'layer')} needs attention.`;
    note = `Every template value is filled in and every reference resolves. ${evidenceNote}${rubricNote}`;
    tone = rubricN ? 'info' : 'ok';
    primary = { id: 'dv-assess', label: 'Open the assessment', action: 'dv-assess' };
  }

  const measures = t.total ? [
    { label: 'Artefacts', value: String(t.total), note: `across ${plural(withArtefacts, 'layer')}`, title: COUNT_DEF },
    { label: 'Live evidence found', value: String(t.live), tone: t.live ? 'ok' : 'neutral',
      title: 'The live platform reported these signals when the pack was drafted or refreshed.' },
    { label: 'Declared only', value: String(t.declared),
      title: 'Declared in the pack or repository; no live evidence was checked or found.' },
    { label: 'Template values to complete', value: String(t.needsInput), tone: t.needsInput ? 'warn' : 'neutral',
      title: 'Generated from a template so the requirement is represented; a person must supply the real value.' },
    ...(t.missing ? [{ label: 'Missing', value: String(t.missing), tone: 'fail', title: 'Required, and neither declared nor observed.' }] : []),
  ] : [];

  return decisionHeaderHtml({
    id: 'dv-summary',
    eyebrow: 'Discover · What do we have?',
    context: [
      { key: 'Service', value: meta.service || state.selectedService || '' },
      { key: 'Environment', value: state.selectedEnv || meta.environment || '' },
      { key: 'Pack', value: [meta.name || state.pack?.id || '', meta.version ? `v${meta.version}` : ''].filter(Boolean).join(' ') },
      { key: 'Tier', value: meta.criticality || '' },
    ],
    decision, note, tone, primary, secondary, causes, measures,
  });
}

// ---------- Show: the task filters ----------

function renderTasks(ctx) {
  const task = activeTask(ctx.model);
  const counts = ctx.model.taskCounts;
  ctx.root.querySelector('.dv-tasks').innerHTML = `
    <div class="ux-segmented" role="group" aria-labelledby="dv-show-key">
      ${DISCOVER_TASKS.map(t => `
        <button type="button" data-ux-action="dv-task" data-task="${t.id}" data-dv-focus="task-${t.id}"
          aria-pressed="${t.id === task}" title="${escapeHtml(t.tip)}"
          aria-label="${escapeHtml(`${t.label}: ${plural(counts[t.id], 'artefact')}`)}">${escapeHtml(t.label)}<span class="ux-seg-count" aria-hidden="true">${counts[t.id]}</span></button>`).join('')}
    </div>`;
}

// ---------- Refine: domain + search ----------

function renderRefine(ctx) {
  const wrap = ctx.root.querySelector('.dv-refine');
  // DOMAIN facet — the fixed four-bucket taxonomy; offered only when 2+
  // domains are actually present.
  const domCounts = new Map();
  for (const { a, layerId } of layerArtefactsWithLayer()) {
    const d = artefactDomain(a, layerId);
    domCounts.set(d, (domCounts.get(d) || 0) + 1);
  }
  const domOptions = DOMAIN_DEFS.filter(d => domCounts.has(d.id));
  // A previously-selected domain that no longer exists (pack switch) falls
  // back to 'all' so we never filter everything out invisibly.
  if (state.layersDomain && state.layersDomain !== 'all' && !domCounts.has(state.layersDomain)) state.layersDomain = 'all';

  wrap.innerHTML = `
    <span class="dv-filter-key" id="dv-refine-key">Refine</span>
    ${domOptions.length >= 2 ? `
      <label class="dv-refine-domain">
        <span class="dv-refine-label">Domain</span>
        <select class="dv-refine-select" aria-describedby="dv-refine-hint">
          <option value="all">All domains</option>
          ${domOptions.map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.label)} (${domCounts.get(d.id)})</option>`).join('')}
        </select>
      </label>` : ''}
    <label class="dv-refine-search">
      <span class="sr-text">Search artefacts</span>
      <input type="search" class="dv-refine-input" placeholder="Search names, IDs, tags…" aria-describedby="dv-refine-hint">
    </label>
    <button type="button" class="ux-link-btn dv-refine-clear" data-ux-action="dv-clear-refine"${refineActive() ? '' : ' hidden'}>Clear refinement</button>
    <span class="dv-refine-hint" id="dv-refine-hint">Narrows the list inside the open layer. The counts on each layer stay whole-pack; “match” shows what the filters leave.</span>`;

  const sel = wrap.querySelector('.dv-refine-select');
  if (sel) {
    sel.value = state.layersDomain || 'all';
    sel.addEventListener('change', () => { state.layersDomain = sel.value; afterRefine(ctx); });
  }
  const input = wrap.querySelector('.dv-refine-input');
  input.value = state.layersSearch || '';
  input.addEventListener('input', () => { state.layersSearch = input.value; afterRefine(ctx); });
}

function afterRefine(ctx) {
  persistence.schedule();
  const clear = ctx.root.querySelector('.dv-refine-clear');
  if (clear) clear.hidden = !refineActive();
  // Only the list repaints, so the search box keeps focus and caret.
  renderLayerList(ctx);
}

// ---------- the layer overview ----------

function renderLayerList(ctx) {
  const task = activeTask(ctx.model);
  const list = ctx.root.querySelector('.dv-layers');
  list.innerHTML = ctx.model.layers.map(L => layerItemHtml(L, task, state.layerFilter === L.id)).join('');
  const open = ctx.model.layers.find(L => L.id === state.layerFilter);
  if (open) fillLayerPanel(ctx, open, task);
}

function layerItemHtml(L, task, open) {
  const p = LAYER_PURPOSE[L.id] || { name: L.def.name, question: '' };
  const c = L.counts;
  const s = (n) => (n === 1 ? '' : 's');
  const evidence = [
    c.live ? statusChipHtml('evidence', 'live', { label: `${c.live} live evidence` }) : '',
    c.declared ? statusChipHtml('evidence', 'declared', { label: `${c.declared} declared only` }) : '',
    c.needsInput ? statusChipHtml('completion', 'needsInput', { label: `${c.needsInput} template value${s(c.needsInput)}` }) : '',
    c.missing ? statusChipHtml('evidence', 'missing', { label: `${c.missing} missing` }) : '',
  ].filter(Boolean).join(' ');
  const attention = c.attention
    ? `<span class="dv-attn" title="${escapeHtml(TASK_BY_ID.attention.tip)}">${c.attention} need${c.attention === 1 ? 's' : ''} attention</span>`
    : (c.total ? '<span class="dv-calm">Nothing needs attention</span>' : '');
  const rubric = L.rubricFails.length
    ? statusChipHtml('assessment', 'fail', {
        label: `${L.rubricFails.length} required check${s(L.rubricFails.length)} not met`,
        extraTip: 'Clauses of the tier rubric for this layer: checks on the pack, not artefacts. The assessment lists them.' })
    : '';
  // The filter's effect on this layer, only when a filter narrows beyond the
  // counts already shown (Needs attention has its own count above).
  const narrowing = (task !== 'all' && task !== 'attention') || refineActive();
  const matchN = narrowing ? L.entries.filter(e => matches(e, L.id, task)).length : 0;
  const matchTip = `Artefacts in this layer that match Show: ${TASK_BY_ID[task].label}${refineActive() ? ' and the refinement' : ''}.`;

  return `
    <li class="dv-layer${open ? ' is-open' : ''}${c.total ? '' : ' is-empty'}" id="dv-layer-${L.id}" data-layer="${L.id}">
      <div class="dv-layer-head" data-ux-action="dv-toggle" data-layer="${L.id}">
        <h3 class="dv-layer-h">
          <button type="button" class="dv-layer-toggle" id="dv-toggle-${L.id}" data-dv-focus="toggle-${L.id}"
            aria-expanded="${open}" aria-controls="dv-panel-${L.id}">
            <span class="dv-layer-code">${escapeHtml(L.id)}</span>
            <span class="dv-layer-title"><span class="dv-layer-name">${escapeHtml(p.name)}</span>${p.question ? ` <span class="dv-layer-q">· ${escapeHtml(p.question)}</span>` : ''}</span>
          </button>
        </h3>
        <div class="dv-layer-stats">
          <span class="dv-count" title="${escapeHtml(COUNT_DEF)}">${c.total ? `${plural(c.total, 'artefact')} in this layer` : 'No artefacts in this layer'}</span>
          ${evidence} ${attention} ${rubric}
        </div>
        ${narrowing ? `<span class="dv-match" title="${escapeHtml(matchTip)}">${matchN} match</span>` : '<span class="dv-match-slot" aria-hidden="true"></span>'}
        <span class="dv-chevron" aria-hidden="true"></span>
      </div>
      <div class="dv-panel" id="dv-panel-${L.id}" role="region" aria-labelledby="dv-toggle-${L.id}"${open ? '' : ' hidden'}></div>
    </li>`;
}

// The open layer: its purpose, what the filters leave, the detail toggles,
// and the rows (L4 grouped by subgroup).
function fillLayerPanel(ctx, L, task) {
  const panel = ctx.root.querySelector(`#dv-panel-${L.id}`);
  if (!panel) return;
  const p = LAYER_PURPOSE[L.id] || { name: L.def.name, blurb: '' };
  const searching = !!(state.layersSearch || '').trim();
  const refining = refineActive();

  const byTask = L.entries.filter(e => matchesTask(e.status, task));
  const matched = byTask.filter(e => passesLayersFilter(e.a, L.id));
  // Detail buckets fold behind their toggle only on the broad views (All,
  // Missing evidence) and never under a search: a narrow filter (Needs
  // attention, a template value, live evidence) or a search never hides its
  // own matches — the row cap handles the volume instead.
  const foldable = !searching && (task === 'all' || task === 'missingEvidence');
  const buckets = (DETAIL_BUCKETS[L.id] || [])
    .map(b => ({ ...b, items: matched.filter(e => b.test(e.a)) }))
    .filter(b => b.items.length);
  const folded = new Set();
  if (foldable) for (const b of buckets) if (!state[b.key]) for (const e of b.items) folded.add(e);
  let visible = matched.filter(e => !folded.has(e));

  // The artefact open in the drawer stays listed (and marked) even when the
  // filter would hide it, so the highlight and the scroll-to always land.
  const active = state.activeCardKey ? L.entries.find(e => isActiveKey(e.key, L.id, e.a.id)) : null;
  const pinned = active && !visible.includes(active) ? active : null;
  if (pinned) {
    const keep = new Set(visible).add(pinned);
    visible = L.entries.filter(e => keep.has(e));
  }

  const capKey = `${packKey()}|${L.id}`;
  const capped = !shownAll.has(capKey) && visible.length > ROW_CAP;
  let rows = capped ? visible.slice(0, ROW_CAP) : visible;
  if (capped && active && visible.includes(active) && !rows.includes(active)) rows = [...rows, active];

  const shownPhrase = [
    `Showing ${rows.length} of ${plural(L.counts.total, 'artefact')} in ${L.id}`,
    task !== 'all' ? `Show: ${TASK_BY_ID[task].label}` : '',
    refining ? 'refined' : '',
    folded.size ? `${folded.size} detail-level folded` : '',
  ].filter(Boolean).join(' · ');

  const toggles = !foldable ? '' : buckets.map(b => {
    const on = !!state[b.key];
    return `<button type="button" class="dv-detail-toggle" data-ux-action="dv-detail" data-key="${b.key}" data-dv-focus="detail-${b.key}"
      aria-pressed="${on}" title="${escapeHtml(b.tip)}">${on ? 'Fold' : 'Include'} ${escapeHtml(b.label)} <span class="dv-detail-count">${b.items.length}</span></button>`;
  }).join('');

  const rubric = L.rubricFails.length ? `
    <div class="dv-panel-rubric">
      <span>${statusChipHtml('assessment', 'fail', { label: `${L.rubricFails.length} required check${L.rubricFails.length === 1 ? '' : 's'} not met` })}</span>
      <span class="dv-panel-rubric-text">${escapeHtml(L.rubricFails[0].description || L.rubricFails[0].id)}${L.rubricFails.length > 1 ? ` (and ${L.rubricFails.length - 1} more)` : ''}</span>
      <button type="button" class="ux-link-btn" data-ux-action="dv-assess">Open the assessment →</button>
    </div>` : '';

  panel.innerHTML = `
    ${p.blurb ? `<p class="dv-panel-intro">${escapeHtml(p.blurb)}</p>` : ''}
    ${rubric}
    ${L.counts.total ? `
    <div class="dv-panel-bar">
      <p class="dv-panel-count">${escapeHtml(shownPhrase)}</p>
      ${toggles ? `<div class="dv-detail-toggles" role="group" aria-label="Detail-level artefacts">${toggles}</div>` : ''}
    </div>` : ''}
    <div class="dv-panel-body"></div>
    ${capped ? `<button type="button" class="ux-secondary-btn dv-show-all" data-ux-action="dv-show-all" data-layer="${L.id}" data-dv-focus="show-all-${L.id}">Show all ${visible.length} artefacts</button>` : ''}`;

  const body = panel.querySelector('.dv-panel-body');
  if (!rows.length) {
    body.innerHTML = layerEmptyHtml(L, task, { byTask, matched, folded, buckets });
    return;
  }
  const rowEl = (e) => renderCard(e.a, L.def, e.sub, { outsideFilter: e === pinned });
  if (L.id === 'L4') {
    for (const sg of L4_SUBGROUPS) {
      const sgRows = rows.filter(e => e.sub === sg.key);
      const declared = L.entries.some(e => e.sub === sg.key);
      if (!sgRows.length && (declared || task !== 'all' || refining)) continue;
      const h = document.createElement('h4');
      h.className = 'dv-subgroup';
      h.textContent = `${sg.label}${sgRows.length ? ` · ${sgRows.length}` : ''}`;
      body.appendChild(h);
      if (!sgRows.length) {
        const none = document.createElement('p');
        none.className = 'dv-subgroup-none';
        none.textContent = `No ${sg.label.toLowerCase()} artefacts declared.`;
        body.appendChild(none);
        continue;
      }
      body.appendChild(rowList(sgRows.map(rowEl)));
    }
  } else {
    body.appendChild(rowList(rows.map(rowEl)));
  }
}

function rowList(els) {
  const list = document.createElement('div');
  list.className = 'dv-rows';
  list.setAttribute('role', 'list');
  for (const el of els) list.appendChild(el);
  return list;
}

// An open layer with nothing to list says what was checked and offers the
// next step — never a bare "no results".
function layerEmptyHtml(L, task, { byTask, matched, folded, buckets }) {
  const p = LAYER_PURPOSE[L.id] || { name: L.def.name };
  const where = `${L.id} ${p.name}`;
  if (!L.counts.total) {
    return emptyStateHtml({
      title: `No artefacts on ${where}`,
      checked: LAYER_CHECKED[L.id] || 'this layer of the pack',
      body: L.rubricFails.length ? `The tier rubric expects ${plural(L.rubricFails.length, 'required check')} here that the pack does not meet yet.` : '',
      actions: L.rubricFails.length ? [{ action: 'dv-assess', label: 'Open the assessment' }] : [],
    });
  }
  if (matched.length && folded.size === matched.length) {
    const b = buckets.find(x => !state[x.key]) || buckets[0];
    return `
      <div class="ux-empty ux-tone-neutral" role="note">
        <p class="ux-empty-title">Only detail-level artefacts match here</p>
        <p class="ux-empty-body">${escapeHtml(`${plural(folded.size, 'artefact')} ${folded.size === 1 ? 'is' : 'are'} folded (${buckets.map(x => x.label).join(', ')}).`)}</p>
        <div class="ux-empty-actions"><button type="button" class="ux-secondary-btn" data-ux-action="dv-detail" data-key="${b.key}">Include ${escapeHtml(b.label)}</button></div>
      </div>`;
  }
  if (byTask.length && !matched.length) {
    return emptyStateHtml({
      title: `Nothing in ${where} matches the refinement`,
      checked: `${plural(byTask.length, 'artefact')} that match Show: ${TASK_BY_ID[task].label}`,
      actions: [{ action: 'dv-clear-refine', label: 'Clear refinement' }],
    });
  }
  const all = { action: 'dv-task-all', label: `Show all ${plural(L.counts.total, 'artefact')}` };
  const checked = `${plural(L.counts.total, 'artefact')} in this layer`;
  switch (task) {
    case 'attention':
      return emptyStateHtml({ tone: 'ok', title: `Nothing in ${where} needs attention`, checked: `${checked}: template values, references and required artefacts`, actions: [all] });
    case 'missingEvidence':
      return emptyStateHtml({ tone: 'ok', title: `Every artefact in ${where} has live evidence`, checked, actions: [all] });
    case 'scaffold':
      return emptyStateHtml({ tone: 'ok', title: `No template values to complete in ${where}`, checked, actions: [all] });
    case 'live':
      return emptyStateHtml({
        title: `No live evidence for ${where} yet`, checked,
        body: 'Live evidence comes from drafting or refreshing the pack from a live MCP server (Actions menu). Declared artefacts are not wrong; nothing live has confirmed them.',
        actions: [all],
      });
    default:
      return emptyStateHtml({ title: `Nothing to list on ${where}`, checked });
  }
}

// ---------- actions ----------

function discoverHandlers(ctx) {
  return {
    'dv-task': (_ev, el) => setTask(ctx, el.dataset.task),
    'dv-task-all': () => setTask(ctx, 'all'),
    'dv-toggle': (_ev, el) => toggleLayer(ctx, el.dataset.layer),
    'dv-detail': (_ev, el) => {
      const key = el.dataset.key;
      if (!key) return;
      state[key] = !state[key];
      persistence.schedule();
      repaintList(ctx, `detail-${key}`);
    },
    'dv-show-all': (_ev, el) => {
      shownAll.add(`${packKey()}|${el.dataset.layer}`);
      repaintList(ctx);
    },
    'dv-clear-refine': () => {
      state.layersSearch = '';
      state.layersDomain = 'all';
      persistence.schedule();
      renderRefine(ctx);
      renderLayerList(ctx);
      ctx.root.querySelector('.dv-refine-input')?.focus();
      announce('Refinement cleared.');
    },
    'dv-review':        () => focusTask(ctx, 'attention', L => L.counts.attention > 0),
    'dv-show-scaffold': () => focusTask(ctx, 'scaffold',  L => L.counts.needsInput > 0),
    'dv-show-broken':   () => focusTask(ctx, 'attention', L => L.counts.broken > 0),
    'dv-show-missing':  () => focusTask(ctx, 'attention', L => L.counts.missing > 0),
    'dv-assess': () => goToAssessment(),
  };
}

// Repaint the overview, keeping the element the user acted on where it was
// on screen (a layer collapsing above must not throw the page) and focused.
function repaintList(ctx, focusKey = null) {
  const sel = focusKey ? `[data-dv-focus="${focusKey}"]` : null;
  const before = sel ? ctx.root.querySelector(sel)?.getBoundingClientRect?.().top : null;
  renderLayerList(ctx);
  if (!sel) return;
  const el = ctx.root.querySelector(sel);
  if (!el) return;
  if (before != null) {
    const drift = el.getBoundingClientRect().top - before;
    if (Math.abs(drift) > 1) window.scrollBy(0, drift);
  }
  el.focus({ preventScroll: true });
}

function setTask(ctx, task) {
  if (!TASK_IDS.has(task)) return;
  state.discoverTask = task;
  persistence.schedule();
  renderTasks(ctx);
  renderLayerList(ctx);
  ctx.root.querySelector(`[data-dv-focus="task-${task}"]`)?.focus({ preventScroll: true });
  announce(`Show: ${TASK_BY_ID[task].label}. ${plural(ctx.model.taskCounts[task], 'artefact')} across the pack.`);
}

function toggleLayer(ctx, layerId) {
  if (!layerId) return;
  const opening = state.layerFilter !== layerId;
  state.layerFilter = opening ? layerId : 'all';
  // Mirror to the legacy activeLayer, as the old layer chips did.
  state.activeLayer = opening ? layerId : 'L1';
  persistence.schedule();
  repaintList(ctx, `toggle-${layerId}`);
  const L = ctx.model.layers.find(x => x.id === layerId);
  const p = LAYER_PURPOSE[layerId];
  announce(opening
    ? `${layerId} ${p?.name || ''} opened: ${ctx.root.querySelector(`#dv-panel-${layerId} .dv-panel-count`)?.textContent || plural(L?.counts.total || 0, 'artefact')}.`
    : `${layerId} ${p?.name || ''} closed.`);
}

// A header action: press a task filter, open the first layer it concerns and
// bring that layer to the top of the screen.
function focusTask(ctx, task, pick) {
  state.discoverTask = task;
  const L = ctx.model.layers.find(pick);
  if (L) { state.layerFilter = L.id; state.activeLayer = L.id; }
  persistence.schedule();
  renderTasks(ctx);
  renderLayerList(ctx);
  if (!L) return;
  const item = ctx.root.querySelector(`#dv-layer-${L.id}`);
  item?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  ctx.root.querySelector(`#dv-toggle-${L.id}`)?.focus({ preventScroll: true });
  announce(`${TASK_BY_ID[task].label}: ${L.id} ${LAYER_PURPOSE[L.id]?.name || ''} opened.`);
}

// Discover → Diagnose (the assessment). Through the chrome's Diagnose tab
// when it is there, so the route runs exactly as a tab click does (the
// working context bar shows the baseline on comparison screens); the host
// seam otherwise. The Discover scroll position is already remembered, and
// coming back restores it.
function goToAssessment() {
  state.diagnoseSub = 'grade';
  const tab = document.querySelector('.observa-tab[data-view="compare"]');
  if (tab) {
    tab.click();
  } else {
    state.view = 'compare';
    state.activeCardKey = null;
    appHost.renderTabs();
    appHost.renderMainView();
  }
  window.scrollTo({ top: 0 });
}

// Remember where the user is on Discover, per pack, while Discover is showing.
let scrollMemoryWired = false;
function wireScrollMemory() {
  if (scrollMemoryWired || typeof window === 'undefined') return;
  scrollMemoryWired = true;
  let queued = false;
  window.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (state.view !== 'layers' || !document.querySelector('#layer-view .dv-root')) return;
      state.discoverScroll = { pack: packKey(), y: window.scrollY };
    });
  }, { passive: true });
}

// Domain classifier — maps an artefact (plus the layer it lives on) into one
// of the four DOMAIN_DEFS buckets. Layer is the strongest signal; tags refine
// it. Deterministic, with Application as the catch-all.
function artefactDomain(a, layerId) {
  const tags = (a.tags || []).map(t => String(t).toLowerCase());
  const has = (...t) => t.some(x => tags.includes(x));
  // User Experience — synthetic / canary / blackbox / RUM probes that stand
  // in for a real user. L5 Validation is the home layer for these.
  if (layerId === 'L5' || has('synthetic', 'canary', 'blackbox', 'probe', 'rum', 'e2e')) {
    return 'ux';
  }
  // Infrastructure — the telemetry plumbing & storage that physically carries
  // signal: backends, exporters, receivers, processors, scrape jobs, the
  // discovered metric inventory. L2 / L2X are the home layers.
  if (layerId === 'L2' || layerId === 'L2X' ||
      has('backend', 'exporter', 'receiver', 'processor', 'storage',
          'metric', 'collector', 'scrape')) {
    return 'infrastructure';
  }
  // Platform — cross-cutting operability: alerting, policy, recording rules,
  // pipelines, self-healing, governance. L4 Action & GOV are the home layers.
  if (layerId === 'L4' || layerId === 'GOV' ||
      has('alert', 'burn-rate', 'policy', 'recording', 'pipeline',
          'route', 'governance', 'healing')) {
    return 'platform';
  }
  // Application — the service's own contract & insight: SLIs, SLOs, dashboards,
  // panels. The catch-all (L1 / L3).
  return 'application';
}

// Every artefact across the loaded pack's layers, tagged with its layer id
// (L4 is grouped). Used to populate the DOMAIN filter and apply it.
function layerArtefactsWithLayer() {
  const out = [];
  const layers = state.pack?.layers || {};
  for (const def of LAYER_DEFS) {
    if (def.id === 'L4') {
      const l4 = layers.L4 || {};
      for (const sg of L4_SUBGROUPS) for (const a of (l4[sg.key] || [])) out.push({ a, layerId: 'L4' });
    } else {
      for (const a of (layers[def.id] || [])) out.push({ a, layerId: def.id });
    }
  }
  return out;
}

// Discover content filter predicate — DOMAIN dropdown + search box. layerId
// lets the domain classifier use the artefact's home layer.
function passesLayersFilter(a, layerId) {
  const dom = state.layersDomain || 'all';
  if (dom !== 'all' && artefactDomain(a, layerId) !== dom) return false;
  const q = (state.layersSearch || '').trim().toLowerCase();
  if (q) {
    const hay = [a.id, a.title, a.desc, a.tool, ...(a.tags || [])]
      .filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function cardKey(layerId, sublayerKey, id) {
  return sublayerKey ? `${layerId}/${sublayerKey}/${id}` : `${layerId}/${id}`;
}

// Is this artefact the one open in the drawer? A caller that jumps in may
// name an L4 artefact without its subgroup ('L4/POL-01' for
// 'L4/policy/POL-01'), so both spellings count.
function isActiveKey(key, layerId, id) {
  const k = state.activeCardKey;
  return !!k && (k === key || k === `${layerId}/${id}`);
}

// The recording rule an inferred indicator was read from (L3 QRY-NN, titled
// by the rule's name).
function findRecordingRule(name) {
  return (state.pack?.layers?.L3 || []).find(a => /^QRY-/.test(a.id || '') && (a.title === name || a.spec?.name === name)) || null;
}

// One Discover row. The body is card-html.mjs artefactRowHtml; this wraps it
// in the element that keeps the card contract the drawer relies on (`.card`,
// data-key, is-active, has-broken-refs, is-scaffold) and owns the clicks:
// the row (or its name button) opens the drawer, as a card did; the
// "Inferred from recording rule" link opens that rule; the Benchmark CTA
// runs the benchmark; Details expands in place.
export function renderCard(artefact, def, sublayerKey, { outsideFilter = false } = {}) {
  const layerDef = LAYER_DEFS.find(d => d.id === def?.id) || def;
  const row = document.createElement('div');
  row.className = 'card dv-row';
  row.setAttribute('role', 'listitem');
  const key = cardKey(layerDef.id, sublayerKey, artefact.id);
  row.dataset.key = key;
  if (isActiveKey(key, layerDef.id, artefact.id)) row.classList.add('is-active');
  const broken = state.symbolTable?.broken?.get(key)?.length || 0;
  if (broken) row.classList.add('has-broken-refs');
  // A Scaffold artefact (a crawler stub, a library placeholder) is parked,
  // not declared: dashed, as the Build stack draws it.
  if (artefact.source === 'Scaffold') row.classList.add('is-scaffold');
  if (outsideFilter) row.classList.add('is-outside-filter');

  // Benchmark CTA — when this backend's `product` matches a catalogue
  // reference pack (grafana, prometheus, kafka), one click loads the
  // reference as Pack B and applies the product lens: "how does my X
  // compare to best practice?"
  const backendProduct = artefact.spec?.product || artefact.product || null;
  const refMatch = backendProduct
    ? LENS_PRODUCTS.find(lp => lp.slug === String(backendProduct).toLowerCase())
    : null;
  const benchmark = refMatch && /^BAK-/.test(artefact.id)
    ? { slug: refMatch.slug, refPackId: refMatch.refPackId, label: refMatch.label }
    : null;

  const inference = inferredFrom(artefact);
  const rules = inference ? inference.rules.map(name => ({ name, found: !!findRecordingRule(name) })) : null;

  row.innerHTML = artefactRowHtml(artefact, { broken, benchmark, rules, outsideFilter });
  row.addEventListener('click', (ev) => {
    const t = ev.target;
    const cta = t.closest?.('.benchmark-cta');
    if (cta) {
      ev.preventDefault();
      ev.stopPropagation();
      runBenchmark(cta.dataset.product, cta.dataset.refPack);
      return;
    }
    const ruleBtn = t.closest?.('[data-dv-rule]');
    if (ruleBtn) {
      ev.stopPropagation();
      const rule = findRecordingRule(ruleBtn.dataset.dvRule);
      if (rule) openDrawer(rule, LAYER_DEFS.find(d => d.id === 'L3'), undefined);
      return;
    }
    // Details expands in place; anything else interactive keeps its own job.
    if (t.closest?.('details, a, input, select, textarea, [data-ux-action]')) return;
    openDrawer(artefact, layerDef, sublayerKey);
  });
  return row;
}
