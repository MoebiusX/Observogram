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
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
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
    assert.throws(() => legacy.readMarker(base), (e) => e instanceof legacy.LegacyFileError && e.code === 'ERR_OBSERVOGRAM_LEGACY_FILE'
      && e.path === p && e.message.startsWith(`${p}: `) && /delete it and the next start rewrites it from the store/.test(e.message)
      && !/the upgrade imports nothing/.test(e.message), text);
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

test('Import: a flat entry with data plus its orgs/default/ twin with data — nothing moved or merged, listed as left behind; the twin is named, never planned as an org', async () => {
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
    assert.deepEqual(report.unreadDefaultDir, { path: join(base, 'orgs', 'default'), defaultOrg: 'acme', defaultRoot: join(base, 'orgs', 'acme') });
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
    assert.deepEqual(report.ownersKept, ['alice']);
    assert.equal(formatReport(report)[1], '[store]   default org default (kept as the store records it); owners: bob, alice (kept)');
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

// ---------- commit 6: the boot decisions, and bootStore() in-process ----------

const boot = await import('./boot.mjs');
const { hashPassword, verifyPassword } = await import('./auth.mjs');
const admin = await import('./identity-admin.mjs');
const { orgRootOf, resetOrgRootCache } = await import('./tenancy.mjs');
const { renameSync } = await import('node:fs');

const BOOT_VARS = ['WORKSPACE', 'DB', 'USERS_FILE', 'API_TOKEN', 'AUTH', 'ADMIN_PASSWORD', 'INSECURE_NO_AUTH', 'OIDC_ISSUER', 'OIDC_JOIN_ROLE', 'BOOTSTRAP_ADMIN'];
const CLEAR_BOOT_ENV = Object.fromEntries(BOOT_VARS.flatMap((s) => [[`OBSERVOGRAM_${s}`, undefined], [`TOMOGRAPH_${s}`, undefined]]));

// bootStore() on a temp workspace, with an explicit environment; the log
// and warn lines are captured. The store stays open (closeBase closes it).
async function bootIn(base, env = {}, { host = '127.0.0.1' } = {}) {
  const logs = [];
  const warns = [];
  try {
    const r = await withEnv({ ...CLEAR_BOOT_ENV, OBSERVOGRAM_WORKSPACE: base, ...env },
      () => boot.bootStore({ host, log: (m) => logs.push(m), warn: (m) => warns.push(m) }));
    return { ...r, logs, warns };
  } catch (e) {
    e.logs = logs;
    e.warns = warns;
    throw e;
  }
}
const dbOf = (base) => join(base, 'observogram.db');
const closeBase = (base) => closeStore(dbOf(base));
const refusal = (re) => (e) => e instanceof boot.BootRefusal && e.code === 'ERR_OBSERVOGRAM_BOOT_REFUSED' && (typeof re === 'string' ? e.message === re : re.test(e.message));
const auditRows = (db) => auditRepo.listAudit(db, { limit: 1000 }).reverse().map((r) => [r.action, r.actor, r.targetId]);

test('seedDecision table: every row of §6.4; no orgs.json input exists', () => {
  const base = { authOff: false, oidc: false, token: false, armed: false, adminPassword: null, loopback: true, adminStillSeeded: false };
  const rows = [
    [{ authOff: true }, 'none', null, 'OBSERVOGRAM_AUTH=off'],
    [{ oidc: true }, 'none', null, 'OIDC'],
    [{ token: true, adminPassword: 'pw' }, 'none', null, 'OBSERVOGRAM_API_TOKEN'],
    [{ armed: true }, 'none', null, 'identity is armed'],
    [{ armed: true, adminPassword: 'pw' }, 'none', null, 'the admin is not the seeded default'],
    [{ armed: true, adminPassword: 'pw', adminStillSeeded: true, loopback: false }, 'rescue', 'pw', null],
    [{ loopback: false }, 'none', null, 'the default credential never binds beyond loopback'],
    [{}, 'seed', null, null],
    [{ adminPassword: 'pw', loopback: false }, 'seed', 'pw', null],
    [{ adminPassword: 'pw' }, 'seed', 'pw', null],
  ];
  for (const [over, kind, password, reason] of rows) {
    const d = boot.seedDecision({ ...base, ...over });
    assert.deepEqual([d.kind, d.password], [kind, password], JSON.stringify(over));
    if (reason) assert.equal(d.reason, reason);
    assert.deepEqual(Object.keys(d).sort(), ['kind', 'password', 'reason'], 'a decision never carries a row');
  }
  assert.deepEqual(boot.seedDecision({ ...base, orgsJson: true }), boot.seedDecision(base), 'an orgs.json term changes nothing (A-56)');
});

test('seedDecision views: the legacy view before the import and the store view after it take the same inputs from the same facts', async () => {
  const cases = [
    { users: { users: { admin: { password: PW, mustChange: true, seededDefault: true } } } },
    { users: { users: { admin: { password: PW } } } },
    { orgs: { solo: { name: 'Solo', members: {} } } },
    {},
  ];
  for (const fixture of cases) {
    const base = workspace(fixture);
    const ctx = { ...contextFor(base), loopback: true, authOff: false, oidc: false, token: false, adminPassword: 'pw' };
    const { db, close } = await storeFor(ctx);
    try {
      const before = boot.legacyView(db, ctx, readLegacy(db, ctx));
      runImport(db, ctx);
      assert.deepEqual(boot.storeView(db, ctx), before, JSON.stringify(fixture));
      assert.deepEqual(boot.seedDecision(boot.storeView(db, ctx)), boot.seedDecision(before));
    } finally {
      close();
    }
  }
  // A CLI-armed store that was never imported is armed in the legacy view (A-2).
  const cliBase = workspace();
  const ctx = { ...contextFor(cliBase), loopback: true, authOff: false, oidc: false, token: false, adminPassword: null };
  const { db, close } = await storeFor(ctx);
  try {
    admin.addLocalUser(db, 'cli', { login: 'alice', password: 'correct horse' });
    assert.equal(boot.legacyView(db, ctx, readLegacy(db, ctx)).armed, true);
    assert.equal(boot.seedDecision(boot.legacyView(db, ctx, readLegacy(db, ctx))).kind, 'none');
  } finally {
    close();
  }
});

const MSG_A = (host) => `refusing to bind to ${host} without auth: mutating /api routes would be open to the network.\n`
  + '  Set OBSERVOGRAM_API_TOKEN=<secret> (clients send Authorization: Bearer <secret>),\n'
  + "  or seed a sign-in with OBSERVOGRAM_ADMIN_PASSWORD=<secret> (user 'admin'),\n"
  + '  or bind to loopback (HOST=127.0.0.1), or set OBSERVOGRAM_INSECURE_NO_AUTH=1 to override knowingly.';
const MSG_B = (host) => `refusing to bind to ${host} while the seeded default admin password is unchanged.\n`
  + '  Sign in once on loopback (admin / admin) to set a real password,\n'
  + '  or seed a fresh workspace with OBSERVOGRAM_ADMIN_PASSWORD=<secret>.';
const MSG_B_DISABLED = (host, login) => `refusing to bind to ${host} while the seeded default admin password is unchanged.\n`
  + `  The user ${login} is disabled but still holds it (a loopback sign-in or OBSERVOGRAM_ADMIN_PASSWORD cannot reach a disabled user).\n`
  + `  With the server stopped, run npm run users -- passwd ${login} to set a real password;\n`
  + `  the user can then stay disabled, or be enabled with npm run users -- enable ${login}.`;
const MSG_C3 = (n, ids) => `orgs.json would leave ${n} orgs (${ids}) but no identity is configured: more than one org needs to know who the user is.\n`
  + '  Configure OIDC (OBSERVOGRAM_OIDC_*), or start once with one org — one org boots with a bearer token alone, or on loopback:\n'
  + '  with the server stopped, edit orgs.json down to one org (or move it aside when the flat workspace is the other org).\n'
  + '  Then add stand-alone users with npm run users -- add <login>, and each other org with npm run orgs -- create <id> --adopt\n'
  + '  (the CLIs refuse until that first start has imported). Nothing was moved or imported.';

test('assertBootChecks table: A (and the INSECURE override), B after the decision, C counted from plan1.liveOrgsAfter, first failing check wins', async () => {
  const input = { step: 'store', host: '0.0.0.0', loopback: false, token: false, insecure: false, auth: false, stillSeeded: false, orgIds: ['default'], identity: false, strandedDefault: null };
  assert.throws(() => boot.assertBootChecks(input), refusal(MSG_A('0.0.0.0')));
  assert.throws(() => boot.assertBootChecks({ ...input, step: 'import' }), (e) => e.nothingMoved === true);
  assert.deepEqual(boot.assertBootChecks({ ...input, insecure: true }), { insecure: true }, 'the override passes and asks for the warning');
  assert.deepEqual(boot.assertBootChecks({ ...input, token: true }), { insecure: false });
  assert.deepEqual(boot.assertBootChecks({ ...input, auth: true }), { insecure: false });
  assert.deepEqual(boot.assertBootChecks({ ...input, loopback: true, stillSeeded: true, orgIds: ['a'] }), { insecure: false });
  assert.throws(() => boot.assertBootChecks({ ...input, auth: true, stillSeeded: true }), refusal(MSG_B('0.0.0.0')));
  assert.throws(() => boot.assertBootChecks({ ...input, auth: true, stillSeeded: true, stillSeededDisabled: null }), refusal(MSG_B('0.0.0.0')));
  assert.throws(() => boot.assertBootChecks({ ...input, auth: true, stillSeeded: true, stillSeededDisabled: ['admin'] }),
    refusal(MSG_B_DISABLED('0.0.0.0', 'admin')), 'every counted row disabled: B names users -- passwd');
  assert.throws(() => boot.assertBootChecks({ ...input, stillSeeded: true, orgIds: ['a', 'b'] }), refusal(MSG_A('0.0.0.0')), 'A before B and C');
  assert.throws(() => boot.assertBootChecks({ ...input, token: true, orgIds: ['a', 'b'] }),
    refusal(/^the store holds 2 orgs \(a, b\) but no identity is configured/), 'a bearer is not identity (step 4 text)');
  assert.doesNotThrow(() => boot.assertBootChecks({ ...input, token: true, orgIds: ['a', 'b'], identity: true }));

  // B from the legacy facts: a seeded record other than the admin a rescue covers still refuses.
  const seededBase = workspace({ users: { users: {
    admin: { password: PW, mustChange: true, seededDefault: true }, temp: { password: PW, mustChange: true, seededDefault: true },
  } } });
  const ctxB = { ...contextFor(seededBase), host: '0.0.0.0', loopback: false, authOff: false, oidc: false, token: false, insecure: false, adminPassword: 'pw' };
  const s = await storeFor(ctxB);
  try {
    const legacyB = readLegacy(s.db, ctxB);
    const decision = boot.seedDecision(boot.legacyView(s.db, ctxB, legacyB));
    assert.equal(decision.kind, 'rescue');
    const plan = planImport(s.db, legacyB, ctxB, projectedMigration({ migrate: false, orgs: legacyB.orgs }));
    assert.throws(() => boot.assertBootChecks(boot.legacyChecksInput(s.db, ctxB, legacyB, decision, plan)), refusal(MSG_B('0.0.0.0')));
    const onlyAdmin = { ...legacyB, users: { ...legacyB.users, entries: legacyB.users.entries.filter(([n]) => n === 'admin') } };
    assert.equal(boot.legacyChecksInput(s.db, ctxB, onlyAdmin, decision, plan).stillSeeded, false, 'the admin the rescue covers is not counted');
  } finally {
    s.close();
  }

  // C from plan1: the empty default artefact is not counted, the migration's default is, a CLI-created org is.
  const cases = [
    [workspace({ orgs: { acme: { members: {} }, default: { members: {} } } }), null, ['acme']],
    [workspace({ orgs: { solo: { members: {} } }, files: { 'packs/p.yaml': PACK } }), MSG_C3(2, 'solo, default'), ['solo', 'default']],
    [workspace({ orgs: { acme: { members: {} } } }), MSG_C3(2, 'default, acme'), ['default', 'acme'], true],
  ];
  for (const [base, msg, ids, cliInit] of cases) {
    const ctx = { ...contextFor(base), host: '127.0.0.1', loopback: true, authOff: false, oidc: false, token: true, insecure: false, adminPassword: null };
    const { db, close } = await storeFor(ctx);
    try {
      if (cliInit) identity.ensureDefaultOrg(db, 'cli');
      const legacy1 = readLegacy(db, ctx);
      const migrate = legacy1.orgs.exists && !boot.keepsDefaultAtRoot(db);
      const flat = migrate ? planFlatMigration({ base }) : null;
      const plan1 = planImport(db, legacy1, ctx, projectedMigration({ flat, migrate, orgs: legacy1.orgs }));
      const decision = boot.seedDecision(boot.legacyView(db, ctx, legacy1));
      const checks = boot.legacyChecksInput(db, ctx, legacy1, decision, plan1);
      assert.deepEqual(checks.orgIds, ids);
      if (msg) assert.throws(() => boot.assertBootChecks(checks), (e) => refusal(msg)(e) && e.nothingMoved === true);
      else assert.doesNotThrow(() => boot.assertBootChecks(checks));
    } finally {
      close();
    }
  }
});

test('bootContext: a malformed issuer, join role or bootstrap admin refuses before any file is created; a bootstrap admin without OIDC only warns', async () => {
  for (const env of [
    { OBSERVOGRAM_OIDC_ISSUER: 'ftp://idp.example' },
    { OBSERVOGRAM_OIDC_ISSUER: 'https://user:pw@idp.example' },
    { OBSERVOGRAM_OIDC_JOIN_ROLE: 'member' },
    { OBSERVOGRAM_OIDC_ISSUER: ISSUER, OBSERVOGRAM_BOOTSTRAP_ADMIN: 'not an email' },
  ]) {
    const base = workspace({ users: { users: { alice: { password: PW } } } });
    const name = Object.keys(env).at(-1);
    await assert.rejects(bootIn(base, env), (e) => refusal(new RegExp(`^refusing to start: ${name} .*Nothing was written\\.$`))(e) && e.nothingMoved === true, JSON.stringify(env));
    assert.equal(existsSync(dbOf(base)), false, 'no database file was created');
  }
  const base = workspace();
  const r = await bootIn(base, { OBSERVOGRAM_BOOTSTRAP_ADMIN: 'boss@example.test' });
  try {
    assert.ok(r.warns.includes('[store] OBSERVOGRAM_BOOTSTRAP_ADMIN applies only with OIDC (OBSERVOGRAM_OIDC_ISSUER is not set) — ignored'), r.warns.join('\n'));
    assert.equal(r.ctx.bootstrap, null);
  } finally {
    closeBase(base);
  }
});

test('bootStore on a fresh workspace, loopback: imports (default at "."), writes the marker, seeds admin/admin owner and admin of default; a second boot changes nothing', async () => {
  const base = workspace();
  const r1 = await bootIn(base);
  try {
    assert.equal(r1.decision.kind, 'seed');
    const db = r1.db;
    assert.deepEqual(rowsOf(db), {
      orgs: [['default', 'Default', '.']],
      users: [{ login: 'admin', kind: 'local', owner: true, disabled: false, epoch: 1, sub: null }],
      memberships: [['default', 'admin', 'admin']],
    });
    const a = users.getUserByLogin(db, 'admin');
    assert.deepEqual([a.mustChange, a.seededDefault], [true, true]);
    assert.ok(verifyPassword('admin', a.password));
    assert.equal(metaOf(db, 'identity_armed'), '1');
    assert.equal(legacy.readMarker(base).storeId, meta.storeId(db));
    assert.equal(legacy.readMarker(base).by, 'import');
    assert.equal(orgRootOf('default', db), '.');
    assert.ok(r1.logs.some((l) => l.startsWith('[store] imported no users file and no orgs.json')), r1.logs.join('\n'));
    assert.ok(r1.logs.includes('[studio] first boot: seeded default sign-in admin / admin — a password change is asked at sign-in (skippable until it lands). OBSERVOGRAM_AUTH=off runs open with no login.'));
    const audit = auditRows(db);
    const r2 = await bootIn(base);
    assert.equal(r2.decision.kind, 'none');
    assert.equal(r2.report, null);
    assert.deepEqual(auditRows(db), audit, 'the second boot writes nothing');
    assert.deepEqual(r2.logs, []);
  } finally {
    closeBase(base);
  }
});

test('bootStore: the rescue never overwrites a real credential — a CLI-created admin kept as a conflict, the env password not applied, a warning, no user.password row', async () => {
  const base = workspace();
  const db0 = await openStore({ path: dbOf(base) });
  admin.addLocalUser(db0, 'cli', { login: 'admin', password: 'a real password' });
  write(join(base, 'users.json'), JSON.stringify({ users: { admin: { password: hashPassword('admin'), mustChange: true, seededDefault: true } } }));
  try {
    const r = await bootIn(base, { OBSERVOGRAM_ADMIN_PASSWORD: 'from the env' });
    assert.equal(r.decision.kind, 'rescue');
    assert.deepEqual(r.report.users.conflicts, [{ login: 'admin', reason: 'kept the existing row' }]);
    const row = users.getUserByLogin(r.db, 'admin');
    assert.ok(verifyPassword('a real password', row.password), 'the real password still verifies');
    assert.ok(!verifyPassword('from the env', row.password), 'the env one does not');
    assert.ok(r.warns.includes("[store] OBSERVOGRAM_ADMIN_PASSWORD not applied: the store's admin is not the seeded default (kept as it is)"), r.warns.join('\n'));
    assert.ok(!auditRows(r.db).some(([action]) => action === 'user.password'));
  } finally {
    closeBase(base);
  }
});

test('bootStore: the rescue replaces a still-seeded admin (imported from users.json) on 0.0.0.0, clears must_change and bumps the epoch', async () => {
  const base = workspace({ users: { users: { admin: { password: hashPassword('admin'), mustChange: true, seededDefault: true } } } });
  try {
    const r = await bootIn(base, { OBSERVOGRAM_ADMIN_PASSWORD: 'from the env' }, { host: '0.0.0.0' });
    assert.equal(r.decision.kind, 'rescue');
    const row = users.getUserByLogin(r.db, 'admin');
    assert.ok(verifyPassword('from the env', row.password));
    assert.deepEqual([row.mustChange, row.seededDefault, row.sessionEpoch], [false, false, 1]);
    assert.ok(r.logs.includes('[studio] replaced the still-default admin password from OBSERVOGRAM_ADMIN_PASSWORD'));
    assert.deepEqual(auditRows(r.db).filter(([a]) => a === 'user.password'), [['user.password', 'system', 'admin']]);
  } finally {
    closeBase(base);
  }
  // The same with a token: no rescue, check B refuses and nothing is imported.
  const tokenBase = workspace({ users: { users: { admin: { password: hashPassword('admin'), mustChange: true, seededDefault: true } } } });
  const before = readFileSync(join(tokenBase, 'users.json'));
  await assert.rejects(bootIn(tokenBase, { OBSERVOGRAM_ADMIN_PASSWORD: 'x', OBSERVOGRAM_API_TOKEN: 't' }, { host: '0.0.0.0' }),
    (e) => refusal(MSG_B('0.0.0.0'))(e) && e.nothingMoved === true);
  try {
    const db = await openStore({ path: dbOf(tokenBase) });
    assert.equal(metaOf(db, 'import_done'), null);
    assert.deepEqual(readFileSync(join(tokenBase, 'users.json')), before);
    assert.equal(existsSync(legacy.markerPath(tokenBase)), false);
  } finally {
    closeBase(tokenBase);
  }
});

test('bootStore: a one-org orgs.json with no token and no identity, on loopback, boots twice to the same posture — seeded at the import boot, nothing at the second (A-56)', async () => {
  const base = workspace({ orgs: { solo: { name: 'Solo', members: {} } } });
  try {
    const r1 = await bootIn(base);
    assert.equal(r1.decision.kind, 'seed');
    assert.deepEqual(rowsOf(r1.db), {
      orgs: [['solo', 'Solo', 'orgs/solo']],
      users: [{ login: 'admin', kind: 'local', owner: true, disabled: false, epoch: 1, sub: null }],
      memberships: [['solo', 'admin', 'admin']],
    });
    assert.equal(metaOf(r1.db, 'identity_armed'), '1');
    const audit = auditRows(r1.db);
    const r2 = await bootIn(base);
    assert.equal(r2.decision.kind, 'none');
    assert.equal(metaOf(r2.db, 'identity_armed'), '1', 'the same posture: stand-alone sign-in armed');
    assert.deepEqual(auditRows(r2.db), audit, 'no second seed');
  } finally {
    closeBase(base);
  }
  // Off loopback with the same env: check A refuses and nothing moves.
  const exposed = workspace({ orgs: { solo: { name: 'Solo', members: {} } }, files: { 'packs/p.yaml': PACK } });
  const orgsBefore = readFileSync(join(exposed, 'orgs.json'));
  await assert.rejects(bootIn(exposed, {}, { host: '0.0.0.0' }), (e) => refusal(MSG_A('0.0.0.0'))(e) && e.nothingMoved === true);
  closeBase(exposed);
  assert.deepEqual(readFileSync(join(exposed, 'orgs.json')), orgsBefore);
  assert.ok(existsSync(join(exposed, 'packs', 'p.yaml')) && !existsSync(join(exposed, 'orgs', 'default')), 'nothing moved');
});

test('bootStore on a CLI-initialised store, then an orgs.json { acme } and flat packs, journeys and deploys.jsonl: nothing moves, orgs.json byte-identical, the skip reported, default still at ".", acme at orgs/acme; C passes on the CLI-armed identity', async () => {
  const base = workspace();
  const db0 = await openStore({ path: dbOf(base) });
  admin.addLocalUser(db0, 'cli', { login: 'alice', password: 'correct horse' });
  write(join(base, 'orgs.json'), JSON.stringify({ acme: { name: 'Acme', members: { alice: 'admin' } } }, null, 2) + '\n');
  write(join(base, 'packs', 'p.yaml'), PACK);
  write(join(base, 'journeys', 'j.journey.yaml'), 'name: j\n');
  write(join(base, 'deploys.jsonl'), '{}\n');
  const orgsBefore = readFileSync(join(base, 'orgs.json'));
  try {
    const r = await bootIn(base, {}, { host: '0.0.0.0' });
    assert.equal(r.report.migration.skipped, 'the store keeps the default org at .');
    assert.deepEqual(r.report.migration.moved, []);
    assert.deepEqual(readFileSync(join(base, 'orgs.json')), orgsBefore);
    for (const rel of ['packs/p.yaml', 'journeys/j.journey.yaml', 'deploys.jsonl']) assert.ok(existsSync(join(base, rel)), rel);
    assert.equal(existsSync(join(base, 'orgs', 'default')), false);
    assert.deepEqual(rowsOf(r.db).orgs, [['default', 'Default', '.'], ['acme', 'Acme', 'orgs/acme']]);
    assert.deepEqual([orgRootOf('default', r.db), orgRootOf('acme', r.db)], ['.', 'orgs/acme']);
    assert.ok(r.logs.includes(`[store]   flat workspace not moved: store ${meta.storeId(r.db)} already keeps the default org at . (initialised by a CLI before this first start)`), r.logs.join('\n'));
    // upgrade-import-report-owners-none-when-kept: the CLI-created owner is named, not "(none)".
    assert.ok(r.logs.includes('[store]   default org default (kept as the store records it); owners: alice (kept)'), r.logs.join('\n'));
  } finally {
    closeBase(base);
  }
});

test('bootStore: the same store whose default-org data a pre-store build already moved into orgs/default refuses (check E) naming both paths, writes and moves nothing; after the entries are moved back the next boot imports; a rollback that moves them again refuses every later boot the same way', async () => {
  const base = workspace();
  const db0 = await openStore({ path: dbOf(base) });
  admin.addLocalUser(db0, 'cli', { login: 'alice', password: 'correct horse' });
  const id = meta.storeId(db0);
  write(join(base, 'orgs.json'), JSON.stringify({ acme: { members: {} }, default: { name: 'Default', members: {} } }, null, 2) + '\n');
  write(join(base, 'orgs', 'default', 'packs', 'p.yaml'), PACK);
  const orgsBefore = readFileSync(join(base, 'orgs.json'));
  const auditBefore = auditRows(db0);
  const moved = join(base, 'orgs', 'default');
  const MSG_E = `refusing to start: store ${id} keeps the default org at ${base} (a CLI initialised it before this first start), `
    + `but ${moved} holds data no org reads — a pre-store build moved the default org's entries there. `
    + `Nothing was moved or imported. With the server stopped, move the entries of ${moved} back into ${base} `
    + '(or move that directory aside if it is not the default org\'s data), then start again.';
  try {
    await assert.rejects(bootIn(base), (e) => refusal(MSG_E)(e) && e.nothingMoved === true);
    assert.deepEqual(auditRows(db0), auditBefore, 'no row');
    assert.equal(metaOf(db0, 'import_done'), null, 'no meta');
    assert.deepEqual(readFileSync(join(base, 'orgs.json')), orgsBefore);
    assert.ok(existsSync(join(moved, 'packs', 'p.yaml')), 'nothing moved');
    renameSync(join(moved, 'packs'), join(base, 'packs'));
    const r = await bootIn(base);
    assert.deepEqual(rowsOf(r.db).orgs, [['default', 'Default', '.'], ['acme', 'acme', 'orgs/acme']]);
    assert.deepEqual(r.report.orgs.conflicts, [{ id: 'default', reason: 'kept the existing org' }]);
    assert.ok(existsSync(join(base, 'packs', 'p.yaml')));
    // A rollback to a pre-store build moves the live default org's data
    // again (orgs.json is unchanged, so no hash check fires): every later
    // boot refuses with the same move-back text, never boots it empty.
    renameSync(join(base, 'packs'), join(moved, 'packs'));
    const MSG_E_LATER = `refusing to start: store ${id} keeps the default org at ${base}, `
      + MSG_E.slice(MSG_E.indexOf('but '));
    await assert.rejects(bootIn(base), (e) => refusal(MSG_E_LATER)(e) && e.nothingMoved === true);
    assert.ok(existsSync(join(moved, 'packs', 'p.yaml')), 'nothing moved');
    renameSync(join(moved, 'packs'), join(base, 'packs'));
    const again = await bootIn(base);
    assert.equal(again.report, null);
    assert.ok(!again.warns.some((w) => /left behind/.test(w)), again.warns.join('\n'));
  } finally {
    closeBase(base);
  }
});

test('bootStore: data in orgs/default with no "default" in orgs.json — a crashed migration or a retired default org — is never planned as an org; the report and every boot name it with the ways out', async () => {
  // A default org an admin retired from orgs.json, its directory kept —
  // the same files as a migration that crashed before its orgs.json write.
  const base = workspace({
    users: { users: { alice: { password: PW } } },
    orgs: { acme: { name: 'Acme', members: { alice: 'admin' } } },
    files: { 'orgs/default/packs/p.pack.yaml': PACK, 'orgs/default/deploys.jsonl': '{"type":"deploy"}\n' },
  });
  const moved = join(base, 'orgs', 'default');
  const text = `${moved} — no org reads it (the store has no org at orgs/default). With the server stopped, ` +
    `move its entries into ${join(base, 'orgs', 'acme')} (the default org acme's root) if they are the default org's data, or move the directory aside`;
  try {
    const r = await bootIn(base);
    assert.deepEqual(r.report.migration.moved, [], 'nothing left to move');
    assert.deepEqual(rowsOf(r.db).orgs, [['acme', 'Acme', 'orgs/acme']], 'the default org is not invented from the directory');
    assert.equal(metaOf(r.db, 'default_org'), 'acme');
    assert.deepEqual([r.report.owners, r.report.noOwner], [['alice'], false], 'alice stays the owner');
    assert.ok(formatReport(r.report).includes(`[store]   left behind: ${text}`), formatReport(r.report).join('\n'));
    assert.ok(r.warns.includes(`[store] left behind: ${text}`), r.warns.join('\n'));
    closeBase(base);
    const again = await bootIn(base);
    assert.equal(again.report, null);
    assert.ok(again.warns.includes(`[store] left behind: ${text}`), 'every boot, not only the import');
  } finally {
    closeBase(base);
  }
  // A store that imported before orgs/default held data.
  const later = workspace({
    users: { users: { alice: { password: PW } } },
    orgs: { acme: { members: { alice: 'admin' } } },
  });
  try {
    await bootIn(later);
    closeBase(later);
    write(join(later, 'orgs', 'default', 'packs', 'p.pack.yaml'), PACK);
    const r = await bootIn(later);
    assert.equal(r.report, null);
    assert.deepEqual(rowsOf(r.db).orgs, [['acme', 'acme', 'orgs/acme']]);
    const dir = join(later, 'orgs', 'default');
    assert.ok(r.warns.includes(`[store] left behind: ${dir} — no org reads it (the store has no org at orgs/default). With the server stopped, ` +
      `move its entries into ${join(later, 'orgs', 'acme')} (the default org acme's root) if they are the default org's data, or move the directory aside`), r.warns.join('\n'));
  } finally {
    closeBase(later);
  }
});

test('staleImportGuard (a): a new store, or a store never imported, beside legacy files a marker names refuses with the 2a text and imports nothing', async () => {
  const base = workspace({ users: { users: { alice: { password: PW } } } });
  const r = await bootIn(base);
  const oldId = meta.storeId(r.db);
  closeBase(base);
  rmSync(dbOf(base));
  const newDb = join(tempDir('other-db'), 'observogram.db');
  for (const [env, dbPath] of [[{}, dbOf(base)], [{ OBSERVOGRAM_DB: newDb }, newDb]]) {
    const refused = await bootIn(base, env).then(() => null, (e) => e);
    const db = await openStore({ path: dbPath });
    try {
      const expected = `refusing to start: the legacy users.json/orgs.json in ${base} were imported into store ${oldId} `
        + `(${join(base, '.store-imported')}), but ${dbPath} holds a new, empty store (${meta.storeId(db)}).\n`
        + 'Nothing was imported. Ways out:\n'
        + '  - point OBSERVOGRAM_DB at that store, or at a copy of its backup;\n'
        + '  - with the server stopped, `packc store restore <backup>`;\n'
        + `  - or, to accept the legacy files as they stand, move ${join(base, '.store-imported')} aside:\n`
        + '    the next start imports them and says so.';
      assert.ok(refusal(expected)(refused), refused?.message);
      assert.equal(metaOf(db, 'import_done'), null);
      assert.deepEqual(rowsOf(db), { orgs: [], users: [], memberships: [] });
    } finally {
      closeStore(dbPath);
    }
  }
  // Moving the marker aside accepts the files: the next boot imports.
  renameSync(legacy.markerPath(base), join(base, 'marker.aside'));
  try {
    const again = await bootIn(base);
    assert.ok(again.report);
    assert.equal(legacy.readMarker(base).storeId, meta.storeId(again.db));
  } finally {
    closeBase(base);
  }
});

test('staleImportGuard (b): a changed issuer refuses with the 2a text; the same issuer re-spelled boots; OIDC unset keeps the record', async () => {
  const base = workspace();
  try {
    const r = await bootIn(base, { OBSERVOGRAM_OIDC_ISSUER: ISSUER });
    assert.equal(metaOf(r.db, 'oidc_issuer'), KEY, 'step 4 records the key');
    assert.deepEqual(auditRows(r.db).filter(([a, , t]) => a === 'meta.set' && t === 'oidc_issuer'), [['meta.set', 'system', 'oidc_issuer']]);
    const id = meta.storeId(r.db);
    const other = 'https://other.example/realms/x';
    const expected = `refusing to start: OBSERVOGRAM_OIDC_ISSUER is ${other} (key ${other}), but store ${id} records its `
      + `OIDC users under ${KEY}. Nothing was changed. If the IdP is the same, set OBSERVOGRAM_OIDC_ISSUER back to `
      + `the value that key was recorded from (a spelling that canonicalises to ${KEY}: its trailing path slash, its well-known suffix).`;
    const audit = auditRows(r.db);
    await assert.rejects(bootIn(base, { OBSERVOGRAM_OIDC_ISSUER: other }), (e) => refusal(expected)(e) && e.nothingMoved === true);
    assert.deepEqual(auditRows(r.db), audit);
    for (const spelling of [`${ISSUER}/`, `${ISSUER}/.well-known/openid-configuration`]) {
      await bootIn(base, { OBSERVOGRAM_OIDC_ISSUER: spelling });
    }
    assert.deepEqual(auditRows(r.db), audit, 'a re-spelled issuer writes nothing');
    const plain = await bootIn(base);
    assert.equal(plain.decision.kind, 'seed', 'booted stand-alone (a fresh stand-alone posture on loopback)');
    assert.equal(metaOf(r.db, 'oidc_issuer'), KEY, 'the record kept');
    assert.equal(auditRows(r.db).filter(([a, , t]) => a === 'meta.set' && t === 'oidc_issuer').length, 1);
  } finally {
    closeBase(base);
  }
});

test('staleImportGuard (d): an edited users.json and an appeared orgs.json refuse with the texts that name import --replace; the file put back passes; (e) a moved-aside file is recorded absent and a missing marker is rewritten', async () => {
  const usersText = JSON.stringify({ users: { alice: { password: PW } } });
  const base = workspace({ users: usersText });
  const usersPath = join(base, 'users.json');
  const markerFile = join(base, '.store-imported');
  try {
    const r = await bootIn(base);
    const id = meta.storeId(r.db);
    const recorded = legacy.sha256Of(Buffer.from(usersText));
    assert.deepEqual(meta.getMetaJson(r.db, 'legacy_hashes'), { 'users.json': { sha256: recorded }, 'orgs.json': { absent: true } });
    const rowsBefore = rowsOf(r.db);
    const auditBefore = auditRows(r.db);

    write(usersPath, JSON.stringify({ users: { alice: { password: PW }, mallory: { password: PW } } }));
    const now = legacy.sha256Of(readFileSync(usersPath));
    const expectedChanged = `refusing to start: ${usersPath} changed since store ${id} last imported it (it was SHA-256 ${recorded}, it is ${now}) — `
      + 'it was edited outside the store (a pre-store build during a rollback, or config management).\n'
      + 'Nothing was changed. The store keeps its own users and orgs; the file is only compared, never read again. With the server stopped:\n'
      + `  - put ${usersPath} back exactly as it was imported (SHA-256 ${recorded}; the store's legacy_hashes and ${markerFile} record it), or\n`
      + `  - move ${usersPath} aside: a file that disappears is recorded as absent and changes no user or org;\n`
      + '    then make the change with `npm run users` / `npm run orgs`;\n'
      + '  - or run `packc store import --replace`: the next start re-imports the files as they stand.';
    await assert.rejects(bootIn(base), (e) => refusal(expectedChanged)(e) && e.nothingMoved === true);
    assert.ok(!/rekey/.test(expectedChanged), 'no command this build lacks');

    write(usersPath, usersText);
    await bootIn(base);

    const orgsPath = write(join(base, 'orgs.json'), '{}\n');
    const expectedAppeared = `refusing to start: ${orgsPath} appeared since store ${id} last imported it (it was absent then).\n`
      + 'Nothing was changed. The store keeps its own users and orgs; the file is only compared, never read again. With the server stopped:\n'
      + `  - move ${orgsPath} aside: a file that disappears is recorded as absent and changes no user or org;\n`
      + '    then make the change with `npm run users` / `npm run orgs`;\n'
      + '  - or run `packc store import --replace`: the next start re-imports the files as they stand.';
    await assert.rejects(bootIn(base), (e) => refusal(expectedAppeared)(e));
    rmSync(orgsPath);

    renameSync(usersPath, join(base, 'users.json.aside'));
    const moved = await bootIn(base);
    assert.ok(moved.logs.includes('[store] users.json disappeared since the import; recorded as absent'), moved.logs.join('\n'));
    assert.deepEqual(meta.getMetaJson(r.db, 'legacy_hashes'), { 'users.json': { absent: true, importedSha256: recorded }, 'orgs.json': { absent: true } });
    assert.deepEqual(rowsOf(r.db), rowsBefore, 'no user, org or membership row changed');
    assert.deepEqual(auditRows(r.db), auditBefore, 'no audit row');
    assert.deepEqual(legacy.readMarker(base).files, meta.getMetaJson(r.db, 'legacy_hashes'), 'the marker follows the database');
    assert.equal(legacy.readMarker(base).by, 'repair');

    rmSync(markerFile);
    const repaired = await bootIn(base);
    assert.ok(repaired.logs.includes(`[store] rewrote ${markerFile} from store ${id}`), repaired.logs.join('\n'));
    assert.deepEqual([legacy.readMarker(base).storeId, legacy.readMarker(base).by], [id, 'repair']);
    write(markerFile, '{ nope');
    await assert.rejects(bootIn(base), (e) => e instanceof legacy.LegacyFileError && e.path === markerFile
      && !/the upgrade imports nothing/.test(e.message) && /delete it and the next start rewrites it from the store/.test(e.message),
    'a corrupt marker refuses naming it and the way out, not as an upgrade problem');
    rmSync(markerFile);
    const again = await bootIn(base);
    assert.ok(again.logs.includes(`[store] rewrote ${markerFile} from store ${id}`), 'the way the refusal names works');
  } finally {
    closeBase(base);
  }
});

test('staleImportGuard (d)/(e): a moved-aside file keeps its imported hash — put back byte for byte it passes and is recorded present again; a different file refuses saying so', async () => {
  const usersText = JSON.stringify({ users: { alice: { password: PW } } });
  const base = workspace({ users: usersText });
  const usersPath = join(base, 'users.json');
  const markerFile = join(base, '.store-imported');
  try {
    const r = await bootIn(base);
    const id = meta.storeId(r.db);
    const recorded = legacy.sha256Of(Buffer.from(usersText));
    const rowsBefore = rowsOf(r.db);
    const auditBefore = auditRows(r.db);

    renameSync(usersPath, join(base, 'users.json.aside'));
    await bootIn(base);
    assert.deepEqual(meta.getMetaJson(r.db, 'legacy_hashes'), { 'users.json': { absent: true, importedSha256: recorded }, 'orgs.json': { absent: true } });
    const still = await bootIn(base);
    assert.ok(!still.logs.some((l) => /disappeared/.test(l)), 'an absent file is recorded once, not every start');

    write(usersPath, JSON.stringify({ users: { alice: { password: PW }, mallory: { password: PW } } }));
    const now = legacy.sha256Of(readFileSync(usersPath));
    const expected = `refusing to start: ${usersPath} came back since store ${id} recorded it absent, but not as it was imported `
      + `(it was SHA-256 ${recorded} at the import, it is ${now}).\n`
      + 'Nothing was changed. The store keeps its own users and orgs; the file is only compared, never read again. With the server stopped:\n'
      + `  - put ${usersPath} back exactly as it was imported (SHA-256 ${recorded}; the store's legacy_hashes and ${markerFile} record it), or\n`
      + `  - move ${usersPath} aside: a file that disappears is recorded as absent and changes no user or org;\n`
      + '    then make the change with `npm run users` / `npm run orgs`;\n'
      + '  - or run `packc store import --replace`: the next start re-imports the files as they stand.';
    await assert.rejects(bootIn(base), (e) => refusal(expected)(e) && e.nothingMoved === true);

    write(usersPath, usersText);
    const back = await bootIn(base);
    assert.ok(back.logs.includes('[store] users.json is back as it was imported; recorded as present'), back.logs.join('\n'));
    assert.deepEqual(meta.getMetaJson(r.db, 'legacy_hashes'), { 'users.json': { sha256: recorded }, 'orgs.json': { absent: true } });
    assert.deepEqual(legacy.readMarker(base).files, meta.getMetaJson(r.db, 'legacy_hashes'), 'the marker follows the database');
    assert.deepEqual(rowsOf(r.db), rowsBefore, 'no user, org or membership row changed');
    assert.deepEqual(auditRows(r.db), auditBefore, 'no audit row');
    const quiet = await bootIn(base);
    assert.ok(!quiet.logs.some((l) => /is back|disappeared/.test(l)), quiet.logs.join('\n'));
  } finally {
    closeBase(base);
  }
});

test('bootStore with OBSERVOGRAM_DB=:memory: warns, writes no marker, and a restart in a fresh process would import again', async () => {
  const base = workspace({ users: { users: { alice: { password: PW } } } });
  try {
    const r = await bootIn(base, { OBSERVOGRAM_DB: ':memory:' });
    assert.ok(r.warns.includes('[store] OBSERVOGRAM_DB=:memory: — nothing persists: every restart imports again and seeds admin/admin again'));
    assert.ok(r.report);
    assert.equal(existsSync(legacy.markerPath(base)), false);
    assert.equal(existsSync(dbOf(base)), false);
  } finally {
    closeStore(':memory:');
  }
});

// The workspace as bytes: every path under it, a directory as 'dir', a
// file as its contents.
function treeOf(dir, rel = '') {
  const out = {};
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    if (lstatSync(join(dir, r)).isDirectory()) Object.assign(out, { [r]: 'dir' }, treeOf(dir, r));
    else out[r] = readFileSync(join(dir, r)).toString('base64');
  }
  return out;
}

test('upgrade-memory-boot-moves-file-store-data: an OBSERVOGRAM_DB=:memory: boot over orgs.json and flat data never writes the workspace', async () => {
  for (const orgs of [{ acme: { members: { alice: 'admin' } } }, { acme: { members: {} }, default: { members: { alice: 'admin' } } }]) {
    const base = workspace({
      users: { users: { alice: { password: PW } } }, orgs,
      files: { 'packs/p.yaml': PACK, 'deploys.jsonl': '{"id":"d1"}\n', 'runs/r1.json': '{}\n' },
    });
    const before = treeOf(base);
    try {
      const r = await bootIn(base, { OBSERVOGRAM_DB: ':memory:' });
      assert.deepEqual(treeOf(base), before, 'the workspace tree is byte-identical after a :memory: boot');
      assert.ok(!r.logs.some((l) => l.startsWith('[tenancy]')), r.logs.join('\n'));
      assert.ok(r.logs.some((l) => l.startsWith('[store]   flat workspace not moved (OBSERVOGRAM_DB=:memory: writes nothing to the workspace')), r.logs.join('\n'));
    } finally {
      closeStore(':memory:');
    }
  }
});

test('the every-boot warnings on a boot that does not import: no owner, left behind, an ignored join role; the zero-owner warning only in the identity postures', async () => {
  const noAdmin = workspace({ users: { users: { bob: { password: PW } } }, orgs: { acme: { members: { bob: 'operator' } } } });
  try {
    await bootIn(noAdmin);
    const r = await bootIn(noAdmin);
    assert.ok(r.warns.includes('[store] no owner — run `npm run users -- owner <login>` (or `npm run users -- add <name>`: the first local user becomes the owner)'), r.warns.join('\n'));
  } finally {
    closeBase(noAdmin);
  }
  const twin = workspace({ users: { users: { alice: { password: PW } } }, orgs: { default: { members: { alice: 'admin' } } }, files: { 'packs/p.yaml': PACK, 'orgs/default/packs/q.yaml': PACK } });
  try {
    await bootIn(twin);
    const r = await bootIn(twin);
    assert.ok(r.warns.includes(`[store] left behind: ${join(twin, 'packs')} — nothing reads it (the default org's copy is orgs/default/packs); merge it by hand`), r.warns.join('\n'));
  } finally {
    closeBase(twin);
  }
  const oidcBase = workspace();
  try {
    const r1 = await bootIn(oidcBase, { OBSERVOGRAM_OIDC_ISSUER: ISSUER, OBSERVOGRAM_OIDC_JOIN_ROLE: 'viewer' });
    assert.equal(metaOf(r1.db, 'oidc_join_role'), 'viewer');
    assert.ok(r1.warns.includes(`[store] no owner who can sign in with OIDC — set OBSERVOGRAM_BOOTSTRAP_ADMIN=${KEY}#<sub> (or a verified email) and sign in, or run \`npm run users -- owner ${KEY}#<sub>\``), r1.warns.join('\n'));
    assert.ok(!r1.warns.some((w) => /JOIN_ROLE/.test(w)), 'the import boot reads it');
    const r2 = await bootIn(oidcBase, { OBSERVOGRAM_OIDC_ISSUER: ISSUER, OBSERVOGRAM_OIDC_JOIN_ROLE: 'admin' });
    assert.ok(r2.warns.includes('[store] OBSERVOGRAM_OIDC_JOIN_ROLE is read at the first start only; the store records viewer'), r2.warns.join('\n'));
    assert.equal(metaOf(r2.db, 'oidc_join_role'), 'viewer');
  } finally {
    closeBase(oidcBase);
  }
  const open = workspace({ orgs: { acme: { members: {} } } });
  try {
    const r = await bootIn(open, { OBSERVOGRAM_AUTH: 'off' });
    assert.ok(!r.warns.some((w) => /no owner/.test(w)), 'the open posture prints no zero-owner warning');
  } finally {
    closeBase(open);
  }
});

test('the import report\'s no-owner line is not logged: open, token-only and OIDC import boots print at most warnNoOwner\'s line (A-49)', async () => {
  const noOwnerLines = (r) => [...r.logs, ...r.warns].filter((l) => /no owner/.test(l));
  const open = workspace();
  try {
    const r = await bootIn(open, { OBSERVOGRAM_INSECURE_NO_AUTH: '1' }, { host: '0.0.0.0' });
    assert.deepEqual(noOwnerLines(r), [], 'an open import boot prints no no-owner line');
  } finally {
    closeBase(open);
  }
  const tokenOnly = workspace({ orgs: { acme: { members: {} } } });
  try {
    const r = await bootIn(tokenOnly, { OBSERVOGRAM_API_TOKEN: 'secret' });
    assert.deepEqual(noOwnerLines(r), [], 'a token-only import boot prints no no-owner line');
  } finally {
    closeBase(tokenOnly);
  }
  const oidc = workspace();
  try {
    const r = await bootIn(oidc, { OBSERVOGRAM_OIDC_ISSUER: ISSUER });
    assert.deepEqual(noOwnerLines(r), [`[store] no owner who can sign in with OIDC — set OBSERVOGRAM_BOOTSTRAP_ADMIN=${KEY}#<sub> (or a verified email) and sign in, or run \`npm run users -- owner ${KEY}#<sub>\``],
      'an OIDC import boot prints the OIDC line once, not the report line too');
  } finally {
    closeBase(oidc);
  }
});

test('orgRootOf: the store\'s root, cached per handle; an unknown org throws; resetOrgRootCache', async () => {
  const flat = workspace({ users: { users: { alice: { password: PW } } } });
  const armed = workspace({ users: { users: { alice: { password: PW } } }, orgs: { default: { members: { alice: 'admin' } } }, files: { 'packs/p.yaml': PACK } });
  try {
    const a = await bootIn(flat);
    const b = await bootIn(armed);
    assert.equal(orgRootOf('default', a.db), '.');
    assert.equal(orgRootOf('default', b.db), 'orgs/default', 'keyed by handle: another store, another root');
    assert.equal(orgRootOf('default', a.db), '.');
    assert.throws(() => orgRootOf('nope', a.db), /^Error: tenancy: unknown org "nope"$/);
    assert.throws(() => orgRootOf(undefined, a.db), /unknown org/);
    resetOrgRootCache();
    assert.equal(orgRootOf('default', b.db), 'orgs/default');
  } finally {
    closeBase(flat);
    closeBase(armed);
  }
});
