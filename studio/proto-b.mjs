// studio/proto-b.mjs
//
// PROTOTYPE B — Mission control (?proto=b).
//
// The KrystalineX-reference direction: a hero KPI band (big number ·
// sparkline · delta vs previous run, powered by journey run history),
// the instrument ladder as a vertical strip, then a dense grid of
// glanceable panels — one title, one question, verdict chips — each
// expandable in place. Remediate is the "Recommended Next Actions"
// table made first-class: a triage queue ordered by weighted badness.

import { state } from './state.mjs';
import { escapeHtml } from './util.mjs';
import { host as appHost } from './host.mjs';
import {
  buildProtoModel, protoEnsureComparison, projectGrade, projectionSentence,
  loadRunHistory, runHistory, runSeries, deltaVsPrevious,
  kpiTile, ladderHtml, chip, criterionChip, donutSvg, fmtUnits, fixChip, badnessClassChip,
  partialEvidenceBanner, scaffoldOosNotes, operabilityNote,
  buildEvidenceRows, deploySelectionFromItems,
} from './proto-shared.mjs';

// Panels the user has expanded (session-only).
const expanded = new Set();
// Triage rows deselected from the deploy basket (session-only).
const deselected = new Set();

// ---------- DIAGNOSE ----------

export function renderProtoDiagnoseB(view) {
  // Start the run-history fetch BEFORE the comparison gate so it resolves
  // while the (much slower) diff computes; the gate's own completion
  // render then paints the tiles with history already in hand. The
  // callback only re-renders when no gate is pending — re-entering the
  // gate would double-fetch the diff.
  loadRunHistory(() => {
    if (state.view === 'compare' && (!state.compareBId || state.packB)) appHost.renderMainView();
  });
  if (protoEnsureComparison(view)) return;
  const m = buildProtoModel();
  const d = m.diagnostic;
  const ig = d.overall.instrumentGrade;
  const audit = d.overall.audit;

  const root = document.createElement('section');
  root.className = 'proto-root proto-b';
  view.appendChild(root);

  // --- hero KPI band ---
  const hist = runHistory();
  const scoreSeries = runSeries('gradeScore');
  const alignSeries = runSeries('alignmentPct');
  const histNote = hist?.journey ? `journey: ${hist.journey}` : 'no run history yet — capture a journey to chart trends';
  const covPct = d.coverage.total ? Math.round((d.coverage.passed / d.coverage.total) * 100) : 0;
  const trustPct = d.trust.total ? Math.round((d.trust.passed / d.trust.total) * 100) : 0;
  const freshC = d.trust.criteria.find(c => c.key === 'fresh');
  const driftC = d.trust.criteria.find(c => c.key === 'drift-free');

  const tiles = [
    kpiTile({ accent: 'cmp', label: 'SCORE', value: `${m.overallPct}`, unit: '%',
      series: scoreSeries, deltaText: deltaVsPrevious(scoreSeries), note: scoreSeries ? histNote : histNote }),
    kpiTile({ accent: 'blue', label: 'COVERAGE', value: `${covPct}`, unit: '%',
      note: `${fmtScore(d.coverage.passed)}/${d.coverage.total} criteria` }),
    kpiTile({ accent: 'green', label: 'TRUST', value: `${trustPct}`, unit: '%',
      note: `${fmtScore(d.trust.passed)}/${d.trust.total} criteria` }),
    kpiTile({ accent: 'amber', label: 'DRIFT FIDELITY', value: m.haveB && m.diff ? `${m.weighted.healthPct}` : '—', unit: m.haveB && m.diff ? '%' : '',
      series: alignSeries, deltaText: deltaVsPrevious(alignSeries),
      note: m.haveB && m.diff ? `${fmtUnits(m.weighted.totalBadness)} badness units` : 'load a Pack B to measure',
      warn: m.haveB && m.diff && m.weighted.healthPct < 85 }),
    kpiTile({ accent: 'cyan', label: 'FRESHNESS', value: freshC?.pass ? 'OK' : 'STALE', unit: '',
      note: freshC?.detail || '', warn: !freshC?.pass }),
    kpiTile({ accent: d.trust.hasMcpSource ? 'green' : 'red', label: 'VERIFIED', value: d.trust.hasMcpSource ? 'LIVE' : 'NO', unit: '',
      note: d.trust.hasMcpSource ? 'live signal present' : 'connect MCP or scan live to verify',
      warn: !d.trust.hasMcpSource }),
  ].join('');

  root.innerHTML = `
    <header class="pb-band">
      <div class="pb-verdict tier-${escapeHtml(ig.tier)}">
        <span class="pb-verdict-letter">${escapeHtml(ig.letter)}</span>
        <span class="pb-verdict-label">${escapeHtml(ig.label)}</span>
        ${chip(audit.passes ? 'pass' : 'fail', `AUDIT ${audit.status}`)}
      </div>
      <div class="pb-tiles">${tiles}</div>
      <aside class="pb-ladder">${ladderHtml(ig, m.overallPct, { compact: true })}</aside>
    </header>
    ${partialEvidenceBanner(m)}
    <div class="pb-grid" id="pb-grid"></div>
    <p class="proto-verification-note">${driftC ? escapeHtml(driftC.detail) + ' · ' : ''}Verification, not validation — the lattice attests declared artefacts against live state; it does not validate the design.</p>
  `;

  renderPanels(root.querySelector('#pb-grid'), m);
}

function fmtScore(n) { return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''); }

function panel({ id, accent = 'cmp', title, question, micro = '', body, detail = '' }) {
  const isOpen = expanded.has(id);
  return `
    <article class="pb-panel is-${accent}${isOpen ? ' is-expanded' : ''}" data-panel="${id}">
      <header class="pb-panel-head">
        <span class="pb-panel-title">${escapeHtml(title)}</span>
        <span class="pb-panel-micro">${micro}</span>
        ${detail ? `<button type="button" class="pb-panel-toggle" title="${isOpen ? 'collapse' : 'drill into the focused panel'}">${isOpen ? '⤡' : '⤢'}</button>` : ''}
      </header>
      <div class="pb-panel-q">${escapeHtml(question)}</div>
      <div class="pb-panel-body">${body}</div>
      ${detail ? `<div class="pb-panel-detail" ${isOpen ? '' : 'hidden'}>${detail}</div>` : ''}
    </article>`;
}

function renderPanels(host, m) {
  const d = m.diagnostic;
  const panels = [];

  // --- Signal Lattice (drift) ---
  if (m.haveB && m.diff) {
    const C_ALIGNED = 'var(--pass-border)';
    const C_DRIFTED = 'rgb(150, 90, 200)';
    const C_DECL = 'rgb(200, 70, 40)';
    const C_SHADOW = 'rgb(180, 120, 0)';
    const aLabel = m.mode === 'drift' ? 'declared-not-live' : 'beyond target';
    const bLabel = m.mode === 'drift' ? 'live-not-declared' : 'missing vs target';
    panels.push(panel({
      id: 'lattice', accent: 'amber', title: 'Signal Lattice',
      question: `does the declared pack match ${m.bName}?`,
      micro: chip(m.weighted.healthPct >= 85 ? 'pass' : m.weighted.healthPct >= 60 ? 'partial' : 'fail', `${m.weighted.healthPct}%`),
      body: `
        <div class="pb-lattice">
          ${donutSvg([{ value: m.totals.aligned, color: C_ALIGNED }, { value: m.weighted.totalBadness, color: 'var(--ink-4)' }], m.weighted.healthPct + '%', { size: 92 })}
          <ul class="pb-lattice-legend">
            <li><span class="sw" style="background:${C_ALIGNED}"></span>${m.totals.aligned} aligned</li>
            <li><span class="sw" style="background:${C_DRIFTED}"></span>${m.totals.drifted} drifted</li>
            <li><span class="sw" style="background:${C_DECL}"></span>${m.totals.onlyInA} ${escapeHtml(aLabel)}</li>
            <li><span class="sw" style="background:${C_SHADOW}"></span>${m.totals.onlyInB} ${escapeHtml(bLabel)}</li>
          </ul>
        </div>`,
      detail: `
        <p class="drift-risk-note">Weighted badness: ${m.mode === 'drift' ? 'declared-not-live = 1.0' : 'missing target artefacts = 1.0'}; drifted = 0.5 default / 1.0 decision-bearing / 0.1 cosmetic; ${m.mode === 'drift' ? 'live-not-declared' : 'beyond-target extras'} = 0.15. Health = aligned / (aligned + weighted badness).</p>
        ${scaffoldOosNotes(m)}`,
    }));

    // --- Strata Drill (per-layer heat) ---
    const maxBad = Math.max(1, ...m.layers.map(r => r.drifted.length + r.onlyInA.length + r.onlyInB.length));
    panels.push(panel({
      id: 'strata', accent: 'blue', title: 'Strata Drill',
      question: 'which layer carries the drift?',
      micro: `${m.layers.length} strata`,
      body: `
        <table class="pb-strata">
          <thead><tr><th></th><th>algn</th><th>drft</th><th>a-only</th><th>b-only</th></tr></thead>
          <tbody>${m.layers.map(r => {
            const bad = r.drifted.length + r.onlyInA.length + r.onlyInB.length;
            return `<tr class="${bad ? '' : 'is-quiet'}" style="--heat:${(bad / maxBad).toFixed(2)}">
              <th><span class="proto-lnum">${r.L}</span> ${escapeHtml(r.name)}</th>
              <td class="is-aligned">${r.aligned.length}</td>
              <td class="is-drifted">${r.drifted.length || ''}</td>
              <td class="is-decl">${r.onlyInA.length || ''}</td>
              <td class="is-shadow">${r.onlyInB.length || ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>`,
      detail: m.layers.map(r => {
        const worst = [...r.drifted, ...r.onlyInA].slice(0, 3);
        if (!worst.length) return '';
        return `<div class="pb-strata-detail"><span class="proto-lnum">${r.L}</span> ${worst.map(e => escapeHtml((e.key || '').split(':').pop() || '')).filter(Boolean).join(' · ') || '—'}</div>`;
      }).join(''),
    }));
  }

  // --- Requirement Chains ---
  const g = d.traceabilityGraph;
  if (g?.rollup && (g.branches || []).length) {
    const r = g.rollup;
    panels.push(panel({
      id: 'chains', accent: 'purple', title: 'Requirement Chains',
      question: 'do declared SLO/SLI derivations hold in live?',
      micro: chip(r.broken ? 'fail' : r.partial ? 'partial' : 'pass', `${Math.round((r.integrityMean || 0) * 100)}%`),
      body: `
        <div class="pb-chain-cells">
          <span class="pb-cell is-pass"><strong>${r.intact}</strong> intact</span>
          <span class="pb-cell is-partial"><strong>${r.partial}</strong> partial</span>
          <span class="pb-cell is-fail"><strong>${r.broken}</strong> broken</span>
          <span class="pb-cell is-info"><strong>${r.undeclared}</strong> live-only</span>
        </div>`,
      detail: `<ul class="pa-chain-list">${(g.branches || []).map(b => `
        <li class="pa-chain is-${escapeHtml(b.verdict)}">
          <span class="pa-chain-title">${escapeHtml(b.title || b.rootKey || 'requirement')}</span>
          ${chip(b.verdict === 'intact' ? 'pass' : b.verdict === 'broken' ? 'fail' : b.verdict === 'partial' ? 'partial' : 'info', String(b.verdict || '').toUpperCase())}
          <span class="pa-chain-meta">${escapeHtml(String(b.integrityPct ?? Math.round((b.integrity || 0) * 100)))}%</span>
        </li>`).join('')}</ul>`,
    }));
  }

  // --- Coverage / Trust matrices ---
  const critPanel = (id, accent, title, question, section, extra = '') => panel({
    id, accent, title, question,
    micro: `${fmtScore(section.passed)}/${section.total}`,
    body: `${extra}
      <ul class="pb-crit">${section.criteria.map(c => `
        <li>${criterionChip(c)}<span class="pb-crit-name">${escapeHtml(c.label)}</span></li>`).join('')}
      </ul>`,
    detail: `<table class="pa-crit-table"><tbody>${section.criteria.map(c => `
      <tr><td>${criterionChip(c)}</td><td class="c-name">${escapeHtml(c.label)}</td>
      <td class="c-obs">${escapeHtml(c.detail)}</td></tr>`).join('')}</tbody></table>`,
  });
  panels.push(critPanel('coverage', 'blue', 'Coverage Matrix', 'are we observing the right signals?', d.coverage));
  panels.push(critPanel('trust', 'green', 'Trust Matrix', 'can we trust what the signals show?', d.trust,
    d.trust.hasMcpSource ? '' : `<div class="diag-banner"><span class="diag-banner-key">WARN</span> Pack A carries no live signal. Drift &amp; freshness require an MCP-drafted or live-refreshed pack to verify.</div>`));

  // --- Operability (informational) ---
  panels.push(panel({
    id: 'operability', accent: 'gray', title: 'Operability',
    question: 'can oncall act on what it sees?',
    micro: chip('info', 'NOT SCORED'),
    body: `
      <ul class="pb-crit">${(d.operability?.criteria || []).map(c => `
        <li>${chip('info', c.pass ? 'YES' : 'NO')}<span class="pb-crit-name">${escapeHtml(c.label)}</span></li>`).join('')}
      </ul>
      <div class="pb-panel-note">${operabilityNote(m)}</div>`,
    detail: `<table class="pa-crit-table"><tbody>${(d.operability?.criteria || []).map(c => `
      <tr><td>${chip('info', c.pass ? 'YES · INFO' : 'NO · INFO')}</td><td class="c-name">${escapeHtml(c.label)}</td>
      <td class="c-obs">${escapeHtml(c.detail)}</td></tr>`).join('')}</tbody></table>`,
  }));

  // --- Evidence Ledger ---
  const evRows = buildEvidenceRows(d);
  panels.push(panel({
    id: 'evidence', accent: 'cyan', title: 'Evidence Ledger',
    question: 'what field backs each claim?',
    micro: `${evRows.filter(r => !r.informational && r.pass).length}/${evRows.filter(r => !r.informational).length} attested`,
    body: `
      <ul class="pb-crit">${evRows.slice(0, 4).map(r => `
        <li>${r.informational ? chip('info', 'INFO') : criterionChip(r)}<span class="pb-crit-name pb-mono">${escapeHtml(r.field)}</span></li>`).join('')}
        <li class="pb-crit-more">+${evRows.length - 4} more — expand</li>
      </ul>`,
    detail: `<table class="pa-evidence-table"><tbody>${evRows.map(r => `
      <tr><td class="e-field">${escapeHtml(r.field)}</td><td class="e-exp">${escapeHtml(r.exp)}</td>
      <td class="e-obs">${escapeHtml(r.obs)}</td>
      <td>${r.informational ? chip('info', r.pass ? 'YES · INFO' : 'NO · INFO') : criterionChip(r)}</td></tr>`).join('')}</tbody></table>`,
  }));

  // --- Recommended Next Actions ---
  if (m.items.length) {
    const top = m.items.slice(0, 6);
    panels.push(panel({
      id: 'actions', accent: 'red', title: 'Recommended Next Actions',
      question: 'what do we do first?',
      micro: `${m.items.length} findings`,
      body: `
        <table class="pb-actions">
          <tbody>${top.map(i => `
            <tr>
              <td><span class="proto-lnum">${i.layer}</span></td>
              <td class="pb-actions-label">${escapeHtml(i.label)}</td>
              <td>${badnessClassChip(i)}</td>
              <td class="pb-actions-w">w ${escapeHtml(fmtUnits(i.badness))}</td>
              <td>${fixChip(i.fix)}</td>
            </tr>`).join('')}</tbody>
        </table>
        <button type="button" class="proto-act is-primary" id="pb-open-queue">Open the triage queue →</button>`,
    }));
  } else if (!m.haveB) {
    panels.push(panel({
      id: 'actions', accent: 'red', title: 'Recommended Next Actions',
      question: 'what do we do first?',
      micro: chip('warn', 'NO PACK B'),
      body: '<div class="pb-panel-note">Load a Pack B from the header picker to compute drift findings and the triage queue.</div>',
    }));
  }

  host.innerHTML = panels.join('');
  host.querySelectorAll('.pb-panel-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.pb-panel').dataset.panel;
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      appHost.renderMainView();
    });
  });
  host.querySelector('#pb-open-queue')?.addEventListener('click', () => {
    state.view = 'compile';
    appHost.renderMainView();
  });
}

// ---------- REMEDIATE — Recommended Next Actions, first-class ----------

export function renderProtoRemediateB(view) {
  if (protoEnsureComparison(view)) return;
  const m = buildProtoModel();

  const root = document.createElement('section');
  root.className = 'proto-root proto-b';
  view.appendChild(root);

  if (!m.items.length) {
    root.innerHTML = `
      <header class="pb-band"><div class="pb-tiles">
        ${kpiTile({ accent: 'green', label: 'TRIAGE QUEUE', value: '0', unit: ' findings', note: m.haveB ? `aligned with ${m.bName}` : 'load a Pack B to compute the queue' })}
      </div></header>`;
    return;
  }

  // Basket = every deployable/selectable row minus explicit deselections.
  for (const id of [...deselected]) if (!m.items.some(i => i.uid === id)) deselected.delete(id);
  const basket = new Set(m.items.filter(i => !deselected.has(i.uid)).map(i => i.uid));
  const dep = deploySelectionFromItems(m.items, basket);
  const projection = basket.size ? projectGrade(basket) : null;
  const sentence = projection ? projectionSentence(projection, basket.size) : '';

  const projTile = projection && projection.afterPct > projection.beforePct
    ? kpiTile({ accent: 'cmp', label: 'PROJECTED GRADE', value: escapeHtml(projection.after.overall.instrumentGrade.letter), unit: ` ${projection.afterPct}%`,
        note: `from ${projection.before.overall.instrumentGrade.letter} (${projection.beforePct}%) — selected fixes` })
    : kpiTile({ accent: 'cmp', label: 'PROJECTED GRADE', value: '—', unit: '',
        note: projection?.chainAnchored ? 'anchored on chain integrity — repairs land at next verification' : 'select fixes to project' });

  root.innerHTML = `
    <header class="pb-band">
      <div class="pb-tiles">
        ${kpiTile({ accent: 'red', label: 'FINDINGS', value: String(m.items.length), unit: '', note: `${fmtUnits(m.weighted.totalBadness)} badness units total` })}
        ${kpiTile({ accent: 'amber', label: 'SELECTED', value: String(basket.size), unit: ` of ${m.items.length}`, note: 'rows in the basket below' })}
        ${kpiTile({ accent: 'green', label: 'DEPLOYABLE', value: String(dep.identities.size), unit: ` · ${dep.rows} rows`, note: 'one-click via the deploy modal' })}
        ${projTile}
      </div>
    </header>
    ${partialEvidenceBanner(m)}
    <section class="pb-queue">
      <header class="pb-queue-head">
        <span class="pb-queue-title">Recommended Next Actions</span>
        <span class="pb-queue-sub">ordered by weighted badness — the engine's own cost model, not a heuristic</span>
      </header>
      <table class="pb-queue-table">
        <thead><tr><th></th><th>Finding</th><th>Layer</th><th>Class</th><th>Badness</th><th>Fix</th><th></th></tr></thead>
        <tbody>
          ${m.items.map(i => `
            <tr class="${deselected.has(i.uid) ? 'is-deselected' : ''}" data-uid="${escapeHtml(i.uid)}">
              <td><input type="checkbox" ${deselected.has(i.uid) ? '' : 'checked'}></td>
              <td class="pb-q-label">${escapeHtml(i.label)}${i.fields?.length ? `<span class="pa-work-fields">${escapeHtml(i.fields.slice(0, 3).join(', '))}</span>` : ''}</td>
              <td><span class="proto-lnum">${i.layer}</span></td>
              <td>${badnessClassChip(i)}</td>
              <td class="pb-q-w">${escapeHtml(fmtUnits(i.badness))}</td>
              <td>${fixChip(i.fix)}</td>
              <td>${i.deployable ? `<button type="button" class="proto-act is-mini" data-deploy="${escapeHtml(i.uid)}">deploy</button>` : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${scaffoldOosNotes(m)}
    </section>
    <div class="proto-deploybar">
      ${dep.identities.size ? `<button type="button" class="proto-act is-primary" id="pb-deploy">⇪ Deploy ${dep.identities.size} selected (${dep.rows} rows)</button>` : ''}
      ${sentence ? `<span class="proto-deploybar-projection">${escapeHtml(sentence)}</span>` : ''}
    </div>
  `;

  root.querySelectorAll('.pb-queue-table input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const uid = cb.closest('tr').dataset.uid;
      if (cb.checked) deselected.delete(uid); else deselected.add(uid);
      appHost.renderMainView();
    });
  });
  root.querySelectorAll('[data-deploy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = m.items.find(i => i.uid === btn.dataset.deploy);
      if (!item?.deployIdentity) return;
      appHost.openDeployModal({ packId: state.selectedPackId, presetIdentities: new Set([item.deployIdentity]) });
    });
  });
  root.querySelector('#pb-deploy')?.addEventListener('click', () =>
    appHost.openDeployModal({ packId: state.selectedPackId, presetIdentities: dep.identities }));
}
