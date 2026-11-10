// server/store/services.mjs — services (context-scoped; docs/STORE_PLAN.md
// §2). Every call reads currentOrg() and touches only that org's rows; a
// call outside runWithOrg() throws. tier is the service's criticality (the
// pack's bindings.criticality vocabulary), not a library minTier.
// repository is where the service's declaration lives (schema v3): an object
// { kind, location, ref } as server/service-admin.mjs parseRepository
// normalised it, or null.
//
// gradeOff is the grade criteria the service is not graded on:
// [{ key, reason, by, at }] as parseGradeOff wrote it, [] while every
// criterion is graded. It is kept beside the row, not in it — one
// schema_meta key per service, grade_off:<orgId>:<serviceId>, as the org's
// repository sources are (server/store/orgs.mjs) — so it takes no schema
// step: every build opens the same database, and one that knows nothing of
// it simply never reads the key. The key goes with the service's deletion,
// in the same transaction.

import { atomic, nowIso, prepare } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { getMetaJson, putMeta } from './meta.mjs';
import { fromJson, notFound, optionalText, requireOrg, requireText, setClause, toJson } from './rows.mjs';

const REPO = 'services';

export const gradeOffKey = (orgId, serviceId) => `grade_off:${orgId}:${serviceId}`;

export function rowToService(r) {
  if (!r) return null;
  return {
    id: r.id, orgId: r.org_id, slug: r.slug, name: r.name, owners: fromJson(r.owners, []),
    tier: r.tier, description: r.description, repository: fromJson(r.repository ?? null, null),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// The stored list, or [] when there is none. A value that is not a list of
// { key, … } was not written by this code: damage, named.
function storedGradeOff(db, orgId, serviceId) {
  const key = gradeOffKey(orgId, serviceId);
  const value = getMetaJson(db, key, []);
  if (!Array.isArray(value) || value.some((x) => !x || typeof x !== 'object' || Array.isArray(x) || typeof x.key !== 'string')) {
    throw new Error(`observogram store: schema_meta ${key} is not a list of grade criteria`);
  }
  return value;
}

// The service as the callers read it: the row, and its switches beside it.
function withGradeOff(db, service) {
  if (!service) return null;
  const { createdAt, updatedAt, ...rest } = service;
  return { ...rest, gradeOff: storedGradeOff(db, service.orgId, service.id), createdAt, updatedAt };
}

// An array of plain objects (the admin module owns their shape); none is no key.
function gradeOffJson(gradeOff) {
  if (!Array.isArray(gradeOff) || gradeOff.some((x) => !x || typeof x !== 'object' || Array.isArray(x) || typeof x.key !== 'string')) {
    throw new TypeError('observogram store: gradeOff is an array of { key, reason, by, at }');
  }
  return gradeOff.length ? JSON.stringify(gradeOff) : null;
}

// null, or a plain object (the admin module owns its shape).
function repositoryJson(repository) {
  if (repository === null || repository === undefined) return null;
  if (typeof repository !== 'object' || Array.isArray(repository)) throw new TypeError('observogram store: repository is an object or null');
  return JSON.stringify(repository);
}

function requireOwners(owners) {
  if (!Array.isArray(owners) || owners.some((o) => typeof o !== 'string')) {
    throw new TypeError('observogram store: owners is an array of strings');
  }
  return owners;
}

// The row alone (no switches read): what an update or a delete checks, so a
// damaged key never stops the write that replaces it or the deletion that removes it.
function rowOf(db, org, id) {
  return rowToService(prepare(db, 'SELECT * FROM services WHERE org_id = ? AND id = ?').get(org, id));
}

export function getService(db, id) {
  const org = requireOrg(REPO);
  return withGradeOff(db, rowToService(prepare(db, 'SELECT * FROM services WHERE org_id = ? AND id = ?').get(org, id)));
}

export function getServiceBySlug(db, slug) {
  const org = requireOrg(REPO);
  return withGradeOff(db, rowToService(prepare(db, 'SELECT * FROM services WHERE org_id = ? AND slug = ?').get(org, slug)));
}

export function listServices(db) {
  const org = requireOrg(REPO);
  return prepare(db, 'SELECT * FROM services WHERE org_id = ? ORDER BY slug').all(org).map((r) => withGradeOff(db, rowToService(r)));
}

// detail extends the service.create row ({ via: 'pack', pack } when a
// register or the import created it).
export function createService(db, actor, { slug, name, owners = [], tier = null, description = null, repository = null }, { detail = null } = {}) {
  const org = requireOrg(REPO);
  requireText(slug, 'slug');
  requireText(name, 'name');
  const at = nowIso();
  return atomic(db, () => {
    const row = prepare(db, `INSERT INTO services (org_id, slug, name, owners, tier, description, repository, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(
      org, slug, name, toJson(requireOwners(owners)), optionalText(tier, 'tier'), optionalText(description, 'description', { max: 4000 }),
      repositoryJson(repository), at, at);
    // An id is reused after the highest one is deleted (a rowid, no AUTOINCREMENT): a key that
    // outlived its service (one deleted other than by deleteService) is no switch of this one.
    putMeta(db, gradeOffKey(org, row.id), null);
    writeAudit(db, actor, { orgId: org, action: 'service.create', targetKind: 'service', targetId: slug, detail });
    return withGradeOff(db, rowToService(row));
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
    repository: patch.repository === undefined ? undefined : repositoryJson(patch.repository),
  };
  const gradeOff = patch.gradeOff === undefined ? undefined : gradeOffJson(patch.gradeOff);
  const { sql, params, fields: columns } = setClause(values, { slug: 'slug', name: 'name', owners: 'owners', tier: 'tier', description: 'description', repository: 'repository' });
  const fields = patch.gradeOff === undefined ? columns : [...columns, 'gradeOff'];
  // The row names the criteria now off, so the audit says what the grade stopped counting.
  const detail = { fields, ...(patch.gradeOff === undefined ? {} : { gradeOff: patch.gradeOff.map((x) => x.key) }) };
  return atomic(db, () => {
    const current = rowOf(db, org, id);
    if (!current) throw notFound('service', id);
    if (!fields.length) return getService(db, id);
    if (gradeOff !== undefined) putMeta(db, gradeOffKey(org, id), gradeOff);
    prepare(db, `UPDATE services SET ${sql ? `${sql}, ` : ''}updated_at = :updated_at WHERE org_id = :org_id AND id = :id`)
      .run({ ...params, updated_at: nowIso(), org_id: org, id });
    writeAudit(db, actor, { orgId: org, action: 'service.update', targetKind: 'service', targetId: current.slug, detail });
    return getService(db, id);
  });
}

// Deletes the service with its environments and pack links (ON DELETE
// CASCADE) and its grade criteria's key; detail is the service.delete row's
// ({ environments, packLinks } — the cascaded rows write none of their own).
export function deleteService(db, actor, id, { detail = null } = {}) {
  const org = requireOrg(REPO);
  return atomic(db, () => {
    const row = rowOf(db, org, id);
    if (!row) throw notFound('service', id);
    // The record as it was, its switches with it — none when its key was damaged.
    let current;
    try { current = withGradeOff(db, row); } catch (_) { current = { ...row, gradeOff: [] }; }
    prepare(db, 'DELETE FROM services WHERE org_id = ? AND id = ?').run(org, id);
    putMeta(db, gradeOffKey(org, id), null);
    writeAudit(db, actor, { orgId: org, action: 'service.delete', targetKind: 'service', targetId: current.slug, detail });
    return current;
  });
}
