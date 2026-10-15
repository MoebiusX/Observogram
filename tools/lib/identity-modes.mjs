// tools/lib/identity-modes.mjs — what pairs an artefact of pack A with one of
// pack B: its behaviour (the default), its name, or its stable id.
//
// The diff engine (tools/lib/diff.mjs `diffPacks(a, b, { identity })`), the
// studio's Compare (`/lib/identity-modes.mjs`, re-keyed in the browser over
// the two packs on screen) and a downstream's own verification call these
// same functions (docs/DOWNSTREAM.md §15.4).
//
//   behaviour  identityKeyOf (tools/lib/artefact-model.mjs): what the artefact
//              DOES — a backend's product and signal, a metric's series, a
//              contract handle. The default; nothing else changes.
//   name       the name or title only (trimmed, spaces collapsed, lower case).
//   id         a stable id or uid only — a dashboard's uid, a spec id; a family
//              whose name IS its id (a metric, a rule, a scrape job) uses it.
//
// In every mode behaviour still decides aligned vs drifted: a mode only
// chooses which artefacts are compared with which.
//
// A key keeps the `<kind>::` prefix, so a pair only forms within a family and
// the diff's prefix-based logic (scope, notObserved, collisions) holds. An
// artefact with no name (or no stable id) never pairs: its key carries the
// side and its own artefact id, so two unnamed artefacts of a family can never
// be matched into a false pair. Positional `XXX-NN` ids are never identity, and
// neither is the prose `title` an adapter writes for a family that has no name.
//
// Pure and browser-safe: no `node:*`, no environment, deterministic.

import { classify, identityKeyOf, modelOf } from './artefact-model.mjs';
import { FAMILIES } from './artefact-classify.mjs';

export const DEFAULT_IDENTITY_MODE = 'behaviour';

function text(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? value : '';
}

// trim, collapse runs of white space, lower case; '' → null.
function normName(value) {
  const s = text(value).trim().replace(/\s+/g, ' ').toLowerCase();
  return s || null;
}

// trim only: a uid is case-sensitive where it comes from.
function normId(value) {
  const s = text(value).trim();
  return s || null;
}

function stripRef(value) {
  return text(value).replace(/^ref:/, '').replace(/^slos\./, '').replace(/^slis\./, '');
}

const DEFINED_PREFIX = Object.freeze({
  sli: 'slis.', slo: 'slos.', derived_view: 'queries.derived_views.', dashboard: 'dashboards.',
});

// The contract handle the adapter attached (`defines`, without its section
// prefix); never the positional artefact id.
function definedIdOf(artefact, kind) {
  const d = text(artefact?.defines);
  const prefix = DEFINED_PREFIX[kind] || '';
  if (!d) return '';
  return prefix && d.startsWith(prefix) ? d.slice(prefix.length) : d;
}

function joined(...parts) {
  const kept = parts.map((p) => text(p).trim()).filter(Boolean);
  return kept.length ? kept.join(' / ') : '';
}

// Per family: the material each mode reads, as [value, label] candidates in
// order (the first non-empty wins). `label` names where the value came from,
// for pairingOf; a third element 'name' normalises an id-mode fallback like a
// name. Total over FAMILIES: tools/test-identity-modes.mjs iterates
// the list, so a family added later fails until it has a row here.
const MATERIAL = Object.freeze({
  dashboard: {
    name: (s, a) => [[s.params?.title, 'title'], [definedIdOf(a, 'dashboard'), 'dashboard id']],
    id:   (s, a) => [[s.params?.uid, 'uid'], [definedIdOf(a, 'dashboard'), 'dashboard id']],
  },
  sli:          handle('sli'),
  slo:          handle('slo'),
  derived_view: handle('derived_view'),
  backend:            same((s) => [[s.id, 'backend id']]),
  pipeline_receiver:  same((s) => [[s.name, 'stage name']]),
  pipeline_processor: same((s) => [[s.name, 'stage name']]),
  pipeline_exporter_metrics: same(exporter),
  pipeline_exporter_logs:    same(exporter),
  pipeline_exporter_traces:  same(exporter),
  storage_metrics: same((s) => [[s.backend, 'storage backend']]),
  storage_logs:    same((s) => [[s.backend, 'storage backend']]),
  storage_traces:  same((s) => [[s.backend, 'storage backend']]),
  scrape_job:     same((s) => [[s.job, 'job name']], 'name'),
  metric:         same((s) => [[s.name, 'series name']], 'name'),
  recording_rule: same((s) => [[s.name, 'record name']], 'name'),
  alert_rule:     same((s) => [[s.name, 'rule name']], 'name'),
  profiling:     same((s) => [[s.product, 'product']]),
  network:       same((s) => [[s.product, 'product']]),
  policy_engine: same((s) => [[s.product, 'product']]),
  mesh:          same((s) => [[s.product ? joined(s.product, s.role) : '', 'product and role']]),
  collection:    same((s) => [[s.product ? joined(s.product, s.role) : '', 'product and role']]),
  panel: {
    name: (s, a) => [[panelName(s) ? joined(a.parent, panelName(s)) : '', 'panel title']],
    id:   (s, a) => [
      [s.binds_to ? joined(a.parent, stripRef(s.binds_to)) : '', 'binding'],
      [panelName(s) ? joined(a.parent, panelName(s)) : '', 'panel title', 'name'],
    ],
  },
  burn_rate:   same((s) => [[stripRef(s.slo), 'objective']]),
  forecast:    same((s) => [[stripRef(s.slo), 'objective']]),
  alert_route: same((s) => [[s.severity, 'severity']]),
  remediation: same((s) => [[s.id, 'remediation id'], [stripRef(s.trigger), 'trigger']]),
  chaos:       same((s) => [[s.id, 'experiment id']]),
  synthetic:   same((s) => [[s.id, 'check id']]),
  imports:     same((s) => [[stripRef(s.ref), 'import ref']]),
  otel:      singleton(),
  baselines: singleton(),
  unknown:   same((s, a) => [[a.defines, 'spec path']]),
});

function handle(kind) {
  return same((s, a) => [[definedIdOf(a, kind), 'spec id']]);
}

// The same material for both modes; `nameIsId` marks a family whose name is
// its id (said so by pairingOf, and normalised like a name in id mode).
function same(fn, nameIsId) {
  return { name: fn, id: fn, nameIsId: nameIsId === 'name' };
}

// otel and baselines hold at most one artefact per pack: they pair with each
// other in every mode (their behaviour identity is the empty object).
function singleton() {
  return { name: () => [], id: () => [], singleton: true };
}

function exporter(s) {
  return [[s.name, 'exporter name'], [s.kind, 'exporter kind']];
}

function panelName(s) {
  return text(s.panel) || text(s.title);
}

function rowOf(artefact) {
  const kind = classify(artefact);
  return { kind, row: MATERIAL[kind] || MATERIAL.unknown };
}

function pick(artefact, which) {
  const { kind, row } = rowOf(artefact);
  if (row.singleton) return { kind, value: kind, label: 'singleton', singleton: true };
  const normalise = which === 'name' || row.nameIsId ? normName : normId;
  for (const [raw, label, as] of row[which](artefact?.spec || {}, artefact || {})) {
    const value = (as === 'name' ? normName : normalise)(raw);
    if (value) return { kind, value, label, nameIsId: !!row.nameIsId };
  }
  return { kind, value: null, label: null };
}

// The artefact's name for pairing (normalised), or null when it has none.
export function nameOf(artefact) {
  return pick(artefact, 'name').value;
}

// The artefact's stable id for pairing, or null when it has none.
export function idOf(artefact) {
  return pick(artefact, 'id').value;
}

function sideTag(artefact, side) {
  return `${side == null ? '' : String(side)}:${text(artefact?.id)}`;
}

// `<kind>::{"name":"…"}`; with no name `<kind>::{"unnamed":"<side>:<artefact id>"}`
// — never paired.
export function nameKeyOf(artefact, { side } = {}) {
  if (!artefact) return null;
  const { kind, value } = pick(artefact, 'name');
  return `${kind}::${JSON.stringify(value == null ? { unnamed: sideTag(artefact, side) } : { name: value })}`;
}

// `<kind>::{"id":"…"}`; with no stable id `<kind>::{"unidentified":"<side>:<artefact id>"}`
// — never paired.
export function idKeyOf(artefact, { side } = {}) {
  if (!artefact) return null;
  const { kind, value } = pick(artefact, 'id');
  return `${kind}::${JSON.stringify(value == null ? { unidentified: sideTag(artefact, side) } : { id: value })}`;
}

export const IDENTITY_MODES = Object.freeze([
  Object.freeze({ id: 'behaviour', label: 'Behaviour', matchedBy: 'behaviour', keyOf: identityKeyOf,
    hint: 'What each artefact does (default): series, product and signal, contract handles.' }),
  Object.freeze({ id: 'name', label: 'Name', matchedBy: 'name', keyOf: nameKeyOf,
    hint: 'The name or title only. Behaviour still decides aligned vs drifted.' }),
  Object.freeze({ id: 'id', label: 'Id', matchedBy: 'id', keyOf: idKeyOf,
    hint: 'Stable ids and uids only (a dashboard uid, a spec id); a family named by its name uses the name.' }),
]);

// The registry row of a mode id; an unknown id is a TypeError naming the three.
export function identityMode(mode) {
  const row = IDENTITY_MODES.find((m) => m.id === mode);
  if (!row) {
    throw new TypeError(`unknown identity mode ${JSON.stringify(mode)} (${IDENTITY_MODES.map((m) => m.id).join(', ')})`);
  }
  return row;
}

function behaviourLabel(artefact) {
  const { identity } = modelOf(artefact);
  const parts = Object.keys(identity).sort()
    .filter((k) => identity[k] !== undefined && identity[k] !== '')
    .map((k) => `${k} ${JSON.stringify(identity[k])}`);
  return parts.length ? `behaviour (${parts.join(', ')})` : 'behaviour (one per pack)';
}

// Why an artefact pairs (or never pairs) in `mode`, in words for a reader:
//   'dashboard uid "ord-1"', 'name "high latency"', 'no name — never paired by name'.
export function pairingOf(artefact, mode = DEFAULT_IDENTITY_MODE) {
  const row = identityMode(mode);
  if (row.id === 'behaviour') return behaviourLabel(artefact);
  const which = row.id;
  const got = pick(artefact, which);
  if (got.singleton) return `the pack's one ${got.kind} entry`;
  if (got.value == null) {
    return which === 'name' ? 'no name — never paired by name' : 'no stable id — never paired by id';
  }
  if (got.nameIsId) return `${got.label} "${got.value}"${which === 'id' ? ' (the name is the id)' : ''}`;
  if (got.kind === 'dashboard') return `dashboard ${got.label === 'dashboard id' ? 'id' : got.label} "${got.value}"`;
  return `${got.label} "${got.value}"`;
}

// The families this module has a row for — every family of the vocabulary.
export function identityFamilies() {
  return FAMILIES.filter((f) => f in MATERIAL);
}
