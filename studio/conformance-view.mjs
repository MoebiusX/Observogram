// studio/conformance-view.mjs
//
// The Conformance view — how MATURE is the focused pack against the v1.3
// maturity rubric (MUST/SHOULD per tier): a headline scorecard, a per-
// dimension grid, and the full clause list. Self-contained; returns the
// rendered <section> for the caller to append.

import { state } from './state.mjs';
import { effectiveFocus, focusedConformance, focusedPack } from './focus.mjs';
import { escapeHtml } from './util.mjs';

export function renderConformanceView() {
  const wrap = document.createElement('section');
  wrap.className = 'section conformance-view';
  wrap.dataset.layer = 'CONF';
  wrap.dataset.focus = effectiveFocus();

  const c = focusedConformance();
  const pk = focusedPack();
  if (!c) {
    wrap.innerHTML = '<div class="placeholder">conformance report unavailable</div>';
    return wrap;
  }

  const head = document.createElement('div');
  head.className = 'section-head';
  const focusBadge = state.packB ? ` · pack ${effectiveFocus().toUpperCase()} (${escapeHtml(pk?.id || '')})` : '';
  head.innerHTML = `
    <span class="section-num">CONF</span>
    <span class="section-name">Maturity rubric · ${escapeHtml(c.declaredTier)}${focusBadge}</span>
    <span class="section-count">${c.scorePercent}% overall · ${c.mustPercent}% MUST</span>
  `;
  wrap.appendChild(head);

  const headline = document.createElement('div');
  headline.className = 'conf-headline ' + (c.conformant ? 'is-pass' : 'is-fail');
  headline.innerHTML = `
    <div class="conf-meta">
      <div class="conf-stat">
        <div class="conf-stat-key">Conformant</div>
        <div class="conf-stat-val">${c.conformant ? 'yes' : 'no'}</div>
      </div>
      <div class="conf-stat">
        <div class="conf-stat-key">MUST passed</div>
        <div class="conf-stat-val">${c.must.passed} / ${c.must.total}</div>
      </div>
      <div class="conf-stat">
        <div class="conf-stat-key">SHOULD passed</div>
        <div class="conf-stat-val">${c.should.passed} / ${c.should.total}</div>
      </div>
      <div class="conf-stat">
        <div class="conf-stat-key">Combined score</div>
        <div class="conf-stat-val">${c.scorePercent}%</div>
      </div>
    </div>
    <div class="conf-note">Scored against <a href="https://github.com/MoebiusX/otel-observability-pack/blob/98be4ae8c05899c066b9882e0498feb850afa387/docs/maturity-model.md" target="_blank" rel="noopener">maturity rubric</a>; MUST = 1, SHOULD = 0.5.</div>
  `;
  wrap.appendChild(headline);

  const dimGrid = document.createElement('div');
  dimGrid.className = 'conf-dim-grid';
  for (const dim of ['L1', 'L2', 'L3', 'L4', 'L5']) {
    const stats = c.byDimension[dim] || { applicable: 0, mustPassed: 0, mustTotal: 0, shouldPassed: 0, shouldTotal: 0 };
    const ok = stats.mustTotal === 0 || stats.mustPassed === stats.mustTotal;
    dimGrid.innerHTML += `
      <div class="conf-dim" data-layer="${dim}" data-pass="${ok}">
        <div class="conf-dim-key">${dim}</div>
        <div class="conf-dim-must">${stats.mustPassed}/${stats.mustTotal} MUST</div>
        <div class="conf-dim-should">${stats.shouldPassed}/${stats.shouldTotal} SHOULD</div>
      </div>
    `;
  }
  wrap.appendChild(dimGrid);

  const list = document.createElement('div');
  list.className = 'conf-clauses';
  for (const cl of c.clauses) {
    const row = document.createElement('div');
    row.className = 'conf-clause';
    row.dataset.dim = cl.dimension;
    row.dataset.applies = cl.applies;
    row.dataset.pass = cl.pass;
    row.dataset.sev = cl.severity;
    row.innerHTML = `
      <div class="conf-clause-icon">${cl.applies ? (cl.pass ? '✓' : '✗') : '·'}</div>
      <div class="conf-clause-body">
        <div class="conf-clause-id">${escapeHtml(cl.id)} <span class="conf-clause-sev">${escapeHtml(cl.severity)}</span> <span class="conf-clause-tier">applies ${escapeHtml(cl.minTier)}+</span> <span class="conf-clause-ref">${escapeHtml(cl.specRef)}</span></div>
        <div class="conf-clause-desc">${escapeHtml(cl.description)}</div>
      </div>
    `;
    list.appendChild(row);
  }
  wrap.appendChild(list);
  return wrap;
}
