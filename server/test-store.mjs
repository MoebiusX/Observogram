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

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, chownSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

// Every child this file spawns, until it exits. A failed assertion can leave
// one running (a setInterval never ends on its own) and its pipes would keep
// this file alive; whatever failed, none outlives the file.
const live = new Set();
function track(proc) {
  live.add(proc);
  proc.on('exit', () => live.delete(proc));
  return proc;
}
after(() => { for (const p of live) p.kill('SIGKILL'); });

// A child ES module run with this very Node binary. `until` resolves once a
// line matching it appears on stdout; `done` resolves with the exit. Both
// bounded waits SIGKILL a child still running at their deadline and reject,
// so a child that never gets there fails its test instead of hanging it:
// `until(re, ms)` for the line, `exited(ms, what)` for the exit. A test
// awaits `exited`, never `done` alone, for a child it expects to end.
function child(code, { env = {} } = {}) {
  const proc = track(spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  let stdout = '';
  let stderr = '';
  const waiters = [];
  proc.stdout.on('data', (b) => {
    stdout += b;
    for (const w of waiters.splice(0)) { if (w.re.test(stdout)) w.resolve(); else waiters.push(w); }
  });
  proc.stderr.on('data', (b) => { stderr += b; });
  const done = new Promise((res) => proc.on('exit', (code, signal) => res({ code, signal, stdout, stderr })));
  const deadline = (ms, onTimeout) => setTimeout(() => { proc.kill('SIGKILL'); onTimeout(); }, ms);
  const until = (re, ms = 10_000) => new Promise((res, rej) => {
    if (re.test(stdout)) return res();
    const t = deadline(ms, () => rej(new Error(`child printed no ${re} in ${ms} ms: ${stderr || stdout}`)));
    waiters.push({ re, resolve: () => { clearTimeout(t); res(); } });
    done.then((r) => { clearTimeout(t); rej(new Error(`child exited (${r.code}/${r.signal}) before ${re}: ${r.stderr || r.stdout}`)); });
  });
  const exited = (ms, what) => new Promise((res, rej) => {
    const t = deadline(ms, () => rej(new Error(`child still running ${ms} ms after ${what}: ${stderr || stdout}`)));
    done.then((r) => { clearTimeout(t); res(r); });
  });
  return { proc, until, done, exited };
}

const tables = (db) => prepare(db, "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);

// ---------- the harness: a stuck child fails its test, it does not hang the file ----------

test('child(): exited() rejects, naming the wait, and SIGKILLs a child still running after its deadline', async () => {
  const c = child(`
    process.on('SIGTERM', () => {});   // a handler that swallows the signal
    console.log('ready');
    setInterval(() => {}, 1000);
  `);
  await c.until(/ready/);
  c.proc.kill('SIGTERM');
  const t0 = Date.now();
  await assert.rejects(c.exited(300, 'SIGTERM'), /child still running 300 ms after SIGTERM/);
  assert.ok(Date.now() - t0 < 5000, 'the deadline, not the child, ended the wait');
  assert.equal((await c.done).signal, 'SIGKILL', 'the stuck child was killed, not left behind');
  const quick = child('process.exit(3)');
  assert.equal((await quick.exited(10_000, 'start')).code, 3, 'a child that exits in time resolves with its exit');
});

test('child(): until() rejects and SIGKILLs a child that stays up without ever printing the line', async () => {
  const c = child('setInterval(() => {}, 1000);');
  await assert.rejects(c.until(/ready/, 300), /printed no \/ready\/ in 300 ms/);
  assert.equal((await c.done).signal, 'SIGKILL');
});

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
  const r = await c.exited(10_000, 'start');
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

test('prepare never binds NULL by omission: NaN, Date and other objects, a missing :name, too few ? values and an object before positional values all throw', async () => {
  const db = await openRaw(':memory:');
  try {
    const one = prepare(db, 'SELECT ? AS v');
    assert.throws(() => one.get(NaN), /cannot bind NaN to parameter 1/);
    assert.throws(() => one.get(new Date()), /cannot bind Date to parameter 1/, 'a Date is not an empty named map');
    assert.throws(() => one.get({}), /named parameters|'\?' parameter/, 'an empty object does not leave ? unbound');
    assert.throws(() => one.get(new Map()), /cannot bind Map/);
    assert.throws(() => one.get(Object.create(null)), /'\?' parameter/);
    assert.throws(() => one.get(), /takes 1 '\?' parameter\(s\), got 0/, 'SQLite would bind the unbound ? as NULL');
    assert.throws(() => prepare(db, 'SELECT ? AS a, ? AS b').get(1), /takes 2 '\?' parameter\(s\), got 1/);
    assert.throws(() => prepare(db, 'SELECT ? AS a, ? AS b, ? AS c').get(new Date(), 'org', 'id'), /cannot bind Date to parameter 1/,
      'an object first would be read as the named map and shift every ? left one slot');
    const named = prepare(db, 'SELECT :a AS a, :b AS b');
    assert.throws(() => named.get({ a: 1 }), /missing named parameter :b/);
    assert.throws(() => named.get(1, 2), /takes named parameters \(:a, :b\)/);
    assert.throws(() => named.get({ a: NaN, b: 1 }), /cannot bind NaN to :a/);
    assert.deepEqual({ ...named.get({ a: 1, b: null }) }, { a: 1, b: null }, 'an explicit null still binds');
    assert.deepEqual({ ...prepare(db, "SELECT ? AS v, ':x' AS lit, 1e999 AS inf").get(Infinity) }, { v: Infinity, lit: ':x', inf: Infinity },
      'Infinity binds; a :name inside a literal is not a parameter');
    assert.deepEqual({ ...prepare(db, 'SELECT :a + :a AS v').get({ a: 2 }) }, { v: 4 }, 'a repeated name needs one key');
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
    tx(db, () => {
      ins.run(10);
      assert.throws(() => atomic(db, () => { ins.run(11); throw new Error('inner'); }), /inner/);
      assert.equal(db.isTransaction, true, 'the outer tx is still open');
      assert.throws(() => atomic(db, () => { ins.run(12); return Promise.resolve(); }), /synchronous/);
      atomic(db, () => atomic(db, () => ins.run(13)));
      ins.run(14);
    });
    assert.deepEqual(prepare(db, 'SELECT a FROM t WHERE a >= 10 ORDER BY a').all().map((r) => r.a), [10, 13, 14],
      'a joined atomic that throws or returns a thenable is undone alone; the outer tx commits the rest');
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
    const r = await holder.exited(10_000, "the parent's write");
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
    assert.equal((await holder.exited(10_000, 'the migration')).code, 0);
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
    const theirs = await c.exited(10_000, "the parent's migration");
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
  // Backdating: a new seq below the newest would list as older history.
  ['backdated seq 0', "INSERT INTO audit (seq, at, actor, action) VALUES (0, 'x', 'mallory', 'forged')"],
  ['backdated seq -5', "INSERT INTO audit (seq, at, actor, action) VALUES (-5, 'x', 'mallory', 'forged')"],
  // -1 is what an auto-assigned seq looks like to the trigger; the CHECK refuses it.
  ['backdated seq -1', "INSERT INTO audit (seq, at, actor, action) VALUES (-1, 'x', 'mallory', 'forged')", /CHECK constraint failed/],
];

test('Audit: UPDATE, DELETE, UPSERT, REPLACE and INSERT OR REPLACE abort and leave the rows unchanged; a plain insert passes', async () => {
  const { path, db, at, snapshot } = await auditFixture();
  try {
    const before = snapshot();
    for (const [what, sql, re = /audit is append-only/] of TAMPERING) {
      assert.throws(() => tx(db, () => prepare(db, sql).run()), re, what);
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
    for (const [what, sql, re = /audit is append-only/] of TAMPERING) {
      assert.throws(() => prepare(raw, sql).run(), re, what);
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
    let r;
    try {
      await c.until(/ready/);
      assert.ok(existsSync(`${path}-wal`), 'the -wal exists while the store is open');
      c.proc.kill(sig);
      r = await c.exited(10_000, sig);
    } finally {
      c.proc.kill('SIGKILL');
    }
    assert.equal(r.signal, sig, `died by ${sig} (code ${r.code}, stderr ${r.stderr})`);
    assert.equal(existsSync(`${path}-wal`), false, 'no -wal left behind');
    const raw = await openRaw(path);
    assert.equal(prepare(raw, "SELECT value FROM schema_meta WHERE key = 'before_signal'").get().value, 'kept');
    raw.close();
  });
}

// A process with its own shutdown handler (drain, write a final row, then
// exit) owns shutdown: the store must stay open under that handler, whether
// it was registered before or after the first open, or as a `once`, and
// must still be closed (checkpointed, no -wal) when that handler exits.
for (const [where, how] of [['before', 'on'], ['after', 'on'], ['before', 'once']]) {
  test(`SIGTERM with the process's own handler (${how}, registered ${where} the open): the store stays usable until it exits`, async () => {
    const path = join(tempDir(), `sig-owned-${where}-${how}.db`);
    const c = child(`
      const { openStore, prepare, tx } = await import(${JSON.stringify(DB_URL)});
      let db;
      const mine = () => setTimeout(() => {
        try {
          tx(db, () => prepare(db, "INSERT INTO schema_meta (key, value) VALUES ('after_signal', 'drained')").run());
          console.log('wrote');
        } catch (e) { console.log('store error: ' + e.message); }
        process.exit(0);
      }, 200);
      if (${JSON.stringify(where)} === 'before') process.${how}('SIGTERM', mine);
      db = await openStore({ path: ${JSON.stringify(path)} });
      if (${JSON.stringify(where)} === 'after') process.${how}('SIGTERM', mine);
      console.log('ready');
      setInterval(() => {}, 1000);
    `);
    await c.until(/ready/);
    c.proc.kill('SIGTERM');
    const r = await c.exited(10_000, 'SIGTERM');
    assert.equal(r.code, 0, `the handler exited on its own (signal ${r.signal}, stdout ${r.stdout}, stderr ${r.stderr})`);
    assert.doesNotMatch(r.stdout, /store error/);
    assert.match(r.stdout, /wrote/);
    assert.equal(existsSync(`${path}-wal`), false, 'no -wal left behind');
    const raw = await openRaw(path);
    assert.equal(prepare(raw, "SELECT value FROM schema_meta WHERE key = 'after_signal'").get().value, 'drained');
    raw.close();
  });
}

// PID 1 (the image runs node with no init) gets no default action for a
// signal it does not handle: the handler's own re-raise and every later
// SIGTERM are dropped by the kernel. The handler must still end the process,
// with the shell's 128 + signal number, instead of leaving it up with the
// store closed until SIGKILL.
const SIGNAL_EXIT = { SIGTERM: 143, SIGINT: 130 };
const SIG_CHILD = (path) => `
  const { openStore, prepare } = await import(${JSON.stringify(DB_URL)});
  const db = await openStore({ path: ${JSON.stringify(path)} });
  console.log('ready');
  setInterval(() => { try { prepare(db, 'SELECT 1').get(); } catch (e) { console.log('closed-but-alive: ' + e.message); } }, 50);
`;

for (const sig of ['SIGTERM', 'SIGINT']) {
  test(`${sig}: when the re-raise is dropped (as for PID 1) the child still exits ${SIGNAL_EXIT[sig]} with the store closed`, async () => {
    const path = join(tempDir(), 'sig-dropped.db');
    // A no-op process.kill stands in for the kernel ignoring the re-raise.
    const c = child(`process.kill = () => true;\n${SIG_CHILD(path)}`);
    await c.until(/ready/);
    c.proc.kill(sig);
    const r = await c.exited(3000, sig);
    assert.equal(r.code, SIGNAL_EXIT[sig], `exit code (signal ${r.signal}, stdout ${r.stdout}, stderr ${r.stderr})`);
    assert.doesNotMatch(r.stdout, /closed-but-alive/);
    assert.equal(existsSync(`${path}-wal`), false, 'no -wal left behind');
  });
}

// The real thing: node as PID 1 of a fresh PID namespace, signalled from
// outside it, as kubelet does. Skipped where unshare is unavailable.
const UNSHARE = (() => {
  if (process.platform !== 'linux') return null;
  const base = ['--pid', '--fork', '--kill-child'];
  const tries = [base, ['--user', '--map-root-user', ...base]];
  for (const args of tries) {
    const r = spawnSync('unshare', [...args, process.execPath, '-e', 'process.exit(process.pid === 1 ? 0 : 7)'], { stdio: 'ignore', timeout: 5000 });
    if (r.status === 0) return args;
  }
  return null;
})();

test('SIGTERM to node running as PID 1: the store closes and the process exits 143', { skip: UNSHARE ? false : 'unshare --pid is unavailable here' }, async () => {
  const path = join(tempDir(), 'sig-pid1.db');
  const proc = track(spawn('unshare', [...UNSHARE, process.execPath, '--input-type=module', '-e', `
    if (process.pid !== 1) { console.log('not pid 1'); process.exit(9); }
    ${SIG_CHILD(path)}
  `], { stdio: ['ignore', 'pipe', 'pipe'] }));
  let stdout = '';
  let stderr = '';
  proc.stderr.on('data', (b) => { stderr += b; });
  const ready = new Promise((res, rej) => {
    proc.stdout.on('data', (b) => { stdout += b; if (/ready/.test(stdout)) res(); });
    proc.on('exit', () => rej(new Error(`exited before ready: ${stdout} ${stderr}`)));
    setTimeout(() => rej(new Error(`no ready in 10 s: ${stdout} ${stderr}`)), 10_000).unref();
  });
  const done = new Promise((res) => proc.on('exit', (code, signal) => res({ code, signal })));
  let r;
  let nodePid;
  try {
    await ready;
    // `unshare --fork` forwards nothing; signal node itself, from outside its
    // namespace. Its host pid is unshare's only child.
    const kids = readFileSync(`/proc/${proc.pid}/task/${proc.pid}/children`, 'utf8').trim().split(/\s+/);
    assert.equal(kids.length, 1, `unshare has one child (${kids})`);
    nodePid = Number(kids[0]);
    assert.match(readFileSync(`/proc/${nodePid}/status`, 'utf8'), /^NSpid:.*\s1$/m, 'node is PID 1 in its namespace');
    process.kill(nodePid, 'SIGTERM');
    r = await Promise.race([done, new Promise((res) => setTimeout(() => res(null), 3000))]);
  } finally {
    // SIGKILL reaches a namespace's init from outside it; --kill-child takes
    // node down with unshare if node's pid was never read.
    if (!r && nodePid) { try { process.kill(nodePid, 'SIGKILL'); } catch {} }
    proc.kill('SIGKILL');
  }
  assert.ok(r, `PID 1 was still alive 3 s after SIGTERM (stdout ${stdout})`);
  assert.equal(r.code, 143, `unshare reports node's exit (${JSON.stringify(r)}, stderr ${stderr})`);
  assert.doesNotMatch(stdout, /closed-but-alive/);
  assert.equal(existsSync(`${path}-wal`), false, 'no -wal left behind');
});

// ---------- Repositories ----------

const { runWithOrg } = await import('./tenancy.mjs');
const users = await import('./store/users.mjs');
const orgs = await import('./store/orgs.mjs');
const memberships = await import('./store/memberships.mjs');
const auditRepo = await import('./store/audit.mjs');
const meta = await import('./store/meta.mjs');
const services = await import('./store/services.mjs');
const environments = await import('./store/environments.mjs');
const mcpEndpoints = await import('./store/mcp-endpoints.mjs');
const packs = await import('./store/packs.mjs');
const packServices = await import('./store/pack-services.mjs');

async function freshStore(tag) {
  const path = join(tempDir(tag), 'observogram.db');
  const db = await openStore({ path });
  return { path, db, close: () => closeStore(path) };
}
const auditActions = (db, filter = {}) => auditRepo.listAudit(db, { limit: 1000, ...filter }).reverse().map((r) => r.action);

test('users: 0/1 booleans, the password record verbatim, epoch 1 by default and bumped by revocations, one audit row per change', async () => {
  const { db, close } = await freshStore('users');
  try {
    const pw = { algo: 'scrypt', N: 16384, r: 8, p: 1, salt: 'c2FsdA==', hash: 'aGFzaA==' };
    const alice = users.createUser(db, 'system', { login: 'alice', name: 'Alice', password: pw, isOwner: true, mustChange: true });
    assert.equal(alice.sessionEpoch, 1);
    assert.deepEqual(alice.password, pw);
    assert.equal(alice.isOwner, true);
    assert.equal(alice.mustChange, true);
    assert.equal(alice.disabled, false);
    const raw = prepare(db, 'SELECT is_owner, must_change, disabled, typeof(is_owner) AS t FROM users WHERE id = ?').get(alice.id);
    assert.deepEqual({ ...raw }, { is_owner: 1, must_change: 1, disabled: 0, t: 'integer' });
    assert.equal(users.getUserByLogin(db, 'alice').id, alice.id);
    const oidc = users.createUser(db, 'system', { kind: 'oidc', login: 'idp#sub-1', issuer: 'https://idp.example', sub: 'sub-1', email: 'b@x.io', emailVerified: true });
    assert.equal(oidc.emailVerified, true);
    assert.throws(() => users.createUser(db, 'system', { kind: 'oidc', login: 'idp#sub-2' }), /CHECK/, 'an OIDC row needs issuer and sub');
    assert.throws(() => users.createUser(db, 'system', { login: 'alice' }), /UNIQUE/);
    assert.throws(() => users.createUser(db, 'system', { kind: 'saml', login: 'x' }), /local or oidc/);
    assert.throws(() => users.createUser(db, '', { login: 'nobody' }), /needs an actor/);
    assert.equal(users.getUserByLogin(db, 'nobody'), null);

    assert.equal(users.bumpSessionEpoch(db, 'alice', alice.id), 2);
    assert.equal(users.setPassword(db, 'alice', alice.id, { ...pw, hash: 'bmV3' }).sessionEpoch, 3, 'a password change bumps');
    assert.equal(users.getUser(db, alice.id).mustChange, false);
    assert.throws(() => users.getUser(db, new Date()), /cannot bind Date/, 'a wrong-typed id throws, not a silent null');
    assert.equal(users.setDisabled(db, 'alice', oidc.id, true).sessionEpoch, 2, 'disabling bumps');
    assert.equal(users.setDisabled(db, 'alice', oidc.id, false).sessionEpoch, 2, 'enabling does not');
    assert.equal(users.updateUserProfile(db, 'alice', alice.id, { name: 'Alice A.', emailVerified: false }).name, 'Alice A.');
    assert.equal(users.getUser(db, alice.id).sessionEpoch, 3, 'a profile edit does not bump');
    assert.equal(users.setOwner(db, 'alice', oidc.id, true).isOwner, true);
    assert.throws(() => users.setDisabled(db, 'alice', 999, true), /no user 999/);
    assert.deepEqual(auditActions(db), [
      'user.create', 'user.create', 'user.signout', 'user.password', 'user.disable', 'user.enable', 'user.update', 'user.owner.grant',
    ], 'exactly one row per successful change, none for a refused one');
    const [latest] = auditRepo.listAudit(db, { limit: 1 });
    assert.equal(latest.actor, 'alice');
    assert.equal(latest.orgId, null, 'user changes are deployment events');
    assert.equal(latest.targetId, 'idp#sub-1');
  } finally {
    close();
  }
});

test('a repository write and its audit row commit together: a composed tx() that throws leaves neither', async () => {
  const { db, close } = await freshStore('atomic');
  try {
    assert.throws(() => tx(db, () => {
      users.createUser(db, 'system', { login: 'ghost' });
      throw new Error('after the write');
    }), /after the write/);
    assert.equal(users.getUserByLogin(db, 'ghost'), null);
    assert.deepEqual(auditActions(db), []);
    tx(db, () => { users.createUser(db, 'system', { login: 'a' }); users.createUser(db, 'system', { login: 'b' }); });
    assert.deepEqual(auditActions(db), ['user.create', 'user.create']);
    assert.throws(() => auditRepo.writeAudit(db, 'x', { action: 'loose' }), /inside the tx\(\)/);
  } finally {
    close();
  }
});

test('a joined repository call that throws is undone on its own: a caller that catches it and carries on commits no write without its audit row', async () => {
  const { db, close } = await freshStore('atomic-joined');
  try {
    const pw = { algo: 'scrypt', hash: 'b2xk' };
    const errors = [];
    tx(db, () => {
      // An import loop that reports each item's error and carries on.
      for (const [actor, login] of [['system', 'ok1'], ['', 'ghost'], ['system', 'ok2']]) {
        try { users.createUser(db, actor, { login, password: pw }); } catch (e) { errors.push(e.message); }
      }
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /needs an actor/);
    assert.equal(users.getUserByLogin(db, 'ghost'), null, 'the refused call left no user row');
    assert.deepEqual(auditRepo.listAudit(db).reverse().map((r) => r.targetId), ['ok1', 'ok2'], 'the calls around it committed with their audit rows');

    const ok1 = users.getUserByLogin(db, 'ok1');
    tx(db, () => {
      try { users.setPassword(db, undefined, ok1.id, { algo: 'scrypt', hash: 'bmV3' }); } catch (e) { errors.push(e.message); }
      users.bumpSessionEpoch(db, 'system', users.getUserByLogin(db, 'ok2').id);
    });
    assert.match(errors[1], /needs an actor/);
    const after = users.getUserByLogin(db, 'ok1');
    assert.deepEqual(after.password, pw, 'the refused password change was undone');
    assert.equal(after.sessionEpoch, 1, 'and so was its epoch bump');
    assert.equal(auditActions(db, { action: 'user.password' }).length, 0);
    assert.equal(users.getUserByLogin(db, 'ok2').sessionEpoch, 2, 'the call after it in the same tx() committed');
    assert.deepEqual(auditActions(db), ['user.create', 'user.create', 'user.signout']);
    assert.equal(db.isTransaction, false);
  } finally {
    close();
  }
});

test('orgs: the root is "." only when asked for, else orgs/<id>; soft removal; a slug is never reused', async () => {
  const { db, close } = await freshStore('orgs');
  try {
    assert.equal(orgs.createOrg(db, 'system', { id: 'default', name: 'Default', root: '.' }).root, '.');
    assert.equal(orgs.createOrg(db, 'system', { id: 'acme', name: 'Acme' }).root, 'orgs/acme');
    assert.throws(() => orgs.createOrg(db, 'system', { id: 'bravo', name: 'Bravo', root: 'elsewhere' }), /'\.' .* or 'orgs\/bravo'/);
    assert.throws(() => orgs.createOrg(db, 'system', { id: 'Bad Slug', name: 'x' }), /invalid org id/);
    assert.throws(() => orgs.createOrg(db, 'system', { id: 'second', name: 'Second default', root: '.' }), /UNIQUE/, 'one org at "."');
    assert.equal(orgs.renameOrg(db, 'alice', 'acme', 'Acme Corp').name, 'Acme Corp');
    assert.ok(orgs.removeOrg(db, 'system', 'acme').removedAt);
    assert.deepEqual(orgs.listOrgs(db).map((o) => o.id), ['default']);
    assert.deepEqual(orgs.listOrgs(db, { includeRemoved: true }).map((o) => o.id), ['default', 'acme']);
    assert.throws(() => orgs.createOrg(db, 'system', { id: 'acme', name: 'Acme again' }), /never reused/);
    assert.throws(() => orgs.renameOrg(db, 'system', 'acme', 'x'), /no org/);
    const rows = auditRepo.listAudit(db).reverse();
    assert.deepEqual(rows.map((r) => [r.action, r.orgId]), [
      ['org.create', null], ['org.create', null], ['org.rename', 'acme'], ['org.remove', null],
    ]);
  } finally {
    close();
  }
});

test('memberships: viewer/operator/admin only, first membership first, removed orgs skipped; audit rows carry the org', async () => {
  const { db, close } = await freshStore('members');
  try {
    const alice = users.createUser(db, 'system', { login: 'alice' });
    const bob = users.createUser(db, 'system', { login: 'bob' });
    orgs.createOrg(db, 'system', { id: 'default', name: 'Default', root: '.' });
    orgs.createOrg(db, 'system', { id: 'acme', name: 'Acme' });
    orgs.createOrg(db, 'system', { id: 'gone', name: 'Gone' });
    for (const bad of ['member', 'owner', 'Admin', ' viewer ', null]) {
      assert.throws(() => memberships.addMembership(db, 'system', { orgId: 'acme', userId: alice.id, role: bad }), /role is one of/, String(bad));
    }
    memberships.addMembership(db, 'system', { orgId: 'gone', userId: alice.id, role: 'admin' });
    memberships.addMembership(db, 'system', { orgId: 'acme', userId: alice.id, role: 'operator' });
    memberships.addMembership(db, 'system', { orgId: 'default', userId: alice.id, role: 'viewer' });
    memberships.addMembership(db, 'system', { orgId: 'acme', userId: bob.id, role: 'viewer' });
    assert.throws(() => memberships.addMembership(db, 'system', { orgId: 'acme', userId: bob.id, role: 'admin' }), /UNIQUE|PRIMARY/);
    assert.throws(() => memberships.addMembership(db, 'system', { orgId: 'nope', userId: bob.id, role: 'admin' }), /no org/);
    orgs.removeOrg(db, 'system', 'gone');
    assert.throws(() => memberships.addMembership(db, 'system', { orgId: 'gone', userId: bob.id, role: 'admin' }), /no org/);
    assert.deepEqual(memberships.listMembershipsForUser(db, alice.id).map((m) => m.orgId), ['acme', 'default'], 'created order, removed org skipped');
    assert.equal(memberships.setRole(db, 'alice', 'acme', bob.id, 'admin').role, 'admin');
    memberships.removeMembership(db, 'alice', 'acme', bob.id);
    assert.equal(memberships.getMembership(db, 'acme', bob.id), null);
    assert.deepEqual(memberships.listMembers(db, 'acme').map((m) => m.userId), [alice.id]);
    const acmeRows = auditRepo.listAudit(db, { orgId: 'acme' }).reverse();
    assert.deepEqual(acmeRows.map((r) => [r.action, r.targetId]), [
      ['membership.add', 'alice'], ['membership.add', 'bob'], ['membership.role', 'bob'], ['membership.remove', 'bob'],
    ]);
  } finally {
    close();
  }
});

test('audit: appendAudit and listAudit filters (deployment rows, one org, actor, action, paging)', async () => {
  const { db, close } = await freshStore('auditlist');
  try {
    auditRepo.appendAudit(db, 'alice', { action: 'x.one' });
    auditRepo.appendAudit(db, 'bob', { orgId: 'acme', action: 'x.two', targetKind: 'pack', targetId: 7, detail: { n: 1 } });
    auditRepo.appendAudit(db, 'alice', { orgId: 'acme', action: 'x.three' });
    assert.equal(auditRepo.listAudit(db).length, 3);
    assert.deepEqual(auditRepo.listAudit(db, { orgId: null }).map((r) => r.action), ['x.one']);
    assert.deepEqual(auditRepo.listAudit(db, { orgId: 'acme' }).map((r) => r.action), ['x.three', 'x.two']);
    assert.deepEqual(auditRepo.listAudit(db, { actor: 'alice' }).map((r) => r.action), ['x.three', 'x.one']);
    const [two] = auditRepo.listAudit(db, { action: 'x.two' });
    assert.deepEqual([two.targetKind, two.targetId, two.detail], ['pack', '7', { n: 1 }]);
    const [newest] = auditRepo.listAudit(db, { limit: 1 });
    assert.deepEqual(auditRepo.listAudit(db, { beforeSeq: newest.seq }).map((r) => r.action), ['x.two', 'x.one']);
    assert.throws(() => auditRepo.appendAudit(db, ' ', { action: 'x' }), /needs an actor/);
  } finally {
    close();
  }
});

test('meta: get and set with an audit row; store_id is fixed', async () => {
  const { db, close } = await freshStore('meta');
  try {
    assert.match(meta.storeId(db), /^[0-9a-f-]{36}$/);
    assert.equal(meta.getMeta(db, 'default_org'), null);
    meta.setMeta(db, 'system', 'default_org', 'default');
    meta.setMeta(db, 'system', 'default_org', 'acme');
    assert.equal(meta.getMeta(db, 'default_org'), 'acme');
    assert.throws(() => meta.setMeta(db, 'system', 'store_id', 'forged'), /fixed at creation/);
    assert.throws(() => meta.setMeta(db, 'system', 'identity_armed', true), /string or null/);
    assert.deepEqual(auditActions(db), ['meta.set', 'meta.set']);
  } finally {
    close();
  }
});

test('context-scoped repositories throw outside runWithOrg()', async () => {
  const { db, close } = await freshStore('noctx');
  try {
    const calls = {
      'services.list': () => services.listServices(db),
      'services.create': () => services.createService(db, 'a', { slug: 's', name: 'S' }),
      'environments.list': () => environments.listEnvironments(db, 1),
      'environments.create': () => environments.createEnvironment(db, 'a', { serviceId: 1, name: 'prod' }),
      'mcp_endpoints.list': () => mcpEndpoints.listMcpEndpoints(db),
      'mcp_endpoints.create': () => mcpEndpoints.createMcpEndpoint(db, 'a', { name: 'm', url: 'https://mcp.example' }),
      'packs.list': () => packs.listPacks(db),
      'packs.add': () => packs.addPack(db, 'a', { id: 'p' }),
      'packs.touch': () => packs.touch(db, 'p'),
      'pack_services.list': () => packServices.listServicesForPack(db, 'p'),
      'pack_services.link': () => packServices.linkPackService(db, 'a', { packId: 'p', serviceId: 1 }),
    };
    for (const [name, call] of Object.entries(calls)) assert.throws(call, /org-scoped — call it inside runWithOrg\(\)/, name);
    assert.deepEqual(auditActions(db), []);
  } finally {
    close();
  }
});

test('Tenancy isolation: org B reads and writes nothing of org A through any context-scoped repository', async () => {
  const { db, close } = await freshStore('iso');
  try {
    orgs.createOrg(db, 'system', { id: 'acme', name: 'Acme' });
    orgs.createOrg(db, 'system', { id: 'bravo', name: 'Bravo' });
    const a = runWithOrg('acme', () => {
      const ep = mcpEndpoints.createMcpEndpoint(db, 'alice', { name: 'prod-mcp', url: 'https://mcp.acme.example/mcp', readTokenEnv: 'ACME_MCP_TOKEN' });
      const svc = services.createService(db, 'alice', { slug: 'checkout', name: 'Checkout', owners: ['alice'], tier: 'critical' });
      const env = environments.createEnvironment(db, 'alice', { serviceId: svc.id, name: 'prod', tier: 'high', bindings: { region: 'eu' }, mcpEndpointId: ep.id });
      const pack = packs.addPack(db, 'alice', { id: 'uploaded-checkout-0123abcd', label: 'Checkout', source: 'upload' });
      const link = packServices.linkPackService(db, 'alice', { packId: pack.id, serviceId: svc.id, role: 'primary' });
      return { ep, svc, env, pack, link };
    });
    assert.deepEqual(a.env.bindings, { region: 'eu' });
    assert.deepEqual(a.svc.owners, ['alice']);
    runWithOrg('bravo', () => {
      assert.deepEqual(services.listServices(db), []);
      assert.equal(services.getService(db, a.svc.id), null);
      assert.equal(services.getServiceBySlug(db, 'checkout'), null);
      assert.throws(() => services.updateService(db, 'bob', a.svc.id, { name: 'Pwned' }), /no service/);
      assert.throws(() => services.deleteService(db, 'bob', a.svc.id), /no service/);
      assert.deepEqual(environments.listEnvironments(db, a.svc.id), []);
      assert.equal(environments.getEnvironment(db, a.env.id), null);
      assert.throws(() => environments.createEnvironment(db, 'bob', { serviceId: a.svc.id, name: 'staging' }), /no service/);
      assert.throws(() => environments.updateEnvironment(db, 'bob', a.env.id, { tier: 'low' }), /no environment/);
      assert.throws(() => environments.deleteEnvironment(db, 'bob', a.env.id), /no environment/);
      assert.deepEqual(mcpEndpoints.listMcpEndpoints(db), []);
      assert.equal(mcpEndpoints.getMcpEndpoint(db, a.ep.id), null);
      assert.throws(() => mcpEndpoints.updateMcpEndpoint(db, 'bob', a.ep.id, { url: 'https://evil.example' }), /no MCP endpoint/);
      assert.throws(() => mcpEndpoints.deleteMcpEndpoint(db, 'bob', a.ep.id), /no MCP endpoint/);
      assert.deepEqual(packs.listPacks(db), []);
      assert.equal(packs.getPack(db, a.pack.id), null);
      assert.equal(packs.touch(db, a.pack.id), false);
      assert.throws(() => packs.removePack(db, 'bob', a.pack.id), /no pack/);
      assert.deepEqual(packServices.listServicesForPack(db, a.pack.id), []);
      assert.deepEqual(packServices.listPacksForService(db, a.svc.id), []);
      assert.throws(() => packServices.unlinkPackService(db, 'bob', a.pack.id, a.svc.id), /no pack link/);
      // B's own rows, reaching for A's: A's service and A's endpoint are not found.
      const bSvc = services.createService(db, 'bob', { slug: 'checkout', name: 'Bravo checkout' });
      assert.throws(() => environments.createEnvironment(db, 'bob', { serviceId: bSvc.id, name: 'prod', mcpEndpointId: a.ep.id }), /no MCP endpoint/);
      const bEnv = environments.createEnvironment(db, 'bob', { serviceId: bSvc.id, name: 'prod' });
      assert.throws(() => environments.updateEnvironment(db, 'bob', bEnv.id, { mcpEndpointId: a.ep.id }), /no MCP endpoint/);
      packs.addPack(db, 'bob', { id: 'uploaded-checkout-0123abcd' });
      assert.throws(() => packServices.linkPackService(db, 'bob', { packId: 'uploaded-checkout-0123abcd', serviceId: a.svc.id }), /no service/);
    });
    // A is untouched.
    runWithOrg('acme', () => {
      assert.equal(services.getService(db, a.svc.id).name, 'Checkout');
      assert.equal(environments.getEnvironment(db, a.env.id).mcpEndpointId, a.ep.id);
      assert.equal(mcpEndpoints.getMcpEndpoint(db, a.ep.id).url, 'https://mcp.acme.example/mcp');
      assert.equal(packs.listPacks(db).length, 1);
      assert.deepEqual(packServices.listServicesForPack(db, a.pack.id).map((l) => l.role), ['primary']);
      assert.equal(packs.touch(db, a.pack.id, '2030-01-01T00:00:00.000Z'), true);
      assert.throws(() => packs.touch(db, a.pack.id, new Date()), /cannot bind Date/, 'not a silent false from ? values shifted one slot');
      assert.equal(packs.getPack(db, a.pack.id).lastUsedAt, '2030-01-01T00:00:00.000Z');
    });
    assert.deepEqual(auditActions(db, { orgId: 'acme' }), ['mcp_endpoint.create', 'service.create', 'environment.create', 'pack.register', 'pack.link'],
      'every write audited in its org, touch() not at all');
    assert.deepEqual(auditActions(db, { orgId: 'bravo' }), ['service.create', 'environment.create', 'pack.register']);
    // The schema holds the same line: a link across orgs is a foreign-key failure.
    assert.throws(() => prepare(db, "INSERT INTO pack_services (org_id, pack_id, service_id, role) VALUES ('bravo', 'uploaded-checkout-0123abcd', ?, 'member')").run(a.svc.id), /FOREIGN KEY/);
  } finally {
    close();
  }
});

test('context-scoped updates, deletes and cascades within one org', async () => {
  const { db, close } = await freshStore('crud');
  try {
    orgs.createOrg(db, 'system', { id: 'acme', name: 'Acme' });
    runWithOrg('acme', () => {
      const ep = mcpEndpoints.createMcpEndpoint(db, 'alice', { name: 'mcp', url: 'http://mcp.internal:3001' });
      assert.throws(() => mcpEndpoints.createMcpEndpoint(db, 'alice', { name: 'leaky', url: 'https://user:secret@mcp.example' }), /may not carry credentials/);
      assert.throws(() => mcpEndpoints.createMcpEndpoint(db, 'alice', { name: 'tok', url: 'https://mcp.example', readTokenEnv: 'sk-live-123' }), /env var name/);
      assert.throws(() => mcpEndpoints.createMcpEndpoint(db, 'alice', { name: 'ftp', url: 'ftp://mcp.example' }), /http\(s\)/);
      const svc = services.createService(db, 'alice', { slug: 'pay', name: 'Payments' });
      assert.throws(() => services.createService(db, 'alice', { slug: 'pay', name: 'Again' }), /UNIQUE/);
      assert.equal(services.updateService(db, 'alice', svc.id, { tier: 'critical', owners: ['team-pay'] }).tier, 'critical');
      const env = environments.createEnvironment(db, 'alice', { serviceId: svc.id, name: 'prod', mcpEndpointId: ep.id });
      assert.equal(environments.updateEnvironment(db, 'alice', env.id, { tier: 'high' }).tier, 'high');
      mcpEndpoints.deleteMcpEndpoint(db, 'alice', ep.id);
      assert.equal(environments.getEnvironment(db, env.id).mcpEndpointId, null, 'the environment is unbound, not deleted');
      packs.addPack(db, 'alice', { id: 'p1' });
      packServices.linkPackService(db, 'alice', { packId: 'p1', serviceId: svc.id, role: 'primary' });
      const other = services.createService(db, 'alice', { slug: 'ledger', name: 'Ledger' });
      assert.throws(() => packServices.linkPackService(db, 'alice', { packId: 'p1', serviceId: other.id, role: 'primary' }), /UNIQUE/, 'one primary per pack');
      packServices.linkPackService(db, 'alice', { packId: 'p1', serviceId: other.id });
      packServices.unlinkPackService(db, 'alice', 'p1', other.id);
      services.deleteService(db, 'alice', svc.id);
      assert.equal(environments.getEnvironment(db, env.id), null, 'environments go with their service');
      assert.deepEqual(packServices.listServicesForPack(db, 'p1'), [], 'so do pack links');
      packs.removePack(db, 'alice', 'p1');
      assert.deepEqual(packs.listPacks(db), []);
    });
    assert.deepEqual(auditActions(db, { orgId: 'acme' }), [
      'mcp_endpoint.create', 'service.create', 'service.update', 'environment.create', 'environment.update', 'mcp_endpoint.delete',
      'pack.register', 'pack.link', 'service.create', 'pack.link', 'pack.unlink', 'service.delete', 'pack.remove',
    ]);
  } finally {
    close();
  }
});

test('an MCP endpoint URL carrying a secret is refused, on create and update, without echoing it', async () => {
  const { db, close } = await freshStore('mcp-url-secrets');
  try {
    orgs.createOrg(db, 'system', { id: 'acme', name: 'Acme' });
    runWithOrg('acme', () => {
      const ep = mcpEndpoints.createMcpEndpoint(db, 'alice', { name: 'ok', url: 'https://mcp.example/sse?transport=sse' });
      assert.equal(ep.url, 'https://mcp.example/sse?transport=sse', 'a harmless query is kept');
      assert.equal(mcpEndpoints.updateMcpEndpoint(db, 'alice', ep.id, { url: 'https://mcp.example/mcp?transport=sse' }).url, 'https://mcp.example/mcp?transport=sse');
      const refused = [
        ['https://mcp.example/sse?access_token=s3cr3t', /may not carry credentials in its query/],
        ['https://mcp.example/sse?transport=sse&api_key=s3cr3t', /may not carry credentials in its query/],
        ['https://mcp.example/sse?X-Api-Key=s3cr3t', /may not carry credentials in its query/],
        ['https://mcp.example/sse#token=s3cr3t', /has no fragment/],
        ['https://alice:s3cr3t@mcp.example/', /may not carry credentials/],
        ['https://alice:s3cr3t@', /is not a URL/],
        ['https://exa mple/?token=s3cr3t', /is not a URL/],
      ];
      for (const [url, why] of refused) {
        for (const [op, write] of [
          ['create', () => mcpEndpoints.createMcpEndpoint(db, 'alice', { name: 'leaky', url })],
          ['update', () => mcpEndpoints.updateMcpEndpoint(db, 'alice', ep.id, { url })],
        ]) {
          assert.throws(write, (e) => {
            assert.match(e.message, why, `${op} ${url}`);
            assert.ok(!e.message.includes('s3cr3t'), `${op} ${url}: the error echoes the secret: ${e.message}`);
            return true;
          });
        }
      }
      assert.deepEqual(mcpEndpoints.listMcpEndpoints(db).map((e) => e.url), ['https://mcp.example/mcp?transport=sse'], 'nothing leaky was stored');
    });
  } finally {
    close();
  }
});

test('Concurrency: a repository write waits out a child holding BEGIN IMMEDIATE, then succeeds with its audit row', async () => {
  const { path, db, close } = await freshStore('conc-repo');
  try {
    const holder = lockHolder(path, 700);
    await holder.until(/locked/);
    const t0 = Date.now();
    users.createUser(db, 'system', { login: 'patient' });
    const waited = Date.now() - t0;
    assert.equal((await holder.exited(10_000, 'the repository write')).code, 0);
    assert.ok(waited >= 300, `waited ${waited} ms`);
    assert.ok(users.getUserByLogin(db, 'patient'));
    assert.deepEqual(auditActions(db), ['user.create']);
  } finally {
    close();
  }
});

// ---------- packc store backup / restore (end to end, through tools/cli.mjs) ----------

const CLI = join(HERE, '..', 'tools', 'cli.mjs');

function packc(args, env) {
  return new Promise((res) => {
    const proc = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, OBSERVOGRAM_WORKSPACE: '', TOMOGRAPH_DB: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => { stdout += b; });
    proc.stderr.on('data', (b) => { stderr += b; });
    proc.on('exit', (code, signal) => res({ code, signal, stdout, stderr }));
  });
}

// A child that opens the store the way the server will, optionally writes,
// says "ready" and stays up (idle) until killed.
function storeHolder(path, { login = null } = {}) {
  return child(`
    const { openStore } = await import(${JSON.stringify(DB_URL)});
    const users = await import(${JSON.stringify(pathToFileURL(join(HERE, 'store', 'users.mjs')).href)});
    const db = await openStore({ path: ${JSON.stringify(path)} });
    if (${JSON.stringify(login)}) users.createUser(db, 'system', { login: ${JSON.stringify(login)} });
    console.log('ready');
    setInterval(() => {}, 1000);
  `);
}

async function readStore(path) {
  const db = await openRaw(path);
  try {
    return {
      storeId: prepare(db, "SELECT value FROM schema_meta WHERE key = 'store_id'").get().value,
      logins: prepare(db, 'SELECT login FROM users ORDER BY id').all().map((r) => r.login),
      journal: pragma(db, 'journal_mode')[0].journal_mode,
    };
  } finally {
    db.close();
  }
}

test('packc store backup: refuses :memory:, a missing database (creating none) and an existing target; usage is exit 2', async () => {
  const dir = tempDir('bk-refuse');
  const dbPath = join(dir, 'observogram.db');
  let r = await packc(['store', 'backup', join(dir, 'a.db')], { OBSERVOGRAM_DB: ':memory:' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /packc store backup: OBSERVOGRAM_DB is :memory:/);
  r = await packc(['store', 'backup', join(dir, 'a.db')], { OBSERVOGRAM_DB: dbPath });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no database at .*observogram\.db — nothing to back up/);
  assert.equal(existsSync(dbPath), false, 'no database was created');
  assert.equal(existsSync(join(dir, 'a.db')), false);
  const db = await openStore({ path: dbPath });
  closeStore(dbPath);
  assert.ok(db);
  r = await packc(['store', 'backup', dbPath], { OBSERVOGRAM_DB: dbPath });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is the database itself/);
  // The database's own -wal/-shm/-journal, also named through a symlinked
  // directory: a backup there reads "written" and the next open deletes it.
  const via = join(dir, 'via');
  symlinkSync(dir, via);
  r = await packc(['store', 'backup', join(via, 'observogram.db')], { OBSERVOGRAM_DB: dbPath });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is the database itself/);
  for (const sfx of ['-wal', '-shm', '-journal']) {
    for (const dest of [`${dbPath}${sfx}`, join(via, `observogram.db${sfx}`)]) {
      r = await packc(['store', 'backup', dest], { OBSERVOGRAM_DB: dbPath });
      assert.equal(r.code, 1, dest);
      assert.match(r.stderr, new RegExp(`is the database's own ${sfx} file`));
      assert.equal(existsSync(`${dbPath}${sfx}`), false, dest);
      assert.equal(existsSync(`${dbPath}${sfx}.tmp`), false, dest);
    }
  }
  // A database named *.tmp is the backup's temporary file for the name
  // without it: refused as that, not as an interrupted backup to remove.
  const tmpNamed = join(dir, 'live.tmp');
  await openStore({ path: tmpNamed });
  closeStore(tmpNamed);
  r = await packc(['store', 'backup', join(dir, 'live')], { OBSERVOGRAM_DB: tmpNamed });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /live\.tmp, the backup's temporary file, would be the database's own file/);
  assert.doesNotMatch(r.stderr, /remove it/);
  assert.equal(existsSync(join(dir, 'live')), false);
  const taken = join(dir, 'taken.db');
  writeFileSync(taken, 'precious');
  r = await packc(['store', 'backup', taken], { OBSERVOGRAM_DB: dbPath });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /exists — a backup never overwrites/);
  assert.equal(readFileSync(taken, 'utf8'), 'precious');
  const notOurs = join(dir, 'other.db');
  const other = await openRaw(notOurs);
  execScript(other, 'CREATE TABLE t (a)');
  other.close();
  r = await packc(['store', 'backup', join(dir, 'b.db')], { OBSERVOGRAM_DB: notOurs });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is not an Observogram store/);
  r = await packc(['store'], {});
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: packc store backup <path>/);
  r = await packc(['store', 'backup'], {});
  assert.equal(r.code, 2);
});

test('packc store backup while a server holds the store: every committed row, not an open transaction, one rollback-journal file', async () => {
  const dir = tempDir('bk-live');
  const dbPath = join(dir, 'observogram.db');
  const server = storeHolder(dbPath, { login: 'committed-before' });
  try {
    await server.until(/ready/);
    const writer = lockHolder(dbPath, 2500);   // an uncommitted row, held open
    await writer.until(/locked/);
    const dest = join(dir, 'backups', 'nightly.db');
    const r = await packc(['store', 'backup', dest], { OBSERVOGRAM_DB: dbPath });
    assert.equal(r.code, 0, r.stderr);
    assert.equal((await writer.exited(10_000, 'the backup')).code, 0);
    const got = await readStore(dest);
    assert.match(r.stdout, new RegExp(`backup written: ${dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(r.stdout, new RegExp(`store_id: ${got.storeId} \\(schema v1`));
    assert.deepEqual(got.logins, ['committed-before']);
    assert.equal(got.journal, 'delete', 'a VACUUM INTO file is rollback-journal');
    const raw = await openRaw(dest);
    assert.equal(prepare(raw, "SELECT count(*) AS n FROM schema_meta WHERE key = 'held_by_child'").get().n, 0, 'the uncommitted row is not in it');
    raw.close();
    assert.equal(existsSync(`${dest}.tmp`), false, 'the .tmp was renamed into place');
  } finally {
    server.proc.kill('SIGTERM');
    await server.exited(10_000, 'SIGTERM');
  }
});

test('packc store restore: refuses while the server holds the store (even idle), a foreign file, a missing one and :memory:', async () => {
  const dir = tempDir('rs-refuse');
  const dbPath = join(dir, 'observogram.db');
  const backup = join(dir, 'b.db');
  await openStore({ path: dbPath });
  closeStore(dbPath);
  assert.equal((await packc(['store', 'backup', backup], { OBSERVOGRAM_DB: dbPath })).code, 0);
  const server = storeHolder(dbPath);
  try {
    await server.until(/ready/);
    const r = await packc(['store', 'restore', backup], { OBSERVOGRAM_DB: dbPath });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is in use — stop the server/);
    assert.deepEqual(readdirSync(dir).sort(), ['b.db', 'observogram.db', 'observogram.db-shm', 'observogram.db-wal'], 'nothing moved, no temp file left');
  } finally {
    server.proc.kill('SIGTERM');
    await server.exited(10_000, 'SIGTERM');
  }
  const junk = join(dir, 'junk.db');
  writeFileSync(junk, 'not a database at all, just some bytes '.repeat(200));
  let r = await packc(['store', 'restore', junk], { OBSERVOGRAM_DB: dbPath });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /junk\.db is not a readable SQLite database/);
  const foreign = join(dir, 'foreign.db');
  const f = await openRaw(foreign);
  execScript(f, 'CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT)');
  f.close();
  r = await packc(['store', 'restore', foreign], { OBSERVOGRAM_DB: dbPath });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is not an Observogram store backup \(user_version 0, no store_id\)/);
  r = await packc(['store', 'restore', join(dir, 'missing.db')], { OBSERVOGRAM_DB: dbPath });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no backup at/);
  r = await packc(['store', 'restore', backup], { OBSERVOGRAM_DB: ':memory:' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /:memory:/);
  // A backup lying on the database's own -wal: the in-use probe would
  // delete it as a stale sidecar.
  const onWal = `${dbPath}-wal`;
  copyFileSync(backup, onWal);
  r = await packc(['store', 'restore', onWal], { OBSERVOGRAM_DB: dbPath });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is the database's own -wal file/);
  assert.deepEqual(readFileSync(onWal), readFileSync(backup), 'the backup on the -wal path is untouched');
  rmSync(onWal);
  assert.deepEqual(readdirSync(dir).sort(), ['b.db', 'foreign.db', 'junk.db', 'observogram.db'], 'no refusal moved or left anything');
});

test('packc store restore end to end: the in-use probe checkpoints an unclean stop\'s -wal into the old db, so the aside copy keeps the crashed writer\'s rows and no -wal is left to replay; both store_ids print, the next open is WAL', async () => {
  const dir = tempDir('rs-e2e');
  const dbPath = join(dir, 'observogram.db');
  const db = await openStore({ path: dbPath });
  users.createUser(db, 'system', { login: 'in-backup' });
  closeStore(dbPath);
  const backup = join(dir, 'b.db');
  const bk = await packc(['store', 'backup', backup], { OBSERVOGRAM_DB: dbPath });
  assert.equal(bk.code, 0, bk.stderr);
  const backupId = (await readStore(backup)).storeId;

  // A server that wrote after the backup and then died uncleanly (SIGKILL: no close, the -wal stays).
  const crashed = storeHolder(dbPath, { login: 'after-backup' });
  await crashed.until(/ready/);
  crashed.proc.kill('SIGKILL');
  assert.equal((await crashed.done).signal, 'SIGKILL');
  assert.ok(existsSync(`${dbPath}-wal`), 'an unclean stop left a -wal behind');

  const r = await packc(['store', 'restore', backup], { OBSERVOGRAM_DB: dbPath });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`store_id: ${backupId} \\(schema v1\\); previous store_id: ${backupId}`));
  assert.match(r.stdout, /moved aside: .*observogram\.db\.pre-restore-\d{8}T\d{9}Z/);
  assert.match(r.stdout, /switches it back to WAL/);
  const aside = readdirSync(dir).filter((n) => n.startsWith('observogram.db.pre-restore-') && !/-(wal|shm)$/.test(n));
  assert.equal(aside.length, 1, `the old set moved aside under one name (${aside})`);
  assert.deepEqual((await readStore(join(dir, aside[0]))).logins, ['in-backup', 'after-backup'], 'the aside copy kept the crashed writer\'s rows');
  assert.equal(readdirSync(dir).some((n) => /-(wal|shm)$/.test(n)), false, 'the probe checkpointed the -wal and removed the -wal and -shm; nothing was left to move');
  assert.equal(readdirSync(dir).some((n) => n.includes('.restore-')), false, 'no temp copy left');

  const restored = await openStore({ path: dbPath });
  try {
    assert.equal(pragma(restored, 'journal_mode')[0].journal_mode, 'wal', 'the next open switches it to WAL');
    assert.deepEqual(users.listUsers(restored).map((u) => u.login), ['in-backup'], 'the stale -wal was not replayed onto it');
    assert.equal(meta.storeId(restored), backupId);
  } finally {
    closeStore(dbPath);
  }
  assert.equal((await readStore(backup)).journal, 'delete', 'the backup file itself was not touched');

  // Restoring another store's backup names both ids.
  const otherPath = join(tempDir('rs-other'), 'observogram.db');
  await openStore({ path: otherPath });
  closeStore(otherPath);
  const otherBackup = join(dir, 'other-backup.db');
  assert.equal((await packc(['store', 'backup', otherBackup], { OBSERVOGRAM_DB: otherPath })).code, 0);
  const otherId = (await readStore(otherBackup)).storeId;
  assert.notEqual(otherId, backupId);
  const r2 = await packc(['store', 'restore', otherBackup], { OBSERVOGRAM_DB: dbPath });
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, new RegExp(`store_id: ${otherId} \\(schema v1\\); previous store_id: ${backupId}`));

  // A fresh deployment with no database yet: restore just puts it in place.
  const freshPath = join(tempDir('rs-fresh'), 'db', 'observogram.db');
  const r3 = await packc(['store', 'restore', backup], { OBSERVOGRAM_DB: freshPath });
  assert.equal(r3.code, 0, r3.stderr);
  assert.match(r3.stdout, /previous store_id: none/);
  assert.equal((await readStore(freshPath)).storeId, backupId);
});

test('packc store restore with a -wal and -shm but no database to probe: they move aside under one timestamp and the stale -wal is not replayed onto the restored file', async () => {
  const dir = tempDir('rs-sidecars');
  const dbPath = join(dir, 'observogram.db');
  const db = await openStore({ path: dbPath });
  users.createUser(db, 'system', { login: 'in-backup' });
  closeStore(dbPath);
  const backup = join(dir, 'b.db');
  const bk = await packc(['store', 'backup', backup], { OBSERVOGRAM_DB: dbPath });
  assert.equal(bk.code, 0, bk.stderr);

  const crashed = storeHolder(dbPath, { login: 'after-backup' });
  await crashed.until(/ready/);
  crashed.proc.kill('SIGKILL');
  assert.equal((await crashed.done).signal, 'SIGKILL');
  assert.ok(existsSync(`${dbPath}-wal`), 'an unclean stop left a -wal behind');
  assert.ok(existsSync(`${dbPath}-shm`), 'an unclean stop left a -shm behind');
  // With a database file present the in-use probe would checkpoint and
  // delete the -wal and -shm itself (even on a corrupt header, when its
  // connection closes), so only a missing database reaches the move.
  rmSync(dbPath);

  const r = await packc(['store', 'restore', backup], { OBSERVOGRAM_DB: dbPath });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /previous store_id: none/);
  const moved = r.stdout.match(/^moved aside: (.*)$/m)?.[1].split(', ');
  assert.ok(moved, r.stdout);
  assert.equal(moved.length, 2, moved.join(', '));
  const [wal, shm] = moved.map((p) => p.match(/observogram\.db\.pre-restore-(\d{8}T\d{9}Z)-(wal|shm)$/));
  assert.ok(wal && shm, moved.join(', '));
  assert.equal(wal[2], 'wal');
  assert.equal(shm[2], 'shm');
  assert.equal(wal[1], shm[1], 'one timestamp for the set');
  assert.ok(existsSync(moved[0]) && existsSync(moved[1]));
  assert.equal(existsSync(`${dbPath}-wal`), false, 'no -wal beside the restored file');
  assert.equal(existsSync(`${dbPath}-shm`), false, 'no -shm beside the restored file');

  const restored = await openStore({ path: dbPath });
  try {
    assert.deepEqual(users.listUsers(restored).map((u) => u.login), ['in-backup'], 'the stale -wal was not replayed onto it');
  } finally {
    closeStore(dbPath);
  }
});

test('packc store restore gives the restored file the replaced store\'s mode (owner read-write, 0600 when there was none), not the backup\'s, and it opens in WAL', async () => {
  const dir = tempDir('rs-mode');
  const dbPath = join(dir, 'observogram.db');
  await openStore({ path: dbPath });
  closeStore(dbPath);
  const backup = join(dir, 'b.db');
  assert.equal((await packc(['store', 'backup', backup], { OBSERVOGRAM_DB: dbPath })).code, 0);
  const modeOf = (p) => statSync(p).mode & 0o777;
  const opensWal = async (p) => {
    // Root bypasses the mode bits, so only a non-root run can prove the open;
    // the mode assertions carry the check under root.
    if (process.getuid?.() === 0) return;
    const db = await openStore({ path: p });
    try { assert.equal(pragma(db, 'journal_mode')[0].journal_mode, 'wal'); } finally { closeStore(p); }
  };

  // Operators make backups read-only; the live store must not inherit that.
  for (const ro of [0o400, 0o444]) {
    chmodSync(backup, ro);
    const r = await packc(['store', 'restore', backup], { OBSERVOGRAM_DB: dbPath });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(modeOf(dbPath), 0o600, `a 0${ro.toString(8)} backup restores as the replaced store's 0600`);
    assert.equal(modeOf(backup), ro, 'the backup keeps its own mode');
    await opensWal(dbPath);
  }

  // A mode the operator chose (0640, a backup agent's group) is kept, and a
  // 0644 backup does not leak its mode in.
  chmodSync(backup, 0o644);
  chmodSync(dbPath, 0o640);
  let r = await packc(['store', 'restore', backup], { OBSERVOGRAM_DB: dbPath });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(modeOf(dbPath), 0o640);
  await opensWal(dbPath);

  // A store the owner cannot write gets owner read-write added.
  chmodSync(dbPath, 0o440);
  r = await packc(['store', 'restore', backup], { OBSERVOGRAM_DB: dbPath });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(modeOf(dbPath), 0o640);

  // No previous store: 0600, what openStore creates, whatever the backup's mode.
  chmodSync(backup, 0o400);
  const freshPath = join(tempDir('rs-mode-fresh'), 'observogram.db');
  r = await packc(['store', 'restore', backup], { OBSERVOGRAM_DB: freshPath });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(modeOf(freshPath), 0o600);
  await opensWal(freshPath);

  // A root shell restoring for a non-root server keeps the replaced file's owner.
  if (process.getuid?.() === 0) {
    chownSync(dbPath, 1000, 1000);
    r = await packc(['store', 'restore', backup], { OBSERVOGRAM_DB: dbPath });
    assert.equal(r.code, 0, r.stderr);
    const st = statSync(dbPath);
    assert.deepEqual([st.uid, st.gid], [1000, 1000], 'owned by the server\'s user, not root');
  }
});

test('the store holds password records, so no file it creates is group or world readable: the database and its -wal/-shm, a backup, a restored database and the moved-aside files are 0600', async () => {
  const dir = tempDir('modes');
  const dbPath = join(dir, 'db', 'observogram.db');
  const modeOf = (p) => statSync(p).mode & 0o777;
  const backup = join(dir, 'bk dir', 'one.db');
  const db = await openStore({ path: dbPath });
  try {
    users.createUser(db, 'system', { login: 'alice', password: { algo: 'scrypt', N: 16384, r: 8, p: 1, salt: 'aa', hash: 'SECRETHASH' } });
    for (const s of ['', '-wal', '-shm']) assert.equal(modeOf(`${dbPath}${s}`), 0o600, `observogram.db${s} is created 0600`);

    // VACUUM INTO writes a new file: the backup is 0600 whatever the store's mode.
    chmodSync(dbPath, 0o644);
    const b = await packc(['store', 'backup', backup], { OBSERVOGRAM_DB: dbPath });
    assert.equal(b.code, 0, b.stderr);
    assert.equal(modeOf(backup), 0o600, 'the backup is 0600');
    assert.ok(!existsSync(`${backup}.tmp`));
  } finally {
    closeStore(dbPath);
  }
  chmodSync(dbPath, 0o600);

  // A 0644 backup (made by an older build, or chmodded) restores 0600 over a 0600 store.
  chmodSync(backup, 0o644);
  const r = await packc(['store', 'restore', backup], { OBSERVOGRAM_DB: dbPath });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(modeOf(dbPath), 0o600, 'the restored database is 0600');
  const aside = readdirSync(dirname(dbPath)).filter((f) => f.includes('.pre-restore-'));
  assert.ok(aside.length >= 1);
  for (const f of aside) assert.equal(modeOf(join(dirname(dbPath), f)), 0o600, `${f} is 0600`);

  // No previous store: 0600.
  const freshPath = join(tempDir('modes-fresh'), 'observogram.db');
  const r2 = await packc(['store', 'restore', backup], { OBSERVOGRAM_DB: freshPath });
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(modeOf(freshPath), 0o600, 'a restore with no previous store is 0600');
});
