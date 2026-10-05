// server/routes/waivers.mjs — the waivers API (GAP batch 2, B3.2;
// docs/CONFORMANCE.md "Waivers"): a service record's time-boxed, reasoned
// suppression of a conformance finding, under /api/services/:id/waivers and
// /api/waivers/:id.
//
//   GET  /api/services/:id/waivers   viewer    { ok, service: { id, slug }, waivers[], counts: { active, expired, revoked } }, newest first
//   POST /api/services/:id/waivers   operator  { ruleId, artefactId?, reason, expiresAt } → 201 { ok, waiver }; audit waiver.create
//   POST /api/waivers/:id/revoke     operator  { reason? } → { ok, waiver } (state revoked); audit waiver.revoke
//
// Every rule is server/waiver-admin.mjs's (which clauses exist, the symbol
// grammar, the expiry window, one active waiver per key, what a revoke may
// touch); this module names the row the path holds (pathId: 400 for a
// malformed id, 404 `no service <id>` / `no waiver <id>` through the rule)
// and answers a refusal by its kind through server/routes/util.mjs (invalid
// 400, missing 404, conflict 409; 403 is the guard's alone). The server's
// clock is `now` for every state the response carries. The audit actor is
// the principal's; the `author` a waiver shows is that actor.

import express from 'express';
import { getService } from '../store/services.mjs';
import { WAYS, createWaiverFromApi, listWaiverViews, revokeWaiverFromApi } from '../waiver-admin.mjs';
import { bodyOf, handler, pathId } from './util.mjs';

export function waiversRoutes({ authorize }) {
  // Case-sensitive like the app (server/index.mjs): a nested router does not inherit the app's setting.
  const router = express.Router({ caseSensitive: true });

  router.get('/api/services/:id/waivers', authorize('GET /api/services/:id/waivers'), handler((req, res, { db }) => {
    const id = pathId(req, res, 'id', 'service');
    if (id === null) return;
    const service = getService(db, id);
    if (!service) return res.status(404).json({ ok: false, error: WAYS.noService(id) });
    res.json(listWaiverViews(db, service, new Date().toISOString()));
  }));

  router.post('/api/services/:id/waivers', authorize('POST /api/services/:id/waivers'), handler((req, res, { db, actor }) => {
    const id = pathId(req, res, 'id', 'service');
    if (id === null) return;
    const waiver = createWaiverFromApi(db, actor, id, bodyOf(req));
    res.status(201).json({ ok: true, waiver });
  }));

  router.post('/api/waivers/:id/revoke', authorize('POST /api/waivers/:id/revoke'), handler((req, res, { db, actor }) => {
    const id = pathId(req, res, 'id', 'waiver');
    if (id === null) return;
    const waiver = revokeWaiverFromApi(db, actor, id, bodyOf(req));
    res.json({ ok: true, waiver });
  }));

  return router;
}
