// tools/lib/adapter.mjs
//
// Projects a canonical ObservabilityPack v1.2 manifest into the studio's
// layered display object. Browser-friendly ESM — no Node APIs — so the
// studio HTML can `<script type="module">` import this same file as the
// Node CLI wrapper (tools/adapt-spec-pack.mjs).
//
// PUBLIC API
//   adapt(canonicalPack, opts?)         -> layeredDisplayPack
//   listEnvironments(canonicalPack)     -> string[]
//   applyEnvironmentOverlay(spec, env)  -> { spec, effective }

import { annotationList, buildRequirementTraceability } from './traceability.mjs';
//
// LAYERED DISPLAY OBJECT shape:
//   {
//     id, name, badge, description,
//     meta: { apiVersion, kind, binding, version, owners, criticality,
//             environment, environments, target },
//     layers: {
//       L1: artefact[],
//       L2: artefact[],
//       L2X: artefact[],
//       L3: artefact[],
//       L4: { policy: artefact[], alerting: artefact[], healing: artefact[] },
//       L5: artefact[],
//       GOV: artefact[],
//     },
//   }
//
// ARTEFACT shape:
//   {
//     id: string,           // e.g. "SLI-01", "BAK-03"
//     title: string,        // human label
//     desc: string,         // one-line summary
//     tool: string,         // implementation tool/family
//     tags: string[],       // free-form tags
//     source: 'Declared' | 'Verified' | 'Scaffold',
//                              // 'Missing' added by Phase 3 conformance pass
//     defines?: string,     // symbol this artefact defines (e.g. "slis.api_availability")
//     refs?: string[],      // symbols this artefact references (cross-ref check input)
//     spec: object,         // raw canonical section/item (drawer detail)
//     mcp?: object,         // verification evidence (metadata.annotations.mcp.<id>)
//   }

const CANONICAL_API_VERSION = 'observability.platform/v1';
const CANONICAL_KIND = 'ObservabilityPack';

// ---------- public API ----------

export function adapt(canonical, opts = {}) {
  if (!canonical || typeof canonical !== 'object') {
    throw new Error('adapter: input must be an object');
  }
  if (canonical.apiVersion !== CANONICAL_API_VERSION || canonical.kind !== CANONICAL_KIND) {
    throw new Error(
      `adapter: not a canonical ObservabilityPack v1.2 manifest ` +
      `(apiVersion=${JSON.stringify(canonical.apiVersion)}, kind=${JSON.stringify(canonical.kind)})`
    );
  }

  const envs = listEnvironments(canonical);
  const envName = opts.environment ?? envs[0] ?? null;
  const { spec, effective } = applyEnvironmentOverlay(canonical.spec || {}, envName);

  // Per-artefact verification markers live as flat annotation keys:
  // `mcp.verified.<symbol>` -> ISO timestamp (a single string, since the
  // schema constrains metadata.annotations to {string: string}).
  const annotations = canonical.metadata?.annotations || {};
  const verifyPrefix = 'mcp.verified.';
  const scaffoldPrefix = 'crawler.scaffold.';

  const ctx = {
    spec,
    annotations,
    canonical,    // adaptMetricInventory + adaptDashboardPanels read metadata.annotations directly
    sourceOf: (id) => (
      annotations[`${verifyPrefix}${id}`]
        ? 'Verified'
        : annotations[`${scaffoldPrefix}${id}`] ? 'Scaffold' : 'Declared'
    ),
    mcpEvidence: (id) => annotations[`${verifyPrefix}${id}`] ?? undefined,
  };

  const layers = {
    L1: [...adaptSLIs(ctx), ...adaptSLOs(ctx)],
    L2: [
      ...adaptOtel(ctx),
      ...adaptBackends(ctx),
      ...adaptPipelines(ctx),
      ...adaptStorage(ctx),
      ...adaptSourceMetricDefinitions(ctx),
      ...adaptScrapeJobs(ctx),
      ...adaptMetricInventory(ctx),
    ],
    L2X: [
      ...adaptProfiling(ctx),
      ...adaptNetwork(ctx),
      ...adaptPolicyEngine(ctx),
      ...adaptMesh(ctx),
      ...adaptCollection(ctx),
    ],
    L3: [
      ...adaptQueries(ctx),
      ...adaptDashboards(ctx),
      ...adaptDashboardPanels(ctx),
    ],
    L4: {
      policy: [
        ...adaptBurnRateAlerts(ctx),
        ...adaptForecasts(ctx),
      ],
      alerting: adaptAlertingRoutes(ctx),
      healing: adaptRemediation(ctx),
    },
    L5: [
      ...adaptBaselines(ctx),
      ...adaptChaos(ctx),
      ...adaptSynthetic(ctx),
    ],
    GOV: adaptImports(canonical),
  };

  const metaBindings = canonical.metadata?.bindings || {};
  return {
    id: canonical.metadata?.name ?? '(unnamed)',
    name: canonical.metadata?.name ?? '(unnamed)',
    badge: (effective.criticality || metaBindings.criticality || '').toUpperCase() || undefined,
    description:
      `ObservabilityPack ${canonical.metadata?.version ?? ''} ` +
      `for ${metaBindings.service ?? canonical.metadata?.name ?? '(service)'}`.trim(),
    meta: {
      apiVersion: canonical.apiVersion,
      kind: canonical.kind,
      name: canonical.metadata?.name,
      binding: canonical.metadata?.binding,
      version: canonical.metadata?.version,
      owners: canonical.metadata?.owners ?? [],
      service: metaBindings.service,
      diffScopeMode: annotations['observogram.diff.scopeMode'] ?? annotations['tomograph.diff.scopeMode'],
      criticality: effective.criticality || metaBindings.criticality,
      environment: envName,
      environments: envs,
      target: effective.target || metaBindings.default_target,
      backendWiring: effective.backendWiring,
      // Annotations carry the per-artefact verification stamps
      // (mcp.verified.<sym>), live version captures (mcp.versions.<product>),
      // capability inventory, and probe provenance. The studio's Benchmark
      // view + lens rely on them to score and source-tag artefacts.
      annotations: { ...annotations },
    },
    layers,
    traceability: buildRequirementTraceability({ spec, annotations, layers }),
  };
}

export function listEnvironments(canonical) {
  const out = new Set(Object.keys(canonical?.spec?.environments || {}));
  for (const env of canonical?.metadata?.bindings?.environments || []) {
    if (typeof env === 'string' && env.trim()) out.add(env.trim());
  }
  return [...out];
}

export function applyEnvironmentOverlay(specInput, envName) {
  const spec = deepClone(specInput);
  const effective = {
    target: undefined,
    criticality: undefined,
    backendWiring: undefined,
  };
  if (!envName) return { spec, effective };
  const env = spec.environments?.[envName];
  if (!env) return { spec, effective };
  for (const [path, value] of Object.entries(env.overrides || {})) {
    setDottedPath(spec, path, value);
  }
  effective.target = env.target;
  effective.criticality = env.criticality;
  effective.backendWiring = env.backends;
  return { spec, effective };
}

// ---------- per-section adapters ----------

const SLI_TYPE_LABEL = {
  ratio: 'ratio SLI',
  threshold: 'threshold SLI',
  distribution: 'distribution SLI',
  custom: 'custom SLI',
};

function adaptSLIs(ctx) {
  const slis = ctx.spec.slis || [];
  return slis.map((sli, i) => ({
    id: `SLI-${pad(i + 1)}`,
    title: sli.id,
    desc: sli.description || `${sli.type ?? '(untyped)'} SLI`,
    tool: SLI_TYPE_LABEL[sli.type] || 'SLI',
    tags: ['sli', sli.type, ...(sli.semconv_metric ? ['semconv'] : [])].filter(Boolean),
    source: ctx.sourceOf(`slis.${sli.id}`),
    defines: `slis.${sli.id}`,
    spec: sli,
    mcp: ctx.mcpEvidence(`slis.${sli.id}`),
  }));
}

function adaptSLOs(ctx) {
  const slos = ctx.spec.slos || [];
  return slos.map((slo, i) => ({
    id: `SLO-${pad(i + 1)}`,
    title: slo.id,
    desc:
      `${formatPct(slo.objective)} over ${slo.window} ` +
      `(SLI: ${stripRefPrefix(slo.sli)})`,
    tool: 'SLO',
    tags: ['slo', slo.window].filter(Boolean),
    source: ctx.sourceOf(`slos.${slo.id}`),
    defines: `slos.${slo.id}`,
    refs: [normalizeSliRef(slo.sli)],
    spec: slo,
    mcp: ctx.mcpEvidence(`slos.${slo.id}`),
  }));
}

function adaptOtel(ctx) {
  const o = ctx.spec.otel;
  if (!o) return [];
  const langs = o.sdk?.languages?.join(', ') || '?';
  const sampling = o.sdk?.sampling
    ? `${o.sdk.sampling.policy}${o.sdk.sampling.ratio !== undefined ? ` @ ${o.sdk.sampling.ratio}` : ''}`
    : '?';
  return [{
    id: 'OTEL-01',
    title: `OTel SemConv ${o.semconv}`,
    desc: `Languages: ${langs} · sampling: ${sampling}`,
    tool: 'OpenTelemetry SDK',
    tags: [
      'otel',
      `semconv-${o.semconv}`,
      ...(o.sdk?.log_correlation ? ['log-correlation'] : []),
    ],
    source: ctx.sourceOf('otel'),
    spec: o,
    mcp: ctx.mcpEvidence('otel'),
  }];
}

function adaptBackends(ctx) {
  const bs = ctx.spec.telemetry?.backends || [];
  return bs.map((b, i) => ({
    id: `BAK-${pad(i + 1)}`,
    title: b.id,
    desc: [
      b.product,
      b.version?.declared,
      b.signal && `(${b.signal})`,
    ].filter(Boolean).join(' '),
    tool: b.product || 'backend',
    tags: [
      b.signal,
      b.version?.gating && `gating-${b.version.gating}`,
      b.default && 'default',
    ].filter(Boolean),
    source: ctx.sourceOf(`telemetry.backends.${b.id}`),
    defines: `telemetry.backends.${b.id}`,
    spec: b,
    mcp: ctx.mcpEvidence(`telemetry.backends.${b.id}`),
  }));
}

function adaptPipelines(ctx) {
  const p = ctx.spec.pipelines || {};
  const out = [];
  (p.receivers || []).forEach((r, i) => out.push({
    id: `PIP-RCV-${pad(i + 1)}`,
    title: `receiver: ${r.name}`,
    desc: 'OTel Collector receiver',
    tool: 'OTel Collector',
    tags: ['receiver', r.name].filter(Boolean),
    source: ctx.sourceOf(`pipelines.receivers[${i}]`),
    spec: r,
  }));
  (p.processors || []).forEach((pr, i) => out.push({
    id: `PIP-PRC-${pad(i + 1)}`,
    title: `processor: ${pr.name}`,
    desc: 'OTel Collector processor',
    tool: 'OTel Collector',
    tags: ['processor', pr.name].filter(Boolean),
    source: ctx.sourceOf(`pipelines.processors[${i}]`),
    spec: pr,
  }));
  const FAM = { metrics: 'MET', logs: 'LOG', traces: 'TRC' };
  for (const family of Object.keys(FAM)) {
    const e = p.exporters?.[family];
    if (!e) continue;
    out.push({
      id: `PIP-EXP-${FAM[family]}`,
      title: `exporter (${family}): ${e.kind}`,
      desc: 'OTel Collector exporter',
      tool: e.kind,
      tags: ['exporter', family],
      source: ctx.sourceOf(`pipelines.exporters.${family}`),
      spec: e,
    });
  }
  return out;
}

function adaptStorage(ctx) {
  const s = ctx.spec.storage || {};
  const out = [];
  const FAM = { metrics: 'MET', logs: 'LOG', traces: 'TRC' };
  for (const family of Object.keys(FAM)) {
    const v = s[family];
    if (!v) continue;
    const parts = [v.backend, v.version, v.retention && `retain ${v.retention}`].filter(Boolean);
    out.push({
      id: `STO-${FAM[family]}-01`,
      title: `${family} storage`,
      desc: parts.join(' '),
      tool: v.backend || 'storage',
      tags: [
        'storage',
        family,
        v.gating && `gating-${v.gating}`,
        v.sampling && `sampling-${v.sampling}`,
      ].filter(Boolean),
      source: ctx.sourceOf(`storage.${family}`),
      spec: v,
    });
  }
  return out;
}

// L2 EXPAND: source-side metric definitions projected from crawler
// annotations. These are not runtime evidence; they are first-class declared
// metric artefacts with origin metadata, so the graph can link an SLI series
// back to the file/service that emits it.
function adaptSourceMetricDefinitions(ctx) {
  const ann = ctx.canonical?.metadata?.annotations || {};
  const names = annotationList(
    ann['crawler.discovered.metric_names'],
    ann['crawler.discovered.metric_names_count'],
    ann['crawler.discovered.metric_names_sample'],
  );
  if (!names.length) return [];
  const origins = parseAnnotationObject(ann['crawler.discovered.metric_origins']);
  return names.map((name, i) => {
    const origin = origins[name] || {};
    return {
      id: `METRIC-SRC-${pad(i + 1)}`,
      title: name,
      desc: origin.file ? `declared in ${origin.file}` : 'declared metric',
      tool: origin.type ? `Prometheus ${origin.type}` : 'Prometheus metric',
      tags: ['metric', 'declared', origin.service, origin.type, origin.origin_kind].filter(Boolean),
      source: 'Declared',
      expand: true,
      parent: 'telemetry.metric_inventory',
      spec: {
        name,
        source: 'crawler.discovered',
        source_name: origin.source_name || null,
        origin_kind: origin.origin_kind || null,
        origin_file: origin.file || null,
        origin_service: origin.service || null,
        metric_type: origin.type || null,
        confidence: origin.confidence || null,
        candidate: Boolean(origin.candidate),
        help: origin.help || null,
        origin_labels: origin.labels || [],
        origin_query: name,
        query: origin.query || null,
        used_by: origin.used_by || [],
        references: origin.references || [],
      },
    };
  });
}

// L2 EXPAND: scrape jobs projected from repo crawler annotations and live MCP
// annotations. The canonical v1.2 schema does not have a first-class
// scrape_jobs field, so both paths store them in annotations. Projecting them
// here makes scrape evidence visible and comparable without changing the pack
// schema.
function adaptScrapeJobs(ctx) {
  const ann = ctx.canonical?.metadata?.annotations || {};
  const out = [];
  const sourceOrigins = parseAnnotationObject(ann['crawler.discovered.scrape_job_origins']);
  const metricOrigins = parseAnnotationObject(ann['crawler.discovered.metric_origins']);
  const sourceJobs = annotationList(
    ann['crawler.discovered.scrape_jobs'],
    ann['crawler.discovered.scrape_jobs_count'],
  );
  sourceJobs.forEach((job, i) => {
    const origin = sourceOrigins[job] || {};
    const exports = metricExportsForJob(metricOrigins, job);
    out.push({
      id: `SCRAPE-SRC-${pad(i + 1)}`,
      title: job,
      desc: `TelemetrySource${origin.file ? ` · ${origin.file}` : ''}`,
      tool: 'Prometheus / OTel Collector',
      tags: ['telemetry-source', 'scrape', 'target', 'declared'],
      source: 'Declared',
      expand: true,
      parent: 'telemetry.scrape',
      spec: {
        type: 'TelemetrySource',
        job,
        source: 'crawler.discovered.scrape_jobs',
        origin_file: origin.file || null,
        file: origin.file || null,
        scrape_query: origin.metrics_path || '/metrics',
        metrics_path: origin.metrics_path || null,
        interval: origin.interval || null,
        targets: origin.targets || [],
        exports,
      },
    });
  });

  const liveJobs = annotationList(ann['mcp.discovered.scrape_jobs']);
  liveJobs.forEach((job, i) => out.push({
    id: `SCRAPE-${pad(i + 1)}`,
    title: `scrape: ${job}`,
    desc: 'live scrape job (MCP)',
    tool: 'Prometheus scrape',
    tags: ['scrape', 'target', 'verified'],
    source: 'Verified',
    expand: true,
    parent: 'telemetry.scrape',
    spec: { job, source: 'mcp.discovered.scrape_jobs' },
    mcp: { tool: 'scrape_configs', when: ann['mcp.refreshedAt'] },
  }));
  return out;
}

function metricExportsForJob(metricOrigins, job) {
  return Object.entries(metricOrigins || {})
    .filter(([_, origin]) => metricSourceMatchesJob(origin, job))
    .map(([name]) => name)
    .sort();
}

function metricSourceMatchesJob(origin, job) {
  const svc = compact(origin?.service || '');
  const j = compact(job || '');
  if (!svc || !j) return false;
  return svc.includes(j) || j.includes(svc);
}

function adaptProfiling(ctx) {
  const p = ctx.spec.profiling;
  if (!p) return [];
  return [{
    id: 'PROF-01',
    title: `profiling: ${p.product || 'unspecified'}`,
    desc: p.profile_types?.length
      ? `Profile types: ${p.profile_types.join(', ')}`
      : 'Continuous profiling',
    tool: p.product || 'profiling',
    tags: ['profiling', ...(p.profile_types || [])],
    source: ctx.sourceOf('profiling'),
    refs: p.backend ? [`telemetry.backends.${p.backend}`] : [],
    spec: p,
  }];
}

function adaptNetwork(ctx) {
  const n = ctx.spec.network;
  if (!n) return [];
  return [{
    id: 'NET-01',
    title: `network observability: ${n.product || 'unspecified'}`,
    desc: n.observe?.length ? `Observes: ${n.observe.join(', ')}` : 'eBPF / network observability',
    tool: n.product || 'network',
    tags: ['network', ...(n.observe || [])],
    source: ctx.sourceOf('network'),
    refs: n.backend ? [`telemetry.backends.${n.backend}`] : [],
    spec: n,
  }];
}

function adaptPolicyEngine(ctx) {
  const pe = ctx.spec.policy_engine;
  if (!pe) return [];
  return [{
    id: 'POE-01',
    title: `policy engine: ${pe.product || 'unspecified'}`,
    desc: pe.bundles?.length ? `Bundles: ${pe.bundles.join(', ')}` : 'Policy-as-code',
    tool: pe.product || 'policy_engine',
    tags: ['policy-engine', ...(pe.bundles || []).map(b => `bundle:${b}`)],
    source: ctx.sourceOf('policy_engine'),
    refs: pe.backend ? [`telemetry.backends.${pe.backend}`] : [],
    spec: pe,
  }];
}

function adaptMesh(ctx) {
  return (ctx.spec.mesh || []).map((m, i) => ({
    id: `MESH-${pad(i + 1)}`,
    title: m.role ? `${m.role}: ${m.product}` : m.product,
    desc: `${m.product}${m.role ? ` as ${m.role}` : ''}${m.version?.declared ? ` (v${m.version.declared})` : ''}`,
    tool: m.product,
    tags: ['mesh', m.role, m.version?.gating && `gating-${m.version.gating}`].filter(Boolean),
    source: ctx.sourceOf(`mesh[${i}]`),
    refs: m.backend ? [`telemetry.backends.${m.backend}`] : [],
    spec: m,
  }));
}

function adaptCollection(ctx) {
  return (ctx.spec.collection || []).map((c, i) => ({
    id: `COL-${pad(i + 1)}`,
    title: c.role ? `${c.role}: ${c.product}` : c.product,
    desc: `${c.product}${c.role ? ` as ${c.role}` : ''}`,
    tool: c.product,
    tags: ['collection', c.role].filter(Boolean),
    source: ctx.sourceOf(`collection[${i}]`),
    refs: c.backend ? [`telemetry.backends.${c.backend}`] : [],
    spec: c,
  }));
}

function adaptQueries(ctx) {
  const q = ctx.spec.queries || {};
  const out = [];
  (q.recording_rules || []).forEach((r, i) => out.push({
    id: `QRY-${pad(i + 1)}`,
    title: r.name,
    desc: `recording rule${r.interval ? ` @ ${r.interval}` : ''}`,
    tool: 'Prometheus recording rule',
    tags: ['recording'],
    source: ctx.sourceOf(`queries.recording_rules[${i}]`),
    refs: extractRefs(r.expr),
    spec: r,
  }));
  (q.derived_views || []).forEach((v, i) => out.push({
    id: `VIEW-${pad(i + 1)}`,
    title: v.id,
    desc: v.bind ? `bound to ${v.bind}` : 'derived view',
    tool: 'derived view',
    tags: ['view', 'derived'],
    source: ctx.sourceOf(`queries.derived_views.${v.id}`),
    defines: `queries.derived_views.${v.id}`,
    refs: v.bind ? [v.bind] : [],
    spec: v,
  }));
  return out;
}

function adaptDashboards(ctx) {
  return (ctx.spec.dashboards || []).map((d, i) => ({
    id: `DASH-${pad(i + 1)}`,
    title: d.id,
    desc: [
      d.provider?.kind,
      d.provider?.version,
      d.folder && `· folder: ${d.folder}`,
    ].filter(Boolean).join(' '),
    tool: d.provider?.kind || 'dashboard',
    tags: ['dashboard', d.provider?.kind].filter(Boolean),
    source: ctx.sourceOf(`dashboards.${d.id}`),
    defines: `dashboards.${d.id}`,
    refs: (d.panel_bindings || []).map(b => b.binds_to),
    spec: d,
  }));
}

// L3 EXPAND: per-panel artefacts projected from each dashboard's panel_bindings.
// Each panel becomes an artefact with `expand: true` so renderers can choose
// to hide it behind an "Expand" toggle (default: hidden, only DASH-NN cards
// shown). This is the L3 mirror of the L2 metric inventory below.
function adaptDashboardPanels(ctx) {
  const out = [];
  let n = 0;
  for (const d of (ctx.spec.dashboards || [])) {
    const bindings = new Map();
    for (const b of (d.panel_bindings || [])) {
      bindings.set(compact(b.panel), b.binds_to);
    }
    const panels = [];
    for (const p of (d.params?.panels || [])) {
      if (!p || typeof p !== 'object') continue;
      const panel = p.panel || p.title || `panel-${panels.length + 1}`;
      panels.push({
        ...p,
        panel,
        binds_to: p.binds_to || bindings.get(compact(panel)) || null,
      });
    }
    for (const b of (d.panel_bindings || [])) {
      if (panels.some(p => compact(p.panel) === compact(b.panel))) continue;
      panels.push({ panel: b.panel, title: b.panel, binds_to: b.binds_to });
    }
    for (const b of panels) {
      n++;
      out.push({
        id: `PANEL-${pad(n)}`,
        title: b.panel || `panel-${n}`,
        desc: b.binds_to ? `binds: ${b.binds_to}` : (b.expr ? 'query panel · unbound' : '(unbound)'),
        tool: 'dashboard panel',
        tags: ['panel', d.provider?.kind].filter(Boolean),
        source: ctx.sourceOf(`dashboards.${d.id}.panels.${b.panel}`),
        refs: b.binds_to ? [b.binds_to] : [],
        expand: true,   // hidden behind L3 Expand toggle
        parent: `dashboards.${d.id}`,
        spec: b,
      });
    }
  }
  return out;
}

// L2 EXPAND: metric inventory projected from
// metadata.annotations.mcp.discovered.metric_names. When the MCP returns the
// metric inventory (via metrics_metadata / metrics_label_values or any
// compatible tool), the fetcher writes the full list into an annotation and a
// compact sample for previews; here we prefer the full list and fall back to
// the sample for older live packs.
function adaptMetricInventory(ctx) {
  const ann = ctx.canonical?.metadata?.annotations || {};
  const names = annotationList(
    ann['mcp.discovered.metric_names'],
    ann['mcp.discovered.metric_names_count'],
    ann['mcp.discovered.metric_names_sample'],
  );
  if (!names.length) return [];
  const totalCount = parseInt(ann['mcp.discovered.metric_names_count'] || String(names.length), 10);
  return names.map((name, i) => ({
    id: `METRIC-${pad(i + 1)}`,
    title: name,
    desc: 'discovered metric (live MCP)',
    tool: 'Prometheus metric',
    tags: ['metric', 'inferred'],
    source: 'Verified',
    refs: [],
    expand: true,    // hidden behind L2 Expand toggle
    parent: 'telemetry.metric_inventory',
    spec: { name, source: 'mcp.discovered' },
    mcp: { tool: 'metrics_metadata', when: ann['mcp.refreshedAt'] },
    _meta: i === 0 ? { totalCount } : undefined,
  }));
}

function adaptBurnRateAlerts(ctx) {
  return (ctx.spec.policy?.burn_rate_alerts || []).map((a, i) => {
    const severities = [...new Set((a.windows || []).map(w => w.severity))];
    return {
      id: `POL-${pad(i + 1)}`,
      title: `burn-rate alert: ${stripRefPrefix(a.slo)}`,
      desc: `${(a.windows || []).length} window(s) · severities: ${severities.join(', ')}`,
      tool: 'Prometheus alerting',
      tags: ['burn-rate', ...severities],
      source: ctx.sourceOf(`policy.burn_rate_alerts[${i}]`),
      refs: [normalizeSliRef(a.slo, 'slos')],
      spec: a,
    };
  });
}

function adaptForecasts(ctx) {
  return (ctx.spec.policy?.forecasts || []).map((f, i) => ({
    id: `FCST-${pad(i + 1)}`,
    title: `forecast: ${stripRefPrefix(f.slo)}`,
    desc: `${f.method} over ${f.horizon}${f.on_projected_breach ? ` · on breach: ${f.on_projected_breach}` : ''}`,
    tool: 'forecast',
    tags: ['forecast', f.method].filter(Boolean),
    source: ctx.sourceOf(`policy.forecasts[${i}]`),
    refs: [normalizeSliRef(f.slo, 'slos')],
    spec: f,
  }));
}

function adaptAlertingRoutes(ctx) {
  return (ctx.spec.alerting?.routes || []).map((r, i) => {
    const channelKinds = (r.channels || [])
      .map(c => Object.keys(c)[0])
      .filter(Boolean);
    return {
      id: `ALR-${pad(i + 1)}`,
      title: `${r.severity} routes`,
      desc: channelKinds.length
        ? `${channelKinds.length} channel(s): ${channelKinds.join(', ')}`
        : 'no channels',
      tool: 'Alertmanager',
      tags: ['routing', r.severity, ...channelKinds],
      source: ctx.sourceOf(`alerting.routes[${i}]`),
      spec: r,
    };
  });
}

function adaptRemediation(ctx) {
  return (ctx.spec.remediation || []).map((r, i) => ({
    id: `HEAL-${pad(i + 1)}`,
    title: r.trigger,
    desc: r.runbook ? `runbook: ${r.runbook}` : 'automated remediation',
    tool: (r.automation || '').split('://')[0] || 'automation',
    tags: [
      'healing',
      r.guardrails?.rollback_on_failure && 'rollback',
      r.guardrails?.circuit_breaker && 'circuit-breaker',
    ].filter(Boolean),
    source: ctx.sourceOf(`remediation[${i}]`),
    refs: [r.trigger],
    spec: r,
  }));
}

function adaptBaselines(ctx) {
  const b = ctx.spec.baselines;
  if (!b) return [];
  return [{
    id: 'BASE-01',
    title: 'MTTD / MTTR baselines',
    desc: `MTTD p50 ${b.mttd_target_p50} · MTTR p50 ${b.mttr_target_p50}` +
      (b.regression_gate ? ` · gate: ${b.regression_gate}` : ''),
    tool: 'baselines',
    tags: ['baseline', 'mttd', 'mttr', b.review_cadence].filter(Boolean),
    source: ctx.sourceOf('baselines'),
    spec: b,
    mcp: ctx.mcpEvidence('baselines'),
  }];
}

function adaptChaos(ctx) {
  return (ctx.spec.validation?.chaos_experiments || []).map((c, i) => ({
    id: `CHAOS-${pad(i + 1)}`,
    title: c.id,
    desc:
      `${c.engine} on ${c.target}` +
      (c.expected_mttd ? ` · expect MTTD ${c.expected_mttd}` : '') +
      (c.schedule ? ` · ${c.schedule}` : '') +
      (c.environment ? ` · ${c.environment}` : ''),
    tool: c.engine,
    tags: ['chaos', c.engine, c.schedule, c.environment].filter(Boolean),
    source: ctx.sourceOf(`validation.chaos_experiments.${c.id}`),
    refs: [
      c.steady_state_hypothesis,
      ...(c.expected_alerts || []).map(a => `alert:${a}`),
    ].filter(Boolean),
    spec: c,
  }));
}

function adaptSynthetic(ctx) {
  return (ctx.spec.validation?.synthetic_checks || []).map((s, i) => ({
    id: `SYN-${pad(i + 1)}`,
    title: s.id,
    desc:
      `${s.kind} · interval ${s.interval}` +
      (s.on_fail_severity ? ` · on fail: ${s.on_fail_severity}` : '') +
      (s.otel_instrumentation ? ' · otel-instrumented' : ''),
    tool: s.kind,
    tags: ['synthetic', s.kind, s.on_fail_severity].filter(Boolean),
    source: ctx.sourceOf(`validation.synthetic_checks.${s.id}`),
    spec: s,
  }));
}

function adaptImports(canonical) {
  return (canonical.metadata?.imports || []).map((imp, i) => ({
    id: `IMP-${pad(i + 1)}`,
    title: imp.ref,
    desc: imp.with ? 'imported with overrides' : 'vertical composition import',
    tool: 'imports',
    tags: ['governance', 'import'],
    source: 'Declared',
    spec: imp,
  }));
}

// ---------- helpers ----------

function pad(n) { return String(n).padStart(2, '0'); }

function formatPct(objective) {
  if (typeof objective !== 'number') return '?';
  return (objective * 100).toFixed(2).replace(/\.00$/, '').replace(/\.?0+$/, '') + '%';
}

function stripRefPrefix(s) {
  if (typeof s !== 'string') return s ?? '';
  return s.replace(/^(slis|slos)\./, '').replace(/^ref:/, '');
}

// Canonicalise an SLO/SLI reference to "slos.<id>" / "slis.<id>" form.
function normalizeSliRef(ref, defaultPrefix = 'slis') {
  if (typeof ref !== 'string') return '';
  if (/^slis\.|^slos\./.test(ref)) return ref;
  if (ref.startsWith('ref:')) return ref;
  return `${defaultPrefix}.${ref}`;
}

// Find `ref:...` and `slis.X` / `slos.X` occurrences in a PromQL-ish expr.
function extractRefs(expr) {
  if (typeof expr !== 'string') return [];
  const refs = [];
  const seen = new Set();
  const re = /(ref:[A-Za-z0-9_./-]+|sli[s]\.[a-z][a-z0-9_-]*|slo[s]\.[a-z][a-z0-9_-]*)/g;
  let m;
  while ((m = re.exec(expr)) !== null) {
    if (!seen.has(m[1])) { refs.push(m[1]); seen.add(m[1]); }
  }
  return refs;
}

function parseAnnotationObject(value) {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function compact(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function deepClone(x) {
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(deepClone);
  const out = {};
  for (const k of Object.keys(x)) out[k] = deepClone(x[k]);
  return out;
}

function setDottedPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}
