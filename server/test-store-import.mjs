#!/usr/bin/env node
/**
 * server/test-store-import.mjs — the legacy import (docs/STORE_PLAN.md §4
 * steps 2–3, §8 gates Import and Boot order), in-process.
 *
 * The strict readers of users.json / orgs.json, the hashes and the import
 * marker, the flat-workspace migration, and (from the import engine on)
 * readLegacy → planImport → applyImport on fixture workspaces, each
 * asserting every row and the report.
 *
 * Hermetic: a developer shell with OBSERVOGRAM_DB (or the other boot
 * variables) exported must not reach these tests, so they are deleted
 * before any server code loads. Every fixture is a temp workspace with its
 * own temp-file store.
 */

for (const suffix of ['DB', 'BOOTSTRAP_ADMIN', 'OIDC_JOIN_ROLE', 'ADMIN_PASSWORD', 'INSECURE_NO_AUTH', 'USERS_FILE', 'WORKSPACE', 'OIDC_ISSUER']) {
  delete process.env[`OBSERVOGRAM_${suffix}`];
  delete process.env[`TOMOGRAPH_${suffix}`];
}

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { spawnSync } = await import('node:child_process');
const {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} = await import('node:fs');
const { tmpdir } = await import('node:os');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const legacy = await import('./store/legacy-files.mjs');
const { planFlatMigration, migrateFlatWorkspace } = await import('./tenancy.mjs');
const { closeStore, openStore, tx } = await import('./store/db.mjs');
const meta = await import('./store/meta.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));

const tmpDirs = [];
function tempDir(tag = 'import') {
  const d = mkdtempSync(join(tmpdir(), `observogram-${tag}-`));
  tmpDirs.push(d);
  return d;
}
process.on('exit', () => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.finally(restore);
    restore();
    return r;
  } catch (e) {
    restore();
    throw e;
  }
}

const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path; };
const isLegacyError = (path) => (e) => e instanceof legacy.LegacyFileError && e.code === 'ERR_OBSERVOGRAM_LEGACY_FILE'
  && e.path === path && e.message.startsWith(`${path}: `) && /the upgrade imports nothing until it is fixed/.test(e.message);

// ---------- commit 3: readers, hashes, marker, migration ----------

test('strict readers: the file — corrupt JSON, a users array, a string record, an array org, a members list refuse naming the path; an absent file is absent', () => {
  const dir = tempDir('readers');
  const u = join(dir, 'users.json');
  const o = join(dir, 'orgs.json');
  assert.deepEqual(legacy.readUsersFileStrict(u), { path: u, exists: false });
  assert.deepEqual(legacy.readOrgsFileStrict(o), { path: o, exists: false });
  for (const text of ['{ "users": ', '[]', '{}', '{ "users": [] }', '{ "users": { "alice": "pw" } }', '{ "users": { "alice": null } }', 'null']) {
    write(u, text);
    assert.throws(() => legacy.readUsersFileStrict(u), isLegacyError(u), text);
  }
  for (const text of ['{ "acme": ', '[]', '{ "acme": [] }', '{ "acme": "Acme" }', '{ "acme": { "members": ["alice"] } }', '{ "acme": { "members": "alice" } }']) {
    write(o, text);
    assert.throws(() => legacy.readOrgsFileStrict(o), isLegacyError(o), text);
  }
  mkdirSync(join(dir, 'dir.json'));
  assert.throws(() => legacy.readUsersFileStrict(join(dir, 'dir.json')), (e) => isLegacyError(join(dir, 'dir.json'))(e) && /EISDIR/.test(e.message));
});

test('strict readers: EACCES on read is an error, not "absent"', (t) => {
  const dir = tempDir('eacces');
  const u = write(join(dir, 'users.json'), '{ "users": {} }');
  chmodSync(u, 0o000);
  if (process.getuid?.() !== 0) {
    assert.throws(() => legacy.readUsersFileStrict(u), (e) => isLegacyError(u)(e) && /EACCES/.test(e.message));
    assert.throws(() => legacy.sha256File(u), (e) => isLegacyError(u)(e) && /EACCES/.test(e.message));
    return;
  }
  // root reads anything: read it as nobody in a child process.
  chmodSync(dir, 0o755);
  const mod = JSON.stringify(join(HERE, 'store', 'legacy-files.mjs'));
  const asNobody = (code) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { uid: 65534, gid: 65534, encoding: 'utf8' });
  // First prove nobody can run this Node, import the module and read a
  // readable file next to u; otherwise an EACCES below would not be the
  // one under test (and a checkout under a 0700 parent is not a failure).
  const control = write(join(dir, 'control.json'), '{}');
  chmodSync(control, 0o644);
  const probe = asNobody(`await import(${mod}); (await import('node:fs')).readFileSync(${JSON.stringify(control)});`);
  if (probe.error || probe.status !== 0) {
    t.skip(`cannot run ${process.execPath} as an unprivileged user on this checkout: ${probe.error?.code || probe.stderr.split('\n').find((l) => /^\w*Error|code:/.test(l.trim())) || probe.status}`);
    return;
  }
  const r = asNobody(`const m = await import(${mod});
    for (const f of [m.readUsersFileStrict, m.sha256File]) {
      try { f(${JSON.stringify(u)}); console.log('READ'); } catch (e) { console.log(e.code, /EACCES/.test(e.message)); }
    }`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['ERR_OBSERVOGRAM_LEGACY_FILE true', 'ERR_OBSERVOGRAM_LEGACY_FILE true']);
});

test('strict readers: entries — odd names, ids and values are returned as parsed, never refused (the store\'s rules are the import\'s)', () => {
  const dir = tempDir('entries');
  const long = 'n'.repeat(201);
  const u = write(join(dir, 'users.json'), JSON.stringify({ users: {
    'John Smith': { password: { algo: 'scrypt' } }, 'ops#1': {}, '': { name: 'x' }, [long]: {},
    carl: { password: 'hunter2', email: '' },
  } }));
  const got = legacy.readUsersFileStrict(u);
  assert.equal(got.exists, true);
  assert.deepEqual(got.raw, readFileSync(u), 'raw is the exact bytes read');
  assert.deepEqual(got.entries.map(([n]) => n), ['John Smith', 'ops#1', '', long, 'carl']);
  assert.deepEqual(got.entries[4][1], { password: 'hunter2', email: '' });
  const o = write(join(dir, 'orgs.json'), JSON.stringify({
    'Bad!': { name: 'Bad' }, acme: { name: 7, members: { alice: 'Admin', '': 'viewer', bob: null } }, bare: {}, nul: { members: null },
  }));
  const orgs = legacy.readOrgsFileStrict(o);
  assert.deepEqual(orgs.entries, [
    ['Bad!', { name: 'Bad', members: [] }],
    ['acme', { name: 7, members: [['alice', 'Admin'], ['', 'viewer'], ['bob', null]] }],
    ['bare', { name: undefined, members: [] }],
    ['nul', { name: undefined, members: [] }],
  ]);
});

test('paths: orgs.json under the base; the users file from OBSERVOGRAM_USERS_FILE (resolved) or the base; the recorded path wins after the import; the hash key', async () => {
  const base = tempDir('paths');
  assert.equal(legacy.orgsFilePath(base), join(base, 'orgs.json'));
  withEnv({ OBSERVOGRAM_USERS_FILE: undefined }, () => assert.equal(legacy.envUsersFilePath(base), join(base, 'users.json')));
  withEnv({ OBSERVOGRAM_USERS_FILE: 'rel/users.json' }, () => assert.equal(legacy.envUsersFilePath(base), join(process.cwd(), 'rel', 'users.json')));
  withEnv({ OBSERVOGRAM_WORKSPACE: base }, () => assert.equal(legacy.orgsFilePath(), join(base, 'orgs.json')));
  assert.equal(legacy.usersHashKey(null), 'users.json');
  assert.equal(legacy.usersHashKey('/etc/observogram/users.json'), '/etc/observogram/users.json');
  const path = join(base, 'observogram.db');
  const db = await openStore({ path });
  try {
    withEnv({ OBSERVOGRAM_USERS_FILE: '/elsewhere/u.json' }, () => {
      assert.equal(legacy.legacyUsersPath(db, base), '/elsewhere/u.json', 'before the import: this environment\'s');
      tx(db, () => meta.putMeta(db, 'import_done', '2026-01-01T00:00:00.000Z'));
      assert.equal(legacy.legacyUsersPath(db, base), join(base, 'users.json'), 'after an import without a recorded file: the base\'s');
      tx(db, () => meta.putMeta(db, 'users_file', '/recorded/users.json'));
      assert.equal(legacy.legacyUsersPath(db, base), '/recorded/users.json', 'the recorded path wins');
    });
  } finally {
    closeStore(path);
  }
});

test('hashes and the marker: sha256File absent vs present; compareHashes changed / appeared / disappeared; readMarker refuses a corrupt marker; writeMarker round-trips', () => {
  const base = tempDir('hashes');
  const f = join(base, 'users.json');
  assert.deepEqual(legacy.sha256File(f), { absent: true });
  write(f, 'abc');
  assert.deepEqual(legacy.sha256File(f), { sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
  assert.equal(legacy.sha256Of(Buffer.from('abc')), legacy.sha256File(f).sha256);

  const recorded = { 'users.json': { sha256: 'a' }, 'orgs.json': { absent: true }, '/x/u.json': { sha256: 'c' }, same: { sha256: 'd' } };
  const current = { 'users.json': { sha256: 'b' }, 'orgs.json': { sha256: 'e' }, '/x/u.json': { absent: true }, same: { sha256: 'd' } };
  assert.deepEqual(legacy.compareHashes(recorded, current), { changed: ['users.json'], appeared: ['orgs.json'], disappeared: ['/x/u.json'] });
  assert.deepEqual(legacy.compareHashes(recorded, recorded), { changed: [], appeared: [], disappeared: [] });
  assert.deepEqual(legacy.compareHashes({}, { 'orgs.json': { sha256: 'e' } }).appeared, ['orgs.json'], 'a key missing on one side reads as absent');

  assert.equal(legacy.readMarker(base), null);
  const files = { 'users.json': { sha256: 'a' }, 'orgs.json': { absent: true } };
  const p = legacy.writeMarker(base, { storeId: 'store-1', files, by: 'import' });
  assert.equal(p, join(base, legacy.MARKER));
  const m = legacy.readMarker(base);
  assert.deepEqual([m.storeId, m.files, m.by], ['store-1', files, 'import']);
  assert.ok(Number.isFinite(Date.parse(m.writtenAt)));
  assert.throws(() => legacy.writeMarker(base, { storeId: 'store-1', files, by: 'whim' }), /written by one of/);
  for (const text of ['{', '[]', '{ "storeId": "", "files": {}, "by": "import", "writtenAt": "x" }', '{ "storeId": "s", "files": [], "by": "import", "writtenAt": "x" }']) {
    write(p, text);
    assert.throws(() => legacy.readMarker(base), isLegacyError(p), text);
  }
});

test('hasData: absent, empty file, empty directory tree → no data; a byte, a nested file, a symlink (even dangling) → data', () => {
  const d = tempDir('hasdata');
  assert.equal(legacy.hasData(join(d, 'nothing')), false);
  write(join(d, 'empty.jsonl'), '');
  assert.equal(legacy.hasData(join(d, 'empty.jsonl')), false);
  mkdirSync(join(d, 'tree', 'a', 'b'), { recursive: true });
  write(join(d, 'tree', 'a', 'zero'), '');
  assert.equal(legacy.hasData(join(d, 'tree')), false);
  write(join(d, 'tree', 'a', 'b', 'one'), 'x');
  assert.equal(legacy.hasData(join(d, 'tree')), true);
  symlinkSync(join(d, 'missing'), join(d, 'link'));
  assert.equal(legacy.hasData(join(d, 'link')), true);
  mkdirSync(join(d, 'withlink'));
  symlinkSync(join(d, 'missing'), join(d, 'withlink', 'l'));
  assert.equal(legacy.hasData(join(d, 'withlink')), true);
});

const PACK = 'id: flat-pack\n';
function flatWorkspace({ orgs } = {}) {
  const base = tempDir('flat');
  write(join(base, 'packs', 'flat-pack.pack.yaml'), PACK);
  write(join(base, 'deploys.jsonl'), '{"type":"deploy"}\n');
  if (orgs !== undefined) write(join(base, 'orgs.json'), typeof orgs === 'string' ? orgs : JSON.stringify(orgs, null, 2) + '\n');
  return base;
}

test('planFlatMigration: empty dirs and a zero-byte deploys.jsonl are never moved; a twin leaves the flat entry behind; data moves', () => {
  const base = tempDir('plan');
  mkdirSync(join(base, 'packs', 'empty'), { recursive: true });
  write(join(base, 'deploys.jsonl'), '');
  write(join(base, 'journeys', 'j.yaml'), 'name: j\n');
  write(join(base, 'snapshots', 's.json'), '{}');
  mkdirSync(join(base, 'orgs', 'default', 'snapshots'), { recursive: true });
  assert.deepEqual(planFlatMigration({ base }), { move: ['journeys'], leftBehind: ['snapshots'], emptyLeftovers: ['packs', 'deploys.jsonl'] });
  assert.ok(existsSync(join(base, 'journeys', 'j.yaml')) && !existsSync(join(base, 'orgs', 'default', 'journeys')), 'read-only');
  withEnv({ OBSERVOGRAM_WORKSPACE: base }, () => assert.deepEqual(planFlatMigration().move, ['journeys'], 'the base defaults to the workspace'));
});

test('migrateFlatWorkspace: no orgs.json → nothing; data moves and \'default\' is written into orgs.json only when it moved data', () => {
  const none = flatWorkspace();
  assert.deepEqual(migrateFlatWorkspace({ base: none }), { moved: [], leftBehind: [], wroteDefault: false });
  assert.ok(existsSync(join(none, 'packs', 'flat-pack.pack.yaml')));

  const base = flatWorkspace({ orgs: { acme: { name: 'Acme', members: { alice: 'admin' } } } });
  const lines = [];
  const r = migrateFlatWorkspace({ base, log: (m) => lines.push(m) });
  assert.deepEqual(r, { moved: ['packs', 'deploys.jsonl'], leftBehind: [], wroteDefault: true });
  assert.ok(existsSync(join(base, 'orgs', 'default', 'packs', 'flat-pack.pack.yaml')));
  assert.ok(existsSync(join(base, 'orgs', 'default', 'deploys.jsonl')));
  assert.ok(!existsSync(join(base, 'packs')));
  assert.deepEqual(JSON.parse(readFileSync(join(base, 'orgs.json'), 'utf8')), {
    acme: { name: 'Acme', members: { alice: 'admin' } }, default: { name: 'Default', members: {} },
  });
  assert.equal(lines.length, 3, lines.join('\n'));
  const again = readFileSync(join(base, 'orgs.json'));
  assert.deepEqual(migrateFlatWorkspace({ base }), { moved: [], leftBehind: [], wroteDefault: false }, 'idempotent');
  assert.deepEqual(readFileSync(join(base, 'orgs.json')), again);

  // Only empty entries: nothing moves, orgs.json untouched, no orgs/default/.
  const empty = tempDir('flat-empty');
  mkdirSync(join(empty, 'packs'));
  write(join(empty, 'deploys.jsonl'), '');
  const orgsText = JSON.stringify({ acme: { name: 'Acme', members: {} } });
  write(join(empty, 'orgs.json'), orgsText);
  assert.deepEqual(migrateFlatWorkspace({ base: empty }), { moved: [], leftBehind: [], wroteDefault: false });
  assert.equal(readFileSync(join(empty, 'orgs.json'), 'utf8'), orgsText);
  assert.ok(!existsSync(join(empty, 'orgs')), 'an empty packs/ manufactures no orgs/default/');

  // A 'default' already declared: data moves, orgs.json untouched.
  const declared = flatWorkspace({ orgs: { default: { name: 'Home', members: {} } } });
  const text = readFileSync(join(declared, 'orgs.json'));
  assert.deepEqual(migrateFlatWorkspace({ base: declared }).wroteDefault, false);
  assert.deepEqual(readFileSync(join(declared, 'orgs.json')), text);

  // A twin: the flat entry is left behind, neither moved nor merged.
  const twin = flatWorkspace({ orgs: { acme: { name: 'Acme', members: {} } } });
  write(join(twin, 'orgs', 'default', 'packs', 'other.pack.yaml'), 'id: other\n');
  const logged = [];
  assert.deepEqual(migrateFlatWorkspace({ base: twin, log: (m) => logged.push(m) }), { moved: ['deploys.jsonl'], leftBehind: ['packs'], wroteDefault: true });
  assert.ok(existsSync(join(twin, 'packs', 'flat-pack.pack.yaml')));
  assert.ok(!existsSync(join(twin, 'orgs', 'default', 'packs', 'flat-pack.pack.yaml')));
  assert.ok(logged.some((l) => /left behind: .*packs/.test(l)));
});

test('migrateFlatWorkspace: a corrupt orgs.json fails naming its path before anything moves, and is never replaced', () => {
  const base = flatWorkspace({ orgs: '{ "acme": ' });
  const orgsPath = join(base, 'orgs.json');
  assert.throws(() => migrateFlatWorkspace({ base }), isLegacyError(orgsPath));
  assert.equal(readFileSync(orgsPath, 'utf8'), '{ "acme": ', 'byte-identical');
  assert.ok(existsSync(join(base, 'packs', 'flat-pack.pack.yaml')), 'nothing moved');
  assert.ok(!existsSync(join(base, 'orgs')));
});
