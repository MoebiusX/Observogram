// studio/proto-c.mjs
//
// PROTOTYPE C — Guided flow (?proto=c).
//
// Diagnose is a four-step walk: VERDICT → EVIDENCE → PICK GAPS → HAND OFF.
// One question per screen, a stepper on top, the projected grade updating
// live as gaps go into the basket. Remediate is the same basket as a
// triage queue ordered by weighted badness, with a progress meter and a
// sticky deploy rail. The basket is shared between the two tabs
// (session-only — the live diff stays the source of truth).

import { state } from './state.mjs';
import { escapeHtml } from './util.mjs';
import { host as appHost } from './host.mjs';
import {
  buildProtoModel, protoEnsureComparison, projectGrade, projectionSentence,
  ladderHtml, chip, criterionChip, donutSvg, fmtUnits, fixChip, badnessClassChip,
  partialEvidenceBanner, scaffoldOosNotes, verificationNote, operabilityNote,
  buildEvidenceRows, deploySelectionFromItems,
} from './proto-shared.mjs';

let step = 1;                  // current Diagnose step (session-only)
const basket = new Set();      // picked gap uids — shared Diagnose ↔ Remediate

const STEPS = [
  { n: 1, key: 'VERDICT', q: 'can we trust it?' },
  { n: 2, key: 'EVIDENCE', q: 'why — what does the instrument see?' },
  { n: 3, key: 'PICK GAPS', q: 'which gaps are worth fixing?' },
  { n: 4, key: 'HAND OFF', q: 'what happens next?' },
];

function stepperHtml(active) {
  return `
    <ol class="pc-stepper">
      ${STEPS.map(s => `
        <li class="pc-step${s.n === active ? ' is-active' : ''}${s.n < active ? ' is-done' : ''}" data-step="${s.n}">
          <span class="pc-step-n">${s.n < active ? '✓' : s.n}</span>
          <span class="pc-step-key">${s.key}</span>
          <span class="pc-step-q">${s.q}</span>
        </li>`).join('')}
    </ol>`;
}

function navHtml(active, { nextLabel = 'Next →', canNext = true } = {}) {
  return `
    <div class="pc-nav">
      ${active > 1 ? '<button type="button" class="proto-act" id="pc-back">← Back</button>' : '<span></span>'}
      ${active < 4 ? `<button type="button" class="proto-act is-primary" id="pc-next" ${canNext ? '' : 'disabled'}>${escapeHtml(nextLabel)}</button>` : ''}
    </div>`;
}

function wireStepper(root) {
  root.querySelectorAll('.pc-step').forEach(el => {
    el.addEventListener('click', () => { step = Number(el.dataset.step); appHost.renderMainView(); });
  });
  root.querySelector('#pc-back')?.addEventListener('click', () => { step = Math.max(1, step - 1); appHost.renderMainView(); });
  root.querySelector('#pc-next')?.addEventListener('click', () => { step = Math.min(4, step + 1); appHost.renderMainView(); });
}

// ---------- DIAGNOSE ----------

export function renderProtoDiagnoseC(view) {
  if (protoEnsureComparison(view)) return;
  const m = buildProtoModel();
  for (const uid of [...basket]) if (!m.items.some(i => i.uid === uid)) basket.delete(uid);

  const root = document.createElement('section');
  root.className = 'proto-root proto-c';
  view.appendChild(root);

  const body =
    step === 1 ? stepVerdict(m) :
    step === 2 ? stepEvidence(m) :
    step === 3 ? stepPickGaps(m) :
    stepHandOff(m);

  root.innerHTML = `${stepperHtml(step)}${partialEvidenceBanner(m)}<div class="pc-stage">${body}</div>`;
  wireStepper(root);
  wireStage(root, m);
}

function stepVerdict(m) {
  const ig = m.diagnostic.overall.instrumentGrade;
  const verdict = m.diagnostic.overall.verdict;
  const audit = m.diagnostic.overall.audit;
  return `
    <div class="pc-verdict">
      <div class="pc-verdict-main">
        <div class="pa-verdict-letter tier-${escapeHtml(ig.tier)}">${escapeHtml(ig.letter)}</div>
        <div>
          <span class="pa-verdict-eyebrow">DIAGNOSTIC GRADE · ${escapeHtml(ig.label)}</span>
          <span class="pa-verdict-word ${escapeHtml(verdict.level)}">${escapeHtml(verdict.word)}</span>
          <span class="pa-verdict-stats">
            <strong>${m.overallPct}%</strong> score
            ${chip(audit.passes ? 'pass' : 'fail', `AUDIT ${audit.status}`)}
            ${chip(m.diagnostic.trust.hasMcpSource ? 'pass' : 'warn', m.diagnostic.trust.hasMcpSource ? 'VERIFIED LIVE' : 'UNVERIFIED')}
          </span>
          ${m.biggestGap ? `<p class="pc-verdict-gap">Biggest drag: <strong>${m.biggestGap.n}</strong> artefact${m.biggestGap.n === 1 ? '' : 's'} ${escapeHtml(m.biggestGap.label)} — ${escapeHtml(fmtUnits(m.biggestGap.units))} badness units.</p>` : ''}
        </div>
      </div>
      <aside class="pa-ladder">${ladderHtml(ig, m.overallPct)}</aside>
    </div>
    ${navHtml(1, { nextLabel: 'See the evidence →' })}`;
}

function stepEvidence(m) {
  const d = m.diagnostic;
  const critList = (criteria) => `
    <ul class="pb-crit">${criteria.map(c => `
      <li>${c.informational ? chip('info', c.pass ? 'YES' : 'NO') : criterionChip(c)}
        <span class="pb-crit-name" title="${escapeHtml(c.detail)}">${escapeHtml(c.label)}</span></li>`).join('')}
    </ul>`;
  const g = d.traceabilityGraph;
  const drift = (m.haveB && m.diff) ? `
    <div class="pc-card">
      <header>Signal drift</header>
      <div class="pb-lattice">
        ${donutSvg([{ value: m.totals.aligned, color: 'var(--pass-border)' }, { value: m.weighted.totalBadness, color: 'var(--ink-4)' }], m.weighted.healthPct + '%', { size: 88 })}
        <ul class="pb-lattice-legend">
          <li>${m.totals.aligned} aligned</li>
          <li>${m.totals.drifted} drifted</li>
          <li>${m.totals.onlyInA} ${m.mode === 'drift' ? 'declared-not-live' : 'beyond target'}</li>
          <li>${m.totals.onlyInB} ${m.mode === 'drift' ? 'live-not-declared' : 'missing vs target'}</li>
        </ul>
      </div>
      ${scaffoldOosNotes(m)}
    </div>` : `
    <div class="pc-card">
      <header>Signal drift</header>
      <div class="pb-panel-note">Load a Pack B from the header picker to verify against live state.</div>
    </div>`;
  const evRows = buildEvidenceRows(d);
  return `
    <div class="pc-evidence">
      ${drift}
      ${g?.rollup ? `
      <div class="pc-card">
        <header>Requirement chains</header>
        <div class="pb-chain-cells">
          <span class="pb-cell is-pass"><strong>${g.rollup.intact}</strong> intact</span>
          <span class="pb-cell is-partial"><strong>${g.rollup.partial}</strong> partial</span>
          <span class="pb-cell is-fail"><strong>${g.rollup.broken}</strong> broken</span>
          <span class="pb-cell is-info"><strong>${g.rollup.undeclared}</strong> live-only</span>
        </div>
      </div>` : ''}
      <div class="pc-card"><header>Coverage — right signals?</header>${critList(d.coverage.criteria)}</div>
      <div class="pc-card"><header>Trust — honest signals?</header>${verificationNote(m)}${critList(d.trust.criteria)}</div>
      <div class="pc-card"><header>Operability — informational, never scored</header>
        <div class="pb-panel-note">${operabilityNote(m)}</div>${critList(d.operability?.criteria || [])}</div>
      <div class="pc-card pc-card-wide">
        <header>Evidence ledger — expected vs observed</header>
        <table class="pa-evidence-table"><tbody>${evRows.map(r => `
          <tr><td class="e-field">${escapeHtml(r.field)}</td><td class="e-obs">${escapeHtml(r.obs)}</td>
          <td>${r.informational ? chip('info', r.pass ? 'YES · INFO' : 'NO · INFO') : criterionChip(r)}</td></tr>`).join('')}</tbody></table>
      </div>
    </div>
    ${navHtml(2, { nextLabel: 'Pick the gaps →' })}`;
}

function stepPickGaps(m) {
  if (!m.items.length) {
    return `
      <div class="pc-card pc-card-wide">
        <header>Nothing to pick</header>
        <div class="pb-panel-note">${m.haveB ? `Every concrete artefact aligns with ${escapeHtml(m.bName)}.` : 'Load a Pack B to compute the gap set.'}</div>
      </div>
      ${navHtml(3, { nextLabel: 'Hand off →' })}`;
  }
  const projection = basket.size ? projectGrade(basket) : null;
  const gauge = projectionGauge(m, projection);
  return `
    <div class="pc-pick">
      <div class="pc-pick-list">
        <div class="pc-pick-tools">
          <button type="button" class="proto-act is-mini" id="pc-pick-all">select all</button>
          <button type="button" class="proto-act is-mini" id="pc-pick-none">clear</button>
          <button type="button" class="proto-act is-mini" id="pc-pick-critical">critical only (w ≥ 1.0)</button>
          <span class="pc-pick-hint">ordered by weighted badness — the engine's own cost model</span>
        </div>
        <ul class="pc-gaps">
          ${m.items.map(i => `
            <li class="pc-gap${basket.has(i.uid) ? ' is-picked' : ''}" data-uid="${escapeHtml(i.uid)}">
              <label><input type="checkbox" ${basket.has(i.uid) ? 'checked' : ''}></label>
              <span class="proto-lnum">${i.layer}</span>
              <span class="pc-gap-label">${escapeHtml(i.label)}</span>
              ${i.fields?.length ? `<span class="pa-work-fields">${escapeHtml(i.fields.slice(0, 3).join(', '))}</span>` : ''}
              ${badnessClassChip(i)}
              <span class="pa-work-w">w ${escapeHtml(fmtUnits(i.badness))}</span>
              ${fixChip(i.fix)}
            </li>`).join('')}
        </ul>
        ${scaffoldOosNotes(m)}
      </div>
      <aside class="pc-rail">${gauge}</aside>
    </div>
    ${navHtml(3, { nextLabel: `Hand off ${basket.size} gap${basket.size === 1 ? '' : 's'} →`, canNext: basket.size > 0 })}`;
}

function stepHandOff(m) {
  const picked = m.items.filter(i => basket.has(i.uid));
  const dep = deploySelectionFromItems(picked, basket);
  const byFix = {};
  for (const i of picked) byFix[i.fix] = (byFix[i.fix] || 0) + 1;
  const projection = basket.size ? projectGrade(basket) : null;
  const sentence = projection ? projectionSentence(projection, picked.length) : '';
  return `
    <div class="pc-handoff">
      <div class="pc-card pc-card-wide">
        <header>The plan</header>
        <p class="pc-handoff-lede">You picked <strong>${picked.length}</strong> gap${picked.length === 1 ? '' : 's'} —
          ${Object.entries(byFix).map(([f, n]) => `${n} ${escapeHtml(f)}`).join(' · ') || 'none'}.</p>
        ${sentence ? `<p class="pa-gap-projection">${escapeHtml(sentence)}</p>` : ''}
        <div class="pc-handoff-actions">
          ${dep.identities.size ? `<button type="button" class="proto-act is-primary" id="pc-deploy">⇪ Deploy ${dep.identities.size} now (${dep.rows} rows)</button>` : ''}
          <button type="button" class="proto-act" id="pc-to-remediate">Open the Remediate queue →</button>
          <button type="button" class="proto-act is-quiet" id="pc-reverify">↻ Re-verify after deploying</button>
        </div>
        <p class="proto-verification-note">Hand-off is verification-scoped: deploys land in the platform, retrofeeds land as a repo patch — the grade only moves when the next live verification confirms it.</p>
      </div>
    </div>
    ${navHtml(4)}`;
}

function projectionGauge(m, projection) {
  const before = m.diagnostic.overall.instrumentGrade;
  if (!basket.size) {
    return `<div class="pc-gauge"><span class="pc-gauge-key">PROJECTED GRADE</span>
      <div class="pc-gauge-now">now: <strong>${escapeHtml(before.letter)}</strong> ${m.overallPct}%</div>
      <div class="pb-panel-note">pick gaps to project the post-fix grade — computed by re-running the verdict engine on the hypothetical diff</div></div>`;
  }
  if (!projection) return '';
  const after = projection.after.overall.instrumentGrade;
  const moved = projection.afterPct > projection.beforePct;
  return `
    <div class="pc-gauge${moved ? ' is-moved' : ''}">
      <span class="pc-gauge-key">PROJECTED GRADE</span>
      <div class="pc-gauge-pair">
        <span class="pc-gauge-before">${escapeHtml(projection.before.overall.instrumentGrade.letter)}<em>${projection.beforePct}%</em></span>
        <span class="pc-gauge-arrow">→</span>
        <span class="pc-gauge-after">${escapeHtml(after.letter)}<em>${projection.afterPct}%</em></span>
      </div>
      <div class="pb-panel-note">${moved
        ? 're-ran the grade engine on the post-fix diff · chains, freshness and chaos not projected'
        : projection.chainAnchored
          ? 'grade is anchored on requirement-chain integrity — these fixes repair chains on the next live verification'
          : 'these picks do not move the scored criteria yet'}</div>
    </div>`;
}

function wireStage(root, m) {
  root.querySelectorAll('.pc-gap input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const uid = cb.closest('.pc-gap').dataset.uid;
      if (cb.checked) basket.add(uid); else basket.delete(uid);
      appHost.renderMainView();
    });
  });
  root.querySelector('#pc-pick-all')?.addEventListener('click', () => {
    for (const i of m.items) basket.add(i.uid);
    appHost.renderMainView();
  });
  root.querySelector('#pc-pick-none')?.addEventListener('click', () => {
    basket.clear();
    appHost.renderMainView();
  });
  root.querySelector('#pc-pick-critical')?.addEventListener('click', () => {
    basket.clear();
    for (const i of m.items) if (i.badness >= 1) basket.add(i.uid);
    appHost.renderMainView();
  });
  const picked = m.items.filter(i => basket.has(i.uid));
  const dep = deploySelectionFromItems(picked, basket);
  root.querySelector('#pc-deploy')?.addEventListener('click', () =>
    appHost.openDeployModal({ packId: state.selectedPackId, presetIdentities: dep.identities }));
  root.querySelector('#pc-to-remediate')?.addEventListener('click', () => {
    state.view = 'compile';
    appHost.renderMainView();
  });
  root.querySelector('#pc-reverify')?.addEventListener('click', () => {
    state.view = 'journeys';
    appHost.renderMainView();
  });
}

// ---------- REMEDIATE — the triage queue + basket rail ----------

export function renderProtoRemediateC(view) {
  if (protoEnsureComparison(view)) return;
  const m = buildProtoModel();
  for (const uid of [...basket]) if (!m.items.some(i => i.uid === uid)) basket.delete(uid);

  const root = document.createElement('section');
  root.className = 'proto-root proto-c';
  view.appendChild(root);

  if (!m.items.length) {
    root.innerHTML = `
      <div class="pc-card pc-card-wide">
        <header>Triage queue</header>
        <div class="pb-panel-note">${m.haveB ? `Empty — every concrete artefact aligns with ${escapeHtml(m.bName)}.` : 'Load a Pack B from the header picker to compute the queue.'}</div>
      </div>`;
    return;
  }

  const picked = m.items.filter(i => basket.has(i.uid));
  const dep = deploySelectionFromItems(picked, basket);
  const projection = basket.size ? projectGrade(basket) : null;
  const pct = Math.round((basket.size / m.items.length) * 100);

  root.innerHTML = `
    ${partialEvidenceBanner(m)}
    <div class="pc-remediate">
      <div class="pc-pick-list">
        <header class="pb-queue-head">
          <span class="pb-queue-title">Triage queue</span>
          <span class="pb-queue-sub">ordered by weighted badness · check a row to add it to the basket</span>
        </header>
        <div class="pa-progress">
          <span class="pa-progress-label">in the basket</span>
          <div class="pa-progress-bar"><span style="width:${pct}%"></span></div>
          <span class="pa-progress-n">${basket.size} of ${m.items.length}</span>
        </div>
        <ul class="pc-gaps">
          ${m.items.map(i => `
            <li class="pc-gap${basket.has(i.uid) ? ' is-picked' : ''}" data-uid="${escapeHtml(i.uid)}">
              <label><input type="checkbox" ${basket.has(i.uid) ? 'checked' : ''}></label>
              <span class="proto-lnum">${i.layer}</span>
              <span class="pc-gap-label">${escapeHtml(i.label)}</span>
              ${i.fields?.length ? `<span class="pa-work-fields">${escapeHtml(i.fields.slice(0, 3).join(', '))}</span>` : ''}
              ${badnessClassChip(i)}
              <span class="pa-work-w">w ${escapeHtml(fmtUnits(i.badness))}</span>
              ${fixChip(i.fix)}
            </li>`).join('')}
        </ul>
        ${scaffoldOosNotes(m)}
      </div>
      <aside class="pc-rail">
        ${projectionGauge(m, projection)}
        <div class="pc-basket">
          <span class="pc-gauge-key">DEPLOY BASKET</span>
          <div class="pc-basket-n"><strong>${dep.identities.size}</strong> deployable · ${dep.rows} rows</div>
          <div class="pc-basket-n">${picked.filter(i => i.fix === 'retrofeed' || i.fix === 'adopt').length} retrofeed · ${picked.filter(i => i.fix === 'reconcile').length} field decisions · ${picked.filter(i => i.fix === 'manual' || i.fix === 'beyond-target').length} manual</div>
          ${dep.identities.size ? `<button type="button" class="proto-act is-primary" id="pc-r-deploy">⇪ Deploy the basket</button>` : ''}
          <button type="button" class="proto-act is-quiet" id="pc-r-reverify">↻ Re-verify</button>
        </div>
      </aside>
    </div>
  `;

  root.querySelectorAll('.pc-gap input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const uid = cb.closest('.pc-gap').dataset.uid;
      if (cb.checked) basket.add(uid); else basket.delete(uid);
      appHost.renderMainView();
    });
  });
  root.querySelector('#pc-r-deploy')?.addEventListener('click', () =>
    appHost.openDeployModal({ packId: state.selectedPackId, presetIdentities: dep.identities }));
  root.querySelector('#pc-r-reverify')?.addEventListener('click', () => {
    state.view = 'journeys';
    appHost.renderMainView();
  });
}
