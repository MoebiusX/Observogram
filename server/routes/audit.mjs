// server/routes/audit.mjs — GET /api/audit, the audit reader (docs/
// STORE_PLAN.md §5, slice 5, design §5): the org's rows to its admins, the
// deployment's to owners, newest first, filtered and paged.
//
// The route is `admin` and closed where the member and user lists are
// (server/route-table.mjs: exposed refuse, direct, closed as 'the audit
// API'): it lists every login and every MCP origin of the deployment, so
// the open, exposed posture refuses it and, without sign-in, only a request
// sent straight to a loopback address is answered. Who may reach it in
// each posture is the guard's (authorize(), server/authz.mjs); which rows
// a principal then sees is server/audit-admin.mjs's rule — the scope — and
// so is every query parameter and every 400. The route itself builds no
// SQL: it hands the audit repository (server/store/audit.mjs listAudit) a
// filters object, asks for one row more than the page and answers `next`
// — the seq of the page's last row when another page exists, else null
// (no more; never "try again"). A read: it writes no row.

import express from 'express';
import { auditView, parseAuditQuery } from '../audit-admin.mjs';
import { currentOrg } from '../org-context.mjs';
import { listAudit } from '../store/audit.mjs';
import { handler } from './util.mjs';

export function auditRoutes({ authorize }) {
  // Case-sensitive like the app (server/index.mjs): a nested router does not inherit the app's setting.
  const router = express.Router({ caseSensitive: true });

  router.get('/api/audit', authorize('GET /api/audit'), handler((req, res, { db, principal }) => {
    const { scope, org, filters, limit } = parseAuditQuery(req.query, { owner: principal.owner === true, org: currentOrg() });
    const rows = listAudit(db, { ...filters, limit: limit + 1 });
    const page = rows.slice(0, limit).map(auditView);
    const next = rows.length > limit ? page[page.length - 1].seq : null;
    res.json({ ok: true, scope, org, limit, rows: page, next });
  }));

  return router;
}
