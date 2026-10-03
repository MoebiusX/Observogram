// tools/lib/artefact-model.mjs
//
// BEHAVIORAL ARTEFACT MODEL
//
// The thesis: two artefacts are "the same" when they represent the same
// deployed control. For telemetry artefacts that means product+signal, output
// series, binding target, etc. For contract artefacts (SLIs, SLOs, dashboards,
// derived views), the declared id is itself the handle other controls bind to,
// so the id is part of the behaviour on purpose. Positional adapter ids such as
// `SLI-01` or `BAK-03` are never behavioural identity.
//
// For every artefact family we construct a typed object with two faces:
//
//   identity  — the behaviour-determining handle used to PAIR an A artefact
//               with its B counterpart. Derived from content (series name,
//               product+signal, output series, binding target), never from the
//               positional `XXX-NN` id the adapter assigns or a cosmetic label.
//
//   behavior  — the full behavioural contract used to decide whether a matched
//               pair is ALIGNED (identical deployed behaviour) or DRIFTED (same
//               artefact, divergent behaviour). Compares ALL content so nothing
//               that affects the running system is silently ignored, with
//               volatile wiring (endpoints, auth, descriptions, annotations)
//               and cosmetic formatting (PromQL whitespace) normalised away.
//
// Pure ESM, no Node APIs — the studio imports this same file in the browser.

import { canonicalizePromql } from './promql-canon.mjs';

// ---------------------------------------------------------------------------
// Normalisation primitives
// ---------------------------------------------------------------------------

// Fields that legitimately differ between a repo manifest and a live
// reconstruction of the same artefact: deployment coordinates and presentation,
// not the contract. Stripped before comparison so "aligned" reflects the
// SEMANTIC definition, not whether the URLs or prose happen to agree.
//
// `folder` and `provider` are dashboard placement/deployment coordinates: which
// Grafana folder a dashboard files under, and which provisioning provider (and
// its version/schemaVersion) renders it. Two packs that file the same dashboard
// in different folders, or reconstruct it under a different provider version,
// describe the SAME dashboard — the contract is its panels/bindings, not where
// it's filed. Likewise, base observability infrastructure versions are inventory
// evidence for compile/deploy compatibility, not live-drift proof for an
// SLO/SLI requirement chain. The compiler still reads versions straight from the
// raw pack for emission fidelity, so dropping them here only affects EQUALITY,
// never what gets compiled.
const VOLATILE_SPEC_KEYS = new Set([
  'endpoints', 'endpoint', 'url', 'address', 'host', 'auth',
  'description', 'desc', 'title', 'summary', 'annotations',
  'source', 'evidence', 'mcp', 'default',
  'semconv',
  'origin', 'origin_kind', 'origin_file', 'origin_service', 'metric_type', 'help', 'origin_labels', 'origin_query',
  'measurement_source',
  'file', 'exports', 'scrape_query', 'metrics_path', 'interval', 'targets',
  'references', 'used_by',
  'folder', 'provider', 'version', 'params', 'panel_bindings',
]);

// Spec fields that carry an executable expression. Whitespace and surrounding
// blanks are cosmetic — `rate(x[5m])` and `rate( x[5m] )` deploy identically —
// so they're collapsed before comparison.
const EXPR_KEYS = new Set(['expr', 'query', 'promql', 'expression']);
const SLI_EXPR_KEYS = new Set(['good', 'total', 'query']);

function normalizeExpr(s) {
  // Whitespace collapse (the long-standing baseline) plus the ratified
  // Workstream B orderings — selector matcher order, by/without label
  // order — applied only when the expression parses cleanly. Parse
  // failures fall back to the conservative comparison; see
  // tools/lib/promql-canon.mjs for the contract and its fences.
  return canonicalizePromql(s).text;
}

// ---------------------------------------------------------------------------
// Values a source would not disclose
// ---------------------------------------------------------------------------

// A reader can know that a channel exists without being able to state its
// address. A running Alertmanager reports its configuration with every
// secret address replaced; a repository wires an address in at deploy time
// (`url: ${WEBHOOK_URL}`). The reader keeps the channel and writes one of
// these in place of the address (tools/lib/alert-routes.mjs):
//   redacted:secret     the source withheld it
//   unresolved:<VAR>    the source names the variable it is taken from
// Both say "a channel of this kind exists, its address is not stated here" —
// partial evidence, exactly like a reference-only expression: it cannot
// contradict the address the other pack states, so it is never a difference
// on its own. Both are URI-shaped, so a webhook carrying one validates.
export const REDACTED_CHANNEL_VALUE = 'redacted:secret';
export const UNRESOLVED_CHANNEL_PREFIX = 'unresolved:';

export function isWithheldValue(value) {
  return typeof value === 'string' && /^(?:redacted|unresolved):/i.test(value);
}

function stripRef(s) {
  if (typeof s !== 'string') return s ?? '';
  return s.replace(/^ref:/, '').replace(/^slos\./, '').replace(/^slis\./, '');
}

// Recursively normalise a value for order-independent structural equality:
// sort object keys, drop volatile/empty fields, normalise expressions, and
// collapse a version block to its declared contract (gating is an operational
// toggle, not the contract). Arrays are normalised element-wise then sorted so
// declaration order can't masquerade as drift.
export function canonicalize(value, keyName) {
  if (typeof value === 'string' && EXPR_KEYS.has(keyName)) {
    return normalizeExpr(value);
  }
  if (Array.isArray(value)) {
    const out = value
      .map((v) => canonicalize(v))
      .filter((v) => !isEmptyComparable(v))
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    return out.length ? out : undefined;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (VOLATILE_SPEC_KEYS.has(k)) continue;
      const cv = canonicalize(value[k], k);
      if (isEmptyComparable(cv)) continue;
      out[k] = cv;
    }
    return out;
  }
  return value;
}

function isEmptyComparable(value) {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

function sortedObject(value) {
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = value[k];
  return out;
}

// ---------------------------------------------------------------------------
// Family classification
// ---------------------------------------------------------------------------

// Resolve an artefact to its behavioural family. Prefers the canonical
// `defines` symbol the adapter attaches; otherwise reads the id prefix. The
// positional number in the id is never used as identity — only as a family
// discriminator here.
export function classify(artefact) {
  if (!artefact) return 'unknown';
  const defines = artefact.defines || '';
  if (defines.startsWith('slis.'))               return 'sli';
  if (defines.startsWith('slos.'))               return 'slo';
  if (defines.startsWith('telemetry.backends.')) return 'backend';
  if (defines.startsWith('queries.derived_views.')) return 'derived_view';
  if (defines.startsWith('dashboards.'))         return 'dashboard';

  const id = artefact.id || '';
  if (id === 'OTEL-01')          return 'otel';
  if (id.startsWith('PIP-RCV-')) return 'pipeline_receiver';
  if (id.startsWith('PIP-PRC-')) return 'pipeline_processor';
  if (id === 'PIP-EXP-MET')      return 'pipeline_exporter_metrics';
  if (id === 'PIP-EXP-LOG')      return 'pipeline_exporter_logs';
  if (id === 'PIP-EXP-TRC')      return 'pipeline_exporter_traces';
  if (id === 'STO-MET-01')       return 'storage_metrics';
  if (id === 'STO-LOG-01')       return 'storage_logs';
  if (id === 'STO-TRC-01')       return 'storage_traces';
  if (id.startsWith('SCRAPE-'))  return 'scrape_job';
  if (id.startsWith('METRIC-'))  return 'metric';
  if (id === 'PROF-01')          return 'profiling';
  if (id === 'NET-01')           return 'network';
  if (id === 'POE-01')           return 'policy_engine';
  if (id.startsWith('MESH-'))    return 'mesh';
  if (id.startsWith('COL-'))     return 'collection';
  if (id.startsWith('QRY-'))     return 'recording_rule';
  if (id.startsWith('PANEL-'))   return 'panel';
  if (id.startsWith('POL-'))     return 'burn_rate';
  if (id.startsWith('FCST-'))    return 'forecast';
  if (id.startsWith('ALR-'))     return 'alert_route';
  if (id.startsWith('RULE-'))    return 'alert_rule';
  if (id.startsWith('HEAL-'))    return 'remediation';
  if (id === 'BASE-01')          return 'baselines';
  if (id.startsWith('CHAOS-'))   return 'chaos';
  if (id.startsWith('SYN-'))     return 'synthetic';
  if (id.startsWith('IMP-'))     return 'imports';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Per-family identity
//
// Each entry returns the behaviour-determining identity object for its family.
// `s` is artefact.spec, `a` is the whole artefact (for the few cases that need
// the parent pointer, e.g. panels). The positional id is deliberately absent.
// ---------------------------------------------------------------------------

const IDENTITY = {
  // Contract handles. SLI/SLO ids ARE the contract — other artefacts bind to
  // them by id, so a rename is a genuine behavioural change, not cosmetic.
  sli:          (s, a) => ({ id: definedId(a, 'slis.') }),
  slo:          (s, a) => ({ id: definedId(a, 'slos.') }),
  derived_view: (s, a) => ({ id: definedId(a, 'queries.derived_views.') }),
  dashboard:    (s, a) => ({ id: definedId(a, 'dashboards.') }),

  // A backend's behaviour is "this product serving this signal". The id is a
  // cosmetic label — two packs naming the same backend differently still
  // deploy the same collector wiring.
  backend:      (s) => ({ product: low(s.product), signal: low(s.signal) }),

  // spec.otel is a singular required object and the adapter emits at most one
  // artefact (fixed OTEL-01 id), so the empty identity is a deliberate
  // singleton-per-pack invariant, not an accidental collision.
  otel:         () => ({}),

  // Pipeline stages identify by what they do, not by position. Same-named
  // stages (the collector's `batch/2` convention) share one identity on
  // purpose: config differences are drift of the same stage, and duplicate
  // instances survive via the diff's occurrence ordinals.
  pipeline_receiver:          (s) => ({ name: low(s.name) }),
  pipeline_processor:         (s) => ({ name: low(s.name) }),
  pipeline_exporter_metrics:  (s) => ({ signal: 'metrics', target: low(s.kind) }),
  pipeline_exporter_logs:     (s) => ({ signal: 'logs',    target: low(s.kind) }),
  pipeline_exporter_traces:   (s) => ({ signal: 'traces',  target: low(s.kind) }),

  storage_metrics: (s) => ({ signal: 'metrics', backend: low(s.backend) }),
  storage_logs:    (s) => ({ signal: 'logs',    backend: low(s.backend) }),
  storage_traces:  (s) => ({ signal: 'traces',  backend: low(s.backend) }),

  scrape_job:   (s) => ({ job: low(s.job) }),

  // A metric IS its series name — that's the handle every query targets.
  // Never the positional METRIC-NN index.
  metric:       (s) => ({ name: low(s.name) }),

  profiling:    (s) => ({ product: low(s.product) }),
  network:      (s) => ({ product: low(s.product) }),
  policy_engine:(s) => ({ product: low(s.product) }),
  mesh:         (s) => ({ product: low(s.product), role: low(s.role) }),
  collection:   (s) => ({ product: low(s.product), role: low(s.role) }),

  // A recording rule's deployed contract is the output series it produces.
  recording_rule: (s) => ({ record: low(s.name) }),

  // A bound panel's behaviour is what it visualises, scoped to its dashboard.
  // Unbound crawler-discovered panels still need a stable identity so a
  // dashboard's 37 query panels don't collapse into one "empty binding".
  panel:        (s, a) => ({
    parent: a.parent || '',
    binds_to: low(s.binds_to),
    panel: s.binds_to ? undefined : low(s.panel || s.title),
    query: s.binds_to ? undefined : normalizeExpr(s.expr || s.query || ''),
  }),

  burn_rate:    (s) => ({ slo: stripRef(s.slo) }),
  forecast:     (s) => ({ slo: stripRef(s.slo) }),
  // Routes key on severity alone, on purpose. Live and crawled packs
  // fabricate channel kinds when routing cannot be introspected (fetch-live's
  // SEV1 msteams placeholder, the crawler's unmapped-receiver stub), so
  // putting channel kinds into identity would turn those evidence gaps into
  // false "missing in production" verdicts. Channel changes surface as
  // decision-bearing drift on the paired route instead; same-severity
  // duplicates survive via the diff's occurrence ordinals and `collisions`.
  alert_route:  (s) => ({ severity: low(s.severity) }),
  // An operational alert rule (spec 1.4 alerting.rules) IS its name: the
  // exact name the engine evaluates it under — `alert:` in a rule file,
  // `title` of a Grafana-managed rule, `name` in a ruler's listing — is
  // what a repository and a live listing share. Never the RULE-NN index.
  alert_rule:   (s) => ({ name: low(s.name) }),
  remediation:  (s) => ({ trigger: low(s.trigger) }),
  // spec.baselines is a singular object (fixed BASE-01 id, at most one per
  // pack) — empty identity is the documented singleton invariant, like otel.
  baselines:    () => ({}),
  chaos:        (s) => ({ id: low(s.id) }),
  synthetic:    (s) => ({ id: low(s.id) }),
  imports:      (s) => ({ ref: stripRef(s.ref) }),
  unknown:      (s, a) => ({ id: a.id || '' }),
};

function definedId(artefact, prefix) {
  const d = artefact.defines || '';
  return d.startsWith(prefix) ? d.slice(prefix.length) : d || artefact.id || '';
}

function low(v) {
  return typeof v === 'string' ? v.toLowerCase() : (v ?? '');
}

// ---------------------------------------------------------------------------
// Public model API
// ---------------------------------------------------------------------------

// Build the behavioural model object for an artefact:
//   { kind, identity, behavior }
// `identity` pairs A↔B; `behavior` decides aligned vs drifted.
export function modelOf(artefact) {
  const kind = classify(artefact);
  const idFn = IDENTITY[kind] || IDENTITY.unknown;
  const identity = idFn(artefact?.spec || {}, artefact || {});
  const behavior = behaviorFor(kind, artefact?.spec ?? {});
  return { kind, identity, behavior };
}

// Spec fields that carry a symbolic reference to another artefact. The
// `ref:` prefix is authoring syntax — `slo: ref:x` and `slo: x` bind to the
// same SLO — so IDENTITY already strips it (stripRef); behaviour must agree
// or a burn alert pairs with itself and then reads as drifted on its own
// binding. `expr` counts only when the whole value is a reference
// (`ref:slis.x`), never inside a real expression.
const REF_KEYS = ['slo', 'sli', 'trigger', 'error_budget_policy'];

// Pure: returns a shallow copy of `spec` with the leading `ref:` removed
// from the reference-bearing fields. Never mutates its input.
function stripRefFields(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;
  const out = { ...spec };
  for (const k of REF_KEYS) {
    if (typeof out[k] === 'string') out[k] = out[k].replace(/^ref:/, '');
  }
  if (typeof out.expr === 'string' && /^ref:[a-z0-9_.:-]+$/i.test(out.expr.trim())) {
    out.expr = out.expr.trim().replace(/^ref:/, '');
  }
  return out;
}

function behaviorFor(kind, spec) {
  if (kind === 'metric') {
    return canonicalize({ name: spec.name });
  }
  if (kind === 'scrape_job') {
    return canonicalize({ job: spec.job });
  }
  if (kind === 'alert_rule') {
    // What the rule does: its expression (normalised like every expr), its
    // wait, its labels and the pack's severity. Not `engine`: a rule file
    // cannot tell a Prometheus ruler from a Mimir or VictoriaMetrics one
    // and a live listing may know more than the repository — reader
    // knowledge, not deployed behaviour. `source` and `annotations` are
    // volatile already.
    const { engine: _engine, ...rest } = stripRefFields(spec) || {};
    return canonicalize(rest);
  }
  if (kind === 'sli') {
    // An SLI's `good` and `total` are expressions like its `query`: the
    // same cosmetic normalisation applies (a ruler returns its rule bodies
    // with a trailing newline; a rule file does not).
    const out = stripRefFields(spec);
    for (const k of ['good', 'total']) {
      if (typeof out?.[k] === 'string') out[k] = normalizeExpr(out[k]);
    }
    return canonicalize(out);
  }
  return canonicalize(stripRefFields(spec));
}

// Stable primitive key for pairing. A Map needs a string key, so we serialise
// the {kind, identity} object — but the key is DERIVED FROM the behavioural
// identity object, not from a name. Two artefacts collide here iff they are the
// same behavioural artefact.
export function identityKeyOf(artefact) {
  if (!artefact) return null;
  const { kind, identity } = modelOf(artefact);
  return `${kind}::${stableStringify(identity)}`;
}

// The full behavioural contract object — what "compare the contents" compares.
export function behaviorOf(artefact) {
  return modelOf(artefact).behavior;
}

// Top-level behavioural fields whose values differ between two matched
// artefacts. Empty array ⇒ identical deployed behaviour (aligned).
export function deltasOf(a, b) {
  const kind = sharedKind(a, b);
  const ba = behaviorOf(a);
  const bb = behaviorOf(b);
  const fields = new Set([...Object.keys(ba), ...Object.keys(bb)]);
  const deltas = [];
  for (const f of [...fields].sort()) {
    const sa = JSON.stringify(ba[f] ?? null);
    const sb = JSON.stringify(bb[f] ?? null);
    if (sa !== sb && isPartialEvidenceExpressionDelta(kind, f, ba[f], bb[f])) continue;
    if (sa !== sb && kind === 'alert_route' && f === 'channels' && isWithheldChannelDelta(ba[f], bb[f])) continue;
    if (sa !== sb) deltas.push({ field: f, a: ba[f] ?? null, b: bb[f] ?? null });
  }
  return deltas;
}

function sharedKind(a, b) {
  const ka = classify(a);
  const kb = classify(b);
  return ka === kb ? ka : 'unknown';
}

function isPartialEvidenceExpressionDelta(kind, field, aValue, bValue) {
  const expressionField =
    EXPR_KEYS.has(field)
    || (kind === 'sli' && SLI_EXPR_KEYS.has(field));
  if (!expressionField) return false;
  if (!['sli', 'recording_rule', 'derived_view'].includes(kind)) return false;
  const aRef = isExpressionReferenceOnly(aValue);
  const bRef = isExpressionReferenceOnly(bValue);
  return aRef !== bRef;
}

// Two channel lists that differ only where one side's address is withheld.
// The channel KINDS must agree one for one; for a kind where neither side
// withholds an address, the addresses must agree too. Anything else is a
// real delta.
function isWithheldChannelDelta(aValue, bValue) {
  const a = channelPairs(aValue);
  const b = channelPairs(bValue);
  if (!a || !b) return false;
  if (![...a, ...b].some(([, v]) => isWithheldValue(v))) return false;
  const kinds = (list) => list.map(([k]) => k).sort().join(',');
  if (kinds(a) !== kinds(b)) return false;
  for (const kind of new Set(a.map(([k]) => k))) {
    const av = a.filter(([k]) => k === kind).map(([, v]) => v);
    const bv = b.filter(([k]) => k === kind).map(([, v]) => v);
    if (av.some(isWithheldValue) || bv.some(isWithheldValue)) continue;
    if (JSON.stringify([...av].sort()) !== JSON.stringify([...bv].sort())) return false;
  }
  return true;
}

// [[kind, address], …] of a route's channels, or null when it is not one.
function channelPairs(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const c of value) {
    const entry = c && typeof c === 'object' ? Object.entries(c)[0] : null;
    if (!entry) return null;
    out.push(entry);
  }
  return out;
}

function isExpressionReferenceOnly(value) {
  const s = normalizeExpr(value ?? '');
  if (!s) return true;
  if (/^ref:[a-z0-9_.:-]+$/i.test(s)) return true;
  // behaviorFor strips the `ref:` prefix before this check runs on the
  // behaviour fields, so the bare symbolic form counts as reference-only too.
  if (/^(?:slis|slos)\.[a-z0-9_.:-]+$/i.test(s)) return true;
  if (/^[a-z_:][a-z0-9_:]*(\{[^{}]*\})?$/i.test(s)) return true;
  if (/^(?:\d+(?:\.\d+)?|true|false)$/i.test(s)) return true;
  return false;
}

// True when two artefacts deploy to identical behaviour.
export function behaviorEqual(a, b) {
  return stableStringify(behaviorOf(a)) === stableStringify(behaviorOf(b));
}

// Deterministic JSON: object keys are already sorted by canonicalize, but
// identity objects are small hand-built maps — sort their keys too so key order
// never changes the serialisation.
function stableStringify(value) {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = v[k];
      return out;
    }
    return v;
  });
}

// ---------------------------------------------------------------------------
// Metric families
//
// One declared metric is several series on the wire. A histogram `x` is
// `x_bucket`, `x_count` and `x_sum`; a summary is `x`, `x_count` and `x_sum`;
// the Python client adds `x_created` beside a counter's `x_total` and beside
// a histogram's series. Source code declares the metric, a metrics store
// lists the series, a query references one of them. Paired name for name, a
// declared histogram reads "not live" while its own three series read "live,
// not declared".
//
// The family is the unit that is compared: every series folds into the
// metric it belongs to, on both sides, using what BOTH sides know.
// ---------------------------------------------------------------------------

const DISTRIBUTION_TYPE_RE = /histogram|summary|timer/i;

/**
 * A resolver from a series name to its family name.
 *
 * `names` is every metric name in play (both packs); `typeOf(name)` is the
 * declared type of a metric when a pack states one (`histogram`,
 * `go-prometheus-summary-vec`, …), else null. Names are compared lowercase.
 *
 *   x_bucket            → x                 (the suffix is reserved for histograms)
 *   x_count, x_sum      → x   when x is a distribution: x_bucket is known,
 *                             x is declared one, or both _count and _sum exist
 *   x_total             → x   when x is known and declared a counter (a
 *                             client that appends the suffix on exposition:
 *                             the Python client, OpenMetrics, OTel → Prometheus)
 *   x_created           → what x_total resolves to when that counter is
 *                             known; x when x is a distribution or is known
 *   anything else       → itself
 */
export function metricFamilyResolver(names, typeOf = () => null) {
  const known = new Set();
  for (const n of names || []) if (typeof n === 'string' && n) known.add(n.toLowerCase());
  const isDistribution = (base) =>
    known.has(`${base}_bucket`)
    || DISTRIBUTION_TYPE_RE.test(String(typeOf(base) || ''))
    || (known.has(`${base}_count`) && known.has(`${base}_sum`));
  const counterFamily = (n) => {
    const base = n.slice(0, -'_total'.length);
    return base && known.has(base) && /counter/i.test(String(typeOf(base) || '')) ? base : n;
  };
  return (name) => {
    const n = String(name || '').toLowerCase();
    if (n.endsWith('_bucket')) return n.slice(0, -'_bucket'.length);
    for (const suffix of ['_count', '_sum']) {
      if (!n.endsWith(suffix)) continue;
      const base = n.slice(0, -suffix.length);
      return base && isDistribution(base) ? base : n;
    }
    if (n.endsWith('_total')) return counterFamily(n);
    if (n.endsWith('_created')) {
      const base = n.slice(0, -'_created'.length);
      if (known.has(`${base}_total`)) return counterFamily(`${base}_total`);
      if (base && (isDistribution(base) || known.has(base))) return base;
    }
    return n;
  };
}

/**
 * Fold the metric artefacts of two artefact lists into families.
 *
 * Returns { a, b }: the same lists, where every group of metric artefacts
 * that belong to one family is replaced by ONE artefact carrying the family
 * name (`spec.name`, `title`), `series` — the names it stands for, sorted —
 * and `memberIds`, the ids of the artefacts it replaces, so a reader that
 * lists a pack's own artefacts can say which family each belongs to. The
 * artefact it is built from is the member named like the
 * family when there is one (the declaration), else the first by name. A
 * metric that is alone in its family and already named like it is passed
 * through untouched, as is every artefact that is not a metric. Inputs are
 * never mutated.
 */
export function foldMetricFamilies(aItems, bItems) {
  const metricsOf = (items) => (items || []).filter((x) => classify(x) === 'metric');
  const nameOf = (x) => String(x?.spec?.name || '').toLowerCase();
  const all = [...metricsOf(aItems), ...metricsOf(bItems)];
  if (!all.length) return { a: aItems || [], b: bItems || [] };
  const types = new Map();
  for (const x of all) {
    const t = x?.spec?.metric_type;
    if (t && !types.has(nameOf(x))) types.set(nameOf(x), t);
  }
  const familyOf = metricFamilyResolver(all.map(nameOf), (n) => types.get(n) || null);

  const fold = (items) => {
    const out = [];
    const groups = new Map();
    for (const x of items || []) {
      if (classify(x) !== 'metric') { out.push(x); continue; }
      const family = familyOf(nameOf(x));
      if (!groups.has(family)) { groups.set(family, []); out.push({ family }); }
      groups.get(family).push(x);
    }
    return out.map((slot) => {
      if (!slot.family || !groups.has(slot.family) || classify(slot) === 'metric') return slot;
      const members = groups.get(slot.family).slice().sort((x, y) => nameOf(x).localeCompare(nameOf(y)));
      const head = members.find((x) => nameOf(x) === slot.family) || members[0];
      if (members.length === 1 && nameOf(head) === slot.family) return head;
      return {
        ...head,
        title: slot.family,
        spec: { ...head.spec, name: slot.family },
        series: [...new Set(members.map((x) => String(x.spec?.name || '')))].sort(),
        memberIds: members.map((x) => x.id).filter(Boolean),
      };
    });
  };
  return { a: fold(aItems), b: fold(bItems) };
}
