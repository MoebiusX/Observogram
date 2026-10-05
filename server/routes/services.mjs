// server/routes/services.mjs — the services, environments and MCP
// endpoints API (docs/STORE_PLAN.md slice 4, design §7): the request's
// org's service records under /api/services, their environments under
// /api/environments and its MCP endpoint records under /api/mcp-endpoints.
// Every GET is `viewer`, every service and environment mutation `operator`,
// every MCP endpoint mutation `admin` (server/route-table.mjs). No path
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
// every member (mcpEndpointViewOf by rank).
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
  deleteServiceFromApi, environmentViewOf, listServiceViews, mcpEndpointViewOf, serviceViewOf, updateEnvironmentFromApi,
  updateMcpEndpointFromApi, updateServiceFromApi,
} from '../service-admin.mjs';
import { getEnvironment, listEnvironments } from '../store/environments.mjs';
import { listMcpEndpoints } from '../store/mcp-endpoints.mjs';
import { getService } from '../store/services.mjs';
import { bodyOf, handler, pathId } from './util.mjs';

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

export function servicesRoutes({ authorize }) {
  // Case-sensitive like the app (server/index.mjs): a nested router does not inherit the app's setting.
  const router = express.Router({ caseSensitive: true });

  // ---------- services ----------

  router.get('/api/services', authorize('GET /api/services'), handler((req, res, { db }) => {
    res.json({ ok: true, services: listServiceViews(db) });
  }));

  router.post('/api/services', authorize('POST /api/services'), handler((req, res, { db, actor }) => {
    const service = createServiceFromApi(db, actor, bodyOf(req));
    res.status(201).json({ ok: true, service: serviceViewOf(db, service) });
  }));

  router.get('/api/services/:id', authorize('GET /api/services/:id'), handler((req, res, { db }) => {
    const service = pathService(req, res, db);
    if (!service) return;
    res.json({ ok: true, service: serviceViewOf(db, service) });
  }));

  // Any of name, owners, tier, description; the slug is fixed (packs link
  // to it). Nothing differing → 200 with changed: [] and no row.
  router.patch('/api/services/:id', authorize('PATCH /api/services/:id'), handler((req, res, { db, actor }) => {
    const id = pathId(req, res, 'id', 'service');
    if (id === null) return;
    const { service, changed } = updateServiceFromApi(db, actor, id, bodyOf(req));
    res.json({ ok: true, service: serviceViewOf(db, service), changed });
  }));

  // The environments, the pack links and the waivers cascade (they write
  // no row of their own; the detail counts them); the packs stay registered.
  router.delete('/api/services/:id', authorize('DELETE /api/services/:id'), handler((req, res, { db, actor }) => {
    const id = pathId(req, res, 'id', 'service');
    if (id === null) return;
    const { service, environments, packLinks, waivers } = deleteServiceFromApi(db, actor, id);
    res.json({ ok: true, deleted: service, environments, packLinks, waivers });
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

  router.get('/api/mcp-endpoints', authorize('GET /api/mcp-endpoints'), handler((req, res, { db, principal }) => {
    res.json({ ok: true, endpoints: listMcpEndpoints(db).map((ep) => endpointView(db, principal, ep)) });
  }));

  router.post('/api/mcp-endpoints', authorize('POST /api/mcp-endpoints'), handler((req, res, { db, principal, actor }) => {
    const endpoint = createMcpEndpointFromApi(db, actor, bodyOf(req));
    res.status(201).json({ ok: true, endpoint: endpointView(db, principal, endpoint) });
  }));

  // Any of name, url, readTokenEnv (null clears it). Nothing differing →
  // 200 with changed: [] and no row.
  router.patch('/api/mcp-endpoints/:id', authorize('PATCH /api/mcp-endpoints/:id'), handler((req, res, { db, principal, actor }) => {
    const id = pathId(req, res, 'id', 'MCP endpoint');
    if (id === null) return;
    const { endpoint, changed } = updateMcpEndpointFromApi(db, actor, id, bodyOf(req));
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
