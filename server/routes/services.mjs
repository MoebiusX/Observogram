// server/routes/services.mjs — the services and environments API
// (docs/STORE_PLAN.md slice 4, design §7): the request's org's service
// records under /api/services and their environments under
// /api/environments. Every GET is `viewer`, every mutation `operator`
// (server/route-table.mjs). No path names an org: the org is the one the
// org middleware resolved, so a member never reaches another org's rows —
// another org's id is "no service <id>" here.
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
// A service's deletion cascades its environments and its pack links; the
// packs stay registered (a pack is not a service) and the deletion holds
// across restarts and rehydrates — the next register of a pack naming the
// service re-creates it, by the person registering (server/pack-registry.mjs).

import express from 'express';
import {
  WAYS, createEnvironmentFromApi, createServiceFromApi, deleteEnvironmentFromApi, deleteServiceFromApi, environmentViewOf,
  listServiceViews, serviceViewOf, updateEnvironmentFromApi, updateServiceFromApi,
} from '../service-admin.mjs';
import { getEnvironment, listEnvironments } from '../store/environments.mjs';
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

  // The environments and the pack links cascade (they write no row of
  // their own; the detail counts them); the packs stay registered.
  router.delete('/api/services/:id', authorize('DELETE /api/services/:id'), handler((req, res, { db, actor }) => {
    const id = pathId(req, res, 'id', 'service');
    if (id === null) return;
    const { service, environments, packLinks } = deleteServiceFromApi(db, actor, id);
    res.json({ ok: true, deleted: service, environments, packLinks });
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

  return router;
}
