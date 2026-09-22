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
//      scrape jobs, product dashboards, derived views, synthetic probes and
//      chaos templates, with an evidence block per entry and per SLI
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
// Toggles leave honest gaps: a section switched off is absent from the pack;
// the schema (minItems: 1 on slos / dashboards / burn_rate_alerts / routes)
// and the rubric then both say what is missing — nothing is faked to keep a
// clause green.
//
// PURE and browser-safe (served at /lib to the studio in slice 2): no
// node:* imports, no process.env, no filesystem. server/library.mjs reads
// the entries from disk and hands them here.

import { parse as parseYaml } from './mini-yaml.mjs';
import { RUBRIC, TIER_RANK, evaluateConformance } from './conformance.mjs';
import { fileSlug, metricPrefix } from './slug.mjs';

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
]);
const BUILTIN_PARAMS = ['service', 'environment', 'tier'];
/** The compiler's policy records are `<service>:errorbudget:burn_<w>`; an SLI of that id would write the same series (tools/lib/sli-inference.mjs reserves it). */
const POLICY_SEGMENT = 'errorbudget';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const rank = (t) => TIER_RANK[t] ?? 0;
const atTier = (tier, minTier) => rank(tier) >= rank(minTier || 'tier-3');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A per-tier map `{ tier-1: x, tier-2: y, tier-3: z }` or a scalar that applies to every tier. */
const perTier = (v, tier, fallback) => (isObj(v) ? (v[tier] ?? fallback) : (v ?? fallback));
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
        for (const t of TIERS) {
          const o = perTier(s.slo.objective, t, undefined);
          if (typeof o !== 'number' || !(o > 0 && o < 1)) e(`${at}.slo.objective[${t}]: expected a number in (0, 1), got ${JSON.stringify(o)}`);
          const w = perTier(s.slo.window, t, '30d');
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
          if (typeof r.trigger !== 'string' || !/^alert:[a-z0-9-]+$/.test(r.trigger)) e(`${at}.remediation.trigger: expected alert:<kebab-name>`);
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
    const slis = (entry.slis || []).map(s => ({
      id: s.id, type: s.type, minTier: s.minTier, unit: s.unit, description: s.description,
      evidence: s.evidence?.status || null, metrics: [...(s.metrics || [])],
      objectives: Object.fromEntries(TIERS.map(t => [t, perTier(s.slo?.objective, t, null)])),
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
 * still named the right key); an object was spliced in as '[object Object]'.
 */
function checkParams(userParams, rows) {
  if (!isObj(userParams)) throw new Error('instantiatePack: params must be an object of key → string | number | boolean');
  const known = uniq([...rows.map(r => r.key), ...rows.filter(r => r.entry).map(r => r.id)]);
  const unknown = Object.keys(userParams).filter(k => !known.includes(k));
  if (unknown.length) throw new Error(`unknown param ${unknown.join(', ')} (known: ${known.sort().join(', ')})`);
  for (const [k, v] of Object.entries(userParams)) {
    if (!['string', 'number', 'boolean'].includes(typeof v)) throw new Error(`param ${k}: expected a string, number or boolean, got ${v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v}`);
  }
  return userParams;
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
function entryFragment(entry, { tier, selectedSlis, prefixed }) {
  const px = prefixed ? `${metricPrefix(entry.id)}_` : '';
  const dpx = prefixed ? `${fileSlug(entry.id)}-` : '';
  const slis = [];
  for (const s of entry.slis || []) {
    const id = `${px}${s.id}`;
    if (!selectedSlis.has(id)) continue;
    if (!atTier(tier, s.minTier)) throw new Error(`SLI ${id} needs ${s.minTier}; the pack is ${tier}`);
    const objective = perTier(s.slo.objective, tier, null);
    const window = perTier(s.slo.window, tier, '30d');
    const profile = Array.isArray(s.burn) ? s.burn : BURN_PROFILES[s.burn || (s.type === 'ratio' ? 'availability' : 'latency')];
    const windows = profile.map(w => ({ ...w, severity: tier === 'tier-3' ? DEMOTE[w.severity] || w.severity : w.severity }));
    slis.push({ template: s, entry, id, sloId: sloIdFor(id, objective), objective, window, windows });
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
    labels: { source: 'library', tier, 'library.entries': fragments.map(f => f.entry.id).join(',') },
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
    { id: 'metrics-prom', signal: 'metrics', product: 'prometheus', version: { declared: '3.14', min: '2.53', gating }, endpoints: ['${metrics_endpoint}'], default: true },
    { id: 'logs-loki', signal: 'logs', product: 'loki', version: { declared: '3.7', min: '3.0', gating }, endpoints: ['${logs_endpoint}'], default: true },
    { id: 'traces-tempo', signal: 'traces', product: 'tempo', version: { declared: '2.10', min: '2.5', gating }, endpoints: ['${traces_endpoint}'], default: true },
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
    metrics: { backend: 'prometheus', version: '3.14', retention: ret.metrics, remote_write: [{ url: '${remote_write_url}' }] },
    logs: { backend: 'loki', version: '3.7', retention: ret.logs },
    traces: { backend: 'tempo', version: '2.10', retention: ret.traces, sampling: t1 ? 'tail-based' : 'head-based' },
  };

  // ----- L1: SLIs and SLOs -----
  const specSlis = slis.map(x => {
    const s = x.template;
    const base = { id: x.id, type: s.type, description: stripText(s.description), ...(s.semconv_metric ? { semconv_metric: s.semconv_metric } : {}) };
    if (s.type === 'ratio') return { ...base, good: stripText(s.good), total: stripText(s.total), ...(s.owner ? { owner: s.owner } : {}) };
    return { ...base, query: stripText(s.query), threshold: s.threshold, unit: s.unit };
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
      items.push({ trigger: `alert:${kebab(x.sloId)}-burn-fast`, runbook: `${kebab(x.id)}`, automation: 'manual-only', generic: true, sli: x });
    }
    remediation = items.map(r => ({
      trigger: r.trigger,
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
  }
  return out;
}

/**
 * instantiatePack(entry | entries, { name, tier, environment, owners, params, toggles })
 *   → { canonical, todos: [{ path, fields, what, clause, clauses, params }], provenance, warnings }
 *   (one todo per parked artefact; `fields` lists its placeholder fields; SLO ids are sloIdFor(sliId, objective))
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
  for (const id of selected) if (!defaults.slis.includes(id)) {
    const known = entries.flatMap(en => (en.slis || []).map(s => (prefixed ? `${metricPrefix(en.id)}_${s.id}` : s.id)));
    throw new Error(known.includes(id) ? `SLI ${id} needs a higher tier than ${tier}` : `unknown SLI ${id} (known: ${known.join(', ')})`);
  }
  if (!selected.size) throw new Error('instantiatePack: at least one SLI must stay selected');
  toggles.slis = [...selected];

  const fragments = entries.map(en => entryFragment(en, { tier, selectedSlis: selected, prefixed }));
  const { canonical: draft, todos: scaffoldTodos } = tierScaffold({ tier, service, environment, owners, fragments, toggles });

  const rows = paramTable(entries, prefixed);
  const { values, provided } = resolveParams(rows, checkParams(opts.params || {}, rows), { service, environment, tier });
  const { canonical, todos: paramTodos, used } = resolvePlaceholders(draft, { rows, values, provided });

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
    const clauses = uniq([...m.clauses, ...clausesFor(m.symbol, canonical, tier)]);
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
  for (const f of fragments) for (const x of f.slis) ann[`library.evidence.slis.${x.id}`] = `${x.template.evidence.status}: ${x.template.evidence.source}`;
  ann['library.todoCount'] = String(todos.length);
  for (const t of todos) ann[`library.todo.${t.path}`] = t.what;

  const provenance = {
    entry: entries.length === 1 ? entries[0].id : entries.map(en => en.id),
    version: entries.length === 1 ? entries[0].version : entries.map(en => en.version),
    entries: entries.map(en => ({ id: en.id, version: en.version, kind: en.kind, evidence: en.evidence.status })),
    source, tier, environment, toggles: { ...toggles },
    params: Object.fromEntries(rows.map(r => [r.key, values[r.key]])),
    placeholders: used,   // the placeholder params that landed in the pack at their default (each is a todo)
  };
  return { canonical, todos, provenance, warnings: [] };
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
