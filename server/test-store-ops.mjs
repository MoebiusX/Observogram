#!/usr/bin/env node
/**
 * server/test-store-ops.mjs — the `packc store` offline operations
 * (docs/STORE_PLAN.md §4 "packc store export", §8 gate Export).
 *
 * Every workspace is upgraded the way a deployment is: legacy files and
 * flat data on disk, one bootStore() (the import), then changes through the
 * management rules (server/identity-admin.mjs), then the store closed —
 * the server stopped — and exported. What a pre-store build then does with
 * the result is asked of server/fixtures/pre-store-build.mjs, a frozen copy
 * of v0.4.0's file semantics; tools/test-store-prestore-live.mjs asks the
 * real v0.4.0 build over HTTP (CI job store-prestore).
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
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const { closeStore, openStore, tx } = await import('./store/db.mjs');
const identity = await import('./store/identity.mjs');
const memberships = await import('./store/memberships.mjs');
const meta = await import('./store/meta.mjs');
const { getOrg } = await import('./store/orgs.mjs');
const { listAudit } = await import('./store/audit.mjs');
const legacy = await import('./store/legacy-files.mjs');
const { exportStore, formatExport, COOKIE_NOTE } = await import('./store/ops.mjs');
const admin = await import('./identity-admin.mjs');
const { hashPassword } = await import('./auth.mjs');
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
async function start(base, env = {}) {
  const clear = Object.fromEntries(STRIP.flatMap((k) => [[`OBSERVOGRAM_${k}`, undefined], [`TOMOGRAPH_${k}`, undefined]]));
  const warns = [];
  await withEnv({ ...clear, OBSERVOGRAM_WORKSPACE: base, ...env },
    () => boot.bootStore({ host: '127.0.0.1', warn: (m) => warns.push(m) }));
  closeStore(dbOf(base));
  return { warns };
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
  for (const e of ['packs', 'snapshots', 'journeys']) assert.equal(existsSync(join(base, e)), false, `${e} moved`);
  const moved = slashed(join(base, 'orgs', 'default', 'packs', 'p1.pack.yaml'));
  const lines = formatExport(r);
  assert.ok(lines.includes(`the default org's root is now orgs/default — point its CronJobs at ${r.cronJob}`), lines.join('\n'));

  // The pre-store build: its migration finds nothing to move.
  assert.deepEqual(pre.boot(base), { migrated: [] });
  assert.deepEqual(pre.orgsForUser(base, 'bob').map((o) => o.id), ['default', 'acme']);
  assert.deepEqual(pre.orgsForUser(base, 'erin'), [{ id: 'acme', name: 'Acme', role: 'viewer' }]);
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
