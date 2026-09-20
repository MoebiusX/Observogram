// ============================================================
// crawler.mjs — Path A of the pack-creation user journey.
//
// Walks a service repository and emits a draft canonical
// ObservabilityPack v1.2 manifest by introspecting common
// observability artefacts: docker-compose backends, Prometheus
// rules, Alertmanager configs, OTel Collector pipelines, Grafana
// dashboard JSONs, Helm values/templates, and Kubernetes workloads.
//
// The library is pure — it accepts an in-memory file map so the
// CLI (which reads from disk) and the server endpoint (which
// receives uploaded files) share one implementation. No fs
// imports here.
//
// Output is honest about what was discovered and what was
// inferred. Every artefact carries a metadata.annotations.crawler.*
// pointer to the source file. SLIs/SLOs/baselines that the spec
// REQUIRES but the repo doesn't reveal are stubbed with
// conservative placeholders + an annotation flagging the stub —
// the conformance panel will then surface them as missing-MUST
// for the engineer to fill in.
// ============================================================

import { parse as parseYaml, parseAll as parseYamlAll, emit as emitYaml } from './mini-yaml.mjs';
import { inferSlisFromRecordingRules, ruleNameToSliId, ruleNameToSloId } from './sli-inference.mjs';
import { materializeL2XFromBackends } from './l2x.mjs';
import { PROMQL_KEYWORDS, extractPromqlMetricNames } from './promql.mjs';
import { symbolSlug as slug } from './slug.mjs';

// Parse a (possibly multi-document) YAML file into a list of non-null
// documents. Prometheus rule files, Alertmanager configs and Kubernetes
// manifests are frequently shipped as multi-document streams (`---`).
function parseYamlDocs(content) {
  return parseYamlAll(content).filter(d => d && typeof d === 'object');
}

// Known backend image-name fragments → spec.telemetry.backends.product enum.
// Prefix match against the docker-compose service image. Order matters —
// most-specific first.
// Signal enum per schema: metrics, logs, traces, profiles, network,
// policy, mesh, gateway, collection, alerting, dashboards. No "all" —
// products that handle multiple signals (Grafana, OTel Collector,
// Alertmanager) get their primary classification.
const BACKEND_PATTERNS = [
  { match: /opentelemetry[/-]?collector|otel\/opentelemetry-collector/i, product: 'opentelemetry-collector', signal: 'collection' },
  { match: /^prom\/prometheus|prometheus:|prometheus-community/i,         product: 'prometheus',              signal: 'metrics' },
  { match: /^grafana\/loki|grafana\/loki-docker|loki:/i,                  product: 'loki',                    signal: 'logs' },
  { match: /^grafana\/tempo|tempo:/i,                                     product: 'tempo',                   signal: 'traces' },
  { match: /^grafana\/mimir|mimir:|grafana\/mimirtool/i,                  product: 'mimir',                   signal: 'metrics' },
  { match: /^grafana\/grafana|grafana:|grafana\/grafana-/i,               product: 'grafana',                 signal: 'dashboards' },
  { match: /^elastic\/|elasticsearch:|opensearch/i,                       product: 'elasticsearch',           signal: 'logs' },
  { match: /^jaegertracing\/|jaegertracing\/all-in-one|jaeger:/i,         product: 'jaeger',                  signal: 'traces' },
  { match: /^thanos\/|thanos:|quay\.io\/thanos/i,                         product: 'thanos',                  signal: 'metrics' },
  { match: /^prom\/alertmanager|alertmanager:|prometheus-community.*alertmanager/i, product: 'alertmanager',  signal: 'alerting' },
  { match: /^pyroscope|grafana\/pyroscope/i,                              product: 'pyroscope',               signal: 'profiles' },
  { match: /^cilium\/cilium|quay\.io\/cilium\/cilium|cilium:/i,             product: 'cilium',                  signal: 'network' },
  { match: /^openpolicyagent\/opa|^opa:/i,                                  product: 'opa',                     signal: 'policy' },
  { match: /^envoyproxy\/envoy|^envoy:/i,                                   product: 'envoy',                   signal: 'mesh' },
  { match: /^consul:|^hashicorp\/consul/i,                                  product: 'consul',                  signal: 'mesh' },
  { match: /^kong:|^kong\/kong/i,                                           product: 'kong',                    signal: 'gateway' },
  { match: /^traefik:|^traefik\/traefik/i,                                  product: 'traefik',                 signal: 'gateway' },
  { match: /fluent[-/]?bit|fluent-bit/i,                                  product: 'fluent-bit',              signal: 'logs' },
  { match: /^grafana\/alloy|^alloy:/i,                                      product: 'alloy',                   signal: 'collection' },
  { match: /^elastic\/beats|^beats:/i,                                      product: 'beats',                   signal: 'collection' },
  { match: /timberio\/vector|vector:/i,                                   product: 'vector',                  signal: 'collection' },
  // Additional common production stacks
  { match: /victoriametrics\/victoria-metrics|victoriametrics\/vmselect|victoriametrics\/vminsert|victoriametrics\/vmstorage|victoriametrics\/vmagent/i,
                                                                          product: 'victoriametrics',         signal: 'metrics' },
  { match: /victoriametrics\/vmalert/i,                                   product: 'vmalert',                 signal: 'alerting' },
  { match: /kube-state-metrics/i,                                          product: 'kube-state-metrics',      signal: 'metrics' },
  { match: /prom\/node-exporter|node_exporter/i,                          product: 'node-exporter',           signal: 'metrics' },
  { match: /grafana\/promtail|promtail:/i,                                product: 'promtail',                signal: 'logs' },
  { match: /grafana\/k6|loadimpact\/k6/i,                                 product: 'k6',                      signal: 'metrics' },
  { match: /^otel\/opentelemetry-collector-contrib/i,                     product: 'opentelemetry-collector', signal: 'collection' },
  { match: /opensearchproject\/opensearch|opensearch:/i,                  product: 'opensearch',              signal: 'logs' },
  { match: /datadog\/agent|datadoghq\/agent/i,                            product: 'datadog-agent',           signal: 'collection' },
];

// Kubernetes workload kinds whose pod template carries container images we
// can decompile into telemetry.backends. Helm charts ship observability
// stacks as these (Deployment-prometheus, StatefulSet-loki, DaemonSet-promtail,
// …), so reading their images back is the inverse of deploying them.
const K8S_WORKLOAD_KINDS = new Set([
  'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet',
  'ReplicationController', 'Pod', 'Job', 'CronJob',
]);

const METRIC_SOURCE_EXT_RE = /\.(?:cjs|mjs|js|jsx|ts|tsx|py|go|java|kt|rs|cs)$/i;

// Match an image reference (`repository[:tag]`) against the known backend
// catalog and register it on the backends bucket. Shared by the Helm values,
// Helm template, and plain-K8s workload walkers. When `dedupeByProduct` is set
// (Helm/K8s paths — the same backend appears across many manifests, replicas,
// and per-environment values files), an existing backend with the same
// signal+product is treated as already-discovered; the docker-compose walker
// keeps its historical per-service uniqueness and so does not pass the flag.
function registerBackendFromImage(image, relPath, backends, evidence, summary, { dedupeByProduct = false, pipelines = null } = {}) {
  const ref = String(image || '').trim();
  if (!ref) return false;
  const tag = (ref.split(':')[1] || '').trim();
  for (const p of BACKEND_PATTERNS) {
    if (!p.match.test(ref)) continue;
    const baseId = `${p.signal}-${p.product}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (dedupeByProduct && backends.some(b => b.signal === p.signal && b.product === p.product)) return false;
    let id = baseId, n = 2;
    while (backends.some(b => b.id === id)) id = `${baseId}-${n++}`;
    const backend = {
      id,
      signal: p.signal,
      product: p.product,
      endpoints: [`http://${p.product}:80`],
      auth: { kind: 'none' },
    };
    if (tag && /^v?\d/.test(tag)) backend.version = { declared: tag.replace(/^v/, ''), gating: 'off' };
    backends.push(backend);
    evidence[id] = relPath;
    summary.discovered.backends++;
    registerMetricsExporterFromBackend(p, pipelines, relPath, evidence, summary);
    return true;
  }
  return false;
}

function registerMetricsExporterFromBackend(pattern, pipelines, relPath, evidence, summary) {
  if (!pipelines || pattern?.signal !== 'metrics') return;
  if (pipelines.exporters?.metrics) return;
  pipelines.exporters.metrics = { kind: 'prometheusremotewrite' };
  evidence['pipelines.exporters.metrics'] = relPath;
  summary.discovered.pipelineExporters = (summary.discovered.pipelineExporters || 0) + 1;
}

// ============================================================
// Public API
// ============================================================

/**
 * Detect what kind of observability artefact a file is.
 * @param {string} relPath - repo-relative path
 * @param {string} content - file content
 * @returns {string} kind: 'prometheus-rules' | 'alertmanager' | 'grafana-dashboard' |
 *                          'otel-collector' | 'docker-compose' | 'helm-chart' |
 *                          'helm-template' | 'unknown'
 */
export function detectArtefactKind(relPath, content) {
  const lower = relPath.toLowerCase();
  // JSON first — Grafana dashboards are the only json we care about.
  if (lower.endsWith('.json')) {
    try {
      const obj = JSON.parse(content);
      if (obj && Array.isArray(obj.panels) && typeof obj.schemaVersion === 'number') {
        return 'grafana-dashboard';
      }
    } catch (_) { /* not json */ }
    return 'unknown';
  }

  if (METRIC_SOURCE_EXT_RE.test(lower) && looksLikeMetricSource(content, lower)) {
    return 'metric-source-code';
  }

  // YAML — could be many things; look at shape.
  if (!/\.ya?ml$/i.test(lower)) return 'unknown';

  // Helm values file — the chart's concrete image references live here
  // (`<svc>.image.repository`), even though the templates that consume them
  // are Go-templated. Detected by the Helm `values[...].yaml` convention and
  // routed to walkHelmValues, which harvests telemetry.backends. Checked
  // before the Helm-template sniff because a values file carries no
  // `{{ include }}` scaffolding and would otherwise fall through to 'unknown'.
  if (/(^|\/)values[\w.-]*\.ya?ml$/.test(lower)) return 'helm-values';

  // Helm template — Go-template scaffolding ({{ include ... }}, {{ .Values.x }})
  // breaks plain YAML parsing, so these files would otherwise be misclassified
  // or silently dropped. Route them to walkHelmTemplate, which lifts the
  // observability payloads embedded in rendered ConfigMaps (Prometheus rules,
  // dashboards, …). Checked before the filename heuristics because a templated
  // `configmap-alertmanager.yaml` is a Helm template first, an Alertmanager
  // config second.
  if (looksLikeHelm(content)) return 'helm-template';

  // Filename heuristics first — fastest.
  if (/(^|\/)(docker-)?compose\.ya?ml$/.test(lower))             return 'docker-compose';
  if (/(^|\/)chart\.ya?ml$/.test(lower))                          return 'helm-chart';
  if (/alertmanager(\.config)?\.ya?ml$/.test(lower))              return 'alertmanager';
  if (/(^|\/)(otel|otelcol|collector)[-_a-z]*\.ya?ml$/.test(lower)) return 'otel-collector';
  if (/(rules?|alerts?|recording|burn[-_ ]?rate)\.ya?ml$/.test(lower)) return 'prometheus-rules';

  // Content sniff fallback.
  let obj;
  try { obj = parseYaml(content); } catch (_) { return 'unknown'; }
  if (!obj || typeof obj !== 'object') return 'unknown';

  if (obj.groups && Array.isArray(obj.groups)
      && obj.groups.some(g => g.rules?.some(r => 'record' in r || 'alert' in r))) {
    return 'prometheus-rules';
  }
  if (Array.isArray(obj.scrape_configs)
      && obj.scrape_configs.some(s => s?.job_name)) return 'prometheus-scrape-config';
  if (looksLikeActuatorMetricsConfig(lower, content, obj)) return 'actuator-metrics-config';
  if (obj.route && obj.receivers && Array.isArray(obj.receivers)) return 'alertmanager';
  if (obj.receivers && obj.exporters && obj.service?.pipelines)   return 'otel-collector';
  if (obj.services && typeof obj.services === 'object'
      && Object.values(obj.services).some(s => s?.image))         return 'docker-compose';
  // Plain (non-templated) Kubernetes workload manifest carrying concrete
  // container images — the backends a Helm chart would otherwise template.
  if (K8S_WORKLOAD_KINDS.has(obj.kind)
      && (obj.spec?.template?.spec?.containers
          || obj.spec?.containers
          || obj.spec?.jobTemplate?.spec?.template?.spec?.containers)) {
    return 'k8s-workload';
  }
  return 'unknown';
}

function normalizeRepoPath(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function basenameOf(relPath) {
  const parts = normalizeRepoPath(relPath).split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function hasPathSegment(relPath, segment) {
  return normalizeRepoPath(relPath).split('/').includes(segment);
}

function isEksSpecificPath(relPath) {
  const p = normalizeRepoPath(relPath);
  const base = basenameOf(p);
  return /values-?eks/.test(base) || hasPathSegment(p, 'eks');
}

function isLocalK8sSpecificPath(relPath) {
  const p = normalizeRepoPath(relPath);
  const base = basenameOf(p);
  return /values-?(local|kind|minikube)/.test(base)
      || /^local[-_.]/.test(base)
      || hasPathSegment(p, 'local-k8s')
      || hasPathSegment(p, 'kind')
      || hasPathSegment(p, 'minikube');
}

function normalizeEnvironmentProfile(environment) {
  const raw = String(environment || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!raw) return null;
  if (/^(local-docker|docker|compose|local-dev|dev|development|local)$/.test(raw)) return 'local-docker';
  if (/^(local-k8s|k8s-local|local-cluster|kind|minikube|kubernetes-local)$/.test(raw)) return 'local-k8s';
  if (/^(eks|aws-eks)$/.test(raw)) return 'eks';
  if (/^(prod|production|prd|k8s|kubernetes|helm)$/.test(raw)) return 'prod';
  return null;
}

function normalizeDiffScopeMode(value) {
  const raw = String(value || 'service').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (raw === 'family' || raw === 'legacy' || raw === 'off') return 'family';
  if (raw === 'all' || raw === 'none' || raw === 'strict') return 'all';
  return 'service';
}

function detectDeploymentSurfaces(files) {
  const out = {
    docker: false,
    k8s: false,
    eksSpecific: false,
    localK8sSpecific: false,
  };
  for (const relPath of files.keys()) {
    const p = normalizeRepoPath(relPath);
    const base = basenameOf(p);
    if (/(^|\/)(docker-)?compose\.ya?ml$/.test(p) || /(^|\/)compose\.ya?ml$/.test(p)) {
      out.docker = true;
    }
    if (hasPathSegment(p, 'k8s') || hasPathSegment(p, 'helm') || hasPathSegment(p, 'charts') || base === 'chart.yaml') {
      out.k8s = true;
    }
    if (isEksSpecificPath(p)) {
      out.eksSpecific = true;
      out.k8s = true;
    }
    if (isLocalK8sSpecificPath(p)) {
      out.localK8sSpecific = true;
      out.k8s = true;
    }
  }
  return out;
}

function isRootDockerConfig(relPath) {
  const p = normalizeRepoPath(relPath);
  const base = basenameOf(p);
  if (/(^|\/)(docker-)?compose\.ya?ml$/.test(p) || /(^|\/)compose\.ya?ml$/.test(p)) return true;
  if (hasPathSegment(p, 'k8s') || hasPathSegment(p, 'helm') || hasPathSegment(p, 'charts')) return false;
  if (hasPathSegment(p, 'config')) return true;
  return /^(prometheus|alertmanager|otel|otelcol|collector|loki|promtail)[\w.-]*\.ya?ml$/.test(base);
}

function isK8sPath(relPath) {
  const p = normalizeRepoPath(relPath);
  const base = basenameOf(p);
  return hasPathSegment(p, 'k8s')
      || hasPathSegment(p, 'helm')
      || hasPathSegment(p, 'charts')
      || base === 'chart.yaml'
      || /^values[\w.-]*\.ya?ml$/.test(base);
}

function isSourceCodePath(relPath) {
  return METRIC_SOURCE_EXT_RE.test(relPath);
}

function shouldIncludeForEnvironment(relPath, profile, surfaces) {
  const p = normalizeRepoPath(relPath);
  if (isSourceCodePath(p)) return true;

  if (profile === 'local-docker') {
    if (!surfaces.docker) return true;
    return isRootDockerConfig(p);
  }

  if (profile === 'local-k8s') {
    if (!surfaces.k8s) return true;
    if (isRootDockerConfig(p) && surfaces.docker) return false;
    if (isEksSpecificPath(p)) return false;
    return isK8sPath(p);
  }

  if (profile === 'prod') {
    if (!surfaces.k8s) return true;
    if (isRootDockerConfig(p) && surfaces.docker) return false;
    if (isLocalK8sSpecificPath(p)) return false;
    if (isEksSpecificPath(p)) return false;
    return isK8sPath(p);
  }

  if (profile === 'eks') {
    if (!surfaces.k8s) return true;
    if (isRootDockerConfig(p) && surfaces.docker) return false;
    if (isLocalK8sSpecificPath(p)) return false;
    return isK8sPath(p);
  }

  return true;
}

function scopeFilesForEnvironment(files, environment) {
  const profile = normalizeEnvironmentProfile(environment);
  const surfaces = detectDeploymentSurfaces(files);
  const result = {
    files,
    profile,
    surfaces,
    applied: false,
    excluded: [],
  };
  if (!profile) return result;

  const scoped = new Map();
  for (const [relPath, content] of files) {
    if (shouldIncludeForEnvironment(relPath, profile, surfaces)) {
      scoped.set(relPath, content);
    } else {
      result.excluded.push(relPath);
    }
  }

  if (scoped.size === 0 || scoped.size === files.size) return result;
  result.files = scoped;
  result.applied = true;
  return result;
}

/**
 * Crawl a map of files and emit a draft canonical pack.
 * @param {Map<string,string>|Record<string,string>} filesInput
 * @param {object} [opts]
 * @param {string} [opts.repoName='crawled-service']  - metadata.name
 * @param {string} [opts.environment='prod']
 * @param {string} [opts.diffScopeMode='service']      - service | family | all.
 * @param {string} [opts.criticality]                  - 'tier-1'|'tier-2'|'tier-3'. Inferred if omitted.
 * @param {string} [opts.binding='otel-elastic-prometheus-grafana']
 * @param {Array<string>} [opts.owners=['team-platform']]
 * @returns {{canonical: object, summary: object, evidence: Record<string,string>}}
 */
export function crawlFiles(filesInput, opts = {}) {
  const rawFiles = filesInput instanceof Map
    ? filesInput
    : new Map(Object.entries(filesInput));
  const repoName = opts.repoName || 'crawled-service';
  const environment = opts.environment || 'prod';
  const binding = opts.binding || 'otel-elastic-prometheus-grafana';
  const owners = opts.owners || ['team-platform'];
  const diffScopeMode = normalizeDiffScopeMode(opts.diffScopeMode || opts.diffScope || opts.liveScope);
  const envScope = scopeFilesForEnvironment(rawFiles, environment);
  const files = envScope.files;

  // ----- per-kind buckets -----
  const summary = {
    files: {
      scanned: rawFiles.size,
      included: files.size,
      excludedByEnvironment: envScope.excluded.length,
      classified: 0,
      byKind: {},
    },
    environment: {
      requested: environment,
      profile: envScope.profile,
      scoped: envScope.applied,
      surfaces: envScope.surfaces,
      excluded: envScope.excluded.slice(0, 40),
    },
    comparison: {
      diffScopeMode,
    },
    discovered: {
      backends: 0, recordingRules: 0, burnRateAlerts: 0,
      metricDefinitions: 0, scrapeJobs: 0,
      pipelines: 0, dashboards: 0, alertingRoutes: 0,
      extendedSurfaces: 0,
    },
    inferred: { slis: 0, slos: 0, baselines: false, tier: null },
    warnings: [],
    omitted: { syntheticRecordingRules: [], unresolvedChannels: [] },
    scaffold: [],
  };
  if (envScope.applied) {
    summary.warnings.push(`Environment scope "${envScope.profile}" excluded ${envScope.excluded.length} file(s) from other deployment surfaces.`);
  }
  const evidence = {};   // <artefact-id> -> <relPath>

  const backends = [];
  const recordingRules = [];
  const burnRateAlerts = [];
  const metricDefinitions = [];
  const scrapeJobs = [];
  const dashboards = [];
  const alertingRoutes = [];
  const pipelines = { receivers: [], processors: [], exporters: { metrics: null, logs: null, traces: null } };
  const scaffoldSymbols = [];

  // ----- pass 1: classify -----
  const classified = [];
  for (const [relPath, content] of files) {
    const kind = detectArtefactKind(relPath, content);
    if (kind === 'unknown') continue;
    classified.push({ relPath, content, kind });
    summary.files.classified++;
    summary.files.byKind[kind] = (summary.files.byKind[kind] || 0) + 1;
  }

  // Honor Helm `enabled: false`: a component the selected environment disables
  // must not be declared as a live backend. The toggle often lives in an env
  // overlay (values-eks) while the image lives in base values.yaml, so merge
  // `enabled` across the in-scope values files (overlays win) before walking.
  const disabledComponents = collectDisabledComponents(
    classified.filter((f) => f.kind === 'helm-values'),
  );
  if (disabledComponents.size) {
    summary.discovered.disabledComponents = [...disabledComponents];
  }

  // ----- pass 2: walk per kind -----
  for (const f of classified) {
    try {
      switch (f.kind) {
        case 'docker-compose':   walkDockerCompose(f, backends, pipelines, evidence, summary); break;
        case 'prometheus-rules': walkPrometheusRules(f, recordingRules, burnRateAlerts, metricDefinitions, evidence, summary); break;
        case 'prometheus-scrape-config': walkPrometheusScrapeConfig(f, scrapeJobs, evidence, summary); break;
        case 'actuator-metrics-config': walkActuatorMetricsConfig(f, scrapeJobs, evidence, summary, repoName); break;
        case 'metric-source-code': walkMetricSourceCode(f, metricDefinitions, evidence, summary, repoName); break;
        case 'alertmanager':     walkAlertmanager(f, alertingRoutes, evidence, summary); break;
        case 'otel-collector':   walkOtelCollector(f, pipelines, evidence, summary); break;
        case 'grafana-dashboard':walkGrafanaDashboard(f, dashboards, metricDefinitions, evidence, summary); break;
        case 'helm-template':    walkHelmTemplate(f, { backends, recordingRules, burnRateAlerts, metricDefinitions, scrapeJobs, alertingRoutes, dashboards, pipelines, repoName }, evidence, summary); break;
        case 'helm-values':      walkHelmValues(f, backends, pipelines, evidence, summary, disabledComponents); break;
        case 'k8s-workload':     walkK8sWorkload(f, backends, pipelines, evidence, summary); break;
        // Chart.yaml itself carries no observability contracts — the payloads
        // live in the templated manifests (handled as 'helm-template'). We
        // record the chart only as a signal that this is a Helm-packaged repo.
        case 'helm-chart':       summary.discovered.helmCharts = (summary.discovered.helmCharts || 0) + 1; break;
      }
    } catch (e) {
      summary.warnings.push(`Failed to parse ${f.relPath}: ${e.message}`);
    }
  }

  // ----- infer SLIs/SLOs (decompiler ⇄ compiler symmetry) -----
  // PRIMARY source: recording rules. compile.mjs materialises every SLI in
  // spec.slis as `<svc>:<sli>:<op>` recording rules, so reading those names
  // back is the exact inverse — and it is the SAME derivation the live
  // system reconstruction uses (tools/fetch-live-pack.mjs). A pack that is
  // compiled, deployed, then crawled (or drafted from its live MCP) now
  // describes its L1 contracts in one shared vocabulary, so diff.mjs can
  // actually match them instead of reporting false drift.
  const sliMap = new Map();
  const sloMap = new Map();
  for (const { sli, slo } of inferSlisFromRecordingRules(recordingRules)) {
    if (!sliMap.has(sli.id)) { sliMap.set(sli.id, sli); summary.inferred.slis++; }
    if (!sloMap.has(slo.id)) { sloMap.set(slo.id, slo); summary.inferred.slos++; }
  }

  // Burn-rate alerts target an SLO. The compiler only ever emits alerts
  // FROM an SLO, so the faithful inverse treats recording rules as the
  // authoritative L1 source and reverses an alert into a contract only when
  // it is genuinely an SLO burn-rate alert:
  //   1. it references a recorded ratio series we already turned into an
  //      SLO (the exact inverse of compile.mjs) — link it; or
  //   2. no recording-rule SLIs were discovered at all (a tier-3 repo) — in
  //      that case fall back to the legacy alert-name synthesis so the pack
  //      still has at least one contract.
  // Operational alerts (CPU, disk, pod, queue-down, …) in a repo that DOES
  // define recorded SLIs are NOT SLOs; they're dropped from the burn-rate
  // policy rather than manufacturing junk L1 contracts that can never match
  // the live system.
  const haveRecordedSlis = sliMap.size > 0;
  for (const alert of burnRateAlerts) {
    const linked = linkAlertToRecordedSlo(alert, sloMap);
    if (linked) { alert.slo = linked; continue; }

    if (haveRecordedSlis) { alert._drop = true; continue; }

    const sloId = alert.slo;
    if (!sloMap.has(sloId)) {
      const sliId = sloId.replace(/_99|_999|_995|_slo$/i, '') || sloId;
      sloMap.set(sloId, {
        id: sloId,
        sli: sliId,
        objective: 0.99,
        window: '30d',
        error_budget_policy: 'ref:platform/default-budget',
      });
      summary.inferred.slos++;
      if (!sliMap.has(sliId)) {
        sliMap.set(sliId, {
          id: sliId,
          type: 'ratio',
          description: `Auto-derived from burn-rate alert "${sloId}" — REPLACE WITH REAL QUERY.`,
          good:  `sum(rate(http_requests_total{status_code!~"5..",service="${repoName}"}[5m]))`,
          total: `sum(rate(http_requests_total{service="${repoName}"}[5m]))`,
        });
        summary.inferred.slis++;
      }
    }
  }

  // Drop operational (non-SLO) alerts, then fold the remaining burn-rate
  // alerts that now share a recording-rule SLO into one entry per SLO,
  // unioning their windows so the emitted policy stays valid.
  const droppedOps = burnRateAlerts.filter(a => a._drop).length;
  if (droppedOps) {
    summary.warnings.push(`Excluded ${droppedOps} operational alert(s) from burn-rate policy — not SLO burn-rate alerts (no recorded-ratio reference). They remain available as alerting signals.`);
  }
  for (let i = burnRateAlerts.length - 1; i >= 0; i--) {
    if (burnRateAlerts[i]._drop) burnRateAlerts.splice(i, 1);
  }
  dedupeBurnRateAlerts(burnRateAlerts);


  // If still no SLI/SLO discovered, fill the minimum tier-3 stub so the
  // result validates.
  if (sliMap.size === 0) {
    sliMap.set('service_availability', {
      id: 'service_availability',
      type: 'ratio',
      description: 'Stub SLI — no SLO references found in repo. REPLACE WITH REAL QUERY.',
      good:  `sum(rate(http_requests_total{status_code!~"5..",service="${repoName}"}[5m]))`,
      total: `sum(rate(http_requests_total{service="${repoName}"}[5m]))`,
    });
    sloMap.set('service_availability_99', {
      id: 'service_availability_99',
      sli: 'service_availability',
      objective: 0.99,
      window: '30d',
      error_budget_policy: 'ref:platform/default-budget',
    });
    summary.inferred.slis = 1;
    summary.inferred.slos = 1;
    summary.warnings.push('No burn-rate alerts found — emitted stub SLI/SLO that must be replaced.');
  }

  // ----- minimum policy: every SLO needs ≥1 burn-rate alert with ≥2 windows -----
  // If the repo had no rules at all we synthesize a Google-SRE-style
  // two-window alert per stubbed SLO so the result satisfies the spec's
  // minItems: 2 constraint on windows.
  if (burnRateAlerts.length === 0) {
    for (const slo of sloMap.values()) {
      burnRateAlerts.push({
        slo: slo.id,
        windows: [
          { short: '5m',  long: '1h', factor: 14, severity: 'SEV1' },
          { short: '30m', long: '6h', factor: 6,  severity: 'SEV2' },
        ],
      });
    }
    summary.warnings.push('Synthesized two-window burn-rate alerts for stub SLOs (Google SRE pattern).');
  } else {
    // Repo HAD recording-rule-style alerts. Translate them to the spec's
    // burn-rate shape with conservative defaults.
    for (const a of burnRateAlerts) {
      if (!a.windows || a.windows.length < 2) {
        a.windows = [
          { short: '5m',  long: '1h', factor: 14, severity: 'SEV1' },
          { short: '30m', long: '6h', factor: 6,  severity: 'SEV2' },
        ];
      }
    }
  }

  // ----- minimum pipelines -----
  if (pipelines.receivers.length === 0) {
    pipelines.receivers = [{ name: 'otlp' }];
    scaffoldSymbols.push('pipelines.receivers[0]');
  }
  if (pipelines.processors.length === 0) {
    pipelines.processors = [{ name: 'batch' }];
    scaffoldSymbols.push('pipelines.processors[0]');
  }
  if (!pipelines.exporters.metrics) {
    pipelines.exporters.metrics = { kind: 'prometheusremotewrite' };
    scaffoldSymbols.push('pipelines.exporters.metrics');
  }
  if (!pipelines.exporters.logs) {
    pipelines.exporters.logs = { kind: 'elasticsearch' };
    scaffoldSymbols.push('pipelines.exporters.logs');
  }
  if (!pipelines.exporters.traces) {
    pipelines.exporters.traces = { kind: 'jaeger' };
    scaffoldSymbols.push('pipelines.exporters.traces');
  }

  // ----- minimum alerting routes -----
  if (alertingRoutes.length === 0) {
    alertingRoutes.push({ severity: 'SEV1', channels: [{ msteams: `#${repoName}-oncall` }] });
    scaffoldSymbols.push('alerting.routes[0]');
    summary.warnings.push('No Alertmanager routes found — emitted stub SEV1 → MS Teams route.');
  }

  // ----- minimum dashboards -----
  if (dashboards.length === 0) {
    dashboards.push({
      id: `${repoName}-overview`,
      provider: { kind: 'grafana' },
      folder: repoName,
      source: `file://dashboards/${repoName}-overview.json`,
    });
    scaffoldSymbols.push(`dashboards.${repoName}-overview`);
    summary.warnings.push('No Grafana dashboards found — emitted stub service-overview pointer.');
  }

  // ----- baselines (always stubbed; nothing in repos infers MTTD/MTTR) -----
  const baselines = {
    mttd_target_p50: '15m',
    mttr_target_p50: '1d',
    review_cadence: 'monthly',
  };
  scaffoldSymbols.push('baselines');
  summary.inferred.baselines = true;

  // ----- source-backed deployability guard -----
  // Older crawler builds emitted one synthetic recording rule per SLO to
  // satisfy the conformance rubric. Those rows were useful hints, but they
  // had no source provenance in the repo and were indistinguishable from
  // deployable rules in the Remediate flow. Keep the candidate names in the
  // crawl summary, but do not place them in spec.queries.recording_rules.
  const repoNs = String(repoName).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'svc';
  for (const slo of sloMap.values()) {
    const sliName = (slo.sli || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'sli';
    const ruleName = `${repoNs}:${sliName}:ratio_5m`;
    if (!recordingRules.some(r => r.name === ruleName)) {
      summary.omitted.syntheticRecordingRules.push({ name: ruleName, expr: `ref:slis.${slo.sli}` });
    }
  }
  if (summary.omitted.syntheticRecordingRules.length) {
    summary.warnings.push(`Skipped ${summary.omitted.syntheticRecordingRules.length} synthetic recording rule candidate(s) with no source provenance. Add source Prometheus/Grafana rules or compile them explicitly before deploying.`);
  }
  if (summary.omitted.unresolvedChannels.length) {
    const n = summary.omitted.unresolvedChannels.length;
    summary.warnings.push(`Excluded ${n} alerting channel(s) whose value is an unresolved \${VAR} placeholder (deploy-time substitution). They are recorded as evidence in crawler.unresolved.* annotations, not declared as routes — resolve the variable or declare a literal URL to include them.`);
  }

  inferDashboardPanelBindings(dashboards, sliMap, sloMap, recordingRules, summary);

  // ----- tier inference -----
  //   tier-1 = rich (rules + dashboards + alertmanager + chaos)
  //   tier-2 = rules + dashboards + alertmanager
  //   tier-3 = everything else
  const realRules     = summary.discovered.recordingRules > 0 || summary.discovered.burnRateAlerts > 0;
  const realDashboards = summary.discovered.dashboards > 0;
  const realAlerting  = summary.discovered.alertingRoutes > 0;
  let tier = 'tier-3';
  if (realRules && realDashboards && realAlerting) tier = 'tier-2';
  summary.inferred.tier = tier;
  const criticality = opts.criticality || tier;
  const l2x = materializeL2XFromBackends(backends);
  summary.discovered.extendedSurfaces = l2x.evidence.length;
  const syntheticCheckId = `${repoName}-health-canary`;
  scaffoldSymbols.push(`validation.synthetic_checks.${syntheticCheckId}`);
  summary.scaffold = [...scaffoldSymbols];

  const scaffoldAnnotations = {};
  for (const symbol of scaffoldSymbols) {
    scaffoldAnnotations[`crawler.scaffold.${symbol}`] = 'schema-required fallback; no source evidence found in selected environment';
  }
  curateMetricDefinitions(metricDefinitions, summary);
  const metricAnnotations = buildMetricDefinitionAnnotations(metricDefinitions);
  const scrapeAnnotations = buildScrapeJobAnnotations(scrapeJobs);

  // ----- canonical assembly -----
  const canonical = {
    apiVersion: 'observability.platform/v1',
    kind: 'ObservabilityPack',
    metadata: {
      name: repoName,
      version: '0.1.0-crawled',
      binding,
      owners,
      bindings: { service: repoName, environments: [environment], criticality },
      labels: { source: 'crawler' },
      // Annotations are Record<string,string> per spec; we flatten the
      // crawler context into namespaced keys instead of nesting an
      // object — keeps the manifest valid.
      annotations: {
        'crawler.discoveredAt':    opts.now || new Date().toISOString(),
        'crawler.filesScanned':    String(summary.files.scanned),
        'crawler.filesIncluded':   String(summary.files.included),
        'crawler.filesExcludedByEnvironment': String(summary.files.excludedByEnvironment),
        'crawler.filesClassified': String(summary.files.classified),
        'crawler.environmentProfile': envScope.profile || '',
        'observogram.diff.scopeMode': diffScopeMode,
        'crawler.tierInferred':    tier,
        'crawler.warningCount':    String(summary.warnings.length),
        'crawler.syntheticRecordingRulesSkipped': String(summary.omitted.syntheticRecordingRules.length),
        'crawler.extendedSurfaces': String(summary.discovered.extendedSurfaces),
        'crawler.scaffoldCount':   String(scaffoldSymbols.length),
        // Channels excluded for unresolved ${VAR} placeholders — evidence
        // of declared intent the crawler could not resolve at crawl time.
        ...(summary.omitted.unresolvedChannels.length ? {
          'crawler.unresolvedChannelCount': String(summary.omitted.unresolvedChannels.length),
          'crawler.unresolved.alerting': summary.omitted.unresolvedChannels
            .map(u => `${u.severity || '?'}:${u.value}${u.source ? ` (${u.source})` : ''}`).join(' · '),
        } : {}),
        ...metricAnnotations,
        ...scrapeAnnotations,
        ...scaffoldAnnotations,
      },
    },
    spec: {
      otel: {
        semconv: '1.26.0',
        resource_attributes: { required: ['service.name'] },
        sdk: {
          languages: ['go'],
          sampling: { policy: 'parentbased_traceidratio', ratio: 0.1 },
          propagators: ['tracecontext'],
        },
      },
      slis: [...sliMap.values()],
      slos: [...sloMap.values()],
      pipelines,
      queries: { recording_rules: recordingRules },
      dashboards,
      policy: { burn_rate_alerts: burnRateAlerts.map(({ slo, windows }) => ({ slo, windows })) },
      alerting: { routes: alertingRoutes },
      baselines,
      validation: {
        synthetic_checks: [{
          id: syntheticCheckId,
          kind: 'blackbox-exporter',
          target: `https://${repoName}.example.com/health`,
          interval: '1m',
          on_fail_severity: 'SEV3',
        }],
      },
    },
  };

  if (backends.length) {
    canonical.spec.telemetry = { backends };
  }
  Object.assign(canonical.spec, l2x.sections);
  for (const item of l2x.evidence) {
    evidence[item.artifactId] = evidence[item.backendId] || item.backendId;
  }

  // Evidence map lives in summary, not in metadata.annotations
  // (annotations are Record<string,string>; the evidence is structured).
  // Callers that want it surface it themselves.
  return { canonical, summary, evidence };
}

/** Convenience — emit the canonical pack as YAML. */
export function crawlToYaml(filesInput, opts) {
  const { canonical, summary, evidence } = crawlFiles(filesInput, opts);
  const banner = [
    `# =============================================================================`,
    `# ObservabilityPack: ${canonical.metadata.name}  (drafted by the crawler)`,
    `# Discovered at ${canonical.metadata.annotations['crawler.discoveredAt']}`,
    `# Files scanned: ${summary.files.scanned}, classified: ${summary.files.classified}`,
    `# Tier inferred: ${summary.inferred.tier}`,
    `# Warnings: ${summary.warnings.length}${summary.warnings.length ? ' (see metadata.annotations + the summary report)' : ''}`,
    `# -----------------------------------------------------------------------------`,
    `# This is a DRAFT. Review every section before deploying. Annotations marked`,
    `# "REPLACE WITH REAL QUERY" need a real PromQL expression that matches your`,
    `# service. The tier was inferred from what was found in the repo — if your`,
    `# service is tier-1, set metadata.bindings.criticality: tier-1 and fill the`,
    `# missing chaos_experiments + per-SLO multi-window alerts.`,
    `# =============================================================================`,
    '',
  ].join('\n');
  return { yaml: banner + emitYaml(canonical), canonical, summary, evidence };
}

// ============================================================
// Helm chart introspection
// ============================================================

// Does this file carry Go/Helm template scaffolding? We deliberately key off
// the unambiguous Helm signals \u2014 the `include`/`template`/`tpl`/`define`/`block`
// functions and the built-in `.Values` / `.Release` / `.Chart` / `.Capabilities`
// / `.Files` objects. This is intentionally narrower than "contains `{{`": bare
// `{{ $labels.x }}` / `{{ $value }}` / `{{ range .Alerts }}` appear in ordinary
// Prometheus and Alertmanager annotation templating and must NOT be mistaken
// for Helm.
function looksLikeHelm(content) {
  return /\{\{-?\s*(include|template|tpl|define|block)\b/.test(content)
      || /\{\{[^{}]*\.(Values|Release|Chart|Capabilities|Files)\b/.test(content);
}

// Best-effort neutralisation of Go/Helm template syntax so the underlying YAML
// structure can be parsed. Pure control-flow / definition lines ({{- if }},
// {{- end }}, {{- range }}, comments, \u2026) are dropped; inline value injections
// ({{ .Values.x }}, {{ include "\u2026" . }}) collapse to a stable placeholder
// token. We are not rendering the chart \u2014 only recovering enough shape to read
// the embedded observability contracts back out.
function stripGoTemplate(content) {
  return content.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (/^\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}$/.test(t)) return null;            // comment
    if (/^\{\{-?\s*(if|else|end|range|with|define|block)\b.*?-?\}\}$/.test(t)) return null; // control flow
    return line
      .replace(/\{\{-?\s*"\{\{"\s*-?\}\}/g, '{')   // Helm literal-open escape: {{ "{{" }} -> {
      .replace(/\{\{-?\s*"\}\}"\s*-?\}\}/g, '}')   // Helm literal-close escape: {{ "}}" }} -> }
      .replace(/\{\{-?[\s\S]*?-?\}\}/g, 'helmvalue'); // inline value injection
  }).filter((l) => l !== null).join('\n');
}

// Lift the embedded file payloads out of a Kubernetes ConfigMap's `data:` map.
// Each `  <name>.<ext>: |` literal-block scalar (Prometheus rules, scrape
// configs, dashboards, \u2026) is captured verbatim and de-indented. The scan is
// purely indentation-driven, so the surrounding Helm/Go-template directives in
// the unrendered manifest don't get in the way.
function extractConfigMapData(content) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  let dataIndent = -1;      // indentation of the active `data:` key, or -1
  let current = null;       // { key, indent, body: [] }

  const flush = () => {
    if (current && current.body.some((l) => l.trim())) {
      const widths = current.body.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length);
      const base = widths.length ? Math.min(...widths) : 0;
      blocks.push({ key: current.key, body: current.body.map((l) => l.slice(base)).join('\n') });
    }
    current = null;
  };

  for (const line of lines) {
    const indent = line.match(/^ */)[0].length;
    const trimmed = line.trim();

    if (current) {
      // Literal-block body continues while indentation stays deeper than the
      // key (blank lines belong to the block too).
      if (trimmed === '' || indent > current.indent) { current.body.push(line); continue; }
      flush(); // fall through to re-classify the dedented line below
    }

    const dataM = /^(\s*)data:\s*$/.exec(line);
    if (dataM) { dataIndent = dataM[1].length; continue; }

    if (dataIndent >= 0) {
      if (trimmed !== '' && indent <= dataIndent) {
        dataIndent = -1;   // left the data block
      } else {
        const keyM = /^(\s*)([\w][\w.-]*):\s*\|[-+0-9]*\s*$/.exec(line);
        if (keyM && keyM[1].length > dataIndent) {
          current = { key: keyM[2], indent: keyM[1].length, body: [] };
          continue;
        }
      }
    }
  }
  flush();
  return blocks;
}

// Content-only artefact sniff (no filename heuristics). Used for the Helm
// whole-document fallback, where template names like `deployment-alertmanager.yaml`
// would otherwise mislead the filename-based detector into parsing a Deployment
// as an Alertmanager config. We only route a templated document when its *shape*
// genuinely matches an observability artefact.
function sniffObservabilityKind(content) {
  let obj;
  try { obj = parseYaml(content); } catch (_) { return 'unknown'; }
  if (!obj || typeof obj !== 'object') return 'unknown';
  if (Array.isArray(obj.groups) && obj.groups.some(g => g.rules?.some(r => 'record' in r || 'alert' in r))) return 'prometheus-rules';
  if (Array.isArray(obj.scrape_configs) && obj.scrape_configs.some(s => s?.job_name)) return 'prometheus-scrape-config';
  if (looksLikeActuatorMetricsConfig('', content, obj)) return 'actuator-metrics-config';
  if (obj.route && Array.isArray(obj.receivers)) return 'alertmanager';
  if (obj.receivers && obj.exporters && obj.service?.pipelines) return 'otel-collector';
  if (obj.services && typeof obj.services === 'object'
      && Object.values(obj.services).some(s => s?.image)) return 'docker-compose';
  if (K8S_WORKLOAD_KINDS.has(obj.kind)
      && (obj.spec?.template?.spec?.containers
          || obj.spec?.containers
          || obj.spec?.jobTemplate?.spec?.template?.spec?.containers)) {
    return 'k8s-workload';
  }
  return 'unknown';
}

function imageFromHelmImageObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const repository = obj.repository || obj.repo || obj.name;
  if (typeof repository !== 'string') return null;
  const tag = typeof obj.tag === 'string' || typeof obj.tag === 'number' ? String(obj.tag) : '';
  return tag ? `${repository}:${tag}` : repository;
}

function looksLikeActuatorMetricsConfig(relPath, content, obj = null) {
  const p = normalizeRepoPath(relPath);
  const text = String(content || '');
  const fileLooksRelevant = /(^|\/)(application|bootstrap)[\w.-]*\.ya?ml$/.test(p)
    || /application[\w.-]*\.ya?ml[#/]/.test(p)
    || p === '';
  if (!fileLooksRelevant && !/\/actuator\/prometheus/.test(text)) return false;
  if (/\/actuator\/prometheus/.test(text)) return true;
  if (!/management:/i.test(text) || !/prometheus/i.test(text)) return false;
  const management = obj?.management;
  if (management && typeof management === 'object') {
    const endpoints = management.endpoints?.web?.exposure?.include;
    const endpointProm = management.endpoint?.prometheus?.enabled;
    const exportProm = management.metrics?.export?.prometheus?.enabled;
    if (String(endpoints || '').includes('prometheus')) return true;
    if (endpointProm === true || exportProm === true) return true;
  }
  return /endpoint[s]?:[\s\S]*prometheus/i.test(text)
      || /metrics:[\s\S]*prometheus/i.test(text);
}

function actuatorServiceName(obj, relPath, fallback) {
  const springName = obj?.spring?.application?.name;
  if (typeof springName === 'string' && springName.trim()) return springName.trim();
  return serviceFromPath(relPath, fallback);
}

function actuatorPrometheusPath(obj) {
  const base = obj?.management?.endpoints?.web?.basePath
    || obj?.management?.endpoints?.web?.['base-path']
    || '/actuator';
  const mapped = obj?.management?.endpoints?.web?.pathMapping?.prometheus
    || obj?.management?.endpoints?.web?.['path-mapping']?.prometheus
    || 'prometheus';
  return `/${String(base || '/actuator').replace(/^\/+|\/+$/g, '')}/${String(mapped || 'prometheus').replace(/^\/+|\/+$/g, '')}`;
}

function looksLikeMetricSource(content, relPath = '') {
  const p = normalizeRepoPath(relPath);
  return /prom-client|prometheus_client|(?:prometheus|promauto(?:\.With\s*\([^)]*\))?)\.New(?:Counter|Gauge|Histogram|Summary)/.test(content)
      || /@opentelemetry\/api|metrics\.getMeter|\.(?:create(?:Counter|Histogram|Gauge|ObservableCounter|ObservableGauge|ObservableUpDownCounter|UpDownCounter))\s*\(/.test(content)
      || /\.(?:Int64|Float64)(?:Counter|Histogram|Gauge|UpDownCounter|ObservableCounter|ObservableGauge|ObservableUpDownCounter)\s*\(\s*['"]/.test(content)
      || /new\s+(?:[A-Za-z_$][\w$]*\.)?(?:Counter|Gauge|Histogram|Summary)\s*\(\s*(?:\{|['"])/.test(content)
      || /\b(?:Counter|Gauge|Histogram|Summary)\s*\(\s*['"][A-Za-z_:][A-Za-z0-9_:]*['"]/.test(content)
      || /io\.micrometer|MeterRegistry|(?:Counter|Gauge|Timer|DistributionSummary|LongTaskTimer)\.builder\s*\(/.test(content)
      || /METRIC_NAME|String\.format\s*\(\s*["'][^"']*%s_|(?:^|[.\s])(?:name|put)\s*\(\s*["'][A-Za-z_:][A-Za-z0-9_:.-]*["']/.test(content)
      || (metricSourcePathLooksRelevant(p) && /(?:metric|prometheus|counter|histogram|gauge|summary)[\s\S]{0,120}['"][A-Za-z_:][A-Za-z0-9_:.-]+['"]/i.test(content));
}

function metricSourcePathLooksRelevant(relPath) {
  return /(^|\/)(metrics?|prometheus|observability|telemetry|exporter|collector|otel)(\/|[-_.])/.test(normalizeRepoPath(relPath));
}

function metricNameish(name) {
  return typeof name === 'string' && /^[A-Za-z_:][A-Za-z0-9_:]*$/.test(name);
}

function normalizePrometheusMetricName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const normalized = raw
    .replace(/[^A-Za-z0-9_:]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!normalized) return '';
  return /^[A-Za-z_:]/.test(normalized) ? normalized : `_${normalized}`;
}

function serviceFromPath(relPath, fallback = null) {
  const parts = normalizeRepoPath(relPath).split('/').filter(Boolean);
  if (!parts.length) return fallback;
  if (parts[0] === 'server') return 'krystalinex-server';
  if (['src', 'app', 'lib'].includes(parts[0])) return fallback;
  return parts[0];
}

function walkMetricSourceCode(f, metricDefinitions, evidence, summary, repoName = null) {
  const service = serviceFromPath(f.relPath, repoName);
  const text = String(f.content || '');

  const jsMetricRe = /new\s+(?:[A-Za-z_$][\w$]*\.)?(Counter|Gauge|Histogram|Summary)\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  let match;
  while ((match = jsMetricRe.exec(text)) !== null) {
    const body = match[2] || '';
    const name = firstStringProp(body, 'name');
    if (!name) continue;
    addMetricDefinition(metricDefinitions, evidence, summary, {
      name,
      type: match[1].toLowerCase(),
      help: firstStringProp(body, 'help'),
      labels: stringArrayProp(body, 'labelNames'),
      service,
      origin: f.relPath,
      originKind: 'source-code',
    });
  }

  const jsOtelMetricRe = /\.(create(?:Counter|Histogram|Gauge|ObservableCounter|ObservableGauge|ObservableUpDownCounter|UpDownCounter))\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*\{([\s\S]*?)\})?/g;
  while ((match = jsOtelMetricRe.exec(text)) !== null) {
    const sourceName = match[2] || '';
    if (!sourceName) continue;
    const body = match[3] || '';
    addMetricDefinition(metricDefinitions, evidence, summary, {
      name: sourceName,
      sourceName,
      type: `otel-js-${match[1].replace(/^create/, '').toLowerCase()}`,
      help: firstStringProp(body, 'description') || firstStringProp(body, 'help'),
      labels: [],
      service,
      origin: f.relPath,
      originKind: 'source-code',
    });
  }

  const pyMetricRe = /\b(Counter|Gauge|Histogram|Summary)\s*\(\s*['"]([A-Za-z_:][A-Za-z0-9_:]*)['"]\s*,\s*['"]([^'"]*)['"]/g;
  while ((match = pyMetricRe.exec(text)) !== null) {
    addMetricDefinition(metricDefinitions, evidence, summary, {
      name: match[2],
      type: match[1].toLowerCase(),
      help: match[3] || '',
      labels: [],
      service,
      origin: f.relPath,
      originKind: 'source-code',
    });
  }

  const goMetricRe = /\b(?:prometheus|promauto(?:\.With\s*\([^)]*\))?)\.New(Counter|Gauge|Histogram|Summary)(Vec)?\s*\(\s*(?:prometheus\.)?\w+Opts\s*\{([\s\S]*?)\}\s*(?:,\s*\[\]string\s*\{([^}]*)\})?/g;
  while ((match = goMetricRe.exec(text)) !== null) {
    const body = match[3] || '';
    const name = goPrometheusMetricName(body);
    if (!name) continue;
    addMetricDefinition(metricDefinitions, evidence, summary, {
      name,
      type: `go-prometheus-${match[1].toLowerCase()}${match[2] ? '-vec' : ''}`,
      help: firstGoStringProp(body, 'Help'),
      labels: goStringList(match[4]),
      service,
      origin: f.relPath,
      originKind: 'source-code',
    });
  }

  const goOtelMetricRe = /\.(Int64|Float64)(Counter|Histogram|Gauge|UpDownCounter|ObservableCounter|ObservableGauge|ObservableUpDownCounter)\s*\(\s*['"]([^'"]+)['"]\s*([^)]*)\)/g;
  while ((match = goOtelMetricRe.exec(text)) !== null) {
    const sourceName = match[3] || '';
    if (!sourceName) continue;
    const body = match[4] || '';
    addMetricDefinition(metricDefinitions, evidence, summary, {
      name: sourceName,
      sourceName,
      type: `otel-go-${match[1].toLowerCase()}-${match[2].toLowerCase()}`,
      help: firstOtelGoDescription(body),
      labels: [],
      service,
      origin: f.relPath,
      originKind: 'source-code',
    });
  }

  const micrometerBuilderRe = /\b(Counter|Gauge|Timer|DistributionSummary|LongTaskTimer)\.builder\s*\(\s*['"]([^'"]+)['"]\s*\)([\s\S]*?)(?:\.register\s*\(|;)/g;
  while ((match = micrometerBuilderRe.exec(text)) !== null) {
    const body = match[3] || '';
    addMetricDefinition(metricDefinitions, evidence, summary, {
      name: match[2],
      sourceName: match[2],
      type: `micrometer-${match[1].toLowerCase()}`,
      help: firstChainedStringArg(body, 'description'),
      labels: micrometerLabelKeys(body),
      service,
      origin: f.relPath,
      originKind: 'source-code',
    });
  }

  if (/MeterRegistry|io\.micrometer/.test(text)) {
    const micrometerRegistryRe = /\b(?:meterRegistry|registry)\.(counter|gauge|timer|summary)\s*\(\s*['"]([^'"]+)['"]/g;
    while ((match = micrometerRegistryRe.exec(text)) !== null) {
      addMetricDefinition(metricDefinitions, evidence, summary, {
        name: match[2],
        sourceName: match[2],
        type: `micrometer-${match[1].toLowerCase()}`,
        help: '',
        labels: [],
        service,
        origin: f.relPath,
        originKind: 'source-code',
      });
    }
  }

  for (const metric of extractJavaStaticMetricFragments(f.relPath, text)) {
    addMetricDefinition(metricDefinitions, evidence, summary, {
      name: metric.name,
      sourceName: metric.sourceName,
      type: 'java-static-fragment',
      help: '',
      labels: [],
      service,
      origin: f.relPath,
      originKind: 'source-code-fragment',
      candidateOnly: true,
    });
  }

  for (const metric of extractLanguageStaticMetricFragments(f.relPath, text)) {
    addMetricDefinition(metricDefinitions, evidence, summary, {
      name: metric.name,
      sourceName: metric.sourceName,
      type: `${metric.language}-static-fragment`,
      help: '',
      labels: [],
      service,
      origin: f.relPath,
      originKind: 'source-code-fragment',
      candidateOnly: true,
    });
  }
}

function addMetricDefinition(metricDefinitions, evidence, summary, item) {
  const name = normalizePrometheusMetricName(item?.name);
  if (!metricNameish(name)) return;
  const metric = {
    ...item,
    name,
    sourceName: item.sourceName && item.sourceName !== name ? item.sourceName : item.sourceName || null,
    originKind: item.originKind || 'source-code',
    candidateOnly: Boolean(item.candidateOnly),
    confidence: item.candidateOnly ? 'candidate' : 'declared',
    references: Array.isArray(item.references) ? item.references : [],
    usedBy: Array.isArray(item.usedBy) ? item.usedBy.filter(Boolean) : [],
  };
  const existing = metricDefinitions.find(m =>
    m.name === metric.name &&
    m.origin === metric.origin &&
    (m.originKind || 'source-code') === metric.originKind);
  if (existing) {
    mergeMetricEvidence(existing, metric);
    return;
  }
  metricDefinitions.push(metric);
  if (!evidence[`metrics.${metric.name}`]) evidence[`metrics.${metric.name}`] = metric.origin;
  summary.discovered.metricDefinitions++;
}

function mergeMetricEvidence(target, source) {
  if (!target.service && source.service) target.service = source.service;
  if (!target.help && source.help) target.help = source.help;
  if (!target.sourceName && source.sourceName) target.sourceName = source.sourceName;
  target.labels = dedupe([...(target.labels || []), ...(source.labels || [])]);
  target.usedBy = dedupe([...(target.usedBy || []), ...(source.usedBy || [])]).slice(0, 24);
  target.references = [...(target.references || []), ...(source.references || [])].slice(0, 12);
  target.candidateOnly = Boolean(target.candidateOnly && source.candidateOnly);
  target.confidence = target.candidateOnly ? 'candidate' : 'declared';
}

function dedupe(values) {
  const out = [];
  const seen = new Set();
  for (const v of values || []) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function firstStringProp(body, prop) {
  const re = new RegExp(`\\b${prop}\\s*:\\s*['"]([^'"]+)['"]`);
  return re.exec(body)?.[1] || '';
}

function firstGoStringProp(body, prop) {
  const re = new RegExp(`\\b${prop}\\s*:\\s*['"]([^'"]+)['"]`);
  return re.exec(body)?.[1] || '';
}

function goPrometheusMetricName(body) {
  const name = firstGoStringProp(body, 'Name');
  if (!name) return '';
  return [firstGoStringProp(body, 'Namespace'), firstGoStringProp(body, 'Subsystem'), name]
    .filter(Boolean)
    .join('_');
}

function goStringList(body) {
  return [...String(body || '').matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
}

function firstOtelGoDescription(body) {
  return /WithDescription\s*\(\s*['"]([^'"]+)['"]/.exec(String(body || ''))?.[1] || '';
}

function stringArrayProp(body, prop) {
  const re = new RegExp(`\\b${prop}\\s*:\\s*\\[([^\\]]*)\\]`);
  const m = re.exec(body);
  if (!m) return [];
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);
}

function firstChainedStringArg(body, method) {
  const re = new RegExp(`\\.${method}\\s*\\(\\s*['"]([^'"]+)['"]`);
  return re.exec(body)?.[1] || '';
}

function micrometerLabelKeys(body) {
  const out = new Set();
  for (const match of body.matchAll(/\.tag\s*\(\s*['"]([^'"]+)['"]/g)) {
    out.add(match[1]);
  }
  for (const match of body.matchAll(/\.tags\s*\(([^)]*)\)/g)) {
    const values = [...String(match[1] || '').matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
    for (let i = 0; i < values.length; i += 2) out.add(values[i]);
  }
  return [...out].filter(Boolean).sort();
}

function extractLanguageStaticMetricFragments(relPath, text) {
  if (/\.java$/i.test(relPath)) return [];
  if (!metricSourcePathLooksRelevant(relPath)) return [];
  if (!/(metric|prometheus|counter|histogram|gauge|summary|otel|telemetry|exporter)/i.test(text)) return [];
  const language = metricSourceLanguage(relPath);
  const out = new Map();
  const add = (raw) => {
    const sourceName = String(raw || '').trim();
    if (!sourceName || sourceName.length > 160) return;
    if (!/[A-Za-z_:][A-Za-z0-9_:.-]/.test(sourceName)) return;
    const name = normalizePrometheusMetricName(sourceName);
    if (!metricNameish(name) || STATIC_FRAGMENT_STOPWORDS.has(name)) return;
    out.set(name, { name, sourceName: sourceName === name ? null : sourceName, language });
  };
  for (const m of text.matchAll(/\b[A-Za-z0-9_]*METRIC[A-Za-z0-9_]*\s*(?::[^=]+)?=\s*["']([A-Za-z_:][A-Za-z0-9_:.-]+)["']/gi)) {
    add(m[1]);
  }
  for (const m of text.matchAll(/\b(?:metricName|metric_name|seriesName|series_name)\s*(?::[^=]+)?=\s*["']([A-Za-z_:][A-Za-z0-9_:.-]+)["']/gi)) {
    add(m[1]);
  }
  for (const m of text.matchAll(/\b(?:[A-Za-z0-9_]*METRIC[A-Za-z0-9_]*|metricNames|metrics|series|exports)\b\s*(?::[^=]+)?=\s*\[([\s\S]*?)\]/gi)) {
    for (const s of String(m[1] || '').matchAll(/["']([A-Za-z_:][A-Za-z0-9_:.-]+)["']/g)) add(s[1]);
  }
  for (const m of text.matchAll(/\b(?:registerMetric|recordMetric|observeMetric|emitMetric|metricName)\s*\(\s*["']([A-Za-z_:][A-Za-z0-9_:.-]+)["']/gi)) {
    add(m[1]);
  }
  return [...out.values()];
}

function metricSourceLanguage(relPath) {
  const p = normalizeRepoPath(relPath);
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(p)) return 'typescript';
  if (/\.go$/.test(p)) return 'go';
  if (/\.py$/.test(p)) return 'python';
  if (/\.kt$/.test(p)) return 'kotlin';
  if (/\.rs$/.test(p)) return 'rust';
  if (/\.cs$/.test(p)) return 'csharp';
  return 'source';
}

function extractJavaStaticMetricFragments(relPath, text) {
  if (!/\.java$/i.test(relPath)) return [];
  if (!/METRIC_NAME|String\.format|(?:^|[.\s])(?:name|put)\s*\(/.test(text)) return [];
  const prefix = javaMetricPrefix(relPath, text);
  const out = new Map();
  const add = (raw) => {
    const sourceName = String(raw || '').trim();
    if (!sourceName || sourceName.length > 160) return;
    const full = sourceName.includes('_') || !prefix ? sourceName : `${prefix}${sourceName}`;
    const name = normalizePrometheusMetricName(full);
    if (!metricNameish(name) || JAVA_FRAGMENT_STOPWORDS.has(name)) return;
    out.set(name, { name, sourceName: sourceName === name ? null : sourceName });
  };
  for (const m of text.matchAll(/\.(?:name|put)\s*\(\s*["']([A-Za-z_:][A-Za-z0-9_:.-]*)["']/g)) {
    add(m[1]);
  }
  for (const m of text.matchAll(/\bMETRIC_NAME\s*=\s*["']([A-Za-z_:][A-Za-z0-9_:.-]*)["']/g)) {
    add(m[1]);
  }
  for (const m of text.matchAll(/\bMETRIC_NAME\s*=\s*String\.format\s*\(\s*["'][^"']*%s[_:-]([A-Za-z0-9_:.-]+)[^"']*["'][^)]*\)/g)) {
    add(`${prefix}${m[1]}`);
  }
  for (const m of text.matchAll(/String\.format\s*\(\s*["']%s[_:-]([A-Za-z0-9_:.-]+)["']\s*,\s*\w+\s*\)/g)) {
    add(`${prefix}${m[1]}`);
  }
  return [...out.values()];
}

const JAVA_FRAGMENT_STOPWORDS = new Set([
  'name', 'type', 'description', 'metric', 'metrics', 'help', 'value',
]);

const STATIC_FRAGMENT_STOPWORDS = new Set([
  ...JAVA_FRAGMENT_STOPWORDS,
  'counter', 'histogram', 'gauge', 'summary', 'register', 'registry',
  'duration', 'latency', 'status', 'method', 'route', 'service', 'namespace',
]);

function javaMetricPrefix(relPath, text) {
  const p = normalizeRepoPath(relPath);
  if (/otel-collector|syslog|event/.test(p)) return 'sol_event_';
  if (/metrics-exporter|solace/.test(p) || /solace/i.test(text)) return 'solace_';
  return '';
}

function extractPrometheusMetricNames(expr) {
  return extractPromqlMetricNames(expr).filter(metricNameish);
}

function addPromqlMetricReferences(metricDefinitions, evidence, summary, expr, context) {
  const names = extractPrometheusMetricNames(expr);
  for (const name of names) {
    addMetricDefinition(metricDefinitions, evidence, summary, {
      name,
      type: 'promql-reference',
      origin: context.origin,
      originKind: 'promql-reference',
      query: expr,
      usedBy: [context.usedBy],
      references: [{
        kind: context.kind,
        name: context.name || '',
        file: context.origin,
      }],
    });
  }
}

function addRecordingRuleOutputMetric(metricDefinitions, evidence, summary, rule, context) {
  if (!rule?.record) return;
  addMetricDefinition(metricDefinitions, evidence, summary, {
    name: rule.record,
    type: 'recording-rule-output',
    origin: context.origin,
    originKind: 'recording-rule-output',
    query: context.expr || '',
    usedBy: [context.usedBy],
    references: [{
      kind: 'recording-rule-output',
      name: rule.record,
      file: context.origin,
    }],
  });
}

function curateMetricDefinitions(metricDefinitions, summary) {
  const referenced = new Set(
    metricDefinitions
      .filter(m => ['promql-reference', 'recording-rule-output'].includes(m.originKind))
      .map(m => m.name),
  );
  let unreferenced = 0;
  for (const metric of metricDefinitions) {
    if (!metric.candidateOnly) continue;
    metric.confidence = referenced.has(metric.name) ? 'referenced-candidate' : 'candidate';
    if (!referenced.has(metric.name)) unreferenced++;
  }
  summary.discovered.metricEvidence = metricDefinitions.length;
  summary.discovered.metricDefinitions = new Set(metricDefinitions.map(m => m.name)).size;
  summary.discovered.metricCandidatesDropped = 0;
  summary.discovered.metricCandidatesUnreferenced = unreferenced;
}

function buildMetricDefinitionAnnotations(metricDefinitions) {
  if (!metricDefinitions.length) return {};
  const byName = new Map();
  for (const metric of metricDefinitions) {
    if (!byName.has(metric.name)) {
      byName.set(metric.name, { primary: metric, all: [metric] });
      continue;
    }
    const bucket = byName.get(metric.name);
    bucket.all.push(metric);
    if (metricOriginRank(metric) < metricOriginRank(bucket.primary)) bucket.primary = metric;
  }
  const names = [...byName.keys()].sort();
  const origins = {};
  for (const name of names) {
    const bucket = byName.get(name);
    const metric = bucket.primary;
    const references = bucket.all.flatMap(m => m.references || []).slice(0, 12);
    const usedBy = dedupe(bucket.all.flatMap(m => m.usedBy || [])).slice(0, 24);
    origins[name] = {
      file: metric.origin,
      service: metric.service || '',
      type: metric.type || '',
      help: metric.help || '',
      labels: metric.labels || [],
      source_name: metric.sourceName || '',
      origin_kind: metric.originKind || '',
      confidence: metric.confidence || (metric.candidateOnly ? 'candidate' : 'declared'),
      candidate: Boolean(metric.candidateOnly),
      query: metric.query || '',
      used_by: usedBy,
      references,
    };
  }
  return {
    'crawler.discovered.metric_names': annotationJson(names),
    'crawler.discovered.metric_names_count': String(names.length),
    'crawler.discovered.metric_origins': annotationJson(origins),
  };
}

const JSON_ANNOTATION_BLOCK_LENGTH = 4096;

function annotationJson(value) {
  const compact = JSON.stringify(value);
  return compact.length > JSON_ANNOTATION_BLOCK_LENGTH
    ? JSON.stringify(value, null, 2)
    : compact;
}

function metricOriginRank(metric) {
  const kind = metric?.originKind || 'source-code';
  if (kind === 'source-code') return 0;
  if (kind === 'source-code-fragment') return 1;
  if (kind === 'recording-rule-output') return 2;
  if (kind === 'promql-reference') return 3;
  return 9;
}

function buildScrapeJobAnnotations(scrapeJobs) {
  if (!scrapeJobs.length) return {};
  const byJob = new Map();
  for (const job of scrapeJobs) {
    if (!byJob.has(job.job)) byJob.set(job.job, job);
  }
  const jobs = [...byJob.keys()].sort();
  const origins = {};
  for (const job of jobs) {
    const item = byJob.get(job);
    origins[job] = {
      file: item.origin,
      metrics_path: item.metrics_path || '',
      interval: item.interval || '',
      targets: item.targets || [],
    };
  }
  return {
    'crawler.discovered.scrape_jobs': annotationJson(jobs),
    'crawler.discovered.scrape_jobs_count': String(jobs.length),
    'crawler.discovered.scrape_job_origins': annotationJson(origins),
  };
}

// Components disabled via Helm `enabled: false`, merged across the in-scope
// values files. Base `values.yaml` is applied first; environment overlays
// (`values-<env>.yaml`) are applied after and win — mirroring `helm -f` order.
// A top-level component in the returned set must NOT be registered as a live
// backend: the environment under inspection does not deploy it (e.g. prometheus
// on EKS, where `values-eks.yaml` sets `prometheus.enabled: false` and the
// cluster runs victoriametrics instead). Honors only top-level component
// toggles, which is the convention these charts use.
function collectDisabledComponents(valuesFiles) {
  const ordered = [...valuesFiles].sort((a, b) => {
    const rank = (p) => (/(^|\/)values\.ya?ml$/i.test(normalizeRepoPath(p)) ? 0 : 1);
    return rank(a.relPath) - rank(b.relPath);
  });
  const effective = new Map(); // top-level component -> enabled boolean
  for (const f of ordered) {
    let docs;
    try { docs = parseYamlDocs(f.content); } catch { continue; }
    for (const obj of docs) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
      for (const [key, val] of Object.entries(obj)) {
        if (val && typeof val === 'object' && !Array.isArray(val)
            && typeof val.enabled === 'boolean') {
          effective.set(key, val.enabled);
        }
      }
    }
  }
  const disabled = new Set();
  for (const [key, on] of effective) if (on === false) disabled.add(key);
  return disabled;
}

function walkHelmValues(f, backends, pipelines, evidence, summary, disabledComponents = new Set()) {
  const visit = (node, path = []) => {
    if (!node) return;
    // Prune the subtree of any top-level component the environment disables
    // (Helm `enabled: false`), so its image is never registered as a backend.
    const topComponent = path[0];
    if (topComponent && disabledComponents.has(topComponent)) return;
    if (typeof node === 'string') {
      const key = path[path.length - 1] || '';
      if (/^(image|repository|repo|name)$/.test(String(key).toLowerCase())) {
        registerBackendFromImage(node, f.relPath, backends, evidence, summary, { dedupeByProduct: true, pipelines });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, idx) => visit(item, path.concat(String(idx))));
      return;
    }
    if (typeof node !== 'object') return;

    const image = imageFromHelmImageObject(node);
    if (image) registerBackendFromImage(image, f.relPath, backends, evidence, summary, { dedupeByProduct: true, pipelines });

    for (const [key, value] of Object.entries(node)) {
      if (key === 'image' && typeof value === 'string') {
        registerBackendFromImage(value, f.relPath, backends, evidence, summary, { dedupeByProduct: true, pipelines });
      }
      visit(value, path.concat(key));
    }
  };

  for (const obj of parseYamlDocs(f.content)) visit(obj);
}

function workloadPodSpec(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.kind === 'CronJob') return obj.spec?.jobTemplate?.spec?.template?.spec || null;
  return obj.spec?.template?.spec || obj.spec || null;
}

function walkK8sWorkload(f, backends, pipelines, evidence, summary) {
  for (const obj of parseYamlDocs(f.content)) {
    if (!K8S_WORKLOAD_KINDS.has(obj?.kind)) continue;
    const podSpec = workloadPodSpec(obj);
    const containers = [
      ...(Array.isArray(podSpec?.containers) ? podSpec.containers : []),
      ...(Array.isArray(podSpec?.initContainers) ? podSpec.initContainers : []),
    ];
    for (const c of containers) {
      registerBackendFromImage(c?.image, f.relPath, backends, evidence, summary, { dedupeByProduct: true, pipelines });
    }
  }
}

// Introspect a Helm template. The valuable observability contracts in a chart
// are rendered into Kubernetes ConfigMaps (Prometheus recording/alerting rules,
// Grafana dashboards, Alertmanager routes, OTel pipelines). We extract those
// embedded payloads and route each through the same per-kind walker the raw
// artefact would use \u2014 so a rule shipped inside a chart is decompiled exactly
// like a rule shipped as a standalone file. If the template embeds nothing, we
// strip the scaffolding and treat the document itself as a single manifest.
function walkHelmTemplate(f, buckets, evidence, summary) {
  const { backends, recordingRules, burnRateAlerts, metricDefinitions, scrapeJobs, alertingRoutes, dashboards, pipelines, repoName } = buckets;
  const route = (kind, sub) => {
    switch (kind) {
      case 'prometheus-rules': walkPrometheusRules(sub, recordingRules, burnRateAlerts, metricDefinitions, evidence, summary); return true;
      case 'prometheus-scrape-config': walkPrometheusScrapeConfig(sub, scrapeJobs, evidence, summary); return true;
      case 'actuator-metrics-config': walkActuatorMetricsConfig(sub, scrapeJobs, evidence, summary, repoName); return true;
      case 'alertmanager':     walkAlertmanager(sub, alertingRoutes, evidence, summary); return true;
      case 'otel-collector':   walkOtelCollector(sub, pipelines, evidence, summary); return true;
      case 'grafana-dashboard':walkGrafanaDashboard(sub, dashboards, metricDefinitions, evidence, summary); return true;
      case 'docker-compose':   walkDockerCompose(sub, backends, pipelines, evidence, summary); return true;
      case 'k8s-workload':     walkK8sWorkload(sub, backends, pipelines, evidence, summary); return true;
      default: return false;
    }
  };

  const blocks = extractConfigMapData(f.content);

  for (const { key, body } of blocks) {
    const clean = stripGoTemplate(body);
    const lk = key.toLowerCase();
    const sub = { relPath: `${f.relPath}#${key}`, content: clean };
    let kind = 'unknown';

    if (/rule/.test(lk) || /^groups:\s*$/m.test(clean))                              kind = 'prometheus-rules';
    else if (/scrape/.test(lk) || /^scrape_configs:\s*$/m.test(clean))                kind = 'prometheus-scrape-config';
    else if (/application|bootstrap|actuator/.test(lk) || looksLikeActuatorMetricsConfig('', clean)) kind = 'actuator-metrics-config';
    else if (lk.endsWith('.json') || /"schemaVersion"\s*:/.test(clean))              kind = 'grafana-dashboard';
    else if (/^route:/m.test(clean) && /^receivers:/m.test(clean))                   kind = 'alertmanager';
    else if (/^receivers:/m.test(clean) && /^exporters:/m.test(clean) && /pipelines:/.test(clean)) kind = 'otel-collector';

    // A ConfigMap whose data key looks like an observability artefact but
    // can't be parsed is a genuine signal worth surfacing; ordinary
    // non-observability data keys (scripts, plain config) are simply skipped.
    try { route(kind, sub); }
    catch (e) { summary.warnings.push(`Failed to parse ${sub.relPath}: ${e.message}`); }
  }

  // No embedded ConfigMap payloads — the template may itself be a single
  // observability manifest. Route it only when its *shape* matches (filename
  // heuristics are unreliable for Helm template names like
  // `deployment-alertmanager.yaml`); stay silent otherwise, since the
  // overwhelming majority of chart templates are Deployments, Services,
  // Secrets, etc. that carry no observability contracts.
  if (blocks.length === 0) {
    const clean = stripGoTemplate(f.content);
    const kind = sniffObservabilityKind(clean);
    if (kind !== 'unknown') {
      try { route(kind, { relPath: f.relPath, content: clean }); } catch (_) { /* speculative */ }
    }
  }
}

// ============================================================
// Per-kind walkers
// ============================================================

function walkDockerCompose(f, backends, pipelines, evidence, summary) {
  for (const obj of parseYamlDocs(f.content)) {
    if (!obj?.services) continue;
    for (const [svcName, svc] of Object.entries(obj.services)) {
    const image = String(svc?.image || '');
    if (!image) continue;
    for (const p of BACKEND_PATTERNS) {
      if (p.match.test(image)) {
        // Schema id pattern: ^[a-z][a-z0-9_-]*[a-z0-9]$ (lowercase, ends alphanumeric).
        const baseId = `${p.signal}-${p.product}`;
        let id = baseId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
        let n = 2;
        while (backends.some(b => b.id === id)) id = `${baseId}-${n++}`;
        const endpoint = inferEndpoint(svc, p.product);
        const versionTag = (image.split(':')[1] || '').trim();
        const backend = {
          id,
          signal: p.signal,
          product: p.product,
          endpoints: endpoint ? [endpoint] : [`http://${p.product}:80`],
          auth: { kind: 'none' },
        };
        if (versionTag && /^v?\d/.test(versionTag)) {
          backend.version = { declared: versionTag.replace(/^v/, ''), gating: 'off' };
        }
        backends.push(backend);
        evidence[id] = f.relPath;
        summary.discovered.backends++;
        registerMetricsExporterFromBackend(p, pipelines, f.relPath, evidence, summary);
        break;
      }
    }
  }
  }
}

function inferEndpoint(svc, product) {
  // Walk ports + healthcheck for a hint. We emit a relative URL so the
  // engineer can see where in the compose graph the backend lives.
  const ports = Array.isArray(svc?.ports) ? svc.ports : [];
  if (ports.length) {
    const first = String(ports[0]);
    const m = first.match(/(\d+)(?::(\d+))?/);
    if (m) return `http://${product}:${m[2] || m[1]}`;
  }
  return null;
}

function walkPrometheusRules(f, recordingRules, burnRateAlerts, metricDefinitions, evidence, summary) {
  let any = false;
  for (const obj of parseYamlDocs(f.content)) {
    if (!Array.isArray(obj.groups)) continue;
    any = true;
    for (const group of obj.groups) {
      for (const rule of group.rules || []) {
        if (rule.record) {
          const id = `QRY-${recordingRules.length + 1}-${slug(rule.record).slice(0, 16)}`;
          const expr = typeof rule.expr === 'string' ? rule.expr : String(rule.expr || '');
          const entry = {
            name: rule.record,
            expr,
          };
          if (group.interval) entry.interval = group.interval;
          recordingRules.push(entry);
          evidence[id] = `${f.relPath}#${group.name || '_'}/${rule.record}`;
          summary.discovered.recordingRules++;
          const origin = `${f.relPath}#${group.name || '_'}/${rule.record}`;
          addRecordingRuleOutputMetric(metricDefinitions, evidence, summary, rule, {
            origin,
            expr,
            usedBy: `recording_rule:${rule.record}`,
          });
          addPromqlMetricReferences(metricDefinitions, evidence, summary, expr, {
            kind: 'recording-rule',
            name: rule.record,
            origin,
            usedBy: `recording_rule:${rule.record}`,
          });
        } else if (rule.alert || rule.title) {
          // `rule.alert` is the Prometheus form; `rule.title` is the Grafana
          // unified-alerting form (provisioned alert rules). Both target an
          // SLO we synthesize from the alert name.
          const alertName = rule.alert || rule.title;
          const sloId = slug(alertName).replace(/-burn-?rate.*$/, '_99');
          if (!burnRateAlerts.some(a => a.slo === sloId)) {
            const windows = parseAlertWindows(rule);
            const expr = typeof rule.expr === 'string' ? rule.expr : String(rule.expr || '');
            burnRateAlerts.push({ slo: sloId, windows, expr, alertName });
            const id = `pol-${burnRateAlerts.length}`;
            evidence[id] = `${f.relPath}#${group.name || '_'}/${alertName}`;
            summary.discovered.burnRateAlerts++;
            addPromqlMetricReferences(metricDefinitions, evidence, summary, expr, {
              kind: 'alert-rule',
              name: alertName,
              origin: `${f.relPath}#${group.name || '_'}/${alertName}`,
              usedBy: `alert:${alertName}`,
            });
          }
        }
      }
    }
  }
  if (!any) return;
}

function walkPrometheusScrapeConfig(f, scrapeJobs, evidence, summary) {
  for (const obj of parseYamlDocs(f.content)) {
    if (!Array.isArray(obj?.scrape_configs)) continue;
    for (const cfg of obj.scrape_configs) {
      const job = String(cfg?.job_name || '').trim();
      if (!job) continue;
      addScrapeJob(scrapeJobs, evidence, summary, {
        job,
        metrics_path: cfg.metrics_path || '/metrics',
        interval: cfg.scrape_interval || obj.global?.scrape_interval || null,
        targets: scrapeTargets(cfg),
        origin: f.relPath,
      });
    }
  }
}

function walkActuatorMetricsConfig(f, scrapeJobs, evidence, summary, repoName = null) {
  for (const obj of parseYamlDocs(f.content)) {
    if (!looksLikeActuatorMetricsConfig(f.relPath, f.content, obj)) continue;
    const job = actuatorServiceName(obj, f.relPath, repoName);
    if (!job) continue;
    addScrapeJob(scrapeJobs, evidence, summary, {
      job,
      metrics_path: actuatorPrometheusPath(obj),
      interval: null,
      targets: [],
      origin: f.relPath,
    });
  }
}

function addScrapeJob(scrapeJobs, evidence, summary, item) {
  if (!item?.job) return;
  if (scrapeJobs.some(j => j.job === item.job && j.origin === item.origin)) return;
  scrapeJobs.push(item);
  if (!evidence[`scrape.${item.job}`]) evidence[`scrape.${item.job}`] = item.origin;
  summary.discovered.scrapeJobs++;
}

function scrapeTargets(cfg) {
  const out = new Set();
  for (const sc of cfg?.static_configs || []) {
    for (const target of sc?.targets || []) {
      if (target) out.add(String(target));
    }
  }
  for (const ds of cfg?.dns_sd_configs || []) {
    for (const name of ds?.names || []) {
      if (name) out.add(String(name));
    }
  }
  for (const ks of cfg?.kubernetes_sd_configs || []) {
    if (ks?.role) out.add(`kubernetes:${ks.role}`);
  }
  return [...out].sort();
}

function parseAlertWindows(rule) {
  // Extract a single window from `for:` and `labels.severity`. Real
  // multi-window decomposition can't be recovered from a single rule;
  // we record what's there and let the synthesizer fill the rest.
  const out = [];
  const sev = rule.labels?.severity?.toString()?.toUpperCase();
  const severity = /^SEV[123]$/.test(sev) ? sev : 'SEV2';
  if (typeof rule.for === 'string') {
    out.push({ short: rule.for, long: '6h', factor: 6, severity });
  }
  return out;
}

// Map a burn-rate alert to a recording-rule-derived SLO by scanning its
// expression for any `ns:metric:op` recorded-series reference. Returns the
// matching SLO id present in `sloMap`, or null. This is the inverse of the
// compiler, which builds burn-rate alerts on top of the recorded ratios.
function linkAlertToRecordedSlo(alert, sloMap) {
  const expr = typeof alert?.expr === 'string' ? alert.expr : '';
  if (!expr) return null;
  const re = /[a-z][a-z0-9_]*:[a-z][a-z0-9_]*:[a-z0-9_]+/g;
  let m;
  while ((m = re.exec(expr)) !== null) {
    const sloId = ruleNameToSloId(m[0]);
    if (sloId && sloMap.has(sloId)) return sloId;
  }
  return null;
}

// Collapse burn-rate alerts that now share an SLO (after linking) into one
// entry per SLO, unioning their windows (de-duplicated by short/long/factor)
// so spec.policy.burn_rate_alerts stays one-entry-per-SLO and valid.
function dedupeBurnRateAlerts(alerts) {
  const bySlo = new Map();
  for (const a of alerts) {
    if (!bySlo.has(a.slo)) { bySlo.set(a.slo, a); continue; }
    const tgt = bySlo.get(a.slo);
    const seen = new Set((tgt.windows || []).map(w => `${w.short}|${w.long}|${w.factor}`));
    for (const w of a.windows || []) {
      const k = `${w.short}|${w.long}|${w.factor}`;
      if (!seen.has(k)) { tgt.windows.push(w); seen.add(k); }
    }
    a._drop = true;
  }
  for (let i = alerts.length - 1; i >= 0; i--) {
    if (alerts[i]._drop) alerts.splice(i, 1);
  }
}

function walkAlertmanager(f, routes, evidence, summary) {
  for (const obj of parseYamlDocs(f.content)) {
    if (!obj?.route) continue;
    // Walk top-level route + its children. Each route → one entry per severity.
    const collected = [];
    walkRoute(obj.route, collected, obj.receivers || [], summary.omitted.unresolvedChannels, f.relPath);
    for (const r of collected) {
      const id = `ALR-${routes.length + 1}`;
      routes.push(r);
      evidence[id] = `${f.relPath}#route/${r.severity || 'default'}`;
      summary.discovered.alertingRoutes++;
    }
  }
}

function walkRoute(route, out, receivers, unresolved, relPath) {
  const sev = route.match?.severity || route.match_re?.severity || route.matchers?.find?.(m => /severity/i.test(m))?.split('=')?.[1]?.replace(/"/g, '');
  const recvName = route.receiver;
  const recv = receivers.find(r => r.name === recvName);
  const before = unresolved.length;
  const channels = recv ? receiverChannels(recv, unresolved, { severity: normalizeSeverity(sev), source: relPath }) : [];
  const droppedHere = unresolved.length - before;
  if (channels.length) {
    out.push({ severity: normalizeSeverity(sev), channels });
  } else if ((sev || recvName) && droppedHere === 0) {
    // Receiver kinds we can't map → keep the route on a synthetic Teams
    // placeholder (long-standing behaviour for unmapped receivers). But
    // when this receiver's channels were EXCLUDED as unresolved ${VAR}
    // placeholders, fabricating a channel here would over-declare: the
    // route stays out of the declared spec and lives on as evidence in
    // the crawler.unresolved.* annotations instead.
    out.push({ severity: normalizeSeverity(sev), channels: [{ msteams: `#${recvName || 'oncall'}` }] });
  }
  for (const child of route.routes || []) walkRoute(child, out, receivers, unresolved, relPath);
}

// Does this channel value carry an unresolved deploy-time placeholder
// (${VAR}) AND fail the spec's URI shape? Embedded placeholders inside an
// otherwise URI-shaped value (https://ntfy.sh/${TOPIC}?…) still parse as a
// webhook target and stay declared. A value that is ONLY a placeholder has
// no scheme, cannot pass `format: uri`, and must not be declared as a real
// channel — the crawler records it as evidence instead of emitting a pack
// that fails its own schema.
const CHANNEL_URI_RE = /^[a-z][a-z0-9+.-]*:\S+$/i;   // mirrors validator.mjs URI_RE
function isUnresolvedChannelValue(value) {
  const v = String(value || '');
  return v.includes('${') && !CHANNEL_URI_RE.test(v);
}

// Map Prometheus / Alertmanager severity labels to the spec v1.2
// enum: SEV1 (critical) / SEV2 (warning) / SEV3 (info) / SEV4 (debug).
// If the input already matches SEV1..SEV4, pass through. Common
// Prometheus conventions map as below.
function normalizeSeverity(s) {
  if (!s) return 'SEV2';
  const up = String(s).toUpperCase();
  if (/^SEV[1234]$/.test(up)) return up;
  if (/^(CRITICAL|FATAL|EMERGENCY|PAGE)$/.test(up)) return 'SEV1';
  if (/^(WARNING|ERROR|MAJOR|HIGH)$/.test(up))      return 'SEV2';
  if (/^(INFO|NOTICE|MINOR|LOW)$/.test(up))         return 'SEV3';
  if (/^(DEBUG|TRACE)$/.test(up))                   return 'SEV4';
  return 'SEV2';
}

function receiverChannels(recv, unresolved = [], ctx = {}) {
  // Spec Channel allows only: msteams, voice, whatsapp, email, webhook.
  // Map Alertmanager's broader vocabulary onto that closed set; flag
  // anything we couldn't map as a webhook with a placeholder URL.
  // Webhook URLs that are unresolved ${VAR} placeholders are screened out
  // (see isUnresolvedChannelValue) and recorded for the evidence
  // annotation — the crawler must never emit a pack that fails its own
  // schema.
  const out = [];
  const webhook = (url, fallback) => {
    const v = url || fallback;
    if (isUnresolvedChannelValue(v)) {
      unresolved.push({ receiver: recv.name || null, severity: ctx.severity || null, value: String(v), source: ctx.source || null });
      return;
    }
    out.push({ webhook: v });
  };
  if (Array.isArray(recv.email_configs))     out.push(...recv.email_configs.map(c => ({ email: c.to || `oncall@${recv.name || 'example'}.com` })));
  if (Array.isArray(recv.msteams_configs))   out.push(...recv.msteams_configs.map(c => ({ msteams: c.channel_url || `#${recv.name || 'oncall'}` })));
  if (Array.isArray(recv.webhook_configs))   for (const c of recv.webhook_configs) webhook(c.url, 'https://hooks.example.com/oncall');
  if (Array.isArray(recv.pagerduty_configs)) out.push({ voice: `pagerduty:${recv.name || 'oncall'}` });
  if (Array.isArray(recv.slack_configs))     for (const c of recv.slack_configs) webhook(c.api_url, `https://hooks.slack.example.com/${c.channel || 'oncall'}`);
  return out;
}

function walkOtelCollector(f, pipelines, evidence, summary) {
  for (const obj of parseYamlDocs(f.content)) {
    if (!obj?.service?.pipelines) continue;
    const seen = new Set();
    for (const pipeline of Object.values(obj.service.pipelines)) {
      for (const recv of pipeline.receivers || []) {
        if (!seen.has(`r:${recv}`)) {
          seen.add(`r:${recv}`);
          pipelines.receivers.push({ name: recv.split('/')[0] });
        }
      }
      for (const proc of pipeline.processors || []) {
        if (!seen.has(`p:${proc}`)) {
          seen.add(`p:${proc}`);
          pipelines.processors.push({ name: proc.split('/')[0] });
        }
      }
      for (const exp of pipeline.exporters || []) {
        const kind = exp.split('/')[0];
        const sig = Object.entries(obj.service.pipelines).find(([_, p]) => p === pipeline)?.[0] || '';
        const signalClass = /^metrics/i.test(sig) ? 'metrics'
                         : /^logs/i.test(sig) ? 'logs'
                         : /^traces/i.test(sig) ? 'traces' : null;
        if (signalClass && !pipelines.exporters[signalClass]) {
          pipelines.exporters[signalClass] = { kind: mapExporterKind(kind) };
        }
      }
    }
    evidence[`PIP-${summary.discovered.pipelines + 1}`] = f.relPath;
    summary.discovered.pipelines++;
  }
}

function mapExporterKind(name) {
  // The spec's exporter kind taxonomy is small; map common collector
  // exporters to it.
  if (/^prometheus|otlphttp?$/i.test(name)) return 'prometheusremotewrite';
  if (/^otlp$|^otlphttp$/i.test(name))      return 'otlp';
  if (/^elasticsearch$/i.test(name))         return 'elasticsearch';
  if (/^jaeger|tempo$/i.test(name))          return 'jaeger';
  if (/^loki$/i.test(name))                  return 'loki';
  return name;
}

function walkGrafanaDashboard(f, dashboards, metricDefinitions, evidence, summary) {
  const dash = JSON.parse(f.content);
  let id = (dash.uid || dash.title || `dash-${dashboards.length + 1}`)
    .toString().toLowerCase().replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60);
  if (!/^[a-z]/.test(id)) id = 'd-' + id;
  const panels = dashboardPromqlQueries(dash);
  dashboards.push({
    id,
    provider: {
      kind: 'grafana',
      version: dash.version ? String(dash.version) : '12.0',
      schemaVersion: Number.isFinite(dash.schemaVersion) ? dash.schemaVersion : 41,
    },
    folder: dash.tags?.[0] || 'crawled',
    source: `file://${f.relPath}`,
    params: {
      title: dash.title || id,
      uid: dash.uid || '',
      panel_count: countDashboardPanels(dash.panels),
      query_panel_count: panels.length,
      panels,
    },
  });
  evidence[id] = f.relPath;
  summary.discovered.dashboards++;

  for (const q of panels) {
    addPromqlMetricReferences(metricDefinitions, evidence, summary, q.expr, {
      kind: 'dashboard-panel',
      name: q.panel,
      origin: `${f.relPath}#${q.panel}`,
      usedBy: `dashboard:${id}/${q.panel}`,
    });
  }
}

function dashboardPromqlQueries(dash) {
  const out = [];
  const walkPanels = (panels = []) => {
    if (!Array.isArray(panels)) return;
    for (const panel of panels) {
      const rawTitle = String(panel.title || panel.id || `panel-${out.length + 1}`);
      const panelName = slug(rawTitle) || `panel-${out.length + 1}`;
      for (const target of panel.targets || []) {
        const expr = target?.expr || target?.query || target?.expression;
        if (typeof expr === 'string' && expr.trim()) {
          out.push({
            panel: panelName,
            title: rawTitle,
            expr,
            refId: target?.refId || '',
            datasource: datasourceLabel(target?.datasource || panel.datasource),
            metrics: extractPrometheusMetricNames(expr),
          });
        }
      }
      walkPanels(panel.panels);
    }
  };
  walkPanels(dash.panels);
  return out;
}

function countDashboardPanels(panels = []) {
  if (!Array.isArray(panels)) return 0;
  let count = 0;
  for (const panel of panels) {
    if (!panel || typeof panel !== 'object') continue;
    count++;
    count += countDashboardPanels(panel.panels);
  }
  return count;
}

function datasourceLabel(ds) {
  if (!ds) return '';
  if (typeof ds === 'string') return ds;
  if (typeof ds === 'object') return ds.uid || ds.type || ds.name || '';
  return '';
}

function inferDashboardPanelBindings(dashboards, sliMap, sloMap, recordingRules, summary) {
  const candidates = dashboardBindingCandidates(sliMap, sloMap, recordingRules);
  if (!candidates.length) return;
  let bound = 0;
  for (const dashboard of dashboards) {
    const panels = dashboard.params?.panels || [];
    for (const panel of panels) {
      if (panel.binds_to) continue;
      const best = bestPanelBinding(panel, candidates);
      if (!best) continue;
      panel.binds_to = best.ref;
      panel.binding_confidence = best.confidence;
      panel.binding_reason = best.reason;
      dashboard.panel_bindings ||= [];
      if (!dashboard.panel_bindings.some(b => norm(b.panel) === norm(panel.panel || panel.title))) {
        dashboard.panel_bindings.push({ panel: panel.title || panel.panel, binds_to: best.ref });
        bound++;
      }
    }
  }
  if (bound) {
    summary.discovered.dashboardPanelBindings = bound;
    summary.warnings.push(`Inferred ${bound} dashboard panel binding(s) from panel queries and requirement/rule names.`);
  }
}

function dashboardBindingCandidates(sliMap, sloMap, recordingRules) {
  const bySli = new Map();
  for (const sli of sliMap.values()) {
    bySli.set(sli.id, {
      ref: `slis.${sli.id}`,
      kind: 'sli',
      id: sli.id,
      metrics: new Set([
        ...extractPrometheusMetricNames(sli.good || ''),
        ...extractPrometheusMetricNames(sli.total || ''),
        ...extractPrometheusMetricNames(sli.query || ''),
        ...extractPrometheusMetricNames(sli.expression || ''),
      ]),
      ruleNames: new Set(),
      keywords: keywords(`${sli.id} ${sli.description || ''}`),
    });
  }
  for (const rule of recordingRules) {
    const sliId = ruleNameToSliId(rule.name);
    if (!sliId || !bySli.has(sliId)) continue;
    const candidate = bySli.get(sliId);
    candidate.ruleNames.add(rule.name);
    for (const metric of extractPrometheusMetricNames(rule.expr || '')) candidate.metrics.add(metric);
    for (const word of keywords(`${rule.name} ${rule.expr || ''}`)) candidate.keywords.add(word);
  }

  const out = [...bySli.values()];
  for (const slo of sloMap.values()) {
    out.push({
      ref: `slos.${slo.id}`,
      kind: 'slo',
      id: slo.id,
      metrics: new Set(),
      ruleNames: new Set(),
      keywords: keywords(`${slo.id} ${slo.sli || ''}`),
    });
  }
  return out;
}

function bestPanelBinding(panel, candidates) {
  const hay = `${panel.title || ''} ${panel.panel || ''} ${panel.expr || ''}`.toLowerCase();
  const panelMetrics = new Set(panel.metrics || extractPrometheusMetricNames(panel.expr || ''));
  const scored = candidates
    .map(candidate => scorePanelBinding(hay, panelMetrics, candidate))
    .filter(candidate => candidate.score >= 5)
    .sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  const top = scored[0];
  return {
    ref: top.ref,
    confidence: top.score >= 8 ? 'declared-inferred' : 'inferred',
    reason: top.reasons.join(', '),
  };
}

function scorePanelBinding(hay, panelMetrics, candidate) {
  let score = 0;
  const reasons = [];
  const id = candidate.id.toLowerCase();
  const ref = candidate.ref.toLowerCase();
  if (hay.includes(ref) || hay.includes(`ref:${ref}`)) {
    score += 8;
    reasons.push('explicit ref text');
  }
  if (matchesLooseId(hay, id)) {
    score += 5;
    reasons.push('requirement id text');
  }
  for (const ruleName of candidate.ruleNames || []) {
    if (!ruleName || !hay.includes(String(ruleName).toLowerCase())) continue;
    score += 7;
    reasons.push('recording rule name');
    break;
  }
  const sharedMetrics = [...panelMetrics].filter(metric => candidate.metrics?.has(metric));
  if (sharedMetrics.length) {
    score += Math.min(5, sharedMetrics.length * 2);
    reasons.push(`shared metrics:${sharedMetrics.slice(0, 3).join('|')}`);
  }
  const sharedKeywords = [...(candidate.keywords || [])].filter(word => hay.includes(word)).slice(0, 4);
  if (sharedKeywords.length >= 2) {
    score += Math.min(4, sharedKeywords.length);
    reasons.push(`keywords:${sharedKeywords.join('|')}`);
  }
  return { ref: candidate.ref, score, reasons };
}

function matchesLooseId(hay, id) {
  if (!hay || !id) return false;
  if (hay.includes(id)) return true;
  return hay.includes(id.replace(/_/g, ':')) || hay.includes(id.replace(/_/g, '-'));
}

function keywords(text) {
  const out = new Set();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4) continue;
    if (PROMQL_KEYWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function norm(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
