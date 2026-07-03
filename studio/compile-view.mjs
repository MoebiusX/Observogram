// studio/compile-view.mjs
//
// The Compile / Remediate / Deploy workflow — Remediate's set-operation band
// and the per-artefact compile catalog (pack -> Prometheus rules, Grafana
// dashboards, OTel pipelines, Alertmanager routes), plus the deploy panel.
// Re-render + deploy-modal entrypoints come through the studio host seam
// (host.mjs); compare-cluster helpers are imported from compare-view.mjs.

import { state } from './state.mjs';
import { api } from './api.mjs';
import { escapeHtml, toast } from './util.mjs';
import {
  effectiveFocus, focusedPack, focusedPackId, focusedEnv,
  focusedCompileCatalog, setFocusedCompileCatalog,
  focusedCompileContent, setFocusedCompileContent,
  focusedCompileGroup, setFocusedCompileGroup,
  focusedCompileFlavor, setFocusedCompileFlavor,
  focusedCompileArtifact, setFocusedCompileArtifact,
} from './focus.mjs';
import { host as appHost } from './host.mjs';
import { catalogEntryFor, layerItemsFor, loadDiff, LAYERS_FOR_DIFF, renderLiveScopeControl } from './compare-view.mjs';
import { artefactLabel, deploySelectionFromEntries, deploySurfaceForArtefact } from './artifact-model.mjs';

// ---------- COMPILE view ----------
//
// Pack -> real, ingestible platform artefacts. The pack is the contract;
// this is the program. Spec §9's reference-implementation table made real.

async function loadCompileTargets() {
  if (state.compileTargets) return state.compileTargets;
  try {
    const r = await api('/api/compile/targets');
    state.compileTargets = r.targets || [];
  } catch (_) {
    state.compileTargets = [];
  }
  return state.compileTargets;
}

export async function loadDeployMatrix() {
  if (state.deployMatrix) return state.deployMatrix;
  try { state.deployMatrix = await api('/api/deploy/matrix'); }
  catch (_) { state.deployMatrix = { products: [], versions: {}, scopes: [], targets: {} }; }
  return state.deployMatrix;
}

function isDeployable(target) {
  return !!state.deployMatrix?.targets?.[target]?.deployable;
}
function targetScopable(target) {
  return !!state.deployMatrix?.targets?.[target]?.scopable;
}

async function loadCompileCatalog() {
  const packId = focusedPackId();
  const env = focusedEnv();
  // No pack id available — fall through to the error sentinel so
  // renderCompileView shows a message instead of looping. Uploaded /
  // crawled / drafted packs now register server-side and get a real id;
  // hitting this branch means something else went wrong (e.g. the user
  // is on home with no pack, or an upload failed validation).
  if (!packId) {
    setFocusedCompileCatalog({ error: 'No pack selected.', groups: [] });
    return focusedCompileCatalog();
  }
  const params = new URLSearchParams();
  if (env) params.set('env', env);
  try {
    const r = await fetch(`/api/packs/${encodeURIComponent(packId)}/compile-catalog?${params}`);
    if (!r.ok) {
      // CRITICAL: must NOT leave catalog null on failure. renderCompileView
      // re-fires loadCompileCatalog every time the catalog is null, so a
      // persistent 4xx/5xx (e.g. uploaded packs the server doesn't know
      // about under their __uploaded__ id) would loop a fetch-and-render
      // chain forever — that was the cause of the krystalinex-pack hang.
      // Store an error sentinel so the next render shows an explanation.
      let msg = `HTTP ${r.status}`;
      try {
        const ct = r.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const j = await r.json();
          if (j?.error) msg = j.error;
        }
      } catch (_) {}
      setFocusedCompileCatalog({ error: msg, groups: [] });
      return focusedCompileCatalog();
    }
    const cat = await r.json();
    setFocusedCompileCatalog(cat);
    // Reconcile current selection with what's available (the pack may
    // have changed since last view).
    const groups = cat.groups || [];
    const g = groups.find(x => x.id === focusedCompileGroup()) || groups[0];
    if (!g) return cat;
    setFocusedCompileGroup(g.id);
    if (!g.flavors?.some(f => f.id === focusedCompileFlavor())) {
      setFocusedCompileFlavor(g.flavors?.[0]?.id || null);
    }
    if (!g.items?.some(it => it.id === focusedCompileArtifact())) {
      setFocusedCompileArtifact(g.items?.[0]?.id || 'all');
    }
  } catch (e) {
    // Network error / parse error — same loop-prevention as above.
    setFocusedCompileCatalog({ error: e.message || 'network error', groups: [] });
  }
  return focusedCompileCatalog();
}

// Map (group, flavor) → legacy deploy target id used by isDeployable() and the
// deploy panel. Until per-artifact deploy lands, deploys are still
// per-target (whole-file) so we resolve the active selection to the
// closest legacy target name.
function legacyDeployTargetFor(group) {
  if (group === 'rules')        return 'prometheus-rules';
  if (group === 'dashboards')   return 'grafana-dashboard';
  if (group === 'pipelines')    return 'otel-collector';
  if (group === 'alertmanager') return 'alertmanager';
  return null;
}

async function loadCompiled() {
  const packId = focusedPackId();
  const env = focusedEnv();
  if (!packId) { setFocusedCompileContent(null); return; }
  // Reset cached content so a switch between artifacts/flavors re-fetches.
  const params = new URLSearchParams();
  if (env) params.set('env', env);
  params.set('group', focusedCompileGroup());
  if (focusedCompileFlavor())   params.set('flavor', focusedCompileFlavor());
  if (focusedCompileArtifact()) params.set('artifact', focusedCompileArtifact());
  const url = `/api/packs/${encodeURIComponent(packId)}/compile-artifact?${params}`;
  try {
    const r = await fetch(url);
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      if (ct.includes('application/json')) {
        const j = await r.json().catch(() => null);
        if (j?.error) msg = j.error;
      }
      setFocusedCompileContent({ error: msg });
      return;
    }
    const text = await r.text();
    setFocusedCompileContent({
      filename: parseCdFilename(r.headers.get('content-disposition'))
        || `${packId}.${focusedCompileGroup()}.${focusedCompileArtifact()}`,
      contentType: ct.split(';')[0].trim(),
      text,
      source: r.headers.get('x-pack-source'),
      group: r.headers.get('x-compile-group'),
      flavor: r.headers.get('x-compile-flavor'),
      artifact: r.headers.get('x-compile-artifact'),
    });
  } catch (e) {
    setFocusedCompileContent({ error: e.message });
  }
}

function parseCdFilename(cd) {
  if (!cd) return null;
  const m = /filename="([^"]+)"/.exec(cd);
  return m ? m[1] : null;
}

// ============================================================
// Schema view — distinct from Conformance.
//
// Conformance answers "how MATURE is this pack?" against the maturity
// rubric (MUST/SHOULD per tier). The Schema view answers "how does
// this pack STAND UP against the v1.2 canonical schema?" — the
// structural question. Three sections:
//
//   1. Identity block — apiVersion / kind / metadata fields, the
//      canonical "what is this pack" header. Reads the same fields
//      a packlint would key on.
//   2. Validation status — pulled from the catalog (only validating
//      packs land in the catalog) plus a link to the schema source.
//   3. Canonical YAML — the manifest verbatim. Read-only, scrollable,
//      monospaced. The single source of truth for the pack.
//
// Caches the YAML per (pack-id, env) under state._schemaYaml so
// switching tabs back doesn't re-fetch.
// renderSchemaView now lives in studio/schema-view.mjs (imported above).
// ============================================================

// ============================================================
// OTLP coverage view (spec §3) — answers the question every fintech
// auditor will ask: "what OTLP-shaped wire does this pack run on?"
//
//   ┌────────────────────────────────────────────────────────────┐
//   │ OTLP · WIRE PROTOCOL COVERAGE                              │
//   │ grafana-reference · tier-2 · prod                          │
//   ├────────────────────────────────────────────────────────────┤
//   │ Receiver                                                    │
//   │ ✓ otlp receiver declared (spec MUST)                       │
//   │ Protocols: ● gRPC ● HTTP                                    │
//   │ Endpoint:  0.0.0.0:4317                                     │
//   ├────────────────────────────────────────────────────────────┤
//   │ Per-signal coverage                                         │
//   │   Signal      Receiver (in)         Exporter (out)         │
//   │   traces      ● OTLP                ● OTLP → tempo:4317   │
//   │   metrics     ● OTLP                ○ prometheusremotewrite│
//   │   logs        ● OTLP                ○ loki native          │
//   │   profiles    ○ not configured      — (pyroscope native)   │
//   ├────────────────────────────────────────────────────────────┤
//   │ SDK contract                                                │
//   │ Semconv 1.27.0 · propagators: tracecontext, baggage        │
//   │ Languages: java, node · Sampling: parentbased 0.1          │
//   │ Resource: service.name, service.namespace, service.version │
//   ├────────────────────────────────────────────────────────────┤
//   │ Summary: 3 of 4 signals wired · 1 end-to-end OTLP          │
//   └────────────────────────────────────────────────────────────┘
//
// Reads from the canonical pack (fetched once, cached). The layered
// display shape doesn't carry pipelines/otel under stable paths.
// renderOtlpView / renderOtlpBody now live in studio/otlp-view.mjs.
// ============================================================

// ============================================================
// RECONCILIATION PLAN — the bidirectional band that leads Remediate.
//
// "Fix the gaps" starts by deciding which direction each gap flows:
//
//   repo → live   — Pack A declares it, live does not; deploy or delete intent
//   live → repo   — live has it, Pack A does not; retrofeed or mark out of scope
//   drifted       — both sides have it but behaviour differs; choose source of truth
//
// The default with Pack B loaded is bidirectional: deployment rows for
// repo→live plus a generated ReconcilePatch for live→repo. That models
// the real operating loop: close production gaps and bring production
// truth back into code.
// ============================================================

// The active set operation, resolving the null default by Pack-B
// presence. B / ∪ / − require Pack B; without it we clamp to 'A'.
function effectiveRemediateOp() {
  const legacy = { A: 'deploy', B: 'retrofeed', AUB: 'all', 'A-B': 'deploy' };
  const op = legacy[state.remediateOp] || state.remediateOp || (state.packB ? 'all' : 'deploy');
  if (!state.packB && op !== 'deploy') return 'deploy';
  return op;
}

// Resolve a set operation to a per-layer artefact list. Uses the
// server-computed diff (state.diff) for B / ∪ / − so the membership
// matches the Diagnose drill exactly; falls back to whole-pack walks
// when the diff isn't present (op 'A', or B-ops before the diff loads).
function resolveRemediationSet(op) {
  const haveB = !!state.packB;
  const diff = (state.diff && !state.diff.error && state.diff.layers) ? state.diff : null;
  const out = { byLayer: {}, total: 0, deployable: 0, author: 0, retrofeed: 0, drift: 0, needsDiff: false };

  for (const L of LAYERS_FOR_DIFF) {
    let entries = [];
    if (op === 'deploy' || !haveB) {
      if (!diff) { out.needsDiff = true; entries = layerItemsFor(state.pack, L).map(a => ({ art: a })); }
      else entries = (diff.layers[L]?.onlyInA || []).map(e => ({ art: e.artefact, direction: 'deploy', identity: e.key }));
    } else if (op === 'retrofeed') {
      if (!diff) { out.needsDiff = true; entries = []; }
      else entries = (diff.layers[L]?.onlyInB || []).map(e => ({ art: e.artefact, direction: 'retrofeed', identity: e.key }));
    } else if (op === 'drift') {
      if (!diff) { out.needsDiff = true; entries = []; }
      else entries = (diff.layers[L]?.inBoth || [])
        .filter(e => e.match === 'drifted')
        .map(e => ({ art: e.a, artB: e.b, deltas: e.deltas || [], direction: 'drift', identity: e.key }));
    } else if (op === 'all') {
      if (!diff) { out.needsDiff = true; entries = []; }
      else entries = [
        ...(diff.layers[L]?.onlyInA || []).map(e => ({ art: e.artefact, direction: 'deploy', identity: e.key })),
        ...(diff.layers[L]?.onlyInB || []).map(e => ({ art: e.artefact, direction: 'retrofeed', identity: e.key })),
        ...(diff.layers[L]?.inBoth || [])
          .filter(e => e.match === 'drifted')
          .map(e => ({ art: e.a, artB: e.b, deltas: e.deltas || [], direction: 'drift', identity: e.key })),
      ];
    }
    const enriched = entries
      .filter(e => e.art)
      .map(e => {
        const deploySurface = deploySurfaceForArtefact(e.art);
        const deployable = e.direction === 'deploy' ? deploySurface.deployable : false;
        return { ...e, ...deploySurface, deployable };
      });
    if (enriched.length) {
      out.byLayer[L] = enriched;
      out.total += enriched.length;
      out.deployable += enriched.filter(e => e.deployable).length;
      out.retrofeed += enriched.filter(e => e.direction === 'retrofeed').length;
      out.drift += enriched.filter(e => e.direction === 'drift').length;
      out.author += enriched.filter(e => !e.deployable).length;
    }
  }
  return out;
}

// Selected deployable identities = all deployable in the set minus the
// ones the user unchecked. `rows` is the count the deploy modal will show
// after expanding SLOs into recording + alerting rows.
function remediationSelectedDeployment(resolved) {
  const deselected = state.remediateDeselected || new Set();
  const entries = [];
  for (const L of LAYERS_FOR_DIFF) {
    entries.push(...(resolved.byLayer[L] || []));
  }
  return deploySelectionFromEntries(entries, deselected);
}

const REMEDIATE_OPS = [
  { id: 'all',       label: 'Bidirectional', sub: 'repo ↔ live',  needsB: true  },
  { id: 'deploy',    label: 'Deploy',        sub: 'repo → live',  needsB: false },
  { id: 'retrofeed', label: 'Retrofeed',     sub: 'live → repo',  needsB: true  },
  { id: 'drift',     label: 'Reconcile',     sub: 'field drift',  needsB: true  },
];

const REMEDIATE_LAYER_NAMES = { L1:'Contract', L2:'Telemetry', L2X:'Extended', L3:'Insight', L4:'Action', L5:'Validation', GOV:'Governance' };

// The remediation plan band — leads the Remediate view. Appends to host.
function renderRemediationPlan(host) {
  const op = effectiveRemediateOp();
  const haveB = !!state.packB;

  const wrap = document.createElement('div');
  wrap.className = 'remediate-plan';

  // ---- Set-operation selector ----
  const bName = haveB
    ? (catalogEntryFor(state.compareBId)?.label || state.packB?.meta?.name || state.packB?.id || 'Pack B')
    : null;
  const opsHtml = REMEDIATE_OPS.map(o => {
    const disabled = o.needsB && !haveB;
    return `<button type="button" class="remediate-op${o.id === op ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}"
      data-op="${o.id}" ${disabled ? 'disabled title="Load a Pack B from the header to enable"' : ''}>
      <span class="remediate-op-label">${escapeHtml(o.label)}</span>
      <span class="remediate-op-sub">${escapeHtml(o.sub)}</span>
    </button>`;
  }).join('');

  wrap.innerHTML = `
    <div class="remediate-plan-head">
      <span class="remediate-plan-eyebrow">RECONCILE</span>
      How do we close the loop?
      ${haveB ? `<span class="remediate-plan-vs">A = your pack · B = <strong>${escapeHtml(bName)}</strong></span>`
              : `<span class="remediate-plan-vs">Load a <strong>Pack B</strong> from the header to unlock live→repo retrofeed and drift decisions</span>`}
    </div>
    <div class="remediate-ops">${opsHtml}</div>
  `;

  // Scope control (item 5): the remediation sets are carved from the same
  // scoped diff as Diagnose — expose the scope HERE too, so what's parked
  // out of scope is a visible choice while deciding what to deploy, not a
  // silent precondition. Changing it refreshes the diff and re-renders.
  if (haveB) wrap.appendChild(renderLiveScopeControl({ standalone: true }));

  // Wire op buttons.
  wrap.querySelectorAll('.remediate-op:not(.is-disabled)').forEach(btn => {
    btn.onclick = () => {
      state.remediateOp = btn.dataset.op;
      state.remediateDeselected = new Set();   // reset curation on op change
      appHost.renderMainView();
    };
  });

  // ---- Resolve the set ----
  const resolved = resolveRemediationSet(op);

  // B-ops need the diff; load it lazily, then re-render.
  if (resolved.needsDiff && haveB && state.compareBId) {
    const loading = document.createElement('div');
    loading.className = 'remediate-loading';
    loading.textContent = 'Computing the set…';
    wrap.appendChild(loading);
    host.appendChild(wrap);
    loadDiff().then(() => appHost.renderMainView());
    return;
  }

  const selectedDeployment = remediationSelectedDeployment(resolved);

  // ---- Summary tiles ----
  const summary = document.createElement('div');
  summary.className = 'remediate-summary';
  const opMeaning = {
    all:       'Bidirectional plan: deploy repo-only intent, retrofeed live-only evidence, and decide drifted fields.',
    deploy:    `Artefacts in your pack but not in ${escapeHtml(bName || 'Pack B')} — deploy delta or delete stale intent.`,
    retrofeed: `Artefacts live in ${escapeHtml(bName || 'Pack B')} but missing from your pack — generate a repo retrofeed patch.`,
    drift:     'Matched artefacts whose decision-bearing fields diverge — choose repo or live as source of truth.',
  };
  summary.innerHTML = `
    <div class="remediate-summary-lede">${opMeaning[op] || ''}</div>
    <div class="remediate-tiles">
      <div class="remediate-tile is-total"><div class="remediate-tile-n">${resolved.total}</div><div class="remediate-tile-l">in set</div></div>
      <div class="remediate-tile is-deployable"><div class="remediate-tile-n">${selectedDeployment.rows}</div><div class="remediate-tile-l">deploy rows selected</div></div>
      <div class="remediate-tile is-retrofeed"><div class="remediate-tile-n">${resolved.retrofeed}</div><div class="remediate-tile-l">repo patch items</div></div>
      <div class="remediate-tile is-drift"><div class="remediate-tile-n">${resolved.drift}</div><div class="remediate-tile-l">field decisions</div></div>
    </div>
  `;
  wrap.appendChild(summary);

  if (resolved.total === 0) {
    const empty = document.createElement('div');
    empty.className = 'remediate-empty';
    empty.textContent = op === 'deploy'
      ? 'Nothing to deploy — your pack has no artefacts beyond Pack B.'
      : 'This set is empty.';
    wrap.appendChild(empty);
    host.appendChild(wrap);
    return;
  }

  const patchText = buildRetrofeedPatchText(resolved, bName);
  if (patchText) {
    const patch = document.createElement('details');
    patch.className = 'remediate-patch';
    patch.open = true;
    patch.innerHTML = `
      <summary>Repo retrofeed patch (${resolved.retrofeed} item${resolved.retrofeed === 1 ? '' : 's'})</summary>
      <pre>${escapeHtml(patchText)}</pre>
    `;
    wrap.appendChild(patch);
  }

  // ---- Per-layer, per-item checklist ----
  const list = document.createElement('div');
  list.className = 'remediate-list';
  const deselected = state.remediateDeselected || (state.remediateDeselected = new Set());
  for (const L of LAYERS_FOR_DIFF) {
    const entries = resolved.byLayer[L];
    if (!entries || !entries.length) continue;
    const layerEl = document.createElement('div');
    layerEl.className = 'remediate-layer';
    const depCount = entries.reduce((sum, e) => sum + (e.deployable ? (e.deployRows || 1) : 0), 0);
    layerEl.innerHTML = `
      <div class="remediate-layer-head">
        <span class="remediate-layer-num">${L}</span>
        <span class="remediate-layer-name">${escapeHtml(REMEDIATE_LAYER_NAMES[L] || L)}</span>
        <span class="remediate-layer-count">${entries.length}${depCount ? ` · ${depCount} deploy row${depCount === 1 ? '' : 's'}` : ''}</span>
      </div>
    `;
    const ul = document.createElement('ul');
    ul.className = 'remediate-items';
    for (const e of entries) {
      const li = document.createElement('li');
      const checked = e.deployable && e.identity && !deselected.has(e.identity);
      li.className = `remediate-item is-${e.direction || 'deploy'}` + (e.deployable ? '' : ' is-author');
      const labelText = artefactLabel(e.art, e.identity || '—');
      if (e.deployable) {
        li.innerHTML = `
          <label class="remediate-item-row">
            <input type="checkbox" ${checked ? 'checked' : ''}>
            <span class="remediate-item-name">${escapeHtml(labelText)}</span>
            <span class="remediate-item-tag is-deploy">${escapeHtml(e.deployLabel || (e.kind === 'dashboard' ? 'dashboard' : 'rules'))}</span>
          </label>
        `;
        const cb = li.querySelector('input');
        cb.onchange = () => {
          if (cb.checked) deselected.delete(e.identity);
          else deselected.add(e.identity);
          appHost.renderMainView();
        };
      } else {
        const tag = e.direction === 'retrofeed' ? 'repo patch'
          : e.direction === 'drift' ? 'field decision'
          : 'manual fix';
        const driftText = e.direction === 'drift' && e.deltas?.length
          ? `<span class="remediate-item-delta">${escapeHtml(e.deltas.slice(0, 3).map(d => d.path || d.field || 'field').join(' · '))}</span>`
          : '';
        li.innerHTML = `
          <div class="remediate-item-row">
            <span class="remediate-item-name">${escapeHtml(labelText)}</span>
            ${driftText}
            <span class="remediate-item-tag is-author">${escapeHtml(tag)}</span>
          </div>
        `;
      }
      ul.appendChild(li);
    }
    layerEl.appendChild(ul);
    list.appendChild(layerEl);
  }
  wrap.appendChild(list);

  // ---- Deploy action ----
  const action = document.createElement('div');
  action.className = 'remediate-action';
  const n = selectedDeployment.rows;
  const deployPackId = state.selectedPackId;
  action.innerHTML = `
    <button type="button" class="remediate-deploy-btn" ${n === 0 ? 'disabled' : ''}>
      Deploy ${n} selected →
    </button>
    <span class="remediate-action-hint">${n === 0
      ? 'Select at least one deployable row, or handle the manual follow-up items.'
      : 'Opens the deploy form pre-selected to these rows. Manual items need pack, instrumentation, or platform config changes.'}</span>
  `;
  const btn = action.querySelector('.remediate-deploy-btn');
  if (btn && n > 0) {
    btn.onclick = () => appHost.openDeployModal({ packId: deployPackId, presetIdentities: selectedDeployment.identities });
  }
  wrap.appendChild(action);

  host.appendChild(wrap);
}

export function buildRetrofeedPatchText(resolved, bName) {
  const changes = [];
  for (const L of LAYERS_FOR_DIFF) {
    for (const e of resolved.byLayer[L] || []) {
      if (e.direction !== 'retrofeed') continue;
      changes.push({ layer: L, identity: e.identity || '', artefact: e.art });
    }
  }
  if (!changes.length) return '';
  const lines = [
    'apiVersion: observogram.dev/v1alpha1',
    'kind: ReconcilePatch',
    'metadata:',
    `  service: ${yamlScalar(state.pack?.meta?.service || state.pack?.meta?.name || 'unknown')}`,
    `  source: ${yamlScalar(bName || 'Pack B')}`,
    'spec:',
    '  direction: live_to_repo',
    '  changes:',
  ];
  for (const change of changes) {
    const label = artefactLabel(change.artefact, change.identity);
    lines.push(`    - layer: ${yamlScalar(change.layer)}`);
    lines.push('      action: add_to_pack');
    lines.push(`      identity: ${yamlScalar(change.identity)}`);
    lines.push(`      title: ${yamlScalar(label)}`);
    lines.push('      artifact_json: |');
    for (const line of JSON.stringify(cleanPatchArtefact(change.artefact), null, 2).split('\n')) {
      lines.push(`        ${line}`);
    }
  }
  return lines.join('\n');
}

function cleanPatchArtefact(artefact) {
  if (!artefact || typeof artefact !== 'object') return artefact;
  const rest = { ...artefact };
  delete rest.domId;
  delete rest._sub;
  return rest;
}

function yamlScalar(value) {
  const s = String(value ?? '');
  if (!s) return "''";
  if (/^[A-Za-z0-9_.:/@-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

export function renderCompileView(host) {
  // The reconciliation plan leads the view: repo→live deployment,
  // live→repo retrofeed, and drift field decisions. The per-artefact
  // compiler below remains the drill-down to inspect/emit one artefact.
  renderRemediationPlan(host);

  const section = document.createElement('section');
  section.className = 'section compile-view';
  section.dataset.layer = 'COMPILE';
  section.dataset.focus = effectiveFocus();

  const focusedPk = focusedPack();
  const head = document.createElement('div');
  head.className = 'section-head';
  const focusBadge = state.packB ? ` · pack ${effectiveFocus().toUpperCase()}` : '';
  head.innerHTML = `
    <span class="section-num">BLD</span>
    <span class="section-name">Compile — inspect &amp; emit one artefact${focusBadge}</span>
    <span class="section-count">${escapeHtml(focusedPk?.id || '')}</span>
  `;
  section.appendChild(head);

  const lede = document.createElement('div');
  lede.className = 'compile-lede';
  lede.innerHTML = `
    Drill into a single artifact and choose its target flavor. Each leaf compiles individually — one SLO's rules,
    one dashboard, or the full file. Every output declares its platform explicitly so you know whether you're
    holding a <em>Prometheus / Mimir</em> rules file or a <em>Grafana-managed</em> provisioning YAML.
  `;
  section.appendChild(lede);

  // ---- Grid: left nav (artifact tree) + right stage ----
  const grid = document.createElement('div');
  grid.className = 'compile-grid';
  section.appendChild(grid);
  host.appendChild(section);

  const nav = document.createElement('aside');
  nav.className = 'compile-nav';
  grid.appendChild(nav);
  const stage = document.createElement('div');
  stage.className = 'compile-stage';
  grid.appendChild(stage);

  // Fetch catalog if missing for the focused pack.
  if (!focusedCompileCatalog()) {
    nav.innerHTML = '<div class="compile-loading">Loading artifacts…</div>';
    stage.innerHTML = '<div class="placeholder">Loading the artifact catalog…</div>';
    loadCompileCatalog().then(() => { setFocusedCompileContent(null); appHost.renderMainView(); });
    return;
  }

  const catalog = focusedCompileCatalog();
  // Catalog-load error — show it, do NOT re-trigger the fetch. Without
  // this guard the renderCompileView → loadCompileCatalog → renderMainView
  // chain loops on persistent 4xx (e.g. uploaded packs the server has no
  // id for) and hangs the tab via fetch + localStorage thrash.
  if (catalog.error) {
    nav.innerHTML = '<div class="placeholder">No catalog available.</div>';
    stage.innerHTML = `<div class="error">Compile catalog failed: ${escapeHtml(catalog.error)}</div>`;
    return;
  }
  const groups = catalog.groups || [];
  if (!groups.length) {
    nav.innerHTML = '<div class="placeholder">This pack has nothing compilable yet — add SLOs, dashboards, or pipelines to the source.</div>';
    return;
  }

  // ---- Left nav: artifact tree ----
  for (const g of groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'compile-group' + (g.id === focusedCompileGroup() ? ' is-active-group' : '');
    groupEl.innerHTML = `
      <div class="compile-group-head">
        <span class="compile-group-label">${escapeHtml(g.label)}</span>
        <span class="compile-group-count">${(g.items || []).length}</span>
      </div>
    `;
    const list = document.createElement('ul');
    list.className = 'compile-item-list';
    for (const it of (g.items || [])) {
      const li = document.createElement('li');
      const selected = (g.id === focusedCompileGroup()) && (it.id === focusedCompileArtifact());
      li.className = 'compile-item' + (selected ? ' is-active' : '');
      li.innerHTML = `
        <button type="button" class="compile-item-btn" title="${escapeHtml(it.subtitle || '')}">
          <span class="compile-item-bullet" aria-hidden="true">${selected ? '●' : '○'}</span>
          <span class="compile-item-body">
            <span class="compile-item-label">${escapeHtml(it.label)}</span>
            ${it.subtitle ? `<span class="compile-item-sub">${escapeHtml(it.subtitle)}</span>` : ''}
          </span>
        </button>
      `;
      li.querySelector('button').onclick = () => {
        setFocusedCompileGroup(g.id);
        setFocusedCompileArtifact(it.id);
        // Reconcile flavor with the chosen group.
        if (!g.flavors?.some(f => f.id === focusedCompileFlavor())) {
          setFocusedCompileFlavor(g.flavors?.[0]?.id || null);
        }
        setFocusedCompileContent(null);
        appHost.renderMainView();
      };
      list.appendChild(li);
    }
    groupEl.appendChild(list);
    nav.appendChild(groupEl);
  }

  // ---- Right stage: flavor pills + platform badge + compiled output ----
  const activeGroup = groups.find(g => g.id === focusedCompileGroup()) || groups[0];
  const activeFlavor = activeGroup?.flavors?.find(f => f.id === focusedCompileFlavor()) || activeGroup?.flavors?.[0];
  const activeItem = (activeGroup?.items || []).find(it => it.id === focusedCompileArtifact());

  // Platform callout — the explicit answer to "where does this land?"
  const callout = document.createElement('div');
  callout.className = 'compile-callout';
  callout.innerHTML = `
    <div class="compile-callout-head">
      <span class="compile-callout-label">TARGET PLATFORM</span>
      <span class="compile-callout-platform">${escapeHtml(activeFlavor?.platform || '—')}</span>
    </div>
    <div class="compile-callout-body">${escapeHtml(activeFlavor?.description || '')}</div>
  `;
  stage.appendChild(callout);

  // Flavor pills (if multiple)
  if ((activeGroup?.flavors || []).length > 1) {
    const flavorBar = document.createElement('div');
    flavorBar.className = 'compile-flavor-bar';
    flavorBar.innerHTML = `<span class="compile-flavor-key">FLAVOR</span>`;
    for (const f of activeGroup.flavors) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'compile-flavor-pill' + (f.id === focusedCompileFlavor() ? ' is-active' : '');
      b.innerHTML = `${escapeHtml(f.label)}`;
      b.title = `${f.platform} · ${f.description}`;
      b.onclick = () => {
        if (focusedCompileFlavor() === f.id) return;
        setFocusedCompileFlavor(f.id);
        setFocusedCompileContent(null);
        appHost.renderMainView();
      };
      flavorBar.appendChild(b);
    }
    stage.appendChild(flavorBar);
  }

  // Active artifact heading
  if (activeItem) {
    const head2 = document.createElement('div');
    head2.className = 'compile-artifact-head';
    head2.innerHTML = `
      <span class="compile-artifact-label">${escapeHtml(activeItem.label)}</span>
      ${activeItem.subtitle ? `<span class="compile-artifact-sub">${escapeHtml(activeItem.subtitle)}</span>` : ''}
    `;
    stage.appendChild(head2);
  }

  // Content
  if (!focusedCompileContent()) {
    const ph = document.createElement('div');
    ph.className = 'placeholder';
    ph.textContent = 'Compiling…';
    stage.appendChild(ph);
    loadCompiled().then(() => appHost.renderMainView());
    return;
  }
  if (focusedCompileContent().error) {
    const err = document.createElement('div');
    err.className = 'error';
    err.textContent = `Compile failed: ${focusedCompileContent().error}`;
    stage.appendChild(err);
    return;
  }
  const c = focusedCompileContent();
  // Map current selection to the legacy target name the deploy path expects.
  state.compileTarget = legacyDeployTargetFor(focusedCompileGroup()) || state.compileTarget;

  const envLabel = focusedEnv() || 'none';
  const actions = document.createElement('div');
  actions.className = 'compile-actions';
  actions.innerHTML = `
    <div class="compile-meta">
      <code>${escapeHtml(c.filename)}</code>
      <span class="muted">${escapeHtml(c.contentType)}</span>
      <span class="muted">${c.text.length.toLocaleString()} bytes</span>
      ${c.source ? `<span class="muted">from <code>${escapeHtml(c.source)}</code></span>` : ''}
    </div>
    <div class="compile-buttons">
      <button class="ctrl-btn" id="copy-compiled" type="button">copy</button>
      <a class="ctrl-btn ctrl-link" id="download-compiled" download="${escapeHtml(c.filename)}">download</a>
      ${isDeployable(state.compileTarget) ? `
        <button class="ctrl-btn ctrl-deploy" id="deploy-compiled" type="button" title="Push this artefact to the live platform via MCP write tools">
          deploy → <em>${escapeHtml(envLabel)}</em>
        </button>` : `
        <span class="ctrl-btn ctrl-deploy-disabled" title="${escapeHtml(state.deployMatrix?.targets?.[state.compileTarget]?.reason || 'No deploy path configured for this target')}">
          deploy ✕
        </span>`}
    </div>
  `;
  stage.appendChild(actions);

  // Inline deploy panel — collapsed by default; expands when the
  // user clicks deploy. Reuses the MCP URL the refresh panel already
  // persisted in localStorage so the engineer doesn't have to retype.
  const deployPanel = document.createElement('div');
  deployPanel.className = 'deploy-panel';
  deployPanel.hidden = true;
  if (isDeployable(state.compileTarget)) {
    deployPanel.innerHTML = renderDeployPanelMarkup(state.compileTarget);
  }
  stage.appendChild(deployPanel);

  const codeWrap = document.createElement('div');
  codeWrap.className = 'compile-code-wrap';
  const code = document.createElement('pre');
  code.className = 'compile-code ' + (c.contentType === 'application/json' ? 'lang-json' : 'lang-yaml');
  code.textContent = c.text;
  codeWrap.appendChild(code);
  stage.appendChild(codeWrap);

  actions.querySelector('#copy-compiled').onclick = async () => {
    try { await navigator.clipboard.writeText(c.text); toast('Copied to clipboard'); }
    catch (e) { toast('Copy failed: ' + e.message, 'error'); }
  };
  const dl = actions.querySelector('#download-compiled');
  const blob = new Blob([c.text], { type: c.contentType });
  dl.href = URL.createObjectURL(blob);

  const deployBtn = actions.querySelector('#deploy-compiled');
  if (deployBtn) deployBtn.onclick = () => appHost.openDeployModal({ packId: focusedPackId() });

  // Live re-derive the default tool name as the user changes product /
  // version / scope. We DON'T overwrite a user-typed override — only when
  // the input still matches the previous default do we refresh it.
  function rewireDefaults() {
    const toolInput = deployPanel.querySelector('#deploy-mcp-tool');
    if (!toolInput) return;
    const newDefault = computeDeployTool(state.compileTarget);
    if (toolInput.value === toolInput.dataset.lastDefault || !toolInput.value) {
      toolInput.value = newDefault;
    }
    toolInput.dataset.lastDefault = newDefault;
  }
  const prodSel = deployPanel.querySelector('#deploy-product');
  if (prodSel) prodSel.addEventListener('change', () => { state.deployProduct = prodSel.value; rewireDefaults(); });
  const verSel = deployPanel.querySelector('#deploy-version');
  if (verSel) verSel.addEventListener('change', () => { state.deployVersion = verSel.value; rewireDefaults(); });
  const scopeSel = deployPanel.querySelector('#deploy-scope');
  if (scopeSel) scopeSel.addEventListener('change', () => { state.deployScope = scopeSel.value; rewireDefaults(); });

  const goBtn2 = deployPanel.querySelector('#deploy-go-btn');
  if (goBtn2) goBtn2.onclick = () => doDeploy(deployPanel);
  const cancelBtn = deployPanel.querySelector('#deploy-cancel-btn');
  if (cancelBtn) cancelBtn.onclick = () => { deployPanel.hidden = true; };
}

// Mirror the server's defaultDeployTool function. Kept in sync with
// server/index.mjs::defaultDeployTool.
function computeDeployTool(target) {
  const product = state.deployProduct;
  if (product === 'grafana') {
    if (target === 'prometheus-rules') {
      return 'grafana_create_alert_rule';
    }
    if (target === 'grafana-dashboard') return 'grafana_create_dashboard';
  }
  return `apply_${String(target || '').replace(/-/g, '_')}`;
}

function renderDeployPanelMarkup(target) {
  const matrix = state.deployMatrix || { products: ['grafana'], versions: { grafana: ['12', '13'] }, scopes: ['both', 'recording', 'alerting'] };
  const products = matrix.products.length ? matrix.products : ['grafana'];
  const versions = matrix.versions[state.deployProduct] || matrix.versions[products[0]] || ['12', '13'];
  const scopes = matrix.scopes || ['both', 'recording', 'alerting'];
  const scopable = targetScopable(target);

  const scopeLabels = {
    both:      'both — recording + alerting rules',
    recording: 'recording rules only',
    alerting:  'alerting rules only',
  };

  return `
    <div class="deploy-panel-head">
      <div class="deploy-panel-title">Deploy via MCP write tool</div>
      <div class="deploy-panel-sub">Target a specific product + version. The pack stays the source of truth — re-deploy any time by re-emitting from the pack.</div>
    </div>
    <div class="deploy-panel-body">
      <div class="deploy-trio">
        <label class="mcp-field deploy-field">
          <span class="mcp-field-key">Target product</span>
          <select id="deploy-product">
            ${products.map(p => `<option value="${escapeHtml(p)}" ${p === state.deployProduct ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
          </select>
        </label>
        <label class="mcp-field deploy-field">
          <span class="mcp-field-key">Target version</span>
          <select id="deploy-version">
            ${versions.map(v => `<option value="${escapeHtml(v)}" ${v === state.deployVersion ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
          </select>
        </label>
        ${scopable ? `
          <label class="mcp-field deploy-field">
            <span class="mcp-field-key">Rules scope</span>
            <select id="deploy-scope">
              ${scopes.map(s => `<option value="${escapeHtml(s)}" ${s === state.deployScope ? 'selected' : ''}>${escapeHtml(scopeLabels[s] || s)}</option>`).join('')}
            </select>
          </label>` : ''}
      </div>
      <label class="mcp-field">
        <span class="mcp-field-key">MCP URL</span>
        <input id="deploy-mcp-url" type="url" placeholder="https://your-mcp.example.com/observability" autocomplete="off">
      </label>
      <label class="mcp-field">
        <span class="mcp-field-key">Tool name <em>(default per product · version · scope)</em></span>
        <input id="deploy-mcp-tool" type="text" placeholder="grafana_create_alert_rule" autocomplete="off">
      </label>
      <label class="mcp-field">
        <span class="mcp-field-key">MCP client key <em>(optional, not persisted)</em></span>
        <input id="deploy-mcp-auth" type="password" placeholder="sk-..." autocomplete="off">
      </label>
      <div class="deploy-panel-actions">
        <button id="deploy-go-btn" class="mcp-refresh-btn" type="button">deploy</button>
        <button id="deploy-cancel-btn" class="ctrl-btn" type="button">cancel</button>
        <span id="deploy-status" class="mcp-refresh-status"></span>
      </div>
      <div id="deploy-result" class="deploy-result" hidden></div>
    </div>
  `;
}

async function doDeploy(panel) {
  const url  = panel.querySelector('#deploy-mcp-url').value.trim();
  const tool = panel.querySelector('#deploy-mcp-tool').value.trim() || computeDeployTool(state.compileTarget);
  const auth = panel.querySelector('#deploy-mcp-auth').value;
  const product = panel.querySelector('#deploy-product')?.value || state.deployProduct;
  const version = panel.querySelector('#deploy-version')?.value || state.deployVersion;
  const scope   = panel.querySelector('#deploy-scope')?.value   || (targetScopable(state.compileTarget) ? state.deployScope : undefined);
  const statusEl = panel.querySelector('#deploy-status');
  const resultEl = panel.querySelector('#deploy-result');
  const setStatus = (msg, kind) => {
    statusEl.textContent = msg;
    statusEl.className = 'mcp-refresh-status' + (kind ? ' is-' + kind : '');
  };
  if (!url) { setStatus('mcp url required', 'error'); return; }
  try { localStorage.setItem('mcpUrl', url); } catch (_) {}

  const goBtn = panel.querySelector('#deploy-go-btn');
  goBtn.disabled = true;
  setStatus(`deploying to ${product} ${version}${scope && scope !== 'both' ? ' · ' + scope : ''}…`);
  resultEl.hidden = true;

  const qs = new URLSearchParams();
  const deployEnv = focusedEnv();
  if (deployEnv) qs.set('env', deployEnv);
  if (state.compileDashId) qs.set('dashboardId', state.compileDashId);
  const target = state.compileTarget;
  const path = `/api/packs/${encodeURIComponent(focusedPackId())}/deploy/${encodeURIComponent(target)}?${qs}`;

  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mcpUrl: url,
        mcpAuth: auth || undefined,
        mcpTool: tool,
        targetProduct: product,
        targetVersion: version,
        scope,
      }),
    });
    const ct = r.headers.get('content-type') || '';
    const raw = await r.text();
    let body;
    if (!ct.includes('application/json')) {
      setStatus(`error: server returned ${r.status} ${ct || 'no content-type'}`, 'error');
      console.error('[deploy] non-JSON response:', raw.slice(0, 400));
      return;
    }
    try { body = JSON.parse(raw); }
    catch (e) { setStatus(`error: malformed JSON (${e.message})`, 'error'); return; }

    if (!body.ok) {
      setStatus(`error: ${body.error || 'unknown'}`, 'error');
      resultEl.textContent = JSON.stringify(body, null, 2);
      resultEl.hidden = false;
      return;
    }
    setStatus(`deployed in ${body.tookMs}ms via ${escapeHtml(body.tool)}`, 'ok');
    resultEl.textContent = JSON.stringify(body.result, null, 2);
    resultEl.hidden = false;
    toast(`Deployed ${body.filename} to ${body.env || 'mcp'}`);
  } catch (e) {
    setStatus(`error: ${e.message}`, 'error');
  } finally {
    goBtn.disabled = false;
  }
}
