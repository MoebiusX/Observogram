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
// objectives is the SLO objectives stated for the service in the studio, for
// the SLOs whose own is the scan's guess (studio/slo-objectives.mjs): { slos:
// { '<slo id>': { objective, window, by, at } } } as parseObjectives wrote it,
// or null. Kept the same way, under slo_objectives:<orgId>:<serviceId>.
//
// agreement is the service's operational agreement as the studio keeps it
// (studio/agreement.mjs): { versions: [{ source: { document, version,
// effective }, commitments: [...], by, at }] } as parseAgreement wrote it,
// newest last, or null. Kept the same way, under agreement:<orgId>:<serviceId>.
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
//
// livePacks is the export of live an environment is checked against in
// place of its MCP endpoint (server/service-packs.mjs): { [environment
// name]: { packId, name, uploadedAt, bytes } }, {} for none. Kept the same
// way, under live_packs:<orgId>:<serviceId>.
//
// liveScopes is the scope each environment's live read applies (the snapshot
// scope's fields, tools/lib/live-fetch.mjs normalizeScope, compact):
// { [environment name]: { metricPrefixes?, folderUids?, datasourceUid?,
// metricExclude?, ruleGroups? } }, {} for none (the org's configured snapshot
// scope, else none). Kept the same way, under live_scopes:<orgId>:<serviceId>.
//
// envSurfaces is the deployment surface each environment's Run reads alone
// (tools/lib/crawler.mjs DEPLOYMENT_SURFACES: kubernetes, eks,
// local-kubernetes, compose): { [environment name]: surface } as
// parseEnvSurfaces wrote it, {} for none — every environment of the service
// then reads every file. Kept the same way, under env_surfaces:<orgId>:<serviceId>.

import { atomic, nowIso, prepare } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { getMetaJson, putMeta } from './meta.mjs';
import { fromJson, notFound, optionalText, requireOrg, requireText, setClause, toJson } from './rows.mjs';

const REPO = 'services';

export const gradeOffKey = (orgId, serviceId) => `grade_off:${orgId}:${serviceId}`;
export const setAsideKey = (orgId, serviceId) => `set_aside:${orgId}:${serviceId}`;
export const targetsKey = (orgId, serviceId) => `mttx_targets:${orgId}:${serviceId}`;
export const objectivesKey = (orgId, serviceId) => `slo_objectives:${orgId}:${serviceId}`;
export const agreementKey = (orgId, serviceId) => `agreement:${orgId}:${serviceId}`;
export const chaosRunsKey = (orgId, serviceId) => `chaos_runs:${orgId}:${serviceId}`;
export const envRefsKey = (orgId, serviceId) => `env_refs:${orgId}:${serviceId}`;
export const livePacksKey = (orgId, serviceId) => `live_packs:${orgId}:${serviceId}`;
export const liveScopesKey = (orgId, serviceId) => `live_scopes:${orgId}:${serviceId}`;
export const envSurfacesKey = (orgId, serviceId) => `env_surfaces:${orgId}:${serviceId}`;

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

// The stored agreement, or null when there is none; damage is named, as above.
const agreementShape = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.versions) && v.versions.length > 0
  && v.versions.every((x) => !!x && typeof x === 'object' && !Array.isArray(x) && !!x.source && typeof x.source === 'object' && Array.isArray(x.commitments));
function storedAgreement(db, orgId, serviceId) {
  const key = agreementKey(orgId, serviceId);
  const value = getMetaJson(db, key, null);
  if (value === null) return null;
  if (!agreementShape(value)) throw new Error(`observogram store: schema_meta ${key} is not a service's agreement`);
  return value;
}

// The stored objectives, or null when there are none; damage is named, as above.
const objectivesShape = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && !!v.slos && typeof v.slos === 'object' && !Array.isArray(v.slos)
  && Object.values(v.slos).every((e) => !!e && typeof e === 'object' && !Array.isArray(e) && typeof e.objective === 'number' && typeof e.window === 'string');
function storedObjectives(db, orgId, serviceId) {
  const key = objectivesKey(orgId, serviceId);
  const value = getMetaJson(db, key, null);
  if (value === null) return null;
  if (!objectivesShape(value)) throw new Error(`observogram store: schema_meta ${key} is not a service's objectives`);
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

// A map of environment names to live exports: each { packId, name } strings at least.
const isLivePackMap = (x) => !!x && typeof x === 'object' && !Array.isArray(x)
  && Object.values(x).every((v) => !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.packId === 'string' && v.packId !== '' && typeof v.name === 'string');

// The stored live exports by environment, or {} when there are none; damage is named, as above.
function storedLivePacks(db, orgId, serviceId) {
  const key = livePacksKey(orgId, serviceId);
  const value = getMetaJson(db, key, {});
  if (!isLivePackMap(value)) throw new Error(`observogram store: schema_meta ${key} is not a map of live exports`);
  return value;
}

// A map of environment names to live scopes: each a plain object with at least one field.
const isScopeMap = (x) => !!x && typeof x === 'object' && !Array.isArray(x)
  && Object.values(x).every((v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0);

// The stored live scopes by environment, or {} when there are none; damage is named, as above.
function storedLiveScopes(db, orgId, serviceId) {
  const key = liveScopesKey(orgId, serviceId);
  const value = getMetaJson(db, key, {});
  if (!isScopeMap(value)) throw new Error(`observogram store: schema_meta ${key} is not a map of live scopes`);
  return value;
}

// The stored deployment surfaces by environment, or {} when there are none; damage is named, as above.
// The shape is the branches' (a map of non-empty strings); the admin module owns which surfaces there are.
function storedEnvSurfaces(db, orgId, serviceId) {
  const key = envSurfacesKey(orgId, serviceId);
  const value = getMetaJson(db, key, {});
  if (!isRefMap(value)) throw new Error(`observogram store: schema_meta ${key} is not a map of environment surfaces`);
  return value;
}

// The service as the callers read it: the row, and its switches, set-asides, targets and recorded chaos runs beside it.
function withGradeOff(db, service) {
  if (!service) return null;
  const { createdAt, updatedAt, ...rest } = service;
  return {
    ...rest, gradeOff: storedGradeOff(db, service.orgId, service.id), setAside: storedSetAside(db, service.orgId, service.id),
    targets: storedTargets(db, service.orgId, service.id), objectives: storedObjectives(db, service.orgId, service.id), agreement: storedAgreement(db, service.orgId, service.id), chaosRuns: storedChaosRuns(db, service.orgId, service.id),
    envRefs: storedEnvRefs(db, service.orgId, service.id), livePacks: storedLivePacks(db, service.orgId, service.id),
    liveScopes: storedLiveScopes(db, service.orgId, service.id), envSurfaces: storedEnvSurfaces(db, service.orgId, service.id), createdAt, updatedAt,
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

// null (no key), or { versions: [...] } with at least one (the admin module owns its shape).
function agreementJson(agreement) {
  if (agreement === null || agreement === undefined) return null;
  if (!agreementShape(agreement)) throw new TypeError('observogram store: agreement is { versions: [{ source, commitments, by, at }] } or null');
  return JSON.stringify(agreement);
}

// null (no key), or { slos: { id: { objective, window, … } } } with at least one entry (the admin module owns its shape).
function objectivesJson(objectives) {
  if (objectives === null || objectives === undefined) return null;
  if (!objectivesShape(objectives)) throw new TypeError('observogram store: objectives is { slos: { <slo id>: { objective, window, by, at } } } or null');
  return Object.keys(objectives.slos).length ? JSON.stringify(objectives) : null;
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

// A map of environment names to live exports (the admin module owns their shape); none is no key.
// The audit's view of a live-scope map: each environment's scope fields, never their values.
const scopeFieldsOf = (map) => Object.fromEntries(Object.entries(map || {}).map(([env, scope]) => [env, Object.keys(scope || {})]));

function liveScopesJson(liveScopes) {
  if (!isScopeMap(liveScopes)) throw new TypeError('observogram store: liveScopes is { [environment]: scope }');
  return Object.keys(liveScopes).length ? JSON.stringify(liveScopes) : null;
}

// A map of environment names to deployment surfaces (the admin module owns its rules); none is no key.
function envSurfacesJson(envSurfaces) {
  if (!isRefMap(envSurfaces)) throw new TypeError('observogram store: envSurfaces is { [environment]: surface }');
  return Object.keys(envSurfaces).length ? JSON.stringify(envSurfaces) : null;
}

function livePacksJson(livePacks) {
  if (!isLivePackMap(livePacks)) throw new TypeError('observogram store: livePacks is { [environment]: { packId, name, uploadedAt, bytes } }');
  return Object.keys(livePacks).length ? JSON.stringify(livePacks) : null;
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

// The packs a service of the org stands on as they are (Overview's pack files): each `pack`
// repository's packId and each environment's export of live. The registry never evicts or
// replaces one of them (server/pack-registry.mjs registerPack). A damaged record pins nothing.
export function pinnedPackIds(db) {
  const org = requireOrg(REPO);
  const out = new Set();
  for (const r of prepare(db, 'SELECT id, repository FROM services WHERE org_id = ?').all(org)) {
    const repo = fromJson(r.repository ?? null, null);
    if (repo?.kind === 'pack' && typeof repo.packId === 'string') out.add(repo.packId);
    try { for (const v of Object.values(storedLivePacks(db, org, r.id))) out.add(v.packId); } catch { /* damaged: pins nothing */ }
  }
  return out;
}

export function listServices(db) {
  const org = requireOrg(REPO);
  return prepare(db, 'SELECT * FROM services WHERE org_id = ? ORDER BY slug').all(org).map((r) => withGradeOff(db, rowToService(r)));
}

// detail extends the service.create row ({ via: 'pack', pack } when a
// register or the import created it).
export function createService(db, actor, { slug, name, owners = [], tier = null, description = null, repository = null, targets = null, envRefs = {}, liveScopes = {}, envSurfaces = {} }, { detail = null } = {}) {
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
    putMeta(db, objectivesKey(org, row.id), null);
    putMeta(db, agreementKey(org, row.id), null);
    putMeta(db, chaosRunsKey(org, row.id), null);
    putMeta(db, envRefsKey(org, row.id), envRefsJson(envRefs));
    putMeta(db, livePacksKey(org, row.id), null);
    putMeta(db, liveScopesKey(org, row.id), liveScopesJson(liveScopes));
    putMeta(db, envSurfacesKey(org, row.id), envSurfacesJson(envSurfaces));
    // The targets as they start, the same shape an update's row names: the profile and the two durations.
    // …and the branches by environment it starts with, when it names any.
    const created = {
      ...(targets ? { targets: { profile: targets.profile, mttd: targets.mttd, mttr: targets.mttr } } : {}),
      ...(Object.keys(envRefs || {}).length ? { envRefs } : {}),
      ...(Object.keys(liveScopes || {}).length ? { liveScopes: scopeFieldsOf(liveScopes) } : {}),
      ...(Object.keys(envSurfaces || {}).length ? { envSurfaces } : {}),
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
  const objectives = patch.objectives === undefined ? undefined : objectivesJson(patch.objectives);
  const agreement = patch.agreement === undefined ? undefined : agreementJson(patch.agreement);
  const chaosRuns = patch.chaosRuns === undefined ? undefined : chaosRunsJson(patch.chaosRuns);
  const envRefs = patch.envRefs === undefined ? undefined : envRefsJson(patch.envRefs);
  const livePacks = patch.livePacks === undefined ? undefined : livePacksJson(patch.livePacks);
  const liveScopes = patch.liveScopes === undefined ? undefined : liveScopesJson(patch.liveScopes);
  const envSurfaces = patch.envSurfaces === undefined ? undefined : envSurfacesJson(patch.envSurfaces);
  const { sql, params, fields: columns } = setClause(values, { slug: 'slug', name: 'name', owners: 'owners', tier: 'tier', description: 'description', repository: 'repository' });
  const fields = [...columns, ...(patch.gradeOff === undefined ? [] : ['gradeOff']), ...(patch.setAside === undefined ? [] : ['setAside']), ...(patch.targets === undefined ? [] : ['targets']), ...(patch.objectives === undefined ? [] : ['objectives']), ...(patch.agreement === undefined ? [] : ['agreement']), ...(patch.chaosRuns === undefined ? [] : ['chaosRuns']), ...(patch.envRefs === undefined ? [] : ['envRefs']), ...(patch.livePacks === undefined ? [] : ['livePacks']), ...(patch.liveScopes === undefined ? [] : ['liveScopes']), ...(patch.envSurfaces === undefined ? [] : ['envSurfaces'])];
  // The row names the criteria now off, so the audit says what the grade stopped counting,
  // and how many differences are set aside on each side (the list itself can be long).
  const sideCount = (side) => patch.setAside.filter((x) => x.side === side).length;
  const detail = {
    fields,
    ...(patch.gradeOff === undefined ? {} : { gradeOff: patch.gradeOff.map((x) => x.key) }),
    ...(patch.setAside === undefined ? {} : { setAside: { declared: sideCount('declared'), live: sideCount('live') } }),
    // The targets as they now are: the profile and the two durations (none: null).
    ...(patch.targets === undefined ? {} : { targets: patch.targets ? { profile: patch.targets.profile, mttd: patch.targets.mttd, mttr: patch.targets.mttr } : null }),
    // The stated objectives as they now are: each SLO's objective and window (none: null).
    ...(patch.objectives === undefined ? {} : { objectives: patch.objectives ? Object.fromEntries(Object.entries(patch.objectives.slos).map(([id, e]) => [id, `${e.objective}/${e.window}`])) : null }),
    // The agreement as it now is: its source document and how much it holds (none: null).
    ...(patch.agreement === undefined ? {} : { agreement: patch.agreement ? (() => {
      const v = patch.agreement.versions[patch.agreement.versions.length - 1];
      return { document: v.source.document, version: v.source.version, effective: v.source.effective, commitments: v.commitments.length, versions: patch.agreement.versions.length };
    })() : null }),
    // The recorded chaos runs: how many, and how many of each outcome (the list itself can be long).
    ...(patch.chaosRuns === undefined ? {} : { chaosRuns: { runs: patch.chaosRuns.length, pass: patch.chaosRuns.filter((x) => x.outcome === 'pass').length, fail: patch.chaosRuns.filter((x) => x.outcome === 'fail').length } }),
    // The branches by environment as they now are.
    ...(patch.envRefs === undefined ? {} : { envRefs: patch.envRefs }),
    // The live exports by environment: each one's file name (the pack ids are the pack rows').
    ...(patch.livePacks === undefined ? {} : { livePacks: Object.fromEntries(Object.entries(patch.livePacks).map(([env, p]) => [env, p.name])) }),
    ...(patch.liveScopes === undefined ? {} : { liveScopes: scopeFieldsOf(patch.liveScopes) }),
    // The deployment surfaces by environment as they now are.
    ...(patch.envSurfaces === undefined ? {} : { envSurfaces: patch.envSurfaces }),
  };
  return atomic(db, () => {
    const current = rowOf(db, org, id);
    if (!current) throw notFound('service', id);
    if (!fields.length) return getService(db, id);
    if (gradeOff !== undefined) putMeta(db, gradeOffKey(org, id), gradeOff);
    if (setAside !== undefined) putMeta(db, setAsideKey(org, id), setAside);
    if (targets !== undefined) putMeta(db, targetsKey(org, id), targets);
    if (objectives !== undefined) putMeta(db, objectivesKey(org, id), objectives);
    if (agreement !== undefined) putMeta(db, agreementKey(org, id), agreement);
    if (chaosRuns !== undefined) putMeta(db, chaosRunsKey(org, id), chaosRuns);
    if (envRefs !== undefined) putMeta(db, envRefsKey(org, id), envRefs);
    if (livePacks !== undefined) putMeta(db, livePacksKey(org, id), livePacks);
    if (liveScopes !== undefined) putMeta(db, liveScopesKey(org, id), liveScopes);
    if (envSurfaces !== undefined) putMeta(db, envSurfacesKey(org, id), envSurfaces);
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
    try { current = withGradeOff(db, row); } catch (_) { current = { ...row, gradeOff: [], setAside: [], targets: null, objectives: null, agreement: null, chaosRuns: [], envRefs: {}, livePacks: {}, liveScopes: {}, envSurfaces: {} }; }
    prepare(db, 'DELETE FROM services WHERE org_id = ? AND id = ?').run(org, id);
    putMeta(db, gradeOffKey(org, id), null);
    putMeta(db, setAsideKey(org, id), null);
    putMeta(db, targetsKey(org, id), null);
    putMeta(db, objectivesKey(org, id), null);
    putMeta(db, agreementKey(org, id), null);
    putMeta(db, chaosRunsKey(org, id), null);
    putMeta(db, envRefsKey(org, id), null);
    putMeta(db, livePacksKey(org, id), null);
    putMeta(db, liveScopesKey(org, id), null);
    putMeta(db, envSurfacesKey(org, id), null);
    writeAudit(db, actor, { orgId: org, action: 'service.delete', targetKind: 'service', targetId: current.slug, detail });
    return current;
  });
}
