// ============================================================
// crawler.mjs — Path A of the pack-creation user journey.
//
// Walks a service repository and emits a draft canonical
// ObservabilityPack manifest by introspecting common
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
import {
  inferSlisFromRecordingRules, ruleNameToSliId,
  burnCandidateFromAlertRule, recordedSloForExpr, mergeBurnAlertsBySlo, defaultBurnWindows,
  operationalAlertRules, isGrafanaManagedRule, alertRuleExpr,
  isSpecRecordingRuleName, canonicalRuleDuration, SPEC_DURATION_RE,
} from './sli-inference.mjs';
import { materializeL2XFromBackends } from './l2x.mjs';
import { routesFromAlertmanagerConfig } from './alert-routes.mjs';
import { BACKEND_PATTERNS } from './backend-products.mjs';
import { PROMQL_KEYWORDS, extractPromqlMetricNames } from './promql.mjs';
import { symbolSlug as slug, packSlug } from './slug.mjs';

// The spec's closed vocabularies, mirrored by hand (a browser-safe module
// cannot read the schema file; tools/test-crawl-canonical.mjs pins the
// mirrors against the vendored $defs). An input outside them is defaulted
// with a warning, never copied into the manifest.
const SPEC_BINDINGS = new Set(['otel-elastic-prometheus-grafana', 'otel-grafanalabs', 'otel-aws-managed', 'otel-multi-backend', 'legacy']);
const SPEC_CRITICALITIES = new Set(['tier-1', 'tier-2', 'tier-3']);
const SLUG_MAX = 64;

// `<base><suffix>` as a spec Slug: the base is cut so the whole fits in 64 and
// never ends the base in a non-alphanumeric.
function suffixedId(base, suffix) {
  const room = SLUG_MAX - suffix.length;
  const head = String(base).slice(0, room).replace(/[^a-z0-9]+$/, '') || 'svc';
  return `${head}${suffix}`;
}

// ---------- which files of a repository a scan reads ----------
// One rule for every way a repository reaches the scanner — the CLI walker
// (tools/crawl-repo.mjs), the studio's folder picker and its drop zone — so
// a local scan reads the same files however the folder is handed over. A
// folder input lists EVERYTHING under the folder, node_modules included:
// before it used this rule it staged 75,000 files (430 MB) of a repository
// whose scannable sources are 600. Where the browser hands over the folder
// itself, walkScanFolder (below) does not list them in the first place.
export const SCAN_EXT = /\.(ya?ml|json|cjs|mjs|js|jsx|ts|tsx|py|go|java|kt|rs|cs)$/i;
export const SCAN_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const SCAN_IGNORE_DIRS = new Set([
  'node_modules', 'vendor', 'venv',
  'dist', 'build', 'out', 'target',
  '__pycache__', 'coverage',
]);

/**
 * A file or folder name a scan never reads: any dot-entry — version control,
 * CI, editor and agent state (`.git`, `.github`, `.vscode`, `.claude` with its
 * worktree copies of the whole repository) — except `.observability`, and,
 * for a folder, the dependency and build output folders.
 */
export function scanSkipsName(name, { dir = false } = {}) {
  const n = String(name ?? '');
  if (n.startsWith('.') && n !== '.observability') return true;
  return dir && SCAN_IGNORE_DIRS.has(n);
}

/**
 * Whether the file at `relPath` (forward slashes) is read: a scannable
 * extension, and no skipped folder on the way to it. `skipRoot` leaves the
 * first segment out of the check — the picked folder's own name, which is
 * the user's choice whatever it is called.
 */
export function scanReadsPath(relPath, { skipRoot = false } = {}) {
  const parts = String(relPath ?? '').split('/').filter(Boolean);
  if (!parts.length) return false;
  const file = parts[parts.length - 1];
  if (parts.slice(skipRoot ? 1 : 0, -1).some(d => scanSkipsName(d, { dir: true }))) return false;
  return !scanSkipsName(file) && SCAN_EXT.test(file);
}

/**
 * Walk a picked folder through its directory handle (the File System Access
 * API's FileSystemDirectoryHandle, or anything shaped like one: `name`,
 * `entries()` yielding `[name, handle]`, `handle.kind`). A folder a scan
 * never enters is not listed at all — where a `webkitdirectory` input hands
 * the page every file under the folder before the rule can apply (105,000
 * for a repository whose scan reads 630, most of them under node_modules).
 *
 * `onFile(relPath, fileHandle)` is awaited for each file the rule reads, in
 * name order, `relPath` rooted at the picked folder's own name (as
 * `webkitRelativePath` is). The picked folder is the user's choice whatever
 * it is called. Answers how many folders were not entered.
 */
export async function walkScanFolder(dir, onFile, prefix = String(dir?.name ?? '')) {
  const entries = [];
  for await (const [name, handle] of dir.entries()) entries.push([name, handle]);
  entries.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  let notEntered = 0;
  for (const [name, handle] of entries) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      if (scanSkipsName(name, { dir: true })) notEntered++;
      else notEntered += await walkScanFolder(handle, onFile, rel);
    } else if (!scanSkipsName(name) && SCAN_EXT.test(name)) {
      await onFile(rel, handle);
    }
  }
  return notEntered;
}

// Parse a (possibly multi-document) YAML file into a list of non-null
// documents. Prometheus rule files, Alertmanager configs and Kubernetes
// manifests are frequently shipped as multi-document streams (`---`).
function parseYamlDocs(content) {
  return parseYamlAll(content).filter(d => d && typeof d === 'object');
}

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
    if (summary.invented) summary.invented.endpoints.push(id);   // a workload image states no port
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
  // Grafana unified-alerting provisioning (`provisioning/alerting/<file>.yaml`):
  // rule groups of `title` + `data[]` rules, walked by the rules walker.
  if (/(^|\/)provisioning\/alerting\/[^/]+\.ya?ml$/.test(lower))        return 'prometheus-rules';

  // Content sniff fallback.
  let obj;
  try { obj = parseYaml(content); } catch (_) { return 'unknown'; }
  if (!obj || typeof obj !== 'object') return 'unknown';

  if (obj.groups && Array.isArray(obj.groups)
      && obj.groups.some(g => g.rules?.some(r => r && typeof r === 'object' && ('record' in r || 'alert' in r || isGrafanaManagedRule(r))))) {
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
  // Inputs the manifest spells as spec Slugs are normalized (the original is
  // kept in the summary and, for the name and the environment, in an
  // annotation); inputs with a closed vocabulary are defaulted with a warning.
  // A fresh crawl therefore never emits an invalid pack for an input the
  // operator can spell differently — the CLI refuses such flags before the
  // crawl, programmatic callers (the server, the studio) get the warning.
  const nameRaw = opts.repoName ?? 'crawled-service';
  const repoName = packSlug(nameRaw, 'crawled-service');
  const envRaw = opts.environment || 'prod';
  const environment = packSlug(envRaw, 'prod', { prefix: 'env-' });
  const ownersRaw = Array.isArray(opts.owners) ? opts.owners.map(o => String(o ?? '')) : [];
  const ownersSlugged = ownersRaw.map(o => packSlug(o, '', { prefix: 'owner-' })).filter(Boolean);
  const ownersDefaulted = ownersSlugged.length === 0;
  const owners = ownersDefaulted ? ['team-platform'] : ownersSlugged;
  const bindingIgnored = opts.binding !== undefined && opts.binding !== null && !SPEC_BINDINGS.has(opts.binding);
  const binding = !opts.binding || bindingIgnored ? 'otel-elastic-prometheus-grafana' : opts.binding;
  const criticalityIgnored = opts.criticality !== undefined && opts.criticality !== null && !SPEC_CRITICALITIES.has(opts.criticality);
  const diffScopeMode = normalizeDiffScopeMode(opts.diffScopeMode || opts.diffScope || opts.liveScope);
  // Profile detection reads the environment as given (it lowercases itself).
  const envScope = scopeFilesForEnvironment(rawFiles, envRaw);
  const files = envScope.files;
  const inputWarnings = [];
  const normalized = { name: null, environment: null, owners: [] };
  if (repoName !== String(nameRaw)) {
    normalized.name = { from: String(nameRaw), to: repoName };
    inputWarnings.push(`metadata.name '${nameRaw}' is not a spec Slug; normalized to '${repoName}' (pass --name to choose).`);
  }
  if (environment !== String(envRaw)) {
    normalized.environment = { from: String(envRaw), to: environment };
    inputWarnings.push(`environment '${envRaw}' is not a spec Slug; normalized to '${environment}'.`);
  }
  ownersRaw.forEach((raw, i) => {
    const to = packSlug(raw, '', { prefix: 'owner-' });
    if (to !== raw) {
      normalized.owners.push({ from: raw, to: to || null });
      inputWarnings.push(to ? `owner '${raw}' is not a spec Slug; normalized to '${to}'.` : `owner '${raw}' is not a spec Slug and has no usable characters; dropped.`);
    }
    if (i === ownersRaw.length - 1 && ownersDefaulted && ownersRaw.length) inputWarnings.push('no usable owner remains; the default \'team-platform\' is used.');
  });
  if (criticalityIgnored) inputWarnings.push(`criticality '${opts.criticality}' is not tier-1|tier-2|tier-3; the inferred tier is used.`);
  if (bindingIgnored) inputWarnings.push(`binding '${opts.binding}' is not a spec Binding; the default 'otel-elastic-prometheus-grafana' is used.`);

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
      requested: envRaw,
      profile: envScope.profile,
      scoped: envScope.applied,
      surfaces: envScope.surfaces,
      excluded: envScope.excluded.slice(0, 40),
    },
    comparison: {
      diffScopeMode,
    },
    discovered: {
      backends: 0, recordingRules: 0, burnRateAlerts: 0, alertRules: 0,
      metricDefinitions: 0, scrapeJobs: 0,
      pipelines: 0, dashboards: 0, alertingRoutes: 0,
      extendedSurfaces: 0,
    },
    inferred: { slis: 0, slos: 0, baselines: false, tier: null },
    warnings: [],
    omitted: { syntheticRecordingRules: [], unresolvedChannels: [], recordingRules: [], ruleIntervals: [] },
    normalized,
    // What the crawler had to INVENT (no evidence in the repository): every
    // entry below becomes a `crawler.scaffold.<symbol>` mark (see `mark`).
    invented: { endpoints: [], channels: [] },
    scaffold: [],
  };
  summary.warnings.push(...inputWarnings);
  if (envScope.applied) {
    summary.warnings.push(`Environment scope "${envScope.profile}" excluded ${envScope.excluded.length} file(s) from other deployment surfaces.`);
  }
  const evidence = {};   // <artefact-id> -> <relPath>

  const backends = [];
  const recordingRules = [];
  const burnRateAlerts = [];
  const alertRules = [];       // every alert rule found, raw, with its file and group (classified below)
  const metricDefinitions = [];
  const scrapeJobs = [];
  const dashboards = [];
  const alertingRoutes = [];
  const pipelines = { receivers: [], processors: [], exporters: { metrics: null, logs: null, traces: null } };
  // symbol → why the crawler could not know it. An ARTEFACT symbol (exactly an
  // id adapter.mjs passes to sourceOf: `baselines`, `dashboards.<id>`,
  // `slis.<id>`, …) parks that artefact as Scaffold; a FIELD symbol (an
  // artefact symbol plus `.<field>` or an index: `otel.semconv`,
  // `telemetry.backends.<id>.endpoints`, `alerting.routes[0].channels[1]`,
  // `metadata.owners`) parks nothing in the studio or in Compare and exists
  // for the conformance report (tools/lib/pack-conformance.mjs). Same grammar
  // as legacy.mjs (`crawler.scaffold.*`), library.mjs (`library.todo.*`) and
  // the fetcher (`mcp.scaffold.*`).
  const SCAFFOLD_NOTE = 'schema-required fallback; no source evidence found in selected environment';
  const scaffoldMarks = new Map();
  const mark = (symbol, note = SCAFFOLD_NOTE) => { if (!scaffoldMarks.has(symbol)) scaffoldMarks.set(symbol, note); };
  const scaffoldSymbols = { push: (...symbols) => symbols.forEach(s => mark(s)) };
  // Marks for what the crawler invents beside the schema-required stubs are
  // appended AFTER those (the existing marks keep their order and text).
  const inventedMarks = [];
  const markInvented = (symbol, note) => { inventedMarks.push([symbol, note]); };

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
        case 'prometheus-rules': walkPrometheusRules(f, recordingRules, burnRateAlerts, alertRules, metricDefinitions, evidence, summary); break;
        case 'prometheus-scrape-config': walkPrometheusScrapeConfig(f, scrapeJobs, evidence, summary); break;
        case 'actuator-metrics-config': walkActuatorMetricsConfig(f, scrapeJobs, evidence, summary, repoName); break;
        case 'metric-source-code': walkMetricSourceCode(f, metricDefinitions, evidence, summary, repoName); break;
        case 'alertmanager':     walkAlertmanager(f, alertingRoutes, evidence, summary); break;
        case 'otel-collector':   walkOtelCollector(f, pipelines, evidence, summary); break;
        case 'grafana-dashboard':walkGrafanaDashboard(f, dashboards, metricDefinitions, evidence, summary); break;
        case 'helm-template':    walkHelmTemplate(f, { backends, recordingRules, burnRateAlerts, alertRules, metricDefinitions, scrapeJobs, alertingRoutes, dashboards, pipelines, repoName }, evidence, summary); break;
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
  // The ids an alert name derives must be spec Slugs (and Refs): letter-led,
  // at most 64 characters, trailing separators trimmed.
  const repoNs = String(repoName).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'svc';
  const symbolId = (s, fallback) => {
    let out = slug(s);
    if (out && !/^[a-z]/.test(out)) out = `${repoNs}_${out}`;
    out = out.slice(0, SLUG_MAX).replace(/[^a-z0-9]+$/, '');
    return out.length >= 2 ? out : fallback;
  };
  for (const alert of burnRateAlerts) {
    const linked = recordedSloForExpr(alert.expr, (id) => sloMap.has(id));
    if (linked) { alert.slo = linked; continue; }

    if (haveRecordedSlis) { alert._drop = true; continue; }

    const sloId = symbolId(alert.slo, `${repoNs}_slo`);
    alert.slo = sloId;
    if (!sloMap.has(sloId)) {
      const sliId = symbolId(sloId.replace(/_99|_999|_995|_slo$/i, '') || sloId, `${repoNs}_sli`);
      sloMap.set(sloId, {
        id: sloId,
        sli: sliId,
        objective: 0.99,
        window: '30d',
        error_budget_policy: 'ref:platform/default-budget',
      });
      summary.inferred.slos++;
      markInvented(`slos.${sloId}`, 'derived from the alert name only; good/total, objective and window are defaults');
      if (!sliMap.has(sliId)) {
        sliMap.set(sliId, {
          id: sliId,
          type: 'ratio',
          description: `Auto-derived from burn-rate alert "${sloId}" — REPLACE WITH REAL QUERY.`,
          good:  `sum(rate(http_requests_total{status_code!~"5..",service="${repoName}"}[5m]))`,
          total: `sum(rate(http_requests_total{service="${repoName}"}[5m]))`,
        });
        summary.inferred.slis++;
        markInvented(`slis.${sliId}`, 'derived from the alert name only; good/total, objective and window are defaults');
      }
    }
  }

  // Take the operational (non-SLO) alerts out of the burn-rate policy, then
  // fold the remaining burn-rate alerts that now share a recording-rule SLO
  // into one entry per SLO, unioning their windows so the emitted policy
  // stays valid.
  for (let i = burnRateAlerts.length - 1; i >= 0; i--) {
    if (burnRateAlerts[i]._drop) burnRateAlerts.splice(i, 1);
  }
  mergeBurnAlertsBySlo(burnRateAlerts);

  // The operational alerts are not lost: spec 1.4 keeps them in
  // spec.alerting.rules, one entry per rule with its EXACT name (the key a
  // live Grafana or ruler listing is reconciled on), its expression, wait,
  // labels, annotations, the engine that evaluates it and where it was read
  // from (sli-inference.mjs operationalAlertRule — the reading the live
  // fetcher applies to a ruler's rules). The classification is the one
  // above, exactly: a rule whose expression references a recorded SLO
  // series is a burn-rate alert and stays in the policy; every other rule
  // is operational, when the repo records SLIs at all — a repo with no
  // recording rules still reads every alert as an SLO contract (the tier-3
  // fallback), and then declares no operational rules.
  const ruleMeta = new Map(alertRules.map(r => [r.rule, r]));
  const operational = haveRecordedSlis
    ? operationalAlertRules(alertRules.map(r => r.rule), (id) => sloMap.has(id), {
      engineOf: (rule) => alertRuleEngine(rule, ruleMeta.get(rule)?.relPath),
      sourceOf: (rule) => ruleMeta.get(rule)?.source,
    })
    : { kept: [], skipped: [] };
  summary.discovered.alertRules = operational.kept.length;
  if (operational.kept.length) {
    const names = operational.kept.map(r => r.name);
    const shown = names.slice(0, 8).join(', ') + (names.length > 8 ? `, … (${names.length - 8} more)` : '');
    summary.warnings.push(`${operational.kept.length} operational alert rule(s) kept in alerting.rules — not SLO burn-rate alerts (no recorded-ratio reference): ${shown}. ${burnRateAlerts.length} burn-rate alert(s) in policy.burn_rate_alerts.`);
  }
  if (operational.skipped.length) {
    summary.warnings.push(`${operational.skipped.length} alert rule(s) state no expression and are not declared: ${operational.skipped.slice(0, 8).join(', ')}.`);
  }
  operational.kept.forEach((r, i) => { evidence[`RULE-${i + 1}`] = r.source; });


  if (summary.omitted.recordingRules.length) {
    const names = summary.omitted.recordingRules.map(r => r.name);
    summary.warnings.push(`${names.length} recording rule(s) are not named <service>:<metric>:<op> and cannot be declared in spec.queries.recording_rules: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''}. Recorded in crawler.omitted.recording_rules; their expressions still feed the metric inventory.`);
  }
  if (summary.omitted.ruleIntervals.length) {
    summary.warnings.push(`${summary.omitted.ruleIntervals.length} rule-group interval(s) are not a spec Duration and are left out: ${summary.omitted.ruleIntervals.slice(0, 8).map(o => `${o.group}=${o.value} (${o.source})`).join(', ')}.`);
  }
  summary.discovered.recordingRulesOmitted = summary.omitted.recordingRules.length;

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
    markInvented('slis.service_availability', 'stub; no recording rule or SLO reference found — REPLACE WITH REAL QUERY');
    markInvented('slos.service_availability_99', 'stub; no recording rule or SLO reference found — REPLACE WITH REAL QUERY');
    summary.warnings.push('No burn-rate alerts found — emitted stub SLI/SLO that must be replaced.');
  }

  // ----- minimum policy: every SLO needs ≥1 burn-rate alert with ≥2 windows -----
  // If the repo had no rules at all we synthesize a Google-SRE-style
  // two-window alert per stubbed SLO so the result satisfies the spec's
  // minItems: 2 constraint on windows.
  if (burnRateAlerts.length === 0) {
    for (const slo of sloMap.values()) {
      burnRateAlerts.push({ slo: slo.id, windows: defaultBurnWindows() });
    }
    summary.warnings.push('Synthesized two-window burn-rate alerts for stub SLOs (Google SRE pattern).');
  } else {
    // Repo HAD recording-rule-style alerts. Translate them to the spec's
    // burn-rate shape with conservative defaults.
    for (const a of burnRateAlerts) {
      if (!a.windows || a.windows.length < 2) a.windows = defaultBurnWindows();
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
    const stubDashboardId = suffixedId(repoName, '-overview');
    dashboards.push({
      id: stubDashboardId,
      provider: { kind: 'grafana' },
      folder: repoName,
      source: `file://dashboards/${stubDashboardId}.json`,
    });
    scaffoldSymbols.push(`dashboards.${stubDashboardId}`);
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
    summary.warnings.push(`${n} alerting channel(s) have an unresolved \${VAR} placeholder (deploy-time substitution) for an address. Each is declared as \`unresolved:<VAR>\` — the channel exists, its address is not in the repository — and recorded in the crawler.unresolved.* annotations; declare a literal URL to pin the address.`);
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
  const criticality = opts.criticality && !criticalityIgnored ? opts.criticality : tier;
  const l2x = materializeL2XFromBackends(backends);
  summary.discovered.extendedSurfaces = l2x.evidence.length;
  const syntheticCheckId = suffixedId(repoName, '-health-canary');
  scaffoldSymbols.push(`validation.synthetic_checks.${syntheticCheckId}`);

  // ----- dashboards: the provider version is the Grafana the repository
  // deploys (its image tag), never the dashboard's own revision counter; two
  // files with the same uid get distinct ids -----
  const grafana = backends.find(b => b.product === 'grafana' && b.version?.declared);
  const seenDashIds = new Set();
  const dashDupes = new Map();
  for (const d of dashboards) {
    if (d.provider?.kind === 'grafana') {
      if (grafana) d.provider.version = grafana.version.declared;
      else delete d.provider.version;
    }
    if (seenDashIds.has(d.id)) {
      const base = d.id;
      let n = 2, next = suffixedId(base, `-${n}`);
      while (seenDashIds.has(next)) next = suffixedId(base, `-${++n}`);
      dashDupes.set(base, (dashDupes.get(base) || [base]).concat(next));
      d.id = next;
    }
    seenDashIds.add(d.id);
  }
  for (const [base, ids] of dashDupes) {
    summary.warnings.push(`dashboard uid '${base}' appears in ${ids.length} files; declared as ${ids.join(', ')}.`);
  }

  // ----- every value the crawler invented, marked -----
  for (const id of summary.invented.endpoints) {
    markInvented(`telemetry.backends.${id}.endpoints`, 'port not stated in the repository; http://<product>:80 assumed');
  }
  for (const ch of summary.invented.channels) {
    markInvented(`alerting.routes[${ch.routeIndex}].channels[${ch.channelIndex}]`, `address invented: the Alertmanager ${ch.kind} receiver '${ch.receiver ?? 'oncall'}' has no spec channel or states no address`);
  }
  if (ownersDefaulted) markInvented('metadata.owners', "default owner 'team-platform'; no source evidence (pass --owners)");
  // The SDK languages are read off the repository's source files (test paths
  // aside); only a repository with none keeps the default, marked.
  const sdkLanguages = inferSdkLanguages(files);
  for (const field of ['semconv', 'resource_attributes', ...(sdkLanguages.length ? [] : ['sdk.languages']), 'sdk.sampling', 'sdk.propagators']) {
    markInvented(`otel.${field}`, 'default; the repository states no SDK configuration');
  }
  for (const [symbol, note] of inventedMarks) mark(symbol, note);
  summary.scaffold = [...scaffoldMarks.keys()];

  const scaffoldAnnotations = {};
  for (const [symbol, note] of scaffoldMarks) {
    scaffoldAnnotations[`crawler.scaffold.${symbol}`] = note;
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
        'crawler.scaffoldCount':   String(scaffoldMarks.size),
        // An input that was not a spec Slug or not in a spec vocabulary — the
        // original name and environment are kept here (owners only in the
        // summary: an owner string may be an address).
        ...(normalized.name ? { 'crawler.nameNormalizedFrom': normalized.name.from } : {}),
        ...(normalized.environment ? { 'crawler.environmentNormalizedFrom': normalized.environment.from } : {}),
        ...(criticalityIgnored ? { 'crawler.criticalityIgnored': String(opts.criticality) } : {}),
        ...(bindingIgnored ? { 'crawler.bindingIgnored': String(opts.binding) } : {}),
        // Recording rules the spec cannot declare (name outside
        // <service>:<metric>:<op>) — evidence, never silently dropped.
        ...(summary.omitted.recordingRules.length ? {
          'crawler.omittedRecordingRuleCount': String(summary.omitted.recordingRules.length),
          'crawler.omitted.recording_rules': annotationJson(summary.omitted.recordingRules),
        } : {}),
        // Channels whose address is an unresolved ${VAR} placeholder — evidence
        // of declared intent the crawler could not resolve at crawl time.
        ...(summary.omitted.unresolvedChannels.length ? {
          'crawler.unresolvedChannelCount': String(summary.omitted.unresolvedChannels.length),
          'crawler.unresolved.alerting': summary.omitted.unresolvedChannels
            .map(u => `${u.severity || '?'}:${u.value}${u.source ? ` (${u.source})` : ''}`).join(' · '),
        } : {}),
        ...(sdkLanguages.length ? { 'crawler.discovered.sdk_languages': annotationJson(sdkLanguages) } : {}),
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
          languages: sdkLanguages.length ? sdkLanguages : ['go'],
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
      alerting: {
        routes: alertingRoutes,
        // Absent means "no operational rules" (spec 1.4): the key appears only when there are some.
        ...(operational.kept.length ? { rules: operational.kept } : {}),
      },
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
      || (metricSourcePathLooksRelevant(p) && /(?:metric|prometheus|counter|histogram|gauge|summary)[\s\S]{0,120}['"][A-Za-z_:][A-Za-z0-9_:.-]+['"]/i.test(content))
      || (!isTestPath(p) && EXPOSITION_TYPE_RE.test(content));
}

// The text exposition format, written out by hand: a script that builds
// `# TYPE <name> <type>` lines and pushes them to a Pushgateway declares
// those metrics just as a client library call does. Not read from test
// files, where such lines are sample input, not a declaration.
const EXPOSITION_TYPE_RE = /#\s*TYPE\s+[A-Za-z_:][A-Za-z0-9_:]*\s+(?:counter|gauge|histogram|summary|untyped)\b/;

// The OTel SDK languages a repository's source files imply (the schema's
// enum: java, node, python, go, dotnet, rust, …), test paths excluded; sorted,
// unique. A heuristic over extensions — a Go service with a scripts/*.js
// helper reports both — stated as such in the DOWNSTREAM table.
const SDK_LANGUAGE_BY_EXT = [
  [/\.go$/i, 'go'], [/\.(java|kt)$/i, 'java'], [/\.py$/i, 'python'],
  [/\.(js|mjs|cjs|jsx|ts|tsx)$/i, 'node'], [/\.rs$/i, 'rust'], [/\.cs$/i, 'dotnet'],
];
function inferSdkLanguages(files) {
  const out = new Set();
  for (const relPath of files.keys()) {
    const p = normalizeRepoPath(relPath);
    if (isTestPath(p)) continue;
    for (const [re, lang] of SDK_LANGUAGE_BY_EXT) if (re.test(p)) { out.add(lang); break; }
  }
  return [...out].sort();
}

function isTestPath(relPath) {
  return /(^|\/)(tests?|__tests__|specs?|fixtures?|testdata)(\/|$)|\.(?:test|spec)\.[a-z]+$|_test\.[a-z]+$/i.test(normalizeRepoPath(relPath));
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
  if (['src', 'app', 'lib', 'server'].includes(parts[0])) return fallback;
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

  if (!isTestPath(f.relPath)) {
    const helps = new Map();
    for (const m of text.matchAll(/#\s*HELP\s+([A-Za-z_:][A-Za-z0-9_:]*)\s+([^\n`'"\\]+)/g)) helps.set(m[1], m[2].trim());
    for (const m of text.matchAll(/#\s*TYPE\s+([A-Za-z_:][A-Za-z0-9_:]*)\s+(counter|gauge|histogram|summary|untyped)\b/g)) {
      addMetricDefinition(metricDefinitions, evidence, summary, {
        name: m[1],
        type: m[2],
        help: helps.get(m[1]) || '',
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
  // A product rule only: the Solace exporters prefix their metrics `solace_`
  // when the path or the source literally says so.
  const p = normalizeRepoPath(relPath);
  if (/solace/.test(p) || /solace/i.test(text)) return 'solace_';
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
  const { backends, recordingRules, burnRateAlerts, alertRules, metricDefinitions, scrapeJobs, alertingRoutes, dashboards, pipelines, repoName } = buckets;
  const route = (kind, sub) => {
    switch (kind) {
      case 'prometheus-rules': walkPrometheusRules(sub, recordingRules, burnRateAlerts, alertRules, metricDefinitions, evidence, summary); return true;
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
        if (!endpoint && summary.invented) summary.invented.endpoints.push(id);
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

// A LogQL condition: a stream selector (`{app="x"}`) that is not a metric's
// label matcher — it opens the expression or follows an operator / paren —
// and is followed by a line filter (`|=`, `|~`, `!=`, `!~`), a parser stage
// (`| json`, `| logfmt`, …) or a range (`[5m]`), as `rate({app="x"}[5m])` is.
const LOGQL_STAGE_RE = /\{[^}]*\}\s*(?:\|[=~]|![=~]|\|\s*(?:json|logfmt|pattern|regexp|unpack|unwrap|line_format|label_format|drop|keep|decolorize)\b)/;
const LOGQL_RANGE_RE = /(?:^|[(\s,])\{[^}]*\}\s*\[/;
function looksLikeLogQL(expr) {
  const e = String(expr || '');
  return LOGQL_STAGE_RE.test(e) || LOGQL_RANGE_RE.test(e);
}

// The engine that evaluates an alert rule, in the Product registry's words
// (spec 1.4 $defs/AlertEngine): a Grafana-managed rule by its shape
// (`title` + `data[]`), a Loki rule by the path it ships under or by its
// LogQL, everything else the Prometheus rule-file format — `prometheus`,
// the default, since a rule file cannot tell a Prometheus ruler from a
// Mimir, Thanos or VictoriaMetrics one (the backends do).
function alertRuleEngine(rule, relPath) {
  if (isGrafanaManagedRule(rule)) return 'grafana';
  if (/(^|[/_.-])loki([/_.-]|$)/i.test(String(relPath || '')) || looksLikeLogQL(alertRuleExpr(rule))) return 'loki';
  return 'prometheus';
}

// The PromQL a Grafana unified-alerting rule evaluates. A provisioned rule
// carries no `expr`; its queries sit in `data[].model`, one entry per
// datasource query or expression node. The model is a mapping in Grafana's
// own export and a JSON string in files written by other tooling (the HTTP
// provisioning API, Terraform). Returns the first query model's `expr`, or
// null when the rule states none. Throws when a model is a JSON string that
// does not parse: that rule cannot be read, the caller decides what to do.
function grafanaRuleExpr(rule) {
  if (!Array.isArray(rule?.data)) return null;
  for (const item of rule.data) {
    let model = item?.model;
    if (typeof model === 'string') {
      try { model = JSON.parse(model); }
      catch (e) { throw new Error(`model JSON could not be parsed (${e.message})`, { cause: e }); }
    }
    if (model && typeof model.expr === 'string' && model.expr.trim()) return model.expr;
  }
  return null;
}

function walkPrometheusRules(f, recordingRules, burnRateAlerts, alertRules, metricDefinitions, evidence, summary) {
  // A rule that cannot be read is skipped on its own; the file and its other
  // rules survive, and one warning per file says how many were lost and why.
  let ruleCount = 0;
  const skipped = [];
  for (const obj of parseYamlDocs(f.content)) {
    if (!Array.isArray(obj.groups)) continue;
    for (const group of obj.groups) {
      for (const rule of group.rules || []) {
        ruleCount++;
        try {
          walkPrometheusRule(f, group, rule, recordingRules, burnRateAlerts, alertRules, metricDefinitions, evidence, summary);
        } catch (e) {
          skipped.push(e?.message || String(e));
        }
      }
    }
  }
  if (skipped.length) {
    const reason = skipped.every(m => /^model JSON could not be parsed/.test(m))
      ? 'model JSON could not be parsed'
      : skipped[0];
    summary.warnings.push(`Skipped ${skipped.length} of ${ruleCount} alert rule(s) in ${f.relPath}: ${reason}`);
  }
}

function walkPrometheusRule(f, group, rule, recordingRules, burnRateAlerts, alertRules, metricDefinitions, evidence, summary) {
  if (rule.record) {
    // The Prometheus form (`record: <name>`, `expr`) and the Grafana
    // unified-alerting recording form (`record: { metric, from }`, the
    // expression in `data[].model.expr`).
    const name = rule.record && typeof rule.record === 'object' ? String(rule.record.metric ?? '') : String(rule.record);
    const grafanaExpr = typeof rule.expr === 'string' ? null : grafanaRuleExpr(rule);
    const expr = typeof rule.expr === 'string' ? rule.expr : grafanaExpr !== null ? grafanaExpr : String(rule.expr || '');
    const origin = `${f.relPath}#${group.name || '_'}/${name}`;
    // The expressions feed the metric inventory whether or not the rule can
    // be declared: evidence is never lost.
    addRecordingRuleOutputMetric(metricDefinitions, evidence, summary, { ...rule, record: name }, {
      origin,
      expr,
      usedBy: `recording_rule:${name}`,
    });
    addPromqlMetricReferences(metricDefinitions, evidence, summary, expr, {
      kind: 'recording-rule',
      name,
      origin,
      usedBy: `recording_rule:${name}`,
    });
    // The spec declares `<service>:<metric>:<op>` names only (the reading the
    // live fetcher already applies); any other name is recorded as omitted.
    if (!isSpecRecordingRuleName(name)) {
      summary.omitted.recordingRules.push({ name, source: origin });
      return;
    }
    const id = `QRY-${recordingRules.length + 1}-${slug(name).slice(0, 16)}`;
    const entry = { name, expr };
    if (group.interval !== undefined && group.interval !== null && group.interval !== '') {
      // A string the repository wrote is kept verbatim when it is a spec
      // Duration; a bare number is seconds (`30` → `30s`).
      const text = typeof group.interval === 'number' ? canonicalRuleDuration(group.interval) : String(group.interval).trim();
      if (text && SPEC_DURATION_RE.test(text)) entry.interval = text;
      else summary.omitted.ruleIntervals.push({ group: group.name || '_', value: String(group.interval), source: f.relPath });
    }
    recordingRules.push(entry);
    evidence[id] = origin;
    summary.discovered.recordingRules++;
  } else if (rule.alert || rule.title) {
    // `rule.alert` is the Prometheus form; `rule.title` is the Grafana
    // unified-alerting form (provisioned alert rules). Both target an
    // SLO we synthesize from the alert name.
    // The entry an alert starts as, and later the SLO it binds to, are
    // the shared derivation (sli-inference.mjs) the live fetcher applies
    // to the ruler's rules: one rule set, one policy.
    const grafanaExpr = typeof rule.expr === 'string' ? null : grafanaRuleExpr(rule);
    const read = grafanaExpr === null ? rule : { ...rule, expr: grafanaExpr };
    const candidate = burnCandidateFromAlertRule(read);
    const { alertName, expr } = candidate;
    // Every alert rule that reads is kept raw as well, with where it was
    // read from: the ones that turn out to guard no SLO are declared in
    // alerting.rules (crawlFiles), name for name. A rule skipped above
    // (its model could not be read) is not declared either.
    alertRules.push({ rule: read, relPath: f.relPath, source: `${f.relPath}#${group.name || '_'}/${alertName}` });
    if (!burnRateAlerts.some(a => a.slo === candidate.slo)) {
      burnRateAlerts.push(candidate);
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

function walkPrometheusScrapeConfig(f, scrapeJobs, evidence, summary) {
  for (const obj of parseYamlDocs(f.content)) {
    if (!Array.isArray(obj?.scrape_configs)) continue;
    for (const cfg of obj.scrape_configs) {
      const job = String(cfg?.job_name || '').trim();
      if (!job) continue;
      // Promtail and Alloy use the same `scrape_configs` / `job_name` keys
      // to say which LOG FILES to tail. Such an entry is not a metrics
      // scrape job and never appears among a metrics store's targets;
      // declaring it made it read "not live" on every platform.
      if (isLogScrapeConfig(cfg, obj)) {
        summary.discovered.logScrapeConfigs = (summary.discovered.logScrapeConfigs || 0) + 1;
        continue;
      }
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

// A log-collection scrape config (Promtail, Alloy's loki.source): it has
// pipeline stages, or points at files through the `__path__` label, or
// sits in a document that ships to log `clients` from saved `positions`.
function isLogScrapeConfig(cfg, doc) {
  if (Array.isArray(cfg?.pipeline_stages)) return true;
  if (doc && typeof doc === 'object' && (Array.isArray(doc.clients) || doc.positions)) return true;
  const pathLabel = (v) => v === '__path__';
  if ((cfg?.relabel_configs || []).some(r => pathLabel(r?.target_label))) return true;
  return (cfg?.static_configs || []).some(sc => sc?.labels && Object.keys(sc.labels).some(pathLabel));
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

function walkAlertmanager(f, routes, evidence, summary) {
  for (const obj of parseYamlDocs(f.content)) {
    if (!obj?.route) continue;
    // Walk top-level route + its children. Each route → one entry per
    // severity. The reading itself is shared with the live fetcher
    // (alert-routes.mjs): the config a repo ships and the config a running
    // Alertmanager reports give the same routes.
    const invented = [];
    const collected = routesFromAlertmanagerConfig(obj, {
      unresolved: summary.omitted.unresolvedChannels,
      invented,
      source: f.relPath,
    });
    // Positions are relative to this config's routes; the bucket may already
    // hold routes from another file.
    for (const ch of invented) {
      summary.invented.channels.push({ ...ch, routeIndex: routes.length + ch.routeIndex, source: f.relPath });
    }
    for (const r of collected) {
      const id = `ALR-${routes.length + 1}`;
      routes.push(r);
      evidence[id] = `${f.relPath}#route/${r.severity || 'default'}`;
      summary.discovered.alertingRoutes++;
    }
  }
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
  if (/^prometheus/i.test(name))            return 'prometheusremotewrite';
  if (/^otlp$|^otlphttp$/i.test(name))      return 'otlp';
  if (/^elasticsearch$/i.test(name))         return 'elasticsearch';
  if (/^jaeger|tempo$/i.test(name))          return 'jaeger';
  if (/^loki$/i.test(name))                  return 'loki';
  return name;
}

// A dashboard's spec Slug id: the uid, else the title, mapped as before
// (lowercase, runs outside [a-z0-9-] → '-', edges trimmed, cut at 60), the
// first non-empty result wins (a uid of `--` yields nothing; the title does);
// trailing separators trimmed AFTER the cut; `d-` in front when the first
// character is not a letter. null when neither yields anything — the caller
// numbers the dashboard. The ONE dashboard id rule a crawled pack and a live
// snapshot share (tools/fetch-live-pack.mjs, snapshot mode), so the same
// Grafana uid pairs by `definedId` whichever side read it.
export function dashboardSpecId(dash) {
  let id = '';
  for (const candidate of [dash?.uid, dash?.title]) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    id = String(candidate).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/[^a-z0-9]+$/, '');
    if (id) break;
  }
  if (!id) return null;
  return /^[a-z]/.test(id) ? id : `d-${id}`;
}

function dashboardId(dash, dashboards) {
  return dashboardSpecId(dash) ?? `dash-${dashboards.length + 1}`;
}

function walkGrafanaDashboard(f, dashboards, metricDefinitions, evidence, summary) {
  const dash = JSON.parse(f.content);
  const id = dashboardId(dash, dashboards);
  const panels = dashboardPromqlQueries(dash);
  // provider.schemaVersion has a spec minimum (30): an older dashboard keeps
  // its value in the free-form params instead of failing the schema.
  // A dashboard that states no schemaVersion declares none (the key is
  // optional); one below the minimum keeps its value in params. The
  // provider version is filled in by crawlFiles from the Grafana image the
  // repository deploys — the dashboard's own `version` is a revision counter.
  const sv = dash.schemaVersion;
  const stated = typeof sv === 'number';
  const declaredSchemaVersion = stated && Number.isInteger(sv) && sv >= 30 ? sv : null;
  if (stated && declaredSchemaVersion === null) {
    summary.warnings.push(`dashboard ${id}: schemaVersion ${sv} is below the spec minimum (30) and is not declared; kept in params.schema_version.`);
  }
  dashboards.push({
    id,
    provider: {
      kind: 'grafana',
      ...(declaredSchemaVersion !== null ? { schemaVersion: declaredSchemaVersion } : {}),
    },
    folder: dash.tags?.[0] || 'crawled',
    source: `file://${f.relPath}`,
    params: {
      title: dash.title || id,
      uid: dash.uid || '',
      panel_count: countDashboardPanels(dash.panels),
      query_panel_count: panels.length,
      panels,
      ...(stated && declaredSchemaVersion === null ? { schema_version: sv } : {}),
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
