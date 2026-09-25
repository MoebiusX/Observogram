// server/store/db.mjs — the one door to the embedded store (docs/STORE_PLAN.md §1).
//
// This is the ONLY file in the repo that names the SQLite built-in
// (server/test-store-guards.mjs fails the build otherwise). Everything
// else — migrations, repositories, the backup CLI — goes through the
// helpers exported here, so the rules below hold by construction:
//
//   - Node floor. The built-in is unflagged from 22.13, but 22.16 fixes a
//     StatementSync use-after-free (nodejs/node#56840) and the run()
//     statement reset (#57350). checkNodeVersion() refuses anything older,
//     numerically: '22.9.0' is older than '22.16.0' even though it sorts
//     after it as a string.
//   - The ExperimentalWarning. On 22.x the built-in prints one through
//     process.emitWarning the first time it loads. It is loaded once,
//     through a cached dynamic import(), with emitWarning wrapped to drop
//     exactly that warning; the original is restored after the import
//     settles. A static import anywhere would load it before any module
//     body runs, which is why nothing else may name it.
//   - Where the file lives. resolveDbPath(): OBSERVOGRAM_DB, else
//     <base workspace>/observogram.db; env re-read on every call, like
//     server/workspace.mjs, so a suite can re-point it between opens.
//   - Not on a network filesystem. WAL needs shared memory between the
//     processes on one host; NFS/CIFS/SMB/CephFS are refused, FUSE warned.
//   - Pragmas, in order: busy_timeout first (so everything after it waits
//     rather than failing on a lock), foreign_keys, recursive_triggers,
//     synchronous=NORMAL, then WAL for a file database (a fresh file or a
//     restored rollback-journal backup is switched and checked).
//   - Writes. tx() is BEGIN IMMEDIATE (a deferred BEGIN on a shared file
//     fails with SQLITE_BUSY_SNAPSHOT at once, whatever the timeout), runs
//     fn synchronously and commits. A thenable from fn is refused: on the
//     one shared connection an await inside a transaction lets other
//     requests' statements run inside it.
//   - Binding. prepare() rejects '?NNN' (positional only from 22.20) and
//     binds only numbers, bigints, strings, null and Uint8Array: 22.x
//     throws on a JS boolean where 24 does not, so a boolean is a bug here
//     on every version. Nothing is ever silently NULL: SQLite binds any
//     parameter left unbound as NULL and Node counts nothing, so a
//     statement is all '?' or all ':name'; a named call is one plain
//     object carrying every name; a positional call has exactly one value
//     per '?'; undefined, NaN, a Date and every other object throw (an
//     object first would otherwise be read as the named map and shift the
//     '?' values left one slot).

import { closeSync, mkdirSync, openSync, statfsSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { baseWorkspacePath, brandEnv } from '../../tools/lib/brand-env.mjs';

export const NODE_FLOOR = '22.16.0';
export const DB_FILENAME = 'observogram.db';
export const BUSY_TIMEOUT_MS = 5000;
const MEMORY = ':memory:';

// ---------- the Node floor ----------

function floorMessage(running) {
  return `observogram store: Node >= ${NODE_FLOOR} is required (node:sqlite fixes nodejs/node#56840 and #57350); running ${running}`;
}

function floorError(running) {
  const err = new Error(floorMessage(running));
  err.code = 'ERR_OBSERVOGRAM_NODE_FLOOR';
  return err;
}

// Throws the one-line floor error unless major > 22, or major 22 and
// minor >= 16. Numeric, never a string compare.
export function checkNodeVersion(v = process.versions.node) {
  const m = /^v?(\d+)\.(\d+)\./.exec(String(v));
  const major = m ? Number(m[1]) : NaN;
  const minor = m ? Number(m[2]) : NaN;
  if (!(major > 22 || (major === 22 && minor >= 16))) throw floorError(v);
  return true;
}

// ---------- loading the built-in, once, without its warning ----------

// True for exactly the warning the built-in emits on load: an
// ExperimentalWarning whose message mentions SQLite. process.emitWarning
// takes (warning, type) or (warning, { type }), and warning may be an Error.
export function isSqliteExperimentalWarning(warning, typeOrOptions) {
  const type = typeof typeOrOptions === 'string' ? typeOrOptions
    : typeOrOptions && typeof typeOrOptions === 'object' ? typeOrOptions.type
      : undefined;
  const isErr = warning instanceof Error;
  const name = type || (isErr ? warning.name : undefined);
  const message = isErr ? warning.message : String(warning);
  return name === 'ExperimentalWarning' && /SQLite/.test(message);
}

let sqlitePromise = null;

export function loadSqlite() {
  if (sqlitePromise) return sqlitePromise;
  sqlitePromise = (async () => {
    checkNodeVersion();
    const original = process.emitWarning;
    process.emitWarning = function filteredEmitWarning(warning, ...rest) {
      if (isSqliteExperimentalWarning(warning, rest[0])) return undefined;
      return original.call(this, warning, ...rest);
    };
    try {
      return await import('node:sqlite');
    } catch (e) {
      if (e?.code === 'ERR_UNKNOWN_BUILTIN_MODULE') throw floorError(process.versions.node);
      throw e;
    } finally {
      process.emitWarning = original;
    }
  })();
  // A failed load is not cached: the next caller gets the same error again.
  sqlitePromise.catch(() => { sqlitePromise = null; });
  return sqlitePromise;
}

// ---------- where the database lives ----------

export function resolveDbPath() {
  const fromEnv = brandEnv('DB');
  if (fromEnv === MEMORY) return MEMORY;
  if (fromEnv) return resolve(fromEnv);
  return join(baseWorkspacePath(), DB_FILENAME);
}

// ---------- the filesystem check ----------

// statfs f_type magic numbers (linux/magic.h, fs/smb/client, fs/ceph).
const NETWORK_FS = new Map([
  [0x6969, 'NFS'],
  [0x517b, 'SMB'],
  [0xff534d42, 'CIFS'],
  [0xfe534d42, 'SMB2'],
  [0x00c36400, 'CephFS'],
]);
const FUSE_SUPER_MAGIC = 0x65735546;

// Pure: statfs type → { kind: 'network' | 'fuse' | 'local', name }. The
// type is normalised to unsigned 32 bits, since a signed f_type renders
// CIFS/SMB2 as negative numbers.
export function classifyFilesystem(type) {
  const t = Number(type) >>> 0;
  if (NETWORK_FS.has(t)) return { kind: 'network', name: NETWORK_FS.get(t) };
  if (t === FUSE_SUPER_MAGIC) return { kind: 'fuse', name: 'FUSE' };
  return { kind: 'local', name: null };
}

// Refuses a network filesystem and warns on FUSE. Linux only: statfs types
// are Linux magic numbers.
export function checkFilesystem(dir, {
  platform = process.platform,
  statfs = statfsSync,
  warn = (msg) => process.emitWarning(msg, 'ObservogramStoreWarning'),
} = {}) {
  if (platform !== 'linux') return { kind: 'unchecked', name: null };
  const fs = classifyFilesystem(statfs(dir).type);
  if (fs.kind === 'network') {
    const err = new Error(`observogram store: ${dir} is on ${fs.name}; the database needs a local filesystem (WAL uses shared memory between processes on one host). Point OBSERVOGRAM_DB at local disk.`);
    err.code = 'ERR_OBSERVOGRAM_STORE_NETWORK_FS';
    throw err;
  }
  if (fs.kind === 'fuse') warn(`observogram store: ${dir} is on FUSE; WAL needs working shared-memory locks there. Prefer local disk.`);
  return fs;
}

// ---------- opening ----------

const handles = new Map();   // resolved path → DatabaseSync

function applyPragmas(db, file) {
  pragma(db, `busy_timeout=${BUSY_TIMEOUT_MS}`);
  pragma(db, 'foreign_keys=ON');
  pragma(db, 'recursive_triggers=ON');
  pragma(db, 'synchronous=NORMAL');
  if (!file) return;
  const [{ journal_mode: mode } = {}] = pragma(db, 'journal_mode');
  if (mode === 'wal') return;
  const [{ journal_mode: now } = {}] = pragma(db, 'journal_mode=WAL');
  if (now !== 'wal') throw new Error(`observogram store: could not switch ${file} to WAL (journal_mode reads ${JSON.stringify(now)})`);
}

// Opens (or returns the cached handle for) the store at `path`, default
// resolveDbPath(): the version check, the load, the directory, the
// filesystem check, the pragmas, then every pending migration.
export async function openStore({ path } = {}) {
  const requested = path ?? resolveDbPath();
  const target = requested === MEMORY ? MEMORY : resolve(requested);
  const { DatabaseSync } = await loadSqlite();
  const { runMigrations } = await import('./migrations.mjs');
  // Everything below is synchronous, so two concurrent openers cannot both
  // miss the cache.
  if (handles.has(target)) return handles.get(target);
  const file = target !== MEMORY;
  if (file) {
    mkdirSync(dirname(target), { recursive: true });
    checkFilesystem(dirname(target));
    // The store holds password records: create the file 0600 (SQLite would
    // create it 0644 under the usual umask). SQLite gives -wal and -shm the
    // database's mode, so they follow. An existing file keeps its mode.
    try { closeSync(openSync(target, 'wx', 0o600)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const db = new DatabaseSync(target);
  try {
    applyPragmas(db, file ? target : null);
    runMigrations(db);
  } catch (e) {
    try { db.close(); } catch {}
    throw e;
  }
  handles.set(target, db);
  installSignalHandlers();
  return db;
}

// The handle openStore() cached for the path resolveDbPath() reads now.
// The server opens it at start (boot step 1), a CLI in its preamble; every
// request-time reader gets it here. The env is re-read on every call, like
// resolveDbPath(), so a suite that re-points the workspace and opens again
// gets the new database. Throws when that store is not open, so a caller
// that runs before the open fails closed (a 500), never open.
function cachedForCurrentPath() {
  const path = resolveDbPath();
  return handles.get(path === MEMORY ? MEMORY : resolve(path)) || null;
}

export function currentStore() {
  const db = cachedForCurrentPath();
  if (db) return db;
  const err = new Error(`observogram store: the store at ${resolveDbPath()} is not open (the server opens it at start)`);
  err.code = 'ERR_OBSERVOGRAM_STORE_NOT_OPEN';
  throw err;
}

// The same lookup, without the throw.
export function storeIsOpen() {
  return cachedForCurrentPath() !== null;
}

// Closes one handle (by the path it was opened with) or, with no argument,
// every handle. Closing the last connection to a WAL file checkpoints it
// and removes the -wal file.
export function closeStore(path) {
  if (path === undefined) {
    for (const db of handles.values()) { try { db.close(); } catch {} }
    handles.clear();
    return;
  }
  const target = path === MEMORY ? MEMORY : resolve(path);
  const db = handles.get(target);
  if (!db) return;
  handles.delete(target);
  db.close();
}

// A bare connection for maintenance (backup, restore, tests): the floor,
// the load and busy_timeout, but no journal switch, no migrations and no
// cache. The caller closes it.
export async function openRaw(path, { readOnly = false, timeout = BUSY_TIMEOUT_MS } = {}) {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(path, { readOnly });
  pragma(db, `busy_timeout=${Math.max(0, Math.trunc(timeout))}`);
  return db;
}

// ---------- closing on SIGTERM / SIGINT ----------

// The server runs as PID 1 in the image and had no handler. On the first
// open, one handler per signal is installed, and the choice is made when the
// signal arrives, not when the handler was installed:
// - If someone else also listens (registered before or after the open,
//   with on or once), they own shutdown: Node's default action is already
//   off and they may still drain and write. The store stays open, and a
//   process 'exit' hook closes every handle when they end the process
//   (process.exit, or the event loop running dry). The handler is
//   prepended so a `once` listener registered earlier has not yet removed
//   itself when the count is taken.
// - Otherwise it closes every handle, removes itself and re-raises the
//   signal, so the process dies by it. 'exit' is not emitted on a death by
//   signal, so this close cannot be left to the hook.
// The kernel drops a signal sent to a PID namespace's init when it has no
// handler, so as PID 1 the re-raise does nothing (nor does any later
// SIGTERM): the process would live on with its store closed until SIGKILL.
// If it survives the re-raise, it exits 128 + the signal number, what a
// shell and kubelet report for a death by that signal.
const SIGNALS = ['SIGTERM', 'SIGINT'];
let signalsInstalled = false;
let exitInstalled = false;

function onSignal(sig) {
  if (process.listenerCount(sig) > 1) return;
  closeStore();
  for (const s of SIGNALS) process.removeListener(s, onSignal);
  signalsInstalled = false;
  process.kill(process.pid, sig);
  setImmediate(() => process.exit(128 + osConstants.signals[sig]));
}

function installSignalHandlers() {
  if (!exitInstalled) {
    exitInstalled = true;
    process.on('exit', () => closeStore());
  }
  if (signalsInstalled) return;
  signalsInstalled = true;
  for (const s of SIGNALS) process.prependListener(s, onSignal);
}

// ---------- transactions ----------

function rollbackQuietly(db) {
  try { if (db.isTransaction) db.exec('ROLLBACK'); } catch {}
}

export function tx(db, fn) {
  if (db.isTransaction) throw new Error('observogram store: tx() does not nest — a transaction is already open on this connection');
  db.exec('BEGIN IMMEDIATE');
  let result;
  try {
    result = fn(db);
  } catch (e) {
    rollbackQuietly(db);
    throw e;
  }
  if (result && typeof result.then === 'function') {
    rollbackQuietly(db);
    result.then(null, () => {});   // its rejection is ours to swallow now
    throw new Error('observogram store: tx(fn) must be synchronous — fn returned a thenable; rolled back');
  }
  try {
    db.exec('COMMIT');
  } catch (e) {
    rollbackQuietly(db);
    throw e;
  }
  return result;
}

// Composition for repositories: joins the tx() already open on this
// connection, else opens one. A repository write and its audit row then
// commit together whether it is called alone or inside a larger tx().
// A joined call runs inside a nested SAVEPOINT, so it is all or nothing on
// its own too: when it throws, its statements are rolled back to the
// savepoint and the outer tx() stays open, and a caller that catches the
// error and carries on (an import reporting errors per item) cannot commit
// a write whose audit row never ran. The savepoint is nested inside
// BEGIN IMMEDIATE, never outermost, so it takes no deferred snapshot.
// ROLLBACK TO leaves the savepoint on the stack; RELEASE pops it.
let savepointSeq = 0;

export function atomic(db, fn) {
  if (!db.isTransaction) return tx(db, fn);
  const name = `observogram_atomic_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${name}`);
  const undo = () => {
    try { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); } catch {}
  };
  let result;
  try {
    result = fn(db);
  } catch (e) {
    undo();
    throw e;
  }
  if (result && typeof result.then === 'function') {
    undo();
    result.then(null, () => {});   // its rejection is ours to swallow now
    throw new Error('observogram store: atomic(fn) must be synchronous — fn returned a thenable; rolled back to its savepoint');
  }
  db.exec(`RELEASE ${name}`);
  return result;
}

// ---------- statements ----------

// Strips string literals, quoted identifiers and comments so a '?1' inside
// a literal is not mistaken for a parameter.
function sqlWithoutLiterals(sql) {
  return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
}

function assertBindable(value, where) {
  if (value === null || typeof value === 'string' || typeof value === 'bigint'
    || (typeof value === 'number' && !Number.isNaN(value)) || value instanceof Uint8Array) return;
  const kind = value === undefined ? 'undefined' : Number.isNaN(value) ? 'NaN'
    : typeof value === 'object' ? (value.constructor?.name || 'object') : typeof value;
  throw new TypeError(`observogram store: cannot bind ${kind} to ${where} — bind numbers, bigints, strings, null or Uint8Array (booleans as 0/1)`);
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// shape: { positional: number of '?', names: [':name' names, no sigil] }.
// SQLite binds an unbound parameter as NULL and Node does not count them,
// so both are checked here: a statement is all '?' or all ':name', a
// named call is one plain object with every name, a positional call has
// exactly one value per '?'.
function checkParams(params, shape) {
  if (params.length === 1 && isPlainObject(params[0])) {
    const p = params[0];
    for (const [k, v] of Object.entries(p)) assertBindable(v, `:${k.replace(/^[:@$]/, '')}`);
    const missing = shape.names.filter((n) => !['', ':', '@', '$'].some((sigil) => Object.hasOwn(p, sigil + n)));
    if (missing.length) throw new TypeError(`observogram store: missing named parameter${missing.length > 1 ? 's' : ''} ${missing.map((n) => `:${n}`).join(', ')}`);
    if (shape.positional) throw new TypeError(`observogram store: ${shape.positional} '?' parameter(s) left unbound by a named call`);
    return;
  }
  params.forEach((p, i) => assertBindable(p, `parameter ${i + 1}`));
  if (shape.names.length) throw new TypeError(`observogram store: this statement takes named parameters (${shape.names.map((n) => `:${n}`).join(', ')}) — pass one plain object`);
  if (params.length !== shape.positional) throw new TypeError(`observogram store: statement takes ${shape.positional} '?' parameter(s), got ${params.length}`);
}

function paramShape(stripped) {
  const names = [...new Set([...stripped.matchAll(/(?<![A-Za-z0-9_$])[:@$]([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
  return { positional: (stripped.match(/\?/g) || []).length, names };
}

const statementCache = new WeakMap();   // db → Map(sql → { stmt: StatementSync, shape })

// The statement wrapper repositories use. Parameters are '?' or ':name';
// RETURNING rows are read with get()/all(), never run().changes.
export function prepare(db, sql) {
  const stripped = sqlWithoutLiterals(sql);
  if (/\?\d/.test(stripped)) {
    throw new Error(`observogram store: '?NNN' parameters are not allowed (positional only from Node 22.20) — use '?' or ':name': ${sql}`);
  }
  let cache = statementCache.get(db);
  if (!cache) { cache = new Map(); statementCache.set(db, cache); }
  let entry = cache.get(sql);
  if (!entry) { entry = { stmt: db.prepare(sql), shape: paramShape(stripped) }; cache.set(sql, entry); }
  const { stmt, shape } = entry;
  return {
    run: (...params) => { checkParams(params, shape); return stmt.run(...params); },
    get: (...params) => { checkParams(params, shape); return stmt.get(...params); },
    all: (...params) => { checkParams(params, shape); return stmt.all(...params); },
  };
}

// Runs a PRAGMA and returns its rows (an empty array for a setter that
// returns none). `text` is everything after the keyword.
export function pragma(db, text) {
  return db.prepare(`PRAGMA ${text}`).all();
}

// Multi-statement DDL for migration steps. Takes no parameters.
export function execScript(db, sql) {
  db.exec(sql);
}

// ---------- small value helpers shared by repositories ----------

export const bit = (v) => (v ? 1 : 0);
export const nowIso = () => new Date().toISOString();
