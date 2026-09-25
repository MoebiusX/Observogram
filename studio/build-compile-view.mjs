// studio/build-compile-view.mjs
//
// BUILD step 2 — COMPILE, "What did the pack produce?" (the 2026-09 UX review,
// "Build / Compile"; docs/UX_SCREEN_GRAMMAR.md). The step keeps its name; the
// screen leads with the result instead of an explanation:
//
//   1. Context      the service, its environment, the tier, what it is built from
//   2. Decision     "Pack compiled. Two warnings need review; 17 values remain
//                   placeholders." — or what stopped it
//   3. Next action  "Continue to Verify", or the blocking item to review
//   4. Explanation  three states kept apart: generated, complete for this tier,
//                   ready to deploy
//   5. Details      the action queue first (each warning with the artefact it
//                   impacts, a suggested correction and Review — the SLI's editor
//                   or the layer's sheet); what the pack produced, one row per
//                   layer with its artefacts by type and purpose, a layer's slab
//                   drawn only when it is selected ("Show all layers" draws them
//                   all); "Changes since Define" — which selection produced which
//                   artefacts — collapsed; the pack YAML.
//
// The slabs are the stack Discover will show (build-stack-view.mjs), drawn
// through the adapter; composition still happens on the layer sheets (click a
// slab head). Every change re-instantiates through the API (the controller
// debounces) and this screen re-renders from the result; the result sentence
// is announced once per change (#ux-status).
//
// Renderer only (docs/UI_CONVENTIONS.md §2-3): render(container, model, host)
// with buildCompileModel's output; host.build.* are the actions. Which layers
// are drawn is `build.compileView` (null · 'all' · a layer id), UI state on the
// draft, never persisted.

import { escapeHtml, downloadText } from './util.mjs';
import { host as appHost } from './host.mjs';
import { stepHeadHtml, instantiateErrorHtml } from './build-define-view.mjs';
import { buildStackHtml, wireBuildStack } from './build-stack-view.mjs';
import { STATE_GLYPH } from './build-atoms.mjs';
import { decisionHeaderHtml, wireUxActions, termHtml, disclosureHtml, emptyStateHtml, announce, plural } from './ux-kit.mjs';

const typesHtml = (types) => `<ul class="bres-types">${types.map(t => `<li${t.purpose ? ` title="${escapeHtml(t.purpose)}"` : ''}>${escapeHtml(t.type)} <b>${t.count}</b>${t.purpose ? `<span class="bres-type-why"> · ${escapeHtml(t.purpose)}</span>` : ''}</li>`).join('')}</ul>`;

/** The action queue: warning, the artefact it impacts, the suggested correction, Review. */
function queueHtml(model) {
  if (!model.result) return '';
  const q = model.queue;
  if (!q.length) {
    // Green only when the result is: an empty queue over a pack that is not ready (a previous pack, the rubric not
    // evaluated) says only that no warning is listed, in a neutral tone.
    const ok = model.decision?.tone === 'ok';
    return `<section class="bres-queue" aria-label="Needs review">${emptyStateHtml({ title: ok ? 'Nothing needs review' : 'No warning to review', checked: 'every SLI expression with the parameters in, the burn-rule generator’s notes, the schema', tone: ok ? 'ok' : 'neutral' })}</section>`;
  }
  return `
    <section class="bres-queue" aria-labelledby="build-queue-title">
      <div class="bres-head">
        <h3 class="bres-title" id="build-queue-title">Needs review <span class="bres-count">${q.length}</span></h3>
      </div>
      <ol class="bres-items">
        ${q.map(i => `
          <li class="bres-item ux-tone-${i.blocking || i.kind === 'failing' ? 'fail' : i.kind === 'placeholders' || i.kind === 'gaps' ? 'info' : 'warn'}">
            <div class="bres-item-main">
              <span class="bres-kind">${escapeHtml(i.label)}${i.blocking ? ' · blocking' : ''}</span>
              <p class="bres-msg">${escapeHtml(i.message)}</p>
              <dl class="bres-facts">
                <div><dt>Impacts</dt><dd>${escapeHtml(i.impact)}</dd></div>
                <div><dt>Suggested correction</dt><dd>${escapeHtml(i.suggestion)}</dd></div>
              </dl>
            </div>
            <div class="bres-actions">
              <button type="button" class="ux-secondary-btn" data-ux-action="review" data-key="${escapeHtml(i.key)}">Review</button>
            </div>
          </li>`).join('')}
      </ol>
    </section>`;
}

/** What the pack produced: one row per layer (its question, verdict, artefacts by type); a slab only when its layer is selected. */
function producedHtml(model) {
  const stack = model.stack;
  if (!stack.compiled && !model.result) {
    // Nothing compiled yet: the silhouette of the stack, as before.
    return `<div class="build-stack-wrap">${buildStackHtml(stack)}</div>`;
  }
  const open = new Set(model.expandedLayers || []);
  const all = model.produced.length > 0 && model.produced.every(l => open.has(l.id));
  const scaffold = stack.counts.scaffold;
  return `
    <section class="bres-produced build-stack-wrap" aria-labelledby="build-produced-title">
      <div class="bres-head">
        <h3 class="bres-title" id="build-produced-title">What the pack produced</h3>
        <p class="bres-sub">${plural(stack.counts.artefacts, 'artefact')} on ${stack.counts.litSlabs} of ${stack.counts.slabs} layers${scaffold ? ` · ${scaffold} with a ${termHtml('scaffold', 'template value that needs completion')}` : ''}${model.stale ? ' · previous pack' : ''}${model.pending ? ' · recompiling…' : ''}</p>
        <button type="button" class="ux-link-btn bres-all" data-ux-action="layers-all" data-focus-key="layers:all" aria-pressed="${all ? 'true' : 'false'}">${all ? 'Collapse all layers' : 'Show all layers'}</button>
      </div>
      <ul class="bres-layers">
        ${model.produced.map(l => {
          const expanded = open.has(l.id);
          const slab = stack.slabs.find(s => s.id === l.id);
          return `
          <li class="bres-layer is-${escapeHtml(l.state)}${expanded ? ' is-open' : ''}" data-layer="${escapeHtml(l.id)}">
            <button type="button" class="bres-layer-toggle" data-ux-action="layer" data-layer="${escapeHtml(l.id)}" data-focus-key="layer:${escapeHtml(l.id)}" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="bres-layer-${escapeHtml(l.id)}">
              <span class="bres-layer-code">${escapeHtml(l.num)}</span>
              <span class="bres-layer-name">${escapeHtml(l.name)} <span class="bres-layer-q">${escapeHtml(l.question)}</span></span>
              <span class="bres-layer-verdict is-${escapeHtml(l.state)}"><b aria-hidden="true">${STATE_GLYPH[l.state] || ''}</b> ${escapeHtml(l.stateText)}</span>
              <span class="bres-layer-count">${plural(l.artefacts, 'artefact')}${l.scaffold ? ` · ${l.scaffold} scaffold` : ''}${l.missing ? ` · ${l.missing} missing` : ''}${l.offSections.length ? ` · ${escapeHtml(l.offSections.join(', '))} off` : ''}</span>
            </button>
            ${l.types.length ? typesHtml(l.types) : ''}
            <div class="bres-layer-body" id="bres-layer-${escapeHtml(l.id)}"${expanded ? '' : ' hidden'}>${expanded && slab ? buildStackHtml({ ...stack, slabs: [slab] }) : ''}</div>
          </li>`;
        }).join('')}
      </ul>
    </section>`;
}

/** "Changes since Define": which selection produced which artefacts, and what was edited since — collapsed. */
function originsHtml(model) {
  const o = model.origins;
  if (!o) return '';
  const body = `
    <p class="bres-group-why">Read from the pack’s provenance and the references between its artefacts (an SLO names its SLI, a burn alert its SLO, a board is named after its entry); what no selection claims is the tier’s scaffold. An attribution, not a proof.</p>
    <ul class="bres-origins">
      ${o.groups.map(g => `
        <li class="bres-origin is-${escapeHtml(g.kind)}">
          <div class="bres-origin-head"><strong>${escapeHtml(g.label)}</strong>${g.sub ? ` <span class="bres-origin-sub">${escapeHtml(g.sub)}</span>` : ''} <span class="bres-count">${g.count}</span></div>
          ${typesHtml(g.types)}
          ${g.slis.length ? `<p class="bres-origin-slis">SLIs: ${g.slis.map(s => `<code>${escapeHtml(s)}</code>`).join(', ')}</p>` : ''}
        </li>`).join('')}
    </ul>
    <h4 class="bres-origin-edits-title">Edited since Define</h4>
    ${o.edits.length ? `<ul class="bres-origin-edits">${o.edits.map(e => `<li>${escapeHtml(e.text)}</li>`).join('')}</ul>` : '<p class="bres-group-why">Nothing yet: every SLI and value is the library’s at this tier, every section on.</p>'}`;
  return disclosureHtml(`Changes since Define — which selection produced which of the ${o.total} artefacts`, body, { cls: 'bres-changes' });
}

let lastAnnouncement = '';
function announceResult(model) {
  if (!model.result || model.pending || !model.decision?.sentence) return;
  const msg = `Compile: ${model.decision.sentence}`;
  if (msg === lastAnnouncement) return;
  lastAnnouncement = msg;
  announce(msg);
}

/** render(container, model, host) — the COMPILE step. */
export function renderBuildCompile(container, model, host = appHost) {
  const act = host.build;
  const r = model.result;
  const stack = model.stack;
  const d = model.decision;
  const firstBlocking = (model.queue || []).find(i => i.blocking);
  const primary = !model.atLeastOne ? { id: 'build-compile-add', label: 'Add an SLI on L1', action: 'open-l1' }
    : !r || model.pending ? null
      : firstBlocking ? { id: 'build-compile-review', label: 'Review the blocking item', action: 'review-first' }
        : { id: 'build-compile-next', label: 'Continue to Verify', action: 'to-verify' };
  container.innerHTML = `
    <section class="build-step build-compile">
      ${stepHeadHtml('compile', 'What did the pack produce?', 'The pack as compiled, layer by layer, exactly as Discover will show it. Select a layer to see its artefacts; click its head to compose it — every change recompiles the pack.')}

      ${decisionHeaderHtml({
        id: 'build-compile-decision', eyebrow: 'Compile · result', context: model.context,
        decision: d.sentence, verdict: d.word, tone: d.tone, note: d.note || '',
        primary, measures: (model.states || []).map(s => ({ label: s.label, value: s.value, note: s.note, tone: s.tone })),
      })}
      ${instantiateErrorHtml(model.error, { stale: model.stale, where: 'on its layer sheet (L2 · L4 · L5) and under its todo on Verify' })}

      ${queueHtml(model)}
      ${producedHtml(model)}
      ${originsHtml(model)}
      ${r ? `
      <details class="build-yaml">
        <summary class="build-yaml-summary">Pack YAML <span>${r.yamlLines} lines · ${escapeHtml(r.fileName)}</span></summary>
        <div class="build-yaml-actions"><button type="button" class="ctrl-btn" id="build-yaml-download">download yaml</button></div>
        <pre class="crawl-result-yaml build-yaml-pre">${escapeHtml(r.yaml)}</pre>
      </details>` : ''}

      <footer class="build-step-actions">
        <button type="button" class="ctrl-btn build-back" id="build-back">← Define</button>
        <span class="build-step-status">${r && !model.pending ? (firstBlocking ? 'A blocking item stops the hand-off — review it before verifying.' : 'Compiled. Verify shows what is ready and what remains.') : ''}</span>
        <button type="button" class="mcp-refresh-btn build-next" id="build-next" ${r && !model.pending ? '' : 'disabled'}>Continue to Verify <span aria-hidden="true">→</span></button>
      </footer>
    </section>`;

  container.querySelector('#build-yaml-download')?.addEventListener('click', () => downloadText(r.fileName, r.yaml, 'application/x-yaml'));
  // The full stack model: a detail fold toggled on one drawn slab keeps the others' folds as they were.
  wireBuildStack(container, stack, host);
  container.querySelector('#build-back').addEventListener('click', () => act.setStep('define'));
  container.querySelector('#build-next').addEventListener('click', () => act.setStep('verify'));
  wireCompileActions(container, model, act);
  announceResult(model);
}

function wireCompileActions(container, model, act) {
  const root = container.querySelector('.build-compile');
  if (!root || typeof root.addEventListener !== 'function') return;
  const byKey = new Map((model.queue || []).map(i => [i.key, i]));
  const open = model.expandedLayers || [];
  // Review opens where the item is edited; its layer is selected first so the slab head focus returns to is drawn.
  const review = (item) => {
    if (!item) return;
    const f = item.fix || {};
    if (f.kind === 'step') { act.setStep(f.step); return; }
    const layer = f.layer || 'L1';
    if (!open.includes(layer)) act.update?.({ compileView: [...open, layer] }, { reinstantiate: false });
    if (f.kind === 'editor') act.openEditor?.({ key: f.key, custom: f.custom, focus: f.focus || null });
    else act.openSheet?.(layer);
  };
  wireUxActions(root, {
    review: (_e, el) => review(byKey.get(el.dataset.key)),
    'review-first': () => review((model.queue || []).find(i => i.blocking)),
    'open-l1': () => review({ fix: { kind: 'sheet', layer: 'L1' } }),
    'to-verify': () => act.setStep('verify'),
    // A layer's row selects it (its slab is drawn under the row) or, when it is open, closes it — the others stay as they are.
    layer: (_e, el) => {
      const id = el.dataset.layer;
      const next = open.includes(id) ? open.filter(x => x !== id) : [...open, id];
      act.update({ compileView: next.length ? next : null }, { rerender: true, reinstantiate: false, focus: `layer:${id}` });
    },
    'layers-all': (_e, el) => act.update({ compileView: el.getAttribute('aria-pressed') === 'true' ? null : 'all' }, { rerender: true, reinstantiate: false, focus: 'layers:all' }),
  });
}
