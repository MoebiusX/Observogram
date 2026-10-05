// server/routes/verdicts.mjs — the verdicts API (GAP batch 2, B3.1;
// docs/ADAPTER.md "Verdicts — a reviewer's record per artefact"): a
// reviewer's trusted | suspect | failed record on one artefact of one
// registered pack, under /api/packs/:id/verdicts.
//
//   GET    /api/packs/:id/verdicts              viewer    the document: { ok, pack, verdicts[], summary }
//   PUT    /api/packs/:id/verdicts/:artefact    operator  { status, reason? } → { ok, verdict, changed[] }; audit verdict.set
//   DELETE /api/packs/:id/verdicts/:artefact    operator  → { ok, cleared }; audit verdict.clear
//
// Every rule is server/verdict-admin.mjs's (the statuses, the reason, which
// artefacts a pack has, what a catalogue pack may hold — nothing); this
// module names the pack the path holds, adapts its canonical and answers a
// refusal by its kind through server/routes/util.mjs (invalid 400, missing
// 404, conflict 409; 403 is the guard's alone). An unknown pack is 404
// `{ ok: false, error: 'unknown pack: <id>' }` — the services API's shape
// (the sibling pack routes of server/index.mjs answer `{ error }` without
// `ok`; the static bundle's shim passes `{ ok: false }` to its unknownPack
// for these routes). A canonical the schema refuses makes adapt() throw,
// which goes on to Express as a 500 like every pack read's. `?env=` is
// ignored: a verdict is per pack, its artefact ids positional within it.
// The audit actor is the principal's.

import express from 'express';
import { adapt } from '../../tools/lib/adapter.mjs';
import { clearVerdictFromApi, setVerdictFromApi, verdictsDocument } from '../verdict-admin.mjs';
import { bodyOf, handler } from './util.mjs';

export function verdictsRoutes({ findPackMeta, loadPackCanonical, authorize }) {
  // Case-sensitive like the app (server/index.mjs): a nested router does not inherit the app's setting.
  const router = express.Router({ caseSensitive: true });

  // The pack a path names, adapted — or null, the 404 sent.
  function pathPack(req, res) {
    const meta = findPackMeta(req.params.id);
    if (!meta) {
      res.status(404).json({ ok: false, error: `unknown pack: ${req.params.id}` });
      return null;
    }
    return { meta, adapted: adapt(loadPackCanonical(meta)) };
  }

  router.get('/api/packs/:id/verdicts', authorize('GET /api/packs/:id/verdicts'), handler((req, res, { db }) => {
    const pack = pathPack(req, res);
    if (!pack) return;
    res.json(verdictsDocument(db, pack));
  }));

  router.put('/api/packs/:id/verdicts/:artefact', authorize('PUT /api/packs/:id/verdicts/:artefact'), handler((req, res, { db, actor }) => {
    const pack = pathPack(req, res);
    if (!pack) return;
    const { verdict, changed } = setVerdictFromApi(db, actor, { ...pack, artefactId: req.params.artefact, body: bodyOf(req) });
    res.json({ ok: true, verdict, changed });
  }));

  router.delete('/api/packs/:id/verdicts/:artefact', authorize('DELETE /api/packs/:id/verdicts/:artefact'), handler((req, res, { db, actor }) => {
    const pack = pathPack(req, res);
    if (!pack) return;
    const { cleared } = clearVerdictFromApi(db, actor, { ...pack, artefactId: req.params.artefact });
    res.json({ ok: true, cleared });
  }));

  return router;
}
