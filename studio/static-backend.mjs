// studio/static-backend.mjs — the backend of the static studio bundle, in the
// browser (tools/build-studio-bundle.mjs; docs/DOWNSTREAM.md, "Embedding the
// studio").
//
// A downstream that serves the studio from its own static host has no
// Observogram server behind the page. This module answers the READ-ONLY pack
// routes the studio calls — the catalogue, the layered pack, the canonical
// manifest, conformance, the compile catalogue and every compiled artefact,
// the export ZIP — from the same tools/lib engines the server uses
// (server/index.mjs is the reference: each port names the handler it
// mirrors), over the packs the bundle carries. Everything the server alone
// can do (uploads, scans, live MCP drafts, Compare, Deploy, Journeys, Build,
// sign-in) answers 501 with `denied: 'no-backend'` and a sentence that names
// the feature — studio/api.mjs shows a `denied` body verbatim — and a
// fixed notice at the bottom of the window says so once.
//
// Imported by NOTHING in the live studio: the bundle alone instantiates it,
// before studio/app.mjs boots. The live Express server serves this file
// publicly like every studio file (express.static), inert. The tools/lib
// imports are static and relative so the module links headlessly under Node
// (the parity suite, tools/test-studio-bundle.mjs) and resolves in the
// bundle's import map; the live studio keeps its `import('/lib/…')` idiom.
//
// Compare (GET /api/diff) is deliberately NOT answered: the server's answer
// carries comparePackBranches (tools/lib/traceability-graph.mjs), whose
// PromQL parser is the bare node dependency @prometheus-io/lezer-promql; a
// diff without the graph would grade differently from the server for the
// same two packs, and a different verdict is worse than none.
//
// The baked taxonomy (`config.taxonomy`, written by --taxonomy) is served at
// GET /api/taxonomy in the server's shape (server/taxonomy.mjs
// taxonomyAnswer); the studio's boot() binds it exactly as it binds a
// server's. The product name in the notices comes from the shell's
// #brand-config (written by --brand, the script studio/brand.mjs reads for
// the header), the default being DEFAULT_BRAND.name — so this file spells
// the product nowhere and the chrome and the notices agree by construction.
//
// Guards this file is written against (server/test-authz.mjs scans every
// studio module): it never spells a fetch call — the page's fetch is
// captured once as `upstream` — and no statement holds an '/api/' literal
// next to a navigation sink.

import { adapt, listEnvironments, applyEnvironmentOverlay } from '../tools/lib/adapter.mjs';
import { serviceMetadata } from '../tools/lib/service-keys.mjs';
import { validateCanonical, SPEC_VERSION, SPEC_DIR, SPEC_SCHEMA_PATH } from '../tools/lib/validator.mjs';
import { evaluateConformance, RUBRIC } from '../tools/lib/conformance.mjs';
import { packConformance } from '../tools/lib/pack-conformance.mjs';
import { compile, listTargets, compileCatalog, compileArtifact } from '../tools/lib/compile.mjs';
import { makeZip } from '../tools/lib/zip.mjs';
import { parse as parseYaml, emit as emitYaml } from '../tools/lib/mini-yaml.mjs';
import { hasLibraryTodos, todosFromAnnotations, validationSummary } from '../tools/lib/library.mjs';
import { focusedPackId, focusedEnv } from './focus.mjs';
import { normalizeBrand, DEFAULT_BRAND } from '../tools/lib/brand.mjs';
import { readBrandConfig } from './brand.mjs';

export const DENIED = 'no-backend';
export const NOTICE_CLASS = 'no-backend-notice';
export const DISMISS_KEY = 'studioNoBackendDismissed';
const JSON_CT = 'application/json; charset=utf-8';

// ---------- what the server alone can do ----------

// Path prefix → the feature the denial names (longest prefix wins). Every
// unmatched /api or /auth path is 'This action'.
export const FEATURES = [
  ['/api/refresh-live', 'Refresh from MCP'],
  ['/api/crawl', 'Scan a repo'],                      // and /api/crawl-github
  ['/api/draft-from-mcp', 'Draft from a live MCP server'],
  ['/api/mcp/ping', 'Testing an MCP connection'],     // the live MCP API (rebadge batch 3); not a prefix of /api/mcp-endpoints
  ['/api/validate', 'Uploading a pack'],
  ['/api/uploads', 'Uploading a pack'],
  ['/api/diff', 'Compare'],
  ['/api/deploy', 'Deploy'],                          // /api/deploy/* and /api/deploys*
  ['/api/journeys', 'Journeys'],
  ['/api/library', 'Build'],
  ['/api/admin', 'Administration'],
  ['/api/waivers', 'Waivers'],                        // /api/waivers/:id/revoke
  ['/api/services', 'Services'],                      // the services table (STORE_PLAN slice 6a): a bundle has no records
  ['/api/orgs', 'Organisations'],                     // the active org's name and effective role (slice 6a)
  ['/api/org', 'Settings'],                           // members and the org's name (slice 6b); '/api/orgs' stays longer
  ['/api/environments', 'Settings'],                  // an environment's own record (slice 6b)
  ['/api/mcp-endpoints', 'Settings'],                 // the org's MCP endpoints (slice 6b)
  ['/api/audit', 'Settings'],                         // the audit rows (slice 6b)
  ['/auth/', 'Sign-in'],
];
// The waivers live on a service record (GAP batch 2, B3.2): a bundled pack
// has none, so `GET`/`POST /api/services/:id/waivers` is the server's alone
// — matched before the prefixes so it keeps its own name under the
// '/api/services' prefix (follow-up `B3.2-bundle-waivers` for a baked sidecar).
const SERVICE_WAIVERS = /^\/api\/services\/[^/]+\/waivers(?:[/?]|$)/;
// The per-pack sub-routes the server alone answers — `verdicts` for its
// writes (PUT / DELETE; the GET is answered below with the empty document)
// and `audit-report` (GAP batch 2, B3.5: its goes-blind section is the blast
// radius over the traceability graph, whose PromQL parser the bundle cannot
// inline — the Compare blocker; `placeholders` IS answered below).
const PACK_FEATURES = { retrofeed: 'Compare', 'deploy-bulk': 'Deploy', verdicts: 'Verdicts', 'audit-report': 'Audit report' };

export function featureOf(pathname) {
  const sub = /^\/api\/packs\/[^/]+\/([^/?]+)/.exec(pathname)?.[1];
  if (sub && PACK_FEATURES[sub]) return PACK_FEATURES[sub];
  if (SERVICE_WAIVERS.test(pathname)) return 'Waivers';
  let best = null;
  for (const [prefix, name] of FEATURES) {
    if (pathname.startsWith(prefix) && (!best || prefix.length > best[0].length)) best = [prefix, name];
  }
  return best ? best[1] : 'This action';
}

// The three texts that name the product take it as `product`, defaulting to
// the upstream name: an unbranded bundle reads today's strings character
// for character, a --brand bundle names its own product.
export function denialText(feature, product = DEFAULT_BRAND.name) {
  return `${feature} needs the ${product} server; this studio is a static bundle built without one.`;
}

// The sentence the notice shows. `n` is the number of packs built in.
export function noticeText(n, product = DEFAULT_BRAND.name) {
  const packs = n === 1 ? '1 pack' : `${n} packs`;
  return `Static studio — no ${product} server behind this page. Discover, Diagnose, Compile and conformance read the ${packs} built in; Scan a repo, Draft from MCP, Compare, Deploy, Journeys, Build and sign-in need the server.`;
}

// The Advanced menu's API item sub text (disableApiMenuItem).
export function apiMenuSubText(product = DEFAULT_BRAND.name) {
  return `needs the ${product} server · this studio is a static bundle`;
}

// ---------- ports of server/index.mjs ----------

// server/pack-registry.mjs slugify — copied, not imported: the registry is
// server code (the store sits behind it) and the export ZIP's file name must be
// the one the server gives (GET /api/packs/:id/export.zip).
function slugify(s) {
  return String(s || 'pack')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'pack';
}

// server/index.mjs readEnv: a string, non-empty; a repeated ?env= is none.
function readEnv(params) {
  const all = params.getAll('env');
  return all.length === 1 && all[0] ? all[0] : null;
}

// server/index.mjs overlaidCanonical.
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

// server/verdict-admin.mjs artefactIndex's walk — the layers and the L4
// subgroups of the studio board (studio/constants.mjs), inlined there and
// here so neither the server nor the bundle reads the other; tools/test-
// verdict-admin.mjs holds the two to the same count over payment-service.
const LAYER_WALK = ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV'];
const L4_WALK = ['policy', 'alerting', 'healing'];
function artefactCount(adapted) {
  const layers = adapted?.layers || {};
  let n = 0;
  for (const id of LAYER_WALK) {
    if (id === 'L4') for (const sub of L4_WALK) n += (layers.L4?.[sub] || []).length;
    else n += (layers[id] || []).length;
  }
  return n;
}

// server/index.mjs librarySummaryFor: validationSummary over the todos a
// library-built pack's own annotations carry; null for any other pack.
function librarySummaryFor(canonical) {
  if (!hasLibraryTodos(canonical)) return null;
  try { return validationSummary(canonical, todosFromAnnotations(canonical)); }
  catch { return null; }
}

// server/index.mjs catalogEntry: the field set of GET /api/packs.
function catalogEntry(meta, canonical) {
  const svc = serviceMetadata(canonical);
  return {
    id: meta.id,
    label: meta.label,
    description: meta.description,
    name: canonical.metadata?.name,
    version: canonical.metadata?.version,
    binding: canonical.metadata?.binding,
    criticality: canonical.metadata?.bindings?.criticality,
    service: svc.service,
    namespace: svc.namespace,
    services: svc.services,
    environments: listEnvironments(canonical),
    ok: true,
  };
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': JSON_CT, ...headers } });
const unknownPack = (id, shape = {}) => json(404, { ...shape, error: `unknown pack: ${id}` });

// The pack text a --pack-url answers, read as server/index.mjs loadPackFile
// reads a file: .json is JSON, anything else YAML.
function parsePackText(text, url) {
  return /\.json$/i.test(new URL(url).pathname) ? JSON.parse(text) : parseYaml(text);
}

// ---------- the backend ----------

// config: { version, schema, packs: [{ id, label, description?, canonical } | { id, label, description?, url }], taxonomy? }
// fetchImpl: the page's own fetch, for the pack URLs (never for the routes).
// origin: the page's origin; an absolute request to another origin is not ours.
// product: the name the denials spell (installStaticBackend reads it from #brand-config).
export function createStaticBackend(config, { fetchImpl, origin = 'http://static-studio.invalid', product = DEFAULT_BRAND.name } = {}) {
  const schema = config?.schema;
  const version = typeof config?.version === 'string' ? config.version : '0.0.0';
  const declared = Array.isArray(config?.packs) ? config.packs : [];
  // The taxonomy override --taxonomy baked (a plain object), else none. The
  // shim serves it; the studio's boot() compiles and binds it from GET
  // /api/taxonomy exactly as against a server (studio/app.mjs
  // bindTaxonomyFromServer) — the import map gives both the one classifier.
  const taxonomy = config && typeof config.taxonomy === 'object' && config.taxonomy !== null && !Array.isArray(config.taxonomy) ? config.taxonomy : null;
  const upstream = fetchImpl;

  // Every pack, resolved once: { meta, canonical } or { meta, error }. A URL
  // pack is read through the page's fetch on the first catalogue call; one
  // that fails is a catalogue entry with ok:false (server/index.mjs
  // catalogEntry's catch), never a failed boot.
  let resolved = null;
  async function loadOne(meta) {
    if (meta.canonical) return { meta, canonical: meta.canonical };
    if (!meta.url) return { meta, error: new Error(`pack ${meta.id} has neither canonical nor url`) };
    if (typeof upstream !== 'function') return { meta, error: new Error(`pack ${meta.id}: no fetch to read ${meta.url} with`) };
    try {
      const r = await upstream(meta.url, { headers: { Accept: 'application/x-yaml, application/json, text/plain' } });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText || ''} fetching ${meta.url}`.replace(/\s+/g, ' '));
      return { meta, canonical: parsePackText(await r.text(), meta.url) };
    } catch (e) {
      return { meta, error: e instanceof Error ? e : new Error(String(e)) };
    }
  }
  const packs = () => resolved || (resolved = Promise.all(declared.map(loadOne)));
  async function findPack(id) {
    return (await packs()).find((p) => p.meta.id === id) || null;
  }
  async function catalog() {
    return {
      packs: (await packs()).map((p) => (p.error
        ? { id: p.meta.id, label: p.meta.label, ok: false, error: p.error.message }
        : catalogEntry(p.meta, p.canonical))),
    };
  }

  // A pack for a per-pack route: { canonical, meta } or a Response (404/500).
  async function packFor(id, notFoundShape) {
    const p = await findPack(id);
    if (!p) return unknownPack(id, notFoundShape);
    if (p.error) return json(500, { ...notFoundShape, error: p.error.message });
    return p;
  }

  // ---- the routes, each a port of the server handler it names ----

  const routes = {
    // GET /api/version — server/build-info.mjs's shape, the fields
    // studio/build-label.mjs reads; no git behind a static file.
    '/api/version': () => json(200, {
      ok: true, version, build: null, commit: null, branch: null, dirty: false, date: null, source: 'package',
      label: `v${version} · static bundle`,
    }, { 'Cache-Control': 'no-store' }),
    // GET /healthz — server/index.mjs: version, build, node, specVersion, schemaPath.
    '/healthz': () => json(200, { ok: true, version, build: null, node: null, specVersion: SPEC_VERSION, schemaPath: SPEC_SCHEMA_PATH }),
    // GET /auth/me — server/auth.mjs: no identity configured. The studio
    // reads a !ok answer as the open posture (no sign-in).
    '/auth/me': () => json(404, { ok: false, error: 'identity not configured' }),
    '/api/packs': async () => json(200, await catalog()),
    '/api/examples': () => json(200, { examples: [] }),
    '/api/references': () => json(200, { references: [] }),
    '/api/live-status': () => json(200, { present: false }),
    // GET /api/taxonomy — server/taxonomy.mjs taxonomyAnswer(): the baked
    // document or none, `configured` saying which; no-store like the server.
    '/api/taxonomy': () => json(200, { ok: true, taxonomy, configured: taxonomy !== null }, { 'Cache-Control': 'no-store' }),
    '/api/compile/targets': () => json(200, { targets: listTargets() }),
    '/api/maturity-rubric': () => json(200, {
      specVersion: SPEC_VERSION,
      docs: `${SPEC_DIR}/docs/maturity-model.md`,
      clauses: RUBRIC.map(({ evaluate: _evaluate, ...rest }) => rest),
    }),
  };

  // GET /api/packs/:id — validate, then adapt for the env.
  async function layered(id, params) {
    const p = await packFor(id);
    if (p instanceof Response) return p;
    try {
      const env = readEnv(params);
      const errors = validateCanonical(p.canonical, schema);
      if (errors.length) return json(500, { error: 'pack failed schema validation', details: errors });
      return json(200, adapt(p.canonical, { environment: env }));
    } catch (e) {
      return json(500, { error: e.message });
    }
  }

  // GET /api/packs/:id/canonical[?format=yaml]
  async function canonical(id, params) {
    const p = await packFor(id);
    if (p instanceof Response) return p;
    try {
      const env = readEnv(params);
      const { canonical: overlaid, effective } = overlaidCanonical(p.canonical, env);
      const format = params.get('format');
      if (format === 'yaml' || format === 'yml') {
        return new Response(emitYaml(overlaid), { status: 200, headers: { 'Content-Type': 'application/x-yaml; charset=utf-8' } });
      }
      return json(200, { ...overlaid, __effectiveEnvironment: env, __effective: effective });
    } catch (e) {
      return json(500, { error: e.message });
    }
  }

  // GET /api/packs/:id/conformance — onPlaceholder only when the pack can say.
  async function conformance(id, params) {
    const p = await packFor(id);
    if (p instanceof Response) return p;
    try {
      const env = readEnv(params);
      const { canonical: overlaid } = overlaidCanonical(p.canonical, env);
      const report = evaluateConformance(overlaid);
      const onPlaceholder = librarySummaryFor(overlaid)?.onPlaceholder;
      // A bundled pack has no service record (STORE_PLAN slice 4 §9 grades
      // an uploaded pack at its service row's tier), so the server's `tier`
      // object is the pack's own: graded === declaredTier, from 'pack', no
      // service or environment, no mismatch.
      const packTier = overlaid.metadata?.bindings?.criticality ?? 'tier-3';
      return json(200, {
        environment: env, ...report, ...(Array.isArray(onPlaceholder) ? { onPlaceholder } : {}),
        tier: { graded: report.declaredTier, pack: packTier, from: 'pack', service: null, environment: null, mismatch: false },
      });
    } catch (e) {
      return json(500, { error: e.message });
    }
  }

  // GET /api/packs/:id/verdicts — server/verdict-admin.mjs verdictsDocument
  // (GAP batch 2, B3.1): a reviewer's verdicts live in the server's store on
  // a REGISTERED pack, and a bundled pack is never registered, so the
  // server's own answer for it is the empty document — every artefact
  // unreviewed. The writes (PUT / DELETE …/verdicts/:artefact) are
  // PACK_FEATURES 'Verdicts' (501).
  async function verdicts(id) {
    const p = await packFor(id, { ok: false });
    if (p instanceof Response) return p;
    try {
      const n = artefactCount(adapt(p.canonical));
      return json(200, { ok: true, pack: p.meta.id, verdicts: [], summary: { artefacts: n, trusted: 0, suspect: 0, failed: 0, unreviewed: n, orphaned: 0 } });
    } catch (e) {
      return json(500, { ok: false, error: e.message });
    }
  }

  // GET /api/packs/:id/compile-catalog
  async function catalogOfCompile(id, params) {
    const p = await packFor(id, { ok: false });
    if (p instanceof Response) return p;
    try {
      const env = readEnv(params);
      const { canonical: overlaid } = overlaidCanonical(p.canonical, env);
      return json(200, { pack: p.meta.id, env: env || null, ...compileCatalog(overlaid) });
    } catch (e) {
      return json(500, { ok: false, error: e.message });
    }
  }

  // GET /api/packs/:id/compile-artifact?group=&flavor=&artifact=
  async function artifact(id, params) {
    const p = await packFor(id, { ok: false });
    if (p instanceof Response) return p;
    const group = String(params.get('group') || '');
    const flavor = params.get('flavor') ? String(params.get('flavor')) : undefined;
    const art = params.get('artifact') ? String(params.get('artifact')) : 'all';
    if (!group) return json(400, { ok: false, error: 'group query param required' });
    try {
      const env = readEnv(params);
      const { canonical: overlaid } = overlaidCanonical(p.canonical, env);
      const out = compileArtifact(overlaid, { group, flavor, artifact: art });
      const headers = {
        'Content-Type': `${out.contentType}; charset=utf-8`,
        'Content-Disposition': `attachment; filename="${out.filename}"`,
        'X-Pack-Source': `${p.meta.id}@${overlaid?.metadata?.version || '?'}`,
        'X-Compile-Group': group,
      };
      if (flavor) headers['X-Compile-Flavor'] = flavor;
      if (art) headers['X-Compile-Artifact'] = art;
      return new Response(out.content, { status: 200, headers });
    } catch (e) {
      return json(500, { ok: false, error: e.message });
    }
  }

  // GET /api/packs/:id/compile/:target[?download=1&dashboardId=]
  async function compileTarget(id, target, params) {
    const p = await packFor(id);
    if (p instanceof Response) return p;
    try {
      const env = readEnv(params);
      const { canonical: overlaid } = overlaidCanonical(p.canonical, env);
      const dashboardId = params.get('dashboardId');
      const out = compile(overlaid, target, { dashboardId: dashboardId || undefined });
      const disposition = params.get('download') === '1' ? 'attachment' : 'inline';
      return new Response(out.content, {
        status: 200,
        headers: {
          'Content-Type': `${out.contentType}; charset=utf-8`,
          'Content-Disposition': `${disposition}; filename="${out.filename}"`,
          'X-Pack-Source': `${p.meta.id}@${p.canonical?.metadata?.version || '?'}`,
          'X-Compile-Target': target,
        },
      });
    } catch (e) {
      return json(400, { error: e.message });
    }
  }

  // GET /api/packs/:id/export.zip — the pack.yaml and every compiled artefact.
  async function exportZip(id, params) {
    const p = await packFor(id);
    if (p instanceof Response) return p;
    try {
      const env = readEnv(params);
      const { canonical: overlaid } = overlaidCanonical(p.canonical, env);
      const name = slugify(overlaid?.metadata?.name || p.meta.id || 'pack');
      const files = [{ name: `${name}.pack.yaml`, data: emitYaml(overlaid) }];
      const cat = compileCatalog(overlaid);
      for (const g of cat.groups || []) {
        const flavors = g.flavors?.length ? g.flavors : [{ id: undefined }];
        for (const fl of flavors) {
          try {
            const out = compileArtifact(overlaid, { group: g.id, flavor: fl.id, artifact: 'all' });
            files.push({ name: `artefacts/${g.id}/${out.filename}`, data: out.content });
          } catch { /* a flavor that can't compile for this pack — skip it, as the server does */ }
        }
      }
      return new Response(makeZip(files), {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${name}.bundle.zip"`,
          'X-Pack-Source': `${p.meta.id}@${overlaid?.metadata?.version || '?'}`,
          'X-Bundle-Files': String(files.length),
        },
      });
    } catch (e) {
      return json(500, { error: e.message });
    }
  }

  // GET /api/packs/:id/placeholders — server/routes/audit-report.mjs (GAP
  // batch 2, B3.5): packConformance over the overlaid canonical, bare — the
  // rows `packc conformance` prints; the engine is zero-store, so the bundle
  // answers it in the browser.
  async function placeholders(id, params) {
    const p = await packFor(id);
    if (p instanceof Response) return p;
    try {
      const { canonical: overlaid } = overlaidCanonical(p.canonical, readEnv(params));
      return json(200, packConformance(overlaid), { 'Cache-Control': 'no-store' });
    } catch (e) {
      return json(500, { error: e.message });
    }
  }

  const deny = (pathname) => json(501, { ok: false, denied: DENIED, error: denialText(featureOf(pathname), product) });

  async function route(url, method) {
    const path = url.pathname;
    if (method !== 'GET' && method !== 'HEAD') return deny(path);
    if (routes[path]) return routes[path]();
    const m = /^\/api\/packs\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (m) {
      let id;
      try { id = decodeURIComponent(m[1]); } catch { return unknownPack(m[1]); }
      const rest = m[2];
      if (rest === undefined) return layered(id, url.searchParams);
      if (rest === 'canonical') return canonical(id, url.searchParams);
      if (rest === 'conformance') return conformance(id, url.searchParams);
      if (rest === 'verdicts') return verdicts(id);
      if (rest === 'placeholders') return placeholders(id, url.searchParams);
      if (rest === 'compile-catalog') return catalogOfCompile(id, url.searchParams);
      if (rest === 'compile-artifact') return artifact(id, url.searchParams);
      if (rest === 'export.zip') return exportZip(id, url.searchParams);
      const t = /^compile\/([^/]+)$/.exec(rest);
      if (t) return compileTarget(id, decodeURIComponent(t[1]), url.searchParams);
    }
    return deny(path);
  }

  // Is this request one of ours? A path (`/api/packs`) always is; an
  // absolute URL only on our origin. Everything else — a pack URL, a font —
  // is the page's own business and returns null.
  function requestOf(input, init) {
    let href;
    let method = init?.method;
    if (typeof input === 'string') href = input;
    else if (input instanceof URL) href = input.href;
    else if (input && typeof input.url === 'string') { href = input.url; method = method ?? input.method; }
    else return null;
    let url;
    if (href.startsWith('/') && !href.startsWith('//')) url = new URL(href, 'http://static-studio.invalid');
    else {
      try { url = new URL(href); } catch { return null; }
      if (url.origin !== origin) return null;
    }
    const p = url.pathname;
    if (!(p.startsWith('/api/') || p === '/api' || p.startsWith('/auth/') || p === '/healthz')) return null;
    return { url, method: String(method || 'GET').toUpperCase() };
  }

  function handle(input, init) {
    const req = requestOf(input, init);
    if (!req) return null;
    return route(req.url, req.method).catch((e) => json(500, { error: e.message }));
  }

  return { handle, catalog, isOurs: (input, init) => requestOf(input, init) !== null, packCount: declared.length, product, taxonomyConfigured: taxonomy !== null };
}

// ---------- the page ----------

// Installs the backend on a window: its fetch answers our routes and hands
// everything else to the page's own; the `api` link and menu item, which
// navigate to /api/packs, are disabled (a navigation never reaches a fetch
// wrapper); the Export button downloads the ZIP this backend builds; a
// download anchor on one of our routes (the Conformance view's audit-report
// anchors) is answered by this backend too — a denial shows its sentence in
// the notice row instead of a canceled download; the notice says what the
// page is.
export function installStaticBackend(config, win = globalThis.window) {
  const upstream = win.fetch.bind(win);
  const origin = win.location.origin;
  const doc = win.document;
  // The product: the #brand-config a --brand build wrote into the shell (the
  // same script studio/brand.mjs reads for the header); an unbranded shell
  // has none, a malformed one is no brand — the default name either way.
  let product = DEFAULT_BRAND.name;
  try { product = normalizeBrand(readBrandConfig(doc)).name; } catch { /* a malformed #brand-config is no brand */ }
  const backend = createStaticBackend(config, { fetchImpl: upstream, origin, product });
  win.fetch = (input, init) => backend.handle(input, init) ?? upstream(input, init);

  const whenReady = (fn) => (doc.readyState === 'loading' ? doc.addEventListener('DOMContentLoaded', fn, { once: true }) : fn());
  whenReady(() => {
    // `hidden` alone is beaten by the author `display` on .ctrl-link
    // (app.css, reskin.css): set the style too.
    const link = doc.getElementById('api-link');
    if (link) { link.hidden = true; link.style.display = 'none'; }
    disableApiMenuItem(doc, win, product);
    mountNotice(doc, win, backend.packCount, product);
  });
  // Capture phase, on the document: runs before studio/app.mjs's own
  // handlers on the buttons, and stops them.
  doc.addEventListener('click', (e) => {
    const t = e.target && typeof e.target.closest === 'function' ? e.target : null;
    if (!t) return;
    if (t.closest('#export-btn')) {
      e.stopImmediatePropagation();
      e.preventDefault();
      exportFocusedPack(backend, doc, win).catch((err) => showError(doc, `Export failed: ${err.message}`));
    } else if (t.closest('[data-action="api"]')) {
      e.stopImmediatePropagation();
      e.preventDefault();
    } else {
      const a = t.closest('a[download]');
      if (a && backend.isOurs(a.href)) {
        e.stopImmediatePropagation();
        e.preventDefault();
        downloadThroughBackend(backend, doc, win, a.href).catch((err) => showError(doc, `Download failed: ${err.message}`));
      }
    }
  }, true);
  return backend;
}

// An `<a download>` on one of our routes: the browser would fetch the href
// itself — a static host answers 404 and the download is canceled with no
// sentence — so the click is answered here. A denial (501 no-backend, 404)
// shows the body's sentence in the notice row; an answer downloads as a Blob
// named by the server's rule, as the Export button does.
async function downloadThroughBackend(backend, doc, win, href) {
  const r = await backend.handle(href);
  if (!r) throw new Error('no answer');
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    showError(doc, body?.error || `${r.status} ${r.statusText || ''}`.trim());
    return;
  }
  const filename = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || new URL(href, win.location.href).pathname.split('/').pop();
  saveBlob(doc, win, await r.blob(), filename);
}

// The Advanced menu's "Pack catalogue API" item (studio/app.mjs
// installObservaChrome mounts it after this module runs): disabled, with its
// sub text saying why. One observer, disconnected once the item is seen.
function disableApiMenuItem(doc, win, product) {
  const disable = () => {
    const item = doc.querySelector('.observa-adv-item[data-action="api"]');
    if (!item) return false;
    item.disabled = true;
    item.setAttribute('aria-disabled', 'true');
    const sub = item.querySelector('.observa-adv-item-sub');
    if (sub) sub.textContent = apiMenuSubText(product);
    return true;
  };
  if (disable()) return;
  const Observer = win.MutationObserver;
  if (!Observer) return;
  const mo = new Observer(() => { if (disable()) mo.disconnect(); });
  mo.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
}

// The Export button downloads the ZIP this backend builds, as a Blob — the
// studio's own handler navigates to /api/packs/:id/export.zip, which no
// static host answers.
async function exportFocusedPack(backend, doc, win) {
  const id = focusedPackId();
  if (!id) { showError(doc, 'Load a pack first'); return; }
  const env = focusedEnv();
  const path = `/api/packs/${encodeURIComponent(id)}/export.zip${env ? `?env=${encodeURIComponent(env)}` : ''}`;
  const r = await backend.handle(path);
  if (!r || !r.ok) throw new Error(r ? `${r.status} ${(await r.text().catch(() => '')).slice(0, 120)}` : 'no answer');
  const blob = await r.blob();
  const disposition = r.headers.get('content-disposition') || '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] || `${id}.bundle.zip`;
  saveBlob(doc, win, blob, filename);
}

// A Blob download: an object URL on a transient anchor, revoked later.
function saveBlob(doc, win, blob, filename) {
  const a = doc.createElement('a');
  const blobUrl = win.URL.createObjectURL(blob);
  a.href = blobUrl;
  a.download = filename;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  win.setTimeout(() => win.URL.revokeObjectURL(blobUrl), 60_000);
}

function readDismissed(win) {
  try { return win.localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}
function writeDismissed(win) {
  try { win.localStorage.setItem(DISMISS_KEY, '1'); } catch { /* storage unavailable */ }
}

// The notice: a status row at the bottom of the window (studio/static-backend.css).
function mountNotice(doc, win, packCount, product) {
  if (readDismissed(win) || doc.querySelector(`.${NOTICE_CLASS}`)) return;
  const el = doc.createElement('div');
  el.className = NOTICE_CLASS;
  el.setAttribute('role', 'status');
  const text = doc.createElement('span');
  text.className = `${NOTICE_CLASS}-text`;
  text.textContent = noticeText(packCount, product);
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = `${NOTICE_CLASS}-dismiss`;
  btn.textContent = 'dismiss';
  btn.setAttribute('aria-label', 'Dismiss the static-studio notice');
  btn.addEventListener('click', () => { writeDismissed(win); el.remove(); });
  el.append(text, btn);
  doc.body.appendChild(el);
}

// An error the notice row can carry (the studio's toast belongs to app.mjs).
function showError(doc, message) {
  let el = doc.querySelector(`.${NOTICE_CLASS}`);
  if (!el) {
    el = doc.createElement('div');
    el.className = NOTICE_CLASS;
    el.setAttribute('role', 'status');
    doc.body.appendChild(el);
  }
  let text = el.querySelector(`.${NOTICE_CLASS}-text`);
  if (!text) { text = doc.createElement('span'); text.className = `${NOTICE_CLASS}-text`; el.prepend(text); }
  text.textContent = message;
  el.classList.add('is-error');
}
