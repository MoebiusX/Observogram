// studio/build-verify-view.mjs
//
// BUILD step 3 — VERIFY, "Is it ready to use?": the conformance verdict at
// the tier (MUST / SHOULD counts, the three clause states — pass, pass on a
// placeholder, fail — and the maturity per layer: the clause pass ratio of
// each dimension with pass-on-placeholder as its own segment), the schema
// verdict, the warnings (promql, sli-excluded, burn-rules), then the layer
// stack with the todos pinned to the slab of the artefact each names —
// routes and runbooks on L4, backends / pipelines / storage on L2, probes /
// chaos / baselines on L5 — the param that fills each one editable inline
// (editing re-instantiates), the artefacts (one card per compile target with
// preview and download), "Download pack YAML" and "Ready to continue?" —
// resolve or adjust (back at Define) or continue with visible gaps, which
// registers the pack the way an upload is registered and hands it to the
// analysis journey, saying how many placeholders remain.
//
// Renderer only (docs/UI_CONVENTIONS.md §2-3): render(container, model, host)
// with buildVerifyModel's output; host.build.* are the actions.

import { escapeHtml, downloadText } from './util.mjs';
import { host as appHost } from './host.mjs';
import { stepHeadHtml, instantiateErrorHtml } from './build-define-view.mjs';
import { buildStackHtml, wireBuildStack } from './build-stack-view.mjs';

const GLYPH = { pass: '✓', placeholder: '◐', fail: '✗' };

/** The per-layer maturity bars: clause counts per dimension, pass on a placeholder its own segment. */
function maturityHtml(rows) {
  if (!rows.length) return '';
  return `
    <div class="build-maturity" aria-label="maturity per layer">
      ${rows.map(m => `
        <div class="build-maturity-row" data-layer="${escapeHtml(m.id)}" title="${escapeHtml(`${m.num} ${m.name}: ${m.pass} pass · ${m.placeholder} on a placeholder · ${m.fail} fail${m.pending ? ` · ${m.pending} not evaluated` : ''} — of ${m.total} clause${m.total === 1 ? '' : 's'} at this tier`)}">
          <span class="build-maturity-name"><b>${escapeHtml(m.num)}</b>${escapeHtml(m.name)}</span>
          <span class="build-maturity-bar">
            <span class="build-maturity-seg is-pass" style="width:${m.passPct}%"></span>
            <span class="build-maturity-seg is-placeholder" style="width:${m.placeholderPct}%"></span>
            <span class="build-maturity-seg is-fail" style="width:${m.failPct}%"></span>
            <span class="build-maturity-seg is-pending" style="width:${m.pendingPct}%"></span>
          </span>
          <span class="build-maturity-pct">${m.pct == null ? 'n/a' : `${m.pct}%`}</span>
        </div>`).join('')}
      <div class="build-maturity-legend"><span class="is-pass"><i></i>pass</span><span class="is-placeholder"><i></i>pass on a placeholder</span><span class="is-fail"><i></i>fail</span></div>
    </div>`;
}

/** render(container, model, host) — the VERIFY step. */
export function renderBuildVerify(container, model, host = appHost) {
  const act = host.build;
  const v = model.verdict;
  const k = model.checklist.counts;
  const stack = model.stack;
  container.innerHTML = `
    <section class="build-step build-verify">
      ${stepHeadHtml('verify', 'Is it ready to use?', `The pack as generated, read three ways: the tier’s conformance rubric (which clauses pass, which pass only on a placeholder, which fail — per layer), the v1.2 schema, and the artefacts it compiles to. The todos sit on the layer they live on; fill a placeholder inline and the pack regenerates; when it holds up, continue to Discover.`)}

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
          ${maturityHtml(model.maturity)}
          ${v.onPlaceholder.length ? `<div class="build-verdict-note">${v.onPlaceholder.length} clause${v.onPlaceholder.length === 1 ? '' : 's'} pass${v.onPlaceholder.length === 1 ? 'es' : ''} on a placeholder: the rubric reads no annotations, so a pager route of <code>pagerduty://…</code> satisfies it like a real one. Conformant on paper pages nobody — the todos on the slabs below are the difference.</div>` : ''}
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
      <div class="build-todos build-stack-wrap">
        <div class="build-section-key">The pack, layer by layer — with its todos <span class="build-count">${model.todoCount}</span>
          <span class="build-section-sub">each todo sits on the slab of the artefact it names (routes and runbooks on L4, backends, pipelines and storage on L2, probes, chaos and baselines on L5) — placeholders and scaffold defaults only the team can fill, <b>${model.placeholdersRemaining}</b> placeholder param${model.placeholdersRemaining === 1 ? '' : 's'} still at their default. Fill one inline (Enter or leave the field) and the pack regenerates; a todo whose value is filled disappears and its card stops being Scaffold. A slab’s edge is the rubric’s verdict for that layer; click it for the clauses.</span>
        </div>
        ${model.todoCount ? '' : '<div class="build-note build-note-ok">No todos: every placeholder is filled and the scaffold has nothing left to hand over.</div>'}
        ${buildStackHtml(stack)}
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

  wireBuildStack(container, stack, host);
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
