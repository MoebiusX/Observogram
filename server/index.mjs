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
 *   GET  /api/packs/:id/conformance       Maturity-rubric scoring (?env=<name>)
 *   GET  /api/maturity-rubric             Rubric metadata (clause definitions)
 *   POST /api/validate                    Validate uploaded JSON/YAML body
 *
 * Env:
 *   PORT   default 8000
 *   HOST   default 127.0.0.1
 */

import express from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { parse as parseYaml, emit as emitYaml } from '../tools/lib/mini-yaml.mjs';
import { adapt, listEnvironments, applyEnvironmentOverlay } from '../tools/lib/adapter.mjs';
import { isLegacyLayeredPack, upconvertLegacyPack } from '../tools/lib/legacy.mjs';
import { validateCanonical, SPEC_VERSION } from '../tools/lib/validator.mjs';
import { evaluateConformance, RUBRIC } from '../tools/lib/conformance.mjs';
import { crawlFiles, crawlToYaml } from '../tools/lib/crawler.mjs';
import { fetchMcp, buildCanonicalPack } from '../tools/fetch-live-pack.mjs';
import { diffPacks } from '../tools/lib/diff.mjs';
import { comparePackBranches } from '../tools/lib/traceability-graph.mjs';
import { compile, listTargets, compileCatalog, compileArtifact } from '../tools/lib/compile.mjs';
import { makeZip } from '../tools/lib/zip.mjs';
import {
  saveWorkspacePack, deleteWorkspacePack, touchWorkspacePack,
  loadWorkspacePacks, clearWorkspacePacks, workspaceInfo,
} from './workspace.mjs';
import {
  listJourneys, loadJourneyDef, runJourney, readJourneyRuns, saveJourneyDef,
} from '../tools/lib/journey.mjs';
import { retrofeedShadowSignals } from '../tools/lib/retrofeed.mjs';
import { initAuth, authEnabled, readSession, maybeSeedDefaultAdmin, defaultAdminCredentialActive } from './auth.mjs';
import { validateMcpUrl, redactCredentials } from './mcp-url.mjs';
import { parseGithubUrl, isCrawlerFile, ghFetch } from './github-crawl.mjs';
import { deployRoutes } from './routes/deploy.mjs';
import { versionInfo } from './version.mjs';
import { tenancyEnabled, orgsForUser, orgExists, runWithOrg, currentOrg, readOrgs, migrateFlatWorkspace } from './tenancy.mjs';
import { setWorkspaceRootResolver } from '../tools/lib/journey.mjs';
import { orgWorkspaceRoot } from './tenancy.mjs';
import { brandEnv } from '../tools/lib/brand-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const STUDIO_DIR = resolve(ROOT, 'studio');
const SCHEMA_PATH = resolve(
  ROOT, 'vendor', 'observability-pack-spec', `v${SPEC_VERSION}`, 'observability-pack.schema.json'
);
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
    path: 'vendor/observability-pack-spec/v1.2/examples/payment-service.pack.yaml',
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
// Capped at MAX_UPLOADS to bound memory; oldest entry evicted on overflow.
// Backed by the workspace directory (server/workspace.mjs): every
// registration writes through to disk and start() rehydrates the map, so
// crawled / drafted / uploaded packs survive restarts. Eviction at the cap
// prunes both the map and the disk copy (retention by least-recently-used).
// With tenancy on, each org has its own registry — a process-wide map
// would leak one org's packs into another's catalog, which is exactly
// what the Stage 2 isolation gate forbids. Scope key '' is the flat
// (tenancy-off) workspace; org scopes rehydrate lazily from their own
// workspace subtree on first touch.
const UPLOAD_REGISTRIES = new Map();   // scope ('' | orgId) → Map(id → { canonical, source, createdAt })
const MAX_UPLOADS = 200;

function uploadsMap() {
  const scope = (tenancyEnabled() && currentOrg()) || '';
  let m = UPLOAD_REGISTRIES.get(scope);
  if (!m) {
    m = new Map();
    UPLOAD_REGISTRIES.set(scope, m);
    if (scope) {
      // First touch of this org in this process: rehydrate from its own
      // workspace subtree (loadWorkspacePacks resolves the org root from
      // the request's AsyncLocalStorage context).
      try {
        for (const p of loadWorkspacePacks()) {
          if (!m.has(p.id)) m.set(p.id, { canonical: p.canonical, source: p.source, label: p.label, createdAt: p.createdAt });
        }
      } catch (e) {
        process.stderr.write(`[workspace] org '${scope}' rehydrate failed: ${e.message}\n`);
      }
    }
  }
  return m;
}

function slugify(s) {
  return String(s || 'pack')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'pack';
}

// Deterministic content hash — same canonical → same id across restarts,
// engineers, and environments. The first 8 hex chars of SHA-256 over the
// JSON.stringify of the canonical pack object. 8 chars = 32 bits = ~4B
// slots, comfortably collision-free for the demo's 20-pack cap. Run-time
// annotations (metadata.annotations.mcp.refreshedAt etc.) ARE included in
// the hash on purpose — two packs that differ only in their refreshedAt
// timestamp are genuinely different snapshots and deserve distinct ids.
function contentHash(canonical) {
  const json = JSON.stringify(canonical || {});
  return createHash('sha256').update(json).digest('hex').slice(0, 8);
}

function registerUploadedPack(canonical, source, label) {
  const slug = slugify(canonical?.metadata?.name || source || 'pack');
  const id = `uploaded-${slug}-${contentHash(canonical)}`;
  // Idempotent: if the same canonical content was already registered,
  // delete + re-insert refreshes its LRU position without minting a new
  // id. That makes re-upload safe (no duplicate entries) AND keeps the
  // user's pick alive when they're actively working with that pack.
  const uploads = uploadsMap();
  if (uploads.has(id)) uploads.delete(id);
  // ALSO drop any older entry whose friendly label collides with the
  // new one. This is how the quick-start cases stay deduplicated:
  // a second "KrystalineX (repo scan)" replaces the first instead of
  // accumulating clones in the picker.
  if (label) {
    for (const [otherId, rec] of [...uploads.entries()]) {
      if (rec.label === label && otherId !== id) {
        uploads.delete(otherId);
        deleteWorkspacePack(otherId);
      }
    }
  }
  const rec = { canonical, source: source || 'upload', label, createdAt: Date.now() };
  uploads.set(id, rec);
  saveWorkspacePack(id, rec);
  // Evict the oldest if we've blown the cap — disk copy goes with it.
  while (uploads.size > MAX_UPLOADS) {
    const oldestKey = uploads.keys().next().value;
    uploads.delete(oldestKey);
    deleteWorkspacePack(oldestKey);
  }
  return id;
}

function uploadedMeta(id) {
  const upl = uploadsMap().get(id);
  if (!upl) return null;
  touchWorkspacePack(id);   // keeps lastUsedAt-based retention honest (debounced)
  return {
    id,
    path: null,        // signal: not file-backed
    canonical: upl.canonical,
    // Prefer the explicit friendly label when present, fall back to
    // the canonical pack name. This is what the picker dropdown reads.
    label: upl.label || upl.canonical?.metadata?.name || id,
    description: `Uploaded pack — ${upl.source}`,
    source: upl.source,
    uploaded: true,
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
      ok: true,
    };
  } catch (e) {
    return { id: meta.id, label: meta.label, ok: false, error: e.message };
  }
}

function serviceMetadata(canonical) {
  const bindings = canonical?.metadata?.bindings || {};
  const annotations = canonical?.metadata?.annotations || {};
  const services = new Set();
  const add = (value) => {
    for (const part of String(value || '').split(',')) {
      const service = part.trim();
      if (service) services.add(service);
    }
  };
  add(bindings.service);
  add(bindings.namespace);
  add(annotations['mcp.servicesDiscovered']);
  add(annotations['observogram.services']);
  add(annotations['tomograph.services']);   // legacy namespace (pre-rebrand packs)
  return {
    service: bindings.service || canonical?.metadata?.name || '',
    namespace: bindings.namespace || bindings.service || canonical?.metadata?.name || '',
    services: [...services].sort(),
  };
}

function readEnv(query) {
  return typeof query.env === 'string' && query.env ? query.env : null;
}

// MCP URL validation (SSRF guard) lives in server/mcp-url.mjs — every
// deploy / draft / refresh endpoint goes through validateMcpUrl(), and
// stderr logs use redactCredentials()/safeUrl, never the raw URL.

// Returns a canonical object with the env overlay applied to spec.* AND
// effective criticality/target propagated up to metadata.bindings so the
// conformance scorer sees the correct tier for the selected environment.
// (The adapter already takes opts.environment and produces its own metadata
// projection — this helper is for non-adapter consumers.)
function overlaidCanonical(canonical, envName) {
  const { spec, effective } = applyEnvironmentOverlay(canonical.spec || {}, envName);
  const next = { ...canonical, spec };
  if (effective.criticality || effective.target) {
    next.metadata = {
      ...(canonical.metadata || {}),
      bindings: {
        ...(canonical.metadata?.bindings || {}),
        ...(effective.criticality ? { criticality: effective.criticality } : {}),
        ...(effective.target ? { default_target: effective.target } : {}),
      },
    };
  }
  return { canonical: next, effective };
}

// ---------- app ----------

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);

// ---------- write-route auth (VALUE_BACKLOG item 10B) ----------
//
// One token, three postures:
//   1. Local (default): loopback bind, no token, no auth — zero friction.
//   2. Exposed + OBSERVOGRAM_API_TOKEN set: mutating /api/* routes require
//      `Authorization: Bearer <token>`. Reads stay open. Once a token is
//      set it is enforced regardless of bind address — a reverse proxy
//      makes everything look local, so a loopback bypass would undermine
//      the token exactly when it matters.
//   3. Exposed + no token: the server REFUSES TO START (fail closed; see
//      start()). OBSERVOGRAM_INSECURE_NO_AUTH=1 is the explicit, loudly
//      logged override for trusted-network demos.
// MCP write tokens are unrelated and never stored here — they pass
// through per request. The audit log records the token's ownership label
// (OBSERVOGRAM_API_TOKEN_LABEL), never the secret.

function apiToken() { return brandEnv('API_TOKEN'); }
function apiTokenLabel() { return brandEnv('API_TOKEN_LABEL') || 'token'; }

function tokenEquals(candidate, token) {
  // Constant-time compare over digests so length differences leak nothing.
  const a = createHash('sha256').update(String(candidate)).digest();
  const b = createHash('sha256').update(String(token)).digest();
  return timingSafeEqual(a, b);
}

// Who performed a mutating request — the audit log's actor field.
function actorForRequest(req) { return req?.observogramActor || 'local'; }

app.use((req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();   // the login flow itself
  const token = apiToken();
  const identity = authEnabled();                     // OIDC or stand-alone users
  if (!token && !identity) return next();             // posture 1/3 — local, no friction
  const isApi = req.path.startsWith('/api/');
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);

  // Bearer token: the service-account / CI path — works in every posture.
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (m && token && tokenEquals(m[1].trim(), token)) {
    req.observogramActor = apiTokenLabel();
    req.observogramBearer = true;
    return next();
  }

  if (identity) {
    const session = readSession(req);
    if (session) {
      // Cookie-authenticated mutations require the custom header —
      // cross-origin pages can't set one without a CORS preflight, so
      // SameSite=Lax + this check closes the CSRF window. The legacy
      // X-Tomograph-CSRF spelling stays accepted for pre-rebrand clients.
      const csrf = req.headers['x-observogram-csrf'] || req.headers['x-tomograph-csrf'];
      if (mutating && isApi && csrf !== '1') {
        return res.status(403).json({ ok: false, error: 'missing X-Observogram-CSRF header on a session-authenticated mutation' });
      }
      req.observogramActor = session.email || session.sub;
      req.observogramSub = session.sub;   // tenancy middleware resolves org membership by sub
      return next();
    }
    // Identity mode protects ALL /api data (reads included) — "your
    // services" is enforced server-side. The static studio shell stays
    // open so the client can land and redirect to the login page.
    if (isApi) {
      return res.status(401).json({ ok: false, error: 'unauthorized: sign in required', login: '/auth/login' });
    }
    return next();
  }

  // Token-only posture (no identity configured): original 10B contract —
  // mutating /api routes require the bearer, reads stay open.
  if (!mutating || !isApi) return next();
  res.set('WWW-Authenticate', 'Bearer realm="observogram"');
  return res.status(401).json({
    ok: false,
    error: 'unauthorized: mutating /api routes require `Authorization: Bearer <OBSERVOGRAM_API_TOKEN>`',
  });
});

// ---------- tenancy (Stage 2 — workspace-per-org) ----------
//
// Armed when <workspace>/orgs.json exists (server/tenancy.mjs). Every
// /api request then runs inside an AsyncLocalStorage org context, and
// workspaceRoot() everywhere underneath answers <workspace>/orgs/<id>/.
// The org comes from the X-Observogram-Org header (or ?org=; the legacy
// X-Tomograph-Org spelling still works), defaulting to the user's first
// membership; membership is enforced here — Stage 3 adds per-route roles
// on top of this same seam.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') || !tenancyEnabled()) return next();
  const requested = String(req.headers['x-observogram-org'] || req.headers['x-tomograph-org'] || req.query.org || '').trim();
  let orgId;
  if (req.observogramBearer) {
    // The bearer is the deployment-level service account: it may target
    // any existing org explicitly; without a header it falls back to
    // 'default' (the migration org) or, failing that, the first org in
    // orgs.json — so single-org deployments never need the header.
    orgId = requested || (orgExists('default') ? 'default' : Object.keys(readOrgs())[0] || 'default');
    if (!orgExists(orgId)) {
      return res.status(403).json({ ok: false, error: `unknown org '${orgId}'` });
    }
  } else {
    const memberships = orgsForUser(req.observogramSub);
    if (!memberships.length) {
      return res.status(403).json({ ok: false, error: 'no org membership — ask an admin to add you to orgs.json' });
    }
    orgId = requested || memberships[0].id;
    if (!memberships.some(o => o.id === orgId)) {
      return res.status(403).json({ ok: false, error: `not a member of org '${orgId}'` });
    }
  }
  res.set('X-Observogram-Org', orgId);   // echo so the client always knows the active org
  return runWithOrg(orgId, next);
});

app.use(express.json({ limit: '16mb' }));   // /api/crawl can carry a whole repo's worth of YAML
app.use(express.text({ type: ['application/x-yaml', 'text/yaml', 'text/plain'], limit: '4mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));   // /auth/login form

// Identity routes (/auth/*) — inert in local mode; throws fail-closed at
// boot when OIDC is configured incompletely. See server/auth.mjs.
initAuth(app);

// Express's PayloadTooLargeError is thrown by the body parsers BEFORE
// any of our handlers run, and the default error path returns HTML.
// /api/* always wants JSON so the client can show a clean error and
// hint the user toward client-side filtering instead of dumping a stack
// trace into the dropzone.
app.use((err, req, res, next) => {
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

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    ...versionInfo(),   // version, build, node — "what exactly is running?"
    specVersion: SPEC_VERSION,
    schemaPath: `vendor/observability-pack-spec/v${SPEC_VERSION}/observability-pack.schema.json`,
  });
});

// Wipe in-memory uploaded / crawled / drafted packs. Used by the
// studio's RESET button so the user can start truly fresh — the client
// pairs this with a localStorage.clear() + reload. No body, no params.
// Returns the number of entries dropped so the client can echo it.
app.delete('/api/uploads', (req, res) => {
  const uploads = uploadsMap();
  const dropped = uploads.size;
  uploads.clear();
  clearWorkspacePacks();   // reset means reset — the disk copies go too
  res.json({ ok: true, dropped });
});

// Stage 2 tenancy: the orgs visible to this request. Sessions see their
// memberships (role recorded for Stage 3, not yet enforced); the bearer
// service account sees every org. `active` echoes the request's resolved
// org so clients never have to guess which workspace they're in.
app.get('/api/orgs', (req, res) => {
  if (!tenancyEnabled()) return res.json({ ok: true, tenancy: false, orgs: [], active: null });
  const orgs = req.observogramBearer
    ? Object.entries(readOrgs()).map(([id, o]) => ({ id, name: o?.name || id, role: 'service-account' }))
    : orgsForUser(req.observogramSub);
  res.json({ ok: true, tenancy: true, orgs, active: currentOrg() });
});

app.get('/api/packs', (req, res) => {
  // Catalog + in-memory uploads. Uploaded packs lead the list so the
  // picker surfaces them at the top — they're the user's just-created
  // work and most likely what they want to interact with next.
  const uploads = [...uploadsMap().keys()].map(id => catalogEntryForUpload(id)).filter(Boolean);
  res.json({ packs: [...uploads, ...PACK_CATALOG.map(catalogEntry)] });
});

function catalogEntryForUpload(id) {
  const meta = uploadedMeta(id);
  if (!meta) return null;
  const c = meta.canonical;
  const svc = serviceMetadata(c);
  return {
    id,
    label: meta.label,
    description: meta.description,
    name: c?.metadata?.name,
    version: c?.metadata?.version,
    binding: c?.metadata?.binding,
    criticality: c?.metadata?.bindings?.criticality,
    service: svc.service,
    namespace: svc.namespace,
    services: svc.services,
    environments: listEnvironments(c),
    source: 'uploaded',
    ok: true,
  };
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
app.get('/api/examples', (req, res) => {
  res.json({ examples: EXAMPLE_PACKS.map(catalogEntry) });
});

// Catalogue reference packs — the curated best-practice packs surfaced in
// the studio's Advanced → References view (reference component analysis).
// Kept separate from /api/examples so they no longer appear in the
// example-pack list, only under References.
app.get('/api/references', (req, res) => {
  res.json({ references: REFERENCE_PACKS.map(catalogEntry) });
});

app.get('/api/packs/:id', (req, res) => {
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

app.get('/api/packs/:id/canonical', (req, res) => {
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

app.get('/api/packs/:id/conformance', (req, res) => {
  const meta = findPackMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackCanonical(meta);
    const env = readEnv(req.query);
    const { canonical: overlaid } = overlaidCanonical(canonical, env);
    const report = evaluateConformance(overlaid);
    res.json({ environment: env, ...report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/diff', (req, res) => {
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

app.get('/api/compile/targets', (req, res) => {
  res.json({ targets: listTargets() });
});

// ----------------------------------------------------------------
// /api/packs/:id/compile-catalog — enumerate every individually
// compilable artifact in this pack. The studio renders this as a
// left-nav tree; each leaf is then compiled via /api/packs/:id/
// compile-artifact?group=&flavor=&artifact= below.
// ----------------------------------------------------------------
app.get('/api/packs/:id/compile-catalog', (req, res) => {
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
app.get('/api/packs/:id/compile-artifact', (req, res) => {
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
// compile group × flavor) under artefacts/. Hand-rolled ZIP, no zip dep.
app.get('/api/packs/:id/export.zip', (req, res) => {
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
app.use(deployRoutes({ findPackMeta, loadPackCanonical, overlaidCanonical, readEnv, actorForRequest, contentHash }));

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
app.post('/api/packs/:id/retrofeed', (req, res) => {
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

app.get('/api/journeys', (req, res) => {
  try {
    const journeys = listJourneys().map(name => {
      let def = null;
      try { def = loadJourneyDef(name); } catch (_) {}
      const lastRun = readJourneyRuns(name, { limit: 1 })[0] || null;
      return {
        name,
        packA: def?.packA?.crawl ? `crawl: ${def.packA.crawl.path}` : (def?.packA?.file || null),
        packB: def?.packB?.mcp ? `mcp: ${def.packB.mcp.url}` : (def?.packB?.file || null),
        gate: def?.gate || {},
        scope: { env: def?.env || null, service: def?.service || null, scopeMode: def?.scopeMode || null },
        lastRun: lastRun && {
          startedAt: lastRun.startedAt,
          outcome: lastRun.outcome,
          alignmentPct: lastRun.drift?.alignmentPct ?? null,
          gradeScore: lastRun.grade?.score ?? null,
          breaches: lastRun.gate?.breaches?.length ?? 0,
        },
      };
    });
    res.json({ journeys });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/journeys/:name/runs — run history newest first (the
// drift-over-time series behind the panel's trend sparkline).
app.get('/api/journeys/:name/runs', (req, res) => {
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 30));
  try {
    res.json({ runs: readJourneyRuns(req.params.name, { limit }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/journeys/:name/run — execute now. HTTP 200 even when the gate
// fails: the run succeeded, the outcome is data. 404 for unknown names,
// 502 when a pack source can't be resolved (live MCP down etc.).
app.post('/api/journeys/:name/run', async (req, res) => {
  let def;
  try { def = loadJourneyDef(req.params.name); }
  catch (e) { return res.status(404).json({ ok: false, error: e.message }); }
  try {
    const record = await runJourney(def);
    res.json({ ok: true, record });
  } catch (e) {
    res.status(502).json({ ok: false, error: redactCredentials(String(e.message)) });
  }
});

// POST /api/journeys/capture — "save this comparison as a journey". The
// server resolves the session's pack ids to durable sources: file-backed
// packs keep their path; uploaded/crawled/drafted packs point at their
// persisted workspace copy (10A); a Pack B that came from a live MCP draft
// is saved as a live mcp: source via its mcp.url annotation, so re-runs
// re-draft instead of comparing against a frozen snapshot.
app.post('/api/journeys/capture', (req, res) => {
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
  let bAnn = {};
  try { bAnn = loadPackCanonical(metaB)?.metadata?.annotations || {}; } catch (_) {}
  if (bAnn['mcp.url']) {
    packB = { mcp: { url: bAnn['mcp.url'] } };
  } else {
    packB = sourceFor(metaB);
  }

  const def = {
    packA, packB,
    ...(b.env ? { env: String(b.env) } : {}),
    ...(b.service ? { service: String(b.service) } : {}),
    ...(b.scopeMode ? { scopeMode: String(b.scopeMode) } : {}),
    gate: (b.gate && typeof b.gate === 'object') ? b.gate : { minAlignmentPct: 85 },
  };
  try {
    const saved = saveJourneyDef(name, def, {
      banner: [
        `Captured from a studio session on ${new Date().toISOString()}.`,
        `Pack A: ${metaA.label || metaA.id} · Pack B: ${metaB.label || metaB.id}`,
        `Edit freely — e.g. swap a frozen pack file for a crawl: source,`,
        `or add authEnv under packB.mcp for authenticated MCPs.`,
      ],
    });
    res.json({ ok: true, name: saved.name });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/packs/:id/compile/:target', (req, res) => {
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

app.get('/api/maturity-rubric', (req, res) => {
  res.json({
    specVersion: SPEC_VERSION,
    docs: `vendor/observability-pack-spec/v${SPEC_VERSION}/docs/maturity-model.md`,
    clauses: RUBRIC.map(({ evaluate, ...rest }) => rest),
  });
});

// ---------- live MCP refresh ----------
//
// The cron-driven workflow (.github/workflows/refresh-live-pack.yml) is the
// production path. This in-browser endpoint exists so a dev session can
// kick off an ad-hoc refresh from a local MCP without spawning a process.

// Local live refreshes write this ignored runtime file. It is deliberately not
// a committed example; the live-status badge reports absent until a refresh
// creates it in the working tree.
const LIVE_PACK_PATH = 'examples/production-live.pack.yaml';

app.get('/api/live-status', (req, res) => {
  try {
    const abs = resolve(ROOT, LIVE_PACK_PATH);
    if (!existsSync(abs)) return res.json({ present: false });
    const c = parseYaml(readFileSync(abs, 'utf8'));
    const a = c.metadata?.annotations || {};
    res.json({
      present: true,
      refreshedAt:        a['mcp.refreshedAt']        || null,
      url:                a['mcp.url']                || null,
      toolsCalled:        a['mcp.toolsCalled']        || '',
      toolsFailed:        a['mcp.toolsFailed']        || '',
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
// instead of a repo file map. Builds a canonical v1.2 pack from what
// the MCP can attest to (system_health, system_topology, baselines,
// active anomalies) and returns it for review WITHOUT writing it to
// disk. The studio shows the preview + summary; "use this pack"
// round-trips it through /api/validate just like the crawler flow.
//
// Body: { mcpUrl, mcpAuth?, packName? }
// Response: { ok, canonical, canonicalYaml, summary, validation,
//             conformance, annotations, tookMs }
// ----------------------------------------------------------------
app.post('/api/draft-from-mcp', async (req, res) => {
  const body = req.body || {};
  const mcpUrl  = typeof body.mcpUrl  === 'string' && body.mcpUrl.trim() ? body.mcpUrl.trim() : null;
  const mcpAuth = typeof body.mcpAuth === 'string' && body.mcpAuth ? body.mcpAuth : null;
  const packName = typeof body.packName === 'string' && body.packName.trim()
    ? body.packName.trim()
    : null;
  if (!mcpUrl) return res.status(400).json({ ok: false, error: 'mcpUrl required in JSON body' });
  const { error: mcpUrlError, safeUrl: safeMcpUrl } = validateMcpUrl(mcpUrl);
  if (mcpUrlError) return res.status(400).json({ ok: false, error: mcpUrlError });

  const t0 = Date.now();
  try {
    process.stderr.write(`[draft-from-mcp] POST -> ${safeMcpUrl}\n`);
    const fetched = await fetchMcp({ mcpUrl, mcpAuth });
    const refreshedAt = new Date().toISOString();
    const pack = buildCanonicalPack({ refreshedAt, mcpUrl, packName, ...fetched });
    const errors = validateCanonical(pack, SCHEMA);

    // Build a discovery summary in the same shape the crawler returns,
    // so the client can render BOTH path A and path B drafts with the
    // same review component.
    const ann = pack.metadata?.annotations || {};
    const probesAttempted = (ann['mcp.probesAttempted'] || '').split(',').filter(Boolean);
    const probesSucceeded = (ann['mcp.probesSucceeded'] || '').split(',').filter(Boolean);
    const probesEmpty     = (ann['mcp.probesEmpty']     || '').split(',').filter(Boolean);
    const probesFailed    = (ann['mcp.probesFailed']    || '').split(',').filter(Boolean);

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
      mcpUrl,
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
        metricNamesCount: Number(ann['mcp.discovered.metric_names_count'] || 0),
        // tools/list inventory — what the MCP advertised vs what we matched
        toolsExposed:    (ann['mcp.toolsExposed']    || '').split(',').filter(Boolean),
        toolsUnmatched:  (ann['mcp.toolsUnmatched']  || '').split(',').filter(Boolean),
        probesAttempted, probesSucceeded, probesEmpty, probesFailed,
      },
      // Full backend_capabilities inventory — the version-gating contract.
      // When null, the MCP didn't expose backend_capabilities (older
      // server). When set, the studio renders the full skill → backend →
      // product → version matrix on connect.
      capabilities,
      warnings: [],
      tier: pack.metadata?.bindings?.criticality || 'tier-3',
    };

    // Warnings — only flag a gap when we ASKED and got nothing, never
    // when we never asked. The MCP probe table is the contract for
    // "what we tried."
    if ((summary.discovered.toolsFailed || []).length) {
      summary.warnings.push(`MCP tools that failed: ${summary.discovered.toolsFailed.join(', ')}`);
    }
    const attemptedNothing = (k) => probesAttempted.includes(k) && !probesSucceeded.includes(k);
    if (attemptedNothing('recording_rules')) {
      summary.warnings.push('Recording-rule probes returned empty. The SLI/SLO sections were synthesised from system_health — if your platform has Prometheus/Mimir rules, the MCP isn\'t exposing them yet.');
    }
    if (attemptedNothing('alert_rules')) {
      summary.warnings.push('Alert-rule probes returned empty. Burn-rate alerts are synthesized from SLOs; existing fired alerts couldn\'t be surfaced.');
    }
    if (attemptedNothing('dashboards')) {
      summary.warnings.push('Dashboard probes returned empty. The dashboards section is a stub — point the MCP at Grafana\'s /api/search to populate it.');
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
    // Register only if validation passes; bad packs aren't addressable.
    // Prefer the caller-supplied label (the quick-start cases pass
    // something friendlier than the auto-generated metadata name).
    const friendlyLabel = (typeof body.label === 'string' && body.label.trim())
      ? body.label.trim()
      : `${pack.metadata?.name || 'mcp-draft'} (live MCP draft)`;
    const registered = errors.length === 0
      ? { id: registerUploadedPack(pack, friendlyLabel, friendlyLabel) }
      : null;
    process.stderr.write(`[draft-from-mcp]   ok in ${Date.now() - t0}ms; ` +
      `valid=${errors.length === 0}; ` +
      `services=${summary.discovered.backends}; ` +
      `registered=${registered?.id || '-'}; ` +
      `failed=${summary.discovered.toolsFailed.join(',') || 'none'}\n`);

    res.json({
      ok: true,
      canonical: pack,
      canonicalYaml,
      summary,
      annotations: ann,
      validation: { ok: errors.length === 0, errors },
      conformance,
      registered,
      tookMs: Date.now() - t0,
    });
  } catch (e) {
    process.stderr.write(`[draft-from-mcp]   error in ${Date.now() - t0}ms: ${redactCredentials(e.message)}\n`);
    res.status(502).json({ ok: false, error: e.message, tookMs: Date.now() - t0 });
  }
});

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

app.post('/api/refresh-live', async (req, res) => {
  const body = req.body || {};
  const mcpUrl = typeof body.mcpUrl === 'string' && body.mcpUrl.trim() ? body.mcpUrl.trim() : null;
  const mcpAuth = typeof body.mcpAuth === 'string' && body.mcpAuth ? body.mcpAuth : null;
  if (!mcpUrl) return res.status(400).json({ ok: false, error: 'mcpUrl required in JSON body' });
  const { error: mcpUrlError, safeUrl: safeMcpUrl } = validateMcpUrl(mcpUrl);
  if (mcpUrlError) return res.status(400).json({ ok: false, error: mcpUrlError });

  const t0 = Date.now();
  try {
    process.stderr.write(`[refresh-live] POST /api/refresh-live -> ${safeMcpUrl}\n`);
    const fetched = await fetchMcp({ mcpUrl, mcpAuth });
    const refreshedAt = new Date().toISOString();
    const pack = buildCanonicalPack({ refreshedAt, mcpUrl, ...fetched });
    const errors = validateCanonical(pack, SCHEMA);
    if (errors.length) {
      return res.status(500).json({ ok: false, error: 'built pack failed schema validation', details: errors });
    }
    const abs = resolve(ROOT, LIVE_PACK_PATH);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, emitYaml(pack));
    process.stderr.write(`[refresh-live]   ok in ${Date.now() - t0}ms; ` +
      `services=${pack.metadata.annotations['mcp.servicesDiscovered'] || '(none)'} ` +
      `failed=${pack.metadata.annotations['mcp.toolsFailed'] || 'none'}\n`);
    res.json({
      ok: true,
      refreshedAt,
      pack: adapt(pack),
      annotations: pack.metadata.annotations,
    });
  } catch (e) {
    process.stderr.write(`[refresh-live]   error in ${Date.now() - t0}ms: ${redactCredentials(e.message)}\n`);
    res.status(502).json({ ok: false, error: e.message, details: e.details });
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
app.post('/api/crawl', (req, res) => {
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
      ? { id: registerUploadedPack(canonical, friendlyLabel, friendlyLabel) }
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

app.post('/api/crawl-github', async (req, res) => {
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

    // 5. Run the SAME crawler the upload path uses.
    // Default the repoName to a Slug-pattern-compliant variant of the
    // repo path (owner-repo, lowercase, slashes → hyphens, dots
    // collapsed) so the canonical pack's metadata.name validates against
    // the spec's `^[a-z][a-z0-9_-]*[a-z0-9]$` pattern.
    const defaultRepoName = `${owner}-${repo}`
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
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
      ? { id: registerUploadedPack(canonical, friendlyLabel, friendlyLabel) }
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

app.post('/api/validate', (req, res) => {
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
    const id = registerUploadedPack(canonical, sourceHint || canonical.metadata?.name || 'upload');
    res.json({ ok: true, adapted, conformance, registered: { id, source: sourceHint || null }, ...(legacyReport ? { legacy: legacyReport } : {}) });
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

app.use(express.static(STUDIO_DIR, { extensions: ['html'], index: 'index.html' }));

// SPA-style fallback: any unknown GET returns the studio shell so the client
// can route. The /api/* paths above already handled JSON requests.
app.get(/^(?!\/api\/).*/, (req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(resolve(STUDIO_DIR, 'index.html'));
});

// ---------- entrypoint ----------

const PORT = Number(process.env.PORT || 8000);
// Loopback by default — matching the documented contract. Exposing the
// studio (HOST=0.0.0.0) requires OBSERVOGRAM_API_TOKEN; see start().
const HOST = process.env.HOST || '127.0.0.1';

export { app };
// Rehydrate the upload registry from the workspace (.observogram/). Runs
// once per process, inside start() (not at module load) so tests can point
// OBSERVOGRAM_WORKSPACE at a temp dir before booting. Entries arrive oldest
// lastUsedAt first, preserving the map's LRU insertion order.
let workspaceRehydrated = false;
function rehydrateUploadsFromWorkspace(silent) {
  if (workspaceRehydrated) return;
  workspaceRehydrated = true;
  let restored = 0;
  try {
    for (const p of loadWorkspacePacks()) {
      if (uploadsMap().has(p.id)) continue;
      uploadsMap().set(p.id, { canonical: p.canonical, source: p.source, label: p.label, createdAt: p.createdAt });
      restored++;
    }
  } catch (e) {
    process.stderr.write(`[workspace] rehydrate failed: ${e.message}\n`);
  }
  if (restored && !silent) process.stdout.write(`[studio] restored ${restored} pack${restored === 1 ? '' : 's'} from workspace\n`);
}

function isLoopbackHost(h) {
  const host = String(h || '').toLowerCase();
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

export function start({ port = PORT, host = HOST, silent = false } = {}) {
  // Grafana-style first boot: nothing configured → seed admin/admin,
  // change asked at every sign-in until it lands (skippable per
  // session). Backs off from any expressed intent
  // (OIDC, users file, API token, tenancy, OBSERVOGRAM_AUTH=off) — see
  // maybeSeedDefaultAdmin in server/auth.mjs.
  maybeSeedDefaultAdmin({
    log: (m) => { if (!silent) process.stdout.write(m + '\n'); },
    wouldExpose: !isLoopbackHost(host),
  });
  // Fail closed (10B): binding beyond loopback with no auth at all would
  // expose every write route — crawl, draft, deploy — to the network.
  // Identity (OIDC or stand-alone users) satisfies the requirement just
  // like the API token does.
  if (!isLoopbackHost(host) && !apiToken() && !authEnabled()) {
    if (brandEnv('INSECURE_NO_AUTH') === '1') {
      process.stderr.write(
        `[studio] WARNING: bound to ${host} with NO auth (OBSERVOGRAM_INSECURE_NO_AUTH=1). ` +
        `Every write route is open to the network. Do not run this posture outside a trusted network.\n`);
    } else {
      return Promise.reject(new Error(
        `refusing to bind to ${host} without auth: mutating /api routes would be open to the network.\n` +
        `  Set OBSERVOGRAM_API_TOKEN=<secret> (clients send Authorization: Bearer <secret>),\n` +
        `  or seed a sign-in with OBSERVOGRAM_ADMIN_PASSWORD=<secret> (user 'admin'),\n` +
        `  or bind to loopback (HOST=127.0.0.1), or set OBSERVOGRAM_INSECURE_NO_AUTH=1 to override knowingly.`));
    }
  }
  // The seeded default credential is loopback-only, without exception:
  // admin/admin reachable from the network is how Grafana instances end
  // up on Shodan. Completing the password change clears this — skipping
  // it does not (the guard stays armed until a real password lands).
  if (!isLoopbackHost(host) && defaultAdminCredentialActive()) {
    return Promise.reject(new Error(
      `refusing to bind to ${host} while the seeded default admin password is unchanged.\n` +
      `  Sign in once on loopback (admin / admin) to set a real password,\n` +
      `  or seed a fresh workspace with OBSERVOGRAM_ADMIN_PASSWORD=<secret>.`));
  }
  // Tenancy (Stage 2) sits ON TOP of identity: orgs.json without a way
  // to know who the user is cannot enforce membership — fail closed with
  // the fix in the message, same posture as incomplete OIDC config.
  if (tenancyEnabled() && !authEnabled()) {
    return Promise.reject(new Error(
      'orgs.json found but no identity is configured: tenancy needs to know who the user is.\n' +
      '  Configure OIDC (OBSERVOGRAM_OIDC_*) or stand-alone users (users.json / npm run users),\n' +
      '  or remove orgs.json to run the flat single-tenant workspace.'));
  }
  // One-shot, idempotent: a deployment whose flat workspace predates
  // tenancy gets its state moved to orgs/default/ when orgs.json appears.
  migrateFlatWorkspace({ log: (m) => { if (!silent) process.stdout.write(m + '\n'); } });
  // Journeys/runs live in the engine (tools/lib/journey.mjs) — wire its
  // root through the same context-aware resolver the registry uses.
  setWorkspaceRootResolver(orgWorkspaceRoot);
  rehydrateUploadsFromWorkspace(silent);
  return new Promise((resolveListen, reject) => {
    const srv = app.listen(port, host, () => {
      // When bind fails the listening callback can still fire with the
      // address being null (race between EADDRINUSE and 'listening').
      // Bail here so the error handler below resolves the promise; the
      // call site will format a friendly message.
      const addr = srv.address();
      if (!addr) return;
      if (!silent) process.stdout.write(`[studio] listening on http://${addr.address}:${addr.port}\n`);
      resolveListen(srv);
    });
    srv.on('error', reject);
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
