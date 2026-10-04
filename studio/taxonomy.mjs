// studio/taxonomy.mjs — the studio's binding to the artefact taxonomy
// (tools/lib/artefact-classify.mjs).
//
// Studio modules never import tools/lib statically: the Node suites import
// them where /lib/ does not resolve. So boot() loads the classifier the
// house way — `await import('/lib/artefact-classify.mjs')` — and binds it
// here, with the server's override (GET /api/taxonomy) compiled and
// installed, before the first render. Zero-import.
//
// Unbound, classifyArtefact() degrades to { family: 'unknown', via:
// 'unbound' } instead of throwing: card-html's row kinds and the drawer's
// panels fall through to their own per-prefix tables for any artefact the
// taxonomy did not place by `type` or by an override, so a headless or
// pre-boot render of an adapted pack keeps working. Only the Discover board
// cannot group unbound — it calls requireTaxonomy() and throws the named
// error, so a render path that reaches it before boot() is loud, not wrong.

let lib = null;

export const UNBOUND = Object.freeze({ family: 'unknown', via: 'unbound', layer: null, group: 'other', label: null, role: null });

/**
 * Bind the classifier module and install the override (`json` is the
 * server's taxonomy document or null for the defaults). Returns the module.
 */
export function bindTaxonomy(mod, json = null) {
  if (!mod || typeof mod.classifyArtefact !== 'function' || typeof mod.configureTaxonomy !== 'function') {
    throw new Error('bindTaxonomy: expected the artefact-classify module');
  }
  mod.configureTaxonomy(json ? mod.compileTaxonomy(json) : null);
  lib = mod;
  return lib;
}

export function taxonomyBound() { return lib !== null; }

/** Throws the named error when nothing is bound — for the one caller that cannot degrade. */
export function requireTaxonomy() {
  if (!lib) throw new Error('taxonomy unbound: bindTaxonomy() runs in boot() before the first render');
  return lib;
}

/** { family, via, layer, group, label, role } — via 'unbound' before boot(). */
export function classifyArtefact(a) {
  return lib ? lib.classifyArtefact(a) : { ...UNBOUND };
}
