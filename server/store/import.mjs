// server/store/import.mjs — the legacy import (docs/STORE_PLAN.md §4 step 3):
// users.json and orgs.json into the store, once, at the first start of a
// store build.
//
//   readLegacy(db, ctx)                       the strict reads (legacy-files.mjs)
//   planImport(db, legacy, ctx, migration)    reads only: the rows, the meta and the report
//   applyImport(db, plan, ctx)                one tx(): the rows, the meta, ONE store.import audit row
//   formatReport(report)                      the boot log lines
//   planReplace / applyReplace / formatReplace  the same for `packc store
//                                             import --replace`, carried out
//                                             by the next start (below)
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

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tx } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { getMeta, getMetaJson, putMeta, storeId } from './meta.mjs';
import { getOrg, insertOrgRow, listOrgs, removeOrgRow, renameOrgRow, setOrgRoot } from './orgs.mjs';
import { deleteMembershipRow, insertMembershipRow, listMembers, setRoleRow } from './memberships.mjs';
import { getUserByLogin, insertUserRow, listUsers, updateUserRow } from './users.mjs';
import { textOk } from './rows.mjs';
import { mapLegacyRole, oidcLogin, signInOwnerCount, SYSTEM } from './identity.mjs';
import { planJourneyRewrites } from './ops.mjs';
import { validOrgId } from '../org-context.mjs';
import {
  hasData, legacyUsersPath, lexists, MIGRATABLE, orgsFilePath, readOrgsFileStrict, readUsersFileStrict, sha256Of, usersHashKey,
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

// A users.json record's fields, by the field rules: what the import and
// the replace store for it; every value dropped is listed.
function userFileFields(name, rec, now, report) {
  const dropField = (field) => (reason) => report.users.droppedFields.push({ login: name, field, reason });
  let password = null;
  if (isPlainObject(rec.password)) password = rec.password;
  else if (rec.password !== undefined && rec.password !== null) dropField('password')('not a password record');
  let createdAt = now;
  if (rec.createdAt !== undefined && rec.createdAt !== null) {
    if (typeof rec.createdAt === 'string' && Number.isFinite(Date.parse(rec.createdAt))) createdAt = rec.createdAt;
    else dropField('createdAt')('not a timestamp — the import time is used');
  }
  return {
    name: optionalField(rec.name, NAME_MAX, dropField('name')),
    email: optionalField(rec.email, EMAIL_MAX, dropField('email')),
    password, mustChange: !!rec.mustChange, seededDefault: !!rec.seededDefault, createdAt,
  };
}

// A users.json name the store can hold as a login, else the reason it
// cannot ('empty' — it could not be typed at the login form, which trims).
const unusableName = (name) => (textOk(name, { max: NAME_MAX }) ? null
  : textOk(name, { max: Infinity }) ? `longer than ${NAME_MAX} characters` : 'empty');

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
      if (unusableName(name)) {
        report.users.dropped.push({ login: name, reason: unusableName(name) });
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
      const row = {
        kind: 'local', login: name, issuer: null, sub: null, ...userFileFields(name, rec, now, report),
        isOwner: false, disabled: oidc, sessionEpoch: 0,
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
  // :memory: never moves the flat workspace: when a file store would move
  // it into an orgs/default that holds no data, the default org reads it
  // in place at '.' (orgs/default would be an empty root, and the flat
  // data unread). A half-migrated workspace (orgs/default already holds
  // data) keeps the default at orgs/default, as a file store plans it:
  // the unmoved flat entries are left unread until a file-store start
  // finishes the move.
  const inPlace = !!ctx.memory && report.migration.moved.length > 0 && !hasData(join(ctx.base, 'orgs', 'default'));
  const defaultRootDir = inPlace ? '.' : 'orgs/default';
  report.memoryInPlace = inPlace;

  if (legacy.orgs.exists) {
    // ---- orgs.json (plan item 2) ----
    const entries = [...legacy.orgs.entries];
    // The default entry the migration wrote. Data in orgs/default with no
    // entry is never planned as an org: a crash before the orgs.json write
    // and an admin who retired the default org look the same. The report
    // and every boot name the directory instead.
    if (migration?.wroteDefault && !entries.some(([id]) => id === 'default')) {
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
      plannedOrgs.push({ id, name, root: id === 'default' ? defaultRootDir : `orgs/${id}` });
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
      plannedOrgs.push({ id: 'default', name: 'Default', root: defaultRootDir });
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
  // orgs/default holding data that no org, planned or kept, reads.
  const defaultDir = join(ctx.base, 'orgs', 'default');
  const rootOf = (id) => plannedOrgs.find((o) => o.id === id)?.root ?? getOrg(db, id)?.root ?? null;
  if (![...plannedOrgs, ...listOrgs(db)].some((o) => o.root === 'orgs/default') && hasData(defaultDir)) {
    const root = effectiveDefault ? rootOf(effectiveDefault) : null;
    report.unreadDefaultDir = {
      path: defaultDir, defaultOrg: root ? effectiveDefault : null,
      defaultRoot: root === null ? null : root === '.' ? ctx.base : join(ctx.base, root),
    };
  } else {
    report.unreadDefaultDir = null;
  }
  report.memberships.imported = memberships.length;
  report.owners = users.filter((u) => u.isOwner).map((u) => u.login);
  // Owners the store already has (a CLI-created owner): the boot line names
  // them too, so a kept owner never reads as "(none)".
  report.ownersKept = listUsers(db).filter((u) => u.isOwner && !u.disabled && !report.owners.includes(u.login)).map((u) => u.login);
  report.noOwner = report.owners.length === 0 && report.ownersKept.length === 0;
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

function ownersText(r) {
  const all = [...r.owners, ...(r.ownersKept ?? []).map((login) => `${login} (kept)`)];
  return all.length ? all.join(', ') : '(none)';
}

// orgs/default with data no org reads (no orgs.json "default" entry): a
// migration that stopped before its orgs.json write, or a default org an
// admin retired. Adding "default" to orgs.json now is too late — the
// import has run — so the ways out are by hand.
export function unreadDefaultText({ path, defaultOrg, defaultRoot }) {
  return `${path} — no org reads it (the store has no org at orgs/default). With the server stopped, ` +
    (defaultRoot ? `move its entries into ${defaultRoot} (the default org ${defaultOrg}'s root) if they are the default org's data, or ` : '') +
    'move the directory aside';
}

export function formatReport(r) {
  const out = [];
  const usersPart = r.files.users.present ? `${r.files.users.path} (${r.users.fromUsersFile} users)` : 'no users file';
  const orgsPart = r.files.orgs.present
    ? `${r.files.orgs.path} (${r.orgs.imported.length} orgs, ${r.memberships.imported} memberships)`
    : `no orgs.json (${r.orgs.imported.length} org, ${r.memberships.imported} memberships)`;
  out.push(`[store] imported ${usersPart} and ${orgsPart} into ${r.dbPath} (store ${r.storeId})`);
  const def = r.orgs.imported.find((o) => o.id === r.orgs.defaultOrg);
  out.push(`[store]   default org ${r.orgs.defaultOrg ?? '(none)'}${def ? ` (${def.root})` : r.orgs.defaultOrgKept ? ' (kept as the store records it)' : ''}; owners: ${ownersText(r)}`);
  if (r.migration.skipped) {
    out.push(`[store]   flat workspace not moved: store ${r.storeId} already keeps the default org at . (initialised by a CLI before this first start)`);
  }
  if (r.migration.moved.length) {
    out.push(r.dbPath === ':memory:'
      ? `[store]   flat workspace not moved (OBSERVOGRAM_DB=:memory: writes nothing to the workspace; a file store moves it to orgs/default/): ${r.migration.moved.join(', ')} — ${r.memoryInPlace
        ? `the default org reads it in place at .${r.migration.wroteDefault ? '' : ' (orgs.json\'s default entry too: its root is . under :memory:)'}`
        : 'left behind unread: orgs/default/ already holds the default org\'s data (a half-finished move); :memory: moves nothing; a file-store start finishes the move'}`
      : `[store]   flat workspace moved to orgs/default/: ${r.migration.moved.join(', ')}`);
  }
  if (r.unreadDefaultDir) out.push(`[store]   left behind: ${unreadDefaultText(r.unreadDefaultDir)}`);
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

// ---------- the replace (`packc store import --replace`) ----------
//
// The request (server/store/ops.mjs requestReplace) sets replace_requested;
// the next start's step 2 accepts it (the request, the marker and the
// database carry one store_id) and step 3 re-imports users.json and
// orgs.json as they stand, with the unit's environment — the files a
// pre-store build edited during a downgrade. Against the import:
//   - the audit, services, environments and endpoints are kept, and rows
//     are updated, never overwritten wholesale;
//   - users, users.json present: a local row absent from it is disabled; an
//     entry with a row takes the file's password, flags, name and email and
//     is re-enabled (a users-file row stays disabled under OIDC); an entry
//     without a row is created (epoch 1) and, without an orgs.json, joins
//     the default org as operator (a pre-store build gave it full write).
//     users.json absent: the local users are kept. An OIDC row is never
//     disabled for being absent (the export never writes one). is_owner is
//     never re-derived;
//   - orgs, orgs.json present: orgs created or renamed to match; each
//     file org's memberships replaced to match its members (keys by the
//     unit's mode); a live org absent from the file is soft-removed unless
//     it is the default org; a removed slug that reappears is skipped.
//     orgs.json absent: orgs, memberships and oidc_join_role are kept;
//   - the root change: the store keeps the default org at '.', and the
//     files' orgs.json holds "default" (a pre-store build keeps that org at
//     orgs/default/, and has moved its entries there, or this start's
//     migration did): its root becomes orgs/default in the same tx(), its
//     journeys' file: paths are rewritten, the empty flat leftovers beside
//     their orgs/default/ twins (every pre-store restart leaves an empty
//     <base>/packs) are removed — as they are when an in-place export
//     already moved that root. A flat entry with data beside its twin
//     refuses (check D, before anything moves);
//   - no enabled owner who can sign in under the unit's mode is left where
//     one was → refuses (check D on plan1; re-asserted in the tx());
//   - in the same tx(): every changed or disabled user's epoch is bumped
//     (a membership change is a change: it also ends cookies minted during
//     the downgrade window), legacy_hashes rewritten, replace_requested
//     cleared, one store.replace row (and org.root for the root change).

const DEFAULT_MOVED = 'orgs/default';

const ownerSignsIn = (u, mode) => u.isOwner && !u.disabled && (mode.mode === 'local'
  ? u.kind === 'local' && u.password !== null && u.password !== undefined
  : u.kind === 'oidc' && u.login.startsWith(`${mode.issuerKey}#`));

export function planReplace(db, legacy, ctx, migration) {
  const oidc = ctx.identityMode === 'oidc';
  const now = ctx.now;
  const id = storeId(db);
  const previous = getMetaJson(db, 'import_report', null);
  const report = {
    kind: 'replace', at: now, storeId: id, dbPath: ctx.dbPath ?? null,
    identityMode: oidc ? 'oidc' : 'local', issuerKey: oidc ? ctx.issuerKey : null, usersFile: getMeta(db, 'users_file'),
    files: {
      users: { path: legacy.usersPath, present: legacy.users.exists, entries: legacy.users.exists ? legacy.users.entries.length : 0 },
      orgs: { path: legacy.orgsPath, present: legacy.orgs.exists, entries: legacy.orgs.exists ? legacy.orgs.entries.length : 0 },
    },
    migration: {
      moved: [...(migration?.moved ?? [])], leftBehind: [...(migration?.leftBehind ?? [])],
      wroteDefault: !!migration?.wroteDefault, skipped: migration?.skipped ?? null,
    },
    users: { created: [], updated: [], disabled: [], enabled: [], conflicts: [], dropped: [], droppedFields: [] },
    orgs: { created: [], renamed: [], removed: [], conflicts: [], dropped: [], droppedFields: [], defaultOrg: getMeta(db, 'default_org') },
    memberships: { added: [], removed: [], changed: [], dropped: [], inexact: [], viewers: [] },
    rootChanged: false, cronJob: null, leftovers: [], journeys: [], sessionsEnded: [],
    ownersDisabled: [], noOwner: false,
    identityArmed: legacy.users.exists || getMeta(db, 'identity_armed') === '1',
    // what the export reads: the deployment has, or had, an orgs.json
    orgsJson: legacy.orgs.exists || !!previous?.orgsJson,
  };

  const rows = listUsers(db);
  const byLogin = new Map(rows.map((u) => [u.login, u]));
  const byId = new Map(rows.map((u) => [u.id, u]));
  const updates = new Map();     // user id → the fields that change
  const creates = new Map();     // login → a new local row
  const plannedOidc = new Map(); // login → a new OIDC row (an orgs.json member never seen)
  const bump = new Set();        // user ids whose sessions end
  const change = (u, fields) => updates.set(u.id, { ...(updates.get(u.id) ?? {}), ...fields });

  // ---- users ----
  if (legacy.users.exists) {
    const inFile = new Set();
    for (const [name, rec] of legacy.users.entries) {
      inFile.add(name);
      if (unusableName(name)) { report.users.dropped.push({ login: name, reason: unusableName(name) }); continue; }
      if (oidc && name.startsWith(`${ctx.issuerKey}#`)) {
        report.users.conflicts.push({ login: name, reason: `has the form of an OIDC login under ${ctx.issuerKey}` });
        continue;
      }
      const row = byLogin.get(name);
      if (row && row.kind !== 'local') { report.users.conflicts.push({ login: name, reason: 'the login is held by an OIDC user' }); continue; }
      const f = userFileFields(name, rec, now, report);
      if (!row) {
        creates.set(name, { kind: 'local', login: name, issuer: null, sub: null, ...f, isOwner: false, disabled: oidc, sessionEpoch: 1 });
        report.users.created.push(name);
        continue;
      }
      const diff = {};
      if (JSON.stringify(row.password) !== JSON.stringify(f.password)) diff.password = f.password;
      for (const k of ['mustChange', 'seededDefault', 'name', 'email']) if (row[k] !== f[k]) diff[k] = f[k];
      const fields = Object.keys(diff);
      if (fields.length) report.users.updated.push({ login: name, fields });
      if (row.disabled && !oidc) { diff.disabled = false; report.users.enabled.push(name); }
      if (Object.keys(diff).length) { change(row, diff); bump.add(row.id); }
    }
    for (const u of rows) {
      if (u.kind !== 'local' || u.disabled || inFile.has(u.login)) continue;
      change(u, { disabled: true });
      bump.add(u.id);
      report.users.disabled.push(u.login);
    }
  }

  // ---- orgs and memberships ----
  const dropMember = (org, key, reason) => report.memberships.dropped.push({ org, key, reason });
  function memberLogin(org, key) {
    if (oidc) {
      if (!textOk(key, { max: SUB_MAX })) { dropMember(org, key, 'not a usable sub'); return null; }
      const login = oidcLogin(ctx.issuerKey, key);
      if (plannedOidc.has(login)) return login;
      const existing = byLogin.get(login);
      if (existing) {
        if (existing.kind !== 'oidc') { dropMember(org, key, 'the login is held by a local user'); return null; }
        return login;
      }
      plannedOidc.set(login, {
        kind: 'oidc', login, issuer: ctx.issuerRaw, sub: key, name: null, email: null, password: null,
        mustChange: false, seededDefault: false, isOwner: false, disabled: false, sessionEpoch: 1, createdAt: now,
      });
      report.users.created.push(login);
      return login;
    }
    if (creates.has(key)) return key;
    const existing = typeof key === 'string' && key ? byLogin.get(key) : null;
    if (existing && existing.kind === 'local') return key;
    dropMember(org, key, 'no such user');
    return null;
  }

  const liveBefore = listOrgs(db);
  const defaultOrgId = getMeta(db, 'default_org');
  const atRoot = liveBefore.find((o) => o.root === '.') ?? null;
  const orgCreates = [];
  const renames = [];
  const removes = [];
  const desired = new Map();     // org id → Map(login → role)
  let fileKeepsDefault = false;
  if (legacy.orgs.exists) {
    const entries = [...legacy.orgs.entries];
    if (migration?.wroteDefault && !entries.some(([k]) => k === 'default')) entries.push(['default', { name: 'Default', members: [] }]);
    const inFile = new Set();
    for (const [oid, org] of entries) {
      if (!validOrgId(oid)) {
        report.orgs.dropped.push({ id: oid, reason: 'not a valid org id (a slug: lowercase letters, digits, - and _)' });
        continue;
      }
      const existing = getOrg(db, oid);
      if (existing?.removedAt) {
        report.orgs.conflicts.push({ id: oid, reason: 'the id was used by a removed org — never reused; skipped' });
        for (const [key] of org.members) dropMember(oid, key, 'org skipped');
        continue;
      }
      const usable = textOk(org.name, { max: NAME_MAX });
      if (!usable && org.name !== undefined && org.name !== null) {
        report.orgs.droppedFields.push({ id: oid, field: 'name', reason: `${whyText(org.name, NAME_MAX)} — ${existing ? 'the store keeps its name' : 'the id is its name'}` });
      }
      if (existing) {
        if (usable && org.name !== existing.name) renames.push({ id: oid, from: existing.name, to: org.name });
        if (oid === 'default') fileKeepsDefault = true;
      } else {
        if (oid === 'default' && org.members.length === 0 && !hasData(join(ctx.base, 'orgs', 'default'))
          && report.migration.moved.length === 0) {
          report.orgs.dropped.push({ id: 'default', reason: 'empty leftover of the flat-workspace migration' });
          continue;
        }
        orgCreates.push({ id: oid, name: usable ? org.name : oid, root: `orgs/${oid}` });
      }
      inFile.add(oid);
      const want = new Map();
      for (const [key, value] of org.members) {
        const login = memberLogin(oid, key);
        if (!login) continue;
        const { role, exact } = mapLegacyRole(value);
        if (!exact) report.memberships.inexact.push({ org: oid, key, from: value ?? null, to: role });
        if (role === 'viewer') report.memberships.viewers.push({ org: oid, key });
        want.set(login, role);
      }
      desired.set(oid, want);
    }
    for (const o of liveBefore) if (!inFile.has(o.id) && o.id !== defaultOrgId) removes.push(o.id);
  }

  const memberAdds = [];
  const memberRemoves = [];
  const memberRoles = [];
  for (const [oid, want] of desired) {
    const have = new Map();
    if (!orgCreates.some((o) => o.id === oid)) for (const m of listMembers(db, oid)) have.set(byId.get(m.userId).login, m);
    for (const [login, m] of have) {
      // A user disabled before and after the replace is one the export
      // leaves out of orgs.json: the file cannot have removed them, so
      // their memberships stay (re-enabling them later finds their orgs).
      const stillDisabled = byId.get(m.userId).disabled && updates.get(m.userId)?.disabled !== false;
      if (!want.has(login)) {
        if (stillDisabled) continue;
        memberRemoves.push({ orgId: oid, login, userId: m.userId, role: m.role });
        bump.add(m.userId);
      } else if (want.get(login) !== m.role) {
        memberRoles.push({ orgId: oid, login, userId: m.userId, from: m.role, to: want.get(login) });
        bump.add(m.userId);
      }
    }
    for (const [login, role] of want) {
      if (have.has(login)) continue;
      memberAdds.push({ orgId: oid, login, role });
      if (byLogin.has(login)) bump.add(byLogin.get(login).id);
    }
  }
  // A new local user without an orgs.json joins the default org (A-29).
  if (!legacy.orgs.exists && defaultOrgId && liveBefore.some((o) => o.id === defaultOrgId)) {
    for (const login of creates.keys()) memberAdds.push({ orgId: defaultOrgId, login, role: 'operator' });
  }
  report.orgs.created = orgCreates.map((o) => ({ id: o.id, root: o.root }));
  report.orgs.renamed = renames.map((r) => ({ ...r }));
  report.orgs.removed = [...removes];
  report.memberships.added = memberAdds.map((m) => ({ org: m.orgId, login: m.login, role: m.role }));
  report.memberships.removed = memberRemoves.map((m) => ({ org: m.orgId, login: m.login, role: m.role }));
  report.memberships.changed = memberRoles.map((m) => ({ org: m.orgId, login: m.login, from: m.from, to: m.to }));

  // ---- the root change ----
  const rootChange = !!atRoot && atRoot.id === 'default' && fileKeepsDefault;
  const flatOf = (e) => join(ctx.base, e);
  const twinOf = (e) => join(ctx.base, 'orgs', 'default', e);
  let twins = [];
  let leftovers = [];
  let journeys = [];
  // The default org already at orgs/default (an in-place export moved it):
  // every pre-store restart since has left an empty <base>/packs beside its
  // twin — removed as the root change's are.
  const alreadyMoved = !atRoot && liveBefore.some((o) => o.id === 'default' && o.root === DEFAULT_MOVED);
  if (rootChange || alreadyMoved) {
    leftovers = MIGRATABLE.filter((e) => lexists(flatOf(e)) && !hasData(flatOf(e)) && lexists(twinOf(e))).map(flatOf);
    report.leftovers = [...leftovers];
  }
  if (rootChange) {
    twins = MIGRATABLE.filter((e) => hasData(flatOf(e)) && lexists(twinOf(e))).map((e) => ({ entry: e, flat: flatOf(e), twin: twinOf(e) }));
    // The default org's journeys: already under orgs/default/ (a pre-store
    // boot moved them), or still at the base until this start's migration.
    const moved = MIGRATABLE.filter((e) => lexists(twinOf(e)) || report.migration.moved.includes(e));
    const dir = lexists(twinOf('journeys')) ? twinOf('journeys') : flatOf('journeys');
    journeys = planJourneyRewrites(ctx.base, moved, { dir }).map((j) => ({ ...j, path: join(twinOf('journeys'), j.name) }));
    report.rootChanged = true;
    report.cronJob = `OBSERVOGRAM_WORKSPACE=${join(ctx.base, DEFAULT_MOVED)}`;
    report.journeys = journeys.map((j) => j.name);
  }
  const brokenJourneys = journeys.filter((j) => j.parsedBefore && !j.parsesAfter).map((j) => j.path);

  // ---- the owner ----
  const ownerMode = oidc ? { mode: 'oidc', issuerKey: ctx.issuerKey } : { mode: 'local' };
  const ownersBefore = signInOwnerCount(db, ownerMode);
  const after = rows.map((u) => ({ ...u, ...(updates.get(u.id) ?? {}) }));
  const ownersAfter = after.filter((u) => ownerSignsIn(u, ownerMode)).length;
  report.ownersDisabled = rows.filter((u) => ownerSignsIn(u, ownerMode) && updates.get(u.id)?.disabled === true).map((u) => u.login);
  report.noOwner = ownersBefore > 0 && ownersAfter === 0;
  report.sessionsEnded = [...bump].map((uid) => byId.get(uid).login);

  // ---- meta ----
  const recorded = getMetaJson(db, 'legacy_hashes', {}) || {};
  // A file still absent keeps the hash it was imported with (step 2 (d)/(e)).
  const hashOf = (key, file) => (file.exists ? { sha256: sha256Of(file.raw) }
    : recorded[key]?.absent && typeof recorded[key].importedSha256 === 'string'
      ? { absent: true, importedSha256: recorded[key].importedSha256 } : { absent: true });
  const legacyHashes = { ...recorded, [legacy.usersKey]: hashOf(legacy.usersKey, legacy.users), [ORGS_KEY]: hashOf(ORGS_KEY, legacy.orgs) };
  const meta = {
    ...(legacy.users.exists && getMeta(db, 'identity_armed') !== '1' ? { identity_armed: '1' } : {}),
    legacy_hashes: JSON.stringify(legacyHashes),
    import_report: JSON.stringify(report),
    replace_requested: null,
  };

  const liveOrgsAfter = [...liveBefore.map((o) => o.id).filter((o) => !removes.includes(o)), ...orgCreates.map((o) => o.id)];
  return {
    replace: true,
    users: { create: [...creates.values(), ...plannedOidc.values()], update: [...updates.entries()] },
    orgs: { create: orgCreates, rename: renames, remove: removes },
    memberships: { add: memberAdds, remove: memberRemoves, role: memberRoles },
    bump: [...bump], rootChange, twins, leftovers, journeys, brokenJourneys,
    ownerMode, ownersBefore, noOwner: report.noOwner, ownersDisabled: report.ownersDisabled, usersPath: legacy.usersPath,
    meta, legacyHashes, liveOrgsAfter, report,
  };
}

// The journey rewrites first (restored if the transaction fails), then one
// tx(), then — committed — the empty flat leftovers are removed.
export function applyReplace(db, plan, ctx) {
  const written = [];
  try {
    for (const j of plan.journeys) {
      writeFileSync(j.path, j.after);
      written.push(j);
    }
    tx(db, () => {
      if (!getMeta(db, 'import_done') || getMeta(db, 'replace_requested') !== plan.report.storeId) {
        throw new Error(`observogram store: the replace request on store ${plan.report.storeId} was carried out or withdrawn while this start was planning it — restart to use it`);
      }
      for (const o of plan.orgs.create) insertOrgRow(db, { ...o, createdAt: ctx.now });
      for (const r of plan.orgs.rename) renameOrgRow(db, r.id, r.to);
      for (const oid of plan.orgs.remove) removeOrgRow(db, oid, ctx.now);
      if (plan.rootChange) setOrgRoot(db, SYSTEM, 'default', DEFAULT_MOVED);
      const ids = new Map();
      for (const u of plan.users.create) ids.set(u.login, insertUserRow(db, u).id);
      const bump = new Set(plan.bump);
      for (const [uid, fields] of plan.users.update) {
        updateUserRow(db, uid, fields, { bump: bump.has(uid) });
        bump.delete(uid);
      }
      for (const m of plan.memberships.remove) deleteMembershipRow(db, m.orgId, m.userId);
      for (const m of plan.memberships.role) setRoleRow(db, m.orgId, m.userId, m.to);
      for (const m of plan.memberships.add) {
        const userId = ids.get(m.login) ?? getUserByLogin(db, m.login)?.id;
        insertMembershipRow(db, { orgId: m.orgId, userId, role: m.role, createdAt: ctx.now });
      }
      for (const uid of bump) updateUserRow(db, uid, {}, { bump: true });
      if (plan.ownersBefore > 0 && signInOwnerCount(db, plan.ownerMode) === 0) {
        throw new Error(`observogram store: the replace would leave store ${plan.report.storeId} with no enabled owner — rolled back`);
      }
      for (const [key, value] of Object.entries(plan.meta)) putMeta(db, key, value);
      const r = plan.report;
      writeAudit(db, SYSTEM, {
        action: 'store.replace', targetKind: 'store', targetId: r.storeId,
        detail: {
          users: { created: r.users.created.length, updated: r.users.updated.length, disabled: r.users.disabled.length, enabled: r.users.enabled.length },
          orgs: { created: r.orgs.created.length, renamed: r.orgs.renamed.length, removed: r.orgs.removed.length },
          memberships: { added: r.memberships.added.length, removed: r.memberships.removed.length, changed: r.memberships.changed.length },
          sessionsEnded: r.sessionsEnded.length, rootChanged: r.rootChanged, mode: r.identityMode,
        },
      });
    });
  } catch (e) {
    const failed = [];
    for (const j of written.reverse()) {
      try { writeFileSync(j.path, j.before); } catch (err) { failed.push(`${j.path} (${err.message})`); }
    }
    if (written.length) {
      e.message += failed.length
        ? `; restoring the rewritten journeys failed for ${failed.join(', ')} — put those back by hand`
        : '; the rewritten journeys were put back';
    }
    throw e;
  }
  for (const path of plan.leftovers) rmSync(path, { recursive: true, force: true });
  return plan.report;
}

export function formatReplace(r) {
  const out = [];
  const usersPart = r.files.users.present ? `${r.files.users.path} (${r.files.users.entries} entries)` : 'no users file (the local users kept)';
  const orgsPart = r.files.orgs.present ? `${r.files.orgs.path} (${r.files.orgs.entries} orgs)` : 'no orgs.json (orgs and memberships kept)';
  out.push(`[store] replaced from ${usersPart} and ${orgsPart} into ${r.dbPath} (store ${r.storeId}; packc store import --replace)`);
  const list = (items) => items.join(', ');
  const users = [
    r.users.created.length ? `created ${list(r.users.created)}` : null,
    r.users.updated.length ? `updated ${list(r.users.updated.map((u) => `${u.login} (${u.fields.join(', ')})`))}` : null,
    r.users.enabled.length ? `re-enabled ${list(r.users.enabled)}` : null,
    r.users.disabled.length ? `disabled ${list(r.users.disabled)} (not in the users file)` : null,
  ].filter(Boolean);
  out.push(`[store]   users: ${users.length ? users.join(' · ') : 'unchanged'}`);
  const orgs = [
    r.orgs.created.length ? `created ${list(r.orgs.created.map((o) => `${o.id} (${o.root})`))}` : null,
    r.orgs.renamed.length ? `renamed ${list(r.orgs.renamed.map((o) => `${o.id} (${q(o.from)} → ${q(o.to)})`))}` : null,
    r.orgs.removed.length ? `removed ${list(r.orgs.removed)} (not in orgs.json)` : null,
  ].filter(Boolean);
  const members = [
    r.memberships.added.length ? `added ${list(r.memberships.added.map((m) => `${m.org}/${m.login} (${m.role})`))}` : null,
    r.memberships.removed.length ? `removed ${list(r.memberships.removed.map((m) => `${m.org}/${m.login}`))}` : null,
    r.memberships.changed.length ? `changed ${list(r.memberships.changed.map((m) => `${m.org}/${m.login} ${m.from} → ${m.to}`))}` : null,
  ].filter(Boolean);
  if (orgs.length) out.push(`[store]   orgs: ${orgs.join(' · ')}`);
  if (members.length) out.push(`[store]   memberships: ${members.join(' · ')}`);
  if (r.migration.moved.length) out.push(`[store]   flat workspace moved to orgs/default/: ${r.migration.moved.join(', ')}`);
  if (r.migration.leftBehind.length) out.push(`[store]   left behind (orgs/default/ already has them; neither moved nor merged): ${r.migration.leftBehind.join(', ')}`);
  if (r.rootChanged) out.push(`[store]   the default org's root is now ${DEFAULT_MOVED} — point its CronJobs at ${r.cronJob}`);
  if (r.journeys.length) out.push(`[store]   journey file: paths rewritten: ${r.journeys.join(', ')}`);
  if (r.leftovers.length) out.push(`[store]   removed empty leftovers of a pre-store build: ${r.leftovers.join(', ')}`);
  if (r.sessionsEnded.length) out.push(`[store]   sessions ended (changed or disabled): ${r.sessionsEnded.join(', ')}`);
  if (r.memberships.inexact.length) {
    out.push(`[store]   roles mapped: ${r.memberships.inexact.map((m) => `${m.org}/${m.key} ${q(m.from)} → ${m.to}${m.to === 'viewer' ? ' (loses write power when roles are enforced)' : ''}`).join(' · ')}`);
  }
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
  if (conflicts.length) out.push(`[store]   skipped: ${conflicts.join(' · ')}`);
  const fields = [
    ...r.users.droppedFields.map((f) => `${f.login} ${f.field} (${f.reason})`),
    ...r.orgs.droppedFields.map((f) => `org ${f.id} ${f.field} (${f.reason})`),
  ];
  if (fields.length) out.push(`[store]   fields dropped: ${fields.join(' · ')}`);
  return out;
}
