#!/usr/bin/env node
/**
 * server/test-store.mjs — the store foundation (docs/STORE_PLAN.md §1–§3,
 * §8 gates Migrations, Concurrency, Audit and Runtime).
 *
 * Every database here is a temp file (or ':memory:'), and every process
 * that must hold a lock, die by a signal or show its stderr is a child of
 * this one, run with the same Node binary — so the suite proves the floor
 * binary as well as the latest 22 when CI runs it on both.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  atomic, checkFilesystem, checkNodeVersion, classifyFilesystem, closeStore, execScript,
  isSqliteExperimentalWarning, openRaw, openStore, pragma, prepare, resolveDbPath, tx,
} from './store/db.mjs';
import { SCHEMA_VERSION, STEPS, runMigrations, userVersion } from './store/migrations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_URL = pathToFileURL(join(HERE, 'store', 'db.mjs')).href;
const MIGRATIONS_URL = pathToFileURL(join(HERE, 'store', 'migrations.mjs')).href;

const tmpDirs = [];
function tempDir(tag = 'store') {
  const d = mkdtempSync(join(tmpdir(), `observogram-${tag}-`));
  tmpDirs.push(d);
  return d;
}
process.on('exit', () => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

// A child ES module run with this very Node binary. `until` resolves once a
// line matching it appears on stdout; `done` resolves with the exit.
function child(code, { env = {} } = {}) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const waiters = [];
  proc.stdout.on('data', (b) => {
    stdout += b;
    for (const w of waiters.splice(0)) { if (w.re.test(stdout)) w.resolve(); else waiters.push(w); }
  });
  proc.stderr.on('data', (b) => { stderr += b; });
  const done = new Promise((res) => proc.on('exit', (code, signal) => res({ code, signal, stdout, stderr })));
  const until = (re) => new Promise((res, rej) => {
    if (re.test(stdout)) return res();
    waiters.push({ re, resolve: res });
    done.then((r) => rej(new Error(`child exited (${r.code}/${r.signal}) before ${re}: ${r.stderr || r.stdout}`)));
  });
  return { proc, until, done };
}

const tables = (db) => prepare(db, "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);

// ---------- Runtime: the Node floor ----------

test('checkNodeVersion refuses below 22.16 numerically, with one line naming the floor, the fixes and the running version', () => {
  for (const v of ['20.18.0', '22.13.1', '22.15.9', '18.20.4', 'v22.9.0']) {
    assert.throws(() => checkNodeVersion(v), (e) => {
      assert.equal(e.code, 'ERR_OBSERVOGRAM_NODE_FLOOR');
      assert.match(e.message, /22\.16\.0/);
      assert.match(e.message, /#56840/);
      assert.match(e.message, /#57350/);
      assert.ok(e.message.includes(v), `names the running version ${v}`);
      assert.ok(!e.message.includes('\n'), 'one line');
      return true;
    }, v);
  }
  // The string-compare trap: '22.9.0' > '22.16.0' as strings, older as numbers.
  assert.ok('22.9.0' > '22.16.0');
  assert.throws(() => checkNodeVersion('22.9.0'), /running 22\.9\.0/);
  for (const v of ['22.16.0', '22.22.2', '23.0.0', '24.1.0', 'v25.2.1']) assert.equal(checkNodeVersion(v), true, v);
  assert.throws(() => checkNodeVersion('garbage'), /running garbage/);
  assert.equal(checkNodeVersion(), true, 'the running binary passes');
});

// ---------- Runtime: the warning filter ----------

test('isSqliteExperimentalWarning matches exactly the SQLite ExperimentalWarning', () => {
  assert.ok(isSqliteExperimentalWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning'));
  assert.ok(isSqliteExperimentalWarning('SQLite is an experimental feature', { type: 'ExperimentalWarning' }));
  const err = new Error('SQLite is experimental'); err.name = 'ExperimentalWarning';
  assert.ok(isSqliteExperimentalWarning(err));
  assert.ok(!isSqliteExperimentalWarning('The Fetch API is an experimental feature', 'ExperimentalWarning'));
  assert.ok(!isSqliteExperimentalWarning('SQLite something', 'DeprecationWarning'));
  assert.ok(!isSqliteExperimentalWarning('SQLite something'));
});

test('loading the store prints no ExperimentalWarning, restores emitWarning, and an unrelated warning still prints (child process)', async () => {
  const c = child(`
    const original = process.emitWarning;
    const { openStore, closeStore } = await import(${JSON.stringify(DB_URL)});
    const db = await openStore({ path: ':memory:' });
    console.log('restored=' + (process.emitWarning === original));
    process.emitWarning('an unrelated warning still prints', 'UnrelatedWarning');
    closeStore();
  `);
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /restored=true/);
  assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
  assert.doesNotMatch(r.stderr, /SQLite/);
  assert.match(r.stderr, /UnrelatedWarning: an unrelated warning still prints/);
});

// ---------- Runtime: where the database lives ----------

test('resolveDbPath: OBSERVOGRAM_DB, else <base workspace>/observogram.db, re-read on every call; :memory: kept verbatim', () => {
  const saved = { db: process.env.OBSERVOGRAM_DB, ws: process.env.OBSERVOGRAM_WORKSPACE, tdb: process.env.TOMOGRAPH_DB };
  try {
    delete process.env.TOMOGRAPH_DB;
    const ws = tempDir('ws');
    delete process.env.OBSERVOGRAM_DB;
    process.env.OBSERVOGRAM_WORKSPACE = ws;
    assert.equal(resolveDbPath(), join(ws, 'observogram.db'));
    const ws2 = tempDir('ws');
    process.env.OBSERVOGRAM_WORKSPACE = ws2;
    assert.equal(resolveDbPath(), join(ws2, 'observogram.db'), 'env re-read per call');
    process.env.OBSERVOGRAM_DB = join(ws, 'elsewhere', 'x.db');
    assert.equal(resolveDbPath(), join(ws, 'elsewhere', 'x.db'));
    process.env.OBSERVOGRAM_DB = 'relative/y.db';
    assert.equal(resolveDbPath(), resolve('relative/y.db'));
    process.env.OBSERVOGRAM_DB = ':memory:';
    assert.equal(resolveDbPath(), ':memory:');
  } finally {
    for (const [k, v] of [['OBSERVOGRAM_DB', saved.db], ['OBSERVOGRAM_WORKSPACE', saved.ws], ['TOMOGRAPH_DB', saved.tdb]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// ---------- Runtime: the filesystem check ----------

test('classifyFilesystem: NFS, CIFS, SMB, SMB2 and CephFS are network, FUSE is fuse, the rest local', () => {
  assert.deepEqual(classifyFilesystem(0x6969), { kind: 'network', name: 'NFS' });
  assert.deepEqual(classifyFilesystem(0xff534d42), { kind: 'network', name: 'CIFS' });
  assert.deepEqual(classifyFilesystem(0xff534d42 | 0), { kind: 'network', name: 'CIFS' }, 'a signed f_type');
  assert.deepEqual(classifyFilesystem(0x517b), { kind: 'network', name: 'SMB' });
  assert.deepEqual(classifyFilesystem(0xfe534d42), { kind: 'network', name: 'SMB2' });
  assert.deepEqual(classifyFilesystem(0x00c36400), { kind: 'network', name: 'CephFS' });
  assert.deepEqual(classifyFilesystem(0x65735546), { kind: 'fuse', name: 'FUSE' });
  for (const local of [0xef53 /* ext4 */, 0x58465342 /* xfs */, 0x01021994 /* tmpfs */, 0x9123683e /* btrfs */, 0x794c7630 /* overlayfs */]) {
    assert.equal(classifyFilesystem(local).kind, 'local', local.toString(16));
  }
});

test('checkFilesystem refuses a database on NFS, warns on FUSE, passes local disk, and skips non-Linux', () => {
  const statfs = (type) => () => ({ type });
  assert.throws(() => checkFilesystem('/mnt/nfs', { platform: 'linux', statfs: statfs(0x6969) }),
    (e) => e.code === 'ERR_OBSERVOGRAM_STORE_NETWORK_FS' && /NFS/.test(e.message) && /OBSERVOGRAM_DB/.test(e.message));
  assert.throws(() => checkFilesystem('/mnt/smb', { platform: 'linux', statfs: statfs(0xfe534d42) }), /SMB2/);
  const warned = [];
  assert.equal(checkFilesystem('/mnt/fuse', { platform: 'linux', statfs: statfs(0x65735546), warn: (m) => warned.push(m) }).kind, 'fuse');
  assert.equal(warned.length, 1);
  assert.match(warned[0], /FUSE/);
  assert.equal(checkFilesystem('/x', { platform: 'linux', statfs: statfs(0xef53) }).kind, 'local');
  assert.equal(checkFilesystem('/x', { platform: 'darwin', statfs: () => { throw new Error('not called'); } }).kind, 'unchecked');
  if (process.platform === 'linux') assert.equal(checkFilesystem(tmpdir()).kind === 'network', false, 'the real temp dir is not refused');
});

// ---------- Runtime: opening ----------

test('openStore: pragmas in order, WAL on a file, one cached handle per resolved path, closeStore closes it', async () => {
  const dir = tempDir();
  const path = join(dir, 'nested', 'observogram.db');
  const db = await openStore({ path });
  try {
    assert.equal(pragma(db, 'busy_timeout')[0].timeout, 5000);
    assert.equal(pragma(db, 'foreign_keys')[0].foreign_keys, 1);
    assert.equal(pragma(db, 'recursive_triggers')[0].recursive_triggers, 1);
    assert.equal(pragma(db, 'synchronous')[0].synchronous, 1, 'NORMAL');
    assert.equal(pragma(db, 'journal_mode')[0].journal_mode, 'wal');
    assert.equal(userVersion(db), SCHEMA_VERSION);
    assert.equal(await openStore({ path: join(dir, 'nested', '..', 'nested', 'observogram.db') }), db, 'same handle for the same resolved path');
  } finally {
    closeStore(path);
  }
  assert.equal(db.isOpen, false);
  const again = await openStore({ path });
  assert.notEqual(again, db, 'a fresh handle after close');
  closeStore();
  assert.equal(again.isOpen, false, 'closeStore() closes every handle');
});

test('openStore uses OBSERVOGRAM_DB when no path is given; :memory: is exempt from WAL', async () => {
  const saved = process.env.OBSERVOGRAM_DB;
  try {
    const path = join(tempDir(), 'env.db');
    process.env.OBSERVOGRAM_DB = path;
    const db = await openStore();
    assert.ok(existsSync(path));
    assert.equal(db.location(), path);
    closeStore();
    process.env.OBSERVOGRAM_DB = ':memory:';
    const mem = await openStore();
    assert.equal(pragma(mem, 'journal_mode')[0].journal_mode, 'memory');
    assert.equal(userVersion(mem), SCHEMA_VERSION);
    closeStore(':memory:');
  } finally {
    if (saved === undefined) delete process.env.OBSERVOGRAM_DB; else process.env.OBSERVOGRAM_DB = saved;
  }
});

test('a restored rollback-journal file (a VACUUM INTO backup) is switched back to WAL on open, rows intact', async () => {
  const dir = tempDir();
  const live = join(dir, 'live.db');
  const db = await openStore({ path: live });
  const storeId = prepare(db, "SELECT value FROM schema_meta WHERE key = 'store_id'").get().value;
  const backup = join(dir, 'backup.db');
  prepare(db, 'VACUUM INTO ?').run(backup);
  closeStore(live);
  const raw = await openRaw(backup);
  assert.equal(pragma(raw, 'journal_mode')[0].journal_mode, 'delete', 'the backup is a rollback-journal file');
  raw.close();
  const restored = await openStore({ path: backup });
  assert.equal(pragma(restored, 'journal_mode')[0].journal_mode, 'wal');
  assert.equal(prepare(restored, "SELECT value FROM schema_meta WHERE key = 'store_id'").get().value, storeId);
  closeStore(backup);
});

// ---------- Runtime: binding rules ----------

test('prepare rejects ?NNN at prepare time; booleans and undefined throw at bind; numbers, bigints, strings, null and bytes bind', async () => {
  const db = await openRaw(':memory:');
  try {
    execScript(db, 'CREATE TABLE t (a ANY)');
    assert.throws(() => prepare(db, 'INSERT INTO t VALUES (?1)'), /\?NNN/);
    assert.throws(() => prepare(db, 'SELECT * FROM t WHERE a = ?12'), /\?NNN/);
    assert.doesNotThrow(() => prepare(db, "SELECT '?1' AS lit, ? AS p"), 'a ?1 inside a string literal is not a parameter');
    const ins = prepare(db, 'INSERT INTO t VALUES (?)');
    assert.throws(() => ins.run(true), /cannot bind boolean/);
    assert.throws(() => ins.run(false), /booleans as 0\/1/);
    assert.throws(() => ins.run(undefined), /cannot bind undefined/);
    assert.throws(() => prepare(db, 'INSERT INTO t VALUES (:v)').run({ v: true }), /cannot bind boolean to :v/);
    assert.throws(() => prepare(db, 'INSERT INTO t VALUES (:v)').run({ v: undefined }), /cannot bind undefined/);
    for (const v of [1, 2.5, 9007199254740993n, 'x', null, new Uint8Array([1, 2])]) ins.run(v);
    prepare(db, 'INSERT INTO t VALUES (:v)').run({ v: 7 });
    assert.equal(prepare(db, 'SELECT count(*) AS n FROM t').get().n, 7);
    const back = prepare(db, 'INSERT INTO t VALUES (?) RETURNING a').get('returned');
    assert.equal(back.a, 'returned', 'RETURNING read with get()');
  } finally {
    db.close();
  }
});

// ---------- tx() semantics ----------

test('tx: commits, rolls back and rethrows on throw, refuses a thenable (rolled back) and refuses nesting; atomic joins', async () => {
  const db = await openRaw(':memory:');
  try {
    execScript(db, 'CREATE TABLE t (a INTEGER)');
    const ins = prepare(db, 'INSERT INTO t VALUES (?)');
    const count = () => prepare(db, 'SELECT count(*) AS n FROM t').get().n;
    assert.equal(tx(db, () => { ins.run(1); return 'ok'; }), 'ok');
    assert.equal(count(), 1);
    assert.throws(() => tx(db, () => { ins.run(2); throw new Error('boom'); }), /boom/);
    assert.equal(count(), 1, 'rolled back');
    assert.equal(db.isTransaction, false);
    assert.throws(() => tx(db, async () => { ins.run(3); }), /synchronous/);
    assert.equal(count(), 1, 'the async fn ran up to its first await, and that was rolled back');
    assert.equal(db.isTransaction, false);
    assert.throws(() => tx(db, () => { ins.run(4); return Promise.reject(new Error('late')); }), /thenable/);
    assert.equal(count(), 1);
    assert.throws(() => tx(db, () => tx(db, () => ins.run(5))), /does not nest/);
    assert.equal(count(), 1, 'the outer tx rolled back too');
    tx(db, () => { ins.run(6); atomic(db, () => ins.run(7)); });
    assert.equal(count(), 3, 'atomic joined the open tx');
    atomic(db, () => ins.run(8));
    assert.equal(count(), 4, 'atomic opened its own tx');
    assert.throws(() => tx(db, () => { atomic(db, () => ins.run(9)); throw new Error('outer'); }), /outer/);
    assert.equal(count(), 4, 'a joined write rolls back with the outer tx');
  } finally {
    db.close();
  }
});

// ---------- Migrations ----------

const V1_TABLES = ['audit', 'environments', 'mcp_endpoints', 'memberships', 'orgs', 'pack_services', 'packs', 'schema_meta', 'services', 'users'];

test('migrations from user_version 0: schema v1 exactly, with a store_id and the audit triggers', async () => {
  const path = join(tempDir(), 'm.db');
  const db = await openStore({ path });
  try {
    assert.equal(userVersion(db), 1);
    assert.deepEqual(tables(db), V1_TABLES);
    const id = prepare(db, "SELECT value FROM schema_meta WHERE key = 'store_id'").get().value;
    assert.match(id, /^[0-9a-f-]{36}$/);
    const triggers = prepare(db, "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(triggers, ['audit_no_delete', 'audit_no_overwrite', 'audit_no_update']);
    assert.equal(pragma(db, 'foreign_keys')[0].foreign_keys, 1, 'foreign keys back ON after the run');
    // memberships.role is NOT NULL with a CHECK.
    const at = new Date().toISOString();
    prepare(db, "INSERT INTO users (kind, login, created_at) VALUES ('local', 'alice', ?)").run(at);
    prepare(db, "INSERT INTO orgs (id, name, root, created_at) VALUES ('acme', 'Acme', 'orgs/acme', ?)").run(at);
    assert.throws(() => prepare(db, "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES ('acme', 1, 'member', ?)").run(at), /CHECK/);
    assert.throws(() => prepare(db, "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES ('acme', 1, NULL, ?)").run(at), /NOT NULL/);
    assert.throws(() => prepare(db, "INSERT INTO orgs (id, name, root, created_at) VALUES ('b', 'B', 'elsewhere', ?)").run(at), /CHECK/, 'root is . or orgs/<id>');
    assert.throws(() => prepare(db, "INSERT INTO users (kind, login, disabled, created_at) VALUES ('local', 'x', 'true', ?)").run(at), /./, 'STRICT refuses a text boolean');
    assert.equal(prepare(db, "SELECT session_epoch FROM users WHERE login = 'alice'").get().session_epoch, 1, 'a new row starts at epoch 1');
  } finally {
    closeStore(path);
  }
  // A second open applies nothing.
  const raw = await openRaw(path);
  assert.deepEqual(runMigrations(raw), { from: 1, to: 1, applied: [] });
  raw.close();
});

// A v2 step that rebuilds `users` under `memberships` the plan's way:
// X_new, copy, drop X, rename — never renaming the parent away first.
const V2_REBUILD_USERS = {
  version: 2,
  name: 'rebuild users (test)',
  up(db) {
    execScript(db, `
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('local', 'oidc')), login TEXT NOT NULL UNIQUE,
        issuer TEXT, sub TEXT, email TEXT, email_verified INTEGER NOT NULL DEFAULT 0, name TEXT, password TEXT,
        must_change INTEGER NOT NULL DEFAULT 0, seeded_default INTEGER NOT NULL DEFAULT 0, is_owner INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0, session_epoch INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
        last_login_at TEXT, nickname TEXT
      ) STRICT;
      INSERT INTO users_new (id, kind, login, issuer, sub, email, email_verified, name, password, must_change, seeded_default,
        is_owner, disabled, session_epoch, created_at, last_login_at)
        SELECT id, kind, login, issuer, sub, email, email_verified, name, password, must_change, seeded_default,
        is_owner, disabled, session_epoch, created_at, last_login_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
  },
};

async function v1WithChildren(path) {
  const db = await openStore({ path });
  const at = new Date().toISOString();
  prepare(db, "INSERT INTO users (kind, login, created_at) VALUES ('local', 'alice', ?), ('local', 'bob', ?)").run(at, at);
  prepare(db, "INSERT INTO orgs (id, name, root, created_at) VALUES ('default', 'Default', '.', ?), ('acme', 'Acme', 'orgs/acme', ?)").run(at, at);
  prepare(db, "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES ('default', 1, 'admin', ?), ('acme', 2, 'viewer', ?), ('acme', 1, 'operator', ?)").run(at, at, at);
  closeStore(path);
  return openRaw(path);
}

test('migrations from v1: a v2 step that rebuilds users under memberships keeps every child row', async () => {
  const path = join(tempDir(), 'v1.db');
  const db = await v1WithChildren(path);
  try {
    pragma(db, 'foreign_keys=ON');
    const r = runMigrations(db, [...STEPS, V2_REBUILD_USERS]);
    assert.deepEqual(r, { from: 1, to: 2, applied: [2] });
    assert.equal(prepare(db, 'SELECT count(*) AS n FROM memberships').get().n, 3);
    assert.deepEqual(pragma(db, 'foreign_key_check'), []);
    const fk = pragma(db, 'foreign_key_list(memberships)').map((r) => r.table).sort();
    assert.deepEqual(fk, ['orgs', 'users'], 'the children still point at users, not a renamed old table');
    assert.equal(pragma(db, 'foreign_keys')[0].foreign_keys, 1);
    assert.ok(pragma(db, 'table_info(users)').some((c) => c.name === 'nickname'));
  } finally {
    db.close();
  }
});

test('a failing step rolls back, leaves user_version and foreign_keys ON; a step that breaks a foreign key is refused', async () => {
  const path = join(tempDir(), 'fail.db');
  const db = await v1WithChildren(path);
  try {
    pragma(db, 'foreign_keys=ON');
    const throwing = { version: 2, name: 'throws', up(d) { execScript(d, 'CREATE TABLE half_done (a)'); throw new Error('step exploded'); } };
    assert.throws(() => runMigrations(db, [...STEPS, throwing]), /step exploded/);
    assert.equal(userVersion(db), 1);
    assert.equal(pragma(db, 'foreign_keys')[0].foreign_keys, 1, 'foreign_keys back ON after a failure');
    assert.ok(!tables(db).includes('half_done'), 'the step rolled back');
    const orphaning = { version: 2, name: 'orphans memberships', up(d) { execScript(d, "DELETE FROM users WHERE login = 'bob'"); } };
    assert.throws(() => runMigrations(db, [...STEPS, orphaning]), /foreign-key violation/);
    assert.equal(userVersion(db), 1);
    assert.equal(prepare(db, "SELECT count(*) AS n FROM users WHERE login = 'bob'").get().n, 1, 'bob is back');
    assert.equal(pragma(db, 'foreign_keys')[0].foreign_keys, 1);
    assert.throws(() => runMigrations(db, [{ ...V2_REBUILD_USERS, version: 3 }]), /numbered 1\.\.n/);
  } finally {
    db.close();
  }
});

test('a database from a newer build is refused, not migrated', async () => {
  const path = join(tempDir(), 'newer.db');
  const db = await v1WithChildren(path);
  pragma(db, 'user_version=7');
  db.close();
  await assert.rejects(openStore({ path }), /schema v7, but this build knows up to v1/);
});

// ---------- Concurrency ----------

// A child that takes BEGIN IMMEDIATE through tx(), says "locked", holds it
// for `holdMs` (< busy_timeout) and commits.
function lockHolder(path, holdMs) {
  return child(`
    import { writeSync } from 'node:fs';
    const { openRaw, tx, prepare } = await import(${JSON.stringify(DB_URL)});
    const db = await openRaw(${JSON.stringify(path)});
    tx(db, () => {
      prepare(db, "INSERT INTO schema_meta (key, value) VALUES ('held_by_child', 'yes')").run();
      writeSync(1, 'locked\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
    });
    db.close();
  `);
}

test('Concurrency: a write waits out a child holding BEGIN IMMEDIATE for less than busy_timeout, then succeeds', async () => {
  const path = join(tempDir(), 'conc.db');
  const db = await openStore({ path });
  try {
    const holder = lockHolder(path, 700);
    await holder.until(/locked/);
    const t0 = Date.now();
    tx(db, () => prepare(db, "INSERT INTO schema_meta (key, value) VALUES ('parent', 'wrote')").run());
    const waited = Date.now() - t0;
    const r = await holder.done;
    assert.equal(r.code, 0, r.stderr);
    assert.ok(waited >= 300, `the parent waited on the lock (${waited} ms)`);
    assert.equal(prepare(db, "SELECT value FROM schema_meta WHERE key = 'parent'").get().value, 'wrote');
    assert.equal(prepare(db, "SELECT value FROM schema_meta WHERE key = 'held_by_child'").get().value, 'yes');
  } finally {
    closeStore(path);
  }
});

test('Concurrency: a migration waits out a child holding BEGIN IMMEDIATE, then applies', async () => {
  const path = join(tempDir(), 'conc-mig.db');
  await openStore({ path });
  closeStore(path);
  const db = await openRaw(path);
  try {
    const holder = lockHolder(path, 700);
    await holder.until(/locked/);
    const t0 = Date.now();
    const step = { version: 2, name: 'add a table', up(d) { execScript(d, 'CREATE TABLE later (a INTEGER)'); } };
    assert.deepEqual(runMigrations(db, [...STEPS, step]).applied, [2]);
    const waited = Date.now() - t0;
    assert.equal((await holder.done).code, 0);
    assert.ok(waited >= 300, `the migration waited on the lock (${waited} ms)`);
    assert.ok(tables(db).includes('later'));
  } finally {
    db.close();
  }
});

test('Migrations: two openers racing the same step apply it once', async () => {
  const path = join(tempDir(), 'race.db');
  const steps = `[{ version: 1, name: 'counted', up(d) {
      execScript(d, 'CREATE TABLE applied (by TEXT)');
      prepare(d, 'INSERT INTO applied VALUES (?)').run(WHO);
      HOLD();
    } }]`;
  const c = child(`
    import { writeSync } from 'node:fs';
    const { openRaw, execScript, prepare } = await import(${JSON.stringify(DB_URL)});
    const { runMigrations } = await import(${JSON.stringify(MIGRATIONS_URL)});
    const WHO = 'child';
    const HOLD = () => { writeSync(1, 'locked\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700); };
    const db = await openRaw(${JSON.stringify(path)});
    console.log(JSON.stringify(runMigrations(db, ${steps})));
    db.close();
  `);
  await c.until(/locked/);
  const db = await openRaw(path);
  try {
    const WHO = 'parent';
    const HOLD = () => {};
    // The same step, built in this process.
    const parentSteps = new Function('execScript', 'prepare', 'WHO', 'HOLD', `return ${steps};`)(execScript, prepare, WHO, HOLD);
    assert.equal(userVersion(db), 0, 'the parent sees v0 before it waits');
    const mine = runMigrations(db, parentSteps);
    const theirs = await c.done;
    assert.equal(theirs.code, 0, theirs.stderr);
    assert.deepEqual(JSON.parse(theirs.stdout.trim().split('\n').pop()).applied, [1]);
    assert.deepEqual(mine.applied, [], 'the parent re-read user_version inside its tx and skipped');
    assert.deepEqual(prepare(db, 'SELECT by FROM applied').all().map((r) => r.by), ['child']);
  } finally {
    db.close();
  }
});

// ---------- Audit is append-only ----------

async function auditFixture() {
  const path = join(tempDir(), 'audit.db');
  const db = await openStore({ path });
  const at = new Date().toISOString();
  const ins = prepare(db, "INSERT INTO audit (at, actor, action, target_kind, target_id) VALUES (?, 'alice', ?, 'user', 'bob')");
  ins.run(at, 'user.create');
  ins.run(at, 'user.disable');
  const snapshot = () => prepare(db, 'SELECT * FROM audit ORDER BY seq').all().map((r) => ({ ...r }));
  return { path, db, at, snapshot };
}

const TAMPERING = [
  ['UPDATE', "UPDATE audit SET actor = 'mallory' WHERE seq = 1"],
  ['DELETE', 'DELETE FROM audit WHERE seq = 1'],
  ['UPSERT', "INSERT INTO audit (seq, at, actor, action) VALUES (1, 'x', 'mallory', 'forged') ON CONFLICT (seq) DO UPDATE SET actor = excluded.actor"],
  ['REPLACE', "REPLACE INTO audit (seq, at, actor, action) VALUES (1, 'x', 'mallory', 'forged')"],
  ['INSERT OR REPLACE', "INSERT OR REPLACE INTO audit (seq, at, actor, action) VALUES (2, 'x', 'mallory', 'forged')"],
];

test('Audit: UPDATE, DELETE, UPSERT, REPLACE and INSERT OR REPLACE abort and leave the rows unchanged; a plain insert passes', async () => {
  const { path, db, at, snapshot } = await auditFixture();
  try {
    const before = snapshot();
    for (const [what, sql] of TAMPERING) {
      assert.throws(() => tx(db, () => prepare(db, sql).run()), /audit is append-only/, what);
      assert.deepEqual(snapshot(), before, `${what} left the rows unchanged`);
    }
    prepare(db, "INSERT INTO audit (at, actor, action) VALUES (?, 'alice', 'org.create')").run(at);
    assert.equal(snapshot().length, 3, 'a plain insert passes');
  } finally {
    closeStore(path);
  }
});

test('Audit: the same on a raw connection opened without recursive_triggers', async () => {
  const { path, snapshot } = await auditFixture();
  const before = snapshot();
  closeStore(path);
  const raw = await openRaw(path);
  try {
    assert.equal(pragma(raw, 'recursive_triggers')[0].recursive_triggers, 0, 'recursive_triggers is off on this connection');
    const rows = () => prepare(raw, 'SELECT * FROM audit ORDER BY seq').all().map((r) => ({ ...r }));
    for (const [what, sql] of TAMPERING) {
      assert.throws(() => prepare(raw, sql).run(), /audit is append-only/, what);
      assert.deepEqual(rows(), before, `${what} left the rows unchanged`);
    }
    prepare(raw, "INSERT INTO audit (at, actor, action) VALUES ('t', 'alice', 'plain')").run();
    assert.equal(rows().length, 3);
  } finally {
    raw.close();
  }
});

// ---------- closing on a signal ----------

for (const sig of ['SIGTERM', 'SIGINT']) {
  test(`${sig}: the child closes the store (no -wal left behind) and still dies by the signal`, async () => {
    const path = join(tempDir(), 'sig.db');
    const c = child(`
      const { openStore, prepare, tx } = await import(${JSON.stringify(DB_URL)});
      const db = await openStore({ path: ${JSON.stringify(path)} });
      tx(db, () => prepare(db, "INSERT INTO schema_meta (key, value) VALUES ('before_signal', 'kept')").run());
      console.log('ready');
      setInterval(() => {}, 1000);
    `);
    await c.until(/ready/);
    assert.ok(existsSync(`${path}-wal`), 'the -wal exists while the store is open');
    c.proc.kill(sig);
    const r = await c.done;
    assert.equal(r.signal, sig, `died by ${sig} (code ${r.code}, stderr ${r.stderr})`);
    assert.equal(existsSync(`${path}-wal`), false, 'no -wal left behind');
    const raw = await openRaw(path);
    assert.equal(prepare(raw, "SELECT value FROM schema_meta WHERE key = 'before_signal'").get().value, 'kept');
    raw.close();
  });
}
