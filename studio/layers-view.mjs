// studio/layers-view.mjs
//
// Discover — the observogram scan dashboard — plus the layered Discover view
// it drills into: the per-layer sections, the Expand toggles, the domain/
// search filters, and the artefact cards (renderCard/cardKey, shared with the
// drawer and compare views). Re-renders via the host seam (host.mjs); still
// imports scan helpers back from app.mjs and the drawer opener (safe cycles).

import { state, $, $$, persistence } from './state.mjs';
import { LAYER_DEFS, L4_SUBGROUPS, DOMAIN_DEFS, DISCO_SLAB_ACCENT, discoGradeLetter, discoGradeWord } from './constants.mjs';
import { effectiveFocus, focusedPack, focusedConformance } from './focus.mjs';
import { escapeHtml, toast } from './util.mjs';
import { openDrawer } from './drawer.mjs';
import { LENS_PRODUCTS } from './compare-view.mjs';
import { buildSymbolTable, defaultEnvFor, layerArtefactCount, renderLayerFilterChips, refresh, runBenchmark } from './app.mjs';
import { host as appHost } from './host.mjs';

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
  provRows.push(['validated', conf ? 'schema v1.2 · conformance scored' : 'schema v1.2']);

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
            <span class="disco-slice-val">deep slice · canonical v1.2</span>
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

// Layers view — stacks every layer when filter='all', narrows to one
// otherwise. Replaces the old per-layer-tab navigation.
export function renderLayersView(view) {
  // The Discover layers view is a toolbar (resolution knob + filters) over
  // a body of layer sections. Toolbar and body are separate containers so
  // typing in the search box re-renders only the sections — the input keeps
  // focus and the slider keeps its thumb position.
  const body = document.createElement('div');
  body.className = 'layers-body';
  const rerender = () => { persistence.schedule(); renderLayersBody(body); };
  view.appendChild(renderLayersToolbar(rerender));
  view.appendChild(body);
  renderLayersBody(body);
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

// Toolbar for the Discover layers view: resolution knob, DOMAIN filter
// (only when 2+ domains exist), and a search box. `rerender` rebuilds just
// the sections body so inputs keep focus.
function renderLayersToolbar(rerender) {
  const wrap = document.createElement('div');
  wrap.className = 'layers-toolbar';

  // --- Layer chips (All · L1 · L2 · … · GOV) ---
  // Primitive but indispensable on a 1500-artefact production pack: one
  // click jumps the whole view to a single layer. Clicking a chip mutates
  // state.layerFilter then re-renders the entire Discover view (renderTabs +
  // renderMainView) so the active chip + sections update together.
  wrap.appendChild(renderLayerFilterChips());

  // --- Controls row: resolution knob · DOMAIN · search ---
  const controls = document.createElement('div');
  controls.className = 'layers-controls';

  // Detail-level is controlled per-section now (the Expand toggles in each
  // L2 / L3 section header), not by a global knob — so the controls row
  // carries just the DOMAIN facet and search.

  // DOMAIN filter — fixed four-bucket taxonomy. Count artefacts per domain
  // and only offer the dropdown when 2+ domains are actually present.
  const domCounts = new Map();
  for (const { a, layerId } of layerArtefactsWithLayer()) {
    const d = artefactDomain(a, layerId);
    domCounts.set(d, (domCounts.get(d) || 0) + 1);
  }
  const domOptions = DOMAIN_DEFS.filter(d => domCounts.has(d.id));
  if (domOptions.length >= 2) {
    // A previously-selected domain that no longer exists (pack switch) falls
    // back to 'all' so we never filter everything out invisibly.
    if (state.layersDomain !== 'all' && !domCounts.has(state.layersDomain)) {
      state.layersDomain = 'all';
    }
    const cur = state.layersDomain || 'all';
    const dwrap = document.createElement('label');
    dwrap.className = 'layers-domain';
    dwrap.innerHTML = `<span class="layers-filter-key">DOMAIN</span>`;
    const sel = document.createElement('select');
    sel.className = 'layers-domain-select';
    sel.innerHTML = `<option value="all">all</option>`
      + domOptions.map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.label)} (${domCounts.get(d.id)})</option>`).join('');
    sel.value = cur;
    sel.onchange = () => { state.layersDomain = sel.value; rerender(); };
    dwrap.appendChild(sel);
    controls.appendChild(dwrap);
  }

  // Search
  const swrap = document.createElement('div');
  swrap.className = 'layers-search';
  const sin = document.createElement('input');
  sin.type = 'search';
  sin.className = 'layers-search-input';
  sin.placeholder = 'Search artefacts…';
  sin.setAttribute('aria-label', 'Search artefacts');
  sin.value = state.layersSearch || '';
  sin.addEventListener('input', () => { state.layersSearch = sin.value; rerender(); });
  swrap.appendChild(sin);
  controls.appendChild(swrap);

  wrap.appendChild(controls);
  return wrap;
}

function renderLayersBody(body) {
  body.innerHTML = '';
  const filter = state.layerFilter || 'all';
  const layersToShow = (filter === 'all')
    ? LAYER_DEFS
    : LAYER_DEFS.filter(d => d.id === filter);

  let rendered = 0;
  for (const def of layersToShow) {
    // Skip L2X if empty (it's optional per spec v1.2).
    if (def.id === 'L2X' && layerArtefactCount('L2X') === 0) continue;
    if (def.id === 'L4') {
      renderLayer4(body);
    } else {
      const items = state.pack.layers[def.id] || [];
      body.appendChild(renderSection(def, items));
    }
    rendered++;
  }
  if (rendered === 0) {
    body.innerHTML = '<div class="placeholder">No artefacts on this layer.</div>';
  }
}

// Detail-level artefacts a section hides by default behind its own Expand
// toggle(s) — the prototype's per-section model. L2 hides the discovered
// metric inventory and live scrape evidence behind one toggle. L3 hides
// dashboard panels and queries behind
// their own toggles, leaving just the dashboards. Classified by tag so no
// adapter change is needed.
function expandBucketsFor(def, filtered) {
  if (def.id === 'L2') {
    const evidence = filtered.filter(a => a.expand);
    return evidence.length
      ? [{ key: 'expandL2', label: 'Evidence', items: evidence,
           title: `Toggle discovered metric inventory and scrape evidence — ${evidence.length} live evidence artefact${evidence.length === 1 ? '' : 's'}` }]
      : [];
  }
  if (def.id === 'L3') {
    const panels  = filtered.filter(a => a.tags?.includes('panel'));
    const queries = filtered.filter(a => a.tags?.includes('recording') || a.tags?.includes('view') || a.tags?.includes('derived'));
    const out = [];
    if (panels.length)  out.push({ key: 'expandL3Panels',  label: 'Panels',  items: panels,
      title: `Toggle dashboard panels — ${panels.length} panel binding${panels.length === 1 ? '' : 's'}` });
    if (queries.length) out.push({ key: 'expandL3Queries', label: 'Queries', items: queries,
      title: `Toggle queries — ${queries.length} recording rule${queries.length === 1 ? '' : 's'} / derived view${queries.length === 1 ? '' : 's'}` });
    return out;
  }
  return [];
}

function renderSection(def, items, opts = {}) {
  const section = document.createElement('section');
  section.className = 'section';
  section.dataset.layer = def.id;

  // Apply the Discover content filters (DOMAIN + search) first so counts and
  // the Expand toggles operate on the filtered set.
  const filtered = items.filter(a => passesLayersFilter(a, def.id));
  const searching = !!(state.layersSearch || '').trim();

  const buckets = expandBucketsFor(def, filtered);
  // Hide items whose bucket toggle is off — unless a search is active, which
  // forces everything open so matches are never hidden.
  const hidden = new Set();
  if (!searching) {
    for (const b of buckets) if (!state[b.key]) for (const a of b.items) hidden.add(a);
  }
  const visible = filtered.filter(a => !hidden.has(a));
  const expandTotal = buckets.reduce((n, b) => n + b.items.length, 0);

  const head = document.createElement('div');
  head.className = 'section-head';
  const countLabel = expandTotal
    ? `${visible.length} of ${filtered.length} artefact${filtered.length === 1 ? '' : 's'}`
    : `${filtered.length} artefact${filtered.length === 1 ? '' : 's'}`;
  head.innerHTML = `
    <span class="section-num">${def.num}</span>
    <span class="section-name">${escapeHtml(opts.subtitle || def.name)}</span>
    <span class="section-count">${countLabel}</span>
  `;
  // Per-bucket Expand toggles. Suppressed while searching (everything's open).
  if (!searching) {
    for (const b of buckets) {
      const on = !!state[b.key];
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'section-expand-toggle' + (on ? ' is-on' : '');
      toggle.title = b.title;
      toggle.innerHTML = `<span class="section-expand-glyph" aria-hidden="true">${on ? '⊟' : '⊞'}</span> ${on ? 'Hide' : 'Expand'} ${escapeHtml(b.label)} <span class="section-expand-count">${b.items.length}</span>`;
      toggle.onclick = () => { state[b.key] = !state[b.key]; persistence.schedule(); appHost.renderMainView(); };
      head.appendChild(toggle);
    }
  }
  section.appendChild(head);

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = (searching || (state.layersDomain && state.layersDomain !== 'all'))
      ? 'no artefacts match the current filter'
      : (expandTotal ? 'collapsed — click Expand to reveal' : 'no artefacts declared in this section');
    section.appendChild(empty);
    return section;
  }

  const grid = document.createElement('div');
  grid.className = 'section-grid';
  for (const a of visible) grid.appendChild(renderCard(a, def, opts.sublayerKey));
  section.appendChild(grid);
  return section;
}

function renderLayer4(view) {
  const head = document.createElement('div');
  head.className = 'section';
  head.dataset.layer = 'L4';
  // Count L4 after applying the Discover content filters so the header
  // matches the (filtered) subgroups below it.
  const l4Count = L4_SUBGROUPS.reduce(
    (n, sg) => n + (state.pack.layers.L4?.[sg.key] || []).filter(a => passesLayersFilter(a, 'L4')).length, 0);
  head.innerHTML = `
    <div class="section-head">
      <span class="section-num">L4</span>
      <span class="section-name">Action — policy · alerting · self-healing</span>
      <span class="section-count">${l4Count} artefact${l4Count === 1 ? '' : 's'}</span>
    </div>
  `;
  view.appendChild(head);

  for (const sg of L4_SUBGROUPS) {
    const items = (state.pack.layers.L4?.[sg.key] || []).filter(a => passesLayersFilter(a, 'L4'));
    const wrapper = document.createElement('div');
    wrapper.className = 'subgroup';
    const h = document.createElement('h4');
    h.className = 'subgroup-head';
    h.textContent = `L4.${sg.key} · ${sg.label}`;
    wrapper.appendChild(h);

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = `no ${sg.label.toLowerCase()} declared`;
      wrapper.appendChild(empty);
    } else {
      const grid = document.createElement('div');
      grid.className = 'section-grid section-grid-l4';
      for (const a of items) grid.appendChild(renderCard(a, { id: 'L4' }, sg.key));
      wrapper.appendChild(grid);
    }
    view.appendChild(wrapper);
  }
}

export function cardKey(layerId, sublayerKey, id) {
  return sublayerKey ? `${layerId}/${sublayerKey}/${id}` : `${layerId}/${id}`;
}

export function renderCard(artefact, def, sublayerKey) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card';
  const key = cardKey(def.id, sublayerKey, artefact.id);
  btn.dataset.key = key;
  if (state.activeCardKey === key) btn.classList.add('is-active');
  if (state.symbolTable?.broken?.has(key)) btn.classList.add('has-broken-refs');

  const tags = (artefact.tags || []).slice(0, 4).map(t =>
    `<span class="tag">${escapeHtml(t)}</span>`).join('');

  // Version-gating chip for backend artefacts.
  let gatingChip = '';
  if (/^BAK-/.test(artefact.id) && artefact.spec?.version?.gating) {
    const g = artefact.spec.version.gating;
    gatingChip = `<span class="gating-chip" data-gating="${escapeHtml(g)}" title="version: ${escapeHtml(artefact.spec.version.declared || '?')} · gating: ${escapeHtml(g)}">${escapeHtml(g)}</span>`;
  }

  const brokenIndicator = state.symbolTable?.broken?.has(key)
    ? `<span class="ref-indicator" title="${state.symbolTable.broken.get(key).length} unresolved reference(s)">⚠</span>`
    : '';

  // Benchmark CTA — when this backend's `product` matches a catalogue
  // reference pack (grafana, prometheus, kafka), surface a small action
  // that loads the reference as Pack B and applies the product lens.
  // This is the discovery affordance for the user journey: from any
  // backend card, one click → "how does my X compare to best practice?"
  let benchmarkCta = '';
  const backendProduct = artefact.spec?.product || artefact.product || null;
  const refMatch = backendProduct
    ? LENS_PRODUCTS.find(lp => lp.slug === backendProduct.toLowerCase())
    : null;
  if (refMatch && /^BAK-/.test(artefact.id)) {
    benchmarkCta = `<button type="button" class="benchmark-cta"
      data-product="${escapeHtml(refMatch.slug)}"
      data-ref-pack="${escapeHtml(refMatch.refPackId)}"
      title="Compare your ${escapeHtml(refMatch.label)} posture against the catalogue reference pack."
    >⛯ Benchmark vs ${escapeHtml(refMatch.label)} →</button>`;
  }

  btn.innerHTML = `
    <div class="card-head">
      <span class="card-id">${escapeHtml(artefact.id)}</span>
      ${brokenIndicator}
      ${gatingChip}
      <span class="card-source" data-source="${escapeHtml(artefact.source || 'Declared')}">${escapeHtml(artefact.source || 'Declared')}</span>
    </div>
    <div class="card-title">${escapeHtml(artefact.title || artefact.id)}</div>
    ${artefact.desc ? `<div class="card-desc">${escapeHtml(artefact.desc)}</div>` : ''}
    <div class="card-foot">
      ${artefact.tool ? `<span class="tool">${escapeHtml(artefact.tool)}</span>` : ''}
      ${tags}
      ${benchmarkCta}
    </div>
  `;
  btn.onclick = (ev) => {
    // The Benchmark CTA lives inside the card button. Intercept clicks
    // on it so the drawer doesn't open.
    const cta = ev.target.closest('.benchmark-cta');
    if (cta) {
      ev.preventDefault();
      ev.stopPropagation();
      runBenchmark(cta.dataset.product, cta.dataset.refPack);
      return;
    }
    openDrawer(artefact, def, sublayerKey);
  };
  return btn;
}

// Drive the benchmark action — load the reference pack as Pack B,
// apply the product lens, switch to Compare. Centralised so the
// Backend CTA and the (future) Benchmark view CTA both use it.
