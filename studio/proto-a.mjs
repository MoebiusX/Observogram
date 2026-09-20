// studio/proto-a.mjs
//
// PROTOTYPE A — Verdict-first narrative (?proto=a).
//
// Diagnose: one hero answer (the verdict + the ONE thing costing the most
// grade), a persistent action bar, then the five reports as chapters you
// open — collapsed by default, the dominant problem's chapter pre-opened.
// Remediate: the highest-value fix leads; the worklist is banded by
// impact (badness weight), with a session progress meter and a sticky
// deploy bar that draws the line from fixes to grade.

import { state } from './state.mjs';
import { escapeHtml } from './util.mjs';
import { host as appHost } from './host.mjs';
import {
  buildProtoModel, protoEnsureComparison, projectGrade, projectionSentence,
  ladderHtml, chip, criterionChip, donutSvg, fmtUnits, fixChip, badnessClassChip,
  partialEvidenceBanner, scaffoldOosNotes, verificationNote, operabilityNote,
  buildEvidenceRows, deploySelectionFromItems,
} from './proto-shared.mjs';

// Session-only "addressed" marks for the Remediate worklist progress
// meter. Deliberately not persisted: the honest progress signal across
// sessions is the next live verification, not a checkbox.
const addressed = new Set();

// ---------- DIAGNOSE ----------

export function renderProtoDiagnoseA(view) {
  if (protoEnsureComparison(view)) return;
  const m = buildProtoModel();
  const ig = m.diagnostic.overall.instrumentGrade;
  const verdict = m.diagnostic.overall.verdict;
  const audit = m.diagnostic.overall.audit;

  const root = document.createElement('section');
  root.className = 'proto-root proto-a';
  view.appendChild(root);

  // --- the one thing costing the most grade ---
  const projection = m.haveB ? projectGrade(null) : null;
  const gapUids = m.biggestGap ? new Set(m.items.filter(i => i.kind === m.biggestGap.kind).map(i => i.uid)) : null;
  const gapProjection = gapUids && gapUids.size ? projectGrade(gapUids) : null;
  const gapSentence = gapProjection ? projectionSentence(gapProjection, gapUids.size) : '';

  const heroGap = !m.haveB ? `
      <div class="pa-gap">
        <span class="pa-gap-eyebrow">DEEPEN THE VERDICT</span>
        <p class="pa-gap-lede">This verdict reads <strong>Pack A on its own</strong>. Load a <strong>Pack B</strong>
        from the header picker to verify against live state — drift, shadow signals, and the
        full evidence drill unlock with it.</p>
      </div>`
    : m.biggestGap ? `
      <div class="pa-gap">
        <span class="pa-gap-eyebrow">BIGGEST DRAG ON THE GRADE</span>
        <p class="pa-gap-lede"><strong class="pa-gap-n">${m.biggestGap.n}</strong> artefact${m.biggestGap.n === 1 ? '' : 's'}
        <strong>${escapeHtml(m.biggestGap.label)}</strong> — ${escapeHtml(fmtUnits(m.biggestGap.units))} of
        ${escapeHtml(fmtUnits(m.weighted.totalBadness))} weighted badness units.</p>
        ${gapSentence ? `<p class="pa-gap-projection">${escapeHtml(gapSentence)}</p>` : ''}
      </div>`
    : `
      <div class="pa-gap is-clean">
        <span class="pa-gap-eyebrow">NO DRIFT DETECTED</span>
        <p class="pa-gap-lede">Every concrete artefact aligns with <strong>${escapeHtml(m.bName)}</strong>.
        Remaining grade loss comes from the criteria below, not from drift.</p>
      </div>`;

  root.innerHTML = `
    <header class="pa-hero">
      <div class="pa-verdict">
        <div class="pa-verdict-letter tier-${escapeHtml(ig.tier)}">${escapeHtml(ig.letter)}</div>
        <div class="pa-verdict-body">
          <span class="pa-verdict-eyebrow">DIAGNOSTIC GRADE · ${escapeHtml(ig.label)}</span>
          <span class="pa-verdict-word ${escapeHtml(verdict.level)}">${escapeHtml(verdict.word)}</span>
          <span class="pa-verdict-stats">
            <strong>${m.overallPct}%</strong> score
            ${chip(audit.passes ? 'pass' : 'fail', `AUDIT ${audit.status}`)}
            ${chip(m.diagnostic.trust.hasMcpSource ? 'pass' : 'warn', m.diagnostic.trust.hasMcpSource ? 'VERIFIED LIVE' : 'UNVERIFIED')}
          </span>
        </div>
      </div>
      ${heroGap}
      <aside class="pa-ladder">${ladderHtml(ig, m.overallPct, { compact: true })}</aside>
    </header>

    <div class="proto-actionbar" id="pa-actions"></div>
    ${partialEvidenceBanner(m)}
    <div id="pa-chapters"></div>
  `;

  renderActionBar(root.querySelector('#pa-actions'), m);
  renderChapters(root.querySelector('#pa-chapters'), m, projection);
}

function renderActionBar(host, m) {
  const dep = m.deployableSet;
  host.innerHTML = `
    ${m.mode === 'drift' && dep.identities.size ? `
      <button type="button" class="proto-act is-primary" id="pa-deploy"
        title="Open the deploy modal preselected with the deployable declared-not-live artefacts (${dep.rows} row${dep.rows === 1 ? '' : 's'})">
        ⇪ Deploy the missing set (${dep.identities.size})</button>` : ''}
    ${m.totals.onlyInB ? `
      <button type="button" class="proto-act" id="pa-retrofeed"
        title="Open Remediate with the retrofeed set selected — adopt the live shadow signals into the pack">
        ⤵ Plan retrofeed (${m.totals.onlyInB})</button>` : ''}
    <button type="button" class="proto-act" id="pa-reverify"
      title="Open Journeys to re-run the live verification">↻ Re-verify</button>
    <button type="button" class="proto-act is-quiet" id="pa-remediate">Open Remediate →</button>
  `;
  host.querySelector('#pa-deploy')?.addEventListener('click', () =>
    appHost.openDeployModal({ packId: state.selectedPackId, presetIdentities: m.deployableSet.identities }));
  host.querySelector('#pa-retrofeed')?.addEventListener('click', () => {
    state.remediateOp = 'retrofeed';
    state.view = 'compile';
    appHost.renderMainView();
  });
  host.querySelector('#pa-reverify')?.addEventListener('click', () => {
    state.view = 'journeys';
    appHost.renderMainView();
  });
  host.querySelector('#pa-remediate')?.addEventListener('click', () => {
    state.view = 'compile';
    appHost.renderMainView();
  });
}

function renderChapters(host, m, projection) {
  const d = m.diagnostic;
  const chapters = [];

  // --- chapter 1: signal drift (only with a diff) ---
  if (m.haveB && m.diff) {
    const C_ALIGNED = 'var(--pass-border)';
    const C_DRIFTED = 'rgb(150, 90, 200)';
    const C_DECL = 'rgb(200, 70, 40)';
    const C_SHADOW = 'rgb(180, 120, 0)';
    const aLabel = m.mode === 'drift' ? 'Declared, not live' : 'Beyond target';
    const bLabel = m.mode === 'drift' ? 'Live, not declared' : 'Missing vs target';
    const layerRows = m.layers.map(r => `
      <tr>
        <th><span class="proto-lnum">${r.L}</span> ${escapeHtml(r.name)}</th>
        <td class="is-aligned">${r.aligned.length}</td>
        <td class="is-drifted">${r.drifted.length}</td>
        <td class="is-decl">${r.onlyInA.length}</td>
        <td class="is-shadow">${r.onlyInB.length}${r.outOfScope.length ? ` <span class="proto-oos-inline">+${r.outOfScope.length} oos</span>` : ''}</td>
      </tr>`).join('');
    const projSentence = projection ? projectionSentence(projection, m.items.length) : '';
    chapters.push({
      id: 'drift', title: 'Signal drift — declared vs live', open: !!m.biggestGap,
      meta: `${chip(m.weighted.healthPct >= 85 ? 'pass' : m.weighted.healthPct >= 60 ? 'partial' : 'fail', m.weighted.healthPct + '% health')} ${fmtUnits(m.weighted.totalBadness)} badness units`,
      body: `
        <div class="pa-drift-charts">
          <figure>${donutSvg([{ value: m.totals.aligned, color: C_ALIGNED }, { value: m.weighted.totalBadness, color: 'var(--ink-4)' }], m.weighted.healthPct + '%')}<figcaption>weighted health</figcaption></figure>
          <figure>${donutSvg([
            { value: m.weighted.driftedUnits, color: C_DRIFTED },
            { value: m.weighted.onlyInAUnits, color: C_DECL },
            { value: m.weighted.onlyInBUnits, color: C_SHADOW },
          ], fmtUnits(m.weighted.totalBadness))}<figcaption>weighted badness</figcaption></figure>
          <ul class="pa-drift-legend">
            <li><span class="sw" style="background:${C_ALIGNED}"></span>${m.totals.aligned} aligned · w 0</li>
            <li><span class="sw" style="background:${C_DRIFTED}"></span>${m.totals.drifted} drifted · w per field</li>
            <li><span class="sw" style="background:${C_DECL}"></span>${m.totals.onlyInA} ${escapeHtml(aLabel.toLowerCase())} · w ${m.mode === 'drift' ? '1.0' : '0.15'}</li>
            <li><span class="sw" style="background:${C_SHADOW}"></span>${m.totals.onlyInB} ${escapeHtml(bLabel.toLowerCase())} · w ${m.mode === 'drift' ? '0.15' : '1.0'}</li>
          </ul>
        </div>
        <p class="drift-risk-note">Weighted badness: ${m.mode === 'drift' ? 'declared-not-live = 1.0' : 'missing target artefacts = 1.0'}; drifted = 0.5 by default, 1.0 for decision-bearing fields, 0.1 for cosmetic fields; ${m.mode === 'drift' ? 'live-not-declared' : 'beyond-target extras'} = 0.15. Health = aligned / (aligned + weighted badness).</p>
        <table class="pa-drift-table">
          <thead><tr><th>Layer</th><th>Aligned</th><th>Drifted</th><th>${escapeHtml(aLabel)}</th><th>${escapeHtml(bLabel)}</th></tr></thead>
          <tbody>${layerRows}</tbody>
        </table>
        ${scaffoldOosNotes(m)}
        ${projSentence ? `<p class="pa-gap-projection">${escapeHtml(projSentence)}</p>` : ''}
      `,
    });
  }

  // --- chapter 2: requirement chains ---
  const g = d.traceabilityGraph;
  if (g?.rollup && (g.branches || []).length) {
    const r = g.rollup;
    chapters.push({
      id: 'chains', title: 'Requirement chains — SLO/SLI derivation integrity', open: false,
      meta: `${chip(r.broken ? 'fail' : r.partial ? 'partial' : 'pass', `${r.intact}/${r.declaredTotal} intact`)} ${Math.round((r.integrityMean || 0) * 100)}% integrity`,
      body: `
        <div class="pa-chain-rollup">
          ${chip('pass', `${r.intact} INTACT`)} ${chip('partial', `${r.partial} PARTIAL`)}
          ${chip('fail', `${r.broken} BROKEN`)} ${chip('info', `${r.undeclared} LIVE-ONLY`)}
        </div>
        <ul class="pa-chain-list">
          ${(g.branches || []).map(b => `
            <li class="pa-chain is-${escapeHtml(b.verdict)}">
              <span class="pa-chain-title">${escapeHtml(b.title || b.rootKey || 'requirement')}</span>
              ${chip(b.verdict === 'intact' ? 'pass' : b.verdict === 'broken' ? 'fail' : b.verdict === 'partial' ? 'partial' : 'info', String(b.verdict || '').toUpperCase())}
              <span class="pa-chain-meta">${escapeHtml(String(b.integrityPct ?? Math.round((b.integrity || 0) * 100)))}% · ${escapeHtml(b.confidence === 'inferred' ? 'inferred edges' : 'declared edges')}</span>
            </li>`).join('')}
        </ul>`,
    });
  }

  // --- chapters 3+4: coverage & trust criteria ---
  const critBody = (criteria) => `
    <table class="pa-crit-table">
      <thead><tr><th></th><th>Criterion</th><th>Observed</th><th>Expected</th></tr></thead>
      <tbody>${criteria.map(c => `
        <tr><td>${criterionChip(c)}</td><td class="c-name">${escapeHtml(c.label)}</td>
        <td class="c-obs">${escapeHtml(c.detail)}</td><td class="c-exp">${escapeHtml(c.sub)}</td></tr>`).join('')}
      </tbody>
    </table>`;
  chapters.push({
    id: 'coverage', title: 'Coverage — are we observing the right signals?', open: false,
    meta: `${d.coverage.passed}/${d.coverage.total} criteria`,
    body: critBody(d.coverage.criteria),
  });
  chapters.push({
    id: 'trust', title: 'Trust — can we trust what the signals show?', open: false,
    meta: `${Number.isInteger(d.trust.passed) ? d.trust.passed : d.trust.passed.toFixed(2)}/${d.trust.total} criteria`,
    body: `${verificationNote(m)}${critBody(d.trust.criteria)}`,
  });
  chapters.push({
    id: 'operability', title: 'Operability — can oncall act on what it sees?', open: false,
    meta: chip('info', 'INFORMATIONAL · NOT SCORED'),
    body: `
      <div class="diag-banner"><span class="diag-banner-key">INFO</span> ${operabilityNote(m)}</div>
      ${critBody(d.operability.criteria || [])}`,
  });

  // --- chapter 5: evidence ledger ---
  const evRows = buildEvidenceRows(d);
  chapters.push({
    id: 'evidence', title: 'Evidence — expected vs observed', open: false,
    meta: `${evRows.filter(r => !r.informational && r.pass).length}/${evRows.filter(r => !r.informational).length} attested · +${evRows.filter(r => r.informational).length} informational`,
    body: `
      <table class="pa-evidence-table">
        <thead><tr><th>Field</th><th>Expected</th><th>Observed</th><th>Status</th></tr></thead>
        <tbody>${evRows.map(r => `
          <tr><td class="e-field">${escapeHtml(r.field)}</td><td class="e-exp">${escapeHtml(r.exp)}</td>
          <td class="e-obs">${escapeHtml(r.obs)}</td>
          <td>${r.informational ? chip('info', r.pass ? 'YES · INFO' : 'NO · INFO') : criterionChip(r)}</td></tr>`).join('')}
        </tbody>
      </table>`,
  });

  host.innerHTML = chapters.map(c => `
    <details class="pa-chapter" id="pa-ch-${c.id}" ${c.open ? 'open' : ''}>
      <summary>
        <span class="pa-chapter-title">${escapeHtml(c.title)}</span>
        <span class="pa-chapter-meta">${c.meta}</span>
      </summary>
      <div class="pa-chapter-body">${c.body}</div>
    </details>`).join('');
}

// ---------- REMEDIATE ----------

export function renderProtoRemediateA(view) {
  if (protoEnsureComparison(view)) return;
  const m = buildProtoModel();

  const root = document.createElement('section');
  root.className = 'proto-root proto-a';
  view.appendChild(root);

  if (!m.items.length) {
    root.innerHTML = `
      <header class="pa-hero">
        <div class="pa-gap is-clean">
          <span class="pa-gap-eyebrow">NOTHING TO REMEDIATE</span>
          <p class="pa-gap-lede">${m.haveB
            ? `Every concrete artefact aligns with <strong>${escapeHtml(m.bName)}</strong>. Re-verify after the next deploy to keep it that way.`
            : 'Load a <strong>Pack B</strong> from the header picker to compute the remediation set (drift, shadow signals, gaps to target).'}</p>
        </div>
      </header>`;
    return;
  }

  // Drop addressed marks that no longer exist in the set (re-verified away).
  for (const uid of [...addressed]) if (!m.items.some(i => i.uid === uid)) addressed.delete(uid);

  const top = m.items[0];
  const allProjection = projectGrade(null);
  const allSentence = allProjection ? projectionSentence(allProjection, m.items.length) : '';
  const done = addressed.size;
  const pct = Math.round((done / m.items.length) * 100);

  const bands = [
    { id: 'critical', title: 'Critical — full badness weight', test: (i) => i.badness >= 1 },
    { id: 'moderate', title: 'Moderate — drifted fields', test: (i) => i.badness >= 0.3 && i.badness < 1 },
    { id: 'low', title: 'Low — shadow signals & cosmetics', test: (i) => i.badness < 0.3 },
  ];

  root.innerHTML = `
    <header class="pa-hero pa-hero-remediate">
      <div class="pa-gap">
        <span class="pa-gap-eyebrow">HIGHEST-VALUE FIX</span>
        <p class="pa-gap-lede"><strong>${escapeHtml(top.label)}</strong>
          <span class="proto-lnum">${top.layer}</span> ${badnessClassChip(top)} ${fixChip(top.fix)}
          — ${escapeHtml(fmtUnits(top.badness))} badness unit${top.badness === 1 ? '' : 's'}, the single biggest drag.</p>
        ${allSentence ? `<p class="pa-gap-projection">${escapeHtml(allSentence)}</p>` : ''}
      </div>
      <div class="pa-progress">
        <span class="pa-progress-label">addressed this session</span>
        <div class="pa-progress-bar"><span style="width:${pct}%"></span></div>
        <span class="pa-progress-n">${done} of ${m.items.length}</span>
        <span class="pa-progress-note">progress resets on re-verification — the live diff is the source of truth</span>
      </div>
    </header>
    ${partialEvidenceBanner(m)}
    <div id="pa-bands"></div>
    <div class="proto-deploybar" id="pa-deploybar"></div>
  `;

  const bandsHost = root.querySelector('#pa-bands');
  for (const band of bands) {
    const items = m.items.filter(band.test);
    if (!items.length) continue;
    const el = document.createElement('section');
    el.className = `pa-band is-${band.id}`;
    el.innerHTML = `
      <header class="pa-band-head">
        <span class="pa-band-title">${escapeHtml(band.title)}</span>
        <span class="pa-band-count">${items.length}</span>
      </header>
      <ul class="pa-worklist">
        ${items.map(i => `
          <li class="pa-work ${addressed.has(i.uid) ? 'is-done' : ''}" data-uid="${escapeHtml(i.uid)}">
            <label class="pa-work-check"><input type="checkbox" ${addressed.has(i.uid) ? 'checked' : ''}></label>
            <span class="proto-lnum">${i.layer}</span>
            <span class="pa-work-label">${escapeHtml(i.label)}</span>
            ${i.fields?.length ? `<span class="pa-work-fields">${escapeHtml(i.fields.slice(0, 3).join(', '))}</span>` : ''}
            ${badnessClassChip(i)}
            <span class="pa-work-w">w ${escapeHtml(fmtUnits(i.badness))}</span>
            ${fixChip(i.fix)}
            ${i.deployable ? `<button type="button" class="proto-act is-mini" data-deploy="${escapeHtml(i.uid)}">deploy</button>` : ''}
          </li>`).join('')}
      </ul>`;
    bandsHost.appendChild(el);
  }

  bandsHost.querySelectorAll('.pa-work input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const uid = cb.closest('.pa-work').dataset.uid;
      if (cb.checked) addressed.add(uid); else addressed.delete(uid);
      appHost.renderMainView();
    });
  });
  bandsHost.querySelectorAll('[data-deploy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = m.items.find(i => i.uid === btn.dataset.deploy);
      if (!item?.deployIdentity) return;
      appHost.openDeployModal({ packId: state.selectedPackId, presetIdentities: new Set([item.deployIdentity]) });
    });
  });

  // Sticky deploy bar — the whole deployable set, with the grade line.
  const bar = root.querySelector('#pa-deploybar');
  const dep = deploySelectionFromItems(m.items);
  const depUids = new Set(m.items.filter(i => i.deployable && i.deployIdentity).map(i => i.uid));
  const depProjection = depUids.size ? projectGrade(depUids) : null;
  bar.innerHTML = `
    ${dep.identities.size ? `
      <button type="button" class="proto-act is-primary" id="pa-deploy-all">⇪ Deploy the missing set (${dep.identities.size})</button>` : ''}
    ${m.totals.onlyInB ? `<button type="button" class="proto-act" id="pa-plan-retrofeed">⤵ Retrofeed ${m.totals.onlyInB} into the pack (classic view)</button>` : ''}
    ${depProjection && depProjection.afterPct > depProjection.beforePct
      ? `<span class="proto-deploybar-projection">deploying moves the grade
          ${escapeHtml(depProjection.before.overall.instrumentGrade.letter)} (${depProjection.beforePct}%) →
          ${escapeHtml(depProjection.after.overall.instrumentGrade.letter)} (${depProjection.afterPct}%)</span>`
      : depProjection?.chainAnchored
        ? '<span class="proto-deploybar-projection">grade is anchored on requirement-chain integrity — deploys repair chains on the next live verification</span>'
        : ''}
  `;
  bar.querySelector('#pa-deploy-all')?.addEventListener('click', () =>
    appHost.openDeployModal({ packId: state.selectedPackId, presetIdentities: dep.identities }));
  bar.querySelector('#pa-plan-retrofeed')?.addEventListener('click', () => {
    state.remediateOp = 'retrofeed';
    const url = new URL(window.location.href);
    url.searchParams.delete('proto');
    window.location.href = url.toString();
  });
}
