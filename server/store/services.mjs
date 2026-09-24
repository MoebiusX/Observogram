// server/store/services.mjs — services (context-scoped; docs/STORE_PLAN.md
// §2). Every call reads currentOrg() and touches only that org's rows; a
// call outside runWithOrg() throws. tier is the service's criticality (the
// pack's bindings.criticality vocabulary), not a library minTier.

import { atomic, nowIso, prepare } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { fromJson, notFound, optionalText, requireOrg, requireText, setClause, toJson } from './rows.mjs';

const REPO = 'services';

export function rowToService(r) {
  if (!r) return null;
  return {
    id: r.id, orgId: r.org_id, slug: r.slug, name: r.name, owners: fromJson(r.owners, []),
    tier: r.tier, description: r.description, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function requireOwners(owners) {
  if (!Array.isArray(owners) || owners.some((o) => typeof o !== 'string')) {
    throw new TypeError('observogram store: owners is an array of strings');
  }
  return owners;
}

export function getService(db, id) {
  const org = requireOrg(REPO);
  return rowToService(prepare(db, 'SELECT * FROM services WHERE org_id = ? AND id = ?').get(org, id));
}

export function getServiceBySlug(db, slug) {
  const org = requireOrg(REPO);
  return rowToService(prepare(db, 'SELECT * FROM services WHERE org_id = ? AND slug = ?').get(org, slug));
}

export function listServices(db) {
  const org = requireOrg(REPO);
  return prepare(db, 'SELECT * FROM services WHERE org_id = ? ORDER BY slug').all(org).map(rowToService);
}

export function createService(db, actor, { slug, name, owners = [], tier = null, description = null }) {
  const org = requireOrg(REPO);
  requireText(slug, 'slug');
  requireText(name, 'name');
  const at = nowIso();
  return atomic(db, () => {
    const row = prepare(db, `INSERT INTO services (org_id, slug, name, owners, tier, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(
      org, slug, name, toJson(requireOwners(owners)), optionalText(tier, 'tier'), optionalText(description, 'description', { max: 4000 }), at, at);
    writeAudit(db, actor, { orgId: org, action: 'service.create', targetKind: 'service', targetId: slug });
    return rowToService(row);
  });
}

export function updateService(db, actor, id, patch) {
  const org = requireOrg(REPO);
  const values = {
    slug: patch.slug === undefined ? undefined : requireText(patch.slug, 'slug'),
    name: patch.name === undefined ? undefined : requireText(patch.name, 'name'),
    owners: patch.owners === undefined ? undefined : toJson(requireOwners(patch.owners)),
    tier: patch.tier === undefined ? undefined : optionalText(patch.tier, 'tier'),
    description: patch.description === undefined ? undefined : optionalText(patch.description, 'description', { max: 4000 }),
  };
  const { sql, params } = setClause(values, { slug: 'slug', name: 'name', owners: 'owners', tier: 'tier', description: 'description' });
  return atomic(db, () => {
    const current = getService(db, id);
    if (!current) throw notFound('service', id);
    if (!sql) return current;
    prepare(db, `UPDATE services SET ${sql}, updated_at = :updated_at WHERE org_id = :org_id AND id = :id`)
      .run({ ...params, updated_at: nowIso(), org_id: org, id });
    writeAudit(db, actor, { orgId: org, action: 'service.update', targetKind: 'service', targetId: current.slug, detail: { fields: Object.keys(params) } });
    return getService(db, id);
  });
}

// Deletes the service with its environments and pack links (ON DELETE CASCADE).
export function deleteService(db, actor, id) {
  const org = requireOrg(REPO);
  return atomic(db, () => {
    const current = getService(db, id);
    if (!current) throw notFound('service', id);
    prepare(db, 'DELETE FROM services WHERE org_id = ? AND id = ?').run(org, id);
    writeAudit(db, actor, { orgId: org, action: 'service.delete', targetKind: 'service', targetId: current.slug });
    return current;
  });
}
