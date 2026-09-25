// server/store/import.mjs — the legacy import (docs/STORE_PLAN.md §4 step 3):
// users.json and orgs.json into the store, once, at the first start of a
// store build.
//
//   readLegacy(db, ctx)                       the strict reads (legacy-files.mjs)
//   planImport(db, legacy, ctx, migration)    reads only: the rows, the meta and the report
//   applyImport(db, plan, ctx)                one tx(): the rows, the meta, ONE store.import audit row
//   formatReport(report)                      the boot log lines
//
// The boot plans twice: before anything moves (plan1: validation, and the
// org count its checks refuse on) and after the flat-workspace migration
// (plan2: what is imported and hashed). Both apply the repositories' own
// field rules (textOk, validOrgId, the roles map) here, before the first
// write, so applyImport never meets a value the repositories refuse after
// the migration has moved data. A value that fails a rule is never a
// refusal: it is dropped (or nulled) and listed in the report.
//
// `ctx` is the boot context: { base, now, dbPath, identityMode ('local' |
// 'oidc'), issuerRaw, issuerKey, usersFileEnv, joinRoleEnv }.

import { join } from 'node:path';
import { tx } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { getMeta, putMeta, storeId } from './meta.mjs';
import { getOrg, insertOrgRow, listOrgs } from './orgs.mjs';
import { insertMembershipRow } from './memberships.mjs';
import { getUserByLogin, insertUserRow, listUsers } from './users.mjs';
import { textOk } from './rows.mjs';
import { mapLegacyRole, oidcLogin, SYSTEM } from './identity.mjs';
import { validOrgId } from '../org-context.mjs';
import {
  hasData, legacyUsersPath, orgsFilePath, readOrgsFileStrict, readUsersFileStrict, sha256Of, usersHashKey,
} from './legacy-files.mjs';

const NAME_MAX = 200;
const EMAIL_MAX = 320;
const SUB_MAX = 2000;
const ORGS_KEY = 'orgs.json';

// ---------- reading ----------

export function readLegacy(db, ctx) {
  const importDone = getMeta(db, 'import_done');
  const usersPath = legacyUsersPath(db, ctx.base);
  const usersKey = usersHashKey(importDone ? getMeta(db, 'users_file') : ctx.usersFileEnv);
  const orgsPath = orgsFilePath(ctx.base);
  return {
    users: readUsersFileStrict(usersPath), usersPath, usersKey,
    orgs: readOrgsFileStrict(orgsPath), orgsPath,
  };
}

// The migration's shape as it WOULD come out, for plan1 (before anything
// moves), from planFlatMigration()'s result — or, when the boot does not
// migrate, the shape that says why. plan1 and plan2 take one parameter
// type.
export function projectedMigration({ flat = null, migrate, orgs }) {
  const move = flat?.move ?? [];
  return {
    moved: [...move],
    leftBehind: [...(flat?.leftBehind ?? [])],
    wroteDefault: !!(migrate && move.length > 0 && orgs?.exists && !orgs.entries.some(([id]) => id === 'default')),
    skipped: orgs?.exists && !migrate ? 'the store keeps the default org at .' : null,
  };
}

// ---------- the field rules ----------

const whyText = (value, max) => {
  if (typeof value !== 'string') return 'not a string';
  if (!value.trim()) return 'blank';
  return `longer than ${max} characters`;
};

// Optional text: a usable value, else null — silently when it was '',
// absent or null, else listed.
function optionalField(value, max, drop) {
  if (value === undefined || value === null || value === '') return null;
  if (textOk(value, { max })) return value;
  drop(whyText(value, max));
  return null;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------- planning ----------

export function planImport(db, legacy, ctx, migration) {
  const oidc = ctx.identityMode === 'oidc';
  const now = ctx.now;
  const report = {
    kind: 'import', at: now, storeId: storeId(db), dbPath: ctx.dbPath ?? null,
    identityMode: oidc ? 'oidc' : 'local', issuerKey: oidc ? ctx.issuerKey : null, usersFile: ctx.usersFileEnv ?? null,
    files: {
      users: { path: legacy.usersPath, present: legacy.users.exists, entries: legacy.users.exists ? legacy.users.entries.length : 0 },
      orgs: { path: legacy.orgsPath, present: legacy.orgs.exists, entries: legacy.orgs.exists ? legacy.orgs.entries.length : 0 },
    },
    migration: {
      moved: [...(migration?.moved ?? [])], leftBehind: [...(migration?.leftBehind ?? [])],
      wroteDefault: !!migration?.wroteDefault, skipped: migration?.skipped ?? null,
    },
    users: { imported: [], fromUsersFile: 0, disabled: [], conflicts: [], dropped: [], droppedFields: [] },
    orgs: { imported: [], dropped: [], conflicts: [], droppedFields: [], defaultOrg: null },
    memberships: { imported: 0, dropped: [], inexact: [], viewers: [] },
    owners: [], noOwner: false, oidcJoinRole: null, identityArmed: false, orgsJson: legacy.orgs.exists,
  };

  // users: login → planned row (users.json rows first, then OIDC member rows)
  const plannedUsers = new Map();
  const localImported = [];

  // ---- users.json (plan item 1) ----
  if (legacy.users.exists) {
    for (const [name, rec] of legacy.users.entries) {
      if (!textOk(name, { max: NAME_MAX })) {
        report.users.dropped.push({ login: name, reason: textOk(name, { max: Infinity }) ? `longer than ${NAME_MAX} characters` : 'empty' });
        continue;
      }
      if (oidc && name.startsWith(`${ctx.issuerKey}#`)) {
        report.users.conflicts.push({ login: name, reason: `has the form of an OIDC login under ${ctx.issuerKey}` });
        continue;
      }
      if (getUserByLogin(db, name) || plannedUsers.has(name)) {
        report.users.conflicts.push({ login: name, reason: 'kept the existing row' });
        continue;
      }
      const dropField = (field) => (reason) => report.users.droppedFields.push({ login: name, field, reason });
      let password = null;
      if (isPlainObject(rec.password)) password = rec.password;
      else if (rec.password !== undefined && rec.password !== null) dropField('password')('not a password record');
      let createdAt = now;
      if (rec.createdAt !== undefined && rec.createdAt !== null) {
        if (typeof rec.createdAt === 'string' && Number.isFinite(Date.parse(rec.createdAt))) createdAt = rec.createdAt;
        else dropField('createdAt')('not a timestamp — the import time is used');
      }
      const row = {
        kind: 'local', login: name, issuer: null, sub: null,
        name: optionalField(rec.name, NAME_MAX, dropField('name')),
        email: optionalField(rec.email, EMAIL_MAX, dropField('email')),
        password, mustChange: !!rec.mustChange, seededDefault: !!rec.seededDefault,
        isOwner: false, disabled: oidc, sessionEpoch: 0, createdAt,
      };
      plannedUsers.set(name, row);
      localImported.push(name);
    }
  }

  // Resolves an org member key to a login, planning an OIDC row when needed;
  // null (and a listed drop) when the key names nobody the store can hold.
  const dropMember = (org, key, reason) => report.memberships.dropped.push({ org, key, reason });
  function memberLogin(org, key) {
    if (oidc) {
      if (!textOk(key, { max: SUB_MAX })) { dropMember(org, key, 'not a usable sub'); return null; }
      const login = oidcLogin(ctx.issuerKey, key);
      if (plannedUsers.has(login)) return login;
      const existing = getUserByLogin(db, login);
      if (existing) {
        if (existing.kind !== 'oidc') { dropMember(org, key, 'the login is held by a local user'); return null; }
        return login;
      }
      plannedUsers.set(login, {
        kind: 'oidc', login, issuer: ctx.issuerRaw, sub: key, name: null, email: null, password: null,
        mustChange: false, seededDefault: false, isOwner: false, disabled: false, sessionEpoch: 0, createdAt: now,
      });
      return login;
    }
    if (plannedUsers.get(key)?.kind === 'local') return key;
    const existing = typeof key === 'string' && key ? getUserByLogin(db, key) : null;
    if (existing && existing.kind === 'local') return key;
    dropMember(org, key, 'no such user');
    return null;
  }

  const plannedOrgs = [];          // [{ id, name, root }]
  const memberships = [];          // [{ orgId, login, role }]
  const remaining = [];            // ids of orgs.json orgs that remain (planned or kept), file order
  const existingDefault = getMeta(db, 'default_org');
  let defaultOrg;
  let joinRole = ctx.joinRoleEnv !== undefined ? ctx.joinRoleEnv : null;

  if (legacy.orgs.exists) {
    // ---- orgs.json (plan item 2) ----
    const entries = [...legacy.orgs.entries];
    // The default entry the migration wrote — or would have: a migration
    // that moved the flat entries and crashed before the orgs.json write
    // leaves data in orgs/default with no entry (nothing is left to move,
    // so wroteDefault is false on the next boot).
    if (!entries.some(([id]) => id === 'default')
      && (migration?.wroteDefault || hasData(join(ctx.base, 'orgs', 'default')))) {
      entries.push(['default', { name: 'Default', members: [] }]);
    }
    const kept = new Set();
    for (const [id, org] of entries) {
      if (!validOrgId(id)) {
        report.orgs.dropped.push({ id, reason: 'not a valid org id (a slug: lowercase letters, digits, - and _)' });
        continue;
      }
      const existing = getOrg(db, id);
      if (existing) {
        report.orgs.conflicts.push({ id, reason: existing.removedAt ? 'the id was used by a removed org — never reused' : 'kept the existing org' });
        for (const [key] of org.members) dropMember(id, key, 'org kept as the store has it');
        if (!existing.removedAt) { kept.add(id); remaining.push(id); }
        continue;
      }
      if (id === 'default' && org.members.length === 0 && !hasData(join(ctx.base, 'orgs', 'default'))
        && report.migration.moved.length === 0) {
        report.orgs.dropped.push({ id: 'default', reason: 'empty leftover of the flat-workspace migration' });
        continue;
      }
      let name = id;
      if (textOk(org.name, { max: NAME_MAX })) name = org.name;
      else if (org.name !== undefined && org.name !== null) {
        report.orgs.droppedFields.push({ id, field: 'name', reason: `${whyText(org.name, NAME_MAX)} — the id is its name` });
      }
      plannedOrgs.push({ id, name, root: `orgs/${id}` });
      remaining.push(id);
      for (const [key, value] of org.members) {
        const login = memberLogin(id, key);
        if (!login) continue;
        const { role, exact } = mapLegacyRole(value);
        if (!exact) report.memberships.inexact.push({ org: id, key, from: value ?? null, to: role });
        if (role === 'viewer') report.memberships.viewers.push({ org: id, key });
        memberships.push({ orgId: id, login, role });
      }
    }
    if (plannedOrgs.length === 0 && kept.size === 0 && !getOrg(db, 'default')) {
      // Zero real orgs (A-5): tenancy was armed, so the default org lives
      // where a pre-store build keeps it.
      plannedOrgs.push({ id: 'default', name: 'Default', root: 'orgs/default' });
      remaining.push('default');
    }
    defaultOrg = remaining.includes('default') ? 'default' : remaining[0] ?? null;
  } else {
    // ---- no orgs.json (plan item 3): one org, the flat workspace ----
    const existing = getOrg(db, existingDefault || 'default');
    if (existing) {
      report.orgs.conflicts.push({ id: existing.id, reason: existing.removedAt ? 'the id was used by a removed org — never reused' : 'kept the existing org' });
      defaultOrg = existing.removedAt ? null : existing.id;
    } else {
      plannedOrgs.push({ id: 'default', name: 'Default', root: '.' });
      defaultOrg = 'default';
    }
    if (!oidc && defaultOrg) {
      for (const login of localImported) {
        plannedUsers.get(login).isOwner = true;
        memberships.push({ orgId: defaultOrg, login, role: 'admin' });
      }
    }
    if (oidc && ctx.joinRoleEnv === undefined) joinRole = 'operator';
  }

  // The deployment's default org: kept when the store already records one.
  const effectiveDefault = existingDefault || defaultOrg;
  report.orgs.defaultOrg = effectiveDefault;
  if (existingDefault) report.orgs.defaultOrgKept = true;

  // Owners of an orgs.json deployment: the admins of the default org
  // (under OIDC, users.json rows are disabled and never owners).
  if (legacy.orgs.exists) {
    for (const m of memberships) {
      const row = plannedUsers.get(m.login);
      if (m.orgId === effectiveDefault && m.role === 'admin' && row && !row.disabled) row.isOwner = true;
    }
  }

  const users = [...plannedUsers.values()];
  report.users.imported = users.map((u) => u.login);
  report.users.fromUsersFile = localImported.length;
  report.users.disabled = users.filter((u) => u.disabled).map((u) => u.login);
  report.orgs.imported = plannedOrgs.map((o) => ({ id: o.id, root: o.root }));
  report.memberships.imported = memberships.length;
  report.owners = users.filter((u) => u.isOwner).map((u) => u.login);
  report.noOwner = report.owners.length === 0 && !listUsers(db).some((u) => u.isOwner && !u.disabled);
  report.oidcJoinRole = joinRole;
  report.identityArmed = legacy.users.exists || getMeta(db, 'identity_armed') === '1';

  const legacyHashes = {
    [legacy.usersKey]: legacy.users.exists ? { sha256: sha256Of(legacy.users.raw) } : { absent: true },
    [ORGS_KEY]: legacy.orgs.exists ? { sha256: sha256Of(legacy.orgs.raw) } : { absent: true },
  };
  const meta = {
    import_done: now,
    ...(ctx.usersFileEnv ? { users_file: ctx.usersFileEnv } : {}),
    ...(legacy.users.exists ? { identity_armed: '1' } : {}),
    ...(!existingDefault && defaultOrg ? { default_org: defaultOrg } : {}),
    ...(joinRole ? { oidc_join_role: joinRole } : {}),
    legacy_hashes: JSON.stringify(legacyHashes),
    import_report: JSON.stringify(report),
    replace_requested: null,
  };

  const liveOrgsAfter = [...listOrgs(db).map((o) => o.id), ...plannedOrgs.map((o) => o.id)];
  return { orgs: plannedOrgs, users, memberships, meta, legacyHashes, liveOrgsAfter, report };
}

// ---------- applying ----------

export function applyImport(db, plan, ctx) {
  return tx(db, () => {
    if (getMeta(db, 'import_done')) {
      throw new Error(`observogram store: store ${storeId(db)} was imported while this start was planning its import — restart to use it`);
    }
    for (const o of plan.orgs) insertOrgRow(db, { ...o, createdAt: ctx.now });
    const ids = new Map();
    for (const u of plan.users) ids.set(u.login, insertUserRow(db, u).id);
    for (const m of plan.memberships) {
      const userId = ids.get(m.login) ?? getUserByLogin(db, m.login)?.id;
      insertMembershipRow(db, { orgId: m.orgId, userId, role: m.role, createdAt: ctx.now });
    }
    for (const [key, value] of Object.entries(plan.meta)) putMeta(db, key, value);
    const r = plan.report;
    writeAudit(db, SYSTEM, {
      action: 'store.import', targetKind: 'store', targetId: r.storeId,
      detail: {
        users: plan.users.length, orgs: plan.orgs.length, memberships: plan.memberships.length, owners: r.owners.length,
        dropped: r.users.dropped.length + r.orgs.dropped.length + r.memberships.dropped.length,
        conflicts: r.users.conflicts.length + r.orgs.conflicts.length,
        mode: r.identityMode,
      },
    });
    return r;
  });
}

// ---------- the boot log ----------

const q = (v) => (typeof v === 'string' ? `'${v}'` : JSON.stringify(v ?? null));

export function formatReport(r) {
  const out = [];
  const usersPart = r.files.users.present ? `${r.files.users.path} (${r.users.fromUsersFile} users)` : 'no users file';
  const orgsPart = r.files.orgs.present
    ? `${r.files.orgs.path} (${r.orgs.imported.length} orgs, ${r.memberships.imported} memberships)`
    : `no orgs.json (${r.orgs.imported.length} org, ${r.memberships.imported} memberships)`;
  out.push(`[store] imported ${usersPart} and ${orgsPart} into ${r.dbPath} (store ${r.storeId})`);
  const def = r.orgs.imported.find((o) => o.id === r.orgs.defaultOrg);
  out.push(`[store]   default org ${r.orgs.defaultOrg ?? '(none)'}${def ? ` (${def.root})` : r.orgs.defaultOrgKept ? ' (kept as the store records it)' : ''}; owners: ${r.owners.length ? r.owners.join(', ') : '(none)'}`);
  if (r.migration.skipped) {
    out.push(`[store]   flat workspace not moved: store ${r.storeId} already keeps the default org at . (initialised by a CLI before this first start)`);
  }
  if (r.migration.moved.length) {
    out.push(r.dbPath === ':memory:'
      ? `[store]   flat workspace not moved (OBSERVOGRAM_DB=:memory: writes nothing to the workspace; a file store moves it to orgs/default/): ${r.migration.moved.join(', ')}`
      : `[store]   flat workspace moved to orgs/default/: ${r.migration.moved.join(', ')}`);
  }
  if (r.migration.leftBehind.length) out.push(`[store]   left behind (orgs/default/ already has them; neither moved nor merged): ${r.migration.leftBehind.join(', ')}`);
  if (r.users.disabled.length) out.push(`[store]   users-file users imported disabled (OIDC is configured): ${r.users.disabled.join(', ')}`);
  if (r.memberships.inexact.length) {
    out.push(`[store]   roles mapped: ${r.memberships.inexact.map((m) => `${m.org}/${m.key} ${q(m.from)} → ${m.to}${m.to === 'viewer' ? ' (loses write power when roles are enforced)' : ''}`).join(' · ')}`);
  }
  const exactViewers = r.memberships.viewers.filter((v) => !r.memberships.inexact.some((m) => m.org === v.org && m.key === v.key));
  if (exactViewers.length) out.push(`[store]   viewers (lose write power when roles are enforced): ${exactViewers.map((v) => `${v.org}/${v.key}`).join(' · ')}`);
  const dropped = [
    ...r.orgs.dropped.map((d) => `org ${d.id} (${d.reason})`),
    ...r.memberships.dropped.map((d) => `member ${d.org}/${d.key} (${d.reason})`),
    ...r.users.dropped.map((d) => `user ${q(d.login.length > 40 ? `${d.login.slice(0, 40)}…` : d.login)} (${d.reason})`),
  ];
  if (dropped.length) out.push(`[store]   dropped: ${dropped.join(' · ')}`);
  const conflicts = [
    ...r.users.conflicts.map((c) => `user ${c.login} (${c.reason})`),
    ...r.orgs.conflicts.map((c) => `org ${c.id} (${c.reason})`),
  ];
  if (conflicts.length) out.push(`[store]   already in the store: ${conflicts.join(' · ')}`);
  const fields = [
    ...r.users.droppedFields.map((f) => `${f.login} ${f.field} (${f.reason})`),
    ...r.orgs.droppedFields.map((f) => `org ${f.id} ${f.field} (${f.reason})`),
  ];
  if (fields.length) out.push(`[store]   fields dropped: ${fields.join(' · ')}`);
  if (r.oidcJoinRole) out.push(`[store]   OIDC users join the default org as ${r.oidcJoinRole} at their first sign-in (OBSERVOGRAM_OIDC_JOIN_ROLE=none before the first start keeps it closed)`);
  if (r.noOwner) out.push('[store]   no owner — run `npm run users -- owner <login>`');
  return out;
}
