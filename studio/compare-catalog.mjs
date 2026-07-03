// studio/compare-catalog.mjs
//
// The two things the verdict/grade modules need from the Compare world,
// extracted from the 3000-line compare-view.mjs so a downstream studio can
// vendor verdict-ui.mjs without stubbing the whole view (docs/VENDORING.md).
// Depends only on state.mjs; compare-view.mjs re-exports both for its
// existing importers.

import { state } from './state.mjs';

// The seven diff buckets, in render order. Mirrors the ids of LAYER_DEFS
// in constants.mjs — kept literal so this module needs nothing but state.
export const LAYERS_FOR_DIFF = ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV'];

// Return the catalog entry for a pack id — the source of truth for
// the human-readable label, version, criticality, environments. The
// per-pack metadata.name in the YAML may DIFFER from the catalog
// label (e.g. catalog "Target advanced (tier-1 reference)" vs YAML
// metadata.name "platform-edge"); the catalog label is what the
// user picked from the dropdown, so it wins for display.
export function catalogEntryFor(packId) {
  return (state.catalog || []).find(p => p.id === packId) || null;
}
