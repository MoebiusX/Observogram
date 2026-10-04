// studio/brand.mjs — the studio's brand: what the server injected, normalized
// by the one module that owns the defaults (tools/lib/brand.mjs).
//
// docs/UI_CONVENTIONS.md §2–3: a loader (readBrandConfig + loadBrand, the
// import injectable) → a model (`state.brand`: the normalized brand with its
// `chrome` strings attached) → renderers that read `state.brand.chrome` and
// never a literal. Every chrome string in the studio — the header wordmark
// and logo, the About card, the scanner title, the reset confirm, the
// API-unreachable screen, the origin chip's tip, the atlas compass mark,
// the version tooltip — comes from here, so a rebadged server rebadges the
// whole studio and the unconfigured one reads exactly the strings it always
// did (DEFAULT_BRAND is those strings).
//
// Zero static imports: the brand module is loaded the house way, at call
// time, through the server's /lib mount (`import('/lib/brand.mjs')`; the
// static bundle's import map resolves the same specifier). A node test
// injects `importFn: () => import('../tools/lib/brand.mjs')`.
//
// tools/test-studio-graph.mjs links app.mjs under node: app.mjs kicks
// `loadBrand()` off at module top level (so the fetch overlaps the module
// graph instead of following it) and marks the promise handled, because
// under node `import('/lib/brand.mjs')` rejects (ERR_MODULE_NOT_FOUND) —
// the graph test still passes on app.mjs's first top-level DOM touch, which
// comes before boot() awaits the brand.

export const CONFIG_ID = 'brand-config';

// The `<script type="application/json" id="brand-config">` the server
// injects into a branded shell (tools/lib/brand.mjs brandShellHtml), or null
// — an unbranded shell carries none, and a malformed one counts as none.
export function readBrandConfig(doc) {
  const el = doc?.getElementById ? doc.getElementById(CONFIG_ID) : doc?.querySelector?.(`#${CONFIG_ID}`);
  if (!el) return null;
  try {
    const parsed = JSON.parse(el.textContent);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// The model: the normalized brand plus `chrome` (brandChrome). Normalizing
// the injected object again is the identity (it was normalized by the same
// function on the server) and the unbranded case is normalizeBrand({}).
export async function loadBrand({ importFn = () => import('/lib/brand.mjs'), doc = typeof document === 'undefined' ? null : document } = {}) {
  const { normalizeBrand, brandChrome } = await importFn();
  const brand = normalizeBrand(doc ? readBrandConfig(doc) : null);
  return Object.freeze({ ...brand, chrome: brandChrome(brand) });
}
