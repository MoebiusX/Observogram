// studio/remediation-flow-view.mjs — the response path (GAP batch 2, B3.3):
// the "what next" panel from a firing alert to the remediation the pack
// declares for it, drawn on Diagnose (inside the assessment report, with its
// sticky-index entry) and on Remediate (after the plan), from the same HTML.
//
// docs/UI_CONVENTIONS.md §1–4: the app is reached through the host seam
// (`appHost.openDeployModal`, `appHost.renderMainView`), never app.mjs; the
// loader (`remediationFlowEngine`, the import injectable) and the pure model
// (`buildRemediationFlowViewModel`: every input explicit, no `state` read,
// testable under node:test) are separate exports from the renderers
// (`remediationFlowHtml`, `renderRemediationFlow(container, model, host)`);
// the CSS zone is `.rflow-*` in studio/ux-remediate.css.
//
// The engine (tools/lib/remediation-flow.mjs, a listed module) is loaded the
// house way, at call time, through the server's /lib mount — the static
// bundle's import map resolves the same specifier (studio/brand.mjs's
// pattern): the first render kicks the import off and repaints once when it
// lands; a rejection is cached as null and the panel stays off (console.warn
// once). Nothing is imported, built or drawn for a pack without
// `spec.remediation` (`packDeclaresRemediation` is the gate), so the eight
// catalogue packs without one and every golden are untouched.

import { escapeHtml } from './util.mjs';
import { plural } from './ux-kit.mjs';
import { host as appHost } from './host.mjs';
import { compareModeFor } from './diagnostic-grade.mjs';
import { deploySurfaceForArtefact } from './artifact-model.mjs';

export const ENGINE_SPECIFIER = '/lib/remediation-flow.mjs';
export const SCREENS = Object.freeze(['diagnose', 'remediate']);

// What the chips say, per state, for each other side the comparison names.
const STATE_LABELS = Object.freeze({
  live: { declared: 'declared', live: 'live', drifted: 'drifted', missing: 'not live', unhealthy: 'not evaluating', unverified: 'unverified', placeholder: 'placeholder', uncompared: 'not compared' },
  baseline: { declared: 'declared', live: 'in the baseline', drifted: 'drifted', missing: 'not in the baseline', unhealthy: 'not evaluating', unverified: 'unverified', placeholder: 'placeholder', uncompared: 'not compared' },
});
const TIER_LABELS = Object.freeze({ annotation: 'by annotation', 'rule-name': 'by rule name', 'burn-name': 'by burn-rule name', slo: 'by SLO' });

// ---------- the gate ----------

/** True when the adapted pack declares at least one remediation (an L4 healing artefact). */
export function packDeclaresRemediation(pack) {
  return Array.isArray(pack?.layers?.L4?.healing) && pack.layers.L4.healing.length > 0;
}

// ---------- the loader ----------

let engine;          // undefined: not asked yet or loading; null: failed; else the module
let loading = null;  // the one in-flight import

// The default import is written as a literal, never through the const above:
// the bundler (tools/build-studio-bundle.mjs, importSpecifiers) collects only
// literal specifiers, so a const here would leave the engine out of the
// bundle's import map and the panel off there (T1 pins the real graph).
/**
 * The engine module when it is loaded, `null` when its import failed, `undefined`
 * while it loads — the first call starts the import and `onLoaded` runs once when
 * it lands (the caller repaints); later calls while it loads schedule nothing.
 */
export function remediationFlowEngine({ importFn = () => import('/lib/remediation-flow.mjs'), onLoaded = null } = {}) {
  if (engine !== undefined) return engine;
  if (!loading) {
    loading = importFn()
      .then((mod) => { engine = mod; }, (e) => {
        engine = null;
        console.warn(`response path: ${ENGINE_SPECIFIER} did not load (${e?.message || e}); the panel stays off`);
      })
      .then(() => { loading = null; if (engine && typeof onLoaded === 'function') onLoaded(); });
  }
  return undefined;
}

/** Tests: forget the loaded engine so the next call imports again. */
export function resetRemediationFlowEngine() { engine = undefined; loading = null; }

// ---------- the model ----------

/**
 * The view model, or null when there is nothing to draw: no engine yet, no
 * remediation declared, or the engine finds no remediation artefact. The other
 * side is `live` for a drift comparison and `baseline` for a gap one
 * (compareModeFor); the comparison counts only when Pack B and an errorless
 * diff are both here. Each deploy step's action gains the SLO artefact's deploy
 * surface (`deployable`, the `identity` the deploy modal expects).
 */
export function buildRemediationFlowViewModel(eng, { pack = null, packB = null, diff = null, compareBId = null, packId = null } = {}) {
  if (!eng || typeof eng.buildRemediationFlowModel !== 'function' || !packDeclaresRemediation(pack)) return null;
  const compared = !!(packB && diff && !diff.error && diff.layers);
  const otherSide = packB && compareModeFor(packB, compareBId) !== 'drift' ? 'baseline' : 'live';
  const model = eng.buildRemediationFlowModel({
    pack,
    diff: compared ? diff : null,
    // Only a live side carries live evidence: a baseline's unhealthy list is not this pack's.
    liveAnnotations: compared && otherSide === 'live' && packB?.meta?.annotations && typeof packB.meta.annotations === 'object' ? packB.meta.annotations : null,
    otherSide,
  });
  if (!model?.configured) return null;
  const slos = new Map((Array.isArray(pack.layers?.L1) ? pack.layers.L1 : []).map((a) => [a?.id, a]));
  const links = model.links.map((link) => ({
    ...link,
    steps: link.steps.map((step) => {
      if (step.action?.type !== 'deploy') return step;
      const surface = deploySurfaceForArtefact(slos.get(step.action.artefactId) || null);
      return { ...step, action: { ...step.action, deployable: !!surface.deployable, identity: surface.identity || step.action.identity } };
    }),
  }));
  return { ...model, links, packId: packId ?? null, otherName: packB?.name || packB?.id || compareBId || null };
}

// ---------- the HTML ----------

const stateLabel = (model, state) => STATE_LABELS[model.otherSide]?.[state] || state;
const code = (s) => `<code>${escapeHtml(s)}</code>`;

function summaryHtml(model, screen) {
  const c = model.counts;
  const parts = [
    `<strong>${escapeHtml(plural(c.remediations, 'remediation'))}</strong>`,
    `${escapeHtml(plural(c.linked, 'path'))} to an alert`,
    c.unresolved ? `<strong>${escapeHtml(plural(c.unresolved, 'trigger'))}</strong> naming no alert of this pack` : '',
    c.blocked ? `<strong>${escapeHtml(plural(c.blocked, 'path'))}</strong> blocked` : '',
    c.uncovered ? `${escapeHtml(plural(c.uncovered, 'alert'))} without a remediation` : '',
    c.placeholder ? `${escapeHtml(plural(c.placeholder, 'placeholder remediation'))}` : '',
  ].filter(Boolean);
  const other = model.otherSide === 'baseline' ? 'the baseline' : 'live';
  const note = model.compared
    ? `Compared with ${escapeHtml(model.otherName || other)}: each alert's state is ${other === 'live' ? 'what is deployed' : 'what the baseline declares'}.`
    : screen === 'diagnose'
      ? 'Not compared yet: every alert reads as declared. Pick a baseline or a live pack to see which alerts are live.'
      : 'Not compared with live: every alert reads as declared, so nothing here can be deployed yet.';
  return `<p class="rflow-summary">${parts.join(' · ')}.</p><p class="rflow-note">${note}</p>`;
}

function stepHtml(step, model, screen) {
  const deploy = screen === 'remediate' && model.compared && step.action?.type === 'deploy' && step.action.deployable
    ? ` <button type="button" class="ux-secondary-btn rflow-deploy" data-ux-action="rflow-deploy" data-identity="${escapeHtml(step.action.identity)}" title="Open the deploy modal preselected with this SLO's ${step.action.rows} rule rows">Deploy ${escapeHtml(step.action.identity)} (${step.action.rows} rows)</button>`
    : '';
  const text = step.kind === 'annotate' ? annotateHtml(step) : escapeHtml(step.text);
  const link = step.href ? ` <a class="rflow-link" href="${escapeHtml(step.href)}" target="_blank" rel="noopener noreferrer">open the runbook ↗</a>` : '';
  return `<li class="rflow-step is-${escapeHtml(step.tone || 'info')} rflow-step-${escapeHtml(step.kind)}">${text}${link}${deploy}</li>`;
}

function annotateHtml(step) {
  // The annotation and its example as code, the rest of the sentence as text.
  const [before, after] = step.text.split('metadata.annotations[');
  if (after === undefined) return escapeHtml(step.text);
  const m = /^"([^"]*)"\] = "([^"]*)"(.*)$/.exec(after);
  if (!m) return escapeHtml(step.text);
  return `${escapeHtml(before)}${code(`metadata.annotations["${m[1]}"] = "${m[2]}"`)}${escapeHtml(m[3])}`;
}

function pathHtml(link, model, screen) {
  const alerts = link.alerts.map((a) => `
        <span class="rflow-alert"><span class="rflow-id">${escapeHtml(a.ref.id)}</span> ${escapeHtml(a.ref.title)} <span class="rflow-state is-${escapeHtml(a.state)}">${escapeHtml(stateLabel(model, a.state))}</span></span>`).join('<span class="rflow-arrow" aria-hidden="true">+</span>');
  return `
    <li class="rflow-path is-${escapeHtml(link.state)}">
      <div class="rflow-path-head">
        <span class="rflow-state is-${escapeHtml(link.state)}">${escapeHtml(stateLabel(model, link.state))}</span>
        <span class="rflow-id">${escapeHtml(link.remediation.id)}</span>
        <span class="rflow-trigger">${escapeHtml(link.trigger)}</span>
        <span class="rflow-arrow" aria-hidden="true">←</span>${alerts}
        <span class="rflow-tier">${escapeHtml(TIER_LABELS[link.tier] || link.tier)}${link.placeholder ? ' · placeholder remediation' : ''}</span>
      </div>
      ${link.steps.length ? `<ol class="rflow-steps">${link.steps.map((s) => stepHtml(s, model, screen)).join('')}</ol>` : ''}
    </li>`;
}

function unresolvedHtml(item, model, screen) {
  const suggestions = item.suggestions.length
    ? `<p class="rflow-suggest">Closest by name: ${item.suggestions.map((s) => `<span class="rflow-id">${escapeHtml(s.ref.id)}</span> ${escapeHtml(s.ref.title)} (${escapeHtml(s.shared.join(', '))})`).join('; ')} — a suggestion, not a link.</p>`
    : '<p class="rflow-suggest">No alert of this pack shares a name with it.</p>';
  return `
    <li class="rflow-path is-unresolved">
      <div class="rflow-path-head">
        <span class="rflow-state is-unresolved">unresolved</span>
        <span class="rflow-id">${escapeHtml(item.remediation.id)}</span>
        <span class="rflow-trigger">${escapeHtml(item.trigger || '(no trigger)')}</span>
        <span class="rflow-tier">names no alert of this pack${item.placeholder ? ' · placeholder remediation' : ''}</span>
      </div>
      ${suggestions}
      <ol class="rflow-steps">${item.steps.map((s) => stepHtml(s, model, screen)).join('')}</ol>
    </li>`;
}

/**
 * The panel's HTML for a view model, or '' when there is none to draw. Diagnose
 * gets a `.diag-block` section with the report's heading markup (and the
 * sticky index's `#diag-flow` target); Remediate a `.ux-rm-flow` section after
 * the plan. The deploy button renders on Remediate only, only when compared,
 * only for a deployable SLO.
 */
export function remediationFlowHtml(model, { screen = 'diagnose' } = {}) {
  if (!model || !model.configured) return '';
  const body = `
    ${summaryHtml(model, screen)}
    ${model.links.length ? `<ol class="rflow-paths" aria-label="Response paths">${model.links.map((l) => pathHtml(l, model, screen)).join('')}</ol>` : ''}
    ${model.unresolved.length ? `<ol class="rflow-paths rflow-unresolved" aria-label="Triggers naming no alert">${model.unresolved.map((u) => unresolvedHtml(u, model, screen)).join('')}</ol>` : ''}
    ${model.uncovered.length ? `
    <details class="rflow-uncovered">
      <summary>${escapeHtml(plural(model.uncovered.length, 'alert'))} without a remediation</summary>
      <ul>${model.uncovered.map((u) => `<li><span class="rflow-id">${escapeHtml(u.ref.id)}</span> ${escapeHtml(u.ref.title)} <span class="rflow-state is-${escapeHtml(u.state)}">${escapeHtml(stateLabel(model, u.state))}</span></li>`).join('')}</ul>
    </details>` : ''}
    ${model.warnings.length ? `<ul class="rflow-warnings">${model.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
    ${screen === 'diagnose' ? '<p class="rflow-foot"><button type="button" class="ux-link-btn" data-ux-action="diag-remediate">Open Remediate →</button></p>' : ''}`;
  const lede = 'Each remediation the pack declares, the alert its trigger names, whether that alert exists on the other side, and what stands between the declaration and a working path.';
  if (screen === 'remediate') {
    return `
    <section class="rflow ux-rm-flow" id="rm-flow" aria-labelledby="rm-flow-title">
      <header class="rflow-head">
        <h3 class="rflow-title" id="rm-flow-title">Response path — from a firing alert to its remediation</h3>
        <p class="rflow-lede">${lede}</p>
      </header>${body}
    </section>`;
  }
  return `
    <section class="rflow diag-block ux-section-target" id="diag-flow" tabindex="-1" aria-labelledby="diag-flow-title">
      <header class="diag-block-head">
        <h2 class="diag-block-title" id="diag-flow-title">Response path — from a firing alert to its remediation</h2>
        <p class="diag-block-lede">${lede}</p>
      </header>${body}
    </section>`;
}

// ---------- the renderer ----------

/**
 * Appends the panel to `container` and returns the `[data-ux-action]` handlers
 * the caller spreads into its wireUxActions: `rflow-deploy` opens the deploy
 * modal preselected with the button's identity. Draws nothing and returns {}
 * for a model that is null.
 */
export function renderRemediationFlow(container, model, host = appHost, { screen = 'remediate' } = {}) {
  const html = remediationFlowHtml(model, { screen });
  if (!html || !container) return {};
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  while (wrap.firstChild) container.appendChild(wrap.firstChild);
  return {
    'rflow-deploy': (_ev, el) => {
      const identity = el?.dataset?.identity;
      if (!identity) return;
      host.openDeployModal({ packId: model.packId, presetIdentities: new Set([identity]) });
    },
  };
}
