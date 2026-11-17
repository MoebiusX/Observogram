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

import { sameDeployment } from './lifecycle.mjs';
import { canonicalizePromql } from './promql-canon.mjs';
import { familyOf } from './artefact-classify.mjs';

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

// PARTLY OBSERVED FIELDS
// A producer may have been shown a field only in part: a live rule listing
// that gives each alert rule a flat `severity` and no `labels` object showed
// that one label and no other. The pack says so per artefact, in
//   observogram.partial.<symbol> = <field>=<key>,<key>[;<field>=…]
// — of that field (a map), the keys the producer was shown; none after the
// `=`, nothing of it. The adapter puts it on the artefact as
// `partial: { <field>: [keys] }`, and the comparison holds the artefact to
// those keys: a key it was never shown cannot contradict what the other pack
// states, so it is never a difference on its own (deltasOf), and the pair
// says which keys went uncompared (unobservedOf). Today one field of one
// family uses it: an alert rule's `labels`.
// A second field a side may not have been shown is the `condition` of a
// Grafana-managed rule (below): a listing that does not show a rule's
// threshold states none, and a condition only one side states is never a
// difference — the pair says it went uncompared (`{ field: 'condition' }`).
export const PARTIAL_ANNOTATION_PREFIX = 'observogram.partial.';

/** `{ labels: ['severity'] }` → `labels=severity`, fields and keys sorted. */
export function partialAnnotation(fields) {
  return Object.keys(fields || {}).sort()
    .map((f) => `${f}=${[...new Set((fields[f] || []).map(String))].sort().join(',')}`)
    .join(';');
}

/** The annotation's value → `{ <field>: [keys] }`, or null when it states nothing. */
export function parsePartialAnnotation(value) {
  if (typeof value !== 'string' || !value.includes('=')) return null;
  const out = {};
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    const field = eq < 0 ? '' : part.slice(0, eq).trim();
    if (!field) continue;
    out[field] = part.slice(eq + 1).split(',').map((k) => k.trim()).filter(Boolean);
  }
  return Object.keys(out).length ? out : null;
}

function stripRef(s) {
  if (typeof s !== 'string') return s ?? '';
  return s.replace(/^ref:/, '').replace(/^slos\./, '').replace(/^slis\./, '');
}

// WHAT A GRAFANA-MANAGED RULE STATES BEYOND THE SPEC
// Spec 1.4's AlertRule is closed: a Grafana-managed rule's uid, folder, group
// and its threshold (an expression node beside the query, never in `expr`)
// have no field there. Both readers state them beside the rule
// (sli-inference.mjs grafanaRuleFacts):
//   observogram.grafana_rule.<symbol> = {"uid":…,"folder":…,"folderUid":…,"group":…,"condition":…}
// for `alerting.rules[<i>]` (and a Grafana-managed recording rule's
// `queries.recording_rules[<i>]`). The adapter puts it on the artefact as
// `grafana`. The comparison holds an alert rule's `condition` as part of its
// behaviour; the uid pairs a rule renamed on one side (diff.mjs); the folder
// and group answer a scope (live-fetch.mjs).
export const GRAFANA_RULE_ANNOTATION_PREFIX = 'observogram.grafana_rule.';
const GRAFANA_RULE_FIELDS = Object.freeze(['uid', 'folder', 'folderUid', 'group', 'condition']);

/** The annotation's value → { uid?, folder?, folderUid?, group?, condition? } (non-empty strings only), or null. */
export function parseGrafanaRuleAnnotation(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out = {};
  for (const k of GRAFANA_RULE_FIELDS) if (typeof parsed[k] === 'string' && parsed[k]) out[k] = parsed[k];
  return Object.keys(out).length ? out : null;
}

// THE RULES A BURN-RATE ENTRY WAS READ FROM
// A hand-written alerting rule on an SLO's recorded series is declared as
// that SLO's burn-rate entry, { slo, windows }, a shape the spec closes; the
// windows are the reader's own, so the rule's expression (its threshold) and
// severity are in no field of the entry, and its wait only as a window. The
// pack says them beside it, per SLO (docs/DIFF.md):
//   observogram.source_rules.policy.burn_rate_alerts.<slo id> = <JSON list>
// of { name, expr, for?, severity?, labels?, partial? } — a rule's terms as
// operationalAlertRule reads them (sli-inference.mjs sourceRuleTerms, the
// one function both readers write it through); `partial` is what the reader
// was shown of the rule only in part, as an artefact's `partial` says it
// ({ labels: [keys shown] }). The adapter puts the list on the burn-rate
// artefact as `sourceRules`, beside `spec` (the entry is closed, and `spec`
// may be copied back into a pack). When BOTH artefacts of a pair state it,
// each rule is also held to its counterpart of the same name, as an
// operational alert rule is (deltasOf). A rule only one side states, and a
// side that states none, are held to nothing.
export const SOURCE_RULES_ANNOTATION_PREFIX = 'observogram.source_rules.';

/** The annotation that states the rules the burn-rate entry of `slo` was read from. */
export function sourceRulesAnnotationKey(slo) {
  return `${SOURCE_RULES_ANNOTATION_PREFIX}policy.burn_rate_alerts.${stripRef(slo)}`;
}

/**
 * The annotation's value → the rules' terms, or null when it states none.
 * A value that is not a JSON list of rules, each with a name and an
 * expression, states nothing: half a list would be compared as the whole.
 */
export function parseSourceRulesAnnotation(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let list;
  try { list = JSON.parse(value); } catch { return null; }
  if (!Array.isArray(list) || !list.length) return null;
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    if (typeof r.name !== 'string' || !r.name || typeof r.expr !== 'string' || !r.expr) return null;
    const terms = { name: r.name, expr: r.expr };
    if (typeof r.for === 'string' && r.for) terms.for = r.for;
    if (typeof r.severity === 'string' && r.severity) terms.severity = r.severity;
    if (typeof r.condition === 'string' && r.condition) terms.condition = r.condition;
    if (r.labels && typeof r.labels === 'object' && !Array.isArray(r.labels)) {
      const labels = {};
      for (const k of Object.keys(r.labels)) if (k !== '__proto__' && typeof r.labels[k] === 'string') labels[k] = r.labels[k];
      if (Object.keys(labels).length) terms.labels = labels;
    }
    // Of `partial`, the one field the comparison reads: the label keys shown.
    if (Array.isArray(r.partial?.labels)) terms.partial = { labels: r.partial.labels.filter((k) => typeof k === 'string') };
    out.push(terms);
  }
  return out;
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
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y), 'en'));
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

// Resolve an artefact to its behavioural family — tools/lib/artefact-classify.mjs
// decides (an explicit `type` first, then the canonical `defines` symbol the
// adapter attaches, then the taxonomy override's id rules, then the id
// prefix). The positional number in the id is never used as identity — only
// as a family discriminator there.
export function classify(artefact) {
  return artefact ? familyOf(artefact) : 'unknown';
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
  // A Grafana-managed alert rule's threshold and other steps (`grafana.condition`) are part of what it does.
  const condition = kind === 'alert_rule' && typeof artefact?.grafana?.condition === 'string' && artefact.grafana.condition ? artefact.grafana.condition : null;
  const behavior = behaviorFor(kind, condition ? { ...(artefact?.spec ?? {}), condition } : (artefact?.spec ?? {}));
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
  const deltas = behaviourDeltas(kind, behaviorOf(a), behaviorOf(b), a, b);
  // A burn-rate pair whose two entries both say which alerting rules they
  // were read from is held to those rules as well, each with its counterpart.
  const rules = kind === 'burn_rate' ? compareSourceRules(a, b) : null;
  return rules ? [...deltas, ...rules.deltas.map((d) => ({ ...d, a: ownCopy(d.a), b: ownCopy(d.b) }))] : deltas;
}

// A kept value handed out as the caller's own: what a caller does to one answer
// must not reach the next.
const ownCopy = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

// The fields of two behaviours that differ. `a` and `b` carry what each side
// said about its own evidence beside the behaviour (`partial`).
function behaviourDeltas(kind, ba, bb, a, b) {
  const fields = new Set([...Object.keys(ba), ...Object.keys(bb)]);
  // The label keys both sides were shown, when a side saw an alert rule's
  // labels only in part; null when both saw them whole.
  const shown = kind === 'alert_rule' ? shownLabelKeys(a, b) : null;
  const deltas = [];
  for (const f of [...fields].sort()) {
    const sa = JSON.stringify(ba[f] ?? null);
    const sb = JSON.stringify(bb[f] ?? null);
    if (sa === sb) continue;
    if (isPartialEvidenceExpressionDelta(kind, f, ba[f], bb[f])) continue;
    // A condition one side does not state (a listing that does not show it) cannot contradict the other's.
    if (kind === 'alert_rule' && f === 'condition' && (ba[f] == null || bb[f] == null)) continue;
    if (kind === 'alert_route' && f === 'channels' && isWithheldChannelDelta(ba[f], bb[f])) continue;
    if (shown && f === 'labels') {
      // Compared on the keys both were shown, and reported on those alone.
      const la = pickKeys(ba[f], shown);
      const lb = pickKeys(bb[f], shown);
      if (JSON.stringify(la) !== JSON.stringify(lb)) deltas.push({ field: f, a: la, b: lb });
      continue;
    }
    // The pack's severity is read from the severity label: not shown, not compared.
    if (shown && f === 'severity' && !shown.includes('severity')) continue;
    deltas.push({ field: f, a: ba[f] ?? null, b: bb[f] ?? null });
  }
  return deltas;
}

// What a matched pair could not be compared on: for each side that was shown
// a field only in part (`partial`, the adapter's reading of
// `observogram.partial.<symbol>`), the keys the OTHER side states there that
// it was never shown — `[{ field, side, keys }]`, `side` the one that did
// not see them. A burn-rate pair says it of the alerting rules it was read
// from, one entry per rule and side, each naming its `rule` (and, where the
// name holds several pairs, which of them: `nth`). Empty for a pair compared
// whole.
export function unobservedOf(a, b) {
  const kind = sharedKind(a, b);
  if (kind === 'alert_rule') return ruleUnobserved(a, b, behaviorOf(a), behaviorOf(b));
  if (kind === 'burn_rate') return (compareSourceRules(a, b)?.unobserved || []).map((u) => ({ ...u, keys: [...u.keys] }));
  return [];
}

function ruleUnobserved(a, b, ba, bb) {
  const out = [];
  for (const [side, self, stated] of [['a', a, bb || {}], ['b', b, ba || {}]]) {
    const seen = partialKeysOf(self, 'labels');
    if (!seen) continue;
    const labels = stated.labels && typeof stated.labels === 'object' && !Array.isArray(stated.labels) ? stated.labels : {};
    // The pack's severity is read from the severity label: stated there
    // without the label, it went uncompared all the same.
    const named = new Set(Object.keys(labels));
    if (stated.severity != null) named.add('severity');
    const keys = [...named].filter((k) => !seen.includes(k)).sort();
    if (keys.length) out.push({ field: 'labels', side, keys });
  }
  // A Grafana-managed rule's condition stated by one side only went uncompared.
  if ((ba?.condition == null) !== (bb?.condition == null)) out.push({ field: 'condition', side: ba?.condition == null ? 'a' : 'b', keys: [] });
  return out;
}

function partialKeysOf(artefact, field) {
  const keys = artefact?.partial?.[field];
  return Array.isArray(keys) ? keys : null;
}

function shownLabelKeys(a, b) {
  const pa = partialKeysOf(a, 'labels');
  const pb = partialKeysOf(b, 'labels');
  if (!pa && !pb) return null;
  if (pa && pb) return pa.filter((k) => pb.includes(k)).sort();
  return [...(pa || pb)].sort();
}

function pickKeys(map, keys) {
  const out = {};
  if (map && typeof map === 'object' && !Array.isArray(map)) for (const k of keys) if (k in map) out[k] = map[k];
  return out;
}

// ---------------------------------------------------------------------------
// The alerting rules a burn-rate entry was read from
// ---------------------------------------------------------------------------

// The list an artefact states, or null. The adapter's parse makes every item a
// rule with a name and an expression; a list built by hand that is not one
// states nothing.
function sourceRulesOf(artefact) {
  const list = artefact?.sourceRules;
  if (!Array.isArray(list) || !list.length) return null;
  const rule = (r) => r && typeof r === 'object' && typeof r.name === 'string' && r.name && typeof r.expr === 'string' && r.expr;
  return list.every(rule) ? list : null;
}

// A rule's terms as the behaviour of the alert rule it is, and that behaviour
// with what the rule says of its own evidence as one string — its content,
// whatever order a side lists it in. Each read once a rule.
const RULE_READINGS = new WeakMap();
function ruleReading(terms) {
  let reading = RULE_READINGS.get(terms);
  if (!reading) {
    const { partial, ...spec } = terms;
    const behaviour = behaviorFor('alert_rule', spec);
    const shown = Array.isArray(partial?.labels) ? [...partial.labels].sort() : null;
    reading = { behaviour, signature: JSON.stringify([behaviour, shown]) };
    RULE_READINGS.set(terms, reading);
  }
  return reading;
}
const ruleBehaviour = (terms) => ruleReading(terms).behaviour;

function ruleDeltas(x, y) {
  return behaviourDeltas('alert_rule', ruleBehaviour(x), ruleBehaviour(y), x, y);
}

// One name's rules on each side, paired closest first: a pair that matches
// whole, then one that matches on the part it was shown, then two rules with
// the same expression, then any two — and in each step the two of ALL still
// open that differ least, ties settled by the rules' own content. Never each
// rule in the order a side lists them: where a name holds more rules on one
// side, the first listed would take a counterpart a later one is nearer to,
// and the answer would change with the listing's order or with the sides
// swapped. A rule left without a counterpart is not compared.
function pairRulesOfOneName(as, bs) {
  // Each pair is measured once, however often it is asked about.
  const measured = as.map(() => []);
  const measure = (i, j) => {
    if (!measured[i][j]) {
      const n = ruleDeltas(as[i], bs[j]).length;
      const whole = n === 0 && ruleUnobserved(as[i], bs[j], ruleBehaviour(as[i]), ruleBehaviour(bs[j])).length === 0;
      measured[i][j] = { n, whole };
    }
    return measured[i][j];
  };
  // A rule's content as its place among the contents of both sides: a pair's
  // tie-break is its two places, the lower first — the same for (x, y) as for
  // (y, x), and two numbers to compare where the contents are long strings.
  const sa = as.map((r) => ruleReading(r).signature);
  const sb = bs.map((r) => ruleReading(r).signature);
  const place = new Map([...new Set([...sa, ...sb])].sort().map((s, at) => [s, at]));
  const pa = sa.map((s) => place.get(s));
  const pb = sb.map((s) => place.get(s));
  const openA = new Set(as.keys());
  const openB = new Set(bs.keys());
  const pairs = [];
  const steps = [
    (i, j) => measure(i, j).whole,
    (i, j) => measure(i, j).n === 0,
    (i, j) => ruleBehaviour(as[i]).expr === ruleBehaviour(bs[j]).expr,
    () => true,
  ];
  for (const among of steps) {
    if (!openA.size || !openB.size) break;
    // The step's candidates in the order they would be chosen one at a time;
    // taking each whose two rules are both still open is that same choice.
    const candidates = [];
    for (const i of openA) {
      for (const j of openB) {
        if (!among(i, j)) continue;
        candidates.push({ i, j, n: measure(i, j).n, lo: Math.min(pa[i], pb[j]), hi: Math.max(pa[i], pb[j]) });
      }
    }
    candidates.sort((x, y) => x.n - y.n || x.lo - y.lo || x.hi - y.hi);
    for (const { i, j } of candidates) {
      if (!openA.has(i) || !openB.has(j)) continue;
      openA.delete(i);
      openB.delete(j);
      pairs.push([as[i], bs[j]]);
    }
  }
  return pairs;
}

/**
 * The comparison of the alerting rules two burn-rate entries were read
 * from, or null unless BOTH state them: each rule against its counterpart of
 * the same name, as an operational alert rule is compared.
 *   deltas      under the alert rule's own field names (`expr`, `for`,
 *               `severity`, `labels`), the rule's name beside them as
 *               `rule` — never inside `field`, which the weight tables
 *               read word by word — and, where the name holds several pairs,
 *               which of them as `nth`
 *   unobserved  what each pair could not be compared on, per rule
 * A rule only one side states is held against nothing: the other side may
 * simply not have listed it (another engine, a scope, a file the scan did
 * not read, a chart condition). Where its wait was read into the entry's
 * windows, those differ as they always did.
 * Measured once for two lists, however often the pair is asked about (the
 * diff's matcher and the chain each ask several times).
 */
const RULE_COMPARISONS = new WeakMap();
function compareSourceRules(a, b) {
  const ra = sourceRulesOf(a);
  const rb = sourceRulesOf(b);
  if (!ra || !rb) return null;
  let known = RULE_COMPARISONS.get(ra);
  if (!known) RULE_COMPARISONS.set(ra, known = new WeakMap());
  let result = known.get(rb);
  if (result) return result;
  const byName = (list) => {
    const groups = new Map();
    for (const r of list) {
      const key = low(r.name);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    return groups;
  };
  const ga = byName(ra);
  const gb = byName(rb);
  const deltas = [];
  const unobserved = [];
  for (const key of [...ga.keys()].filter((k) => gb.has(k)).sort()) {
    const pairs = pairRulesOfOneName(ga.get(key), gb.get(key));
    pairs.forEach(([x, y], at) => {
      const which = pairs.length > 1 ? { rule: x.name, nth: at + 1 } : { rule: x.name };
      for (const d of ruleDeltas(x, y)) deltas.push({ ...d, ...which });
      for (const u of ruleUnobserved(x, y, ruleBehaviour(x), ruleBehaviour(y))) unobserved.push({ ...u, ...which });
    });
  }
  result = { deltas, unobserved };
  known.set(rb, result);
  return result;
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

// True when two artefacts deploy to identical behaviour — their `spec`s alone.
// What rides beside the spec (the rules a burn-rate entry was read from, a
// field shown in part) is deltasOf's to weigh.
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
      const members = groups.get(slot.family).slice().sort((x, y) => nameOf(x).localeCompare(nameOf(y), 'en'));
      const head = members.find((x) => nameOf(x) === slot.family) || members[0];
      if (members.length === 1 && nameOf(head) === slot.family) return head;
      // A lifecycle statement covers the family only when every series carries it.
      const { lifecycle, ...rest } = head;
      return {
        ...rest,
        ...(lifecycle && members.every((x) => x.lifecycle && sameDeployment(x.lifecycle, lifecycle)) ? { lifecycle } : {}),
        title: slot.family,
        spec: { ...head.spec, name: slot.family },
        series: [...new Set(members.map((x) => String(x.spec?.name || '')))].sort(),
        memberIds: members.map((x) => x.id).filter(Boolean),
      };
    });
  };
  return { a: fold(aItems), b: fold(bItems) };
}
