#!/usr/bin/env node
/**
 * server/test-store-ops.mjs — the `packc store` offline operations
 * (docs/STORE_PLAN.md §4 "packc store export" and "packc store import
 * --replace", §8 gates Export and Stale import).
 *
 * Every workspace is upgraded the way a deployment is: legacy files and
 * flat data on disk, one bootStore() (the import), then changes through the
 * management rules (server/identity-admin.mjs), then the store closed —
 * the server stopped — and exported. What a pre-store build then does with
 * the result is asked of server/fixtures/pre-store-build.mjs, a frozen copy
 * of v0.4.0's file semantics; tools/test-store-prestore-live.mjs asks the
 * real v0.4.0 build over HTTP (CI job store-prestore). The Stale import
 * cases then edit the files as a pre-store build does during a downgrade,
 * and start the store build again: it refuses, and after `packc store
 * import --replace` the next start re-imports them. `packc store
 * rekey-issuer` (--to, --clear) closes the OIDC upgrade gate's IdP moves;
 * `packc store purge-org` deletes a removed org's files, and `packc store
 * restore` warns when the workspace's marker names another store.
 *
 * Hermetic (§0): the store and identity variables of a developer shell are
 * deleted before any server code loads; each fixture has its own temp
 * workspace and store; the CLI child gets an explicit env.
 */

const STRIP = [
  'DB', 'BOOTSTRAP_ADMIN', 'OIDC_JOIN_ROLE', 'ADMIN_PASSWORD', 'INSECURE_NO_AUTH', 'WORKSPACE', 'USERS_FILE',
  'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'SESSION_SECRET', 'API_TOKEN', 'AUTH',
];
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { spawnSync } = await import('node:child_process');
const { createHmac } = await import('node:crypto');
const { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const { closeStore, openStore, tx } = await import('./store/db.mjs');
const identity = await import('./store/identity.mjs');
const memberships = await import('./store/memberships.mjs');
const meta = await import('./store/meta.mjs');
const { getOrg, listOrgs } = await import('./store/orgs.mjs');
const { getUserByLogin, listUsers } = await import('./store/users.mjs');
const { listAudit } = await import('./store/audit.mjs');
const legacy = await import('./store/legacy-files.mjs');
const {
  exportStore, formatExport, formatPurge, formatRekey, COOKIE_NOTE, purgeOrg, rekeyIssuer, REPLACE_REQUESTED, requestReplace, restoreMarkerWarning,
} = await import('./store/ops.mjs');
const { backupStore, restoreStore } = await import('./store/backup.mjs');
const admin = await import('./identity-admin.mjs');
const { hashPassword, resolveSession, verifyPassword } = await import('./auth.mjs');
const boot = await import('./boot.mjs');
const pre = await import('./fixtures/pre-store-build.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKC = join(HERE, '..', 'tools', 'cli.mjs');

const tmpDirs = [];
function tempDir(tag = 'ops') {
  const d = mkdtempSync(join(tmpdir(), `observogram-${tag}-`));
  tmpDirs.push(d);
  return d;
}
process.on('exit', () => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const dbOf = (base) => join(base, 'observogram.db');
const silent = { write() {} };
const slashed = (p) => p.replaceAll('\\', '/');

// ---------- fixtures ----------

const PW = { alice: 'alice-passw0rd', bob: 'bob-passw0rd', carol: 'carol-passw0rd' };
const HASHED = Object.fromEntries(Object.entries(PW).map(([k, v]) => [k, hashPassword(v)]));
const record = (login) => ({ name: login[0].toUpperCase() + login.slice(1), createdAt: '2026-01-01T00:00:00.000Z', password: HASHED[login] });

function usersJson(base, logins, path = join(base, 'users.json')) {
  legacy.writeUsersFile({ users: Object.fromEntries(logins.map((l) => [l, record(l)])) }, path);
}
function pack(root, id) {
  mkdirSync(join(root, 'packs'), { recursive: true });
  writeFileSync(join(root, 'packs', `${id}.pack.yaml`), `name: ${id}\n`);
}
// A journey as /api/journeys/capture writes it: absolute, forward slashes.
function journey(root, name, packFile) {
  mkdirSync(join(root, 'journeys'), { recursive: true });
  writeFileSync(join(root, 'journeys', `${name}.journey.yaml`),
    `# Captured from a studio session.\npackA:\n  file: ${slashed(packFile)}\npackB:\n  file: ${slashed(packFile)}\ngate:\n  minAlignmentPct: 85\n`);
}

// The server's start: one bootStore() with this env, then stopped.
const CLEAR = Object.fromEntries(STRIP.flatMap((k) => [[`OBSERVOGRAM_${k}`, undefined], [`TOMOGRAPH_${k}`, undefined]]));
async function start(base, env = {}) {
  const warns = [];
  const logs = [];
  try {
    await withEnv({ ...CLEAR, OBSERVOGRAM_WORKSPACE: base, ...env },
      () => boot.bootStore({ host: '127.0.0.1', log: (m) => logs.push(m), warn: (m) => warns.push(m) }));
  } finally {
    closeStore(env.OBSERVOGRAM_DB ?? dbOf(base));
  }
  return { warns, logs };
}

// A start that must refuse: the BootRefusal.
async function refused(base, env = {}) {
  try {
    await start(base, env);
  } catch (e) {
    assert.ok(e instanceof boot.BootRefusal, e.stack);
    return e;
  }
  assert.fail('the start did not refuse');
}

// Changes made while the server is stopped (as a CLI would).
async function change(base, fn) {
  const db = await openStore({ path: dbOf(base) });
  try { return fn(db); } finally { closeStore(dbOf(base)); }
}

async function read(base, fn) { return change(base, fn); }

const exportIt = (base, dir = base) => exportStore(dir, { dbPath: dbOf(base), base, out: silent });
const actions = (db) => listAudit(db, { limit: 1000 }).reverse().map((r) => `${r.action}:${r.actor}:${r.targetId}`);

// ---------- the Export gate ----------

test('Export gate: a flat deployment — no orgs.json; the same enabled users sign in, the same packs and journeys', async () => {
  const base = tempDir();
  usersJson(base, ['alice', 'bob', 'carol']);
  pack(base, 'p1');
  pack(base, 'p2');
  journey(base, 'nightly', join(base, 'packs', 'p1.pack.yaml'));
  await start(base);
  const before = await change(base, (db) => {
    admin.setLocalPassword(db, 'cli', 'bob', 'bob-new-passw0rd');
    admin.disableUser(db, 'cli', 'carol');
    admin.addLocalUser(db, 'cli', { login: 'dave', password: 'dave-passw0rd', role: 'operator' });
    return actions(db).length;
  });
  const journeyBefore = readFileSync(join(base, 'journeys', 'nightly.journey.yaml'), 'utf8');

  const r = await exportIt(base);
  assert.equal(r.inPlace, true);
  assert.equal(r.orgs.path, null, 'a flat deployment exports no orgs.json');
  assert.equal(existsSync(join(base, 'orgs.json')), false);
  assert.equal(r.users.path, join(base, 'users.json'));
  assert.deepEqual(r.users.logins.sort(), ['alice', 'bob', 'dave']);
  assert.deepEqual(r.move, []);
  assert.deepEqual(r.writeAccess, [{ org: 'default', key: 'dave', role: 'operator' }]);
  const lines = formatExport(r);
  assert.ok(lines.includes(`note: ${COOKIE_NOTE}`), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('default/dave (operator)')), lines.join('\n'));
  assert.ok(lines.some((l) => l === 'orgs.json: not written (one org at the workspace root, and the deployment never had one)'));

  // The pre-store build.
  pre.boot(base);
  assert.deepEqual(pre.signIn(base, 'alice', PW.alice), { sub: 'alice', mustChange: false });
  assert.equal(pre.signIn(base, 'bob', PW.bob), null, "bob's old password no longer signs in");
  assert.deepEqual(pre.signIn(base, 'bob', 'bob-new-passw0rd'), { sub: 'bob', mustChange: false });
  assert.equal(pre.signIn(base, 'carol', PW.carol), null, 'a disabled user does not sign in');
  assert.deepEqual(pre.signIn(base, 'dave', 'dave-passw0rd'), { sub: 'dave', mustChange: false });
  assert.equal(pre.tenancyEnabled(base), false);
  assert.deepEqual(pre.packIds(base), ['p1', 'p2']);
  assert.deepEqual(pre.journeys(base), { nightly: { packA: slashed(join(base, 'packs', 'p1.pack.yaml')), packB: slashed(join(base, 'packs', 'p1.pack.yaml')) } });
  assert.equal(readFileSync(join(base, 'journeys', 'nightly.journey.yaml'), 'utf8'), journeyBefore, 'nothing moved, nothing rewritten');

  // The store recorded its own export: one store.export row, the hashes, the marker.
  await read(base, (db) => {
    const rows = actions(db);
    assert.deepEqual(rows.slice(before), [`store.export:cli:${meta.storeId(db)}`]);
    const hashes = meta.getMetaJson(db, 'legacy_hashes');
    assert.deepEqual(hashes['users.json'], legacy.sha256File(join(base, 'users.json')));
    assert.deepEqual(hashes['orgs.json'], { absent: true });
    const marker = legacy.readMarker(base);
    assert.equal(marker.by, 'export');
    assert.equal(marker.storeId, meta.storeId(db));
    assert.deepEqual(marker.files, hashes);
    assert.equal(getOrg(db, 'default').root, '.');
  });
  // …so a store build starts on its own export (and on what the pre-store boot left).
  await start(base);
});

test('Export gate: a flat default org plus a created org — orgs.json, the default org moved, its packs and journeys found', async () => {
  const base = tempDir();
  usersJson(base, ['alice', 'bob']);
  pack(base, 'p1');
  journey(base, 'nightly', join(base, 'packs', 'p1.pack.yaml'));
  mkdirSync(join(base, 'snapshots', 'd1'), { recursive: true });
  writeFileSync(join(base, 'snapshots', 'd1', 'meta.json'), '{}');
  await start(base);
  const before = await change(base, (db) => {
    admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'bob', base });
    admin.addLocalUser(db, 'cli', { login: 'erin', password: 'erin-passw0rd', role: 'viewer', orgId: 'acme' });
    return actions(db).length;
  });
  pack(join(base, 'orgs', 'acme'), 'a1');

  const r = await exportIt(base);
  assert.deepEqual(r.orgs.ids, ['default', 'acme']);
  assert.deepEqual(r.move, ['packs', 'snapshots', 'journeys']);
  assert.deepEqual(r.journeys.map((j) => j.name), ['nightly.journey.yaml']);
  assert.equal(r.cronJob, `OBSERVOGRAM_WORKSPACE=${join(base, 'orgs', 'default')}`);
  const orgs = JSON.parse(readFileSync(join(base, 'orgs.json'), 'utf8'));
  assert.deepEqual(orgs, {
    default: { name: 'Default', members: { alice: 'admin', bob: 'admin' } },
    acme: { name: 'Acme', members: { bob: 'admin', erin: 'viewer' } },
  });
  assert.deepEqual(r.writeAccess, [{ org: 'acme', key: 'erin', role: 'viewer' }]);
  await read(base, (db) => assert.deepEqual(listUsers(db).filter((u) => u.isOwner).map((u) => u.login).sort(), ['alice', 'bob']));
  assert.deepEqual(r.ownerLoss, [{ org: 'acme', key: 'alice' }], 'the owner alice is no member of acme (the owner bob is)');
  for (const e of ['packs', 'snapshots', 'journeys']) assert.equal(existsSync(join(base, e)), false, `${e} moved`);
  const moved = slashed(join(base, 'orgs', 'default', 'packs', 'p1.pack.yaml'));
  const lines = formatExport(r);
  assert.ok(lines.includes(`the default org's root is now orgs/default — point its CronJobs at ${r.cronJob}`), lines.join('\n'));
  assert.ok(lines.includes('no access on a pre-store build (it has no owners; an owner enters only the orgs it is a member of): acme/alice (owner)'), lines.join('\n'));

  // The pre-store build: its migration finds nothing to move.
  assert.deepEqual(pre.boot(base), { migrated: [] });
  assert.deepEqual(pre.orgsForUser(base, 'bob').map((o) => o.id), ['default', 'acme']);
  assert.deepEqual(pre.orgsForUser(base, 'erin'), [{ id: 'acme', name: 'Acme', role: 'viewer' }]);
  assert.deepEqual(pre.orgsForUser(base, 'alice').map((o) => o.id), ['default'], 'the owner keeps only its memberships');
  assert.deepEqual(pre.packIds(base, 'default'), ['p1']);
  assert.deepEqual(pre.journeys(base, 'default'), { nightly: { packA: moved, packB: moved } });
  assert.ok(existsSync(moved), 'the rewritten journey path exists');
  assert.deepEqual(pre.packIds(base, 'acme'), ['a1']);
  assert.deepEqual(pre.signIn(base, 'erin', 'erin-passw0rd'), { sub: 'erin', mustChange: false });

  await read(base, (db) => {
    assert.equal(getOrg(db, 'default').root, 'orgs/default');
    assert.deepEqual(actions(db).slice(before), ['org.root:cli:default', `store.export:cli:${meta.storeId(db)}`]);
    const [rootRow] = listAudit(db, { action: 'org.root' });
    assert.equal(rootRow.orgId, 'default');
    assert.deepEqual(rootRow.detail, { from: '.', to: 'orgs/default' });
    assert.deepEqual(meta.getMetaJson(db, 'legacy_hashes')['orgs.json'], legacy.sha256File(join(base, 'orgs.json')));
  });
  // A store build starts on it: nothing left behind (the pre-store boot's empty <base>/packs holds no data).
  const { warns } = await start(base);
  assert.deepEqual(warns.filter((w) => /left behind/.test(w)), []);
});

test('Rollback backed out by restoring the pre-export backup: the refusal says the files are the export\'s, claims no marker record it lacks, and names the database the export wrote, which starts with the default org\'s data found', async () => {
  const base = tempDir();
  usersJson(base, ['alice', 'bob']);
  pack(base, 'p1');
  await start(base);
  await change(base, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'bob', base }));
  const backup = join(tempDir(), 'before-rollback.db');
  await backupStore(backup, { dbPath: dbOf(base) });
  const recorded = await read(base, (db) => meta.getMetaJson(db, 'legacy_hashes')['users.json'].sha256);
  await change(base, (db) => admin.addLocalUser(db, 'cli', { login: 'erin', password: 'erin-passw0rd', role: 'viewer', orgId: 'acme' }));
  const r = await exportIt(base);
  assert.deepEqual(r.move, ['packs']);

  const restored = await restoreStore(backup, { dbPath: dbOf(base) });
  const aside = restored.movedAside.find((p) => !/-(wal|shm)$/.test(p));
  const e = await refused(base);
  const marker = legacy.markerPath(base);
  assert.ok(e.message.includes(`They are exactly what an export from store ${restored.storeId} wrote (${marker}, written by that export, records them)`), e.message);
  assert.ok(e.message.includes(`\`packc store restore\` the ${dbOf(base)}.pre-restore-… copy`), e.message);
  assert.ok(e.message.includes(`(SHA-256 ${recorded}; the store's legacy_hashes record it), or`), e.message);
  assert.ok(!e.message.includes(`legacy_hashes and ${marker}`), 'the export\'s marker records another hash');
  assert.ok(e.message.includes('moving the files aside starts on the backup\'s default-org root without that data'), e.message);

  // The way out it names first: the database the export wrote starts on these files.
  await restoreStore(aside, { dbPath: dbOf(base) });
  const { warns } = await start(base);
  assert.deepEqual(warns.filter((w) => /left behind/.test(w)), []);
  await read(base, (db) => assert.equal(getOrg(db, 'default').root, 'orgs/default'));
});

test('Export gate: an orgs.json deployment — roles written back as admin/member/viewer, no move', async () => {
  const base = tempDir();
  usersJson(base, ['alice', 'bob', 'carol']);
  legacy.writeOrgsFile({
    default: { name: 'Default', members: { alice: 'admin', bob: 'viewer' } },
    beta: { name: 'Beta', members: { carol: 'member' } },
  }, join(base, 'orgs.json'));
  pack(base, 'p1');
  await start(base);   // the import moves the flat workspace to orgs/default
  await change(base, (db) => admin.disableUser(db, 'cli', 'bob'));

  const r = await exportIt(base);
  assert.deepEqual(r.move, []);
  assert.equal(r.cronJob, null);
  assert.deepEqual(JSON.parse(readFileSync(join(base, 'orgs.json'), 'utf8')), {
    default: { name: 'Default', members: { alice: 'admin' } },
    beta: { name: 'Beta', members: { carol: 'member' } },
  });
  assert.deepEqual(r.writeAccess, [{ org: 'beta', key: 'carol', role: 'operator' }]);
  pre.boot(base);
  assert.deepEqual(pre.packIds(base, 'default'), ['p1']);
  assert.deepEqual(pre.orgsForUser(base, 'bob'), [], 'a disabled user is no member');
  assert.equal(pre.signIn(base, 'bob', PW.bob), null);
  await start(base);
});

test('export to a directory: only reads the store, never overwrites', async () => {
  const base = tempDir();
  usersJson(base, ['alice']);
  pack(base, 'p1');
  await start(base);
  await change(base, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'alice', base }));
  const snapshot = await read(base, (db) => ({ rows: actions(db).length, hashes: meta.getMeta(db, 'legacy_hashes') }));
  const markerBefore = readFileSync(legacy.markerPath(base), 'utf8');
  const dir = join(tempDir('ops-out'), 'export');

  const db = await openStore({ path: dbOf(base) });   // the server may keep running
  try {
    const r = await exportIt(base, dir);
    assert.equal(r.inPlace, false);
    assert.equal(r.users.path, join(dir, 'users.json'));
    assert.equal(r.orgs.path, join(dir, 'orgs.json'));
    assert.deepEqual(r.move, [], 'a directory export moves nothing');
    assert.equal(r.marker, null);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'users.json'), 'utf8')).users), ['alice']);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'orgs.json'), 'utf8'))), ['default', 'acme']);
    assert.equal(actions(db).length, snapshot.rows);
    assert.equal(meta.getMeta(db, 'legacy_hashes'), snapshot.hashes);
    await assert.rejects(exportIt(base, dir), (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && /never overwrites/.test(e.message));
  } finally {
    closeStore(dbOf(base));
  }
  assert.equal(readFileSync(legacy.markerPath(base), 'utf8'), markerBefore);
  assert.ok(existsSync(join(base, 'packs', 'p1.pack.yaml')));
  assert.equal(existsSync(join(base, 'orgs.json')), false);
});

test('export: a workspace named while the shell\'s workspace is elsewhere is refused, not exported to as a directory — nothing written', async () => {
  // An OIDC deployment keeps no users.json, so only the marker and the database tell the workspace apart.
  const base = tempDir();
  usersJson(base, ['alice']);
  pack(base, 'p1');
  await start(base);
  await change(base, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'alice', base }));
  rmSync(join(base, 'users.json'));
  const markerBefore = readFileSync(legacy.markerPath(base), 'utf8');
  const elsewhere = join(tempDir('ops-cwd'), '.observogram');   // OBSERVOGRAM_WORKSPACE unset, another cwd
  const named = (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && e.message.includes(`OBSERVOGRAM_WORKSPACE=${base}`);
  await assert.rejects(exportStore(base, { dbPath: dbOf(base), base: elsewhere, out: silent }), named);
  // The database alone (a store the marker was lost from) tells it too.
  rmSync(legacy.markerPath(base));
  await assert.rejects(exportStore(base, { dbPath: dbOf(base), base: elsewhere, out: silent }), named);
  writeFileSync(legacy.markerPath(base), markerBefore);
  assert.equal(existsSync(join(base, 'orgs.json')), false);
  assert.equal(existsSync(join(base, 'users.json')), false);
  assert.equal(existsSync(elsewhere), false);
  assert.ok(existsSync(join(base, 'packs', 'p1.pack.yaml')), 'nothing moved');
  await read(base, (db) => assert.equal(getOrg(db, 'default').root, '.'));
});

test('export: users.json holds password hashes — a new one is created 0600, an existing one keeps its mode, no .tmp left behind', { skip: process.platform === 'win32' && 'POSIX modes' }, async () => {
  const base = tempDir();
  usersJson(base, ['alice']);
  await start(base);
  await change(base, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'alice', base }));
  const dir = join(tempDir('ops-out'), 'export');
  await exportIt(base, dir);
  const mode = (p) => statSync(p).mode & 0o777;
  assert.equal(mode(join(dir, 'users.json')), 0o600, 'a directory export (a backup) is not world-readable');
  assert.equal(mode(join(dir, 'orgs.json')), 0o600);
  assert.deepEqual(readdirSync(dir).sort(), ['orgs.json', 'users.json'], 'no users.json.tmp left behind');

  // An existing file (a bind mount, an operator's chmod) is rewritten in place: its mode stays.
  const kept = join(tempDir('ops-mode'), 'users.json');
  writeFileSync(kept, '{}');
  chmodSync(kept, 0o640);
  legacy.writeUsersFile({ users: { alice: record('alice') } }, kept);
  assert.equal(mode(kept), 0o640);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(kept, 'utf8')).users), ['alice']);
  assert.equal(existsSync(`${kept}.tmp`), false);
});

test('export: OIDC members are written by their bare sub, only under the recorded issuer; never into users.json', async () => {
  const base = tempDir();
  usersJson(base, ['alice']);
  await start(base);
  await change(base, (db) => {
    admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'alice', base });
    const key = 'https://idp.example/';
    tx(db, () => {
      meta.putMeta(db, 'oidc_issuer', key);
      const u = identity.createOidcUser(db, { issuerKey: key, issuerDisplay: key, sub: 'sub-1', via: 'test' });
      const stale = identity.createOidcUser(db, { issuerKey: 'https://old.example/', issuerDisplay: 'https://old.example/', sub: 'sub-2', via: 'test' });
      memberships.insertMembershipRow(db, { orgId: 'acme', userId: u.id, role: 'operator' });
      memberships.insertMembershipRow(db, { orgId: 'acme', userId: stale.id, role: 'admin' });
    });
  });
  const dir = join(tempDir('ops-out'), 'x');
  const r = await exportIt(base, dir);
  closeStore(dbOf(base));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'orgs.json'), 'utf8')).acme.members, { alice: 'admin', 'sub-1': 'member' });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'users.json'), 'utf8')).users), ['alice']);
  assert.deepEqual(r.writeAccess, [{ org: 'acme', key: 'sub-1', role: 'operator' }]);
});

test('in place: refused while the store is in use, before the server first started, and on a move conflict — nothing changed', async () => {
  const refused = (re) => (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && re.test(e.message);

  const base = tempDir();
  usersJson(base, ['alice']);
  pack(base, 'p1');
  await start(base);
  await change(base, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'alice', base }));
  const usersBefore = readFileSync(join(base, 'users.json'));

  await openStore({ path: dbOf(base) });
  try {
    await assert.rejects(exportIt(base), refused(/is in use — stop the server .* before an in-place export/));
  } finally {
    closeStore(dbOf(base));
  }

  mkdirSync(join(base, 'orgs', 'default', 'packs'), { recursive: true });
  await assert.rejects(exportIt(base), refused(new RegExp(`already holds ${join(base, 'orgs', 'default', 'packs').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — nothing was changed`)));
  assert.ok(existsSync(join(base, 'packs', 'p1.pack.yaml')));
  assert.equal(existsSync(join(base, 'orgs.json')), false);
  assert.deepEqual(readFileSync(join(base, 'users.json')), usersBefore);
  await read(base, (db) => assert.equal(getOrg(db, 'default').root, '.'));

  const fresh = tempDir();
  await openStore({ path: dbOf(fresh) });
  closeStore(dbOf(fresh));
  await assert.rejects(exportIt(fresh), refused(/has never been started by the server/));
  await assert.rejects(exportIt(tempDir()), refused(/no database at/));
  await assert.rejects(exportStore(base, { dbPath: ':memory:', base, out: silent }), refused(/:memory:/));
});

test('in place: a failure after the move puts everything back', async () => {
  const base = tempDir();
  usersJson(base, ['alice']);
  pack(base, 'p1');
  journey(base, 'nightly', join(base, 'packs', 'p1.pack.yaml'));
  await start(base);
  await change(base, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'alice', base }));
  const journeyBefore = readFileSync(join(base, 'journeys', 'nightly.journey.yaml'), 'utf8');
  const rows = await read(base, (db) => actions(db).length);
  // users.json cannot be written (step 4): a directory stands in its place.
  rmSync(join(base, 'users.json'));
  mkdirSync(join(base, 'users.json'));

  await assert.rejects(exportIt(base), (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED'
    && /^the in-place export failed: .*; everything it moved or wrote was put back \(packs, journeys are at /.test(e.message));
  assert.ok(existsSync(join(base, 'packs', 'p1.pack.yaml')));
  assert.equal(readFileSync(join(base, 'journeys', 'nightly.journey.yaml'), 'utf8'), journeyBefore);
  assert.equal(existsSync(join(base, 'orgs', 'default')), false);
  assert.equal(existsSync(join(base, 'orgs.json')), false);
  await read(base, (db) => {
    assert.equal(getOrg(db, 'default').root, '.');
    assert.equal(actions(db).length, rows);
  });
});

test('packc store export: the store line first, the report, exit codes', async () => {
  const base = tempDir();
  usersJson(base, ['alice']);
  await start(base);
  const env = { ...process.env };
  for (const k of STRIP) { delete env[`OBSERVOGRAM_${k}`]; delete env[`TOMOGRAPH_${k}`]; }
  env.OBSERVOGRAM_WORKSPACE = base;
  const run = (...args) => spawnSync(process.execPath, [PACKC, 'store', ...args], { env, encoding: 'utf8', timeout: 60_000 });

  const ok = run('export', base);
  assert.equal(ok.status, 0, ok.stderr);
  const lines = ok.stdout.trim().split('\n');
  assert.equal(lines[0], `store: ${dbOf(base)}`);
  assert.equal(lines[1], `export: in place in ${base} (store ${legacy.readMarker(base).storeId})`);
  assert.ok(lines.includes(`users.json: ${join(base, 'users.json')} (1 enabled local user; OIDC users are never written)`), ok.stdout);
  assert.equal(lines.at(-1), `note: ${COOKIE_NOTE}`);

  const usage = run('export');
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /packc store export <dir>/);
});

// ---------- import --replace (the Stale import gate, 2b) ----------

const SECRET = 'ops-suite-session-secret-0123456789abcdef';
const ISSUER = 'https://idp.example/';
const KEY = identity.canonIssuer(ISSUER);
const requestIt = (base) => requestReplace({ dbPath: dbOf(base), base, out: silent });
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// A signed session cookie: the store build's ({ login, ep, purpose }) or,
// without them, one a pre-store build minted.
function cookie(payload) {
  const body = Buffer.from(JSON.stringify({ iat: Date.now(), exp: Date.now() + 3_600_000, ...payload })).toString('base64url');
  return `observogram_session=v1.${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}
const storeCookie = (login, ep) => cookie({ sub: login, login, ep, purpose: 'session' });
// The login a cookie resolves to on the stopped store build, or null.
async function sessionOf(base, c) {
  return withEnv({ ...CLEAR, OBSERVOGRAM_WORKSPACE: base, OBSERVOGRAM_SESSION_SECRET: SECRET }, async () => {
    const db = await openStore({ path: dbOf(base) });
    try { return resolveSession({ headers: { cookie: c } }, { db })?.login ?? null; } finally { closeStore(dbOf(base)); }
  });
}
const userRows = (db) => listUsers(db).map((u) => ({ login: u.login, kind: u.kind, disabled: u.disabled, owner: u.isOwner, ep: u.sessionEpoch }));
const membersOf = (db, orgId) => memberships.listMembers(db, orgId).map((m) => `${listUsers(db).find((u) => u.id === m.userId).login}:${m.role}`).sort();

test('Stale import: export in place, a pre-store build removes a user and changes a password — the start refuses naming import --replace; after it the removed user is disabled and their cookie refused, the new password works, a viewer stays a viewer; the start after passes', async () => {
  const base = tempDir();
  usersJson(base, ['alice', 'bob', 'carol']);
  pack(base, 'p1');
  await start(base);
  await change(base, (db) => admin.addLocalUser(db, 'cli', { login: 'dave', password: 'dave-passw0rd', role: 'viewer' }));
  await exportIt(base);
  const cookies = await read(base, (db) => Object.fromEntries(['alice', 'bob', 'carol', 'dave'].map((l) => [l, storeCookie(l, getUserByLogin(db, l).sessionEpoch)])));
  for (const l of ['alice', 'bob', 'carol', 'dave']) assert.equal(await sessionOf(base, cookies[l]), l);

  // The pre-store build: a restart, carol removed, bob's password changed, frank added (and signed in).
  pre.boot(base);
  const usersPath = join(base, 'users.json');
  const file = readJson(usersPath);
  delete file.users.carol;
  file.users.bob.password = hashPassword('bob-downgrade-pw');
  file.users.frank = { name: 'Frank', createdAt: '2026-05-01T00:00:00.000Z', password: hashPassword('frank-passw0rd') };
  legacy.writeUsersFile(file, usersPath);
  assert.deepEqual(pre.signIn(base, 'frank', 'frank-passw0rd'), { sub: 'frank', mustChange: false });
  const frankPreStore = cookie({ sub: 'frank', name: 'frank' });

  const e = await refused(base);
  assert.ok(e.message.startsWith(`refusing to start: ${usersPath} changed since store `), e.message);
  assert.ok(e.message.endsWith('  - or run `packc store import --replace`: the next start re-imports the files as they stand.'), e.message);
  const before = await read(base, (db) => ({ rows: actions(db).length, users: userRows(db) }));

  const req = await requestIt(base);
  assert.equal(req.alreadyPending, false);
  const id = await read(base, (db) => {
    assert.equal(meta.getMeta(db, 'replace_requested'), meta.storeId(db));
    assert.deepEqual(actions(db).slice(before.rows), ['meta.set:cli:replace_requested']);
    assert.deepEqual(userRows(db), before.users, 'the request changes no user');
    return meta.storeId(db);
  });
  assert.equal((await requestIt(base)).alreadyPending, true, 'a second request is a no-op');

  const { logs } = await start(base);
  assert.ok(logs.includes(`[store] replaced from ${usersPath} (4 entries) and no orgs.json (orgs and memberships kept) into ${dbOf(base)} (store ${id}; packc store import --replace)`), logs.join('\n'));
  assert.ok(logs.includes('[store]   users: created frank · updated bob (password) · disabled carol (not in the users file)'), logs.join('\n'));
  assert.ok(logs.includes('[store]   memberships: added default/frank (operator)'), logs.join('\n'));
  assert.ok(logs.includes('[store]   sessions ended (changed or disabled): bob, carol'), logs.join('\n'));
  await read(base, (db) => {
    const u = Object.fromEntries(userRows(db).map((r) => [r.login, r]));
    const was = Object.fromEntries(before.users.map((r) => [r.login, r]));
    assert.equal(u.carol.disabled, true);
    assert.equal(u.carol.ep, was.carol.ep + 1);
    assert.equal(u.bob.ep, was.bob.ep + 1);
    assert.ok(verifyPassword('bob-downgrade-pw', getUserByLogin(db, 'bob').password));
    assert.deepEqual([u.alice.ep, u.alice.disabled, u.alice.owner], [was.alice.ep, false, true], 'an unchanged user keeps its sessions');
    assert.deepEqual([u.frank.ep, u.frank.owner, u.frank.disabled], [1, false, false], 'created at epoch 1, never an owner');
    assert.equal(getUserByLogin(db, 'frank').createdAt, '2026-05-01T00:00:00.000Z');
    assert.deepEqual(membersOf(db, 'default'), ['alice:admin', 'bob:admin', 'carol:admin', 'dave:viewer', 'frank:operator']);
    assert.deepEqual(actions(db).slice(before.rows), ['meta.set:cli:replace_requested', `store.replace:system:${id}`]);
    const [row] = listAudit(db, { action: 'store.replace' });
    assert.deepEqual(row.detail, {
      users: { created: 1, updated: 1, disabled: 1, enabled: 0 }, orgs: { created: 0, renamed: 0, removed: 0 },
      memberships: { added: 1, removed: 0, changed: 0 }, sessionsEnded: 2, rootChanged: false, mode: 'local',
    });
    assert.equal(meta.getMeta(db, 'replace_requested'), null);
    const hashes = meta.getMetaJson(db, 'legacy_hashes');
    assert.deepEqual(hashes, { 'users.json': legacy.sha256File(usersPath), 'orgs.json': { absent: true } });
    assert.deepEqual(legacy.readMarker(base).files, hashes);
    assert.equal(legacy.readMarker(base).by, 'replace');
    assert.equal(meta.getMetaJson(db, 'import_report').kind, 'replace');
  });
  assert.equal(await sessionOf(base, cookies.carol), null, "the removed user's cookie is refused");
  assert.equal(await sessionOf(base, cookies.bob), null, 'a changed password ends the sessions');
  assert.equal(await sessionOf(base, cookies.alice), 'alice');
  assert.equal(await sessionOf(base, cookies.dave), 'dave');
  assert.equal(await sessionOf(base, frankPreStore), null, 'a cookie minted during the downgrade window reads as epoch 0');
  assert.equal(await sessionOf(base, storeCookie('frank', 1)), 'frank');

  const rows = await read(base, (db) => actions(db).length);
  const again = await start(base);
  assert.ok(!again.logs.some((l) => /replaced/.test(l)), 'the start after passes the guard and replaces nothing');
  await read(base, (db) => assert.equal(actions(db).length, rows));
});

test('Stale import: with the marker missing (lost after an export, or moved aside as (a) says on an imported store) the refusals name a replace that works — aside, start once, back, request, start', async () => {
  const refusedOp = (re) => (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && re.test(e.message);
  const usersPath = (base) => join(base, 'users.json');
  const downgradeAdds = (base, login) => {
    const file = readJson(usersPath(base));
    file.users[login] = { name: login, createdAt: '2026-05-01T00:00:00.000Z', password: hashPassword(`${login}-passw0rd`) };
    legacy.writeUsersFile(file, usersPath(base));
  };
  // The route the refusals name: aside, one start (the repair rewrites the marker), back, request, start.
  const replaceWithoutMarker = async (base, login) => {
    const e = await refused(base);
    assert.ok(e.message.includes(`${usersPath(base)} changed since store`), e.message);
    assert.ok(e.message.includes("the store's legacy_hashes record it"), 'no claim that the missing marker records it');
    assert.ok(!e.message.includes('  - or run `packc store import --replace`: the next start'), e.message);
    assert.ok(e.message.includes(`\`packc store import --replace\` needs ${legacy.markerPath(base)}, which is missing — move ${usersPath(base)} aside, start once`), e.message);
    await assert.rejects(requestIt(base), refusedOp(/is missing, and a replace is requested only for the store the marker names: with the server stopped, move users\.json\/orgs\.json aside .* start the server once/));
    renameSync(usersPath(base), `${usersPath(base)}.aside`);
    await start(base);
    assert.ok(legacy.readMarker(base), 'the start rewrote the marker');
    renameSync(`${usersPath(base)}.aside`, usersPath(base));
    await requestIt(base);
    const { logs } = await start(base);
    assert.ok(logs.some((l) => l.startsWith(`[store] replaced from ${usersPath(base)}`)), logs.join('\n'));
    await read(base, (db) => assert.equal(getUserByLogin(db, login)?.disabled, false));
  };

  // 1. The marker lost after an export; a pre-store build added dave.
  const base = tempDir();
  usersJson(base, ['alice']);
  await start(base);
  await exportIt(base);
  pre.boot(base);
  downgradeAdds(base, 'dave');
  rmSync(legacy.markerPath(base));
  await replaceWithoutMarker(base, 'dave');

  // 2. Another imported store's database at this workspace: (a) does not
  // promise an import, and its "move the marker aside" leads to (d)'s route.
  const other = tempDir();
  usersJson(other, ['alice']);
  await start(other);
  const ws = tempDir();
  usersJson(ws, ['alice', 'bob']);
  await start(ws);
  copyFileSync(dbOf(other), dbOf(ws));
  const idOther = legacy.readMarker(other).storeId;
  const a = await refused(ws);
  assert.ok(a.message.includes(`move ${legacy.markerPath(ws)} aside: store ${idOther} was imported already, so the next start imports nothing`), a.message);
  assert.ok(!a.message.includes('the next start imports them'), a.message);
  rmSync(legacy.markerPath(ws));
  await replaceWithoutMarker(ws, 'bob');
});

test('Stale import: a second in-place export over files a pre-store build edited refuses naming import --replace and changes nothing; after the replace it exports the edits', async () => {
  const base = tempDir();
  usersJson(base, ['alice', 'bob']);
  pack(base, 'p1');
  await start(base);
  await change(base, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'alice', base }));
  await exportIt(base);
  const usersPath = join(base, 'users.json');
  const orgsPath = join(base, 'orgs.json');

  // The pre-store build: alice's password changed, dave added, dave in acme.
  pre.boot(base);
  const file = readJson(usersPath);
  file.users.alice.password = hashPassword('alice-downgrade-pw');
  file.users.dave = { name: 'Dave', createdAt: '2026-05-01T00:00:00.000Z', password: hashPassword('dave-passw0rd') };
  legacy.writeUsersFile(file, usersPath);
  const orgs = readJson(orgsPath);
  orgs.acme.members.dave = 'member';
  legacy.writeOrgsFile(orgs, orgsPath);
  const edited = { users: readFileSync(usersPath), orgs: readFileSync(orgsPath) };
  const before = await read(base, (db) => ({ rows: actions(db).length, hashes: meta.getMetaJson(db, 'legacy_hashes') }));
  const markerBefore = readFileSync(legacy.markerPath(base));

  await assert.rejects(exportIt(base), (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED'
    && e.message.startsWith(`${usersPath} (it was SHA-256 ${before.hashes['users.json'].sha256}, it is ${legacy.sha256Of(edited.users)}), `
      + `${orgsPath} (it was SHA-256 ${before.hashes['orgs.json'].sha256}, it is ${legacy.sha256Of(edited.orgs)}) differ from what store `)
    && e.message.includes('Nothing was changed. With the server stopped, run `packc store import --replace` and start the server once'));
  assert.deepEqual(readFileSync(usersPath), edited.users, 'the edited users.json is not overwritten');
  assert.deepEqual(readFileSync(orgsPath), edited.orgs, 'the edited orgs.json is not overwritten');
  assert.deepEqual(readFileSync(legacy.markerPath(base)), markerBefore);
  await read(base, (db) => {
    assert.equal(actions(db).length, before.rows);
    assert.deepEqual(meta.getMetaJson(db, 'legacy_hashes'), before.hashes);
  });

  // The way out it names: the replace takes the edits in, then the export writes them back.
  await requestIt(base);
  await start(base);
  const r = await exportIt(base);
  assert.deepEqual(r.users.logins.sort(), ['alice', 'bob', 'dave']);
  assert.deepEqual(pre.signIn(base, 'alice', 'alice-downgrade-pw'), { sub: 'alice', mustChange: false });
  assert.deepEqual(pre.signIn(base, 'dave', 'dave-passw0rd'), { sub: 'dave', mustChange: false });
  assert.equal(readJson(orgsPath).acme.members.dave, 'member');
  // Unedited, a second export passes.
  await exportIt(base);
  await start(base);
});

test('Stale import: a flat single-org store exported, then `orgs create acme` on a pre-store build and a restart — the start refuses; a flat entry with data beside its twin refuses the replace (check D) and moves nothing; then the default org is found at orgs/default and acme exists', async () => {
  const base = tempDir();
  usersJson(base, ['alice', 'bob']);
  pack(base, 'p1');
  journey(base, 'nightly', join(base, 'packs', 'p1.pack.yaml'));
  writeFileSync(join(base, 'deploys.jsonl'), '{"at":"2026-01-01T00:00:00.000Z"}\n');
  await start(base);
  const r = await exportIt(base);
  assert.equal(r.orgs.path, null, 'a flat deployment exports no orgs.json');

  // The pre-store build: npm run orgs -- create acme; add-member acme bob admin; a restart; an upload into acme.
  legacy.writeOrgsFile({ acme: { name: 'Acme', members: { bob: 'admin' } } }, join(base, 'orgs.json'));
  assert.deepEqual(pre.boot(base), { migrated: ['packs', 'deploys.jsonl', 'journeys'] });
  pack(join(base, 'orgs', 'acme'), 'a1');
  assert.deepEqual(pre.packIds(base, 'default'), ['p1']);

  const e = await refused(base);
  assert.ok(e.message.includes(`${join(base, 'orgs.json')} appeared since store`) && e.message.includes('packc store import --replace'), e.message);
  await requestIt(base);

  // Data written at the base beside its orgs/default twin: check D, nothing moved or replaced.
  pack(base, 'stray');
  const before = await read(base, (db) => ({ rows: actions(db).length, users: userRows(db), root: getOrg(db, 'default').root }));
  const d = await refused(base);
  assert.equal(d.nothingMoved, true);
  assert.equal(d.message, `refusing to start: the pending \`packc store import --replace\` moves the default org's root to ${join(base, 'orgs', 'default')} `
    + '(the files\' orgs.json holds "default", which a pre-store build keeps there), but '
    + `${join(base, 'packs')} holds data beside ${join(base, 'orgs', 'default', 'packs')} — neither is moved or merged. `
    + 'Nothing was moved, imported or replaced; the request stays pending.\n'
    + '  With the server stopped, merge the flat entry into its twin by hand (or move one of the two aside), then start again.');
  await read(base, (db) => {
    assert.deepEqual({ rows: actions(db).length, users: userRows(db), root: getOrg(db, 'default').root }, before);
    assert.equal(meta.getMeta(db, 'replace_requested'), meta.storeId(db), 'the request stays pending');
  });
  rmSync(join(base, 'packs', 'stray.pack.yaml'));   // back to the empty <base>/packs every pre-store restart leaves

  const { logs, warns } = await start(base);
  const moved = slashed(join(base, 'orgs', 'default', 'packs', 'p1.pack.yaml'));
  assert.ok(logs.includes(`[store]   the default org's root is now orgs/default — point its CronJobs at OBSERVOGRAM_WORKSPACE=${join(base, 'orgs', 'default')}`), logs.join('\n'));
  assert.ok(logs.includes(`[store]   removed empty leftovers of a pre-store build: ${join(base, 'packs')}`), logs.join('\n'));
  assert.ok(logs.includes('[store]   journey file: paths rewritten: nightly.journey.yaml'), logs.join('\n'));
  assert.ok(logs.includes('[store]   orgs: created acme (orgs/acme)'), logs.join('\n'));
  assert.deepEqual(warns.filter((w) => /left behind/.test(w)), []);
  assert.equal(existsSync(join(base, 'packs')), false, 'the empty leftover is removed');
  assert.deepEqual(pre.journeys(base, 'default'), { nightly: { packA: moved, packB: moved } });
  await read(base, (db) => {
    const id = meta.storeId(db);
    assert.equal(getOrg(db, 'default').root, 'orgs/default');
    assert.deepEqual(listOrgs(db).map((o) => [o.id, o.root]), [['default', 'orgs/default'], ['acme', 'orgs/acme']]);
    for (const f of [join('packs', 'p1.pack.yaml'), 'deploys.jsonl', join('journeys', 'nightly.journey.yaml')]) {
      assert.ok(existsSync(join(base, getOrg(db, 'default').root, f)), `the default org's ${f} is found`);
    }
    assert.ok(existsSync(join(base, getOrg(db, 'acme').root, 'packs', 'a1.pack.yaml')));
    assert.deepEqual(membersOf(db, 'acme'), ['bob:admin']);
    // orgs.json's "default" (the pre-store migration's) has no members: the memberships follow the file.
    assert.deepEqual(membersOf(db, 'default'), []);
    assert.equal(getUserByLogin(db, 'alice').isOwner, true, 'is_owner is never re-derived');
    assert.deepEqual(actions(db).slice(before.rows), ['org.root:system:default', `store.replace:system:${id}`]);
    assert.deepEqual(listAudit(db, { action: 'org.root' })[0].detail, { from: '.', to: 'orgs/default' });
    assert.equal(meta.getMetaJson(db, 'legacy_hashes')['orgs.json'].sha256, legacy.sha256File(join(base, 'orgs.json')).sha256);
  });
  const again = await start(base);
  assert.deepEqual(again.warns.filter((w) => /left behind/.test(w)), []);
});

test('Stale import: orgs.json edited on a pre-store build — orgs renamed, created and soft-removed to match, a removed slug that reappears is skipped, memberships replaced', async () => {
  const base = tempDir();
  usersJson(base, ['alice', 'bob', 'carol']);
  legacy.writeOrgsFile({
    default: { name: 'Default', members: { alice: 'admin' } },
    beta: { name: 'Beta', members: { bob: 'member' } },
    gamma: { name: 'Gamma', members: { carol: 'member' } },
  }, join(base, 'orgs.json'));
  pack(base, 'p1');
  await start(base);
  await change(base, (db) => admin.removeOrgSoft(db, 'cli', 'gamma'));
  await exportIt(base);
  assert.deepEqual(Object.keys(readJson(join(base, 'orgs.json'))), ['default', 'beta']);

  pre.boot(base);
  legacy.writeOrgsFile({
    default: { name: 'Main', members: { alice: 'admin', bob: 'viewer' } },
    gamma: { name: 'Gamma', members: { carol: 'member' } },
    delta: { name: 'Delta', members: { carol: 'admin', ghost: 'member' } },
  }, join(base, 'orgs.json'));
  await refused(base);
  await requestIt(base);
  const before = await read(base, (db) => ({ rows: actions(db).length, users: userRows(db) }));
  const { logs } = await start(base);
  assert.ok(logs.includes("[store]   orgs: created delta (orgs/delta) · renamed default ('Default' → 'Main') · removed beta (not in orgs.json)"), logs.join('\n'));
  assert.ok(logs.includes('[store]   memberships: added default/bob (viewer), delta/carol (admin)'), logs.join('\n'));
  assert.ok(logs.includes('[store]   dropped: member gamma/carol (org skipped) · member delta/ghost (no such user)'), logs.join('\n'));
  assert.ok(logs.includes('[store]   skipped: org gamma (the id was used by a removed org — never reused; skipped)'), logs.join('\n'));
  await read(base, (db) => {
    assert.equal(getOrg(db, 'default').name, 'Main');
    assert.ok(getOrg(db, 'beta').removedAt, 'an org absent from the file is soft-removed');
    assert.ok(getOrg(db, 'gamma').removedAt, 'a removed slug is never reused');
    assert.deepEqual([getOrg(db, 'delta').root, getOrg(db, 'delta').removedAt], ['orgs/delta', null]);
    assert.deepEqual(membersOf(db, 'default'), ['alice:admin', 'bob:viewer']);
    assert.deepEqual(membersOf(db, 'delta'), ['carol:admin']);
    assert.deepEqual(membersOf(db, 'beta'), ['bob:operator'], 'a soft-removed org keeps its rows');
    const was = Object.fromEntries(before.users.map((r) => [r.login, r.ep]));
    assert.deepEqual(userRows(db).map((u) => [u.login, u.ep - was[u.login]]), [['alice', 0], ['bob', 1], ['carol', 1]], 'a membership change ends the sessions');
    assert.deepEqual(actions(db).slice(before.rows), [`store.replace:system:${meta.storeId(db)}`]);
  });
});

test('Stale import: a user disabled in the store keeps their memberships across a replace — the export leaves them out of orgs.json, so the file cannot have removed them', async () => {
  const base = tempDir();
  usersJson(base, ['alice', 'bob', 'carol']);
  legacy.writeOrgsFile({
    default: { name: 'Default', members: { alice: 'admin', bob: 'member', carol: 'member' } },
    acme: { name: 'Acme', members: { alice: 'admin', carol: 'viewer' } },
  }, join(base, 'orgs.json'));
  await start(base);
  await change(base, (db) => admin.disableUser(db, 'cli', 'carol'));
  await exportIt(base);
  const orgsPath = join(base, 'orgs.json');
  assert.deepEqual(Object.values(readJson(orgsPath)).map((o) => Object.keys(o.members)), [['alice', 'bob'], ['alice']], 'disabled users left out');

  pre.boot(base);
  const orgs = readJson(orgsPath);
  orgs.default.members.bob = 'viewer';
  legacy.writeOrgsFile(orgs, orgsPath);
  await refused(base);
  await requestIt(base);
  const { logs } = await start(base);
  assert.ok(logs.includes('[store]   memberships: changed default/bob operator → viewer'), logs.join('\n'));
  await read(base, (db) => {
    assert.deepEqual(membersOf(db, 'default'), ['alice:admin', 'bob:viewer', 'carol:operator']);
    assert.deepEqual(membersOf(db, 'acme'), ['alice:admin', 'carol:viewer']);
    assert.equal(getUserByLogin(db, 'carol').disabled, true);
  });
  assert.ok(logs.includes('[store]   sessions ended (changed or disabled): bob'), logs.join('\n'));
});

test('Stale import: the replace refuses to leave no enabled owner (check D) — nothing changes and the request stays pending; with the owner back in users.json it runs', async () => {
  const base = tempDir();
  usersJson(base, ['alice']);
  await start(base);
  await change(base, (db) => admin.addLocalUser(db, 'cli', { login: 'bob', password: 'bob-passw0rd', role: 'operator' }));
  await exportIt(base);
  const usersPath = join(base, 'users.json');
  const exported = readJson(usersPath);
  const edited = { users: { bob: { ...exported.users.bob, password: hashPassword('bob-new-passw0rd') } } };
  legacy.writeUsersFile(edited, usersPath);
  await refused(base);
  await requestIt(base);
  const before = await read(base, (db) => ({ rows: actions(db).length, users: userRows(db) }));
  const e = await refused(base);
  assert.equal(e.message, `refusing to start: the pending \`packc store import --replace\` would leave store ${legacy.readMarker(base).storeId} `
    + `with no enabled owner who can sign in with a local password (it disables alice: not in ${usersPath}). `
    + 'Nothing was moved, imported or replaced; the request stays pending.\n'
    + `  With the server stopped, put an owner back into ${usersPath}, or make a user the files keep an owner `
    + '(npm run users -- owner <login>), then start again.');
  await read(base, (db) => {
    assert.deepEqual({ rows: actions(db).length, users: userRows(db) }, before);
    assert.equal(meta.getMeta(db, 'replace_requested'), meta.storeId(db));
  });
  legacy.writeUsersFile({ users: { alice: exported.users.alice, ...edited.users } }, usersPath);
  await start(base);
  await read(base, (db) => {
    assert.ok(verifyPassword('bob-new-passw0rd', getUserByLogin(db, 'bob').password));
    assert.equal(getUserByLogin(db, 'alice').disabled, false);
  });
});

test('Stale import: the no-owner refusal names a user only the files hold — add it (with --org) before owner; followed as written, the replace runs', async () => {
  const base = tempDir();
  usersJson(base, ['alice']);
  await start(base);
  await change(base, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'alice', base }));
  await exportIt(base);
  const usersPath = join(base, 'users.json');
  legacy.writeUsersFile({ users: { carol: record('carol') } }, usersPath);
  await refused(base);
  await requestIt(base);
  const e = await refused(base);
  assert.equal(e.message, `refusing to start: the pending \`packc store import --replace\` would leave store ${legacy.readMarker(base).storeId} `
    + `with no enabled owner who can sign in with a local password (it disables alice: not in ${usersPath}). `
    + 'Nothing was moved, imported or replaced; the request stays pending.\n'
    + `  With the server stopped, put an owner back into ${usersPath}, or make a user the files keep an owner `
    + '(npm run users -- owner <login>; carol is not in the store yet: npm run users -- add <login> --org <org> first), then start again.');
  await change(base, (db) => {
    assert.throws(() => admin.grantOwnerByLogin(db, 'cli', 'carol'), /no local user carol/);
    assert.throws(() => admin.addLocalUser(db, 'cli', { login: 'carol', password: 'carol-other-pw', role: 'operator' }), /name one with --org/);
    admin.addLocalUser(db, 'cli', { login: 'carol', password: 'carol-other-pw', role: 'operator', orgId: 'default' });
    admin.grantOwnerByLogin(db, 'cli', 'carol');
  });
  await start(base);
  await read(base, (db) => {
    const carol = getUserByLogin(db, 'carol');
    assert.deepEqual([carol.isOwner, carol.disabled, verifyPassword(PW.carol, carol.password)], [true, false, true]);
    assert.equal(getUserByLogin(db, 'alice').disabled, true);
    assert.equal(meta.getMeta(db, 'replace_requested'), null);
  });
});

test('Stale import: with OBSERVOGRAM_USERS_FILE outside the workspace the replace re-imports the recorded file', async () => {
  const base = tempDir();
  const outside = join(tempDir('ops-users'), 'users.json');
  usersJson(base, ['alice', 'bob'], outside);
  const env = { OBSERVOGRAM_USERS_FILE: outside };
  await start(base, env);
  assert.equal((await exportIt(base)).users.path, outside);
  const file = readJson(outside);
  file.users.bob.password = hashPassword('bob-new-passw0rd');
  legacy.writeUsersFile(file, outside);
  assert.deepEqual(pre.signIn(base, 'bob', 'bob-new-passw0rd', { usersFile: outside }), { sub: 'bob', mustChange: false });
  const e = await refused(base, env);
  assert.ok(e.message.startsWith(`refusing to start: ${outside} changed since store`), e.message);
  await requestIt(base);
  await start(base);   // the recorded users_file is compared and read, whatever this env says
  await read(base, (db) => {
    assert.ok(verifyPassword('bob-new-passw0rd', getUserByLogin(db, 'bob').password));
    assert.deepEqual(meta.getMetaJson(db, 'legacy_hashes')[outside], legacy.sha256File(outside));
  });
  await start(base, env);
});

test('Stale import: a replace requested from a shell with no OIDC env on an OIDC deployment maps members under the unit\'s issuer and disables no OIDC user; after an issuer change it refuses at step 2 and stays pending; after `rekey-issuer --to` it runs under the new key with no duplicate rows', async () => {
  const base = tempDir();
  legacy.writeOrgsFile({
    default: { name: 'Default', members: { 'sub-1': 'admin' } },
    acme: { name: 'Acme', members: { 'sub-2': 'member' } },
  }, join(base, 'orgs.json'));
  pack(base, 'p1');
  const env = { OBSERVOGRAM_OIDC_ISSUER: ISSUER };
  await start(base, env);
  await exportIt(base);
  assert.deepEqual(readJson(join(base, 'orgs.json')), {
    default: { name: 'Default', members: { 'sub-1': 'admin' } }, acme: { name: 'Acme', members: { 'sub-2': 'member' } },
  });
  pre.boot(base);
  legacy.writeOrgsFile({
    default: { name: 'Default', members: { 'sub-1': 'admin' } },
    acme: { name: 'Acme', members: { 'sub-2': 'admin', 'sub-3': 'viewer' } },
  }, join(base, 'orgs.json'));
  await refused(base, env);

  // The request, from a shell without the unit's OIDC env.
  const shell = { ...process.env };
  for (const k of STRIP) { delete shell[`OBSERVOGRAM_${k}`]; delete shell[`TOMOGRAPH_${k}`]; }
  shell.OBSERVOGRAM_WORKSPACE = base;
  const run = (...args) => spawnSync(process.execPath, [PACKC, 'store', ...args], { env: shell, encoding: 'utf8', timeout: 60_000 });
  const ok = run('import', '--replace');
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.stdout.trim().split('\n'), [`store: ${dbOf(base)}`, REPLACE_REQUESTED]);

  // A changed issuer refuses at step 2, before the replace; the request stays pending.
  const before = await read(base, (db) => ({ rows: actions(db).length, users: userRows(db) }));
  const b = await refused(base, { OBSERVOGRAM_OIDC_ISSUER: 'https://other.example/' });
  assert.match(b.message, /^refusing to start: OBSERVOGRAM_OIDC_ISSUER is https:\/\/other\.example\//);
  await read(base, (db) => {
    assert.deepEqual({ rows: actions(db).length, users: userRows(db) }, before);
    assert.equal(meta.getMeta(db, 'replace_requested'), meta.storeId(db));
  });

  // The IdP moved: `rekey-issuer --to` from the same shell; the request stays pending.
  const moved = 'https://other.example/';
  const rk = run('rekey-issuer', '--to', moved);
  assert.equal(rk.status, 0, rk.stderr);
  assert.match(rk.stdout, /a pending `packc store import --replace` stays pending/);
  await read(base, (db) => assert.equal(meta.getMeta(db, 'replace_requested'), meta.storeId(db)));
  const NEW = identity.canonIssuer(moved);
  await start(base, { OBSERVOGRAM_OIDC_ISSUER: moved });
  await read(base, (db) => {
    assert.deepEqual(userRows(db).map((u) => [u.login, u.kind, u.disabled, u.owner]), [
      [`${NEW}#sub-1`, 'oidc', false, true], [`${NEW}#sub-2`, 'oidc', false, false], [`${NEW}#sub-3`, 'oidc', false, false],
    ], 'no row under the old key, no duplicate under the new one');
    assert.equal(getUserByLogin(db, `${NEW}#sub-3`).sessionEpoch, 1);
    assert.deepEqual(membersOf(db, 'acme'), [`${NEW}#sub-2:admin`, `${NEW}#sub-3:viewer`]);
    assert.deepEqual(membersOf(db, 'default'), [`${NEW}#sub-1:admin`]);
    assert.equal(meta.getMeta(db, 'replace_requested'), null);
    assert.equal(meta.getMeta(db, 'oidc_issuer'), NEW);
  });
  await start(base, { OBSERVOGRAM_OIDC_ISSUER: moved });
});

test('Stale import: a flat OIDC round trip keeps every IdP user and the owner enabled; a user a pre-store build adds to the leftover users.json is created disabled', async () => {
  const base = tempDir();
  usersJson(base, ['alice']);   // a leftover under OIDC: imported disabled
  pack(base, 'p1');
  const env = { OBSERVOGRAM_OIDC_ISSUER: ISSUER };
  await start(base, env);
  await change(base, (db) => {
    admin.grantOwnerByLogin(db, 'cli', `${KEY}#sub-1`, { shellIssuerRaw: ISSUER });
    identity.createOidcUser(db, { issuerKey: KEY, issuerDisplay: ISSUER, sub: 'sub-2', via: 'test' });
  });
  const r = await exportIt(base);
  assert.deepEqual([r.orgs.path, r.users.logins], [null, []]);
  pre.boot(base);
  legacy.writeUsersFile({ users: { ops: record('bob') } }, join(base, 'users.json'));
  await refused(base, env);
  await requestIt(base);
  await start(base, env);
  await read(base, (db) => {
    assert.deepEqual(userRows(db).map((u) => [u.login, u.disabled, u.owner]), [
      ['alice', true, false], [`${KEY}#sub-1`, false, true], [`${KEY}#sub-2`, false, false], ['ops', true, false],
    ]);
    assert.equal(getOrg(db, 'default').root, '.');
    assert.ok(membersOf(db, 'default').includes('ops:operator'));
  });
  await start(base, env);
});

test('import --replace: the request refuses a store that is in use, never imported, foreign or :memory:; the start refuses a request the marker does not match (a foreign store, a missing marker) and changes nothing', async () => {
  const refusedOp = (re) => (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && re.test(e.message);
  const a = tempDir();
  usersJson(a, ['alice']);
  await start(a);
  const b = tempDir();
  usersJson(b, ['alice']);
  await start(b);
  legacy.writeUsersFile({ users: { alice: record('alice'), bob: record('bob') } }, join(b, 'users.json'));
  await requestIt(b);

  // b's database, its request pending, pointed at a's workspace: (a) refuses; nothing changes.
  const foreign = join(a, 'foreign.db');
  copyFileSync(dbOf(b), foreign);
  const rowsOf = async (path) => { const db = await openStore({ path }); try { return { rows: actions(db).length, users: userRows(db), req: meta.getMeta(db, 'replace_requested') }; } finally { closeStore(path); } };
  const before = await rowsOf(foreign);
  const e = await refused(a, { OBSERVOGRAM_DB: foreign });
  assert.match(e.message, /^refusing to start: the legacy users\.json\/orgs\.json in .* were imported into store /);
  assert.deepEqual(await rowsOf(foreign), before);
  assert.ok(before.req, 'the request stays pending');
  await assert.rejects(requestReplace({ dbPath: foreign, base: a, out: silent }), refusedOp(/names store .*: an empty or foreign store — see the stale-store ways out/));

  // b's marker gone: (c) refuses, naming it; put back, the replace runs.
  const markerB = readFileSync(legacy.markerPath(b));
  rmSync(legacy.markerPath(b));
  const c = await refused(b);
  const idB = JSON.parse(markerB).storeId;
  assert.equal(c.message, `refusing to start: ${dbOf(b)} holds store ${idB} with a pending \`packc store import --replace\` requested for store ${idB}, `
    + `but ${legacy.markerPath(b)} is missing. Nothing was imported or replaced; the request stays pending. Ways out:\n`
    + '  - point OBSERVOGRAM_DB at the store the request was made for, or at a copy of its backup;\n'
    + '  - with the server stopped, `packc store restore <backup>`;\n'
    + `  - or put ${legacy.markerPath(b)} back as it was (it names store ${idB}), then start again.`);
  await assert.rejects(requestIt(b), refusedOp(/is missing, and a replace is requested only for the store the marker names: a replace is already pending, and the next start carries it out once .* is put back as it was/));
  writeFileSync(legacy.markerPath(b), markerB);
  const { logs } = await start(b);
  assert.ok(logs.some((l) => l.startsWith('[store] replaced from')), logs.join('\n'));
  await read(b, (db) => assert.ok(getUserByLogin(db, 'bob')));

  // In use, never imported, no database, :memory:.
  await openStore({ path: dbOf(a) });
  try {
    await assert.rejects(requestIt(a), refusedOp(/is in use — stop the server .* before requesting a replace/));
  } finally {
    closeStore(dbOf(a));
  }
  const fresh = tempDir();
  await openStore({ path: dbOf(fresh) });
  closeStore(dbOf(fresh));
  await assert.rejects(requestIt(fresh), refusedOp(/never imported, but .* is missing: an empty or foreign store/));
  await assert.rejects(requestIt(tempDir()), refusedOp(/no database at/));
  await assert.rejects(requestReplace({ dbPath: ':memory:', base: a, out: silent }), refusedOp(/:memory:/));
  await read(a, (db) => assert.equal(meta.getMeta(db, 'replace_requested'), null));
});

test('packc store import: without --replace a usage error naming it; the refusal on one line with exit 1', () => {
  const base = tempDir();
  const env = { ...process.env };
  for (const k of STRIP) { delete env[`OBSERVOGRAM_${k}`]; delete env[`TOMOGRAPH_${k}`]; }
  env.OBSERVOGRAM_WORKSPACE = base;
  const run = (...args) => spawnSync(process.execPath, [PACKC, 'store', ...args], { env, encoding: 'utf8', timeout: 60_000 });
  for (const args of [['import'], ['import', '--force'], ['import', '--replace', 'x']]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /only `packc store import --replace` exists/);
    assert.match(r.stderr, /packc store import --replace +Ask the next server start/);
  }
  const none = run('import', '--replace');
  assert.equal(none.status, 1);
  assert.equal(none.stdout, `store: ${dbOf(base)}\n`);
  assert.match(none.stderr, /^packc store import: no database at /);
  assert.equal(none.stderr.trim().split('\n').length, 1);
});

// ---------- rekey-issuer ----------

const rekey = (base, opts) => rekeyIssuer({ dbPath: dbOf(base), out: silent, ...opts });
async function oidcSessionOf(base, c, issuerRaw) {
  return withEnv({ ...CLEAR, OBSERVOGRAM_WORKSPACE: base, OBSERVOGRAM_SESSION_SECRET: SECRET, OBSERVOGRAM_OIDC_ISSUER: issuerRaw }, async () => {
    const db = await openStore({ path: dbOf(base) });
    try { return resolveSession({ headers: { cookie: c } }, { db })?.login ?? null; } finally { closeStore(dbOf(base)); }
  });
}
// An OIDC deployment: orgs.json members, an owner, a local user left over.
async function oidcDeployment() {
  const base = tempDir();
  usersJson(base, ['alice']);
  legacy.writeOrgsFile({
    default: { name: 'Default', members: { 'sub-1': 'admin' } },
    acme: { name: 'Acme', members: { 'sub-2': 'viewer', 'sub-1': 'admin' } },
  }, join(base, 'orgs.json'));
  await start(base, { OBSERVOGRAM_OIDC_ISSUER: ISSUER });
  // As start() records it once the server listens.
  await change(base, (db) => boot.recordIdentityMode(db, { issuerKey: KEY }));
  return base;
}

test('rekey-issuer --to: the same IdP users keep their rows, roles and owner flag under the new key; identity_mode follows; one issuer.rekey row; the new issuer boots', async () => {
  const base = await oidcDeployment();
  const moved = 'https://login.example/realms/ops/.well-known/openid-configuration';
  const NEW = identity.canonIssuer(moved);
  await change(base, (db) => admin.grantOwnerByLogin(db, 'cli', `${KEY}#sub-2`, { shellIssuerRaw: ISSUER }));
  const before = await read(base, (db) => ({
    users: userRows(db), audit: actions(db).length, identityMode: meta.getMeta(db, 'identity_mode'),
    members: ['default', 'acme'].map((o) => membersOf(db, o)),
  }));
  assert.equal(before.identityMode, `oidc:${KEY}`);
  assert.deepEqual(before.members, [[`${KEY}#sub-1:admin`, `${KEY}#sub-2:admin`], [`${KEY}#sub-1:admin`, `${KEY}#sub-2:viewer`]]);
  const oldCookie = storeCookie(`${KEY}#sub-1`, 0);
  assert.equal(await oidcSessionOf(base, oldCookie, ISSUER), `${KEY}#sub-1`);

  const r = await rekey(base, { to: moved });
  assert.deepEqual([r.mode, r.from, r.to, r.rows, r.pending], ['to', KEY, NEW, 2, false]);
  assert.deepEqual(formatRekey(r), [
    `rekeyed store ${r.storeId}: OIDC users ${KEY}#<sub> -> ${NEW}#<sub> (2 rows)`,
    `set OBSERVOGRAM_OIDC_ISSUER to a spelling of ${NEW} before starting the server; sessions signed in under the old key end (a fresh sign-in finds the same user)`,
  ]);
  await read(base, (db) => {
    assert.deepEqual(userRows(db), before.users.map((u) => ({ ...u, login: u.kind === 'oidc' ? u.login.replace(`${KEY}#`, `${NEW}#`) : u.login })),
      'same rows, epochs, owner and disabled flags; only the prefix changed');
    assert.deepEqual(['default', 'acme'].map((o) => membersOf(db, o)),
      before.members.map((m) => m.map((x) => x.replace(`${KEY}#`, `${NEW}#`))), 'the same memberships and roles');
    assert.equal(meta.getMeta(db, 'oidc_issuer'), NEW);
    assert.equal(meta.getMeta(db, 'identity_mode'), `oidc:${NEW}`);
    const rows = listAudit(db, { limit: 1000 });
    assert.equal(rows.length, before.audit + 1, 'one audit row');
    assert.deepEqual([rows[0].action, rows[0].actor, rows[0].targetKind, rows[0].targetId, rows[0].detail],
      ['issuer.rekey', 'cli', 'issuer', KEY, { from: KEY, to: NEW, mode: 'to', rows: 2 }]);
    assert.ok(rows.slice(1).some((a) => a.targetId === `${KEY}#sub-2`), 'earlier audit rows keep the old logins');
  });

  // Under the new issuer: no step-2 refusal; a pre-upgrade cookie finds the same row, a store cookie under the old key ends.
  const { warns } = await start(base, { OBSERVOGRAM_OIDC_ISSUER: moved });
  assert.ok(!warns.some((w) => /no owner/.test(w)), warns.join('\n'));
  assert.equal(await oidcSessionOf(base, cookie({ sub: 'sub-2' }), moved), `${NEW}#sub-2`);
  assert.equal(await oidcSessionOf(base, oldCookie, moved), null);
  assert.equal(await oidcSessionOf(base, storeCookie(`${NEW}#sub-1`, 0), moved), `${NEW}#sub-1`);
  await read(base, (db) => assert.equal(listUsers(db).length, before.users.length, 'no first-sight duplicate'));
  const e = await refused(base, { OBSERVOGRAM_OIDC_ISSUER: ISSUER });
  assert.ok(e.message.includes(`records its OIDC users under ${NEW}`), e.message);
});

test('rekey-issuer --to: refused on a re-spelling of the recorded key, a login it would reuse, no recorded issuer, an unusable URL, a store in use, no database and :memory: — nothing changed', async () => {
  const refusedOp = (re) => (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && re.test(e.message);
  const base = await oidcDeployment();
  const NEW = identity.canonIssuer('https://new.example/');
  await change(base, (db) => identity.createOidcUser(db, { issuerKey: NEW, issuerDisplay: 'https://new.example/', sub: 'sub-2', via: 'test' }));
  const snapshot = () => read(base, (db) => ({ users: userRows(db), audit: actions(db).length, issuer: meta.getMeta(db, 'oidc_issuer'), mode: meta.getMeta(db, 'identity_mode') }));
  const before = await snapshot();

  await assert.rejects(rekey(base, { to: `${ISSUER}.well-known/openid-configuration` }), refusedOp(/already records its OIDC users under https:\/\/idp\.example\/ — nothing to rekey/));
  await assert.rejects(rekey(base, { to: 'https://new.example' }), refusedOp(new RegExp(`would reuse a login that exists: ${NEW}#sub-2 — nothing was changed`)));
  await assert.rejects(rekey(base, { to: 'ftp://new.example/' }), refusedOp(/^--to is an http\(s\) URL/));
  await assert.rejects(rekey(base, {}), refusedOp(/name one of --to <issuer> or --clear/));
  await assert.rejects(rekey(base, { to: 'https://x.example/', clear: true }), refusedOp(/name one of/));
  await openStore({ path: dbOf(base) });
  try {
    await assert.rejects(rekey(base, { to: 'https://x.example/' }), refusedOp(/is in use — stop the server .* before rekeying the issuer/));
  } finally {
    closeStore(dbOf(base));
  }
  assert.deepEqual(await snapshot(), before);

  const local = tempDir();
  usersJson(local, ['alice']);
  await start(local);
  await assert.rejects(rekey(local, { to: 'https://x.example/' }), refusedOp(/records no OIDC issuer — nothing to rekey/));
  await assert.rejects(rekey(local, { clear: true }), refusedOp(/records no OIDC issuer/));
  await assert.rejects(rekey(tempDir(), { clear: true }), refusedOp(/no database at .* never creates one/));
  await assert.rejects(rekeyIssuer({ clear: true, dbPath: ':memory:', out: silent }), refusedOp(/:memory:/));
});

test('rekey-issuer --clear: every OIDC row disabled with its epoch bumped, the record and an oidc: identity_mode cleared, one issuer.rekey row; the next start records the new key and the bootstrap names a new owner', async () => {
  const base = await oidcDeployment();
  await change(base, (db) => admin.disableUser(db, 'cli', `${KEY}#sub-2`, { shellIssuerRaw: ISSUER }));
  const before = await read(base, (db) => ({ users: userRows(db), audit: actions(db).length }));
  const r = await rekey(base, { clear: true });
  assert.deepEqual([r.mode, r.from, r.to, r.disabled], ['clear', KEY, null, [`${KEY}#sub-1`]]);
  assert.deepEqual(formatRekey(r), [
    `cleared the OIDC issuer of store ${r.storeId} (was ${KEY}): disabled ${KEY}#sub-1`,
    'the next start records the new issuer; set OBSERVOGRAM_BOOTSTRAP_ADMIN to name its owner',
  ]);
  await read(base, (db) => {
    assert.deepEqual(userRows(db), before.users.map((u) => (u.kind === 'oidc' ? { ...u, disabled: true, ep: u.disabled ? u.ep : u.ep + 1 } : u)));
    assert.equal(meta.getMeta(db, 'oidc_issuer'), null);
    assert.equal(meta.getMeta(db, 'identity_mode'), null);
    const rows = listAudit(db, { limit: 1000 });
    assert.equal(rows.length, before.audit + 1, 'one audit row, none per user');
    assert.deepEqual([rows[0].action, rows[0].actor, rows[0].targetId, rows[0].detail],
      ['issuer.rekey', 'cli', KEY, { from: KEY, to: null, mode: 'clear', disabled: [`${KEY}#sub-1`] }]);
  });
  assert.equal(await oidcSessionOf(base, storeCookie(`${KEY}#sub-1`, 0), ISSUER), null, 'the old rows no longer sign in');

  const other = 'https://other-idp.example/';
  const OTHER = identity.canonIssuer(other);
  const { warns } = await start(base, { OBSERVOGRAM_OIDC_ISSUER: other, OBSERVOGRAM_BOOTSTRAP_ADMIN: `${OTHER}#boss` });
  assert.ok(warns.some((w) => w.startsWith('[store] no owner who can sign in with OIDC')), warns.join('\n'));
  await change(base, (db) => {
    assert.equal(meta.getMeta(db, 'oidc_issuer'), OTHER, 'the next start records the new key');
    const u = identity.oidcSignIn(db, {
      issuerKey: OTHER, issuerDisplay: other, claims: identity.sanitiseClaims({ sub: 'boss' }, other),
      bootstrap: identity.parseBootstrapAdmin(`${OTHER}#boss`),
    });
    assert.equal(getUserByLogin(db, `${OTHER}#boss`).isOwner, true, u && 'the bootstrap names the new owner');
    assert.equal(getUserByLogin(db, `${KEY}#sub-1`).isOwner, true, 'the old owner row keeps its flag, disabled');
  });

  // A stand-alone identity_mode is left as it is.
  const local = tempDir();
  await start(local, { OBSERVOGRAM_OIDC_ISSUER: ISSUER });
  await change(local, (db) => boot.recordIdentityMode(db, { issuerKey: null, token: 'x' }));
  await rekey(local, { clear: true });
  await read(local, (db) => assert.equal(meta.getMeta(db, 'identity_mode'), 'token'));
});

test('packc store rekey-issuer: usage errors exit 2; the store line, the report; a refusal on one line with exit 1', async () => {
  const base = await oidcDeployment();
  const env = { ...process.env };
  for (const k of STRIP) { delete env[`OBSERVOGRAM_${k}`]; delete env[`TOMOGRAPH_${k}`]; }
  env.OBSERVOGRAM_WORKSPACE = base;
  const run = (...args) => spawnSync(process.execPath, [PACKC, 'store', 'rekey-issuer', ...args], { env, encoding: 'utf8', timeout: 60_000 });
  for (const args of [[], ['--to'], ['--to', ''], ['--clear', 'x'], ['--to', 'a', 'b'], ['--both']]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /name one of --to <issuer> \(the same IdP at a new URL\) or --clear/);
    assert.match(r.stderr, /packc store rekey-issuer --to <issuer> \| --clear/);
  }
  const same = run('--to', ISSUER);
  assert.equal(same.status, 1);
  assert.equal(same.stdout, `store: ${dbOf(base)}\n`);
  assert.match(same.stderr, /^packc store rekey-issuer: store \S+ already records its OIDC users under/);
  assert.equal(same.stderr.trim().split('\n').length, 1);
  const ok = run('--to', 'https://moved.example/');
  assert.equal(ok.status, 0, ok.stderr);
  const lines = ok.stdout.trim().split('\n');
  assert.equal(lines[0], `store: ${dbOf(base)}`);
  assert.match(lines[1], /^rekeyed store \S+: OIDC users https:\/\/idp\.example\/#<sub> -> https:\/\/moved\.example\/#<sub> \(2 rows\)$/);
  const clr = run('--clear');
  assert.equal(clr.status, 0, clr.stderr);
  assert.match(clr.stdout, /cleared the OIDC issuer of store \S+ \(was https:\/\/moved\.example\/\): disabled https:\/\/moved\.example\/#sub-1, https:\/\/moved\.example\/#sub-2/);
});

// ---------- purge-org ----------

const purge = (base, id, opts = {}) => purgeOrg(id, { dbPath: dbOf(base), base, out: silent, ...opts });
const refusedOp = (re) => (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && re.test(e.message);
function cliEnv(base) {
  const env = { ...process.env };
  for (const k of STRIP) { delete env[`OBSERVOGRAM_${k}`]; delete env[`TOMOGRAPH_${k}`]; }
  env.OBSERVOGRAM_WORKSPACE = base;
  return env;
}

// A flat deployment with two created orgs, acme removed (its files stay).
async function removedOrgDeployment() {
  const base = tempDir();
  usersJson(base, ['alice']);
  pack(base, 'p1');
  await start(base);
  await change(base, (db) => {
    admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'alice', base });
    admin.createOrgFromAdmin(db, 'cli', { id: 'beta', name: 'Beta', admin: 'alice', base });
    admin.removeOrgSoft(db, 'cli', 'acme');
  });
  pack(join(base, 'orgs', 'acme'), 'a1');
  pack(join(base, 'orgs', 'beta'), 'b1');
  return base;
}

test('purge-org: a removed org\'s files deleted, its legacy_hashes keys dropped, one org.purge row, the marker rewritten; the next start passes and writes no row', async () => {
  const base = await removedOrgDeployment();
  // A slice-4 per-root key, as the store would record it.
  const indexKey = 'orgs/acme/packs/index.json';
  writeFileSync(join(base, indexKey), '{}\n');
  const before = await change(base, (db) => {
    const hashes = { ...meta.getMetaJson(db, 'legacy_hashes'), [indexKey]: legacy.sha256File(join(base, indexKey)) };
    tx(db, () => meta.putMeta(db, 'legacy_hashes', JSON.stringify(hashes)));
    return { rows: actions(db).length, hashes };
  });
  const markerBefore = legacy.readMarker(base);

  const r = await purge(base, 'acme');
  assert.deepEqual({ deleted: r.deleted, dropped: r.dropped, root: r.root }, { deleted: true, dropped: [indexKey], root: join(base, 'orgs', 'acme') });
  assert.deepEqual(formatPurge(r), [`purged org acme: deleted ${join(base, 'orgs', 'acme')}`, `dropped from legacy_hashes: ${indexKey}`, `rewrote ${legacy.markerPath(base)}`]);
  assert.equal(existsSync(join(base, 'orgs', 'acme')), false);
  assert.deepEqual(readdirSync(join(base, 'orgs', 'beta', 'packs')), ['b1.pack.yaml'], 'another org\'s files stay');
  assert.ok(existsSync(join(base, 'packs', 'p1.pack.yaml')), 'the default org\'s files stay');
  const after = await read(base, (db) => {
    assert.deepEqual(actions(db).slice(before.rows), ['org.purge:cli:acme']);
    const [row] = listAudit(db, { action: 'org.purge' });
    assert.equal(row.orgId, null);
    assert.deepEqual(row.detail, { root: 'orgs/acme', deleted: true, legacyHashes: [indexKey] });
    const { [indexKey]: _gone, ...rest } = before.hashes;
    assert.deepEqual(meta.getMetaJson(db, 'legacy_hashes'), rest);
    assert.ok(getOrg(db, 'acme').removedAt, 'the row stays: its slug is never reused');
    return { rows: actions(db).length, hashes: rest };
  });
  const marker = legacy.readMarker(base);
  assert.deepEqual({ by: marker.by, storeId: marker.storeId, files: marker.files }, { by: 'purge-org', storeId: markerBefore.storeId, files: after.hashes });

  const { warns } = await start(base);
  assert.deepEqual(warns.filter((w) => /left behind/.test(w)), []);
  await read(base, (db) => assert.equal(actions(db).length, after.rows, 'the start writes no row'));

  // Nothing left: a second purge is refused.
  await assert.rejects(purge(base, 'acme'), refusedOp(/^org acme was purged already and nothing of it is left at /));
});

test('purge-org docs: the README and the k8s note say it cannot be undone, what it deletes, and that a store backup holds none of it', () => {
  const section = (text, heading) => {
    const at = text.indexOf(heading);
    assert.notEqual(at, -1, heading);
    const next = text.indexOf('\n#', at + heading.length);
    return text.slice(at, next === -1 ? undefined : next).replace(/\s+/g, ' ');
  };
  const readme = section(readFileSync(join(HERE, '..', 'README.md'), 'utf8'), '### Purge A Removed Org');
  const k8s = readFileSync(join(HERE, '..', 'deploy', 'k8s', 'README.md'), 'utf8').replace(/\s+/g, ' ');
  const note = k8s.slice(k8s.indexOf('`store purge-org <id>`'), k8s.indexOf('### Storage class'));
  for (const [name, text] of [['README', readme], ['deploy/k8s/README.md', note]]) {
    assert.match(text, /cannot be undone/, `${name}: irreversible`);
    assert.match(text, /no confirmation/, `${name}: no prompt`);
    for (const part of ['deploys.jsonl', 'snapshots/', 'runs/', 'journeys/']) assert.ok(text.includes(part), `${name}: names ${part}`);
    assert.match(text, /store backup` holds/, `${name}: a store backup does not cover the files`);
    assert.match(text, /copy `[^`]*orgs\/<id>\/?` .*first/, `${name}: copy the directory first`);
  }
});

test('purge-org: refused for a live, default or unknown org, a root that is a symlink, a workspace whose marker names another store, a store in use, no database and :memory: — nothing deleted', async () => {
  const base = await removedOrgDeployment();
  const rows = await read(base, (db) => actions(db).length);
  const files = () => readdirSync(join(base, 'orgs'), { recursive: true }).sort();
  const filesBefore = files();

  await assert.rejects(purge(base, 'beta'), refusedOp(/^org beta is live — remove it first with `npm run orgs -- remove beta` \(its files stay\), then purge it; nothing was deleted$/));
  await assert.rejects(purge(base, 'default'), refusedOp(/^default is the default org and is never purged/));
  await assert.rejects(purge(base, 'nope'), refusedOp(/^store \S+ has no org "nope" — nothing was deleted$/));

  await openStore({ path: dbOf(base) });
  try {
    await assert.rejects(purge(base, 'acme'), refusedOp(/is in use — stop the server .* before purging an org/));
  } finally {
    closeStore(dbOf(base));
  }

  const markerBytes = readFileSync(legacy.markerPath(base));
  legacy.writeMarker(base, { storeId: 'another-store', files: {}, by: 'import' });
  await assert.rejects(purge(base, 'acme'), refusedOp(/names store another-store, but .* holds store \S+: the workspace .* is not this store's/));
  writeFileSync(legacy.markerPath(base), markerBytes);

  const elsewhere = tempDir();
  pack(elsewhere, 'x1');
  rmSync(join(base, 'orgs', 'acme'), { recursive: true });
  symlinkSync(elsewhere, join(base, 'orgs', 'acme'), 'dir');
  await assert.rejects(purge(base, 'acme'), refusedOp(/orgs\/acme is not a directory \(a symlink, never followed\)/));
  assert.ok(existsSync(join(elsewhere, 'packs', 'x1.pack.yaml')), 'the link target stays');
  rmSync(join(base, 'orgs', 'acme'));
  pack(join(base, 'orgs', 'acme'), 'a1');
  assert.deepEqual(files(), filesBefore);

  await assert.rejects(purge(tempDir(), 'acme'), refusedOp(/^no database at .* nothing to purge/));
  await assert.rejects(purge(base, 'acme', { dbPath: ':memory:' }), refusedOp(/:memory:/));
  await read(base, (db) => assert.equal(actions(db).length, rows));
  assert.deepEqual(readFileSync(legacy.markerPath(base)), markerBytes);
});

test('packc store purge-org: usage exits 2; the store line, the report; a refusal on one line with exit 1; `orgs -- remove` names it', async () => {
  const base = await removedOrgDeployment();
  const env = cliEnv(base);
  const run = (...args) => spawnSync(process.execPath, [PACKC, 'store', 'purge-org', ...args], { env, encoding: 'utf8', timeout: 60_000 });
  for (const args of [[], ['acme', 'x']]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /packc store purge-org <id> +Delete the files of an org removed with `npm run orgs -- remove`/);
  }
  const live = run('beta');
  assert.equal(live.status, 1);
  assert.equal(live.stdout, `store: ${dbOf(base)}\n`);
  assert.match(live.stderr, /^packc store purge-org: org beta is live/);
  assert.equal(live.stderr.trim().split('\n').length, 1);
  const ok = run('acme');
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.stdout.trim().split('\n'), [`store: ${dbOf(base)}`, `purged org acme: deleted ${join(base, 'orgs', 'acme')}`, `rewrote ${legacy.markerPath(base)}`]);

  const rm = spawnSync(process.execPath, [join(HERE, '..', 'tools', 'org-admin.mjs'), 'remove', 'beta'], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(rm.status, 0, rm.stderr);
  assert.match(rm.stdout, /removed org beta — its files under .*orgs.beta stay; `packc store purge-org beta` deletes them with the server stopped/);
});

// ---------- restore: the marker warning ----------

test('packc store restore warns when the workspace\'s marker names another store, and the start then refuses; a backup of the same store restores without it', async () => {
  const base = tempDir();
  usersJson(base, ['alice']);
  await start(base);
  const own = legacy.readMarker(base).storeId;
  const sameBackup = join(tempDir(), 'same.db');
  await backupStore(sameBackup, { dbPath: dbOf(base) });
  const other = tempDir();
  await start(other);
  const otherId = await read(other, (db) => meta.storeId(db));
  const otherBackup = join(tempDir(), 'other.db');
  await backupStore(otherBackup, { dbPath: dbOf(other) });

  assert.equal(restoreMarkerWarning(own, base), null);
  assert.equal(restoreMarkerWarning(own, tempDir()), null, 'no marker, no warning');
  const text = `warning: the restored store is ${otherId}; ${legacy.markerPath(base)} names ${own} — the next start refuses until they agree (README: stale import)`;
  assert.equal(restoreMarkerWarning(otherId, base), text);

  const env = cliEnv(base);
  const run = (...args) => spawnSync(process.execPath, [PACKC, 'store', 'restore', ...args], { env, encoding: 'utf8', timeout: 60_000 });
  const foreign = run(otherBackup);
  assert.equal(foreign.status, 0, foreign.stderr);
  assert.match(foreign.stdout, new RegExp(`store_id: ${otherId} `));
  assert.equal(foreign.stderr, `${text}\n`);
  const e = await refused(base);
  assert.match(e.message, new RegExp(`imported into store ${own} `));

  const same = run(sameBackup);
  assert.equal(same.status, 0, same.stderr);
  assert.equal(same.stderr, '');
  await start(base);

  writeFileSync(legacy.markerPath(base), 'not json');
  assert.match(restoreMarkerWarning(own, base), /^warning: .*\.store-imported cannot be read as a store import marker — the next start refuses until it is fixed \(README: stale import\)$/);
});
