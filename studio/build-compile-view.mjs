// studio/build-compile-view.mjs
//
// BUILD step 2 — COMPILE, "What should we watch?": the layer stack of the
// instantiated pack is the surface, drawn through the adapter exactly as
// Discover will draw it (its real artefacts per layer, the slab edges in the
// clause states, a ghost card for a clause still unmet, Scaffold on the
// placeholder artefacts, a section switched off dimming its slab with an
// 'off' chip on its head). Composition happens on the layer sheets: click a
// slab and its sheet opens with the layer's clauses and options — the SLI
// rolodex and the SLOs switch on L1, the scrape jobs and endpoints on L2,
// the Dashboards switch on L3, Policy and Routes on L4, Validation on L5
// (build-sheet-view.mjs). The SLI rows and the sections grid that used to
// sit above the stack live there now. Above the stack: the summary line, the
// warnings and the schema verdict; below it: the pack YAML as a collapsible.
// Every change re-instantiates through the API (the controller debounces)
// and the stack, the sheet and the definition column re-render from the
// result.
//
// Renderer only (docs/UI_CONVENTIONS.md §2-3): render(container, model, host)
// with buildCompileModel's output; host.build.* are the actions.

import { escapeHtml, downloadText } from './util.mjs';
import { host as appHost } from './host.mjs';
import { stepHeadHtml, instantiateErrorHtml } from './build-define-view.mjs';
import { buildStackHtml, wireBuildStack } from './build-stack-view.mjs';

function warningsHtml(groups) {
  if (!groups.length) return '';
  return `
    <div class="build-warnings">
      ${groups.map(g => `
        <div class="build-warning-group${g.blocking ? ' is-blocking' : ''}">
          <div class="build-warning-kind">${escapeHtml(g.label)} <span>${g.items.length}</span>${g.blocking ? ' <em>blocking</em>' : ''}</div>
          <ul>${g.items.map(w => `<li>${escapeHtml(w.message)}</li>`).join('')}</ul>
        </div>`).join('')}
    </div>`;
}

/** render(container, model, host) — the COMPILE step. */
export function renderBuildCompile(container, model, host = appHost) {
  const act = host.build;
  const r = model.result;
  const stack = model.stack;
  const lit = stack.counts.litSlabs;
  const k = model.counts;
  container.innerHTML = `
    <section class="build-step build-compile">
      ${stepHeadHtml('compile', 'What should we watch?', `The pack, layer by layer, exactly as Discover will show it. Click a layer to compose it: L1 holds the SLI rolodex — <strong>${k.checked} of ${k.reachable}</strong> SLI${k.reachable === 1 ? '' : 's'} at <strong>${escapeHtml(model.tier)}</strong> in the pack — and the SLOs switch; L2 the scrape jobs and endpoints; L3 the boards; L4 the burn policy and the routes; L5 the probes and chaos. Every change recompiles the pack and redraws it; each slab’s edge says which of the tier’s clauses that layer holds up, and on what.`)}

      <div class="build-result build-stack-wrap">
        <div class="build-section-key">The pack, layer by layer <span class="build-section-sub">${model.pending ? 'recompiling…' : r ? `${r.sliCount} SLI${r.sliCount === 1 ? '' : 's'} · ${r.sloCount} SLO${r.sloCount === 1 ? '' : 's'} · ${stack.counts.artefacts} artefact${stack.counts.artefacts === 1 ? '' : 's'} on ${lit} of ${stack.counts.slabs} layers${stack.counts.scaffold ? ` · ${stack.counts.scaffold} scaffold (a placeholder value the team fills)` : ''}${stack.counts.ghosts ? ` · ${stack.counts.ghosts} clause${stack.counts.ghosts === 1 ? '' : 's'} unmet` : ''} · ${r.todoCount} todo${r.todoCount === 1 ? '' : 's'} · ${r.warningCount} warning${r.warningCount === 1 ? '' : 's'} · schema ${r.schemaOk ? 'valid' : `${r.schemaErrors.length} error${r.schemaErrors.length === 1 ? '' : 's'}`}${model.stale ? ' · previous pack' : ''} — the same artefacts, ids and titles Discover will show for this pack` : model.error ? 'the last generation failed' : 'nothing generated yet — the silhouette below fills in as soon as the pack compiles'}</span></div>
        ${instantiateErrorHtml(model.error, { stale: model.stale, where: 'on its layer sheet (L2 · L4 · L5) and under its todo on Verify' })}
        ${!model.atLeastOne ? '<div class="build-note build-note-warn">At least one SLI must stay in the pack — open L1 and add one; the pack cannot be generated without one.</div>' : ''}
        ${r && !r.schemaOk ? `<div class="build-note build-note-warn"><strong>Schema:</strong> the pack does not validate against spec v1.2 as toggled — ${r.schemaErrors.slice(0, 4).map(e => escapeHtml(e)).join('; ')}${r.schemaErrors.length > 4 ? ` … +${r.schemaErrors.length - 4}` : ''}</div>` : ''}
        ${r ? warningsHtml(r.warnings) : ''}
        ${buildStackHtml(stack)}
        ${r ? `
        <details class="build-yaml">
          <summary class="build-yaml-summary">Pack YAML <span>${r.yamlLines} lines · ${escapeHtml(r.fileName)}</span></summary>
          <div class="build-yaml-actions"><button type="button" class="ctrl-btn" id="build-yaml-download">download yaml</button></div>
          <pre class="crawl-result-yaml build-yaml-pre">${escapeHtml(r.yaml)}</pre>
        </details>` : ''}
      </div>

      <footer class="build-step-actions">
        <button type="button" class="ctrl-btn build-back" id="build-back">← Define</button>
        <span class="build-step-status">${r && !model.pending ? (r.warnings.some(w => w.blocking) ? 'A PromQL warning blocks the pack — fix the param before verifying.' : 'Compiled. Verify shows the verdict, the todos and the artefacts.') : ''}</span>
        <button type="button" class="mcp-refresh-btn build-next" id="build-next" ${r && !model.pending ? '' : 'disabled'}>Continue to Verify <span aria-hidden="true">→</span></button>
      </footer>
    </section>`;

  container.querySelector('#build-yaml-download')?.addEventListener('click', () => downloadText(r.fileName, r.yaml, 'application/x-yaml'));
  wireBuildStack(container, stack, host);
  container.querySelector('#build-back').addEventListener('click', () => act.setStep('define'));
  container.querySelector('#build-next').addEventListener('click', () => act.setStep('verify'));
}
