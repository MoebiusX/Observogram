// studio/state.mjs
//
// The studio client's single source of mutable truth — the `state` object —
// plus the tiny DOM query helpers and the localStorage persistence layer
// that hang off it. Everything here is imported (and mutated in place) by
// app.mjs and the view modules; `state` is never reassigned, only its
// properties, so the imported binding stays live across modules.

// ---------- DOM helpers ----------
export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const state = {
  // 'home' starts the studio empty; user picks Analyze (one pack) or
  // Compare (two packs). Once chosen, mode becomes 'single' or 'compare'
  // and the header bar + tabs appear. Logo click returns to 'home'.
  mode: 'home',
  // Which home renders: 'gate' (signed-in service picker) or 'hero'
  // (the marketing/connect landing). Authenticated users with services
  // land on the gate; local mode keeps the hero. Never persisted.
  homeVariant: 'hero',
  // /auth/me result (identity postures only; null in local mode).
  identity: null,
  catalog: [],
  selectedService: null,
  selectedPackId: null,
  selectedEnv: null,
  pack: null,
  conformance: null,
  symbolTable: null,
  // Primary view selector (top nav). One of: layers, conformance,
  // compile, atlas, schema. Compare mode hides conformance + compile.
  view: 'layers',
  // Per-pack focus toggle (A | B). Surfaces the A|B switch on the
  // conformance / compile / schema views when both packs are loaded so
  // the user can read B's report without losing A. Resets to 'a' when
  // Pack B is cleared. Stays 'a' until the user flips it.
  viewFocus: 'a',
  // Parallel slots for Pack B — populated when the user flips focus
  // to B (or pre-fetched alongside loadPackB() so toggling is instant).
  conformanceB: null,
  compileCatalogB: null,        // mirrors compileCatalog for B
  compileGroupB: 'rules',       // mirrors compileGroup for B
  compileFlavorB: 'prometheus', // mirrors compileFlavor for B
  compileArtifactB: 'all',      // mirrors compileArtifact for B
  compileContentB: null,        // mirrors compileContent for B
  // Traceability view preferences (persisted via Direction 3). Keys are
  // `${layer}::${key}` strings — see compareKeyOf. Suppressed findings
  // are hidden from their bucket; resolved findings render as resolved.
  tracePrefs: { suppressed: [], resolved: [] },
  traceOpen: { aligned: false, declaredNotVerified: true, verifiedNotDeclared: true, stale: true },
  // Per-section Expand toggles — each L2/L3 section hides its detail-level
  // artefacts by default and reveals them on demand. L2: live evidence
  // inventory (METRIC-NN + SCRAPE-NN). L3: dashboard panels (PANEL-NN) and
  // queries (recording rules / derived views) vs the dashboards. Persisted so
  // the user's choice survives refresh.
  expandL2: false,
  expandL3Panels: false,
  expandL3Queries: false,
  // Discover content filters (only active on view='layers').
  layersSearch: '',            // free-text over card id/title/desc/tags/tool
  layersDomain: 'all',         // facet over artefact tool/system
  // Secondary layer filter chips (only visible on view='layers').
  // 'all' stacks every layer; the layer ids narrow to one.
  layerFilter: 'all',
  // Legacy: kept for back-compat with code that still reads it
  // (drawer card highlight on per-layer cards, etc.). Mirrors view.
  activeLayer: 'L1',
  activeCardKey: null,
  activeCardKeyA: null,        // side-A card highlight (compare view)
  activeCardKeyB: null,        // side-B card highlight (compare view)
  uploadedSource: null,        // set when user uploaded a pack instead of using the catalog
  diagnoseSub: 'grade',        // DIAGNOSE sub-tab: 'grade' (verdict report) | 'compare' (A-vs-B side-by-side)
  compareBId: null,            // second pack id for the COMPARE view
  compareBEnv: null,
  compareSlice: 'all',         // 'all' | 'onlyA' | 'onlyB' | 'both' | 'a-b' | 'a+b'
  compareSearch: '',           // text filter applied to card id/title
  compareLens: 'all',          // 'all' | <product-slug>. Filters Compare/Benchmark to
                               // only artefacts in a product's surface (e.g. 'grafana'
                               // keeps backends with product=grafana, dashboards whose
                               // provider.kind=grafana, anything whose mcp.source.<id>
                               // annotation came from a grafana_* tool, and any artefact
                               // that refs a surface backend). 'all' disables the filter.
  diffScopeMode: '',           // '' means use Pack A's observogram.diff.scopeMode annotation
                               // or the service-scoped default. Otherwise:
                               // 'service' | 'family' | 'all'.
  diff: null,                  // last fetched /api/diff result
  packB: null,                 // B's full layered pack (for atlases)
  atlasVariant: 'strata',      // 'strata' | 'periodic' | 'constellation' | 'skyline' | 'transit' | 'arbor'
  atlasMorph: 0,               // 0..1 for the constellation slider
  arborView: 'A',              // 'A' | 'B' | 'both' — arbor side-by-side toggle
  compileTarget: 'prometheus-rules',
  compileDashId: null,
  compileContent: null,        // { filename, contentType, text, source } | { error }
  compileTargets: null,        // legacy catalog from /api/compile/targets
  // Per-artifact compile state (Phase 7m).
  compileCatalog: null,        // { groups: [...] } from /api/packs/:id/compile-catalog
  compileGroup: 'rules',       // 'rules' | 'dashboards' | 'pipelines' | 'alertmanager'
  compileFlavor: 'prometheus', // chosen flavor for the active group
  compileArtifact: 'all',      // chosen leaf in the artifact tree
  deployMatrix: null,          // catalog from /api/deploy/matrix
  deployProduct: 'grafana',    // chosen target product
  deployVersion: '12',         // chosen target version (string — matches matrix.versions)
  deployScope: 'both',         // for prometheus-rules: both | recording | alerting
  // Reconcile mode. null → bidirectional when Pack B is loaded, otherwise
  // deploy-only. Legacy values (A/B/AUB/A-B) are migrated in compile-view.
  remediateOp: null,           // 'all' | 'deploy' | 'retrofeed' | 'drift'
  remediateDeselected: null,   // Set<string> of identities the user unchecked
  mcpStatus: null,
};

// ---------- persistence (localStorage) ----------
//
// The studio used to forget everything on refresh: which pack was open,
// which view you were on, your layer filter, your compare slice. That's
// fine for a demo but cruel for a tool you live in for hours. We persist
// a small whitelist of state under a versioned key and re-hydrate on
// boot — re-fetching packs the normal way (no skipping validation) so a
// pack that vanished from the catalog just drops silently.
const PERSIST_KEY = 'studioState.v1';
const PERSIST_FIELDS = [
  'selectedService',
  'selectedPackId', 'selectedEnv',
  'compareBId', 'compareBEnv',
  'view', 'layerFilter', 'diagnoseSub',
  'compareSlice', 'compareSearch', 'compareLens', 'diffScopeMode',
  'viewFocus',
  'atlasVariant', 'arborView',
  'compileGroup', 'compileFlavor', 'compileArtifact',
  'compileGroupB', 'compileFlavorB', 'compileArtifactB',
  'tracePrefs',
  'expandL2', 'expandL3Panels', 'expandL3Queries',
  'layersSearch', 'layersDomain',
];
export const persistence = {
  _suspended: true,  // boot-phase guard — flipped to false once rehydrate finishes
  _timer: null,
  suspend() { this._suspended = true; if (this._timer) { clearTimeout(this._timer); this._timer = null; } },
  resume()  { this._suspended = false; },
  read() {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return (data && typeof data === 'object') ? data : null;
    } catch (_) { return null; }
  },
  write() {
    if (this._suspended) return;
    const snap = {};
    for (const k of PERSIST_FIELDS) snap[k] = state[k];
    try { localStorage.setItem(PERSIST_KEY, JSON.stringify(snap)); } catch (_) {}
  },
  schedule() {
    if (this._suspended) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this.write(); }, 250);
  },
  clear() { try { localStorage.removeItem(PERSIST_KEY); } catch (_) {} },
};
