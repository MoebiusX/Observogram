// studio/app.mjs
//
// Studio v0.3 client. Phase 3b adds:
//   - Per-artefact-type drawer panels (SLI/SLO/backend/dashboard/chaos/...).
//   - Version-gating chips on backend cards.
//   - Cross-reference checker (red border + drawer "broken refs" list).
//   - Conformance tab (maturity rubric scoring per dimension).
//   - File-upload + drag-and-drop UI for POST /api/validate.
// Phase 7b adds the Compare tab (pack arithmetic).
// Phase 7c adds the Atlas tab (6 SVG metaphors).

import { render as renderAtlas, VARIANTS as ATLAS_VARIANTS, ATLAS_META } from './atlases.mjs';
import {
  LAYER_DEFS, L4_SUBGROUPS, DOMAIN_DEFS,
  DISCO_SLAB_ACCENT, discoGradeLetter, discoGradeWord,
} from './constants.mjs';
import { state, $, $$, persistence } from './state.mjs';
import { api, loadCatalog, validateUploaded, authHeaders, setActiveOrg, getActiveOrg, savedOrg } from './api.mjs';
import {
  effectiveFocus, focusedPackId, focusedEnv, focusedPack,
  focusedConformance, setFocusedConformance,
  focusedCompileCatalog, setFocusedCompileCatalog,
  focusedCompileContent, setFocusedCompileContent,
  focusedCompileGroup, setFocusedCompileGroup,
  focusedCompileFlavor, setFocusedCompileFlavor,
  focusedCompileArtifact, setFocusedCompileArtifact,
} from './focus.mjs';
import { escapeHtml, toast, fmtRelative, installDialogFocusTrap } from './util.mjs';
import { renderSchemaView } from './schema-view.mjs';
import { renderConformanceView } from './conformance-view.mjs';
import { renderOtlpView } from './otlp-view.mjs';
import { renderReferencesView } from './references-view.mjs';
import { renderCompileView, loadDeployMatrix } from './compile-view.mjs';
import { openDrawer, closeDrawer } from './drawer.mjs';
import { renderDiscoverDashboard, renderLayersView, renderCard, cardKey } from './layers-view.mjs';
import { renderAtlasView } from './atlas-view.mjs';
import { renderJourneysView } from './journeys-view.mjs';
import { renderBenchmarkView, renderComparePicker, renderTraceabilityView, refreshDiff, loadDiff, LENS_PRODUCTS, activeDiffScopeMode } from './compare-view.mjs';
import { catalogToDeployManifest } from './artifact-model.mjs';
import { computeDeployTransitions } from './verify-deploy.mjs';
import { protoActive, renderProtoDiagnose, renderProtoRemediate } from './proto-view.mjs';
import { initHost } from './host.mjs';

// `state`, the `$`/`$$` DOM helpers and the persistence layer now live in
// studio/state.mjs (imported above).

// `api` / `loadCatalog` / `validateUploaded` now live in studio/api.mjs and
// the pack-focus (A | B) getters/setters in studio/focus.mjs (imported
// above). setViewFocus stays here — it re-renders, which is orchestration.

function setViewFocus(focus) {
  if (state.viewFocus === focus) return;
  state.viewFocus = focus;
  // Cached content for the newly-focused side may be stale or missing —
  // dropping it forces a lazy-load on the next render.
  if (effectiveFocus() === 'b' && !state.compileCatalogB) state.compileContentB = null;
  renderTabs();
  renderMainView();
}

// Rehydrate state from the persistence key. Called once after the
// catalog + examples are loaded so we can validate pack IDs before
// trying to load them. Returns true if it took the studio out of home
// mode; the caller falls back to goHome() otherwise.
async function rehydrateFromPersistence() {
  const saved = persistence.read();
  if (!saved) return false;
  const allKnown = [...(state.catalog || []), ...(state._examplesCache || [])];
  const aMeta = allKnown.find(p => p.id === saved.selectedPackId);
  if (!aMeta) {
    // Pack A is gone — drop the whole snapshot. Half-restoring a session
    // (view/filter but no pack) would just confuse.
    persistence.clear();
    return false;
  }

  // Restore non-pack UI fields up-front so the first render shows them.
  if (typeof saved.selectedService === 'string') state.selectedService = saved.selectedService;
  if (typeof saved.view === 'string')          state.view = saved.view;
  // Migrate persisted state from prior nav layouts to the three-tab
  // model (Layers · Compare · Compile). Anything outside those three
  // routes to either Compare (if it implied a comparison view) or
  // Layers (everything else) so we never strand the user on a tab
  // that no longer has a nav entry.
  // Permitted views: the three workflow tabs + the Advanced deep tools.
  // Anything else (legacy 'benchmark', the removed 'compare-artefacts')
  // routes to the compliance report so we never strand the user.
  const PERMITTED_VIEWS = new Set(['layers', 'compare', 'compile', 'conformance', 'schema', 'otlp', 'traceability', 'atlas', 'references', 'journeys']);
  if (state.view && !PERMITTED_VIEWS.has(state.view)) {
    state.view = 'compare';
  }
  if (typeof saved.layerFilter === 'string')   state.layerFilter = saved.layerFilter;
  if (typeof saved.compareSlice === 'string')  state.compareSlice = saved.compareSlice;
  if (typeof saved.compareSearch === 'string') state.compareSearch = saved.compareSearch;
  if (typeof saved.compareLens === 'string')   state.compareLens = saved.compareLens;
  if (typeof saved.diffScopeMode === 'string') state.diffScopeMode = saved.diffScopeMode;
  if (saved.viewFocus === 'a' || saved.viewFocus === 'b') state.viewFocus = saved.viewFocus;
  if (typeof saved.atlasVariant === 'string')  state.atlasVariant = saved.atlasVariant;
  if (typeof saved.arborView === 'string')     state.arborView = saved.arborView;
  if (typeof saved.compileGroup === 'string')  state.compileGroup = saved.compileGroup;
  if (typeof saved.compileFlavor === 'string') state.compileFlavor = saved.compileFlavor;
  if (typeof saved.compileArtifact === 'string') state.compileArtifact = saved.compileArtifact;
  if (typeof saved.compileGroupB === 'string')  state.compileGroupB = saved.compileGroupB;
  if (typeof saved.compileFlavorB === 'string') state.compileFlavorB = saved.compileFlavorB;
  if (typeof saved.compileArtifactB === 'string') state.compileArtifactB = saved.compileArtifactB;
  if (saved.tracePrefs && typeof saved.tracePrefs === 'object') {
    state.tracePrefs = {
      suppressed: Array.isArray(saved.tracePrefs.suppressed) ? saved.tracePrefs.suppressed : [],
      resolved:   Array.isArray(saved.tracePrefs.resolved)   ? saved.tracePrefs.resolved   : [],
    };
  }
  // Per-section Expand toggles (L2 metric inventory; L3 panels + queries).
  if (typeof saved.expandL2 === 'boolean') state.expandL2 = saved.expandL2;
  if (typeof saved.expandL3Panels === 'boolean') state.expandL3Panels = saved.expandL3Panels;
  if (typeof saved.expandL3Queries === 'boolean') state.expandL3Queries = saved.expandL3Queries;
  if (typeof saved.layersSearch === 'string') state.layersSearch = saved.layersSearch;
  if (typeof saved.layersDomain === 'string') state.layersDomain = saved.layersDomain;

  // Make sure the picker can label an archived example by pushing the
  // catalog-entry shape into state.catalog (same trick renderPackBSelect uses).
  if (!state.catalog.find(p => p.id === aMeta.id)) state.catalog.push(aMeta);
  enterAnalyzeMode(aMeta.id, saved.selectedEnv);

  // Pack B (optional) — only if both the ID still resolves AND we had
  // env-B persisted. We don't pre-fetch B's pack object; loadPackB does that.
  const bMeta = saved.compareBId ? allKnown.find(p => p.id === saved.compareBId) : null;
  if (bMeta) {
    if (!state.catalog.find(p => p.id === bMeta.id)) state.catalog.push(bMeta);
    state.compareBId  = bMeta.id;
    state.compareBEnv = saved.compareBEnv || defaultEnvFor(bMeta.id);
    loadPackB().then(() => {
      refreshDiff();
      applyModeChrome();
      renderPackBSelect();
      renderEnvBSelect();
      renderTabs();
      renderMainView();
    }).catch((e) => {
      // Pack B restore is best-effort: keep the session usable on Pack A.
      state.compareBId = null;
      state.packB = null;
      toast(`Couldn't restore Pack B: ${e.message}`, 'error');
      renderTabs();
      renderMainView();
    });
  }
  return true;
}

async function loadPack(id, env) {
  const q = env ? `?env=${encodeURIComponent(env)}` : '';
  const [pack, conformance] = await Promise.all([
    api(`/api/packs/${encodeURIComponent(id)}${q}`),
    api(`/api/packs/${encodeURIComponent(id)}/conformance${q}`),
  ]);
  state.pack = pack;
  state.conformance = conformance;
  state.uploadedSource = null;
  state.symbolTable = buildSymbolTable(pack);
}

// ---------- selectors ----------

function uploadedSourceHint(p) {
  if (p?.source !== 'uploaded') return '';
  const m = String(p.description || '').match(/^Uploaded pack\s+—\s+(.+)$/);
  const source = (m?.[1] || '').trim();
  if (!source || source === p.label || source === p.name) return '';
  return source;
}

function packSelectLabel(p, { prefixUploaded = false } = {}) {
  const prefix = prefixUploaded && p.source === 'uploaded' ? '📂 ' : '';
  const version = p.version || '?';
  const source = uploadedSourceHint(p);
  return `${prefix}${p.label} · v${version}${source ? ` · from ${source}` : ''}`;
}

function normalizeServiceKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function serviceNamesForPack(p) {
  const names = new Set();
  const add = (value) => {
    const v = String(value || '').trim();
    if (v) names.add(v);
  };
  add(p?.service);
  add(p?.namespace);
  add(p?.name);
  if (Array.isArray(p?.services)) p.services.forEach(add);
  return [...names];
}

function primaryServiceName(p) {
  return String(p?.service || p?.namespace || p?.name || p?.label || '').trim();
}

function serviceKeyForPack(p) {
  return normalizeServiceKey(primaryServiceName(p));
}

function isLiveAggregatePack(p) {
  const text = [
    p?.id, p?.label, p?.name, p?.description, p?.source,
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(live|mcp|production-live|draft-from-mcp)\b/.test(text);
}

function serviceCatalogue() {
  const byKey = new Map();
  const add = (name, p) => {
    const key = normalizeServiceKey(name);
    if (!key) return;
    if (!byKey.has(key)) byKey.set(key, {
      key,
      label: String(name).trim(),
      packCount: 0,
      liveCount: 0,
    });
    const item = byKey.get(key);
    if (p) {
      if (isLiveAggregatePack(p)) item.liveCount += 1;
      else item.packCount += 1;
    }
  };
  for (const p of [...(state.catalog || []), ...(state._examplesCache || [])]) {
    if (!p?.ok) continue;
    const aggregate = isLiveAggregatePack(p);
    const primaryKey = serviceKeyForPack(p);
    if (!aggregate) add(primaryServiceName(p), p);
    for (const svc of p.services || []) {
      if (aggregate && normalizeServiceKey(svc) === primaryKey) continue;
      add(svc, p);
    }
  }
  const current = state.pack?.meta?.service;
  if (current) add(current);
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function packMatchesService(p, serviceKey, { side = 'a' } = {}) {
  if (!serviceKey) return true;
  if (!p?.ok) return false;
  const keys = new Set(serviceNamesForPack(p).map(normalizeServiceKey).filter(Boolean));
  if (keys.has(serviceKey)) return true;
  // Pack B is often an aggregate live snapshot from a multitenant platform.
  // Keep it available; the diff's selected service scope keeps unrelated
  // live inventory out of the grade.
  return side === 'b' && isLiveAggregatePack(p);
}

function ensureServiceFromPack() {
  if (state.selectedService) return;
  const entry = state.catalog.find(p => p.id === state.selectedPackId);
  const key = serviceKeyForPack(entry) || normalizeServiceKey(state.pack?.meta?.service);
  if (key) state.selectedService = key;
}

function clearPackBState() {
  state.compareBId = null;
  state.compareBEnv = null;
  state.packB = null;
  state.diff = null;
  state.conformanceB = null;
  state.compileCatalogB = null;
  state.compileContentB = null;
  state.viewFocus = 'a';
}

function renderServiceSelect() {
  const sel = $('#service-select');
  if (!sel) return;
  const services = serviceCatalogue();
  sel.innerHTML = '';
  if (!services.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— service —';
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  if (!state.selectedService || !services.some(s => s.key === state.selectedService)) {
    ensureServiceFromPack();
    if (!state.selectedService || !services.some(s => s.key === state.selectedService)) {
      state.selectedService = services[0].key;
    }
  }
  for (const service of services) {
    const opt = document.createElement('option');
    opt.value = service.key;
    opt.textContent = service.label;
    sel.appendChild(opt);
  }
  sel.value = state.selectedService || '';
  updateObservaServiceChip();
  sel.onchange = () => {
    state.selectedService = sel.value || null;
    const currentA = state.catalog.find(p => p.id === state.selectedPackId);
    if (state.selectedPackId && !packMatchesService(currentA, state.selectedService, { side: 'a' })) {
      const nextA = state.catalog.find(p => p.ok && packMatchesService(p, state.selectedService, { side: 'a' }));
      state.selectedPackId = nextA?.id || null;
      state.selectedEnv = state.selectedPackId ? defaultEnvFor(state.selectedPackId) : null;
      state.pack = null;
      state.conformance = null;
      state.symbolTable = null;
    }
    const currentB = [...(state.catalog || []), ...(state._examplesCache || [])].find(p => p.id === state.compareBId);
    if (state.compareBId && !packMatchesService(currentB, state.selectedService, { side: 'b' })) clearPackBState();
    state.diff = null;
    renderPackSelect();
    renderPackBSelect();
    renderEnvSelect();
    renderEnvBSelect();
    renderTabs();
    if (state.selectedPackId && state.mode !== 'home') refresh();
    else renderMainView();
  };
}

function renderPackSelect() {
  const sel = $('#pack-select');
  sel.innerHTML = '';
  ensureServiceFromPack();
  const options = state.catalog.filter(p => packMatchesService(p, state.selectedService, { side: 'a' }));
  for (const p of options) {
    const opt = document.createElement('option');
    opt.value = p.id;
    // Uploaded packs lead with a folder glyph so the user can tell
    // them apart from file-backed catalog entries at a glance. Tier
    // is omitted from the option text — it already renders as a
    // separate badge on the picker chrome.
    opt.textContent = p.ok
      ? packSelectLabel(p, { prefixUploaded: true })
      : `${p.label} (error)`;
    if (!p.ok) opt.disabled = true;
    sel.appendChild(opt);
  }
  sel.value = state.selectedPackId || (options.find(p => p.ok)?.id ?? '');
  sel.onchange = () => {
    state.selectedPackId = sel.value;
    state.selectedEnv = defaultEnvFor(state.selectedPackId);
    const entry = state.catalog.find(p => p.id === state.selectedPackId);
    const key = serviceKeyForPack(entry);
    if (key) state.selectedService = key;
    renderServiceSelect();
    refresh();
  };
}

// Pack B picker — sits next to Pack A in the header. Empty by default
// (shows "— none —"). Picking a pack here loads Pack B in place; the
// view nav grows to include Compare + Atlas without leaving single mode.
// Sources of pack options: state.catalog (live + crawled + uploaded)
// PLUS the archived /api/examples list (fetched once, cached).
function renderPackBSelect() {
  const sel = $('#pack-b-select');
  if (!sel) return;
  // Merge catalog + cached examples, dedup by id, drop the active Pack A.
  // Catalogue reference packs are intentionally NOT offered here: comparing
  // a single product's reference pack against a whole service's posture is
  // an apples-to-oranges comparison. They live under Advanced → References.
  const cat = state.catalog || [];
  const ex  = state._examplesCache || [];
  const seen = new Set();
  const options = [];      // packs in the active service (or live aggregates)
  const crossService = []; // everything else — still comparable, grouped apart
  for (const p of [...cat, ...ex]) {
    if (!p?.id || !p.ok) continue;
    if (p.id === state.selectedPackId) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    // Same-service packs (and live aggregates) lead the list; packs from
    // OTHER services remain selectable under their own group — comparing
    // across services is a sanctioned flow (legacy imports each derive
    // their own service from the old pack id; live aggregates span many),
    // and the diff's service scope keeps unrelated inventory honest.
    // The ACTIVE Pack B is always representable wherever it falls — a
    // select must show its own value.
    if (p.id === state.compareBId || packMatchesService(p, state.selectedService, { side: 'b' })) {
      options.push(p);
    } else {
      crossService.push(p);
    }
  }
  // Sort by label so the list is stable across re-renders.
  const byLabel = (a, b) => (a.label || a.id).localeCompare(b.label || b.id);
  options.sort(byLabel);
  crossService.sort(byLabel);
  const opt = (p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(packSelectLabel(p))}</option>`;
  sel.innerHTML = '<option value="">— none —</option>'
    + options.map(opt).join('')
    + (crossService.length
        ? `<optgroup label="other services">${crossService.map(opt).join('')}</optgroup>`
        : '');
  sel.value = state.compareBId || '';
  sel.onchange = () => {
    const newId = sel.value || null;
    if (newId === state.compareBId) return;
    state.compareBId = newId;
    state.compareBEnv = newId ? defaultEnvFor(newId) : null;
    state.packB = null; state.diff = null;
    // Reset B-side state slots (they belong to whatever pack was just removed).
    state.conformanceB = null;
    state.compileCatalogB = null;
    state.compileContentB = null;
    if (!newId) {
      // User cleared Pack B — back to single-pack focus.
      state.viewFocus = 'a';
      // Atlas works in single-pack mode (Strata / Periodic / Skyline /
      // Arbor), so it stays. Compare + Traceability are cross-pack only —
      // fall back to Layers.
      if (state.view === 'compare' || state.view === 'traceability') {
        state.view = 'layers';
      }
      if (state.view === 'atlas' && CROSS_PACK_VARIANTS.has(state.atlasVariant)) {
        state.atlasVariant = 'strata';
      }
      applyModeChrome();
      renderTabs();
      renderMainView();
      return;
    }
    // Push the chosen pack into state.catalog (if not already present)
    // so loadPackB() + the catalog-entry resolver have a label to read.
    if (!state.catalog.find(p => p.id === newId)) {
      const ex = (state._examplesCache || []).find(p => p.id === newId)
              || (state._referencesCache || []).find(p => p.id === newId);
      if (ex) state.catalog.push(ex);
    }
    // Lazy-load B then refresh tabs + view. Auto-switch to Compare —
    // picking Pack B IS the user's intent to compare; making them then
    // click Compare separately was the source of "I changed Pack B and
    // lost the comparison" confusion. Preserve any cross-pack view
    // they had already chosen (Atlas, Traceability) so we don't fight
    // the user when they switched away deliberately.
    const crossPackViews = new Set(['compare', 'atlas', 'traceability']);
    const wantedAutoSwitch = !crossPackViews.has(state.view);
    loadPackB().then(() => {
      refreshDiff();
      if (wantedAutoSwitch) state.view = 'compare';
      // applyModeChrome reads state.view — must run AFTER the
      // potential switch so the header pickers hide/show correctly.
      applyModeChrome();
      renderEnvBSelect();
      renderTabs();
      renderMainView();
    });
  };
  renderEnvBSelect();
}

function renderEnvBSelect() {
  const sel = $('#env-b-select');
  if (!sel) return;
  sel.innerHTML = '';
  const entry = state.catalog.find(p => p.id === state.compareBId);
  const envs = entry?.environments || [];
  if (!envs.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '— none —';
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const e of envs) {
    const opt = document.createElement('option');
    opt.value = e; opt.textContent = e;
    sel.appendChild(opt);
  }
  sel.value = state.compareBEnv || envs[0];
  sel.onchange = () => {
    state.compareBEnv = sel.value || null;
    state.packB = null; state.diff = null;
    loadPackB().then(() => { refreshDiff(); renderTabs(); renderMainView(); });
  };
}

function renderEnvSelect() {
  const sel = $('#env-select');
  sel.innerHTML = '';
  const envs = state.pack?.meta?.environments?.length
    ? state.pack.meta.environments
    : (state.catalog.find(p => p.id === state.selectedPackId)?.environments || []);
  if (!envs.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '— none —';
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const e of envs) {
    const opt = document.createElement('option');
    opt.value = e; opt.textContent = e;
    sel.appendChild(opt);
  }
  sel.value = state.selectedEnv ?? envs[0];
  sel.onchange = () => { state.selectedEnv = sel.value || null; refresh(); };
}

export function defaultEnvFor(packId) {
  const entry = state.catalog.find(p => p.id === packId);
  return entry?.environments?.[0] || null;
}

// ---------- meta strip ----------

function renderMeta() {
  const m = state.pack?.meta || {};
  const setVal = (key, value) => {
    const el = document.querySelector(`[data-meta="${key}"]`);
    if (!el) return;
    el.textContent = value ?? '—';
  };
  setVal('apiVersion', m.apiVersion);
  setVal('kind', m.kind);
  setVal('binding', m.binding);
  setVal('version', m.version);
  setVal('criticality', m.criticality);
  setVal('target', m.target);
  setVal('owners', Array.isArray(m.owners) ? m.owners.join(', ') : '—');
  setVal('environments', Array.isArray(m.environments) ? m.environments.join(', ') : '—');
  const critEl = document.querySelector('[data-meta="criticality"]');
  if (critEl) critEl.dataset.tier = m.criticality || '';
}

// ---------- symbol table + cross-references ----------

export function buildSymbolTable(pack) {
  const defined = new Set();
  const refsFrom = new Map();  // cardKey -> string[] of refs

  const walk = (artefact, layerId, sublayerKey) => {
    if (artefact.defines) defined.add(artefact.defines);
    if (Array.isArray(artefact.refs) && artefact.refs.length) {
      const key = cardKey(layerId, sublayerKey, artefact.id);
      refsFrom.set(key, artefact.refs);
    }
  };

  const layers = pack?.layers || {};
  for (const layerId of ['L1', 'L2', 'L2X', 'L3', 'L5', 'GOV']) {
    for (const a of layers[layerId] || []) walk(a, layerId);
  }
  for (const sg of L4_SUBGROUPS) {
    for (const a of layers.L4?.[sg.key] || []) walk(a, 'L4', sg.key);
  }

  // Classify each ref
  const broken = new Map();  // cardKey -> string[] of unresolved refs
  for (const [key, refs] of refsFrom) {
    const unresolved = [];
    for (const ref of refs) {
      if (!ref) continue;
      // External imports (ref:platform/..., ref:something/...) — treat as resolved.
      if (/^ref:[A-Za-z0-9_./-]+/.test(ref) && !defined.has(ref)) {
        // accept any ref:platform/... as external import
        if (/^ref:[A-Za-z0-9_-]+\//.test(ref)) continue;
      }
      // Alert references — there's no first-class alert symbol yet, accept all alert:*
      if (/^alert:[a-z]/.test(ref)) continue;
      // Internal symbol — must resolve
      if (defined.has(ref)) continue;
      // Bare `slos.<id>` / `slis.<id>` style
      if (/^(slis|slos)\.[a-z]/.test(ref) && defined.has(ref)) continue;
      unresolved.push(ref);
    }
    if (unresolved.length) broken.set(key, unresolved);
  }

  return { defined, refsFrom, broken };
}

// ---------- layer tabs ----------

export function layerArtefactCount(layerId) {
  const layers = state.pack?.layers;
  if (!layers) return 0;
  if (layerId === 'L4') {
    return (layers.L4?.policy?.length || 0) + (layers.L4?.alerting?.length || 0) + (layers.L4?.healing?.length || 0);
  }
  return (layers[layerId] || []).length;
}

// ============================================================
// Two-level navigation
//
// LEVEL 1 (primary view selector, top nav strip):
//   Layers · Conformance · Compile · Atlas · Schema     (single mode)
//   Layers · Atlas · Schema                              (compare mode)
//
// LEVEL 2 (layer filter chip strip, only visible on Layers view):
//   All · L1 · L2 · L2X · L3 · L4 · L5 · GOV
//
// The previous design crammed everything in one row — layer tabs
// L1..GOV mixed with the primary views CONF / BLD / CMP / ATL — which
// meant filters fought primary navigation for screen space and the
// user couldn't tell which was which. User feedback was unambiguous:
// "filters are displayed mixed with the main Studio functions, that
// you can't even see."
// ============================================================

export function renderTabs() {
  // Keep the OBSERVA chrome's active tab in sync on every re-render.
  paintObservaActiveTab();
  const tabs = $('#layer-tabs');
  if (!tabs) return;
  tabs.innerHTML = '';
  // The three H2 journey tabs in the OBSERVA chrome (Discover · Diagnose ·
  // Remediate) are the SOLE primary nav. The old in-content view-nav row
  // (Layers · Compare · Compile) duplicated them and was the "mixing" that
  // broke the journey — it's gone. We keep only the A|B focus toggle (for
  // the single-pack Advanced views) and the layer filter chips.
  tabs.appendChild(renderFocusToggle());
  tabs.appendChild(renderLayerFilterChips());
}

// Focus toggle (A | B). Visible only when both packs are loaded AND the
// active view renders a single pack — conformance, compile, schema, otlp.
// The other views (layers/compare/atlas) already show both packs.
function renderFocusToggle() {
  const wrap = document.createElement('div');
  wrap.className = 'focus-toggle';
  const showToggle = !!state.packB && ['conformance', 'compile', 'schema', 'otlp'].includes(state.view);
  if (!showToggle) { wrap.hidden = true; return wrap; }
  const cur = effectiveFocus();

  const label = document.createElement('span');
  label.className = 'focus-toggle-key';
  label.textContent = 'FOCUS';
  wrap.appendChild(label);

  const mkBtn = (side, pack) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.side = side;
    b.className = 'focus-toggle-btn' + (cur === side ? ' is-active' : '');
    b.textContent = side.toUpperCase();
    b.title = `Focus PACK ${side.toUpperCase()} — ${pack?.id || ''}`;
    b.onclick = () => setViewFocus(side);
    return b;
  };
  wrap.appendChild(mkBtn('a', state.pack));
  wrap.appendChild(mkBtn('b', state.packB));
  return wrap;
}

export function renderLayerFilterChips() {
  const wrap = document.createElement('div');
  wrap.className = 'layer-chips';
  // Only show layer filter chips on the Layers view.
  if (state.view !== 'layers' && state.view !== undefined && state.view !== null) {
    wrap.hidden = true;
    return wrap;
  }
  // 'All' first, then each layer in order.
  const filterOptions = [{ id: 'all', label: 'All', count: null }];
  for (const def of LAYER_DEFS) {
    const count = state.pack ? layerArtefactCount(def.id) : 0;
    if (def.id === 'L2X' && count === 0 && state.mode === 'single') continue;
    filterOptions.push({ id: def.id, label: def.id, name: def.name, count });
  }
  const active = state.layerFilter || 'all';
  for (const opt of filterOptions) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'layer-chip' + (opt.id === active ? ' is-active' : '');
    c.dataset.layer = opt.id;
    if (opt.name) c.title = `${opt.id} · ${opt.name}${opt.count != null ? ' · ' + opt.count + ' artefact' + (opt.count === 1 ? '' : 's') : ''}`;
    c.innerHTML = `
      ${opt.id === 'all' ? '' : `<span class="lc-num">${opt.id}</span>`}
      <span class="lc-label">${escapeHtml(opt.id === 'all' ? 'All' : (opt.name || opt.id))}</span>
      ${opt.count != null ? `<span class="lc-count">${opt.count}</span>` : ''}
    `;
    c.onclick = () => {
      state.layerFilter = opt.id;
      // Mirror to activeLayer for renderLayerView et al.
      state.activeLayer = opt.id === 'all' ? 'L1' : opt.id;
      state.activeCardKey = null;
      renderTabs();
      renderMainView();
    };
    wrap.appendChild(c);
  }
  return wrap;
}

// ---------- main view ----------

export function renderMainView() {
  const view = $('#layer-view');
  view.innerHTML = '';
  // Persistence: every mutation chain ends here, so this is the single
  // hook for the debounced write. Cheap when suspended (boot phase).
  persistence.schedule();
  if (state.mode === 'home') {
    if (state.homeVariant === 'gate') renderServiceGate();
    else renderHomeView();
    return;
  }
  if (!state.pack) {
    // In the workspace but no pack yet. Discover ("what do we have?") is
    // where you LOAD or GENERATE a pack — so its empty state IS the three
    // load options, never the marketing hero. Diagnose/Remediate need a
    // pack first, so they point the user back to Discover.
    if (state.view === 'layers') { renderDiscoverEmpty(view); return; }
    // References (Advanced) is a catalogue browser — it renders without a
    // pack loaded; the per-reference benchmark action then needs Pack A.
    if (state.view === 'references') { renderReferencesView(view); return; }
    renderNeedPackPrompt(view); return;
  }

  // Mode-free dispatch. 'compare' IS the Diagnose view — the
  // diagnostic-grade compliance report ("Can We Trust It?"). The old
  // artefact-id side-by-side diff is GONE; any stale 'compare-artefacts'
  // or 'benchmark' state routes to the compliance report.
  switch (state.view) {
    case 'benchmark':                                         // legacy alias
    case 'compare-artefacts':                                 // removed view → report
    case 'compare':
      // The redesign synthesis runs ONLY behind ?proto (maintainer call,
      // 2026-06-11) — without the query param production is untouched.
      if (protoActive()) { renderProtoDiagnose(view); return; }
      renderBenchmarkView(view); return;
    case 'traceability':       renderTraceabilityView(view); return;
    case 'atlas':              renderAtlasView(view); return;
    case 'conformance':        view.appendChild(renderConformanceView()); return;
    case 'compile':
      if (protoActive()) { renderProtoRemediate(view); return; }
      renderCompileView(view); return;
    case 'schema':             renderSchemaView(view); return;
    case 'otlp':               renderOtlpView(view); return;
    case 'references':         renderReferencesView(view); return;
    case 'journeys':           renderJourneysView(view); return;
    case 'layers':
    default:
      // Discover ("What Do We Have?") IS the real layer inventory —
      // the actual artefact cards grouped by canonical layer. The
      // CT-scanner is the LANDING-PAGE hero, not the in-app view.
      renderLayersView(view);
      return;
  }
}

// ============================================================
// DISCOVER — the OBSERVOGRAM SCAN dashboard.
//
// Three-column mission-control layout:
//   LEFT   — pack overview (manifest identity) + pack catalog
//   CENTER — the scanner centerpiece (hero image, with CSS fallback),
//            scan status, slice readout, layer index, top issues,
//            scan provenance
//   RIGHT  — conformance score, maturity by dimension, reference
//            check, artefact sourcing legend
//
// Every panel is wired to real pack data — meta, conformance,
// symbol table, catalog. No fabricated trends or activity logs.
// (Display vocabulary — DISCO_SLAB_ACCENT, discoGradeLetter/Word — now
// lives in constants.mjs.)
// ============================================================

// Discover + Layers + the artefact cards now live in studio/layers-view.mjs.

export async function runBenchmark(product, refPackId) {
  if (!product || !refPackId) return;
  state.compareLens = product;
  try {
    // Drive state directly. The old path dispatched a change event at the
    // Pack B picker, but reference packs are intentionally NOT picker
    // options anymore (see renderPackBSelect) — assigning a non-existent
    // option silently reset the select to '' and the CTA cleared Pack B
    // instead of loading the reference.
    if (!state.catalog.find(p => p.id === refPackId)) {
      const ref = (state._referencesCache || []).find(p => p.id === refPackId)
               || (state._examplesCache  || []).find(p => p.id === refPackId);
      if (ref) state.catalog.push(ref);
    }
    state.compareBId  = refPackId;
    state.compareBEnv = defaultEnvFor(refPackId);
    state.packB = null; state.diff = null;
    state.conformanceB = null;
    state.compileCatalogB = null;
    state.compileContentB = null;
    await loadPackB();
    refreshDiff();
    state.view = 'compare';
    applyModeChrome();
    renderPackBSelect();
    renderEnvBSelect();
    renderTabs();
    renderMainView();
  } catch (e) {
    console.warn('[benchmark] failed:', e);
    toast(`Benchmark failed: ${e.message}`, 'error');
  }
}

// ---------- references view (Advanced) ----------
// Reference component analysis. The catalogue reference packs (Kafka,
// Prometheus, Grafana) live here, off the main workflow, under Advanced →
// References. Each card describes a best-practice pack and offers a
// one-click benchmark that loads it as Pack B and jumps to Diagnose →
// Compare. Renders even without Pack A so the catalogue is browsable; the
// benchmark action is gated on a loaded pack.
// renderReferencesView now lives in studio/references-view.mjs (imported above).

// ---------- conformance view ----------

// renderConformanceView now lives in studio/conformance-view.mjs (imported above).

// The COMPILE / Remediate / Deploy views now live in studio/compile-view.mjs.

// The Compare / Diagnose views now live in studio/compare-view.mjs.

// ---------- atlas view ----------

export async function loadPackB() {
  if (!state.compareBId) {
    state.packB = null;
    state.conformanceB = null;
    state.compileCatalogB = null;
    state.compileContentB = null;
    return;
  }
  const q = state.compareBEnv ? `?env=${encodeURIComponent(state.compareBEnv)}` : '';
  // Fetch pack + conformance in parallel so flipping focus to B is
  // instant (no extra network round-trip).
  const [pack, conformance] = await Promise.all([
    api(`/api/packs/${encodeURIComponent(state.compareBId)}${q}`),
    api(`/api/packs/${encodeURIComponent(state.compareBId)}/conformance${q}`).catch(() => null),
  ]);
  state.packB = pack;
  state.conformanceB = conformance;
  // Reset cached compile state for B so first-visit re-fetches.
  state.compileCatalogB = null;
  state.compileContentB = null;
}

// Variants that need both packs (animate / interchange between them).
// Everything else works on a single pack — Arbor especially is a
// dependency-discovery tool you don't need to compare to use.
export const CROSS_PACK_VARIANTS = new Set(['constellation', 'transit']);

// The Atlas view now lives in studio/atlas-view.mjs.

// The artefact detail drawer now lives in studio/drawer.mjs.

// ---------- toast ----------

// ---------- upload ----------

async function handleFile(file) {
  if (!file) return;
  const text = await file.text();
  const isYaml = /\.ya?ml$/i.test(file.name) || file.type === 'text/yaml' || file.type === 'application/x-yaml';
  const ct = isYaml ? 'application/x-yaml' : 'application/json';
  try {
    const res = await validateUploaded(text, ct, state.selectedEnv);
    if (!res.ok) {
      const view = $('#layer-view');
      view.innerHTML = `
        <div class="error">
          <strong>${file.name} failed validation:</strong>
          <ul>${res.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
        </div>
      `;
      toast(`${file.name}: ${res.errors.length} validation error(s)`, 'error');
      return;
    }
    state.pack = res.adapted;
    state.conformance = res.conformance;
    state.symbolTable = buildSymbolTable(res.adapted);
    state.uploadedSource = file.name;
    state.activeLayer = 'L1';
    state.activeCardKey = null;
    state.mode = 'single';
    // The server now registers uploaded packs and returns an id so the
    // rest of the API (/api/packs/:id/compile-catalog, /conformance,
    // /deploy, /diff) can address them. Use it as state.selectedPackId
    // so Compile / Deploy / Compare all Just Work — instead of hanging
    // the way they did pre-registration.
    if (res.registered?.id) {
      state.selectedPackId = res.registered.id;
      state.selectedEnv = defaultEnvFor(state.selectedPackId);
      // Refresh the catalog so the picker shows the new uploaded pack
      // alongside the file-backed ones. Pack B picker reads the same
      // catalog so it's available there too.
      await loadCatalog();
    }
    state.selectedService = serviceKeyForPack(state.catalog.find(p => p.id === state.selectedPackId))
      || normalizeServiceKey(state.pack?.meta?.service)
      || state.selectedService;
    applyModeChrome();
    renderServiceSelect();
    renderPackSelect();
    renderPackBSelect();
    renderEnvSelect();
    renderMeta();
    renderTabs();
    renderMainView();
    if (res.legacy) {
      toast(`Loaded ${file.name} — previous (layered JSON) format upconverted to canonical v1.2: ${res.legacy.mapped} artefacts mapped, ${res.legacy.scaffolded} scaffolds`);
    } else {
      toast(`Loaded ${file.name}`);
    }
  } catch (e) {
    toast(`Failed to upload: ${e.message}`, 'error');
  }
}

function setupUpload() {
  const fileInput = $('#file-input');
  const btn = $('#upload-btn');
  const popover = $('#upload-popover');

  // Upload button now opens a small popover offering three paths:
  // (a) pick a local file (the original behaviour), (b) load Krystaline
  // from the live MCP, (c) scan the KrystalineX OSS repo. Click-outside
  // and Esc close it. The popover lets the demo feel organic — the
  // presenter clicks Upload like any user, sees one of the quick-start
  // cases listed, and loads it in one click. Same flows the rest of
  // the studio already uses (no demo-mode codepath).
  const closePopover = () => {
    if (!popover) return;
    popover.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  const openPopover = () => {
    if (!popover) return;
    popover.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  };
  btn.onclick = (ev) => {
    ev.stopPropagation();
    if (!popover) { fileInput.click(); return; }
    popover.hidden ? openPopover() : closePopover();
  };
  document.addEventListener('click', (ev) => {
    if (!popover || popover.hidden) return;
    if (ev.target.closest('.upload-popover-wrap')) return;
    closePopover();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && popover && !popover.hidden) closePopover();
  });
  if (popover) {
    popover.addEventListener('click', async (ev) => {
      const item = ev.target.closest('.upload-popover-item');
      if (!item) return;
      const action = item.dataset.action;
      closePopover();
      if (action === 'pick-file') {
        fileInput.click();
        return;
      }
      if (action === 'quick-krystaline') {
        // Same flow as the home's MCP connect → adopt path, just driven
        // programmatically. We pre-fill the URL and trigger the same
        // doHomeMcpConnect that the home button calls. The friendly
        // label is held on the panel via a data-attribute so the
        // adopt handler can pass it through to the API.
        window._observogramQuickLabel = 'Krystaline (live MCP draft)';
        const newFromLive = document.getElementById('draft-mcp-btn');
        if (newFromLive) newFromLive.click();
        setTimeout(() => {
          const panelUrl = document.getElementById('draft-mcp-url');
          if (panelUrl) panelUrl.value = 'https://www.krystaline.io/mcp/public';
          const goBtn = document.getElementById('draft-mcp-go-btn');
          if (goBtn) goBtn.click();
        }, 60);
        return;
      }
      if (action === 'quick-krystalinex-repo') {
        // Open the scan-a-repo panel and pre-fill the GitHub URL field.
        window._observogramQuickLabel = 'KrystalineX (repo scan)';
        const scanBtn = document.getElementById('crawl-btn');
        if (scanBtn) scanBtn.click();
        setTimeout(() => {
          const ghUrl = document.getElementById('crawl-github-url');
          if (ghUrl) {
            ghUrl.value = 'MoebiusX/KrystalineX';
            ghUrl.dispatchEvent(new Event('input', { bubbles: true }));
          }
          const ghGo = document.getElementById('crawl-github-go-btn');
          if (ghGo && !ghGo.disabled) ghGo.click();
        }, 60);
        return;
      }
    });
  }
  fileInput.onchange = () => { if (fileInput.files?.[0]) handleFile(fileInput.files[0]); fileInput.value = ''; };

  let dragDepth = 0;
  const overlay = $('#drop-overlay');
  document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragDepth++;
    overlay.hidden = false;
    document.body.classList.add('is-dragging');
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      overlay.hidden = true;
      document.body.classList.remove('is-dragging');
    }
  });
  document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0; overlay.hidden = true;
    document.body.classList.remove('is-dragging');
    handleFile(e.dataTransfer.files[0]);
  });
}

// ---------- boot ----------

export async function refresh() {
  try {
    ensureServiceFromPack();
    await loadPack(state.selectedPackId, state.selectedEnv);
    // Compile catalog is pack/env-specific — invalidate on switch so the
    // tree re-fetches the new pack's artifacts.
    state.compileCatalog = null;
    state.compileContent = null;
    renderServiceSelect();
    renderEnvSelect();
    renderPackSelect();
    renderPackBSelect();
    renderMeta();
    renderTabs();
    renderMainView();
  } catch (e) {
    const view = $('#layer-view');
    view.innerHTML = `<div class="error">Failed to load pack: ${escapeHtml(e.message)}</div>`;
    toast('Failed to load pack', 'error');
  }
}

// ============================================================
// OBSERVA chrome — the three-tab top bar from the demo mockup.
//
// Replaces the legacy header (Observogram logo + dense pack-picker row +
// meta strip + view-nav + layer chips) with a single clean chrome:
//
//   ┌──────────────────────────────────────────────────────────────────┐
//   │ [logo] OBSERVOGRAM    ① Layers       ② Comparison    ③ ObsOps     │
//   │                       What's in...   Is it good...   Compile &  │
//   │                                                                  │
//   │                                          Projects · Alerts · AD  │
//   └──────────────────────────────────────────────────────────────────┘
//
// The legacy chrome stays in the DOM but hidden — every existing event
// handler that references #pack-select, #upload-btn, etc. keeps working.
// A small "⚙ controls" button reveals the legacy controls row on demand
// for pack switching / upload / scan / theme until those move into the
// tab content in later phases.
// ============================================================
// Question-oriented chrome: the tab title IS the user's mental
// question, the small workflow word beneath identifies the act the
// product takes to answer it. This is the load-bearing framing —
// most observability tools organize around data types or products;
// Observogram organizes around three questions that map onto a workflow
// people already understand from medicine:
//
//     Discover  →  Diagnose  →  Remediate
//      (CT scan)    (Diagnosis)   (Treatment)
//
// The technical names (Layers / Comparison / ObsOps) move into the
// tooltip — discoverable but not load-bearing on the chrome.
const OBSERVA_TABS = [
  {
    id: 'layers',
    n: '1',
    label: 'What Do We Have?',
    sub: 'Discover',
    techName: 'Layers',
    tagline: 'the Observogram Scan',
    accent: 'tab-blue',
  },
  {
    id: 'compare',
    n: '2',
    label: 'Can We Trust It?',
    sub: 'Diagnose',
    techName: 'Comparison',
    tagline: 'Coverage & Fidelity',
    accent: 'tab-magenta',
  },
  {
    id: 'compile',
    n: '3',
    label: 'Fix The Gaps',
    sub: 'Remediate',
    techName: 'ObsOps',
    tagline: 'Compile & Deploy',
    accent: 'tab-emerald',
  },
];

// "Advanced / Alien Observability" — the deep, specialised tools that
// sit OFF the three-step workflow. A first-time user never needs these;
// an expert reaches for them. They live behind a single right-side
// chrome button (styled like the old action cluster) that opens a menu.
// Each routes to a view that already exists in the dispatcher.
const OBSERVA_ADV = [
  { id: 'references',   label: 'References',   sub: 'catalogue reference packs · benchmark vs best practice' },
  { id: 'conformance',  label: 'Conformance',  sub: 'maturity rubric · MUST/SHOULD per tier' },
  { id: 'schema',       label: 'Schema',       sub: 'canonical YAML + v1.2 validation' },
  { id: 'otlp',         label: 'OTLP Coverage', sub: 'receiver protocols · per-signal exporters' },
  { id: 'traceability', label: 'Traceability', sub: 'repo vs live · declared / verified / stale' },
  { id: 'atlas',        label: 'Atlas',        sub: 'visual atlases · strata · periodic · skyline' },
  { id: 'journeys',     label: 'Journeys',     sub: 'saved drift checks · run history · trends' },
];
const OBSERVA_ADV_VIEWS = new Set(OBSERVA_ADV.map(a => a.id));

function installObservaChrome() {
  if (document.querySelector('.observa-hdr')) return;
  document.body.classList.add('chrome-observa');

  const hdr = document.createElement('header');
  hdr.className = 'observa-hdr';
  hdr.innerHTML = `
    <div class="observa-hdr-inner">
      <a class="observa-brand" href="/" aria-label="Observogram home">
        <span class="observa-logo" aria-hidden="true">
          <svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="observaLogoG" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%"  stop-color="#3b82f6"/>
                <stop offset="50%" stop-color="#a855f7"/>
                <stop offset="100%" stop-color="#10b981"/>
              </linearGradient>
            </defs>
            <path d="M18 3 L31 11 L31 25 L18 33 L5 25 L5 11 Z" stroke="url(#observaLogoG)" stroke-width="2" fill="none"/>
            <path d="M18 11 L25 15 L25 22 L18 26 L11 22 L11 15 Z" stroke="url(#observaLogoG)" stroke-width="1.4" fill="rgba(168,85,247,0.12)"/>
            <circle cx="18" cy="18" r="2.4" fill="url(#observaLogoG)"/>
          </svg>
        </span>
        <span class="observa-brand-text">
          <span class="observa-wordmark">OBSERVO<strong>GRAM</strong></span>
          <span class="observa-tagline">
            <span class="observa-tagline-step">Discover</span>
            <span class="observa-tagline-dot">·</span>
            <span class="observa-tagline-step">Diagnose</span>
            <span class="observa-tagline-dot">·</span>
            <span class="observa-tagline-step">Remediate</span>
          </span>
        </span>
      </a>

      <!-- The active org (Stage 2 tenancy) — same rule as the SERVICE
           chip: which workspace Observogram is reading must never be a
           mystery. Becomes a switcher when the user has several orgs. -->
      <span class="observa-service observa-org" id="observa-org" hidden>
        <span class="observa-service-key">ORG</span>
        <span class="observa-service-name" id="observa-org-name"></span>
      </span>

      <!-- The active service — always visible once chosen (the gate or
           the header SERVICE selector set it). "Observogram is configured
           for MY service" must never be a mystery. -->
      <span class="observa-service" id="observa-service" hidden>
        <span class="observa-service-key">SERVICE</span>
        <span class="observa-service-name" id="observa-service-name"></span>
      </span>

      <nav class="observa-tabs" role="tablist" aria-label="Primary">
        ${OBSERVA_TABS.map(t => `
          <button type="button" role="tab" class="observa-tab ${t.accent}" data-view="${t.id}"
                  aria-selected="false" title="${escapeHtml(t.techName + ' — ' + t.tagline)}">
            <span class="observa-tab-num">${t.n}</span>
            <span class="observa-tab-text">
              <span class="observa-tab-eyebrow">${escapeHtml(t.sub)}</span>
              <span class="observa-tab-title">${escapeHtml(t.label)}</span>
              <span class="observa-tab-tagline">${escapeHtml(t.tagline)}</span>
            </span>
          </button>
        `).join('')}
      </nav>

      <div class="observa-actions" aria-label="Advanced tools">
        <div class="observa-adv-wrap">
          <button type="button" class="observa-action observa-adv-toggle"
                  aria-haspopup="true" aria-expanded="false" aria-controls="observa-adv-menu"
                  title="Advanced — deep observability tools">
            <span class="observa-action-glyph">⬡</span>
            <span class="observa-action-label">Advanced</span>
            <span class="observa-adv-caret">▾</span>
          </button>
          <div class="observa-adv-menu" id="observa-adv-menu" role="menu" aria-label="Advanced tools" hidden>
            <div class="observa-adv-menu-head">Alien Observability · deep tools</div>
            ${OBSERVA_ADV.map(a => `
              <button type="button" class="observa-adv-item" role="menuitem" data-view="${a.id}">
                <span class="observa-adv-item-label">${escapeHtml(a.label)}</span>
                <span class="observa-adv-item-sub">${escapeHtml(a.sub)}</span>
              </button>
            `).join('')}
            <button type="button" class="observa-adv-item observa-adv-about" role="menuitem" data-action="about">
              <span class="observa-adv-item-label">About Observogram</span>
              <span class="observa-adv-item-sub" id="observa-about-sub">version &amp; build</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.insertBefore(hdr, document.body.firstChild);

  // Wire tab clicks → route to the existing view dispatcher.
  const routeTo = (id) => {
    if (!id) return;
    // Clicking any tab leaves the landing/reset hero and enters the
    // workspace. Without this the no-pack state stays mode='home' and
    // every tab would keep rendering the landing hero (the bug behind
    // "why is Discover like the landing hero page?"). The pack is still
    // null until the user loads one — Discover's empty state handles that.
    if (state.mode === 'home') state.mode = 'single';
    state.view = id;
    state.activeCardKey = null;
    state.activeLayer = ({ compile: 'COMPILE', conformance: 'CONF', schema: 'CONF', atlas: 'ATLAS', layers: state.layerFilter !== 'all' ? state.layerFilter : 'L1' })[id] || 'L1';
    applyModeChrome();
    paintObservaActiveTab();
    renderTabs();
    renderMainView();
  };
  for (const btn of hdr.querySelectorAll('.observa-tab')) {
    btn.addEventListener('click', () => routeTo(btn.dataset.view));
  }

  // Wire the Advanced menu — deep tools off the main workflow.
  const advToggle = hdr.querySelector('.observa-adv-toggle');
  const advMenu   = hdr.querySelector('.observa-adv-menu');
  const advItems  = () => [...advMenu.querySelectorAll('.observa-adv-item')];
  // Focus contract: opening moves focus to the first menu item; closing
  // hands it back to the toggle whenever the menu owned it (Escape, item
  // activation) — but an outside click keeps focus where the user clicked.
  const closeAdv = () => {
    if (!advMenu || advMenu.hidden) return;
    const ownedFocus = advMenu.contains(document.activeElement);
    advMenu.hidden = true;
    advToggle?.setAttribute('aria-expanded', 'false');
    if (ownedFocus) advToggle?.focus();
  };
  const positionAdv = () => {
    if (!advToggle || !advMenu) return;
    const gap = 10;
    const pad = 12;
    const rect = advToggle.getBoundingClientRect();
    const width = Math.min(280, Math.max(180, window.innerWidth - pad * 2));
    const left = Math.min(
      Math.max(pad, rect.right - width),
      Math.max(pad, window.innerWidth - width - pad),
    );
    const top = Math.min(
      rect.bottom + gap,
      Math.max(pad, window.innerHeight - pad - advMenu.offsetHeight),
    );
    advMenu.style.width = `${width}px`;
    advMenu.style.left = `${left}px`;
    advMenu.style.top = `${top}px`;
  };
  advToggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = advMenu.hidden;
    if (!willOpen) { closeAdv(); return; }
    advMenu.hidden = false;
    advToggle.setAttribute('aria-expanded', 'true');
    positionAdv();
    advItems()[0]?.focus();
  });
  window.addEventListener('resize', () => { if (advMenu && !advMenu.hidden) positionAdv(); });
  hdr.querySelectorAll('.observa-adv-item').forEach(item => {
    item.addEventListener('click', () => {
      closeAdv();
      if (item.dataset.action === 'about') { openAboutModal(); return; }
      routeTo(item.dataset.view);
    });
  });
  // Arrow-key navigation within the menu (standard menu pattern).
  advMenu?.addEventListener('keydown', (e) => {
    const items = advItems();
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown')      { e.preventDefault(); items[(idx + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home')      { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End')       { e.preventDefault(); items[items.length - 1].focus(); }
  });
  // Close the menu on any outside click / Escape.
  document.addEventListener('click', (e) => {
    if (advMenu && !advMenu.hidden && !e.target.closest('.observa-adv-wrap')) closeAdv();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAdv(); });

  paintObservaActiveTab();
}

function paintObservaActiveTab() {
  const v = state.view || 'layers';
  const active = (v === 'benchmark' || v === 'compare-artefacts') ? 'compare' : v;
  const advActive = OBSERVA_ADV_VIEWS.has(v);
  // The landing/reset hero is NOT a tab — it's the pre-workspace start
  // screen. Clearing the active marker there is what keeps Discover from
  // "being" the landing hero: you only light a tab once you're working.
  const onLanding = state.mode === 'home';
  for (const btn of document.querySelectorAll('.observa-tab')) {
    // A workflow tab is active only when we're NOT in an advanced view
    // and NOT on the landing screen.
    const isActive = !onLanding && !advActive && btn.dataset.view === active;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
  const advToggle = document.querySelector('.observa-adv-toggle');
  if (advToggle) advToggle.classList.toggle('is-active', advActive);
}

async function boot() {
  // Mount the new chrome FIRST so the user sees the demo shape even
  // while the catalog loads.
  installObservaChrome();
  // Identity + active org BEFORE the first /api call — with tenancy on,
  // /api/packs answers from the active org's workspace, so the org
  // header has to be resolved before the catalog loads.
  await loadIdentity();
  resolveActiveOrg();
  try { await loadCatalog(); }
  catch (e) {
    document.body.innerHTML = `<pre class="json" style="margin:48px;max-width:800px">Failed to reach Observogram's API.\n\n${escapeHtml(e.message)}\n\nMake sure the server is running: \`node server/index.mjs\` or \`npm run serve\`.</pre>`;
    return;
  }

  setupUpload();
  setupTheme();
  setupIdentityChip();
  setupResetButton();
  setupExportButton();
  // Eagerly fetch /api/examples so the Pack B picker has the archived
  // reference packs available even before the user visits the home
  // examples disclosure. AWAITED so the persistence rehydrate below can
  // validate saved pack IDs against the merged catalog ∪ examples set.
  await loadAndCacheExamples();
  // Fetch the catalogue reference packs (Advanced → References) so they're
  // available both in that view and as Pack B benchmark targets.
  await loadAndCacheReferences();
  // Wire the Pack B "×" clear button.
  $('#pack-b-clear')?.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    clearPackBState();
    // Compare + Traceability are cross-pack only; Atlas stays available
    // in single mode (Strata / Periodic / Skyline / Arbor work on one pack).
    if (state.view === 'compare' || state.view === 'traceability') state.view = 'layers';
    if (state.view === 'atlas' && CROSS_PACK_VARIANTS.has(state.atlasVariant)) {
      state.atlasVariant = 'strata';
    }
    applyModeChrome();
    renderServiceSelect();
    renderPackBSelect();
    renderTabs();
    renderMainView();
  });
  setupMcpPanel();
  setupCrawlPanel();
  setupDraftFromMcpPanel();
  setupDeployModal();
  installDialogFocusTrap();
  setupHomeAffordance();   // logo click returns home

  // Initial live-status load + 60s soft-refresh of the badge so "3m ago"
  // ticks forward without manual reload.
  state.mcpStatus = await loadLiveStatus();
  renderMcpBadge(state.mcpStatus);
  renderMcpStatusBody(state.mcpStatus);
  setInterval(() => renderMcpBadge(state.mcpStatus), 60_000);

  // Deploy matrix loaded eagerly; used by the compile view.
  loadDeployMatrix().then(() => {
    if (state.mode !== 'home' && state.activeLayer === 'COMPILE') renderMainView();
  });

  // Try to rehydrate from the previous session before falling back to
  // home. Persistence stays suspended until rehydrate finishes so the
  // boot-time mutations don't fire `schedule()` writes.
  const restored = await rehydrateFromPersistence();
  persistence.resume();
  if (!restored) goHome();
}

// ============================================================
// Home / Analyze / Compare mode transitions
// ============================================================

function goHome() {
  state.mode = 'home';
  state.pack = null;
  state.packB = null;
  state.diff = null;
  state.compileCatalog = null;
  state.compileContent = null;
  // Going home is the user saying "start over" — clear the persisted
  // pack/compare-B IDs so the next reload doesn't re-enter analyze mode.
  state.selectedService = null;
  state.selectedPackId = null;
  state.selectedEnv = null;
  state.compareBId = null;
  state.compareBEnv = null;
  state.conformanceB = null;
  state.compileCatalogB = null;
  state.compileContentB = null;
  state.viewFocus = 'a';
  // Reset view so the next pack lands on the default browse, not on
  // whatever the previous session left selected (e.g. Compile, which
  // would be weird with no pack loaded yet).
  state.view = 'layers';
  state.layerFilter = 'all';
  // A signed-in user has services — home for them is "which service are
  // you working on?", not the marketing hero. The hero stays for local
  // mode and for true cold starts (no services yet); the gate links to
  // it for "start something new".
  state.homeVariant = (state.identity?.authenticated && serviceCatalogue().length) ? 'gate' : 'hero';
  applyModeChrome();
  if (state.homeVariant === 'gate') renderServiceGate();
  else renderHomeView();
  persistence.schedule();
}

// ============================================================
// SERVICE GATE — the post-sign-in landing. The user's services
// (from the same catalogue the header SERVICE selector reads),
// one click from "signed in" to "Observogram configured for my
// service". docs/PRODUCTIZATION_PLAN.md Stage 1 UX.
// ============================================================

function renderServiceGate() {
  const view = $('#layer-view');
  if (!view) return;
  const services = serviceCatalogue();
  const who = state.identity?.name || state.identity?.email || state.identity?.sub || '';
  view.innerHTML = `
    <section class="svc-gate">
      <div class="svc-gate-eyebrow">OBSERVOGRAM · THE OBSERVABILITY COMPILER</div>
      <h1 class="svc-gate-title">Welcome back${who ? `, ${escapeHtml(who.split(' ')[0])}` : ''}.</h1>
      <p class="svc-gate-sub">Which service are you working on?</p>
      <div class="svc-gate-grid">
        ${services.map(s => `
          <button type="button" class="svc-gate-card" data-service="${escapeHtml(s.key)}">
            <span class="svc-gate-name">${escapeHtml(s.label)}</span>
            <span class="svc-gate-meta">${s.packCount} pack${s.packCount === 1 ? '' : 's'}${s.liveCount ? ` · ${s.liveCount} live draft${s.liveCount === 1 ? '' : 's'}` : ''}</span>
          </button>`).join('')}
      </div>
      <button type="button" class="svc-gate-new" id="svc-gate-new">+ start something new — connect an MCP endpoint, upload or scan a repo</button>
    </section>
  `;
  view.querySelectorAll('.svc-gate-card').forEach(card => {
    card.addEventListener('click', () => enterServiceWorkspace(card.dataset.service));
  });
  view.querySelector('#svc-gate-new')?.addEventListener('click', () => {
    state.homeVariant = 'hero';
    renderHomeView();
  });
}

// Reflect the active service into the always-visible OBSERVA-bar chip.
// Called wherever the selection can change (service select, analyze
// mode entry, mode chrome) — hidden on home where no service is active.
function updateObservaOrgChip() {
  const chip = document.getElementById('observa-org');
  if (!chip) return;
  const orgs = state.identity?.orgs || [];
  const active = orgs.find(o => o.id === getActiveOrg()) || orgs[0];
  if (!active) { chip.hidden = true; return; }
  const name = document.getElementById('observa-org-name');
  if (orgs.length > 1 && !chip.querySelector('select')) {
    const sel = document.createElement('select');
    sel.className = 'observa-org-select';
    sel.setAttribute('aria-label', 'Active organisation');
    for (const o of orgs) {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.name || o.id;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      setActiveOrg(sel.value);
      // Every view is a projection of the active org's workspace — a
      // clean re-boot is the honest refresh.
      window.location.reload();
    });
    name.replaceWith(sel);
  }
  const sel = chip.querySelector('select');
  if (sel) sel.value = active.id;
  else name.textContent = active.name || active.id;
  chip.title = `organisation: ${active.id} (role: ${active.role || 'member'})`;
  chip.hidden = false;
}

function updateObservaServiceChip() {
  updateObservaOrgChip();
  const chip = document.getElementById('observa-service');
  if (!chip) return;
  const name = document.getElementById('observa-service-name');
  const services = serviceCatalogue();
  const active = services.find(s => s.key === state.selectedService);
  if (state.mode === 'home' || !active) { chip.hidden = true; return; }
  name.textContent = active.label;
  chip.hidden = false;
}

// One click on a service card → Observogram configured for that service:
// service selected, its most recent pack loaded as Pack A, Discover open.
function enterServiceWorkspace(serviceKey) {
  if (!serviceKey) return;
  state.selectedService = serviceKey;
  // Catalog order is oldest→newest (workspace registry order, new
  // registrations appended) — the LAST match is the freshest. Prefer the
  // declared (non-aggregate) pack; an aggregate live draft is a usable
  // fallback when it's all the service has.
  const matches = state.catalog.filter(p => p.ok && packMatchesService(p, serviceKey, { side: 'a' }));
  const declared = matches.filter(p => !isLiveAggregatePack(p));
  const pack = declared[declared.length - 1] || matches[matches.length - 1]
    || state.catalog.filter(p => p.ok && packMatchesService(p, serviceKey, { side: 'b' })).pop();
  if (!pack) {
    // A service with nothing loadable (e.g. example-derived) — fall back
    // to the hero so the user can bring a pack in.
    state.homeVariant = 'hero';
    renderHomeView();
    return;
  }
  enterAnalyzeMode(pack.id, defaultEnvFor(pack.id));
}

function enterAnalyzeMode(packId, env) {
  if (!packId) return;
  state.mode = 'single';
  state.selectedPackId = packId;
  state.selectedEnv    = env || defaultEnvFor(packId);
  state.selectedService = serviceKeyForPack(state.catalog.find(p => p.id === packId)) || state.selectedService;
  state.activeLayer = 'L1';
  state.activeCardKey = null;
  applyModeChrome();
  renderServiceSelect();
  renderPackSelect();
  refresh();
}

function enterCompareMode(aId, aEnv, bId, bEnv) {
  if (!aId || !bId) return;
  state.mode = 'compare';
  state.selectedPackId = aId;
  state.selectedEnv    = aEnv || defaultEnvFor(aId);
  state.selectedService = serviceKeyForPack(state.catalog.find(p => p.id === aId)) || state.selectedService;
  state.compareBId     = bId;
  state.compareBEnv    = bEnv || defaultEnvFor(bId);
  state.activeLayer    = 'COMPARE';
  applyModeChrome();
  renderServiceSelect();
  renderPackSelect();
  refresh();
  refreshDiff();
}

// Show/hide global chrome based on mode. Home hides the pack-select,
// env-select, meta strip and tabs — only the brand + the corner
// utility buttons (upload, new from repo, new from live, mcp, theme,
// api) stay visible because they're the entry points to creating a
// new pack.
function applyModeChrome() {
  const isHome = state.mode === 'home';
  updateObservaServiceChip();
  // Under the OBSERVA chrome the pack/env selectors are PINNED as a
  // permanent master row — they are the user's primary controls and
  // must never be hidden by view. Only the legacy (non-chrome) layout
  // hides them on the artefact-id side-by-side view, where the inline
  // pack cards carry their own pickers.
  const observa = document.body.classList.contains('chrome-observa');
  const onCompare = !observa && state.view === 'compare-artefacts';
  document.body.dataset.mode = state.mode;
  document.body.dataset.view = state.view || '';
  const packSel = $('#pack-select')?.parentElement;
  const envSel  = $('#env-select')?.parentElement;
  const serviceSel = $('#ctrl-service');
  if (serviceSel) serviceSel.hidden = isHome || onCompare;
  if (packSel) packSel.hidden = isHome || onCompare;
  if (envSel)  envSel.hidden  = isHome || onCompare;
  // Pack B picker stays visible whenever we're not on home — empty until
  // the user picks something. This is the unlock: no more rigid single
  // vs compare mode. Hide it on Compare for the same duplication reason.
  const packBCtrl = $('#ctrl-pack-b');
  const envBCtrl  = $('#ctrl-env-b');
  if (packBCtrl) packBCtrl.hidden = isHome || onCompare;
  if (envBCtrl)  envBCtrl.hidden  = isHome || onCompare || !state.packB;
  // Clear-B button only when B is loaded.
  const clearB = $('#pack-b-clear');
  if (clearB) clearB.hidden = !state.packB || onCompare;
  const meta = $('#meta');   if (meta) meta.hidden = isHome;
  const tabs = $('#layer-tabs'); if (tabs) tabs.hidden = isHome;
  // Export is only meaningful once a pack is loaded (it bundles the focused
  // pack's manifest + compiled artefacts).
  const exportBtn = $('#export-btn');
  if (exportBtn) exportBtn.hidden = isHome || !focusedPackId();
}

// RESET button — clears EVERYTHING (server uploads + client persistence)
// and reloads. Hard-refresh alone doesn't reset the studio because
// persistence rehydrates the previous pack, and uploaded packs sit in
// the server's in-memory map until the process restarts. This button
// gives the user one click for a true clean slate without bouncing
// `npm run dev`.
function setupResetButton() {
  const btn = $('#reset-btn');
  if (!btn) return;
  btn.onclick = async () => {
    const ok = confirm('Reset Observogram?\n\n' +
      'This will:\n' +
      '  • drop every uploaded / scanned / drafted pack from the server\n' +
      '  • clear saved view + filter + focus + trace preferences from localStorage\n' +
      '  • reload the page to the empty home screen\n\n' +
      'Catalog-shipped example packs are unaffected (they live on disk).');
    if (!ok) return;
    // 1. Stop persistence from racing the reload + writing stale state.
    try { persistence.suspend(); } catch (_) {}
    // 2. Wipe localStorage. Keep theme so the user's dark/light choice
    //    survives — that's not session state, it's a preference.
    try {
      const theme = localStorage.getItem('studioTheme');
      localStorage.clear();
      if (theme) localStorage.setItem('studioTheme', theme);
    } catch (_) {}
    // 3. Drop server-side uploads. If the endpoint is unreachable we
    //    still reload — the client-side reset is the higher-leverage part.
    try {
      await fetch('/api/uploads', { method: 'DELETE' });
    } catch (_) {}
    // 4. Reload. location.reload(true) is non-standard in modern Firefox;
    //    plain reload() picks up server changes since the navigation
    //    bypasses the disk cache for HTML.
    location.reload();
  };
}

// Export button — download the focused pack as one ZIP: its canonical
// pack.yaml plus every compiled artefact. The server builds the bundle
// (GET /api/packs/:id/export.zip); here we just trigger the download.
function setupExportButton() {
  const btn = $('#export-btn');
  if (!btn) return;
  btn.onclick = () => {
    const id = focusedPackId();
    if (!id) { toast('Load a pack first', 'error'); return; }
    const env = focusedEnv();
    const qs = env ? `?env=${encodeURIComponent(env)}` : '';
    const a = document.createElement('a');
    a.href = `/api/packs/${encodeURIComponent(id)}/export.zip${qs}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
}

// Logo click returns home.
function setupHomeAffordance() {
  const brand = document.querySelector('.hdr-brand h1');
  if (!brand) return;
  brand.style.cursor = 'pointer';
  brand.title = 'Return home';
  brand.onclick = () => goHome();
}

// Hero / home screen — two big affordances. Mode-aware.
// Default MCP endpoint shown on the home screen — points to Krystaline's
// public reference MCP so a first-time visitor's one-click experience
// is connecting to a real, live observability platform. localStorage
// override (the user's last-used MCP URL) wins so returning users keep
// their own configured endpoint. To rebrand for a different anchor MCP,
// change this constant — the rest of the home is data-driven.
const DEFAULT_MCP_URL = 'https://www.krystaline.io/mcp/public';

// Packs available to inspect right now: anything uploaded/drafted this
// session plus the archived /api/examples set (cached at boot), de-duped.
function availablePickerPacks() {
  return [
    ...((state.catalog || []).filter(p => p.ok && p.id)),
    ...((state._examplesCache || []).filter(p => p.ok)),
  ].filter((p, i, arr) => arr.findIndex(q => q.id === p.id) === i);
}

// Wire a list of .home-pick-row buttons → load the chosen pack as Pack A
// and draw it. Examples live only in the cache, so promote the selected
// one into the catalog before entering analyze mode.
function wirePackPickerRows(scope) {
  scope.querySelectorAll('.home-pick-row').forEach(row => {
    row.onclick = () => {
      const id = row.dataset.packId;
      if (!id) return;
      if (!(state.catalog || []).find(p => p.id === id)) {
        const ex = (state._examplesCache || []).find(p => p.id === id);
        if (ex) (state.catalog = state.catalog || []).push(ex);
      }
      enterAnalyzeMode(id, defaultEnvFor(id));
    };
  });
}

function packPickerRowsHtml() {
  return availablePickerPacks().map(p => `
    <button type="button" class="home-pick-row" data-pack-id="${escapeHtml(p.id)}">
      <span class="home-pick-name">${escapeHtml(p.label || p.name || p.id)}</span>
      <span class="home-pick-meta">
        ${p.criticality ? `<span class="home-pick-tier">${escapeHtml(p.criticality)}</span>` : ''}
        <span class="home-pick-ver">v${escapeHtml(p.version || '1.2')}</span>
      </span>
      <span class="home-pick-go" aria-hidden="true">→</span>
    </button>
  `).join('');
}

// ============================================================
// DISCOVER — empty state. The Discover tab answers "what do we have?",
// and the FLOW is: load-or-generate a pack first, THEN see its inventory.
// So with no pack this renders the three ways to GET a pack — crawl a
// repo, generate live from an MCP server, or upload a manifest — plus a
// quick picker of packs already on hand.
// ============================================================
function renderDiscoverEmpty(view) {
  const pickerRows = packPickerRowsHtml();
  view.innerHTML = `
    <section class="discover-empty">
      <header class="discover-empty-head">
        <h2 class="discover-empty-title">What do we have?</h2>
        <p class="discover-empty-lede">
          Load or generate an ObservabilityPack to draw its observogram — the
          per-layer inventory of every contract, signal, dashboard, alert
          and check that makes up this service's observability posture.
        </p>
      </header>

      <ol class="discover-journey" aria-label="The drift check, in three steps">
        <li class="discover-journey-step">
          <span class="discover-journey-num">1</span>
          <span class="discover-journey-body">
            <span class="discover-journey-label">Scan a repo</span>
            <span class="discover-journey-sub">what the service <em>declares</em> — Pack A</span>
          </span>
        </li>
        <li class="discover-journey-step">
          <span class="discover-journey-num">2</span>
          <span class="discover-journey-body">
            <span class="discover-journey-label">Generate from live</span>
            <span class="discover-journey-sub">what the platform <em>verifies</em> — Pack B</span>
          </span>
        </li>
        <li class="discover-journey-step">
          <span class="discover-journey-num">3</span>
          <span class="discover-journey-body">
            <span class="discover-journey-label">Diagnose drift</span>
            <span class="discover-journey-sub">where declared and live disagree — automatic</span>
          </span>
        </li>
      </ol>

      <div class="discover-load">
        <button type="button" class="discover-load-card" data-load="crawl">
          <span class="discover-load-glyph" aria-hidden="true">↻</span>
          <span class="discover-load-label">① Scan a repository</span>
          <span class="discover-load-sub">walk Prom / OTel / Grafana / Alertmanager configs — local folder or a GitHub URL</span>
        </button>
        <button type="button" class="discover-load-card" data-load="mcp">
          <span class="discover-load-glyph" aria-hidden="true">⟳</span>
          <span class="discover-load-label">② Generate live from MCP</span>
          <span class="discover-load-sub">interrogate a live OpenTelemetry MCP server for backends, baselines and anomalies</span>
        </button>
        <button type="button" class="discover-load-card" data-load="upload">
          <span class="discover-load-glyph" aria-hidden="true">▤</span>
          <span class="discover-load-label">Upload a pack</span>
          <span class="discover-load-sub">an existing canonical v1.2 YAML or JSON manifest</span>
        </button>
      </div>

      ${pickerRows ? `
      <div class="home-picker discover-empty-picker">
        <div class="home-picker-head"><span>or inspect a pack already on hand</span></div>
        <div class="home-picker-list">${pickerRows}</div>
      </div>` : ''}
    </section>
  `;

  // The three load cards proxy the proven header entry points so there's
  // a single implementation of crawl / draft-from-mcp / upload.
  const proxy = { crawl: '#crawl-btn', mcp: '#draft-mcp-btn', upload: '#upload-btn' };
  view.querySelectorAll('.discover-load-card').forEach(card => {
    card.onclick = () => $(proxy[card.dataset.load])?.click();
  });
  wirePackPickerRows(view);
}

// Diagnose / Remediate with no pack loaded — both need a pack from
// Discover first. Point the user there rather than showing an empty grid.
function renderNeedPackPrompt(view) {
  const what = state.view === 'compile' ? 'compile and deploy' : 'diagnose';
  view.innerHTML = `
    <section class="need-pack">
      <h2 class="need-pack-title">Load a pack first</h2>
      <p class="need-pack-lede">There's nothing to ${escapeHtml(what)} yet. Head to
        <strong>Discover</strong> to crawl a repo, generate from a live MCP server, or
        upload a manifest — then come back here.</p>
      <button type="button" class="need-pack-btn" id="need-pack-goto-discover">
        <span>Go to Discover</span><span aria-hidden="true">→</span>
      </button>
    </section>
  `;
  $('#need-pack-goto-discover').onclick = () => {
    state.view = 'layers';
    applyModeChrome();
    paintObservaActiveTab();
    renderTabs();
    renderMainView();
  };
}

function renderHomeView() {
  const view = $('#layer-view');
  if (!view) return;

  // Premium fintech-grade home. The previous draft was functional but
  // crude — eyebrow numbering, four widget boxes, textbook-internal
  // tone. This redesign assumes a sophisticated audience: confident
  // serif headline, single primary action (URL already filled in, just
  // hit Connect), capability surface presented as an executive summary
  // not a dashboard. Auth + manual paths still reachable but quiet.
  const mcpUrl = (() => {
    try { return localStorage.getItem('mcpUrl') || DEFAULT_MCP_URL; }
    catch (_) { return DEFAULT_MCP_URL; }
  })();

  view.innerHTML = `
    <section class="home-hero">
      <div class="home-hero-eyebrow">observogram · the observability compiler</div>
      <h2 class="home-hero-title">Map your observability platform in seconds.</h2>
      <p class="home-hero-lede">
        Scan a service repo to capture what it <em>declares</em>, then draft
        from a live OpenTelemetry MCP server to capture what the platform
        <em>verifies</em> — Observogram diffs the two and shows you exactly where
        they drift. Connect below to begin, or scan a repo from Discover.
      </p>

      <div class="home-mcp-card">
        <label class="home-mcp-url-row">
          <span class="home-mcp-url-label">MCP endpoint</span>
          <input id="home-mcp-url" type="url" autocomplete="off" spellcheck="false" value="${escapeHtml(mcpUrl)}">
        </label>
        <div class="home-mcp-actions">
          <button id="home-mcp-connect" type="button" class="home-mcp-connect-btn">
            <span class="home-mcp-connect-label">Connect</span>
            <span class="home-mcp-connect-arrow" aria-hidden="true">→</span>
          </button>
          <button id="home-mcp-advanced-toggle" type="button" class="home-mcp-advanced-toggle" aria-expanded="false">
            Advanced
          </button>
          <span id="home-mcp-status" class="home-mcp-status"></span>
        </div>
        <div id="home-mcp-advanced" class="home-mcp-advanced" hidden>
          <label class="home-mcp-field">
            <span class="home-mcp-key">Auth token <em>not persisted</em></span>
            <input id="home-mcp-auth" type="password" placeholder="bearer" autocomplete="off">
          </label>
        </div>

        <!-- Capabilities surface here once the MCP responds. -->
        <div id="home-mcp-capabilities" class="home-mcp-capabilities" hidden></div>

        <div id="home-mcp-adopt-bar" class="home-mcp-adopt-bar" hidden>
          <button id="home-mcp-adopt" type="button" class="home-mcp-adopt-btn">
            <span class="home-mcp-adopt-title">Render the manifest</span>
            <span class="home-mcp-adopt-sub" id="home-mcp-adopt-hint">canonical v1.2 · ready to compile and deploy</span>
          </button>
        </div>
      </div>

      <div class="home-alt">
        <div class="home-alt-head"><span>or open a pack manually</span></div>
        <div class="home-alt-buttons">
          <button id="home-shortcut-upload" type="button" class="home-alt-btn">
            <span class="home-alt-key" aria-hidden="true">▤</span>
            <span class="home-alt-label">Drop a YAML / JSON pack</span>
            <span class="home-alt-sub">canonical v1.2 manifest</span>
          </button>
          <button id="home-shortcut-crawl" type="button" class="home-alt-btn">
            <span class="home-alt-key" aria-hidden="true">↻</span>
            <span class="home-alt-label">Scan a service repo</span>
            <span class="home-alt-sub">walks Prom / OTel / Grafana / AM configs · or a GitHub URL</span>
          </button>
        </div>
      </div>
    </section>
  `;

  $('#home-mcp-connect').onclick = () => doHomeMcpConnect();
  $('#home-mcp-url').onkeydown = (e) => { if (e.key === 'Enter') doHomeMcpConnect(); };
  $('#home-mcp-advanced-toggle').onclick = () => {
    const adv = $('#home-mcp-advanced');
    const tog = $('#home-mcp-advanced-toggle');
    const shown = adv.hidden;
    adv.hidden = !shown;
    tog.setAttribute('aria-expanded', String(shown));
    if (shown) $('#home-mcp-auth')?.focus();
  };
  $('#home-shortcut-upload').onclick = () => $('#upload-btn')?.click();
  $('#home-shortcut-crawl').onclick  = () => $('#crawl-btn')?.click();
}

async function doHomeMcpConnect() {
  const urlInput  = $('#home-mcp-url');
  const authInput = $('#home-mcp-auth');
  const statusEl  = $('#home-mcp-status');
  const goBtn     = $('#home-mcp-connect');
  const capEl     = $('#home-mcp-capabilities');
  const adoptBar  = $('#home-mcp-adopt-bar');
  if (!urlInput || !statusEl) return;

  const url  = urlInput.value.trim();
  const auth = authInput?.value || '';
  if (!url) {
    statusEl.textContent = 'enter your MCP URL first';
    statusEl.className = 'home-mcp-status is-error';
    return;
  }
  try { localStorage.setItem('mcpUrl', url); } catch (_) {}

  goBtn.disabled = true;
  statusEl.textContent = 'contacting MCP…';
  statusEl.className = 'home-mcp-status is-pending';
  capEl.hidden = true;
  adoptBar.hidden = true;

  try {
    const r = await fetch('/api/draft-from-mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        mcpUrl: url,
        mcpAuth: auth || undefined,
        // Forward the quick-start friendly label when the user came
        // through the Upload popover. window._observogramQuickLabel is
        // cleared after consumption so manual draft-from-mcp from the
        // panel keeps the auto-generated label.
        label: window._observogramQuickLabel || undefined,
      }),
    });
    if (window._observogramQuickLabel) window._observogramQuickLabel = null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw new Error(`server returned ${r.status} ${ct || 'no content-type'}`);
    }
    const out = await r.json();
    if (!out.ok) throw new Error(out.error || 'MCP draft failed');
    draftMcpState.lastResult = out;

    statusEl.textContent = `connected · ${out.summary.discovered.backends} backend(s) · ${out.tookMs}ms`;
    statusEl.className = 'home-mcp-status is-ok';

    renderHomeMcpCapabilities(out, capEl);
    capEl.hidden = false;
    adoptBar.hidden = false;

    const hint = $('#home-mcp-adopt-hint');
    if (hint) hint.textContent = out.canonical?.metadata?.name
      ? `pack name: ${out.canonical.metadata.name}` : '';

    $('#home-mcp-adopt').onclick = () => adoptDraftFromMcpResult();
  } catch (e) {
    statusEl.textContent = `error: ${e.message}`;
    statusEl.className = 'home-mcp-status is-error';
  } finally {
    goBtn.disabled = false;
  }
}

function renderHomeMcpCapabilities(out, host) {
  const s = out.summary?.discovered || {};
  const ann = out.annotations || {};
  const tools = (ann['mcp.toolsCalled'] || '').split(',').filter(Boolean);
  const failed = (ann['mcp.toolsFailed'] || '').split(',').filter(Boolean);
  const services = (ann['mcp.servicesDiscovered'] || '').split(',').filter(Boolean);
  const baselines = parseInt(ann['mcp.baselinesComputed'] || '0', 10);
  const anomalies = parseInt(ann['mcp.activeAnomalies'] || '0', 10);
  const backends = s.backends ?? 0;

  // tools/list inventory: the full set of tools the MCP advertised, and the
  // subset Observogram doesn't yet have a probe pattern for. These come from
  // the post-rename fetcher that calls `tools/list` instead of guessing.
  const toolsExposed   = (ann['mcp.toolsExposed']   || '').split(',').filter(Boolean);
  const toolsUnmatched = (ann['mcp.toolsUnmatched'] || '').split(',').filter(Boolean);

  // backend_capabilities inventory: the canonical skill → backend →
  // product → version matrix the MCP exposes. When present, render the
  // full version-gating story below the 4-card grid so the user sees
  // EVERYTHING their MCP can speak to before drafting a pack.
  const capabilities = out.summary?.capabilities || null;

  // Live version captures — authoritative version strings pulled from
  // grafana_health / metrics_query vm_app_version etc. Threaded into
  // the capability chips so the demo audience sees ground truth, not
  // just the policy band.
  const liveVersions = {};
  for (const [k, v] of Object.entries(ann)) {
    const m = /^mcp\.versions\.([a-z0-9_-]+)$/.exec(k);
    if (m) liveVersions[m[1]] = v;
  }

  // Recognised vs unrecognised tools (over what we CALLED, not what was
  // advertised). Tracks the canonical otel-mcp-server tool catalog
  // (metrics_*, grafana_*, alertmanager_*, pipeline_*) plus the generic
  // system + zk-proof tools.
  const knownTools = new Set([
    // generic / system
    'system_health', 'system_topology',
    'anomalies_active', 'anomalies_baselines',
    // zk-proofs skill
    'zk_proof_get', 'zk_proof_verify', 'zk_solvency', 'zk_stats',
    // metrics skill (Prometheus)
    'metrics_query', 'metrics_query_range', 'metrics_targets',
    'metrics_alerts', 'metrics_metadata', 'metrics_label_values',
    // grafana skill
    'grafana_health', 'grafana_datasources', 'grafana_datasource_health',
    'grafana_datasource_query', 'grafana_dashboards_search',
    'grafana_dashboard_get', 'grafana_folders', 'grafana_alert_rules',
    'grafana_alerts', 'grafana_contact_points',
    // alertmanager skill
    'alertmanager_alerts', 'alertmanager_groups', 'alertmanager_silences',
    'alertmanager_status',
    // pipeline skill
    'pipeline_alloy', 'pipeline_beats', 'pipeline_fluentbit', 'pipeline_vector',
  ]);
  const recognised   = tools.filter(t => knownTools.has(t));
  const unrecognised = tools.filter(t => !knownTools.has(t));
  const mcpHost = (() => {
    try { return new URL(out.summary?.mcpUrl || '').host || 'mcp'; }
    catch (_) { return 'mcp'; }
  })();

  // Four-card grid: each capability owns its own card with detail
  // content inside. Connection status sits above as a pulse-dot line.
  // Styling kept from the premium pass (subtle borders, serif numbers,
  // ink-tone accents) but the per-card content is back so the user can
  // SEE which tools were called, which services were discovered, etc.
  host.innerHTML = `
    <div class="home-mcp-report">
      <div class="home-mcp-report-head">
        <span class="home-mcp-report-dot" aria-hidden="true"></span>
        Connected to <strong>${escapeHtml(mcpHost)}</strong>${out.tookMs ? ` <span class="home-mcp-report-meta">· ${out.tookMs}ms</span>` : ''}
      </div>
      <div class="home-mcp-cap-grid">
        <div class="home-mcp-cap" data-cap="tools">
          <div class="home-mcp-cap-num">${toolsExposed.length || tools.length}</div>
          <div class="home-mcp-cap-key">${toolsExposed.length ? 'tools exposed' : 'tools called'}</div>
          <div class="home-mcp-cap-detail">${recognised.length ? recognised.map(t => `<code>${escapeHtml(t)}</code>`).join(' ') : '<em>none recognised</em>'}</div>
          ${toolsUnmatched.length ? `<div class="home-mcp-cap-detail home-mcp-cap-detail-unknown">+${toolsUnmatched.length} not yet probed: ${toolsUnmatched.slice(0, 8).map(t => `<code>${escapeHtml(t)}</code>`).join(' ')}${toolsUnmatched.length > 8 ? ` <em>+${toolsUnmatched.length - 8} more</em>` : ''}</div>` : ''}
          ${unrecognised.length && !toolsUnmatched.length ? `<div class="home-mcp-cap-detail home-mcp-cap-detail-unknown">+${unrecognised.length} unrecognised: ${unrecognised.map(t => `<code>${escapeHtml(t)}</code>`).join(' ')}</div>` : ''}
          ${failed.length ? `<div class="home-mcp-cap-detail home-mcp-cap-detail-fail">⚠ failed: ${failed.map(t => `<code>${escapeHtml(t)}</code>`).join(' ')}</div>` : ''}
        </div>
        <div class="home-mcp-cap" data-cap="services">
          <div class="home-mcp-cap-num">${services.length}</div>
          <div class="home-mcp-cap-key">services discovered</div>
          <div class="home-mcp-cap-detail">${services.length ? services.slice(0, 6).map(s => `<code>${escapeHtml(s)}</code>`).join(' ') + (services.length > 6 ? `<div class="home-mcp-cap-more">+${services.length - 6} more</div>` : '') : '<em>none</em>'}</div>
        </div>
        <div class="home-mcp-cap" data-cap="backends">
          <div class="home-mcp-cap-num">${backends}</div>
          <div class="home-mcp-cap-key">backends inferred</div>
          <div class="home-mcp-cap-detail">${backends ? 'metrics / logs / traces<div class="home-mcp-cap-meta">pipelines inferred from topology</div>' : '<em>none observed</em>'}</div>
        </div>
        <div class="home-mcp-cap" data-cap="anomalies">
          <div class="home-mcp-cap-num">${anomalies}</div>
          <div class="home-mcp-cap-key">active anomalies</div>
          <div class="home-mcp-cap-detail">${baselines} baseline${baselines === 1 ? '' : 's'} computed<div class="home-mcp-cap-meta">from recent telemetry</div></div>
        </div>
      </div>
      ${renderCapabilitiesPanel(capabilities, liveVersions)}
      ${out.summary?.warnings?.length ? `
        <div class="home-mcp-gaps">
          <div class="home-mcp-gaps-head">⚠ Honest gaps</div>
          <ul>${out.summary.warnings.slice(0, 5).map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
        </div>` : ''}
    </div>
  `;
}

// Render the skill → backend → product → version matrix the MCP
// exposes via `backend_capabilities`. The signal-class skills
// (metrics/logs/traces/profiles + alerting/dashboards) lead because
// they're what drive Observogram's L1–L4 projection; the rest follow
// in a compact tail.
//
// When `liveVersions` carries an authoritative live version for a
// product (e.g. {grafana: "12.4.0", victoriametrics: "v1.113.0"} from
// grafana_health + metrics_query), the chip flips to "live mode": the
// live version is shown in bold instead of the policy must[0], and a
// "● LIVE" indicator hangs off the chip so the audience can see at a
// glance which versions are attested vs which are inferred from
// capabilities.
function renderCapabilitiesPanel(capabilities, liveVersions = {}) {
  if (!capabilities || !Array.isArray(capabilities.inventory) || !capabilities.inventory.length) return '';

  // The spec's Signal enum order — used to group + sort entries.
  const SIGNAL_SKILLS = ['metrics', 'logs', 'traces', 'pyroscope', 'alertmanager', 'grafana'];
  const grouped = new Map();
  for (const row of capabilities.inventory) {
    if (!grouped.has(row.skill)) grouped.set(row.skill, []);
    grouped.get(row.skill).push(row);
  }
  const orderedSkills = [
    ...SIGNAL_SKILLS.filter(s => grouped.has(s)),
    ...[...grouped.keys()].filter(s => !SIGNAL_SKILLS.includes(s)).sort(),
  ];

  const liveCount = Object.keys(liveVersions).length;

  const rows = orderedSkills.map(skill => {
    const backends = grouped.get(skill);
    const chips = backends.map(b => {
      const product = b.product || b.backend;
      // `liveVersions[product]` carries either a real version string
      // (e.g. "12.4.0") OR the sentinel "live" when the backend
      // responded to a probe but doesn't expose a readable version
      // (Jaeger via traces_services). Both flip the chip to live mode.
      const live = liveVersions[product];
      const policyVer = (b.versions?.must || [])[0] || '';
      const isLive = !!live;
      // When the capture has a real version, show it. When it's the
      // "live" sentinel, keep showing the policy version (jaeger 2.x)
      // because that's the only number we have — but still mark it
      // ● LIVE so the user knows the backend itself is responding.
      const isAliveSentinel = isLive && live === 'live';
      const ver = isAliveSentinel ? policyVer : (isLive ? live : policyVer);
      const liveTooltip = !isLive ? '' :
        (isAliveSentinel
          ? ` · live=responding (version not exposed)`
          : ` · live=${live}`);
      return `<span class="home-mcp-skill-chip${isLive ? ' is-live' : ''}" title="${escapeHtml(b.backend)} · must=${escapeHtml((b.versions?.must||[]).join(','))}${liveTooltip}">
        <strong>${escapeHtml(product)}</strong>${ver ? ` <em>${escapeHtml(ver)}</em>` : ''}${isLive ? `<span class="home-mcp-skill-chip-live" aria-label="live version">●&nbsp;LIVE</span>` : ''}
      </span>`;
    }).join('');
    return `
      <div class="home-mcp-skill-row" data-skill="${escapeHtml(skill)}">
        <div class="home-mcp-skill-name">${escapeHtml(skill)}</div>
        <div class="home-mcp-skill-chips">${chips}</div>
      </div>
    `;
  }).join('');

  const liveSummary = liveCount
    ? ` · <span class="home-mcp-skills-meta-live">${liveCount} live version${liveCount === 1 ? '' : 's'}</span>`
    : '';

  return `
    <div class="home-mcp-skills">
      <div class="home-mcp-skills-head">
        <div class="home-mcp-skills-title">
          Backend capabilities
          <span class="home-mcp-skills-meta">
            ${capabilities.skillCount} skill${capabilities.skillCount === 1 ? '' : 's'}
            · ${capabilities.backendCount} backend${capabilities.backendCount === 1 ? '' : 's'}
            · gating <code>${escapeHtml(capabilities.gatingMode)}</code>${liveSummary}
          </span>
        </div>
        <div class="home-mcp-skills-sub">From <code>backend_capabilities</code> — every skill the MCP can speak to, the products it implements, and the version policy it enforces. <strong>LIVE</strong> chips carry an authoritative version captured from the backend itself.</div>
      </div>
      <div class="home-mcp-skills-body">${rows}</div>
    </div>
  `;
}

async function loadAndCacheExamples() {
  if (state._examplesCache?.length) return state._examplesCache;
  try {
    const r = await api('/api/examples');
    state._examplesCache = r.examples || [];
    // Re-render the Pack B picker so the newly available options appear.
    renderServiceSelect();
    renderPackBSelect();
  } catch (_) { state._examplesCache = []; }
  return state._examplesCache;
}

// Catalogue reference packs (Kafka / Prometheus / Grafana) — fetched once
// and cached. They power the Advanced → References view (reference
// component analysis) and stay available as Pack B options so the
// benchmark CTA can load them for comparison.
export async function loadAndCacheReferences() {
  if (state._referencesCache?.length) return state._referencesCache;
  // Single-flight: concurrent callers (boot + the References view) share
  // one fetch. _referencesError distinguishes "failed" from "catalogue is
  // empty" so the view can render an honest state instead of loading
  // forever; a retry just calls this again.
  if (state._referencesPromise) return state._referencesPromise;
  state._referencesPromise = (async () => {
    try {
      const r = await api('/api/references');
      state._referencesCache = r.references || [];
      state._referencesError = null;
      state._referencesLoaded = true; // settled — even an empty catalogue
      renderServiceSelect();
      renderPackBSelect();
    } catch (e) {
      state._referencesCache = [];
      state._referencesError = e?.message || 'failed to load /api/references';
    } finally {
      state._referencesPromise = null;
    }
    return state._referencesCache;
  })();
  return state._referencesPromise;
}

// loadAndRenderHomeExamples + openExampleAsPack lived here until the
// home-screen redesign — they powered the "Browse archived reference
// packs" disclosure. Dropped now that the home screen is just the
// drop-zone affordance + 3 input buttons; example packs are still
// reachable as Pack B options (loadAndCacheExamples populates them in
// the picker) but no longer surface on the empty start screen.

$('#drawer-close').onclick   = () => closeDrawer('b');
$('#drawer-a-close').onclick = () => closeDrawer('a');
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); closeMcpPanel(); } });

// ---------- MCP refresh panel ----------

const MCP_STALE_HOURS = 1;

async function loadLiveStatus() {
  try { return await api('/api/live-status'); }
  catch { return { present: false }; }
}

function renderMcpBadge(status) {
  const btn = $('#mcp-btn');
  const ageEl = $('#mcp-btn-age');
  if (!btn || !ageEl) return;
  if (!status?.present) {
    btn.dataset.mcpState = 'idle';
    ageEl.textContent = 'idle';
    btn.title = 'No live pack yet — open to refresh from MCP';
    return;
  }
  const stale = status.refreshedAt && (Date.now() - Date.parse(status.refreshedAt) > MCP_STALE_HOURS * 3600_000);
  const errored = (status.toolsFailed || '').trim() !== '';
  btn.dataset.mcpState = errored ? 'error' : stale ? 'stale' : 'fresh';
  ageEl.textContent = fmtRelative(status.refreshedAt) || '—';
  btn.title = errored
    ? `MCP refresh had errors (${status.toolsFailed})`
    : `Last refresh ${fmtRelative(status.refreshedAt)} from ${status.url || 'unknown'}`;
}

function renderMcpStatusBody(status) {
  const el = $('#mcp-status-body');
  if (!el) return;
  if (!status?.present) {
    el.innerHTML = '<em>No production-live pack on disk yet.</em>';
    return;
  }
  const rows = [
    ['refreshed',  status.refreshedAt ? `${fmtRelative(status.refreshedAt)} (${escapeHtml(status.refreshedAt)})` : '—'],
    ['mcp url',    status.url || '—'],
    ['tools called',  status.toolsCalled || '—'],
    ['tools failed',  status.toolsFailed || 'none'],
    ['services',   status.servicesDiscovered || '—'],
    ['baselines',  status.baselinesComputed || '0'],
    ['anomalies',  status.activeAnomalies   || '0'],
  ];
  el.innerHTML = '<dl>' + rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${k === 'refreshed' ? v : escapeHtml(v)}</dd>`).join('') + '</dl>';
}

function openMcpPanel() {
  const panel = $('#mcp-panel');
  if (!panel) return;
  panel.hidden = false;
  $('#mcp-btn').setAttribute('aria-expanded', 'true');
  const urlInput = $('#mcp-url');
  // pre-fill: saved value > server-known value > empty
  if (!urlInput.value) {
    const saved = (() => { try { return localStorage.getItem('mcpUrl'); } catch { return null; } })();
    const liveUrl = state.mcpStatus?.url || null;
    urlInput.value = saved || liveUrl || '';
  }
  urlInput.focus();
}
function closeMcpPanel() {
  const panel = $('#mcp-panel');
  if (panel) panel.hidden = true;
  const btn = $('#mcp-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

async function refreshLive() {
  const url = $('#mcp-url').value.trim();
  const auth = $('#mcp-auth').value;
  if (!url) {
    setRefreshStatus('mcp url required', 'error');
    return;
  }
  try { localStorage.setItem('mcpUrl', url); } catch (_) {}
  const btn = $('#mcp-refresh-btn');
  btn.disabled = true;
  $('#mcp-btn').dataset.mcpState = 'active';
  setRefreshStatus('contacting mcp…');
  try {
    const r = await fetch('/api/refresh-live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ mcpUrl: url, mcpAuth: auth || undefined }),
    });
    // Read as text first so we can surface a useful error if the server
    // returned HTML (typical when the dev server is stale and the route
    // doesn't exist yet — Express's default 404 is HTML).
    const ct = r.headers.get('content-type') || '';
    const raw = await r.text();
    let body;
    if (!ct.includes('application/json')) {
      const hint = r.status === 404
        ? 'server returned 404 — does it have /api/refresh-live? Restart `npm run dev`.'
        : `server returned ${r.status} ${ct || 'no content-type'}`;
      setRefreshStatus(`error: ${hint}`, 'error');
      $('#mcp-btn').dataset.mcpState = 'error';
      console.error('[refresh-live] non-JSON response:', raw.slice(0, 400));
      return;
    }
    try { body = JSON.parse(raw); }
    catch (e) {
      setRefreshStatus(`error: malformed JSON response (${e.message})`, 'error');
      $('#mcp-btn').dataset.mcpState = 'error';
      console.error('[refresh-live] bad JSON:', raw.slice(0, 400));
      return;
    }
    if (!body.ok) {
      setRefreshStatus(`error: ${body.error || 'unknown'}`, 'error');
      $('#mcp-btn').dataset.mcpState = 'error';
      return;
    }
    setRefreshStatus(`refreshed · ${fmtRelative(body.refreshedAt)}`, 'ok');
    // Replace live status from response annotations + refetch authoritative status
    state.mcpStatus = await loadLiveStatus();
    renderMcpBadge(state.mcpStatus);
    renderMcpStatusBody(state.mcpStatus);
    toast('Live pack refreshed');
    // If the user is currently viewing production-live, reload it so the
    // adapter projection updates.
    if (state.selectedPackId === 'production-live') {
      await refresh();
    } else {
      // Refresh the catalog so the production-live entry's ok-state updates.
      await loadCatalog();
      renderServiceSelect();
      renderPackSelect();
      renderPackBSelect();
    }
  } catch (e) {
    setRefreshStatus(`error: ${e.message}`, 'error');
    $('#mcp-btn').dataset.mcpState = 'error';
  } finally {
    btn.disabled = false;
  }
}

function setRefreshStatus(msg, kind = '') {
  const el = $('#mcp-refresh-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'mcp-refresh-status' + (kind ? ' is-' + kind : '');
}

// ============================================================
// Crawler panel — Path A of pack creation.
//
// Engineer drops a service repo (or picks files) → studio reads them
// in the browser → POSTs to /api/crawl → server returns a draft
// canonical pack + validation + conformance → we render the review.
// "Use this pack" hands the draft to the existing upload flow so it
// loads into the active session just like any other pack.
// ============================================================

const CRAWL_SCAN_EXT = /\.(ya?ml|json|cjs|mjs|js|jsx|ts|tsx|py|go|java|kt|rs|cs)$/i;
const CRAWL_IGNORE_DIRS = new Set([
  '.git', '.github', '.gitlab', '.circleci',     // CI and version control
  'node_modules', 'vendor', 'venv', '.venv',
  'dist', 'build', 'out', 'target', '.cache',
  '.next', '.nuxt', '.svelte-kit',
  '.terraform', '.serverless',
  '__pycache__', '.pytest_cache', '.mypy_cache',
  '.idea', '.vscode',
  'coverage',
]);
const CRAWL_MAX_FILE_BYTES = 5 * 1024 * 1024;
const CRAWL_PAYLOAD_SOFT_CAP = 15 * 1024 * 1024;  // leave 1 MB headroom under the 16 MB server cap

// Lazy-loaded reference to the shared crawler library (also used by
// the CLI and server). Importing it here lets us classify files in the
// browser BEFORE posting — keeping payloads small and the user honest
// about what's being sent.
let _crawlerLib = null;
async function getCrawlerLib() {
  if (!_crawlerLib) _crawlerLib = await import('/lib/crawler.mjs');
  return _crawlerLib;
}

const crawlState = {
  files: new Map(),       // relPath → string content (ALL staged files)
  classified: new Map(),  // relPath → kind (only files that match an artefact)
  skipped: [],            // [{relPath, reason}] for the "what was skipped" disclosure
  rootName: null,
  lastResult: null,
};

function setupCrawlPanel() {
  const btn = $('#crawl-btn');
  if (!btn) return;
  const panel = $('#crawl-panel');
  const dropzone = $('#crawl-dropzone');
  const pickFilesBtn = $('#crawl-pick-files-btn');
  const pickFolderBtn = $('#crawl-pick-folder-btn');
  const goBtn = $('#crawl-go-btn');
  const resetBtn = $('#crawl-reset-btn');
  const closeBtn = $('#crawl-panel-close');
  const resultCloseBtn = $('#crawl-result-close');
  const adoptBtn = $('#crawl-adopt-btn');
  const folderInput = $('#crawl-file-input');
  // We add a separate non-webkitdirectory input lazily for "pick files".
  let multiInput = null;

  btn.onclick = () => { panel.hidden = !panel.hidden; if (!panel.hidden) $('#crawl-name')?.focus(); };
  closeBtn.onclick = () => { panel.hidden = true; };
  resultCloseBtn.onclick = () => { $('#crawl-result').hidden = true; };
  resetBtn.onclick = () => { resetCrawlStaged(); };

  pickFolderBtn.onclick = () => folderInput.click();
  pickFilesBtn.onclick = () => {
    if (!multiInput) {
      multiInput = document.createElement('input');
      multiInput.type = 'file';
      multiInput.multiple = true;
      multiInput.accept = '.yaml,.yml,.json,.cjs,.mjs,.js,.jsx,.ts,.tsx,.py,.go,.java,.kt,.rs,.cs';
      multiInput.style.display = 'none';
      multiInput.addEventListener('change', () => {
        if (multiInput.files?.length) stageFileList(multiInput.files, null);
        multiInput.value = '';
      });
      document.body.appendChild(multiInput);
    }
    multiInput.click();
  };
  folderInput.onchange = () => {
    if (folderInput.files?.length) stageFileList(folderInput.files, null);
    folderInput.value = '';
  };

  // Drag-and-drop. We accept both files (FileList) and DataTransferItem
  // entries (so a directory drag works in Chromium/Edge/Firefox via
  // webkitGetAsEntry).
  ['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation();
    dropzone.classList.add('is-dragover');
  }));
  ['dragleave', 'dragend', 'drop'].forEach(ev => dropzone.addEventListener(ev, e => {
    if (ev === 'drop') return;
    if (e.target === dropzone || !dropzone.contains(e.target)) dropzone.classList.remove('is-dragover');
  }));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    dropzone.classList.remove('is-dragover');
    const dt = e.dataTransfer;
    const entries = dt?.items
      ? [...dt.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean)
      : [];
    if (entries.length) {
      for (const ent of entries) await readEntry(ent, '');
      finalizeStaging();
    } else if (dt?.files?.length) {
      stageFileList(dt.files, null);
    }
  });

  goBtn.onclick = () => doCrawl();
  adoptBtn.onclick = () => adoptCrawlResult();

  // GitHub URL crawl — same modal, different source. Enables the
  // "crawl github" button as soon as the URL field has text matching
  // the owner/repo or full-URL shape.
  const githubUrl = $('#crawl-github-url');
  const githubRef = $('#crawl-github-ref');
  const githubGo  = $('#crawl-github-go-btn');
  if (githubUrl && githubGo) {
    const updateGhEnabled = () => {
      const v = (githubUrl.value || '').trim();
      githubGo.disabled = !/^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/.test(v);
    };
    githubUrl.addEventListener('input', updateGhEnabled);
    githubUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !githubGo.disabled) { e.preventDefault(); doCrawlFromGithub(); }
    });
    githubGo.onclick = () => doCrawlFromGithub();
    updateGhEnabled();
  }
}

// Read a single FileSystemEntry recursively into the staged map.
async function readEntry(entry, prefix) {
  if (!entry) return;
  if (entry.isFile) {
    if (!CRAWL_SCAN_EXT.test(entry.name)) return;
    const file = await new Promise((res, rej) => entry.file(res, rej));
    if (file.size > CRAWL_MAX_FILE_BYTES) return;
    const rel = (prefix ? `${prefix}/` : '') + entry.name;
    const text = await file.text();
    crawlState.files.set(rel, text);
    if (!crawlState.rootName) crawlState.rootName = entry.fullPath?.split('/')[1] || null;
  } else if (entry.isDirectory) {
    if (CRAWL_IGNORE_DIRS.has(entry.name)) return;
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const ent of batch) await readEntry(ent, (prefix ? `${prefix}/` : '') + entry.name);
    } while (batch.length > 0);
  }
}

async function stageFileList(fileList, _rootHint) {
  for (const f of fileList) {
    if (!CRAWL_SCAN_EXT.test(f.name)) continue;
    if (f.size > CRAWL_MAX_FILE_BYTES) continue;
    // webkitRelativePath populated when picked via webkitdirectory.
    const rel = f.webkitRelativePath || f.name;
    crawlState.files.set(rel, await f.text());
    if (!crawlState.rootName && f.webkitRelativePath) {
      crawlState.rootName = f.webkitRelativePath.split('/')[0];
    }
  }
  finalizeStaging();
}

async function finalizeStaging() {
  const list = $('#crawl-staged-files');
  const go = $('#crawl-go-btn');
  const n = crawlState.files.size;
  if (n === 0) {
    list.innerHTML = '<span class="crawl-staged-empty">nothing staged yet</span>';
    go.disabled = true;
    return;
  }
  // Run the shared classifier in the browser. Same heuristic the server
  // uses — filename hints first, content sniff for ambiguous YAML.
  list.innerHTML = '<span class="crawl-staged-empty">classifying…</span>';
  crawlState.classified.clear();
  crawlState.skipped = [];
  let lib;
  try { lib = await getCrawlerLib(); }
  catch (e) {
    list.innerHTML = `<span class="crawl-staged-empty">classifier unavailable (${escapeHtml(e.message)}); sending raw set</span>`;
    // Fallback: treat every staged file as classified so behaviour
    // degrades gracefully.
    for (const k of crawlState.files.keys()) crawlState.classified.set(k, 'unknown');
    go.disabled = false;
    return;
  }
  let totalBytes = 0;
  for (const [path, content] of crawlState.files) {
    let kind = 'unknown';
    try { kind = lib.detectArtefactKind(path, content); }
    catch (_) { kind = 'unknown'; }
    if (kind === 'unknown') {
      crawlState.skipped.push({ relPath: path, reason: 'not an observability artefact' });
      continue;
    }
    crawlState.classified.set(path, kind);
    totalBytes += content.length;
  }
  if (totalBytes > CRAWL_PAYLOAD_SOFT_CAP) {
    list.innerHTML = `<span class="crawl-staged-empty">payload too large after classification (${(totalBytes/1024/1024).toFixed(1)} MB). Reduce scope — drop a subdirectory instead.</span>`;
    go.disabled = true;
    return;
  }
  renderStagedList(totalBytes);
  go.disabled = crawlState.classified.size === 0;
  if (crawlState.rootName && !$('#crawl-name').value) $('#crawl-name').value = crawlState.rootName;
}

function renderStagedList(totalBytes) {
  const list = $('#crawl-staged-files');
  const total = crawlState.files.size;
  const classified = crawlState.classified.size;
  const skipped = crawlState.skipped.length;

  // Group classified by kind for a count-by-kind line.
  const byKind = {};
  for (const k of crawlState.classified.values()) byKind[k] = (byKind[k] || 0) + 1;
  const kindCounts = Object.entries(byKind).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `<strong>${n}</strong>&nbsp;${escapeHtml(k)}`).join(' · ');

  const sample = [...crawlState.classified.keys()].slice(0, 8);
  const sampleHtml = sample.length
    ? sample.map(p => `<code>${escapeHtml(p)}</code>`).join('  ·  ')
    + (classified > sample.length ? ` <em>… and ${classified - sample.length} more</em>` : '')
    : '<em>nothing matched — drop a folder with docker-compose, Prometheus rules, Grafana dashboards, etc.</em>';

  list.innerHTML = `
    <div class="crawl-staged-counts">
      <strong>${classified}</strong> observability artefact${classified === 1 ? '' : 's'} found
      from <strong>${total}</strong> staged file${total === 1 ? '' : 's'}
      ${crawlState.rootName ? ` (root <code>${escapeHtml(crawlState.rootName)}/</code>)` : ''}.
      ${totalBytes ? `<span class="crawl-staged-bytes">${(totalBytes/1024).toFixed(1)} KB will be sent.</span>` : ''}
    </div>
    ${kindCounts ? `<div class="crawl-staged-kinds">${kindCounts}</div>` : ''}
    <div class="crawl-staged-sample">${sampleHtml}</div>
    ${skipped ? `
      <details class="crawl-staged-skipped">
        <summary>${skipped} file${skipped === 1 ? '' : 's'} skipped — not an observability artefact</summary>
        <div class="crawl-skipped-list">${
          crawlState.skipped.slice(0, 40)
            .map(s => `<code>${escapeHtml(s.relPath)}</code>`).join('  ·  ')
          + (skipped > 40 ? ` <em>… and ${skipped - 40} more</em>` : '')
        }</div>
      </details>` : ''}
  `;
}

function resetCrawlStaged() {
  crawlState.files.clear();
  crawlState.classified.clear();
  crawlState.skipped = [];
  crawlState.rootName = null;
  crawlState.lastResult = null;
  finalizeStaging();
  $('#crawl-result').hidden = true;
  $('#crawl-status').textContent = '';
}

async function doCrawl() {
  const statusEl = $('#crawl-status');
  const setStatus = (msg, kind) => {
    statusEl.textContent = msg;
    statusEl.className = 'mcp-refresh-status' + (kind ? ' is-' + kind : '');
  };
  if (crawlState.classified.size === 0) {
    if (crawlState.files.size > 0) setStatus('no observability artefacts in the staged set; nothing to scan', 'error');
    else setStatus('drop a folder or pick files first', 'error');
    return;
  }

  // Only send the classified subset. This is the key change — even when
  // the user drops a 3000-file repo, we transmit just the few
  // observability artefacts the crawler will actually use.
  const files = {};
  for (const k of crawlState.classified.keys()) {
    files[k] = crawlState.files.get(k);
  }

  const body = {
    files,
    repoName:   $('#crawl-name').value.trim() || crawlState.rootName || 'crawled-service',
    environment:$('#crawl-env').value.trim() || 'prod',
    diffScopeMode: $('#crawl-diff-scope')?.value || 'service',
  };
  const crit = $('#crawl-criticality').value;
  if (crit) body.criticality = crit;

  const goBtn = $('#crawl-go-btn');
  goBtn.disabled = true;
  setStatus(`scanning ${crawlState.classified.size} artefact${crawlState.classified.size === 1 ? '' : 's'}…`);

  try {
    const r = await fetch('/api/crawl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    const ct = r.headers.get('content-type') || '';
    const raw = await r.text();
    if (!ct.includes('application/json')) {
      setStatus(`server returned ${r.status} ${ct || 'no content-type'} — restart \`npm run dev\` if you just changed server code`, 'error');
      return;
    }
    const out = JSON.parse(raw);
    if (!out.ok) { setStatus(`error: ${out.error || 'unknown'}`, 'error'); return; }
    crawlState.lastResult = out;
    renderCrawlResult(out);
    setStatus(`done in ${out.tookMs}ms · ${out.summary.files.classified}/${out.summary.files.scanned} files classified`, 'ok');
  } catch (e) {
    setStatus(`error: ${e.message}`, 'error');
  } finally {
    goBtn.disabled = false;
  }
}

// GitHub URL variant of doCrawl(). Posts to /api/crawl-github which
// downloads the relevant files server-side and feeds them into the
// same crawler pipeline.
async function doCrawlFromGithub() {
  const ghStatus = $('#crawl-github-status');
  const setGhStatus = (msg, kind) => {
    if (!ghStatus) return;
    ghStatus.textContent = msg;
    ghStatus.className = 'crawl-github-status' + (kind ? ' is-' + kind : '');
  };
  const url = $('#crawl-github-url')?.value?.trim();
  if (!url) return setGhStatus('paste a github URL first', 'error');

  const ref = $('#crawl-github-ref')?.value?.trim() || undefined;
  const body = {
    url,
    ref,
    repoName:   $('#crawl-name').value.trim() || undefined,  // server falls back to owner/repo
    environment:$('#crawl-env').value.trim() || 'prod',
    diffScopeMode: $('#crawl-diff-scope')?.value || 'service',
    // Quick-start cases pass a friendly label via the global so the
    // picker doesn't read "moebiusx-krystalinex" but the human name.
    label:      window._observogramQuickLabel || undefined,
  };
  if (window._observogramQuickLabel) window._observogramQuickLabel = null;
  const crit = $('#crawl-criticality').value;
  if (crit) body.criticality = crit;

  const goBtn = $('#crawl-github-go-btn');
  goBtn.disabled = true;
  setGhStatus(`fetching ${url}…`);
  try {
    const r = await fetch('/api/crawl-github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    const ct = r.headers.get('content-type') || '';
    const raw = await r.text();
    if (!ct.includes('application/json')) {
      setGhStatus(`server returned ${r.status} ${ct || 'no content-type'} — restart \`npm run dev\` if you just changed server code`, 'error');
      return;
    }
    const out = JSON.parse(raw);
    if (!out.ok) {
      const hint = out.hint ? ` · ${out.hint}` : '';
      setGhStatus(`error: ${out.error || 'unknown'}${hint}`, 'error');
      return;
    }
    crawlState.lastResult = out;
    renderCrawlResult(out);
    if (out.canonical) {
      setGhStatus(`done in ${out.tookMs}ms · ${out.summary?.files?.classified ?? 0} files classified from ${out.summary?.repo}@${out.summary?.ref}`, 'ok');
    } else {
      setGhStatus(`done in ${out.tookMs}ms · no observability artefacts found in this repo`, 'warn');
    }
  } catch (e) {
    setGhStatus(`error: ${e.message}`, 'error');
  } finally {
    goBtn.disabled = false;
  }
}

function renderCrawlResult(out) {
  const resBox = $('#crawl-result');
  resBox.hidden = false;

  $('#crawl-result-sub').textContent =
    `${out.canonical.metadata.name} · ${out.canonical.metadata.bindings.criticality} (inferred ${out.summary.inferred.tier})`;
  $('#crawl-result-yaml').textContent = out.canonicalYaml;

  // Validation
  const vBox = $('#crawl-result-validation');
  vBox.innerHTML = `
    <h4>schema validation</h4>
    ${out.validation.ok
      ? `<div class="crawl-pill crawl-pill-ok">✓ valid v1.2</div>`
      : `<div class="crawl-pill crawl-pill-err">✗ ${out.validation.errors.length} schema error(s)</div>
         <ul class="crawl-result-errs">${out.validation.errors.slice(0, 8).map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`}
  `;

  // Discovery summary
  const s = out.summary.discovered;
  const f = out.summary.files || {};
  const env = out.summary.environment || {};
  const comparison = out.summary.comparison || {};
  $('#crawl-result-summary').innerHTML = `
    <h4>what we found</h4>
    <table class="crawl-summary-table">
      <tr><td>environment scope</td><td>${escapeHtml(env.profile || 'none')}${env.scoped ? ` · ${f.excludedByEnvironment || 0} excluded` : ''}</td></tr>
      <tr><td>live scope</td><td>${escapeHtml(comparison.diffScopeMode || 'service')}</td></tr>
      <tr><td>files used</td><td>${f.included ?? f.scanned ?? 0} / ${f.scanned ?? 0}</td></tr>
      <tr><td>backends</td><td>${s.backends}</td></tr>
      <tr><td>metric definitions</td><td>${s.metricDefinitions || 0}</td></tr>
      <tr><td>telemetry sources</td><td>${s.scrapeJobs || 0}</td></tr>
      <tr><td>recording rules</td><td>${s.recordingRules}</td></tr>
      <tr><td>burn-rate alerts</td><td>${s.burnRateAlerts}</td></tr>
      <tr><td>dashboards</td><td>${s.dashboards}</td></tr>
      <tr><td>alerting routes</td><td>${s.alertingRoutes}</td></tr>
      <tr><td>pipelines</td><td>${s.pipelines}</td></tr>
    </table>
    <div class="crawl-inferred">
      <em>inferred</em>: ${out.summary.inferred.slis} SLI(s) · ${out.summary.inferred.slos} SLO(s) · tier ${out.summary.inferred.tier}
    </div>
  `;

  // Warnings — these are the bits we stubbed.
  const w = out.summary.warnings || [];
  $('#crawl-result-warnings').innerHTML = w.length
    ? `<h4>what to refine</h4><ul class="crawl-warnings">${w.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`
    : `<h4>what to refine</h4><div class="crawl-pill crawl-pill-ok">nothing flagged — review the YAML and ship</div>`;

  // Evidence
  const ev = out.evidence || {};
  const evEntries = Object.entries(ev).slice(0, 12);
  $('#crawl-result-evidence').innerHTML = evEntries.length
    ? `<h4>evidence (top ${evEntries.length})</h4><ul class="crawl-evidence">${evEntries.map(([id, path]) => `<li><code>${escapeHtml(id)}</code> ← <code>${escapeHtml(path)}</code></li>`).join('')}</ul>`
    : '';

  // Download link
  const dl = $('#crawl-download-btn');
  const blob = new Blob([out.canonicalYaml], { type: 'application/x-yaml' });
  if (dl.href.startsWith('blob:')) URL.revokeObjectURL(dl.href);
  dl.href = URL.createObjectURL(blob);
  dl.download = `${out.canonical.metadata.name}.pack.yaml`;
}

// Shared adoption for the two pack-creation paths — Path A (repo scan)
// and Path B (live MCP draft). Routes the new pack into the canonical
// drift journey instead of blindly overwriting Pack A:
//
//   • repo scans prefer slot A ("declared"), live drafts prefer slot B
//     ("verified") — so "scan a repo, then scan the live deployment"
//     lands you straight in the Diagnose / drift compare view.
//   • whichever slot is empty gets filled; as soon as BOTH are present
//     we auto-switch to compare. With only one pack we stay in
//     single-pack Discover.
//   • re-running the same path while comparing replaces just that slot
//     (a fresh repo scan refreshes A and keeps the live B, and vice
//     versa) so the drift view stays put.
//
// kind ∈ {'repo','live'}. Returns true when it entered compare.
async function adoptValidatedPack(res, sourceLabel, kind) {
  state.pack = res.adapted;
  state.conformance = res.conformance;
  state.symbolTable = buildSymbolTable(res.adapted);
  state.uploadedSource = sourceLabel;
  state.activeCardKey = null;

  const newId = res.registered?.id;
  if (!newId) {
    // No server id (shouldn't normally happen) — render the adapted
    // pack inline as a single, unaddressable view.
    state.selectedPackId = null;
    state.mode = 'single';
    state.view = 'layers';
    state.activeLayer = 'L1';
    state.selectedService = normalizeServiceKey(state.pack?.meta?.service) || state.selectedService;
    applyModeChrome();
    renderServiceSelect();
    renderPackSelect();
    renderPackBSelect();
    renderEnvSelect();
    renderMeta();
    renderTabs();
    renderMainView();
    return false;
  }

  await loadCatalog();
  if (kind === 'repo') {
    state.selectedService = serviceKeyForPack(state.catalog.find(p => p.id === newId)) || state.selectedService;
  }

  const prevA = state.selectedPackId;
  const prevB = state.compareBId;
  const wasCompare = state.mode === 'compare' && prevA && prevB;

  let aId = null, bId = null;
  if (wasCompare && (newId === prevA || newId === prevB)) {
    // Re-adopted a pack already on screen — keep the existing pairing.
    aId = prevA; bId = prevB;
  } else if (wasCompare) {
    // Already comparing — replace the slot matching this path's kind,
    // keep the other half of the drift view intact.
    if (kind === 'repo') { aId = newId; bId = prevB; }
    else                 { aId = prevA; bId = newId; }
  } else if (prevA && state.mode !== 'home' && prevA !== newId) {
    // One pack already loaded — pair it with the new one. Repo → A,
    // live → B; the existing pack takes the other slot.
    if (kind === 'repo') { aId = newId; bId = prevA; }
    else                 { aId = prevA; bId = newId; }
  } else {
    // Empty start (or re-adopting the only pack) — single Discover.
    aId = newId; bId = null;
  }

  if (aId && bId && aId !== bId) {
    state.view = 'compare';
    enterCompareMode(aId, defaultEnvFor(aId), bId, defaultEnvFor(bId));
    return true;
  }
  state.view = 'layers';
  enterAnalyzeMode(aId, defaultEnvFor(aId));
  return false;
}

async function adoptCrawlResult() {
  const out = crawlState.lastResult;
  if (!out) return;
  // Reuse the upload flow: POST /api/validate → if ok, route the pack
  // into the drift journey (repo scan → Pack A). Same validation path
  // as drag-dropping a yaml file onto the studio shell.
  try {
    const res = await validateUploaded(out.canonicalYaml, 'application/x-yaml', state.selectedEnv);
    if (!res.ok) {
      toast(`Could not adopt — ${res.errors.length} validation error(s)`, 'error');
      return;
    }
    $('#crawl-panel').hidden = true;
    const compared = await adoptValidatedPack(res, `${out.canonical.metadata.name} (scanned draft)`, 'repo');
    toast(compared
      ? `Comparing ${out.canonical.metadata.name} against the live deployment`
      : `Loaded scanned draft for ${out.canonical.metadata.name}`);
  } catch (e) {
    toast(`Adopt failed: ${e.message}`, 'error');
  }
}

// ============================================================
// Draft-from-MCP panel — Path B of pack creation.
//
// Parallel to the crawler (Path A). The SRE enters their MCP URL,
// optionally an auth token, and a pack name; the server hits the
// MCP, builds a canonical pack from what the MCP can attest to, and
// returns it for review. Adoption round-trips through /api/validate
// like every other pack path.
// ============================================================

const draftMcpState = {
  lastResult: null,
};

// ============================================================
// Deploy modal — full per-artefact picker. Replaces the inline
// deploy panel that used to live below the compile output.
//
// Drives off /api/packs/:id/compile-catalog to enumerate every
// individually deployable artefact in the active pack, surfaces a
// type-filter row (Alert rule / Recording rule / Dashboard) +
// per-row checkboxes, and POSTs to /api/packs/:id/deploy-bulk
// with the selected items.
// ============================================================

const DEPLOY_PROFILES_KEY = 'deployProfiles.v1';

const deployModalState = {
  manifest: null,        // [{id, type, name, group, flavor, artifact, dashboardId, scope}]
  packId: null,
  selected: new Set(),
  presetIdentities: null,  // Set<string> from Remediate plan, or null
  inflight: false,
};

function setupDeployModal() {
  const modal = $('#deploy-modal');
  if (!modal) return;
  $('#deploy-modal-close').onclick   = () => closeDeployModal();
  $('#deploy-modal-cancel').onclick  = () => closeDeployModal();
  $('#deploy-modal-go').onclick      = () => doDeployBulk();

  $('#deploy-profile-save').onclick  = () => saveDeployProfile();
  $('#deploy-profile-delete').onclick = () => deleteDeployProfile();
  $('#deploy-target-profile').onchange = () => loadDeployProfile($('#deploy-target-profile').value);

  // Recompute the target summary line on any target field change.
  for (const id of ['deploy-target-profile','deploy-target-url','deploy-target-folder','deploy-target-product','deploy-target-version','deploy-target-mcp']) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input',  updateDeployTargetSummary);
    if (el) el.addEventListener('change', updateDeployTargetSummary);
  }

  // Pack picker rebuilds the manifest.
  $('#deploy-source-pack').onchange = () => loadDeployManifest($('#deploy-source-pack').value);

  // Type filter checkboxes hide rows.
  $('#deploy-type-filters').addEventListener('change', () => renderDeployManifestTable());

  // Manifest toolbar
  $('#deploy-manifest-toggle').onchange = (e) => bulkSelectVisibleManifest(e.target.checked);
  $('#deploy-manifest-all').onclick     = () => bulkSelectVisibleManifest(true);
  $('#deploy-manifest-none').onclick    = () => bulkSelectVisibleManifest(false);

  // Esc closes even when focus is inside a field. The modal itself is
  // focusable, but target fields usually own focus during deploy.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeDeployModal();
  });
}

export function openDeployModal({ packId, packLabel, presetIdentities } = {}) {
  const modal = $('#deploy-modal');
  if (!modal) return;
  // Optional preset: when the Remediate plan hands off a curated set, pre-
  // select only the matching manifest rows (by row.id). Cleared otherwise
  // so a direct open defaults to all-deployable.
  deployModalState.presetIdentities = (presetIdentities && presetIdentities.size) ? presetIdentities : null;
  if (!state.deployMatrix) loadDeployMatrix().then(() => populateDeployTargetSelects());
  else populateDeployTargetSelects();
  populateDeploySourcePackSelect(packId || state.selectedPackId);
  populateDeployProfileSelect();
  modal.hidden = false;
  modal.focus?.();
  $('#deploy-modal-status').textContent = '';
  $('#deploy-modal-result').hidden = true;
  const verifyHost = $('#deploy-modal-verify');
  if (verifyHost) { verifyHost.hidden = true; verifyHost.innerHTML = ''; }
  cancelDeployVerify();
  loadDeployManifest(packId || state.selectedPackId);
  updateDeployTargetSummary();
  loadDeployHistory(packId || state.selectedPackId);
}

// Deploy history — the audit trail for this pack (VALUE_BACKLOG 10C).
// Read-only context above the Go button: when this pack was last pushed,
// where, and whether it stuck. Failures here never block deploying.
async function loadDeployHistory(packId) {
  const host = $('#deploy-modal-history');
  if (!host) return;
  host.hidden = true;
  if (!packId) return;
  try {
    const { deploys } = await api(`/api/deploys?pack=${encodeURIComponent(packId)}&limit=5`);
    if (!deploys?.length) return;
    const rows = deploys.map(d => {
      const when = d.at ? new Date(d.at).toLocaleString() : '?';
      const ok = d.summary?.failed === 0;
      const verify = d.verify
        ? `<span class="deploy-hist-verify">verify: ${escapeHtml(d.verify.outcome || '?')}</span>`
        : '';
      const what = d.rollbackOf
        ? `↩ rollback of <code>${escapeHtml(d.rollbackOf)}</code>`
        : `${escapeHtml(d.target?.product || '?')}@${escapeHtml(d.target?.version || '?')}${d.dryRun ? ' · dry-run' : ''}`;
      // A rollback point exists when the pre-deploy snapshot captured state.
      const canRollback = !d.rollbackOf && !d.dryRun
        && ['captured', 'partial'].includes(d.snapshot?.status);
      const rbBtn = canRollback
        ? `<button type="button" class="ctrl-btn deploy-hist-rollback" data-deploy-id="${escapeHtml(d.deployId)}" title="Restore the pre-deploy snapshot through the same MCP write tools">↩ roll back</button>`
        : '';
      return `<tr class="${ok ? 'is-ok' : 'is-err'}">
        <td>${ok ? '✓' : '✗'}</td>
        <td>${escapeHtml(when)}</td>
        <td>${what}</td>
        <td>${d.summary?.ok ?? 0}/${d.summary?.total ?? 0} ok ${verify} ${rbBtn}</td>
      </tr>`;
    }).join('');
    host.innerHTML = `
      <h4 class="deploy-hist-title">Deploy history</h4>
      <table class="deploy-result-table">
        <thead><tr><th></th><th>When</th><th>Target</th><th>Result</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    host.querySelectorAll('.deploy-hist-rollback').forEach(btn => {
      btn.addEventListener('click', () => doRollback(btn.dataset.deployId, packId, btn));
    });
    host.hidden = false;
  } catch (_) { /* history is optional context — never block the modal */ }
}

// Roll a deploy back to its pre-deploy snapshot (10D). Reuses the MCP
// target fields already in the modal; the result lands in the audit log
// as its own record (rollbackOf) and the history refreshes to show it.
async function doRollback(deployId, packId, btn) {
  const url = $('#deploy-target-mcp')?.value.trim();
  const auth = $('#deploy-target-auth')?.value;
  if (!url) { toast('Enter the MCP URL in the target form first', 'error'); return; }
  if (!confirm(`Roll back ${deployId}?\n\nRestorable artefacts are re-upserted from the pre-deploy snapshot. Anything this deploy created is listed for manual removal.`)) return;
  btn.disabled = true;
  try {
    const r = await api(`/api/deploys/${encodeURIComponent(deployId)}/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders() },
      body: JSON.stringify({ mcpUrl: url, mcpAuth: auth || undefined }),
    });
    const manualNote = r.manual?.length ? ` · ${r.manual.length} manual step${r.manual.length === 1 ? '' : 's'}` : '';
    toast(r.ok
      ? `Rolled back: ${r.summary.ok}/${r.summary.total} restored${manualNote}`
      : `Rollback incomplete: ${r.summary.failed} failed${manualNote}`, r.ok ? '' : 'error');
    loadDeployHistory(packId);
  } catch (e) {
    toast(`Rollback failed: ${e.message}`, 'error');
    btn.disabled = false;
  }
}

function closeDeployModal() {
  const modal = $('#deploy-modal');
  if (modal) modal.hidden = true;
  cancelDeployVerify();   // closing the modal stops the verify polling cold
}

function populateDeployTargetSelects() {
  const matrix = state.deployMatrix || { products: ['grafana'], versions: { grafana: ['12', '13'] } };
  const prodSel = $('#deploy-target-product');
  prodSel.innerHTML = matrix.products.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
  prodSel.value = state.deployProduct || matrix.products[0];
  const verSel = $('#deploy-target-version');
  const versions = matrix.versions[prodSel.value] || ['12'];
  verSel.innerHTML = versions.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  verSel.value = state.deployVersion || versions[0];
}

function populateDeploySourcePackSelect(activeId) {
  const sel = $('#deploy-source-pack');
  sel.innerHTML = '';
  for (const p of (state.catalog || [])) {
    if (!p.ok) continue;
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.label} · v${p.version || '?'}`;
    sel.appendChild(opt);
  }
  sel.value = activeId || state.selectedPackId;
}

function updateDeployTargetSummary() {
  const prof = $('#deploy-target-profile').selectedOptions?.[0]?.textContent?.trim() || '(no profile)';
  const url  = $('#deploy-target-url').value.trim() || '—';
  const prod = $('#deploy-target-product').value || '—';
  const ver  = $('#deploy-target-version').value || '—';
  $('#deploy-target-summary').textContent = `Target: ${prof}  |  ${prod} ${ver}  |  ${url}`;
}

// ----- Profiles in localStorage -----

function loadDeployProfiles() {
  try { return JSON.parse(localStorage.getItem(DEPLOY_PROFILES_KEY) || '{}'); }
  catch { return {}; }
}
function saveDeployProfiles(profiles) {
  try { localStorage.setItem(DEPLOY_PROFILES_KEY, JSON.stringify(profiles)); } catch (_) {}
}
function populateDeployProfileSelect() {
  const sel = $('#deploy-target-profile');
  const profiles = loadDeployProfiles();
  sel.innerHTML = '<option value="">(no profile — fill manually)</option>'
    + Object.keys(profiles).sort().map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');
}
function loadDeployProfile(name) {
  if (!name) return;
  const p = loadDeployProfiles()[name];
  if (!p) return;
  $('#deploy-target-url').value     = p.targetUrl || '';
  $('#deploy-target-folder').value  = p.folder || '';
  $('#deploy-target-product').value = p.product || 'grafana';
  $('#deploy-target-version').value = p.version || '12';
  $('#deploy-target-mcp').value     = p.mcpUrl || '';
  updateDeployTargetSummary();
}
function saveDeployProfile() {
  const name = prompt('Profile name (e.g. "Prod Grafana"):', $('#deploy-target-profile').selectedOptions?.[0]?.value || '');
  if (!name) return;
  const profiles = loadDeployProfiles();
  profiles[name] = {
    targetUrl: $('#deploy-target-url').value.trim(),
    folder:    $('#deploy-target-folder').value.trim(),
    product:   $('#deploy-target-product').value,
    version:   $('#deploy-target-version').value,
    mcpUrl:    $('#deploy-target-mcp').value.trim(),
  };
  saveDeployProfiles(profiles);
  populateDeployProfileSelect();
  $('#deploy-target-profile').value = name;
  updateDeployTargetSummary();
  toast(`Saved deploy profile: ${name}`);
}
function deleteDeployProfile() {
  const name = $('#deploy-target-profile').value;
  if (!name) return;
  if (!confirm(`Delete deploy profile "${name}"?`)) return;
  const profiles = loadDeployProfiles();
  delete profiles[name];
  saveDeployProfiles(profiles);
  populateDeployProfileSelect();
  toast(`Deleted profile: ${name}`);
}

// ----- Manifest (per-artefact rows) -----

async function loadDeployManifest(packId) {
  deployModalState.packId = packId;
  deployModalState.selected = new Set();
  const tbody = $('#deploy-manifest-tbody');
  tbody.innerHTML = '<tr><td colspan="5" class="placeholder">Loading manifest…</td></tr>';
  try {
    const params = new URLSearchParams();
    if (state.selectedEnv) params.set('env', state.selectedEnv);
    const cat = await api(`/api/packs/${encodeURIComponent(packId)}/compile-catalog?${params}`);
    deployModalState.manifest = catalogToDeployManifest(cat);
    // Default-select: when a preset (from the Remediate plan) is present,
    // select only deployable rows whose id matches a preset identity; fall
    // back to all-deployable if nothing matched (safe — never deploys
    // something the user didn't intend, never silently empties the form).
    const preset = deployModalState.presetIdentities;
    let presetMatched = 0;
    for (const row of deployModalState.manifest) {
      if (!row.deployable) continue;
      if (preset) {
        if (preset.has(row.id)) { deployModalState.selected.add(row.key); presetMatched++; }
      } else {
        deployModalState.selected.add(row.key);
      }
    }
    if (preset && presetMatched === 0) {
      // No id overlap (keyspace mismatch) — fall back to all-deployable.
      for (const row of deployModalState.manifest) {
        if (row.deployable) deployModalState.selected.add(row.key);
      }
    }
    renderDeployManifestTable();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="error">Could not load manifest: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderDeployManifestTable() {
  const tbody = $('#deploy-manifest-tbody');
  const types = new Set([...document.querySelectorAll('#deploy-type-filters input:checked')].map(i => i.value));
  const rows = (deployModalState.manifest || []).filter(r => types.has(r.type));
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="placeholder">No artefacts of the selected types in this pack.</td></tr>';
    updateManifestCounter(0, 0);
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr class="${deployModalState.selected.has(r.key) ? 'is-checked' : ''}" data-key="${escapeHtml(r.key)}">
      <td class="deploy-col-check"><input type="checkbox" ${deployModalState.selected.has(r.key) ? 'checked' : ''}></td>
      <td><span class="type-pill type-pill-${escapeHtml(r.type)}">${escapeHtml(r.type === 'recording' ? 'Recording rule' : r.type === 'alert' ? 'Alert rule' : 'Dashboard')}</span></td>
      <td><code>${escapeHtml(r.id)}</code></td>
      <td>${escapeHtml(r.name)}</td>
      <td><span class="source-chip" data-source="${escapeHtml(r.source)}">${escapeHtml(r.source)}</span></td>
    </tr>
  `).join('');
  // Per-row toggle
  tbody.querySelectorAll('tr').forEach(tr => {
    const cb = tr.querySelector('input[type=checkbox]');
    cb.onchange = () => {
      const k = tr.dataset.key;
      if (cb.checked) deployModalState.selected.add(k);
      else deployModalState.selected.delete(k);
      tr.classList.toggle('is-checked', cb.checked);
      updateManifestCounter(rows.filter(r => deployModalState.selected.has(r.key)).length, rows.length);
    };
  });
  updateManifestCounter(rows.filter(r => deployModalState.selected.has(r.key)).length, rows.length);
}

function bulkSelectVisibleManifest(checked) {
  const types = new Set([...document.querySelectorAll('#deploy-type-filters input:checked')].map(i => i.value));
  for (const r of (deployModalState.manifest || [])) {
    if (!types.has(r.type)) continue;
    if (checked) deployModalState.selected.add(r.key);
    else deployModalState.selected.delete(r.key);
  }
  renderDeployManifestTable();
}

function updateManifestCounter(selected, total) {
  $('#deploy-manifest-counter').textContent = `${selected} of ${total} artefact${total === 1 ? '' : 's'} selected`;
  const goBtn = $('#deploy-modal-go');
  if (goBtn) goBtn.disabled = selected === 0;
  const toggle = $('#deploy-manifest-toggle');
  if (toggle) {
    toggle.checked = total > 0 && selected === total;
    toggle.indeterminate = selected > 0 && selected < total;
  }
}

async function doDeployBulk() {
  if (deployModalState.inflight) return;
  const url  = $('#deploy-target-mcp').value.trim();
  const auth = $('#deploy-target-auth').value;
  const folder = $('#deploy-target-folder').value.trim();
  const product = $('#deploy-target-product').value;
  const version = $('#deploy-target-version').value;
  const statusEl = $('#deploy-modal-status');
  const setStatus = (msg, kind) => {
    statusEl.textContent = msg;
    statusEl.className = 'mcp-refresh-status' + (kind ? ' is-' + kind : '');
  };
  if (!url) { setStatus('mcp url required', 'error'); return; }
  if (deployModalState.selected.size === 0) { setStatus('select at least one artefact', 'error'); return; }

  const items = [...deployModalState.selected].map(k => {
    const row = (deployModalState.manifest || []).find(r => r.key === k);
    return row && {
      group:       row.group,
      flavor:      row.flavor,
      artifact:    row.artifact,
      dashboardId: row.dashboardId,
      scope:       row.scope,
      // Carried for the post-deploy transition verification (and the audit
      // trail): the matcher keys on type + human identity.
      type:        row.type,
      id:          row.id,
    };
  }).filter(Boolean);

  deployModalState.inflight = true;
  const goBtn = $('#deploy-modal-go');
  goBtn.disabled = true;
  setStatus(`deploying ${items.length} artefact${items.length === 1 ? '' : 's'}…`);

  try {
    const qs = new URLSearchParams();
    if (state.selectedEnv) qs.set('env', state.selectedEnv);
    const path = `/api/packs/${encodeURIComponent(deployModalState.packId)}/deploy-bulk?${qs}`;
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        mcpUrl: url, mcpAuth: auth || undefined,
        targetProduct: product, targetVersion: version, targetFolder: folder || undefined,
        items,
      }),
    });
    const ct = r.headers.get('content-type') || '';
    const raw = await r.text();
    if (!ct.includes('application/json')) {
      setStatus(`server returned ${r.status} ${ct || 'no content-type'}`, 'error');
      return;
    }
    const body = JSON.parse(raw);
    if (body.summary) {
      const { ok, failed, total } = body.summary;
      setStatus(`${ok}/${total} deployed in ${body.tookMs}ms · ${failed} failed`, failed === 0 ? 'ok' : 'error');
    }
    renderDeployBulkResult(body);
    // The attempt is in the audit log now (ok or not) — refresh the trail.
    loadDeployHistory(deployModalState.packId);
    // Post-deploy re-verify (VALUE_BACKLOG 9): confirm the ok items through
    // the READ path. A write acknowledgement is not live verification.
    const okItems = (body.results || []).filter(r => r.ok && r.item).map(r => r.item);
    if (okItems.length && !body.dryRun) {
      startDeployVerify({
        deployId: body.deployId,
        packId: deployModalState.packId,
        env: state.selectedEnv || null,
        mcpUrl: url,
        mcpAuth: auth || undefined,
        items: okItems,
      });
    }
  } catch (e) {
    setStatus(`error: ${e.message}`, 'error');
  } finally {
    deployModalState.inflight = false;
    goBtn.disabled = false;
  }
}

// ---------- post-deploy re-verify (VALUE_BACKLOG item 9) ----------
//
// After a deploy reports ok, confirm each item through the READ path: re-
// draft the live pack from the same MCP, re-diff it against the deployed
// pack (same scope params the app's own diff uses), and classify every
// deployed item via studio/verify-deploy.mjs. Propagation lag is expected —
// a just-written rule needs an evaluation cycle before the read path sees
// it — so 'pending' polls with backoff and then settles HONESTLY rather
// than claiming success: deployed ≠ verified live.

const deployVerifyState = { running: false, cancelled: false };

function cancelDeployVerify() {
  deployVerifyState.cancelled = true;
  deployVerifyState.running = false;
}

const VERIFY_DELAYS_MS = [3000, 15000, 30000, 60000];

export async function startDeployVerify({ deployId, packId, env, mcpUrl, mcpAuth, items }) {
  const host = $('#deploy-modal-verify');
  if (!host || !items.length || !mcpUrl) return;
  if (deployVerifyState.running) cancelDeployVerify();
  deployVerifyState.cancelled = false;
  deployVerifyState.running = true;
  host.hidden = false;

  let last = null, packBId = null, refreshedAt = null, attempt = 0, lastError = null;

  for (; attempt < VERIFY_DELAYS_MS.length && !deployVerifyState.cancelled; ) {
    await verifyCountdown(host, VERIFY_DELAYS_MS[attempt], attempt, last);
    if (deployVerifyState.cancelled) return;
    attempt++;
    try {
      host.querySelector('.deploy-verify-status')?.replaceChildren(
        document.createTextNode(`check ${attempt}/${VERIFY_DELAYS_MS.length}: drafting live state…`));
      const out = await api('/api/draft-from-mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders() },
        body: JSON.stringify({ mcpUrl, mcpAuth }),
      });
      if (!out.ok) throw new Error(out.error || 'MCP draft failed');
      const reg = await validateUploaded(out.canonicalYaml, 'application/x-yaml');
      if (!reg.ok || !reg.registered?.id) throw new Error('live draft failed validation');
      packBId = reg.registered.id;
      refreshedAt = out.canonical?.metadata?.annotations?.['mcp.refreshedAt'] || null;
      const params = new URLSearchParams({ a: packId, b: packBId });
      if (env) params.set('aEnv', env);
      params.set('scopeMode', activeDiffScopeMode());
      if (state.selectedService) params.set('service', state.selectedService);
      const diff = await api(`/api/diff?${params}`);
      last = computeDeployTransitions(items, diff);
      lastError = null;
      renderDeployVerifyPanel(host, last, { attempt, packBId, final: false });
      // Only propagation lag warrants another poll. Verified is done;
      // drifted/partial won't fix itself by waiting.
      if (last.summary.outcome !== 'pending') break;
    } catch (e) {
      lastError = e;
      renderDeployVerifyPanel(host, last, { attempt, packBId, final: false, error: e.message });
    }
  }
  if (deployVerifyState.cancelled) return;
  deployVerifyState.running = false;

  renderDeployVerifyPanel(host, last, { attempt, packBId, final: true, error: lastError?.message });

  // Write the outcome back into the audit trail (best effort — the verify
  // verdict on screen never depends on this landing).
  if (last && deployId) {
    try {
      await fetch(`/api/deploys/${encodeURIComponent(deployId)}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          outcome: last.summary.outcome,
          summary: last.summary,
          transitions: last.transitions.map(t => ({ id: t.id, type: t.type, status: t.status, match: t.match })),
          packB: packBId,
          refreshedAt,
          attempts: attempt,
          alignment: typeof last.alignment === 'number' ? last.alignment : undefined,
        }),
      });
      loadDeployHistory(packId);
    } catch (_) {}
  }
}

// Render the countdown into the panel and resolve when it elapses; checks
// the cancel flag every tick so closing the modal stops the loop cold.
function verifyCountdown(host, ms, attempt, last) {
  return new Promise((resolve) => {
    let remaining = Math.round(ms / 1000);
    const headline = last
      ? `still pending — re-checking in <strong class="deploy-verify-count">${remaining}</strong>s`
      : `verifying through the live read path in <strong class="deploy-verify-count">${remaining}</strong>s`;
    if (!host.querySelector('.deploy-verify-status') || !last) {
      host.innerHTML = `
        <h4 class="deploy-hist-title">Post-deploy verification</h4>
        <p class="deploy-verify-status">${headline}</p>
        ${last ? '' : '<p class="deploy-verify-note">A write acknowledgement is not live verification — confirming each artefact via the MCP read path.</p>'}
      `;
    } else {
      host.querySelector('.deploy-verify-status').innerHTML = headline;
    }
    const tick = setInterval(() => {
      if (deployVerifyState.cancelled) { clearInterval(tick); resolve(); return; }
      remaining--;
      const el = host.querySelector('.deploy-verify-count');
      if (el) el.textContent = String(Math.max(0, remaining));
      if (remaining <= 0) { clearInterval(tick); resolve(); }
    }, 1000);
  });
}

const VERIFY_STATUS_META = {
  verified: { icon: '✓', label: 'verified live' },
  pending:  { icon: '⏳', label: 'deployed · not yet visible live' },
  drifted:  { icon: '≠', label: 'live contract differs' },
  shadow:   { icon: '◌', label: 'only on the live side' },
  unknown:  { icon: '?', label: 'no identity mapping' },
};

function renderDeployVerifyPanel(host, result, { attempt, packBId, final, error }) {
  if (!result) {
    host.innerHTML = `
      <h4 class="deploy-hist-title">Post-deploy verification</h4>
      <p class="deploy-verify-status is-error">could not verify: ${escapeHtml(error || 'unknown error')}${final ? '' : ' — will retry'}</p>
    `;
    return;
  }
  const s = result.summary;
  const headIcon = s.allVerified ? '✓' : (s.outcome === 'pending' ? '⏳' : '≠');
  const headline = s.allVerified
    ? `${s.verified}/${s.total} verified live`
    : `${s.verified}/${s.total} verified · ${s.pending} pending · ${s.drifted} drifted`;
  const align = typeof result.alignment === 'number' ? ` · alignment ${Math.round(result.alignment * 100)}%` : '';
  const rows = result.transitions.map(t => {
    const m = VERIFY_STATUS_META[t.status] || VERIFY_STATUS_META.unknown;
    return `<tr class="${t.status === 'verified' ? 'is-ok' : (t.status === 'pending' ? 'is-pending' : 'is-err')}">
      <td>${m.icon}</td>
      <td><code>${escapeHtml(t.id ?? '?')}</code></td>
      <td>${escapeHtml(t.type || '?')}</td>
      <td>${escapeHtml(m.label)}${t.match === 'fuzzy' ? ' <span class="deploy-verify-fuzzy">(SLI-base match)</span>' : ''}</td>
    </tr>`;
  }).join('');
  const finalNote = final
    ? (s.outcome === 'pending'
        ? `<p class="deploy-verify-note">Still not visible after ${attempt} checks — rules may need an evaluation cycle. Re-open this modal later or refresh live from the MCP panel.</p>`
        : '')
    : '';
  const adoptBtn = final && packBId
    ? `<button type="button" class="ctrl-btn" id="deploy-verify-adopt">Load post-deploy live state as Pack B</button>`
    : '';
  host.innerHTML = `
    <h4 class="deploy-hist-title">Post-deploy verification</h4>
    <p class="deploy-verify-status ${s.allVerified ? 'is-ok' : ''}">${headIcon} ${escapeHtml(headline)}${align}${final ? '' : ` · check ${attempt}/${VERIFY_DELAYS_MS.length}`}</p>
    ${error ? `<p class="deploy-verify-status is-error">last check failed: ${escapeHtml(error)}</p>` : ''}
    <table class="deploy-result-table"><tbody>${rows}</tbody></table>
    ${finalNote}
    ${adoptBtn}
  `;
  host.querySelector('#deploy-verify-adopt')?.addEventListener('click', () => {
    state.compareBId = packBId;
    state.compareBEnv = null;
    loadPackB().then(() => {
      refreshDiff();
      renderPackBSelect();
      renderEnvBSelect();
      renderTabs();
      renderMainView();
    });
    toast('Post-deploy live draft loaded as Pack B');
    closeDeployModal();
  });
}

function renderDeployBulkResult(body) {
  const el = $('#deploy-modal-result');
  el.hidden = false;
  const rows = (body.results || []).map(r => `
    <tr class="${r.ok ? 'is-ok' : 'is-err'}">
      <td>${r.ok ? '✓' : '✗'}</td>
      <td><code>${escapeHtml(r.item?.group || '')}/${escapeHtml(r.item?.artifact || '')}</code></td>
      <td>${r.ok ? `${r.operations || 1} op · ${r.bytes || 0} b · ${r.tool || ''}` : escapeHtml(r.error || 'failed')}</td>
      <td>${r.tookMs || 0} ms</td>
    </tr>
  `).join('');
  el.innerHTML = `
    <h4>Deploy result</h4>
    <table class="deploy-result-table">
      <thead><tr><th></th><th>Artefact</th><th>Detail</th><th>Took</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function setupDraftFromMcpPanel() {
  const btn = $('#draft-mcp-btn');
  if (!btn) return;
  const panel    = $('#draft-mcp-panel');
  const closeBtn = $('#draft-mcp-panel-close');
  const goBtn    = $('#draft-mcp-go-btn');
  const resetBtn = $('#draft-mcp-reset-btn');
  const resultCloseBtn = $('#draft-mcp-result-close');
  const adoptBtn = $('#draft-mcp-adopt-btn');

  btn.onclick = () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      // Pre-fill URL from the same localStorage slot the MCP refresh
      // panel uses, so the SRE doesn't have to retype.
      const urlInput = $('#draft-mcp-url');
      if (!urlInput.value) {
        try { urlInput.value = localStorage.getItem('mcpUrl') || ''; } catch (_) {}
      }
      urlInput.focus();
    }
  };
  closeBtn.onclick = () => { panel.hidden = true; };
  resultCloseBtn.onclick = () => { $('#draft-mcp-result').hidden = true; };
  resetBtn.onclick = () => {
    $('#draft-mcp-url').value = '';
    $('#draft-mcp-auth').value = '';
    $('#draft-mcp-name').value = '';
    $('#draft-mcp-result').hidden = true;
    $('#draft-mcp-status').textContent = '';
    draftMcpState.lastResult = null;
  };
  goBtn.onclick = () => doDraftFromMcp();
  adoptBtn.onclick = () => adoptDraftFromMcpResult();
}

async function doDraftFromMcp() {
  const url  = $('#draft-mcp-url').value.trim();
  const auth = $('#draft-mcp-auth').value;
  const name = $('#draft-mcp-name').value.trim();
  const statusEl = $('#draft-mcp-status');
  const setStatus = (msg, kind) => {
    statusEl.textContent = msg;
    statusEl.className = 'mcp-refresh-status' + (kind ? ' is-' + kind : '');
  };
  if (!url) { setStatus('mcp url required', 'error'); return; }
  try { localStorage.setItem('mcpUrl', url); } catch (_) {}

  const goBtn = $('#draft-mcp-go-btn');
  goBtn.disabled = true;
  setStatus('contacting mcp…');
  $('#draft-mcp-result').hidden = true;

  try {
    const r = await fetch('/api/draft-from-mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ mcpUrl: url, mcpAuth: auth || undefined, packName: name || undefined }),
    });
    const ct = r.headers.get('content-type') || '';
    const raw = await r.text();
    if (!ct.includes('application/json')) {
      setStatus(`server returned ${r.status} ${ct || 'no content-type'} — restart \`npm run dev\` if you just changed server code`, 'error');
      return;
    }
    const out = JSON.parse(raw);
    if (!out.ok) { setStatus(`error: ${out.error || 'unknown'}`, 'error'); return; }
    draftMcpState.lastResult = out;
    renderDraftMcpResult(out);
    setStatus(`drafted in ${out.tookMs}ms · ${out.summary.discovered.backends} backend(s) discovered`, 'ok');
  } catch (e) {
    setStatus(`error: ${e.message}`, 'error');
  } finally {
    goBtn.disabled = false;
  }
}

function renderDraftMcpResult(out) {
  const resBox = $('#draft-mcp-result');
  resBox.hidden = false;

  $('#draft-mcp-result-sub').textContent =
    `${out.canonical.metadata.name} · ${out.canonical.metadata.bindings?.criticality || 'tier-3'} · MCP @ ${out.summary.mcpUrl}`;
  $('#draft-mcp-result-yaml').textContent = out.canonicalYaml;

  // Validation
  const v = out.validation;
  $('#draft-mcp-result-validation').innerHTML = `
    <h4>schema validation</h4>
    ${v.ok
      ? `<div class="crawl-pill crawl-pill-ok">✓ valid v1.2</div>`
      : `<div class="crawl-pill crawl-pill-err">✗ ${v.errors.length} schema error(s)</div>
         <ul class="crawl-result-errs">${v.errors.slice(0, 8).map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`}
  `;

  // Discovery summary — show what the MCP actually attested, not just
  // raw tool counts. Rows are present only when the value is non-zero
  // or the probe was attempted (so the SRE sees what was asked vs found).
  const d = out.summary.discovered;
  const row = (label, value, dim = false) =>
    `<tr${dim ? ' class="is-dim"' : ''}><td>${escapeHtml(label)}</td><td>${typeof value === 'number' ? value : escapeHtml(String(value))}</td></tr>`;
  const probesA = new Set(d.probesAttempted || []);
  const probesS = new Set(d.probesSucceeded || []);
  const probesE = new Set(d.probesEmpty || []);
  const probesF = new Set(d.probesFailed || []);
  // Three distinct outcomes when a probe was attempted:
  //   data     — MCP responded with real content → show count
  //   empty    — MCP responded with empty payload → "0 (none configured)"
  //              honest zero, e.g. Krystaline has no Prometheus rules
  //   failed   — every candidate errored / 503'd → "— probe failed"
  //              transient or systemic, not the same as zero
  const probeRow = (label, key, value) => {
    if (!probesA.has(key)) return '';
    if (probesS.has(key))  return row(label, value || 0);
    if (probesE.has(key))  return row(label, `0 — none configured`, true);
    if (probesF.has(key))  return row(label, '— probe failed', true);
    // Older packs (pre-Phase 5) don't have probesEmpty/probesFailed
    // annotations; fall back to the original behaviour.
    return row(label, '— probed, none found', true);
  };
  // Rule-evidence fallback rows — only shown when the primary probe
  // came back empty (or failed) but the fallback found evidence. Reads
  // directly from the annotations the fetcher stamped.
  const ann = out.annotations || {};
  const alertsFiringNames = (ann['mcp.discovered.alerts_firing.names'] || '').split(',').filter(Boolean);
  const alertsFiringCount = Number(ann['mcp.discovered.alerts_firing.count'] || 0);
  const alertsTotalFirings = Number(ann['mcp.discovered.alerts_firing.total_firings'] || 0);
  const recordingFallbackCount = Number(ann['mcp.discovered.recording_rules_via_inventory.count'] || 0);
  const evidenceRow = (label, value, hint) =>
    `<tr class="is-evidence"><td>${escapeHtml(label)}<span class="row-evidence-hint">${escapeHtml(hint)}</span></td><td>${escapeHtml(String(value))}</td></tr>`;
  const alertEvidenceRow = alertsFiringCount > 0
    ? evidenceRow(
        'alerts firing',
        `${alertsFiringCount} alertname${alertsFiringCount === 1 ? '' : 's'} · ${alertsTotalFirings} total`,
        `via ALERTS metric — rule definitions hidden, firing state visible`,
      )
    : '';
  const recordingEvidenceRow = recordingFallbackCount > 0
    ? evidenceRow(
        'recording rule outputs',
        `${recordingFallbackCount}`,
        `via colon-pattern grep over metric inventory`,
      )
    : '';
  $('#draft-mcp-result-summary').innerHTML = `
    <h4>what the MCP attested</h4>
    <table class="crawl-summary-table">
      ${row('services', (d.servicesDiscovered || []).length)}
      ${row('backends', d.backends)}
      ${row('active anomalies', d.activeAnomalies)}
      ${probeRow('recording rules', 'recording_rules', d.recordingRules)}
      ${recordingEvidenceRow}
      ${probeRow('alert rules',     'alert_rules',     d.alertRules)}
      ${alertEvidenceRow}
      ${probeRow('dashboards',      'dashboards',      d.dashboards)}
      ${probeRow('scrape jobs',     'scrape_configs',  (d.scrapeJobs || []).length)}
      ${probeRow('metric names',    'metric_names',    d.metricNamesCount)}
    </table>
    ${alertsFiringCount > 0 || recordingFallbackCount > 0 ? `
      <div class="crawl-evidence-note">
        Rows in italic = fallback evidence. The standard rule endpoints came back empty,
        but Observogram found evidence in metric data: firing alerts via the
        <code>ALERTS</code> series, recording rules via metric names following the
        <code>&lt;ns&gt;:&lt;metric&gt;:&lt;op&gt;</code> convention.
      </div>
    ` : ''}
    <div class="crawl-inferred">
      <em>refreshed</em>: ${escapeHtml(out.summary.refreshedAt)}
    </div>
  `;

  // Warnings
  const w = out.summary.warnings || [];
  $('#draft-mcp-result-warnings').innerHTML = w.length
    ? `<h4>what to refine</h4><ul class="crawl-warnings">${w.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`
    : `<h4>what to refine</h4><div class="crawl-pill crawl-pill-ok">nothing flagged</div>`;

  // Tools chip
  const tools = d.toolsCalled || [];
  const fails = d.toolsFailed || [];
  $('#draft-mcp-result-tools').innerHTML = `
    <h4>mcp tools</h4>
    <div class="draft-mcp-tools">
      ${tools.map(t => `<code class="draft-mcp-tool ${fails.includes(t) ? 'is-failed' : 'is-ok'}">${escapeHtml(t)}</code>`).join(' ')}
      ${tools.length === 0 ? '<em class="crawl-staged-empty">no tools called</em>' : ''}
    </div>
  `;

  // Download link
  const dl = $('#draft-mcp-download-btn');
  const blob = new Blob([out.canonicalYaml], { type: 'application/x-yaml' });
  if (dl.href.startsWith('blob:')) URL.revokeObjectURL(dl.href);
  dl.href = URL.createObjectURL(blob);
  dl.download = `${out.canonical.metadata.name}.pack.yaml`;
}

async function adoptDraftFromMcpResult() {
  const out = draftMcpState.lastResult;
  if (!out) return;
  try {
    const res = await validateUploaded(out.canonicalYaml, 'application/x-yaml', state.selectedEnv);
    if (!res.ok) {
      toast(`Could not adopt — ${res.errors.length} validation error(s)`, 'error');
      return;
    }
    $('#draft-mcp-panel').hidden = true;
    // Live drafts are the "verified" half of the drift journey → Pack B.
    const compared = await adoptValidatedPack(res, `${out.canonical.metadata.name} (live draft)`, 'live');
    toast(compared
      ? `Comparing the repo scan against ${out.canonical.metadata.name} (live)`
      : `Loaded live draft for ${out.canonical.metadata.name}`);
  } catch (e) {
    toast(`Adopt failed: ${e.message}`, 'error');
  }
}

function setupMcpPanel() {
  const btn = $('#mcp-btn');
  if (!btn) return;
  btn.onclick = () => {
    const open = !$('#mcp-panel').hidden;
    if (open) closeMcpPanel(); else openMcpPanel();
  };
  $('#mcp-panel-close').onclick = closeMcpPanel;
  $('#mcp-refresh-btn').onclick = refreshLive;

  // Close on outside click
  document.addEventListener('click', (e) => {
    const panel = $('#mcp-panel');
    if (panel.hidden) return;
    if (e.target.closest('#mcp-panel') || e.target.closest('#mcp-btn')) return;
    closeMcpPanel();
  });
}

// ---------- theme ----------

// ---------- theme ----------
// ---------- about / version ----------
//
// /healthz carries { version, build, node } (server/version.mjs). Fetched
// once at boot, displayed in the Advanced menu foot, the header subtitle,
// and the About modal — "what exactly is running?" should never need a
// terminal.
let serverVersion = null;

async function loadVersion() {
  try {
    const r = await fetch('/healthz');
    if (r.ok) serverVersion = await r.json();
  } catch (_) { /* offline boot path already handles the error */ }
  const label = serverVersion ? `v${serverVersion.version} · build ${serverVersion.build}` : null;
  if (!label) return;
  const sub = document.getElementById('observa-about-sub');
  if (sub) sub.textContent = label;
  const hdrSub = document.querySelector('.hdr-sub');
  if (hdrSub && !hdrSub.textContent.includes('build')) hdrSub.textContent += ` · ${label}`;
  const brand = document.querySelector('.observa-brand');
  if (brand) brand.title = `Observogram ${label}`;
}

function openAboutModal() {
  document.getElementById('about-modal')?.remove();
  const v = serverVersion || {};
  const row = (k, val) => val ? `<div class="about-row"><span class="about-key">${k}</span><span class="about-val">${escapeHtml(String(val))}</span></div>` : '';
  const overlay = document.createElement('div');
  overlay.id = 'about-modal';
  overlay.className = 'about-overlay';
  overlay.innerHTML = `
    <div class="about-card" role="dialog" aria-modal="true" aria-label="About Observogram">
      <div class="about-brand">Observo<i>gram</i></div>
      <div class="about-tagline">the observability compiler</div>
      <div class="about-version">${escapeHtml(v.version ? `v${v.version}` : 'version unknown')}<span class="about-build">${escapeHtml(v.build ? ` · build ${v.build}` : '')}</span></div>
      <div class="about-rows">
        ${row('spec', v.specVersion ? `ObservabilityPack v${v.specVersion}` : null)}
        ${row('server', v.node ? `node ${v.node}` : null)}
        ${row('identity', state.identity?.mode || 'local (no sign-in)')}
        ${state.identity?.orgs?.length ? row('org', state.identity.orgs.map(o => o.name || o.id).join(' · ')) : ''}
      </div>
      <a class="about-link" href="https://github.com/MoebiusX/Observogram/blob/develop/docs/CHANGELOG.md" target="_blank" rel="noopener">changelog</a>
      <button type="button" class="about-close" aria-label="Close">esc</button>
    </div>
  `;
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.about-close').addEventListener('click', close);
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.appendChild(overlay);
  overlay.querySelector('.about-close').focus();
}

// /auth/me → state.identity. Local mode: the endpoint 404s and identity
// stays null — every downstream check degrades to today's behaviour.
async function loadIdentity() {
  try {
    const r = await fetch('/auth/me');
    if (!r.ok) return null;
    state.identity = await r.json();
    return state.identity;
  } catch (_) { return null; }
}

// Stage 2 tenancy: pick the active org from the session's memberships
// (/auth/me carries them when orgs.json is armed) — the persisted choice
// when still valid, the first membership otherwise. Outside tenancy mode
// this is a no-op and no org header is ever sent.
function resolveActiveOrg() {
  const orgs = state.identity?.orgs || [];
  if (!orgs.length) { setActiveOrg(null); return; }
  const saved = savedOrg();
  setActiveOrg((orgs.find(o => o.id === saved) || orgs[0]).id);
}

// Identity chip — only renders when the server runs in an identity
// posture and a session exists.
function setupIdentityChip() {
  const me = state.identity;
  if (!me?.authenticated) return;
  const anchor = $('#theme-toggle');
  if (!anchor || document.getElementById('hdr-user')) return;

  // Org indicator — a switcher when the user belongs to several orgs, a
  // static label for exactly one. Switching reloads: every view is a
  // projection of the active org's workspace, so a clean re-boot is the
  // honest refresh.
  const orgs = me.orgs || [];
  if (orgs.length && !document.getElementById('hdr-org')) {
    const wrap = document.createElement('span');
    wrap.id = 'hdr-org';
    wrap.className = 'hdr-org';
    if (orgs.length > 1) {
      wrap.innerHTML = `<span class="ctrl-key">ORG</span>`;
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', 'Active organisation');
      for (const o of orgs) {
        const opt = document.createElement('option');
        opt.value = o.id;
        opt.textContent = o.name || o.id;
        if (o.id === getActiveOrg()) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => {
        setActiveOrg(sel.value);
        window.location.reload();
      });
      wrap.appendChild(sel);
    } else {
      const active = orgs[0];
      wrap.innerHTML = `<span class="ctrl-key">ORG</span><span class="hdr-org-name">${escapeHtml(active.name || active.id)}</span>`;
      wrap.title = `organisation: ${active.id}`;
    }
    anchor.parentNode.insertBefore(wrap, anchor);
  }

  // Account menu: who you are, change password (stand-alone mode — OIDC
  // passwords belong to the IdP), sign out.
  const chip = document.createElement('span');
  chip.id = 'hdr-user';
  chip.className = 'hdr-user';
  // Deliberately NOT role="menu"/"menuitem": that ARIA contract demands
  // arrow-key navigation this popover doesn't implement. Plain links and
  // buttons are natively focusable and honest about what this is.
  chip.innerHTML = `
    <button type="button" class="ctrl-btn hdr-user-btn" aria-expanded="false"
            title="signed in as ${escapeHtml(me.email || me.sub)} (${escapeHtml(me.mode)})">⏣ ${escapeHtml(me.name || me.email || me.sub)} ▾</button>
    <div class="hdr-user-menu" hidden>
      <div class="hdr-user-menu-id">signed in as <strong>${escapeHtml(me.email || me.sub)}</strong><span class="hdr-user-menu-mode">${escapeHtml(me.mode)}</span></div>
      ${me.mode === 'local-users' ? '<a class="hdr-user-menu-item" href="/auth/change-password">change password…</a>' : ''}
      <button type="button" class="hdr-user-menu-item hdr-user-out">sign out</button>
    </div>
  `;
  const menuBtn = chip.querySelector('.hdr-user-btn');
  const menu = chip.querySelector('.hdr-user-menu');
  const setOpen = (open) => { menu.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); };
  menuBtn.addEventListener('click', () => setOpen(menu.hidden));
  document.addEventListener('click', (e) => { if (!chip.contains(e.target)) setOpen(false); });
  chip.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setOpen(false); menuBtn.focus(); } });
  chip.querySelector('.hdr-user-out').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST', headers: { ...authHeaders() } }).catch(() => {});
    window.location.assign('/auth/login');
  });
  anchor.parentNode.insertBefore(chip, anchor);
}

// The inline script in <head> already applied the persisted/system theme
// before paint. Here we wire the toggle and keep the studio in sync with
// the system preference if the user hasn't pinned one.

function setupTheme() {
  const btn = $('#theme-toggle');
  if (!btn) return;
  const apply = (t) => document.documentElement.setAttribute('data-theme', t);
  const current = () => document.documentElement.getAttribute('data-theme') || 'light';

  btn.onclick = () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    apply(next);
    try { localStorage.setItem('studioTheme', next); } catch (_) {}
    btn.setAttribute('title', `Switch to ${next === 'dark' ? 'light' : 'dark'} mode`);
  };
  btn.setAttribute('title', `Switch to ${current() === 'dark' ? 'light' : 'dark'} mode`);

  // Follow the system preference when the user hasn't explicitly chosen.
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', (e) => {
      const explicit = localStorage.getItem('studioTheme');
      if (explicit !== 'light' && explicit !== 'dark') {
        apply(e.matches ? 'dark' : 'light');
      }
    });
  } catch (_) {}
}

// ---------- helpers ----------

// Fill the studio-wide host seam (studio/host.mjs) — view modules reach the
// re-render / loader / modal entrypoints through it instead of importing
// app.mjs (docs/VENDORING.md, docs/UI_CONVENTIONS.md). Function declarations
// hoist, so binding them here (before boot) is safe.
initHost({ loadPackB, openDeployModal, renderMainView, renderTabs });

boot();
