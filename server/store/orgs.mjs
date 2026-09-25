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
import { validOrgId } from '../org-context.mjs';

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

// The row insert, with the repository's rules and no audit row: internal
// to server/store/ (the import, the identity operations), and only inside
// the tx() whose own audit row covers it.
export function insertOrgRow(db, { id, name, root, createdAt }) {
  if (!db.isTransaction) throw new Error('observogram store: insertOrgRow() runs inside the tx() whose audit row covers it');
  if (!validOrgId(id)) throw new TypeError(`observogram store: invalid org id ${JSON.stringify(id)} (a slug: lowercase letters, digits, - and _)`);
  requireText(name, 'name');
  const fixedRoot = root === '.' ? '.' : `orgs/${id}`;
  if (root !== undefined && root !== fixedRoot) {
    throw new TypeError(`observogram store: an org's root is '.' (the default org, asked for explicitly) or 'orgs/${id}', not ${JSON.stringify(root)}`);
  }
  if (createdAt !== undefined && (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)))) {
    throw new TypeError('observogram store: createdAt is an ISO timestamp');
  }
  if (getOrg(db, id)) throw new Error(`observogram store: org ${JSON.stringify(id)} exists or existed — a slug is never reused`);
  return rowToOrg(prepare(db, 'INSERT INTO orgs (id, name, root, created_at) VALUES (?, ?, ?, ?) RETURNING *').get(id, name, fixedRoot, createdAt ?? nowIso()));
}

// Deployment event: org_id NULL on the audit row.
export function createOrg(db, actor, { id, name, root }) {
  return atomic(db, () => {
    const org = insertOrgRow(db, { id, name, root });
    writeAudit(db, actor, { action: 'org.create', targetKind: 'org', targetId: id, detail: { name, root: org.root } });
    return org;
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

// The one offline root change (docs/STORE_PLAN.md §4): the default org's
// '.' becomes 'orgs/<id>' when its flat entries moved there — the in-place
// export, and the replace's root change. Only with the server stopped or
// inside boot step 3 (tenancy.mjs caches roots per handle). An org-level
// change: the row carries the org's id.
export function setOrgRoot(db, actor, id, root) {
  return atomic(db, () => {
    const org = getOrg(db, id);
    if (!org || org.removedAt) throw notFound('org', id);
    if (root !== `orgs/${id}`) {
      throw new TypeError(`observogram store: an org's root changes only from '.' to 'orgs/${id}', not to ${JSON.stringify(root)}`);
    }
    if (org.root === root) return org;
    prepare(db, 'UPDATE orgs SET root = ? WHERE id = ?').run(root, id);
    writeAudit(db, actor, { orgId: id, action: 'org.root', targetKind: 'org', targetId: id, detail: { from: org.root, to: root } });
    return getOrg(db, id);
  });
}
