// server/store/waivers.mjs — a service record's time-boxed, reasoned waivers
// of conformance findings (context-scoped; docs/STORE_PLAN.md §2 "Schema
// v2", GAP batch 2 B3.2). A waiver names a rubric clause (`ruleId`) and,
// optionally, one canonical symbol (`artefactId`: `slos.<id>`, `slis.<id>`
// — the adapter's `defines` vocabulary, never a JSONPath), with a reason,
// the author (the audit actor: a login or the token label, never an email)
// and an expiry. Rows are immutable but for the revoke, which keeps the row
// as history (`revokedAt`, `revokedBy`, `revokeReason`); an expired waiver
// is a row whose expiry has passed — the state is computed by the rule that
// reads it (server/waiver-admin.mjs, tools/lib/waivers.mjs), never stored.
// No unique index: expiry is time-dependent, so "one active per (service,
// rule, artefact)" is the admin rule's, inside its atomic(). The row
// cascades with its service.
//
// The repository keeps the permissive text rules every repository has (a
// rule id is any text); the vocabulary — which rule ids exist, the expiry
// window, the symbol grammar — is server/waiver-admin.mjs's. This module
// holds the SQL.

import { atomic, nowIso, prepare } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { getService } from './services.mjs';
import { notFound, optionalText, requireIso, requireOrg, requireText } from './rows.mjs';

const REPO = 'waivers';
export const WAIVER_REASON_MAX = 2000;
const DETAIL_TEXT_MAX = 200; // a reason as the audit row quotes it

export function rowToWaiver(r) {
  if (!r) return null;
  return {
    id: r.id, orgId: r.org_id, serviceId: r.service_id, artefactId: r.artefact_id, ruleId: r.rule_id, reason: r.reason, author: r.author,
    expiresAt: r.expires_at, createdAt: r.created_at, revokedAt: r.revoked_at, revokedBy: r.revoked_by, revokeReason: r.revoke_reason,
  };
}

const cut = (text) => (typeof text === 'string' ? text.slice(0, DETAIL_TEXT_MAX) : null);

export function getWaiver(db, id) {
  const org = requireOrg(REPO);
  return rowToWaiver(prepare(db, 'SELECT * FROM waivers WHERE org_id = ? AND id = ?').get(org, id));
}

// Newest first (history included: a revoked row stays).
export function listWaivers(db, serviceId) {
  const org = requireOrg(REPO);
  return prepare(db, 'SELECT * FROM waivers WHERE org_id = ? AND service_id = ? ORDER BY created_at DESC, id DESC').all(org, serviceId).map(rowToWaiver);
}

export function countWaivers(db, serviceId) {
  const org = requireOrg(REPO);
  return prepare(db, 'SELECT count(*) AS n FROM waivers WHERE org_id = ? AND service_id = ?').get(org, serviceId).n;
}

// The author is the actor: a waiver is signed by whoever recorded it.
// Audit waiver.create on target waiver <id> { service: slug, ruleId,
// artefactId, expiresAt, reason ≤ 200 }.
export function createWaiver(db, actor, { serviceId, artefactId = null, ruleId, reason, expiresAt }) {
  const org = requireOrg(REPO);
  requireText(ruleId, 'ruleId');
  requireText(reason, 'reason', { max: WAIVER_REASON_MAX });
  requireIso(expiresAt, 'expiresAt');
  const nextArtefact = optionalText(artefactId, 'artefactId');
  return atomic(db, () => {
    const service = getService(db, serviceId);
    if (!service) throw notFound('service', serviceId);
    const row = prepare(db, `INSERT INTO waivers (org_id, service_id, artefact_id, rule_id, reason, author, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(org, service.id, nextArtefact, ruleId, reason, actor, expiresAt, nowIso());
    writeAudit(db, actor, {
      orgId: org, action: 'waiver.create', targetKind: 'waiver', targetId: row.id,
      detail: { service: service.slug, ruleId, artefactId: nextArtefact, expiresAt, reason: cut(reason) },
    });
    return rowToWaiver(row);
  });
}

// Soft: the row stays as history. A second revoke is a TypeError (the
// route answers it as 400 through server/routes/util.mjs). Audit
// waiver.revoke { service: slug, ruleId, artefactId, reason ≤ 200 }.
export function revokeWaiver(db, actor, id, { reason = null } = {}) {
  const org = requireOrg(REPO);
  const nextReason = optionalText(reason, 'reason', { max: WAIVER_REASON_MAX });
  return atomic(db, () => {
    const current = getWaiver(db, id);
    if (!current) throw notFound('waiver', id);
    if (current.revokedAt) throw new TypeError(`observogram store: waiver ${id} is revoked already (${current.revokedAt}, by ${current.revokedBy})`);
    const service = getService(db, current.serviceId);
    const row = prepare(db, 'UPDATE waivers SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE org_id = ? AND id = ? RETURNING *')
      .get(nowIso(), actor, nextReason, org, id);
    writeAudit(db, actor, {
      orgId: org, action: 'waiver.revoke', targetKind: 'waiver', targetId: id,
      detail: { service: service?.slug ?? null, ruleId: current.ruleId, artefactId: current.artefactId, reason: cut(nextReason) },
    });
    return rowToWaiver(row);
  });
}
