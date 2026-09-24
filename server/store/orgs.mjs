// server/store/orgs.mjs — orgs (deployment-level; docs/STORE_PLAN.md §2).
//
// An org's root is where its files live, relative to the base workspace,
// fixed at creation so data never moves at runtime: '.' only when the
// caller explicitly asks for it (the default org), otherwise 'orgs/<id>'.
// The schema holds the same rule (CHECK root = '.' OR root = 'orgs/' || id,
// and one '.' at most). Removal is a soft delete (removed_at); the row
// stays, so a slug and its root are never reused.

import { atomic, nowIso, prepare } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { notFound, requireText } from './rows.mjs';
import { validOrgId } from '../tenancy.mjs';

export function rowToOrg(r) {
  if (!r) return null;
  return { id: r.id, name: r.name, root: r.root, removedAt: r.removed_at, createdAt: r.created_at };
}

export function getOrg(db, id) {
  return rowToOrg(prepare(db, 'SELECT * FROM orgs WHERE id = ?').get(id));
}

export function listOrgs(db, { includeRemoved = false } = {}) {
  const sql = includeRemoved
    ? 'SELECT * FROM orgs ORDER BY created_at, rowid'
    : 'SELECT * FROM orgs WHERE removed_at IS NULL ORDER BY created_at, rowid';
  return prepare(db, sql).all().map(rowToOrg);
}

// Deployment event: org_id NULL on the audit row.
export function createOrg(db, actor, { id, name, root }) {
  if (!validOrgId(id)) throw new TypeError(`observogram store: invalid org id ${JSON.stringify(id)} (a slug: lowercase letters, digits, - and _)`);
  requireText(name, 'name');
  const fixedRoot = root === '.' ? '.' : `orgs/${id}`;
  if (root !== undefined && root !== fixedRoot) {
    throw new TypeError(`observogram store: an org's root is '.' (the default org, asked for explicitly) or 'orgs/${id}', not ${JSON.stringify(root)}`);
  }
  return atomic(db, () => {
    if (getOrg(db, id)) throw new Error(`observogram store: org ${JSON.stringify(id)} exists or existed — a slug is never reused`);
    const row = prepare(db, 'INSERT INTO orgs (id, name, root, created_at) VALUES (?, ?, ?, ?) RETURNING *').get(id, name, fixedRoot, nowIso());
    writeAudit(db, actor, { action: 'org.create', targetKind: 'org', targetId: id, detail: { name, root: fixedRoot } });
    return rowToOrg(row);
  });
}

// An org-level change: the row carries the org's id.
export function renameOrg(db, actor, id, name) {
  requireText(name, 'name');
  return atomic(db, () => {
    const org = getOrg(db, id);
    if (!org || org.removedAt) throw notFound('org', id);
    if (org.name === name) return org;
    prepare(db, 'UPDATE orgs SET name = ? WHERE id = ?').run(name, id);
    writeAudit(db, actor, { orgId: id, action: 'org.rename', targetKind: 'org', targetId: id, detail: { from: org.name, to: name } });
    return getOrg(db, id);
  });
}

export function removeOrg(db, actor, id) {
  return atomic(db, () => {
    const org = getOrg(db, id);
    if (!org || org.removedAt) throw notFound('org', id);
    prepare(db, 'UPDATE orgs SET removed_at = ? WHERE id = ?').run(nowIso(), id);
    writeAudit(db, actor, { action: 'org.remove', targetKind: 'org', targetId: id });
    return getOrg(db, id);
  });
}
