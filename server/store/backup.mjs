// server/store/backup.mjs — `packc store backup` / `restore`
// (docs/STORE_PLAN.md §3 "Backups" and "Restore").
//
// The database is WAL, so a file copy taken while any process has it open
// is not a backup, -wal and -shm included: a checkpoint between two file
// copies tears it. backupStore() runs VACUUM INTO outside any transaction
// into <path>.tmp (created 0600 first) and renames it into place: one
// consistent rollback-journal file of every committed row, taken while
// writers are active.
//
// restoreStore() is for a stopped server. It refuses while anything holds
// the database: switching a WAL database out of WAL needs exclusive
// access, so `PRAGMA journal_mode=DELETE` with no busy wait fails while
// any other connection has the file open — even an idle one, which a
// wal_checkpoint(TRUNCATE) would report as not busy. Then it moves the
// database, -wal and -shm aside together (a -wal left by an unclean stop
// would otherwise be replayed onto the restored file) and puts a copy of
// the backup in its place, with the replaced file's mode and owner rather
// than the backup's; the next open switches it back to WAL.

import { chmodSync, chownSync, closeSync, copyFileSync, constants as fsConstants, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openRaw, pragma, prepare, resolveDbPath } from './db.mjs';
import { SCHEMA_VERSION, userVersion } from './migrations.mjs';

const MEMORY = ':memory:';
const SIDECARS = ['', '-wal', '-shm'];

function refuse(message) {
  const err = new Error(message);
  err.code = 'ERR_OBSERVOGRAM_STORE_REFUSED';
  return err;
}

function removeSet(path) {
  for (const s of SIDECARS) { try { rmSync(`${path}${s}`, { force: true }); } catch {} }
}

// { version, storeId } of an open connection; storeId null when the file
// has no schema_meta (not one of ours).
function identify(db) {
  const version = userVersion(db);
  let storeId = null;
  try { storeId = prepare(db, "SELECT value FROM schema_meta WHERE key = 'store_id'").get()?.value ?? null; } catch {}
  return { version, storeId };
}

const isOurs = ({ version, storeId }) => version >= 1 && typeof storeId === 'string' && storeId.length > 0;

function stamp(now) {
  return now.toISOString().replace(/[-:.]/g, '');
}

export async function backupStore(dest, { dbPath = resolveDbPath() } = {}) {
  if (dbPath === MEMORY) throw refuse('OBSERVOGRAM_DB is :memory: — an in-memory store lives in one process and cannot be backed up from another');
  const source = resolve(dbPath);
  if (!existsSync(source)) throw refuse(`no database at ${source} — nothing to back up (this command never creates one; check OBSERVOGRAM_DB and OBSERVOGRAM_WORKSPACE)`);
  if (!dest) throw refuse('name the backup file: packc store backup <path>');
  const target = resolve(dest);
  if (target === source) throw refuse(`${target} is the database itself`);
  if (existsSync(target)) throw refuse(`${target} exists — a backup never overwrites; choose a new path`);
  const tmp = `${target}.tmp`;
  if (existsSync(tmp)) throw refuse(`${tmp} exists (an interrupted backup?) — remove it and run again`);
  mkdirSync(dirname(target), { recursive: true });
  // A backup holds the password records: VACUUM INTO would create the file
  // 0644 under the usual umask, so create it empty at 0600 first (SQLite
  // fills an existing empty target). 'wx' also closes the race with the
  // check above.
  try { closeSync(openSync(tmp, 'wx', 0o600)); } catch (e) {
    if (e.code === 'EEXIST') throw refuse(`${tmp} exists (an interrupted backup?) — remove it and run again`);
    throw e;
  }

  let db = null;
  let id;
  try {
    db = await openRaw(source);
    id = identify(db);
    if (!isOurs(id)) throw refuse(`${source} is not an Observogram store (user_version ${id.version}, ${id.storeId ? 'a store_id' : 'no store_id'})`);
    prepare(db, 'VACUUM INTO ?').run(tmp);
  } catch (e) {
    removeSet(tmp);
    throw e;
  } finally {
    db?.close();
  }
  if (existsSync(target)) { removeSet(tmp); throw refuse(`${target} appeared while the backup ran — nothing overwritten`); }
  renameSync(tmp, target);
  return { path: target, source, storeId: id.storeId, schemaVersion: id.version };
}

export async function restoreStore(backup, { dbPath = resolveDbPath(), now = new Date() } = {}) {
  if (dbPath === MEMORY) throw refuse('OBSERVOGRAM_DB is :memory: — there is no file to restore into');
  if (!backup) throw refuse('name the backup file: packc store restore <backup>');
  const target = resolve(dbPath);
  const source = resolve(backup);
  if (!existsSync(source)) throw refuse(`no backup at ${source}`);
  if (source === target) throw refuse(`${source} is the database itself`);
  const ts = stamp(now);
  mkdirSync(dirname(target), { recursive: true });

  // Validate a copy, not the caller's file: opening it must not touch it.
  const incoming = `${target}.restore-${ts}.tmp`;
  copyFileSync(source, incoming, fsConstants.COPYFILE_EXCL);
  // copyFileSync keeps the backup's mode, and backups are often made
  // read-only: a 0400 copy would become a live store the next open cannot
  // switch to WAL ("attempt to write a readonly database"). Take the
  // replaced store's mode (and, run as root, its owner) instead, always
  // with owner read-write; 0600, what openStore creates, when there was
  // none. SQLite gives -wal and -shm the database's mode, so they follow.
  let live = null;
  try { live = statSync(target); } catch {}
  try {
    chmodSync(incoming, ((live?.mode ?? 0o600) & 0o777) | 0o600);
    if (live && process.getuid?.() === 0) chownSync(incoming, live.uid, live.gid);
  } catch (e) {
    removeSet(incoming);
    throw e;
  }
  let id;
  try {
    const db = await openRaw(incoming);
    try {
      id = identify(db);
      const check = pragma(db, 'quick_check')[0]?.quick_check;
      if (!isOurs(id)) throw refuse(`${source} is not an Observogram store backup (user_version ${id.version}, ${id.storeId ? 'a store_id' : 'no store_id'})`);
      if (id.version > SCHEMA_VERSION) throw refuse(`${source} is at schema v${id.version}; this build knows up to v${SCHEMA_VERSION} — restore it with the build that wrote it`);
      if (check !== 'ok') throw refuse(`${source} fails quick_check: ${check}`);
    } finally {
      db.close();
    }
  } catch (e) {
    removeSet(incoming);
    if (e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED') throw e;
    throw refuse(`${source} is not a readable SQLite database: ${e.message}`);
  }

  // Refuse while anything holds the current database.
  let previous = null;
  let previousNote = null;
  if (existsSync(target)) {
    const cur = await openRaw(target, { timeout: 0 });
    try {
      previous = identify(cur);
      const mode = pragma(cur, 'journal_mode=DELETE')[0]?.journal_mode;
      if (mode !== 'delete') throw Object.assign(new Error(`journal_mode stayed ${mode}`), { errcode: 5 });
    } catch (e) {
      cur.close();
      if (e.errcode === 5 || e.errcode === 6 || /locked|busy/i.test(e.message)) {
        removeSet(incoming);
        throw refuse(`${target} is in use — stop the server (and any npm run users / orgs / packc store) before restoring`);
      }
      previousNote = `unreadable: ${e.message}`;
    }
    if (cur.isOpen) cur.close();
  }

  const movedAside = [];
  const aside = `${target}.pre-restore-${ts}`;
  for (const s of SIDECARS) {
    if (!existsSync(`${target}${s}`)) continue;
    renameSync(`${target}${s}`, `${aside}${s}`);
    movedAside.push(`${aside}${s}`);
  }
  renameSync(incoming, target);
  // The validating connection was the copy's last, so its -wal/-shm are
  // already gone; this only sweeps what a crash could have left.
  for (const s of SIDECARS.slice(1)) { try { rmSync(`${incoming}${s}`, { force: true }); } catch {} }
  return {
    path: target,
    source,
    storeId: id.storeId,
    schemaVersion: id.version,
    previousStoreId: previous?.storeId ?? null,
    previousNote,
    movedAside,
  };
}
