// studio/constants.mjs
//
// The studio's display vocabulary — the fixed taxonomy and grading scale
// the UI is built around. Pure data and pure functions only: nothing here
// touches `state` or the DOM, so it is safe to import from anywhere in the
// client (and to unit-test in isolation). The semantics are the spec's, not
// the UI's — see vendor/observability-pack-spec for the source of truth.

// The seven canonical layers (L1 Contract … GOV Governance).
export const LAYER_DEFS = [
  { id: 'L1',  num: 'L1',  name: 'Contract'   },
  { id: 'L2',  num: 'L2',  name: 'Telemetry'  },
  { id: 'L2X', num: 'L2X', name: 'Extended'   },
  { id: 'L3',  num: 'L3',  name: 'Insight'    },
  { id: 'L4',  num: 'L4',  name: 'Action'     },
  { id: 'L5',  num: 'L5',  name: 'Validation' },
  { id: 'GOV', num: 'GOV', name: 'Governance' },
];

// NOTE: diagnostic-grade.mjs inlines its own private copy of this array so
// it can stay zero-dependency for downstream vendoring — keep the two in sync.
export const L4_SUBGROUPS = [
  { key: 'policy',   label: 'Policy' },
  { key: 'alerting', label: 'Alerting' },
  { key: 'healing',  label: 'Self-healing' },
];

// DOMAIN facet — a fixed four-bucket taxonomy that cuts ACROSS the layers,
// answering "which slice of the stack does this artefact belong to?" The
// layer (L1…GOV) says WHAT KIND of artefact it is; the domain says WHICH
// PART OF THE SYSTEM it observes. Classification is deterministic (see
// artefactDomain) and falls back to Application.
export const DOMAIN_DEFS = [
  { id: 'infrastructure', label: 'Infrastructure' },
  { id: 'platform',       label: 'Platform' },
  { id: 'application',    label: 'Application' },
  { id: 'ux',             label: 'User Experience' },
];

// Slab accents only — the layer NAMES come from the canonical LAYER_DEFS
// (L1 Contract · L2 Telemetry · L2X Extended · L3 Insight · L4 Action ·
// L5 Validation · GOV Governance). Never invent layer semantics; the spec
// is the source of truth.
export const DISCO_SLAB_ACCENT = {
  L1: '#3b82f6', L2: '#06b6d4', L2X: '#0ea5e9', L3: '#10b981',
  L4: '#f59e0b', L5: '#a855f7', GOV: '#64748b',
};

// Conformance-percentage → letter grade / one-word verdict. The scale is
// the conventional US academic banding; both are pure of any UI state.
export function discoGradeLetter(pct) {
  if (pct >= 97) return 'A+'; if (pct >= 93) return 'A'; if (pct >= 90) return 'A-';
  if (pct >= 87) return 'B+'; if (pct >= 83) return 'B'; if (pct >= 80) return 'B-';
  if (pct >= 77) return 'C+'; if (pct >= 73) return 'C'; if (pct >= 70) return 'C-';
  if (pct >= 60) return 'D';  return 'F';
}
export function discoGradeWord(pct) {
  if (pct >= 90) return 'Excellent'; if (pct >= 80) return 'Good';
  if (pct >= 70) return 'Fair';      if (pct >= 60) return 'Weak';
  return 'Failing';
}
