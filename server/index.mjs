#!/usr/bin/env node
/**
 * server/index.mjs
 *
 * Express server for Observogram v0.3+.
 *
 * Responsibilities:
 *   - Serve the studio HTML/CSS/JS shell from studio/.
 *   - Expose a JSON API that runs the validator, adapter, and conformance
 *     scorer server-side. The browser fetches adapted layered packs and
 *     pre-computed conformance reports; no in-browser YAML parsing, no
 *     in-browser schema validation, no embedded pack literals.
 *
 * Routes:
 *   GET  /                                Studio HTML shell
 *   GET  /healthz                         Liveness probe
 *   GET  /api/packs                       Pack catalog
 *   GET  /api/packs/:id                   Adapted layered pack (?env=<name>)
 *   GET  /api/packs/:id/canonical         Canonical manifest + env overlay (?env=<name>)
 *   GET  /api/packs/:id/conformance       Maturity-rubric scoring (?env=<name>; onPlaceholder for a library-built pack; graded at the service record's tier when one is set — `tier`)
 *   GET  /api/packs/:id/verdicts          A reviewer's verdicts on the pack's artefacts (server/routes/verdicts.mjs; PUT / DELETE …/verdicts/:artefact record and clear one)
 *   GET  /api/maturity-rubric             Rubric metadata (clause definitions)
 *   POST /api/validate                    Validate uploaded JSON/YAML body (summary.onPlaceholder for a library-built pack)
 *   GET  /api/library                     The pack library index (BUILD journey, docs/BUILD_JOURNEY.md)
 *   GET  /api/library/requirements/:tier  The conformance clauses that apply at a tier
 *   GET  /api/library/:id                 One library entry: index row + full SLI templates and params
 *   POST /api/library/instantiate         Library entries + name/tier/env/owners/params/toggles/overrides/custom → canonical pack, todos, summary, adapted
 *   POST /api/library/compile             { canonical | the instantiate inputs, target } → one compiled artefact, nothing registered
 *   POST /api/library/register            { canonical | the instantiate inputs, source? } → the upload registry (as /api/validate registers)
 *
 * Env:
 *   PORT   default 8000
 *   HOST   default 127.0.0.1
 */

import express from 'express';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, emit as emitYaml } from '../tools/lib/mini-yaml.mjs';
import { adapt, listEnvironments, overlaidCanonical } from '../tools/lib/adapter.mjs';
import { serviceMetadata, catalogEntryOf, livePackKind } from '../tools/lib/service-keys.mjs';
import { isLegacyLayeredPack, upconvertLegacyPack } from '../tools/lib/legacy.mjs';
import { validateCanonical, SPEC_VERSION, SPEC_DIR, SPEC_SCHEMA_PATH } from '../tools/lib/validator.mjs';
import { evaluateConformance, RUBRIC } from '../tools/lib/conformance.mjs';
import { crawlFiles, crawlToYaml } from '../tools/lib/crawler.mjs';
import { fetchMcp, buildCanonicalPack } from '../tools/fetch-live-pack.mjs';
import { diffPacks } from '../tools/lib/diff.mjs';
import { comparePackBranches } from '../tools/lib/traceability-graph.mjs';
import { compile, listTargets, compileCatalog, compileArtifact, TARGETS } from '../tools/lib/compile.mjs';
import { makeZip } from '../tools/lib/zip.mjs';
import { loadLibrary, findEntry } from './library.mjs';
import {
  libraryIndex, tierRequirements, instantiatePack, validationSummary, todosFromAnnotations, hasLibraryTodos,
  TIERS, SCAFFOLD_PARAMS,
} from '../tools/lib/library.mjs';
import { parsePromqlDependencies as parsePromql } from '../tools/lib/promql-lezer.mjs';
import { workspaceInfo, writeLivePack, readLivePack, LIVE_PACK_FILE } from './workspace.mjs';
import { registerPack, uploadsMap, ensureOrgLoaded, touchPack, clearPacks, contentHash, slugify } from './pack-registry.mjs';
import {
  listJourneys, loadJourneyDef, runJourney, readJourneyRuns, saveJourneyDef, validateGateStack,
  validateSchedule, validateStackBudget, validateNotify,
} from '../tools/lib/journey.mjs';
import { retrofeedShadowSignals } from '../tools/lib/retrofeed.mjs';
import { initAuth, localUsersEnabled, touchSessionSecret } from './auth.mjs';
import { describeProxyAuth } from './auth-proxy.mjs';
import { stripMcpUrl, mcpUrlOrigin, droppedNote } from './mcp-url.mjs';
import { mcpCallerOf, mcpRefusalBody, redactTarget } from './mcp-target-policy.mjs';
import { parseGithubUrl, isCrawlerFile, ghFetch } from './github-crawl.mjs';
import { deployRoutes } from './routes/deploy.mjs';
import { auditAfter, actorForRecord, bounded, finite } from './audit-after.mjs';
import { identityRoutes } from './routes/identity.mjs';
import { servicesRoutes } from './routes/services.mjs';
import { auditRoutes } from './routes/audit.mjs';
import { verdictsRoutes } from './routes/verdicts.mjs';
import { waiversRoutes } from './routes/waivers.mjs';
import { auditReportRoutes } from './routes/audit-report.mjs';
import { liveRoutes, livePackCounts } from './routes/live.mjs';
import { mcpSettingsRoutes } from './routes/mcp-settings.mjs';
import { abortAllLiveJobs } from './live-jobs.mjs';
import { verdictsDocument } from './verdict-admin.mjs';
import { journeyPackBSource, resolveJourneyMcp, resolveMcpTarget, serviceTierFor } from './service-admin.mjs';
import { conformanceWaivers, listWaiverViews } from './waiver-admin.mjs';
import { authGate, orgContext, authorize, effectiveRoleOf, rankOf, rankOfRole } from './authz.mjs';
import { versionInfo } from './version.mjs';
import { buildInfo, buildLabel } from './build-info.mjs';
import { runWithOrg, currentOrg, orgWorkspaceRoot, baseWorkspaceRoot, orgRootOf } from './tenancy.mjs';
import { setWorkspaceRootResolver } from '../tools/lib/journey.mjs';
import { recordIdentityMode, bootStore } from './boot.mjs';
import { currentStore } from './store/db.mjs';
import { defaultOrgId } from './store/identity.mjs';
import { getOrg, listOrgs } from './store/orgs.mjs';
import { listMembershipsForUser } from './store/memberships.mjs';
import { brandEnv, loadBrand, brandSource } from '../tools/lib/brand-env.mjs';
import { brandShellHtml, DEFAULT_BRAND } from '../tools/lib/brand.mjs';
import { loadTaxonomy, taxonomyAnswer } from './taxonomy.mjs';
import { loadSettingsPolicy } from './mcp-settings-policy.mjs';
import { mcpTransport, describeTransport } from '../tools/mcp-transport.mjs';
import { STACK_SELF_METRIC_PROBES, STACK_OUTCOMES, displayHint } from '../tools/lib/contracts/stack-self-metrics.mjs';
import { stackSummary } from '../tools/lib/stack-evidence.mjs';
import { parseSchedule } from '../tools/lib/schedule.mjs';
import { scheduleSnippets } from '../tools/lib/schedule-snippets.mjs';
import { NOTIFY_DEFAULT_POLICY, NOTIFY_DEFAULT_FORMAT } from '../tools/lib/journey-notify.mjs';
import { chainSummary, topCause } from '../tools/lib/chain-history.mjs';
import { inventorySummary } from '../tools/lib/inventory-coverage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const STUDIO_DIR = resolve(ROOT, 'studio');
const SCHEMA_PATH = resolve(ROOT, SPEC_SCHEMA_PATH);
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

// ---------- pack catalog ----------
//
// The studio boots EMPTY by design (Phase 7q). No packs are auto-loaded.
// The user opens a pack from disk via:
//   - Upload (drag-drop or file picker)
//   - "New from repo" (Path A — crawler)
//   - "New from live" (Path B — MCP draft)
//   - GET /api/examples to browse archived reference packs in examples/
//
// The five previously bundled packs (Payment service, Target advanced,
// Production curated, Production live, Demo skeleton) now live under
// examples/ as reference material, surfaced via /api/examples but not
// auto-loaded into the catalog.

const PACK_CATALOG = [];

// Examples directory — archived reference packs. Browsed on demand via
// the home screen's "Browse examples" link. Each entry mirrors the
// catalog shape so the existing /api/packs/:id paths keep working when
// the user opens an example.
// Labels intentionally omit the tier — it renders as a separate badge
// in the picker, so duplicating it in the name reads as noise.
const EXAMPLE_PACKS = [
  {
    id: 'payment-service',
    label: 'Payment service (canonical example)',
    path: `${SPEC_DIR}/examples/payment-service.pack.yaml`,
    description: "The spec repo's reference tier-1 pack — HTTP API + Kafka consumer.",
  },
  {
    id: 'target-advanced',
    label: 'Target advanced (aspirational reference)',
    path: 'examples/target-advanced.pack.yaml',
    description: 'Aspirational tier-1 — 100% MUST conformance, all 5 SHOULDs pass.',
  },
  {
    id: 'production-curated',
    label: 'Production curated (hand-authored baseline)',
    path: 'examples/production-curated.pack.yaml',
    description: 'Hand-curated baseline with intentional gaps the conformance panel surfaces.',
  },
];

// Catalogue reference packs — the curated, evidence-cited "state of the
// art" packs for well-known observability components (Kafka, Prometheus,
// Grafana). These are NOT example packs: they live under reference-packs/
// and are surfaced through the studio's Advanced → References view (the
// reference component analysis), where the user benchmarks their own pack
// against best practice. Browsed via GET /api/references; loaded as Pack B
// via /api/packs/:id. Keep in sync with LENS_PRODUCTS in studio/app.mjs.
const REFERENCE_PACKS = [
  {
    id: 'kafka-reference',
    label: 'Kafka (catalogue reference)',
    path: 'reference-packs/kafka.pack.yaml',
    description: 'State-of-the-art reference pack for Apache Kafka 3.x. Five operational vital signs, multi-window burn-rate alerts, 4 chaos experiments. Every section evidence-cited in docs/catalogue-evidence/kafka.md.',
    catalogue: true,
  },
  {
    id: 'prometheus-reference',
    label: 'Prometheus (catalogue reference)',
    path: 'reference-packs/prometheus.pack.yaml',
    description: 'State-of-the-art reference pack for Prometheus 2.45+ self-monitoring (via Meta-Prometheus pattern). Eight operational vital signs, 4 chaos experiments. Every section evidence-cited in docs/catalogue-evidence/prometheus.md.',
    catalogue: true,
  },
  {
    id: 'grafana-reference',
    label: 'Grafana (catalogue reference)',
    path: 'reference-packs/grafana.pack.yaml',
    description: 'State-of-the-art reference pack for Grafana 11.x including unified alerting. Eight operational vital signs (HTTP, datasource proxy, database, alerting evaluation, plugins, login), 4 chaos experiments, 3-layer synthetic checks. Paired with the Prometheus reference pack. Every section evidence-cited in docs/catalogue-evidence/grafana.md.',
    catalogue: true,
  },
];

function loadPackFile(relPath) {
  const abs = resolve(ROOT, relPath);
  if (!existsSync(abs)) throw new Error(`pack file missing: ${relPath}`);
  const text = readFileSync(abs, 'utf8');
  const ext = extname(relPath).toLowerCase();
  return ext === '.json' ? JSON.parse(text) : parseYaml(text);
}

// ---------- uploaded / crawled / drafted packs registry ----------
//
// In-memory registry for packs that didn't come from disk (uploaded via
// /api/validate, crawled via /api/crawl, drafted via /api/draft-from-mcp).
// Demoing — and any per-artefact compile, conformance score, deploy or
// diff against a freshly-created pack — needs those packs to be addressable
// by an id under /api/packs/:id/*. Without this they'd be opaque blobs the
// server can't refer back to.
//
// The org's upload registry — crawled / drafted / uploaded packs — lives in
// server/pack-registry.mjs (STORE_PLAN slice 4): one pack file per pack
// (server/workspace.mjs), one `packs` row with its service links, and the
// per-org in-memory Map this module reads (uploadsMap(), rehydrated from the
// rows and files on an org's first touch — boot step 6 touches every live
// org). A register writes the file, the rows and their audit rows under the
// request's principal; a read touches lastUsedAt (debounced, audit-free).
// The actor is the principal's (a login, the bearer's label, `local`); an
// anonymous principal has none and never reaches an operator route — a
// missing one fails closed in the repository (requireActor), never defaults.
const actorOf = (req) => req.observogramPrincipal?.actor;

function registerUploadedPack(req, canonical, source, label) {
  return registerPack(currentStore(), actorOf(req), { canonical, source, label });
}

function uploadedMeta(id) {
  const upl = uploadsMap().get(id);
  if (!upl) return null;
  touchPack(currentStore(), id);   // keeps lastUsedAt-based retention honest (debounced)
  // The catalogue entry GET /api/packs serves for it — the one builder the
  // registry's rows and the studio's tiles read too (tools/lib/service-keys.mjs):
  // the label falls back to the canonical pack name, then the id.
  const entry = catalogEntryOf(id, { label: upl.label, source: upl.source }, upl.canonical, listEnvironments(upl.canonical));
  return {
    id,
    path: null,        // signal: not file-backed
    canonical: upl.canonical,
    label: entry.label,
    description: entry.description,
    source: upl.source,
    uploaded: true,
    entry,
  };
}

// Resolve a canonical pack object regardless of where it came from. Used
// by every /api/packs/:id/* handler so uploaded packs are treated the
// same as catalog or example packs.
function loadPackCanonical(meta) {
  if (meta?.canonical) return meta.canonical;
  if (meta?.path)      return loadPackFile(meta.path);
  throw new Error(`pack meta has neither canonical nor path: ${meta?.id}`);
}

function catalogEntry(meta) {
  try {
    const c = loadPackFile(meta.path);
    const svc = serviceMetadata(c);
    const live = livePackKind(c);   // 'scaffold' | 'snapshot' for a live pack only
    return {
      id: meta.id,
      label: meta.label,
      description: meta.description,
      name: c.metadata?.name,
      version: c.metadata?.version,
      binding: c.metadata?.binding,
      criticality: c.metadata?.bindings?.criticality,
      service: svc.service,
      namespace: svc.namespace,
      services: svc.services,
      environments: listEnvironments(c),
      ...(live ? { live } : {}),
      ok: true,
    };
  } catch (e) {
    return { id: meta.id, label: meta.label, ok: false, error: e.message };
  }
}

function readEnv(query) {
  return typeof query.env === 'string' && query.env ? query.env : null;
}

// MCP URL validation (SSRF guard) lives in server/mcp-url.mjs — every
// deploy / draft / refresh endpoint goes through validateMcpUrl() (inside
// resolveMcpTarget, server/service-admin.mjs, which also takes the org's
// MCP endpoint by id — STORE_PLAN slice 4 §7.6), and stderr logs use
// redactCredentials()/safeUrl, never the raw URL.

// overlaidCanonical (the env overlay applied to spec.* with the effective
// criticality / target propagated up to metadata.bindings) is the adapter's
// (tools/lib/adapter.mjs): one helper for the server, the static bundle and
// the CLIs.

// The default tools/lib/conformance.mjs grades at (tierOf) — the pack's own
// tier once the env overlay has lifted the environment's criticality.
const DEFAULT_TIER = 'tier-3';
const packTierOf = (canonical) => canonical.metadata?.bindings?.criticality ?? DEFAULT_TIER;

// A copy of `canonical` with metadata.bindings.criticality replaced — the
// tier the conformance scorer grades at (STORE_PLAN slice 4 §9: a service
// record's tier). Spreads metadata and bindings so the registry's live
// object is never mutated.
function withCriticality(canonical, tier) {
  return {
    ...canonical,
    metadata: { ...(canonical.metadata || {}), bindings: { ...(canonical.metadata?.bindings || {}), criticality: tier } },
  };
}

// ---------- app ----------

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);
// Routes match case-sensitively. Express matches case-insensitively by
// default, while the auth gate and the org middleware below test the path
// as written ('/api/'): `/API/…` used to reach the handlers with neither.
// Set before the first route creates app.router. A nested express.Router()
// does not inherit this — each one passes { caseSensitive: true } itself
// (server/test-auth-local.mjs checks every router layer).
app.enable('case sensitive routing');

// ---------- which build is this? ----------
//
// GET /api/version — the commit this process was started from
// (server/build-info.mjs): { version, build, commit, branch, dirty,
// date, source } plus the display `label`. Registered BEFORE the auth and
// tenancy middlewares on purpose: it is public like the static shell (the
// footer fills itself from it before anyone signs in) and holds nothing
// secret. `no-store` so a proxy never pins an old build to a new process.
app.get('/api/version', authorize('GET /api/version'), (req, res) => {
  const info = buildInfo();
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ...info, label: buildLabel(info) });
});

// ---------- the auth gate and the org middleware ----------
//
// server/authz.mjs: authGate decides who is calling (the bearer, a
// session, or nobody) and the posture's answer to an anonymous caller;
// orgContext runs every /api request inside its org (membership checked)
// and stamps the principal. Both before the body parsers: the context
// survives Express's body parsing.

app.use(authGate);
app.use(orgContext);

app.use(express.json({ limit: '16mb' }));   // /api/crawl can carry a whole repo's worth of YAML
app.use(express.text({ type: ['application/x-yaml', 'text/yaml', 'text/plain'], limit: '4mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));   // /auth/login form

// Identity routes (/auth/*) — inert in local mode; throws fail-closed at
// boot when OIDC is configured incompletely. See server/auth.mjs.
initAuth(app, { authorize });

// Express's PayloadTooLargeError is thrown by the body parsers BEFORE
// any of our handlers run, and the default error path returns HTML.
// /api/* always wants JSON so the client can show a clean error and
// hint the user toward client-side filtering instead of dumping a stack
// trace into the dropzone.
app.use(function payloadTooLarge(err, req, res, next) {
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    if ((req.path || '').startsWith('/api/')) {
      const limit = err.limit ? Math.round(err.limit / 1024 / 1024) + 'MB' : '16MB';
      return res.status(413).json({
        ok: false,
        error: `Request body too large (cap ${limit}). The crawler should filter to observability artefacts only — drop a large repo and the client will pre-classify; if you're hitting this you may have an in-flight build.`,
      });
    }
  }
  return next(err);
});

app.get('/healthz', authorize('GET /healthz'), (req, res) => {
  res.json({
    ok: true,
    ...versionInfo(),   // version, build, node — "what exactly is running?"
    specVersion: SPEC_VERSION,
    schemaPath: SPEC_SCHEMA_PATH,
  });
});

// Wipe the org's uploaded / crawled / drafted packs. Used by the studio's
// RESET button so the user can start truly fresh — the client pairs this
// with a localStorage.clear() + reload. No body, no params. The rows go
// (their service links with them; one pack.clear audit row), the map and
// the disk copies go too — reset means reset — but the services and
// environments the packs named STAY: a reset of the working set is not a
// deletion of the org's services. Returns the number of packs dropped so
// the client can echo it.
app.delete('/api/uploads', authorize('DELETE /api/uploads'), (req, res) => {
  const dropped = clearPacks(currentStore(), actorOf(req));
  res.json({ ok: true, dropped });
});

// Stage 2 tenancy: the orgs visible to this request. Sessions see their
// memberships; the bearer service account sees every live org; the open
// and anonymous postures see the default org. `role` is the membership's
// role (null without one; 'service-account' for the bearer) and
// `effectiveRole` the role the route guard applies there (an owner is an
// admin in every live org, so an owner's list also holds the active org
// when it is not one of their memberships). `active` echoes the request's
// resolved org so clients never have to guess which workspace they're in.
// `tenancy` stays in the body (always true) for old clients.
app.get('/api/orgs', authorize('GET /api/orgs'), (req, res) => {
  const db = currentStore();
  const principal = req.observogramPrincipal;
  const active = currentOrg();
  let orgs;
  if (req.observogramBearer) {
    orgs = listOrgs(db).map((o) => ({ id: o.id, name: o.name, role: 'service-account', effectiveRole: effectiveRoleOf(principal) }));
  } else if (req.observogramUser) {
    orgs = listMembershipsForUser(db, req.observogramUser.id).map((m) => ({
      id: m.orgId, name: getOrg(db, m.orgId)?.name || m.orgId, role: m.role, effectiveRole: effectiveRoleOf(principal, m.role),
    }));
    if (principal?.owner && !orgs.some((o) => o.id === active)) {
      orgs.push({ id: active, name: getOrg(db, active)?.name || active, role: null, effectiveRole: effectiveRoleOf(principal) });
    }
  } else {
    const org = getOrg(db, active);
    orgs = [{ id: org.id, name: org.name, role: null, effectiveRole: effectiveRoleOf(principal) }];
  }
  res.json({ ok: true, tenancy: true, orgs, active });
});

app.get('/api/packs', authorize('GET /api/packs'), (req, res) => {
  // Catalog + in-memory uploads. Uploaded packs lead the list so the
  // picker surfaces them at the top — they're the user's just-created
  // work and most likely what they want to interact with next.
  const uploads = [...uploadsMap().keys()].map(id => catalogEntryForUpload(id)).filter(Boolean);
  res.json({ packs: [...uploads, ...PACK_CATALOG.map(catalogEntry)] });
});

function catalogEntryForUpload(id) {
  return uploadedMeta(id)?.entry ?? null;
}

// Opt-in lookup across uploads + catalog + examples — used by every
// /api/packs/:id/* route so uploaded / crawled / drafted packs work the
// same as file-backed packs (compile, conformance, diff, deploy etc).
function findPackMeta(id) {
  const upl = uploadedMeta(id);
  if (upl) return upl;
  return PACK_CATALOG.find(p => p.id === id)
      || EXAMPLE_PACKS.find(p => p.id === id)
      || REFERENCE_PACKS.find(p => p.id === id);
}

// Browse the archived reference packs without auto-loading them. The
// home screen renders these as a small "Browse examples" affordance.
app.get('/api/examples', authorize('GET /api/examples'), (req, res) => {
  res.json({ examples: EXAMPLE_PACKS.map(catalogEntry) });
});

// The artefact taxonomy override (OBSERVOGRAM_TAXONOMY, server/taxonomy.mjs):
// the document the studio compiles at boot to classify typed artefacts, or
// null when none is configured. `configured` says which; the file's path
// is logged at start, never served. `no-store` like /api/version: the
// answer changes with the process, not with the resource.
app.get('/api/taxonomy', authorize('GET /api/taxonomy'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(taxonomyAnswer());
});

// Catalogue reference packs — the curated best-practice packs surfaced in
// the studio's Advanced → References view (reference component analysis).
// Kept separate from /api/examples so they no longer appear in the
// example-pack list, only under References.
app.get('/api/references', authorize('GET /api/references'), (req, res) => {
  res.json({ references: REFERENCE_PACKS.map(catalogEntry) });
});

app.get('/api/packs/:id', authorize('GET /api/packs/:id'), (req, res) => {
  const meta = findPackMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackCanonical(meta);
    const env = readEnv(req.query);
    const errors = validateCanonical(canonical, SCHEMA);
    if (errors.length) return res.status(500).json({ error: 'pack failed schema validation', details: errors });
    const layered = adapt(canonical, { environment: env });
    res.json(layered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/packs/:id/canonical', authorize('GET /api/packs/:id/canonical'), (req, res) => {
  const meta = findPackMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackCanonical(meta);
    const env = readEnv(req.query);
    const { canonical: overlaid, effective } = overlaidCanonical(canonical, env);
    // Allow ?format=yaml to return the manifest as text/yaml for the
    // Schema view's canonical-source pane (saves a round-trip + an
    // ESM YAML emitter on the client).
    if (req.query.format === 'yaml' || req.query.format === 'yml') {
      res.set('Content-Type', 'application/x-yaml; charset=utf-8');
      res.send(emitYaml(overlaid));
      return;
    }
    res.json({ ...overlaid, __effectiveEnvironment: env, __effective: effective });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/packs/:id/conformance — the maturity rubric over the env-overlaid
// pack, graded at the service record's tier when one is set (STORE_PLAN
// slice 4 §9): an uploaded pack's primary service row, its environment row
// for ?env= first (environment.tier, else service.tier); a catalogue or
// example pack has no row and is graded at its own tier, as every pack was
// before. `declaredTier` is the tier the report was graded at, so
// scorePercent, mustPercent and the clauses' `applies` follow it; `tier`
// says where it came from: { graded (=== declaredTier), pack (the pack's own
// declaration for this env), from: 'environment' | 'service' | 'pack',
// service { id, slug } | null, environment { id, name } | null, mismatch
// (the record's tier differs from the pack's — shown, never blocked) }.
// tools/lib/conformance.mjs is untouched: the tier goes in through a copy
// of the canonical.
// conformanceReportFor(meta, canonical, env) is the one builder of that
// body: the route answers it, and GET /api/packs/:id/audit-report (GAP batch
// 2, server/routes/audit-report.mjs) reads the same object, so the two can
// never grade one pack differently. The service record's waivers (GAP batch
// 2 B3.2, server/waiver-admin.mjs conformanceWaivers) overlay the engine's
// report here and here only: with no open waiver the report is the same
// object (byte-identical body); /api/validate and the library routes keep
// the bare report.
function conformanceReportFor(meta, canonical, env, { now = new Date().toISOString() } = {}) {
  const { canonical: overlaid } = overlaidCanonical(canonical, env);
  const packTier = packTierOf(overlaid);
  const record = meta.uploaded ? serviceTierFor(currentStore(), meta.id, env) : null;
  const graded = record?.tier ? withCriticality(overlaid, record.tier) : overlaid;
  const engine = evaluateConformance(graded);
  const report = record?.service ? conformanceWaivers(currentStore(), record.service, engine, graded, { now }) : engine;
  // Which clauses pass only on a placeholder, for this env overlay at the
  // graded tier — the same list /api/validate and /api/library/register
  // put in summary.onPlaceholder. Only a pack carrying library.todo.*
  // annotations can say; for any other pack the key is omitted (not []),
  // because "no placeholder" is not known there and the view keeps its hedge.
  const onPlaceholder = librarySummaryFor(graded)?.onPlaceholder;
  return {
    environment: env,
    ...report,
    ...(Array.isArray(onPlaceholder) ? { onPlaceholder } : {}),
    tier: {
      graded: report.declaredTier,
      pack: packTier,
      from: record?.from ?? 'pack',
      service: record?.service ?? null,
      environment: record?.environment ?? null,
      mismatch: !!record?.tier && record.tier !== packTier,
    },
  };
}

app.get('/api/packs/:id/conformance', authorize('GET /api/packs/:id/conformance'), (req, res) => {
  const meta = findPackMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackCanonical(meta);
    const env = readEnv(req.query);
    res.json(conformanceReportFor(meta, canonical, env));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/diff', authorize('GET /api/diff'), (req, res) => {
  const aId = typeof req.query.a === 'string' ? req.query.a : null;
  const bId = typeof req.query.b === 'string' ? req.query.b : null;
  if (!aId || !bId) return res.status(400).json({ error: 'query params `a` and `b` (pack ids) required' });
  const aMeta = findPackMeta(aId);
  const bMeta = findPackMeta(bId);
  if (!aMeta) return res.status(404).json({ error: `unknown pack: ${aId}` });
  if (!bMeta) return res.status(404).json({ error: `unknown pack: ${bId}` });
  const aEnv = typeof req.query.aEnv === 'string' && req.query.aEnv ? req.query.aEnv : null;
  const bEnv = typeof req.query.bEnv === 'string' && req.query.bEnv ? req.query.bEnv : null;
  const requestedScopeMode = typeof req.query.scopeMode === 'string' ? req.query.scopeMode : undefined;
  const requestedService = typeof req.query.service === 'string' && req.query.service ? req.query.service : undefined;
  try {
    const aCanonical = loadPackCanonical(aMeta);
    const bCanonical = loadPackCanonical(bMeta);
    const annotatedScopeMode = aCanonical.metadata?.annotations?.['observogram.diff.scopeMode']
      ?? aCanonical.metadata?.annotations?.['tomograph.diff.scopeMode'];   // legacy namespace
    const scopeMode = requestedScopeMode || annotatedScopeMode;
    const aLayered = adapt(aCanonical, { environment: aEnv });
    const bLayered = adapt(bCanonical, { environment: bEnv });
    res.json({
      ...diffPacks(aLayered, bLayered, { scopeMode, service: requestedService }),
      traceabilityGraph: comparePackBranches(aLayered, bLayered),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- pack compiler ----------
//
// The pack is the source of truth; this endpoint emits the real
// platform artefacts (Prometheus rules, OTel Collector config, etc.)
// derived from it. Spec §9's reference implementation table made real.

app.get('/api/compile/targets', authorize('GET /api/compile/targets'), (req, res) => {
  res.json({ targets: listTargets() });
});

// ----------------------------------------------------------------
// /api/packs/:id/compile-catalog — enumerate every individually
// compilable artifact in this pack. The studio renders this as a
// left-nav tree; each leaf is then compiled via /api/packs/:id/
// compile-artifact?group=&flavor=&artifact= below.
// ----------------------------------------------------------------
app.get('/api/packs/:id/compile-catalog', authorize('GET /api/packs/:id/compile-catalog'), (req, res) => {
  const meta = findPackMeta(req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackCanonical(meta);
    const env = readEnv(req.query);
    const { canonical: overlaid } = overlaidCanonical(canonical, env);
    const catalog = compileCatalog(overlaid);
    res.json({
      pack: meta.id,
      env: env || null,
      ...catalog,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ----------------------------------------------------------------
// /api/packs/:id/compile-artifact?group=&flavor=&artifact=
// Per-artifact compilation. Returns the same content-type/body
// shape as /api/packs/:id/compile/:target so the client can reuse
// the existing display path.
// ----------------------------------------------------------------
app.get('/api/packs/:id/compile-artifact', authorize('GET /api/packs/:id/compile-artifact'), (req, res) => {
  const meta = findPackMeta(req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: `unknown pack: ${req.params.id}` });
  const group = String(req.query.group || '');
  const flavor = req.query.flavor ? String(req.query.flavor) : undefined;
  const artifact = req.query.artifact ? String(req.query.artifact) : 'all';
  if (!group) return res.status(400).json({ ok: false, error: 'group query param required' });
  try {
    const canonical = loadPackCanonical(meta);
    const env = readEnv(req.query);
    const { canonical: overlaid } = overlaidCanonical(canonical, env);
    const out = compileArtifact(overlaid, { group, flavor, artifact });
    res.setHeader('Content-Type', out.contentType + '; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('X-Pack-Source', `${meta.id}@${overlaid?.metadata?.version || '?'}`);
    res.setHeader('X-Compile-Group', group);
    if (flavor)   res.setHeader('X-Compile-Flavor', flavor);
    if (artifact) res.setHeader('X-Compile-Artifact', artifact);
    res.send(out.content);
  } catch (e) {
    res.status(500).type('application/json').send(JSON.stringify({ ok: false, error: e.message }));
  }
});

// GET /api/packs/:id/export.zip — the whole pack as one download: the
// canonical pack.yaml plus every compiled artefact (the 'all' bundle of each
// compile group × flavor) under artefacts/, and — only when the pack carries
// any — the reviewer's verdicts as verdicts.json (the GET
// /api/packs/:id/verdicts document, GAP batch 2 B3.1; a catalogue pack and
// a pack nobody reviewed export exactly what they did before, so the static
// bundle's ZIP stays the server's). Hand-rolled ZIP, no zip dep.
app.get('/api/packs/:id/export.zip', authorize('GET /api/packs/:id/export.zip'), (req, res) => {
  const meta = findPackMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackCanonical(meta);
    const env = readEnv(req.query);
    const { canonical: overlaid } = overlaidCanonical(canonical, env);
    const name = slugify(overlaid?.metadata?.name || meta.id || 'pack');

    // The source of truth first, then the compiled outputs beside it.
    const files = [{ name: `${name}.pack.yaml`, data: emitYaml(overlaid) }];

    const catalog = compileCatalog(overlaid);
    for (const g of catalog.groups || []) {
      const flavors = g.flavors?.length ? g.flavors : [{ id: undefined }];
      for (const fl of flavors) {
        try {
          const out = compileArtifact(overlaid, { group: g.id, flavor: fl.id, artifact: 'all' });
          files.push({ name: `artefacts/${g.id}/${out.filename}`, data: out.content });
        } catch (_) { /* a flavor that can't compile for this pack — skip it */ }
      }
    }
    if (meta.uploaded) {
      const doc = verdictsDocument(currentStore(), { meta, adapted: adapt(canonical) });
      if (doc.verdicts.length > 0) files.push({ name: 'verdicts.json', data: `${JSON.stringify(doc, null, 2)}\n` });
    }

    const zip = makeZip(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.bundle.zip"`);
    res.setHeader('X-Pack-Source', `${meta.id}@${overlaid?.metadata?.version || '?'}`);
    res.setHeader('X-Bundle-Files', String(files.length));
    res.send(Buffer.from(zip));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Deploy domain routes (matrix, audit trail, verify write-back, rollback
// plan/execute, bulk + single deploy) live in server/routes/deploy.mjs;
// the shaping transforms in server/deploy-helpers.mjs. The pack-registry
// seam is injected until the registry extraction slice.
app.use(deployRoutes({ findPackMeta, loadPackCanonical, overlaidCanonical, readEnv, contentHash, authorize }));

// The identity API (STORE_PLAN slice 3b) lives in server/routes/identity.mjs:
// the deployment's users, orgs and join role under /api/admin/* (owners),
// the request's org — its name and its members — under /api/org* (its
// admins), every rule server/identity-admin.mjs's — the CLIs' own.
app.use(identityRoutes({ authorize }));

// The services and environments API (STORE_PLAN slice 4) lives in
// server/routes/services.mjs: the request's org's service records under
// /api/services (viewer reads, operator writes) and their environments
// under /api/environments, every rule server/service-admin.mjs's.
app.use(servicesRoutes({ authorize }));

// The verdicts API (GAP batch 2, B3.1) lives in server/routes/verdicts.mjs:
// a reviewer's trusted | suspect | failed record per artefact of a
// registered pack under /api/packs/:id/verdicts (viewer reads, operator
// writes), every rule server/verdict-admin.mjs's. The pack-registry seam is
// injected as the deploy routes take it.
app.use(verdictsRoutes({ findPackMeta, loadPackCanonical, authorize }));

// The waivers API (GAP batch 2, B3.2) lives in server/routes/waivers.mjs: a
// service record's time-boxed waivers of conformance findings under
// /api/services/:id/waivers and /api/waivers/:id/revoke (viewer reads,
// operator writes), every rule server/waiver-admin.mjs's; the overlay they
// produce is read by conformanceReportFor above.
app.use(waiversRoutes({ authorize }));

// The service audit report (GAP batch 2, B3.5) lives in
// server/routes/audit-report.mjs: GET /api/packs/:id/audit-report (JSON or
// HTML, branded like the shell) and GET /api/packs/:id/placeholders, both
// viewer reads. The report's conformance section is conformanceReportFor's
// body (the one builder), its verdict and waiver rows the admin modules'
// views over the store — mapped field by field here, the one `now` shared
// with the conformance overlay. The brand is the one start() loads; the
// styles (the studio's design tokens and kit) are read at the first request.
app.use(auditReportRoutes({
  authorize, findPackMeta, loadPackCanonical, readEnv, conformanceReportFor, overlaidCanonical, currentStore,
  brand: () => brand,
  styles: () => `${readFileSync(resolve(STUDIO_DIR, 'design-tokens.css'), 'utf8')}\n${readFileSync(resolve(STUDIO_DIR, 'design-kit.css'), 'utf8')}`,
  generator: () => ({ name: `${brand.name} server`, version: buildInfo().version }),
  assessments: {
    // A pack's verdict rows (server/verdict-admin.mjs verdictsDocument): a catalogue pack has none, by construction.
    verdictsFor: (db, meta, _env, adapted) => verdictsDocument(db, { meta, adapted }).verdicts
      .map((v) => ({ artefactKey: v.artefact, key: v.key, family: v.family, title: v.title, state: v.status, reason: v.reason, at: v.setAt, by: v.actor })),
    // The pack's primary service record's waivers (server/waiver-admin.mjs listWaiverViews), history included; no service → none.
    waiversFor: (db, meta, env, now) => {
      const service = meta.uploaded ? serviceTierFor(db, meta.id, env)?.service : null;
      if (!service) return [];
      return listWaiverViews(db, service, now).waivers
        .map((w) => ({ id: w.id, artefactKey: w.artefactId, rule: w.ruleId, reason: w.reason, expiresAt: w.expiresAt, at: w.createdAt, by: w.author, status: w.state, revokedAt: w.revokedAt, revokedBy: w.revokedBy, revokeReason: w.revokeReason }));
    },
  },
}));

// The audit reader (STORE_PLAN slice 5) lives in server/routes/audit.mjs:
// GET /api/audit — the request's org's rows to its admins, the
// deployment's to owners, filtered and paged; the scope and every query
// rule server/audit-admin.mjs's.
app.use(auditRoutes({ authorize }));

// The live MCP API (rebadge batch 3) lives in server/routes/live.mjs:
// POST /api/mcp/ping — initialize, tools/list and one cheap read against
// the request's MCP target (resolveMcpTarget's, as a draft's), writing no
// live file and no pack; the live jobs — /api/mcp/jobs, a snapshot or a
// draft (draftFromMcp, below) run in the server's memory, polled by id.
app.use(liveRoutes({ authorize, draftFromMcp }));

// The MCP server-settings API (rebadge batch 4) lives in
// server/routes/mcp-settings.mjs: GET /api/mcp-settings — the settings
// policy (OBSERVOGRAM_MCP_SETTINGS_POLICY) and whether the opt-in
// pass-through is on, read by the studio when its Server settings modal opens.
app.use(mcpSettingsRoutes({ authorize }));

// ---------- saved journeys (VALUE_BACKLOG item 11, studio surface) ----------

// GET /api/journeys — every saved journey with its definition summary and
// last-run outcome, for the studio panel.
// POST /api/packs/:id/retrofeed — the reverse remediation arrow
// (VALUE_BACKLOG item 4): adopt live shadow signals (the diff's onlyInB)
// back into the declared pack. Recomputes the diff server-side (never
// trusts client-supplied artefacts), returns the additions as a fragment,
// the full updated pack YAML, and an honest skipped-list. The updated pack
// is schema-validated before it leaves — retrofeed must never hand out a
// pack that fails its own spec.
app.post('/api/packs/:id/retrofeed', authorize('POST /api/packs/:id/retrofeed'), (req, res) => {
  const metaA = findPackMeta(req.params.id);
  if (!metaA) return res.status(404).json({ ok: false, error: `unknown pack: ${req.params.id}` });
  const b = req.body || {};
  const metaB = findPackMeta(String(b.packBId || ''));
  if (!metaB) return res.status(404).json({ ok: false, error: `unknown pack B: ${b.packBId}` });
  try {
    const canonicalA = loadPackCanonical(metaA);
    const canonicalB = loadPackCanonical(metaB);
    const aEnv = typeof b.aEnv === 'string' && b.aEnv ? b.aEnv : null;
    const bEnv = typeof b.bEnv === 'string' && b.bEnv ? b.bEnv : null;
    const diff = diffPacks(
      adapt(canonicalA, { environment: aEnv }),
      adapt(canonicalB, { environment: bEnv }),
      { scopeMode: typeof b.scopeMode === 'string' ? b.scopeMode : undefined,
        service: typeof b.service === 'string' ? b.service : undefined },
    );
    let entries = Object.values(diff.layers || {}).flatMap(l => l.onlyInB || []);
    if (Array.isArray(b.keys) && b.keys.length) {
      // Suffix-tolerant: diff entries and traceability-branch nodes both use
      // identity keys, but each applies its own `#NN` occurrence suffixing —
      // match on the base identity so branch-scoped retrofeed always finds
      // its entries.
      const baseOf = (k) => String(k).replace(/#\d+$/, '');
      const want = new Set(b.keys.map(baseOf));
      entries = entries.filter(e => want.has(baseOf(e.key)));
    }
    const { adopted, skipped, updatedCanonical, fragment } =
      retrofeedShadowSignals(canonicalA, entries, { now: new Date().toISOString() });
    // Tripwire (the crawler incident's law, applied here too).
    const errs = validateCanonical(updatedCanonical, SCHEMA);
    if (errs.length) {
      return res.status(500).json({ ok: false, error: 'retrofeed produced a pack that fails the schema — this is a bug, please report it', details: errs.slice(0, 5) });
    }
    res.json({
      ok: true,
      summary: { candidates: entries.length, adopted: adopted.length, skipped: skipped.length },
      adopted, skipped,
      fragmentYaml: fragment ? emitYaml(fragment) : null,
      updatedPackYaml: emitYaml(updatedCanonical),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Step 5: the declared schedule, parsed; null without one. A definition
// that loaded has already been validated, so this cannot throw — guarded
// anyway: a listing must never fail on one journey's cadence.
function parsedSchedule(def) {
  if (!def || def.schedule === undefined || def.schedule === null) return null;
  try { return parseSchedule(def.schedule); } catch { return null; }
}

app.get('/api/journeys', authorize('GET /api/journeys'), (req, res) => {
  try {
    const journeys = listJourneys().map(name => {
      let def = null;
      // A definition that fails to load is still listed, with the reason:
      // a journey that can never run must not look like a healthy
      // never-run one.
      let loadError = null;
      try { def = loadJourneyDef(name, { allowPath: false }); } catch (e) { loadError = e.message; }
      const lastRun = readJourneyRuns(name, { limit: 1 })[0] || null;
      return {
        name,
        loadError,
        packA: def?.packA?.crawl ? `crawl: ${def.packA.crawl.path}` : (def?.packA?.file || null),
        packB: def?.packB?.mcp ? `mcp: ${def.packB.mcp.url}` : (def?.packB?.file || null),
        gate: def?.gate || {},
        scope: { env: def?.env || null, service: def?.service || null, scopeMode: def?.scopeMode || null },
        // Step 5: the declared cadence (parsed the way the CLI parses it —
        // cadenceMs null with a note for an irregular cron), the posture
        // budget inputs and the notify block as env var NAMES only. No
        // computation here: the journeys view derives the posture line
        // from the run history with the same browser-safe helpers.
        schedule: parsedSchedule(def),
        stackBudget: def?.stackBudget ?? null,
        notify: def?.notify ? { urlEnv: def.notify.urlEnv, authEnv: def.notify.authEnv ?? null, on: def.notify.on ?? NOTIFY_DEFAULT_POLICY, format: def.notify.format ?? NOTIFY_DEFAULT_FORMAT } : null,
        lastRun: lastRun && {
          startedAt: lastRun.startedAt,
          outcome: lastRun.outcome,
          alignmentPct: lastRun.drift?.alignmentPct ?? null,
          gradeScore: lastRun.grade?.score ?? null,
          breaches: lastRun.gate?.breaches?.length ?? 0,
          // Step 5: the delivery outcome of the last run — status, HTTP
          // status, reason. null when the record carries no notify object
          // (no notify block, or a record written before delivery).
          notify: lastRun.notify && typeof lastRun.notify === 'object'
            ? { status: lastRun.notify.status ?? null, httpStatus: lastRun.notify.httpStatus ?? null, reason: lastRun.notify.reason ?? null }
            : null,
          // Step 3: the stack self-metric samples the last run saw —
          // status, rows that answered data, best row per family. null
          // when the record carries no stackEvidence (file-sourced B,
          // pre-step-3 record): an absence, never a healthy stack.
          stack: stackSummary(lastRun),
          // Step 4: the requirement-chain summary of the last run (counts
          // by verdict and ladder verdict, top exposure) and whether its
          // chains moved since the run before. null when the record
          // carries no chains / no previous run to compare.
          chains: chainSummary(lastRun),
          transition: lastRun.transition && typeof lastRun.transition === 'object' ? {
            any: !!lastRun.transition.any,
            changed: Array.isArray(lastRun.transition.changed) ? lastRun.transition.changed.length : 0,
            worse: Array.isArray(lastRun.transition.changed) ? lastRun.transition.changed.filter(c => c && c.direction === 'worse').length : 0,
          } : null,
          // Step 4: the rank-1 candidate cause of the last run (a candidate
          // ranked by evidence, never a root-cause verdict) and whether its
          // vantage changed since the run before — reported beside the
          // cause, never as one. null when the record carries no causes.
          topCause: topCause(lastRun),
          vantageChanged: lastRun.causes?.vantage?.changed ?? null,
          // Inventory coverage of the last run (inventory-coverage.mjs inventorySummary): status,
          // reason and per kind expected / up / down / silent / unexpected. null without a block.
          inventory: inventorySummary(lastRun),
        },
      };
    });
    res.json({ journeys });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/journeys/:name/runs — run history newest first (the
// drift-over-time series behind the panel's trend sparkline).
app.get('/api/journeys/:name/runs', authorize('GET /api/journeys/:name/runs'), (req, res) => {
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 30));
  try {
    res.json({ runs: readJourneyRuns(req.params.name, { limit }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/journeys/:name/schedule — the delegated form of scheduling
// (VALUE_BACKLOG 11) for the Neuron view: the parsed schedule: and the
// ready-made cron / schtasks / GitHub Actions / CronJob snippets, built
// with the same inputs and emitters as `packc journey schedule <name>
// --json`. Env var NAMES only — no snippet ever carries a value. Without
// a schedule: every snippet uses the placeholder cadence and `placeholder`
// says so (nothing fabricated is presented as the journey's cadence). 404
// for an unknown or unloadable journey.
app.get('/api/journeys/:name/schedule', authorize('GET /api/journeys/:name/schedule'), (req, res) => {
  let def;
  try { def = loadJourneyDef(req.params.name, { allowPath: false }); }
  catch (e) { return res.status(404).json({ ok: false, error: e.message }); }
  try {
    const parsed = parsedSchedule(def);
    const envNames = [...new Set([def.packB?.mcp?.authEnv, def.notify?.urlEnv, def.notify?.authEnv].filter(Boolean))];
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    const snippets = scheduleSnippets({
      name: def.name,
      cron: parsed?.cron ?? null, timezone: parsed?.timezone ?? null, every: parsed?.every ?? null, cadenceNote: parsed?.cadenceNote ?? null,
      envNames,
      nodePath: process.execPath, cliPath: resolve(ROOT, 'tools/cli.mjs'), cwd: process.cwd(),
      workspace: orgWorkspaceRoot(), orgRoot: orgRootOf(currentOrg()),
      image: `observogram:${pkg.version}`, namespace: 'observability',
      retention: brandEnv('JOURNEY_RUN_RETENTION') || null,
      placeholder: !parsed,
      source: def.__source || null,
    });
    res.json({ ok: true, name: def.name, schedule: parsed, placeholder: !parsed, envNames, snippets });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/journeys/:name/run — execute now. HTTP 200 even when the gate
// fails: the run succeeded, the outcome is data. 404 for unknown names,
// 502 when a pack source can't be resolved (live MCP down etc.).
//
// The audit (STORE_PLAN slice 5): one journey.run row for every attempt
// past the 404 and the Pack B target refusal, written after the engine returned or threw — on the 200
// path the record's seven scalars; on the 502 path the same keys from the
// route's own clock, the outcome `vantage-lost` when a live source lost its
// vantage (the engine wrote a run record and may have notified) else
// `error` (no record exists). Never the error's message: it may carry a URL
// or a credential. A failed insert never fails the run: `auditError` on
// the response, one line on stderr.
app.post('/api/journeys/:name/run', authorize('POST /api/journeys/:name/run'), async (req, res) => {
  let def;
  try { def = loadJourneyDef(req.params.name, { allowPath: false }); }
  catch (e) { return res.status(404).json({ ok: false, error: e.message }); }
  try { actorForRecord(req); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  // A live Pack B is a server-side request to an MCP target (R4, decision
  // D6): resolved before anything runs — through the org's registered
  // endpoint (packB.mcp.endpointId), or a raw url as a typed URL, which
  // only an admin may send. A refusal sends nothing and writes no row; the
  // def's authEnv is never read here.
  const usesMcp = !!def.packB?.mcp && (!def.packB.file || def.inventory !== undefined);
  const mcpTarget = usesMcp ? resolveJourneyMcp(currentStore(), def.packB.mcp, { caller: mcpCallerOf(req) }) : null;
  if (mcpTarget?.status) return res.status(mcpTarget.status).json(mcpRefusalBody(mcpTarget));
  const t0 = new Date();
  const runRow = (detail) => ({ action: 'journey.run', targetKind: 'journey', targetId: bounded(def.name), detail });
  try {
    // A crawl: walk, a file: source and an inventory site read only this
    // org's own part of the workspace (STORE_PLAN slice 2, A-24); a path in
    // another org's part is refused.
    const record = await runJourney(def, {
      crawlScope: { base: baseWorkspaceRoot(), ownRoot: orgWorkspaceRoot() },
      resolveMcp: () => {
        if (!mcpTarget) throw new Error(`journey ${def.name}: Pack B's MCP was not resolved`);
        return mcpTarget;
      },
    });
    const auditError = auditAfter(req, runRow({
      startedAt: bounded(record.startedAt), outcome: bounded(record.outcome, 100),
      alignmentPct: finite(record.drift?.alignmentPct), gradeScore: finite(record.grade?.score),
      gradePass: typeof record.grade?.pass === 'boolean' ? record.grade.pass : null,
      breaches: Array.isArray(record.gate?.breaches) ? record.gate.breaches.length : null,
      tookMs: finite(record.tookMs),
    }), { tag: 'journey' });
    res.json({ ok: true, record, ...(auditError ? { auditError } : {}) });
  } catch (e) {
    const auditError = auditAfter(req, runRow({
      startedAt: t0.toISOString(), outcome: def.packB?.mcp && e?.vantageLost ? 'vantage-lost' : 'error',
      alignmentPct: null, gradeScore: null, gradePass: null, breaches: null, tookMs: Date.now() - t0.getTime(),
    }), { tag: 'journey' });
    res.status(502).json({ ok: false, error: redactTarget(String(e.message), mcpTarget), ...(auditError ? { auditError } : {}) });
  }
});

// POST /api/journeys/capture — "save this comparison as a journey". The
// server resolves the session's pack ids to durable sources: file-backed
// packs keep their path; uploaded/crawled/drafted packs point at their
// persisted workspace copy (10A); a Pack B that came from a live MCP draft
// is saved as a live mcp: source via its mcp.url annotation, so re-runs
// re-draft instead of comparing against a frozen copy (a live snapshot is
// saved as a file: it is an inventory read at one time) — through the
// org's registered endpoint whose safe URL is the annotation's
// ({ url, endpointId }); without one, an admin's capture keeps the URL
// (typed-URL and origin rules) and anyone else's saves Pack B as a file
// (R4, decision D6).
app.post('/api/journeys/capture', authorize('POST /api/journeys/capture'), (req, res) => {
  const b = req.body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  const metaA = findPackMeta(String(b.packAId || ''));
  const metaB = findPackMeta(String(b.packBId || ''));
  if (!metaA) return res.status(404).json({ ok: false, error: `unknown pack A: ${b.packAId}` });
  if (!metaB) return res.status(404).json({ ok: false, error: `unknown pack B: ${b.packBId}` });

  const sourceFor = (meta) => {
    // Journey-relative paths resolve against the journeys/ dir, so the
    // captured definition always stores absolute paths: catalog packs'
    // repo-relative meta.path is absolutized, and uploaded packs point at
    // their persisted workspace copy (10A).
    if (meta.path) return { file: resolve(meta.path).replaceAll('\\', '/') };
    return { file: join(workspaceInfo().packs, `${meta.id}.pack.yaml`).replaceAll('\\', '/') };
  };
  const packA = sourceFor(metaA);
  let packB;
  let canonicalB = null;
  try { canonicalB = loadPackCanonical(metaB); } catch (_) {}
  const bAnn = canonicalB?.metadata?.annotations || {};
  // A snapshot is an inventory read at one time (its mcp.url is an origin
  // only): it is saved as the file it is, never re-fetched as a draft.
  const live = bAnn['mcp.url'] && livePackKind(canonicalB) !== 'snapshot'
    ? journeyPackBSource(currentStore(), bAnn['mcp.url'], { caller: mcpCallerOf(req) }) : null;
  if (live?.status) return res.status(live.status).json(mcpRefusalBody(live));
  packB = live ?? sourceFor(metaB);

  const def = {
    packA, packB,
    ...(b.env ? { env: String(b.env) } : {}),
    ...(b.service ? { service: String(b.service) } : {}),
    ...(b.scopeMode ? { scopeMode: String(b.scopeMode) } : {}),
    gate: (b.gate && typeof b.gate === 'object') ? b.gate : { minAlignmentPct: 85 },
    // Step 5: the delivery keys ride through when the body carries them.
    ...(b.schedule !== undefined ? { schedule: b.schedule } : {}),
    ...(b.stackBudget !== undefined ? { stackBudget: b.stackBudget } : {}),
    ...(b.notify !== undefined ? { notify: b.notify } : {}),
  };
  // The audit (STORE_PLAN slice 5): the principal is checked before the
  // file is written — a missing actor (a bug) writes neither the file nor
  // the row, 500.
  try { actorForRecord(req); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  let saved;
  try {
    // The same validation loadJourneyDef applies: a captured gate that
    // names an unknown stack row must be refused here (400), not saved as
    // a journey that can never load — likewise a malformed schedule or
    // stackBudget block.
    if (def.gate.stack !== undefined) validateGateStack(def.gate.stack, name);
    if (def.schedule !== undefined) validateSchedule(def.schedule, name);
    if (def.stackBudget !== undefined) validateStackBudget(def.stackBudget, name);
    if (def.notify !== undefined) validateNotify(def.notify, name);
    saved = saveJourneyDef(name, def, {
      banner: [
        `Captured from a studio session on ${new Date().toISOString()}.`,
        `Pack A: ${metaA.label || metaA.id} · Pack B: ${metaB.label || metaB.id}`,
        `Edit freely — e.g. swap a frozen pack file for a crawl: source.`,
        `The server fetches a live Pack B through packB.mcp.endpointId (its token`,
        `from the endpoint's readTokenEnv); the CLI reads url and authEnv.`,
      ],
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  // The row, after the file: the two pack ids and whether Pack B was saved
  // as a live mcp: source — never the paths or the mcp.url the file holds;
  // the three scope scalars cut to the row's text rule.
  const auditError = auditAfter(req, {
    action: 'journey.capture', targetKind: 'journey', targetId: bounded(saved.name),
    detail: {
      packA: metaA.id, packB: metaB.id, live: Boolean(packB.mcp),
      env: bounded(def.env), service: bounded(def.service), scopeMode: bounded(def.scopeMode),
    },
  }, { tag: 'journeys' });
  res.json({ ok: true, name: saved.name, ...(auditError ? { auditError } : {}) });
});

app.get('/api/packs/:id/compile/:target', authorize('GET /api/packs/:id/compile/:target'), (req, res) => {
  const meta = findPackMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackCanonical(meta);
    const env = readEnv(req.query);
    const { canonical: overlaid } = overlaidCanonical(canonical, env);
    const opts = {
      dashboardId: typeof req.query.dashboardId === 'string' && req.query.dashboardId
        ? req.query.dashboardId : undefined,
    };
    const out = compile(overlaid, req.params.target, opts);
    const isDownload = req.query.download === '1';
    res.setHeader('Content-Type', out.contentType + '; charset=utf-8');
    if (isDownload) {
      res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    } else {
      res.setHeader('Content-Disposition', `inline; filename="${out.filename}"`);
    }
    res.setHeader('X-Pack-Source', `${meta.id}@${canonical?.metadata?.version || '?'}`);
    res.setHeader('X-Compile-Target', req.params.target);
    res.send(out.content);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/maturity-rubric', authorize('GET /api/maturity-rubric'), (req, res) => {
  res.json({
    specVersion: SPEC_VERSION,
    docs: `${SPEC_DIR}/docs/maturity-model.md`,
    clauses: RUBRIC.map(({ evaluate, ...rest }) => rest),
  });
});

// ---------- live MCP refresh ----------
//
// The cron-driven workflow (.github/workflows/refresh-live-pack.yml) is the
// production path. This in-browser endpoint exists so a dev session can
// kick off an ad-hoc refresh from a local MCP without spawning a process.

// Each org's live pack is <org root>/live/production-live.pack.yaml
// (server/workspace.mjs livePackPath); the badge reports absent until the
// org's first refresh. The install's examples/production-live.pack.yaml —
// the deployment-wide file of the builds before STORE_PLAN slice 3, still
// the CLI's default output and detect-drift's default input — is no longer
// read here (start() says so once, until the default org has its own).
const LEGACY_LIVE_PACK = 'examples/production-live.pack.yaml';

// ---------- step 2: stack self-metrics summary (signal, never verdict) ----------
//
// The fetcher stamps mcp.stack.* counts and mcp.observed.* JSON blocks
// (docs/MCP_INTEGRATION.md). This turns them back into the shape the
// studio's draft review renders. Nothing here is a threshold: `hint` is
// the contracts' display-only 'nonzero' marker, and every row keeps the
// outcome the sampler recorded (data | empty | failed | not-in-inventory
// | not-attempted) so an absent number is shown as absent.
function parseJsonAnnotation(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

const STACK_ROW_BY_ID = new Map(STACK_SELF_METRIC_PROBES.map(r => [r.id, r]));

function stackSummaryFromAnnotations(ann) {
  const status = ann['mcp.stack.status'];
  if (status !== 'sampled' && status !== 'not-attempted') return null;
  const n = (k) => { const v = Number(ann[k]); return Number.isFinite(v) ? v : 0; };
  const families = {};
  for (const entry of String(ann['mcp.stack.families'] || '').split(',').filter(Boolean)) {
    const [family, outcome] = entry.split(':');
    if (family && STACK_OUTCOMES.includes(outcome)) families[family] = outcome;
  }
  const observed = parseJsonAnnotation(ann['mcp.observed.stack_metrics']);
  const rows = (Array.isArray(observed) ? observed : [])
    .filter(r => r && typeof r === 'object' && typeof r.id === 'string')
    .map(r => {
      const def = STACK_ROW_BY_ID.get(r.id);
      const value = typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : null;
      const direction = def?.direction || r.direction || 'info';
      return {
        id: r.id,
        family: def?.family || r.family || null,
        product: r.product ?? null,
        value,
        unit: def?.unit || r.unit || null,
        direction,
        outcome: STACK_OUTCOMES.includes(r.outcome) ? r.outcome : 'failed',
        hint: displayHint({ direction }, value),
        ...(r.reason ? { reason: String(r.reason) } : {}),
      };
    });
  return {
    status,
    reason: status === 'not-attempted' ? (ann['mcp.stack.reason'] || 'not attempted') : null,
    sampled: n('mcp.stack.sampled'),
    empty: n('mcp.stack.empty'),
    failed: n('mcp.stack.failed'),
    notInInventory: n('mcp.stack.notInInventory'),
    notAttempted: n('mcp.stack.notAttempted'),
    families,
    rows,
  };
}

// A null summary means the surface was NOT ADVERTISED by the MCP (a tier
// fact). An advertised tool that failed still yields a summary, carrying
// `error` — the studio words that as "probe failed", never "not exposed".
function alertmanagerSummaryFromAnnotations(ann) {
  const o = parseJsonAnnotation(ann['mcp.observed.alertmanager']);
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const silences = o.silences && typeof o.silences === 'object'
    ? { active: Number(o.silences.active ?? 0) || 0, total: Number(o.silences.total ?? 0) || 0 }
    : null;
  return {
    version: o.version == null ? null : String(o.version),
    uptime: o.uptime == null ? null : String(o.uptime),
    clusterStatus: o.clusterStatus == null ? null : String(o.clusterStatus),
    silences,
    error: o.error == null ? null : String(o.error).slice(0, 200),
  };
}

function grafanaSummaryFromAnnotations(ann) {
  const ds = parseJsonAnnotation(ann['mcp.observed.grafana.datasources']);
  const cp = parseJsonAnnotation(ann['mcp.observed.grafana.contact_points']);
  const err = ann['mcp.observed.grafana.error'];
  if (!Array.isArray(ds) && !(cp && typeof cp === 'object') && !err) return null;
  // Health stays three-valued on the summary: `unknown` is "not checked"
  // (health tool not exposed / errored / beyond the cap) and must never be
  // folded into the non-error bucket — `healthChecked` counts the
  // datasources that actually got a verdict.
  const datasources = Array.isArray(ds)
    ? ds.filter(d => d && typeof d === 'object').map(d => ({
        uid: d.uid == null ? null : String(d.uid),
        name: d.name == null ? null : String(d.name),
        type: d.type == null ? null : String(d.type),
        health: d.health === 'ok' || d.health === 'error' ? d.health : 'unknown',
        message: d.message == null ? null : String(d.message).slice(0, 200),
      }))
    : null;
  const contactPoints = cp && typeof cp === 'object' && !Array.isArray(cp)
    ? { count: Number(cp.count ?? 0) || 0, names: Array.isArray(cp.names) ? cp.names.map(String) : [] }
    : null;
  return {
    datasources,
    healthChecked: datasources ? datasources.filter(d => d.health !== 'unknown').length : 0,
    contactPoints,
    error: err == null ? null : String(err).slice(0, 200),
  };
}

// The org's live pack. `origin` (scheme://host:port) is served to every
// reader; `url` — the safe form, which may still carry a path — only to an
// operator and above (its one consumer is the MCP panel's prefill, an
// operator action): a viewer, and in the token posture any anonymous
// caller, never sees a path. A file written by an older build or by hand
// is served clean too.
app.get('/api/live-status', authorize('GET /api/live-status'), (req, res) => {
  try {
    const text = readLivePack();
    if (text === null) return res.json({ present: false });
    const c = parseYaml(text);
    const a = c.metadata?.annotations || {};
    const raw = a['mcp.url'] || null;
    const operator = rankOf(req.observogramPrincipal) >= rankOfRole('operator');
    res.json({
      present: true,
      refreshedAt:        a['mcp.refreshedAt']        || null,
      origin:             raw ? mcpUrlOrigin(raw) : null,
      url:                raw && operator ? stripMcpUrl(raw).safe : null,
      toolsCalled:        a['mcp.toolsCalled']        || '',
      toolsFailed:        a['mcp.toolsFailed']        || '',
      // Probe-outcome honesty: families that got no answer (a hole) vs
      // families this MCP tier simply doesn't expose (a restriction).
      probesFailed:       a['mcp.probesFailed']       || '',
      probesUnsupported:  a['mcp.probesUnsupported']  || '',
      // Step 2 stack self-metrics: 'sampled' | 'not-attempted' | null (a
      // pack refreshed before step 2 carries no panel at all).
      stackStatus:        a['mcp.stack.status']        || null,
      stackSampled:       Number(a['mcp.stack.sampled'] || 0),
      servicesDiscovered: a['mcp.servicesDiscovered'] || '',
      baselinesComputed:  a['mcp.baselinesComputed']  || '0',
      activeAnomalies:    a['mcp.activeAnomalies']    || '0',
    });
  } catch (e) {
    res.json({ present: false, error: e.message });
  }
});

// ----------------------------------------------------------------
// POST /api/draft-from-mcp — Path B of the pack-creation journey.
//
// Parallel to POST /api/crawl, but the source is a live MCP server
// instead of a repo file map. Builds a canonical pack from what
// the MCP can attest to (system_health, system_topology, baselines,
// active anomalies) and returns it for review WITHOUT writing it to
// disk. The studio shows the preview + summary; "use this pack"
// round-trips it through /api/validate just like the crawler flow.
//
// Body: { mcpUrl | mcpEndpointId, mcpAuth?, packName? } — an endpoint by id
// is the org's record (STORE_PLAN slice 4 §7.6): its URL, and its read
// token from the org's own variable when the request sends none.
// Response: { ok, canonical, canonicalYaml, summary, validation,
//             conformance, annotations, registered, mcpEndpoint, tookMs }
// ----------------------------------------------------------------
app.post('/api/draft-from-mcp', authorize('POST /api/draft-from-mcp'), async (req, res) => {
  const body = req.body || {};
  const target = resolveMcpTarget(currentStore(), body, { forWrite: false, caller: mcpCallerOf(req) });
  if (target.status) return res.status(target.status).json(mcpRefusalBody(target));
  const t0 = Date.now();
  try {
    res.json(await draftFromMcp(target, {
      packName: body.packName,
      label: body.label,
      register: (pack, label) => registerUploadedPack(req, pack, label, label),
    }));
  } catch (e) {
    const error = redactTarget(e.message, target);
    process.stderr.write(`[draft-from-mcp]   error in ${Date.now() - t0}ms: ${error}\n`);
    res.status(502).json({ ok: false, error, tookMs: Date.now() - t0 });
  }
});

// The draft itself, shared by POST /api/draft-from-mcp and a draft live job
// (server/routes/live.mjs), so a job's canonical is the route's byte for
// byte. `target` is resolveMcpTarget's answer. `onStage` and `signal` reach
// fetchMcp (the draft's canonical is the same with or without them); the
// `build` stage is reported here. `register(pack, label)` registers a valid
// pack and returns its id (the route: the request's principal; a job: its
// captured actor, after its authority re-check). Throws what the fetch
// throws; answers { ok, canonical, canonicalYaml, summary, annotations,
// validation, conformance, registered, mcpEndpoint, tookMs }.
async function draftFromMcp(target, { packName: rawName = null, label = null, onStage = null, signal = null, register, tag = 'draft-from-mcp', verb = 'POST' } = {}) {
  const packName = typeof rawName === 'string' && rawName.trim()
    ? rawName.trim()
    : null;
  const { mcpUrl, safeMcpUrl, mcpAuth, endpoint: mcpEndpoint } = target;
  // The draft is a registered pack every viewer of the org reads: it keeps
  // the safe URL (a journey captured from it re-drafts from it; a header
  // token rides packB.mcp.authEnv), and says what it dropped.
  const { dropped } = stripMcpUrl(mcpUrl);

  const t0 = Date.now();
  process.stderr.write(`[${tag}] ${verb} -> ${safeMcpUrl}\n`);
  const fetched = await fetchMcp({ mcpUrl, mcpAuth, onStage, signal });
  onStage?.({ stage: 'build', state: 'running', counts: null, message: null, gap: null });
  const refreshedAt = new Date().toISOString();
  const pack = buildCanonicalPack({ refreshedAt, mcpUrl: safeMcpUrl, packName, ...fetched });
  const errors = validateCanonical(pack, SCHEMA);

  // Build a discovery summary in the same shape the crawler returns,
  // so the client can render BOTH path A and path B drafts with the
  // same review component.
  const ann = pack.metadata?.annotations || {};
  const probesAttempted = (ann['mcp.probesAttempted'] || '').split(',').filter(Boolean);
  const probesSucceeded = (ann['mcp.probesSucceeded'] || '').split(',').filter(Boolean);
  const probesEmpty     = (ann['mcp.probesEmpty']     || '').split(',').filter(Boolean);
  const probesFailed    = (ann['mcp.probesFailed']    || '').split(',').filter(Boolean);
  const probesUnsupported = (ann['mcp.probesUnsupported'] || '').split(',').filter(Boolean);
  // Why a family got no answer — the fetcher's last candidate error.
  const probeErrors = {};
  for (const [k, v] of Object.entries(ann)) {
    if (k.startsWith('mcp.probeErrors.') && v) probeErrors[k.slice('mcp.probeErrors.'.length)] = String(v);
  }

  // Parse the capability inventory (skill → backend → product → versions)
  // out of the flat annotation set the fetcher stamped. The studio's
  // connect screen reads this directly to render the version-gating
  // story up-front, before the user even commits to drafting a pack.
  const inventoryRaw = ann['mcp.capabilities.inventory'] || '';
  const inventory = inventoryRaw.split('|').filter(Boolean).map(row => {
    const [skill, backend, product, mustCsv] = row.split(':');
    return {
      skill, backend,
      product: product === '-' ? null : product,
      versions: { must: (mustCsv || '').split(';').filter(Boolean) },
    };
  });
  const capabilities = ann['mcp.capabilities.skillCount']
    ? {
        gatingMode:    ann['mcp.capabilities.gatingMode'] || 'warn',
        protocolModel: ann['mcp.capabilities.protocolModel'] || null,
        skillCount:    Number(ann['mcp.capabilities.skillCount'] || 0),
        backendCount:  Number(ann['mcp.capabilities.backendCount'] || 0),
        skills:        (ann['mcp.capabilities.skills'] || '').split(',').filter(Boolean),
        inventory,
      }
    : null;

  const summary = {
    source: 'mcp',
    mcpUrl: safeMcpUrl,
    refreshedAt,
    discovered: {
      backends:        (pack.spec?.telemetry?.backends || []).length,
      servicesDiscovered: (ann['mcp.servicesDiscovered'] || '').split(',').filter(Boolean),
      toolsCalled:    (ann['mcp.toolsCalled']    || '').split(',').filter(Boolean),
      toolsFailed:    (ann['mcp.toolsFailed']    || '').split(',').filter(Boolean),
      activeAnomalies: Number(ann['mcp.activeAnomalies'] || 0),
      // Probe-discovered facts — counts only, full data lives in the
      // pack itself (spec.queries.recording_rules etc.)
      recordingRules:  Number(ann['mcp.discovered.recording_rules'] || (pack.spec?.queries?.recording_rules || []).length),
      alertRules:      Number(ann['mcp.discovered.alert_rules'] || 0),
      dashboards:      Number(ann['mcp.discovered.dashboards'] || (pack.spec?.dashboards || []).length),
      scrapeJobs:     (ann['mcp.discovered.scrape_jobs'] || '').split(',').filter(Boolean),
      // Routes read from the running Alertmanager configuration.
      alertingRoutes:  Number(ann['mcp.discovered.alerting_routes'] || 0),
      // Alerting rules that guard a recorded SLO (read as burn-rate
      // entries) and the operational ones that guard none.
      alertRulesLinked:      Number(ann['mcp.discovered.alert_rules_linked'] || 0),
      alertRulesOperational: Number(ann['mcp.discovered.alert_rules_operational'] || 0),
      // Products the MCP can speak to that showed no sign of running:
      // supported, not deployed — never listed as backends.
      supportedOnly:  (ann['mcp.capabilities.unobserved'] || '').split(',').filter(Boolean),
      // Artefact families this fetch had no way to look at, with why
      // (observogram.unobserved.<family>) — a comparison reports them as
      // "not checked", never as missing.
      unobserved: Object.fromEntries(Object.entries(ann)
        .filter(([k]) => k.startsWith('observogram.unobserved.'))
        .map(([k, v]) => [k.slice('observogram.unobserved.'.length), String(v)])),
      // On-wire liveness: jobs whose every target is down, and rules the
      // ruler reports as failing to evaluate. Names, so the studio can
      // say WHICH ones — the pack's mcp.observed.* annotations carry the
      // per-target / per-rule detail.
      scrapeJobsDown:         (ann['mcp.discovered.scrape_jobs_down'] || '').split(',').filter(Boolean),
      recordingRulesUnhealthy: (ann['mcp.discovered.recording_rules_unhealthy'] || '').split(',').filter(Boolean),
      alertRulesUnhealthy:    (ann['mcp.discovered.alert_rules_unhealthy'] || '').split(',').filter(Boolean),
      metricNamesCount: Number(ann['mcp.discovered.metric_names_count'] || 0),
      // tools/list inventory — what the MCP advertised vs what we matched
      toolsExposed:    (ann['mcp.toolsExposed']    || '').split(',').filter(Boolean),
      toolsUnmatched:  (ann['mcp.toolsUnmatched']  || '').split(',').filter(Boolean),
      probesAttempted, probesSucceeded, probesEmpty, probesFailed,
      probesUnsupported, probeErrors,
    },
    // Full backend_capabilities inventory — the version-gating contract.
    // When null, the MCP didn't expose backend_capabilities (older
    // server). When set, the studio renders the full skill → backend →
    // product → version matrix on connect.
    capabilities,
    // Step 2: the stack's own self-metrics and the Alertmanager /
    // Grafana status surfaces — point-in-time samples the studio shows
    // under "signal, not verdict". null when the fetcher predates step 2
    // (or the surface wasn't advertised); never a Verified stamp.
    stack: stackSummaryFromAnnotations(ann),
    alertmanager: alertmanagerSummaryFromAnnotations(ann),
    grafana: grafanaSummaryFromAnnotations(ann),
    warnings: [],
    tier: pack.metadata?.bindings?.criticality || 'tier-3',
  };

  // The strip is never silent.
  const strippedNote = droppedNote(dropped, { where: 'not kept in the draft' });
  if (strippedNote) summary.warnings.push(strippedNote);
  // Warnings — only flag a gap when we ASKED and got nothing, never
  // when we never asked. The MCP probe table is the contract for
  // "what we tried."
  if ((summary.discovered.toolsFailed || []).length) {
    summary.warnings.push(`MCP tools that failed: ${summary.discovered.toolsFailed.join(', ')}`);
  }
  // A family the MCP doesn't expose at all is a tier restriction, not an
  // empty answer — one honest line, never the per-family "returned empty"
  // narrative below.
  if (probesUnsupported.length) {
    summary.warnings.push(`Restricted MCP tier — families not exposed by this server: ${probesUnsupported.join(', ')}.`);
  }
  // The stack panel is gated on metrics_query alone; a restricted tier
  // reads "not attempted", never "healthy" and never "absent".
  if (summary.stack && summary.stack.status === 'not-attempted') {
    summary.warnings.push(/not exposed/.test(summary.stack.reason || '')
      ? 'Stack self-metrics not attempted — metrics_query not exposed by this MCP tier.'
      : `Stack self-metrics not attempted — ${summary.stack.reason || 'no reason recorded'}.`);
  }
  if (summary.alertmanager?.error) {
    summary.warnings.push(`Alertmanager status probe failed — ${summary.alertmanager.error}`);
  }
  if (summary.grafana?.error) {
    summary.warnings.push(`Grafana status probe failed — ${summary.grafana.error}`);
  }
  const attemptedNothing = (k) => probesAttempted.includes(k) && !probesSucceeded.includes(k) && !probesUnsupported.includes(k);
  if (attemptedNothing('recording_rules')) {
    summary.warnings.push('Recording-rule probes returned empty. The SLI/SLO sections were synthesised from system_health — if your platform has Prometheus/Mimir rules, the MCP isn\'t exposing them yet.');
  }
  if (attemptedNothing('alert_rules')) {
    summary.warnings.push('Alert-rule probes returned empty. Burn-rate alerts are synthesized from SLOs; existing fired alerts couldn\'t be surfaced.');
  }
  if (attemptedNothing('dashboards')) {
    summary.warnings.push(probesFailed.includes('dashboards')
      ? `The dashboards probe got no answer${probeErrors.dashboards ? ` (${probeErrors.dashboards})` : ''}. The dashboards section is a stub, and a comparison reports declared dashboards as not checked — not as missing.`
      : 'Dashboard probes returned empty. The dashboards section is a stub — point the MCP at Grafana\'s /api/search to populate it.');
  }
  if (attemptedNothing('alerting_routes')) {
    summary.warnings.push(`The running Alertmanager configuration could not be read${probeErrors.alerting_routes ? ` (${probeErrors.alerting_routes})` : ''}. The route in the draft is a placeholder, and a comparison reports declared routes as not checked.`);
  }
  if (attemptedNothing('scrape_configs')) {
    summary.warnings.push('Scrape-config probes returned empty. spec.telemetry.scrape_evidence is unknown — declare scrape jobs in the pack by hand if you can.');
  }
  if (attemptedNothing('metric_names')) {
    summary.warnings.push('Metric-inventory probes returned empty. The metrics actually exported by the platform couldn\'t be enumerated.');
  }
  // Hard guards regardless of probes (the live state has to satisfy SOMETHING).
  if ((pack.spec?.slis || []).length === 0) {
    summary.warnings.push('No SLIs at all — recording rules + system_health both came up empty.');
  }

  const conformance = evaluateConformance(pack);
  const canonicalYaml = banner(pack) + emitYaml(pack);
  onStage?.({
    stage: 'build',
    state: errors.length === 0 ? 'done' : 'failed',
    counts: { ...livePackCounts(pack), errors: errors.length, bytes: Buffer.byteLength(canonicalYaml) },
    message: errors.length === 0 ? null : `the draft failed schema validation (${errors.length} error${errors.length === 1 ? '' : 's'})`,
    gap: null,
  });
  // Register only if validation passes; bad packs aren't addressable.
  // Prefer the caller-supplied label (the quick-start cases pass
  // something friendlier than the auto-generated metadata name).
  const friendlyLabel = (typeof label === 'string' && label.trim())
    ? label.trim()
    : `${pack.metadata?.name || 'mcp-draft'} (live MCP draft)`;
  const registered = errors.length === 0
    ? { id: await register(pack, friendlyLabel) }
    : null;
  process.stderr.write(`[${tag}]   ok in ${Date.now() - t0}ms; ` +
    `valid=${errors.length === 0}; ` +
    `services=${summary.discovered.backends}; ` +
    `registered=${registered?.id || '-'}; ` +
    `failed=${summary.discovered.toolsFailed.join(',') || 'none'}\n`);

  return {
    ok: true,
    canonical: pack,
    canonicalYaml,
    summary,
    annotations: ann,
    validation: { ok: errors.length === 0, errors },
    conformance,
    registered,
    mcpEndpoint,
    tookMs: Date.now() - t0,
  };
}

function banner(pack) {
  return [
    `# =============================================================================`,
    `# ObservabilityPack: ${pack.metadata?.name || 'unnamed'}  (drafted from live MCP)`,
    `# Source         : ${pack.metadata?.annotations?.['mcp.url'] || 'unknown'}`,
    `# Drafted at     : ${pack.metadata?.annotations?.['mcp.refreshedAt'] || new Date().toISOString()}`,
    `# Tools called   : ${pack.metadata?.annotations?.['mcp.toolsCalled']    || '(none)'}`,
    `# Tools failed   : ${pack.metadata?.annotations?.['mcp.toolsFailed']    || 'none'}`,
    `# Services found : ${pack.metadata?.annotations?.['mcp.servicesDiscovered'] || 0}`,
    `# -----------------------------------------------------------------------------`,
    `# This is a DRAFT. The MCP can attest to what's live (backends, topology,`,
    `# baselines, active anomalies). It CANNOT supply your declared SLIs/SLOs,`,
    `# dashboards, policy, or remediation — those belong in the pack you author or`,
    `# crawl from the repo. Merge this draft with a repo-derived draft to get a`,
    `# tier-2-complete pack.`,
    `# =============================================================================`,
    '',
  ].join('\n');
}

// Body: { mcpUrl | mcpEndpointId, mcpAuth? } (as draft-from-mcp). The
// response says which record was used (mcpEndpoint: { id, name } | null);
// the live pack keeps the safe URL, never a token.
app.post('/api/refresh-live', authorize('POST /api/refresh-live'), async (req, res) => {
  const body = req.body || {};
  const target = resolveMcpTarget(currentStore(), body, { forWrite: false, caller: mcpCallerOf(req) });
  if (target.status) return res.status(target.status).json(mcpRefusalBody(target));
  const { mcpUrl, safeMcpUrl, mcpAuth, endpoint: mcpEndpoint } = target;
  const { dropped } = stripMcpUrl(mcpUrl);
  // The audit (STORE_PLAN slice 5): the principal is checked before any
  // fetch or file write — a missing actor (a bug) writes nothing, 500.
  try { actorForRecord(req); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }

  const t0 = Date.now();
  try {
    process.stderr.write(`[refresh-live] POST /api/refresh-live -> ${safeMcpUrl}\n`);
    const fetched = await fetchMcp({ mcpUrl, mcpAuth });
    const refreshedAt = new Date().toISOString();
    // The persisted mcp.url (and the response's annotations) is the safe form.
    const pack = buildCanonicalPack({ refreshedAt, mcpUrl: safeMcpUrl, ...fetched });
    const errors = validateCanonical(pack, SCHEMA);
    if (errors.length) {
      return res.status(500).json({ ok: false, error: 'built pack failed schema validation', details: errors });
    }
    writeLivePack(emitYaml(pack));   // <org root>/live/production-live.pack.yaml, atomically
    process.stderr.write(`[refresh-live]   ok in ${Date.now() - t0}ms; ` +
      `services=${pack.metadata.annotations['mcp.servicesDiscovered'] || '(none)'} ` +
      `failed=${pack.metadata.annotations['mcp.toolsFailed'] || 'none'}\n`);
    // The row, after the file: the MCP origin (never the URL), the record
    // used, and counts from the comma-list annotations.
    const listCount = (v) => (typeof v === 'string' ? v.split(',').filter(Boolean).length : 0);
    const auditError = auditAfter(req, {
      action: 'live.refresh', targetKind: 'live', targetId: mcpUrlOrigin(safeMcpUrl),
      detail: {
        mcpEndpoint, refreshedAt,
        servicesDiscovered: listCount(pack.metadata.annotations['mcp.servicesDiscovered']),
        toolsFailed: listCount(pack.metadata.annotations['mcp.toolsFailed']),
      },
    }, { tag: 'refresh-live' });
    const note = droppedNote(dropped);
    res.json({
      ok: true,
      refreshedAt,
      pack: adapt(pack),
      annotations: pack.metadata.annotations,
      mcpEndpoint,
      ...(note ? { note } : {}),
      ...(auditError ? { auditError } : {}),
    });
  } catch (e) {
    const error = redactTarget(e.message, target);
    process.stderr.write(`[refresh-live]   error in ${Date.now() - t0}ms: ${error}\n`);
    res.status(502).json({ ok: false, error, details: e.details });
  }
});

// ----------------------------------------------------------------
// POST /api/crawl — Path A of the pack-creation user journey.
//
// Accepts an in-memory file map (the client uploads or drags in
// files; the server never touches disk) and returns a draft
// canonical pack plus the validation + conformance reports.
//
// Body: {
//   files: { [relPath]: contentString },
//   repoName?: string,
//   environment?: string,
//   criticality?: 'tier-1'|'tier-2'|'tier-3',
//   binding?: string,
//   owners?: string[]
// }
//
// Response: { ok, canonical, canonicalYaml, summary, evidence,
//             validation: { ok, errors }, conformance }
//
// The crawler library is shared with tools/crawl-repo.mjs (the
// CLI form); both feed crawlFiles() the same in-memory map shape.
// ----------------------------------------------------------------
app.post('/api/crawl', authorize('POST /api/crawl'), (req, res) => {
  const body = req.body || {};
  const files = body.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return res.status(400).json({ ok: false, error: 'expected JSON body { files: { <relPath>: <content> } }' });
  }
  const entries = Object.entries(files);
  if (entries.length === 0) {
    return res.status(400).json({ ok: false, error: 'no files provided' });
  }
  for (const [k, v] of entries) {
    if (typeof k !== 'string' || typeof v !== 'string') {
      return res.status(400).json({ ok: false, error: `each file entry must be string→string (offending key: ${JSON.stringify(k)})` });
    }
  }
  // Cap total payload to 16 MB so a runaway repo can't OOM the server.
  let total = 0;
  for (const [_, v] of entries) total += v.length;
  if (total > 16 * 1024 * 1024) {
    return res.status(413).json({ ok: false, error: `payload too large (${total} bytes; cap is 16MB). Drop large files like build artefacts or vendored binaries.` });
  }

  const opts = {
    repoName: typeof body.repoName === 'string' ? body.repoName : undefined,
    environment: typeof body.environment === 'string' ? body.environment : undefined,
    diffScopeMode: typeof body.diffScopeMode === 'string' ? body.diffScopeMode : undefined,
    criticality: typeof body.criticality === 'string' ? body.criticality : undefined,
    binding: typeof body.binding === 'string' ? body.binding : undefined,
    owners: Array.isArray(body.owners) ? body.owners.map(String) : undefined,
  };

  const t0 = Date.now();
  try {
    const { yaml, summary, evidence } = crawlToYaml(files, opts);
    const { canonical } = crawlFiles(files, opts);
    const validationErrors = validateCanonical(canonical, SCHEMA);
    const conformance = evaluateConformance(canonical);
    // Register the crawled canonical only if it validates. Bad packs
    // shouldn't pollute the catalog under an addressable id.
    const friendlyLabel = (typeof body.label === 'string' && body.label.trim())
      ? body.label.trim()
      : `${opts.repoName || canonical.metadata?.name || 'crawl'} (scanned)`;
    const registered = validationErrors.length === 0
      ? { id: registerUploadedPack(req, canonical, friendlyLabel, friendlyLabel) }
      : null;
    process.stderr.write(`[crawl] ${entries.length} files, ${summary.files.classified} classified, ${Object.keys(evidence).length} evidence, tier=${summary.inferred.tier}, valid=${validationErrors.length === 0}, registered=${registered?.id || '-'}, ${Date.now() - t0}ms\n`);
    res.json({
      ok: true,
      canonical,
      canonicalYaml: yaml,
      summary,
      evidence,
      validation: { ok: validationErrors.length === 0, errors: validationErrors },
      conformance,
      registered,
      tookMs: Date.now() - t0,
    });
  } catch (e) {
    process.stderr.write(`[crawl] error: ${e.message}\n`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ----------------------------------------------------------------
// POST /api/crawl-github — Path A extension. Same crawler, different
// source: a public GitHub repo URL instead of an uploaded folder.
//
// The server fetches the repo's file tree via the GitHub Tree API,
// downloads just the files the crawler cares about (docker-compose,
// Prometheus rules, OTel configs, dashboards), and feeds them into
// the same crawlFiles() pipeline as /api/crawl. Returns the same
// response shape.
//
// Body: {
//   url:         'https://github.com/owner/repo' | 'owner/repo',
//   ref?:        'main' | 'develop' | <sha>,   // default: repo default branch
//   environment?, criticality?, binding?, owners?  // same as /api/crawl
// }
//
// Auth: respects GITHUB_TOKEN env var for higher rate limits + private
// repos. Without it: public-only, 60 req/hr per IP.
//
// Bandwidth guards: max 200 files, max 16 MB total, max 1 MB per file.
// ----------------------------------------------------------------
// parseGithubUrl / isCrawlerFile / ghFetch live in server/github-crawl.mjs.

app.post('/api/crawl-github', authorize('POST /api/crawl-github'), async (req, res) => {
  const body = req.body || {};
  const parsed = parseGithubUrl(body.url);
  if (!parsed) {
    return res.status(400).json({
      ok: false,
      error: 'expected `url` like https://github.com/owner/repo or owner/repo',
    });
  }
  const { owner, repo } = parsed;
  const explicitRef = (typeof body.ref === 'string' && body.ref.trim()) ? body.ref.trim() : parsed.ref || null;
  const t0 = Date.now();

  try {
    // 1. Resolve default branch when no ref given.
    let ref = explicitRef;
    if (!ref) {
      const repoMeta = await ghFetch(`/repos/${owner}/${repo}`).then(r => r.json());
      ref = repoMeta.default_branch || 'main';
    }

    // 2. List the full tree at that ref.
    const treeResp = await ghFetch(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`)
      .then(r => r.json());
    if (treeResp.truncated) {
      process.stderr.write(`[crawl-github] tree truncated for ${owner}/${repo}@${ref}; some files may be missing\n`);
    }

    // 3. Filter to crawler-relevant blobs.
    const FILE_CAP_BYTES = 1 * 1024 * 1024;        // 1 MB / file
    const TOTAL_CAP_BYTES = 16 * 1024 * 1024;      // 16 MB total
    const MAX_FILES = 200;
    const candidates = (treeResp.tree || [])
      .filter(node => node.type === 'blob' && isCrawlerFile(node.path))
      .filter(node => !node.size || node.size <= FILE_CAP_BYTES)
      .slice(0, MAX_FILES);

    if (candidates.length === 0) {
      return res.json({
        ok: true,
        canonical: null,
        canonicalYaml: '',
        summary: { source: 'github', repo: `${owner}/${repo}`, ref, files: { total: 0, classified: 0 } },
        validation: { ok: false, errors: ['no crawler-relevant files found in repo'] },
        registered: null,
        tookMs: Date.now() - t0,
        notes: ['Repo had no docker-compose, prometheus rules, otel collector configs, alertmanager configs, or Grafana dashboards.'],
      });
    }

    // 4. Download contents in parallel (raw content endpoint).
    let totalBytes = 0;
    const files = {};
    const skipped = [];
    await Promise.all(candidates.map(async (node) => {
      try {
        const contentRes = await ghFetch(`/repos/${owner}/${repo}/contents/${encodeURIComponent(node.path).replace(/%2F/g, '/')}?ref=${encodeURIComponent(ref)}`, {
          headers: { Accept: 'application/vnd.github.raw+json' },
        });
        const text = await contentRes.text();
        if (text.length > FILE_CAP_BYTES) { skipped.push(`${node.path} (size ${text.length})`); return; }
        if (totalBytes + text.length > TOTAL_CAP_BYTES) { skipped.push(`${node.path} (total cap)`); return; }
        files[node.path] = text;
        totalBytes += text.length;
      } catch (e) {
        skipped.push(`${node.path} (${e.message})`);
      }
    }));

    if (Object.keys(files).length === 0) {
      return res.json({
        ok: true, canonical: null, canonicalYaml: '',
        summary: { source: 'github', repo: `${owner}/${repo}`, ref, files: { total: candidates.length, classified: 0 } },
        validation: { ok: false, errors: ['all candidate files were skipped (size caps or download errors)'] },
        registered: null, tookMs: Date.now() - t0, notes: skipped,
      });
    }

    // 5. Run the SAME crawler the upload path uses. The default name is the
    // raw `owner-repo`: the library normalizes it to a spec Slug (one rule
    // for the three doors; the original rides in crawler.nameNormalizedFrom).
    const defaultRepoName = `${owner}-${repo}`;
    const opts = {
      repoName: typeof body.repoName === 'string' && body.repoName.trim()
        ? body.repoName.trim() : defaultRepoName,
      environment: typeof body.environment === 'string' ? body.environment : undefined,
      diffScopeMode: typeof body.diffScopeMode === 'string' ? body.diffScopeMode : undefined,
      criticality: typeof body.criticality === 'string' ? body.criticality : undefined,
      binding: typeof body.binding === 'string' ? body.binding : undefined,
      owners: Array.isArray(body.owners) ? body.owners.map(String) : undefined,
    };
    const { yaml, summary, evidence } = crawlToYaml(files, opts);
    const { canonical } = crawlFiles(files, opts);
    const validationErrors = validateCanonical(canonical, SCHEMA);
    const conformance = evaluateConformance(canonical);
    const friendlyLabel = (typeof body.label === 'string' && body.label.trim())
      ? body.label.trim()
      : `${owner}/${repo} (repo scan)`;
    const registered = validationErrors.length === 0
      ? { id: registerUploadedPack(req, canonical, friendlyLabel, friendlyLabel) }
      : null;

    summary.source = 'github';
    summary.repo   = `${owner}/${repo}`;
    summary.ref    = ref;
    if (skipped.length) summary.skipped = skipped;

    process.stderr.write(`[crawl-github] ${owner}/${repo}@${ref} → ${Object.keys(files).length} files, ${summary.files.classified} classified, valid=${validationErrors.length === 0}, registered=${registered?.id || '-'}, ${Date.now() - t0}ms\n`);
    res.json({
      ok: true,
      canonical,
      canonicalYaml: yaml,
      summary,
      evidence,
      validation: { ok: validationErrors.length === 0, errors: validationErrors },
      conformance,
      registered,
      tookMs: Date.now() - t0,
    });
  } catch (e) {
    process.stderr.write(`[crawl-github] error: ${e.message}\n`);
    const status = e.status === 404 ? 404 : (e.status === 403 ? 403 : 500);
    res.status(status).json({
      ok: false,
      error: e.message,
      hint: e.status === 403
        ? 'GitHub rate limit. Set GITHUB_TOKEN in the server env for higher quotas.'
        : e.status === 404 ? 'Repo not found or private. Set GITHUB_TOKEN to access private repos.' : undefined,
    });
  }
});

app.post('/api/validate', authorize('POST /api/validate'), (req, res) => {
  try {
    let canonical;
    if (typeof req.body === 'string') {
      canonical = parseYaml(req.body);
    } else if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      canonical = req.body;
    } else {
      return res.status(400).json({ ok: false, errors: ['expected JSON body or text/yaml body'] });
    }
    // Previous pack format — the pre-v1.2 layered JSON (examples/legacy/).
    // Upconvert at the gate so everything downstream (validator, adapter,
    // conformance, compile, deploy, diff) stays one canonical pipeline.
    // The response carries the conversion report so the client can say so.
    let legacyReport = null;
    if (isLegacyLayeredPack(canonical)) {
      ({ canonical, report: legacyReport } = upconvertLegacyPack(canonical, { now: new Date().toISOString() }));
    }
    const errors = validateCanonical(canonical, SCHEMA);
    if (errors.length) return res.json({ ok: false, errors });
    const env = readEnv(req.query);
    const adapted = adapt(canonical, { environment: env });
    const { canonical: overlaid } = overlaidCanonical(canonical, env);
    const conformance = evaluateConformance(overlaid);
    // Register the canonical so the rest of the API can refer to it by
    // id. The client uses `registered.id` as the new state.selectedPackId
    // — that unlocks per-artefact Compile, Deploy, Conformance, diff
    // against this pack as Pack A or Pack B, etc. ?source= lets the
    // client describe where the pack came from (file name, crawl target,
    // mcp URL); falls back to the canonical's metadata.name.
    const sourceHint = typeof req.query.source === 'string' && req.query.source ? req.query.source : null;
    const id = registerUploadedPack(req, canonical, sourceHint || canonical.metadata?.name || 'upload');
    // A library-built pack (docs/BUILD_JOURNEY.md, Placeholders) is conformant
    // on paper: the rubric reads no annotations, so a pager route of
    // `pagerduty://<svc>` satisfies its clause like a real one. Only the
    // engine's summary tells the clauses that pass on a placeholder from the
    // rest — attached whenever the pack carries library.todo.* annotations.
    const summary = librarySummaryFor(overlaid);
    res.json({ ok: true, adapted, conformance, registered: { id, source: sourceHint || null }, ...(summary ? { summary } : {}), ...(legacyReport ? { legacy: legacyReport } : {}) });
  } catch (e) {
    res.status(400).json({ ok: false, errors: [e.message] });
  }
});

// ----------------------------------------------------------------
// The BUILD journey API (docs/BUILD_JOURNEY.md, slice 2) — the studio's
// Define · Compile · Verify steps over the engine in tools/lib/library.mjs.
// Registered here, after the write-route auth and tenancy middleware, so
// they carry the same posture as POST /api/validate and POST /api/crawl:
// open in local mode, a session or bearer in identity mode. The library is
// read from disk once per process (server/library.mjs); nothing here
// touches the filesystem afterwards.
// ----------------------------------------------------------------

let LIBRARY = null;
function library() {
  if (!LIBRARY) LIBRARY = loadLibrary();
  return LIBRARY;
}

// validationSummary over the todos a pack's own annotations carry — null
// when the pack is not library-built (or has no placeholders left).
function librarySummaryFor(canonical) {
  if (!hasLibraryTodos(canonical)) return null;
  try { return validationSummary(canonical, todosFromAnnotations(canonical)); }
  catch { return null; }
}

const knownEntryIds = () => library().entries.map(e => e.id).join(', ');
const tierError = (tier) => `unknown tier ${JSON.stringify(tier)} (known: ${TIERS.join(', ')})`;

// GET /api/library — the index the DEFINE step lists (libraryIndex of loadLibrary)
// plus the scaffold's own params (every instantiation has them) and the files
// that did not load, so an entry missing from the list is never a mystery.
app.get('/api/library', authorize('GET /api/library'), (req, res) => {
  const lib = library();
  res.json({ ok: true, entries: libraryIndex(lib.entries), scaffoldParams: SCAFFOLD_PARAMS, errors: lib.errors });
});

// GET /api/library/requirements/:tier — the conformance clauses that apply at
// the tier (tierRequirements: the rubric filtered by minTier, never a second one).
app.get('/api/library/requirements/:tier', authorize('GET /api/library/requirements/:tier'), (req, res) => {
  const tier = req.params.tier;
  if (!TIERS.includes(tier)) return res.status(400).json({ ok: false, error: tierError(tier) });
  res.json({ ok: true, tier, clauses: tierRequirements(tier) });
});

// GET /api/library/:id — one entry: its index row (what the step needs) plus
// the full SLI templates and params (what a details drawer needs).
app.get('/api/library/:id', authorize('GET /api/library/:id'), (req, res) => {
  const entry = findEntry(library(), req.params.id);
  if (!entry) return res.status(404).json({ ok: false, error: `unknown library entry ${JSON.stringify(req.params.id)} (known: ${knownEntryIds()})` });
  const [row] = libraryIndex([entry]);
  res.json({
    ok: true,
    entry: row,
    params: JSON.parse(JSON.stringify(entry.params || [])),
    scaffoldParams: SCAFFOLD_PARAMS,
    slis: JSON.parse(JSON.stringify(entry.slis || [])),
    description: entry.description || '',
    evidence: JSON.parse(JSON.stringify(entry.evidence || {})),
    otel: JSON.parse(JSON.stringify(entry.otel || {})),
    telemetry: JSON.parse(JSON.stringify(entry.telemetry || {})),
  });
});

// The entries a request names: `entries: [ids]` or `id` / `entry`; a 400 names
// the unknown one and the known ones.
function resolveRequestedEntries(body) {
  const raw = Array.isArray(body.entries) ? body.entries
    : typeof body.entries === 'string' ? body.entries.split(',')
    : typeof body.id === 'string' ? [body.id]
    : typeof body.entry === 'string' ? body.entry.split(',')
    : [];
  const ids = raw.map(s => String(s).trim()).filter(Boolean);
  if (!ids.length) return { error: 'expected `entries: [<library entry id>, …]` (GET /api/library lists them)' };
  const entries = [];
  for (const id of ids) {
    const entry = findEntry(library(), id);
    if (!entry) return { error: `unknown library entry ${JSON.stringify(id)} (known: ${knownEntryIds()})` };
    entries.push(entry);
  }
  return { entries };
}

// The caps on the copies a request may carry (docs/BUILD_JOURNEY.md "The seed and the copies"): the
// engine bounds every string at MAX_PARAM_LENGTH; the route bounds the counts so a body of ten thousand
// overrides is refused before anything is validated one by one.
const MAX_OVERRIDES = 64;
const MAX_CUSTOM_SLIS = 16;

/**
 * The instantiate inputs of a request body, whitelisted: entries, name, tier, environment, owners, params,
 * toggles, overrides (an object of at most MAX_OVERRIDES entries), custom (a list of at most MAX_CUSTOM_SLIS).
 * Returns { opts } or { errors } (a 400 body). The engine validates every value.
 */
function instantiateInputs(body) {
  const picked = resolveRequestedEntries(body);
  if (picked.error) return { errors: [picked.error] };
  if (body.tier !== undefined && !TIERS.includes(body.tier)) return { errors: [tierError(body.tier)] };
  const owners = Array.isArray(body.owners) ? body.owners.map(String)
    : typeof body.owners === 'string' ? body.owners.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const params = (body.params && typeof body.params === 'object' && !Array.isArray(body.params)) ? body.params : {};
  const toggles = (body.toggles && typeof body.toggles === 'object' && !Array.isArray(body.toggles)) ? body.toggles : {};
  let overrides;
  if (body.overrides !== undefined && body.overrides !== null) {
    if (typeof body.overrides !== 'object' || Array.isArray(body.overrides)) return { errors: ['overrides: expected an object of { <sli id>: { id?, objective?, window?, threshold?, query?, good?, total?, description?, unit?, semconv_metric? } }'] };
    const n = Object.keys(body.overrides).length;
    if (n > MAX_OVERRIDES) return { errors: [`overrides: at most ${MAX_OVERRIDES} entries (${n} given)`] };
    overrides = body.overrides;
  }
  let custom;
  if (body.custom !== undefined && body.custom !== null) {
    if (!Array.isArray(body.custom)) return { errors: ['custom: expected a list of { id, type, objective, window, good + total | query + threshold, description?, unit? }'] };
    if (body.custom.length > MAX_CUSTOM_SLIS) return { errors: [`custom: at most ${MAX_CUSTOM_SLIS} custom SLIs (${body.custom.length} given)`] };
    custom = body.custom;
  }
  return { opts: { entries: picked.entries, name: body.name, tier: body.tier, environment: body.environment, owners, params, toggles, overrides, custom } };
}

/** instantiatePack on a request's inputs: { result } or { errors } — an engine usage error is a 400, never a 500. */
function instantiateFromBody(body) {
  const inputs = instantiateInputs(body);
  if (inputs.errors) return inputs;
  const { entries, ...opts } = inputs.opts;
  try {
    return { result: instantiatePack(entries, { ...opts, promql: parsePromql }) };
  } catch (e) {
    return { errors: [e.message] };
  }
}

// POST /api/library/instantiate — body { entries | id, name, tier, environment,
// owners, params, toggles, overrides, custom } → the engine's result plus what VERIFY reads:
// schemaErrors (validateCanonical), summary (validationSummary), conformance
// (evaluateConformance of the env-overlaid canonical, as /api/validate computes
// it), `adapted` (the adapter's layered projection of the env-overlaid canonical,
// exactly as /api/validate returns it — what Build's layer stack draws, so it is
// the artefact list Discover shows after the hand-off, id for id) and the pack as
// YAML for the preview and the download. Node passes the Lezer PromQL grammar,
// as packc init does, so a broken SLI expression comes back as a `promql`
// warning. A usage error from the engine is 400, never 500.
app.post('/api/library/instantiate', authorize('POST /api/library/instantiate'), (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : null;
  if (!body) return res.status(400).json({ ok: false, errors: ['expected a JSON body { entries, name, tier, environment, owners, params, toggles, overrides, custom }'] });
  const made = instantiateFromBody(body);
  if (made.errors) return res.status(400).json({ ok: false, errors: made.errors });
  const { canonical, todos, provenance, warnings } = made.result;
  const schemaErrors = validateCanonical(canonical, SCHEMA);
  const summary = validationSummary(canonical, todos);
  const { canonical: overlaid } = overlaidCanonical(canonical, provenance.environment);
  const conformance = evaluateConformance(overlaid);
  // adapt() applies the environment overlay itself: the same call /api/validate makes.
  const adapted = adapt(canonical, { environment: provenance.environment });
  const canonicalYaml = `# ObservabilityPack ${canonical.metadata.name} — built from the library (${provenance.source}) at ${provenance.tier}\n# Todos: ${todos.length} (metadata.annotations library.todo.*). Spec v${SPEC_VERSION}.\n` + emitYaml(canonical);
  res.json({ ok: true, canonical, canonicalYaml, todos, provenance, warnings, schemaErrors, summary, conformance, adapted });
});

// The pack a compile or register request means: its `canonical`, or — when it carries the instantiate
// inputs instead (entries, name, tier, …, overrides, custom) — the pack those inputs make, so a caller
// can compile or register a customised pack in one request. { canonical } or { status, body }.
function canonicalOfBody(body, what) {
  if (body.canonical !== undefined) {
    const canonical = body.canonical;
    if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical) || !canonical.spec) return { status: 400, body: { ok: false, ...what('expected `canonical`: a canonical ObservabilityPack object (the instantiate response carries one), or the instantiate inputs (entries, name, tier, …, overrides, custom)') } };
    return { canonical };
  }
  if (body.entries === undefined && body.id === undefined && body.entry === undefined) return { status: 400, body: { ok: false, ...what('expected `canonical`: a canonical ObservabilityPack object (the instantiate response carries one), or the instantiate inputs (entries, name, tier, …, overrides, custom)') } };
  const made = instantiateFromBody(body);
  if (made.errors) return { status: 400, body: { ok: false, ...what(made.errors) } };
  return { canonical: made.result.canonical };
}

// POST /api/library/compile — body { canonical | the instantiate inputs, target, dashboardId? } → one
// compiled artefact through tools/lib/compile.mjs, so VERIFY previews the
// Prometheus rules, the collector config, the Alertmanager routes and the
// Grafana boards without registering anything.
app.post('/api/library/compile', authorize('POST /api/library/compile'), (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const target = body.target;
  if (!TARGETS[target]) return res.status(400).json({ ok: false, error: `unknown compile target ${JSON.stringify(target)} (known: ${Object.keys(TARGETS).join(', ')})` });
  const got = canonicalOfBody(body, (e) => ({ error: Array.isArray(e) ? e.join('; ') : e }));
  if (got.status) return res.status(got.status).json(got.body);
  const canonical = got.canonical;
  try {
    const opts = typeof body.dashboardId === 'string' && body.dashboardId ? { dashboardId: body.dashboardId } : {};
    const out = compile(canonical, target, opts);
    res.json({
      ok: true, target, label: TARGETS[target].label, description: TARGETS[target].description, contentType: out.contentType,
      artifact: { filename: out.filename, content: out.content, warnings: out.warnings, profile: out.profile },
    });
  } catch (e) {
    // A pack that will not compile (a section toggled off, a board it does
    // not declare) is the caller's input, not a server fault.
    res.status(400).json({ ok: false, error: e.message });
  }
});

// POST /api/library/register — body { canonical, source? } → the pack into the
// upload registry exactly as POST /api/validate registers one (registerUploadedPack),
// so "Open in Discover" hands Discover an ordinary registered pack. The source hint
// defaults to `library:<entries>@<tier>` for a library-built pack (one carrying
// library.source) and to metadata.name for anything else, as /api/validate labels an
// upload; the todos travel in metadata.annotations and the summary says which
// clauses still pass on a placeholder.
app.post('/api/library/register', authorize('POST /api/library/register'), (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const got = canonicalOfBody(body, (e) => ({ errors: Array.isArray(e) ? e : [e] }));
  if (got.status) return res.status(got.status).json(got.body);
  const canonical = got.canonical;
  try {
    const errors = validateCanonical(canonical, SCHEMA);
    if (errors.length) return res.status(400).json({ ok: false, errors });
    const ann = canonical.metadata?.annotations || {};
    const libSource = typeof ann['library.source'] === 'string' && ann['library.source'].trim() ? ann['library.source'].trim() : null;
    const entryIds = libSource ? libSource.split(',').map(s => s.split('@')[0].trim()).filter(Boolean) : [];
    const defaultSource = libSource
      ? `library:${entryIds.join(',') || 'pack'}@${ann['library.tier'] || canonical.metadata?.bindings?.criticality || 'tier-3'}`
      : (canonical.metadata?.name || 'upload');
    const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim() : defaultSource;
    const env = readEnv(req.query) || ann['library.environment'] || null;
    const adapted = adapt(canonical, { environment: env });
    const { canonical: overlaid } = overlaidCanonical(canonical, env);
    const conformance = evaluateConformance(overlaid);
    const summary = librarySummaryFor(overlaid) || validationSummary(overlaid, []);
    const id = registerUploadedPack(req, canonical, source);
    res.json({ ok: true, registered: { id, source }, adapted, conformance, summary });
  } catch (e) {
    res.status(400).json({ ok: false, errors: [e.message] });
  }
});

// Static studio shell + assets.
// Expose the shared crawler + YAML libraries so the browser can do
// client-side artefact detection (filtering the staged file map BEFORE
// posting to /api/crawl). Single source of truth — same module the
// CLI and the server use.
app.use('/lib', express.static(resolve(ROOT, 'tools/lib'), {
  extensions: ['mjs', 'js'],
  setHeaders: (res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

// The studio shell (studio/index.html), one way out for every path that
// serves it: `/`, `/index.html` and the SPA fallback below. Unbranded (the
// default) it is res.sendFile — the same `send` pipeline express.static ran,
// so the bytes and the headers (ETag, Last-Modified, Cache-Control, Accept-
// Ranges) are the ones the static mount used to answer. Branded
// (OBSERVOGRAM_BRAND_FILE / OBSERVOGRAM_BRAND_*, read once in start()), it is
// brandShellHtml's rendering, held in memory, no-cache. The static mount
// serves no index and tries no extension, so `/index` cannot reach the
// on-disk shell around this handler (it falls to the SPA route instead).
const SHELL_FILE = resolve(STUDIO_DIR, 'index.html');
let brandedShell = null;
// The brand start() loaded (DEFAULT_BRAND until then): the audit report's
// chrome and tokens read it through the closure above.
let brand = DEFAULT_BRAND;
function sendShell(req, res) {
  if (brandedShell !== null) return res.type('html').set('Cache-Control', 'no-cache').send(brandedShell);
  res.sendFile(SHELL_FILE);
}
app.get('/', authorize('GET /'), sendShell);
app.get('/index.html', authorize('GET /index.html'), sendShell);

app.use(express.static(STUDIO_DIR, { index: false }));

// SPA-style fallback: any unknown GET returns the studio shell so the client
// can route. The /api/* paths above already handled JSON requests.
const SPA_FALLBACK = /^(?!\/api\/).*/;
app.get(SPA_FALLBACK, authorize(`GET ${SPA_FALLBACK}`), (req, res, next) => {
  if (req.method !== 'GET') return next();
  sendShell(req, res);
});

// ---------- entrypoint ----------

const PORT = Number(process.env.PORT || 8000);
// Loopback by default — matching the documented contract. Exposing the
// studio (HOST=0.0.0.0) requires OBSERVOGRAM_API_TOKEN; see start().
const HOST = process.env.HOST || '127.0.0.1';

export { app };

// Boot step 6: rehydrate each live org's upload registry from its rows and
// its workspace subtree. Idempotent per store: a map that exists is not
// refilled (suites call start() several times in one process).
function rehydrateOrgs(silent) {
  let restored = 0;
  for (const org of listOrgs(currentStore())) {
    runWithOrg(org.id, () => { restored += ensureOrgLoaded(currentStore()); });
  }
  if (restored && !silent) process.stdout.write(`[studio] restored ${restored} pack${restored === 1 ? '' : 's'} from workspace\n`);
}

// The studio no longer reads the install's deployment-wide live pack
// (STORE_PLAN slice 3: one per org). While that file exists and the default
// org has no live pack of its own yet, one line says where the badge reads
// now — it stops after the default org's first refresh. The file is not
// moved: it belonged to no org, and the CLIs still use it.
function noteLegacyLivePack(db, log, legacyPath) {
  try {
    if (!existsSync(legacyPath)) return;
    const org = defaultOrgId(db);
    if (!org || runWithOrg(org, () => readLivePack()) !== null) return;
    log(`[studio] the studio no longer reads ${LEGACY_LIVE_PACK}: each org's live pack is <org root>/live/${LIVE_PACK_FILE}, `
      + `written by the MCP panel's refresh (npm run detect-drift and the dry run still read the old file; `
      + `OUTPUT=<org root>/live/${LIVE_PACK_FILE} npm run fetch-live writes the new one)`);
  } catch { /* a note, never a boot failure */ }
}

// Boot steps 1–5 are server/boot.mjs's bootStore(): the store opened, the
// stale-import guard, the legacy import once, the seed decision and the
// fail-closed checks (docs/STORE_PLAN.md §4). A refusal arrives as a
// rejected promise (BootRefusal / LegacyFileError). Then step 6 and the
// listen. legacyLivePack is where the old file is looked for — a seam for
// the suites, which must not plant one in the checkout's examples/ (other
// suites enumerate examples/*.pack.yaml concurrently).
export async function start({ port = PORT, host = HOST, silent = false, legacyLivePack = resolve(ROOT, LEGACY_LIVE_PACK) } = {}) {
  const log = (m) => { if (!silent) process.stdout.write(m + '\n'); };
  const warn = (m) => { if (!silent) process.stderr.write(m + '\n'); };
  // The artefact taxonomy override (OBSERVOGRAM_TAXONOMY, server/taxonomy.mjs)
  // is read first: an unreadable or invalid file refuses the start before
  // the store is touched; a loaded one is installed process-wide for the
  // diff and the graphs and logged here once, path only.
  loadTaxonomy({ log });
  // The MCP server-settings policy (OBSERVOGRAM_MCP_SETTINGS_POLICY,
  // server/mcp-settings-policy.mjs), the taxonomy's twin: an unreadable or
  // invalid file refuses the start before the store is touched; a loaded one
  // is logged here once, path and rule count only.
  loadSettingsPolicy({ log });
  // The brand (tools/lib/brand-env.mjs loadBrand, tools/lib/brand.mjs): read
  // here, not at import, so an in-process suite's env lands first; a bad
  // brand file refuses the start before the store is touched. Said once,
  // name and source (a path or 'env') only — never the file's contents.
  brand = loadBrand();
  brandedShell = brand.configured ? brandShellHtml(readFileSync(SHELL_FILE, 'utf8'), brand) : null;
  if (brand.configured) log(`[studio] brand: ${brand.name} (${brandSource() === 'env' ? 'OBSERVOGRAM_BRAND_* env' : brandSource()})`);
  const { db, ctx } = await bootStore({ host, log, warn });
  // The MCP transport hook (OBSERVOGRAM_TRANSPORT_HOOK, tools/mcp-transport.mjs)
  // loads once per process: a hook that cannot load refuses the start, and
  // every MCP call the routes make (refresh, draft, deploy) goes through it.
  // Logged here once, by this entrypoint — the loader is silent.
  const transport = await mcpTransport();
  if (transport.hookPath) log(`[studio] MCP transport hook: ${describeTransport(transport)}`);
  // Identity from a reverse proxy (OBSERVOGRAM_TRUST_PROXY_AUTH=1,
  // server/auth-proxy.mjs): said once here, header names only, never the secret.
  if (ctx.proxyAuth) log(`[studio] identity from the reverse proxy: ${describeProxyAuth(ctx.proxyAuth)}`);
  if (localUsersEnabled()) touchSessionSecret();
  // Journeys/runs live in the engine (tools/lib/journey.mjs) — wire its
  // root through the same context-aware resolver the registry uses.
  setWorkspaceRootResolver(orgWorkspaceRoot);
  rehydrateOrgs(silent);
  noteLegacyLivePack(db, log, legacyLivePack);
  // Each server stamps its own bind on the requests it receives
  // (server/authz.mjs listenOf): suites run several servers per process
  // on different binds, so the bind never lives in module state.
  const listen = Object.freeze({ host, loopback: ctx.loopback });
  return new Promise((resolveListen, reject) => {
    const srv = createServer((req, res) => { req.observogramListen = listen; app(req, res); });
    srv.listen(port, host, () => {
      // Defensive: should the listening callback ever fire without an
      // address (a failed bind), bail here so the error handler below
      // resolves the promise; the call site will format a friendly message.
      const addr = srv.address();
      if (!addr) return;
      // The sign-in mode the CLIs read (server/identity-admin.mjs) is this
      // server's only once it listens: a start that fails to bind records nothing.
      recordIdentityMode(db, ctx);
      if (!silent) process.stdout.write(`[studio] listening on http://${addr.address}:${addr.port}\n`);
      resolveListen(srv);
    });
    srv.on('error', reject);
    // The live jobs run in this process's memory: a server that stops
    // aborts them (each fails, saying so; every timer is unref()'d).
    srv.on('close', abortAllLiveJobs);
  });
}

const invokedDirectly = resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  start().catch(e => {
    // EADDRINUSE is the common case — give a clear, actionable hint
    // instead of a generic stack trace.
    if (e && e.code === 'EADDRINUSE') {
      process.stderr.write(
        `[studio] port ${PORT} is already in use.\n` +
        `         Another Observogram instance is probably running. Stop it, or:\n` +
        `           PORT=8001 npm run dev\n`
      );
    } else {
      process.stderr.write(`[studio] failed to start: ${e.message}\n`);
    }
    process.exit(1);
  });
}
