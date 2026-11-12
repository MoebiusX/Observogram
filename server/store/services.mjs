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
//
// setAside is the differences with live the service's grade leaves out — the
// declared things under development, the live things not this service's
// (studio/set-asides.mjs): [{ key, side, layer, label, kind, note, until, by,
// at }] as parseSetAside wrote it, [] for none. Kept the same way, under
// set_aside:<orgId>:<serviceId>.
//
// targets is the MTTD / MTTR targets given the service in the studio, for a
// repository that states none (studio/mttx-targets.mjs): { profile, mttd,
// mttr, by, at } as parseTargets wrote it, or null. Kept the same way, under
// mttx_targets:<orgId>:<serviceId>.
//
// chaosRuns is the chaos runs recorded in the studio for the service's
// experiments (studio/chaos-runs.mjs): [{ experiment, at, outcome,
// environment, mttd, alertsFired, note, by, recordedAt }] as parseChaosRuns
// wrote it, [] for none. Kept the same way, under chaos_runs:<orgId>:<serviceId>.
//
// envRefs is the branch each environment's Run reads, where it is not the
// repository's own (`repository.ref`): { [environment name]: branch } as
// parseEnvRefs wrote it, {} for none. Kept the same way, under
// env_refs:<orgId>:<serviceId>.

import { atomic, nowIso, prepare } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { getMetaJson, putMeta } from './meta.mjs';
import { fromJson, notFound, optionalText, requireOrg, requireText, setClause, toJson } from './rows.mjs';

const REPO = 'services';

export const gradeOffKey = (orgId, serviceId) => `grade_off:${orgId}:${serviceId}`;
export const setAsideKey = (orgId, serviceId) => `set_aside:${orgId}:${serviceId}`;
export const targetsKey = (orgId, serviceId) => `mttx_targets:${orgId}:${serviceId}`;
export const chaosRunsKey = (orgId, serviceId) => `chaos_runs:${orgId}:${serviceId}`;
export const envRefsKey = (orgId, serviceId) => `env_refs:${orgId}:${serviceId}`;

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

// The stored set-asides, or [] when there are none; damage is named, as above.
function storedSetAside(db, orgId, serviceId) {
  const key = setAsideKey(orgId, serviceId);
  const value = getMetaJson(db, key, []);
  if (!Array.isArray(value) || value.some((x) => !x || typeof x !== 'object' || Array.isArray(x) || typeof x.key !== 'string' || typeof x.side !== 'string')) {
    throw new Error(`observogram store: schema_meta ${key} is not a list of set-asides`);
  }
  return value;
}

// The stored targets, or null when there are none; damage is named, as above.
function storedTargets(db, orgId, serviceId) {
  const key = targetsKey(orgId, serviceId);
  const value = getMetaJson(db, key, null);
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.profile !== 'string' || typeof value.mttd !== 'string' || typeof value.mttr !== 'string') {
    throw new Error(`observogram store: schema_meta ${key} is not a service's targets`);
  }
  return value;
}

// The stored chaos runs, or [] when there are none; damage is named, as above.
function storedChaosRuns(db, orgId, serviceId) {
  const key = chaosRunsKey(orgId, serviceId);
  const value = getMetaJson(db, key, []);
  if (!Array.isArray(value) || value.some((x) => !x || typeof x !== 'object' || Array.isArray(x) || typeof x.experiment !== 'string' || typeof x.at !== 'string')) {
    throw new Error(`observogram store: schema_meta ${key} is not a list of chaos runs`);
  }
  return value;
}

// A map of environment names to branches: a plain object whose every value is a non-empty string.
const isRefMap = (x) => !!x && typeof x === 'object' && !Array.isArray(x) && Object.values(x).every((v) => typeof v === 'string' && v !== '');

// The stored branches by environment, or {} when there are none; damage is named, as above.
function storedEnvRefs(db, orgId, serviceId) {
  const key = envRefsKey(orgId, serviceId);
  const value = getMetaJson(db, key, {});
  if (!isRefMap(value)) throw new Error(`observogram store: schema_meta ${key} is not a map of environment branches`);
  return value;
}

// The service as the callers read it: the row, and its switches, set-asides, targets and recorded chaos runs beside it.
function withGradeOff(db, service) {
  if (!service) return null;
  const { createdAt, updatedAt, ...rest } = service;
  return {
    ...rest, gradeOff: storedGradeOff(db, service.orgId, service.id), setAside: storedSetAside(db, service.orgId, service.id),
    targets: storedTargets(db, service.orgId, service.id), chaosRuns: storedChaosRuns(db, service.orgId, service.id),
    envRefs: storedEnvRefs(db, service.orgId, service.id), createdAt, updatedAt,
  };
}

// An array of plain objects (the admin module owns their shape); none is no key.
function gradeOffJson(gradeOff) {
  if (!Array.isArray(gradeOff) || gradeOff.some((x) => !x || typeof x !== 'object' || Array.isArray(x) || typeof x.key !== 'string')) {
    throw new TypeError('observogram store: gradeOff is an array of { key, reason, by, at }');
  }
  return gradeOff.length ? JSON.stringify(gradeOff) : null;
}

// An array of plain objects with a key and a side (the admin module owns their shape); none is no key.
function setAsideJson(setAside) {
  if (!Array.isArray(setAside) || setAside.some((x) => !x || typeof x !== 'object' || Array.isArray(x) || typeof x.key !== 'string' || typeof x.side !== 'string')) {
    throw new TypeError('observogram store: setAside is an array of { key, side, layer, label, kind, note, until, by, at }');
  }
  return setAside.length ? JSON.stringify(setAside) : null;
}

// null (no key), or a plain object with a profile and two durations (the admin module owns its shape).
function targetsJson(targets) {
  if (targets === null || targets === undefined) return null;
  if (typeof targets !== 'object' || Array.isArray(targets) || typeof targets.profile !== 'string' || typeof targets.mttd !== 'string' || typeof targets.mttr !== 'string') {
    throw new TypeError('observogram store: targets is { profile, mttd, mttr, by, at } or null');
  }
  return JSON.stringify(targets);
}

// An array of plain objects with an experiment and a time (the admin module owns their shape); none is no key.
function chaosRunsJson(chaosRuns) {
  if (!Array.isArray(chaosRuns) || chaosRuns.some((x) => !x || typeof x !== 'object' || Array.isArray(x) || typeof x.experiment !== 'string' || typeof x.at !== 'string')) {
    throw new TypeError('observogram store: chaosRuns is an array of { experiment, at, outcome, environment, mttd, alertsFired, note, by, recordedAt }');
  }
  return chaosRuns.length ? JSON.stringify(chaosRuns) : null;
}

// A map of environment names to branches (the admin module owns its rules); none is no key.
function envRefsJson(envRefs) {
  if (!isRefMap(envRefs)) throw new TypeError('observogram store: envRefs is { [environment]: branch }');
  return Object.keys(envRefs).length ? JSON.stringify(envRefs) : null;
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
export function createService(db, actor, { slug, name, owners = [], tier = null, description = null, repository = null, targets = null, envRefs = {} }, { detail = null } = {}) {
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
    putMeta(db, setAsideKey(org, row.id), null);
    putMeta(db, targetsKey(org, row.id), targetsJson(targets));
    putMeta(db, chaosRunsKey(org, row.id), null);
    putMeta(db, envRefsKey(org, row.id), envRefsJson(envRefs));
    // The targets as they start, the same shape an update's row names: the profile and the two durations.
    // …and the branches by environment it starts with, when it names any.
    const created = {
      ...(targets ? { targets: { profile: targets.profile, mttd: targets.mttd, mttr: targets.mttr } } : {}),
      ...(Object.keys(envRefs || {}).length ? { envRefs } : {}),
    };
    writeAudit(db, actor, { orgId: org, action: 'service.create', targetKind: 'service', targetId: slug, detail: Object.keys(created).length ? { ...(detail || {}), ...created } : detail });
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
  const setAside = patch.setAside === undefined ? undefined : setAsideJson(patch.setAside);
  const targets = patch.targets === undefined ? undefined : targetsJson(patch.targets);
  const chaosRuns = patch.chaosRuns === undefined ? undefined : chaosRunsJson(patch.chaosRuns);
  const envRefs = patch.envRefs === undefined ? undefined : envRefsJson(patch.envRefs);
  const { sql, params, fields: columns } = setClause(values, { slug: 'slug', name: 'name', owners: 'owners', tier: 'tier', description: 'description', repository: 'repository' });
  const fields = [...columns, ...(patch.gradeOff === undefined ? [] : ['gradeOff']), ...(patch.setAside === undefined ? [] : ['setAside']), ...(patch.targets === undefined ? [] : ['targets']), ...(patch.chaosRuns === undefined ? [] : ['chaosRuns']), ...(patch.envRefs === undefined ? [] : ['envRefs'])];
  // The row names the criteria now off, so the audit says what the grade stopped counting,
  // and how many differences are set aside on each side (the list itself can be long).
  const sideCount = (side) => patch.setAside.filter((x) => x.side === side).length;
  const detail = {
    fields,
    ...(patch.gradeOff === undefined ? {} : { gradeOff: patch.gradeOff.map((x) => x.key) }),
    ...(patch.setAside === undefined ? {} : { setAside: { declared: sideCount('declared'), live: sideCount('live') } }),
    // The targets as they now are: the profile and the two durations (none: null).
    ...(patch.targets === undefined ? {} : { targets: patch.targets ? { profile: patch.targets.profile, mttd: patch.targets.mttd, mttr: patch.targets.mttr } : null }),
    // The recorded chaos runs: how many, and how many of each outcome (the list itself can be long).
    ...(patch.chaosRuns === undefined ? {} : { chaosRuns: { runs: patch.chaosRuns.length, pass: patch.chaosRuns.filter((x) => x.outcome === 'pass').length, fail: patch.chaosRuns.filter((x) => x.outcome === 'fail').length } }),
    // The branches by environment as they now are.
    ...(patch.envRefs === undefined ? {} : { envRefs: patch.envRefs }),
  };
  return atomic(db, () => {
    const current = rowOf(db, org, id);
    if (!current) throw notFound('service', id);
    if (!fields.length) return getService(db, id);
    if (gradeOff !== undefined) putMeta(db, gradeOffKey(org, id), gradeOff);
    if (setAside !== undefined) putMeta(db, setAsideKey(org, id), setAside);
    if (targets !== undefined) putMeta(db, targetsKey(org, id), targets);
    if (chaosRuns !== undefined) putMeta(db, chaosRunsKey(org, id), chaosRuns);
    if (envRefs !== undefined) putMeta(db, envRefsKey(org, id), envRefs);
    prepare(db, `UPDATE services SET ${sql ? `${sql}, ` : ''}updated_at = :updated_at WHERE org_id = :org_id AND id = :id`)
      .run({ ...params, updated_at: nowIso(), org_id: org, id });
    writeAudit(db, actor, { orgId: org, action: 'service.update', targetKind: 'service', targetId: current.slug, detail });
    return getService(db, id);
  });
}

// Deletes the service with its environments and pack links (ON DELETE
// CASCADE) and its grade criteria's and set-asides' keys; detail is the service.delete row's
// ({ environments, packLinks } — the cascaded rows write none of their own).
export function deleteService(db, actor, id, { detail = null } = {}) {
  const org = requireOrg(REPO);
  return atomic(db, () => {
    const row = rowOf(db, org, id);
    if (!row) throw notFound('service', id);
    // The record as it was, its switches with it — none when a key was damaged.
    let current;
    try { current = withGradeOff(db, row); } catch (_) { current = { ...row, gradeOff: [], setAside: [], targets: null, chaosRuns: [], envRefs: {} }; }
    prepare(db, 'DELETE FROM services WHERE org_id = ? AND id = ?').run(org, id);
    putMeta(db, gradeOffKey(org, id), null);
    putMeta(db, setAsideKey(org, id), null);
    putMeta(db, targetsKey(org, id), null);
    putMeta(db, chaosRunsKey(org, id), null);
    putMeta(db, envRefsKey(org, id), null);
    writeAudit(db, actor, { orgId: org, action: 'service.delete', targetKind: 'service', targetId: current.slug, detail });
    return current;
  });
}
