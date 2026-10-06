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
import { state, $, $$, persistence, defaultBuildState, BUILD_PERSIST_FIELDS } from './state.mjs';
import {
  api, loadCatalog, loadTaxonomy, validateUploaded, registeredOrValidated, authHeaders, orgQuery, setActiveOrg, getActiveOrg, savedOrg, orgChipModel, deniedError, deployRefusal,
  setSignedInLogin, recallMcpUrl, rememberMcpUrl, forgetMcpUrls, signOutOthersText, recallMcpEndpoint, rememberMcpEndpoint,
  loadDeployProfiles, storeDeployProfile, removeDeployProfile,
} from './api.mjs';
import {
  effectiveFocus, focusedPackId, focusedEnv, focusedPack,
  focusedConformance, setFocusedConformance,
  focusedCompileCatalog, setFocusedCompileCatalog,
  focusedCompileContent, setFocusedCompileContent,
  focusedCompileGroup, setFocusedCompileGroup,
  focusedCompileFlavor, setFocusedCompileFlavor,
  focusedCompileArtifact, setFocusedCompileArtifact,
} from './focus.mjs';
import { escapeHtml, toast, fmtRelative, installDialogFocusTrap, downloadText } from './util.mjs';
import {
  personalName, announce, parseRecentServices,
} from './ux-kit.mjs';
import { renderSchemaView } from './schema-view.mjs';
import { renderConformanceView } from './conformance-view.mjs';
import { renderOtlpView } from './otlp-view.mjs';
import { renderReferencesView } from './references-view.mjs';
import { renderCompileView, loadDeployMatrix } from './compile-view.mjs';
import { openDrawer, closeDrawer } from './drawer.mjs';
import { renderDiscoverDashboard, renderLayersView, renderCard, cardKey } from './layers-view.mjs';
import { renderAtlasView } from './atlas-view.mjs';
import { renderNeuronView } from './neuron-view.mjs';
import { renderBenchmarkView, renderComparePicker, renderTraceabilityView, refreshDiff, loadDiff, LENS_PRODUCTS, activeDiffScopeMode } from './compare-view.mjs';
import { catalogToDeployManifest } from './artifact-model.mjs';
import { computeDeployTransitions } from './verify-deploy.mjs';
import { protoActive, renderProtoDiagnose, renderProtoRemediate } from './proto-view.mjs';
import { initHost } from './host.mjs';
import {
  recentServicesKey, buildNoOrgModel, buildServicesHomeModel, buildServicePageModel, accessModel, servicesStatusOf,
  packForService, newestPack, serviceChipModel, servicesSelectModel, discoverEmptyNote, buildPrefillFromService, verdictKey, buildHandoffPlan, buildDefineOriginNote, buildExitRefusal,
  buildServiceEditorModel, buildServicePatch, serviceSaveStatus,
} from './services-model.mjs';
import { loadOrgs, loadServices, loadService, patchService, verdictLoader, requestJson } from './services-api.mjs';
import { renderNoOrgHome, renderServicesHome, renderServicePage, renderServiceEditor, markUnavailable } from './services-view.mjs';
import {
  BUILT_SECTIONS, BUILT_EDITORS, settingsAccessModel, settingsSectionFor, buildSettingsFrameModel, settingsSectionHead, settingsAboveRank,
  buildEnvironmentsSectionModel, buildEndpointsSectionModel, buildMembersSectionModel, buildAuditSectionModel, auditQuery,
  buildSettingsEditorModel, buildEndpointPatch, buildEndpointCreate, endpointSaveStatus, endpointDeleteStatus,
  buildMemberAddBody, memberSaveStatus, orgRenameStatus, lastAdmin,
  buildEnvironmentPatch, buildEnvironmentCreate, environmentSaveStatus,
  mcpTargetModel, mcpTargetBody, profileEndpointNote, endpointDrift,
} from './settings-model.mjs';
import {
  loadMcpEndpoints, loadMembers, createEndpoint, patchEndpoint, deleteEndpoint, createEnvironment, patchEnvironment, deleteEnvironment,
  addMember, patchMember, removeMember, renameOrg, loadAudit,
} from './settings-api.mjs';
import { renderSettings, renderSettingsEditor, renderMcpTarget, readAuditDrafts } from './settings-view.mjs';
import { bindTaxonomy } from './taxonomy.mjs';
// The BUILD journey (docs/BUILD_JOURNEY.md, slice 2): models, loaders, steps.
import {
  BUILD_STEPS, TIERS as BUILD_TIERS, defineValid as buildDefineValid, buildStepReachability, enterStep as enterBuildStep, stepAfterInstantiate as buildStepAfterInstantiate, focusFallbackSelectors, instantiateBody as buildInstantiateBody,
  buildDefineModel, buildCompileModel, buildVerifyModel, buildDefinitionModel, buildSheetModel, buildClauseChecklist, buildStatusLine, sheetModeFor, addSliSelection, placeholdersRemaining, retargetSlis, retargetSlisForEntries, retargetOverrides,
  restoreBuildDraft as restoreBuildDraftModel, buildEditorModel, editorModeFor, editorDirtyAfterAnswer, BUILD_TABS, tabName,
} from './build-model.mjs';
import { fieldValueFor } from './build-copies-model.mjs';
import { renderBuildEditor } from './build-editor-view.mjs';
import {
  loadLibrary as loadBuildLibrary, libraryCache as buildLibraryCache, loadRequirements as loadBuildRequirements,
  requirementsCache as buildRequirementsCache, instantiate as instantiateBuild, compilePreview as compileBuildPreview,
  registerBuiltPack, loadTargets as loadBuildTargets,
} from './build-api.mjs';
import { renderBuildDefine } from './build-define-view.mjs';
import { renderBuildCompile } from './build-compile-view.mjs';
import { renderBuildVerify } from './build-verify-view.mjs';
import { renderBuildDefinition } from './build-definition-view.mjs';
import { renderBuildSheet } from './build-sheet-view.mjs';
import { revealTodo } from './build-atoms.mjs';
import { loadBuildInfo, loadHealth, buildLabelModel, renderVersionChrome } from './build-label.mjs';
import { loadBrand } from './brand.mjs';
import { loadVerdicts, emptyVerdicts } from './verdicts.mjs';

// The brand (studio/brand.mjs): kicked off here, at module top level, so the
// one fetch (/lib/brand.mjs, modulepreloaded by the shell) overlaps the
// module graph instead of following it; boot() awaits it first. Marked
// handled so a rejection waits for that await (under node — the graph
// test — the specifier cannot resolve).
const brandReady = loadBrand();
brandReady.catch(() => {});

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
  // The BUILD draft: inputs only (state.mjs BUILD_PERSIST_FIELDS); the
  // canonical is re-instantiated from them, never read back. A session
  // that was building resumes on its step whether or not a pack was open.
  if (saved.build && typeof saved.build === 'object') restoreBuildDraft(saved.build);
  // A Build or a workspace opened from a service page keeps its binding across a
  // reload (the exit bar back to the page, the bound environment option, the
  // empty Discover's sentence) — read before the build branch returns; the
  // service-page branch below sets both again from the record.
  if (Number.isInteger(saved.serviceId)) state.serviceId = saved.serviceId;
  if (typeof saved.serviceEnv === 'string') state.serviceEnv = saved.serviceEnv;
  if (saved.mode === 'build') {
    enterBuildMode(state.build.step);
    return true;
  }
  // The service page (STORE_PLAN §6, slice 6a): GET /api/services/:id again —
  // a record deleted meanwhile (404) drops the snapshot and lands on home.
  // The key is one org's, so an org mismatch can no longer happen here.
  if (saved.mode === 'service' && Number.isInteger(saved.serviceId)) {
    const ok = await enterServicePage(saved.serviceId, typeof saved.serviceEnv === 'string' ? saved.serviceEnv : null, { rehydrate: true });
    if (ok) return true;
    persistence.clear();
    return false;
  }
  // Settings (slice 6b): it opens in every posture — a section the rank
  // cannot read falls back to the first it can — so it always answers true.
  // The section is set before the first render (enterSettings does).
  if (saved.mode === 'settings') {
    return enterSettings(typeof saved.settingsSection === 'string' ? saved.settingsSection : null, { rehydrate: true });
  }
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
  // 'journeys' (the pre-Neuron Advanced item) is accepted and routed to
  // Neuron, which carries the journey cards among its panels.
  const PERMITTED_VIEWS = new Set(['layers', 'compare', 'compile', 'conformance', 'schema', 'otlp', 'traceability', 'atlas', 'references', 'neuron', 'journeys']);
  if (state.view && !PERMITTED_VIEWS.has(state.view)) {
    state.view = 'compare';
  }
  if (state.view === 'journeys') state.view = 'neuron';
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
  if (['list', 'tiles', 'cards', 'details'].includes(saved.compareDetail)) state.compareDetail = saved.compareDetail;
  if (['list', 'tiles', 'cards', 'details'].includes(saved.discoverDetail)) state.discoverDetail = saved.discoverDetail;

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

// The /conformance report carries onPlaceholder itself — worked out for this
// env overlay — whenever the pack carries library todos, and omits it when the
// server cannot say, so it survives reloads and env switches as is.
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
  // The reviewer's verdicts on it (GAP batch 2; none for a catalogue pack):
  // after the pack, never blocking it — a server that cannot answer leaves
  // the studio as it was.
  await loadVerdicts(id);
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

// The service rules — the key every service goes by, the names a pack
// spells, its primary, the live-aggregate test and the per-pack plan
// (`servicesForPack`) — live in tools/lib/service-keys.mjs, shared with
// the server so the rows it writes and the tiles drawn here can never name
// different services. Bound in boot() from `/lib/service-keys.mjs` (the
// studio loads tools/lib at call time, never statically: a static import
// would make the Node suites that import this module resolve `/lib/`).
// Only what the studio calls is bound: `primaryServiceName` is reached
// through `serviceKeyForPack` and `servicesForPack`.
let normalizeServiceKey;
let serviceNamesForPack;
let serviceKeyForPack;
let isLiveAggregatePack;
let servicesForPack;

// `ownOnly` (the home tiles): only the packs in this workspace's catalog —
// never the bundled reference examples, which are not the user's services
// and do not open from a tile — and not the service of whatever pack
// happens to be loaded.
function serviceCatalogue({ ownOnly = false } = {}) {
  const byKey = new Map();
  const counted = new Map();
  const add = (name, p) => {
    const key = normalizeServiceKey(name);
    if (!key) return;
    if (!byKey.has(key)) byKey.set(key, {
      key,
      label: String(name).trim(),
      packCount: 0,
      liveCount: 0,
      environments: [],
      tiers: [],
    });
    const item = byKey.get(key);
    if (p) {
      // A pack names its service more than once (bindings and services[]):
      // count it once per service.
      const seen = counted.get(key) || new Set();
      counted.set(key, seen);
      if (p.id != null && seen.has(p.id)) return;
      if (p.id != null) seen.add(p.id);
      if (isLiveAggregatePack(p)) item.liveCount += 1;
      else item.packCount += 1;
      // The home tiles tell services apart by environment and tier.
      for (const env of p.environments || []) if (!item.environments.includes(env)) item.environments.push(env);
      if (p.criticality && !item.tiers.includes(p.criticality)) item.tiers.push(p.criticality);
    }
  };
  const exampleIds = new Set((state._examplesCache || []).map(p => p?.id));
  const packs = ownOnly
    ? (state.catalog || []).filter(p => !exampleIds.has(p?.id))
    : [...(state.catalog || []), ...(state._examplesCache || [])];
  for (const p of packs) {
    if (!p?.ok) continue;
    // The per-pack rule (the primary unless the pack is an aggregate, then
    // its services[] members) is the module's: the same plan the server
    // links as rows.
    for (const s of servicesForPack(p)) add(s.name, p);
  }
  const current = state.pack?.meta?.service;
  if (current && !ownOnly) add(current);
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

// The header SERVICE selector reads the table (design §6.3): one option per
// record — sorted by name — then, apart after a disabled separator, the own
// derived services no record covers (never the examples' services, A-M5) and
// the open catalogue pack's own service as "(catalogue pack)". With the table
// unavailable, the list is today's own derived one. Choosing a record goes
// through the SAME resolver as the card → page → Discover path (A-M4); a
// record with no pack opens its page (D2); a derived-only key re-picks Pack A
// by the resolver's rule (the newest declared pack, else the newest aggregate).
function renderServiceSelect() {
  const sel = $('#service-select');
  if (!sel) return;
  ensureServiceFromPack();
  const currentA = state.catalog.find(p => p.id === state.selectedPackId);
  const current = state.selectedPackId
    ? (serviceKeyForPack(currentA) || normalizeServiceKey(state.pack?.meta?.service) || null)
    : null;
  const m = servicesSelectModel(Array.isArray(state.services) ? state.services : null,
    serviceCatalogue({ ownOnly: true }), state.selectedService, { current });
  sel.innerHTML = '';
  if (m.disabled) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— service —';
    sel.appendChild(opt);
    sel.disabled = true;
    updateObservaServiceChip();
    return;
  }
  sel.disabled = false;
  // A key nothing lists any more (a record deleted since the state was saved):
  // the first listed service, as today — the open pack's own key is always listed.
  if (!m.value) state.selectedService = m.options[0]?.value ?? m.extra[0]?.value ?? null;
  const addOption = (o) => {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.serviceId != null) opt.dataset.serviceId = String(o.serviceId);
    sel.appendChild(opt);
  };
  m.options.forEach(addOption);
  if (m.extra.length) {
    if (m.options.length) {
      const sep = document.createElement('option');
      sep.disabled = true;
      sep.value = '';
      sep.textContent = '— from packs only —';
      sel.appendChild(sep);
    }
    m.extra.forEach(addOption);
  }
  sel.value = state.selectedService || '';
  updateObservaServiceChip();
  sel.onchange = () => {
    const value = sel.value || null;
    const record = m.options.find(o => o.value === value && o.serviceId != null);
    if (record) {
      const service = findServiceRecord(record.serviceId);
      const { pack } = packForService(service, state.catalog, { isLiveAggregatePack });
      const currentB = [...(state.catalog || []), ...(state._examplesCache || [])].find(p => p.id === state.compareBId);
      if (state.compareBId && !packMatchesService(currentB, record.value, { side: 'b' })) clearPackBState();
      state.diff = null;
      if (!pack) { enterServicePage(record.serviceId, state.selectedEnv); return; }
      const view = ['layers', 'compare', 'compile'].includes(state.view) ? state.view : 'layers';
      openServiceIn(view, { serviceId: record.serviceId, env: state.selectedEnv });
      return;
    }
    state.selectedService = value;
    if (state.selectedPackId && !packMatchesService(currentA, state.selectedService, { side: 'a' })) {
      const matches = state.catalog.filter(p => p.ok && packMatchesService(p, state.selectedService, { side: 'a' }));
      const nextA = newestPack(matches, p => !isLiveAggregatePack(p)).pack;
      state.selectedPackId = nextA?.id || null;
      state.selectedEnv = state.selectedPackId ? defaultEnvFor(state.selectedPackId) : null;
      state.pack = null;
      state.conformance = null;
      state.symbolTable = null;
      emptyVerdicts();
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
  // A service with no pack here (a record opened from its page): the bar says
  // so instead of keeping the previous pack's text.
  if (!options.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '— no pack —';
    sel.appendChild(opt);
  }
  sel.disabled = !options.length;
  sel.value = state.selectedPackId || (options.find(p => p.ok)?.id ?? '');
  sel.onchange = () => {
    if (!sel.value) return;
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
  // An environment bound from a service record that the pack does not declare
  // (the row exists; the overlay is a no-op and the grade is the pack's base
  // grade): the select says so instead of showing another environment.
  if (state.selectedEnv && !envs.includes(state.selectedEnv)) {
    const opt = document.createElement('option');
    opt.value = state.selectedEnv; opt.textContent = `${state.selectedEnv} (service record — no overlay in the pack)`;
    sel.appendChild(opt);
  }
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
  // Keep the OBSERVA chrome in sync on every re-render. Views that switch
  // state.view through the host seam (appHost.renderTabs) get the whole
  // chrome, not just the tab highlight.
  applyModeChrome();
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
  // The audit's filters as typed but not applied survive the repaint.
  const auditDrafts = state.mode === 'settings' ? readAuditDrafts(view) : null;
  view.innerHTML = '';
  // Persistence: every mutation chain ends here, so this is the single
  // hook for the debounced write. Cheap when suspended (boot phase).
  persistence.schedule();
  // The record editors live in their own hosts on <body> (syncServiceEditor
  // and syncSettingsEditor draw or clear them).
  syncServiceEditor();
  syncSettingsEditor();
  if (state.mode === 'home') {
    if (state.homeVariant === 'gate') renderServiceGate();
    else renderHomeView();
    return;
  }
  // Settings (STORE_PLAN §6 item 3, slice 6b): the org's environments and MCP endpoints.
  if (state.mode === 'settings') { renderSettingsHost(view, auditDrafts); return; }
  // The service page (STORE_PLAN §6, slice 6a): one record, its environments as tabs.
  if (state.mode === 'service') { renderServicePageHost(view); return; }
  // The BUILD journey renders its own three steps (Define · Compile ·
  // Verify) under BUILD_TABS; nothing below applies until "Open in
  // Discover" hands the produced pack to the analysis journey. Its pop-up
  // editor lives outside this view (syncBuildEditor draws or clears it).
  if (state.mode === 'build') { renderBuildView(view); syncBuildEditor(); return; }
  syncBuildEditor();
  if (!state.pack) {
    // In the workspace but no pack yet. Discover ("what do we have?") is
    // where you LOAD or COMPILE a pack — so its empty state IS the three
    // load options, never the marketing hero. Diagnose/Remediate need a
    // pack first, so they point the user back to Discover.
    if (state.view === 'layers') { renderDiscoverEmpty(view); return; }
    // References (Advanced) is a catalogue browser — it renders without a
    // pack loaded; the per-reference benchmark action then needs Pack A.
    if (state.view === 'references') { renderReferencesView(view); return; }
    // Neuron (Advanced) reads the saved journeys and their run history from
    // the workspace — no pack needs to be loaded; only the capture bar
    // asks for an A/B pair.
    if (state.view === 'neuron' || state.view === 'journeys') { renderNeuronView(view); return; }
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
    case 'journeys':                                          // pre-Neuron alias
    case 'neuron':             renderNeuronView(view); return;
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
    state.conformance = withPlaceholderPasses(res);
    state.symbolTable = buildSymbolTable(res.adapted);
    await loadVerdicts(res.registered?.id);
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
      await refreshCatalogue();
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
      toast(`Loaded ${file.name} — previous (layered JSON) format upconverted to canonical v1.4: ${res.legacy.mapped} artefacts mapped, ${res.legacy.scaffolded} scaffolds`);
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
      if (action === 'build-library') {
        // No pack to upload yet: the BUILD journey makes one from the library.
        enterBuildMode('define');
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
    tagline: 'Layers, artefacts and evidence',
    accent: 'tab-blue',
  },
  {
    id: 'compare',
    n: '2',
    label: 'How reliable is this pack?',
    sub: 'Diagnose',
    techName: 'Comparison',
    tagline: 'Assessment and comparison',
    accent: 'tab-magenta',
  },
  {
    id: 'compile',
    n: '3',
    label: 'Resolve gaps',
    sub: 'Remediate',
    techName: 'ObsOps',
    tagline: 'Update, compile and deploy',
    accent: 'tab-emerald',
  },
];

// "Advanced / Alien Observability" — the deep, specialised tools that
// sit OFF the three-step workflow. A first-time user never needs these;
// an expert reaches for them. They live behind a single right-side
// chrome button (styled like the old action cluster) that opens a menu.
// Each routes to a view that already exists in the dispatcher.
const OBSERVA_ADV = [
  // Neuron first: the monitor-of-monitors surface (journeys, chains, causes,
  // stack posture, delivery, trends) — the Journeys item it replaces lives
  // on as a route alias.
  { id: 'neuron',       label: 'Neuron',       sub: 'observability control · journeys · chains · causes · posture · trends' },
  { id: 'references',   label: 'References',   sub: 'catalogue reference packs · benchmark vs best practice' },
  { id: 'conformance',  label: 'Conformance',  sub: 'maturity rubric · MUST/SHOULD per tier' },
  { id: 'schema',       label: 'Schema',       sub: 'canonical YAML + v1.4 validation' },
  { id: 'otlp',         label: 'OTLP Coverage', sub: 'receiver protocols · per-signal exporters' },
  { id: 'traceability', label: 'Traceability', sub: 'requirements · proof chain · repo vs live' },
  { id: 'atlas',        label: 'Atlas',        sub: 'visual atlases · strata · periodic · skyline' },
];
const OBSERVA_ADV_VIEWS = new Set(OBSERVA_ADV.map(a => a.id));
// The conformance report plus which clauses pass only on a placeholder, when
// the answer carries it (a library-built or uploaded pack's validation
// summary): Conformance then lists "Passes on placeholders" exactly instead of
// hedging. (GET /api/packs/:id/conformance carries the same list itself.)
function withPlaceholderPasses(res) {
  const onPlaceholder = res?.summary?.onPlaceholder;
  return res?.conformance && Array.isArray(onPlaceholder) ? { ...res.conformance, onPlaceholder } : res?.conformance;
}


// The BUILD journey's three cards (docs/BUILD_JOURNEY.md) live in build-model.mjs
// (BUILD_TABS, pure, tested): the same shape as OBSERVA_TABS and the same
// accents, rendered by the same header renderer whenever state.mode is 'build';
// re-exported here for the studio's public surface.
export { BUILD_TABS };

// Which tab list the header shows: the analysis journey unless we are building.
function activeTabSet() { return state.mode === 'build' ? 'build' : 'observa'; }
function tabListFor(set) { return set === 'build' ? BUILD_TABS : OBSERVA_TABS; }

// A tab's accessible name is its step word and tagline (tabName: "Define — Choose a service, tier, and starting point"), spelled
// once for the title and aria-label — the content alone read as one run of number, eyebrow, question and tagline.
function observaTabHtml(t) {
  return `
    <button type="button" role="tab" class="observa-tab ${t.accent}" data-view="${t.id}"
            aria-selected="false" aria-label="${escapeHtml(tabName(t))}" title="${escapeHtml(tabName(t))}">
      <span class="observa-tab-num">${t.n}</span>
      <span class="observa-tab-text">
        <span class="observa-tab-eyebrow">${escapeHtml(t.sub)}</span>
        <span class="observa-tab-title">${escapeHtml(t.label)}</span>
        <span class="observa-tab-tagline">${escapeHtml(t.tagline)}</span>
      </span>
    </button>`;
}

// (Re)render the header's tab cards for the active set. Idempotent per set:
// the buttons are rebuilt only when the set changes (analysis ↔ build), so
// the analysis journey's chrome is untouched while nobody is building.
function syncObservaTabs() {
  const nav = document.querySelector('.observa-tabs');
  if (!nav) return;
  const set = activeTabSet();
  if (nav.dataset.set === set) return;
  nav.dataset.set = set;
  nav.innerHTML = tabListFor(set).map(observaTabHtml).join('');
  for (const btn of nav.querySelectorAll('.observa-tab')) {
    btn.addEventListener('click', () => (set === 'build' ? goToBuildStep(btn.dataset.view) : routeTo(btn.dataset.view)));
  }
  // The brand tagline names the journey on screen.
  const steps = document.querySelectorAll('.observa-tagline-step');
  const words = tabListFor(set).map(t => t.sub);
  steps.forEach((el, i) => { if (words[i]) el.textContent = words[i]; });
  document.body.classList.toggle('chrome-build', set === 'build');
}

// Route a header tab (or an Advanced item) to the existing view dispatcher.
function routeTo(id) {
  if (!id) return;
  // Clicking any tab leaves the landing/reset hero (or the BUILD journey)
  // and enters the workspace. Without this the no-pack state stays
  // mode='home' and every tab would keep rendering the landing hero (the
  // bug behind "why is Discover like the landing hero page?"). The pack is
  // still null until the user loads one — Discover's empty state handles that.
  // A journey tab clicked on the service page opens the service's pack bound
  // to the page's environment (the one resolver, services-model.mjs
  // packForService) — never the empty workspace.
  if (state.mode === 'service' && (id === 'layers' || id === 'compare' || id === 'compile') && state.serviceId) {
    openServiceIn(id, { serviceId: state.serviceId, env: state.serviceEnv });
    return;
  }
  if (state.mode === 'home' || state.mode === 'build' || state.mode === 'service' || state.mode === 'settings') state.mode = 'single';
  state.view = id;
  state.activeCardKey = null;
  state.activeLayer = ({ compile: 'COMPILE', conformance: 'CONF', schema: 'CONF', atlas: 'ATLAS', layers: state.layerFilter !== 'all' ? state.layerFilter : 'L1' })[id] || 'L1';
  applyModeChrome();
  paintObservaActiveTab();
  renderTabs();
  renderMainView();
}

// The sticky strips below the context bar (.ux-section-nav, .diag-sticky,
// .ux-decision.is-sticky) pin at chrome + --ux-context-h. The bar wraps onto
// more rows on narrow screens and is hidden on home and in Build, so measure
// it; ux.css holds the single-row default for when this cannot run.
function syncContextBarHeight() {
  const bar = document.querySelector('header.hdr');
  if (!bar) return;
  const h = Math.ceil(bar.getBoundingClientRect().height);
  document.body.style.setProperty('--ux-context-h', `${h}px`);
  // The chrome above it too: its height follows the type and the stepper's
  // wrapping, and everything pinned below counts from its real bottom edge.
  const chrome = document.querySelector('.observa-hdr');
  if (chrome) document.body.style.setProperty('--observa-chrome-h', `${Math.ceil(chrome.getBoundingClientRect().height)}px`);
}
function trackContextBarHeight() {
  const bar = document.querySelector('header.hdr');
  if (!bar || typeof ResizeObserver !== 'function') return;
  const ro = new ResizeObserver(syncContextBarHeight);
  ro.observe(bar);
  const chrome = document.querySelector('.observa-hdr');
  if (chrome) ro.observe(chrome);
  syncContextBarHeight();
}

// The chrome strings come from the brand (studio/brand.mjs, state.brand.chrome)
// — never a literal here, so a rebadged server rebadges the header, and the
// default reads exactly what it always did. logo.svg is the one raw-HTML
// brand field; this innerHTML is the only place it lands.
function installObservaChrome(chrome) {
  if (document.querySelector('.observa-hdr')) return;
  document.body.classList.add('chrome-observa');

  const hdr = document.createElement('header');
  hdr.className = 'observa-hdr';
  hdr.innerHTML = `
    <div class="observa-hdr-inner">
      <a class="observa-brand" href="/" aria-label="${escapeHtml(chrome.homeAriaLabel)}">
        <span class="observa-logo" aria-hidden="true">
          ${chrome.logoHtml('observa-logo-img')}
        </span>
        <span class="observa-brand-text">
          <span class="observa-wordmark">${chrome.wordmarkHtml('strong', '', { upper: true })}</span>
          <span class="observa-tagline">
            <!-- Home names no journey: the stepper appears once one is chosen. -->
            <span class="observa-tagline-home">${escapeHtml(chrome.tagline)}</span>
            <span class="observa-tagline-step">Discover</span>
            <span class="observa-tagline-dot">·</span>
            <span class="observa-tagline-step">Diagnose</span>
            <span class="observa-tagline-dot">·</span>
            <span class="observa-tagline-step">Remediate</span>
          </span>
        </span>
      </a>

      <!-- The active org (Stage 2 tenancy) — same rule as the SERVICE
           chip: which workspace the studio is reading must never be a
           mystery. Becomes a switcher when the user has several orgs. -->
      <span class="observa-service observa-org" id="observa-org" hidden>
        <span class="observa-service-key">ORG</span>
        <span class="observa-service-name" id="observa-org-name"></span>
      </span>

      <!-- The active service — always visible once chosen (the gate or
           the header SERVICE selector set it). "The studio is configured
           for MY service" must never be a mystery. -->
      <span class="observa-service" id="observa-service" hidden>
        <span class="observa-service-key">SERVICE</span>
        <span class="observa-service-name" id="observa-service-name"></span>
      </span>

      <nav class="observa-tabs" role="tablist" aria-label="Primary"></nav>

      <div class="observa-actions" aria-label="Advanced tools and account">
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
            <div class="observa-adv-menu-head">Administration</div>
            <button type="button" class="observa-adv-item" role="menuitem" data-action="settings">
              <span class="observa-adv-item-label">Settings</span>
              <span class="observa-adv-item-sub">this organisation's environments and MCP endpoints</span>
            </button>
            <button type="button" class="observa-adv-item" role="menuitem" data-action="mcp">
              <span class="observa-adv-item-label">Live MCP connection</span>
              <span class="observa-adv-item-sub" id="observa-adv-mcp-sub">refresh production-live from an MCP server</span>
            </button>
            <button type="button" class="observa-adv-item" role="menuitem" data-action="api">
              <span class="observa-adv-item-label">Pack catalogue API</span>
              <span class="observa-adv-item-sub">the raw JSON the studio reads · opens a new tab</span>
            </button>
            <button type="button" class="observa-adv-item" role="menuitem" data-action="theme">
              <span class="observa-adv-item-label">Switch light / dark theme</span>
              <span class="observa-adv-item-sub">also in the context bar while a pack is open</span>
            </button>
            <button type="button" class="observa-adv-item" role="menuitem" data-action="reset">
              <span class="observa-adv-item-label">Reset the studio…</span>
              <span class="observa-adv-item-sub">drop uploaded packs and saved state · asks first</span>
            </button>
            <button type="button" class="observa-adv-item observa-adv-about" role="menuitem" data-action="about">
              <span class="observa-adv-item-label">${escapeHtml(chrome.aboutLabel)}</span>
              <span class="observa-adv-item-sub" id="observa-about-sub">version &amp; build</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.insertBefore(hdr, document.body.firstChild);

  // The tab cards: the analysis journey's three (or the BUILD journey's
  // three in build mode), one renderer — syncObservaTabs wires the clicks.
  syncObservaTabs();

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
    // The MCP badge left the header; its state travels with the menu item.
    const mcpSub = document.getElementById('observa-adv-mcp-sub');
    const mcpBtn = document.getElementById('mcp-btn');
    if (mcpSub && mcpBtn?.title) mcpSub.textContent = mcpBtn.title;
    advMenu.hidden = false;
    advToggle.setAttribute('aria-expanded', 'true');
    positionAdv();
    advItems()[0]?.focus();
  });
  window.addEventListener('resize', () => { if (advMenu && !advMenu.hidden) positionAdv(); });
  hdr.querySelectorAll('.observa-adv-item').forEach(item => {
    item.addEventListener('click', () => {
      closeAdv();
      const action = item.dataset.action;
      if (action === 'about') { openAboutModal(); return; }
      if (action === 'settings') { enterSettings(null); return; }
      // Admin tools proxy to the header's original controls. Deferred, so
      // this click's own document-level outside-click handlers (the MCP
      // panel closes on any click outside it) run before the panel opens.
      if (action === 'mcp')   { setTimeout(() => $('#mcp-btn')?.click(), 0); return; }
      if (action === 'reset') { setTimeout(() => $('#reset-btn')?.click(), 0); return; }
      if (action === 'theme') { $('#theme-toggle')?.click(); return; }
      if (action === 'api')   { window.open(`/api/packs${orgQuery()}`, '_blank', 'noopener'); return; }
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
  // Once the chrome is in the page: keep its height and the context bar's measured.
  trackContextBarHeight();
}

function paintObservaActiveTab() {
  syncObservaTabs();
  if (state.mode === 'build') {
    // BUILD: the current step is the active card; a step is reachable when
    // the previous step's inputs are valid, locked otherwise.
    const reach = buildStepReachability(state.build);
    for (const btn of document.querySelectorAll('.observa-tab')) {
      const id = btn.dataset.view;
      const isActive = id === state.build.step;
      btn.classList.toggle('is-active', isActive);
      btn.classList.toggle('is-locked', !reach[id]);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      btn.setAttribute('aria-disabled', reach[id] ? 'false' : 'true');
    }
    document.querySelector('.observa-adv-toggle')?.classList.remove('is-active');
    return;
  }
  const v = state.view || 'layers';
  const active = (v === 'benchmark' || v === 'compare-artefacts') ? 'compare' : v;
  const advActive = OBSERVA_ADV_VIEWS.has(v);
  // The landing/reset hero is NOT a tab — it's the pre-workspace start
  // screen. Clearing the active marker there is what keeps Discover from
  // "being" the landing hero: you only light a tab once you're working.
  const onLanding = state.mode === 'home' || state.mode === 'service' || state.mode === 'settings';
  for (const btn of document.querySelectorAll('.observa-tab')) {
    // A workflow tab is active only when we're NOT in an advanced view
    // and NOT on the landing screen.
    const isActive = !onLanding && !advActive && btn.dataset.view === active;
    btn.classList.toggle('is-active', isActive);
    btn.classList.remove('is-locked');
    btn.removeAttribute('aria-disabled');
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
  const advToggle = document.querySelector('.observa-adv-toggle');
  if (advToggle) advToggle.classList.toggle('is-active', advActive);
}

async function boot() {
  // The brand first (kicked off at module top level, see brandReady), then
  // the chrome — mounted before anything else so the user sees the demo
  // shape even while the catalog loads.
  state.brand = await brandReady;
  installObservaChrome(state.brand.chrome);
  // The shared service rules (tools/lib/service-keys.mjs), bound before the
  // first catalogue read — loaded at call time like every tools/lib module.
  ({ normalizeServiceKey, serviceNamesForPack, serviceKeyForPack, isLiveAggregatePack, servicesForPack }
    = await import('/lib/service-keys.mjs'));
  // Which build is this? Fire-and-forget: fills the footer span, the About
  // entry, the header subtitle and the brand tooltip. /api/version is
  // public, so it needs neither identity nor org — and never blocks boot.
  loadVersion();
  // Identity + active org BEFORE the first /api call — with tenancy on,
  // /api/packs answers from the active org's workspace, so the org
  // header has to be resolved before the catalog loads.
  await loadIdentity();
  resolveActiveOrg();
  // The persisted snapshot is this login's in this org (state.mjs): scoped
  // here, after the org is known and before the rehydrate reads it.
  persistence.scope(signedInLogin(), getActiveOrg());
  // The artefact taxonomy (tools/lib/artefact-classify.mjs), bound before
  // the first render with the server's override (GET /api/taxonomy, a
  // viewer route — hence after the identity): the Discover board groups
  // by it, the row kinds and the drawer read it for typed artefacts. An
  // answer that cannot be fetched or compiled binds the default families
  // and says so once; it never blocks the boot.
  await bindTaxonomyFromServer();
  // The deploy target profiles saved before slice 3 (one browser-wide key,
  // URLs as typed) become this user's, stripped, now — not at the first
  // deploy: no credential waits in localStorage until then. Not on a boot
  // /auth/me answered "no session": the login is not known yet and the
  // shell is about to redirect to sign-in — adopted now, the profiles
  // would sit under 'local', where the signed-in user never sees them.
  // (state.identity stays null in the open posture, which adopts here.)
  if (state.identity?.authenticated !== false) loadDeployProfiles().catch(() => {});
  syncApiLink();
  // The account menu before the first catalogue read: a signed-in user the
  // org middleware refuses (no membership) still has a way to sign out.
  setupIdentityChip();
  try { await loadCatalog(); }
  catch (e) {
    if (e.denied === 'org') {
      // Signed in, in no organisation (STORE_PLAN §6, slice 6a): the server's
      // sentence as is, under the chrome — not the API-unreachable screen.
      // GET /api/orgs is not attempted (it would refuse the same way). The
      // refusal is kept: Settings, which such a user cannot read, explains
      // with it instead of opening.
      state.noOrg = e;
      applyModeChrome();
      renderNoOrgHome($('#layer-view'), buildNoOrgModel({ identity: state.identity, error: e }), servicesHost);
      return;
    }
    document.body.innerHTML = `<pre class="json" style="margin:48px;max-width:800px">${escapeHtml(state.brand.chrome.apiUnreachable)}\n\n${escapeHtml(e.message)}\n\nMake sure the server is running: \`node server/index.mjs\` or \`npm run serve\`.</pre>`;
    return;
  }
  // The services axis (STORE_PLAN §6, slice 6a): the rank the guard applies
  // here (GET /api/orgs) and the services table (GET /api/services), read
  // once the catalogue answered — so a user in no org never reaches them.
  // Both viewer routes; a bundle's 501 leaves the derived tiles, silently.
  await Promise.all([refreshAccess(), refreshServices()]);

  setupUpload();
  setupTheme();
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
  navGeneration++;
  state.mode = 'home';
  state.pack = null;
  emptyVerdicts();
  state.packB = null;
  state.diff = null;
  state.compileCatalog = null;
  state.compileContent = null;
  // Going home is the user saying "start over" — clear the persisted
  // pack/compare-B IDs so the next reload doesn't re-enter analyze mode.
  state.selectedService = null;
  state.selectedPackId = null;
  state.selectedEnv = null;
  state.serviceId = null;
  state.serviceEnv = null;
  servicePageRecord = null;
  closeSettingsEditor({ focus: false });
  state.settingsFrom = null;
  state.settings = null;
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
  // The gate opens on service records in every posture (the registry writes
  // them whoever registered — a developer's `npm run dev` sees cards after
  // the first scan), and on derived services for a signed-in user where the
  // table is unavailable (a bundle, a failed read).
  state.homeVariant = ((state.services?.length > 0) || (state.identity?.authenticated && serviceCatalogue({ ownOnly: true }).length)) ? 'gate' : 'hero';
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

// ============================================================
// THE FIRST DECISION IS ABOUT THE PACK (docs/BUILD_JOURNEY.md "Where it
// starts"): a service may already exist without one — Build comes first in time,
// Check is the common case. Both landings — the
// signed-in service gate and the local hero — open with the same question,
// and both branches join at "Pack available in Discover".
// ============================================================
// The two journeys, equal-sized, under one question (the 2026-09 UX review,
// docs/UX_SCREEN_GRAMMAR.md). Check opens its next step in place — recent
// services, a search, the import / scan sources — so the service grid is no
// longer a second, competing way to start. Build enters DEFINE.
function homeChoiceHtml({ checkOpen }) {
  return `
    <div class="home-choice" role="group" aria-labelledby="home-title">
      <div class="home-choice-cards">
        <button type="button" class="home-choice-card is-check${checkOpen ? ' is-open' : ''}" id="home-choice-check"
                aria-expanded="${checkOpen ? 'true' : 'false'}" aria-controls="home-check">
          <span class="home-choice-key" aria-hidden="true">◎</span>
          <span class="home-choice-title">Check an existing service or pack</span>
          <span class="home-choice-sub">Inspect its artefacts, assess evidence, and resolve gaps.</span>
          <span class="home-choice-path">Discover / Diagnose / Remediate</span>
          <span class="home-choice-cta">Inspect a service</span>
        </button>
        <button type="button" class="home-choice-card is-build" id="home-choice-build">
          <span class="home-choice-key" aria-hidden="true">⬡</span>
          <span class="home-choice-title">Build a new pack</span>
          <span class="home-choice-sub">Define a service and generate a pack you can review.</span>
          <span class="home-choice-path">Define / Compile / Verify</span>
          <span class="home-choice-cta">Create a pack</span>
        </button>
      </div>
    </div>`;
}

// When each service was last opened here — the tiles' "last activity". The
// catalogue carries no timestamps, so this is this browser's own record,
// kept per org (services-model.mjs recentServicesKey): the services of one
// org are not another's recents. The unscoped pre-slice-6a key is adopted
// once into the default org's and never read again.
const LEGACY_RECENT_SERVICES_KEY = 'studioRecentServices';
function recentServices() {
  try {
    const legacy = localStorage.getItem(LEGACY_RECENT_SERVICES_KEY);
    if (legacy !== null) {
      localStorage.removeItem(LEGACY_RECENT_SERVICES_KEY);
      if (localStorage.getItem(recentServicesKey(null)) === null) localStorage.setItem(recentServicesKey(null), legacy);
    }
    return parseRecentServices(localStorage.getItem(recentServicesKey(getActiveOrg())));
  } catch { return parseRecentServices(null); }
}
function recordRecentService(key) {
  if (!key) return;
  try {
    const all = recentServices();
    all[key] = new Date().toISOString();
    localStorage.setItem(recentServicesKey(getActiveOrg()), JSON.stringify(all));
  } catch (_) {}
}
// Sign-out: the recents of every org go with the snapshots — a shared
// browser keeps no record of which services a user who left had opened.
function forgetRecentServices() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LEGACY_RECENT_SERVICES_KEY)) localStorage.removeItem(k);
    }
  } catch { /* storage unavailable */ }
}

// ---------- the services table, the rank, the catalogue refresh ----------

// GET /api/orgs → what this browser may do in the active org and the org's
// name (services-model.mjs accessModel). The call failing is not an error
// the home shows: the /auth/me memberships are the fallback, and a bundle's
// 501 is the static posture. Logs nothing (the bundle smoke fails on a
// console.error).
async function refreshAccess() {
  let orgs = null;
  let orgsError = null;
  try { orgs = await loadOrgs(); }
  catch (e) { orgsError = e; }
  state.access = accessModel({ orgs, identity: state.identity, activeOrg: getActiveOrg(), orgsError });
  state.orgName = state.access.orgName;
  // The org the server resolved — in the open and token postures no header
  // names one, and the answer's `active` is the only source.
  state.orgId = orgs?.active ?? getActiveOrg();
}

// GET /api/services → state.services, or null with the reason in
// state.servicesStatus (static · denied · error). Never throws, logs nothing.
async function refreshServices() {
  try {
    state.services = await loadServices();
    state.servicesStatus = { kind: 'ok', error: null };
  } catch (e) {
    state.services = null;
    state.servicesStatus = servicesStatusOf(e);
  }
}

// Every register path refreshes the catalogue; the services table follows
// it (a register writes service rows) and the verdict cache is dropped (a
// new primary pack changes what a card grades). loadCatalog()'s own failure
// still propagates as it did; the table's never does.
async function refreshCatalogue() {
  await loadCatalog();
  state.serviceVerdicts = {};
  await refreshServices();
}

// The home's model from the state (services-model.mjs buildServicesHomeModel):
// the table, the rank, the catalogue and the derived services as of now.
function homeServicesModel() {
  return buildServicesHomeModel({
    status: state.servicesStatus, services: state.services, catalog: state.catalog, examples: state._examplesCache || [],
    derived: serviceCatalogue({ ownOnly: true }), verdicts: state.serviceVerdicts, opened: recentServices(),
    access: state.access, orgName: state.orgName, isLiveAggregatePack,
  });
}

// The verdict per environment on the cards on screen: the current primary
// pack's conformance report at the environment's name, fetched lazily and
// pooled (four in flight), cached for the session in state.serviceVerdicts.
// One repaint of the services section per settled batch — and only while
// the home is still on screen (a settled report never repaints a page the
// user left). A failed report reads "Unavailable" with the parsed refusal.
const verdictPool = verdictLoader();
function loadHomeVerdicts(model) {
  const wanted = model.cards.flatMap(c => c.envs).filter(e => e.verdict.state === 'loading' && e.packId && e.key && !(e.key in state.serviceVerdicts));
  if (!wanted.length) return;
  Promise.allSettled(wanted.map(e => verdictPool.load(e.packId, e.name)
    .then(report => { state.serviceVerdicts[e.key] = report; }, err => { state.serviceVerdicts[e.key] = { error: err?.message || 'no answer' }; })))
    .then(() => { if (state.mode === 'home') repaintHomeServices(); });
}

// Repaint the services section in place (not the whole home: the import
// sources below it keep what was typed), keeping the search as typed and
// the focus where it was.
function repaintHomeServices() {
  const section = $('#home-services');
  if (!section) return;
  const search = section.querySelector('#home-service-search');
  const q = search?.value ?? '';
  const focused = search && document.activeElement === search;
  const model = homeServicesModel();
  renderServicesHome(section, model, servicesHost);
  const again = section.querySelector('#home-service-search');
  if (again && q) { again.value = q; again.dispatchEvent(new Event('input')); }
  if (focused) again?.focus({ preventScroll: true });
  loadHomeVerdicts(model);
}

// A refused affordance explains itself when activated: the reason the rank
// cannot use it, as the server's effective role words it.
function explainUnavailable(reason) {
  const text = reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : 'Not available for your role here.';
  toast(text);
  announce(text);
}

// ---------- the service page (STORE_PLAN §6, slice 6a, design §5) ----------

// The record the page shows, as GET /api/services/:id answered it (the table's
// row is replaced by it too). Not persisted: a reload reads it again.
let servicePageRecord = null;
// The next render of the page moves the focus to its heading (entering it).
let servicePageFocusNext = false;
// Bumped by every mode transition: a GET /api/services/:id that answers after
// the user went elsewhere (home, a pack, Build) must not paint the page over it.
let navGeneration = 0;

function findServiceRecord(id) {
  if (servicePageRecord && servicePageRecord.id === id) return servicePageRecord;
  return (state.services || []).find(s => s.id === id) || null;
}

// A record as the server just answered it (GET /api/services/:id, a PATCH's
// view) replaces the table's row and becomes the page's.
function adoptServiceRecord(service) {
  if (Array.isArray(state.services)) {
    const i = state.services.findIndex(s => s.id === service.id);
    if (i >= 0) state.services[i] = service; else state.services.push(service);
  }
  servicePageRecord = service;
}

// Enter the page: GET /api/services/:id, then mode 'service' with the record
// id and the selected environment set BEFORE the render (the render persists
// them — a reload lands here again). The service counts as opened (the home's
// recents) only once the read succeeded. A refusal (404 `no service <id>`,
// a 403) is the server's sentence in a toast; a rehydrate answers false
// instead so the boot falls back to home, and `onRefused` (Build's exit)
// takes the sentence in place of the toast so the caller can name its own
// way out. The selected tab's verdict is always read anew here (a tier
// change since the home's cache must show).
async function enterServicePage(id, env = null, { rehydrate = false, onRefused = null } = {}) {
  const nav = ++navGeneration;
  const refused = (why) => { if (rehydrate) return false; if (onRefused) onRefused(why); else toast(why, 'error'); return false; };
  let service;
  try { service = await loadService(id); }
  catch (e) { return refused(e.message || `Could not read service ${id}`); }
  if (!service) return refused(`${id}: no service answered`);
  if (nav !== navGeneration) return false;   // the user went elsewhere meanwhile
  adoptServiceRecord(service);
  recordRecentService(service.slug);
  const names = (service.environments || []).map(e => e.name);
  // On the page the service is the axis, not a pack: Pack A is let go (an
  // action re-resolves it through packForService; Build's exit and a reload
  // come back here, not to a pack). Pack B, a comparison's other side, stays.
  state.selectedPackId = null;
  state.selectedEnv = null;
  state.pack = null;
  state.conformance = null;
  state.symbolTable = null;
  emptyVerdicts();
  state.mode = 'service';
  state.serviceId = service.id;
  state.serviceEnv = names.includes(env) ? env : (names[0] ?? null);
  state.selectedService = service.slug;
  state.activeCardKey = null;
  if (state.serviceEnv) {
    const { pack, how } = packForService(service, state.catalog, { isLiveAggregatePack });
    if (pack && how === 'primary') delete state.serviceVerdicts[verdictKey(pack.id, state.serviceEnv)];
  }
  servicePageFocusNext = true;
  applyModeChrome();
  paintObservaActiveTab();
  renderTabs();
  renderMainView();
  return true;
}

function servicePageModel(service) {
  return buildServicePageModel({
    service, envName: state.serviceEnv, verdicts: state.serviceVerdicts, catalog: state.catalog,
    access: state.access, orgName: state.orgName, isLiveAggregatePack,
  });
}

// renderMainView's branch for mode 'service': the page from the record, the
// focus on its heading when just entered, the selected tab's verdict read
// lazily through the pool — repainting only while this page is still on screen.
function renderServicePageHost(view) {
  const service = findServiceRecord(state.serviceId);
  if (!service) { goHome(); return; }
  const model = servicePageModel(service);
  renderServicePage(view, model, servicesHost);
  if (servicePageFocusNext) {
    servicePageFocusNext = false;
    view.querySelector('.svc-page-name')?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }
  const v = model.panel.verdict;
  const env = model.panel.env;
  if (v && v.state === 'loading' && v.fetch && model.panel.pack && env) {
    const key = v.key;
    verdictPool.load(model.panel.pack.id, env.name)
      .then(report => { state.serviceVerdicts[key] = report; }, err => { state.serviceVerdicts[key] = { error: err?.message || 'no answer' }; })
      .then(() => {
        if (state.mode !== 'service' || state.serviceId !== service.id || state.serviceEnv !== env.name) return;   // the user left
        repaintServicePage();
        const fresh = servicePageModel(findServiceRecord(service.id) || service).panel.verdict;
        if (fresh) announce(`${env.name}: ${fresh.text}`);
      });
  }
}

// Repaint the page keeping the focus where it is (a verdict settled, a tab
// selected by keyboard): the heading just entered, a tab, an action, a row.
function repaintServicePage() {
  const active = document.activeElement;
  const focusedTab = active?.closest?.('.svc-tabs') ? active.dataset.env : null;
  const focusedId = !focusedTab && active?.id && active.closest?.('.svc-page') ? active.id : null;
  renderMainView();
  if (focusedTab) document.querySelector(`.svc-tab[data-env="${CSS.escape(focusedTab)}"]`)?.focus({ preventScroll: true });
  else if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
}

// The tab: the environment NAME selected on the page; its verdict is read if
// the cache has none for it (the render above issues the read).
function selectServiceEnv(name) {
  if (state.mode !== 'service' || !name) return;
  const service = findServiceRecord(state.serviceId);
  if (!service || !(service.environments || []).some(e => e.name === name)) return;
  state.serviceEnv = name;
  repaintServicePage();
}

// Discover · Diagnose · Remediate bound to the service and the environment
// (design §5.4–5.5): the page decides the pack (the one resolver,
// packForService) and the environment; the user never picks a file. Without
// a pack the workspace opens empty, and Discover's empty state says, for the
// rank that reads it, how one is registered.
function openServiceIn(view, { serviceId, env = null } = {}) {
  const service = findServiceRecord(serviceId);
  if (!service) { toast(`Service ${serviceId} is not in the table here — reload the page.`, 'error'); return; }
  const names = (service.environments || []).map(e => e.name);
  const envName = names.includes(env) ? env : (names[0] ?? null);
  state.serviceId = service.id;
  state.serviceEnv = envName;
  const { pack } = packForService(service, state.catalog, { isLiveAggregatePack });
  state.view = view;
  state.activeCardKey = null;
  if (pack) {
    enterAnalyzeMode(pack.id, envName || defaultEnvFor(pack.id));
    state.selectedService = service.slug;
    state.activeLayer = ({ compile: 'COMPILE', compare: 'COMPARE' })[view] || 'L1';
    paintObservaActiveTab();
    renderTabs();
    return;
  }
  state.mode = 'single';
  state.selectedService = service.slug;
  state.selectedPackId = null;
  state.selectedEnv = envName;
  state.pack = null;
  state.conformance = null;
  state.symbolTable = null;
  emptyVerdicts();
  state.activeLayer = ({ compile: 'COMPILE', compare: 'COMPARE' })[view] || 'L1';
  applyModeChrome();
  // The context bar is redrawn for the empty workspace: the service listed
  // and selected, "— no pack —", no environment, the meta strip blank.
  renderServiceSelect();
  renderPackSelect();
  renderPackBSelect();
  renderEnvSelect();
  renderMeta();
  paintObservaActiveTab();
  renderTabs();
  renderMainView();
}

// Build from the page (design §6.4): DEFINE prefilled from the record — name,
// owners, tier, the tab's environment, and the ORIGIN id the hand-off may
// write — only when the draft is empty; a draft in progress is kept and said so.
function openBuild({ serviceId, env = null } = {}) {
  const service = findServiceRecord(serviceId);
  if (!service) { toast(`Service ${serviceId} is not in the table here — reload the page.`, 'error'); return; }
  if (state.access?.canWrite === false) { explainUnavailable(state.access.reason); return; }
  state.serviceId = service.id;
  state.serviceEnv = env ?? state.serviceEnv;
  const plan = buildPrefillFromService(state.build, service, env);
  if (plan.apply) Object.assign(state.build, plan.patch);
  else if (plan.note) toast(plan.note);
  enterBuildMode('define');
}

// A pack opens as Pack A at the given environment (else the pack's first): a
// row under "Packs linked" on the page (the binding kept — an older primary or
// a member pack is one click away but never the default), or a catalogue pack
// (an example, a file-backed entry) from the home — an example lives only in
// its cache, so it is promoted into the catalogue first.
function openPack(id, env = null) {
  if (!id) return;
  if (!(state.catalog || []).find(p => p.id === id)) {
    const ex = (state._examplesCache || []).find(p => p.id === id);
    if (ex) (state.catalog = state.catalog || []).push(ex);
  }
  state.view = 'layers';
  enterAnalyzeMode(id, env || defaultEnvFor(id));
}

// ---------- the record editor (design §6.5) ----------

// The pop-up over the page's record: UI state of the page, never persisted
// (a reload lands on the page, closed). It is drawn into its own host on
// <body>, outside #layer-view, so the page behind it repaints (a verdict
// settles, a save lands) without the dialog losing the focus or what was
// typed — renderServiceEditor repaints the status alone for the same record.
let serviceEditor = null;   // { serviceId, draft, status } | null

function serviceEditorHost() {
  let el = document.getElementById('svc-editor-host');
  if (!el) { el = document.createElement('div'); el.id = 'svc-editor-host'; document.body.appendChild(el); }
  return el;
}

// Draw the editor over the page's record, or clear it: leaving the page (any
// mode change, another record) closes it.
function syncServiceEditor() {
  const el = document.getElementById('svc-editor-host');
  const service = serviceEditor ? findServiceRecord(serviceEditor.serviceId) : null;
  if (state.mode !== 'service' || !service || state.serviceId !== service.id) {
    serviceEditor = null;
    if (el && el.innerHTML) el.innerHTML = '';
    return;
  }
  renderServiceEditor(serviceEditorHost(), buildServiceEditorModel(service, { draft: serviceEditor.draft, status: serviceEditor.status }), servicesHost);
}

// Edit (the page's button): the rank that may PATCH gets the dialog with the
// focus in its first field; another rank is told why (the button is not
// drawn for it, but the access can downgrade while the page is open).
function openServiceEditor(serviceId) {
  if (state.mode !== 'service' || !findServiceRecord(serviceId)) return;
  if (state.access?.canWrite === false) { explainUnavailable(state.access.reason); return; }
  serviceEditor = { serviceId, draft: null, status: null };
  syncServiceEditor();
  document.getElementById('svc-edit-name')?.focus({ preventScroll: true });
}

// Close (the scrim, esc, Close, Escape): the focus returns to the Edit button.
function closeServiceEditor() {
  if (!serviceEditor) return;
  serviceEditor = null;
  const el = document.getElementById('svc-editor-host');
  if (el) el.innerHTML = '';
  document.getElementById('svc-edit')?.focus({ preventScroll: true });
}

// Save: the draft diffed against the record (services-model.mjs
// buildServicePatch — only the fields that differ, parsed; never the slug);
// nothing differing → "Nothing changed." without a call; else PATCH
// /api/services/:id (CSRF and org headers through requestJson). A refusal
// is the server's sentence in the status line (`400: a tier is …`; a 401/403
// auth/role also downgrades the rank the affordances draw from). On success
// the record is read anew (GET /api/services/:id — the PATCH's view stands if
// that fails), the cached verdicts of its packs are dropped (the tier grades
// them, A-M3), the page repaints — which re-reads the selected tab's verdict —
// the header SERVICE selector follows a rename, and the status names what
// the server says changed. Returns { ok, service, changed } or null.
async function saveServiceRecord(serviceId, draft) {
  const current = findServiceRecord(serviceId);
  if (!serviceEditor || serviceEditor.serviceId !== serviceId || !current) return null;
  if (serviceEditor.status?.kind === 'pending') return null;   // one PATCH at a time: a second Save while it runs is ignored
  serviceEditor.draft = draft;
  const patch = buildServicePatch(current, draft);
  if (!Object.keys(patch).length) {
    serviceEditor.status = serviceSaveStatus([]);
    syncServiceEditor();
    return { ok: true, service: current, changed: [] };
  }
  serviceEditor.status = { kind: 'pending', text: 'Saving…' };
  syncServiceEditor();
  let res;
  try { res = await patchService(serviceId, patch); }
  catch (e) {
    if (e.denied === 'auth' || e.denied === 'role') state.access = { ...(state.access || {}), canWrite: false, reason: e.message };
    if (!serviceEditor || serviceEditor.serviceId !== serviceId) return null;
    serviceEditor.status = { kind: 'error', text: e.message || 'no answer' };
    if (state.mode === 'service' && state.serviceId === serviceId) repaintServicePage(); else syncServiceEditor();
    return null;
  }
  let service = res.service || current;
  try { service = (await loadService(serviceId)) || service; } catch { /* the PATCH's own view of the record stands */ }
  adoptServiceRecord(service);
  forgetServiceVerdicts(current);
  state.selectedService = service.slug;
  if (res.changed.includes('name')) renderServiceSelect();
  const status = serviceSaveStatus(res.changed);
  if (serviceEditor && serviceEditor.serviceId === serviceId) { serviceEditor.status = status; serviceEditor.draft = null; }
  if (state.mode === 'service' && state.serviceId === serviceId) repaintServicePage(); else syncServiceEditor();
  announce(status.text);
  return { ok: true, service, changed: res.changed };
}

// The host the services renderers get (docs/UI_CONVENTIONS.md §3): the two
// stable hooks plus the axis's actions under `services`. Sign-out is the
// account menu's handler, proxied — one place knows the IdP logout rules.
const servicesActions = {
  openService: (id, env = null) => { enterServicePage(id, typeof env === 'string' ? env : null); },
  openDerived: (key) => enterServiceWorkspace(key),
  selectEnv: selectServiceEnv,
  openIn: openServiceIn,
  openBuild,
  openPack,
  home: () => goHome(),
  retry: async () => { await refreshServices(); if (state.mode === 'home') repaintHomeServices(); },
  explain: explainUnavailable,
  openEditor: openServiceEditor,
  closeEditor: closeServiceEditor,
  saveService: saveServiceRecord,
  // The environment editor is Settings' (one editor, two doors — design §5.2):
  // the page opens it over its record without changing mode.
  editEnvironment: (envId) => openSettingsEditor('environment', envId),
  addEnvironment: (serviceId) => openSettingsEditor('environment', null, serviceId),
  signOut: () => document.querySelector('.hdr-user-out')?.click(),
};
const servicesHost = { renderMainView, renderTabs, services: servicesActions };

// ---------- Settings (STORE_PLAN §6 item 3, slice 6b; design §3–§5) ----------

// Bumped by every Settings read: an answer that settles after the user left
// the section (or Settings) never repaints it.
let settingsGeneration = 0;
// The next render moves the focus to the page's h1 (entering Settings).
let settingsFocusNext = false;

// The frame's answers for one entry: the probe (token and open postures),
// a downgrade a read met, each section's status line, the endpoints read's
// refusal. Never persisted; a new entry starts afresh.
function freshSettings() {
  return { probe: null, denied: null, deniedAdmin: null, status: {}, members: null, org: null, membersError: null, endpointsError: null, audit: null };
}

// What this reader may do in Settings (settings-model.mjs settingsAccessModel)
// — 6a's access, /auth/me's owner bit, the probe's answer — and, once a read
// was refused by the gate (the session ended, the membership went), nothing
// at all, with the server's sentence as every reason (the downgrade, §4).
function settingsAccess() {
  const access = settingsAccessModel({ access: state.access, identity: state.identity, probe: state.settings?.probe ?? null, chromeName: state.brand?.chrome?.name });
  const denied = state.settings?.denied;
  const deniedAdmin = state.settings?.deniedAdmin;
  if (!denied && deniedAdmin) {
    // An admin write refused by the role (demoted meanwhile): the admin's
    // controls and the owner's go, with the server's sentence; the rest stays.
    return {
      ...access,
      can: { ...access.can, admin: false, own: false, createOrg: false },
      why: { ...access.why, admin: deniedAdmin, own: deniedAdmin, createOrg: deniedAdmin },
    };
  }
  if (!denied) return access;
  return {
    ...access,
    can: { operate: false, admin: false, own: false, createOrg: false },
    why: { operate: denied, admin: denied, own: denied, closed: access.why.closed, createOrg: denied },
  };
}

// The cached answers the access may no longer read are dropped, and the
// frame moves to the first section it may (C-6).
function forgetSettingsAbove(access) {
  state.settings = settingsAboveRank(state.settings, access, { orgId: state.orgId });
  state.settingsSection = settingsSectionFor(access, state.settingsSection, BUILT_SECTIONS);
}

// Enter Settings (Advanced → Settings, the account menu, a reload in it):
// where Back returns is kept unless rehydrating (a reload's Back is home);
// the section asked for, else the last one, else the first the rank reads —
// set before the first render, which persists it. Then the frame's reads.
// A signed-in user in no organisation is told why instead (the boot's
// refusal). Answers true when Settings is on screen.
function enterSettings(section = null, { rehydrate = false } = {}) {
  if (state.noOrg) { explainUnavailable(state.noOrg.message); return false; }
  navGeneration++;
  if (rehydrate) state.settingsFrom = null;
  else if (state.mode !== 'settings') {
    state.settingsFrom = state.mode === 'service' && Number.isInteger(state.serviceId)
      ? { mode: 'service', serviceId: state.serviceId, env: state.serviceEnv }
      : { mode: 'home' };
  }
  state.mode = 'settings';
  state.settings = freshSettings();
  state.settingsSection = settingsSectionFor(settingsAccess(), section ?? state.settingsSection, BUILT_SECTIONS);
  if (state.settingsSection) state.settings.status[state.settingsSection] = { kind: 'loading', text: settingsSectionHead(state.settingsSection).loading };
  settingsFocusNext = true;
  applyModeChrome();
  paintObservaActiveTab();
  renderTabs();
  renderMainView();
  loadSettingsFrame();
  return true;
}

// Back: the service page Settings was entered from, else home. A record
// gone meanwhile lands home with the server's sentence.
function leaveSettings() {
  const from = state.settingsFrom;
  closeSettingsEditor({ focus: false });
  state.settingsFrom = null;
  state.settings = null;
  if (from?.mode === 'service' && Number.isInteger(from.serviceId)) {
    enterServicePage(from.serviceId, from.env ?? null, { onRefused: (why) => { goHome(); toast(why, 'error'); } });
    return;
  }
  goHome();
}

// The frame's first read, by posture (design §3.4): the bundle's — GET
// /api/mcp-endpoints, whose 501 sentence is the banner; the token and open
// postures' probe — GET /api/org/members, whose refusal is the banner (the
// token posture's way in, a server bound without sign-in) and whose 200 is
// the members list; none in the identity posture (GET /api/orgs and
// /auth/me already said). Then the section on screen. Logs nothing.
async function loadSettingsFrame() {
  const settings = state.settings;
  const here = () => state.mode === 'settings' && state.settings === settings;
  const posture = state.access?.posture;
  if (posture === 'static') {
    try { state.mcpEndpoints = await loadMcpEndpoints(); }
    catch (e) { if (here()) settings.probe = e; }
    if (here()) repaintSettings();
    return;
  }
  if (posture === 'token' || posture === 'open') {
    try {
      const body = await loadMembers();
      if (here()) Object.assign(settings, { probe: { ok: true }, members: body.members, org: body.org });
    } catch (e) {
      if (here()) settings.probe = e;
    }
    if (!here()) return;
    state.settingsSection = settingsSectionFor(settingsAccess(), state.settingsSection, BUILT_SECTIONS);
  }
  if (here() && state.settingsSection) loadSettingsSection(state.settingsSection);
}

// One section's reads (design §7.5): the environments and the MCP endpoints
// both read the services table (the environments are its rows; the
// endpoints name the environments bound to them) and the org's endpoints
// (shared with the pickers — state.mcpEndpoints). The status line says
// "Reading …" meanwhile, the refusal as served after. A refusal by the gate
// (the session ended, the membership went) downgrades the frame first.
async function loadSettingsSection(id, { notice = null } = {}) {
  if (state.mode !== 'settings' || !id) return;
  const settings = state.settings;
  const gen = ++settingsGeneration;
  settings.status[id] = { kind: 'loading', text: settingsSectionHead(id).loading };
  repaintSettings();
  if (id === 'members') return loadMembersSection(settings, gen, notice);
  if (id === 'audit') return loadAuditSection(settings, gen, notice);
  let endpointsRefusal = null;
  await Promise.all([
    refreshServices(),
    loadMcpEndpoints().then((list) => { state.mcpEndpoints = list; settings.endpointsError = null; }, (e) => {
      state.mcpEndpoints = null;
      settings.endpointsError = e?.message || 'no answer';
      endpointsRefusal = e;
    }),
  ]);
  if (state.mode !== 'settings' || state.settings !== settings) return;
  const gate = [endpointsRefusal, state.servicesStatus?.kind === 'denied' ? { denied: 'org', message: state.servicesStatus.error } : null]
    .find((e) => e && ['auth', 'role', 'posture', 'org'].includes(e.denied));
  if (gate) {
    settings.denied = gate.message || 'refused';
    forgetSettingsAbove(settingsAccess());
  }
  settings.status[id] = { kind: 'ok', text: notice ?? '' };
  if (gen !== settingsGeneration || state.settingsSection !== id) return;   // the user moved on meanwhile
  repaintSettings();
}

// The members and the org's row (GET /api/org/members, an admin's read): a
// refusal by the role (demoted meanwhile) takes the admin's sections away
// with the server's sentence; one by the gate (the session, the membership)
// every control. Either way the frame moves to a section the rank reads,
// which is read with the sentence in its status line.
async function loadMembersSection(settings, gen, notice) {
  let refusal = null;
  try {
    const body = await loadMembers();
    if (state.settings === settings) Object.assign(settings, { members: body.members, org: body.org, membersError: null });
  } catch (e) {
    refusal = e;
    if (state.settings === settings) Object.assign(settings, { members: null, membersError: e?.message || 'no answer' });
  }
  if (state.mode !== 'settings' || state.settings !== settings) return;
  if (adminReadRefused(settings, refusal, gen, 'members')) return;
  settings.status.members = { kind: 'ok', text: notice ?? '' };
  if (gen !== settingsGeneration || state.settingsSection !== 'members') return;
  repaintSettings();
}

// An admin's read (the members, the audit) refused by the gate: the role
// (demoted meanwhile) takes the admin's sections away with the server's
// sentence; the session or the membership every control. The frame moves to
// a section the rank reads, read with the sentence in its status line.
// Answers true when it moved.
function adminReadRefused(settings, refusal, gen, id) {
  if (!refusal || !['auth', 'role', 'posture', 'org'].includes(refusal.denied)) return false;
  if (refusal.denied === 'role') settings.deniedAdmin = refusal.message || 'refused';
  else settings.denied = refusal.message || 'refused';
  forgetSettingsAbove(settingsAccess());
  if (gen === settingsGeneration && state.settingsSection && state.settingsSection !== id) {
    loadSettingsSection(state.settingsSection, { notice: settings.denied || settings.deniedAdmin });
    return true;
  }
  return false;
}

// The audit (GET /api/audit, an admin's read; the deployment's rows an
// owner's): the filters kept for the entry, the query only the filled ones
// (auditQuery — "through" a day reaches the next midnight UTC). A first page
// replaces the rows; an older page (`before`) adds to them. A refusal (a
// filter the server refuses — `400: since must be before until`) is the
// section's status as served.
function settingsAudit(settings) {
  return settings.audit || { filters: {}, doc: null, rows: [], error: null };
}
async function loadAuditSection(settings, gen, notice, { before = null } = {}) {
  const prev = settingsAudit(settings);
  let doc = null;
  let refusal = null;
  try { doc = await loadAudit(auditQuery(prev.filters, { owner: settingsAccess().owner, before })); }
  catch (e) { refusal = e; }
  if (state.mode !== 'settings' || state.settings !== settings) return;
  const rows = Array.isArray(doc?.rows) ? doc.rows : [];
  if (doc) settings.audit = { filters: prev.filters, doc, rows: before === null ? rows : [...prev.rows, ...rows], error: null };
  else settings.audit = before === null ? { filters: prev.filters, doc: null, rows: [], error: refusal?.message || 'no answer' } : { ...prev, error: refusal?.message || 'no answer' };
  if (adminReadRefused(settings, refusal, gen, 'audit')) return;
  settings.status.audit = { kind: 'ok', text: notice ?? '' };
  if (gen !== settingsGeneration || state.settingsSection !== 'audit') return;
  repaintSettings();
}

// Apply: the filters change, the list starts again.
function applyAuditFilters(filters) {
  if (state.mode !== 'settings' || !state.settings) return;
  state.settings.audit = { filters: { ...(filters || {}) }, doc: null, rows: [], error: null };
  loadSettingsSection('audit');
}

// Older rows: the page before the oldest shown, added under it.
function loadOlderAuditRows() {
  const settings = state.settings;
  const audit = settings?.audit;
  if (state.mode !== 'settings' || state.settingsSection !== 'audit' || audit?.doc?.next == null) return;
  const gen = ++settingsGeneration;
  settings.status.audit = { kind: 'loading', text: 'Reading older rows…' };
  repaintSettings();
  loadAuditSection(settings, gen, null, { before: audit.doc.next });
}

// An audit row's time in this browser's local time (the ISO stays in the
// row's <time datetime>).
function auditTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso ?? '') : d.toLocaleString();
}

// The nav: a section the rank reads becomes the one on screen (persisted)
// and is read anew; the focus stays on its nav item.
function selectSettingsSection(id) {
  if (state.mode !== 'settings') return;
  if (settingsSectionFor(settingsAccess(), id, BUILT_SECTIONS) !== id) return;   // drawn unavailable: its click explains
  state.settingsSection = id;
  loadSettingsSection(id);
}

// Repaint Settings keeping the focus where it was: a nav item, or a control
// of the section with an id.
function repaintSettings() {
  if (state.mode !== 'settings') return;
  const active = document.activeElement;
  const navItem = active?.closest?.('.set-nav') ? active.dataset.section : null;
  const focusedId = !navItem && active?.id && active.closest?.('.set-page') ? active.id : null;
  renderMainView();
  if (navItem) document.querySelector(`.set-nav-item[data-section="${CSS.escape(navItem)}"]`)?.focus({ preventScroll: true });
  else if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
}

// The section on screen as the renderer takes it: its head, its model, its status line.
function settingsSectionView(id, access) {
  const settings = state.settings || freshSettings();
  const head = settingsSectionHead(id, { orgName: state.orgName });
  const status = settings.status[id] ?? null;
  if (id === 'audit') {
    const audit = settingsAudit(settings);
    const model = buildAuditSectionModel({ doc: audit.doc, rows: audit.rows, filters: audit.filters, access, orgId: state.orgId, formatTime: auditTime, error: audit.error });
    return { id, head, model, status, filters: audit.filters };
  }
  if (id === 'members') {
    const model = buildMembersSectionModel({
      members: settings.members, org: settings.org ?? { id: state.orgId, name: state.orgName }, access,
      me: signedInLogin(), error: settings.membersError,
    });
    return { id, head, model, status };
  }
  const model = id === 'environments'
    ? buildEnvironmentsSectionModel({
      services: state.services, access, orgName: state.orgName,
      error: state.services === null ? (state.servicesStatus?.error || null) : null,
      editable: BUILT_EDITORS.includes('environment'),
    })
    : buildEndpointsSectionModel({
      endpoints: state.mcpEndpoints, services: state.services, access, orgName: state.orgName,
      error: settings.endpointsError, editable: BUILT_EDITORS.includes('endpoint'),
    });
  return { id, head, model, status };
}

// renderMainView's branch for mode 'settings': the frame and the section
// from the state, the focus on the h1 when just entered.
function renderSettingsHost(view, auditDrafts = null) {
  const access = settingsAccess();
  const section = settingsSectionFor(access, state.settingsSection, BUILT_SECTIONS);
  const frame = buildSettingsFrameModel({ access, section, orgName: state.orgName, orgId: state.orgId, builtSections: BUILT_SECTIONS });
  const sectionView = section ? settingsSectionView(section, access) : null;
  if (sectionView?.id === 'audit') sectionView.drafts = auditDrafts;
  renderSettings(view, frame, sectionView, settingsHost);
  if (settingsFocusNext) {
    settingsFocusNext = false;
    view.querySelector('.set-title')?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }
}

// A reload that lands in Settings in another org (the ORG chip changed in
// Settings — design §3.5): this org's snapshot written now and no write
// after it, the target org's seeded with Settings and the section, then the
// org chosen and the page reloaded.
function reloadIntoSettings(orgId, section = null) {
  persistence.write();
  persistence.suspend();
  persistence.seed(signedInLogin(), orgId, { mode: 'settings', settingsSection: section });
  setActiveOrg(orgId);
  window.location.reload();
}

// ---------- the Settings record editor (design §5, the editor idiom) ----------

// The pop-up over one record of a section (an MCP endpoint, an environment —
// new or registered): UI state, never persisted — a reload lands on the
// section, closed. Drawn into its own host on <body>, outside #layer-view, so
// a section repaint keeps what was typed and the focus. `record` is the row
// as last read (kept when a re-read fails; a re-read that lacks it closes the
// editor); `opener` the selector the focus returns to. The environment
// editor has a second door, the service page (design §5.2, D-C): `page` is
// the service whose page opened it (null from Settings) — leaving that page
// closes it, as leaving Settings closes one opened there. `endpointsError`
// is the refusal of the endpoint list read when the editor opened (A4).
let settingsEditor = null;   // { kind, id, serviceId, page, record, draft, status, step, opener, endpointsError } | null
// Bumped by every open: an open that awaited the endpoint list and was
// overtaken meanwhile (another open, the page left) draws nothing.
let settingsEditorOpening = 0;

function settingsEditorHost() {
  let el = document.getElementById('set-editor-host');
  if (!el) { el = document.createElement('div'); el.id = 'set-editor-host'; document.body.appendChild(el); }
  return el;
}

// The services the environment editor reads (its service select, its
// eyebrow): the table; on the service page with the table unavailable, the
// page's own record.
function settingsEditorServices() {
  if (Array.isArray(state.services)) return state.services;
  const own = state.mode === 'service' ? findServiceRecord(state.serviceId) : null;
  return own ? [own] : [];
}

// The environment `id` as read now: on the service page its record first
// (the page's own read), then the table.
function environmentRecord(id) {
  const rows = [state.mode === 'service' ? findServiceRecord(state.serviceId) : null, ...(Array.isArray(state.services) ? state.services : [])];
  for (const s of rows) {
    const e = (s?.environments || []).find((x) => x.id === id);
    if (e) return e;
  }
  return null;
}

// An environment as a write answered it, put in the service rows held (the
// table and the page's record) — or taken out of them — so the dialog and the
// page agree before the re-read lands.
function adoptEnvironment(env, { remove = false } = {}) {
  const rows = new Set([...(Array.isArray(state.services) ? state.services : []), servicePageRecord].filter(Boolean));
  for (const s of rows) {
    if (s.id !== env.serviceId) continue;
    const list = Array.isArray(s.environments) ? [...s.environments] : [];
    const i = list.findIndex((e) => e.id === env.id);
    if (remove) { if (i >= 0) list.splice(i, 1); } else if (i >= 0) list[i] = env; else list.push(env);
    s.environments = list;
  }
}

// The record the editor is over, as the section's list has it now.
function settingsEditorRecord(ed) {
  if (ed.kind === 'org-name') return settingsOrgRecord();
  if (ed.id === null) return null;
  if (ed.kind === 'member') return Array.isArray(state.settings?.members) ? (state.settings.members.find((m) => m.userId === ed.id) ?? undefined) : ed.record;
  if (ed.kind === 'endpoint' && Array.isArray(state.mcpEndpoints)) return state.mcpEndpoints.find((ep) => ep.id === ed.id) ?? undefined;
  if (ed.kind === 'environment' && (state.mode === 'service' || Array.isArray(state.services))) return environmentRecord(ed.id) ?? undefined;
  return ed.record;
}

// The org the members section is about: its row as GET /api/org/members
// answered, else the active org's id and name.
function settingsOrgRecord() {
  return state.settings?.org ?? { id: state.orgId, name: state.orgName };
}

// The editor belongs where it was opened: Settings, or the page of the
// service it was opened from.
function settingsEditorHere(ed) {
  return ed.page === null ? state.mode === 'settings' : state.mode === 'service' && state.serviceId === ed.page;
}

// Draw the editor, or clear it: leaving where it was opened (Settings, the
// service page — any mode change, another service) closes it, and so does
// its record gone from a list read anew.
function syncSettingsEditor() {
  const el = document.getElementById('set-editor-host');
  const ed = settingsEditor;
  const record = ed ? settingsEditorRecord(ed) : null;
  if (!ed || !settingsEditorHere(ed) || record === undefined) {
    settingsEditor = null;
    if (el && el.innerHTML) el.innerHTML = '';
    return;
  }
  if (record) ed.record = record;
  const model = buildSettingsEditorModel(ed.kind, ed.record, {
    draft: ed.draft, status: ed.status, step: ed.step,
    ctx: {
      access: settingsAccess(), orgName: state.orgName, orgId: state.orgId, services: ed.kind === 'environment' ? settingsEditorServices() : state.services,
      endpoints: state.mcpEndpoints, endpointsError: ed.endpointsError ?? state.settings?.endpointsError ?? null, serviceId: ed.serviceId ?? null,
      members: state.settings?.members ?? null, me: signedInLogin(),
    },
  });
  renderSettingsEditor(settingsEditorHost(), model, settingsHost);
}

// Where the focus returns on close: the opener (Edit… of its row, the
// section's primary, the service page's button), else the section's primary,
// else the page's h1.
function settingsOpenerSelector(el) {
  if (!el) return null;
  if (el.dataset?.editEndpoint) return `[data-edit-endpoint="${CSS.escape(el.dataset.editEndpoint)}"]`;
  if (el.dataset?.editEnv) return `[data-edit-env="${CSS.escape(el.dataset.editEnv)}"]`;
  if (el.dataset?.memberRole) return `[data-member-role="${CSS.escape(el.dataset.memberRole)}"]`;
  if (el.dataset?.memberRemove) return `[data-member-remove="${CSS.escape(el.dataset.memberRemove)}"]`;
  return el.id ? `#${CSS.escape(el.id)}` : null;
}

// Open (a section's primary, a row's Edit…, the service page's Add
// environment / Edit environment): the rank that may write gets the dialog
// with the focus in its first field; another is told why (the controls say so
// already, but the access can downgrade meanwhile). The environment editor
// awaits the org's MCP endpoints when they were never read (the service page
// opens it without Settings having read them — A4), so its select never
// offers "none" alone over a bound record. An open MCP panel closes first —
// one dialog at a time (T11).
async function openSettingsEditor(kind, id = null, serviceId = null, { step = 'edit' } = {}) {
  const page = state.mode === 'service' ? state.serviceId : null;
  if (!BUILT_EDITORS.includes(kind)) return;
  if (kind === 'environment' ? !(state.mode === 'settings' || state.mode === 'service') : state.mode !== 'settings') return;
  const access = settingsAccess();
  const need = kind === 'environment' ? 'operate' : 'admin';
  if (!access.can[need]) { explainUnavailable(access.why[need]); return; }
  const opening = ++settingsEditorOpening;
  const opener = settingsOpenerSelector(document.activeElement);
  const mode = state.mode;
  const find = () => {
    if (kind === 'endpoint') return Array.isArray(state.mcpEndpoints) ? state.mcpEndpoints.find((ep) => ep.id === id) : null;
    if (kind === 'member') return Array.isArray(state.settings?.members) ? state.settings.members.find((m) => m.userId === id) : null;
    if (kind === 'org-name') return settingsOrgRecord();
    return environmentRecord(id);
  };
  if (id !== null && !find()) return;
  let endpointsError = null;
  if (kind === 'environment') {
    if (id === null && !settingsEditorServices().length) return;   // no service yet: the primary says so (A11)
    if (state.mcpEndpoints === null) {
      try {
        state.mcpEndpoints = await loadMcpEndpoints();
        if (state.settings) state.settings.endpointsError = null;
      } catch (e) {
        endpointsError = e?.message || 'no answer';
      }
      if (opening !== settingsEditorOpening || state.mode !== mode || (page !== null && state.serviceId !== page)) return;
    }
  }
  const record = id === null ? null : find();
  if (id !== null && !record) return;
  closeMcpPanel();
  const draftPanel = document.getElementById('draft-mcp-panel');
  if (draftPanel) draftPanel.hidden = true;
  settingsEditor = {
    kind, id, serviceId: record?.serviceId ?? serviceId ?? page, page: kind === 'environment' ? page : null,
    record, draft: null, status: null, step: kind === 'member' && step === 'confirm-delete' ? 'confirm-delete' : 'edit', opener, endpointsError,
  };
  syncSettingsEditor();
  focusSettingsEditor();
}

function focusSettingsEditor() {
  const dialog = document.querySelector('#set-editor-host .set-editor');
  const first = dialog?.querySelector('input, textarea, select') || dialog?.querySelector('#set-editor-confirm')
    || dialog?.querySelector('[role="radio"][tabindex="0"]') || dialog;
  first?.focus({ preventScroll: true });
}

// Close (the scrim, esc, Close, Escape, a delete done, leaving Settings):
// the focus returns to the opener when it is still on the page.
function closeSettingsEditor({ focus = true } = {}) {
  if (!settingsEditor) return;
  const opener = settingsEditor.opener;
  settingsEditor = null;
  const el = document.getElementById('set-editor-host');
  if (el) el.innerHTML = '';
  if (focus) closeSettingsEditorFocus(opener);
}

// The delete step and back: the body swaps for the consequence sentence; what
// was typed is kept for the way back.
function setSettingsEditorStep(step, draft = null) {
  if (!settingsEditor || settingsEditor.status?.kind === 'pending') return;
  if (draft) settingsEditor.draft = draft;
  settingsEditor.step = ['confirm-delete', 'confirm-action'].includes(step) ? step : 'edit';
  settingsEditor.status = null;
  syncSettingsEditor();
  focusSettingsEditor();
}

// A write refused by the gate: the session ended, the membership went or the
// server closed the API (every control goes, with the server's sentence), or
// the role went (the admin's controls go). Then what the rank may no longer
// read is forgotten and the page repaints (design §4).
function settingsWriteRefused(e) {
  if (!state.settings) return;
  if (e?.denied === 'role') state.settings.deniedAdmin = e.message || 'refused';
  else if (['auth', 'posture', 'org'].includes(e?.denied)) state.settings.denied = e.message || 'refused';
  else return;
  forgetSettingsAbove(settingsAccess());
  repaintSettings();
}

// The section's lists after a write: the MCP endpoints (the pickers read the
// same list) and the services (bindings may have gone), the section
// repainted with `notice` in its status line.
async function rereadAfterSettingsWrite(notice = null) {
  if (state.mode === 'settings' && state.settingsSection) await loadSettingsSection(state.settingsSection, { notice });
  syncSettingsEditor();
}

// Save (Create or Save): an endpoint created — POST with the non-empty
// fields, `Created <name> (<origin>).`, and the dialog stays over the new
// record — or saved: only the differing fields PATCHed (nothing differing →
// "Nothing changed." without a call), the status naming what the server
// says changed. A refusal is the server's sentence in the status line.
async function saveSettingsEditor(draft) {
  const ed = settingsEditor;
  if (!ed || ed.status?.kind === 'pending') return null;
  if (ed.kind === 'environment') return saveEnvironmentEditor(ed, draft);
  if (ed.kind === 'org-name') return saveOrgName(ed, draft);
  if (ed.kind === 'member-add') return saveMemberAdd(ed, draft);
  if (ed.kind === 'member') return saveMemberRole(ed, draft);
  if (ed.kind !== 'endpoint') return null;
  ed.draft = draft;
  const record = ed.record;
  const patch = record ? buildEndpointPatch(record, draft) : null;
  if (record && !Object.keys(patch).length) {
    ed.status = endpointSaveStatus([]);
    syncSettingsEditor();
    return { ok: true, changed: [] };
  }
  ed.status = { kind: 'pending', text: 'Saving…' };
  syncSettingsEditor();
  let status;
  try {
    if (record) {
      const res = await patchEndpoint(record.id, patch);
      if (settingsEditor === ed && res.endpoint) ed.record = res.endpoint;
      status = endpointSaveStatus(res.changed);
    } else {
      const created = await createEndpoint(buildEndpointCreate(draft));
      status = { kind: 'saved', text: `Created ${created?.name ?? draft.name} (${created?.origin ?? ''}).` };
      // The list holds it until the re-read below answers (the editor stays over it).
      if (created && Array.isArray(state.mcpEndpoints)) state.mcpEndpoints = [...state.mcpEndpoints, created];
      if (settingsEditor === ed && created) Object.assign(ed, { id: created.id, record: created });
    }
  } catch (e) {
    if (settingsEditor !== ed) return null;
    ed.status = { kind: 'error', text: e?.message || 'no answer' };
    syncSettingsEditor();
    settingsWriteRefused(e);
    return null;
  }
  const opened = settingsEditor === ed;
  if (opened) { ed.status = status; ed.draft = null; }
  syncSettingsEditor();
  if (opened && !record) focusSettingsEditor();
  announce(status.text);
  await rereadAfterSettingsWrite();
  return { ok: true };
}

// The danger button of the delete step: DELETE, then the sentence naming the
// environments it unbound (resolved through the services table as read
// before the delete) in the section's status line; the dialog closes.
async function confirmSettingsEditor() {
  const ed = settingsEditor;
  if (!ed || ed.status?.kind === 'pending' || !ed.record) return null;
  if (ed.kind === 'member' && ed.step === 'confirm-action') return patchMemberRole(ed, ed.draft?.role);
  if (ed.step !== 'confirm-delete') return null;
  if (ed.kind === 'member') return removeMemberEditor(ed);
  if (ed.kind === 'environment') return deleteEnvironmentEditor(ed);
  if (ed.kind !== 'endpoint') return null;
  ed.status = { kind: 'pending', text: 'Deleting…' };
  syncSettingsEditor();
  let res;
  try { res = await deleteEndpoint(ed.record.id); }
  catch (e) {
    if (settingsEditor !== ed) return null;
    ed.status = { kind: 'error', text: e?.message || 'no answer' };
    syncSettingsEditor();
    settingsWriteRefused(e);
    return null;
  }
  const status = endpointDeleteStatus(ed.record.name, res.unbound, state.services);
  // The row it was opened from goes with the record: the focus goes to the section's primary.
  if (settingsEditor === ed) { ed.opener = null; closeSettingsEditor(); }
  announce(status.text);
  await rereadAfterSettingsWrite(status.text);
  return { ok: true };
}

// ---------- the members and the org's name (design §5.4) ----------

// A members write refused: the server's sentence in the dialog's status line
// (the last-admin 409 among them, as served); the gate's refusals downgrade.
function memberWriteRefused(ed, e) {
  if (settingsEditor !== ed) return null;
  ed.status = { kind: 'error', text: e?.message || 'no answer' };
  syncSettingsEditor();
  settingsWriteRefused(e);
  return null;
}

// The org renamed: the name everywhere this page shows it — the Settings
// head, the section, the ORG chip (its option or its label) and the
// membership /auth/me listed; the next boot reads it anew.
function adoptOrgName(org) {
  if (!org?.name) return;
  if (state.settings) state.settings.org = { ...(state.settings.org || {}), ...org };
  if (org.id === state.orgId || !org.id) {
    state.orgName = org.name;
    if (state.access) state.access = { ...state.access, orgName: org.name };
  }
  const entry = (state.identity?.orgs || []).find((o) => o.id === org.id);
  if (entry) entry.name = org.name;
  const option = [...document.querySelectorAll('#observa-org select option')].find((o) => o.value === org.id);
  if (option) option.textContent = org.name;
  updateObservaOrgChip();
}

// Rename… (PATCH /api/org): nothing differing → "Nothing changed." without a
// call; the answer has no `changed`, so the status compares the names (A-16).
async function saveOrgName(ed, draft) {
  ed.draft = draft;
  const before = ed.record?.name ?? state.orgName ?? '';
  const name = String(draft?.name ?? '').trim();
  if (name === before) {
    ed.status = orgRenameStatus(before, before);
    syncSettingsEditor();
    return { ok: true, changed: [] };
  }
  ed.status = { kind: 'pending', text: 'Saving…' };
  syncSettingsEditor();
  let org;
  try { org = await renameOrg(name); }
  catch (e) { return memberWriteRefused(ed, e); }
  const status = orgRenameStatus(before, org?.name ?? name);
  adoptOrgName(org ?? { id: ed.record?.id ?? state.orgId, name });
  if (settingsEditor === ed) { ed.status = status; ed.draft = null; }
  repaintSettings();
  syncSettingsEditor();
  announce(status.text);
  return { ok: true };
}

// Add member (POST /api/org/members, an upsert — A-23): by login or by
// verified email; the status says what the server did (added, the role
// changed, nothing). The dialog stays for the next one; the list is read anew.
async function saveMemberAdd(ed, draft) {
  ed.draft = draft;
  ed.status = { kind: 'pending', text: 'Saving…' };
  syncSettingsEditor();
  let answer;
  try { answer = await addMember(buildMemberAddBody(draft)); }
  catch (e) { return memberWriteRefused(ed, e); }
  const status = memberSaveStatus(answer, { login: draft?.by === 'email' ? null : String(draft?.value ?? '').trim() });
  if (settingsEditor === ed) ed.status = status;
  syncSettingsEditor();
  announce(status.text);
  await rereadAfterSettingsWrite();
  return { ok: true };
}

// Save on a member's dialog: the role chosen. The same role → "Nothing
// changed." without a call; a change the reader should weigh first — their
// own role, or an owner demoting the org's last admin (A12) — goes to the
// confirm step, which says what it leaves; any other is sent at once.
async function saveMemberRole(ed, draft) {
  ed.draft = draft;
  const role = draft?.role ?? ed.record.role;
  if (role === ed.record.role) {
    ed.status = { kind: 'idle', text: 'Nothing changed.' };
    syncSettingsEditor();
    return { ok: true, changed: [] };
  }
  const access = settingsAccess();
  const you = ed.record.login === signedInLogin();
  const ownerNote = access.owner && lastAdmin(ed.record, state.settings?.members || [], { owner: false }) && role !== 'admin';
  if (you || ownerNote) { setSettingsEditorStep('confirm-action', draft); return { ok: true, confirm: true }; }
  return patchMemberRole(ed, role);
}

// PATCH /api/org/members/:userId { role }: `<login>: <from> → <to>.` A
// reader who demoted themselves out of the admin role (still a member)
// reads their rank anew: the members and the audit go, with what they held,
// and the frame moves to a section the new rank reads (A-29, C-6).
async function patchMemberRole(ed, role) {
  if (!role) return null;
  const login = ed.record.login;
  ed.status = { kind: 'pending', text: 'Saving…' };
  syncSettingsEditor();
  let res;
  try { res = await patchMember(ed.record.userId, role); }
  catch (e) { return memberWriteRefused(ed, e); }
  const status = memberSaveStatus(res, { login });
  announce(status.text);
  if (login === signedInLogin() && !settingsAccess().owner && role !== 'admin') {
    closeSettingsEditor({ focus: false });
    await refreshAccess();
    if (state.settings) state.settings.deniedAdmin = null;
    forgetSettingsAbove(settingsAccess());
    updateObservaOrgChip();
    if (state.mode === 'settings' && state.settingsSection) await loadSettingsSection(state.settingsSection, { notice: status.text });
    document.querySelector('.set-title')?.focus({ preventScroll: true });
    return { ok: true };
  }
  if (settingsEditor === ed) { ed.status = status; ed.step = 'edit'; ed.draft = null; }
  syncSettingsEditor();
  await rereadAfterSettingsWrite();
  return { ok: true };
}

// Remove (DELETE /api/org/members/:userId): `Removed <login>.` in the
// section's status line. The reader removing themselves from the org on
// screen never stays on it: the next request would carry an org they are no
// longer in (A3, C-2) — the status says so, and the page reloads into their
// next organisation (or the no-org screen).
async function removeMemberEditor(ed) {
  const login = ed.record.login;
  const orgName = settingsOrgRecord().name || state.orgName || state.orgId;
  ed.status = { kind: 'pending', text: 'Removing…' };
  syncSettingsEditor();
  try { await removeMember(ed.record.userId); }
  catch (e) { return memberWriteRefused(ed, e); }
  if (login === signedInLogin()) {
    const text = `You left ${orgName}; this browser switches to your next organisation.`;
    if (settingsEditor === ed) { ed.status = { kind: 'saved', text }; syncSettingsEditor(); }
    announce(text);
    leaveOrgAndReload();
    return { ok: true, left: true };
  }
  const text = `Removed ${login}.`;
  // The row it was opened from goes with the membership: the focus goes to the section's primary.
  if (settingsEditor === ed) { ed.opener = null; closeSettingsEditor(); }
  announce(text);
  await rereadAfterSettingsWrite(text);
  return { ok: true };
}

// This browser leaves the org on screen: its snapshot is written now, the
// active org forgotten — the boot picks the first live membership, or draws
// the no-org screen — and the page reloads.
function leaveOrgAndReload() {
  persistence.write();
  persistence.suspend();
  setActiveOrg(null);
  window.location.reload();
}

// ---------- the environment editor (design §5.1–5.2: one editor, two doors) ----------

// An environment write refused: the server's sentence in the status line; a
// refusal by the session or the role also downgrades the rank the controls
// draw from (6a's rule), and Settings forgets what the rank may no longer read.
function environmentWriteRefused(ed, e) {
  if (e?.denied === 'auth' || e?.denied === 'role') state.access = { ...(state.access || {}), canWrite: false, reason: e.message };
  if (settingsEditor !== ed) return;
  ed.status = { kind: 'error', text: e?.message || 'no answer' };
  syncSettingsEditor();
  settingsWriteRefused(e);
  if (state.mode === 'service' && (e?.denied === 'auth' || e?.denied === 'role')) repaintServicePage();
}

// After a write: the cached verdicts of the service's packs are dropped (the
// environment's tier grades them — 6a A-M3); Settings reads its section anew
// (the table with it) with `notice` in its status line; the service page
// reads the table and its record anew and repaints.
async function rereadAfterEnvironmentWrite(serviceId, notice = null) {
  forgetServiceVerdicts(findServiceRecord(serviceId));
  if (state.mode === 'settings') {
    if (state.settingsSection) await loadSettingsSection(state.settingsSection, { notice });
  } else {
    await refreshServices();
    if (state.mode === 'service' && state.serviceId === serviceId) {
      try { const fresh = await loadService(serviceId); if (fresh) adoptServiceRecord(fresh); } catch { /* the write's own answer stands */ }
      if (state.mode === 'service' && state.serviceId === serviceId) repaintServicePage();
    }
  }
  syncSettingsEditor();
}

// Save (Create or Save) of the environment editor: created — POST
// /api/services/:id/environments with the non-empty fields, `Created <name>
// on <service>.`, and the dialog stays over the new record (on its service's
// page, its tab is selected) — or saved: only the differing fields PATCHed
// (nothing differing → "Nothing changed." without a call), the status naming
// what the server says changed. The binding is never resent nor nulled when
// the endpoint list could not be read (A4). A refusal is the server's sentence.
async function saveEnvironmentEditor(ed, draft) {
  ed.draft = draft;
  const d = { ...draft };
  if (!Array.isArray(state.mcpEndpoints)) d.mcpEndpointId = undefined;
  const record = ed.record;
  const patch = record ? buildEnvironmentPatch(record, d) : null;
  if (record && !Object.keys(patch).length) {
    ed.status = environmentSaveStatus([]);
    syncSettingsEditor();
    return { ok: true, changed: [] };
  }
  const serviceId = record ? record.serviceId : Number(d.serviceId ?? ed.serviceId);
  const service = settingsEditorServices().find((s) => s.id === serviceId) || findServiceRecord(serviceId);
  ed.status = { kind: 'pending', text: 'Saving…' };
  syncSettingsEditor();
  let status;
  let env;
  try {
    if (record) {
      const res = await patchEnvironment(record.id, patch);
      env = res.environment;
      status = environmentSaveStatus(res.changed);
    } else {
      const body = buildEnvironmentCreate(d);
      env = await createEnvironment(serviceId, body);
      status = { kind: 'saved', text: `Created ${env?.name ?? body.name} on ${service?.name ?? `service ${serviceId}`}.` };
    }
  } catch (e) {
    environmentWriteRefused(ed, e);
    return null;
  }
  if (env) {
    adoptEnvironment({ ...env, serviceId: env.serviceId ?? serviceId });
    // On its service's page the tab follows: a rename keeps it selected; a new one is shown.
    if (state.mode === 'service' && state.serviceId === serviceId && (!record || state.serviceEnv === record.name)) state.serviceEnv = env.name;
  }
  const opened = settingsEditor === ed;
  if (opened) {
    ed.status = status;
    ed.draft = null;
    if (env) Object.assign(ed, { id: env.id, serviceId: env.serviceId ?? serviceId, record: { ...env, serviceId: env.serviceId ?? serviceId } });
  }
  if (state.mode === 'service') repaintServicePage(); else syncSettingsEditor();
  if (opened && !record) focusSettingsEditor();
  announce(status.text);
  await rereadAfterEnvironmentWrite(serviceId);
  return { ok: true };
}

// The danger button of the environment's delete step: DELETE, `Deleted
// <env>.` (in the section's status line in Settings; said on the service
// page), the dialog closes and the focus goes back to where it came from.
async function deleteEnvironmentEditor(ed) {
  const env = ed.record;
  ed.status = { kind: 'pending', text: 'Deleting…' };
  syncSettingsEditor();
  try { await deleteEnvironment(env.id); }
  catch (e) {
    environmentWriteRefused(ed, e);
    return null;
  }
  const status = { kind: 'saved', text: `Deleted ${env.name}.` };
  adoptEnvironment(env, { remove: true });
  if (state.mode === 'service' && state.serviceId === env.serviceId && state.serviceEnv === env.name) state.serviceEnv = null;
  if (settingsEditor === ed) {
    // The row it was opened from goes with the record (Settings): the focus goes to the section's primary.
    if (ed.page === null) ed.opener = null;
    closeSettingsEditor({ focus: false });
    if (state.mode === 'service') repaintServicePage();
    closeSettingsEditorFocus(ed.opener);
  }
  announce(status.text);
  if (state.mode === 'service') toast(status.text);
  await rereadAfterEnvironmentWrite(env.serviceId, status.text);
  return { ok: true };
}

// The focus after a close: the opener when still on the page, else the
// section's primary or the page's h1 (Settings), else the service page's
// environment buttons or its heading.
function closeSettingsEditorFocus(opener) {
  const back = (opener && document.querySelector(opener)) || document.getElementById('set-primary') || document.querySelector('.set-title')
    || document.getElementById('svc-edit-env') || document.getElementById('svc-add-env') || document.querySelector('.svc-page-name');
  back?.focus({ preventScroll: true });
}

// The host the Settings renderers get (docs/UI_CONVENTIONS.md §3): the two
// stable hooks plus Settings' actions under `settings`.
const settingsActions = {
  open: (section = null) => enterSettings(section),
  back: () => leaveSettings(),
  selectSection: (id) => selectSettingsSection(id),
  retry: (id) => loadSettingsSection(id),
  explain: explainUnavailable,
  build: () => enterBuildMode('define'),
  openService: (id) => { enterServicePage(id); },
  openEditor: ({ kind, id = null, serviceId = null, step = 'edit' } = {}) => openSettingsEditor(kind, id, serviceId, { step }),
  closeEditor: () => closeSettingsEditor(),
  save: (draft) => saveSettingsEditor(draft),
  step: (step, draft = null) => setSettingsEditorStep(step, draft),
  confirm: () => confirmSettingsEditor(),
  auditApply: (filters) => applyAuditFilters(filters),
  auditMore: () => loadOlderAuditRows(),
  pickMcpTarget: (container, value) => pickMcpTarget(container, value),
  openMcpEndpoints: () => openMcpEndpointsFromPicker(),
};
const settingsHost = { renderMainView, renderTabs, settings: settingsActions };

// Greet a person only by a name that is a name — "Welcome back, Admin" read
// as a role label, not a greeting.
function homeGreetingHtml() {
  const who = personalName(state.identity);
  return who ? `<p class="home-greeting">Welcome back, ${escapeHtml(who)}.</p>` : '';
}

// Whether Check was the last choice here: a returning user lands on their
// services instead of re-opening the branch every visit.
function homeCheckRemembered() {
  try { return localStorage.getItem('studioHomeChoice') === 'check'; } catch (_) { return false; }
}

function wireHomeChoice(view, model) {
  const checkBtn = view.querySelector('#home-choice-check');
  const panel = view.querySelector('#home-check');
  checkBtn?.addEventListener('click', () => {
    const open = checkBtn.getAttribute('aria-expanded') !== 'true';
    checkBtn.setAttribute('aria-expanded', String(open));
    checkBtn.classList.toggle('is-open', open);
    if (panel) panel.hidden = !open;
    try { localStorage.setItem('studioHomeChoice', open ? 'check' : ''); } catch (_) {}
    if (open) {
      panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      (view.querySelector('#home-service-search') || view.querySelector('#home-mcp-url'))?.focus({ preventScroll: true });
    }
  });
  // Build is operator work (POST /api/library/instantiate): a rank without it
  // sees the card drawn unavailable with the reason, and the click explains.
  const buildBtn = view.querySelector('#home-choice-build');
  if (!model.build.enabled) markUnavailable(buildBtn, model.build.reason);
  buildBtn?.addEventListener('click', () => (model.build.enabled ? enterBuildMode('define') : explainUnavailable(model.build.reason)));
}

// The signed-in service gate and the local hero are one screen now: the
// same question and the same two choices. The gate opens straight onto the
// user's services; both keep the import sources one step down.
function renderServiceGate() { renderHomeView(); }

// The one ORG chip (STORE_PLAN §6, slice 6a D6/D7): on every screen in the
// OBSERVA bar — a switcher for a user in a second org, a label for one org
// that is not the default one, nothing otherwise (orgChipModel). The list is
// the user's memberships (/auth/me `orgs`: an org the chip offers is one the
// next boot can re-select); the role in the title is the EFFECTIVE one the
// guard applies in the active org (GET /api/orgs → state.access — an owner
// reads admin), the membership's as the fallback before that call answered.
// Called wherever the chrome repaints (updateObservaServiceChip).
function updateObservaOrgChip() {
  const chip = document.getElementById('observa-org');
  if (!chip) return;
  const orgs = state.identity?.orgs || [];
  const { kind, active } = orgChipModel(orgs, getActiveOrg());
  if (kind === 'none') { chip.hidden = true; return; }
  const name = document.getElementById('observa-org-name');
  if (kind === 'switcher' && !chip.querySelector('select')) {
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
      // From Settings the reload lands in Settings in the chosen org, on the
      // same section (the target org's snapshot is seeded first).
      if (state.mode === 'settings') { reloadIntoSettings(sel.value, state.settingsSection); return; }
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
  const role = (state.access?.posture === 'identity' && state.access.role) || active.effectiveRole || active.role || 'member';
  chip.title = `organisation: ${active.id} (role: ${role})`;
  chip.hidden = false;
}

// The chip resolves the active service key against the table (services-model.mjs
// serviceChipModel): a record → a <button> back to its page; a key no record
// covers (the table unavailable, a derived-only service) → today's label, not
// interactive; hidden on home, on the page itself and in Build.
function updateObservaServiceChip() {
  updateObservaOrgChip();
  let chip = document.getElementById('observa-service');
  if (!chip) return;
  const derived = serviceCatalogue().find(s => s.key === state.selectedService);
  const m = serviceChipModel({ services: state.services, selected: state.selectedService, derivedLabel: derived?.label ?? null });
  if (state.mode === 'home' || state.mode === 'build' || state.mode === 'service' || state.mode === 'settings' || m.kind === 'none') { chip.hidden = true; return; }
  const wantTag = m.kind === 'record' ? 'BUTTON' : 'SPAN';
  if (chip.tagName !== wantTag) {
    const next = document.createElement(wantTag.toLowerCase());
    next.className = chip.className;
    next.id = chip.id;
    if (wantTag === 'BUTTON') next.type = 'button';
    next.innerHTML = chip.innerHTML;
    chip.replaceWith(next);
    chip = next;
  }
  const name = document.getElementById('observa-service-name');
  if (name) name.textContent = m.label;
  if (m.kind === 'record') {
    chip.title = `Back to the service page of ${m.label}`;
    chip.setAttribute('aria-label', `Service ${m.label} — back to its page`);
    chip.onclick = () => enterServicePage(m.serviceId, state.serviceEnv);
  } else {
    chip.removeAttribute('title');
    chip.removeAttribute('aria-label');
    chip.onclick = null;
  }
  chip.hidden = false;
}

// One click on a service card → Observogram configured for that service:
// service selected, its most recent pack loaded as Pack A, Discover open.
function enterServiceWorkspace(serviceKey) {
  if (!serviceKey) return;
  // Catalog order is oldest→newest (workspace registry order, new
  // registrations appended) — the LAST match is the freshest. Prefer the
  // declared (non-aggregate) pack; an aggregate live draft that names the
  // service is a usable fallback when it's all the service has. A live
  // snapshot of some other service is never opened as this one's Pack A.
  const matches = state.catalog.filter(p => p.ok
    && (serviceKeyForPack(p) === serviceKey || packMatchesService(p, serviceKey, { side: 'a' })));
  // The same rule the record card, the page and the selector apply
  // (services-model.mjs newestPack): the newest declared pack, else the newest aggregate.
  const { pack } = newestPack(matches, p => !isLiveAggregatePack(p));
  if (!pack) {
    // Nothing loadable for it here: say so, open nothing, and record
    // nothing — the tile must not then read "Opened".
    const label = serviceCatalogue().find(s => s.key === serviceKey)?.label || serviceKey;
    toast(`No pack for ${label} is loaded here yet. Import or scan one under "Import or scan another source".`);
    return;
  }
  // Record the tile that was clicked: a pack can carry several services (or
  // be a live aggregate), and enterAnalyzeMode records only its primary one.
  recordRecentService(serviceKey);
  state.selectedService = serviceKey;
  enterAnalyzeMode(pack.id, defaultEnvFor(pack.id));
}

function enterAnalyzeMode(packId, env) {
  if (!packId) return;
  navGeneration++;
  state.mode = 'single';
  state.selectedPackId = packId;
  state.selectedEnv    = env || defaultEnvFor(packId);
  state.selectedService = serviceKeyForPack(state.catalog.find(p => p.id === packId)) || state.selectedService;
  state.activeLayer = 'L1';
  recordRecentService(state.selectedService);
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
  // The BUILD journey hides the pack controls like home does: there is no
  // pack until VERIFY's "Open pack in Discover" (with visible gaps, or without) registers one.
  const isHome = state.mode === 'home' || state.mode === 'build' || state.mode === 'service' || state.mode === 'settings';
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
  // Loading Pack A, loading Pack B and comparing them is the studio's core
  // operation, so the picker is on every workspace screen, Discover included.
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
  // The header's cards follow the mode too: leaving the BUILD journey through
  // its exit bar (goHome, or enterAnalyzeMode when a pack was open) once left
  // the three build cards up, the last step highlighted and the tagline
  // reading "Define · Compile · Verify" over the home hero, because only
  // routeTo and openInDiscover repainted them. Every mode transition passes
  // through here, so this is where the set is swapped (idempotent: the nav
  // is rebuilt only when the set changes).
  paintObservaActiveTab();
  // The bar's controls just changed (a picker shown or hidden can wrap it
  // onto another row): re-measure now, so what pins under it — the panels,
  // the drawers, the sticky strips — is never a frame behind the observer.
  syncContextBarHeight();
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
    const ok = confirm(`${state.brand.chrome.resetTitle}\n\n` +
      'This will:\n' +
      '  • drop every uploaded / scanned / drafted pack from the server\n' +
      '  • clear saved view + filter + focus + trace preferences from localStorage\n' +
      '  • reload the page to the empty home screen\n\n' +
      'Catalog-shipped example packs are unaffected (they live on disk).');
    if (!ok) return;
    // 1. Drop server-side uploads FIRST. A refusal (a viewer, a signed-out
    //    session) is shown and nothing is cleared — the browser's state
    //    stays as it was. If the endpoint is unreachable we still reset
    //    the client — the client-side reset is the higher-leverage part.
    try {
      const r = await fetch('/api/uploads', { method: 'DELETE', headers: { Accept: 'application/json', ...authHeaders() } });
      if (!r.ok) {
        const denial = deniedError(r.status, await r.text().catch(() => ''));
        if (denial) { toast(`RESET refused — ${denial.message}`, 'error'); return; }
      }
    } catch (_) {}
    // 2. Stop persistence from racing the reload + writing stale state.
    try { persistence.suspend(); } catch (_) {}
    // 3. Wipe localStorage. Keep theme so the user's dark/light choice
    //    survives — that's not session state, it's a preference.
    try {
      const theme = localStorage.getItem('studioTheme');
      localStorage.clear();
      if (theme) localStorage.setItem('studioTheme', theme);
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
    a.href = `/api/packs/${encodeURIComponent(id)}/export.zip${qs}${orgQuery(qs ? '&' : '?')}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
}

// Logo click returns home. The OBSERVA chrome's brand is an <a href="/">:
// left to the browser a click reloads the page, and with mode 'build'
// persisted the studio resumed the BUILD journey at the saved step instead
// of landing on the hero — so the brand is bound here beside the legacy
// header's h1 (the build draft stays in state.build; "Build a pack" resumes it).
function setupHomeAffordance() {
  const legacy = document.querySelector('.hdr-brand h1');
  if (legacy) {
    legacy.style.cursor = 'pointer';
    legacy.title = 'Return home';
    legacy.onclick = () => goHome();
  }
  const brand = document.querySelector('.observa-brand');
  if (brand) brand.addEventListener('click', (e) => { e.preventDefault(); goHome(); });
}

// ============================================================
// The BUILD journey — Define · Compile · Verify (docs/BUILD_JOURNEY.md,
// slice 2). The controller: state.build is the draft, the step modules
// render it (build-define-view / build-compile-view / build-verify-view,
// renderer-only), build-model.mjs computes what they show, build-api.mjs
// talks to the six /api/library routes. Every change to the draft
// re-instantiates through the API (debounced), because the PromQL grammar
// check is Node-only; the result feeds the clause rail the three steps share.
// ============================================================

// Restore a persisted draft (inputs only) over the defaults — the pure part is the model's (a legacy step id
// resumes on its current step, a pre-seed draft on COMPILE / VERIFY counts as seeded).
function restoreBuildDraft(saved) {
  state.build = restoreBuildDraftModel(saved, defaultBuildState(), BUILD_PERSIST_FIELDS);
}

export function enterBuildMode(step) {
  navGeneration++;
  state.mode = 'build';
  state.activeCardKey = null;
  // The step clamped to what is reachable now; a demoted step (VERIFY before the
  // re-instantiation below has answered) is kept as wantedStep and honoured then.
  Object.assign(state.build, enterBuildStep(state.build, step || state.build.step));
  applyModeChrome();
  paintObservaActiveTab();
  renderTabs();
  renderMainView();
  // DEFINE shows what each tier requires and the rail the chosen tier's
  // clauses; the draft needs a result if it is already complete (a reload
  // lands here with inputs and no canonical).
  for (const t of BUILD_TIERS) ensureBuildRequirements(t);
  if (!state.build.result && buildDefineValid(state.build)) scheduleBuildInstantiate(0);
  // VERIFY draws one artefact card per compile target.
  if (!buildTargets) loadBuildTargets().then(t => { buildTargets = t; if (state.mode === 'build' && state.build.step === 'verify') rerenderBuild(); }).catch(() => { buildTargets = []; });
  persistence.schedule();
}
let buildTargets = null;

// Leave the journey without a hand-off: back to the pack that was open, or home.
function exitBuildMode() {
  if (state.mode !== 'build') return;
  state.build.editor = null;   // the pop-up editor is UI state of the journey; the render that follows clears its host
  if (state.selectedPackId) { state.mode = 'single'; state.view = 'layers'; enterAnalyzeMode(state.selectedPackId, state.selectedEnv); return; }
  // Opened from a service page (no pack was open): back to that page. A row
  // deleted meanwhile (404) or refused since cannot be landed on — the exit
  // still works: home, with the server's sentence and where the user ended up
  // (a refusal names a way out that works), and the stale binding dropped.
  if (state.serviceId) {
    const name = findServiceRecord(state.serviceId)?.name || 'The service this Build was opened from';
    enterServicePage(state.serviceId, state.serviceEnv, {
      onRefused: (why) => { if (state.mode !== 'build') return; goHome(); toast(buildExitRefusal(name, why), 'error'); },
    });
    return;
  }
  goHome();
}

// Where leaving Build goes, said plainly: the open pack, the service page it was opened from, or home.
function buildExitLabel() {
  if (state.selectedPackId) return 'Back to the open pack';
  if (state.serviceId) return `Back to ${findServiceRecord(state.serviceId)?.name || 'the service'}`;
  return 'Back to home';
}

// `todo` (a todo path) lands the step on that todo instead of its top — a card's
// pin on COMPILE, whose todo is drawn on VERIFY only. `sheet` (a layer id) lands
// it with that layer's sheet open; an open sheet otherwise stays open across
// steps (one component on the three steps, its mode follows the step).
function goToBuildStep(step, { todo = null, sheet } = {}) {
  if (!BUILD_STEPS.includes(step)) return;
  const reach = buildStepReachability(state.build);
  if (!reach[step]) {
    toast(step === 'compile' ? (buildDefineValid(state.build) ? 'Seed the pack first — "Seed the pack →" on Define opens Compile.' : 'Complete the definition first — a service name, a tier and at least one library entry — then seed the pack.')
      : 'Generate a pack with at least one SLI first.', 'error');
    return;
  }
  if (state.mode !== 'build') { enterBuildMode(step); return; }
  state.build.step = step;
  state.build.wantedStep = null;   // an explicit choice supersedes a step still waited for
  state.build.preview = null;
  if (sheet !== undefined) {
    buildSheetEntering = !!sheet && sheet !== state.build.sheetOpen;   // reopening the same layer on another step is not an opening
    state.build.sheetOpen = sheet;
    if (sheet) buildFocusNext = '.build-sheet';
  }
  paintObservaActiveTab();
  renderMainView();
  focusAfterRender();
  if (todo && revealTodo(document.querySelector(`.build-step [data-todo="${CSS.escape(todo)}"]`))) return;
  if (!sheet) window.scrollTo({ top: 0 });
}

// A one-shot focus target for the render that follows: the sheet when it opens, the
// slab head it belongs to when it closes (focus moves in and returns).
let buildFocusNext = null;
// A one-shot for the render that opens a layer's sheet: that render draws the sheet with
// `is-entering` (the 200 ms entrance); every later re-render while it stays open — a
// switch flipped, a param committed, a settled keystroke — rebuilds it without the class,
// so the entrance never replays (measured: it slid in six times per SLI switch flip).
let buildSheetEntering = false;
function focusAfterRender() {
  if (!buildFocusNext) return;
  // A target inside the sheet that is not there (a product with no card yet) lands on the sheet itself.
  // COMPILE draws a layer's slab only when it is selected: a slab edge that is not there lands on its layer row.
  const head = /^\.build-slab\[data-layer="([^"]+)"\] \.build-slab-edge$/.exec(buildFocusNext);
  const el = document.querySelector(buildFocusNext)
    || (head ? document.querySelector(`.bres-layer-toggle[data-layer="${head[1]}"]`) : null)
    || (buildFocusNext.startsWith('.build-sheet ') ? document.querySelector('.build-sheet') : null)
    || focusFallbackSelectors(buildFocusNextKey).map(sel => document.querySelector(sel)).find(Boolean)
    || null;
  buildFocusNext = null;
  buildFocusNextKey = null;
  el?.focus({ preventScroll: true });
  // A rolodex card landed on (a seed chip opened the sheet on its product) is centred in the snap track.
  const card = el?.closest?.('[data-snap-card]');
  const track = card?.closest('[data-scroll-key]');
  if (card && track) track.scrollLeft = card.offsetLeft - (track.clientWidth - card.offsetWidth) / 2;
}
/** The selector of a focus key (`ov:<sli>:<field>`, `customise:<key>`, …) as the renderers stamp it. */
const focusKeySelector = (key) => `[data-focus-key="${CSS.escape(key)}"]`;
/** Nothing to re-render, but a field was left by Enter or Tab and nothing has the focus: give it back to the key. */
function refocusBuild(focusKey) {
  if (!focusKey || (document.activeElement && document.activeElement !== document.body)) return;
  document.querySelector(focusKeySelector(focusKey))?.focus({ preventScroll: true });
}

// The pop-up SLI editor (docs/BUILD_JOURNEY.md "The editor") lives in a persistent host on <body>, outside the
// re-rendered view, so a re-render of the stack, the sheet and the column under it never replaces the field being
// typed in. syncBuildEditor draws or clears it after every render of the main view; the dialog itself is
// re-rendered by build-editor-view.mjs with the focused field's text, focus and caret kept. `build.editor` (UI
// state, never persisted) says which SLI it is over; the one-shots below carry the field to land on when it
// opens and where focus returns when it closes.
let buildEditorFocus = null;
let buildEditorOpener = null;
// The opener's raw focus key: kept so a renamed custom SLI's Edit button is re-keyed, and so a missing opener (the
// SLI was removed) falls back through focusFallbackSelectors instead of dropping focus to <body>.
let buildEditorOpenerKey = null;
let buildFocusNextKey = null;
/** Focus goes back where the editor was opened from; the key rides along for the fallback. */
function returnFocusToOpener() {
  buildFocusNext = editorReturnSelector();
  buildFocusNextKey = buildEditorOpenerKey;
  buildEditorOpener = null;
  buildEditorOpenerKey = null;
}
function buildEditorHost() {
  let el = document.getElementById('build-editor-host');
  if (!el) { el = document.createElement('div'); el.id = 'build-editor-host'; document.body.appendChild(el); }
  return el;
}
function syncBuildEditor() {
  const el = document.getElementById('build-editor-host');
  const b = state.build;
  const library = buildLibraryCache();
  if (state.mode !== 'build' || !b?.editor || !library) { if (el && el.innerHTML) el.innerHTML = ''; return; }
  const model = buildEditorModel({ build: b, library, mode: editorModeFor(b.step) });
  // The SLI it was over is gone (its entry deselected, a custom one removed): the editor closes.
  if (!model) { b.editor = null; if (el) el.innerHTML = ''; return; }
  renderBuildEditor(buildEditorHost(), model, buildHost, { focus: buildEditorFocus });
  buildEditorFocus = null;
}
/** The selector focus returns to when the editor closes: the opener's focus key, else the L1 slab head. */
const editorReturnSelector = () => buildEditorOpener || '.build-slab[data-layer="L1"] .build-slab-edge';

// A tier's clauses, loaded once per tier; the view repaints when they land
// (DEFINE shows what every tier requires, the rail the chosen tier's).
function ensureBuildRequirements(tier) {
  if (!tier || buildRequirementsCache()[tier]) return;
  loadBuildRequirements(tier).then(() => { if (state.mode === 'build') rerenderBuild(); })
    .catch(e => toast(`Could not load the ${tier} requirements: ${e.message}`, 'error'));
}

// Debounced re-instantiation. Stale answers are dropped by sequence, so a
// fast second edit never paints an older pack over a newer one.
let buildSeq = 0;
let buildTimer = null;
function scheduleBuildInstantiate(delay = 350) {
  if (buildTimer) clearTimeout(buildTimer);
  buildTimer = setTimeout(runBuildInstantiate, delay);
}
async function runBuildInstantiate() {
  buildTimer = null;
  const b = state.build;
  if (!buildDefineValid(b)) {
    b.editorDirty = false;
    if (b.result || b.error || b.pending) { b.result = null; b.error = null; b.pending = false; rerenderBuild(); }
    return;
  }
  // A draft restored from an older session may list an SLI of an entry no longer selected: drop those keys
  // before sending (an SLI above the tier stays — the tier is a seed, not a gate); the body carries the
  // overrides of the SLIs in the selection only (instantiateBody with the library).
  const lib = buildLibraryCache();
  if (lib) b.slis = retargetSlis(b, lib);
  const seq = ++buildSeq;
  b.pending = true;
  paintBuildPending(true);
  let res;
  try { res = await instantiateBuild(b, { library: lib }); }
  catch (e) { res = { ok: false, errors: [e.message] }; }
  if (seq !== buildSeq || state.build !== b) return;
  b.pending = false;
  // The editor's last edit has an answer, so its status line reads it — unless a newer edit still waits on the
  // debounce (buildTimer): this answer is to an older request and the status must keep reading applying…
  b.editorDirty = editorDirtyAfterAnswer(b.editorDirty, !!buildTimer);
  if (res?.ok) {
    applyInstantiateOk(b, res);
  } else {
    // A usage error — a param value the engine refuses, every SLI unticked, a rejected customised value:
    // the previous pack stays (the views mark it stale and show the error beside the field it names — on the
    // editor's field when it is open, on the card's chip and in the compile note otherwise), so Validate stays
    // reachable and nothing typed so far is lost. Dropping the result here once bounced the user from
    // Validate to Generate, the one step without parameter inputs.
    b.error = res?.errors || [res?.error || 'instantiation failed'];
  }
  // A step that is no longer reachable falls back — only when there is no
  // pack to read: a kept pack keeps its step. A step waited for (a reload on
  // VERIFY lands on COMPILE until the pack is back) is honoured now, once.
  Object.assign(b, buildStepAfterInstantiate(b));
  rerenderBuild();
  persistence.schedule();
}
// A successful instantiate response onto the draft: the result the views read, the error cleared, the
// preview (compiled from the previous canonical) dropped.
function applyInstantiateOk(b, res) {
  b.result = {
    canonical: res.canonical, canonicalYaml: res.canonicalYaml || '', todos: res.todos || [], warnings: res.warnings || [],
    summary: res.summary || null, conformance: res.conformance || null, schemaErrors: res.schemaErrors || [], provenance: res.provenance || null,
    // The adapter's layered projection — what the stack draws and what Discover will show.
    adapted: res.adapted || null,
  };
  b.error = null;
  b.preview = null;
}
function paintBuildPending(on) {
  document.querySelector('.build-summary')?.classList.toggle('is-pending', on);
  document.querySelector('.build-shell')?.classList.toggle('is-pending', on);
}

// Re-render the build view keeping the focused input focused (a typed name
// or an inline param re-instantiates and repaints while the caret is in it).
// When the input is gone — a filled todo disappears with its inputs — focus
// moves to the nearest thing on the same slab (or on the sheet) rather than
// falling to <body>. The scroll offsets of the sheet body and the rolodex
// track ([data-scroll-key]) survive too, so a switch flipped mid-list does
// not throw the list back to its top; a focused rolodex card is re-centred.
function rerenderBuild() {
  if (state.mode !== 'build') return;
  const el = document.activeElement;
  // The render that opens the editor (or morphs it after 'Add to the pack') lands the focus in it — the generic
  // restore below must not hand it back to the opener (measured: the Edit button took it back).
  const key = buildEditorFocus ? null : (el?.dataset?.focusKey || null);
  const sel = key && typeof el.selectionStart === 'number' ? [el.selectionStart, el.selectionEnd] : null;
  const scrollY = window.scrollY;
  const scrolls = Object.fromEntries([...document.querySelectorAll('[data-scroll-key]')].map(n => [n.dataset.scrollKey, [n.scrollTop, n.scrollLeft]]));
  paintObservaActiveTab();
  renderMainView();
  for (const n of document.querySelectorAll('[data-scroll-key]')) {
    const s = scrolls[n.dataset.scrollKey];
    if (s) { n.scrollTop = s[0]; n.scrollLeft = s[1]; }
  }
  if (key) {
    let next = document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
    let caret = sel;
    if (!next) {
      for (const s of focusFallbackSelectors(key)) { next = document.querySelector(s); if (next) break; }
      caret = null;   // another input, or the slab's edge: the old caret means nothing there
    }
    if (next) {
      next.focus({ preventScroll: true });
      if (caret && typeof next.setSelectionRange === 'function') { try { next.setSelectionRange(caret[0], caret[1]); } catch { /* not a text input */ } }
      const card = next.closest?.('[data-snap-card]');
      const track = card?.closest('[data-scroll-key]');
      if (card && track) track.scrollLeft = card.offsetLeft - (track.clientWidth - card.offsetWidth) / 2;
    }
  }
  focusAfterRender();
  window.scrollTo({ top: scrollY });
}

// The draft's instantiate body as runBuildInstantiate sends it (the overrides filtered to the selection).
function instantiateBodyOf(b) { return buildInstantiateBody(b, buildLibraryCache()); }

// The actions the step renderers call (they never import app.mjs).
const buildActions = {
  // Merge a patch into the draft; text fields re-instantiate after a pause,
  // structural changes repaint at once.
  update(patch, { rerender = false, reinstantiate = true, delay, focus = null } = {}) {
    Object.assign(state.build, patch);
    if (focus) buildFocusNext = focusKeySelector(focus);   // where the render that follows should land the focus (a face that opened: its first field)
    if (rerender) rerenderBuild();
    if (reinstantiate) scheduleBuildInstantiate(delay);
    persistence.schedule();
  },
  setTier(tier) {
    const b = state.build;
    if (!BUILD_TIERS.includes(tier) || tier === b.tier) return;
    const prev = b.tier;
    b.tier = tier;
    // The tier is a seed: an explicit SLI list keeps every SLI the user has (above the new tier too, with
    // its overrides) and takes in what the new tier unlocks — the library's defaults refresh, the
    // customisations stay (docs/BUILD_JOURNEY.md "The seed and the copies").
    b.slis = retargetSlis(b, buildLibraryCache(), prev);
    ensureBuildRequirements(tier);
    rerenderBuild();
    scheduleBuildInstantiate(0);
  },
  toggleEntry(id) {
    const b = state.build;
    const prevEntries = [...b.entries];
    b.entries = b.entries.includes(id) ? b.entries.filter(x => x !== id) : [...b.entries, id];
    // The other entries keep exactly the SLIs they had, re-keyed for the new composition; an entry that leaves
    // takes its SLIs (and their overrides) with it, one that joins brings the tier's defaults of its own.
    b.slis = retargetSlisForEntries({ build: b, library: buildLibraryCache() }, prevEntries);
    b.overrides = retargetOverrides({ build: b, library: buildLibraryCache() }, prevEntries);
    rerenderBuild();   // an open editor over an SLI of the entry that left closes here (syncBuildEditor finds no item)
    scheduleBuildInstantiate(0);
  },
  setParam(key, value) {
    const b = state.build;
    const v = String(value ?? '').trim();
    const params = { ...b.params };
    if (v === '') delete params[key]; else params[key] = v;
    if (JSON.stringify(params) === JSON.stringify(b.params)) return;
    b.params = params;
    scheduleBuildInstantiate(0);
    persistence.schedule();
  },
  setSli(key, on, allKeys) {
    const b = state.build;
    const current = new Set(Array.isArray(b.slis) ? b.slis : allKeys);
    if (on) current.add(key); else current.delete(key);
    b.slis = [...current];
    rerenderBuild();
    scheduleBuildInstantiate(0);
  },
  setToggle(section, on) {
    const b = state.build;
    b.toggles = { ...b.toggles, [section]: !!on };
    rerenderBuild();
    scheduleBuildInstantiate(0);
  },
  // The rolodex's one action for an SLI of a product not yet selected: the entry joins
  // the selection and the SLI is ticked, the rest of the selection kept (re-keyed for
  // the new composition). Pure part: addSliSelection.
  addSli(entryId, sliId) {
    const b = state.build;
    const prevEntries = [...b.entries];
    const next = addSliSelection({ build: b, library: buildLibraryCache() }, entryId, sliId);
    if (!next.changed) { if (next.reason) toast(`${sliId}: ${next.reason}`, 'error'); return; }
    b.entries = next.entries;
    b.slis = next.slis;
    if (next.entries.length !== prevEntries.length) b.overrides = retargetOverrides({ build: b, library: buildLibraryCache() }, prevEntries);
    rerenderBuild();
    scheduleBuildInstantiate(0);
  },
  // The slug guard as typed (design §6.4): the DEFINE view repaints its note on every keystroke from this —
  // the key rule lives here, bound at boot (T19), never imported by a view (T8). null when nothing is to say.
  originNote(name) { return buildDefineOriginNote(buildDefineOrigin(name)); },
  // DEFINE's primary action: the definition is confirmed once (seeded, persisted) and COMPILE opens; the
  // column recedes into the seed card there. Idempotent: once seeded it is "Continue to Compile →".
  seed() {
    const b = state.build;
    if (!buildDefineValid(b)) return;
    b.seeded = true;
    persistence.schedule();
    goToBuildStep('compile');
  },
  // The copies (docs/BUILD_JOURNEY.md "The seed and the copies", "The editor"): an override is copy-on-write over
  // the library's value for one field of one SLI, keyed by the id the library gives it (a rename — the `id`
  // field — keeps that key, so the SLI stays attached to its library row); an empty value clears it. The engine
  // validates on the re-instantiation and its `override <sli>.<field>: …` error lands under the editor's field.
  // `live`: the editor commits on input — the draft changes, the dialog alone is redrawn (its status reads
  // 'applying…'; the page under it follows when the pack answers) and the instantiate is debounced like a typed
  // name, so a keystroke is never a request of its own. `focusKey`: the field to land the focus on after a full
  // re-render when the commit found none focused (a field left by Enter or Tab has <body> active meanwhile).
  setOverride(key, field, text, { focusKey = null, live = false } = {}) {
    const b = state.build;
    const value = fieldValueFor(field, text);
    const current = { ...(Object.prototype.hasOwnProperty.call(b.overrides || {}, key) ? b.overrides[key] : {}) };
    if (value === null) delete current[field]; else current[field] = value;
    const overrides = { ...(b.overrides || {}) };
    if (Object.keys(current).length) overrides[key] = current; else delete overrides[key];
    if (JSON.stringify(overrides) === JSON.stringify(b.overrides || {})) { refocusBuild(focusKey); return false; }   // nothing changed: the editor's status stays as it was
    b.overrides = overrides;
    if (live) { b.editorDirty = true; syncBuildEditor(); scheduleBuildInstantiate(); persistence.schedule(); return true; }
    if (focusKey) buildFocusNext = focusKeySelector(focusKey);
    rerenderBuild();
    scheduleBuildInstantiate(0);
    persistence.schedule();
    return true;
  },
  clearOverride(key, field) {
    const b = state.build;
    if (!Object.prototype.hasOwnProperty.call(b.overrides || {}, key)) return;
    const current = { ...b.overrides[key] };
    if (field) delete current[field];
    const overrides = { ...b.overrides };
    if (field && Object.keys(current).length) overrides[key] = current; else delete overrides[key];
    b.overrides = overrides;
    rerenderBuild();
    scheduleBuildInstantiate(0);
    persistence.schedule();
  },
  // A custom SLI is tried before it is kept: one instantiation with it added; the engine's usage errors
  // (a 400) stay on the form, inline, and nothing changes in the pack; a success commits it and the pack.
  async addCustom(def, draft = null) {
    const b = state.build;
    const custom = [...(b.custom || []), def];
    const seq = ++buildSeq;
    b.pending = true;
    b.customDraftErrors = null;
    paintBuildPending(true);
    let res;
    try { res = await instantiateBuild(b, { body: { ...instantiateBodyOf(b), custom } }); }
    catch (e) { res = { ok: false, errors: [e.message] }; }
    if (seq !== buildSeq || state.build !== b) return;
    b.pending = false;
    if (res?.ok) {
      b.custom = custom;
      b.customDraft = null;
      b.customDraftErrors = null;
      applyInstantiateOk(b, res);
      // The editor stays open, now over the SLI it just added (edit mode): its status says what the pack made of it.
      if (b.editor?.create) { b.editor = { key: def.id, custom: true }; buildEditorFocus = 'first'; }
      persistence.schedule();
    } else {
      b.customDraft = draft || b.customDraft;
      b.customDraftErrors = res?.errors || [res?.error || 'the custom SLI was refused'];
    }
    Object.assign(b, buildStepAfterInstantiate(b));
    rerenderBuild();
  },
  // A custom SLI's field (`live` as setOverride's); its `id` renames it — the definition, the editor and its key follow.
  // Both return whether anything changed (false: the editor's status line stays as it was).
  updateCustom(id, field, text, { focusKey = null, live = false } = {}) {
    const b = state.build;
    const i = (b.custom || []).findIndex(d => d.id === id);
    if (i < 0) return false;
    const value = fieldValueFor(field, text);
    const next = { ...b.custom[i] };
    if (field === 'id') { if (value === null) return false; next.id = value; }
    else if (value === null) delete next[field]; else next[field] = value;
    if (JSON.stringify(next) === JSON.stringify(b.custom[i])) { refocusBuild(focusKey); return false; }
    b.custom = b.custom.map((d, j) => (j === i ? next : d));
    if (field === 'id' && b.editor?.custom && b.editor.key === id) b.editor = { ...b.editor, key: next.id };
    // The Edit button that opened it carries the id in its focus key: follow the rename.
    if (field === 'id' && buildEditorOpenerKey === `sugg-edit:${id}`) {
      buildEditorOpenerKey = `sugg-edit:${next.id}`;
      buildEditorOpener = focusKeySelector(buildEditorOpenerKey);
    }
    if (live) { b.editorDirty = true; syncBuildEditor(); scheduleBuildInstantiate(); persistence.schedule(); return true; }
    if (focusKey) buildFocusNext = focusKeySelector(focusKey);
    rerenderBuild();
    scheduleBuildInstantiate(0);
    persistence.schedule();
    return true;
  },
  removeCustom(id) {
    const b = state.build;
    if (!(b.custom || []).some(d => d.id === id)) return;
    b.custom = b.custom.filter(d => d.id !== id);
    // The editor over the SLI just removed closes, focus back where it was opened from.
    if (b.editor?.custom && b.editor.key === id) { b.editor = null; returnFocusToOpener(); }
    rerenderBuild();
    scheduleBuildInstantiate(0);
    persistence.schedule();
  },
  // The pop-up editor (docs/BUILD_JOURNEY.md "The editor"): one at a time, on the draft (never persisted). It opens
  // from an L1 card on the stack, a rolodex card's Edit or the '+ Custom SLI' card (`create`); `focus` names the
  // field to land on (an SLO card lands on the objective); `opener` the focus key focus returns to on close.
  openEditor({ key = null, custom = false, create = false, focus = null, opener = null } = {}) {
    const b = state.build;
    if (!create && !key) return;
    b.editor = create ? { create: true } : { key, custom: !!custom };
    buildEditorOpener = opener ? focusKeySelector(opener) : null;
    buildEditorOpenerKey = opener || null;
    // An existing SLI opens on the dialog's first field (Behavior leads; the id is a generated output now).
    buildEditorFocus = focus || (create ? 'name' : 'first');
    rerenderBuild();
  },
  closeEditor() {
    const b = state.build;
    if (!b.editor) return;
    b.editor = null;
    b.customDraftErrors = null;
    returnFocusToOpener();
    rerenderBuild();
  },
  // The layer sheet: one at a time, remembered on the draft (never persisted); focus
  // moves into the sheet when it opens and returns to the slab head when it closes.
  // `entry` (a seed-card chip): the L1 sheet lands on that product's first SLI card.
  openSheet(layerId, { entry = null } = {}) {
    const b = state.build;
    if (!layerId) return;
    buildSheetEntering = layerId !== b.sheetOpen;
    b.sheetOpen = layerId;
    buildFocusNext = entry ? `.build-sheet .build-rolo-card[data-entry="${CSS.escape(entry)}"] [data-edit-sli]` : '.build-sheet';
    rerenderBuild();
  },
  closeSheet() {
    const b = state.build;
    if (!b.sheetOpen) return;
    const layer = b.sheetOpen;
    b.sheetOpen = null;
    buildFocusNext = `.build-slab[data-layer="${CSS.escape(layer)}"] .build-slab-edge`;
    rerenderBuild();
  },
  setStep: goToBuildStep,
  exit: exitBuildMode,
  // VERIFY: one compile target previewed from the generated canonical —
  // nothing registered, nothing deployed.
  async preview(target) {
    const b = state.build;
    if (!b.result) return;
    b.preview = { target, label: target, filename: '', content: null, loading: true };
    rerenderBuild();
    const canonical = b.result.canonical;
    let res;
    try { res = await compileBuildPreview(canonical, target); }
    catch (e) { res = { ok: false, error: e.message }; }
    if (state.build !== b || b.result?.canonical !== canonical || b.preview?.target !== target) return;
    b.preview = res?.ok
      ? { target, label: res.label, filename: res.artifact.filename, contentType: res.contentType, content: res.artifact.content, warnings: res.artifact.warnings || [], profile: res.artifact.profile || null }
      : { target, label: target, filename: '', content: null, error: res?.error || (res?.errors || []).join('; ') || 'compile failed' };
    rerenderBuild();
  },
  async downloadArtifact(target) {
    const b = state.build;
    if (!b.result) return;
    const p = b.preview?.target === target && b.preview.content != null ? b.preview : null;
    if (p) { downloadText(p.filename, p.content, p.contentType); return; }
    try {
      const res = await compileBuildPreview(b.result.canonical, target);
      if (!res?.ok) throw new Error(res?.error || 'compile failed');
      downloadText(res.artifact.filename, res.artifact.content, res.contentType);
    } catch (e) { toast(`Could not compile ${target}: ${e.message}`, 'error'); }
  },
  // The hand-off: register the pack the way an upload is registered and
  // switch to the analysis journey with it selected — Discover, the layers
  // view — saying how many placeholders remain (the todos travel with the
  // pack in metadata.annotations; the summary keeps onPlaceholder honest).
  async openInDiscover() {
    const b = state.build;
    if (!b.result) return;
    const canonical = b.result.canonical;
    let res;
    try { res = await registerBuiltPack(canonical); }
    catch (e) { res = { ok: false, errors: [e.message] }; }
    if (!res?.ok) { toast(`Could not register the pack: ${(res?.errors || [res?.error || 'unknown error']).join('; ')}`, 'error'); return; }
    const id = res.registered.id;
    b.registeredId = id;
    const left = placeholdersRemaining(b.result);
    const onPh = res.summary?.onPlaceholder?.length || 0;
    try { await refreshCatalogue(); } catch (e) { toast(`Registered, but the catalog did not refresh: ${e.message}`, 'error'); }
    // Build ends by writing the service row (docs/STORE_PLAN.md §6, slice 6a; design §6.1): the register linked the
    // pack by its service's slug and created the row when none existed — tier null, owners []. The tier and the
    // owners typed on DEFINE go onto that row only where it has none (a person's values are never overwritten; a
    // differing tier is said), and never onto a row that is not the record Build was opened from (a renamed record
    // or an explicit slug lands the pack under another service — named, not repaired: there is no re-link by id).
    // The pack IS registered whatever happens here: nothing below throws out of the hand-off.
    const handoff = await writeServiceRowAfterRegister(b, id);
    state.pack = res.adapted;
    state.conformance = withPlaceholderPasses(res);
    state.symbolTable = buildSymbolTable(res.adapted);
    await loadVerdicts(res.registered?.id);
    state.uploadedSource = res.registered.source;
    state.mode = 'single';
    state.view = 'layers';
    state.layerFilter = 'all';
    const annotatedEnv = canonical.metadata?.annotations?.['library.environment'] || null;
    const env = annotatedEnv || defaultEnvFor(id);
    // The workspace is bound to the service the pack landed under (the origin when it landed elsewhere) and the environment DEFINE named.
    if (handoff) { state.serviceId = handoff.serviceId; state.serviceEnv = b.environment || env; }
    // enterAnalyzeMode refetches the pack and its conformance report, which
    // names the placeholder passes itself for a library-built pack.
    enterAnalyzeMode(id, env);
    paintObservaActiveTab();
    // The hand-off says what the pack now is: the same kind of pack the check journey inspects.
    // Never "every placeholder is filled" while a clause still rests on one or a todo is left.
    const todosLeft = b.result.todos.length;
    const gaps = [
      left ? `${left} placeholder value${left === 1 ? '' : 's'}` : '',
      onPh ? `${onPh} clause${onPh === 1 ? '' : 's'} passing only on a placeholder` : '',
      todosLeft ? `${todosLeft} todo${todosLeft === 1 ? '' : 's'} to write or measure` : '',
    ].filter(Boolean);
    const opened = `Opened ${canonical.metadata.name} in Discover — the same kind of pack you inspect and improve there. `
      + (gaps.length ? `It carries ${gaps.length > 1 ? `${gaps.slice(0, -1).join(', ')} and ${gaps[gaps.length - 1]}` : gaps[0]} as visible gaps.` : 'Every value is filled and no clause rests on a placeholder.')
      + (handoff?.sentence || '');
    toast(opened);
    announce(opened);
  },
};

// The service row after a register (design §6.1 steps 1–5), from the table refreshCatalogue() just re-read:
// the row whose primary link is the registered pack, the plan over it (services-model.mjs buildHandoffPlan —
// pure), the PATCH when the plan has one, and what the hand-off says. Returns null in a bundle (no table
// exists there — nothing to say), else { serviceId, sentence }. A refusal of the PATCH is the server's
// sentence in a toast (a 401/403 auth/role also downgrades the rank the affordances draw from) and the
// hand-off goes on — the pack is registered; a retry must not re-register.
async function writeServiceRowAfterRegister(build, packId) {
  if (state.servicesStatus?.kind === 'static') return null;
  const tableRead = Array.isArray(state.services);
  if (!tableRead) toast(`Registered, but the services table did not refresh: ${state.servicesStatus?.error || 'no answer'}`, 'error');
  const row = tableRead ? state.services.find(s => (s.packs || []).some(p => p.id === packId && p.role === 'primary')) || null : null;
  const origin = build.serviceId != null ? (findServiceRecord(build.serviceId) || { id: build.serviceId, name: null, slug: null }) : null;
  const plan = buildHandoffPlan(build, row, { origin, tableRead });
  let changed = [];
  if (row && Object.keys(plan.patch).length) {
    try {
      const res = await patchService(row.id, plan.patch);
      changed = res.changed;
      if (res.service) state.services = state.services.map(s => (s.id === row.id ? res.service : s));
      forgetServiceVerdicts(row);   // the tier grades the pack: the cached reports are stale (A-M3)
    } catch (e) {
      toast(`Registered, but the service row was not written: ${e.message}`, 'error');
      if (e.denied === 'auth' || e.denied === 'role') state.access = { ...(state.access || {}), canWrite: false, reason: e.message };
    }
  }
  const serviceId = (plan.outcome === 'other-service' ? origin?.id : row?.id) ?? null;
  return { serviceId, sentence: plan.sentence(changed) };
}

// Drop every cached verdict of a service's packs: a tier written on the row changes what every report grades at.
function forgetServiceVerdicts(service) {
  const ids = new Set((service?.packs || []).map(p => p.id));
  for (const key of Object.keys(state.serviceVerdicts || {})) {
    if (ids.has(key.split('::')[0])) delete state.serviceVerdicts[key];
  }
}

// The slug guard's inputs (design §6.4, T19): the record DEFINE was prefilled from (state.build.serviceId) and the
// service keys of `name` and of the record's name — the key rule is /lib/service-keys.mjs, bound at boot, so the
// pure model takes the computed keys, not the function.
function buildDefineOrigin(name) {
  const origin = state.build.serviceId != null ? findServiceRecord(state.build.serviceId) : null;
  if (!origin) return { origin: null, nameKey: null, originNameKey: null };
  return { origin: { id: origin.id, slug: origin.slug, name: origin.name }, nameKey: normalizeServiceKey(name) || null, originNameKey: normalizeServiceKey(origin.name) || null };
}

// The host the Build renderers get (docs/UI_CONVENTIONS.md §3): the two stable hooks plus the journey's actions.
const buildHost = { renderMainView, renderTabs, build: buildActions };

// The build view — the pack is the axis (docs/BUILD_JOURNEY.md "The axis"): the
// definition column on the left (service, tier, entries, the conformance summary,
// sticky), the step with the stack as the main surface on the right, and, when a
// layer is open, its sheet over the stack (one component on the three steps; its
// mode follows the step: live on Define and Compile, read-only on Verify). The
// pop-up editor is drawn after this, into its own host (syncBuildEditor).
function renderBuildView(view) {
  const b = state.build;
  const shell = document.createElement('div');
  shell.className = `build-shell build-step-${b.step}${b.pending ? ' is-pending' : ''}${b.sheetOpen ? ' has-sheet' : ''}`;
  const exitBar = document.createElement('div');
  exitBar.className = 'build-exit';
  // Where leaving goes, said plainly: the open pack, or home (where the journeys are chosen).
  exitBar.innerHTML = `<button type="button" class="build-exit-btn" title="Leave the Build journey — your definition is kept">← ${escapeHtml(buildExitLabel())}</button>`;
  exitBar.querySelector('button').addEventListener('click', exitBuildMode);
  const def = document.createElement('aside');
  def.className = 'build-def';
  def.setAttribute('aria-label', 'Pack definition');
  const main = document.createElement('div');
  main.className = 'build-main';
  shell.append(exitBar, def, main);
  view.appendChild(shell);

  const library = buildLibraryCache();
  if (!library) {
    main.innerHTML = '<div class="placeholder">Loading the library…</div>';
    loadBuildLibrary().then(() => { if (state.mode === 'build') rerenderBuild(); })
      .catch(e => { main.innerHTML = `<div class="error">Could not load the pack library: ${escapeHtml(e.message)}</div>`; });
    return;
  }
  const requirements = buildRequirementsCache();
  const clauses = requirements[b.tier] || [];
  if (!clauses.length) ensureBuildRequirements(b.tier);
  const host = buildHost;
  const checklist = buildClauseChecklist(clauses, b.result?.summary || null);
  const definition = buildDefinitionModel({ build: b, library, requirements, checklist });
  renderBuildDefinition(def, definition, host);
  // The status line goes to the one persistent live region (#build-status, outside this
  // re-rendered tree) and only when it changed: the summary block itself is rebuilt on every
  // re-render, so a live region on it announced nothing, or the whole block after each keystroke.
  const status = buildStatusLine(definition.summary);
  const live = document.getElementById('build-status');
  if (live && status && live.textContent !== status) live.textContent = status;

  const stepEl = document.createElement('div');
  stepEl.className = 'build-step-host';
  main.appendChild(stepEl);
  let stack;
  switch (b.step) {
    case 'verify': {
      const m = buildVerifyModel({ build: b, library, clauses, targets: buildTargets || [], access: state.access || { canWrite: true } });
      stack = m.stack;
      renderBuildVerify(stepEl, m, host);
      break;
    }
    case 'compile': {
      const m = buildCompileModel({ build: b, library, clauses });
      stack = m.stack;
      renderBuildCompile(stepEl, m, host);
      break;
    }
    case 'define':
    default: {
      const m = buildDefineModel({ build: b, library, requirements, ...buildDefineOrigin(b.name) });
      stack = m.stack;
      renderBuildDefine(stepEl, m, host);
      break;
    }
  }
  if (b.sheetOpen) {
    // In the main column: the scrim dims the stack only (the definition column stays live),
    // the panel itself is fixed to the viewport's right edge.
    const sheetEl = document.createElement('div');
    sheetEl.className = 'build-sheet-host';
    main.appendChild(sheetEl);
    renderBuildSheet(sheetEl, buildSheetModel({ layerId: b.sheetOpen, build: b, library, requirements: clauses, stack, checklist, mode: sheetModeFor(b.step), entering: buildSheetEntering }), host);
  }
  buildSheetEntering = false;   // the entrance plays once
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
  // Opened from a service page with no pack (design §5.4): one sentence for
  // the rank — an operator is offered Build with DEFINE prefilled, a viewer
  // told who registers one.
  const bound = state.serviceId ? findServiceRecord(state.serviceId) : null;
  const note = discoverEmptyNote({ service: bound, env: state.serviceEnv, access: state.access });
  view.innerHTML = `
    <section class="discover-empty">
      <header class="discover-empty-head">
        <h2 class="discover-empty-title">What do we have?</h2>
        ${note ? `<p class="discover-empty-service" id="discover-empty-service">${escapeHtml(note.text)}${note.build ? ' <button type="button" class="ux-secondary-btn" id="discover-empty-build">Build one</button>' : ''}</p>` : ''}
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
          <span class="discover-load-sub">an existing canonical v1.4 YAML or JSON manifest</span>
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
  view.querySelector('#discover-empty-build')?.addEventListener('click', () => openBuild({ serviceId: state.serviceId, env: state.serviceEnv }));
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
  const mcpUrl = recallMcpUrl() || DEFAULT_MCP_URL;

  // One question, two journeys. The signed-in gate opens on the user's
  // services — the records of the services table, or the services the
  // loaded packs name where the table is unavailable (services-view.mjs
  // renderServicesHome); the check branch is otherwise remembered from last time.
  const model = homeServicesModel();
  const hasServices = model.kind === 'table' || model.derived.length > 0;
  const checkOpen = (state.homeVariant === 'gate' && hasServices) || homeCheckRemembered();
  view.innerHTML = `
    <section class="home-hero">
      ${homeGreetingHtml()}
      <h1 class="home-hero-title" id="home-title">What would you like to do?</h1>
      <p class="home-hero-lede">
        ${escapeHtml(state.brand.chrome.name)} compares what a service's repository <em>declares</em> with
        what the live platform <em>verifies</em>, and helps you close the gap.
      </p>

      ${homeChoiceHtml({ checkOpen })}
      <div class="home-check" id="home-check"${checkOpen ? '' : ' hidden'}>
        <div class="home-services" id="home-services"></div>
        <h2 class="home-check-title home-check-sources-title">Import or scan another source</h2>
        <div class="home-sources" id="home-sources"></div>
      </div>
    </section>
  `;
  renderServicesHome(view.querySelector('#home-services'), model, servicesHost);
  // The import sources live inside the check branch.
  const sources = view.querySelector('#home-sources');
  sources.innerHTML = `
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
            <span class="home-mcp-adopt-sub" id="home-mcp-adopt-hint">canonical v1.4 · ready to compile and deploy</span>
          </button>
        </div>
      </div>

      <div class="home-alt">
        <div class="home-alt-buttons">
          <button id="home-shortcut-upload" type="button" class="home-alt-btn">
            <span class="home-alt-key" aria-hidden="true">▤</span>
            <span class="home-alt-label">Upload a pack file</span>
            <span class="home-alt-sub">a YAML or JSON manifest (spec v1.4) — or drop it anywhere on the page</span>
          </button>
          <button id="home-shortcut-crawl" type="button" class="home-alt-btn">
            <span class="home-alt-key" aria-hidden="true">↻</span>
            <span class="home-alt-label">Scan a service repository</span>
            <span class="home-alt-sub">reads its Prometheus, OpenTelemetry, Grafana and Alertmanager configuration — a folder or a GitHub URL</span>
          </button>
        </div>
      </div>
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
  // The header (and its upload popover) is hidden on home: go straight to the file picker.
  $('#home-shortcut-upload').onclick = () => $('#file-input')?.click();
  $('#home-shortcut-crawl').onclick  = () => $('#crawl-btn')?.click();
  // The three sources are operator routes (POST /api/draft-from-mcp, /api/validate,
  // /api/crawl): a rank without them sees the buttons drawn unavailable with the
  // reason and every activation explains; the URL field stays editable (a
  // viewer may paste a URL for Pack B, a viewer read).
  if (!model.sources.enabled) {
    const explain = () => explainUnavailable(model.sources.reason);
    for (const id of ['home-mcp-connect', 'home-shortcut-upload', 'home-shortcut-crawl']) {
      const btn = $(`#${id}`);
      // The Connect button is a filled action with no room for a line: its reason sits in the status slot beside it.
      markUnavailable(btn, model.sources.reason, { into: id === 'home-mcp-connect' ? $('#home-mcp-status') : btn });
      btn.onclick = explain;
    }
    $('#home-mcp-url').onkeydown = (e) => { if (e.key === 'Enter') explain(); };
  }
  paintHomeMcpTarget();
  wireHomeChoice(view, model);
  loadHomeVerdicts(model);
}

// The home's source card lists the org's MCP endpoints (D-J) for a rank that
// may connect, in the identity and open postures: read once, then only the
// picker is repainted when the read settles; a re-render reuses the list. An
// empty list, a refusal or a failure leaves today's card (the URL typed).
let homeMcpEndpointsRead = false;
function paintHomeMcpTarget() {
  paintMcpTarget('home');
  if (homeMcpEndpointsRead || state.mcpEndpoints !== null || !mcpPickersReadable() || state.access?.canWrite === false) return;
  homeMcpEndpointsRead = true;
  readMcpEndpointsForPickers().then((list) => {
    if (list?.length && document.getElementById('home-mcp-url')) paintMcpTarget('home');
  });
}

async function doHomeMcpConnect() {
  const urlInput  = $('#home-mcp-url');
  const statusEl  = $('#home-mcp-status');
  const goBtn     = $('#home-mcp-connect');
  const capEl     = $('#home-mcp-capabilities');
  const adoptBar  = $('#home-mcp-adopt-bar');
  if (!urlInput || !statusEl) return;

  const { body: target, chosen } = mcpTargetOf('home');
  if (!target) {
    statusEl.textContent = 'choose an MCP endpoint or type a URL';
    statusEl.className = 'home-mcp-status is-error';
    return;
  }
  if (target.mcpUrl) rememberMcpUrl(target.mcpUrl).catch(() => {});

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
        ...target,
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
    rememberMcpEndpoint(chosen ? chosen.id : null);
    draftMcpState.lastResult = out;
    followReplacedPack(out.registered?.id).catch(() => {});

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
  const toolsFailed = (status.toolsFailed || '').trim();
  // A probe family that got no answer is a hole in the live picture —
  // the badge goes red for it exactly as for a failed core tool.
  const probesFailed = (status.probesFailed || '').trim();
  // Families this MCP tier doesn't expose at all: a restriction, not an
  // error — named in the title, never a colour state of its own.
  const probesUnsupported = (status.probesUnsupported || '').trim();
  const errored = toolsFailed !== '' || probesFailed !== '';
  btn.dataset.mcpState = errored ? 'error' : stale ? 'stale' : 'fresh';
  ageEl.textContent = fmtRelative(status.refreshedAt) || '—';
  const errorBits = [
    toolsFailed ? `tools: ${toolsFailed}` : '',
    probesFailed ? `probes with no answer: ${probesFailed}` : '',
  ].filter(Boolean);
  const title = errored
    ? `MCP refresh had errors (${errorBits.join('; ')})`
    : `Last refresh ${fmtRelative(status.refreshedAt)} from ${status.url || status.origin || 'unknown'}`;
  btn.title = probesUnsupported
    ? `${title} · restricted tier: families ${probesUnsupported} not exposed`
    : title;
}

function renderMcpStatusBody(status) {
  const el = $('#mcp-status-body');
  if (!el) return;
  if (!status?.present) {
    el.innerHTML = '<em>No live pack for this org yet — refresh from an MCP server.</em>';
    return;
  }
  const rows = [
    ['refreshed',  status.refreshedAt ? `${fmtRelative(status.refreshedAt)} (${escapeHtml(status.refreshedAt)})` : '—'],
    ['mcp url',    status.url || status.origin || '—'],   // url: operators only
    ['tools called',  status.toolsCalled || '—'],
    ['tools failed',  status.toolsFailed || 'none'],
    ['probes failed', status.probesFailed || 'none'],
    ['not exposed',   status.probesUnsupported || 'none'],
    ['services',   status.servicesDiscovered || '—'],
    ['baselines',  status.baselinesComputed || '0'],
    ['anomalies',  status.activeAnomalies   || '0'],
  ];
  el.innerHTML = '<dl>' + rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${k === 'refreshed' ? v : escapeHtml(v)}</dd>`).join('') + '</dl>';
}

// ---------- the MCP pickers: a registered endpoint, or a typed URL (design §6) ----------
//
// Four pickers — the refresh panel, the draft panel, the deploy modal (its
// rollback and its post-deploy verify ride it) and the home's source card —
// draw the org's registered MCP endpoints before their URL field
// (renderMcpTarget over mcpTargetModel), list first and preselected, "Type a
// URL…" last. With an endpoint chosen the URL row is hidden (its value kept)
// and the request names it by id (mcpTargetBody: an id or a URL, never
// both); the read token stays on the server, named by the record. The list
// (state.mcpEndpoints) is read in the identity and open postures only — the
// bundle and the token posture never read it, and keep the typed URL.
const MCP_PICKERS = {
  refresh: { url: 'mcp-url', auth: 'mcp-auth', purpose: 'read', field: 'mcp-field', key: 'mcp-field-key', hint: true },
  draft: { url: 'draft-mcp-url', auth: 'draft-mcp-auth', purpose: 'read', field: 'mcp-field', key: 'mcp-field-key', hint: true },
  deploy: { url: 'deploy-target-mcp', auth: 'deploy-target-auth', purpose: 'write', field: 'deploy-field', key: 'deploy-field-key', hint: true },
  // D-J: the home reads the list for a rank that may connect, and says
  // nothing when the org has none (today's card, the demo URL typed).
  home: { url: 'home-mcp-url', auth: 'home-mcp-auth', purpose: 'read', field: 'home-mcp-url-row', key: 'home-mcp-url-label', hint: false, needsWrite: true },
};

function mcpPickersReadable() {
  const posture = state.access?.posture;
  return posture === 'identity' || posture === 'open';
}

// The empty list's way to Settings → MCP endpoints, for a reader known to be
// an admin of the org (C-7: never guessed — the open postures may close it).
function mcpPickerCanAdmin() {
  return state.access?.posture === 'identity' && state.access?.role === 'admin';
}

// GET /api/mcp-endpoints for the pickers. Silent: a refusal or a failure
// leaves the typed URL alone (state.mcpEndpoints null), and Settings is
// where a failed read is said. `keep` keeps the list already read when this
// read fails (the pre-send check: its own sentence says it could not check).
async function readMcpEndpointsForPickers({ keep = false } = {}) {
  if (!mcpPickersReadable()) return null;
  try {
    state.mcpEndpoints = await loadMcpEndpoints();
    return state.mcpEndpoints;
  } catch {
    if (!keep) state.mcpEndpoints = null;
    return null;
  }
}

// The picker's slot before its URL row (created once per row: the home's is
// drawn anew with its card), in the host's own field idiom.
function mcpTargetSlot(id) {
  const p = MCP_PICKERS[id];
  const row = document.getElementById(p.url)?.closest('label');
  if (!row?.parentElement) return null;
  const prev = row.previousElementSibling;
  if (prev?.dataset?.mcpTarget === id) return prev;
  const slot = document.createElement('div');
  slot.className = p.field;
  slot.dataset.mcpTarget = id;
  slot.hidden = true;
  slot.innerHTML = `<span class="${p.key}" aria-hidden="true">Registered MCP endpoint</span><div class="mcp-target-body" hidden></div>`;
  row.before(slot);
  return slot;
}

function mcpPickerModel(id, chosen = null) {
  const p = MCP_PICKERS[id];
  const readable = mcpPickersReadable() && (!p.needsWrite || state.access?.canWrite !== false);
  const model = mcpTargetModel({
    endpoints: readable ? state.mcpEndpoints : null,
    remembered: recallMcpEndpoint(),
    liveUrl: state.mcpStatus?.url || null,
    // The remembered typed URL — or, in the deploy modal (which remembers
    // none), what its field holds (a profile's URL).
    typedUrl: id === 'deploy' ? (document.getElementById(p.url)?.value || '') : (recallMcpUrl() || ''),
    purpose: p.purpose, orgName: state.orgName, canAdmin: mcpPickerCanAdmin(), chosen,
  });
  return p.hint ? model : { ...model, hint: null };
}

// The URL row and the auth field's help follow the choice: an endpoint hides
// the URL row (its value kept) and says where the token comes from.
function applyMcpTargetChoice(id, model) {
  const p = MCP_PICKERS[id];
  const row = document.getElementById(p.url)?.closest('label');
  if (row) row.hidden = !model.showUrl;
  if (id === 'home') {
    const urlKey = row?.querySelector('.home-mcp-url-label');
    if (urlKey) urlKey.textContent = model.show ? 'MCP URL' : 'MCP endpoint';
  }
  const key = document.getElementById(p.auth)?.closest('label')?.querySelector('span');
  if (!key) return;
  if (key.dataset.mcpKeyHtml === undefined) key.dataset.mcpKeyHtml = key.innerHTML;
  if (!model.authHelp) { key.innerHTML = key.dataset.mcpKeyHtml; return; }
  if (p.purpose === 'write') { key.textContent = model.authHelp; return; }
  const label = [...key.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim())?.textContent.trim() || 'Auth token';
  key.innerHTML = `${escapeHtml(label)} <em>${escapeHtml(model.authHelp)}</em>`;
}

// (Re)draw a picker: the person's choice in it is kept across a repaint
// while its endpoint is listed; `chosen` replaces it ('' = Type a URL…).
function paintMcpTarget(id, { chosen } = {}) {
  const slot = mcpTargetSlot(id);
  if (!slot) return;
  const body = slot.querySelector('.mcp-target-body');
  const current = body.querySelector('select.set-mcp-target')?.value;
  const model = mcpPickerModel(id, chosen !== undefined ? chosen : (current ?? null));
  renderMcpTarget(body, model, settingsHost);
  slot.hidden = body.hidden;
  applyMcpTargetChoice(id, model);
  if (id === 'deploy') updateDeployTargetSummary();
}

// What a picker would send: { body, chosen, url } — `chosen` is the
// endpoint as its option shows it ({ id, name, origin }), null when typed.
function mcpTargetOf(id) {
  const p = MCP_PICKERS[id];
  const slot = document.querySelector(`[data-mcp-target="${id}"]`);
  const sel = slot && !slot.hidden ? slot.querySelector('select.set-mcp-target') : null;
  const value = sel?.value || '';
  const opt = value ? sel.selectedOptions?.[0] : null;
  const chosen = opt ? { id: Number(value), name: opt.dataset.name, origin: opt.dataset.origin } : null;
  const url = document.getElementById(p.url)?.value ?? '';
  const auth = document.getElementById(p.auth)?.value ?? '';
  return { body: mcpTargetBody(value, url, auth), chosen, url: url.trim() };
}

// The deploy modal's target — Deploy, rollback and the post-deploy verify
// all send it.
function deployTargetBody() {
  return mcpTargetOf('deploy').body;
}

// Before a write is sent (C-3): the chosen endpoint is re-read; when its
// origin moved, or it is gone, nothing is sent — the picker is repainted
// (the option names the new origin; a gone one falls back to Type a URL…)
// and the sentence says why. null: send.
async function checkEndpointDrift(id) {
  const { chosen } = mcpTargetOf(id);
  if (!chosen) return null;
  const list = await readMcpEndpointsForPickers({ keep: true });
  const drift = endpointDrift(chosen, list, { orgName: state.orgName });
  if (drift && Array.isArray(list)) {
    paintMcpTarget(id, { chosen: list.some((ep) => ep.id === chosen.id) ? String(chosen.id) : '' });
  }
  return drift;
}

// A picker opening: drawn from the list already read, then — when the list
// is unread, or `fresh` (the deploy modal: every open) — read and redrawn.
function openMcpTarget(id, { fresh = false } = {}) {
  paintMcpTarget(id);
  if (!mcpPickersReadable() || (!fresh && state.mcpEndpoints !== null)) return;
  readMcpEndpointsForPickers().then(() => paintMcpTarget(id));
}

// The focus a picker opens on: the URL field, or the select while it hides it.
function focusMcpTarget(id) {
  const url = document.getElementById(MCP_PICKERS[id].url);
  if (url && !url.closest('label')?.hidden) url.focus();
  else document.querySelector(`[data-mcp-target="${id}"] select.set-mcp-target`)?.focus();
}

// The picker's change (host.settings.pickMcpTarget): the URL row and the
// auth help follow; the select is not redrawn under the focus.
function pickMcpTarget(container, value) {
  const id = container?.closest?.('[data-mcp-target]')?.dataset?.mcpTarget;
  if (!MCP_PICKERS[id]) return;
  applyMcpTargetChoice(id, mcpPickerModel(id, value));
  if (id === 'deploy') updateDeployTargetSummary();
  if (value === '') document.getElementById(MCP_PICKERS[id].url)?.focus();
}

// The empty list's button: Settings → MCP endpoints, the pickers' panels closed first.
function openMcpEndpointsFromPicker() {
  closeMcpPanel();
  const draft = $('#draft-mcp-panel');
  if (draft) draft.hidden = true;
  if ($('#deploy-modal') && !$('#deploy-modal').hidden) closeDeployModal();
  enterSettings('endpoints');
}

function openMcpPanel() {
  const panel = $('#mcp-panel');
  if (!panel) return;
  panel.hidden = false;
  $('#mcp-btn').setAttribute('aria-expanded', 'true');
  const urlInput = $('#mcp-url');
  // pre-fill: saved value > server-known value > empty
  if (!urlInput.value) {
    const saved = recallMcpUrl();                 // this user, this org
    const liveUrl = state.mcpStatus?.url || null; // served to operators only
    urlInput.value = saved || liveUrl || '';
  }
  openMcpTarget('refresh');
  focusMcpTarget('refresh');
}
function closeMcpPanel() {
  const panel = $('#mcp-panel');
  if (panel) panel.hidden = true;
  const btn = $('#mcp-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

async function refreshLive() {
  const { body: target, chosen } = mcpTargetOf('refresh');
  if (!target) {
    setRefreshStatus('choose an MCP endpoint or type a URL', 'error');
    return;
  }
  // A typed URL is remembered (its safe form); an endpoint's choice is, on success.
  const dropped = target.mcpUrl ? await rememberMcpUrl(target.mcpUrl).catch(() => []) : [];
  const btn = $('#mcp-refresh-btn');
  btn.disabled = true;
  $('#mcp-btn').dataset.mcpState = 'active';
  setRefreshStatus('contacting mcp…');
  try {
    const r = await fetch('/api/refresh-live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(target),
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
    rememberMcpEndpoint(chosen ? chosen.id : null);
    // Say what was not kept: the server's note (the live pack) and ours
    // (the remembered URL) — and the endpoint the server went through.
    setRefreshStatus([
      `refreshed · ${fmtRelative(body.refreshedAt)}`,
      body.mcpEndpoint?.name ? `through ${body.mcpEndpoint.name}` : null,
      body.note || null,
      dropped.length ? `remembered without its ${dropped.map((n) => `"${n}"`).join(', ')} parameter${dropped.length === 1 ? '' : 's'} — put the token in the auth field` : null,
    ].filter(Boolean).join(' · '), 'ok');
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
      await refreshCatalogue();
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

// Which files a scan reads — the extensions, the size cap and the folders it
// never enters — is the crawler library's rule (scanReadsPath, scanSkipsName),
// the same one the CLI walker applies, so a folder gives the same pack
// whether it is picked, dropped or scanned from a terminal.
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
  ignored: 0,             // files under folders a scan never enters (node_modules, dist, dot-folders…): not read
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

  pickFolderBtn.onclick = () => pickScanFolder(folderInput);
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
      const lib = await getCrawlerLib();
      for (const ent of entries) await readEntry(ent, '', lib);
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

// Read a single FileSystemEntry recursively into the staged map. The dropped
// folder itself (no prefix yet) is the user's choice whatever its name; below
// it the scan rule decides.
async function readEntry(entry, prefix, lib) {
  if (!entry) return;
  if (entry.isFile) {
    if (lib.scanSkipsName(entry.name) || !lib.SCAN_EXT.test(entry.name)) return;
    const file = await new Promise((res, rej) => entry.file(res, rej));
    if (file.size > lib.SCAN_MAX_FILE_BYTES) return;
    const rel = (prefix ? `${prefix}/` : '') + entry.name;
    const text = await file.text();
    crawlState.files.set(rel, text);
    if (!crawlState.rootName) crawlState.rootName = entry.fullPath?.split('/')[1] || null;
  } else if (entry.isDirectory) {
    if (prefix && lib.scanSkipsName(entry.name, { dir: true })) { crawlState.ignored++; return; }
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const ent of batch) await readEntry(ent, (prefix ? `${prefix}/` : '') + entry.name, lib);
    } while (batch.length > 0);
  }
}

// "pick a folder". Where the browser can hand over the folder itself
// (showDirectoryPicker: Chromium, a secure context such as localhost) the
// studio walks it and never enters node_modules, so a large repository is
// staged in the time it takes to read its own sources. Elsewhere — Firefox,
// Safari, plain http on a LAN address, a frame the API is refused in — the
// folder input lists every file under the folder first (stageFileList).
async function pickScanFolder(folderInput) {
  if (typeof window.showDirectoryPicker !== 'function') { folderInput.click(); return; }
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'observogram-scan', mode: 'read' });
  } catch (e) {
    // AbortError: the dialog was closed. Anything else: the API is there but
    // refused here — the input still works.
    if (e?.name !== 'AbortError') folderInput.click();
    return;
  }
  await stageFolderHandle(dir);
}

async function stageFolderHandle(dir) {
  const lib = await getCrawlerLib();
  const list = $('#crawl-staged-files');
  const say = (n) => { if (list) list.innerHTML = `<span class="crawl-staged-empty">reading ${escapeHtml(dir.name || 'the folder')}… ${n} file${n === 1 ? '' : 's'}</span>`; };
  let read = 0;
  say(0);
  try {
    crawlState.ignored += await lib.walkScanFolder(dir, async (rel, handle) => {
      const file = await handle.getFile();
      if (file.size > lib.SCAN_MAX_FILE_BYTES) return;
      crawlState.files.set(rel, await file.text());
      if (++read % 25 === 0) say(read);
    });
  } catch (e) {
    // A file removed or locked mid-walk: what was read is still staged.
    toast(`Stopped reading the folder: ${e.message}`, 'error');
  }
  if (!crawlState.rootName) crawlState.rootName = dir.name || null;
  finalizeStaging();
}

async function stageFileList(fileList, _rootHint) {
  // Taken now: the caller clears its input as soon as this returns its promise.
  const files = [...fileList];
  const lib = await getCrawlerLib();
  const list = $('#crawl-staged-files');
  const total = files.length;
  let seen = 0;
  for (const f of files) {
    // The folder picker lists every file under the folder — node_modules,
    // build output, agent worktrees — so the scan rule is applied to the
    // PATH before anything is read. webkitRelativePath is set when picked
    // via webkitdirectory; its first segment is the picked folder's name.
    const rel = f.webkitRelativePath || f.name;
    if (++seen % 2000 === 0 && list) list.innerHTML = `<span class="crawl-staged-empty">reading the folder… ${seen} of ${total} files</span>`;
    if (!lib.scanReadsPath(rel, { skipRoot: !!f.webkitRelativePath })) {
      if (lib.SCAN_EXT.test(f.name)) crawlState.ignored++;
      continue;
    }
    if (f.size > lib.SCAN_MAX_FILE_BYTES) continue;
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
    ${crawlState.ignored ? `<div class="crawl-staged-ignored">${crawlState.ignored} ${crawlState.ignored === 1 ? 'entry' : 'entries'} under dependency, build or hidden folders (node_modules, dist, .git, .claude …) ${crawlState.ignored === 1 ? 'was' : 'were'} not read.</div>` : ''}
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
  crawlState.ignored = 0;
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
    followReplacedPack(out.registered?.id).catch(() => {});
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
    followReplacedPack(out.registered?.id).catch(() => {});
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
      ? `<div class="crawl-pill crawl-pill-ok">✓ valid v1.4</div>`
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
  // An entry the scan or draft route registered arrives as its id alone
  // (registeredOrValidated): enterAnalyzeMode / enterCompareMode load it.
  if (res.adapted) {
    state.pack = res.adapted;
    state.conformance = withPlaceholderPasses(res);
    state.symbolTable = buildSymbolTable(res.adapted);
    await loadVerdicts(res.registered?.id);
  }
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

  await refreshCatalogue();
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

// A scan or draft that carries the label of an earlier one replaces it on
// the server (registerUploadedPack drops the older id), and adopting selects
// that labelled entry — so the pack it replaced can be the one on screen.
// Pack A or Pack B then follows to the new id; left alone it would name a
// pack that no longer exists. Both gone at once is a reset, not a
// replacement, and is left as it is.
async function followReplacedPack(newId) {
  if (!newId || (state.mode !== 'single' && state.mode !== 'compare')) return;
  await refreshCatalogue();
  const replaced = (id) => typeof id === 'string' && id.startsWith('uploaded-') && !state.catalog.some(p => p.id === id);
  const aGone = replaced(state.selectedPackId);
  const bGone = replaced(state.compareBId);
  if (aGone === bGone || state.selectedPackId === newId || state.compareBId === newId) return;
  if (aGone) {
    state.selectedPackId = newId;
    state.selectedEnv = defaultEnvFor(newId);
    await refresh();
  } else {
    state.compareBId = newId;
    state.compareBEnv = defaultEnvFor(newId);
    state.packB = null; state.diff = null;
    await loadPackB();
    renderPackBSelect();
  }
  if (state.compareBId) await refreshDiff();
  const label = state.catalog.find(p => p.id === newId)?.label || newId;
  toast(`Pack ${aGone ? 'A' : 'B'} now shows the newer ${label} — it replaced the one that was loaded`);
}

async function adoptCrawlResult() {
  const out = crawlState.lastResult;
  if (!out) return;
  // Route the pack the scan registered into the drift journey (repo scan
  // → Pack A). A scan that failed validation registered nothing: it goes
  // through POST /api/validate, as a yaml file dropped on the studio does,
  // and its errors are the toast.
  try {
    const res = await registeredOrValidated(out, state.selectedEnv);
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
// returns it for review, registered. Adoption selects that entry
// (registeredOrValidated), as a repo scan's does.
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
  // The org's endpoints, re-read on every open (C-3): a write goes where
  // the option shows.
  openMcpTarget('deploy', { fresh: true });
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

// Roll a deploy back to its pre-deploy snapshot (10D). Reuses the modal's
// MCP target (a registered endpoint, re-read before it is sent — C-3 — or
// the typed URL); the result lands in the audit log as its own record
// (rollbackOf) and the history refreshes to show it. A refusal reads as the
// server's sentence (C-1); a result where every restore failed (a 502 with
// its summary) still reads as a result.
async function doRollback(deployId, packId, btn) {
  if (!deployTargetBody()) { toast('Choose an MCP endpoint or type the MCP URL in the target form first', 'error'); return; }
  const moved = await checkEndpointDrift('deploy');
  if (moved) { toast(moved, 'error'); return; }
  if (!confirm(`Roll back ${deployId}?\n\nRestorable artefacts are re-upserted from the pre-deploy snapshot. Anything this deploy created is listed for manual removal.`)) return;
  const drift = await checkEndpointDrift('deploy');
  if (drift) { toast(drift, 'error'); return; }
  const target = deployTargetBody();
  if (!target) return;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/deploys/${encodeURIComponent(deployId)}/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders() },
      body: JSON.stringify(target),
    });
    const r = await res.json().catch(() => null);
    if (res.status === 401 && r?.login) { window.location.assign(r.login); return; }
    const refusal = deployRefusal(res.status, r);
    if (refusal) throw refusal;
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

// ----- Profiles (studio/api.mjs: per user, each URL in its safe form) -----

function setDeployStatus(msg, kind = '') {
  const el = $('#deploy-modal-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'mcp-refresh-status' + (kind ? ' is-' + kind : '');
}
async function populateDeployProfileSelect() {
  const sel = $('#deploy-target-profile');
  const profiles = await loadDeployProfiles();
  sel.innerHTML = '<option value="">(no profile — fill manually)</option>'
    + Object.keys(profiles).sort().map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');
}
async function loadDeployProfile(name) {
  if (!name) return;
  const p = (await loadDeployProfiles())[name];
  if (!p) return;
  $('#deploy-target-url').value     = p.targetUrl || '';
  $('#deploy-target-folder').value  = p.folder || '';
  $('#deploy-target-product').value = p.product || 'grafana';
  $('#deploy-target-version').value = p.version || '12';
  $('#deploy-target-mcp').value     = p.mcpUrl || '';
  // A profile that names an endpoint selects it in the org it belongs to,
  // while it is listed; anywhere else the typed mode, empty, and the note
  // says why (A-12: another org's id is never sent). A typed profile is typed.
  const { select, note } = profileEndpointNote(p, {
    orgId: state.orgId ?? getActiveOrg(), orgName: state.orgName,
    endpoints: mcpPickersReadable() ? state.mcpEndpoints : null, profileName: name,
  });
  if (p.mcpEndpoint) {
    if (select === null) $('#deploy-target-mcp').value = '';
    paintMcpTarget('deploy', { chosen: select === null ? '' : String(select) });
  } else if (p.mcpUrl) {
    paintMcpTarget('deploy', { chosen: '' });
  }
  setDeployStatus(note || '', note ? 'error' : '');
  updateDeployTargetSummary();
}

// The endpoint a saved profile names, with the org it belongs to (A-12) —
// none when the URL is typed.
function chosenEndpointForProfile() {
  const { chosen } = mcpTargetOf('deploy');
  return chosen ? { orgId: state.orgId ?? getActiveOrg() ?? 'default', id: chosen.id, name: chosen.name } : undefined;
}
async function saveDeployProfile() {
  const name = prompt('Profile name (e.g. "Prod Grafana"):', $('#deploy-target-profile').selectedOptions?.[0]?.value || '');
  if (!name) return;
  let note;
  try {
    // Stored stripped (no credential parameter); the field keeps what was
    // typed — this deploy still sends it.
    note = await storeDeployProfile(name, {
      targetUrl: $('#deploy-target-url').value.trim(),
      folder:    $('#deploy-target-folder').value.trim(),
      product:   $('#deploy-target-product').value,
      version:   $('#deploy-target-version').value,
      mcpUrl:    $('#deploy-target-mcp').value.trim(),
      mcpEndpoint: chosenEndpointForProfile(),
    });
  } catch (e) {
    toast(`Profile not saved: ${e.message}`, 'error');
    return;
  }
  await populateDeployProfileSelect();
  $('#deploy-target-profile').value = name;
  updateDeployTargetSummary();
  // What was not kept, if anything, stays on the status line after the toast.
  setDeployStatus(note || '', note ? 'ok' : '');
  toast(`Saved deploy profile: ${name}`);
}
async function deleteDeployProfile() {
  const name = $('#deploy-target-profile').value;
  if (!name) return;
  if (!confirm(`Delete deploy profile "${name}"?`)) return;
  await removeDeployProfile(name);
  await populateDeployProfileSelect();
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
  // The deploy review (compile-view.mjs readDeployReview) says which selected
  // rows a type filter hides — and so will not deploy — from these counts.
  const hiddenSelected = {};
  for (const r of deployModalState.manifest || []) {
    if (!types.has(r.type) && deployModalState.selected.has(r.key)) hiddenSelected[r.type] = (hiddenSelected[r.type] || 0) + 1;
  }
  tbody.dataset.hiddenSelected = JSON.stringify(hiddenSelected);
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
  const folder = $('#deploy-target-folder').value.trim();
  const product = $('#deploy-target-product').value;
  const version = $('#deploy-target-version').value;
  const setStatus = setDeployStatus;
  if (!deployTargetBody()) { setStatus('choose an MCP endpoint or type a URL', 'error'); return; }
  // Deploy what the review shows: a selected row the type filter hides is
  // not counted, not reviewed — and so not deployed.
  const types = new Set([...document.querySelectorAll('#deploy-type-filters input:checked')].map(i => i.value));
  const visible = new Set((deployModalState.manifest || []).filter(r => types.has(r.type)).map(r => r.key));
  const items = [...deployModalState.selected].filter(k => visible.has(k)).map(k => {
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
  if (items.length === 0) { setStatus('select at least one artefact', 'error'); return; }

  deployModalState.inflight = true;
  const goBtn = $('#deploy-modal-go');
  goBtn.disabled = true;
  // A registered endpoint is re-read just before the write (C-3): moved or
  // gone → nothing is sent, and the status line says why.
  const drift = await checkEndpointDrift('deploy');
  const target = drift ? null : deployTargetBody();
  if (!target) {
    if (drift) setStatus(drift, 'error');
    deployModalState.inflight = false;
    goBtn.disabled = false;
    return;
  }
  setStatus(`deploying ${items.length} artefact${items.length === 1 ? '' : 's'}…`);

  try {
    const qs = new URLSearchParams();
    if (state.selectedEnv) qs.set('env', state.selectedEnv);
    const path = `/api/packs/${encodeURIComponent(deployModalState.packId)}/deploy-bulk?${qs}`;
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        ...target,
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
    // A refusal (a viewer's 403, an unknown pack, a bad URL) is no result:
    // the status line says the server's text; no result table is drawn.
    const refusal = deployRefusal(r.status, body);
    if (refusal) throw refusal;
    const { ok, failed, total } = body.summary;
    setStatus(`${ok}/${total} deployed in ${body.tookMs}ms · ${failed} failed`, failed === 0 ? 'ok' : 'error');
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
        target,
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

// `target` is the deploy's MCP target (deployTargetBody(): a registered
// endpoint by id, or the typed URL — with the deploy's typed key when one was
// typed; without one, the server reads the endpoint's own variable).
export async function startDeployVerify({ deployId, packId, env, target, items }) {
  const host = $('#deploy-modal-verify');
  if (!host || !items.length || !target) return;
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
      // requestJson: a refusal (an endpoint whose token variable is unset,
      // one gone from the org) reads as the server's sentence, never a `{`.
      const out = await requestJson('/api/draft-from-mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target),
      });
      if (!out.ok) throw new Error(out.error || 'MCP draft failed');
      // The draft is registered by the route that answered it; it replaces
      // the earlier draft of the same label — the previous check's, or the
      // live draft loaded as Pack B, which then follows to this one.
      const reg = await registeredOrValidated(out);
      if (!reg.ok || !reg.registered?.id) throw new Error('live draft failed validation');
      packBId = reg.registered.id;
      followReplacedPack(packBId).catch(() => {});
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
      // The server refused the draft (a 4xx: the endpoint's token variable
      // unset, the endpoint gone, the role): waiting changes nothing — the
      // panel settles on the sentence now instead of polling behind it.
      if (e.status >= 400 && e.status < 500) break;
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
        urlInput.value = recallMcpUrl() || '';
      }
      openMcpTarget('draft');
      focusMcpTarget('draft');
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
  const { body: target, chosen } = mcpTargetOf('draft');
  const name = $('#draft-mcp-name').value.trim();
  const statusEl = $('#draft-mcp-status');
  const setStatus = (msg, kind) => {
    statusEl.textContent = msg;
    statusEl.className = 'mcp-refresh-status' + (kind ? ' is-' + kind : '');
  };
  if (!target) { setStatus('choose an MCP endpoint or type a URL', 'error'); return; }
  if (target.mcpUrl) rememberMcpUrl(target.mcpUrl).catch(() => {});

  const goBtn = $('#draft-mcp-go-btn');
  goBtn.disabled = true;
  setStatus('contacting mcp…');
  $('#draft-mcp-result').hidden = true;

  try {
    const r = await fetch('/api/draft-from-mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ ...target, packName: name || undefined }),
    });
    const ct = r.headers.get('content-type') || '';
    const raw = await r.text();
    if (!ct.includes('application/json')) {
      setStatus(`server returned ${r.status} ${ct || 'no content-type'} — restart \`npm run dev\` if you just changed server code`, 'error');
      return;
    }
    const out = JSON.parse(raw);
    if (!out.ok) { setStatus(`error: ${out.error || 'unknown'}`, 'error'); return; }
    rememberMcpEndpoint(chosen ? chosen.id : null);
    draftMcpState.lastResult = out;
    renderDraftMcpResult(out);
    followReplacedPack(out.registered?.id).catch(() => {});
    setStatus(`drafted in ${out.tookMs}ms · ${out.summary.discovered.backends} backend(s) discovered`, 'ok');
  } catch (e) {
    setStatus(`error: ${e.message}`, 'error');
  } finally {
    goBtn.disabled = false;
  }
}

// Step 2 — the stack's own self-metrics (docs/MCP_INTEGRATION.md,
// mcp.stack.* / mcp.observed.*). Every number is a point-in-time sample
// read straight from the server summary: signal, not verdict. Absent when
// the fetcher predates step 2 (summary.stack == null). `row` is the
// caller's table-row helper so the markup matches the rows above; a
// sampled row adds the row id / product as a hint line (plain, never the
// purple "fallback evidence" tint — a sample is not fallback evidence).
const STACK_OUTCOME_RANK = ['data', 'empty', 'failed', 'not-in-inventory', 'not-attempted'];

function formatStackValue(value, unit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  switch (unit) {
    case 'ratio':      return `${(value * 100).toFixed(1)}%`;
    case 'per-second': return `${value.toFixed(3)}/s`;
    case 'per-hour':   return `${value.toFixed(1)}/h`;
    case 'seconds':    return `${value.toFixed(1)}s`;
    case 'count':      return String(Math.round(value));
    default:           return String(value);
  }
}

function stackOutcomeText(outcome, reason) {
  switch (outcome) {
    case 'empty':            return '— empty';
    case 'failed':           return reason ? `— probe failed: ${reason}` : '— probe failed';
    case 'not-in-inventory': return '— not in inventory';
    case 'not-attempted':    return `— not attempted: ${reason || 'not attempted'}`;
    default:                 return `— ${outcome || 'unknown'}`;
  }
}

function renderStackSelfMetricsBlock(summary, row) {
  const sampledRow = (label, value, hint) =>
    `<tr><td>${escapeHtml(label)}<span class="row-evidence-hint">${escapeHtml(hint)}</span></td><td>${escapeHtml(String(value))}</td></tr>`;
  const stack = summary?.stack;
  const am = summary?.alertmanager;
  const gf = summary?.grafana;
  if (!stack && !am && !gf) return '';
  const rank = (o) => { const i = STACK_OUTCOME_RANK.indexOf(o); return i < 0 ? STACK_OUTCOME_RANK.length : i; };
  const lines = [];
  if (!stack) {
    lines.push(row('stack self-metrics', '— not sampled by this fetcher', true));
  } else if (stack.status !== 'sampled') {
    // The server's reason is the source of truth (today: the tier).
    lines.push(row('stack self-metrics', `— not attempted: ${stack.reason || 'metrics_query not exposed by this MCP tier'}`, true));
  } else {
    const rows = Array.isArray(stack.rows) ? stack.rows : [];
    for (const [family, familyOutcome] of Object.entries(stack.families || {})) {
      // The family's best row: outcome rank first, then the table order.
      const best = rows
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => r.family === family)
        .sort((a, b) => rank(a.r.outcome) - rank(b.r.outcome) || a.i - b.i)[0]?.r;
      if (!best) {
        // A family with no observed row was never reached: its rows were
        // counted not-attempted (call budget), not listed.
        lines.push(row(family, stackOutcomeText(familyOutcome, familyOutcome === 'not-attempted' ? 'call budget exhausted' : null), true));
        continue;
      }
      const hint = `${best.id}${best.product && best.product !== 'generic' ? ` · ${best.product}` : ''}`;
      if (best.outcome === 'data') {
        const text = formatStackValue(best.value, best.unit) + (best.hint === 'nonzero' ? ' · nonzero' : '');
        lines.push(sampledRow(family, text, hint));
      } else {
        lines.push(row(family, stackOutcomeText(best.outcome, best.reason), true));
      }
    }
  }
  // "— not exposed" is reserved for a surface the MCP did not advertise
  // (summary null). An advertised tool that failed carries `error` and
  // reads "probe failed" — a failure must never look like a tier limit.
  if (am) {
    const answered = am.version || am.silences || am.clusterStatus || am.uptime;
    if (!answered && am.error) {
      lines.push(row('alertmanager', `— probe failed: ${am.error}`, true));
    } else {
      const silences = am.silences ? `${am.silences.active} active silence${am.silences.active === 1 ? '' : 's'}` : 'silences not answered';
      lines.push(row('alertmanager', `${am.version ? `v${am.version}` : 'version unknown'} · ${silences}${am.error ? ` · probe failed: ${am.error}` : ''}`));
    }
  } else {
    lines.push(row('alertmanager', '— not exposed', true));
  }
  if (gf) {
    if (Array.isArray(gf.datasources)) {
      // Three buckets, never two: `unknown` means the health of that
      // datasource was NOT checked (health tool not exposed / errored /
      // beyond the cap) — "0 unhealthy" is printed only when at least one
      // datasource actually got a verdict.
      const label = (d) => d.name || d.uid || '?';
      const errors = gf.datasources.filter(d => d.health === 'error').map(label);
      const unchecked = gf.datasources.filter(d => d.health !== 'ok' && d.health !== 'error').map(label);
      const checked = gf.datasources.length - unchecked.length;
      let text;
      if (gf.datasources.length === 0) text = '0';
      else if (checked === 0) text = `${gf.datasources.length} · health not checked (grafana_datasource_health not exposed or did not answer)`;
      else {
        text = `${gf.datasources.length} · ${errors.length} error${errors.length ? `: ${errors.join(', ')}` : ''}`
          + (unchecked.length ? ` · ${unchecked.length} unchecked: ${unchecked.join(', ')}` : '');
      }
      lines.push(row('datasources', text));
    }
    if (gf.contactPoints) lines.push(row('contact points', gf.contactPoints.count));
    if (gf.error) lines.push(row('grafana', `— probe failed: ${gf.error}`, true));
  } else {
    lines.push(row('grafana', '— not exposed', true));
  }
  return `
    <div class="crawl-stack-heading">stack self-metrics — point-in-time sample, signal not verdict</div>
    <table class="crawl-summary-table">
      ${lines.join('')}
    </table>`;
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
      ? `<div class="crawl-pill crawl-pill-ok">✓ valid v1.4</div>`
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
  const probesU = new Set(d.probesUnsupported || []);
  const probeErrors = d.probeErrors || {};
  // Four distinct outcomes when a probe was attempted:
  //   data        — MCP responded with real content → show count
  //   empty       — MCP responded with empty payload → "0 (none configured)"
  //                 honest zero, e.g. Krystaline has no Prometheus rules
  //   failed      — every candidate errored / 503'd → "— probe failed"
  //                 transient or systemic, not the same as zero
  //   unsupported — tools/list exposes no candidate for the family →
  //                 "— not exposed by this MCP": a tier restriction, not
  //                 an outage; nothing to retry.
  const probeRow = (label, key, value) => {
    if (!probesA.has(key)) return '';
    if (probesS.has(key))  return row(label, value || 0);
    if (probesE.has(key))  return row(label, `0 — none configured`, true);
    if (probesU.has(key))  return row(label, '— not exposed by this MCP', true);
    if (probesF.has(key))  return row(label, probeErrors[key] ? `— probe failed: ${probeErrors[key]}` : '— probe failed', true);
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
  // On-wire liveness rows — only when the MCP reported something NOT
  // doing its job: scrape jobs whose every target is down, rules the
  // ruler reports as failing to evaluate. These jobs/rules exist but are
  // not counted as evidence above (the fetcher withholds their stamps).
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const scrapeJobsDown = d.scrapeJobsDown || [];
  const rulesUnhealthy = [...(d.recordingRulesUnhealthy || []), ...(d.alertRulesUnhealthy || [])];
  const scrapeDownRow = scrapeJobsDown.length
    ? row(`${plural(scrapeJobsDown.length, 'scrape job')} down`, scrapeJobsDown.join(', '))
    : '';
  const rulesUnhealthyRow = rulesUnhealthy.length
    ? row(`${plural(rulesUnhealthy.length, 'rule')} unhealthy`, rulesUnhealthy.join(', '))
    : '';
  const stackBlock = renderStackSelfMetricsBlock(out.summary, row);
  // Backends are the products with evidence of running here. What the MCP
  // can merely speak to is said apart, so "supported" never reads as
  // "deployed".
  const supportedOnly = d.supportedOnly || [];
  const supportedOnlyRow = supportedOnly.length
    ? row('supported by the MCP, not seen running', `${supportedOnly.length} — ${supportedOnly.slice(0, 8).join(', ')}${supportedOnly.length > 8 ? ', …' : ''}`, true)
    : '';
  const alertRulesSplitRow = probesS.has('alert_rules') && (d.alertRulesLinked || d.alertRulesOperational)
    ? row('… guarding an SLO · operational', `${d.alertRulesLinked || 0} · ${d.alertRulesOperational || 0}`, true)
    : '';
  // What this fetch had no way to look at: a comparison reports these
  // families as "not checked", never as missing.
  const unobservedFamilies = Object.keys(d.unobserved || {});
  const unobservedNote = unobservedFamilies.length
    ? `<div class="crawl-evidence-note">Not observable through this MCP: ${escapeHtml(unobservedFamilies.map(k => k.replace(/_/g, ' ')).join(', '))}. A comparison shows what another pack declares there as <em>not checked</em>, not as missing.</div>`
    : '';
  $('#draft-mcp-result-summary').innerHTML = `
    <h4>what the MCP attested</h4>
    <table class="crawl-summary-table">
      ${row('services', (d.servicesDiscovered || []).length)}
      ${row('backends', d.backends)}
      ${supportedOnlyRow}
      ${row('active anomalies', d.activeAnomalies)}
      ${probeRow('recording rules', 'recording_rules', d.recordingRules)}
      ${recordingEvidenceRow}
      ${probeRow('alert rules',     'alert_rules',     d.alertRules)}
      ${alertRulesSplitRow}
      ${alertEvidenceRow}
      ${probeRow('alerting routes', 'alerting_routes', d.alertingRoutes)}
      ${probeRow('dashboards',      'dashboards',      d.dashboards)}
      ${probeRow('scrape jobs',     'scrape_configs',  (d.scrapeJobs || []).length)}
      ${scrapeDownRow}
      ${rulesUnhealthyRow}
      ${probeRow('metric names',    'metric_names',    d.metricNamesCount)}
    </table>
    ${stackBlock}
    ${unobservedNote}
    ${alertsFiringCount > 0 || recordingFallbackCount > 0 ? `
      <div class="crawl-evidence-note">
        Rows in italic = fallback evidence. The standard rule endpoints came back empty,
        but ${escapeHtml(state.brand.chrome.name)} found evidence in metric data: firing alerts via the
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
    const res = await registeredOrValidated(out, state.selectedEnv);
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
// Which build is this studio? GET /api/version (server/build-info.mjs)
// names the commit the server was started from — 'v0.4.0 · build 975 ·
// 9c4f827 · develop'; /healthz adds the spec version and the node runtime
// for the About modal. studio/build-label.mjs owns the pieces
// (docs/UI_CONVENTIONS.md §2: loaders, a pure model, renderers); this is
// only their composition, run once at boot, fire-and-forget: the footer
// span, the Advanced menu's About entry, the header subtitle and the brand
// tooltip get painted — "what exactly is running?" should never need a
// terminal. When the server does not answer, the footer keeps its
// package.json fallback.
let serverVersion = null;   // /healthz: { version, build, node, specVersion }
let serverBuild = null;     // buildLabelModel(/api/version)

async function bindTaxonomyFromServer() {
  const mod = await import('/lib/artefact-classify.mjs');
  let json = null;
  try { json = await loadTaxonomy(); }
  catch (e) { console.warn(`[taxonomy] GET /api/taxonomy failed — classifying with the default families: ${e.message}`); }
  try { bindTaxonomy(mod, json); }
  catch (e) {
    console.warn(`[taxonomy] the server's override does not compile — classifying with the default families: ${e.message}`);
    bindTaxonomy(mod, null);
  }
}

async function loadVersion() {
  const [info, health] = await Promise.all([loadBuildInfo(), loadHealth()]);
  serverVersion = health;
  serverBuild = buildLabelModel(info);
  renderVersionChrome(document, serverBuild, state.brand.chrome);
}

function openAboutModal() {
  document.getElementById('about-modal')?.remove();
  const v = serverVersion || {};
  const b = serverBuild;
  const chrome = state.brand.chrome;
  const row = (k, val) => val ? `<div class="about-row"><span class="about-key">${k}</span><span class="about-val">${escapeHtml(String(val))}</span></div>` : '';
  const overlay = document.createElement('div');
  overlay.id = 'about-modal';
  overlay.className = 'about-overlay';
  overlay.innerHTML = `
    <div class="about-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(chrome.aboutLabel)}">
      <div class="about-brand">${chrome.wordmarkHtml('i')}</div>
      <div class="about-tagline">${escapeHtml(chrome.tagline)}</div>
      <div class="about-version">${escapeHtml(b ? `v${b.version ?? '?'}` : v.version ? `v${v.version}` : 'version unknown')}<span class="about-build">${escapeHtml(b ? ` · build ${b.build ?? 'unknown'}` : v.build ? ` · build ${v.build}` : '')}</span></div>
      <div class="about-rows">
        ${row('commit', b?.commit ? [b.commit, b.branch, b.dirty ? 'dirty' : null].filter(Boolean).join(' · ') : null)}
        ${row('committed', b?.date)}
        ${row('source', b?.source && b.source !== 'unknown' ? b.source : null)}
        ${row('history', b?.shallow ? 'shallow clone — no commit count' : null)}
        ${row('spec', v.specVersion ? `ObservabilityPack v${v.specVersion}` : null)}
        ${row('server', v.node ? `node ${v.node}` : null)}
        ${row('identity', state.identity?.mode || 'local (no sign-in)')}
        ${state.identity?.orgs?.length ? row('org', state.identity.orgs.map(o => o.name || o.id).join(' · ')) : ''}
      </div>
      ${chrome.aboutChangelogHref ? `<a class="about-link" href="${escapeHtml(chrome.aboutChangelogHref)}" target="_blank" rel="noopener">changelog</a>` : ''}
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
// The signed-in login, or null in the open posture and before /auth/me
// answered — the first half of every per-user storage key.
function signedInLogin() {
  return state.identity?.authenticated ? (state.identity.user?.login || null) : null;
}

async function loadIdentity() {
  try {
    const r = await fetch('/auth/me');
    if (!r.ok) return null;
    state.identity = await r.json();
    setSignedInLogin(state.identity?.authenticated ? state.identity.user?.login : null);
    return state.identity;
  } catch (_) { return null; }
}

// Stage 2 tenancy: pick the active org from the session's memberships
// (/auth/me carries them in every identity posture) — the persisted choice
// when still valid, the first membership otherwise. Without memberships
// (the open posture) no org header is sent: the server runs the request in
// the default org. The header is sent whatever the ORG chip shows.
function resolveActiveOrg() {
  const orgs = state.identity?.orgs || [];
  if (!orgs.length) { setActiveOrg(null); return; }
  const saved = savedOrg();
  setActiveOrg((orgs.find(o => o.id === saved) || orgs[0]).id);
}

// The header's `api` link (studio/index.html #api-link) names the active
// org in its query: a static href cannot know it.
function syncApiLink() {
  const link = document.getElementById('api-link');
  if (link) link.href = `/api/packs${orgQuery()}`;
}

// Identity chip — only renders when the server runs in an identity
// posture and a session exists. The account menu mounts in the chrome's
// action cluster (installObservaChrome runs first in boot): the one bar
// every screen shows. The context bar (.hdr) is hidden on the home and
// Build screens (app.css, ux.css), so a menu there left a signed-in user
// no way to sign out or change a password until a pack was open.
function setupIdentityChip() {
  const me = state.identity;
  if (!me?.authenticated) return;
  const actions = document.querySelector('.observa-hdr .observa-actions');
  if (!actions || document.getElementById('hdr-user')) return;

  // The ORG indicator / switcher is the OBSERVA bar's chip alone
  // (updateObservaOrgChip), on every screen; the context bar carries no copy.

  // Account menu: who you are, change password (stand-alone mode — OIDC
  // passwords belong to the IdP), sign out my other sessions (not behind a
  // reverse proxy: the headers are the session, the route is not
  // registered), sign out.
  // The name is its own span: beside the tabs it gives way (ux.css — ten
  // characters at a laptop width, the glyph alone at phone width), so the
  // tab titles keep their room; the title and the menu say it in full.
  const chip = document.createElement('span');
  chip.id = 'hdr-user';
  chip.className = 'hdr-user';
  // Deliberately NOT role="menu"/"menuitem": that ARIA contract demands
  // arrow-key navigation this popover doesn't implement. Plain links and
  // buttons are natively focusable and honest about what this is.
  chip.innerHTML = `
    <button type="button" class="ctrl-btn hdr-user-btn" aria-expanded="false"
            title="signed in as ${escapeHtml(me.email || me.sub)} (${escapeHtml(me.mode)})">⏣ <span class="hdr-user-name">${escapeHtml(me.name || me.email || me.sub)}</span> ▾</button>
    <div class="hdr-user-menu" hidden>
      <div class="hdr-user-menu-id" aria-live="polite">signed in as <strong>${escapeHtml(me.email || me.sub)}</strong><span class="hdr-user-menu-mode">${escapeHtml(me.mode)}</span></div>
      <button type="button" class="hdr-user-menu-item hdr-user-settings">settings</button>
      ${me.mode === 'local-users' ? '<a class="hdr-user-menu-item" href="/auth/change-password">change password…</a>' : ''}
      ${me.mode === 'proxy' ? '' : '<button type="button" class="hdr-user-menu-item hdr-user-others">sign out my other sessions</button>'}
      <button type="button" class="hdr-user-menu-item hdr-user-out">sign out</button>
    </div>
  `;
  const menuBtn = chip.querySelector('.hdr-user-btn');
  const menu = chip.querySelector('.hdr-user-menu');
  const setOpen = (open) => { menu.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); };
  menuBtn.addEventListener('click', () => setOpen(menu.hidden));
  // On the way down (capture): the Advanced toggle beside it stops its own
  // click from bubbling, and would leave this menu open under that one.
  document.addEventListener('click', (e) => { if (!chip.contains(e.target)) setOpen(false); }, true);
  chip.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setOpen(false); menuBtn.focus(); } });
  // Every other session of this user ends at its next request; this
  // browser's cookie comes back re-issued (Set-Cookie). The id line says
  // what happened — or the server's refusal, as it words it.
  const others = chip.querySelector('.hdr-user-others');
  if (others) others.addEventListener('click', async () => {
    others.disabled = true;
    let status = 0;
    let body;
    try {
      const r = await fetch('/auth/signout-others', { method: 'POST', headers: { Accept: 'application/json', ...authHeaders() } });
      status = r.status;
      body = await r.json().catch(() => null);
    } catch (e) {
      body = { error: e?.message || String(e) };
    }
    chip.querySelector('.hdr-user-menu-id').textContent = signOutOthersText(status, body);
    others.disabled = false;
  });
  // Behind a reverse proxy the proxy's session outlives this app's: go to
  // its logout URL when the server names one (/auth/me logoutUrl); without
  // one, say what happened instead of landing on the 401 explainer.
  chip.querySelector('.hdr-user-out').addEventListener('click', async () => {
    forgetMcpUrls(me.user?.login);   // a shared browser keeps no MCP URL or deploy profile of this user
    persistence.forget(me.user?.login);   // nor a snapshot of this user in any org — the Build draft included
    forgetRecentServices();
    await fetch('/auth/logout', { method: 'POST', headers: { ...authHeaders() } }).catch(() => {});
    if (me.mode === 'proxy') {
      if (me.logoutUrl) { window.location.assign(me.logoutUrl); return; }
      chip.querySelector('.hdr-user-menu-id').textContent = 'signed out of this app only — the reverse proxy still knows you; end its session there';
      return;
    }
    window.location.assign('/auth/login');
  });
  // Settings — the same door as Advanced → Settings (a user in no org is
  // told why instead).
  chip.querySelector('.hdr-user-settings').addEventListener('click', () => { setOpen(false); enterSettings(null); });
  actions.appendChild(chip);
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
