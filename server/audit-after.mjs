// server/audit-after.mjs — the audit row a file-first route writes AFTER its
// file (docs/STORE_PLAN.md §5, slice 5).
//
// The deploys.jsonl routes, the journey capture and run, and the live
// refresh change a file of the org's, not a table, so no repository tx()
// carries their row. The rule here: the row is written on its own
// (appendAudit, a transaction of its own) once the file write has been
// attempted, and a failed insert never fails the operation — the caller
// puts `auditError` on its response and one line goes to stderr. The audit
// table is append-only; a row written after a failed file append is a new
// row with a flag (detail.fileError), never a correction.
//
// This module holds no SQL (server/test-store-guards.mjs keeps it so):
// everything goes through the audit repository.

import { appendAudit } from './store/audit.mjs';
import { currentStore } from './store/db.mjs';
import { requireActor } from './store/rows.mjs';
import { currentOrg } from './org-context.mjs';

// Writes `row` ({ action, targetKind, targetId, detail }) for the request's
// principal in the request's org. Returns null, or the error's message for
// the response's `auditError`.
export function auditAfter(req, row, { tag = 'audit' } = {}) {
  try {
    appendAudit(currentStore(), req.observogramPrincipal?.actor, { orgId: currentOrg(), ...row });
    return null;
  } catch (e) {
    process.stderr.write(`[${tag}]   audit row failed: ${e.message} (the operation stands; ${row.action} ${row.targetId ?? ''} is not on the record)\n`);
    return e.message;
  }
}

// The actor a file-first route stamps on its file AND its row: checked
// before the file is written, so a missing one (a bug — every principal
// past authorize() has an actor) writes neither. Throws requireActor's
// TypeError; the route answers 500 with its text.
export function actorForRecord(req) {
  return requireActor(req?.observogramPrincipal?.actor);
}

// Request text that may enter a permanent row: cut to the repository's text
// rule (server/store/rows.mjs: 200 characters), null when not a string.
export function bounded(text, max = 200) {
  return typeof text === 'string' ? text.slice(0, max) : null;
}

// A number for a row: finite, or null.
export function finite(n) {
  return Number.isFinite(n) ? n : null;
}
