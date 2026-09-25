// server/store/ops.mjs — the `packc store` offline operations
// (docs/STORE_PLAN.md §4 "packc store export <dir> — the exit and the
// downgrade path").
//
//   exportStore(dir, { dbPath, base })   users.json / orgs.json a pre-store
//                                        build boots on, to a directory or
//                                        in place (with the default org's
//                                        move); planExport is its read-only half
//   formatExport(result)                 the CLI's report lines
//   requestReplace({ dbPath, base })     `packc store import --replace`: asks the
//                                        next server start to re-import
//                                        users.json / orgs.json as they stand
//                                        (boot step 3, planReplace/applyReplace
//                                        in server/store/import.mjs)
//   rekeyIssuer({ to | clear })          `packc store rekey-issuer`: the OIDC
//                                        users follow the IdP to a new URL
//                                        (--to), or are retired for another
//                                        IdP (--clear)
//   purgeOrg(id, { dbPath, base })      `packc store purge-org`: delete a
//                                        removed org's files
//   restoreMarkerWarning(storeId, base)  the warning `packc store restore`
//                                        prints when the workspace's marker
//                                        names another store
//
// An in-place export runs with the server stopped: assertNotInUse()
// (server/store/backup.mjs, restore's probe) refuses while any connection
// holds the database. A directory export only reads the store, and writes
// only into a directory that does not exist or is empty (exportDirectory).
//
// The export writes files a pre-store build boots on with the same
// membership, not the same access: a pre-store build enforces no roles, so
// every viewer and operator regains full write there, and the report lists
// them; it has no owners either, so an owner enters only the orgs it is a
// member of, and the report lists the orgs each owner loses. It is not a
// byte-level round trip.
//
// In place, when it writes orgs.json while the default org's root is '.',
// a pre-store build would move that org's flat entries into orgs/default/
// at its next start and the store would no longer find them. So the export
// makes the move itself, every check before the first write:
//   0. users.json / orgs.json, where it writes them, are as the store last
//      imported or exported them (a file a pre-store build edited since
//      is refused naming `import --replace`, never overwritten);
//   1. dry run: no MIGRATABLE entry present at the base has an
//      orgs/default/ twin (refused listing every conflict), and every
//      journey whose file: paths it rewrites still parses;
//   2. rename each entry into orgs/default/;
//   3. rewrite the default org's journey file: values <base>/<entry>/ →
//      <base>/orgs/default/<entry>/ (forward slashes, as
//      /api/journeys/capture writes them);
//   4. write users.json / orgs.json;
//   5. one tx(): the default org's root (org.root), legacy_hashes of what
//      step 4 wrote, one store.export row;
//   6. the marker (by 'export').
// A failure in 2–5 undoes what ran from in-memory copies (renames back,
// journey and legacy file contents restored) and says so.
//
// Every regex here is used through .test() / .match() / replace: the
// store's source guard refuses a raw handle call's spelling here.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { baseWorkspacePath } from '../../tools/lib/brand-env.mjs';
import { parse as parseYaml } from '../../tools/lib/mini-yaml.mjs';
import { closeStore, openStore, resolveDbPath, tx } from './db.mjs';
import { assertNotInUse, identifyFile } from './backup.mjs';
import { listAudit, writeAudit } from './audit.mjs';
import { getMeta, getMetaJson, isIdentityArmed, putMeta, setMeta, storeId } from './meta.mjs';
import { getOrg, listOrgs, setOrgRoot } from './orgs.mjs';
import { listMembers } from './memberships.mjs';
import { disableOidcRows, listUsers, rewriteLoginPrefix } from './users.mjs';
import { CLI, canonIssuer, preStoreSub } from './identity.mjs';
import {
  MIGRATABLE, lexists, markerPath, orgsFilePath, readMarker, sha256File, usersHashKey, writeMarker, writeOrgsFile, writeUsersFile,
} from './legacy-files.mjs';

const MEMORY = ':memory:';
const DEFAULT_MOVED = 'orgs/default';
const JOURNEY_SUFFIX = '.journey.yaml';
// Store roles → the words a pre-store orgs.json used.
const LEGACY_ROLE = Object.freeze({ admin: 'admin', operator: 'member', viewer: 'viewer' });

export const COOKIE_NOTE = 'users revoked in the store stay signed in on a pre-store build until their cookies expire; '
  + 'rotating OBSERVOGRAM_SESSION_SECRET signs everyone out';

function refuse(message) {
  const err = new Error(message);
  err.code = 'ERR_OBSERVOGRAM_STORE_REFUSED';
  return err;
}

function realOr(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

const slashed = (p) => p.replaceAll('\\', '/');

function readOrNull(path) {
  try { return readFileSync(path); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
}

function parses(text) {
  try { parseYaml(text); return true; } catch { return false; }
}

// ---------- the plan (reads only) ----------

// The journey rewrites of the default org's move: for every
// *.journey.yaml in `dir` (the default org's journeys: <base>/journeys
// before the move, <base>/orgs/default/journeys after it — the replace's
// root change, server/store/import.mjs), its text with each
// <base>/<moved entry>/ spelled <base>/orgs/default/<moved entry>/ (the
// base as given and, when it differs, as realpath spells it). Only files
// whose text changes.
export function planJourneyRewrites(base, moved, { dir = join(base, 'journeys') } = {}) {
  if (!moved.includes('journeys')) return [];
  let names;
  try { names = readdirSync(dir).filter((f) => f.endsWith(JOURNEY_SUFFIX)).sort(); } catch { return []; }
  const bases = [...new Set([slashed(base), slashed(realOr(base))])];
  const out = [];
  for (const name of names) {
    const path = join(dir, name);
    try { if (!statSync(path).isFile()) continue; } catch { continue; }
    const before = readFileSync(path, 'utf8');
    let after = before;
    for (const b of bases) {
      for (const entry of moved) after = after.split(`${b}/${entry}/`).join(`${b}/${DEFAULT_MOVED}/${entry}/`);
    }
    if (after !== before) out.push({ name, before, after, parsedBefore: parses(before), parsesAfter: parses(after) });
  }
  return out;
}

// In place, the files the export would overwrite must be as the store
// last imported or exported them (the boot's step 2 (d) comparison: a file
// recorded absent keeps its imported hash). One a pre-store build edited
// since holds the only copy of those edits, so it is refused, not
// overwritten: the replace takes them into the store first.
function assertUnedited(db, id, base, files) {
  const recorded = getMetaJson(db, 'legacy_hashes', {}) || {};
  const expectedOf = (r) => (r?.absent ? (typeof r.importedSha256 === 'string' ? r.importedSha256 : null)
    : typeof r?.sha256 === 'string' ? r.sha256 : null);
  const edited = [];
  for (const [key, path] of files) {
    let now;
    // A file that cannot be read is left to step 4, which fails on it and
    // puts back what ran.
    try { now = sha256File(path); } catch (e) { if (e?.code === 'ERR_OBSERVOGRAM_LEGACY_FILE') continue; throw e; }
    if (now.absent) continue;
    const was = expectedOf(recorded[key]);
    if (now.sha256 !== was) edited.push(`${path} (${was ? `it was SHA-256 ${was}` : 'it was absent'}, it is ${now.sha256})`);
  }
  if (!edited.length) return;
  throw refuse(`${edited.join(', ')} ${edited.length === 1 ? 'differs' : 'differ'} from what store ${id} last imported or exported — `
    + 'edited outside the store (a pre-store build during a rollback, or config management); an in-place export would overwrite '
    + 'those edits. Nothing was changed. With the server stopped, run `packc store import --replace` and start the server once, '
    + `so the store takes them in, then export again; or move ${edited.length === 1 ? 'it' : 'them'} aside to discard them`);
}

// Everything the export will write, and every refusal, before any write.
export function planExport(db, { inPlace, target, base }) {
  const id = storeId(db);
  if (inPlace && !getMeta(db, 'import_done')) {
    throw refuse(`store ${id} has never been started by the server (import_done is unset): an in-place export writes the files `
      + 'the store took over at its first start — start the server once, or export to a directory');
  }
  const users = listUsers(db);
  const armed = isIdentityArmed(db);
  const issuerKey = getMeta(db, 'oidc_issuer');

  // users.json: the enabled local users, only once stand-alone sign-in is armed.
  const localUsers = users.filter((u) => u.kind === 'local' && !u.disabled);
  const noPassword = localUsers.filter((u) => !u.password).map((u) => u.login);
  const records = {};
  for (const u of localUsers) {
    if (!u.password) continue;
    records[u.login] = {
      ...(u.name !== null ? { name: u.name } : {}),
      ...(u.email !== null ? { email: u.email } : {}),
      createdAt: u.createdAt,
      password: u.password,
      ...(u.mustChange ? { mustChange: true } : {}),
      ...(u.seededDefault ? { seededDefault: true } : {}),
    };
  }
  const recordedUsersFile = getMeta(db, 'users_file');
  const usersPath = !armed ? null : inPlace ? (recordedUsersFile || join(base, 'users.json')) : join(target, 'users.json');

  // orgs.json: when the deployment had one, has more than one live org, or
  // keeps the default org anywhere but the workspace root (A-30).
  const live = listOrgs(db);
  const atRoot = live.find((o) => o.root === '.') ?? null;
  const report = getMetaJson(db, 'import_report', null);
  const writeOrgs = !!report?.orgsJson || live.length > 1 || !atRoot;
  const orgs = {};
  const writeAccess = [];
  const ownerLoss = [];    // owners a pre-store build (no owners) keeps out of an org they are no member of
  const collisions = [];
  let memberCount = 0;
  const byId = new Map(users.map((u) => [u.id, u]));
  if (writeOrgs) {
    const signsInPreStore = (u) => !u.disabled && (u.kind === 'local' || (issuerKey && u.login.startsWith(`${issuerKey}#`)));
    for (const org of live) {
      const members = {};
      for (const m of listMembers(db, org.id)) {
        const u = byId.get(m.userId);
        if (!u || !signsInPreStore(u)) continue;
        const key = preStoreSub(u);
        if (Object.hasOwn(members, key)) { collisions.push({ org: org.id, key, login: u.login }); continue; }
        members[key] = LEGACY_ROLE[m.role];
        memberCount += 1;
        if (m.role !== 'admin') writeAccess.push({ org: org.id, key, role: m.role });
      }
      orgs[org.id] = { name: org.name, members };
      for (const u of users) {
        if (u.isOwner && signsInPreStore(u) && !Object.hasOwn(members, preStoreSub(u))) ownerLoss.push({ org: org.id, key: preStoreSub(u) });
      }
    }
  } else {
    for (const org of live) {
      for (const m of listMembers(db, org.id)) {
        const u = byId.get(m.userId);
        if (u && u.kind === 'local' && !u.disabled && m.role !== 'admin') writeAccess.push({ org: org.id, key: u.login, role: m.role });
      }
    }
  }
  const orgsPath = !writeOrgs ? null : inPlace ? orgsFilePath(base) : join(target, 'orgs.json');
  if (inPlace) {
    assertUnedited(db, id, base, [
      ...(usersPath ? [[usersHashKey(recordedUsersFile), usersPath]] : []),
      ...(orgsPath ? [['orgs.json', orgsPath]] : []),
    ]);
  }

  // The default org's move (in place only).
  let move = [];
  let journeys = [];
  if (inPlace && writeOrgs && atRoot) {
    if (atRoot.id !== 'default') {
      throw refuse(`org ${atRoot.id} keeps the workspace root, but only the default org "default" can move to ${DEFAULT_MOVED} — nothing was changed`);
    }
    move = MIGRATABLE.filter((entry) => lexists(join(base, entry)));
    const conflicts = move.filter((entry) => lexists(join(base, DEFAULT_MOVED, entry)));
    if (conflicts.length) {
      throw refuse(`the default org's entries must move to ${join(base, DEFAULT_MOVED)} for a pre-store build, but it already holds `
        + `${conflicts.map((e) => join(base, DEFAULT_MOVED, e)).join(', ')} — nothing was changed. With the server stopped, `
        + `merge or move aside ${conflicts.length === 1 ? 'that entry' : 'those entries'} (the default org reads ${conflicts.map((e) => join(base, e)).join(', ')}), then export again`);
    }
    journeys = planJourneyRewrites(base, move);
    const broken = journeys.filter((j) => j.parsedBefore && !j.parsesAfter);
    if (broken.length) {
      throw refuse(`rewriting the file: paths of ${broken.map((j) => join(base, 'journeys', j.name)).join(', ')} would leave `
        + `${broken.length === 1 ? 'it' : 'them'} unparseable — nothing was changed; fix the paths by hand and export again`);
    }
  }

  return {
    storeId: id, inPlace, base, target, armed,
    users: { path: usersPath, data: { users: records }, logins: Object.keys(records), noPassword },
    orgs: { path: orgsPath, data: orgs, ids: Object.keys(orgs), members: memberCount, collisions },
    writeAccess, ownerLoss, move, journeys,
    usersKey: usersHashKey(recordedUsersFile),
  };
}

// ---------- the export ----------

// A directory export writes only into a directory that does not exist or is empty: anything else may be a
// workspace (live, another store's, or one its marker was lost from), and files written there would skip the
// in-place steps. A symlink is resolved, and what it names must itself be absent or empty. A directory inside
// the workspace or holding it is refused too: the way back is the in-place export. → the directory to write.
function exportDirectory(target, base) {
  const named = (into) => (into === target ? target : `${target} (a symlink to ${into})`);
  const unreadable = (p, e) => refuse(`${p} cannot be read: ${e.message}. Nothing was changed. Choose an empty or new directory`);
  let into = target;
  let st;
  for (let hops = 0; ; hops += 1) {
    try { st = lstatSync(into); } catch (e) { if (e?.code === 'ENOENT') { st = null; break; } throw unreadable(into, e); }
    if (!st.isSymbolicLink()) break;
    if (hops >= 40) throw refuse(`${target} is a symlink loop. Nothing was changed. Choose an empty or new directory`);
    into = resolve(dirname(into), readlinkSync(into));
  }
  const t = realOr(into);
  const b = realOr(base);
  const inside = t.startsWith(b + sep);
  if (t === b || inside || b.startsWith(t.endsWith(sep) ? t : t + sep)) {
    throw refuse(`${named(into)} ${t === b ? 'is' : inside ? 'lies inside' : 'holds'} the workspace ${base} — a directory export there `
      + `would write files without the in-place steps. Nothing was changed. To export in place, stop the server and run `
      + `packc store export ${base}; otherwise choose an empty directory outside the workspace`);
  }
  if (!st) return into;
  if (!st.isDirectory()) throw refuse(`${named(into)} exists and is not a directory. Nothing was changed. Choose an empty or new directory`);
  let entries;
  try { entries = readdirSync(into); } catch (e) { throw unreadable(into, e); }
  if (entries.length) {
    throw refuse(`${named(into)} is not empty — a directory export writes only into a new or empty directory. Nothing was changed. `
      + `To export: choose an empty or new directory; or, if ${into} is this store's workspace, stop the server and run `
      + `OBSERVOGRAM_WORKSPACE=${into} packc store export ${into} to export in place`);
  }
  return into;
}

// An in-place export with no marker: the workspace is this store's only if no other store's database is in it.
// The candidates are the *.db files directly in <base> and <base>/db (<base>/observogram.db, the default, among
// them), each opened read-only without migrating; one that cannot be read is refused naming it.
async function assertNoOtherStore(base, path, id) {
  const own = realOr(path);
  for (const dir of [base, join(base, 'db')]) {
    let names;
    try { names = readdirSync(dir); } catch (e) { if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') continue; throw e; }
    for (const name of names.filter((n) => n.endsWith('.db')).sort()) {
      const file = join(dir, name);
      if (realOr(file) === own) continue;
      try { if (!statSync(file).isFile()) continue; } catch { continue; }
      let other;
      try {
        other = (await identifyFile(file)).storeId;
      } catch (e) {
        throw refuse(`${file} cannot be read as a store (${e.message}), and ${markerPath(base)} is missing: an in-place export `
          + `cannot tell whether the workspace ${base} is store ${id}'s. Nothing was changed. Move ${file} out of ${base}, then run `
          + 'the export again');
      }
      if (other && other !== id) {
        throw refuse(`${file} holds store ${other}, but ${path} holds store ${id}, and ${markerPath(base)} is missing: the workspace `
          + `${base} is not known to be this store's, and an in-place export would write store ${id}'s files over it. Nothing was `
          + `changed. To export that workspace, stop the server and run OBSERVOGRAM_DB=${file} OBSERVOGRAM_WORKSPACE=${base} `
          + `packc store export ${base}; to export store ${id}, choose an empty or new directory`);
      }
    }
  }
}

export async function exportStore(dir, { dbPath = resolveDbPath(), base = baseWorkspacePath(), out = process.stdout } = {}) {
  if (!dir) throw refuse('name the directory: packc store export <dir> (the workspace directory itself exports in place)');
  if (dbPath === MEMORY) throw refuse('OBSERVOGRAM_DB is :memory: — an in-memory store lives in one process and cannot be exported from another');
  const path = resolve(dbPath);
  out.write(`store: ${path}\n`);
  if (!existsSync(path)) throw refuse(`no database at ${path} — nothing to export (this command never creates one; check OBSERVOGRAM_DB and OBSERVOGRAM_WORKSPACE)`);
  const target = resolve(dir);
  const inPlace = realOr(target) === realOr(base);
  let into = target;   // where a directory export writes: the target, or the directory its symlink resolves to
  if (inPlace) {
    await assertNotInUse(path, { doing: 'an in-place export' });
  } else {
    into = exportDirectory(target, base);
  }

  const db = await openStore({ path });
  try {
    const id = storeId(db);
    if (inPlace) {
      // Another store's workspace (OBSERVOGRAM_DB pointing elsewhere): the export would move its files and write this
      // store's users, orgs and marker over it.
      const mp = markerPath(base);
      const marker = readMarker(base, { tail: 'nothing was changed. The store writes this file: with the server stopped, move it '
        + `aside (mv ${mp} ${mp}.corrupt), then run the export again — with no marker, it checks the workspace's databases instead `
        + 'and writes a new marker' });
      if (marker && marker.storeId !== id) {
        throw refuse(`${mp} names store ${marker.storeId}, but ${path} holds store ${id}: the workspace ${base} `
          + `is not this store's, and an in-place export would write store ${id}'s files over it. Nothing was changed. To export `
          + `that workspace, point OBSERVOGRAM_DB at its own store (store ${marker.storeId}); to export store ${id}, choose an empty `
          + 'or new directory');
      }
      if (!marker) await assertNoOtherStore(base, path, id);
    }
    const plan = planExport(db, { inPlace, target: into, base });
    if (!inPlace) {
      if (plan.users.path) writeUsersFile(plan.users.data, plan.users.path);
      if (plan.orgs.path) writeOrgsFile(plan.orgs.data, plan.orgs.path);
      return { ...plan, rootChanged: false, marker: null };
    }
    return exportInPlace(db, plan);
  } finally {
    if (inPlace) closeStore(path);
  }
}

function exportInPlace(db, plan) {
  const { base } = plan;
  const renamed = [];      // [from, to]
  const restores = [];     // { path, before: Buffer | null }
  const made = [];         // directories this export created
  const undo = () => {
    const failed = [];
    for (const r of restores.reverse()) {
      try {
        if (r.before === null) rmSync(r.path, { force: true });
        else writeFileSync(r.path, r.before);
      } catch (e) { failed.push(`${r.path} (${e.message})`); }
    }
    for (const [from, to] of renamed.reverse()) {
      try { renameSync(to, from); } catch (e) { failed.push(`${to} → ${from} (${e.message})`); }
    }
    for (const d of made.reverse()) { try { rmdirSync(d); } catch { /* not empty, or gone: leave it */ } }
    return failed;
  };

  let rootChanged = false;
  try {
    // 2. the move
    if (plan.move.length) {
      const dest = join(base, DEFAULT_MOVED);
      for (const d of [join(base, 'orgs'), dest]) {
        if (!existsSync(d)) { mkdirSync(d); made.push(d); }
      }
      for (const entry of plan.move) {
        const from = join(base, entry);
        const to = join(dest, entry);
        renameSync(from, to);
        renamed.push([from, to]);
      }
    }
    // 3. the journey rewrite (the files now sit under orgs/default/journeys)
    for (const j of plan.journeys) {
      const path = join(base, DEFAULT_MOVED, 'journeys', j.name);
      restores.push({ path, before: Buffer.from(j.before, 'utf8') });
      writeFileSync(path, j.after);
    }
    // 4. the legacy files
    const written = {};
    if (plan.users.path) {
      restores.push({ path: plan.users.path, before: readOrNull(plan.users.path) });
      writeUsersFile(plan.users.data, plan.users.path);
      written[plan.usersKey] = sha256File(plan.users.path);
    }
    if (plan.orgs.path) {
      restores.push({ path: plan.orgs.path, before: readOrNull(plan.orgs.path) });
      writeOrgsFile(plan.orgs.data, plan.orgs.path);
      written['orgs.json'] = sha256File(plan.orgs.path);
    }
    // 5. the store, in one transaction
    tx(db, () => {
      if (plan.move.length) { setOrgRoot(db, CLI, 'default', DEFAULT_MOVED); rootChanged = true; }
      const hashes = { ...(getMetaJson(db, 'legacy_hashes', {}) || {}), ...written };
      putMeta(db, 'legacy_hashes', JSON.stringify(hashes));
      writeAudit(db, CLI, {
        action: 'store.export', targetKind: 'store', targetId: plan.storeId,
        detail: {
          inPlace: true, users: plan.users.path ? plan.users.logins.length : null,
          orgs: plan.orgs.path ? plan.orgs.ids.length : null, moved: plan.move,
        },
      });
    });
  } catch (e) {
    const failed = undo();
    const what = failed.length
      ? `; undoing it failed for ${failed.join(', ')} — put those back by hand`
      : `; everything it moved or wrote was put back${plan.move.length ? ` (${plan.move.join(', ')} are at ${base} again)` : ''}`;
    const err = refuse(`the in-place export failed: ${e.message}${what}`);
    err.cause = e;
    throw err;
  }

  // 6. the marker
  const files = getMetaJson(db, 'legacy_hashes', {}) || {};
  const marker = writeMarker(base, { storeId: plan.storeId, files, by: 'export' });
  const defaultRoot = getOrg(db, 'default')?.root ?? null;
  return { ...plan, rootChanged, marker, cronJob: rootChanged ? `OBSERVOGRAM_WORKSPACE=${join(base, DEFAULT_MOVED)}` : null, defaultRoot };
}

// ---------- import --replace: the request ----------

export const REPLACE_REQUESTED = "replace requested: the next server start re-imports users.json/orgs.json with the unit's environment";

// Only a request: the replace itself runs at the next start, with the
// unit's environment (its OIDC issuer, its users file), which this shell
// may not have. With the server stopped; the store must be the one the
// workspace's marker names, already imported — an empty or foreign store
// takes the stale-store ways out instead (a replace there would re-import
// the files into the wrong store).
export async function requestReplace({ dbPath = resolveDbPath(), base = baseWorkspacePath(), out = process.stdout } = {}) {
  if (dbPath === MEMORY) throw refuse('OBSERVOGRAM_DB is :memory: — an in-memory store lives in one process; a replace is carried out by the server\'s next start on its database file');
  const path = resolve(dbPath);
  out.write(`store: ${path}\n`);
  if (!existsSync(path)) throw refuse(`no database at ${path} — nothing to replace into (this command never creates one; check OBSERVOGRAM_DB and OBSERVOGRAM_WORKSPACE)`);
  await assertNotInUse(path, { doing: 'requesting a replace' });
  const db = await openStore({ path });
  try {
    const id = storeId(db);
    const marker = readMarker(base);   // corrupt → LegacyFileError naming it
    const importDone = getMeta(db, 'import_done');
    if (importDone && !marker) {
      // The store was imported, only the marker is gone: the next start's
      // repair rewrites it — once the legacy files pass step 2 (d), and
      // with no request pending (step 2 (c) refuses that).
      const way = getMeta(db, 'replace_requested') !== null
        ? `a replace is already pending, and the next start carries it out once ${markerPath(base)} is put back as it was (it names store ${id})`
        : 'with the server stopped, move users.json/orgs.json aside if they changed since the import, start the server once '
          + '(it records them absent and rewrites the marker), stop it, put them back, then run this again';
      throw refuse(`${path} holds store ${id}, but ${markerPath(base)} is missing, and a replace is requested only for the store `
        + `the marker names: ${way}. Nothing was requested`);
    }
    if (!importDone || !marker || marker.storeId !== id) {
      const holds = importDone ? `store ${id}` : `store ${id}, never imported`;
      const names = !marker ? `${markerPath(base)} is missing` : `${markerPath(base)} names store ${marker.storeId}`;
      throw refuse(`${path} holds ${holds}, but ${names}: an empty or foreign store — see the stale-store ways out: `
        + 'point OBSERVOGRAM_DB at the store this workspace was imported into, or at a copy of its backup, '
        + 'or with the server stopped `packc store restore <backup>`. Nothing was requested');
    }
    const pending = getMeta(db, 'replace_requested') === id;
    if (!pending) setMeta(db, CLI, 'replace_requested', id);
    return { storeId: id, path, alreadyPending: pending };
  } finally {
    closeStore(path);
  }
}

// ---------- rekey-issuer ----------

// With the server stopped, on a store that records an OIDC issuer key.
//   --to <issuer>: the same IdP at a new URL (same subs). One tx(): every
//     kind 'oidc' login '<old>#<sub>' becomes '<new>#<sub>' (refused when a
//     rewritten login exists), oidc_issuer and an 'oidc:<old>'
//     identity_mode name the new key, one issuer.rekey row. Earlier audit
//     rows and deploys.jsonl keep the old logins (append-only).
//   --clear: another IdP. One tx(): every enabled kind 'oidc' row disabled
//     with its epoch bumped, oidc_issuer and an 'oidc:' identity_mode
//     cleared, one issuer.rekey row listing the logins. The next start
//     records the new key; OBSERVOGRAM_BOOTSTRAP_ADMIN names the owner.
// A pending replace is left pending: the next start carries it out under
// the key this leaves (after --clear, the unit's new one).
export async function rekeyIssuer({ to = null, clear = false, dbPath = resolveDbPath(), out = process.stdout } = {}) {
  if (Boolean(clear) === (to !== null)) throw refuse('name one of --to <issuer> or --clear');
  if (dbPath === MEMORY) throw refuse('OBSERVOGRAM_DB is :memory: — an in-memory store lives in one process; rekey the server\'s database file');
  let newKey = null;
  if (!clear) {
    try { newKey = canonIssuer(to); } catch (e) { throw refuse(`--to ${e.message.replace(/^OBSERVOGRAM_OIDC_ISSUER /, '')}`); }
  }
  const path = resolve(dbPath);
  out.write(`store: ${path}\n`);
  if (!existsSync(path)) throw refuse(`no database at ${path} — nothing to rekey (this command never creates one; check OBSERVOGRAM_DB and OBSERVOGRAM_WORKSPACE)`);
  await assertNotInUse(path, { doing: 'rekeying the issuer' });
  const db = await openStore({ path });
  try {
    const id = storeId(db);
    const from = getMeta(db, 'oidc_issuer');
    if (!from) throw refuse(`store ${id} records no OIDC issuer — nothing to rekey (the server records one at its first start with OBSERVOGRAM_OIDC_ISSUER set)`);
    const mode = getMeta(db, 'identity_mode');
    const pending = getMeta(db, 'replace_requested') !== null;
    if (!clear) {
      if (newKey === from) throw refuse(`store ${id} already records its OIDC users under ${from} — nothing to rekey`);
      const rows = tx(db, () => {
        let n;
        try {
          n = rewriteLoginPrefix(db, `${from}#`, `${newKey}#`);
        } catch (e) {
          if (e.code !== 'ERR_OBSERVOGRAM_LOGIN_TAKEN') throw e;
          throw refuse(`the new key would reuse a login that exists: ${e.taken.join(', ')} — nothing was changed`);
        }
        putMeta(db, 'oidc_issuer', newKey);
        if (mode === `oidc:${from}`) putMeta(db, 'identity_mode', `oidc:${newKey}`);
        writeAudit(db, CLI, { action: 'issuer.rekey', targetKind: 'issuer', targetId: from, detail: { from, to: newKey, mode: 'to', rows: n } });
        return n;
      });
      return { storeId: id, path, mode: 'to', from, to: newKey, rows, pending };
    }
    const disabled = tx(db, () => {
      const logins = disableOidcRows(db);
      putMeta(db, 'oidc_issuer', null);
      if (mode !== null && mode.startsWith('oidc:')) putMeta(db, 'identity_mode', null);
      writeAudit(db, CLI, { action: 'issuer.rekey', targetKind: 'issuer', targetId: from, detail: { from, to: null, mode: 'clear', disabled: logins } });
      return logins;
    });
    return { storeId: id, path, mode: 'clear', from, to: null, disabled, pending };
  } finally {
    closeStore(path);
  }
}

export function formatRekey(r) {
  const out = [];
  if (r.mode === 'to') {
    out.push(`rekeyed store ${r.storeId}: OIDC users ${r.from}#<sub> -> ${r.to}#<sub> (${r.rows} row${r.rows === 1 ? '' : 's'})`);
    out.push(`set OBSERVOGRAM_OIDC_ISSUER to a spelling of ${r.to} before starting the server; `
      + 'sessions signed in under the old key end (a fresh sign-in finds the same user)');
  } else {
    out.push(`cleared the OIDC issuer of store ${r.storeId} (was ${r.from}): `
      + `${r.disabled.length ? `disabled ${r.disabled.join(', ')}` : 'no enabled OIDC user to disable'}`);
    out.push('the next start records the new issuer; set OBSERVOGRAM_BOOTSTRAP_ADMIN to name its owner');
  }
  if (r.pending) out.push('a pending `packc store import --replace` stays pending: the next start carries it out under the new key');
  return out;
}

// ---------- purge-org ----------

// With the server stopped: deletes the files of an org `npm run orgs --
// remove` soft-removed (the row stays, so its slug and root are never
// reused). The org exists, is removed and is not the default org; its root
// is orgs/<id> and resolves under <base>/orgs/ (a symlink is refused, never
// followed). Then one tx(): the root's keys dropped from legacy_hashes
// (none before slice 4), one org.purge row; then the marker rewritten from
// legacy_hashes (by 'purge-org'). A workspace whose marker names another
// store is refused: its orgs/ are not this store's to delete.
export async function purgeOrg(id, { dbPath = resolveDbPath(), base = baseWorkspacePath(), out = process.stdout } = {}) {
  if (!id) throw refuse('name the org: packc store purge-org <id>');
  if (dbPath === MEMORY) throw refuse('OBSERVOGRAM_DB is :memory: — an in-memory store lives in one process; purge from the server\'s database file');
  const path = resolve(dbPath);
  out.write(`store: ${path}\n`);
  if (!existsSync(path)) throw refuse(`no database at ${path} — nothing to purge (this command never creates one; check OBSERVOGRAM_DB and OBSERVOGRAM_WORKSPACE)`);
  await assertNotInUse(path, { doing: 'purging an org' });
  const db = await openStore({ path });
  try {
    const sid = storeId(db);
    const org = getOrg(db, id);
    if (!org) throw refuse(`store ${sid} has no org ${JSON.stringify(id)} — nothing was deleted`);
    if (getMeta(db, 'default_org') === id) throw refuse(`${id} is the default org and is never purged — nothing was deleted`);
    if (!org.removedAt) {
      throw refuse(`org ${id} is live — remove it first with \`npm run orgs -- remove ${id}\` (its files stay), then purge it; nothing was deleted`);
    }
    const marker = readMarker(base);   // corrupt → LegacyFileError naming it
    if (marker && marker.storeId !== sid) {
      throw refuse(`${markerPath(base)} names store ${marker.storeId}, but ${path} holds store ${sid}: the workspace ${base} `
        + 'is not this store\'s — point OBSERVOGRAM_DB and OBSERVOGRAM_WORKSPACE at one deployment; nothing was deleted');
    }
    const rel = `orgs/${id}`;
    if (org.root !== rel) throw refuse(`org ${id}'s root is ${org.root}, not ${rel} — only an org's own directory is purged; nothing was deleted`);
    const root = join(base, 'orgs', id);
    const parent = realOr(join(base, 'orgs'));
    let present = false;
    if (lexists(root)) {
      const st = lstatSync(root);
      if (!st.isDirectory()) throw refuse(`${root} is not a directory (${st.isSymbolicLink() ? 'a symlink, never followed' : 'a file'}) — move it aside by hand; nothing was deleted`);
      if (!realOr(root).startsWith(parent + sep)) throw refuse(`${root} resolves outside ${join(base, 'orgs')} — nothing was deleted`);
      present = true;
    }
    const usersFile = getMeta(db, 'users_file');
    if (usersFile && isAbsolute(usersFile) && present && realOr(usersFile).startsWith(realOr(root) + sep)) {
      throw refuse(`the recorded users file ${usersFile} lies under ${root} — move it out first; nothing was deleted`);
    }
    const hashes = getMetaJson(db, 'legacy_hashes', {}) || {};
    const dropped = Object.keys(hashes).filter((k) => !isAbsolute(k) && slashed(k).startsWith(`${rel}/`)).sort();
    if (!present && !dropped.length && listAudit(db, { action: 'org.purge', targetId: id, limit: 1 }).length) {
      throw refuse(`org ${id} was purged already and nothing of it is left at ${root}`);
    }
    if (present) rmSync(root, { recursive: true });
    const files = Object.fromEntries(Object.entries(hashes).filter(([k]) => !dropped.includes(k)));
    tx(db, () => {
      if (dropped.length) putMeta(db, 'legacy_hashes', JSON.stringify(files));
      writeAudit(db, CLI, { action: 'org.purge', targetKind: 'org', targetId: id, detail: { root: rel, deleted: present, legacyHashes: dropped } });
    });
    const written = marker ? writeMarker(base, { storeId: sid, files, by: 'purge-org' }) : null;
    return { storeId: sid, path, id, root, deleted: present, dropped, marker: written };
  } finally {
    closeStore(path);
  }
}

export function formatPurge(r) {
  const out = [r.deleted ? `purged org ${r.id}: deleted ${r.root}` : `purged org ${r.id}: nothing on disk at ${r.root}`];
  if (r.dropped.length) out.push(`dropped from legacy_hashes: ${r.dropped.join(', ')}`);
  if (r.marker) out.push(`rewrote ${r.marker}`);
  return out;
}

// ---------- restore: the marker check ----------

// After `packc store restore`: the start refuses (step 2 (a)) while the
// workspace's marker names another store than the one restored.
export function restoreMarkerWarning(restoredId, base = baseWorkspacePath()) {
  let marker;
  try {
    marker = readMarker(base);
  } catch (e) {
    if (e?.code !== 'ERR_OBSERVOGRAM_LEGACY_FILE') throw e;
    return `warning: ${markerPath(base)} cannot be read as a store import marker — the next start refuses until it is fixed (README: stale import)`;
  }
  if (!marker || marker.storeId === restoredId) return null;
  return `warning: the restored store is ${restoredId}; ${markerPath(base)} names ${marker.storeId} — the next start refuses until they agree (README: stale import)`;
}

// ---------- the report ----------

export function formatExport(r) {
  const out = [];
  out.push(r.inPlace ? `export: in place in ${r.base} (store ${r.storeId})` : `export: to ${r.target} (store ${r.storeId})`);
  out.push(r.users.path
    ? `users.json: ${r.users.path} (${r.users.logins.length} enabled local user${r.users.logins.length === 1 ? '' : 's'}; OIDC users are never written)`
    : 'users.json: not written (stand-alone sign-in was never armed on this store)');
  if (r.users.noPassword.length) out.push(`  left out (no password to write): ${r.users.noPassword.join(', ')}`);
  out.push(r.orgs.path
    ? `orgs.json: ${r.orgs.path} (${r.orgs.ids.length} org${r.orgs.ids.length === 1 ? '' : 's'}: ${r.orgs.ids.join(', ')}; ${r.orgs.members} member${r.orgs.members === 1 ? '' : 's'}; disabled users left out)`
    : 'orgs.json: not written (one org at the workspace root, and the deployment never had one)');
  if (r.orgs.collisions.length) {
    out.push(`  left out (a pre-store build knows both by the same name): ${r.orgs.collisions.map((c) => `${c.org}/${c.login} as ${c.key}`).join(' · ')}`);
  }
  if (r.move.length) out.push(`moved to ${join(r.base, DEFAULT_MOVED)}: ${r.move.join(', ')}`);
  if (r.journeys.length) out.push(`journey file: paths rewritten: ${r.journeys.map((j) => j.name).join(', ')}`);
  if (r.cronJob) out.push(`the default org's root is now ${DEFAULT_MOVED} — point its CronJobs at ${r.cronJob}`);
  if (r.writeAccess.length) {
    out.push(`full write on a pre-store build (it enforces no roles): ${r.writeAccess.map((w) => `${w.org}/${w.key} (${w.role})`).join(' · ')}`);
  }
  if (r.ownerLoss.length) {
    out.push(`no access on a pre-store build (it has no owners; an owner enters only the orgs it is a member of): ${r.ownerLoss.map((o) => `${o.org}/${o.key} (owner)`).join(' · ')}`);
  }
  if (r.marker) out.push(`recorded what it wrote in the store and ${r.marker}: a store build starts on these files without refusing`);
  out.push(`note: ${COOKIE_NOTE}`);
  return out;
}
