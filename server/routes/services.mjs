// server/routes/services.mjs — the services, environments and MCP
// endpoints API (docs/STORE_PLAN.md slice 4, design §7): the request's
// org's service records under /api/services, their environments under
// /api/environments and its MCP endpoint records under /api/mcp-endpoints;
// beside them, the folders a repository can be picked from, and the org's
// repository sources (Settings → Repository sources: which repository kinds
// a save, an upload and a Run may use).
// Every GET is `viewer` but the folders' (`operator`, as the save it serves),
// every service and environment mutation `operator`,
// every MCP endpoint mutation and the repository sources' switch `admin`
// (server/route-table.mjs). No path
// names an org: the org is the one the org middleware resolved, so a
// member never reaches another org's rows — another org's id is "no
// service <id>" here.
//
// An MCP endpoint record is durable configuration the server will fetch
// with a token it reads from its own environment (the variable's NAME is
// the record's; its value is never stored, returned or logged), so its
// three changes take the identity API's defences in the route table — the
// CSRF header in every posture, closed in the open, exposed posture, a
// direct loopback request only without sign-in — and its GET shows the
// URL and the variable to operators and above, the name and origin to
// every member (mcpEndpointViewOf by rank). The repository sources' switch
// is durable configuration of the org too, and takes the same defences.
//
// Every rule is server/service-admin.mjs's — the vocabulary (a tier is
// tier-1 | tier-2 | tier-3 | null, "graded by the pack"), the shapes of
// owners, bindings and endpoints, the slug as tools/lib/service-keys.mjs
// keys services, what exists and what clashes. This module parses the
// request, names a row by its id, projects rows into the views of design
// §7.3 and answers a refusal by its kind through server/routes/util.mjs
// (invalid 400, missing 404, conflict 409; a repository's TypeError 400;
// 403 is the guard's alone). Each handler is synchronous around its rule.
// The audit actor is the principal's; the rows each route writes are
// listed in server/route-table.mjs.
//
// A service's deletion cascades its environments, its pack links and its
// waivers (server/routes/waivers.mjs); the packs stay registered (a pack is not a service) and the deletion holds
// across restarts and rehydrates — the next register of a pack naming the
// service re-creates it, by the person registering (server/pack-registry.mjs).

import express from 'express';
import { rankOf } from '../authz.mjs';
import {
  WAYS, createEnvironmentFromApi, createMcpEndpointFromApi, createServiceFromApi, deleteEnvironmentFromApi, deleteMcpEndpointFromApi,
  deleteServiceFromApi, environmentViewOf, listServiceViews, mcpEndpointViewOf, repositorySourceRefusal, repositorySourcesView,
  serviceViewOf, setRepositorySourcesFromApi, updateEnvironmentFromApi, updateMcpEndpointFromApi, updateServiceFromApi,
} from '../service-admin.mjs';
import { AdminRefusal } from '../identity-admin.mjs';
import { currentStore } from '../store/db.mjs';
import { getEnvironment, listEnvironments } from '../store/environments.mjs';
import { listMcpEndpoints } from '../store/mcp-endpoints.mjs';
import { getService } from '../store/services.mjs';
import { mcpCallerOf, mcpTargetView } from '../mcp-target-policy.mjs';
import { FOLDER_WAYS, listRepositoryFolders } from '../repository-folders.mjs';
import { deleteUpload, parseUpload, saveUpload, setUploadedRepository } from '../repository-uploads.mjs';
import { bodyOf, handler, pathId, refused } from './util.mjs';

// The service a path names — or null, the answer (400 / 404) sent.
function pathService(req, res, db) {
  const id = pathId(req, res, 'id', 'service');
  if (id === null) return null;
  const row = getService(db, id);
  if (!row) {
    res.status(404).json({ ok: false, error: WAYS.noService(id) });
    return null;
  }
  return row;
}

// The environment a path names — or null, the answer sent.
function pathEnvironment(req, res, db) {
  const id = pathId(req, res, 'id', 'environment');
  if (id === null) return null;
  const row = getEnvironment(db, id);
  if (!row) {
    res.status(404).json({ ok: false, error: WAYS.noEnvironment(id) });
    return null;
  }
  return row;
}

// The service as an environment answer names it.
const serviceSummary = (s) => ({ id: s.id, slug: s.slug, name: s.name, tier: s.tier });

// `onGradeOffChanged(service)`: called after a PATCH changed a service's
// grade criteria, inside the request's org — the server writes the switches
// into the service's saved checks there (server/index.mjs).
// `onServiceDeleting(service)`: called before a DELETE, with the service as
// it is; the function it returns runs once the delete went through (the
// server takes the switches out of the checks that were the service's).
export function servicesRoutes({ authorize, onGradeOffChanged = null, onServiceDeleting = null }) {
  // Case-sensitive like the app (server/index.mjs): a nested router does not inherit the app's setting.
  const router = express.Router({ caseSensitive: true });

  // ---------- services ----------

  router.get('/api/services', authorize('GET /api/services'), handler((req, res, { db }) => {
    res.json({ ok: true, services: listServiceViews(db) });
  }));

  router.post('/api/services', authorize('POST /api/services'), handler((req, res, { db, actor }) => {
    const service = createServiceFromApi(db, actor, bodyOf(req), { caller: mcpCallerOf(req) });
    res.status(201).json({ ok: true, service: serviceViewOf(db, service) });
  }));

  router.get('/api/services/:id', authorize('GET /api/services/:id'), handler((req, res, { db }) => {
    const service = pathService(req, res, db);
    if (!service) return;
    res.json({ ok: true, service: serviceViewOf(db, service) });
  }));

  // Any of name, owners, tier, description, repository; the slug is fixed
  // (packs link to it). Nothing differing → 200 with changed: [] and no row.
  router.patch('/api/services/:id', authorize('PATCH /api/services/:id'), handler((req, res, { db, actor }) => {
    const id = pathId(req, res, 'id', 'service');
    if (id === null) return;
    const before = getService(db, id);
    const { service, changed } = updateServiceFromApi(db, actor, id, bodyOf(req), { caller: mcpCallerOf(req) });
    // Pointed away from its upload: the copy goes with it.
    if (changed.includes('repository') && before?.repository?.kind === 'upload') deleteUpload(id);
    const view = serviceViewOf(db, service);
    if (changed.includes('gradeOff')) onGradeOffChanged?.(view);
    res.json({ ok: true, service: view, changed });
  }));

  // The environments, the pack links and the waivers cascade (they write
  // no row of their own; the detail counts them); the packs stay registered.
  router.delete('/api/services/:id', authorize('DELETE /api/services/:id'), handler((req, res, { db, actor }) => {
    const id = pathId(req, res, 'id', 'service');
    if (id === null) return;
    const current = getService(db, id);
    const after = current && Array.isArray(current.gradeOff) && current.gradeOff.length ? onServiceDeleting?.(current) : null;
    const { service, environments, packLinks, waivers } = deleteServiceFromApi(db, actor, id);
    deleteUpload(id);   // its uploaded repository, if it had one
    if (typeof after === 'function') after();
    res.json({ ok: true, deleted: service, environments, packLinks, waivers });
  }));

  // The repository uploaded from the person's own machine (Overview's
  // Upload, server/repository-uploads.mjs): { name, files } — the folder's or
  // the .zip's name and the text of the files a scan reads, as their browser
  // read them. The copy replaces the service's last one, and the record
  // points at it: { kind: 'upload', location: name, uploadedAt, files, bytes }.
  // Upload switched off in the org (Settings → Repository sources): 409,
  // before the body is read or anything kept.
  router.put('/api/services/:id/repository-upload', authorize('PUT /api/services/:id/repository-upload'), handler((req, res, { db, actor }) => {
    const current = pathService(req, res, db);
    if (!current) return;
    const off = repositorySourceRefusal(db, 'upload');
    if (off) throw new AdminRefusal(off, 'conflict');
    const upload = parseUpload(bodyOf(req));
    const repository = saveUpload(current.id, upload);
    const { service } = setUploadedRepository(db, actor, current.id, repository);
    res.json({ ok: true, service: serviceViewOf(db, service), upload: repository });
  }));

  // The folders a service's repository can be picked from (Overview's
  // Browse…): one folder and the folders inside it, under the rule a save
  // applies (server/repository-folders.mjs). Asynchronous (it reads the
  // disk), so it answers its refusals itself; operator, as the save is.
  // Folder switched off in the org: the top says so (allowed: false, `why`
  // the sentence), a named folder is 409; no folder is read.
  router.get('/api/repository-folders', authorize('GET /api/repository-folders'), async (req, res, next) => {
    try {
      const path = req.query.path;
      if (path !== undefined && typeof path !== 'string') return res.status(400).json({ ok: false, error: FOLDER_WAYS.pathParam });
      const listing = await listRepositoryFolders(path, mcpCallerOf(req), { off: repositorySourceRefusal(currentStore(), 'path') });
      return res.set('Cache-Control', 'no-store').json(listing);
    } catch (e) {
      try { return refused(res, e); } catch (bug) { return next(bug); }
    }
  });

  // ---------- the org's repository sources ----------

  // Settings → Repository sources, read by every member: { github, ado,
  // path, upload }, true on — every source on until an org admin switches it off.
  router.get('/api/repository-sources', authorize('GET /api/repository-sources'), handler((req, res, { db }) => {
    res.json({ ok: true, sources: repositorySourcesView(db) });
  }));

  // An org admin's switch: { github?, ado?, path?, upload? }, each true or
  // false, at least one → the switches after (`sources`) and before
  // (`from`); one org.repository_sources row when a switch moved, none when
  // nothing did. The records keep their repository.
  router.put('/api/repository-sources', authorize('PUT /api/repository-sources'), handler((req, res, { db, actor }) => {
    const { sources, from } = setRepositorySourcesFromApi(db, actor, bodyOf(req));
    res.json({ ok: true, sources, from });
  }));

  // ---------- environments ----------

  router.get('/api/services/:id/environments', authorize('GET /api/services/:id/environments'), handler((req, res, { db }) => {
    const service = pathService(req, res, db);
    if (!service) return;
    res.json({ ok: true, service: serviceSummary(service), environments: listEnvironments(db, service.id).map((env) => environmentViewOf(db, env, service)) });
  }));

  router.post('/api/services/:id/environments', authorize('POST /api/services/:id/environments'), handler((req, res, { db, actor }) => {
    const id = pathId(req, res, 'id', 'service');
    if (id === null) return;
    const environment = createEnvironmentFromApi(db, actor, id, bodyOf(req));
    res.status(201).json({ ok: true, environment: environmentViewOf(db, environment) });
  }));

  router.get('/api/environments/:id', authorize('GET /api/environments/:id'), handler((req, res, { db }) => {
    const environment = pathEnvironment(req, res, db);
    if (!environment) return;
    const service = getService(db, environment.serviceId);
    res.json({ ok: true, environment: environmentViewOf(db, environment, service), service: serviceSummary(service) });
  }));

  // Any of name, tier, bindings, endpoints, mcpEndpointId (null unbinds).
  router.patch('/api/environments/:id', authorize('PATCH /api/environments/:id'), handler((req, res, { db, actor }) => {
    const id = pathId(req, res, 'id', 'environment');
    if (id === null) return;
    const { environment, changed } = updateEnvironmentFromApi(db, actor, id, bodyOf(req));
    res.json({ ok: true, environment: environmentViewOf(db, environment), changed });
  }));

  router.delete('/api/environments/:id', authorize('DELETE /api/environments/:id'), handler((req, res, { db, actor }) => {
    const id = pathId(req, res, 'id', 'environment');
    if (id === null) return;
    const { environment } = deleteEnvironmentFromApi(db, actor, id);
    res.json({ ok: true, deleted: environment });
  }));

  // ---------- MCP endpoints ----------

  // The reader's rank decides the view: the URL and the variable's name to
  // operators and above, null to a viewer (the live-status precedent).
  const endpointView = (db, principal, ep) => mcpEndpointViewOf(db, ep, { rank: rankOf(principal) });

  // `policy` says what this caller may do with a target (mcpTargetView): type
  // a URL, register an endpoint, and the reader's own org's origin list.
  router.get('/api/mcp-endpoints', authorize('GET /api/mcp-endpoints'), handler((req, res, { db, principal }) => {
    res.json({ ok: true, endpoints: listMcpEndpoints(db).map((ep) => endpointView(db, principal, ep)), policy: mcpTargetView(db, mcpCallerOf(req)) });
  }));

  router.post('/api/mcp-endpoints', authorize('POST /api/mcp-endpoints'), handler((req, res, { db, principal, actor }) => {
    const endpoint = createMcpEndpointFromApi(db, actor, bodyOf(req), { caller: mcpCallerOf(req) });
    res.status(201).json({ ok: true, endpoint: endpointView(db, principal, endpoint) });
  }));

  // Any of name, url, readTokenEnv (null clears it). Nothing differing →
  // 200 with changed: [] and no row.
  router.patch('/api/mcp-endpoints/:id', authorize('PATCH /api/mcp-endpoints/:id'), handler((req, res, { db, principal, actor }) => {
    const id = pathId(req, res, 'id', 'MCP endpoint');
    if (id === null) return;
    const { endpoint, changed } = updateMcpEndpointFromApi(db, actor, id, bodyOf(req), { caller: mcpCallerOf(req) });
    res.json({ ok: true, endpoint: endpointView(db, principal, endpoint), changed });
  }));

  // The environments checked through it keep their row, unbound (their
  // ids are `unbound`); the view is the record as it was.
  router.delete('/api/mcp-endpoints/:id', authorize('DELETE /api/mcp-endpoints/:id'), handler((req, res, { db, actor }) => {
    const id = pathId(req, res, 'id', 'MCP endpoint');
    if (id === null) return;
    const { endpoint, unbound } = deleteMcpEndpointFromApi(db, actor, id);
    res.json({ ok: true, deleted: endpoint, unbound });
  }));

  return router;
}
