// tools/lib/library.mjs
//
// The BUILD journey engine (docs/BUILD_JOURNEY.md, slice 1): a library of
// parameterised pack fragments — one YAML entry per product or archetype
// under library/ — and the instantiation that turns one entry (or several)
// plus a service name, a criticality tier, an environment and a few toggles
// into a canonical ObservabilityPack v1.2 that tools/lib/validator.mjs
// accepts, tools/lib/compile.mjs compiles and tools/lib/conformance.mjs
// scores at that tier.
//
// Three ideas, in the order they are applied:
//
//   1. An ENTRY contributes what is product-specific: SLI templates (metric
//      names + PromQL, a minTier, per-tier SLO objectives, a burn profile),
//      scrape jobs, product dashboards, derived views, synthetic probes, chaos
//      and remediation templates (a remediation's trigger is derived: the
//      SLI's fast burn alert, the only alerts a library pack compiles), with
//      an evidence block per entry and per SLI
//      (recorded-live | reference-pack | upstream-docs | semconv).
//   2. The TIER SCAFFOLD (tierScaffold, one function shared by every entry)
//      produces the structural sections a tier needs — otel, telemetry
//      backends, pipelines, storage, queries, dashboards, policy, alerting,
//      remediation, baselines, validation — sized so that every MUST clause
//      of tools/lib/conformance.mjs that applies at the tier is satisfied
//      when every toggle is on. Tier requirements are NOT a second rubric:
//      tierRequirements(tier) is the conformance rubric filtered by minTier.
//   3. PLACEHOLDERS. Values the library cannot know (a pager service, a
//      chaos target, the address of the Prometheus) are parameters flagged
//      `placeholder: true`. A placeholder left at its default is written into
//      the pack as a plausible value AND reported as a todo at the path where
//      it landed, mirroring the crawler's `crawler.scaffold.<symbol>`
//      annotations: `metadata.annotations['library.todo.<symbol>']`, where
//      <symbol> is the artefact id the adapter uses (`alerting.routes[0]`,
//      `validation.synthetic_checks.<id>`, `telemetry.backends.<id>`, …), so
//      the studio parks the artefact as Scaffold exactly as it parks a
//      crawler stub (tools/lib/adapter.mjs scaffoldPrefixes).
//
// Provenance: every produced pack carries
// `metadata.annotations['library.source'] = '<entry id>@<entry version>'`
// (comma-joined when several entries are composed) plus `library.tier`,
// `library.toggles`, `library.slis`, `library.params` and per-SLI evidence
// (`library.evidence.slis.<id>`), so diff can tell library-derived from
// hand-written and a later library release can propose upgrades.
//
// THE TIER IS A SEED, NOT A CONSTRAINT (docs/BUILD_JOURNEY.md "The seed and
// the copies"). The tier decides what a pack STARTS with (defaultToggles: the
// SLIs whose minTier it reaches, the scaffold's sections) and which RUBRIC
// grades it (tierRequirements). It never forbids an SLI: any SLI of a passed
// entry may be selected at any tier; a value declared per tier resolves for
// an above-tier SLI by walking towards the stricter tiers (perTier). An SLI's
// own tier features (forecast, chaos, remediation with a minTier) keep their
// gating against the pack's tier — they are tier features, not the SLI.
//
// COPIES, NOT LINKS. The library values are defaults the caller may edit:
// `overrides` (per SLI: id, objective, window, threshold, query / good / total,
// description, unit, semconv_metric — copy-on-write over the template) and
// `custom` (SLIs written from scratch). An edited expression drops the
// library's evidence (status `custom`); a renamed id keeps it (the expression
// is still the library's) and the SLO, the recording rule, the bindings and
// the provenance follow the new id; the provenance lists what was customised
// per SLI.
//
// Toggles leave honest gaps: a section switched off is absent from the pack;
// the schema (minItems: 1 on slos / dashboards / burn_rate_alerts / routes)
// and the rubric then both say what is missing — nothing is faked to keep a
// clause green.
//
// PURE and browser-safe (served at /lib to the studio in slice 2): no
// node:* imports, no process.env, no filesystem. server/library.mjs reads
// the entries from disk and hands them here, and the PromQL grammar check
// is a parser handed in (opts.promql: the Lezer wrapper in Node) for the
// same reason.

import { parse as parseYaml } from './mini-yaml.mjs';
import { RUBRIC, TIER_RANK, evaluateConformance } from './conformance.mjs';
import { fileSlug, metricPrefix } from './slug.mjs';
import { compileBurnRules } from './burn-rules.mjs';

// ---------------------------------------------------------------------------
// Constants — the entry format and the scaffold's fixed vocabulary
// ---------------------------------------------------------------------------

export const LIBRARY_FORMAT = 'v1';
/** Least stringent first — the order the studio lists them. */
export const TIERS = ['tier-3', 'tier-2', 'tier-1'];
export const ENTRY_KINDS = ['product', 'archetype'];
export const EVIDENCE_STATUSES = ['recorded-live', 'reference-pack', 'upstream-docs', 'semconv'];
export const SLI_TYPES = ['ratio', 'threshold'];
export const SLO_WINDOWS = ['7d', '28d', '30d', '90d'];
/** The sections a toggle can switch off (each is an honest gap when off). */
export const SECTION_TOGGLES = ['slos', 'policy', 'routes', 'dashboards', 'validation'];
export const SEMCONV_VERSION = '1.27.0';   // L2.MUST.semconv_current pins this exact version at tier-1
const DEFAULT_TIER = 'tier-3';
const DEFAULT_ENVIRONMENT = 'prod';
const PACK_VERSION = '0.1.0';
const BINDING = 'otel-grafanalabs';         // Prometheus + Loki + Tempo + Grafana: what the scaffold wires
const BUDGET_POLICY = 'ref:platform/std-budget-policy';
const GRAFANA_PROVIDER = { kind: 'grafana', version: '12.4', schemaVersion: 41 };

/**
 * Multi-window burn-rate profiles (Google SRE playbook windows, the factors
 * and severities of the reference packs). An SLI names one; tier-3 demotes
 * every severity one step (a tier-3 service pages nobody for a burn).
 */
export const BURN_PROFILES = Object.freeze({
  availability: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV1' }, { short: '30m', long: '6h', factor: 6, severity: 'SEV2' }],
  latency:      [{ short: '5m', long: '1h', factor: 14, severity: 'SEV2' }, { short: '30m', long: '6h', factor: 6, severity: 'SEV3' }],
  saturation:   [{ short: '10m', long: '1h', factor: 10, severity: 'SEV2' }, { short: '1h', long: '6h', factor: 4, severity: 'SEV3' }],
  slow:         [{ short: '15m', long: '2h', factor: 8, severity: 'SEV2' }, { short: '1h', long: '6h', factor: 3, severity: 'SEV3' }],
});
const DEMOTE = { SEV1: 'SEV2', SEV2: 'SEV3', SEV3: 'SEV3', SEV4: 'SEV4' };
/** The profile an SLI takes when its template names none — and every custom SLI: availability for a ratio, latency for a threshold. */
export const DEFAULT_BURN_PROFILE = Object.freeze({ ratio: 'availability', threshold: 'latency' });
/** The two windows of an SLI at a tier: its template's profile (or the default one), severities demoted one step at tier-3. */
function burnWindowsFor(template, tier) {
  const profile = Array.isArray(template.burn) ? template.burn : BURN_PROFILES[template.burn || DEFAULT_BURN_PROFILE[template.type]];
  return profile.map(w => ({ ...w, severity: tier === 'tier-3' ? DEMOTE[w.severity] || w.severity : w.severity }));
}
/**
 * The fields an override may carry, keyed by the SLI id as the library gives it to the pack (prefixed when several
 * entries compose; docs/BUILD_JOURNEY.md "The seed and the copies"). `id` renames the SLI in the pack — the key
 * stays the library's, so a caller keeps a renamed SLI attached to its library row; `semconv_metric` restates the
 * metric the SLI reads.
 */
export const OVERRIDE_FIELDS = Object.freeze(['id', 'objective', 'window', 'threshold', 'query', 'good', 'total', 'description', 'unit', 'semconv_metric']);
/** The fields of a custom SLI (`custom: [...]`): its identity, then the override fields (its id is its key, not an override). */
export const CUSTOM_FIELDS = Object.freeze(['id', 'type', ...OVERRIDE_FIELDS.filter(f => f !== 'id')]);
/** An override key: the SLI id as the pack carries it (prefixed when several entries compose). */
export const SLI_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** A custom SLI's id: a slug of at least two characters (the schema's Slug, one segment). */
export const CUSTOM_ID_RE = /^[a-z][a-z0-9_]{1,62}$/;
/** Never read through the prototype chain: these keys are refused before anything is looked up. */
const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** The fields that replace the library's PromQL: an edit here drops the library's evidence for the SLI. */
const PROMQL_FIELDS = ['query', 'good', 'total'];
const MAX_UNIT_LENGTH = 64;
/** A semconv metric name (`http.server.request.duration`): one token, bounded. */
const MAX_METRIC_LENGTH = 128;

/**
 * Parameters every instantiation has, whatever the entry: the values the
 * scaffold cannot know. `placeholder: true` ones become todos when left at
 * their default. Defaults may use the built-ins ${service} / ${environment}.
 */
export const SCAFFOLD_PARAMS = Object.freeze([
  { id: 'oncall_channel', label: 'Chat channel for SEV1/SEV2', default: '#${service}-oncall', placeholder: true, description: 'The Teams channel the SEV1 and SEV2 routes post to.' },
  { id: 'team_channel', label: 'Chat channel for SEV3', default: '#${service}-team', placeholder: true, description: 'The Teams channel the SEV3 route posts to.' },
  { id: 'pager_service', label: 'Voice (pager) target for SEV1', default: 'pagerduty://${service}', placeholder: true, description: 'The voice channel of the SEV1 route (tier-2 and tier-1; L4.MUST.tier1_voice_route).' },
  { id: 'pager_service_low', label: 'Voice (pager) target for SEV2', default: 'pagerduty://${service}-low', placeholder: true, description: 'The voice channel of the SEV2 route (tier-1).' },
  { id: 'metrics_endpoint', label: 'Prometheus query endpoint', default: 'http://prometheus:9090', placeholder: true, description: 'Where the metrics backend answers PromQL (telemetry.backends metrics-prom).' },
  { id: 'remote_write_url', label: 'Prometheus remote-write URL', default: 'http://prometheus:9090/api/v1/write', placeholder: true, description: 'Where the collector remote-writes metrics (pipelines.exporters.metrics).' },
  { id: 'logs_endpoint', label: 'Loki endpoint', default: 'http://loki:3100', placeholder: true, description: 'Where the logs backend answers (telemetry.backends logs-loki).' },
  { id: 'logs_otlp_endpoint', label: 'Loki OTLP ingest endpoint', default: 'http://loki:3100/otlp', placeholder: true, description: 'Where the collector pushes logs over OTLP/HTTP (pipelines.exporters.logs).' },
  { id: 'traces_endpoint', label: 'Tempo endpoint', default: 'http://tempo:3200', placeholder: true, description: 'Where the traces backend answers (telemetry.backends traces-tempo).' },
  { id: 'traces_otlp_endpoint', label: 'Tempo OTLP ingest endpoint', default: 'tempo:4317', placeholder: true, description: 'Where the collector pushes traces over OTLP/gRPC (pipelines.exporters.traces).' },
  { id: 'chaos_target', label: 'Chaos target workload', default: '${service}', placeholder: true, description: 'The workload the generic chaos experiments inject faults into (entries with their own chaos templates name their own targets).' },
  { id: 'probe_target', label: 'Health probe target', default: 'http://${service}:8080/health', placeholder: true, description: 'The URL the fallback blackbox probe hits (entries with their own synthetic templates do not use it).' },
  { id: 'runbook_dir', label: 'Runbook directory', default: 'runbooks', placeholder: false, description: 'Directory the remediation runbook paths point into (file://<dir>/<name>.md).' },
  // The backend versions the pack declares (telemetry.backends[].version.declared, storage.<signal>.version) are the
  // team's to state; the scaffold cannot know them and tier-1 gates on the version block (gating: enforce). `min` is
  // not a parameter: it is the floor the scaffold's wiring and the library's PromQL are known to work from.
  { id: 'prometheus_version', label: 'Prometheus version you run', default: '3.14', placeholder: true, description: 'The version of the Prometheus that stores the metrics (telemetry.backends metrics-prom version.declared, storage.metrics.version); min stays 2.53, the floor the expressions are known to work from, and tier-1 enforces the block.' },
  { id: 'loki_version', label: 'Loki version you run', default: '3.7', placeholder: true, description: 'The version of the Loki that stores the logs (telemetry.backends logs-loki version.declared, storage.logs.version); min stays 3.0.' },
  { id: 'tempo_version', label: 'Tempo version you run', default: '2.10', placeholder: true, description: 'The version of the Tempo that stores the traces (telemetry.backends traces-tempo version.declared, storage.traces.version); min stays 2.5.' },
]);
const BUILTIN_PARAMS = ['service', 'environment', 'tier'];
/** The compiler's policy records are `<service>:errorbudget:burn_<w>`; an SLI of that id would write the same series (tools/lib/sli-inference.mjs reserves it). */
const POLICY_SEGMENT = 'errorbudget';
/** A param value is spliced verbatim into label matchers (`job="${x}"`), targets and endpoints: a quote or a backslash ends or escapes the matcher, a control character (newline, tab, DEL) breaks the line. */
const forbiddenInParam = (v) => [...String(v)].some(ch => ch === '"' || ch === '\\' || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const rank = (t) => TIER_RANK[t] ?? 0;
const atTier = (tier, minTier) => rank(tier) >= rank(minTier || 'tier-3');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/**
 * A per-tier map `{ tier-1: x, tier-2: y, tier-3: z }` or a scalar that applies to every tier. A map is read
 * at the tier, then walking towards the stricter tiers (tier-3 → tier-2 → tier-1) to the first value declared:
 * a tier-2 pack that adds an SLI declared for tier-1 only starts with the tier-1 objective, a tier-3 pack adding
 * one declared for tier-2 and tier-1 takes tier-2's. The tier is a seed, never a gate.
 */
const perTier = (v, tier, fallback) => {
  if (!isObj(v)) return v ?? fallback;
  for (let i = Math.max(0, TIERS.indexOf(tier)); i < TIERS.length; i++) {
    const at = v[TIERS[i]];
    if (at !== undefined && at !== null) return at;
  }
  return fallback;
};
const clone = (v) => JSON.parse(JSON.stringify(v));
const uniq = (xs) => [...new Set(xs)];
const PLACEHOLDER_RE = /\$\{([a-zA-Z_][a-zA-Z0-9_.]*)\}/g;
const placeholdersIn = (s) => [...String(s).matchAll(PLACEHOLDER_RE)].map(m => m[1]);
const stripText = (s) => String(s ?? '').replace(/\n\s*$/, '').trim();
/** `broker_availability` at objective 0.999 → `broker_availability_99_9` (the reference packs' SLO naming). */
export function sloIdFor(sliId, objective) {
  const pct = Number((objective * 100).toFixed(4)).toString().replace('.', '_');
  return `${sliId}_${pct}`;
}
const kebab = (id) => String(id).replace(/_/g, '-');

// ---------------------------------------------------------------------------
// 1. Entries — parse, validate, index
// ---------------------------------------------------------------------------

/** Parse an entry from YAML text (mini-yaml) or take an object as is. Shape errors come from validateLibraryEntry. */
export function parseLibraryEntry(textOrObject) {
  if (typeof textOrObject === 'string') return parseYaml(textOrObject);
  if (isObj(textOrObject)) return textOrObject;
  throw new Error('parseLibraryEntry: expected YAML text or an object');
}

const SLUG_RE = /^[a-z][a-z0-9_-]*[a-z0-9]$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const DURATION_RE = /^([0-9]+(\.[0-9]+)?(ns|us|ms|s|m|h|d|w|mo|y))+$/;
const SYNTHETIC_KINDS = ['elastic-synthetics', 'blackbox-exporter', 'checkly', 'k6', 'grafana-synthetics'];
const CHAOS_ENGINES = ['chaos-mesh', 'litmus', 'gremlin'];
const SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'];

/** Every `${x}` used anywhere in a value tree. */
function collectPlaceholders(value, out = new Set()) {
  if (typeof value === 'string') for (const p of placeholdersIn(value)) out.add(p);
  else if (Array.isArray(value)) value.forEach(v => collectPlaceholders(v, out));
  else if (isObj(value)) Object.values(value).forEach(v => collectPlaceholders(v, out));
  return out;
}

/** Errors (strings) that make an entry unusable; [] when it is sound. */
export function validateLibraryEntry(entry) {
  const errors = [];
  const e = (m) => errors.push(m);
  if (!isObj(entry)) return ['entry is not an object'];
  if (entry.library !== LIBRARY_FORMAT) e(`library: expected '${LIBRARY_FORMAT}', got ${JSON.stringify(entry.library)}`);
  if (typeof entry.id !== 'string' || !SLUG_RE.test(entry.id)) e(`id: not a slug (${JSON.stringify(entry.id)})`);
  if (!ENTRY_KINDS.includes(entry.kind)) e(`kind: expected one of ${ENTRY_KINDS.join('|')}, got ${JSON.stringify(entry.kind)}`);
  if (typeof entry.version !== 'string' || !SEMVER_RE.test(entry.version)) e(`version: expected x.y.z, got ${JSON.stringify(entry.version)}`);
  if (typeof entry.title !== 'string' || !entry.title.trim()) e('title: required');
  if (typeof entry.summary !== 'string' || !entry.summary.trim()) e('summary: required (one line)');
  if (entry.kind === 'product' && (typeof entry.product !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(entry.product))) e('product: required for a product entry (the spec Product registry key)');
  if (entry.kind === 'archetype' && entry.product != null) e('product: an archetype has no product');

  // evidence
  const ev = entry.evidence;
  if (!isObj(ev)) e('evidence: required');
  else {
    if (!EVIDENCE_STATUSES.includes(ev.status)) e(`evidence.status: expected one of ${EVIDENCE_STATUSES.join('|')}, got ${JSON.stringify(ev.status)}`);
    if (!Array.isArray(ev.sources) || !ev.sources.length || !ev.sources.every(s => typeof s === 'string' && s.trim())) e('evidence.sources: at least one source (string) is required');
    if (ev.gaps != null && (!Array.isArray(ev.gaps) || !ev.gaps.every(s => typeof s === 'string'))) e('evidence.gaps: a list of strings');
  }

  // params
  const paramIds = new Set();
  const scaffoldIds = new Set(SCAFFOLD_PARAMS.map(p => p.id));
  for (const [i, p] of (entry.params || []).entries()) {
    const at = `params[${i}]`;
    if (!isObj(p)) { e(`${at}: not an object`); continue; }
    if (typeof p.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(p.id)) e(`${at}.id: expected [a-z][a-z0-9_]*, got ${JSON.stringify(p.id)}`);
    else if (paramIds.has(p.id)) e(`${at}.id: duplicate '${p.id}'`);
    else if (scaffoldIds.has(p.id) || BUILTIN_PARAMS.includes(p.id)) e(`${at}.id: '${p.id}' is a scaffold or built-in parameter`);
    else paramIds.add(p.id);
    if (typeof p.label !== 'string' || !p.label.trim()) e(`${at}.label: required`);
    if (!('default' in p) || (typeof p.default !== 'string' && typeof p.default !== 'number' && typeof p.default !== 'boolean')) e(`${at}.default: required (string, number or boolean)`);
    if (typeof p.description !== 'string' || !p.description.trim()) e(`${at}.description: required`);
    if (p.placeholder != null && typeof p.placeholder !== 'boolean') e(`${at}.placeholder: boolean`);
  }
  const known = new Set([...paramIds, ...scaffoldIds, ...BUILTIN_PARAMS]);
  // The metric-name check reads the query with every parameter at its default (a name such as
  // `${duration_metric}_count` is a metric name only once the default is in).
  const defaults = Object.fromEntries([...SCAFFOLD_PARAMS, ...(entry.params || []).filter(isObj)].map(p => [p.id, String(p.default ?? '')]));
  const builtins = { service: 'svc', environment: 'prod', tier: 'tier-3' };
  const withDefaults = (s) => String(s ?? '').replace(PLACEHOLDER_RE, (m, k) => (k in defaults ? defaults[k].replace(PLACEHOLDER_RE, (m2, k2) => builtins[k2] ?? m2) : builtins[k] ?? m));

  // slis
  const slis = entry.slis;
  const sliIds = new Set();
  if (!Array.isArray(slis) || !slis.length) e('slis: at least one SLI template is required');
  else {
    let ratioAtTier3 = false, thresholdByTier2 = false;
    for (const [i, s] of slis.entries()) {
      const at = `slis[${i}]`;
      if (!isObj(s)) { e(`${at}: not an object`); continue; }
      if (typeof s.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(s.id)) e(`${at}.id: expected [a-z][a-z0-9_]*, got ${JSON.stringify(s.id)}`);
      else if (s.id === POLICY_SEGMENT) e(`${at}.id: '${POLICY_SEGMENT}' is the compiler's reserved policy-record segment (<service>:errorbudget:burn_5m|1h, tools/lib/sli-inference.mjs); an SLI of that id would collide with it`);
      else if (sliIds.has(s.id)) e(`${at}.id: duplicate '${s.id}'`);
      else sliIds.add(s.id);
      if (!SLI_TYPES.includes(s.type)) e(`${at}.type: expected ${SLI_TYPES.join('|')}, got ${JSON.stringify(s.type)}`);
      if (!TIERS.includes(s.minTier)) e(`${at}.minTier: expected ${TIERS.join('|')}, got ${JSON.stringify(s.minTier)}`);
      if (typeof s.description !== 'string' || !s.description.trim()) e(`${at}.description: required`);
      if (typeof s.why !== 'string' || !s.why.trim()) e(`${at}.why: required (why this SLI, for the studio)`);
      if (typeof s.unit !== 'string' || !s.unit.trim()) e(`${at}.unit: required`);
      const text = withDefaults(s.type === 'ratio' ? `${s.good}\n${s.total}` : String(s.query));
      if (!Array.isArray(s.metrics) || !s.metrics.length) e(`${at}.metrics: the metric names the query reads (non-empty list)`);
      else for (const m of s.metrics) {
        if (typeof m !== 'string' || !/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(m)) e(`${at}.metrics: '${m}' is not a metric name`);
        else if (!new RegExp(`(^|[^a-zA-Z0-9_:])${m}([^a-zA-Z0-9_:]|$)`).test(text)) e(`${at}.metrics: '${m}' does not appear in the query`);
      }
      if (!isObj(s.evidence) || !EVIDENCE_STATUSES.includes(s.evidence.status)) e(`${at}.evidence.status: expected one of ${EVIDENCE_STATUSES.join('|')}`);
      else if (typeof s.evidence.source !== 'string' || !s.evidence.source.trim()) e(`${at}.evidence.source: required`);
      if (s.type === 'ratio') {
        if (typeof s.good !== 'string' || !s.good.trim()) e(`${at}.good: required for a ratio SLI`);
        if (typeof s.total !== 'string' || !s.total.trim()) e(`${at}.total: required for a ratio SLI`);
        if (s.minTier === 'tier-3') ratioAtTier3 = true;
      } else if (s.type === 'threshold') {
        if (typeof s.query !== 'string' || !s.query.trim()) e(`${at}.query: required for a threshold SLI`);
        if (typeof s.threshold !== 'number') e(`${at}.threshold: a number is required`);
        if (s.minTier !== 'tier-1') thresholdByTier2 = true;
      }
      if (!isObj(s.slo)) e(`${at}.slo: required ({ objective, window })`);
      else {
        // A per-tier map must cover the tiers the SLI reaches; a tier below its minTier may be left out
        // (a pack at that tier reads the stricter tiers' value through perTier's walk).
        for (const t of TIERS) {
          const declared = (m) => (isObj(m) ? m[t] : m);
          const o = declared(s.slo.objective);
          if (o === undefined || o === null) { if (atTier(t, s.minTier)) e(`${at}.slo.objective[${t}]: required (the SLI is at ${s.minTier}; only a tier below it may leave the value out)`); }
          else if (typeof o !== 'number' || !(o > 0 && o < 1)) e(`${at}.slo.objective[${t}]: expected a number in (0, 1), got ${JSON.stringify(o)}`);
          const w = declared(s.slo.window) ?? (isObj(s.slo.window) && !atTier(t, s.minTier) ? '30d' : undefined) ?? '30d';
          if (!SLO_WINDOWS.includes(w)) e(`${at}.slo.window[${t}]: expected ${SLO_WINDOWS.join('|')}, got ${JSON.stringify(w)}`);
        }
      }
      if (s.burn != null && !(typeof s.burn === 'string' && BURN_PROFILES[s.burn]) && !(Array.isArray(s.burn) && s.burn.length >= 2)) e(`${at}.burn: a profile (${Object.keys(BURN_PROFILES).join('|')}) or two or more explicit windows`);
      if (s.forecast != null) {
        if (!isObj(s.forecast) || !['linear', 'holt-winters', 'percentile-of-history'].includes(s.forecast.method)) e(`${at}.forecast.method: linear | holt-winters | percentile-of-history`);
        else if (s.forecast.minTier != null && !TIERS.includes(s.forecast.minTier)) e(`${at}.forecast.minTier: expected a tier`);
      }
      if (s.chaos != null) {
        const c = s.chaos;
        if (!isObj(c)) e(`${at}.chaos: an object`);
        else {
          if (typeof c.id !== 'string' || !SLUG_RE.test(c.id)) e(`${at}.chaos.id: a slug is required`);
          if (!CHAOS_ENGINES.includes(c.engine)) e(`${at}.chaos.engine: expected ${CHAOS_ENGINES.join('|')}`);
          if (typeof c.target !== 'string' || !c.target.trim()) e(`${at}.chaos.target: required`);
          if (!isObj(c.fault) || typeof c.fault.kind !== 'string') e(`${at}.chaos.fault.kind: required`);
          if (typeof c.expected_mttd !== 'string' || !DURATION_RE.test(c.expected_mttd)) e(`${at}.chaos.expected_mttd: a duration is required`);
          if (c.minTier != null && !TIERS.includes(c.minTier)) e(`${at}.chaos.minTier: expected a tier`);
        }
      }
      if (s.remediation != null) {
        const r = s.remediation;
        if (!isObj(r)) e(`${at}.remediation: an object`);
        else {
          // The trigger is derived: a library pack compiles burn-rate (and forecast) alerts and nothing else,
          // so a template naming a product's symptom alert would key the remediation to an alert that never fires.
          if ('trigger' in r) e(`${at}.remediation.trigger: not a template field — the trigger is the SLI's fast burn alert by the compiler's name (alert:<slo>_burn_<factor>x_<short>_<long>), the only alerts a library pack compiles`);
          if (typeof r.runbook !== 'string' || !/^[a-z0-9-]+$/.test(r.runbook)) e(`${at}.remediation.runbook: the runbook file stem (kebab-case)`);
          if (typeof r.automation !== 'string' || !r.automation.trim()) e(`${at}.remediation.automation: required (an automation URI or manual-only)`);
          if (r.minTier != null && !TIERS.includes(r.minTier)) e(`${at}.remediation.minTier: expected a tier`);
        }
      }
    }
    if (!ratioAtTier3) e('slis: at least one ratio SLI with minTier tier-3 is required (L1.MUST.availability_slo applies at every tier)');
    if (!thresholdByTier2) e('slis: at least one threshold SLI with minTier tier-3 or tier-2 is required (L1.MUST.latency_slo applies from tier-2)');
  }

  // views, dashboards, synthetic, telemetry
  const viewIds = new Set();
  for (const [i, v] of (entry.views || []).entries()) {
    const at = `views[${i}]`;
    if (!isObj(v) || typeof v.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(v.id)) { e(`${at}.id: expected [a-z][a-z0-9_]*`); continue; }
    if (viewIds.has(v.id)) e(`${at}.id: duplicate '${v.id}'`); else viewIds.add(v.id);
    if (typeof v.bind !== 'string' || !v.bind.startsWith('ref:')) e(`${at}.bind: a ref:platform/... binding is required`);
    if (v.minTier != null && !TIERS.includes(v.minTier)) e(`${at}.minTier: expected a tier`);
    if (isObj(v.params) && typeof v.params.sli === 'string' && !sliIds.has(v.params.sli)) e(`${at}.params.sli: '${v.params.sli}' is not an SLI of this entry`);
  }
  for (const [i, d] of (entry.dashboards || []).entries()) {
    const at = `dashboards[${i}]`;
    if (!isObj(d) || typeof d.id !== 'string' || !SLUG_RE.test(d.id)) { e(`${at}.id: a slug is required`); continue; }
    if (d.minTier != null && !TIERS.includes(d.minTier)) e(`${at}.minTier: expected a tier`);
    if (!Array.isArray(d.binds) || !d.binds.length) e(`${at}.binds: at least one slis.<id> | slos.<id> | views.<id> binding`);
    else for (const b of d.binds) {
      const m = /^(slis|slos|views)\.([a-z0-9_]+)$/.exec(String(b));
      if (!m) e(`${at}.binds: '${b}' is not slis.<id> | slos.<id> | views.<id>`);
      else if ((m[1] === 'views' && !viewIds.has(m[2])) || (m[1] !== 'views' && !sliIds.has(m[2]))) e(`${at}.binds: '${b}' names nothing this entry declares`);
    }
  }
  for (const [i, s] of (entry.synthetic || []).entries()) {
    const at = `synthetic[${i}]`;
    if (!isObj(s) || typeof s.id !== 'string' || !SLUG_RE.test(s.id)) { e(`${at}.id: a slug is required`); continue; }
    if (!SYNTHETIC_KINDS.includes(s.kind)) e(`${at}.kind: expected ${SYNTHETIC_KINDS.join('|')}`);
    if (typeof s.target !== 'string' || !s.target.trim()) e(`${at}.target: required`);
    if (typeof s.interval !== 'string' || !DURATION_RE.test(s.interval)) e(`${at}.interval: a duration is required`);
    if (!SEVERITIES.includes(s.on_fail_severity)) e(`${at}.on_fail_severity: expected ${SEVERITIES.join('|')}`);
    if (s.minTier != null && !TIERS.includes(s.minTier)) e(`${at}.minTier: expected a tier`);
  }
  const tel = entry.telemetry;
  if (tel != null) {
    if (!isObj(tel)) e('telemetry: an object');
    else {
      for (const [i, j] of (tel.scrape_jobs || []).entries()) {
        const at = `telemetry.scrape_jobs[${i}]`;
        if (!isObj(j) || typeof j.job_name !== 'string' || !j.job_name.trim()) e(`${at}.job_name: required`);
        if (isObj(j) && (!Array.isArray(j.targets) || !j.targets.length)) e(`${at}.targets: at least one target`);
        if (isObj(j) && j.minTier != null && !TIERS.includes(j.minTier)) e(`${at}.minTier: expected a tier`);
      }
      for (const [i, r] of (tel.receivers || []).entries()) {
        if (!isObj(r) || typeof r.name !== 'string') e(`telemetry.receivers[${i}].name: required`);
      }
    }
  }
  if (entry.otel != null) {
    if (!isObj(entry.otel)) e('otel: an object');
    else {
      if (entry.otel.languages != null && (!Array.isArray(entry.otel.languages) || !entry.otel.languages.every(l => ['java', 'node', 'python', 'go', 'dotnet', 'ruby', 'php', 'rust', 'cpp'].includes(l)))) e('otel.languages: spec SDK languages only');
      if (entry.otel.custom_attributes != null && !Array.isArray(entry.otel.custom_attributes)) e('otel.custom_attributes: a list');
    }
  }

  // every ${x} anywhere must be a declared, scaffold or built-in parameter
  for (const p of collectPlaceholders(entry)) {
    if (!known.has(p)) e(`placeholder \${${p}} is not a declared parameter (params[].id), a scaffold parameter or a built-in (${BUILTIN_PARAMS.join(', ')})`);
  }
  return errors;
}

/** The summary the studio lists: one row per entry, its params, SLIs with minTier and evidence, the tiers it supports. */
export function libraryIndex(entries) {
  return [...entries].map(entry => {
    // objectives / windows per tier read through perTier's walk: what the SLI starts with at each tier, above
    // its minTier too; the PromQL templates (${param} unresolved), the bound and the semconv metric are the
    // defaults the studio's editor shows beside an override.
    const slis = (entry.slis || []).map(s => ({
      id: s.id, type: s.type, minTier: s.minTier, unit: s.unit, description: s.description,
      ...(s.semconv_metric ? { semconv_metric: s.semconv_metric } : {}),
      evidence: s.evidence?.status || null, metrics: [...(s.metrics || [])],
      objectives: Object.fromEntries(TIERS.map(t => [t, perTier(s.slo?.objective, t, null)])),
      windows: Object.fromEntries(TIERS.map(t => [t, perTier(s.slo?.window, t, null)])),
      ...(s.type === 'ratio' ? { good: stripText(s.good), total: stripText(s.total) } : { query: stripText(s.query), threshold: s.threshold }),
    }));
    return {
      id: entry.id, kind: entry.kind, title: entry.title, product: entry.product || null, version: entry.version,
      summary: entry.summary, tags: [...(entry.tags || [])],
      evidence: { status: entry.evidence?.status || null, verifiedOn: entry.evidence?.verifiedOn || null, sources: [...(entry.evidence?.sources || [])], gaps: [...(entry.evidence?.gaps || [])] },
      params: (entry.params || []).map(p => ({ id: p.id, label: p.label, default: p.default, placeholder: !!p.placeholder, description: p.description })),
      slis,
      sliCountByTier: Object.fromEntries(TIERS.map(t => [t, slis.filter(s => atTier(t, s.minTier)).length])),
      tiers: [...TIERS],
    };
  }).sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'product' ? -1 : 1));
}

/** The conformance clauses that apply at a tier — the rubric itself (tools/lib/conformance.mjs), filtered by minTier; no second rubric. */
export function tierRequirements(tier) {
  if (!TIERS.includes(tier)) throw new Error(`tierRequirements: unknown tier ${JSON.stringify(tier)} (expected ${TIERS.join(' | ')})`);
  return RUBRIC.filter(c => atTier(tier, c.minTier)).map(({ id, dimension, severity, minTier, description, specRef }) => ({ id, dimension, severity, minTier, description, specRef }));
}

/** The toggles an instantiation starts from: every section on, every SLI whose minTier the tier reaches. */
export function defaultToggles(entryOrEntries, tier) {
  const entries = Array.isArray(entryOrEntries) ? entryOrEntries : [entryOrEntries];
  const prefixed = entries.length > 1;
  const slis = entries.flatMap(en => (en.slis || []).filter(s => atTier(tier, s.minTier)).map(s => (prefixed ? `${metricPrefix(en.id)}_${s.id}` : s.id)));
  return { slis, slos: true, policy: true, routes: true, dashboards: true, validation: true };
}

// ---------------------------------------------------------------------------
// 2. Instantiation
// ---------------------------------------------------------------------------

/** The parameter table of an instantiation: scaffold params, then the entries' (namespaced `<entry>.<param>` when composing). */
function paramTable(entries, prefixed) {
  const rows = SCAFFOLD_PARAMS.map(p => ({ ...p, entry: null, key: p.id }));
  for (const en of entries) for (const p of en.params || []) rows.push({ ...p, entry: en.id, key: prefixed ? `${en.id}.${p.id}` : p.id });
  return rows;
}

/**
 * The caller's params, checked before anything is substituted: every key must be a parameter of
 * this instantiation (a scaffold param, `<entry>.<param>`, or a bare entry param) and every value
 * a scalar. A mistyped key was silently dropped once (the pack kept its placeholder and the todo
 * still named the right key); an object was spliced in as '[object Object]'. The error echoes at
 * most UNKNOWN_PARAMS_SHOWN of the unknown keys (a params object of 200,000 bogus keys once made a
 * 1.7 MB error body) and a value is bounded by MAX_PARAM_LENGTH (a 3 MB value was accepted and
 * spliced into a 9 MB pack); both are usage errors, `param <key>: …` for the value so a caller
 * can point at the field.
 */
export const MAX_PARAM_LENGTH = 4096;
const UNKNOWN_PARAMS_SHOWN = 10;
function checkParams(userParams, rows) {
  if (!isObj(userParams)) throw new Error('instantiatePack: params must be an object of key → string | number | boolean');
  const known = uniq([...rows.map(r => r.key), ...rows.filter(r => r.entry).map(r => r.id)]);
  const unknown = Object.keys(userParams).filter(k => !known.includes(k));
  if (unknown.length) {
    const shown = unknown.slice(0, UNKNOWN_PARAMS_SHOWN).join(', ') + (unknown.length > UNKNOWN_PARAMS_SHOWN ? ` and ${unknown.length - UNKNOWN_PARAMS_SHOWN} more` : '');
    throw new Error(`unknown param ${shown} (known: ${known.sort().join(', ')})`);
  }
  for (const [k, v] of Object.entries(userParams)) {
    if (!['string', 'number', 'boolean'].includes(typeof v)) throw new Error(`param ${k}: expected a string, number or boolean, got ${v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v}`);
    if (typeof v === 'string' && v.length > MAX_PARAM_LENGTH) throw new Error(`param ${k}: a value may not exceed ${MAX_PARAM_LENGTH} characters (${v.length} given)`);
    if (typeof v === 'string' && forbiddenInParam(v)) throw new Error(`param ${k}: a value may not contain a double quote, a backslash or a control character (it is spliced verbatim into PromQL label matchers, scrape targets and endpoints)`);
  }
  return userParams;
}

// ---------------------------------------------------------------------------
// The copies: overrides over the library's SLIs, and custom SLIs (docs/BUILD_JOURNEY.md "The seed and the copies")
// ---------------------------------------------------------------------------

/** A usage error on one field of an override or a custom SLI, spelled `override <sli>.<field>: …` / `custom <id>.<field>: …` so a caller can point at the input. */
const fieldError = (where, msg) => new Error(`${where}: ${msg}`);

/**
 * One field of an override or a custom SLI, checked against the SLI's type: the objective a number in (0, 1)
 * (the ratio the pack stores — the studio shows a percent), the window one of the schema's SLO windows, the
 * threshold a finite number (an upper bound: spec v1.2 has no direction field, so `comparison` is refused with
 * the reason), the PromQL a non-empty string within MAX_PARAM_LENGTH that carries no ${…} placeholder (an
 * override replaces the library's expression after the params are in; nothing resolves a placeholder in it),
 * the description and unit bounded strings, the id a slug like a custom SLI's (CUSTOM_ID_RE, not the reserved
 * policy segment — its uniqueness is checked once every SLI is known, checkSliIds), the semconv_metric one bounded
 * token. Returns the normalised value.
 */
function checkCopyField(where, field, value, type) {
  const str = (max, what) => {
    if (typeof value !== 'string' || !value.trim()) throw fieldError(where, `${what} must be a non-empty string`);
    if (value.length > max) throw fieldError(where, `${what} may not exceed ${max} characters (${value.length} given)`);
    return value;
  };
  switch (field) {
    case 'id':
      if (typeof value !== 'string' || !CUSTOM_ID_RE.test(value) || POLLUTING_KEYS.has(value)) throw fieldError(where, `the id is a slug of 2 to 63 characters ([a-z][a-z0-9_]{1,62}), got ${JSON.stringify(value)}`);
      if (value === POLICY_SEGMENT) throw fieldError(where, `'${POLICY_SEGMENT}' is the compiler's reserved policy-record segment`);
      return value;
    case 'semconv_metric': {
      const v = str(MAX_METRIC_LENGTH, 'the metric');
      if (/[\s"\\]/.test(v)) throw fieldError(where, `the metric is one name — no whitespace, quote or backslash — got ${JSON.stringify(v)}`);
      return v;
    }
    case 'objective':
      if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0 && value < 1)) throw fieldError(where, `the objective is a number in (0, 1) — the ratio the pack stores (0.995 for 99.5 %), got ${JSON.stringify(value)}`);
      return value;
    case 'window':
      if (!SLO_WINDOWS.includes(value)) throw fieldError(where, `the window is one of ${SLO_WINDOWS.join(' | ')} (the schema's SLO windows), got ${JSON.stringify(value)}`);
      return value;
    case 'threshold':
      if (type !== 'threshold') throw fieldError(where, 'a ratio SLI has no threshold (it has good and total)');
      if (typeof value !== 'number' || !Number.isFinite(value)) throw fieldError(where, `the threshold is a finite number (an upper bound), got ${JSON.stringify(value)}`);
      return value;
    case 'query':
      if (type !== 'threshold') throw fieldError(where, 'a ratio SLI has good and total, not a query');
      return promqlField();
    case 'good': case 'total':
      if (type !== 'ratio') throw fieldError(where, `a threshold SLI has a query, not ${field}`);
      return promqlField();
    case 'description': return str(MAX_PARAM_LENGTH, 'the description');
    case 'unit': return str(MAX_UNIT_LENGTH, 'the unit');
    default: throw fieldError(where, `unknown field (the fields are ${OVERRIDE_FIELDS.join(', ')})`);
  }
  function promqlField() {
    const v = str(MAX_PARAM_LENGTH, 'the PromQL');
    const ph = placeholdersIn(v);
    if (ph.length) throw fieldError(where, `the PromQL may not carry a \${…} placeholder (\${${ph[0]}}): an override replaces the library's expression after the params are in, nothing resolves one here`);
    return v;
  }
}

/** The one reason `comparison` is not a field: the spec's threshold is an upper bound and its schema has no direction. */
const COMPARISON_REASON = 'not a field: an ObservabilityPack v1.2 threshold is an upper bound (the schema has no direction / comparison field; the burn-rate generator reads every threshold so) — express a floor as a ratio SLI';

/**
 * The caller's overrides, checked before anything is instantiated: a plain object keyed by SLI id as the pack
 * carries it (SLI_KEY_RE; __proto__ / constructor / prototype refused, nothing read through the prototype chain),
 * each value an object of OVERRIDE_FIELDS checked by checkCopyField against the SLI's type. An override for an SLI
 * that is not in the pack (unknown, or known but not selected) is a warning of kind `override`, never an error.
 * Returns { byId: Map<id, override>, warnings }.
 */
function checkOverrides(overrides, known, selected) {
  const byId = new Map();
  const warnings = [];
  if (overrides === undefined || overrides === null) return { byId, warnings };
  if (!isObj(overrides)) throw new Error('instantiatePack: overrides must be an object of { <sli id>: { objective?, window?, threshold?, query?, good?, total?, description?, unit? } }');
  for (const key of Object.keys(overrides)) {
    if (POLLUTING_KEYS.has(key) || !SLI_KEY_RE.test(key)) throw new Error(`override ${key}: not an SLI id (${SLI_KEY_RE})`);
    const ov = overrides[key];
    if (!isObj(ov)) throw new Error(`override ${key}: expected an object of fields, got ${ov === null ? 'null' : Array.isArray(ov) ? 'array' : typeof ov}`);
    const k = known.get(key);
    if (!k || !selected.has(key)) {
      warnings.push({ kind: 'override', sli: key, message: `override ${key}: the SLI is not in the pack (${k ? 'not selected' : 'unknown'}) — the override is kept aside, nothing is applied` });
      continue;
    }
    const out = Object.create(null);
    for (const field of Object.keys(ov)) {
      if (POLLUTING_KEYS.has(field)) throw fieldError(`override ${key}.${field}`, 'refused');
      if (field === 'comparison') throw fieldError(`override ${key}.comparison`, COMPARISON_REASON);
      if (!OVERRIDE_FIELDS.includes(field)) throw fieldError(`override ${key}.${field}`, `unknown field (the fields are ${OVERRIDE_FIELDS.join(', ')})`);
      out[field] = checkCopyField(`override ${key}.${field}`, field, ov[field], k.type);
    }
    // A rename to the id the pack already gives the SLI is no rename: nothing customised, nothing to follow.
    if (out.id === key) delete out.id;
    if (Object.keys(out).length) byId.set(key, out);
  }
  return { byId, warnings };
}

/**
 * Every SLI id in the pack once: a renamed library SLI (`override <key>.id`) may not take the id of another SLI in
 * the pack — a library SLI as the pack carries it, another renamed one, a custom one — nor shadow a library SLI of
 * the passed entries that is not ticked (it would clash the moment it is ticked, and a draft carrying both would
 * draw two cards with one id); a custom SLI may not take a renamed id either (checkCustom knows the library's ids
 * only). A usage error spelled on the field the user can change: the rename first, else the custom id.
 */
function checkSliIds(slis, known) {
  const seen = new Map();
  const renamed = (x) => !x.custom && x.id !== x.key;
  const name = (x) => (x.custom ? `the custom SLI ${x.id}` : `the library SLI ${x.key}${x.entry ? ` of ${x.entry.id}` : ''}${renamed(x) ? ` (renamed ${x.id})` : ''}`);
  for (const x of slis) {
    const other = seen.get(x.id);
    if (other) {
      const culprit = [x, other].find(renamed) || [x, other].find(y => y.custom) || x;
      const rival = culprit === x ? other : x;
      const where = culprit.custom ? `custom ${culprit.id}.id` : `override ${culprit.key}.id`;
      throw new Error(`${where}: ${x.id} is already the id of ${name(rival)} in the pack — pick another id`);
    }
    seen.set(x.id, x);
    if (renamed(x) && known.has(x.id)) {
      const k = known.get(x.id);
      throw new Error(`override ${x.key}.id: shadows the library SLI ${x.id}${k.entry ? ` of ${k.entry}` : ''} (not in the pack now — it would clash the moment it is ticked) — pick another id`);
    }
  }
}

/**
 * The caller's custom SLIs, checked: a list of { id, type, objective, window, good + total | query + threshold,
 * description?, unit? }; the id a slug (CUSTOM_ID_RE, not the reserved policy segment) unique among the pack's
 * SLIs — a clash with a selected library SLI or another custom one is a usage error naming both; the objective
 * and window required; the PromQL required per type; every field checked by checkCopyField; an unknown field a
 * usage error. Returns the normalised definitions in order.
 */
function checkCustom(custom, selected, known) {
  if (custom === undefined || custom === null) return [];
  if (!Array.isArray(custom)) throw new Error('instantiatePack: custom must be a list of { id, type, objective, window, good + total | query + threshold, description?, unit? }');
  const out = [];
  const seen = new Set();
  custom.forEach((def, i) => {
    const at = `custom[${i}]`;
    if (!isObj(def)) throw new Error(`${at}: expected an object, got ${def === null ? 'null' : Array.isArray(def) ? 'array' : typeof def}`);
    const id = hasOwn(def, 'id') ? def.id : undefined;
    if (typeof id !== 'string' || !CUSTOM_ID_RE.test(id) || POLLUTING_KEYS.has(id)) throw new Error(`${at}.id: a slug of 2 to 63 characters is required ([a-z][a-z0-9_]{1,62}), got ${JSON.stringify(id)}`);
    if (id === POLICY_SEGMENT) throw new Error(`custom ${id}.id: '${POLICY_SEGMENT}' is the compiler's reserved policy-record segment`);
    const where = `custom ${id}`;
    // Any library SLI of the passed entries owns its id, ticked or not: an un-ticked one would clash the moment
    // it is ticked (a draft carrying both would draw two cards with one key), so the id is refused either way.
    if (known.has(id)) {
      const k = known.get(id);
      const of = k?.entry ? ` of ${k.entry}` : '';
      throw new Error(selected.has(id)
        ? `${where}.id: clashes with the library SLI ${id}${of} in the pack — pick another id or drop that SLI`
        : `${where}.id: shadows the library SLI ${id}${of} (not in the pack now — it would clash the moment it is ticked) — pick another id`);
    }
    if (seen.has(id)) throw new Error(`${where}.id: declared twice in custom`);
    seen.add(id);
    const type = def.type;
    if (!SLI_TYPES.includes(type)) throw new Error(`${where}.type: expected ${SLI_TYPES.join(' | ')}, got ${JSON.stringify(type)}`);
    const norm = { id, type };
    for (const field of Object.keys(def)) {
      if (field === 'id' || field === 'type') continue;
      if (POLLUTING_KEYS.has(field)) throw fieldError(`${where}.${field}`, 'refused');
      if (field === 'comparison') throw fieldError(`${where}.comparison`, COMPARISON_REASON);
      if (!OVERRIDE_FIELDS.includes(field)) throw fieldError(`${where}.${field}`, `unknown field (the fields are ${CUSTOM_FIELDS.join(', ')})`);
      norm[field] = checkCopyField(`${where}.${field}`, field, def[field], type);
    }
    for (const req of ['objective', 'window', ...(type === 'ratio' ? ['good', 'total'] : ['query', 'threshold'])]) {
      if (!hasOwn(norm, req)) throw fieldError(`${where}.${req}`, `required for a ${type} SLI`);
    }
    out.push(norm);
  });
  return out;
}

/**
 * Two SLIs may not share an SLO id. sloIdFor joins `<sli>_<pct>` with `_`, which is legal inside an SLI id, so an
 * overridden `broker_availability` at 0.9999 and a custom `broker_availability_99` at 0.99 both become
 * `broker_availability_99_99` — one SLO id, two burn alerts, two bindings, and nothing downstream would have said
 * so (measured: schema valid, MUST 15/15, the compiled rules carrying the alert twice). A usage error spelled on
 * the field the user can change: the custom SLI's id, else the overridden objective.
 */
function checkSloIds(slis) {
  const bySlo = new Map();
  for (const x of slis) {
    const other = bySlo.get(x.sloId);
    if (!other) { bySlo.set(x.sloId, x); continue; }
    const culprit = [x, other].find(y => y.custom) || [x, other].find(y => hasOwn(y.overrides || {}, 'objective')) || x;
    const rival = culprit === x ? other : x;
    // Spelled on the override's key (the library's id), which is how the caller addresses the SLI — a renamed one too.
    const where = culprit.custom ? `custom ${culprit.id}.id` : `override ${culprit.key}.objective`;
    throw new Error(`${where}: its SLO id ${x.sloId} collides with ${rival.id}'s (objective ${rival.objective}) — pick another ${culprit.custom ? 'id or objective' : 'objective'}`);
  }
}

/**
 * Every SLI expression, with the params in, must still be PromQL. The parser is an input: packc
 * init passes the Lezer grammar (tools/lib/promql-lezer.mjs, an npm import and so not for the
 * browser); the browser-safe core in tools/lib/promql.mjs extracts dependencies and reports no
 * grammar error, so without a parser no `promql` warning can arise and the caller has to run the
 * check where Node is. A `promql` warning means the pack must not ship as it is.
 */
function promqlWarnings(canonical, promql) {
  if (typeof promql !== 'function') return [];
  const out = [];
  for (const s of canonical.spec.slis) for (const field of ['good', 'total', 'query']) {
    if (typeof s[field] !== 'string') continue;
    const parsed = promql(s[field]);
    if (!parsed || parsed.parseOk !== false) continue;
    const where = (parsed.errors || []).map(e => (e && e.text ? `near ${JSON.stringify(e.text)}` : String(e?.message || e))).join(', ');
    out.push({ kind: 'promql', sli: s.id, field, message: `SLI ${s.id}.${field} is not valid PromQL after parameter substitution (${where}): ${s[field].replace(/\s+/g, ' ')}` });
  }
  return out;
}

/** Effective parameter values: user value (by key, or bare id for an entry param) else the default with the built-ins applied. */
function resolveParams(rows, userParams, builtins) {
  const values = {};
  const provided = new Set();
  for (const row of rows) {
    const user = userParams[row.key] ?? (row.entry && userParams[row.id] !== undefined && !SCAFFOLD_PARAMS.some(s => s.id === row.id) ? userParams[row.id] : undefined);
    if (user !== undefined) { values[row.key] = String(user); provided.add(row.key); }
    else values[row.key] = String(row.default).replace(PLACEHOLDER_RE, (m, k) => (k in builtins ? builtins[k] : m));
  }
  return { values, provided };
}

/**
 * What one entry contributes at a tier: the selected SLI templates resolved
 * for the tier (objective, window, burn windows, SLO id) plus the product
 * views, boards, probes, chaos and remediation templates the tier reaches.
 * Ids are prefixed with the entry id when several entries are composed.
 */
function entryFragment(entry, { tier, selectedSlis, prefixed, overrides = new Map() }) {
  const px = prefixed ? `${metricPrefix(entry.id)}_` : '';
  const dpx = prefixed ? `${fileSlug(entry.id)}-` : '';
  const slis = [];
  for (const s of entry.slis || []) {
    // `key` is the id the library gives the SLI in this pack (the selection and the overrides address it so);
    // `id` is what the pack carries — the key, or the override's rename, which the SLO, the rule and the
    // bindings follow.
    const key = `${px}${s.id}`;
    if (!selectedSlis.has(key)) continue;
    // No tier gate: an SLI above the tier starts with the value the walk finds (its own tier's profile).
    const ov = overrides.get(key) || {};
    const id = hasOwn(ov, 'id') ? ov.id : key;
    const objective = ov.objective ?? perTier(s.slo.objective, tier, null);
    const window = ov.window ?? perTier(s.slo.window, tier, '30d');
    const customised = OVERRIDE_FIELDS.filter(k => hasOwn(ov, k));
    slis.push({
      template: s, entry, id, key, sloId: sloIdFor(id, objective), objective, window, windows: burnWindowsFor(s, tier),
      overrides: ov, customised, custom: false, aboveTier: !atTier(tier, s.minTier),
    });
  }
  const has = (t) => atTier(tier, t?.minTier);
  const sliOf = (bare) => slis.find(x => x.template.id === bare);
  // A view on an SLI that is not selected is dropped, and so is a board binding to a dropped view.
  const views = (entry.views || []).filter(has).filter(v => !(isObj(v.params) && typeof v.params.sli === 'string') || sliOf(v.params.sli)).map(v => ({
    id: `${px}${v.id}`, bind: v.bind,
    params: isObj(v.params) ? Object.fromEntries(Object.entries(v.params).map(([k, val]) => [k, k === 'sli' ? sliOf(val).id : val])) : undefined,
  }));
  const viewIds = new Set(views.map(v => v.id));
  return {
    entry, slis, views,
    dashboards: (entry.dashboards || []).filter(has).map(d => ({
      id: `${dpx}${d.id}`,
      binds: d.binds.map(b => {
        const m = /^(slis|slos|views)\.([a-z0-9_]+)$/.exec(b);
        if (m[1] === 'views') return viewIds.has(`${px}${m[2]}`) ? `ref:queries.${px}${m[2]}` : null;
        const x = sliOf(m[2]);
        if (!x) return null;
        return m[1] === 'slis' ? `slis.${x.id}` : `slos.${x.sloId}`;
      }).filter(Boolean),
    })).filter(d => d.binds.length),
    synthetic: (entry.synthetic || []).filter(has).map(s => ({ ...clone(s), id: `${dpx}${s.id}` })),
    chaos: slis.filter(x => x.template.chaos && has(x.template.chaos)).map(x => ({ ...clone(x.template.chaos), id: `${dpx}${x.template.chaos.id}`, sli: x })),
    remediation: slis.filter(x => x.template.remediation && has(x.template.remediation)).map(x => ({ ...clone(x.template.remediation), sli: x })),
    scrapeJobs: (entry.telemetry?.scrape_jobs || []).filter(has).map(j => clone(j)),
    receivers: (entry.telemetry?.receivers || []).filter(has).map(r => clone(r)),
    languages: entry.otel?.languages || [],
    customAttributes: entry.otel?.custom_attributes || [],
  };
}

/**
 * What the custom SLIs contribute: one SLI record each, shaped like a template (so the scaffold treats it like any
 * SLI — an SLO, a recording rule, burn alerts from the default profile, the overview board's bindings), with
 * `custom` evidence and no entry. Nothing else: no view, board, probe, chaos or scrape job.
 */
function customFragment(defs, { tier }) {
  const slis = defs.map(def => {
    const template = {
      id: def.id, type: def.type, minTier: tier,
      description: def.description ?? `custom ${def.type} SLI — written in the studio`,
      ...(def.unit !== undefined ? { unit: def.unit } : {}),
      ...(def.semconv_metric !== undefined ? { semconv_metric: def.semconv_metric } : {}),
      ...(def.type === 'ratio' ? { good: def.good, total: def.total } : { query: def.query, threshold: def.threshold }),
      evidence: { status: 'custom', source: 'written in the studio' },
    };
    return {
      template, entry: null, id: def.id, key: def.id, sloId: sloIdFor(def.id, def.objective), objective: def.objective, window: def.window,
      windows: burnWindowsFor(template, tier), overrides: {}, customised: [], custom: true, aboveTier: false,
    };
  });
  return { entry: null, custom: true, slis, views: [], dashboards: [], synthetic: [], chaos: [], remediation: [], scrapeJobs: [], receivers: [], languages: [], customAttributes: [] };
}

const RESOURCE_ATTRIBUTES = {
  'tier-3': ['service.name', 'deployment.environment'],
  'tier-2': ['service.name', 'service.namespace', 'service.version', 'deployment.environment'],
  'tier-1': ['service.name', 'service.namespace', 'service.version', 'service.instance.id', 'deployment.environment'],
};
const RETENTION = {
  'tier-3': { metrics: '15d', logs: '7d', traces: '3d' },
  'tier-2': { metrics: '90d', logs: '30d', traces: '7d' },
  'tier-1': { metrics: '13mo', logs: '90d', traces: '14d' },
};
const BASELINES = {
  'tier-3': { mttd_target_p50: '15m', mttr_target_p50: '1d', review_cadence: 'monthly' },
  'tier-2': { mttd_target_p50: '5m', mttd_target_p95: '15m', mttr_target_p50: '1h', mttr_target_p95: '4h', measurement_source: 'incident-mgmt + alertmanager firing timestamps', review_cadence: 'monthly', regression_gate: 'warn_only' },
  'tier-1': { mttd_target_p50: '2m', mttd_target_p95: '5m', mttr_target_p50: '30m', mttr_target_p95: '1h', measurement_source: 'incident-mgmt + alertmanager firing timestamps', review_cadence: 'monthly', regression_gate: 'block_release_if_either_breaches_target' },
};
/** The compiler's name for a burn-rate alert (tools/lib/compile.mjs): `<slo>_burn_<factor>x_<short>_<long>`. */
const burnAlertName = (sloId, w) => `${sloId}_burn_${w.factor}x_${w.short}_${w.long}`;

/**
 * The generic tier scaffold — ONE function for every entry. Takes the tier,
 * the service identity and the fragments the entries contributed, and
 * returns a canonical pack whose strings may still carry `${param}`
 * placeholders (resolvePlaceholders substitutes them and records the todos)
 * plus the scaffold's own todos (things no parameter can express: an unwritten
 * runbook, baseline targets that are tier defaults, a generic chaos fault).
 */
export function tierScaffold({ tier, service, environment, owners, fragments, toggles }) {
  const prefix = metricPrefix(service);
  const todos = [];
  const todo = (symbol, field, what, clauses = []) => todos.push({ symbol, field, what, clauses });
  const slis = fragments.flatMap(f => f.slis);
  const ratioSlis = slis.filter(x => x.template.type === 'ratio');
  const t2 = atTier(tier, 'tier-2'), t1 = atTier(tier, 'tier-1');

  // ----- metadata -----
  const ownersList = owners && owners.length ? owners : [`${service}-owners`];
  if (!(owners && owners.length)) todo('metadata.owners', '', `owners defaulted to '${service}-owners': name the owning team(s)`);
  const metadata = {
    name: service,
    version: PACK_VERSION,
    binding: BINDING,
    owners: ownersList,
    imports: [{ ref: 'platform/std-budget-policy@2.1' }],
    bindings: { service, environments: [environment], criticality: tier },
    labels: { source: 'library', tier, 'library.entries': fragments.filter(f => f.entry).map(f => f.entry.id).join(',') },
    annotations: {},   // filled by instantiatePack (provenance, todos, evidence)
  };

  // ----- otel -----
  const languages = uniq(fragments.flatMap(f => f.languages));
  const custom = uniq(fragments.flatMap(f => f.customAttributes));
  const otel = {
    semconv: SEMCONV_VERSION,
    resource_attributes: { required: [...RESOURCE_ATTRIBUTES[tier]], ...(custom.length ? { custom } : {}) },
    sdk: {
      languages: languages.length ? languages : ['go'],
      sampling: { policy: 'parentbased_traceidratio', ratio: t1 ? 1.0 : 0.1 },
      propagators: ['tracecontext', 'baggage'],
      ...(t2 ? { log_correlation: true } : {}),
    },
  };

  // ----- telemetry backends (Prometheus + Loki + Tempo: the otel-grafanalabs binding) -----
  const gating = t1 ? 'enforce' : 'warn';
  const backends = [
    { id: 'metrics-prom', signal: 'metrics', product: 'prometheus', version: { declared: '${prometheus_version}', min: '2.53', gating }, endpoints: ['${metrics_endpoint}'], default: true },
    { id: 'logs-loki', signal: 'logs', product: 'loki', version: { declared: '${loki_version}', min: '3.0', gating }, endpoints: ['${logs_endpoint}'], default: true },
    { id: 'traces-tempo', signal: 'traces', product: 'tempo', version: { declared: '${tempo_version}', min: '2.5', gating }, endpoints: ['${traces_endpoint}'], default: true },
  ];

  // ----- environments -----
  const environments = { [environment]: { criticality: tier, backends: { metrics: 'metrics-prom', logs: 'logs-loki', traces: 'traces-tempo' } } };

  // ----- pipelines -----
  const scrapeJobs = fragments.flatMap(f => f.scrapeJobs).map(j => ({
    job_name: j.job_name, scrape_interval: j.scrape_interval || '30s',
    ...(j.honor_labels ? { honor_labels: true } : {}),
    static_configs: [{ targets: [...j.targets] }],
  }));
  const receivers = [
    { name: 'otlp', protocols: ['grpc', 'http'], endpoint: '0.0.0.0:4317' },
    ...(scrapeJobs.length ? [{ name: 'prometheus', scrape_configs: scrapeJobs }] : []),
    ...fragments.flatMap(f => f.receivers),
  ];
  const processors = [
    { name: 'memory_limiter', limit_percentage: 80 },
    { name: 'batch', timeout: '10s' },
    ...(t2 ? [{ name: 'resource', attributes: [{ key: 'deployment.environment', value: environment, action: 'upsert' }] }] : []),
    ...(t1 ? [{ name: 'tail_sampling', decision_wait: '10s', policies: [{ name: 'errors', type: 'status_code', status_codes: ['ERROR'] }, { name: 'slow', type: 'latency', threshold_ms: 1000 }, { name: 'baseline', type: 'probabilistic', sampling_percentage: 10 }] }] : []),
  ];
  const exporters = {
    metrics: { kind: 'prometheusremotewrite', endpoint: '${remote_write_url}', external_labels: { service } },
    logs: { kind: 'otlphttp', endpoints: ['${logs_otlp_endpoint}'] },
    traces: { kind: 'otlp', endpoint: '${traces_otlp_endpoint}' },
  };

  // ----- storage -----
  const ret = RETENTION[tier];
  const storage = {
    metrics: { backend: 'prometheus', version: '${prometheus_version}', retention: ret.metrics, remote_write: [{ url: '${remote_write_url}' }] },
    logs: { backend: 'loki', version: '${loki_version}', retention: ret.logs },
    traces: { backend: 'tempo', version: '${tempo_version}', retention: ret.traces, sampling: t1 ? 'tail-based' : 'head-based' },
  };

  // ----- L1: SLIs and SLOs -----
  // Copy-on-write over the template: an override replaces the field (its PromQL carries no ${param}, so the
  // substitution below leaves it alone); an edited expression also drops the semconv claim, which was the template's
  // — unless the caller restated the metric (semconv_metric), which is then theirs to claim.
  const specSlis = slis.map(x => {
    const s = x.template, ov = x.overrides || {};
    const promqlEdited = PROMQL_FIELDS.some(k => hasOwn(ov, k));
    const metric = hasOwn(ov, 'semconv_metric') ? ov.semconv_metric : (!promqlEdited ? s.semconv_metric : undefined);
    const base = { id: x.id, type: s.type, description: stripText(ov.description ?? s.description), ...(metric ? { semconv_metric: metric } : {}) };
    if (s.type === 'ratio') return { ...base, good: stripText(ov.good ?? s.good), total: stripText(ov.total ?? s.total), ...(s.owner ? { owner: s.owner } : {}), ...(hasOwn(ov, 'unit') ? { unit: ov.unit } : {}) };
    const unit = ov.unit ?? s.unit;
    return { ...base, query: stripText(ov.query ?? s.query), threshold: ov.threshold ?? s.threshold, ...(unit !== undefined ? { unit } : {}) };
  });
  const specSlos = toggles.slos ? slis.map(x => ({ id: x.sloId, sli: x.id, objective: x.objective, window: x.window, error_budget_policy: BUDGET_POLICY })) : null;

  // ----- L3: queries -----
  const recording_rules = slis.map(x => ({
    name: `${prefix}:${x.id.replace(/[^a-zA-Z0-9_]/g, '_')}:${x.template.type === 'ratio' ? 'ratio_5m' : 'value_5m'}`,
    expr: `ref:slis.${x.id}`, interval: '30s',
  }));
  const derived_views = [
    ...(t2 ? [{ id: `golden_signals_${prefix}`, bind: 'ref:platform/golden-signals-view', params: { service } }] : []),
    ...fragments.flatMap(f => f.views).map(v => ({ id: v.id, bind: v.bind, ...(v.params ? { params: v.params } : {}) })),
  ];

  // ----- L3: dashboards -----
  const board = (id, binds, folder = service) => ({ id, provider: { ...GRAFANA_PROVIDER }, folder, source: `file://dashboards/${id}.json`, panel_bindings: binds.map(b => ({ panel: b.replace(/^(slis|slos)\./, '$1-').replace(/^ref:queries\./, 'view-').replace(/_/g, '-'), binds_to: b })) });
  const allSliBinds = slis.map(x => `slis.${x.id}`), allSloBinds = toggles.slos ? slis.map(x => `slos.${x.sloId}`) : [];
  const dashboards = toggles.dashboards ? [
    board(`${service}-overview`, [...allSliBinds, ...allSloBinds]),
    ...(t2 && toggles.slos ? [{ id: `${service}-slo-burn`, provider: { ...GRAFANA_PROVIDER }, folder: service, template: 'ref:platform/slo-burn-template', params: { slos: slis.map(x => x.sloId) } }] : []),
    ...(t1 ? [board(`${service}-deployment-overlay`, allSliBinds), ...(toggles.slos ? [board(`${service}-customer-impact`, allSloBinds)] : [])] : []),
    ...fragments.flatMap(f => f.dashboards).map(d => board(d.id, d.binds.filter(b => toggles.slos || !b.startsWith('slos.')))).filter(d => d.panel_bindings.length),
  ] : null;

  // ----- L4: policy -----
  const forecasts = [];
  if (toggles.slos) {
    for (const x of slis) {
      const f = x.template.forecast;
      if (f && atTier(tier, f.minTier)) forecasts.push({ slo: x.sloId, method: f.method, horizon: f.horizon || '7d', on_projected_breach: f.on_projected_breach || 'open_ticket' });
    }
    if (t1 && ratioSlis.length && !forecasts.some(f => ratioSlis.some(x => x.sloId === f.slo))) {
      forecasts.push({ slo: ratioSlis[0].sloId, method: 'holt-winters', horizon: '7d', on_projected_breach: 'open_ticket' });
    }
  }
  const policy = toggles.policy && toggles.slos ? {
    burn_rate_alerts: slis.map(x => ({ slo: x.sloId, windows: x.windows.map(w => ({ ...w })) })),
    ...(forecasts.length ? { forecasts } : {}),
  } : null;

  // ----- L4: alerting routes -----
  let alerting = null;
  if (toggles.routes) {
    const routes = [
      { severity: 'SEV1', channels: [{ msteams: '${oncall_channel}' }, ...(t2 ? [{ voice: '${pager_service}' }] : [])] },
      { severity: 'SEV2', channels: [{ msteams: '${oncall_channel}' }, ...(t1 ? [{ voice: '${pager_service_low}' }] : [])] },
      { severity: 'SEV3', channels: [{ msteams: '${team_channel}' }] },
    ];
    alerting = { routes, dedup: 'ref:platform/std-dedup', ...(t2 ? { suppress: ['maintenance_windows', 'deploy_freezes'] } : {}) };
  }

  // ----- L4: remediation (tier-2 and up; tier-1 MUST have one) -----
  let remediation = null;
  if (t2) {
    const items = fragments.flatMap(f => f.remediation);
    if (!items.length && t1 && slis.length) {
      const x = slis[0];
      items.push({ runbook: `${kebab(x.id)}`, automation: 'manual-only', generic: true, sli: x });
    }
    // Triggered by the SLI's fast burn alert under the compiler's name (tools/lib/compile.mjs): the alerts a
    // library pack actually compiles. The entries' symptom-alert names resolved in the reference packs only
    // because those repos ship rule files; here 0 of 21 did.
    remediation = items.map(r => ({
      trigger: `alert:${burnAlertName(r.sli.sloId, r.sli.windows[0])}`,
      runbook: `file://\${runbook_dir}/${r.runbook}.md`,
      automation: r.automation,
      guardrails: { max_invocations_per_hour: 1, requires_human_above: 'SEV2', rollback_on_failure: true, cooldown_after_success: '30m', ...(r.guardrails || {}) },
    }));
    remediation.forEach((r, i) => {
      todo(`remediation[${i}]`, 'runbook', `write the runbook ${r.runbook.replace('${runbook_dir}', '<runbook_dir>')}${items[i].generic ? ' and name the automation (manual-only until one exists)' : ''}`, t1 ? ['L4.MUST.tier1_at_least_one_automation'] : []);
    });
    if (!remediation.length) remediation = null;
  }

  // ----- L5: baselines -----
  const baselines = { ...BASELINES[tier] };
  todo('baselines', 'mttd_target_p50', `MTTD / MTTR targets are the ${tier} defaults, not measured: set them from the service's incident history`, t1 ? ['L5.SHOULD.tier1_release_gate'] : []);

  // ----- L5: validation -----
  let validation = null;
  if (toggles.validation) {
    const probes = fragments.flatMap(f => f.synthetic);
    const synthetic_checks = (probes.length ? probes : [{ id: `${service}-health-probe`, kind: 'blackbox-exporter', target: '${probe_target}', interval: '1m', assertions: [{ status_code: 200 }], on_fail_severity: 'SEV2', generic: true }])
      .map(({ minTier: _m, generic: _g, ...p }, i) => ({ ...p, ...(t1 && i === 0 ? { otel_instrumentation: true } : {}) }));
    synthetic_checks.forEach((p, i) => {
      const generic = !probes.length && i === 0;
      if (generic) todo(`validation.synthetic_checks.${p.id}`, 'target', 'generic health probe: point it at the endpoint that proves the service works end to end', ['L5.MUST.synthetic_probe', ...(t1 && i === 0 ? ['L5.MUST.tier1_weekly_prod_chaos'] : [])]);
    });
    validation = { synthetic_checks };
    if (t2 && toggles.slos) {
      const chaos_experiments = [];
      const declared = fragments.flatMap(f => f.chaos);
      const covered = new Set();
      const experiment = (c, sched, env) => ({
        id: c.id, engine: c.engine, target: c.target, steady_state_hypothesis: `ref:slos.${c.sli.sloId}`,
        fault: clone(c.fault), expected_alerts: [burnAlertName(c.sli.sloId, c.sli.windows[0])], expected_mttd: c.expected_mttd,
        schedule: sched, environment: env,
      });
      // tier-2: the entry's experiments, monthly in staging (one is enough for L5.MUST.tier2_chaos_staging;
      // none declared → a generic one on the first SLO). tier-1: one per SLO, and the first one again weekly in prod.
      const wanted = t1 ? slis : (declared.length ? declared.map(c => c.sli) : slis.slice(0, 1));
      for (const x of wanted) {
        const c = declared.find(d => d.sli === x) || {
          id: `${kebab(x.id)}-degradation`, engine: 'chaos-mesh', target: '${chaos_target}',
          fault: x.template.type === 'ratio' ? { kind: 'pod-failure', fraction: 0.5, duration: '5m' } : { kind: 'network-latency', latency: '500ms', duration: '5m' },
          expected_mttd: '5m', sli: x, generic: true,
        };
        if (covered.has(c.id)) continue;
        covered.add(c.id);
        chaos_experiments.push(experiment(c, 'monthly', 'staging'));
        if (c.generic) todo(`validation.chaos_experiments.${c.id}`, 'fault', `generic ${c.fault.kind} fault chosen by SLI type: replace it with the fault that actually degrades ${x.id}`, ['L5.MUST.tier2_chaos_staging', ...(t1 ? ['L5.MUST.tier1_chaos_for_each_slo'] : [])]);
      }
      if (t1 && chaos_experiments.length) {
        const first = chaos_experiments[0];
        chaos_experiments.push({ ...clone(first), id: `${first.id}-prod`, schedule: 'weekly', environment: 'prod' });
        todo(`validation.chaos_experiments.${first.id}-prod`, 'schedule', 'weekly production chaos (tier-1): confirm the blast radius and the change-freeze rules before enabling it', ['L5.MUST.tier1_weekly_prod_chaos']);
      }
      validation.chaos_experiments = chaos_experiments;
    }
  }

  const spec = {
    otel, telemetry: { backends }, environments,
    slis: specSlis,
    ...(specSlos ? { slos: specSlos } : {}),
    pipelines: { receivers, processors, exporters },
    storage,
    queries: { recording_rules, ...(derived_views.length ? { derived_views } : {}) },
    ...(dashboards ? { dashboards } : {}),
    ...(policy ? { policy } : {}),
    ...(alerting ? { alerting } : {}),
    ...(remediation ? { remediation } : {}),
    baselines,
    ...(validation ? { validation } : {}),
  };
  return { canonical: { apiVersion: 'observability.platform/v1', kind: 'ObservabilityPack', metadata, spec }, todos };
}

/**
 * The adapter's artefact symbol for a path into the pack (tools/lib/adapter.mjs
 * sourceOf ids): the section, then the artefact by id or index; the rest is the field.
 */
const ID_KEYED = new Set(['spec.telemetry.backends', 'spec.validation.synthetic_checks', 'spec.validation.chaos_experiments', 'spec.slis', 'spec.slos', 'spec.dashboards', 'spec.queries.derived_views']);
const INDEX_KEYED = new Set(['spec.pipelines.receivers', 'spec.pipelines.processors', 'spec.alerting.routes', 'spec.remediation', 'spec.queries.recording_rules', 'spec.policy.burn_rate_alerts', 'spec.policy.forecasts', 'spec.mesh', 'spec.collection']);
const KEY_KEYED = new Set(['spec.pipelines.exporters', 'spec.storage']);
export function symbolOf(path, root) {
  const parts = [...path];
  if (parts[0] === 'metadata') return { symbol: `metadata.${parts[1]}`, field: parts.slice(2).join('.') || String(parts[1]) };
  const at = (n) => parts.slice(0, n).join('.');
  for (let n = 2; n <= parts.length; n++) {
    const head = at(n);
    if (ID_KEYED.has(head) || INDEX_KEYED.has(head) || KEY_KEYED.has(head)) {
      const idx = parts[n];
      const rest = parts.slice(n + 1).join('.');
      const symbolHead = head.replace(/^spec\./, '');
      if (idx === undefined) return { symbol: symbolHead, field: rest };
      if (KEY_KEYED.has(head)) return { symbol: `${symbolHead}.${idx}`, field: rest };
      if (INDEX_KEYED.has(head)) return { symbol: `${symbolHead}[${idx}]`, field: rest };
      let node = root;
      for (const p of parts.slice(0, n + 1)) node = node?.[p];
      return { symbol: node && node.id != null ? `${symbolHead}.${node.id}` : `${symbolHead}[${idx}]`, field: rest };
    }
  }
  return { symbol: parts.slice(1, 2).join('.') || parts.join('.'), field: parts.slice(2).join('.') };
}

/** Substitute every `${param}` in the pack, recording a todo wherever a placeholder param left at its default landed. */
function resolvePlaceholders(canonical, { rows, values, provided }) {
  const byKey = new Map(rows.map(r => [r.key, r]));
  const byBare = new Map(rows.filter(r => r.entry).map(r => [r.id, r]));
  const hits = new Map();   // symbol|field → { symbol, field, params:Set }
  const walk = (value, path) => {
    if (typeof value === 'string') {
      return value.replace(PLACEHOLDER_RE, (m, k) => {
        const row = byKey.get(k) || byBare.get(k);
        if (!row) throw new Error(`unresolved placeholder \${${k}} at ${path.join('.')}`);
        if (row.placeholder && !provided.has(row.key)) {
          const { symbol, field } = symbolOf(path, canonical);
          const hk = `${symbol}|${field}`;
          if (!hits.has(hk)) hits.set(hk, { symbol, field, params: new Set() });
          hits.get(hk).params.add(row.key);
        }
        return values[row.key];
      });
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, [...path, i]));
    if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, [...path, k])]));
    return value;
  };
  const resolved = walk(canonical, []);
  const todos = [...hits.values()].map(h => ({
    symbol: h.symbol, field: h.field,
    what: [...h.params].map(k => { const r = byKey.get(k); return `${r.label}: placeholder '${values[k]}' (param ${k}) — ${r.description}`; }).join(' · '),
    params: [...h.params], clauses: [],
  }));
  const used = uniq(todos.flatMap(t => t.params));
  return { canonical: resolved, todos, used };
}

/** The clauses a placeholder artefact holds up, by its symbol (a todo names them so VALIDATE can say "passes on a placeholder"). */
function clausesFor(symbol, canonical, tier) {
  const t2 = atTier(tier, 'tier-2'), t1 = atTier(tier, 'tier-1');
  const out = [];
  if (/^alerting\.routes\[/.test(symbol)) {
    const i = Number(/\[(\d+)\]/.exec(symbol)[1]);
    const r = canonical.spec.alerting?.routes?.[i];
    if (t1 && r?.severity === 'SEV1' && (r.channels || []).some(ch => 'voice' in ch)) out.push('L4.MUST.tier1_voice_route');
  } else if (/^validation\.synthetic_checks\./.test(symbol)) {
    out.push('L5.MUST.synthetic_probe');
    const id = symbol.split('.').slice(2).join('.');
    const s = (canonical.spec.validation?.synthetic_checks || []).find(x => x.id === id);
    if (t1 && s?.otel_instrumentation === true) out.push('L5.MUST.tier1_weekly_prod_chaos');
  } else if (/^validation\.chaos_experiments\./.test(symbol)) {
    const id = symbol.split('.').slice(2).join('.');
    const c = (canonical.spec.validation?.chaos_experiments || []).find(x => x.id === id);
    if (t2 && c?.environment === 'staging') out.push('L5.MUST.tier2_chaos_staging');
    if (t1) out.push('L5.MUST.tier1_chaos_for_each_slo');
    if (t1 && (c?.environment === 'prod' || c?.environment === 'production') && (c.schedule === 'weekly' || c.schedule === 'daily')) out.push('L5.MUST.tier1_weekly_prod_chaos');
  } else if (/^remediation\[/.test(symbol)) {
    if (t1) out.push('L4.MUST.tier1_at_least_one_automation');
  } else if (/^telemetry\.backends\./.test(symbol)) {
    if (t2) out.push('L2.MUST.metrics_logs_traces_backends');
  } else if (/^pipelines\.exporters\.metrics/.test(symbol)) {
    if (t2) out.push('L2.MUST.metrics_exporter');
  } else if (/^pipelines\.exporters\.(logs|traces)/.test(symbol)) {
    if (t1) out.push('L2.MUST.logs_and_traces_exporters');
  } else if (/^pipelines\.receivers\[/.test(symbol)) {
    const i = Number(/\[(\d+)\]/.exec(symbol)[1]);
    if (canonical.spec.pipelines?.receivers?.[i]?.name === 'otlp') out.push('L2.MUST.otlp_receiver');
  } else if (symbol === 'baselines') {
    if (t1) out.push('L5.SHOULD.tier1_release_gate');   // the scaffold's baseline todo holds up the release gate at tier-1
  }
  return out;
}

/**
 * The burn-rule generator's own warnings on the produced pack (tools/lib/burn-rules.mjs, the same
 * generator gen-burn-rules.mjs runs): a good leg derived by arithmetic without a presence guard,
 * a comparison it has to rewrite to bool, a threshold whose unit suggests a floor the spec cannot
 * express. Measured failure modes of the policy, so the caller sees them at build time rather
 * than when the alerts stay silent. Nothing to compile when the SLOs are off.
 */
function burnRuleWarnings(canonical) {
  if (!Array.isArray(canonical.spec.slos) || !canonical.spec.slos.length) return [];
  return compileBurnRules(canonical).warnings.map(message => ({ kind: 'burn-rules', message }));
}

/**
 * instantiatePack(entry | entries, { name, tier, environment, owners, params, toggles, overrides, custom, promql })
 *   → { canonical, todos: [{ path, fields, what, clause, clauses, params }], provenance,
 *       warnings: [{ kind, message, sli?, field? }] }
 *   (one todo per parked artefact; `fields` lists its placeholder fields; SLO ids are sloIdFor(sliId, objective);
 *   `promql` is the PromQL parser used on every resolved SLI expression — a `promql` warning per failure;
 *   any SLI of the passed entries may be selected at any tier (an unknown one throws); `overrides` edit the
 *   selected SLIs' fields (an override for an SLI not in the pack is a warning of kind `override`) and `custom`
 *   adds SLIs written from scratch; the burn-rule generator's warnings on the produced policy come back as kind
 *   `burn-rules`; `provenance.slis[id]` says per SLI where it came from, its evidence and what was customised)
 *
 * Several entries compose into one pack (a service that runs on Kafka AND
 * exposes HTTP): SLI, view, board, probe and chaos ids are prefixed with the
 * entry id and entry params are addressed as `<entry>.<param>` (a bare
 * `<param>` reaches every entry that declares it).
 */
export function instantiatePack(entryOrEntries, opts = {}) {
  const entries = Array.isArray(entryOrEntries) ? entryOrEntries : [entryOrEntries];
  if (!entries.length) throw new Error('instantiatePack: at least one entry is required');
  for (const en of entries) {
    const errs = validateLibraryEntry(en);
    if (errs.length) throw new Error(`instantiatePack: entry ${en?.id ?? '?'} is not valid: ${errs.join('; ')}`);
  }
  if (uniq(entries.map(e => e.id)).length !== entries.length) throw new Error('instantiatePack: the same entry twice');
  const tier = opts.tier || DEFAULT_TIER;
  if (!TIERS.includes(tier)) throw new Error(`instantiatePack: unknown tier ${JSON.stringify(opts.tier)} (expected ${TIERS.join(' | ')})`);
  if (typeof opts.name !== 'string' || !opts.name.trim()) throw new Error('instantiatePack: a service name is required');
  const service = fileSlug(opts.name, '');
  if (!SLUG_RE.test(service)) throw new Error(`instantiatePack: '${opts.name}' does not slug to a valid service name`);
  const environment = fileSlug(opts.environment || DEFAULT_ENVIRONMENT, DEFAULT_ENVIRONMENT);
  const owners = (opts.owners || []).map(o => fileSlug(o, '')).filter(Boolean);
  const prefixed = entries.length > 1;
  const defaults = defaultToggles(entries, tier);
  const toggles = { ...defaults, ...(opts.toggles || {}) };
  for (const k of SECTION_TOGGLES) toggles[k] = toggles[k] !== false;
  const requested = Array.isArray(opts.toggles?.slis) ? opts.toggles.slis : (Array.isArray(opts.slis) ? opts.slis : null);
  const selected = new Set(requested || defaults.slis);
  // The tier is a seed: any SLI of the passed entries may be selected at any tier (the defaults are the ones the
  // tier reaches; the rest start from their own tier's profile). Only an id no entry declares is an error.
  const known = new Map(entries.flatMap(en => (en.slis || []).map(s => [prefixed ? `${metricPrefix(en.id)}_${s.id}` : s.id, { type: s.type, minTier: s.minTier, entry: en.id, sli: s.id }])));
  for (const id of selected) if (!known.has(id)) throw new Error(`unknown SLI ${id} (known: ${[...known.keys()].join(', ')})`);
  const { byId: overrides, warnings: overrideWarnings } = checkOverrides(opts.overrides, known, selected);
  const customDefs = checkCustom(opts.custom, selected, known);
  if (!selected.size && !customDefs.length) throw new Error('instantiatePack: at least one SLI must stay selected (or a custom SLI added)');
  toggles.slis = [...selected];

  const fragments = [
    ...entries.map(en => entryFragment(en, { tier, selectedSlis: selected, prefixed, overrides })),
    ...(customDefs.length ? [customFragment(customDefs, { tier })] : []),
  ];
  checkSliIds(fragments.flatMap(f => f.slis), known);
  checkSloIds(fragments.flatMap(f => f.slis));
  const { canonical: draft, todos: scaffoldTodos } = tierScaffold({ tier, service, environment, owners, fragments, toggles });

  const rows = paramTable(entries, prefixed);
  const { values, provided } = resolveParams(rows, checkParams(opts.params || {}, rows), { service, environment, tier });
  const { canonical, todos: paramTodos, used } = resolvePlaceholders(draft, { rows, values, provided });
  const warnings = [...overrideWarnings, ...promqlWarnings(canonical, opts.promql), ...burnRuleWarnings(canonical)];

  // Merge the scaffold's own todos with the placeholder todos: ONE todo per artefact (symbol),
  // its fields listed, so `library.todo.<symbol>` is one annotation per parked artefact.
  const merged = new Map();
  for (const t of [...paramTodos, ...scaffoldTodos]) {
    if (!merged.has(t.symbol)) merged.set(t.symbol, { symbol: t.symbol, fields: [], what: [], clauses: new Set(), params: new Set() });
    const m = merged.get(t.symbol);
    if (t.field && !m.fields.includes(t.field)) m.fields.push(t.field);
    m.what.push(t.field ? `${t.field}: ${t.what}` : t.what);
    for (const c of t.clauses || []) m.clauses.add(c);
    for (const p of t.params || []) m.params.add(p);
  }
  const todos = [...merged.values()].map(m => {
    const clauses = uniq([...m.clauses, ...clausesFor(m.symbol, canonical, tier)]).sort();   // sorted: todosFromAnnotations reproduces the same list
    return { path: m.symbol, fields: m.fields, what: m.what.join(' · '), clause: clauses[0] || null, clauses, params: [...m.params] };
  }).sort((a, b) => a.path.localeCompare(b.path));

  // Provenance and the todo annotations (flat string map, as the schema requires).
  const source = entries.map(en => `${en.id}@${en.version}`).join(',');
  const ann = canonical.metadata.annotations;
  ann['library.source'] = source;
  ann['library.format'] = LIBRARY_FORMAT;
  ann['library.tier'] = tier;
  ann['library.environment'] = environment;
  ann['library.toggles'] = SECTION_TOGGLES.filter(k => toggles[k]).join(',');
  ann['library.slis'] = toggles.slis.join(',');
  ann['library.params'] = JSON.stringify(Object.fromEntries(rows.filter(r => provided.has(r.key)).map(r => [r.key, values[r.key]])));
  ann['library.evidence'] = entries.map(en => `${en.id}:${en.evidence.status}`).join(',');
  // Per SLI: the evidence as it stands (an edited expression drops the library's — honestly `custom`), and what
  // was customised, so VERIFY and Discover can say "customised: objective, query" after the hand-off.
  const sliProvenance = {};
  for (const f of fragments) for (const x of f.slis) {
    const evidence = evidenceOf(x);
    ann[`library.evidence.slis.${x.id}`] = `${evidence.status}: ${evidence.source}${evidence.note ? ` — ${evidence.note}` : ''}`;
    if (x.customised.length) ann[`library.customised.slis.${x.id}`] = x.customised.join(',');
    sliProvenance[x.id] = {
      library: x.custom ? { source: 'custom', entry: null, sli: null } : { source: `${x.entry.id}@${x.entry.version}`, entry: x.entry.id, sli: x.template.id },
      evidence, customised: [...x.customised], custom: x.custom, aboveTier: x.aboveTier, ...(x.aboveTier ? { profileTier: x.template.minTier } : {}),
    };
  }
  if (customDefs.length) ann['library.custom'] = customDefs.map(d => d.id).join(',');
  if (overrides.size) ann['library.overrides'] = JSON.stringify(Object.fromEntries([...overrides].map(([id, ov]) => [id, { ...ov }])));
  ann['library.todoCount'] = String(todos.length);
  for (const t of todos) ann[`library.todo.${t.path}`] = t.what;

  const provenance = {
    entry: entries.length === 1 ? entries[0].id : entries.map(en => en.id),
    version: entries.length === 1 ? entries[0].version : entries.map(en => en.version),
    entries: entries.map(en => ({ id: en.id, version: en.version, kind: en.kind, evidence: en.evidence.status })),
    source, tier, environment, toggles: { ...toggles },
    params: Object.fromEntries(rows.map(r => [r.key, values[r.key]])),
    placeholders: used,   // the placeholder params that landed in the pack at their default (each is a todo)
    overrides: Object.fromEntries([...overrides].map(([id, ov]) => [id, { ...ov }])),   // the overrides applied (the warned-about ones are not here)
    custom: customDefs.map(d => d.id),
    slis: sliProvenance,
  };
  return { canonical, todos, provenance, warnings };
}

/**
 * The evidence an SLI carries in the produced pack: the template's while the library's expression is what runs;
 * `custom` once its PromQL was edited (the library's evidence is about the library's expression — it no longer
 * applies) or when the SLI was written from scratch. The shape the studio's evidence vocabulary reads.
 */
function evidenceOf(x) {
  if (x.custom) return { status: 'custom', source: 'written in the studio' };
  if (PROMQL_FIELDS.some(k => x.customised.includes(k))) return { status: 'custom', source: 'edited in the studio', note: 'the library evidence no longer applies' };
  return { status: x.template.evidence.status, source: x.template.evidence.source };
}

/**
 * The VALIDATE step's reading of a produced pack: the clauses that apply at the
 * pack's tier, which pass, which fail, and which pass only on a placeholder
 * (a todo names the clause). Pure over evaluateConformance.
 */
export function validationSummary(canonical, todos = []) {
  const report = evaluateConformance(canonical);
  const byClause = new Map();
  for (const t of todos) for (const c of t.clauses || []) { if (!byClause.has(c)) byClause.set(c, []); byClause.get(c).push(t); }
  const applicable = report.clauses.filter(c => c.applies);
  return {
    tier: report.declaredTier, conformant: report.conformant, mustPercent: report.mustPercent, scorePercent: report.scorePercent,
    must: report.must, should: report.should,
    passing: applicable.filter(c => c.pass && !byClause.has(c.id)).map(c => c.id),
    onPlaceholder: applicable.filter(c => c.pass && byClause.has(c.id)).map(c => ({ id: c.id, severity: c.severity, todos: byClause.get(c.id).map(t => t.path) })),
    failing: applicable.filter(c => !c.pass).map(c => ({ id: c.id, severity: c.severity, description: c.description, todos: (byClause.get(c.id) || []).map(t => t.path) })),
  };
}

const TODO_PREFIX = 'library.todo.';
const TODO_PARAM_RE = /\(param ([a-zA-Z_][a-zA-Z0-9_.-]*)\)/g;

/** Whether a pack carries `library.todo.<symbol>` annotations (a library-built pack with placeholders left). */
export function hasLibraryTodos(canonical) {
  return Object.keys(canonical?.metadata?.annotations || {}).some(k => k.startsWith(TODO_PREFIX));
}

/**
 * Recover the todo list from a pack's `library.todo.<symbol>` annotations, so a pack that arrives
 * as YAML (an upload of what packc init wrote, the register hand-off) reads like a fresh
 * instantiation: `{ path, fields, what, clause, clauses, params }` per parked artefact, the clauses
 * derived from the pack itself (clausesFor) and the params from the annotation text. The tier is
 * `library.tier`, falling back to the declared criticality. `validationSummary(canonical,
 * todosFromAnnotations(canonical)).onPlaceholder` is then what /api/validate attaches.
 */
export function todosFromAnnotations(canonical) {
  const ann = canonical?.metadata?.annotations || {};
  const tier = TIERS.includes(ann['library.tier']) ? ann['library.tier'] : (canonical?.metadata?.bindings?.criticality || DEFAULT_TIER);
  return Object.entries(ann)
    .filter(([k, v]) => k.startsWith(TODO_PREFIX) && typeof v === 'string')
    .map(([k, what]) => {
      const path = k.slice(TODO_PREFIX.length);
      const fields = uniq(what.split(' · ').map(part => /^([a-zA-Z0-9_.[\]-]+): /.exec(part)?.[1]).filter(Boolean));
      const params = uniq([...what.matchAll(TODO_PARAM_RE)].map(m => m[1]));
      const clauses = canonical?.spec ? uniq(clausesFor(path, canonical, tier)).sort() : [];
      return { path, fields, what, clause: clauses[0] || null, clauses, params };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
