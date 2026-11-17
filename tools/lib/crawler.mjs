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

import { LIFECYCLE_ANNOTATION, readLifecycleBlock, sameDeployment } from './lifecycle.mjs';
import { parse as parseYaml, parseAll as parseYamlAll, emit as emitYaml, withAliasBudget, apartFromAliasBudget } from './mini-yaml.mjs';
import {
  inferSlisFromRecordingRules, ruleNameToSliId, ruleNameToSloId,
  burnCandidateFromAlertRule, recordedSloForExpr, mergeBurnAlertsBySlo, defaultBurnWindows,
  operationalAlertRules, sourceRuleTerms, isGrafanaManagedRule, alertRuleExpr, grafanaRuleFacts,
  isSpecRecordingRuleName, canonicalRuleDuration, SPEC_DURATION_RE,
} from './sli-inference.mjs';
import { materializeL2XFromBackends } from './l2x.mjs';
import { routesFromAlertmanagerConfig } from './alert-routes.mjs';
import { BACKEND_PATTERNS } from './backend-products.mjs';
import { PROMQL_KEYWORDS, extractPromqlMetricNames } from './promql.mjs';
import { symbolSlug as slug, packSlug } from './slug.mjs';
import { detectChaos, chaosExperimentsFrom, chaosControlSummary, chaosPassReads } from './chaos-detect.mjs';
import { isRepoPackPath, readRepoPack } from './repo-pack.mjs';
import {
  DYNAMIC_FAMILY_LIMITS, compileMetricFamilyPattern, isMetricsManifestPath, isExpositionSnapshotPath, isTestOrFixturePath, parseExposition, readMetricsManifest, safeSourceUrl,
  resolveExporterCatalogue, asResolvedCatalogue, mayBeExporterConfig, matchExporterConfig, inferExporterFamilies,
} from './exporter-metrics.mjs';
import { createGitignore } from './gitignore.mjs';

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
// `.prom` / `.metrics`: a saved /metrics response (an exposition snapshot).
export const SCAN_EXT = /\.(ya?ml|json|cjs|mjs|js|jsx|ts|tsx|py|go|java|kt|rs|cs|prom|metrics)$/i;
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
 * A YAML or JSON file whose name says it holds secrets — `values-secrets.yaml`,
 * `secret.yaml`, `db-secrets.json` — is never read, through any door and
 * whatever git says about it: a Helm secrets overlay or a Kubernetes Secret
 * carries real keys and passwords, and no observability artefact lives in
 * one. Every door names it in its skipped list (SCAN_WHY.secret).
 */
export const SCAN_SECRET_FILE = /^[^/]*secret[^/]*\.(ya?ml|json)$/i;
export function scanRefusesName(name) {
  return SCAN_SECRET_FILE.test(String(name ?? ''));
}

/**
 * Why a door leaves out a file, in one wording for every door (the server's
 * Folder walk and its GitHub and Azure DevOps reads, the CLI walker, the
 * studio's folder, drop and .zip readers): each skipped list is
 * [{ path, why }].
 */
const mbOf = (n) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
export const SCAN_WHY = Object.freeze({
  secret: 'its name says it holds secrets, which a scan never reads',
  gitignored: 'git ignores it (.gitignore)',
  gitignoredFolder: 'git ignores this folder (.gitignore)',
  tooLarge: (limit = SCAN_MAX_FILE_BYTES) => `it is larger than ${mbOf(limit)}`,
  totalCap: (limit) => `the scan stops at ${mbOf(limit)} in all`,
  notText: 'it is not UTF-8 text',
  // A file past a host read's file cap (server/github-crawl.mjs HOST_READ_CAPS): named in a record's cappedFiles.
  fileCap: (n) => `past the read's ${Number.isInteger(n) && n > 0 ? `${n}-file` : 'file'} cap (the likely artefacts are read first)`,
});

/**
 * What a skipped entry's `why` says of the file, by the one wording every
 * door writes (SCAN_WHY, a reader's "it could not be … (…)"):
 *   'on-purpose'  a rule left it out — its name says it holds secrets, git
 *                 ignores it or a folder on the way to it, or it lies in
 *                 another org's part of the workspace: never a loss;
 *   'lost'        the read failed — "it could not be downloaded (…)", "…
 *                 read (…)", "… listed (…)" (a host refused or dropped it, the
 *                 read's budget ran out, the disk would not give it): the scan
 *                 is partial, and a Run says so;
 *   'limit'       anything else — too large, past the total, not text, an
 *                 archive entry the reader cannot open: counted as not read,
 *                 the same on every read of the same files, never partial.
 * A wording nobody planned for is a limit, so it never stops a Run for ever.
 */
export const SCAN_SKIP_KINDS = Object.freeze(['on-purpose', 'lost', 'limit']);
const SKIP_LOST = /^it could not be (?:downloaded|read|listed) \(/;
const SKIP_GITIGNORED_FOLDER = /^git ignores the folder .+\/ \(\.gitignore\)$/;
const SKIP_REFUSED_PART = /^it (?:belongs to another org's part of the workspace|is not a path on a local drive)\b/;
export function scanSkipKind(why) {
  const w = String(why ?? '');
  if (w === SCAN_WHY.secret || w === SCAN_WHY.gitignored || w === SCAN_WHY.gitignoredFolder || SKIP_GITIGNORED_FOLDER.test(w) || SKIP_REFUSED_PART.test(w)) return 'on-purpose';
  if (SKIP_LOST.test(w)) return 'lost';
  return 'limit';
}

/**
 * The deployment surfaces an environment may read alone (a service
 * environment's explicit setting, server/service-admin.mjs envSurfaces; the
 * Run passes it to crawlFiles as `surface`), each mapped onto the filter's
 * profile, and the words a sentence names it by. A surface is never named by
 * an environment's name: "prod" is a name, not a surface.
 */
export const DEPLOYMENT_SURFACES = Object.freeze({ kubernetes: 'prod', eks: 'eks', 'local-kubernetes': 'local-k8s', compose: 'local-docker' });
export const DEPLOYMENT_SURFACE_LABELS = Object.freeze({ kubernetes: 'Kubernetes and Helm', eks: 'Amazon EKS', 'local-kubernetes': 'local Kubernetes', compose: 'Docker Compose' });
const SURFACE_OF_PROFILE = Object.freeze(Object.fromEntries(Object.entries(DEPLOYMENT_SURFACES).map(([id, profile]) => [profile, id])));
const surfaceWords = (id) => DEPLOYMENT_SURFACE_LABELS[id] || String(id);

// The folder and extension rule alone (scanReadsPath without the refusals).
function scanTakesParts(parts, skipRoot) {
  if (!parts.length) return false;
  const file = parts[parts.length - 1];
  if (parts.slice(skipRoot ? 1 : 0, -1).some(d => scanSkipsName(d, { dir: true }))) return false;
  return !scanSkipsName(file) && SCAN_EXT.test(file);
}

/**
 * Whether the file at `relPath` (forward slashes) is read: a scannable
 * extension, no skipped folder on the way to it, and not a secrets file
 * (scanRefusesName). `skipRoot` leaves the first segment out of the check —
 * the picked folder's own name, which is the user's choice whatever it is
 * called.
 */
export function scanReadsPath(relPath, { skipRoot = false } = {}) {
  const parts = String(relPath ?? '').split('/').filter(Boolean);
  return scanTakesParts(parts, skipRoot) && !scanRefusesName(parts[parts.length - 1]);
}

/**
 * Why a scan leaves out a file its folder and extension rule would read —
 * git ignores it or a folder on the way to it (`gitignore`: a
 * tools/lib/gitignore.mjs createGitignore() matcher over the scanned
 * folder's own .gitignore files, paths relative to that folder), or it is a
 * secrets file — or null: it is read, or it is not a file a scan looks at in
 * the first place (another extension, under node_modules …), which no
 * skipped list names. `skipRoot` as scanReadsPath's.
 */
export function scanRefusal(relPath, { skipRoot = false, gitignore = null } = {}) {
  const parts = String(relPath ?? '').split('/').filter(Boolean);
  if (!scanTakesParts(parts, skipRoot)) return null;
  const inner = (skipRoot ? parts.slice(1) : parts).join('/');
  const at = gitignore ? gitignore.ignoredAt(inner) : null;
  if (at) return at === inner ? SCAN_WHY.gitignored : `git ignores the folder ${at}/ (.gitignore)`;
  return scanRefusesName(parts[parts.length - 1]) ? SCAN_WHY.secret : null;
}

// The matcher itself, for a host that walks a folder its own way (the
// studio's drop zone).
export { createGitignore };

/**
 * Whether a flat list's `relPath` (every file under a folder: a
 * webkitdirectory FileList, a .zip's entries) is a .gitignore a scan honours
 * — one in a folder the scan enters. `skipRoot` as scanReadsPath's.
 */
export function scanHonoursGitignore(relPath, { skipRoot = false } = {}) {
  const parts = String(relPath ?? '').split('/').filter(Boolean);
  if (parts[parts.length - 1] !== '.gitignore') return false;
  return !parts.slice(skipRoot ? 1 : 0, -1).some(d => scanSkipsName(d, { dir: true }));
}

/**
 * A gitignore matcher (tools/lib/gitignore.mjs) over a flat list's
 * .gitignore files — `pairs` [{ path, text }], the paths as the list gives
 * them — parents before their children, for scanRefusal's `gitignore`.
 * `skipRoot` as scanReadsPath's: the picked folder's own name is no folder
 * of the repository.
 */
export function gitignoreOf(pairs, { skipRoot = false } = {}) {
  const gitignore = createGitignore();
  const depth = (p) => p.split('/').length;
  const honoured = (Array.isArray(pairs) ? pairs : [])
    .filter((p) => p && typeof p.text === 'string' && scanHonoursGitignore(p.path, { skipRoot }))
    .map((p) => ({ path: String(p.path).split('/').filter(Boolean).join('/'), text: p.text }))
    .sort((x, y) => depth(x.path) - depth(y.path) || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  for (const { path, text } of honoured) {
    const parts = path.split('/');
    gitignore.add(parts.slice(skipRoot ? 1 : 0, -1).join('/'), text);
  }
  return gitignore;
}

/**
 * Walk a picked folder through its directory handle (the File System Access
 * API's FileSystemDirectoryHandle, or anything shaped like one: `name`,
 * `entries()` yielding `[name, handle]`, `handle.kind`, a file handle's
 * `getFile()`). A folder a scan never enters is not listed at all — where a
 * `webkitdirectory` input hands the page every file under the folder before
 * the rule can apply (105,000 for a repository whose scan reads 630, most of
 * them under node_modules).
 *
 * `onFile(relPath, fileHandle)` is awaited for each file the rule reads, in
 * name order, `relPath` rooted at the picked folder's own name (as
 * `webkitRelativePath` is). The picked folder is the user's choice whatever
 * it is called. Its .gitignore files are honoured — a folder git ignores is
 * not entered — and a file or folder the rule would read but git ignores, or
 * a secrets file, goes to `onSkip(relPath, why)` instead (SCAN_WHY's words; a
 * folder's path ends in `/`). Answers how many folders were not entered for
 * being dependency, build or hidden folders.
 */
export async function walkScanFolder(dir, onFile, prefix = String(dir?.name ?? ''), { onSkip = null } = {}) {
  const gitignore = createGitignore();
  const root = prefix;
  const inner = (p) => (root ? p.slice(root.length + 1) : p);
  async function walk(d, pre) {
    const entries = [];
    for await (const [name, handle] of d.entries()) entries.push([name, handle]);
    entries.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    const ignoreFile = entries.find(([name, handle]) => name === '.gitignore' && handle.kind !== 'directory');
    if (ignoreFile) {
      try { gitignore.add(inner(pre), await (await ignoreFile[1].getFile()).text()); } catch { /* unreadable: nothing to honour */ }
    }
    let notEntered = 0;
    for (const [name, handle] of entries) {
      const rel = pre ? `${pre}/${name}` : name;
      if (handle.kind === 'directory') {
        if (scanSkipsName(name, { dir: true })) notEntered++;
        else if (gitignore.ignores(inner(rel), { dir: true })) onSkip?.(`${rel}/`, SCAN_WHY.gitignoredFolder);
        else notEntered += await walk(handle, rel);
      } else if (!scanSkipsName(name) && SCAN_EXT.test(name)) {
        if (gitignore.ignores(inner(rel))) onSkip?.(rel, SCAN_WHY.gitignored);
        else if (scanRefusesName(name)) onSkip?.(rel, SCAN_WHY.secret);
        else await onFile(rel, handle);
      }
    }
    return notEntered;
  }
  return walk(dir, prefix);
}

// Parse a (possibly multi-document) YAML file into a list of non-null
// documents. Prometheus rule files, Alertmanager configs and Kubernetes
// manifests are frequently shipped as multi-document streams (`---`).
// Repository files are read with a value standing on the line below its
// key (a compose file's `KEY:\n  ${VAR:-x}`): the reader leaves it out by
// default only for the writer's own files, read back elsewhere.
const REPO_YAML = Object.freeze({ valueBelowKey: true });
// A Helm template, once stripped, puts `helmvalue` alone on a line where an
// include renders a whole block: read below its key it would be a scalar the
// chart never renders, and a template that never read would read. So a
// template is read without valueBelowKey (walkHelmTemplate), as it always was.
const TEMPLATE_YAML = Object.freeze({});
let repoYaml = REPO_YAML;

function parseYamlDocs(content, options) {
  return parseYamlAll(content, { ...repoYaml, ...options }).filter(d => d && typeof d === 'object');
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

// The built-in exporter catalogue (tools/lib/exporter-catalogue.mjs), the one
// detectArtefactKind reads when its caller names none.
const BUILTIN_EXPORTER_CATALOGUE = resolveExporterCatalogue();

const isMapping = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

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

// A rules document: `groups` of rules, one of which is a recording rule, a
// Prometheus alerting rule or a Grafana-managed one (a provisioning file or
// Grafana's alert-rule export, in YAML or JSON).
function isRuleGroupsDocument(obj) {
  return !!obj && typeof obj === 'object' && Array.isArray(obj.groups)
    && obj.groups.some(g => g && Array.isArray(g.rules) && g.rules.some(r => r && typeof r === 'object' && ('record' in r || 'alert' in r || isGrafanaManagedRule(r))));
}

// ============================================================
// Public API
// ============================================================

/**
 * Detect what kind of observability artefact a file is.
 * @param {string} relPath - repo-relative path
 * @param {string} content - file content
 * @param {object} [opts]
 * @param {object|Array} [opts.exporterCatalogue] - a downstream's exporter
 *   catalogue ({ exporters: [...] } or the array), merged with the built-in
 *   entries; the built-in one when omitted
 * @returns {string} kind: 'prometheus-rules' | 'alertmanager' | 'grafana-dashboard' |
 *                          'grafana-dashboard-provider' |
 *                          'otel-collector' | 'docker-compose' | 'helm-chart' |
 *                          'helm-template' | 'metrics-manifest' | 'exposition-snapshot' |
 *                          'exporter-config' | 'unknown'
 */
export function detectArtefactKind(relPath, content, opts) {
  const { exporterCatalogue = BUILTIN_EXPORTER_CATALOGUE } = opts ?? {};
  const lower = relPath.toLowerCase();
  const catalogue = asResolvedCatalogue(exporterCatalogue);
  // A prebuilt exporter's metric list, as `packc emit --exporter` writes it.
  // Named by its file, so a malformed one is walked and warned about, never
  // silently skipped.
  if (isMetricsManifestPath(lower)) return 'metrics-manifest';
  // A saved /metrics response — not from a test or fixture path, where an
  // exposition is sample input, not what a deployed exporter serves.
  if (isExpositionSnapshotPath(lower)) {
    return !isTestOrFixturePath(relPath) && parseExposition(content).families.length ? 'exposition-snapshot' : 'unknown';
  }
  // JSON first — Grafana dashboards, and Grafana's alert-rule export written
  // as JSON (the same groups of rules as the YAML one).
  if (lower.endsWith('.json')) {
    try {
      const obj = JSON.parse(content);
      if (obj && Array.isArray(obj.panels) && typeof obj.schemaVersion === 'number') {
        return 'grafana-dashboard';
      }
      if (isRuleGroupsDocument(obj)) return 'prometheus-rules';
    } catch (_) { /* not json */ }
    return 'unknown';
  }

  if (METRIC_SOURCE_EXT_RE.test(lower) && looksLikeMetricSource(content, lower)) {
    return 'metric-source-code';
  }

  // YAML — could be many things; look at shape.
  if (!/\.ya?ml$/i.test(lower)) return 'unknown';

  // A repository's own pack (`.observability/*.yaml`, `kind:
  // ObservabilityPack`): what code cannot say — the chaos experiments a team
  // runs and their newest runs — declared where the service lives
  // (repo-pack.mjs), merged into the drafted pack by id.
  if (isRepoPackPath(lower) && /^kind:\s*ObservabilityPack\s*$/m.test(content)) return 'observability-pack';

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

  // A prebuilt exporter's own config (mq-metric-samples' config.yaml), by
  // the top-level keys a catalogue entry names — before the filename
  // heuristics, which would read `mq-collector.yaml` as an OTel collector.
  if (mayBeExporterConfig(content, catalogue)) {
    let cfg = null;
    try { cfg = parseYaml(content, repoYaml); } catch { /* not YAML: fall through */ }
    if (matchExporterConfig(cfg, catalogue)) return 'exporter-config';
  }

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
  try { obj = parseYaml(content, repoYaml); } catch (_) { return 'unknown'; }
  if (!obj || typeof obj !== 'object') return 'unknown';

  if (isRuleGroupsDocument(obj)) return 'prometheus-rules';
  // A Grafana dashboard provider (provisioning/dashboards/<file>.yaml): the
  // folder each provider files its dashboards under (walkDashboardProvider).
  if (Array.isArray(obj.providers)
      && obj.providers.some(p => p && typeof p === 'object' && (typeof p.options?.path === 'string' || p.type === 'file'))) {
    return 'grafana-dashboard-provider';
  }
  if (Array.isArray(obj.scrape_configs)
      && obj.scrape_configs.some(s => s?.job_name)) return 'prometheus-scrape-config';
  if (looksLikeActuatorMetricsConfig(lower, content, obj)) return 'actuator-metrics-config';
  if (obj.route && obj.receivers && Array.isArray(obj.receivers)) return 'alertmanager';
  if (looksLikeOtelCollector(obj))                                return 'otel-collector';
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

/**
 * Whether a scan reads this file at all: it is an artefact
 * (detectArtefactKind), or the chaos pass reads it beside the artefacts
 * (chaos-detect.mjs chaosPassReads: a scenario table or chaos control in
 * code, a Chaos Mesh / Litmus resource). A door that sends the server only
 * what the scan uses (the Expert panel, studio/app.mjs finalizeStaging)
 * sends exactly these, so its pack is the pack of the whole folder.
 * `kind`, when the caller already classified the file, saves a second parse.
 */
export function scanUsesFile(relPath, content, kind = detectArtefactKind(relPath, content)) {
  return kind !== 'unknown' || chaosPassReads(relPath, content);
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

// `chartRoots`: the folder of every Chart.yaml ('' for the repository's root,
// else its path with a trailing `/`): a Helm chart, whatever folder it is in.
function detectDeploymentSurfaces(files) {
  const out = {
    docker: false,
    k8s: false,
    eksSpecific: false,
    localK8sSpecific: false,
    chartRoots: [],
  };
  const roots = new Set();
  for (const relPath of files.keys()) {
    const p = normalizeRepoPath(relPath);
    const base = basenameOf(p);
    if (/(^|\/)(docker-)?compose\.ya?ml$/.test(p) || /(^|\/)compose\.ya?ml$/.test(p)) {
      out.docker = true;
    }
    if (hasPathSegment(p, 'k8s') || hasPathSegment(p, 'helm') || hasPathSegment(p, 'charts') || base === 'chart.yaml') {
      out.k8s = true;
    }
    if (base === 'chart.yaml') roots.add(p.slice(0, p.length - base.length));
    if (isEksSpecificPath(p)) {
      out.eksSpecific = true;
      out.k8s = true;
    }
    if (isLocalK8sSpecificPath(p)) {
      out.localK8sSpecific = true;
      out.k8s = true;
    }
  }
  out.chartRoots = [...roots].sort();
  return out;
}

// What a Helm chart ships, under the folder its Chart.yaml is in: its
// templates, files, dashboards, CRDs and subcharts, and its values schema —
// the Kubernetes surface, never another one (a root chart's files/collector.yaml
// is the chart's collector config, not a root Docker config).
const CHART_CONTENT = /^(?:templates|files|dashboards|crds|charts)\//;
function inChart(p, roots) {
  return Array.isArray(roots) && roots.some((root) => p.startsWith(root) && (CHART_CONTENT.test(p.slice(root.length)) || p.slice(root.length) === 'values.schema.json'));
}

function isRootDockerConfig(relPath, surfaces = null) {
  const p = normalizeRepoPath(relPath);
  const base = basenameOf(p);
  if (/(^|\/)(docker-)?compose\.ya?ml$/.test(p) || /(^|\/)compose\.ya?ml$/.test(p)) return true;
  if (inChart(p, surfaces?.chartRoots)) return false;
  if (hasPathSegment(p, 'k8s') || hasPathSegment(p, 'helm') || hasPathSegment(p, 'charts')) return false;
  if (hasPathSegment(p, 'config')) return true;
  return /^(prometheus|alertmanager|otel|otelcol|collector|loki|promtail)[\w.-]*\.ya?ml$/.test(base);
}

function isK8sPath(relPath, surfaces = null) {
  const p = normalizeRepoPath(relPath);
  const base = basenameOf(p);
  return hasPathSegment(p, 'k8s')
      || hasPathSegment(p, 'helm')
      || hasPathSegment(p, 'charts')
      || base === 'chart.yaml'
      || /^values[\w.-]*\.ya?ml$/.test(base)
      || inChart(p, surfaces?.chartRoots);
}

function isSourceCodePath(relPath) {
  return METRIC_SOURCE_EXT_RE.test(relPath);
}

function shouldIncludeForEnvironment(relPath, profile, surfaces) {
  const p = normalizeRepoPath(relPath);
  if (isSourceCodePath(p)) return true;
  // What an exporter exposes is the exporter's, not a deployment surface's:
  // a metrics manifest and a saved exposition are read in every environment.
  if (isMetricsManifestPath(p) || isExpositionSnapshotPath(p)) return true;
  // The repository's own pack (.observability/*.yaml) is the service's, not a
  // deployment surface's: read in every environment.
  if (isRepoPackPath(p)) return true;

  if (profile === 'local-docker') {
    if (!surfaces.docker) return true;
    return isRootDockerConfig(p, surfaces);
  }

  if (profile === 'local-k8s') {
    if (!surfaces.k8s) return true;
    if (isRootDockerConfig(p, surfaces) && surfaces.docker) return false;
    if (isEksSpecificPath(p)) return false;
    return isK8sPath(p, surfaces);
  }

  if (profile === 'prod') {
    if (!surfaces.k8s) return true;
    if (isRootDockerConfig(p, surfaces) && surfaces.docker) return false;
    if (isLocalK8sSpecificPath(p)) return false;
    if (isEksSpecificPath(p)) return false;
    return isK8sPath(p, surfaces);
  }

  if (profile === 'eks') {
    if (!surfaces.k8s) return true;
    if (isRootDockerConfig(p, surfaces) && surfaces.docker) return false;
    if (isLocalK8sSpecificPath(p)) return false;
    return isK8sPath(p, surfaces);
  }

  return true;
}

// The files a deployment profile reads (null: every file). `excluded` names
// the files left out only when the filter applied: a filter that would leave
// nothing (`emptied`) reads every file and leaves out none, and so does one
// that drops nothing.
function scopeFilesForProfile(files, profile) {
  const surfaces = detectDeploymentSurfaces(files);
  const result = {
    files,
    profile,
    surfaces,
    applied: false,
    emptied: false,
    excluded: [],
  };
  if (!profile) return result;

  const scoped = new Map();
  const excluded = [];
  for (const [relPath, content] of files) {
    if (shouldIncludeForEnvironment(relPath, profile, surfaces)) {
      scoped.set(relPath, content);
    } else {
      excluded.push(relPath);
    }
  }

  if (scoped.size === 0 || scoped.size === files.size) {
    result.emptied = scoped.size === 0 && files.size > 0;
    return result;
  }
  result.files = scoped;
  result.applied = true;
  result.excluded = excluded;
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
 * @param {object|Array} [opts.exporterCatalogue] - exporter family catalogue
 *   entries ({ exporters: [...] } or the array) that replace or extend the
 *   built-in ones (tools/lib/exporter-catalogue.mjs)
 * @returns {{canonical: object, summary: object, evidence: Record<string,string>}}
 */
const UNKNOWN_FILES_SHOWN = 200;
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
  // Which files the crawl reads. `surface` given (a service environment's Run
  // passes its setting, null for none): that deployment surface alone, or
  // every file — the environment's name chooses nothing. Not given (the
  // command line, Expert's crawl panel, POST /api/crawl and /api/crawl-github,
  // a journey's crawl: source): the profile the environment's name maps to,
  // prod by default, as before. Profile detection reads the name as given
  // (it lowercases itself).
  const explicitSurface = Object.hasOwn(opts, 'surface');
  const surfaceGiven = explicitSurface && opts.surface !== null && opts.surface !== undefined && opts.surface !== '' && opts.surface !== 'none' ? String(opts.surface) : null;
  const surfaceUnknown = surfaceGiven && !Object.hasOwn(DEPLOYMENT_SURFACES, surfaceGiven) ? surfaceGiven : null;
  const profile = explicitSurface
    ? (surfaceGiven && !surfaceUnknown ? DEPLOYMENT_SURFACES[surfaceGiven] : null)
    : normalizeEnvironmentProfile(envRaw);
  const envScope = scopeFilesForProfile(rawFiles, profile);
  const askedSurface = profile ? SURFACE_OF_PROFILE[profile] : null;
  const files = envScope.files;
  const catalogue = resolveExporterCatalogue(opts.exporterCatalogue);
  const inputWarnings = [...catalogue.warnings];
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
      // The files read that no walker recognised (detectArtefactKind
      // 'unknown'): never walked, named here so a scan says what it saw
      // and set aside — the first UNKNOWN_FILES_SHOWN; `unclassified` counts all.
      unclassified: 0,
      unknown: [],
    },
    environment: {
      requested: envRaw,
      profile: envScope.profile,
      scoped: envScope.applied,
      surfaces: { docker: envScope.surfaces.docker, k8s: envScope.surfaces.k8s, eksSpecific: envScope.surfaces.eksSpecific, localK8sSpecific: envScope.surfaces.localK8sSpecific },
      excluded: envScope.excluded.slice(0, 40),
      // The deployment surface whose files alone were read (kubernetes | eks | local-kubernetes | compose),
      // or null: every file. `asked`: a surface asked for that would have left no file, so every file was read.
      surface: askedSurface && !envScope.emptied ? askedSurface : null,
      ...(askedSurface && envScope.emptied ? { asked: askedSurface } : {}),
      // The filter left out more than half the files the scan recognises (set after the files are classified).
      excludedMost: false,
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
  // The filter's words: an explicit surface by its label (the setting a person chose), a name's
  // profile as it always read.
  const scopeName = explicitSurface ? `The ${surfaceWords(askedSurface)} filter` : `Environment scope "${envScope.profile}"`;
  const readsEvery = explicitSurface ? 'An environment with no deployment surface set reads every file.' : 'An environment that names no deployment profile (e.g. `all`) reads every file.';
  if (surfaceUnknown) {
    summary.warnings.push(`deployment surface "${surfaceUnknown}" is not one the scan knows (${Object.keys(DEPLOYMENT_SURFACES).join(', ')}); every file was read.`);
  }
  if (explicitSurface && envScope.emptied) {
    summary.warnings.push(`The ${surfaceWords(askedSurface)} filter would leave no file, so every file was read.`);
  }
  if (envScope.applied) {
    summary.warnings.push(`${scopeName} excluded ${envScope.excluded.length} file(s) from other deployment surfaces.`);
    // A file the scope leaves out may be the only one that shows how the
    // metrics are collected: say which, never drop them silently.
    const collection = envScope.excluded
      .map(relPath => collectionEvidenceOf(relPath, rawFiles.get(relPath), catalogue))
      .filter(Boolean);
    if (collection.length) {
      const shown = collection.slice(0, 8).join('; ') + (collection.length > 8 ? `; … (${collection.length - 8} more)` : '');
      summary.warnings.push(`${scopeName} excluded ${collection.length} file(s) that carry scrape jobs or exporter evidence: ${shown}. ${readsEvery}`);
    }
  }
  const evidence = {};   // <artefact-id> -> <relPath>

  const backends = [];
  const recordingRules = [];
  const burnRateAlerts = [];
  const alertRules = [];       // every alert rule found, raw, with its file and group (classified below)
  const metricDefinitions = [];
  const scrapeJobs = [];
  const exporters = new Map();   // exporter name → the files that say what it exposes
  const metricFamilies = [];     // the dynamic families those manifests declare
  // A collector config with no pipelines names its metrics exporter only by
  // guess; the guesses are settled after every file is walked against the
  // metrics pipelines the walk found (a config split across --config files
  // declares them in another file) — settleCollectorGuesses.
  const collectorState = newCollectorState();
  const dashboards = [];
  // Where the repository provisions its dashboards (resolveDashboardFolders): provider files, compose bind mounts, sidecar ConfigMaps.
  const dashboardProviders = [];
  const composeMounts = [];
  const helmFolders = [];
  const alertingRoutes = [];
  const repoPacks = [];        // the repository's own packs (.observability/*.yaml): their declared chaos experiments
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
    const kind = detectArtefactKind(relPath, content, { exporterCatalogue: catalogue });
    if (kind === 'unknown') {
      if (summary.files.unclassified++ < UNKNOWN_FILES_SHOWN) summary.files.unknown.push(relPath);
      continue;
    }
    classified.push({ relPath, content, kind });
    summary.files.classified++;
    summary.files.byKind[kind] = (summary.files.byKind[kind] || 0) + 1;
  }

  // A filter that left out more than half the files the scan recognises: said, so a
  // row can warn that most of the repository was not read for this environment.
  if (envScope.applied) {
    const excludedClassified = envScope.excluded
      .filter((relPath) => detectArtefactKind(relPath, rawFiles.get(relPath), { exporterCatalogue: catalogue }) !== 'unknown').length;
    summary.files.excludedClassified = excludedClassified;
    if (excludedClassified > summary.files.classified) {
      summary.environment.excludedMost = true;
      summary.warnings.push(`${scopeName} left out ${excludedClassified} of the ${excludedClassified + summary.files.classified} files the scan recognises — more than half of them. ${readsEvery}`);
    }
  }

  // Honor Helm `enabled: false`: a component the selected environment disables
  // must not be declared as a live backend. The toggle often lives in an env
  // overlay (values-eks) while the image lives in base values.yaml, so merge
  // `enabled` across the in-scope values files (overlays win) before walking —
  // when a deployment profile chose the files. With none (every file read, as a
  // service environment reads by default), an overlay is some environment's,
  // never every environment's: only the base values decide, and each overlay
  // switch they override is named in one warning — one that would switch a
  // component off (it stays declared), and one that switches on a component
  // the base values switch off (it is not declared: what it deploys is that
  // environment's, read through its deployment surface), never left unsaid.
  const valuesFiles = classified.filter((f) => f.kind === 'helm-values');
  const disabledComponents = collectDisabledComponents(envScope.profile ? valuesFiles : valuesFiles.filter((f) => isBaseValuesPath(f.relPath)));
  if (!envScope.profile) {
    const overlaid = overlaySwitches(valuesFiles, disabledComponents);
    if (overlaid.length) {
      const said = (o) => (o.switches === 'off' ? `${o.relPath} switches ${o.components.join(', ')} off`
        : `${o.relPath} switches ${o.components.join(', ')} on, which ${o.components.length === 1 ? 'is' : 'are'} not declared`);
      const shown = overlaid.slice(0, 8).map(said).join('; ') + (overlaid.length > 8 ? `; … (${overlaid.length - 8} more)` : '');
      summary.warnings.push(`Every file is read, so only the base Helm values decide what is deployed: ${shown}. An environment that deploys with one of these overlays reads it alone through its deployment surface.`);
    }
  }
  if (disabledComponents.size) {
    summary.discovered.disabledComponents = [...disabledComponents];
  }

  // A dashboard export kept under a documentation folder (docs/, examples/, samples/) that repeats
  // the uid of a dashboard file the repository holds elsewhere is a copy, not a second dashboard:
  // set aside before the walk, so it neither takes the deployed dashboard's uid (pushing that one to
  // a -2 id no Grafana holds) nor declares the metrics its panels query, and named. A documentation
  // dashboard that is the only holder of its uid is declared as before.
  const docCopies = documentationDashboardCopies(classified);
  if (docCopies.length) {
    const shown = docCopies.slice(0, 8).map((c) => `${c.relPath} repeats ${c.holder} (uid ${c.id})`).join('; ') + (docCopies.length > 8 ? `; … (${docCopies.length - 8} more)` : '');
    summary.warnings.push(`${docCopies.length} dashboard file(s) under a documentation folder repeat a dashboard the repository holds elsewhere and are not declared: ${shown}.`);
  }
  const setAside = new Set(docCopies.map((c) => c.relPath));

  // ----- pass 2: walk per kind -----
  // One alias budget for every file the walk reads: it keeps what it reads,
  // from up to hundreds of files (mini-yaml's withAliasBudget). The reads
  // before it — the sniffs that classify, the Helm toggle — keep nothing and
  // are bounded each on its own.
  withAliasBudget(() => walkClassified());
  function walkClassified() { for (const f of classified) {
    if (setAside.has(f.relPath)) continue;
    try {
      switch (f.kind) {
        case 'docker-compose':   walkDockerCompose(f, backends, pipelines, evidence, summary, composeMounts); break;
        case 'grafana-dashboard-provider': walkDashboardProvider(f, dashboardProviders, summary); break;
        case 'prometheus-rules': walkPrometheusRules(f, recordingRules, burnRateAlerts, alertRules, metricDefinitions, evidence, summary); break;
        case 'prometheus-scrape-config': walkPrometheusScrapeConfig(f, scrapeJobs, evidence, summary); break;
        case 'actuator-metrics-config': walkActuatorMetricsConfig(f, scrapeJobs, evidence, summary, repoName); break;
        case 'metric-source-code': walkMetricSourceCode(f, metricDefinitions, evidence, summary, repoName); break;
        case 'alertmanager':     walkAlertmanager(f, alertingRoutes, evidence, summary); break;
        case 'otel-collector':   walkOtelCollector(f, pipelines, scrapeJobs, evidence, summary, collectorState); break;
        case 'metrics-manifest': walkMetricsManifest(f, metricDefinitions, metricFamilies, exporters, summary, evidence); break;
        case 'exposition-snapshot': walkExpositionSnapshot(f, metricDefinitions, exporters, summary, evidence); break;
        case 'exporter-config':  walkExporterConfig(f, catalogue, metricDefinitions, exporters, summary, evidence); break;
        case 'grafana-dashboard':walkGrafanaDashboard(f, dashboards, metricDefinitions, evidence, summary); break;
        case 'helm-template':    walkHelmTemplate(f, { backends, recordingRules, burnRateAlerts, alertRules, metricDefinitions, scrapeJobs, alertingRoutes, dashboards, pipelines, collectorState, repoName, helmFolders }, evidence, summary); break;
        case 'helm-values':      walkHelmValues(f, backends, pipelines, evidence, summary, disabledComponents, { scrapeJobs, collectorState }); break;
        case 'k8s-workload':     walkK8sWorkload(f, backends, pipelines, evidence, summary); break;
        // Chart.yaml itself carries no observability contracts — the payloads
        // live in the templated manifests (handled as 'helm-template'). We
        // record the chart only as a signal that this is a Helm-packaged repo.
        case 'helm-chart':       summary.discovered.helmCharts = (summary.discovered.helmCharts || 0) + 1; break;
        case 'observability-pack': repoPacks.push({ relPath: f.relPath, read: readRepoPack(f.relPath, f.content) }); break;
      }
    } catch (e) {
      summary.warnings.push(`Failed to parse ${f.relPath}: ${e.message}`);
    }
  } }

  settleCollectorGuesses(collectorState, pipelines, evidence, summary);
  resolveDashboardFolders(dashboards, { providers: dashboardProviders, mounts: composeMounts, helmFolders }, summary);

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
  //      still has at least one contract. What it invents — the SLO, its SLI
  //      and the burn-rate entry, all from the alert's name — is marked a
  //      placeholder (crawler.scaffold.*): no live read can hold a burn-rate
  //      entry no recorded SLO series names, so it is never compared. The
  //      alert rule itself is declared in alerting.rules (below), as live
  //      lists it, and that is what compares.
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
    alert._invented = true;
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
  const inventedBurn = markInventedBurnAlerts(burnRateAlerts, markInvented);

  // The operational alerts are not lost: spec 1.4 keeps them in
  // spec.alerting.rules, one entry per rule with its EXACT name (the key a
  // live Grafana or ruler listing is reconciled on), its expression, wait,
  // labels, annotations, the engine that evaluates it and where it was read
  // from (sli-inference.mjs operationalAlertRule — the reading the live
  // fetcher applies to a ruler's rules). The classification is the one
  // above, exactly: a rule whose expression references a recorded SLO
  // series is a burn-rate alert and stays in the policy; every other rule
  // is operational — in every repository. A repo with no recording rules
  // declares every alert rule here (the live fetch lists each as an
  // operational rule, having no recorded SLO either); the SLO, SLI and
  // burn-rate entry the tier-3 fallback derives from each name stay beside
  // them as marked placeholders.
  const ruleMeta = new Map(alertRules.map(r => [r.rule, r]));
  const operational = operationalAlertRules(alertRules.map(r => r.rule), (id) => haveRecordedSlis && sloMap.has(id), {
    engineOf: (rule) => alertRuleEngine(rule),
    sourceOf: (rule) => ruleMeta.get(rule)?.source,
  });
  summary.discovered.alertRules = operational.kept.length;
  if (operational.kept.length) {
    const names = operational.kept.map(r => r.name);
    const shown = names.slice(0, 8).join(', ') + (names.length > 8 ? `, … (${names.length - 8} more)` : '');
    summary.warnings.push(`${operational.kept.length} operational alert rule(s) kept in alerting.rules — not SLO burn-rate alerts (no recorded-ratio reference): ${shown}. ${burnRateAlerts.length} burn-rate alert(s) in policy.burn_rate_alerts${inventedBurn ? `, ${inventedBurn} of them placeholders derived from alert names` : ''}.`);
  }
  if (operational.skipped.length) {
    summary.warnings.push(`${operational.skipped.length} alert rule(s) state no expression and are not declared: ${operational.skipped.slice(0, 8).join(', ')}.`);
  }
  operational.kept.forEach((r, i) => { evidence[`RULE-${i + 1}`] = r.source; });


  if (summary.omitted.recordingRules.length) {
    const names = summary.omitted.recordingRules.map(r => r.name);
    summary.warnings.push(`${names.length} recording rule(s) are not metric names with a colon and cannot be declared in spec.queries.recording_rules: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''}. Recorded in crawler.omitted.recording_rules; their expressions still feed the metric inventory.`);
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
      // No rule wrote it: a placeholder, as the live fetch marks its own (never "declared, not live").
      markInvented(`policy.burn_rate_alerts[${burnRateAlerts.length - 1}]`, 'schema-required fallback; no burn-rate alerting rule in the repository');
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

  // ----- baselines -----
  // Nothing in code says the MTTD / MTTR a team holds itself to: the
  // repository's own pack (.observability/*.yaml, spec.baselines) declares
  // them, the later file winning; without one the targets are placeholders.
  for (const { relPath, read } of repoPacks) {
    if (read?.baselinesRefused) summary.warnings.push(`${relPath}: spec.baselines is not a valid spec 1.5 Baselines and is left out (${read.baselinesRefused}).`);
  }
  const declaredBaselines = repoPacks.map(p => p.read?.baselines).filter(Boolean);
  const ownBaselines = declaredBaselines[declaredBaselines.length - 1] || null;
  let baselines;
  if (ownBaselines) {
    baselines = { ...ownBaselines.entry };
    evidence.baselines = ownBaselines.source;
    summary.discovered.baselines = ownBaselines.source;
    if (declaredBaselines.length > 1) summary.warnings.push(`spec.baselines is declared ${declaredBaselines.length} times under .observability/; the last (${ownBaselines.source}) wins.`);
  } else {
    baselines = {
      mttd_target_p50: '15m',
      mttr_target_p50: '1d',
      review_cadence: 'monthly',
    };
    scaffoldSymbols.push('baselines');
    summary.inferred.baselines = true;
  }

  // ----- chaos experiments (spec 1.5; chaos-detect.mjs) -----
  // Read from the repository in a pass of their own over every in-scope file
  // — a file has one kind, and a chaos controller that also exports metrics
  // would otherwise lose its scenarios to `metric-source-code`. Each
  // experiment found carries its evidence path (Declared, never Scaffold);
  // the fields code cannot supply are filled and field-marked. The
  // repository's own pack (.observability/*.yaml) then wins by id.
  const valuesInOrder = classified.filter(f => f.kind === 'helm-values')
    .sort((a, b) => (/(^|\/)values\.ya?ml$/i.test(a.relPath) ? 0 : 1) - (/(^|\/)values\.ya?ml$/i.test(b.relPath) ? 0 : 1));
  const chaosFound = detectChaos(files, { valuesFiles: valuesInOrder });
  const sloOfAlertName = new Map(burnRateAlerts.map(a => [a.alertName, a.slo]));
  const chaos = chaosExperimentsFrom(chaosFound, {
    repoName,
    alertRules: alertRules.map(({ rule }) => {
      const name = rule.alert || rule.title || rule.name || '';
      const expr = typeof rule.expr === 'string' ? rule.expr : '';
      return { name, for: rule.for, slo: recordedSloForExpr(expr, (id) => sloMap.has(id)) || sloOfAlertName.get(name) || null };
    }),
    slos: [...sloMap.values()],
    slis: sliMap,
    mttdFallback: baselines.mttd_target_p50,
  });
  const chaosExperiments = chaos.experiments;
  const chaosMarks = new Map(chaos.marks);
  const chaosDiscovered = chaos.discovered;
  Object.assign(evidence, chaos.evidence);
  for (const { relPath, read } of repoPacks) {
    if (!read) continue;
    for (const { id, reason } of read.refused) {
      summary.warnings.push(`${relPath}: chaos experiment ${id ?? '(no id)'} is not a valid spec 1.5 experiment and is left out (${reason}).`);
    }
    for (const { entry, source } of read.chaos) {
      const at = chaosExperiments.findIndex(e => e.id === entry.id);
      const was = at >= 0 ? chaosDiscovered.find(d => d.id === entry.id) : null;
      if (was?.from === 'repo-pack') summary.warnings.push(`${relPath}: chaos experiment ${entry.id} is declared again; the later declaration (${source}) wins over ${was.source}.`);
      if (at >= 0) chaosExperiments[at] = entry; else chaosExperiments.push(entry);
      for (const symbol of [...chaosMarks.keys()]) if (symbol.startsWith(`validation.chaos_experiments.${entry.id}.`)) chaosMarks.delete(symbol);
      evidence[`validation.chaos_experiments.${entry.id}`] = source;
      const row = { id: entry.id, engine: entry.engine, source, from: 'repo-pack', ...(was && was.from !== 'repo-pack' ? { replaces: was.source } : {}) };
      if (was) chaosDiscovered.splice(chaosDiscovered.indexOf(was), 1, row); else chaosDiscovered.push(row);
    }
  }
  for (const [symbol, note] of chaosMarks) markInvented(symbol, note);
  summary.discovered.chaosExperiments = chaosExperiments.length;
  summary.discovered.chaosSources = [...new Set(chaosDiscovered.map(d => d.source.split('#')[0]))].sort();
  summary.warnings.push(...chaos.notes);
  if (chaosExperiments.length) {
    const from = (kind) => chaosDiscovered.filter(d => d.from === kind).length;
    const parts = [['code', 'from code'], ['resource', 'from Chaos Mesh / Litmus resources'], ['repo-pack', 'declared in .observability/']]
      .filter(([k]) => from(k)).map(([k, label]) => `${from(k)} ${label}`);
    summary.warnings.push(`${chaosExperiments.length} chaos experiment(s) in spec.validation.chaos_experiments (${parts.join(', ')}): ${chaosExperiments.slice(0, 8).map(e => e.id).join(', ')}${chaosExperiments.length > 8 ? ', …' : ''}. A declared experiment is not a proven one: no run is recorded unless an experiment carries last_result.`);
  }

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
  // The chaos the tier-1 line names: an experiment the repository holds (from
  // code, a Chaos Mesh / Litmus resource or its own pack), declared, proven
  // or not — the grade, not the tier, tells those apart.
  if (tier === 'tier-2' && chaosExperiments.length) tier = 'tier-1';
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
  const exporterAnnotations = {
    ...buildExporterAnnotations(exporters),
    ...buildMetricFamilyAnnotations(metricFamilies),
    ...buildLifecycleAnnotations(classified, {
      recordingRules, alertRules, burnRateAlerts, metricDefinitions, metricFamilies, evidence, summary,
      linkedSlo: (expr) => recordedSloForExpr(expr, (id) => sloMap.has(id)),
      // The ids an alert derives when the repo records no SLI (the loop above).
      derivedIds: haveRecordedSlis ? null : (slo) => {
        const sloId = symbolId(slo, `${repoNs}_slo`);
        return { sloId, sliId: symbolId(sloId.replace(/_99|_999|_995|_slo$/i, '') || sloId, `${repoNs}_sli`) };
      },
    }),
  };

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
        // `crawler.unobserved.chaos` is gone: the scan detects chaos
        // experiments (chaos-detect.mjs), so "none declared" here means it
        // looked. A pack scanned before still carries the key, and the grade
        // still reads it there.
        // An input that was not a spec Slug or not in a spec vocabulary — the
        // original name and environment are kept here (owners only in the
        // summary: an owner string may be an address).
        ...(normalized.name ? { 'crawler.nameNormalizedFrom': normalized.name.from } : {}),
        ...(normalized.environment ? { 'crawler.environmentNormalizedFrom': normalized.environment.from } : {}),
        ...(criticalityIgnored ? { 'crawler.criticalityIgnored': String(opts.criticality) } : {}),
        ...(bindingIgnored ? { 'crawler.bindingIgnored': String(opts.binding) } : {}),
        // Recording rules the spec cannot declare (not a metric name with
        // a `:`) — evidence, never silently dropped.
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
        // The chaos experiments and where each was read from (code, a
        // resource, the repository's own pack); how an in-process system is
        // triggered and gated, and whether this environment switches it off.
        ...(chaosDiscovered.length ? { 'crawler.discovered.chaos_experiments': annotationJson(chaosDiscovered) } : {}),
        // Every alert rule's exact name the repository declares — the burn-rate ones folded into the
        // policy included, which alerting.rules does not keep: the control room's scope reads it
        // (server/routes/control-room.mjs).
        ...alertNameAnnotations(alertRules),
        // What each Grafana-managed rule states beyond the spec (uid, folder, group, condition).
        ...grafanaRuleAnnotations(operational, recordingRules),
        // The rules each burn-rate entry was read from, with their own terms: the entry keeps only
        // { slo, windows }, and the windows are this reading's, so the comparison reads the rules here.
        ...(haveRecordedSlis ? sourceRuleAnnotations(alertRules, burnRateAlerts, (id) => sloMap.has(id)) : {}),
        ...(chaosFound.scenarios.length && chaosControlSummary(chaosFound) ? { 'crawler.chaos.control': chaosControlSummary(chaosFound) } : {}),
        ...(chaosFound.scenarios.length && chaosFound.toggle?.enabled === false ? { 'crawler.chaos.disabled': `${chaosFound.toggle.path}: false (${chaosFound.toggle.file})` } : {}),
        ...metricAnnotations,
        ...scrapeAnnotations,
        ...exporterAnnotations,
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
        ...(chaosExperiments.length ? { chaos_experiments: chaosExperiments } : {}),
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
/**
 * What a scan saw, for a Run's answer and its run record — the read
 * (`read`: a door's { source, ref, files, candidates, capped, truncated,
 * skipped: [{ path, why }] }) and crawlFiles' summary, every list bounded
 * so a large repository never bloats either:
 *   { source, ref,
 *     files            how many files were read,
 *     candidates       how many the scan's rule takes in the repository (a
 *                      GitHub or Azure DevOps tree; a folder: those read),
 *     capped           how many of those the host read's file cap left out,
 *     truncated        the host cut its tree listing short (GitHub),
 *     skipped, skippedFiles      the files the rule would read and the read
 *                      did not, and why (the first SCAN_REPORT_SHOWN),
 *     classified, byKind         what the crawler recognised, by kind,
 *     unclassified, unknownFiles what it read and recognised as nothing,
 *     environment: { profile, excluded, excludedFiles }  what the
 *                      environment's deployment profile left out,
 *     warnings,
 *     partial          the read LOST files (a host refused or dropped them, the
 *                      read's budget ran out, the disk would not give them):
 *                      such a scan stops a Run, fails its gate and is not
 *                      comparable with another (scanSkipKind 'lost'),
 *     lost             how many,
 *     notRead          every file the scan takes and did not read but those left
 *                      out on purpose: the lost ones, those over the size caps
 *                      or not text, and those past the file cap,
 *     notReadReasons   the first 5 of them, lost first: [{ path, why }] — reasons
 *                      only, never a host's body,
 *     cappedFiles      the first 20 past the file cap,
 *     treeTruncated    the host's own flag (`truncated`, kept for older readers),
 *     filter: { surface, excluded[, asked] }  the deployment surface whose files
 *                      alone were read (null: every file) and how many it left out,
 *     excludedMost     it left out more than half the files the scan recognises }
 * Each skippedFiles entry names its `kind` (scanSkipKind). `candidates` with no
 * count from the read is the files read and those not read.
 * Without a summary (the scan read nothing) only the read's part is filled.
 */
export const SCAN_REPORT_SHOWN = 50;
export const SCAN_REASONS_SHOWN = 5;
export const SCAN_CAPPED_SHOWN = 20;
export function scanReport(read = {}, summary = null) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const fileCount = read.files && typeof read.files === 'object' ? Object.keys(read.files).length : n(read.files);
  const skipped = Array.isArray(read.skipped) ? read.skipped : [];
  const f = summary?.files || {};
  const env = summary?.environment || {};
  const excluded = Array.isArray(env.excluded) ? env.excluded : [];
  const short = (s, max = 500) => { const t = String(s ?? ''); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
  const kinds = skipped.map((s) => scanSkipKind(s?.why));
  const lost = skipped.filter((_, i) => kinds[i] === 'lost');
  const limited = skipped.filter((_, i) => kinds[i] === 'limit');
  const capped = n(read.capped);
  const cappedPaths = (Array.isArray(read.cappedFiles) ? read.cappedFiles : []).filter((p) => typeof p === 'string');
  const capWhy = SCAN_WHY.fileCap(Number.isInteger(read.fileCap) ? read.fileCap : null);
  const notRead = lost.length + limited.length + capped;
  const reasons = [...lost, ...limited, ...cappedPaths.slice(0, SCAN_REASONS_SHOWN).map((path) => ({ path, why: capWhy }))].slice(0, SCAN_REASONS_SHOWN);
  return {
    source: read.source ?? null,
    ref: read.ref ?? null,
    files: fileCount,
    candidates: Number.isFinite(Number(read.candidates)) && read.candidates !== null && read.candidates !== undefined ? n(read.candidates) : fileCount + notRead,
    capped,
    truncated: read.truncated === true,
    skipped: skipped.length,
    // A reason at most 300 characters: a host's sentence with the tries after it fits whole.
    skippedFiles: skipped.slice(0, SCAN_REPORT_SHOWN).map((s, i) => ({ path: short(s?.path, 300), why: short(s?.why, 300), kind: kinds[i] })),
    classified: n(f.classified),
    byKind: f.byKind && typeof f.byKind === 'object' ? { ...f.byKind } : {},
    unclassified: n(f.unclassified),
    unknownFiles: (Array.isArray(f.unknown) ? f.unknown : []).slice(0, SCAN_REPORT_SHOWN).map((p) => short(p, 300)),
    environment: {
      profile: env.profile ?? null,
      excluded: n(f.excludedByEnvironment),
      excludedFiles: excluded.slice(0, SCAN_REPORT_SHOWN).map((p) => short(p, 300)),
    },
    warnings: (Array.isArray(summary?.warnings) ? summary.warnings : []).slice(0, 20).map((w) => short(w)),
    partial: lost.length > 0,
    lost: lost.length,
    notRead,
    notReadReasons: reasons.map((s) => ({ path: short(s?.path, 300), why: short(s?.why, 300) })),
    cappedFiles: cappedPaths.slice(0, SCAN_CAPPED_SHOWN).map((p) => short(p, 300)),
    treeTruncated: read.truncated === true,
    filter: {
      surface: typeof env.surface === 'string' ? env.surface : null,
      excluded: n(f.excludedByEnvironment),
      ...(typeof env.asked === 'string' ? { asked: env.asked } : {}),
    },
    excludedMost: env.excludedMost === true,
  };
}

/**
 * A scan's loss in one sentence, for a stopped Run's answer and its record:
 *   "<n> of <m> files not read: <path> — <why>"  (the first reason; lost first)
 *   "<lost> of <m> files could not be read: <path> — <why> (<k> more not read: …)"
 *     when files were also left out by the caps;
 * "files or folders" when a folder is among them; '' when nothing is missing.
 */
export function notReadSentence(scan) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const notRead = n(scan?.notRead);
  if (!notRead) return '';
  const lost = n(scan?.lost);
  const capped = n(scan?.capped);
  const limited = Math.max(0, notRead - lost - capped);
  const reasons = Array.isArray(scan?.notReadReasons) ? scan.notReadReasons : [];
  const first = reasons[0] ? `: ${reasons[0].path} — ${reasons[0].why}` : '';
  const noun = reasons.some((r) => String(r?.path ?? '').endsWith('/')) ? 'files or folders' : 'files';
  const of = `of ${n(scan?.candidates)} ${noun}`;
  if (lost && lost < notRead) {
    const more = [limited ? `${limited} over the scan's limits` : '', capped ? `${capped} past the file cap` : ''].filter(Boolean).join(', ');
    return `${lost} ${of} could not be read${first} (${notRead - lost} more not read: ${more})`;
  }
  return `${notRead} ${of} not read${first}`;
}

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
//
// An action that is only a string literal — {{ "{{" }}, {{ `}}` }}, the way a
// chart writes a Prometheus annotation's own {{ $value }} — renders as that
// string, so it is kept as Helm prints it: `{{ "{{" }} $value {{ "}}" }}` is
// `{{ $value }}`, the text live serves. Its braces are held aside while the
// injections collapse, so they are never taken for one.
const HELM_OPEN = '\u0000helm-open\u0000';
const HELM_CLOSE = '\u0000helm-close\u0000';
// What an inline value injection collapses to: a value the chart fills in at
// deploy time, which the repository does not state.
const HELM_VALUE = 'helmvalue';
const helmLiteral = (text) => text.replaceAll('{{', HELM_OPEN).replaceAll('}}', HELM_CLOSE);
function stripGoTemplate(content) {
  return content.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (/^\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}$/.test(t)) return null;            // comment
    if (/^\{\{-?\s*(if|else|end|range|with|define|block)\b.*?-?\}\}$/.test(t)) return null; // control flow
    return line
      .replace(/\{\{-?\s*"((?:[^"\\]|\\.)*)"\s*-?\}\}/g, (_, s) => helmLiteral(s.replace(/\\(.)/g, '$1')))   // {{ "…" }} prints …
      .replace(/\{\{-?\s*`([^`]*)`\s*-?\}\}/g, (_, s) => helmLiteral(s))                                      // {{ `…` }} prints …
      .replace(/\{\{-?[\s\S]*?-?\}\}/g, HELM_VALUE) // inline value injection
      .replaceAll(HELM_OPEN, '{{').replaceAll(HELM_CLOSE, '}}');
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
  try { obj = parseYaml(content, repoYaml); } catch (_) { return 'unknown'; }
  if (!obj || typeof obj !== 'object') return 'unknown';
  if (Array.isArray(obj.groups) && obj.groups.some(g => g.rules?.some(r => 'record' in r || 'alert' in r))) return 'prometheus-rules';
  if (Array.isArray(obj.scrape_configs) && obj.scrape_configs.some(s => s?.job_name)) return 'prometheus-scrape-config';
  if (looksLikeActuatorMetricsConfig('', content, obj)) return 'actuator-metrics-config';
  if (obj.route && Array.isArray(obj.receivers)) return 'alertmanager';
  if (looksLikeOtelCollector(obj)) return 'otel-collector';
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
    // A caller may state it ('inferred': an exporter config's family).
    confidence: item.confidence || (item.candidateOnly ? 'candidate' : 'declared'),
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
  target.confidence = target.candidateOnly
    ? (target.confidence === 'inferred' ? 'inferred' : 'candidate')
    : 'declared';
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
    if (!referenced.has(metric.name)) unreferenced++;
    // An exporter config's family stays 'inferred': the config says the
    // exporter is switched on, not that the name is right.
    if (metric.confidence === 'inferred') continue;
    metric.confidence = referenced.has(metric.name) ? 'referenced-candidate' : 'candidate';
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

// The burn-rate entries the tier-3 fallback derived from alert names, marked
// placeholders (crawler.scaffold.policy.burn_rate_alerts[<i>]) like the SLO and
// SLI derived with them: a live read derives a burn-rate entry only from a
// recorded SLO series, so these can never pair — never "declared, not live".
// The alert rules themselves are declared in alerting.rules and compare there.
// Answers how many were marked.
function markInventedBurnAlerts(burnRateAlerts, markInvented) {
  let marked = 0;
  burnRateAlerts.forEach((a, i) => {
    if (!a._invented) return;
    markInvented(`policy.burn_rate_alerts[${i}]`, 'derived from the alert name only; the alert rule is declared in alerting.rules, and a live read derives burn-rate entries only from recorded SLO series');
    marked += 1;
  });
  return marked;
}

// observogram.grafana_rule.<symbol>: what each Grafana-managed rule states
// beyond the spec's closed shapes (sli-inference.mjs grafanaRuleFacts) — for
// each operational rule declared, by its alerting.rules index, and for each
// Grafana-managed recording rule, by its queries.recording_rules index. The
// adapter lifts it onto the artefact as `grafana` (tools/lib/artefact-model.mjs).
function grafanaRuleAnnotations(operational, recordingRules) {
  const out = {};
  (operational.keptRules || []).forEach((rule, i) => {
    if (rule?.grafana) out[`observogram.grafana_rule.alerting.rules[${i}]`] = JSON.stringify(rule.grafana);
  });
  recordingRules.forEach((entry, i) => {
    const facts = GRAFANA_RECORDING_FACTS.get(entry);
    if (facts) out[`observogram.grafana_rule.queries.recording_rules[${i}]`] = JSON.stringify(facts);
  });
  return out;
}

// The names of every alert rule read, each once, sorted — none when there are none.
function alertNameAnnotations(alertRules) {
  const names = [...new Set(alertRules.map((r) => String(r.name || '').trim()).filter(Boolean))].sort();
  return names.length ? { 'crawler.discovered.alert_names': annotationJson(names), 'crawler.discovered.alert_names_count': String(names.length) } : {};
}

// The alerting rules each burn-rate entry was read from, stated beside it.
// A hand-written rule on an SLO's recorded series becomes that SLO's entry,
// { slo, windows }, whose windows are this reading's own (the rule's wait as
// `short`, constants for the rest, the default pair below two): its
// expression and severity are in no field of the pack, its wait only as a
// window. So each entry says them here, per SLO — every rule that guards it,
// read as an operational rule is read (sli-inference.mjs sourceRuleTerms, the
// function the live fetch states its own rules through) — and the comparison
// holds each rule to the one live runs under the same name. The key and the
// value are tools/lib/artefact-model.mjs's (sourceRulesAnnotationKey,
// parseSourceRulesAnnotation), mirrored here so this module's imports stay
// what they were; tools/test-source-rules.mjs holds the two together.
//
// Not for an SLO any of whose rules holds a value the repository does not
// state itself — one a chart fills in at deploy time, which reaches a rule as
// the placeholder stripGoTemplate leaves (HELM_VALUE), or a ${VAR} a deploy
// step substitutes: held against what live renders there it would read as a
// difference, so that SLO states no rules and compares as it always did.
const SOURCE_RULES_ANNOTATION = 'observogram.source_rules.policy.burn_rate_alerts.';
function sourceRuleAnnotations(alertRules, burnRateAlerts, hasSlo) {
  const bySlo = sourceRuleTerms(alertRules.map((r) => r.rule), hasSlo);
  // Decided on each rule as the file writes it: what the reading keeps of it
  // no longer shows a labels map the chart fills in whole.
  const withheld = new Set();
  for (const r of alertRules) {
    if (!notStatedAsWritten(r)) continue;
    for (const slo of sourceRuleTerms([r.rule], hasSlo).keys()) withheld.add(slo);
  }
  const out = {};
  for (const { slo } of burnRateAlerts) {
    const terms = bySlo.get(slo);
    if (terms?.length && !withheld.has(slo)) out[`${SOURCE_RULES_ANNOTATION}${slo}`] = annotationJson(terms);
  }
  return out;
}

// A rule the repository does not state as the ruler will list it. Its SLO
// states no rules: held against what live renders, it would read as a
// difference in a system that is the same.
//   - a value filled in at deploy time: the placeholder stripGoTemplate
//     leaves, a template action, a ${VAR} or a $VAR (never a capture group's
//     ${1} / $1, nor the ruler's own {{ $labels.x }} inside a label);
//   - labels that are not a map of the rule's own strings: a map a chart or
//     a deploy step fills in whole (on the rule, or on its group), a labels
//     map given as an alias or a merge key whose anchor the file does not
//     define (the reader keeps it as text), group labels past the scan's
//     copy budget. The group's labels, anchors and merge keys the file does
//     define, and numbers and booleans, are read as the ruler reads them
//     (asListed, tools/lib/mini-yaml.mjs). A label value that is an alias to
//     no anchor is stated as its text: the ruler refuses such a file, so live
//     lists none of its rules to hold the statement to.
const INJECTED_NAME_RE = /\$\{[A-Za-z_][A-Za-z0-9_.]*\}|\$[A-Za-z_][A-Za-z0-9_]*/;
function notStatedAsWritten({ rule, labelsUnread }) {
  if (labelsUnread) return true;
  const text = (v) => (typeof v === 'string' ? v : '');
  const injected = (v) => new RegExp(`\\b${HELM_VALUE}\\b`).test(v) || INJECTED_NAME_RE.test(v);
  for (const v of [rule.alert, rule.title, rule.expr, rule.for]) {
    if (injected(text(v)) || text(v).includes('{{')) return true;
  }
  const labels = rule.labels;
  if (labels === null || labels === undefined) return false;
  if (typeof labels !== 'object' || Array.isArray(labels)) return true;
  for (const [k, v] of Object.entries(labels)) {
    // An empty label is no label, to the ruler as to this reading.
    if (v === null) continue;
    if (k === '<<' || typeof v !== 'string') return true;
    // The ruler's own templating of a label ({{ $labels.job }}) is the rule's text, listed as written.
    const own = (s) => s.replace(/\{\{[^}]*\}\}/g, '');
    if (injected(k) || injected(own(v))) return true;
  }
  return false;
}

function annotationJson(value) {
  const compact = JSON.stringify(value);
  return compact.length > JSON_ANNOTATION_BLOCK_LENGTH
    ? JSON.stringify(value, null, 2)
    : compact;
}

// Which file speaks for a metric named in several: what the exporter says it
// exposes first (its manifest, then a saved exposition), then the code that
// registers it, then what reads it, and last a name only inferred from an
// exporter's config.
function metricOriginRank(metric) {
  const kind = metric?.originKind || 'source-code';
  if (kind === 'exporter-manifest') return 0;
  if (kind === 'exporter-snapshot') return 1;
  if (kind === 'source-code') return 2;
  if (kind === 'source-code-fragment') return 3;
  if (kind === 'recording-rule-output') return 4;
  if (kind === 'promql-reference') return 5;
  if (kind === 'exporter-config') return 6;
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
      // A job an OTel collector's prometheus receiver scrapes: the receiver,
      // its static target count, and where the collector ships the samples.
      ...(item.via ? {
        via: item.via,
        receiver: item.receiver,
        target_count: item.target_count,
        exporters: item.exporters,
      } : {}),
    };
  }
  return {
    'crawler.discovered.scrape_jobs': annotationJson(jobs),
    'crawler.discovered.scrape_jobs_count': String(jobs.length),
    'crawler.discovered.scrape_job_origins': annotationJson(origins),
  };
}

// crawler.discovered.metric_families: the names an exporter mints at runtime,
// as its manifest declares them. No metric definition can hold one (a name is
// a name, addMetricDefinition refuses the rest), so they have their own
// annotation, and the adapter projects them as METRIC-FAM-NN.
function buildMetricFamilyAnnotations(families) {
  if (!families.length) return {};
  const sorted = [...families].sort((x, y) => (x.pattern < y.pattern ? -1 : x.pattern > y.pattern ? 1 : 0));
  return {
    'crawler.discovered.metric_families': annotationJson(sorted),
    'crawler.discovered.metric_families_count': String(sorted.length),
  };
}

// observogram.lifecycle: what each rules file's lifecycle block covers
// (tools/lib/lifecycle.mjs). A symbol is covered only when every file that speaks
// for it states the same. Whatever reads a series speaks for it too, down the chain:
// an alert or a dashboard in another file keeps the SLO behind it, its rules and
// their metrics visible. So a statement can only ever hide what its own file, or
// files that say the same, declare.
function buildLifecycleAnnotations(classified, { recordingRules, alertRules, burnRateAlerts, metricDefinitions, metricFamilies, evidence, summary, linkedSlo, derivedIds }) {
  const blocks = new Map();
  for (const f of classified) {
    if (f.kind !== 'prometheus-rules' && f.kind !== 'helm-template') continue;
    const read = readLifecycleBlock(f.content);
    if (!read) continue;
    if (read.problem) summary.warnings.push(`${f.relPath}: the lifecycle block is not read: ${read.problem}.`);
    else blocks.set(f.relPath, read.statement);
  }
  if (!blocks.size) return {};
  const owners = new Map();
  const own = (symbol, file) => {
    if (!owners.has(symbol)) owners.set(symbol, new Set());
    owners.get(symbol).add(file);
  };
  const fileOf = (origin) => String(origin ?? '').split('#')[0];
  const rulesByName = new Map(recordingRules.map((rule) => [rule.name, rule]));
  // A rule the spec cannot declare is still a reader of what its expression names.
  const omittedRuleExprs = new Map(metricDefinitions
    .filter((metric) => metric.originKind === 'recording-rule-output' && !rulesByName.has(metric.name))
    .map((metric) => [metric.name, metric.query]));
  const ownExpr = (expr, file, seen = new Set()) => {
    for (const raw of extractPrometheusMetricNames(expr)) {
      const name = normalizePrometheusMetricName(raw);
      if (seen.has(name)) continue;
      seen.add(name);
      own(`metrics.${name}`, file);
      if (rulesByName.has(name)) ownRule(rulesByName.get(name), file, seen);
      else if (omittedRuleExprs.has(name)) ownExpr(omittedRuleExprs.get(name), file, seen);
    }
  };
  const ownRule = (rule, file, seen) => {
    own(`queries.recording_rules.${rule.name}`, file);
    const sliId = ruleNameToSliId(rule.name);
    if (sliId) {
      own(`slis.${sliId}`, file);
      own(`slos.${ruleNameToSloId(rule.name)}`, file);
    }
    ownExpr(rule.expr, file, seen);
  };
  recordingRules.forEach((rule, i) => {
    ownRule(rule, fileOf(evidence[`QRY-${i + 1}-${slug(rule.name).slice(0, 16)}`]), new Set());
  });
  for (const { rule, relPath } of alertRules) {
    const file = fileOf(relPath);
    const { alertName, expr, slo } = burnCandidateFromAlertRule(rule);
    const linked = linkedSlo(expr);
    if (linked) {
      own(`policy.burn_rate_alerts.${linked}`, file);
      own(`slos.${linked}`, file);
      own(`slis.${linked.replace(/_99$/, '')}`, file);
    } else if (derivedIds) {
      const { sloId, sliId } = derivedIds(slo);
      own(`policy.burn_rate_alerts.${sloId}`, file);
      own(`slos.${sloId}`, file);
      own(`slis.${sliId}`, file);
      // The rule itself is declared in alerting.rules too (crawlFiles).
      own(`alerting.rules.${String(alertName).trim()}`, file);
    } else {
      own(`alerting.rules.${String(alertName).trim()}`, file);
    }
    ownExpr(expr, file);
  }
  // Every other reader of a series: a dashboard, the code, a rule the spec omits.
  for (const metric of metricDefinitions) {
    const file = fileOf(metric.origin);
    own(`metrics.${metric.name}`, file);
    if (rulesByName.has(metric.name)) ownRule(rulesByName.get(metric.name), file, new Set([metric.name]));
    else if (omittedRuleExprs.has(metric.name)) ownExpr(omittedRuleExprs.get(metric.name), file, new Set([metric.name]));
  }
  // A burn alert no rule wrote (synthesized for an SLO) goes with its SLO.
  for (const { slo } of burnRateAlerts) {
    const symbol = `policy.burn_rate_alerts.${slo}`;
    if (!owners.has(symbol)) for (const file of owners.get(`slos.${slo}`) || []) own(symbol, file);
  }
  // A manifest's dynamic family declares the names it matches.
  for (const family of metricFamilies) {
    const { re } = compileMetricFamilyPattern(family.pattern, { timed: false });
    if (!re) continue;
    for (const { name } of metricDefinitions) if (re.test(name)) own(`metrics.${name}`, family.file);
  }
  const statements = [...blocks.keys()].sort().map((source) => ({
    source,
    ...blocks.get(source),
    symbols: [...owners]
      .filter(([, files]) => files.has(source) && [...files].every((file) => blocks.has(file) && sameDeployment(blocks.get(file), blocks.get(source))))
      .map(([symbol]) => symbol).sort(),
  }));
  for (const { source, symbols } of statements) {
    if (!symbols.length) summary.warnings.push(`${source}: the lifecycle block covers nothing: every rule of this file is also read or declared elsewhere.`);
  }
  summary.discovered.lifecycleStatements = statements.length;
  return { [LIFECYCLE_ANNOTATION]: annotationJson(statements) };
}

// crawler.discovered.exporters: each prebuilt exporter the crawl learned
// metrics from, and the files that said what it exposes (a manifest, a saved
// exposition, its own config).
function buildExporterAnnotations(exporters) {
  if (!exporters.size) return {};
  const names = [...exporters.keys()].sort();
  return {
    'crawler.discovered.exporters': annotationJson(Object.fromEntries(names.map(n => [n, exporters.get(n)]))),
    'crawler.discovered.exporters_count': String(names.length),
  };
}

function recordExporter(exporters, name, source, summary) {
  if (!exporters.has(name)) {
    exporters.set(name, { sources: [] });
    summary.discovered.exporters = (summary.discovered.exporters || 0) + 1;
  }
  exporters.get(name).sources.push(source);
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
    const rank = (p) => (isBaseValuesPath(p) ? 0 : 1);
    return rank(a.relPath) - rank(b.relPath);
  });
  const effective = new Map(); // top-level component -> enabled boolean
  for (const f of ordered) {
    for (const [key, on] of enabledTogglesOf(f)) effective.set(key, on);
  }
  const disabled = new Set();
  for (const [key, on] of effective) if (on === false) disabled.add(key);
  return disabled;
}

// A chart's base values (`values.yaml`), as against an overlay (`values-eks.yaml`, …).
function isBaseValuesPath(relPath) {
  return /(^|\/)values\.ya?ml$/i.test(normalizeRepoPath(relPath));
}

// A values file's top-level `<component>.enabled` toggles, in document order.
function enabledTogglesOf(f) {
  const out = [];
  let docs;
  try { docs = parseYamlDocs(f.content); } catch { return out; }
  for (const obj of docs) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    for (const [key, val] of Object.entries(obj)) {
      if (val && typeof val === 'object' && !Array.isArray(val) && typeof val.enabled === 'boolean') out.push([key, val.enabled]);
    }
  }
  return out;
}

// The overlay switches the base values override when every file is read —
// said, never applied: an overlay that would switch off a component the base
// values leave on (`switches: 'off'`), and one that switches on a component
// the base values switch off (`switches: 'on'`). [{ relPath, switches,
// components }] in path order, an overlay's switches off before its
// switches on.
function overlaySwitches(valuesFiles, baseDisabled) {
  const out = [];
  for (const f of [...valuesFiles].filter((x) => !isBaseValuesPath(x.relPath)).sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))) {
    const toggles = enabledTogglesOf(f);
    const off = [...new Set(toggles.filter(([key, on]) => on === false && !baseDisabled.has(key)).map(([key]) => key))];
    const on = [...new Set(toggles.filter(([key, enabled]) => enabled === true && baseDisabled.has(key)).map(([key]) => key))];
    if (off.length) out.push({ relPath: f.relPath, switches: 'off', components: off });
    if (on.length) out.push({ relPath: f.relPath, switches: 'on', components: on });
  }
  return out;
}

// The top-level folders a repository keeps documentation and samples in (the
// host reader's own list orders by the same names: server/github-crawl.mjs).
const DOCUMENTATION_FOLDERS = new Set(['docs', 'doc', 'examples', 'example', 'samples', 'sample']);
const isDocumentationPath = (relPath) => DOCUMENTATION_FOLDERS.has(normalizeRepoPath(relPath).split('/')[0].toLowerCase());

// The dashboard files under a documentation folder whose dashboard id (its
// uid, else its title: dashboardSpecId) a dashboard file outside those folders
// also holds: [{ relPath, id, holder }] in path order, `holder` the first such
// file in path order.
function documentationDashboardCopies(classified) {
  const idOf = (f) => { try { return dashboardSpecId(JSON.parse(f.content)); } catch { return null; } };
  const dashboards = classified.filter((f) => f.kind === 'grafana-dashboard').map((f) => ({ relPath: f.relPath, id: idOf(f), doc: isDocumentationPath(f.relPath) }));
  const holders = new Map();
  for (const d of dashboards) if (d.id && !d.doc && !holders.has(d.id)) holders.set(d.id, d.relPath);
  return dashboards.filter((d) => d.doc && d.id && holders.has(d.id)).map((d) => ({ relPath: d.relPath, id: d.id, holder: holders.get(d.id) }));
}

function walkHelmValues(f, backends, pipelines, evidence, summary, disabledComponents = new Set(), { scrapeJobs = [], collectorState = newCollectorState() } = {}) {
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

  for (const obj of parseYamlDocs(f.content)) {
    // A collector chart's values carry the collector config: at the top
    // level, under `config:` (the opentelemetry-collector chart's idiom), or
    // under a subchart's key in an umbrella chart. Read first, so a pipeline
    // it declares beats an image's inference; a config this walk cannot read
    // (the chart's `pipelines.metrics: null` drops a pipeline) is warned
    // about and never costs the values file its images.
    for (const collector of valuesCollectorConfigs(obj, { disabled: disabledComponents })) {
      try { walkOtelCollectorDoc(collector, f.relPath, pipelines, scrapeJobs, evidence, summary, collectorState); }
      catch (e) { summary.warnings.push(`The collector config in ${f.relPath} could not be read (${e.message}); its images are read as before.`); }
    }
    visit(obj);
  }
}

// The collector configs a Helm values document carries: the document
// itself, its `config:`, or a subchart's `<key>.config:` (an umbrella
// chart) — never a subchart that is disabled. A crawl knows that from
// `disabled`, the `enabled` toggles merged across the in-scope values files
// (an overlay wins, as with `helm -f`); a file read alone (the scope warning)
// from its own `enabled: false`.
function valuesCollectorConfigs(obj, { disabled = null } = {}) {
  if (!isMapping(obj)) return [];
  if (looksLikeOtelCollector(obj)) return [obj];
  if (isMapping(obj.config) && looksLikeOtelCollector(obj.config)) return [obj.config];
  const off = (key, v) => (disabled ? disabled.has(key) : v?.enabled === false);
  return Object.entries(obj)
    .filter(([key, v]) => !off(key, v) && isMapping(v?.config) && looksLikeOtelCollector(v.config))
    .map(([, v]) => v.config);
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
  const was = repoYaml;
  repoYaml = TEMPLATE_YAML;
  try { return walkStrippedTemplate(f, buckets, evidence, summary); } finally { repoYaml = was; }
}

function walkStrippedTemplate(f, buckets, evidence, summary) {
  const { backends, recordingRules, burnRateAlerts, alertRules, metricDefinitions, scrapeJobs, alertingRoutes, dashboards, pipelines, collectorState, repoName } = buckets;
  // The Grafana sidecar's folder each annotated document states: its own dashboard keys (here), the chart files it ships (resolveDashboardFolders).
  const sidecar = helmSidecarFolders(f);
  buckets.helmFolders?.push(...sidecar.filter((s) => s.files.length));
  const folderOfKey = (key) => {
    const titles = [...new Set(sidecar.filter((s) => s.keys.includes(key)).map((s) => s.title))];
    return titles.length === 1 ? sidecar.find((s) => s.keys.includes(key)) : null;
  };
  let provisioned = null;
  const route = (kind, sub) => {
    switch (kind) {
      case 'prometheus-rules': walkPrometheusRules(sub, recordingRules, burnRateAlerts, alertRules, metricDefinitions, evidence, summary); return true;
      case 'prometheus-scrape-config': walkPrometheusScrapeConfig(sub, scrapeJobs, evidence, summary); return true;
      case 'actuator-metrics-config': walkActuatorMetricsConfig(sub, scrapeJobs, evidence, summary, repoName); return true;
      case 'alertmanager':     walkAlertmanager(sub, alertingRoutes, evidence, summary); return true;
      case 'otel-collector':   walkOtelCollector(sub, pipelines, scrapeJobs, evidence, summary, collectorState); return true;
      case 'grafana-dashboard':walkGrafanaDashboard(sub, dashboards, metricDefinitions, evidence, summary, provisioned); return true;
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
    const placed = folderOfKey(key);
    provisioned = placed ? { title: placed.title, source: placed.source } : null;
    let kind = 'unknown';

    if (/rule/.test(lk) || /^groups:\s*$/m.test(clean))                              kind = 'prometheus-rules';
    else if (/scrape/.test(lk) || /^scrape_configs:\s*$/m.test(clean))                kind = 'prometheus-scrape-config';
    else if (/application|bootstrap|actuator/.test(lk) || looksLikeActuatorMetricsConfig('', clean)) kind = 'actuator-metrics-config';
    else if (lk.endsWith('.json') || /"schemaVersion"\s*:/.test(clean))              kind = 'grafana-dashboard';
    else if (/^route:/m.test(clean) && /^receivers:/m.test(clean))                   kind = 'alertmanager';
    else if (/^receivers:/m.test(clean) && /^exporters:/m.test(clean) && /pipelines:/.test(clean)) kind = 'otel-collector';
    // A collector config with no service block: a prometheus receiver's
    // scrape jobs, or its exporters alone.
    else if (/^receivers:/m.test(clean) && (/^exporters:/m.test(clean) || /^\s+scrape_configs:/m.test(clean))) kind = 'otel-collector';

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

function walkDockerCompose(f, backends, pipelines, evidence, summary, mounts = null) {
  for (const obj of parseYamlDocs(f.content)) {
    if (!obj?.services) continue;
    for (const [svcName, svc] of Object.entries(obj.services)) {
    // The folders it bind-mounts from the repository: where a dashboard provider reads its files.
    if (mounts) mounts.push(...composeBindMounts(f.relPath, svc));
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

// ---- where a crawled dashboard is provisioned (the folder a live read files it under) ----
//
// A live read's folder scope keeps the dashboards of some Grafana folders; a
// crawled dashboard that does not say which folder it is provisioned into can
// only be "not checked" under it. The repository says so in three places, and
// only those are read (never a guess from a path alone):
//   - a dashboard provider file (provisioning/dashboards/*.yaml): each
//     provider's folder (a title; none is General), folder uid, the container
//     path it reads and foldersFromFilesStructure — matched to a dashboard file
//     through a compose bind mount of the folder holding it;
//   - a Helm chart's ConfigMap annotated (or labelled) for the Grafana sidecar
//     (`grafana_folder`, `k8s-sidecar-target-directory`): its own dashboard
//     data keys, and the chart files it ships with .Files.Glob / .Files.Get.
// A dashboard so placed carries `folder` (the title) and params folderTitle,
// folderUid (when stated) and folderSource (the file that says so).

// A repository path made plain: `.` and `..` resolved; null when it leaves the repository.
function normalizeRelPath(path) {
  const out = [];
  for (const seg of String(path).replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}
const containerPath = (path) => `/${normalizeRelPath(String(path).replace(/^\/+/, '')) ?? ''}`;

// A compose service's bind mounts of repository folders: { source (repository path), target (container path) }.
// Short syntax `<host>:<container>[:<mode>]` with a relative host path; long syntax `{ type: bind, source, target }`.
// A named volume, an absolute or home path and a templated value are not the repository's.
function composeBindMounts(composePath, svc) {
  const dir = composePath.includes('/') ? composePath.slice(0, composePath.lastIndexOf('/')) : '';
  const out = [];
  for (const v of Array.isArray(svc?.volumes) ? svc.volumes : []) {
    let source = null;
    let target = null;
    if (typeof v === 'string') [source, target] = v.split(':');
    else if (v && typeof v === 'object' && v.type === 'bind') ({ source, target } = v);
    if (typeof source !== 'string' || typeof target !== 'string') continue;
    source = source.trim();
    target = target.trim();
    if (!source || !target.startsWith('/') || source.startsWith('/') || /[$~{}\\]/.test(source)) continue;
    if (!source.startsWith('./') && !source.startsWith('../') && !source.includes('/')) continue;   // a named volume
    const resolved = normalizeRelPath(dir ? `${dir}/${source}` : source);
    if (resolved === null) continue;
    out.push({ source: resolved, target: containerPath(target) });
  }
  return out;
}

// A dashboard provider file's providers.
function walkDashboardProvider(f, providers, summary) {
  let n = 0;
  for (const obj of parseYamlDocs(f.content)) {
    for (const p of Array.isArray(obj?.providers) ? obj.providers : []) {
      if (!p || typeof p !== 'object') continue;
      const path = typeof p.options?.path === 'string' && p.options.path.trim() ? containerPath(p.options.path.trim()) : null;
      providers.push({
        relPath: f.relPath,
        folder: typeof p.folder === 'string' ? p.folder.trim() : '',
        folderUid: typeof p.folderUid === 'string' && p.folderUid.trim() ? p.folderUid.trim() : null,
        path,
        fromStructure: p.options?.foldersFromFilesStructure === true,
      });
      n += 1;
    }
  }
  summary.discovered.dashboardProviders = (summary.discovered.dashboardProviders || 0) + n;
}

// The Grafana sidecar's folder a chart template's documents state: per document, the title (the
// last segment of `grafana_folder` / `k8s-sidecar-target-directory`, an annotation or a label; a
// value the chart fills in at deploy time says nothing), its own data keys and the chart files it
// ships (.Files.Glob "<pattern>" / .Files.Get "<path>", relative to the chart's root).
function helmSidecarFolders(f) {
  const out = [];
  const chartRoot = f.relPath.includes('/templates/') ? f.relPath.slice(0, f.relPath.indexOf('/templates/'))
    : f.relPath.startsWith('templates/') ? '' : null;
  for (const doc of f.content.split(/^---\s*$/m)) {
    const m = /^\s*["']?(grafana_folder|k8s-sidecar-target-directory)["']?\s*:\s*(.+?)\s*$/m.exec(doc);
    if (!m) continue;
    const raw = m[2].replace(/^["']|["']$/g, '').trim();
    if (!raw || raw.includes('{{') || raw.includes('$')) continue;
    const title = raw.replace(/\/+$/, '').split('/').pop().trim();
    if (!title) continue;
    const keys = extractConfigMapData(doc).map((b) => b.key);
    const files = chartRoot === null ? [] : [...doc.matchAll(/\.Files\.(Glob|Get)\s+"([^"]+)"/g)].map((x) => ({ pattern: x[2], chartRoot }));
    out.push({ title, source: `${f.relPath} (ConfigMap ${m[1]})`, keys, files });
  }
  return out;
}

// A glob of .Files.Glob (`*` within a segment, `**` across them) as a test on a chart-relative path.
function chartGlob(pattern) {
  const p = String(pattern);
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      i += 1;
      if (p[i + 1] === '/') { i += 1; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// Each crawled dashboard file the repository provisions into a folder, placed there.
function resolveDashboardFolders(dashboards, { providers, mounts, helmFolders }, summary) {
  const place = (d, title, folderUid, source) => {
    d.folder = title;
    d.params = { ...(d.params || {}), folderTitle: title, ...(folderUid ? { folderUid } : {}), folderSource: source };
  };
  for (const d of dashboards) {
    const relPath = typeof d.source === 'string' && d.source.startsWith('file://') ? d.source.slice('file://'.length) : null;
    if (!relPath || relPath.includes('#') || d.params?.folderTitle) continue;
    // A chart's sidecar ConfigMap shipping this file.
    const shipped = helmFolders.flatMap((h) => h.files.filter((x) => {
      const under = x.chartRoot ? (relPath.startsWith(`${x.chartRoot}/`) ? relPath.slice(x.chartRoot.length + 1) : null) : relPath;
      return under !== null && chartGlob(x.pattern).test(under);
    }).map(() => h));
    const titles = [...new Set(shipped.map((h) => h.title))];
    if (titles.length === 1) { place(d, titles[0], null, shipped[0].source); continue; }
    if (titles.length > 1) continue;   // two folders say they ship it: none
    // A provider reading the folder a compose service mounts it from.
    const mount = mounts.find((x) => relPath === x.source || relPath.startsWith(`${x.source}/`));
    if (!mount) continue;
    const inContainer = `${mount.target}/${relPath.slice(mount.source.length).replace(/^\/+/, '')}`.replace(/\/+/g, '/');
    const fits = providers.filter((p) => p.path && (inContainer === p.path || inContainer.startsWith(`${p.path}/`)));
    if (!fits.length) continue;
    const longest = Math.max(...fits.map((p) => p.path.length));
    const best = fits.filter((p) => p.path.length === longest);
    if (best.length !== 1) continue;   // two providers equally good: none, never a guess
    const p = best[0];
    if (p.fromStructure) {
      const under = inContainer.slice(p.path.length + 1).split('/');
      place(d, under.length > 1 ? under[under.length - 2] : 'General', null, p.relPath);
    } else {
      place(d, p.folder || 'General', p.folderUid, p.relPath);
    }
  }
  const stated = dashboards.filter((d) => d.params?.folderTitle).length;
  if (stated) summary.discovered.dashboardFolders = stated;
}

// Compose interpolation with the variables unset: each `${VAR:-default}` or
// `${VAR-default}` its default, any other `${…}` nothing — innermost first.
function composeDefaults(value) {
  let text = String(value ?? '');
  for (let i = 0; i < 8; i++) {
    const next = text.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-([^${}]*))?[^${}]*\}/g, (_, fallback) => fallback ?? '');
    if (next === text) break;
    text = next;
  }
  return text;
}

function inferEndpoint(svc, product) {
  // Walk ports + healthcheck for a hint. We emit a relative URL so the
  // engineer can see where in the compose graph the backend lives.
  const ports = Array.isArray(svc?.ports) ? svc.ports : [];
  if (ports.length) {
    const port = containerPort(ports[0]);
    if (port) return `http://${product}:${port}`;
  }
  return null;
}

// A compose port entry's container port — the one the other services reach:
// `3000`, `13000:3000`, `127.0.0.1:13000:3000`, `[::1]:13000:3000`,
// `13000:3000/tcp`, a range's first port, the long form's `target`; a
// variable with a default (`${PORT:-3000}`, nested too) is its default, as
// `docker compose config` resolves it, and one without is no port.
function containerPort(entry) {
  if (isMapping(entry)) {
    const target = composeDefaults(entry.target).trim();
    return /^\d+$/.test(target) ? target : null;
  }
  const spec = composeDefaults(entry).trim().replace(/\/[a-z]+$/i, '');
  const m = /^(\d+)/.exec(spec.slice(spec.lastIndexOf(':') + 1));
  return m ? m[1] : null;
}

// LogQL the expression itself states: a stream selector (`{app="x"}`)
// followed by a pipeline stage PromQL has no operator for — a line filter
// (`|=`, `|~`, `|>`, `!~`, `!>`, or `!=` against a string: `!= "debug"`), a
// parser or format stage (`| json`, `| logfmt`, …) or a label filter
// (`| level="error"`). No Prometheus-compatible ruler can evaluate it. Never a
// guess from a shape PromQL has too: a selector over a range
// (`rate({app="x"}[5m])`) or before `!=` and a number or a series
// (`up{job="x"} != 1`) is valid PromQL, and a rule about Loki written in PromQL
// (a mixin's alerts on loki_* series) is a Prometheus rule wherever it ships.
const LOGQL_PIPELINE_RE = /\{[^}]*\}\s*(?:\||![~>]|!=\s*["`])/;
function statesLogQL(expr) {
  return LOGQL_PIPELINE_RE.test(String(expr || ''));
}

// What each Grafana-managed recording rule read states (grafanaRuleFacts), by
// its spec entry: the entry is the spec's closed RecordingRule, so the facts
// ride beside it (observogram.grafana_rule.queries.recording_rules[<i>]).
const GRAFANA_RECORDING_FACTS = new WeakMap();

// What a Grafana-managed rule states beyond the spec, as the repository writes
// it (sli-inference.mjs grafanaRuleFacts, given what its group states): its
// uid, folder and group, and its condition only when the repository states
// that whole — a node holding a value a chart fills in at deploy time (the
// placeholder stripGoTemplate leaves: a math expression's, a query's) states
// no condition, as a threshold that is not a number does not. Held against
// what Grafana runs, it would read as a difference that is not there; the
// pair says the condition went uncompared instead.
function grafanaFactsAsWritten(rule, group) {
  const facts = grafanaRuleFacts(rule, { folder: group.folder, folderUid: group.folderUid ?? group.folderUID, group: group.name });
  if (!facts?.condition || !new RegExp(`\\b${HELM_VALUE}\\b`).test(facts.condition)) return facts;
  const { condition: _notStated, ...stated } = facts;
  return Object.keys(stated).length ? stated : null;
}

// The engine that evaluates an alert rule, in the Product registry's words
// (spec 1.4 $defs/AlertEngine), as the rule's own source states it: a
// Grafana-managed rule by its shape (`title` + `data[]`), a Loki rule by the
// LogQL its expression is written in, everything else the Prometheus
// rule-file format — `prometheus`, the default, since a rule file cannot tell
// a Prometheus ruler from a Mimir, Thanos or VictoriaMetrics one (the backends
// do). Never by the path a file ships under: `loki/alerts.yml` and
// `loki-mixin.yaml` hold the PromQL rules a Prometheus evaluates about Loki,
// and a comparison parks a `loki` rule as not checked (no tool reads a Loki
// ruler), so a guess would hide a rule missing live.
function alertRuleEngine(rule) {
  if (isGrafanaManagedRule(rule)) return 'grafana';
  if (statesLogQL(alertRuleExpr(rule))) return 'loki';
  return 'prometheus';
}

// The PromQL a Grafana unified-alerting rule evaluates. A provisioned rule
// carries no `expr`; its queries sit in `data[].model`, one entry per
// datasource query or expression node. The model is a mapping in Grafana's
// own export and a JSON string in files written by other tooling (the HTTP
// provisioning API, Terraform). Returns the query the live reader reads too
// (sli-inference.mjs alertRuleExpr: the first node that is a query, never an
// expression step), or null when the rule has no query node. Throws when a
// model is a JSON string that does not parse: that rule cannot be read, the
// caller decides what to do.
function grafanaRuleExpr(rule) {
  if (!Array.isArray(rule?.data)) return null;
  for (const item of rule.data) {
    if (typeof item?.model !== 'string') continue;
    try { JSON.parse(item.model); }
    catch (e) { throw new Error(`model JSON could not be parsed (${e.message})`, { cause: e }); }
  }
  const expr = alertRuleExpr({ data: rule.data });
  // alertRuleExpr stands a ref (`A`) in for a rule with no query node: that is no query.
  return expr && !rule.data.some(n => n?.refId === expr) ? expr : null;
}

// An alerting rule as the ruler lists it. Its labels: the labels its group
// gives every rule (Prometheus 3, vmalert) under the rule's own — the rule's
// own label wins; and each label and annotation the text the file writes,
// where YAML would read a number or a boolean (a Go reader decoding into a
// string keeps `objective: 99.0` as "99.0", `page: True` as "True").
// `twin` gives the rule and its group read with numbers and booleans as
// written. `labelsUnread` when the group gives labels this reading cannot
// see: a map a chart or a deploy step fills in whole, or labels past the
// scan's copy budget (`mergeGroup` false, groupLabelsFit).
function asListed(rule, group, twin, mergeGroup = true) {
  const typed = (m) => isMapping(m) && Object.values(m).some((v) => typeof v === 'number' || typeof v === 'boolean');
  const shared = group?.labels;
  const grouped = shared !== null && shared !== undefined && shared !== '';
  // The group's labels are looked at only when they will be merged: past the
  // budget their size is the reason not to.
  const retyped = typed(rule.labels) || typed(rule.annotations) || (grouped && mergeGroup && typed(shared));
  if (!grouped && !retyped) return { rule };
  const asWritten = retyped ? twin() : {};
  const written = (typedValue, writtenValue) => (isMapping(writtenValue) ? writtenValue : typedValue);
  const out = { ...rule };
  if (retyped && isMapping(rule.labels)) out.labels = written(rule.labels, asWritten.rule?.labels);
  if (retyped && isMapping(rule.annotations)) out.annotations = written(rule.annotations, asWritten.rule?.annotations);
  if (!grouped) return { rule: out };
  if (!isMapping(shared) || !mergeGroup) return { rule: out, labelsUnread: true };
  const groupLabels = retyped ? written(shared, asWritten.group?.labels) : shared;
  if (out.labels === null || out.labels === undefined) out.labels = { ...groupLabels };
  else if (isMapping(out.labels)) out.labels = { ...groupLabels, ...out.labels };
  return { rule: out };
}

// The label entries one scan may copy from rule groups into their alerting
// rules. The ruler copies them into every rule; a file of thousands of rules
// under thousands of group labels would make millions here. Past the budget
// a group's labels are not added to its rules — which then state no rules
// (asListed's labelsUnread) — and the scan says so.
const GROUP_LABEL_COPIES = 250_000;
const groupLabelCopies = new WeakMap();   // a scan's summary → the copies it made
function groupLabelsFit(group, rules, f, summary) {
  if (!isMapping(group?.labels)) return true;
  const alerting = rules.filter((r) => r && (r.alert || r.title)).length;
  const copies = Object.keys(group.labels).length * alerting;
  const used = groupLabelCopies.get(summary) ?? 0;
  if (used + copies <= GROUP_LABEL_COPIES) {
    groupLabelCopies.set(summary, used + copies);
    return true;
  }
  summary.warnings.push(`${f.relPath}: the labels of group ${JSON.stringify(String(group.name ?? '_'))} were not added to its ${alerting} alerting rule(s): past ${GROUP_LABEL_COPIES} label copies in this scan`);
  return false;
}

function walkPrometheusRules(f, recordingRules, burnRateAlerts, alertRules, metricDefinitions, evidence, summary) {
  // A rule that cannot be read is skipped on its own; the file and its other
  // rules survive, and one warning per file says how many were lost and why.
  let ruleCount = 0;
  const skipped = [];
  // Grafana's alert-rule export written as JSON reads as the YAML one (a
  // ConfigMap key reaches here as `<file>#<key>.json`); JSON states its
  // numbers and booleans as typed, so it is its own as-written reading.
  const json = /\.json$/i.test(f.relPath);
  // The same file read with numbers and booleans as written, only once a
  // rule's labels or annotations hold one (asListed) — and once: a second
  // reading of a text the walk has already been charged for, so apart from
  // the scan's alias budget; if it fails, the rules keep the typed reading.
  let written = null;
  const writtenDocs = () => {
    if (written === null) {
      try { written = json ? [JSON.parse(f.content)] : apartFromAliasBudget(() => parseYamlDocs(f.content, { asWritten: true })); } catch { written = []; }
    }
    return written;
  };
  (json ? [JSON.parse(f.content)] : parseYamlDocs(f.content)).forEach((obj, d) => {
    if (!Array.isArray(obj?.groups)) return;
    obj.groups.forEach((group, g) => {
      const rules = Array.isArray(group?.rules) ? group.rules : [];
      const mergeGroup = groupLabelsFit(group, rules, f, summary);
      rules.forEach((rule, r) => {
        ruleCount++;
        const twin = () => {
          const writtenGroup = writtenDocs()[d]?.groups?.[g];
          return { group: writtenGroup, rule: writtenGroup?.rules?.[r] };
        };
        try {
          walkPrometheusRule(f, group, rule, recordingRules, burnRateAlerts, alertRules, metricDefinitions, evidence, summary, twin, mergeGroup);
        } catch (e) {
          skipped.push(e?.message || String(e));
        }
      });
    });
  });
  if (skipped.length) {
    const reason = skipped.every(m => /^model JSON could not be parsed/.test(m))
      ? 'model JSON could not be parsed'
      : skipped[0];
    summary.warnings.push(`Skipped ${skipped.length} of ${ruleCount} alert rule(s) in ${f.relPath}: ${reason}`);
  }
}

function walkPrometheusRule(f, group, rule, recordingRules, burnRateAlerts, alertRules, metricDefinitions, evidence, summary, twin = () => ({}), mergeGroup = true) {
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
    // The spec declares metric names with a `:` only (the reading the live
    // fetcher already applies); any other name is recorded as omitted.
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
    // A Grafana-managed recording rule says so beside the entry (no ruler a live read lists holds it).
    const facts = grafanaFactsAsWritten(rule, group);
    if (facts) GRAFANA_RECORDING_FACTS.set(entry, facts);
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
    const listed = asListed(rule, group, twin, mergeGroup);
    const base = grafanaExpr === null ? listed.rule : { ...listed.rule, expr: grafanaExpr };
    // A Grafana-managed rule's uid, folder (the group's, a title), group and
    // condition (its threshold): what the spec's AlertRule cannot hold.
    const facts = grafanaFactsAsWritten(rule, group);
    const read = facts ? { ...base, grafana: facts } : base;
    const candidate = burnCandidateFromAlertRule(read);
    const { alertName, expr } = candidate;
    // Every alert rule that reads is kept raw as well, with where it was
    // read from: the ones that turn out to guard no SLO are declared in
    // alerting.rules (crawlFiles), name for name. A rule skipped above
    // (its model could not be read) is not declared either.
    alertRules.push({
      rule: read, relPath: f.relPath, source: `${f.relPath}#${group.name || '_'}/${alertName}`, name: alertName,
      // Labels the group gives every rule that this reading cannot see (sourceRuleAnnotations).
      ...(listed.labelsUnread ? { labelsUnread: true } : {}),
    });
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
  for (const obj of parseYamlDocs(f.content)) walkScrapeConfigDoc(obj, f.relPath, scrapeJobs, evidence, summary);
}

// One Prometheus config document's scrape jobs — a standalone prometheus.yml
// or the `config:` of an OTel collector's prometheus receiver (`collector`
// then names the receiver and the exporters its samples leave by).
// Answers how many jobs it added. In a collector config a job this walk
// cannot read is warned about and skipped (its siblings and the rest of the
// config are still read); a standalone prometheus.yml reads as before.
function walkScrapeConfigDoc(obj, origin, scrapeJobs, evidence, summary, collector = null) {
  if (!Array.isArray(obj?.scrape_configs)) return 0;
  let added = 0;
  for (const cfg of obj.scrape_configs) {
    const job = String(cfg?.job_name || '').trim();
    if (!job) continue;
    const read = () => {
      // Promtail and Alloy use the same `scrape_configs` / `job_name` keys
      // to say which LOG FILES to tail. Such an entry is not a metrics
      // scrape job and never appears among a metrics store's targets;
      // declaring it made it read "not live" on every platform.
      if (isLogScrapeConfig(cfg, obj)) {
        summary.discovered.logScrapeConfigs = (summary.discovered.logScrapeConfigs || 0) + 1;
        return;
      }
      if (addScrapeJob(scrapeJobs, evidence, summary, {
        job,
        metrics_path: cfg.metrics_path || '/metrics',
        interval: cfg.scrape_interval || obj.global?.scrape_interval || null,
        targets: scrapeTargets(cfg),
        origin,
        ...(collector ? {
          via: 'otel-collector',
          receiver: collector.receiver,
          target_count: (Array.isArray(cfg.static_configs) ? cfg.static_configs : []).reduce((n, sc) => n + (Array.isArray(sc?.targets) ? sc.targets.filter(Boolean).length : 0), 0),
          exporters: collector.exporters,
        } : {}),
      })) added++;
    };
    if (!collector) { read(); continue; }
    try { read(); }
    catch (e) { summary.warnings.push(`Scrape job '${job}' of receiver ${collector.receiver} in ${origin} could not be read (${e.message}); the rest of the config is read.`); }
  }
  return added;
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
  if (!item?.job) return false;
  if (scrapeJobs.some(j => j.job === item.job && j.origin === item.origin)) return false;
  scrapeJobs.push(item);
  if (!evidence[`scrape.${item.job}`]) evidence[`scrape.${item.job}`] = item.origin;
  summary.discovered.scrapeJobs++;
  return true;
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

// An OTel collector config: its pipelines (receivers, processors, the
// exporter per signal) and the scrape jobs of its prometheus receivers. A
// config with no `service:` block (a Helm chart's files/ copy, assembled
// with the pipelines elsewhere) still names its receivers and exporters:
// the prometheus receivers' jobs are read, and the metrics exporter it
// configures is a guess, settled after the walk (settleCollectorGuesses).
function walkOtelCollector(f, pipelines, scrapeJobs, evidence, summary, state = newCollectorState()) {
  for (const obj of parseYamlDocs(f.content)) walkOtelCollectorDoc(obj, f.relPath, pipelines, scrapeJobs, evidence, summary, state);
}

// What the walk learns about collector configs across files: each metrics
// pipeline declared (its receivers and exporters, with the exporters'
// configs), and each pipeline-less config's guess.
function newCollectorState() {
  return { declared: [], guesses: [] };
}

function walkOtelCollectorDoc(obj, relPath, pipelines, scrapeJobs, evidence, summary, state) {
  const scrapeReceivers = collectorScrapeReceivers(obj);
  const exporterCfgs = isMapping(obj?.exporters) ? obj.exporters : {};
  if (obj?.service?.pipelines) {
    const seen = new Set();
    for (const pipeline of Object.values(obj.service.pipelines)) {
      // `metrics: null` removes a pipeline (the Helm chart's idiom).
      if (!isMapping(pipeline)) continue;
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
    evidence[`PIP-${summary.discovered.pipelines + 1}`] = relPath;
    summary.discovered.pipelines++;
    for (const [sig, p] of Object.entries(obj.service.pipelines)) {
      if (/^metrics/i.test(sig) && isMapping(p) && Array.isArray(p.receivers)) {
        state.declared.push({ receivers: p.receivers, exporters: Array.isArray(p.exporters) ? p.exporters : [], cfgs: exporterCfgs });
      }
    }
    // Each scrape receiver's samples leave by the exporters of the metrics
    // pipelines that list it.
    for (const { key, config } of scrapeReceivers) {
      const names = [];
      for (const [sig, p] of Object.entries(obj.service.pipelines)) {
        if (!/^metrics/i.test(sig) || !Array.isArray(p?.receivers) || !p.receivers.includes(key)) continue;
        for (const exp of p.exporters || []) if (!names.includes(exp)) names.push(exp);
      }
      const exporters = names.map(n => collectorExporterDetail(n, exporterCfgs[n]));
      const jobs = walkScrapeConfigDoc(config, relPath, scrapeJobs, evidence, summary, { receiver: key, exporters });
      // No metrics pipeline here lists the receiver: another file's may (a
      // config split across --config files), settled after the walk.
      if (!names.length) state.guesses.push({ relPath, candidates: [], cfgs: exporterCfgs, groups: [{ receiver: key, exporters, jobs }], receivers: [] });
    }
    return;
  }

  // No pipelines: the metrics exporter is the metrics-capable exporter the
  // config names (the first when it names several) — a guess. Its scrape
  // jobs carry it for now; settleCollectorGuesses replaces it with a
  // declared pipeline's exporters when one lists the receiver, and applies
  // it to spec.pipelines only when nothing else set the metrics exporter.
  const candidates = Object.keys(exporterCfgs).filter(n => METRICS_EXPORTER_TYPES.has(n.split('/')[0].toLowerCase()));
  const chosen = candidates[0] || null;
  if (!scrapeReceivers.length && !chosen) return;
  const groups = [];
  for (const { key, config } of scrapeReceivers) {
    // One array per receiver, shared with its jobs' entries (patched in place).
    const exporters = chosen ? [collectorExporterDetail(chosen, exporterCfgs[chosen])] : [];
    const jobs = walkScrapeConfigDoc(config, relPath, scrapeJobs, evidence, summary, { receiver: key, exporters });
    groups.push({ receiver: key, exporters, jobs });
  }
  state.guesses.push({ relPath, candidates, cfgs: exporterCfgs, groups, receivers: scrapeReceivers.map(({ key }) => key.split('/')[0]) });
}

// After every file is walked: a pipeline-less config's scrape jobs leave by
// the exporters of the declared metrics pipelines that list their receiver
// (a config split across --config files), else by its guess; its receivers
// join spec.pipelines; the first guess sets spec.pipelines.exporters.metrics
// only when nothing else set it (no declared pipeline, no metrics backend
// image). A first-of-several guess left standing is warned about.
function settleCollectorGuesses(state, pipelines, evidence, summary) {
  const warned = new Set();
  const warnFirstOfSeveral = (g) => {
    if (g.candidates.length < 2 || warned.has(g.relPath)) return;
    warned.add(g.relPath);
    summary.warnings.push(`${g.relPath} has no service pipelines and ${g.candidates.length} metrics-capable exporters (${g.candidates.join(', ')}); the metrics exporter is taken to be the first, '${g.candidates[0]}'.`);
  };
  for (const g of state.guesses) {
    for (const group of g.groups) {
      const names = [];
      const cfgOf = {};
      for (const d of state.declared) {
        if (!d.receivers.includes(group.receiver)) continue;
        for (const n of d.exporters) {
          if (typeof n !== 'string') continue;
          if (!names.includes(n)) names.push(n);
          if (isMapping(d.cfgs?.[n]) && Object.keys(d.cfgs[n]).length && !cfgOf[n]) cfgOf[n] = d.cfgs[n];
        }
      }
      if (names.length) {
        group.exporters.splice(0, group.exporters.length,
          ...names.map(n => collectorExporterDetail(n, isMapping(g.cfgs[n]) && Object.keys(g.cfgs[n]).length ? g.cfgs[n] : cfgOf[n])));
      } else if (group.exporters.length && group.jobs) {
        warnFirstOfSeveral(g);
      }
    }
    for (const name of g.receivers) {
      if (!pipelines.receivers.some(r => r.name === name)) pipelines.receivers.push({ name });
    }
  }
  const first = state.guesses.find(g => g.candidates.length);
  if (!pipelines.exporters.metrics && first) {
    pipelines.exporters.metrics = { kind: mapExporterKind(first.candidates[0].split('/')[0]) };
    evidence['pipelines.exporters.metrics'] = first.relPath;
    warnFirstOfSeveral(first);
    evidence[`PIP-${summary.discovered.pipelines + 1}`] = first.relPath;
    summary.discovered.pipelines++;
  }
}

// Collector exporters that carry metrics, by component type.
const METRICS_EXPORTER_TYPES = new Set([
  'kafka', 'prometheusremotewrite', 'prometheus', 'otlp', 'otlphttp',
  'googlemanagedprometheus', 'awsemf', 'datadog', 'influxdb', 'clickhouse',
  'signalfx', 'carbon', 'azuremonitor', 'splunk_hec', 'sumologic',
]);

// A collector's prometheus receivers (`prometheus`, `prometheus/<name>`)
// that state scrape jobs: [{ key, config }].
function collectorScrapeReceivers(obj) {
  if (!isMapping(obj?.receivers)) return [];
  return Object.entries(obj.receivers)
    .filter(([key, r]) => /^prometheus(\/|$)/.test(key) && isMapping(r?.config) && Array.isArray(r.config.scrape_configs))
    .map(([key, r]) => ({ key, config: r.config }));
}

// An OTel collector config by shape: receivers, exporters and pipelines (a
// full config), or a receivers mapping with a prometheus receiver's scrape
// jobs or with exporters (one with no service block). Alertmanager's
// `receivers` is a list, never a mapping.
function looksLikeOtelCollector(obj) {
  if (obj.receivers && obj.exporters && obj.service?.pipelines) return true;
  if (!isMapping(obj.receivers)) return false;
  return collectorScrapeReceivers(obj).length > 0 || isMapping(obj.exporters);
}

// What a collector exporter is and where it sends: a kafka exporter's
// metrics topic, any other's endpoint — reduced by safeSourceUrl, so no
// userinfo, query or fragment is recorded.
function collectorExporterDetail(name, cfg) {
  const type = String(name).split('/')[0];
  const out = { name: String(name), kind: mapExporterKind(type) };
  if (/^kafka$/i.test(type)) {
    const topic = cfg?.metrics?.topic ?? cfg?.topic;
    if (typeof topic === 'string' && topic.trim()) out.topic = topic.trim();
  } else {
    const endpoint = cfg?.endpoint ?? cfg?.metrics_endpoint;
    const safe = typeof endpoint === 'string' ? safeSourceUrl(endpoint) : '';
    if (safe) out.endpoint = safe;
  }
  return out;
}

// The scrape jobs or exporter evidence a file carries, as one line for the
// environment-scope warning (`<file> (scrape jobs: a, b)`), or null.
function collectionEvidenceOf(relPath, content, catalogue) {
  if (typeof content !== 'string') return null;
  let kind;
  try { kind = detectArtefactKind(relPath, content, { exporterCatalogue: catalogue }); } catch { return null; }
  const jobsOf = (docs) => docs.flatMap(d => (Array.isArray(d?.scrape_configs) ? d.scrape_configs : []))
    .map(c => String(c?.job_name || '').trim()).filter(Boolean);
  try {
    if (kind === 'prometheus-scrape-config') {
      const jobs = jobsOf(parseYamlDocs(content));
      return jobs.length ? `${relPath} (scrape jobs: ${jobs.join(', ')})` : null;
    }
    if (kind === 'otel-collector') {
      const jobs = jobsOf(parseYamlDocs(content).flatMap(d => collectorScrapeReceivers(d).map(r => r.config)));
      return jobs.length ? `${relPath} (collector scrape jobs: ${jobs.join(', ')})` : null;
    }
    if (kind === 'exporter-config') {
      const entry = matchExporterConfig(parseYaml(content, repoYaml), catalogue);
      return `${relPath} (exporter config: ${entry?.id ?? 'unknown'})`;
    }
    if (kind === 'helm-values') {
      const jobs = jobsOf(parseYamlDocs(content).flatMap(d => valuesCollectorConfigs(d))
        .flatMap(c => collectorScrapeReceivers(c).map(r => r.config)));
      return jobs.length ? `${relPath} (collector scrape jobs: ${jobs.join(', ')})` : null;
    }
    if (kind === 'helm-template') {
      // The jobs the template's walker would read (its ConfigMap values or
      // the whole template), walked into throwaway buckets.
      const buckets = {
        backends: [], recordingRules: [], burnRateAlerts: [], alertRules: [], metricDefinitions: [], scrapeJobs: [],
        alertingRoutes: [], dashboards: [], collectorState: newCollectorState(), repoName: null,
        pipelines: { receivers: [], processors: [], exporters: { metrics: null, logs: null, traces: null } },
      };
      const scratch = {
        discovered: {}, warnings: [], invented: { endpoints: [], channels: [] },
        omitted: { syntheticRecordingRules: [], unresolvedChannels: [], recordingRules: [], ruleIntervals: [] },
      };
      walkHelmTemplate({ relPath, content }, buckets, {}, scratch);
      const jobs = [...new Set(buckets.scrapeJobs.map(j => j.job))];
      return jobs.length ? `${relPath} (template scrape jobs: ${jobs.join(', ')})` : null;
    }
  } catch { /* unreadable: nothing to report */ }
  return null;
}

// ---------- prebuilt exporters ----------

// A metrics manifest: each entry is a declared metric of the exporter.
function walkMetricsManifest(f, metricDefinitions, metricFamilies, exporters, summary, evidence) {
  const read = readMetricsManifest(f.content);
  if (!read.ok) {
    summary.warnings.push(`${f.relPath} is not a metrics manifest (${read.error}); it is not read.`);
    return;
  }
  const m = read.manifest;
  for (const metric of m.metrics) {
    addMetricDefinition(metricDefinitions, evidence, summary, {
      name: metric.name,
      type: metric.type,
      help: metric.help,
      labels: metric.labels,
      service: m.exporter,
      origin: f.relPath,
      originKind: 'exporter-manifest',
      confidence: 'declared',
    });
  }
  if (read.skipped) {
    summary.warnings.push(`${f.relPath}: ${read.skipped} metric entr${read.skipped === 1 ? 'y is' : 'ies are'} not read (each needs a metric name not listed before and an exposition type: ${['counter', 'gauge', 'histogram', 'summary', 'untyped'].join(', ')}, …).`);
  }
  let familiesRead = 0;
  for (const family of m.dynamicFamilies) {
    const other = metricFamilies.find(x => x.pattern === family.pattern);
    if (other) {
      summary.warnings.push(`${f.relPath}: a dynamic family repeats a pattern ${other.file} declares; the first is kept.`);
    } else if (metricFamilies.length >= DYNAMIC_FAMILY_LIMITS.families) {
      summary.warnings.push(`${f.relPath}: a dynamic family is not read: the crawl holds ${DYNAMIC_FAMILY_LIMITS.families} already.`);
    } else {
      metricFamilies.push({ ...family, exporter: m.exporter, file: f.relPath });
      familiesRead++;
      summary.discovered.dynamicFamilies = (summary.discovered.dynamicFamilies || 0) + 1;
    }
  }
  for (const { index, reason } of read.refusedFamilies) {
    summary.warnings.push(`${f.relPath}: ${index === null ? '`dynamicFamilies` is' : `dynamic family ${index + 1} is`} not read: ${reason}.`);
  }
  recordExporter(exporters, m.exporter, {
    origin_kind: 'exporter-manifest',
    file: f.relPath,
    metrics: m.metrics.length,
    ...(familiesRead ? { dynamic_families: familiesRead } : {}),
    ...(m.version ? { version: m.version } : {}),
    ...(m.source ? { source: m.source } : {}),
    ...(m.generatedAt ? { generated_at: m.generatedAt } : {}),
  }, summary);
}

// A saved exposition: the exporter is named by the file (`ibm-mq.prom` →
// ibm-mq).
function walkExpositionSnapshot(f, metricDefinitions, exporters, summary, evidence) {
  const { families } = parseExposition(f.content);
  const exporter = basenameOf(f.relPath).replace(/\.(prom|metrics)$/i, '') || 'exporter';
  for (const fam of families) {
    addMetricDefinition(metricDefinitions, evidence, summary, {
      name: fam.name,
      type: fam.type,
      help: fam.help,
      labels: fam.labels,
      service: exporter,
      origin: f.relPath,
      originKind: 'exporter-snapshot',
      confidence: 'declared',
    });
  }
  recordExporter(exporters, exporter, { origin_kind: 'exporter-snapshot', file: f.relPath, metrics: families.length }, summary);
}

// An exporter's own config, read against the catalogue: the families it
// switches on, as candidates.
function walkExporterConfig(f, catalogue, metricDefinitions, exporters, summary, evidence) {
  for (const obj of parseYamlDocs(f.content)) {
    const entry = matchExporterConfig(obj, catalogue);
    if (!entry) continue;
    const inferred = inferExporterFamilies(obj, entry);
    for (const fam of inferred.families) {
      addMetricDefinition(metricDefinitions, evidence, summary, {
        name: fam.name,
        type: fam.type,
        help: fam.help,
        labels: fam.labels,
        service: entry.id,
        origin: f.relPath,
        originKind: 'exporter-config',
        confidence: 'inferred',
        candidateOnly: true,
      });
    }
    recordExporter(exporters, entry.id, {
      origin_kind: 'exporter-config',
      file: f.relPath,
      metrics: inferred.families.length,
      namespace: inferred.namespace,
      gates: inferred.gates,
      scopes: inferred.scopes,
    }, summary);
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

function walkGrafanaDashboard(f, dashboards, metricDefinitions, evidence, summary, provisioned = null) {
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
    // The folder the repository provisions it into, where it says so (a sidecar ConfigMap here;
    // provider files after the walk, resolveDashboardFolders); else a guess from its first tag.
    folder: provisioned?.title || dash.tags?.[0] || 'crawled',
    source: `file://${f.relPath}`,
    params: {
      title: dash.title || id,
      uid: dash.uid || '',
      ...(provisioned ? { folderTitle: provisioned.title, folderSource: provisioned.source } : {}),
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
    .sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref, 'en'));
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
