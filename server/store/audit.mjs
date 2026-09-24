// server/store/audit.mjs — the append-only audit (deployment-level).
//
// Rows are written by the repository whose change they record, inside the
// same tx() (writeAudit), or on their own (appendAudit). org_id NULL marks
// a deployment event (users, orgs, owners); an org's rows carry its id.
// The schema's triggers refuse UPDATE, DELETE and any insert over an
// existing seq, so there is deliberately no way to change a row here.

import { atomic, nowIso, prepare } from './db.mjs';
import { requireActor, requireText, fromJson } from './rows.mjs';

const INSERT = `INSERT INTO audit (at, org_id, actor, action, target_kind, target_id, detail)
  VALUES (:at, :org_id, :actor, :action, :target_kind, :target_id, :detail) RETURNING *`;

export function rowToAudit(r) {
  if (!r) return null;
  return {
    seq: r.seq, at: r.at, orgId: r.org_id, actor: r.actor, action: r.action,
    targetKind: r.target_kind, targetId: r.target_id, detail: fromJson(r.detail),
  };
}

// For repositories: must run inside the tx() of the change it records.
export function writeAudit(db, actor, { orgId = null, action, targetKind = null, targetId = null, detail = null }) {
  if (!db.isTransaction) throw new Error('observogram store: writeAudit() runs inside the tx() of the change it records');
  return rowToAudit(prepare(db, INSERT).get({
    at: nowIso(),
    org_id: orgId,
    actor: requireActor(actor),
    action: requireText(action, 'action', { max: 100 }),
    target_kind: targetKind,
    target_id: targetId === null || targetId === undefined ? null : String(targetId),
    detail: detail === null || detail === undefined ? null : JSON.stringify(detail),
  }));
}

// An audit row on its own (joins an open tx() when there is one).
export function appendAudit(db, actor, row) {
  return atomic(db, () => writeAudit(db, actor, row));
}

// Newest first. orgId: undefined = every row, null = deployment rows only,
// a string = that org's rows. beforeSeq pages backwards.
export function listAudit(db, { orgId, actor, action, targetKind, targetId, since, until, beforeSeq, limit = 100 } = {}) {
  const where = [];
  const params = {};
  if (orgId === null) where.push('org_id IS NULL');
  else if (orgId !== undefined) { where.push('org_id = :org_id'); params.org_id = orgId; }
  if (actor !== undefined) { where.push('actor = :actor'); params.actor = actor; }
  if (action !== undefined) { where.push('action = :action'); params.action = action; }
  if (targetKind !== undefined) { where.push('target_kind = :target_kind'); params.target_kind = targetKind; }
  if (targetId !== undefined) { where.push('target_id = :target_id'); params.target_id = String(targetId); }
  if (since !== undefined) { where.push('at >= :since'); params.since = since; }
  if (until !== undefined) { where.push('at < :until'); params.until = until; }
  if (beforeSeq !== undefined) { where.push('seq < :before_seq'); params.before_seq = beforeSeq; }
  params.limit = Math.min(Math.max(1, Math.trunc(Number(limit) || 100)), 1000);
  const sql = `SELECT * FROM audit${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT :limit`;
  return prepare(db, sql).all(params).map(rowToAudit);
}
