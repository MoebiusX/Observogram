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

// ---------- commit 4: the Import gate ----------

const { applyImport, formatReport, planImport, projectedMigration, readLegacy } = await import('./store/import.mjs');
const users = await import('./store/users.mjs');
const orgsRepo = await import('./store/orgs.mjs');
const membershipsRepo = await import('./store/memberships.mjs');
const auditRepo = await import('./store/audit.mjs');
const identity = await import('./store/identity.mjs');
const { baseWorkspacePath } = await import('../tools/lib/brand-env.mjs');

const ISSUER = 'https://idp.example';
const KEY = 'https://idp.example/';
const PW = { algo: 'scrypt', N: 16384, r: 8, p: 1, salt: 'c2FsdA==', hash: 'aGFzaA==' };

// A fixture workspace: users.json / orgs.json as given (an object is
// written as JSON), plus flat or org-tree files ({ relPath: text }).
function workspace({ users: u, orgs: o, files = {} } = {}) {
  const base = tempDir('ws');
  if (u !== undefined) write(join(base, 'users.json'), typeof u === 'string' ? u : JSON.stringify(u, null, 2));
  if (o !== undefined) write(join(base, 'orgs.json'), typeof o === 'string' ? o : JSON.stringify(o, null, 2) + '\n');
  for (const [rel, text] of Object.entries(files)) write(join(base, rel), text);
  return base;
}

function contextFor(base, { oidc = false, usersFileEnv = null, joinRoleEnv = undefined, dbPath = join(base, 'observogram.db') } = {}) {
  return {
    base, now: '2026-09-24T10:00:00.000Z', dbPath, memory: false,
    identityMode: oidc ? 'oidc' : 'local', issuerRaw: oidc ? ISSUER : null, issuerKey: oidc ? identity.canonIssuer(ISSUER) : null,
    usersFileEnv, joinRoleEnv,
  };
}

async function storeFor(ctx) {
  const db = await openStore({ path: ctx.dbPath });
  return { db, close: () => closeStore(ctx.dbPath) };
}

// Boot step 3 as the boot will run it: read, plan before anything moves,
// migrate unless the store already keeps a default org at '.', read and
// plan again, apply.
function runImport(db, ctx) {
  const legacy1 = readLegacy(db, ctx);
  const migrate = legacy1.orgs.exists && !orgsRepo.listOrgs(db).some((org) => org.root === '.');
  const flat = migrate ? planFlatMigration({ base: ctx.base }) : null;
  const plan1 = planImport(db, legacy1, ctx, projectedMigration({ flat, migrate, orgs: legacy1.orgs }));
  const migration = migrate
    ? { ...migrateFlatWorkspace({ base: ctx.base }), skipped: null }
    : projectedMigration({ flat: null, migrate, orgs: legacy1.orgs });
  const legacy2 = readLegacy(db, ctx);
  const plan2 = planImport(db, legacy2, ctx, migration);
  const report = applyImport(db, plan2, ctx);
  return { plan1, plan2, report };
}

const rowsOf = (db) => ({
  orgs: orgsRepo.listOrgs(db, { includeRemoved: true }).map((o) => [o.id, o.name, o.root]),
  users: users.listUsers(db).map((u) => ({
    login: u.login, kind: u.kind, owner: u.isOwner, disabled: u.disabled, epoch: u.sessionEpoch, sub: u.sub,
  })),
  memberships: orgsRepo.listOrgs(db, { includeRemoved: true }).flatMap((o) => membershipsRepo.listMembers(db, o.id)
    .map((m) => [o.id, users.getUser(db, m.userId).login, m.role])),
});
const metaOf = (db, key) => meta.getMeta(db, key);
const importAudit = (db) => auditRepo.listAudit(db, { limit: 1000 }).reverse().map((r) => r.action);
const samePlans = (a, b) => assert.deepEqual(
  { orgs: a.orgs, users: a.users, memberships: a.memberships, liveOrgsAfter: a.liveOrgsAfter },
  { orgs: b.orgs, users: b.users, memberships: b.memberships, liveOrgsAfter: b.liveOrgsAfter },
  'plan1 and plan2 plan the same rows',
);

test('Import: a flat stand-alone workspace — default at ".", every user an owner and admin of it at epoch 0, armed, no users_file', async () => {
  const base = workspace({
    users: { users: { alice: { name: 'Alice', createdAt: '2025-01-01T00:00:00.000Z', password: PW }, bob: { password: PW, mustChange: true } } },
    files: { 'packs/p.pack.yaml': PACK },
  });
  const ctx = contextFor(base);
  const { db, close } = await storeFor(ctx);
  try {
    const { plan1, plan2, report } = runImport(db, ctx);
    samePlans(plan1, plan2);
    assert.deepEqual(rowsOf(db), {
      orgs: [['default', 'Default', '.']],
      users: [
        { login: 'alice', kind: 'local', owner: true, disabled: false, epoch: 0, sub: null },
        { login: 'bob', kind: 'local', owner: true, disabled: false, epoch: 0, sub: null },
      ],
      memberships: [['default', 'alice', 'admin'], ['default', 'bob', 'admin']],
    });
    const alice = users.getUserByLogin(db, 'alice');
    assert.deepEqual([alice.name, alice.createdAt, alice.password], ['Alice', '2025-01-01T00:00:00.000Z', PW]);
    assert.equal(users.getUserByLogin(db, 'bob').mustChange, true);
    assert.equal(users.getUserByLogin(db, 'bob').createdAt, ctx.now);
    assert.deepEqual([metaOf(db, 'identity_armed'), metaOf(db, 'users_file'), metaOf(db, 'default_org'), metaOf(db, 'oidc_join_role'), metaOf(db, 'import_done')],
      ['1', null, 'default', null, ctx.now]);
    assert.deepEqual(meta.getMetaJson(db, 'legacy_hashes'), {
      'users.json': { sha256: legacy.sha256File(join(base, 'users.json')).sha256 }, 'orgs.json': { absent: true },
    });
    assert.deepEqual(report.owners, ['alice', 'bob']);
    assert.equal(report.noOwner, false);
    assert.deepEqual(meta.getMetaJson(db, 'import_report'), report);
    assert.ok(existsSync(join(base, 'packs', 'p.pack.yaml')), 'no orgs.json: nothing moves');
    assert.deepEqual(importAudit(db), ['store.import'], 'exactly one audit row');
    const [row] = auditRepo.listAudit(db);
    assert.deepEqual([row.actor, row.orgId, row.targetKind, row.targetId, row.detail],
      ['system', null, 'store', meta.storeId(db), { users: 2, orgs: 1, memberships: 2, owners: 2, dropped: 0, conflicts: 0, mode: 'local' }]);
    const lines = formatReport(report);
    assert.match(lines[0], /^\[store\] imported .*users\.json \(2 users\) and no orgs\.json \(1 org, 2 memberships\) into .*observogram\.db \(store [0-9a-f-]{36}\)$/);
    assert.equal(lines[1], '[store]   default org default (.); owners: alice, bob');
    assert.throws(() => applyImport(db, plan2, ctx), /was imported while this start was planning/, 'import_done is re-checked inside the transaction');
    assert.deepEqual(importAudit(db), ['store.import']);
  } finally {
    close();
  }
});

test('Import: OBSERVOGRAM_USERS_FILE outside the workspace — users_file is its resolved path and legacy_hashes is keyed by it', async () => {
  const base = workspace();
  const outside = write(join(tempDir('users-outside'), 'etc', 'users.json'), JSON.stringify({ users: { alice: { password: PW } } }));
  const ctx = contextFor(base, { usersFileEnv: outside });
  const { db, close } = await storeFor(ctx);
  try {
    await withEnv({ OBSERVOGRAM_USERS_FILE: outside }, () => runImport(db, ctx));
    assert.equal(metaOf(db, 'users_file'), outside);
    assert.deepEqual(meta.getMetaJson(db, 'legacy_hashes'), { [outside]: legacy.sha256File(outside), 'orgs.json': { absent: true } });
    assert.deepEqual(rowsOf(db).users.map((u) => u.login), ['alice']);
    assert.equal(legacy.legacyUsersPath(db, base), outside, 'the recorded path wins from now on');
  } finally {
    close();
  }
});

test('Import: orgs.json-armed with a not-yet-moved flat workspace — the data moves, default is real at orgs/default and the default org; no admin of it → noOwner', async () => {
  const base = workspace({
    users: { users: { alice: { password: PW } } },
    orgs: { acme: { name: 'Acme', members: { alice: 'admin' } } },
    files: { 'packs/p.pack.yaml': PACK, 'deploys.jsonl': '{"type":"deploy"}\n' },
  });
  const ctx = contextFor(base);
  const { db, close } = await storeFor(ctx);
  try {
    const { plan1, plan2, report } = runImport(db, ctx);
    samePlans(plan1, plan2);
    assert.notDeepEqual(plan1.legacyHashes, plan2.legacyHashes, 'the migration rewrote orgs.json');
    assert.ok(existsSync(join(base, 'orgs', 'default', 'packs', 'p.pack.yaml')));
    assert.deepEqual(rowsOf(db), {
      orgs: [['acme', 'Acme', 'orgs/acme'], ['default', 'Default', 'orgs/default']],
      users: [{ login: 'alice', kind: 'local', owner: false, disabled: false, epoch: 0, sub: null }],
      memberships: [['acme', 'alice', 'admin']],
    });
    assert.equal(metaOf(db, 'default_org'), 'default');
    assert.deepEqual(report.migration, { moved: ['packs', 'deploys.jsonl'], leftBehind: [], wroteDefault: true, skipped: null });
    assert.deepEqual([report.owners, report.noOwner, report.orgsJson], [[], true, true]);
    assert.deepEqual(meta.getMetaJson(db, 'legacy_hashes')['orgs.json'], legacy.sha256File(join(base, 'orgs.json')), 'the hash of the rewritten file');
    assert.ok(formatReport(report).includes('[store]   no owner — run `npm run users -- owner <login>`'));
  } finally {
    close();
  }
});

test('Import: a flat entry with data plus its orgs/default/ twin with data — nothing moved or merged, listed as left behind', async () => {
  const base = workspace({
    users: { users: { alice: { password: PW } } },
    orgs: { acme: { members: { alice: 'admin' } } },
    files: { 'packs/flat.pack.yaml': PACK, 'orgs/default/packs/twin.pack.yaml': PACK },
  });
  const ctx = contextFor(base);
  const { db, close } = await storeFor(ctx);
  try {
    const { plan1, plan2, report } = runImport(db, ctx);
    samePlans(plan1, plan2);
    assert.deepEqual(report.migration, { moved: [], leftBehind: ['packs'], wroteDefault: false, skipped: null });
    assert.ok(existsSync(join(base, 'packs', 'flat.pack.yaml')));
    assert.ok(!existsSync(join(base, 'orgs', 'default', 'packs', 'flat.pack.yaml')));
    assert.deepEqual(rowsOf(db).orgs, [['acme', 'acme', 'orgs/acme']]);
    assert.equal(metaOf(db, 'default_org'), 'acme');
    assert.deepEqual(report.owners, ['alice'], 'the default org is acme: its admins are the owners');
  } finally {
    close();
  }
});

test('Import: an acme-only orgs.json plus the empty default artefact — default dropped and listed, the default org is acme, its admins the owners', async () => {
  const base = workspace({
    users: { users: { alice: { password: PW }, bob: { password: PW } } },
    orgs: { acme: { name: 'Acme', members: { alice: 'admin', bob: 'operator' } }, default: { name: 'Default', members: {} } },
    files: { 'orgs/default/packs/.keep': '' },
  });
  const ctx = contextFor(base);
  const { db, close } = await storeFor(ctx);
  try {
    const { plan1, plan2, report } = runImport(db, ctx);
    samePlans(plan1, plan2);
    assert.deepEqual(plan1.liveOrgsAfter, ['acme']);
    assert.deepEqual(rowsOf(db), {
      orgs: [['acme', 'Acme', 'orgs/acme']],
      users: [
        { login: 'alice', kind: 'local', owner: true, disabled: false, epoch: 0, sub: null },
        { login: 'bob', kind: 'local', owner: false, disabled: false, epoch: 0, sub: null },
      ],
      memberships: [['acme', 'alice', 'admin'], ['acme', 'bob', 'operator']],
    });
    assert.deepEqual(report.orgs.dropped, [{ id: 'default', reason: 'empty leftover of the flat-workspace migration' }]);
    assert.deepEqual([metaOf(db, 'default_org'), report.owners], ['acme', ['alice']]);
    assert.ok(formatReport(report).some((l) => l.startsWith('[store]   dropped: org default (empty leftover of the flat-workspace migration)')));
  } finally {
    close();
  }
});

test('Import: OIDC with orgs.json — one kind oidc row per member key across orgs, login <issuerKey>#<key>, sub the key, epoch 0; no oidc_join_role; owners the default org\'s admins', async () => {
  const base = workspace({
    orgs: {
      default: { name: 'Home', members: { 'sub-a': 'admin', 'sub-b': 'member' } },
      acme: { name: 'Acme', members: { 'sub-b': 'admin', 'sub-c': 'viewer' } },
    },
    files: { 'orgs/default/packs/p.pack.yaml': PACK },
  });
  const ctx = contextFor(base, { oidc: true });
  const { db, close } = await storeFor(ctx);
  try {
    const { plan1, plan2, report } = runImport(db, ctx);
    samePlans(plan1, plan2);
    assert.deepEqual(rowsOf(db), {
      orgs: [['default', 'Home', 'orgs/default'], ['acme', 'Acme', 'orgs/acme']],
      users: [
        { login: `${KEY}#sub-a`, kind: 'oidc', owner: true, disabled: false, epoch: 0, sub: 'sub-a' },
        { login: `${KEY}#sub-b`, kind: 'oidc', owner: false, disabled: false, epoch: 0, sub: 'sub-b' },
        { login: `${KEY}#sub-c`, kind: 'oidc', owner: false, disabled: false, epoch: 0, sub: 'sub-c' },
      ],
      memberships: [
        ['default', `${KEY}#sub-a`, 'admin'], ['default', `${KEY}#sub-b`, 'operator'],
        ['acme', `${KEY}#sub-b`, 'admin'], ['acme', `${KEY}#sub-c`, 'viewer'],
      ],
    });
    assert.equal(users.getUserByLogin(db, `${KEY}#sub-a`).issuer, ISSUER, 'the display issuer is the env value');
    assert.deepEqual([metaOf(db, 'oidc_join_role'), metaOf(db, 'identity_armed'), metaOf(db, 'default_org')], [null, null, 'default']);
    assert.deepEqual([report.identityMode, report.issuerKey, report.owners], ['oidc', KEY, [`${KEY}#sub-a`]]);
    assert.deepEqual(report.memberships.inexact, [{ org: 'default', key: 'sub-b', from: 'member', to: 'operator' }]);
    assert.deepEqual(report.memberships.viewers, [{ org: 'acme', key: 'sub-c' }]);
  } finally {
    close();
  }
});

test('Import: OIDC without orgs.json — default at "."; oidc_join_role operator, absent with OBSERVOGRAM_OIDC_JOIN_ROLE=none, viewer with viewer', async () => {
  for (const [joinRoleEnv, expected] of [[undefined, 'operator'], [null, null], ['viewer', 'viewer']]) {
    const base = workspace({ files: { 'packs/p.pack.yaml': PACK } });
    const ctx = contextFor(base, { oidc: true, joinRoleEnv });
    const { db, close } = await storeFor(ctx);
    try {
      const { report } = runImport(db, ctx);
      assert.deepEqual(rowsOf(db), { orgs: [['default', 'Default', '.']], users: [], memberships: [] });
      assert.equal(metaOf(db, 'oidc_join_role'), expected, String(joinRoleEnv));
      assert.equal(report.oidcJoinRole, expected);
      assert.equal(metaOf(db, 'identity_armed'), null, 'no users file: not armed');
    } finally {
      close();
    }
  }
});

test('Import: a leftover users.json under OIDC — its rows disabled, never owners; identity_armed set', async () => {
  const base = workspace({ users: { users: { alice: { password: PW }, bob: { password: PW } } } });
  const ctx = contextFor(base, { oidc: true });
  const { db, close } = await storeFor(ctx);
  try {
    const { report } = runImport(db, ctx);
    assert.deepEqual(rowsOf(db).users, [
      { login: 'alice', kind: 'local', owner: false, disabled: true, epoch: 0, sub: null },
      { login: 'bob', kind: 'local', owner: false, disabled: true, epoch: 0, sub: null },
    ]);
    assert.deepEqual(rowsOf(db).memberships, []);
    assert.deepEqual([metaOf(db, 'identity_armed'), report.users.disabled, report.owners], ['1', ['alice', 'bob'], []]);
    assert.ok(formatReport(report).some((l) => /imported disabled \(OIDC is configured\): alice, bob/.test(l)));
  } finally {
    close();
  }
});

test('Import: a local username equal to an orgs.json OIDC sub — the membership goes to the oidc row, the local row has none', async () => {
  const base = workspace({ users: { users: { alice: { password: PW } } }, orgs: { acme: { members: { alice: 'admin' } } } });
  const ctx = contextFor(base, { oidc: true });
  const { db, close } = await storeFor(ctx);
  try {
    runImport(db, ctx);
    assert.deepEqual(rowsOf(db).memberships, [['acme', `${KEY}#alice`, 'admin']]);
    assert.deepEqual(membershipsRepo.listMembershipsForUser(db, users.getUserByLogin(db, 'alice').id), []);
    assert.equal(users.getUserByLogin(db, 'alice').disabled, true);
    assert.equal(users.getUserByLogin(db, `${KEY}#alice`).isOwner, true);
  } finally {
    close();
  }
});

test('Import: a legacy .tomograph/ workspace — users.json read there; the database and the marker live under it', async () => {
  const dir = tempDir('tomograph');
  write(join(dir, '.tomograph', 'users.json'), JSON.stringify({ users: { alice: { password: PW } } }));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const base = baseWorkspacePath();
    assert.equal(base, join(dir, '.tomograph'));
    const { resolveDbPath } = await import('./store/db.mjs');
    const ctx = contextFor(base, { dbPath: resolveDbPath() });
    assert.equal(ctx.dbPath, join(dir, '.tomograph', 'observogram.db'));
    const { db, close } = await storeFor(ctx);
    try {
      const legacy1 = readLegacy(db, ctx);
      assert.equal(legacy1.usersPath, join(dir, '.tomograph', 'users.json'));
      const { plan2 } = runImport(db, ctx);
      assert.deepEqual(rowsOf(db).users.map((u) => u.login), ['alice']);
      legacy.writeMarker(ctx.base, { storeId: meta.storeId(db), files: plan2.legacyHashes, by: 'import' });
      assert.ok(existsSync(join(dir, '.tomograph', '.store-imported')));
      assert.ok(!existsSync(join(dir, '.observogram')), 'nothing is created under .observogram/');
    } finally {
      close();
    }
  } finally {
    process.chdir(cwd);
  }
});

test('Import: an empty users.json — armed, no users, no owner', async () => {
  const base = workspace({ users: { users: {} } });
  const ctx = contextFor(base);
  const { db, close } = await storeFor(ctx);
  try {
    const { report } = runImport(db, ctx);
    assert.deepEqual(rowsOf(db), { orgs: [['default', 'Default', '.']], users: [], memberships: [] });
    assert.deepEqual([metaOf(db, 'identity_armed'), report.noOwner, report.owners], ['1', true, []]);
  } finally {
    close();
  }
});

test('Import: unknown and messy roles map without refusing — owner, Admin, \' Viewer \', editor, admn, null, "" → admin, admin, viewer, operator, operator, operator, operator', async () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const base = workspace({
    users: { users: Object.fromEntries(names.map((n) => [n, { password: PW }])) },
    orgs: { acme: { members: { a: 'owner', b: 'Admin', c: ' Viewer ', d: 'editor', e: 'admn', f: null, g: '' } } },
  });
  const ctx = contextFor(base);
  const { db, close } = await storeFor(ctx);
  try {
    const { report } = runImport(db, ctx);
    assert.deepEqual(rowsOf(db).memberships.map(([, login, role]) => [login, role]), [
      ['a', 'admin'], ['b', 'admin'], ['c', 'viewer'], ['d', 'operator'], ['e', 'operator'], ['f', 'operator'], ['g', 'operator'],
    ]);
    assert.deepEqual(report.memberships.inexact.map((m) => [m.key, m.from, m.to]), [
      ['a', 'owner', 'admin'], ['b', 'Admin', 'admin'], ['c', ' Viewer ', 'viewer'], ['d', 'editor', 'operator'],
      ['e', 'admn', 'operator'], ['f', null, 'operator'], ['g', '', 'operator'],
    ]);
    assert.deepEqual(report.memberships.viewers, [{ org: 'acme', key: 'c' }]);
    const mapped = formatReport(report).find((l) => l.startsWith('[store]   roles mapped:'));
    assert.ok(mapped.includes("acme/c ' Viewer ' → viewer (loses write power when roles are enforced)"), mapped);
  } finally {
    close();
  }
});

test('Import: an orgs.json of {} — default at orgs/default (A-5)', async () => {
  const base = workspace({ users: { users: { alice: { password: PW } } }, orgs: {} });
  const ctx = contextFor(base);
  const { db, close } = await storeFor(ctx);
  try {
    const { plan1, report } = runImport(db, ctx);
    assert.deepEqual(plan1.liveOrgsAfter, ['default']);
    assert.deepEqual(rowsOf(db).orgs, [['default', 'Default', 'orgs/default']]);
    assert.deepEqual([metaOf(db, 'default_org'), report.owners], ['default', []]);
  } finally {
    close();
  }
});

test('Import: a CLI-initialised store — the existing alice kept (password, epoch 1) as a conflict, bob imported owner and admin of the kept default at ".", default_org kept', async () => {
  const base = workspace({ users: { users: { alice: { password: { ...PW, hash: 'b3RoZXI=' } }, bob: { password: PW } } } });
  const ctx = contextFor(base);
  const { db, close } = await storeFor(ctx);
  try {
    identity.ensureDefaultOrg(db, 'cli');
    const alice = users.createUser(db, 'cli', { login: 'alice', password: PW, isOwner: true });
    membershipsRepo.addMembership(db, 'cli', { orgId: 'default', userId: alice.id, role: 'admin' });
    meta.setMeta(db, 'cli', 'identity_armed', '1');
    const before = importAudit(db);
    const { report } = runImport(db, ctx);
    const got = rowsOf(db);
    got.memberships.sort();   // created_at order: the fixture's clock is not the import's
    assert.deepEqual(got, {
      orgs: [['default', 'Default', '.']],
      users: [
        { login: 'alice', kind: 'local', owner: true, disabled: false, epoch: 1, sub: null },
        { login: 'bob', kind: 'local', owner: true, disabled: false, epoch: 0, sub: null },
      ],
      memberships: [['default', 'alice', 'admin'], ['default', 'bob', 'admin']],
    });
    assert.deepEqual(users.getUserByLogin(db, 'alice').password, PW, 'the store\'s password is kept');
    assert.deepEqual(report.users.conflicts, [{ login: 'alice', reason: 'kept the existing row' }]);
    assert.deepEqual(report.orgs.conflicts, [{ id: 'default', reason: 'kept the existing org' }]);
    assert.deepEqual([metaOf(db, 'default_org'), report.orgs.defaultOrg, report.orgs.defaultOrgKept], ['default', 'default', true]);
    assert.deepEqual(report.owners, ['bob']);
    assert.deepEqual(importAudit(db).slice(before.length), ['store.import']);
  } finally {
    close();
  }
});

test('Import: the field rules — values the store cannot hold are nulled or dropped and listed, never refused; plan1 and plan2 plan the same rows; applyImport succeeds', async () => {
  const long = 'n'.repeat(201);
  const base = workspace({
    users: { users: {
      bob: { email: '', name: '   ', password: PW }, eve: { email: `${'e'.repeat(317)}@x.io`, password: PW },
      'John Smith': { password: PW }, 'ops#1': { password: PW }, '': { password: PW }, [long]: { password: PW },
      carl: { password: 'hunter2', createdAt: 'test' },
    } },
    orgs: { acme: { name: long, members: { bob: 'admin' } }, 'Bad!': { name: 'Bad', members: { carl: 'admin' } } },
    files: { 'packs/p.pack.yaml': PACK },
  });
  const ctx = contextFor(base);
  const { db, close } = await storeFor(ctx);
  try {
    const { plan1, plan2, report } = runImport(db, ctx);
    samePlans(plan1, plan2);
    assert.deepEqual(rowsOf(db).users.map((u) => u.login), ['bob', 'eve', 'John Smith', 'ops#1', 'carl']);
    const bob = users.getUserByLogin(db, 'bob');
    assert.deepEqual([bob.email, bob.name], [null, null]);
    assert.equal(users.getUserByLogin(db, 'eve').email, null);
    assert.equal(users.getUserByLogin(db, 'carl').password, null);
    assert.equal(users.getUserByLogin(db, 'carl').createdAt, ctx.now);
    assert.deepEqual(report.users.droppedFields, [
      { login: 'bob', field: 'name', reason: 'blank' },
      { login: 'eve', field: 'email', reason: 'longer than 320 characters' },
      { login: 'carl', field: 'password', reason: 'not a password record' },
      { login: 'carl', field: 'createdAt', reason: 'not a timestamp — the import time is used' },
    ]);
    assert.deepEqual(report.users.dropped, [{ login: '', reason: 'empty' }, { login: long, reason: 'longer than 200 characters' }]);
    assert.deepEqual(rowsOf(db).orgs, [['acme', 'acme', 'orgs/acme'], ['default', 'Default', 'orgs/default']]);
    assert.deepEqual(report.orgs.droppedFields, [{ id: 'acme', field: 'name', reason: 'longer than 200 characters — the id is its name' }]);
    assert.deepEqual(report.orgs.dropped, [{ id: 'Bad!', reason: 'not a valid org id (a slug: lowercase letters, digits, - and _)' }]);
    assert.deepEqual(rowsOf(db).memberships, [['acme', 'bob', 'admin']]);
    const lines = formatReport(report);
    assert.ok(lines.some((l) => l.startsWith('[store]   fields dropped: bob name (blank) · eve email (longer than 320 characters)')), lines.join('\n'));
    assert.ok(lines.some((l) => l.includes("org Bad! (not a valid org id") && l.includes("user '' (empty)")), lines.join('\n'));
  } finally {
    close();
  }
});

test('Import: the field rules under OIDC — an empty and a 2001-character member key dropped as not a usable sub; a users.json name <issuerKey>#x dropped as a conflict while the member x becomes the oidc row', async () => {
  const base = workspace({
    users: { users: { [`${KEY}#x`]: { password: PW }, alice: { password: PW } } },
    orgs: { acme: { members: { '': 'admin', ['s'.repeat(2001)]: 'admin', x: 'admin' } } },
  });
  const ctx = contextFor(base, { oidc: true });
  const { db, close } = await storeFor(ctx);
  try {
    const { plan1, plan2, report } = runImport(db, ctx);
    samePlans(plan1, plan2);
    assert.deepEqual(report.memberships.dropped.map((d) => [d.org, d.key.length, d.reason]), [['acme', 0, 'not a usable sub'], ['acme', 2001, 'not a usable sub']]);
    assert.deepEqual(report.users.conflicts, [{ login: `${KEY}#x`, reason: `has the form of an OIDC login under ${KEY}` }]);
    const x = users.getUserByLogin(db, `${KEY}#x`);
    assert.deepEqual([x.kind, x.sub, x.isOwner], ['oidc', 'x', true]);
    assert.deepEqual(rowsOf(db).memberships, [['acme', `${KEY}#x`, 'admin']]);
    assert.ok(metaOf(db, 'import_done'), 'the import committed');
  } finally {
    close();
  }
});

test('Import: an existing store row holding an OIDC member\'s login as kind local — the membership is dropped and listed, no row changed', async () => {
  const base = workspace({ orgs: { acme: { members: { alice: 'admin', bob: 'operator' } } } });
  const ctx = contextFor(base, { oidc: true });
  const { db, close } = await storeFor(ctx);
  try {
    const local = users.createUser(db, 'cli', { login: `${KEY}#alice`, password: PW });
    const { report } = runImport(db, ctx);
    assert.deepEqual(report.memberships.dropped, [{ org: 'acme', key: 'alice', reason: 'the login is held by a local user' }]);
    assert.deepEqual(users.getUser(db, local.id), local, 'no row changed');
    assert.deepEqual(rowsOf(db).memberships, [['acme', `${KEY}#bob`, 'operator']]);
  } finally {
    close();
  }
});

test('Import: applyImport is atomic — a plan whose third insert fails leaves no row, no meta and no audit row; one store.import row on success', async () => {
  const base = workspace({ users: { users: { alice: { password: PW }, bob: { password: PW } } } });
  const ctx = contextFor(base);
  const { db, close } = await storeFor(ctx);
  try {
    const plan = planImport(db, readLegacy(db, ctx), ctx, projectedMigration({ migrate: false, orgs: { exists: false } }));
    assert.deepEqual([plan.orgs.length, plan.users.length], [1, 2]);
    const broken = { ...plan, users: [plan.users[0], { ...plan.users[1], login: plan.users[0].login }] };
    assert.throws(() => applyImport(db, broken, ctx), /UNIQUE/);
    assert.deepEqual(rowsOf(db), { orgs: [], users: [], memberships: [] });
    assert.deepEqual([metaOf(db, 'import_done'), metaOf(db, 'identity_armed'), metaOf(db, 'import_report')], [null, null, null]);
    assert.deepEqual(importAudit(db), []);
    applyImport(db, plan, ctx);
    assert.deepEqual(importAudit(db), ['store.import']);
    assert.equal(rowsOf(db).users.length, 2);
  } finally {
    close();
  }
});
