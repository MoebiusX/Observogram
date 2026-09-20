// studio/proto-synthesis.mjs
//
// THE SYNTHESIS PROTOTYPE (?proto=…) — the converged Diagnose/Remediate
// redesign, gated behind the query param until the maintainer ratifies
// it (2026-06-11: "only make changes in the prototypes for now, not the
// app yet"). Without ?proto the production tabs render untouched.
//
// Diagnose: the ratified narrative header (grade chip · blurb · summary
// rows · biggest-drag callout · full labelled ladder + derivation note),
// a sticky action strip, trend tiles from journey run history, and every
// deep report as a focused expandable panel. Remediate: a triage queue
// ordered by the engine's weighted badness with a basket-projected grade.
//
// View-layer only. Reuses the PRODUCTION renderers for the ratified
// pieces (chain cards with per-branch actions, the posture stack, the
// retrofeed POST) via compare-view exports — no duplicated semantics.

import { state } from './state.mjs';
import { escapeHtml } from './util.mjs';
import { catalogEntryFor } from './compare-catalog.mjs';
import {
  loadDiff, renderBenchmarkView, renderLiveScopeControl, refreshDiff,
  renderDiagnosticTraceabilityGraph, runRetrofeed, productSurface,
  renderPostureMatrix, renderPostureNarrative, renderBenchmarkHeadline, renderPosturePieRow,
  LENS_PRODUCTS,
} from './compare-view.mjs';
import { buildRetrofeedPatchText } from './compile-view.mjs';
import { artefactLabel, diffEntryLabel } from './artifact-model.mjs';
import {
  computeDiagnosticGrade, computePostureMatrix, criterionScore,
  diagnosticAuditStatus, instrumentGradeFor, INSTRUMENT_GRADE_SCALE,
  DRIFT_HEALTH_PASS_PCT, POSTURE_LAYERS, POSTURE_MECHANISMS_PER_LAYER,
} from './diagnostic-grade.mjs';
import {
  buildVerdictModel, projectGrade, projectionSentence,
  loadRunHistory, runSeries, deltaVsPrevious,
  kpiTile, chip, criterionChip, donutSvg, fmtUnits, fixChip, badnessClassChip,
  partialEvidenceBanner, scaffoldOosNotes, buildEvidenceRows, deploySelectionFromItems,
} from './verdict-ui.mjs';
// App-level callbacks, injected by the host studio at boot (app.mjs calls
// initHost right before boot()) — dependency inversion instead of importing
// app.mjs, so a downstream studio can vendor this file and hand it its own
// loader / modal / re-render entrypoints (docs/VENDORING.md).
import { host as appHost } from './host.mjs';

// The verdict-ui engines take the state slice explicitly (no global reads);
// this is the studio's one binding of that contract.
function verdictInputs() {
  return { pack: state.pack, packB: state.packB, diff: state.diff, compareBId: state.compareBId };
}

// ---------- comparison loading gate (mirrors production behaviour) ----------

function ensureComparison(host) {
  const haveB = !!state.packB;
  if (!state.compareBId || (haveB && (state.diff || state.diff?.error))) return false;
  const loading = document.createElement('div');
  loading.className = 'placeholder loading-compare';
  loading.innerHTML = `
    <span class="compare-spinner" aria-hidden="true"></span>
    <span>Comparing <strong>${escapeHtml(state.pack?.name || 'pack A')}</strong> against <strong>${escapeHtml(String(state.compareBId))}</strong>…</span>
    <span class="loading-compare-sub">matching artefacts by behavioural identity — large packs take a few seconds</span>
  `;
  host.appendChild(loading);
  Promise.all([
    haveB ? Promise.resolve() : appHost.loadPackB(),
    (state.diff && !state.diff.error) ? Promise.resolve() : loadDiff(),
  ]).then(() => { appHost.renderTabs(); appHost.renderMainView(); })
    .catch((e) => {
      loading.classList.remove('loading-compare');
      loading.innerHTML = `
        <span>Comparison failed to load: ${escapeHtml(e?.message || 'unknown error')}</span>
        <button type="button" class="ctrl-btn loading-compare-retry">retry</button>
      `;
      loading.querySelector('.loading-compare-retry')?.addEventListener('click', () => appHost.renderMainView());
    });
  return true;
}

// ---------- DIAGNOSE ----------

export function renderSynthDiagnose(view) {
  // The Compare sub-tab is untouched by the redesign — the production
  // view handles it (including the sub-nav, which re-enters here when
  // the user flips back to Diagnostic Grade).
  if (state.diagnoseSub === 'compare') { renderBenchmarkView(view); return; }

  // Sub-nav replica so the prototype keeps the two sub-tabs reachable.
  const nav = document.createElement('div');
  nav.className = 'diag-subnav';
  nav.innerHTML = `
    <button type="button" class="diag-subtab is-active">
      <span class="diag-subtab-label">Diagnostic Grade</span><span class="diag-subtab-sub">is it good enough?</span></button>
    <button type="button" class="diag-subtab" data-sub="compare">
      <span class="diag-subtab-label">Compare</span><span class="diag-subtab-sub">A vs B — what differs?</span></button>
  `;
  nav.querySelector('[data-sub="compare"]').addEventListener('click', () => {
    state.diagnoseSub = 'compare';
    appHost.renderMainView();
  });
  view.appendChild(nav);

  const scaffold = document.createElement('section');
  scaffold.className = 'section benchmark-view';
  scaffold.dataset.layer = 'BENCHMARK';
  view.appendChild(scaffold);

  if (ensureComparison(scaffold)) return;

  // Auto-lens when Pack B is a *-reference catalogue pack (production rule).
  const haveB = !!state.packB;
  if (haveB) {
    const bId = String(state.compareBId || state.packB?.id || '').toLowerCase();
    const refMatch = /^([a-z][a-z0-9_-]*?)-reference$/.exec(bId);
    if (refMatch && (state.compareLens === 'all' || !state.compareLens)) {
      if (LENS_PRODUCTS.some(lp => lp.slug === refMatch[1])) state.compareLens = refMatch[1];
    }
  }
  const lens = state.compareLens || 'all';
  const useLens = lens && lens !== 'all';
  const passesLens = !useLens ? null : (entry, side) => {
    const art = side === 'b' ? (entry.artefact || entry.b) : (entry.artefact || entry.a);
    const pack = side === 'b' ? state.packB : state.pack;
    return productSurface(art, lens, pack);
  };

  const posture = computePostureMatrix(state.pack, state.packB);
  const diagnostic = computeDiagnosticGrade(state.pack, state.packB, posture, state.compareBId, state.diff);
  const vm = buildVerdictModel({
    ...verdictInputs(),
    catalogEntry: catalogEntryFor(state.compareBId),
    passesLens,
  });

  // Trend tiles read journey run history; repaint once when it lands
  // (only when no comparison gate is pending).
  loadRunHistory(() => {
    if (state.view === 'compare' && (!state.compareBId || state.packB)) appHost.renderMainView();
  });

  scaffold.appendChild(buildDiagnosePage(vm, diagnostic, posture, lens, useLens));

  if (!haveB) {
    const head = scaffold.querySelector('.diag-report-head');
    if (head) head.insertAdjacentHTML('afterend', `
      <div class="compare-prompt"><div class="compare-prompt-body">
        <span class="compare-prompt-key">COMPARE</span>
        <span class="compare-prompt-text">This verdict reads <strong>Pack A on its own</strong>. Load a
          <strong>Pack B</strong> from the <em>PACK B</em> picker in the header to compare side-by-side —
          detect <strong>drift</strong> (declared vs what's deployed) or measure the <strong>gap to a target</strong> posture.</span>
      </div></div>`);
  }
}

function buildDiagnosePage(vm, diagnostic, posture, lens, useLens) {
  const wrap = document.createElement('div');
  wrap.className = 'diag-report';

  const cov = diagnostic.coverage;
  const trust = diagnostic.trust;
  const operability = diagnostic.operability || { criteria: [], informational: true, note: '' };
  const overall = diagnostic.overall;

  const pct = (passed, total) => total === 0 ? 0 : Math.round((passed / total) * 100);
  const fmtScore = (n) => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  const criterionState = (c) => c.pass ? 'is-pass' : (criterionScore(c) > 0 ? 'is-partial' : 'is-fail');
  const criterionPip = (c) => c.pass ? '✓' : (criterionScore(c) > 0 ? '◐' : '✗');
  const overallPct = pct(overall.passed, overall.total);
  const covPct = pct(cov.passed, cov.total);
  const trustPct = pct(trust.passed, trust.total);
  const chainBlock = renderDiagnosticTraceabilityGraph(diagnostic.traceabilityGraph);
  const audit = overall.audit || diagnosticAuditStatus(overall.passed, overall.total);
  const passes = audit.passes;
  const ig = overall.instrumentGrade || instrumentGradeFor(audit.scorePctExact);

  const summaryRow = (label, value, hint, st) => `
    <tr class="diag-summary-row ${st || ''}">
      <td class="diag-summary-key">${escapeHtml(label)}</td>
      <td class="diag-summary-val">${value}</td>
      <td class="diag-summary-hint">${hint || ''}</td>
    </tr>`;
  const bar = (p) => `
    <span class="diag-bar"><span class="diag-bar-fill" style="width:${Math.max(0, Math.min(100, p))}%"></span></span>`;
  const critTable = (criteria) => `
    <table class="diag-crit-table">
      <thead><tr><th class="c-pip"></th><th class="c-name">Criterion</th><th class="c-obs">Observed</th><th class="c-exp">Expected</th></tr></thead>
      <tbody>${criteria.map(c => `
        <tr class="diag-crit ${criterionState(c)}" data-key="${escapeHtml(c.key)}">
          <td class="c-pip">${criterionPip(c)}</td>
          <td class="c-name">${escapeHtml(c.label)}</td>
          <td class="c-obs">${escapeHtml(c.detail)}</td>
          <td class="c-exp">${escapeHtml(c.sub)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  const evidenceRows = buildEvidenceRows(diagnostic);
  const evidenceTable = `
    <table class="diag-evidence-table">
      <thead><tr><th class="e-field">Field</th><th class="e-exp">Expected</th><th class="e-obs">Observed</th><th class="e-status">Status</th></tr></thead>
      <tbody>${evidenceRows.map(r => `
        <tr class="${r.informational ? 'is-info' : criterionState(r)}">
          <td class="e-field">${escapeHtml(r.field)}</td>
          <td class="e-exp">${escapeHtml(r.exp)}</td>
          <td class="e-obs">${escapeHtml(r.obs)}</td>
          <td class="e-status">${r.informational ? (r.pass ? 'YES · INFO' : 'NO · INFO') : (r.pass ? 'PASS' : (typeof r.score === 'number' && r.score > 0 ? 'PARTIAL' : 'FAIL'))}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  const ladderHtml = `
    <ul class="grade-ladder">
      ${INSTRUMENT_GRADE_SCALE.map(g => {
        const current = g.letter === ig.letter;
        const unreachable = g.minPct === null;
        const tip = g.blurb + (unreachable ? ` Requires ${g.requires}.` : '') + (current ? ` ← this pack: ${overallPct}%.` : '');
        return `
        <li class="grade-rung tier-${g.tier} ${current ? 'is-current' : ''} ${unreachable ? 'is-unreachable' : ''}" title="${escapeHtml(tip)}">
          <span class="grade-rung-letter">${escapeHtml(g.letter)}</span>
          <span class="grade-rung-label">${escapeHtml(g.label)}</span>
          <span class="grade-rung-range">${escapeHtml(g.range)}</span>
        </li>`;
      }).join('')}
    </ul>
    <p class="grade-ladder-note">Grades derive from the verification score — A starts strictly above the ${audit.threshold}% audit bar, so the letter and the machine PASS/FAIL always agree. Verification evidence, not incident-validation. A++ needs external reference evidence this instrument cannot produce alone.</p>`;

  // The ONE thing costing the most grade + the engine-projected effect of
  // fixing exactly that bucket (honesty fence in verdict-ui.projectGrade).
  let dragSentence = '';
  if (vm.haveB && vm.biggestGap) {
    const gapUids = new Set(vm.items.filter(i => i.kind === vm.biggestGap.kind).map(i => i.uid));
    const gp = gapUids.size ? projectGrade(gapUids, verdictInputs()) : null;
    dragSentence = gp ? projectionSentence(gp, gapUids.size) : '';
  }

  wrap.innerHTML = `
    <header class="diag-report-head">
      <div class="diag-head-main">
        <div class="diag-report-head-line">
          <span class="diag-report-eyebrow">DIAGNOSTIC GRADE</span>
          <span class="diag-report-status grade-chip tier-${escapeHtml(ig.tier)}" title="${escapeHtml(ig.blurb || '')}">${escapeHtml(ig.letter)} · ${escapeHtml(ig.label)}</span>
        </div>
        <p class="diag-grade-blurb">${escapeHtml(ig.blurb || '')} Diagnostic-grade (A) begins above ${audit.threshold}%${passes ? '' : ` — this pack is ${(audit.threshold - audit.scorePctExact).toFixed(1)} pp below the bar`}.</p>
        <table class="diag-summary">
          <colgroup><col><col><col></colgroup>
          <tbody>
            ${summaryRow('Score', `<span class="diag-pct">${overallPct}%</span> <span class="diag-frac">${fmtScore(overall.passed)}/${overall.total}</span>`, bar(overallPct))}
            ${summaryRow('Coverage', `<span class="diag-pct">${covPct}%</span> <span class="diag-frac">${fmtScore(cov.passed)}/${cov.total}</span>`, bar(covPct))}
            ${summaryRow('Trust', `<span class="diag-pct">${trustPct}%</span> <span class="diag-frac">${fmtScore(trust.passed)}/${trust.total}</span>`, bar(trustPct))}
            ${summaryRow('Audit', `<span class="${passes ? 'diag-yes' : 'diag-no'}">${audit.status}</span>`, `gate contract: PASS above ${audit.threshold}% (A and better)`)}
            ${summaryRow('Verified', trust.hasMcpSource ? '<span class="diag-yes">YES</span>' : '<span class="diag-no">NO</span>',
                         trust.hasMcpSource ? 'live signal present' : 'connect MCP or scan live to verify',
                         trust.hasMcpSource ? '' : 'is-warn')}
          </tbody>
        </table>
      </div>
      ${vm.haveB ? `
      <div class="diag-head-drag${vm.biggestGap ? '' : ' is-clean'}">
        ${vm.biggestGap ? `
          <span class="diag-drag-eyebrow">BIGGEST DRAG ON THE GRADE</span>
          <p class="diag-drag-lede"><strong class="diag-drag-n">${vm.biggestGap.n}</strong>
            artefact${vm.biggestGap.n === 1 ? '' : 's'} <strong>${escapeHtml(vm.biggestGap.label)}</strong>
            — ${escapeHtml(fmtUnits(vm.biggestGap.units))} of ${escapeHtml(fmtUnits(vm.weighted.totalBadness))} weighted badness units.</p>
          ${dragSentence ? `<p class="diag-drag-projection">${escapeHtml(dragSentence)}</p>` : ''}
        ` : `
          <span class="diag-drag-eyebrow">NO DRIFT DETECTED</span>
          <p class="diag-drag-lede">Every concrete artefact aligns with <strong>${escapeHtml(vm.bName)}</strong>.
            Remaining grade loss comes from the scored criteria, not drift.</p>
        `}
      </div>` : ''}
      <aside class="diag-grade-scale">
        ${ladderHtml}
      </aside>
    </header>
  `;

  wrap.appendChild(buildActionStrip(vm));
  if (vm.haveB) wrap.appendChild(renderLiveScopeControl({ standalone: true }));
  wrap.insertAdjacentHTML('beforeend', partialEvidenceBanner(vm));
  wrap.insertAdjacentHTML('beforeend', buildTrendTiles(vm, diagnostic));
  wrap.appendChild(buildPanels(vm, {
    posture, lensSlug: lens,
    lensLabel: useLens ? (LENS_PRODUCTS.find(lp => lp.slug === lens)?.label || lens) : null,
    covSection: { meta: `${fmtScore(cov.passed)}/${cov.total} score · ${covPct}%`, table: critTable(cov.criteria), criteria: cov.criteria },
    trustSection: {
      meta: `${fmtScore(trust.passed)}/${trust.total} score · ${trustPct}%`,
      table: critTable(trust.criteria), criteria: trust.criteria, hasMcpSource: trust.hasMcpSource,
    },
    opSection: {
      table: critTable(operability.criteria), criteria: operability.criteria,
      note: operability.note || 'response readiness, not diagnostic capability — observed, displayed, never scored',
    },
    evidenceSection: {
      meta: `${fmtScore(evidenceRows.filter(r => !r.informational).reduce((n, r) => n + criterionScore(r), 0))}/${evidenceRows.filter(r => !r.informational).length} evidence score · +${evidenceRows.filter(r => r.informational).length} informational`,
      table: evidenceTable, rows: evidenceRows,
    },
    chainBlock,
    chainRollup: diagnostic.traceabilityGraph?.rollup || null,
  }));
  return wrap;
}

// Deploy / retrofeed / re-verify — wired to the production machinery
// (deploy modal preset, the real runRetrofeed POST), persistent at the
// top instead of buried mid-scroll.
function buildActionStrip(vm) {
  const strip = document.createElement('div');
  strip.className = 'mc-actionbar';
  const dep = vm.deployableSet;
  const rfLabel = vm.mode === 'drift'
    ? `⤵ Retrofeed ${vm.totals.onlyInB} shadow signal${vm.totals.onlyInB === 1 ? '' : 's'} to the pack`
    : `⤵ Adopt ${vm.totals.onlyInB} declaration${vm.totals.onlyInB === 1 ? '' : 's'} from ${escapeHtml(vm.bName)}`;
  strip.innerHTML = `
    ${vm.mode === 'drift' && dep.identities.size ? `
      <button type="button" class="mc-act is-primary" id="mc-deploy-missing"
        title="Open the deploy modal preselected with the deployable declared-not-live artefacts (${dep.rows} rule/dashboard row${dep.rows === 1 ? '' : 's'})">
        ⇪ Deploy the missing set (${dep.identities.size})</button>` : ''}
    ${vm.haveB && vm.totals.onlyInB > 0 ? `
      <button type="button" class="mc-act" id="mc-retrofeed"
        title="Adopt the ${vm.mode === 'drift' ? 'live-not-declared shadow signals' : 'target pack’s missing declarations'} into your pack — download the additions and the updated pack for a repo PR">
        ${rfLabel}</button>` : ''}
    <button type="button" class="mc-act" id="mc-reverify"
      title="Open Journeys to re-run the live verification — the only thing that actually moves the grade">↻ Re-verify</button>
    <button type="button" class="mc-act is-quiet" id="mc-open-remediate">Open Remediate →</button>
    <div class="drift-retrofeed-result" hidden></div>
  `;
  strip.querySelector('#mc-deploy-missing')?.addEventListener('click', () =>
    appHost.openDeployModal({ packId: state.selectedPackId, presetIdentities: vm.deployableSet.identities }));
  strip.querySelector('#mc-retrofeed')?.addEventListener('click', (ev) =>
    runRetrofeed(ev.currentTarget, strip.querySelector('.drift-retrofeed-result')));
  strip.querySelector('#mc-reverify')?.addEventListener('click', () => {
    state.view = 'journeys';
    appHost.renderTabs(); appHost.renderMainView();
  });
  strip.querySelector('#mc-open-remediate')?.addEventListener('click', () => {
    state.view = 'compile';
    appHost.renderTabs(); appHost.renderMainView();
  });
  return strip;
}

// Trend tiles — sparkline + delta from journey run history where it
// exists; honest "no run history yet" notes where it doesn't.
function buildTrendTiles(vm, diagnostic) {
  const scoreSeries = runSeries('gradeScore');
  const alignSeries = runSeries('alignmentPct');
  const freshC = diagnostic.trust.criteria.find(c => c.key === 'fresh');
  const rollup = diagnostic.traceabilityGraph?.rollup;
  const histNote = scoreSeries ? '' : 'no run history yet — capture a journey to chart trends';
  const tiles = [
    kpiTile({
      accent: 'cmp', label: 'SCORE TREND', value: `${vm.overallPct}`, unit: '%',
      series: scoreSeries, deltaText: deltaVsPrevious(scoreSeries), note: histNote,
    }),
    kpiTile({
      accent: 'amber', label: 'DRIFT FIDELITY',
      value: vm.haveB && vm.diff ? `${vm.weighted.healthPct}` : '—',
      unit: vm.haveB && vm.diff ? '%' : '',
      series: alignSeries, deltaText: deltaVsPrevious(alignSeries),
      note: vm.haveB && vm.diff ? `${fmtUnits(vm.weighted.totalBadness)} badness units` : 'load a Pack B to measure',
      warn: vm.haveB && vm.diff && vm.weighted.healthPct < DRIFT_HEALTH_PASS_PCT,
    }),
    kpiTile({
      accent: 'purple', label: 'CHAIN INTEGRITY',
      value: rollup ? `${Math.round((rollup.integrityMean || 0) * 100)}` : '—',
      unit: rollup ? '%' : '',
      note: rollup ? `${rollup.intact}/${rollup.declaredTotal} declared commitments intact` : 'needs a live diff with declared SLO chains',
      warn: !!rollup && (rollup.broken > 0),
    }),
    kpiTile({
      accent: 'cyan', label: 'FRESHNESS', value: freshC?.pass ? 'OK' : 'STALE', unit: '',
      note: freshC?.detail || '', warn: !freshC?.pass,
    }),
  ];
  return `<div class="mc-tiles">${tiles.join('')}</div>`;
}

// One focused panel: glanceable body, expandable detail (⤢), one title,
// one question — no prose walls. Toggling is local DOM state.
function mcPanel({ id, accent = 'cmp', num = '', title, question, micro = '', body, detail = '', wide = false }) {
  return `
    <article class="mc-panel is-${accent}${wide ? ' is-wide' : ''}" data-panel="${escapeHtml(id)}">
      <header class="mc-panel-head">
        ${num ? `<span class="mc-panel-num">${escapeHtml(num)}</span>` : ''}
        <span class="mc-panel-title">${escapeHtml(title)}</span>
        <span class="mc-panel-micro">${micro}</span>
        ${detail ? `<button type="button" class="mc-panel-toggle" title="expand the full report">⤢</button>` : ''}
      </header>
      <div class="mc-panel-q">${escapeHtml(question)}</div>
      <div class="mc-panel-body">${body}</div>
      ${detail ? `<div class="mc-panel-detail" hidden>${detail}</div>` : ''}
    </article>`;
}

const C_LATTICE = {
  aligned: 'var(--pass-border)',
  drifted: 'rgb(150, 90, 200)',
  decl: 'rgb(200, 70, 40)',
  shadow: 'rgb(180, 120, 0)',
};

function buildPanels(vm, ctx) {
  const grid = document.createElement('div');
  grid.className = 'mc-grid';
  const panels = [];
  const critChips = (criteria) => `
    <ul class="mc-crit">${criteria.map(c => `
      <li>${c.informational ? chip('info', c.pass ? 'YES' : 'NO') : criterionChip(c)}
        <span class="mc-crit-name" title="${escapeHtml(c.detail)}">${escapeHtml(c.label)}</span></li>`).join('')}
    </ul>`;
  const sampleKeys = (entries, max = 4) => {
    const names = entries.slice(0, max).map(e => escapeHtml(diffEntryLabel(e)));
    const more = entries.length > max ? ` +${entries.length - max}` : '';
    return names.length ? names.join(' · ') + more : '—';
  };
  const sampleDeltas = (entries, max = 3) => {
    const names = entries.slice(0, max).map(e => {
      const fields = (e.deltas || []).map(d => d.field).slice(0, 3).join(',');
      return escapeHtml(diffEntryLabel(e)) + (fields ? `<span class="drift-delta-fields">(${escapeHtml(fields)})</span>` : '');
    });
    const more = entries.length > max ? ` +${entries.length - max}` : '';
    return names.length ? names.join(' · ') + more : '—';
  };

  if (vm.haveB && vm.diff) {
    const aLabel = vm.mode === 'drift' ? 'declared, not live' : 'beyond target';
    const bLabel = vm.mode === 'drift' ? 'live, not declared' : 'missing vs target';
    const aW = vm.mode === 'drift' ? '1.0' : '0.15';
    const bW = vm.mode === 'drift' ? '0.15' : '1.0';
    const riskNote = vm.mode === 'drift'
      ? 'Weighted badness: declared-not-live = 1.0; drifted = 0.5 by default, 1.0 for decision-bearing fields, 0.1 for cosmetic fields; live-not-declared = 0.15. Out-of-scope live inventory is excluded.'
      : 'Weighted badness: missing target artefacts = 1.0; drifted = 0.5 by default, 1.0 for decision-bearing fields, 0.1 for cosmetic fields; beyond-target extras = 0.15.';
    panels.push(mcPanel({
      id: 'lattice', accent: 'amber', title: 'Signal Lattice',
      question: vm.mode === 'drift' ? `does the declared pack match ${vm.bName}?` : `how far from ${vm.bName}?`,
      micro: chip(vm.weighted.healthPct >= DRIFT_HEALTH_PASS_PCT ? 'pass' : vm.weighted.healthPct >= 60 ? 'partial' : 'fail', `${vm.weighted.healthPct}% health`)
        + (ctx.lensLabel ? ` ${chip('info', `LENS · ${ctx.lensLabel.toUpperCase()}`)}` : ''),
      body: `
        <div class="mc-lattice">
          <figure>${donutSvg([{ value: vm.totals.aligned, color: C_LATTICE.aligned }, { value: vm.weighted.totalBadness, color: 'var(--ink-4)' }], vm.weighted.healthPct + '%', { size: 96 })}<figcaption>weighted health</figcaption></figure>
          <figure>${donutSvg([
            { value: vm.weighted.driftedUnits, color: C_LATTICE.drifted },
            { value: vm.weighted.onlyInAUnits, color: C_LATTICE.decl },
            { value: vm.weighted.onlyInBUnits, color: C_LATTICE.shadow },
          ], fmtUnits(vm.weighted.totalBadness), { size: 96 })}<figcaption>weighted badness</figcaption></figure>
          <ul class="mc-lattice-legend">
            <li><span class="sw" style="background:${C_LATTICE.aligned}"></span>${vm.totals.aligned} aligned · w 0</li>
            <li><span class="sw" style="background:${C_LATTICE.drifted}"></span>${vm.totals.drifted} drifted · w per field</li>
            <li><span class="sw" style="background:${C_LATTICE.decl}"></span>${vm.totals.onlyInA} ${escapeHtml(aLabel)} · w ${aW}</li>
            <li><span class="sw" style="background:${C_LATTICE.shadow}"></span>${vm.totals.onlyInB} ${escapeHtml(bLabel)} · w ${bW}</li>
          </ul>
        </div>`,
      detail: `
        <p class="drift-risk-note">${escapeHtml(riskNote)} Health = aligned / (aligned + weighted badness).</p>
        ${scaffoldOosNotes(vm)}
        ${vm.totals.outOfScope ? '<button type="button" class="ctrl-link drift-oos-widen" title="Switch the live scope to \'All live\' so the parked inventory is classified instead of parked">show them — widen scope</button>' : ''}`,
    }));

    const maxBad = Math.max(1, ...vm.layers.map(r => r.drifted.length + r.onlyInA.length + r.onlyInB.length));
    panels.push(mcPanel({
      id: 'strata', accent: 'blue', title: 'Strata Drill',
      question: 'which layer carries the drift?',
      micro: `${vm.layers.length} strata`,
      body: `
        <table class="mc-strata">
          <thead><tr><th></th><th>aligned</th><th>drifted</th><th>a-only</th><th>b-only</th></tr></thead>
          <tbody>${vm.layers.map(r => {
            const bad = r.drifted.length + r.onlyInA.length + r.onlyInB.length;
            return `<tr class="${bad ? '' : 'is-quiet'}" style="--heat:${(bad / maxBad).toFixed(2)}">
              <th><span class="mc-lnum">${r.L}</span> ${escapeHtml(r.name)}</th>
              <td class="is-aligned">${r.aligned.length}</td>
              <td class="is-drifted">${r.drifted.length || ''}</td>
              <td class="is-decl">${r.onlyInA.length || ''}</td>
              <td class="is-shadow">${r.onlyInB.length || ''}${r.outOfScope.length ? ` <span class="mc-oos-inline">+${r.outOfScope.length} oos</span>` : ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>`,
      detail: vm.layers.map(r => {
        const drifted = r.drifted.length ? `<div class="mc-strata-detail"><span class="mc-lnum">${r.L}</span> drifted: ${sampleDeltas(r.drifted)}</div>` : '';
        const missing = r.onlyInA.length ? `<div class="mc-strata-detail"><span class="mc-lnum">${r.L}</span> ${vm.mode === 'drift' ? 'declared-not-live' : 'beyond target'}: ${sampleKeys(r.onlyInA)}</div>` : '';
        const shadow = r.onlyInB.length ? `<div class="mc-strata-detail"><span class="mc-lnum">${r.L}</span> ${vm.mode === 'drift' ? 'live-not-declared' : 'missing vs target'}: ${sampleKeys(r.onlyInB)}</div>` : '';
        return drifted + missing + shadow;
      }).join('') || '<div class="mc-strata-detail">no deltas</div>',
    }));
  }

  if (ctx.chainBlock && ctx.chainRollup) {
    const r = ctx.chainRollup;
    panels.push(mcPanel({
      id: 'chains', accent: 'purple', num: '2B.G', title: 'Requirement Chains', wide: true,
      question: 'do declared SLO/SLI derivations hold in live?',
      micro: chip(r.broken ? 'fail' : r.partial ? 'partial' : 'pass', `${r.intact}/${r.declaredTotal} INTACT`)
        + ` ${Math.round((r.integrityMean || 0) * 100)}% integrity`,
      body: `
        <div class="mc-cells">
          <span class="mc-cell is-pass"><strong>${r.intact}</strong> intact</span>
          <span class="mc-cell is-partial"><strong>${r.partial}</strong> partial</span>
          <span class="mc-cell is-fail"><strong>${r.broken}</strong> broken</span>
          <span class="mc-cell is-info"><strong>${r.undeclared}</strong> live-only</span>
        </div>`,
      detail: ctx.chainBlock,
    }));
  }

  panels.push(mcPanel({
    id: 'coverage', accent: 'blue', num: '2A', title: 'Coverage',
    question: 'are we observing the right signals?',
    micro: ctx.covSection.meta,
    body: critChips(ctx.covSection.criteria),
    detail: ctx.covSection.table,
  }));
  panels.push(mcPanel({
    id: 'trust', accent: 'green', num: '2B', title: 'Trust',
    question: 'can we trust what the signals show?',
    micro: ctx.trustSection.meta,
    body: `${ctx.trustSection.hasMcpSource ? '' : `
      <div class="diag-banner"><span class="diag-banner-key">WARN</span>
        Pack A carries no live signal. Drift &amp; freshness require an MCP-drafted or live-refreshed pack to verify.</div>`}
      ${critChips(ctx.trustSection.criteria)}`,
    detail: ctx.trustSection.table,
  }));
  panels.push(mcPanel({
    id: 'operability', accent: 'gray', num: '2C', title: 'Operability',
    question: 'can oncall act on what it sees?',
    micro: chip('info', 'INFORMATIONAL · NOT SCORED'),
    body: `
      <div class="diag-banner"><span class="diag-banner-key">INFO</span> ${escapeHtml(ctx.opSection.note)}</div>
      ${critChips(ctx.opSection.criteria)}`,
    detail: ctx.opSection.table,
  }));
  panels.push(mcPanel({
    id: 'evidence', accent: 'cyan', num: '⊜', title: 'Evidence Ledger',
    question: 'what pack field backs each claim?',
    micro: ctx.evidenceSection.meta,
    body: (() => {
      const failing = ctx.evidenceSection.rows.filter(r => !r.informational && !r.pass);
      if (!failing.length) return '<div class="mc-panel-note">every scored assertion attested — expand for the full field-by-field trail</div>';
      return `<ul class="mc-crit">${failing.map(r => `
        <li>${chip(typeof r.score === 'number' && r.score > 0 ? 'partial' : 'fail', typeof r.score === 'number' && r.score > 0 ? 'PARTIAL' : 'FAIL')}
          <span class="mc-crit-name mc-mono" title="${escapeHtml(r.obs)}">${escapeHtml(r.field)}</span></li>`).join('')}
      </ul>`;
    })(),
    detail: ctx.evidenceSection.table,
  }));

  // Posture matrix — the full ratified stack (headline verdict word,
  // per-layer pies, the matrix, the narrative), reorganized into the
  // panel detail. Nothing removed.
  let present = 0, evidence = 0, absent = 0;
  for (const l of POSTURE_LAYERS) {
    for (const m of POSTURE_MECHANISMS_PER_LAYER) {
      const arr = ctx.posture.cells[`${l.key}:${m.key}`];
      if (!arr || arr.length === 0) absent++;
      else if (arr.every(a => a._evidence)) evidence++;
      else present++;
    }
  }
  const postureTotal = POSTURE_LAYERS.length * POSTURE_MECHANISMS_PER_LAYER.length;
  const observedPct = Math.round(((present + evidence) / postureTotal) * 100);
  panels.push(mcPanel({
    id: 'posture', accent: 'cmp', title: 'Posture Matrix', wide: true,
    question: 'where do the coverage gaps live, mechanism by mechanism?',
    micro: chip(observedPct >= 50 ? 'pass' : 'fail', `${observedPct}% OBSERVED`)
      + ` ${evidence} evidenced · ${present} declared · ${absent} absent of ${postureTotal}`,
    body: '<div class="mc-panel-note">4 layers × 10 mechanisms — expand for the headline, per-layer pies, the full matrix and narrative</div>',
    detail: '<div class="mc-posture-host"></div>',
  }));

  grid.innerHTML = panels.join('');

  const postureHost = grid.querySelector('.mc-posture-host');
  if (postureHost) {
    postureHost.appendChild(renderBenchmarkHeadline(ctx.posture, ctx.lensSlug));
    postureHost.appendChild(renderPosturePieRow(ctx.posture));
    postureHost.appendChild(renderPostureMatrix(ctx.posture));
    postureHost.appendChild(renderPostureNarrative(ctx.posture));
  }

  grid.addEventListener('click', (ev) => {
    if (ev.target.closest?.('.drift-oos-widen')) {
      state.diffScopeMode = 'all';
      state.diff = null;
      refreshDiff();
      return;
    }
    const btn = ev.target.closest?.('.mc-panel-toggle');
    if (!btn) return;
    const panel = btn.closest('.mc-panel');
    const detail = panel.querySelector('.mc-panel-detail');
    const open = detail.hidden;
    detail.hidden = !open;
    panel.classList.toggle('is-expanded', open);
    btn.textContent = open ? '⤡' : '⤢';
  });

  return grid;
}

// ---------- REMEDIATE — the triage queue ----------

// Display filter for the queue (session-only — selection is unaffected).
let triageFilter = 'all';

const TRIAGE_FILTERS = [
  { id: 'all',       label: 'All',             test: () => true },
  { id: 'deploy',    label: 'Deploy',          test: i => i.fix === 'deploy' },
  { id: 'retrofeed', label: 'Retrofeed',       test: i => i.fix === 'retrofeed' || i.fix === 'adopt' },
  { id: 'reconcile', label: 'Field decisions', test: i => i.fix === 'reconcile' },
  { id: 'manual',    label: 'Manual',          test: i => i.fix === 'manual' || i.fix === 'beyond-target' },
];

// Session-only basket deselections (NOT state.remediateDeselected — the
// production plan band owns that; the prototype must not disturb it).
const rqDeselected = new Set();

export function renderSynthRemediate(view) {
  const host = document.createElement('section');
  host.className = 'section compile-view';
  view.appendChild(host);

  const haveB = !!state.packB;
  const wrap = document.createElement('div');
  wrap.className = 'rq-band';
  host.appendChild(wrap);

  if (!haveB) {
    wrap.innerHTML = `
      <div class="rq-head">
        <span class="rq-eyebrow">TRIAGE</span>
        <span class="rq-title">What do we fix first?</span>
        <span class="rq-sub">Load a <strong>Pack B</strong> from the header to compute the queue —
          drift, shadow signals, and gaps to target, ordered by what they cost the grade.
          (The per-artefact compiler is unchanged — exit the prototype to use it.)</span>
      </div>`;
    return;
  }

  if (!state.diff || state.diff.error || !state.diff.layers) {
    wrap.innerHTML = `<div class="remediate-loading">Computing the set…</div>`;
    loadDiff().then(() => appHost.renderMainView());
    return;
  }

  const vm = buildVerdictModel({
    ...verdictInputs(),
    catalogEntry: catalogEntryFor(state.compareBId),
  });
  const bName = vm.bName;
  for (const uid of [...rqDeselected]) if (!vm.items.some(i => i.uid === uid)) rqDeselected.delete(uid);
  const basket = new Set(vm.items.filter(i => !rqDeselected.has(i.uid)).map(i => i.uid));
  const picked = vm.items.filter(i => basket.has(i.uid));
  const dep = deploySelectionFromItems(vm.items, basket);
  const projection = basket.size ? projectGrade(basket, verdictInputs()) : null;
  const sentence = projection ? projectionSentence(projection, basket.size) : '';

  const projTile = projection && projection.afterPct > projection.beforePct
    ? kpiTile({
        accent: 'cmp', label: 'PROJECTED GRADE',
        value: escapeHtml(projection.after.overall.instrumentGrade.letter),
        unit: ` ${projection.afterPct}%`,
        note: `from ${projection.before.overall.instrumentGrade.letter} (${projection.beforePct}%) — the selected fixes, engine-projected`,
      })
    : kpiTile({
        accent: 'cmp', label: 'PROJECTED GRADE', value: '—', unit: '',
        note: projection?.chainAnchored
          ? 'anchored on chain integrity — repairs land at the next live verification'
          : 'select fixes to project',
      });

  const filterChips = TRIAGE_FILTERS.map(f => {
    const n = f.id === 'all' ? vm.items.length : vm.items.filter(f.test).length;
    return `<button type="button" class="rq-filter${triageFilter === f.id ? ' is-active' : ''}" data-filter="${f.id}">
      ${escapeHtml(f.label)} <span class="rq-filter-n">${n}</span></button>`;
  }).join('');
  const activeFilter = TRIAGE_FILTERS.find(f => f.id === triageFilter) || TRIAGE_FILTERS[0];
  const shown = vm.items.filter(activeFilter.test);

  wrap.innerHTML = `
    <div class="rq-head">
      <span class="rq-eyebrow">TRIAGE</span>
      <span class="rq-title">What do we fix first?</span>
      <span class="rq-sub">every finding from the live diff vs <strong>${escapeHtml(bName)}</strong>,
        ordered by weighted badness — the engine's own cost model, not a heuristic</span>
    </div>
    ${partialEvidenceBanner(vm)}
    <div class="mc-tiles">
      ${kpiTile({ accent: 'red', label: 'FINDINGS', value: String(vm.items.length), unit: '', note: `${fmtUnits(vm.weighted.totalBadness)} weighted badness units total` })}
      ${kpiTile({ accent: 'amber', label: 'SELECTED', value: String(basket.size), unit: ` of ${vm.items.length}`, note: 'rows in the basket below' })}
      ${kpiTile({ accent: 'green', label: 'DEPLOYABLE', value: String(dep.identities.size), unit: ` · ${dep.rows} rows`, note: 'one-click via the deploy modal' })}
      ${projTile}
    </div>
    <div class="rq-tools"><div class="rq-filters">${filterChips}</div></div>
    <table class="rq-table">
      <thead><tr><th></th><th>Finding</th><th>Layer</th><th>Class</th><th>Badness</th><th>Fix</th><th></th></tr></thead>
      <tbody>
        ${shown.map(i => `
          <tr class="${rqDeselected.has(i.uid) ? 'is-deselected' : ''}" data-uid="${escapeHtml(i.uid)}">
            <td><input type="checkbox" ${rqDeselected.has(i.uid) ? '' : 'checked'} aria-label="include in the basket"></td>
            <td class="rq-label">${escapeHtml(artefactLabel(i.art, i.label))}${i.fields?.length ? `<span class="rq-fields">${escapeHtml(i.fields.slice(0, 3).join(', '))}</span>` : ''}</td>
            <td><span class="mc-lnum">${i.layer}</span></td>
            <td>${badnessClassChip(i)}</td>
            <td class="rq-w">${escapeHtml(fmtUnits(i.badness))}</td>
            <td>${fixChip(i.fix)}</td>
            <td>${i.deployable ? `<button type="button" class="mc-act is-mini" data-deploy="${escapeHtml(i.uid)}">deploy</button>` : ''}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    ${shown.length === 0 ? `<div class="remediate-empty">Nothing ${triageFilter === 'all' ? 'to remediate — every concrete artefact aligns.' : `under the ${escapeHtml(activeFilter.label)} filter.`}</div>` : ''}
    ${scaffoldOosNotes(vm)}
    <div class="rq-patch-host"></div>
    <div class="mc-deploybar">
      ${dep.identities.size ? `<button type="button" class="mc-act is-primary" id="rq-deploy">⇪ Deploy ${dep.identities.size} selected (${dep.rows} row${dep.rows === 1 ? '' : 's'})</button>` : ''}
      ${sentence ? `<span class="mc-deploybar-projection">${escapeHtml(sentence)}</span>` : ''}
    </div>
  `;

  const head = wrap.querySelector('.rq-head');
  head.insertAdjacentElement('afterend', renderLiveScopeControl({ standalone: true }));

  const retroPicked = picked.filter(i => i.fix === 'retrofeed' || i.fix === 'adopt');
  if (retroPicked.length) {
    const resolvedLike = { byLayer: {} };
    for (const i of retroPicked) {
      (resolvedLike.byLayer[i.layer] = resolvedLike.byLayer[i.layer] || []).push({
        direction: 'retrofeed', identity: i.identity || '', art: i.art,
      });
    }
    const patchText = buildRetrofeedPatchText(resolvedLike, bName);
    if (patchText) {
      const patch = document.createElement('details');
      patch.className = 'remediate-patch';
      patch.innerHTML = `
        <summary>Repo retrofeed patch (${retroPicked.length} item${retroPicked.length === 1 ? '' : 's'} in the basket)</summary>
        <pre>${escapeHtml(patchText)}</pre>
      `;
      wrap.querySelector('.rq-patch-host').appendChild(patch);
    }
  }

  wrap.querySelectorAll('.rq-filter').forEach(btn => {
    btn.onclick = () => { triageFilter = btn.dataset.filter; appHost.renderMainView(); };
  });
  wrap.querySelectorAll('.rq-table input[type="checkbox"]').forEach(cb => {
    cb.onchange = () => {
      const uid = cb.closest('tr').dataset.uid;
      if (cb.checked) rqDeselected.delete(uid); else rqDeselected.add(uid);
      appHost.renderMainView();
    };
  });
  wrap.querySelectorAll('[data-deploy]').forEach(btn => {
    btn.onclick = () => {
      const item = vm.items.find(i => i.uid === btn.dataset.deploy);
      if (!item?.deployIdentity) return;
      appHost.openDeployModal({ packId: state.selectedPackId, presetIdentities: new Set([item.deployIdentity]) });
    };
  });
  wrap.querySelector('#rq-deploy')?.addEventListener('click', () =>
    appHost.openDeployModal({ packId: state.selectedPackId, presetIdentities: dep.identities }));
}
