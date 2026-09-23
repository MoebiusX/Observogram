// studio/build-verify-view.mjs
//
// BUILD step 3 — VERIFY, "Is it ready to use?": the conformance verdict at
// the tier (MUST / SHOULD counts and the three clause states — pass, pass on
// a placeholder, fail), the schema verdict, the warnings (promql,
// sli-excluded, burn-rules), the todos grouped by artefact with the param
// that fills each one editable inline (editing re-instantiates), the
// artefacts (one card per compile target with preview and download),
// "Download pack YAML" and "Ready to continue?" — resolve or adjust (back at Define)
// or continue with visible gaps, which registers the pack the
// way an upload is registered and hands it to the analysis journey, saying
// how many placeholders remain.
//
// Renderer only (docs/UI_CONVENTIONS.md §2-3): render(container, model, host)
// with buildVerifyModel's output; host.build.* are the actions.

import { escapeHtml, downloadText } from './util.mjs';
import { host as appHost } from './host.mjs';
import { stepHeadHtml, paramRowHtml, wireParamInputs, instantiateErrorHtml } from './build-define-view.mjs';

const GLYPH = { pass: '✓', placeholder: '◐', fail: '✗' };

// "channels.0.msteams: Chat channel for SEV1/SEV2: placeholder '#x' (param oncall_channel) — The Teams…"
// → the part before the em dash, one line per placeholder field.
function todoLines(what) {
  return String(what || '').split(' · ').map(part => part.split(' — ')[0].trim()).filter(Boolean);
}

function todoHtml(t, i) {
  return `
    <li class="build-todo${t.manual ? ' is-manual' : ''}" data-todo="${escapeHtml(t.path)}">
      <div class="build-todo-head">
        <code class="build-todo-path">${escapeHtml(t.path)}</code>
        ${t.clauses.map(c => `<span class="build-todo-clause" title="this placeholder artefact holds up ${escapeHtml(c)}">${GLYPH.placeholder} ${escapeHtml(c)}</span>`).join('')}
      </div>
      <ul class="build-todo-what">${todoLines(t.what).map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
      ${t.manual
        ? '<div class="build-todo-manual">no parameter fills this one — a file to write or a number to measure, then edit the pack</div>'
        : `<div class="build-todo-params">${t.params.map(p => paramRowHtml(p, { compact: true, idSuffix: `t${i}` })).join('')}</div>`}
    </li>`;
}

/** render(container, model, host) — the VERIFY step. */
export function renderBuildVerify(container, model, host = appHost) {
  const act = host.build;
  const v = model.verdict;
  const k = model.checklist.counts;
  let todoIndex = 0;
  container.innerHTML = `
    <section class="build-step build-verify">
      ${stepHeadHtml('verify', 'Is it ready to use?', `The pack as generated, read three ways: the tier’s conformance rubric (which clauses pass, which pass only on a placeholder, which fail), the v1.2 schema, and the artefacts it compiles to. Fill a placeholder inline and the pack regenerates; when it holds up, open it in Discover.`)}

      ${!model.ready && !model.error ? `<div class="build-note">${model.pending ? 'Compiling…' : 'Nothing compiled yet — go back to Compile.'}</div>` : ''}
      ${instantiateErrorHtml(model.error, { stale: model.stale, where: 'below, under its todo' })}

      ${v ? `
      <div class="build-verdicts">
        <div class="build-verdict build-verdict-conf ${v.conformant ? 'is-ok' : 'is-fail'}">
          <div class="build-verdict-key">Conformance at ${escapeHtml(model.tier)}</div>
          <div class="build-verdict-big">${v.conformant ? 'conformant' : 'not conformant'}</div>
          <div class="build-verdict-line">MUST <b>${v.must.passed}/${v.must.total}</b>${v.should.total ? ` · SHOULD <b>${v.should.passed}/${v.should.total}</b>` : ''}</div>
          <div class="build-verdict-states">
            <span class="is-pass"><b>${GLYPH.pass}</b> ${k.pass} pass</span>
            <span class="is-placeholder"><b>${GLYPH.placeholder}</b> ${k.placeholder} on a placeholder</span>
            <span class="is-fail"><b>${GLYPH.fail}</b> ${k.fail} fail</span>
          </div>
          ${v.failing.length ? `<ul class="build-verdict-failing">${v.failing.map(f => `<li><span class="build-sev build-sev-${f.severity.toLowerCase()}">${f.severity}</span> ${escapeHtml(f.description)} <code>${escapeHtml(f.id)}</code></li>`).join('')}</ul>` : ''}
          ${v.onPlaceholder.length ? `<div class="build-verdict-note">${v.onPlaceholder.length} clause${v.onPlaceholder.length === 1 ? '' : 's'} pass${v.onPlaceholder.length === 1 ? 'es' : ''} on a placeholder: the rubric reads no annotations, so a pager route of <code>pagerduty://…</code> satisfies it like a real one. Conformant on paper pages nobody — the todos below are the difference.</div>` : ''}
        </div>
        <div class="build-verdict build-verdict-schema ${model.schema.ok ? 'is-ok' : 'is-fail'}">
          <div class="build-verdict-key">Schema</div>
          <div class="build-verdict-big">${model.schema.ok ? 'valid' : `${model.schema.errors.length} error${model.schema.errors.length === 1 ? '' : 's'}`}</div>
          <div class="build-verdict-line">ObservabilityPack spec v1.2</div>
          ${model.schema.errors.length ? `<ul class="build-verdict-errors">${model.schema.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}
        </div>
        <div class="build-verdict build-verdict-warn ${model.warnings.length ? (model.blocking ? 'is-fail' : 'is-warn') : 'is-ok'}">
          <div class="build-verdict-key">Warnings</div>
          <div class="build-verdict-big">${model.warnings.reduce((n, g) => n + g.items.length, 0)}</div>
          <div class="build-verdict-line">promql · sli-excluded · burn-rules</div>
          ${model.warnings.length ? model.warnings.map(g => `
            <div class="build-warning-group${g.blocking ? ' is-blocking' : ''}">
              <div class="build-warning-kind">${escapeHtml(g.label)} <span>${g.items.length}</span>${g.blocking ? ' <em>blocking</em>' : ''}</div>
              <ul>${g.items.map(w => `<li>${escapeHtml(w.message)}</li>`).join('')}</ul>
            </div>`).join('') : '<div class="build-verdict-note">none — every SLI expression parses with the params in, and the burn-rule generator had nothing to say</div>'}
        </div>
      </div>` : ''}

      ${model.ready ? `
      <div class="build-todos">
        <div class="build-section-key">Todos <span class="build-count">${model.todoCount}</span>
          <span class="build-section-sub">placeholders and scaffold defaults only the team can fill — <b>${model.placeholdersRemaining}</b> placeholder param${model.placeholdersRemaining === 1 ? '' : 's'} still at their default. Fill one inline (Enter or leave the field) and the pack regenerates; a todo whose value is filled disappears.</span>
        </div>
        ${model.todoGroups.length ? model.todoGroups.map(g => `
          <div class="build-todo-group">
            <div class="build-todo-group-head">${escapeHtml(g.label)} <span>${g.todos.length}</span></div>
            <ul class="build-todo-list">${g.todos.map(t => todoHtml(t, todoIndex++)).join('')}</ul>
          </div>`).join('') : '<div class="build-note build-note-ok">No todos: every placeholder is filled and the scaffold has nothing left to hand over.</div>'}
      </div>

      <div class="build-artifacts">
        <div class="build-section-key">Artefacts <span class="build-section-sub">what the pack compiles to today, through the same targets Remediate deploys — previewed from the generated canonical, nothing registered</span></div>
        <div class="build-artifact-grid">
          ${model.artifacts.map(a => `
            <div class="build-artifact${model.preview?.target === a.id ? ' is-open' : ''}" data-target="${escapeHtml(a.id)}">
              <div class="build-artifact-label">${escapeHtml(a.label)}</div>
              <div class="build-artifact-desc">${escapeHtml(a.description)}</div>
              <div class="build-artifact-actions">
                <button type="button" class="ctrl-btn" data-act="preview" aria-label="preview ${escapeHtml(a.label)}">${model.preview?.target === a.id ? 'previewing' : 'preview'}</button>
                <button type="button" class="ctrl-btn" data-act="download" aria-label="download ${escapeHtml(a.label)}">download</button>
              </div>
            </div>`).join('')}
        </div>
        ${model.preview ? `
          <div class="build-preview">
            <div class="build-preview-head">
              <span class="build-preview-name">${escapeHtml(model.preview.label)} · <code>${escapeHtml(model.preview.filename)}</code>${model.preview.profile ? ` · ${escapeHtml(model.preview.profile.label || `${model.preview.profile.product} ${model.preview.profile.version}`)}` : ''}</span>
              <span class="build-preview-actions"><button type="button" class="ctrl-btn" id="build-preview-download">download</button><button type="button" class="ctrl-btn" id="build-preview-close">close</button></span>
            </div>
            ${model.preview.error ? `<div class="build-note build-note-err">${escapeHtml(model.preview.error)}</div>` : ''}
            ${(model.preview.warnings || []).length ? `<div class="build-note build-note-warn">${model.preview.warnings.length} compile warning${model.preview.warnings.length === 1 ? '' : 's'}: ${model.preview.warnings.slice(0, 3).map(w => escapeHtml(w)).join(' · ')}${model.preview.warnings.length > 3 ? ' …' : ''}</div>` : ''}
            ${model.preview.content != null ? `<pre class="crawl-result-yaml build-yaml-pre">${escapeHtml(model.preview.content)}</pre>` : ''}
          </div>` : ''}
      </div>

      <footer class="build-step-actions">
        <span class="build-actions-left">
          <button type="button" class="ctrl-btn build-back" id="build-back">← Compile</button>
          <button type="button" class="ctrl-btn build-adjust" id="build-adjust" title="Back to Define — change the service, its tier or the library entries">Resolve or adjust</button>
        </span>
        <span class="build-step-status">${({
          registered: `Registered as <code>${escapeHtml(model.registeredId || '')}</code> — continuing again re-registers the current pack.`,
          ready: escapeHtml(model.readyText),
          error: 'The last compilation failed — fix the rejected value above; the pack shown is the previous one and is not handed off.',
          promql: 'A PromQL warning blocks the hand-off — fix the param first.',
          schema: 'The pack does not validate against the schema — see the schema card.',
        })[model.handoff]}</span>
        <span class="build-actions-right">
          <button type="button" class="ctrl-btn" id="build-yaml-download">download pack yaml</button>
          <button type="button" class="mcp-refresh-btn build-next" id="build-open" ${model.canRegister ? '' : 'disabled'}>${escapeHtml(model.continueLabel)} <span aria-hidden="true">→</span></button>
        </span>
      </footer>` : ''}
    </section>`;

  wireParamInputs(container, act);
  container.querySelectorAll('.build-artifact').forEach(card => {
    const target = card.dataset.target;
    card.querySelector('[data-act="preview"]').addEventListener('click', () => act.preview(target));
    card.querySelector('[data-act="download"]').addEventListener('click', () => act.downloadArtifact(target));
  });
  container.querySelector('#build-preview-download')?.addEventListener('click', () => {
    const p = model.preview;
    if (p?.content != null) downloadText(p.filename, p.content, p.contentType || 'text/plain');
  });
  container.querySelector('#build-preview-close')?.addEventListener('click', () => act.update({ preview: null }, { rerender: true, reinstantiate: false }));
  container.querySelector('#build-yaml-download')?.addEventListener('click', () => downloadText(model.fileName, model.yaml, 'application/x-yaml'));
  container.querySelector('#build-back')?.addEventListener('click', () => act.setStep('compile'));
  container.querySelector('#build-adjust')?.addEventListener('click', () => act.setStep('define'));
  container.querySelector('#build-open')?.addEventListener('click', () => act.openInDiscover());
}
