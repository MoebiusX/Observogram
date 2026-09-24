// studio/schema-view.mjs
//
// The Schema view (Advanced) — the canonical manifest as the studio sees it:
// an identity block, a validation note, and the lazily-fetched canonical
// YAML with copy / download. Self-contained: it renders into a host element
// and fetches its own YAML, with no back-references into the orchestrator.

import { state, $ } from './state.mjs';
import { focusedPack, focusedPackId, focusedEnv, effectiveFocus } from './focus.mjs';
import { escapeHtml } from './util.mjs';

export function renderSchemaView(host) {
  const pack    = focusedPack();
  const packId  = focusedPackId();
  const env     = focusedEnv() || pack?.meta?.environment;
  if (!pack) {
    host.innerHTML = '<div class="placeholder">No pack loaded.</div>';
    return;
  }

  const wrap = document.createElement('section');
  wrap.className = 'section schema-view';
  wrap.dataset.layer = 'SCHEMA';
  wrap.dataset.focus = effectiveFocus();
  host.appendChild(wrap);

  // ---------- header ----------
  const focusBadge = state.packB ? ` · pack ${effectiveFocus().toUpperCase()} (${escapeHtml(pack?.id || '')})` : '';
  const sectionHead = document.createElement('div');
  sectionHead.className = 'section-head';
  sectionHead.innerHTML = `
    <span class="section-num">SCHEMA</span>
    <span class="section-name">Canonical manifest · ObservabilityPack v1.3${focusBadge}</span>
    <span class="section-count">${escapeHtml(pack?.meta?.binding || 'unknown binding')}</span>
  `;
  wrap.appendChild(sectionHead);

  // ---------- identity block ----------
  const id = document.createElement('div');
  id.className = 'schema-identity';
  const m = pack.meta || {};
  const rows = [
    ['apiVersion',  m.apiVersion],
    ['kind',        m.kind],
    ['metadata.name', m.name || pack.id || pack.name],
    ['metadata.version', m.version],
    ['binding',      m.binding],
    ['criticality',  m.criticality],
    ['environment',  m.environment],
    ['target',       m.target],
    ['owners',       Array.isArray(m.owners) ? m.owners.join(', ') : m.owners],
  ];
  id.innerHTML = `
    <div class="schema-identity-head">Identity</div>
    <dl class="schema-identity-list">
      ${rows.map(([k, v]) => `
        <div class="schema-identity-row">
          <dt>${escapeHtml(k)}</dt>
          <dd>${v ? `<code>${escapeHtml(String(v))}</code>` : '<em>—</em>'}</dd>
        </div>
      `).join('')}
    </dl>
  `;
  wrap.appendChild(id);

  // ---------- validation block ----------
  // Catalog presence = pack passed canonical validation when it was
  // loaded. We surface that as a green pass; if it ever failed, the
  // pack wouldn't be in the picker. The link points at the schema
  // source so a curious engineer can read the rules themselves.
  const validation = document.createElement('div');
  validation.className = 'schema-validation';
  validation.innerHTML = `
    <div class="schema-validation-head">Validation</div>
    <div class="schema-validation-status is-pass">
      <span class="schema-validation-pip">✓</span>
      <span class="schema-validation-msg">
        Validates against the canonical
        <a href="https://github.com/MoebiusX/otel-observability-pack/blob/main/schema/observability-pack.schema.json" target="_blank" rel="noopener">ObservabilityPack v1.3 JSON Schema</a>.
        Packs that fail validation never appear in the catalog.
      </span>
    </div>
    <div class="schema-validation-meta">
      Schema source: <code>vendor/observability-pack-spec/v1.3/observability-pack.schema.json</code> ·
      <a href="https://github.com/MoebiusX/otel-observability-pack/blob/main/spec/ObservabilityPack-Spec.md" target="_blank" rel="noopener">Spec document</a>
    </div>
  `;
  wrap.appendChild(validation);

  // ---------- canonical YAML pane ----------
  const yamlBox = document.createElement('div');
  yamlBox.className = 'schema-yaml-box';
  yamlBox.innerHTML = `
    <div class="schema-yaml-head">
      <span class="schema-yaml-title">Canonical YAML</span>
      <span class="schema-yaml-meta" id="schema-yaml-meta">loading…</span>
      <button id="schema-yaml-copy" type="button" class="ctrl-btn schema-yaml-copy">copy</button>
      <a id="schema-yaml-download" class="ctrl-btn schema-yaml-download" download>download</a>
    </div>
    <pre class="schema-yaml-body" id="schema-yaml-body" role="region" aria-label="Canonical pack YAML">loading…</pre>
  `;
  wrap.appendChild(yamlBox);

  // Lazy-fetch the YAML.
  const cacheKey = `${packId}::${env || ''}`;
  state._schemaYaml = state._schemaYaml || {};
  const apply = (text) => {
    const body = $('#schema-yaml-body');
    const meta = $('#schema-yaml-meta');
    if (!body || !meta) return;
    body.textContent = text;
    const bytes = new Blob([text]).size;
    const lines = text.split('\n').length;
    meta.textContent = `${lines} lines · ${(bytes / 1024).toFixed(1)} KB`;
    const dl = $('#schema-yaml-download');
    if (dl) {
      const slug = (m.name || pack.id || 'pack').toString().replace(/[^a-z0-9-]+/gi, '-');
      dl.href = `data:application/x-yaml;charset=utf-8,${encodeURIComponent(text)}`;
      dl.setAttribute('download', `${slug}.pack.yaml`);
    }
    const copy = $('#schema-yaml-copy');
    if (copy) {
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(text); copy.textContent = 'copied'; setTimeout(() => copy.textContent = 'copy', 1200); }
        catch (_) { copy.textContent = 'select all'; setTimeout(() => copy.textContent = 'copy', 1200); }
      };
    }
  };

  if (state._schemaYaml[cacheKey]) {
    apply(state._schemaYaml[cacheKey]);
    return;
  }

  const envQ = env ? `?env=${encodeURIComponent(env)}&format=yaml` : '?format=yaml';
  fetch(`/api/packs/${encodeURIComponent(packId)}/canonical${envQ}`, {
    headers: { Accept: 'application/x-yaml' },
  }).then(async r => {
    const text = await r.text();
    if (!r.ok) throw new Error(`server ${r.status}: ${text.slice(0, 200)}`);
    state._schemaYaml[cacheKey] = text;
    apply(text);
  }).catch(e => {
    const body = $('#schema-yaml-body');
    const meta = $('#schema-yaml-meta');
    if (body) body.textContent = `# Failed to load canonical YAML: ${e.message}`;
    if (meta) meta.textContent = 'error';
  });
}
