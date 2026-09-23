// studio/build-generate-view.mjs
//
// BUILD step 2 — GENERATE, "What should it watch?": per-entry SLI toggles
// (an SLI above the tier is shown disabled with the tier it needs), the SLO
// objective and window each SLI gets at this tier (the library's per-tier
// defaults, read-only — overriding an objective is a later slice), the
// section toggles (SLOs, policy + routes, dashboards, validation), what the
// last instantiation produced (SLIs, SLOs, todos, warnings, the schema
// verdict) and a collapsible YAML preview with a download. Every change
// re-instantiates through the API (the controller debounces) and the rail
// on the right fills in from the result.
//
// Renderer only (docs/UI_CONVENTIONS.md §2-3): render(container, model, host)
// with buildGenerateModel's output; host.build.* are the actions.

import { escapeHtml, downloadText } from './util.mjs';
import { host as appHost } from './host.mjs';
import { stepHeadHtml, evidenceBadge, instantiateErrorHtml } from './build-select-view.mjs';

function sliRowHtml(s) {
  const disabled = !s.reachable;
  return `
    <label class="build-sli${disabled ? ' is-disabled' : ''}${s.checked ? ' is-checked' : ''}" data-sli="${escapeHtml(s.key)}" title="${escapeHtml(`${disabled ? `needs ${s.minTier} · ` : ''}${s.metrics.join(', ')}`)}">
      <input type="checkbox" ${s.checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="${escapeHtml(s.key)}">
      <span class="build-sli-main">
        <span class="build-sli-id">${escapeHtml(s.id)}</span>
        <span class="build-sli-desc">${escapeHtml(s.description)}</span>
      </span>
      <span class="build-sli-type type-pill">${escapeHtml(s.type)}</span>
      <span class="build-sli-evidence">${evidenceBadge(s.evidence)}</span>
      <span class="build-sli-slo">
        ${disabled
          ? `<span class="build-sli-needs">needs ${escapeHtml(s.minTier)}</span>`
          : `<span class="build-sli-objective">${escapeHtml(s.objectiveLabel)}</span><span class="build-sli-window">over ${escapeHtml(s.window || '—')}</span>`}
      </span>
    </label>`;
}

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

/** render(container, model, host) — the GENERATE step. */
export function renderBuildGenerate(container, model, host = appHost) {
  const act = host.build;
  const r = model.result;
  const allKeys = model.groups.flatMap(g => g.slis.filter(s => s.reachable).map(s => s.key));
  container.innerHTML = `
    <section class="build-step build-generate">
      ${stepHeadHtml('generate', 'What should it watch?', `Tick the SLIs the pack should carry — the library’s objectives and windows at <strong>${escapeHtml(model.tier)}</strong> are shown beside each one — and the sections it should contain. Every change regenerates the pack; the rail shows which of the tier’s clauses it holds up, and on what.`)}

      ${model.groups.map(g => `
        <div class="build-sli-group">
          <div class="build-section-key">${escapeHtml(g.title)} ${evidenceBadge(g.evidence)}
            <span class="build-section-sub">${g.slis.filter(s => s.checked).length} of ${g.slis.filter(s => s.reachable).length} SLI${g.slis.filter(s => s.reachable).length === 1 ? '' : 's'} at ${escapeHtml(model.tier)} selected${g.slis.some(s => !s.reachable) ? ` · ${g.slis.filter(s => !s.reachable).length} above the tier` : ''}${model.composed ? ` · ids prefixed <code>${escapeHtml(g.slis[0]?.key.slice(0, g.slis[0].key.length - g.slis[0].id.length) || '')}</code> in the pack` : ''}</span>
          </div>
          <div class="build-sli-list">
            <div class="build-sli-head" aria-hidden="true"><span></span><span>SLI</span><span>type</span><span>evidence</span><span>objective · window at ${escapeHtml(model.tier)}</span></div>
            ${g.slis.map(sliRowHtml).join('')}
          </div>
        </div>`).join('')}
      <p class="build-footnote">Objectives and windows are the library’s per-tier defaults (each entry’s <code>slo.objective</code> table); overriding an objective is a later slice. The SLO id is derived from the SLI and the objective (<code>broker_availability_99_9</code>).</p>

      <div class="build-toggles">
        <div class="build-section-key">Sections <span class="build-section-sub">a section switched off is absent from the pack: the schema and the rubric then both say what is missing — nothing is faked to keep a clause green</span></div>
        <div class="build-toggle-row">
          ${model.toggles.map(t => `
            <label class="build-toggle${t.on ? ' is-on' : ''}${t.disabled ? ' is-disabled' : ''}" data-toggle="${escapeHtml(t.id)}" title="${escapeHtml(t.hint)}">
              <input type="checkbox" ${t.on ? 'checked' : ''} ${t.disabled ? 'disabled' : ''} aria-label="${escapeHtml(t.label)} section">
              <span class="build-toggle-label">${escapeHtml(t.label)}</span>
              <span class="build-toggle-hint">${escapeHtml(t.hint)}</span>
            </label>`).join('')}
        </div>
      </div>

      <div class="build-result">
        <div class="build-section-key">Generated pack <span class="build-section-sub">${model.pending ? 'regenerating…' : r ? `${r.sliCount} SLI${r.sliCount === 1 ? '' : 's'} · ${r.sloCount} SLO${r.sloCount === 1 ? '' : 's'} · ${r.todoCount} todo${r.todoCount === 1 ? '' : 's'} · ${r.warningCount} warning${r.warningCount === 1 ? '' : 's'} · schema ${r.schemaOk ? 'valid' : `${r.schemaErrors.length} error${r.schemaErrors.length === 1 ? '' : 's'}`}${model.stale ? ' · previous pack' : ''}` : model.error ? 'the last generation failed' : 'nothing generated yet'}</span></div>
        ${instantiateErrorHtml(model.error, { stale: model.stale, where: 'Select and Validate (this step has no parameter inputs)' })}
        ${!model.atLeastOne ? '<div class="build-note build-note-warn">At least one SLI must stay selected — the pack cannot be generated without one.</div>' : ''}
        ${r && !r.schemaOk ? `<div class="build-note build-note-warn"><strong>Schema:</strong> the pack does not validate against spec v1.2 as toggled — ${r.schemaErrors.slice(0, 4).map(e => escapeHtml(e)).join('; ')}${r.schemaErrors.length > 4 ? ` … +${r.schemaErrors.length - 4}` : ''}</div>` : ''}
        ${r ? warningsHtml(r.warnings) : ''}
        ${r ? `
        <details class="build-yaml">
          <summary class="build-yaml-summary">Pack YAML <span>${r.yamlLines} lines · ${escapeHtml(r.fileName)}</span></summary>
          <div class="build-yaml-actions"><button type="button" class="ctrl-btn" id="build-yaml-download">download yaml</button></div>
          <pre class="crawl-result-yaml build-yaml-pre">${escapeHtml(r.yaml)}</pre>
        </details>` : ''}
      </div>

      <footer class="build-step-actions">
        <button type="button" class="ctrl-btn build-back" id="build-back">← Select</button>
        <span class="build-step-status">${r && !model.pending ? (r.warnings.some(w => w.blocking) ? 'A PromQL warning blocks the pack — fix the param before validating.' : 'Generated. Validate shows the verdict, the todos and the artefacts.') : ''}</span>
        <button type="button" class="mcp-refresh-btn build-next" id="build-next" ${r && !model.pending ? '' : 'disabled'}>Continue to Validate <span aria-hidden="true">→</span></button>
      </footer>
    </section>`;

  container.querySelectorAll('.build-sli input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => act.setSli(cb.closest('.build-sli').dataset.sli, cb.checked, allKeys));
  });
  container.querySelectorAll('.build-toggle input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => act.setToggle(cb.closest('.build-toggle').dataset.toggle, cb.checked));
  });
  container.querySelector('#build-yaml-download')?.addEventListener('click', () => downloadText(r.fileName, r.yaml, 'application/x-yaml'));
  container.querySelector('#build-back').addEventListener('click', () => act.setStep('select'));
  container.querySelector('#build-next').addEventListener('click', () => act.setStep('validate'));
}
