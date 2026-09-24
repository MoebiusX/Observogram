// server/store/memberships.mjs — who is in which org, with which role
// (deployment-level; docs/STORE_PLAN.md §2, §5). Takes the org id
// explicitly: the org middleware's own lookup, just-in-time joins and the
// bootstrap grant are cross-org by nature. Roles are viewer, operator and
// admin, checked here and by the schema.

import { atomic, nowIso, prepare } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { getOrg } from './orgs.mjs';
import { getUser } from './users.mjs';
import { notFound } from './rows.mjs';

export const ROLES = Object.freeze(['viewer', 'operator', 'admin']);

function requireRole(role) {
  if (!ROLES.includes(role)) throw new TypeError(`observogram store: role is one of ${ROLES.join(', ')}, not ${JSON.stringify(role)}`);
  return role;
}

export function rowToMembership(r) {
  if (!r) return null;
  return { orgId: r.org_id, userId: r.user_id, role: r.role, createdAt: r.created_at };
}

export function getMembership(db, orgId, userId) {
  return rowToMembership(prepare(db, 'SELECT * FROM memberships WHERE org_id = ? AND user_id = ?').get(orgId, userId));
}

export function listMembers(db, orgId) {
  return prepare(db, 'SELECT * FROM memberships WHERE org_id = ? ORDER BY created_at, rowid').all(orgId).map(rowToMembership);
}

// A user's memberships in live orgs, first membership first (by created_at,
// then rowid — the order the org middleware lands a user in).
export function listMembershipsForUser(db, userId) {
  return prepare(db, `SELECT m.* FROM memberships m JOIN orgs o ON o.id = m.org_id
    WHERE m.user_id = ? AND o.removed_at IS NULL ORDER BY m.created_at, m.rowid`).all(userId).map(rowToMembership);
}

function subjects(db, orgId, userId) {
  const org = getOrg(db, orgId);
  if (!org || org.removedAt) throw notFound('org', orgId);
  const user = getUser(db, userId);
  if (!user) throw notFound('user', userId);
  return { org, user };
}

export function addMembership(db, actor, { orgId, userId, role }) {
  requireRole(role);
  return atomic(db, () => {
    const { user } = subjects(db, orgId, userId);
    const row = prepare(db, 'INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?) RETURNING *')
      .get(orgId, userId, role, nowIso());
    writeAudit(db, actor, { orgId, action: 'membership.add', targetKind: 'user', targetId: user.login, detail: { role } });
    return rowToMembership(row);
  });
}

export function setRole(db, actor, orgId, userId, role) {
  requireRole(role);
  return atomic(db, () => {
    const { user } = subjects(db, orgId, userId);
    const current = getMembership(db, orgId, userId);
    if (!current) throw notFound('membership', `${orgId}/${user.login}`);
    if (current.role === role) return current;
    prepare(db, 'UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?').run(role, orgId, userId);
    writeAudit(db, actor, { orgId, action: 'membership.role', targetKind: 'user', targetId: user.login, detail: { from: current.role, to: role } });
    return getMembership(db, orgId, userId);
  });
}

export function removeMembership(db, actor, orgId, userId) {
  return atomic(db, () => {
    const user = getUser(db, userId);
    const current = getMembership(db, orgId, userId);
    if (!user || !current) throw notFound('membership', `${orgId}/${userId}`);
    prepare(db, 'DELETE FROM memberships WHERE org_id = ? AND user_id = ?').run(orgId, userId);
    writeAudit(db, actor, { orgId, action: 'membership.remove', targetKind: 'user', targetId: user.login, detail: { role: current.role } });
    return current;
  });
}
