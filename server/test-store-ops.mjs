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
 * `packc store purge-org` deletes a removed org's files — never while that
 * would take the users file a pre-store build reads, decided by what deleting
 * the root takes (server/store/users-file-place.mjs, over the mounts a runner
 * cannot make in server/fixtures/mount-fs.mjs) — and `packc store
 * restore` warns when the workspace's marker names another store. `packc
 * store audit` (slice 5, the audit) lists the rows from a shell, newest
 * first, one JSON line each, and writes none.
 *
 * Slice 4 (the pack registry on the store): the in-place export reconciles
 * each org's pack files with its rows BEFORE it writes packs/index.json in
 * the old shape (the Export gate's "the same packs with their labels", read
 * back through the fixture's copy of v0.4.0's label join); the Stale-import
 * round trip — a rolled-back build registers, relabels, removes or RESETs
 * packs → the start refuses naming `import --replace`, which takes the
 * file's entries in; a rollback that only READS packs (lastUsedAt) never
 * refuses; and a 0.5.0-like guard loop (server/fixtures/store-050-guard.mjs)
 * over a slice-4 workspace does not refuse — because the pack hashes live
 * under their own key, never in legacy_hashes.
 *
 * Hermetic (§0): the store and identity variables of a developer shell are
 * deleted before any server code loads; each fixture has its own temp
 * workspace and store; the CLI child gets an explicit env.
 */

// The children's STRIP list is this process's too (serve-child.mjs imports
// no server code; server/test-hermetic-suites.mjs guards the shape).
const { STRIP } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { spawnSync } = await import('node:child_process');
const { createHmac } = await import('node:crypto');
const { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { dirname, join, posix, win32 } = await import('node:path');
const { fileURLToPath, pathToFileURL } = await import('node:url');
const { isWin32, win32Skip, WIN32 } = await import('./fixtures/platform.mjs');

const { closeStore, openStore, tx } = await import('./store/db.mjs');
const identity = await import('./store/identity.mjs');
const memberships = await import('./store/memberships.mjs');
const meta = await import('./store/meta.mjs');
const { getOrg, listOrgs } = await import('./store/orgs.mjs');
const { getUserByLogin, listUsers } = await import('./store/users.mjs');
const { listAudit, writeAudit } = await import('./store/audit.mjs');
const legacy = await import('./store/legacy-files.mjs');
const {
  exportStore, formatExport, formatPurge, formatRekey, COOKIE_NOTE, purgeOrg, rekeyIssuer, REPLACE_REQUESTED, requestReplace, restoreMarkerWarning,
} = await import('./store/ops.mjs');
const { backupStore, restoreStore } = await import('./store/backup.mjs');
const { usersFilePlace } = await import('./store/users-file-place.mjs');
const { mountFs } = await import('./fixtures/mount-fs.mjs');
const admin = await import('./identity-admin.mjs');
const { hashPassword, resolveSession, verifyPassword } = await import('./auth.mjs');
const boot = await import('./boot.mjs');
const { applyReplace } = await import('./store/import.mjs');
const pre = await import('./fixtures/pre-store-build.mjs');
const { guard050, BootRefusal050 } = await import('./fixtures/store-050-guard.mjs');
const packsRepo = await import('./store/packs.mjs');
const { runWithOrg } = await import('./org-context.mjs');

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
// The pack registry (slice 4): the rows of an org, an index file's recorded hash shape, the index as read.
const packRows = (db, org) => runWithOrg(org, () => packsRepo.listPacks(db).map((p) => [p.id, p.label, p.source]));
const indexHashOf = (text) => {
  const entries = Object.entries(JSON.parse(text));
  return { sha256: legacy.sha256Of(legacy.canonicalPackIndex(entries)), canon: 'pack-index-v1', raw: legacy.sha256Of(Buffer.from(text)) };
};
const readIndex = (path) => JSON.parse(readFileSync(path, 'utf8'));
const relabel = (db, org, id, label) => runWithOrg(org, () => packsRepo.upsertPack(db, 'cli', { id, label, source: packsRepo.getPack(db, id).source }));

test('in place: an index that was corrupt when recorded is compared byte for byte — the refusal says so, not "canonical SHA-256"', async () => {
  const base = tempDir();
  pack(base, 'a');
  const path = join(base, 'packs', 'index.json');
  const corrupt = '{"a": {"label": "WS';
  writeFileSync(path, corrupt);
  await start(base);
  const rawHash = legacy.sha256Of(Buffer.from(corrupt));
  await read(base, (db) => assert.deepEqual(meta.getMetaJson(db, 'pack_index_hashes'), { 'packs/index.json': { sha256: rawHash, canon: 'raw', raw: rawHash } }, 'a corrupt index hashes its bytes'));
  // Edited since: refused, and the recorded hash is named for what it is — packIndexHash records a corrupt
  // index by the SHA-256 of its bytes, so "canonical SHA-256" would send the operator after an entry set no file reproduces.
  writeFileSync(path, '{}');
  await assert.rejects(exportIt(base), (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED'
    && e.message.startsWith(`${path} (it was SHA-256 ${rawHash} of its bytes — the file was corrupt when recorded, so it is compared byte for byte; it is ${indexHashOf('{}').sha256}) differs from what store `)
    && !e.message.includes('canonical'));
  assert.equal(readFileSync(path, 'utf8'), '{}', 'not overwritten');
  // The same corrupt bytes put back: the export passes and re-records the index it wrote.
  writeFileSync(path, corrupt);
  await exportIt(base);
  await read(base, (db) => assert.equal(meta.getMetaJson(db, 'pack_index_hashes')['packs/index.json'].canon, 'pack-index-v1'));
});

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
    relabel(db, 'default', 'p2', 'Second');   // a label the store holds and the file never did (no index.json before the import)
    return actions(db).length;
  });
  const journeyBefore = readFileSync(join(base, 'journeys', 'nightly.journey.yaml'), 'utf8');
  const indexPath = join(base, 'packs', 'index.json');
  assert.equal(existsSync(indexPath), false, 'the import wrote no index; the server never does');

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
  // The pack registry written back in the old shape (ms numbers), from the rows, with the labels.
  assert.deepEqual(r.indexes.map((i) => [i.org, i.path, i.write, i.packs.map((x) => x.id), i.adopt, i.prune]), [['default', indexPath, true, ['p1', 'p2'], [], []]]);
  assert.ok(lines.includes(`index.json: 1 org root — ${indexPath} (2 packs)`), lines.join('\n'));
  const idx = readIndex(indexPath);
  const mtime = (id) => statSync(join(base, 'packs', `${id}.pack.yaml`)).mtimeMs;
  assert.deepEqual(idx, {
    p1: { label: null, source: 'workspace', createdAt: Math.trunc(mtime('p1')), lastUsedAt: Math.trunc(mtime('p1')) },
    p2: { label: 'Second', source: 'workspace', createdAt: Math.trunc(mtime('p2')), lastUsedAt: idx.p2.lastUsedAt },
  });
  assert.ok(Number.isInteger(idx.p2.lastUsedAt) && idx.p2.lastUsedAt >= idx.p2.createdAt, 'lastUsedAt: the relabel touched it');
  assert.equal(statSync(indexPath).mode & 0o777, isWin32 ? 0o666 : 0o644, 'no secret in it: world-readable (0644; Windows reports a writable file as 0666)');
  assert.deepEqual(readdirSync(join(base, 'packs')).filter((f) => f.endsWith('.tmp')), []);

  // The pre-store build.
  pre.boot(base);
  assert.deepEqual(pre.signIn(base, 'alice', PW.alice), { sub: 'alice', mustChange: false });
  assert.equal(pre.signIn(base, 'bob', PW.bob), null, "bob's old password no longer signs in");
  assert.deepEqual(pre.signIn(base, 'bob', 'bob-new-passw0rd'), { sub: 'bob', mustChange: false });
  assert.equal(pre.signIn(base, 'carol', PW.carol), null, 'a disabled user does not sign in');
  assert.deepEqual(pre.signIn(base, 'dave', 'dave-passw0rd'), { sub: 'dave', mustChange: false });
  assert.equal(pre.tenancyEnabled(base), false);
  assert.deepEqual(pre.packIds(base), ['p1', 'p2']);
  assert.deepEqual(pre.catalogWithLabels(base), [{ id: 'p1', label: null }, { id: 'p2', label: 'Second' }], 'the same packs with their labels (B2)');
  assert.deepEqual(pre.journeys(base), { nightly: { packA: slashed(join(base, 'packs', 'p1.pack.yaml')), packB: slashed(join(base, 'packs', 'p1.pack.yaml')) } });
  assert.equal(readFileSync(join(base, 'journeys', 'nightly.journey.yaml'), 'utf8'), journeyBefore, 'nothing moved, nothing rewritten');

  // The store recorded its own export: one store.export row, the hashes (the pack index under its own key), the marker (no pack key).
  await read(base, (db) => {
    const rows = actions(db);
    assert.deepEqual(rows.slice(before), [`store.export:cli:${meta.storeId(db)}`]);
    assert.deepEqual(listAudit(db, { action: 'store.export' })[0].detail, { inPlace: true, users: 3, orgs: null, moved: [], indexes: [indexPath], packs: { adopted: 0, pruned: 0 } });
    const hashes = meta.getMetaJson(db, 'legacy_hashes');
    assert.deepEqual(hashes['users.json'], legacy.sha256File(join(base, 'users.json')));
    assert.deepEqual(hashes['orgs.json'], { absent: true });
    assert.deepEqual(Object.keys(hashes).sort(), ['orgs.json', 'users.json'], 'never a pack key in legacy_hashes');
    assert.deepEqual(meta.getMetaJson(db, 'pack_index_hashes'), { 'packs/index.json': indexHashOf(readFileSync(indexPath, 'utf8')) }, 'the canonical hash of the file written');
    const marker = legacy.readMarker(base);
    assert.equal(marker.by, 'export');
    assert.equal(marker.storeId, meta.storeId(db));
    assert.deepEqual(marker.files, hashes);
    assert.equal(getOrg(db, 'default').root, '.');
  });
  // …so a store build starts on its own export (and on what the pre-store boot left), with no line about the index.
  const { logs } = await start(base);
  assert.deepEqual(logs.filter((l) => /index\.json/.test(l)), []);
  await read(base, (db) => assert.deepEqual(packRows(db, 'default'), [['p1', null, 'workspace'], ['p2', 'Second', 'workspace']]));
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
  pack(join(base, 'orgs', 'acme'), 'a1');   // copied in after the boot: no row yet — the export adopts it before it writes (B1)

  const r = await exportIt(base);
  assert.deepEqual(r.orgs.ids, ['default', 'acme']);
  assert.deepEqual(r.move, ['packs', 'snapshots', 'journeys']);
  const defaultIdx = join(base, 'orgs', 'default', 'packs', 'index.json');
  const acmeIdx = join(base, 'orgs', 'acme', 'packs', 'index.json');
  assert.deepEqual(r.indexes.map((i) => [i.org, i.path, i.write, i.packs.map((x) => x.id), i.adopt.map((a) => a.id), i.prune]),
    [['default', defaultIdx, true, ['p1'], [], []], ['acme', acmeIdx, true, ['a1'], ['a1'], []]], 'the index of the moved root is written where the root now is');
  assert.deepEqual(Object.keys(readIndex(defaultIdx)), ['p1']);
  const a1Mtime = Math.trunc(statSync(join(base, 'orgs', 'acme', 'packs', 'a1.pack.yaml')).mtimeMs);
  assert.deepEqual(readIndex(acmeIdx), { a1: { label: null, source: 'workspace', createdAt: a1Mtime, lastUsedAt: a1Mtime } });
  assert.ok(formatExport(r).includes(`index.json: 2 org roots — ${defaultIdx} (1 pack) · ${acmeIdx} (1 pack; adopted a1)`), formatExport(r).join('\n'));
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
  assert.deepEqual(pre.catalogWithLabels(base, 'default'), [{ id: 'p1', label: null }]);
  assert.deepEqual(pre.catalogWithLabels(base, 'acme'), [{ id: 'a1', label: null }], 'the old build finds a1 in the index: nothing for it to adopt and flush');
  assert.deepEqual(pre.signIn(base, 'erin', 'erin-passw0rd'), { sub: 'erin', mustChange: false });

  await read(base, (db) => {
    const id = meta.storeId(db);
    assert.equal(getOrg(db, 'default').root, 'orgs/default');
    // In the one tx(): the root, the adoption's rows (the CLI's: the one place a CLI creates service rows), the export.
    assert.deepEqual(actions(db).slice(before), ['org.root:cli:default', 'pack.register:cli:a1', 'service.create:cli:a1', 'pack.link:cli:a1', `store.export:cli:${id}`]);
    assert.deepEqual(listAudit(db, { action: 'pack.register' })[0].detail, { label: null, source: 'workspace', adopted: true, via: 'export' });
    assert.deepEqual(packRows(db, 'acme'), [['a1', null, 'workspace']]);
    assert.deepEqual(listAudit(db, { action: 'store.export' })[0].detail, { inPlace: true, users: 3, orgs: 2, moved: ['packs', 'snapshots', 'journeys'], indexes: [defaultIdx, acmeIdx], packs: { adopted: 1, pruned: 0 } });
    const [rootRow] = listAudit(db, { action: 'org.root' });
    assert.equal(rootRow.orgId, 'default');
    assert.deepEqual(rootRow.detail, { from: '.', to: 'orgs/default' });
    assert.deepEqual(meta.getMetaJson(db, 'legacy_hashes')['orgs.json'], legacy.sha256File(join(base, 'orgs.json')));
    assert.deepEqual(meta.getMetaJson(db, 'pack_index_hashes'), {
      'orgs/default/packs/index.json': indexHashOf(readFileSync(defaultIdx, 'utf8')),
      'orgs/acme/packs/index.json': indexHashOf(readFileSync(acmeIdx, 'utf8')),
    }, 'the pre-move key packs/index.json is dropped: its file moved with packs/');
  });
  // A store build starts on it: nothing left behind (the pre-store boot's empty <base>/packs holds no data), nothing about the indexes.
  const { warns, logs } = await start(base);
  assert.deepEqual(warns.filter((w) => /left behind/.test(w)), []);
  assert.deepEqual(logs.filter((l) => /index\.json/.test(l)), []);
});

test('Export: a recorded index.json a rolled-back build changed (a relabel, a labelled register) refuses naming import --replace and writes nothing; one it only touched (lastUsedAt), or that says what the reconcile makes the store hold (an adopted file), is overwritten; a packs/ that cannot be listed refuses', { skip: win32Skip(WIN32.modes) }, async () => {
  const base = tempDir();
  usersJson(base, ['alice']);
  pack(base, 'p1');
  await start(base);
  await change(base, (db) => relabel(db, 'default', 'p1', 'First'));
  const path = join(base, 'packs', 'index.json');
  await exportIt(base);
  const written = readFileSync(path, 'utf8');
  const recorded = await read(base, (db) => meta.getMetaJson(db, 'pack_index_hashes')['packs/index.json']);
  assert.deepEqual(recorded, indexHashOf(written));

  // (i) a read on the old build: lastUsedAt rewritten, re-serialised — overwritten by the next export, the raw hash follows.
  const idx = readIndex(path);
  writeFileSync(path, JSON.stringify({ p1: { ...idx.p1, lastUsedAt: idx.p1.lastUsedAt + 60_000 } }));
  await exportIt(base);
  assert.equal(readFileSync(path, 'utf8'), written, 'written again from the rows');
  // (ii) an adopted file (no label, source workspace, its mtime): what the store would hold — overwritten, the file adopted.
  pack(base, 'q1');
  const qm = statSync(join(base, 'packs', 'q1.pack.yaml')).mtimeMs;
  writeFileSync(path, JSON.stringify({ ...idx, q1: { label: null, source: 'workspace', createdAt: qm, lastUsedAt: qm } }, null, 2));
  const adopted = await exportIt(base);
  assert.deepEqual(adopted.indexes[0].adopt.map((a) => a.id), ['q1']);
  assert.deepEqual(Object.keys(readIndex(path)), ['p1', 'q1']);
  await read(base, (db) => assert.deepEqual(packRows(db, 'default'), [['p1', 'First', 'workspace'], ['q1', null, 'workspace']]));
  // (ii′) the old build adopted the FILE of a pack the store holds with a label (a rollback without a fresh export: the index it was
  // left did not list p1): an adoption records no decision — overwritten from the rows, the label kept, nothing refused.
  const pm = statSync(join(base, 'packs', 'p1.pack.yaml')).mtimeMs;
  writeFileSync(path, JSON.stringify({ ...readIndex(path), p1: { label: null, source: 'workspace', createdAt: pm, lastUsedAt: pm } }, null, 2));
  await exportIt(base);
  assert.equal(readIndex(path).p1.label, 'First', 'written again from the rows: the label the store holds');
  await read(base, (db) => assert.deepEqual(packRows(db, 'default'), [['p1', 'First', 'workspace'], ['q1', null, 'workspace']], 'no row changed'));
  const before = await read(base, (db) => ({ rows: actions(db).length, hash: meta.getMetaJson(db, 'pack_index_hashes') }));
  const current = readFileSync(path, 'utf8');
  // (iii) a relabel on the old build: refused, nothing written.
  const relabelled = JSON.stringify({ ...readIndex(path), p1: { ...readIndex(path).p1, label: 'Renamed' } });
  writeFileSync(path, relabelled);
  const refusedText = (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED'
    && e.message.startsWith(`${path} (it was canonical SHA-256 ${indexHashOf(current).sha256}, it is ${indexHashOf(relabelled).sha256}) differs from what store `)
    && e.message.includes('run `packc store import --replace` and start the server once');
  await assert.rejects(exportIt(base), refusedText);
  assert.equal(readFileSync(path, 'utf8'), relabelled, 'not overwritten: it holds the only copy of that label');
  // (iv) a register with a label on the old build: refused too.
  pack(base, 'r1');
  writeFileSync(path, JSON.stringify({ ...readIndex(path), p1: readIndex(current === '' ? path : path).p1, r1: { label: 'R', source: 'upload', createdAt: Date.now(), lastUsedAt: Date.now() } }).replace('"Renamed"', '"First"'));
  await assert.rejects(exportIt(base), (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && /differs from what store/.test(e.message));
  await read(base, (db) => {
    assert.equal(actions(db).length, before.rows, 'no row written');
    assert.deepEqual(meta.getMetaJson(db, 'pack_index_hashes'), before.hash);
    assert.deepEqual(packRows(db, 'default'), [['p1', 'First', 'workspace'], ['q1', null, 'workspace']], 'r1 not adopted: the export stopped before any write');
  });
  // (v) a packs/ that cannot be listed: refused before any write (an index from the rows alone is what the reconcile prevents).
  writeFileSync(path, current);
  chmodSync(join(base, 'packs'), 0o000);
  try {
    if (process.getuid?.() === 0) {
      // root lists anything: the refusal is asserted on a packs that is a file instead.
      chmodSync(join(base, 'packs'), 0o755);
      renameSync(join(base, 'packs'), join(base, 'packs.aside'));
      writeFileSync(join(base, 'packs'), 'not a directory');
      await assert.rejects(exportIt(base), (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED'
        && e.message.startsWith(`${path} cannot be read (ENOTDIR) — an in-place export compares it with what store `) && /Nothing was changed/.test(e.message));
      rmSync(join(base, 'packs'));
      renameSync(join(base, 'packs.aside'), join(base, 'packs'));
    } else {
      await assert.rejects(exportIt(base), (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && e.message.startsWith(`${join(base, 'packs')} cannot be listed (EACCES) — the export reconciles`));
    }
  } finally {
    try { chmodSync(join(base, 'packs'), 0o755); } catch { /* a file, or already restored */ }
  }
  await read(base, (db) => assert.equal(actions(db).length, before.rows));
  await start(base);
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

test('Export gate: one org at the workspace root on a deployment that had an orgs.json — orgs.json written, the default org moved (A-30)', async () => {
  const base = tempDir();
  usersJson(base, ['alice']);
  pack(base, 'p1');
  await start(base);
  // The one case the rule alone decides: one live org, kept at '.', and the
  // import report recording that the deployment had an orgs.json.
  await change(base, (db) => tx(db, () => {
    meta.putMeta(db, 'import_report', JSON.stringify({ ...meta.getMetaJson(db, 'import_report'), orgsJson: true }));
  }));
  await read(base, (db) => {
    assert.deepEqual(listOrgs(db).map((o) => [o.id, o.root]), [['default', '.']]);
  });

  const r = await exportIt(base);
  assert.equal(r.orgs.path, join(base, 'orgs.json'));
  assert.deepEqual(r.orgs.ids, ['default']);
  assert.deepEqual(r.move, ['packs']);
  assert.deepEqual(JSON.parse(readFileSync(join(base, 'orgs.json'), 'utf8')), {
    default: { name: 'Default', members: { alice: 'admin' } },
  });
  assert.equal(existsSync(join(base, 'packs')), false, 'packs moved');
  assert.deepEqual(pre.boot(base), { migrated: [] });
  assert.deepEqual(pre.packIds(base, 'default'), ['p1']);
  await read(base, (db) => assert.equal(getOrg(db, 'default').root, 'orgs/default'));
  await start(base);
});

test('export to a directory: only reads the store, never overwrites — a second export into it is refused as not empty', async () => {
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
    await assert.rejects(exportIt(base, dir), (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && e.message.includes(`${dir} is not empty`));
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

test('export: a workspace its marker was lost from — this store\'s database beside its org data, no users.json — is refused as a directory export, naming the in-place export that works', async () => {
  const base = tempDir();
  usersJson(base, ['alice']);
  await start(base);
  await change(base, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'alice', base }));
  pack(join(base, 'orgs', 'acme'), 'a1');   // org data only: no flat entry at the base
  rmSync(join(base, 'users.json'));
  rmSync(legacy.markerPath(base));
  const elsewhere = join(tempDir('ops-cwd'), '.observogram');   // OBSERVOGRAM_WORKSPACE unset, another cwd
  const named = (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && e.message.includes(`OBSERVOGRAM_WORKSPACE=${base} packc store export ${base} to export in place`);
  await assert.rejects(exportStore(base, { dbPath: dbOf(base), base: elsewhere, out: silent }), named);
  assert.equal(existsSync(join(base, 'orgs.json')), false);
  assert.equal(existsSync(join(base, 'users.json')), false);
  assert.equal(existsSync(elsewhere), false);
  // The way out, followed literally: the in-place export, and the next start takes what it wrote.
  assert.equal((await exportStore(base, { dbPath: dbOf(base), base, out: silent })).inPlace, true);
  await start(base);
});

test('export: another store\'s workspace is never exported into — the directory export refuses it as not empty, and the in-place export refuses when the marker names another store, naming both stores', async () => {
  const w1 = tempDir();
  usersJson(w1, ['alice']);
  pack(w1, 's1');
  await start(w1);
  await change(w1, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'alice', base: w1 }));
  const w2 = tempDir();
  usersJson(w2, ['bob']);
  pack(w2, 's2');
  await start(w2);
  rmSync(join(w2, 'users.json'));   // as an OIDC deployment: nothing of store A's to trip over but the marker
  const idA = await read(w1, (db) => meta.storeId(db));
  const idB = await read(w2, (db) => meta.storeId(db));
  assert.notEqual(idA, idB);
  const markerBefore = readFileSync(legacy.markerPath(w2), 'utf8');
  const both = (e) => e.message.includes(idA) && e.message.includes(idB);

  // The directory export from w1's shell (workspace unset): w2 is not empty. Its in-place way out holds only for this
  // store's own workspace; followed for w2 anyway (OBSERVOGRAM_WORKSPACE=w2), it is an in-place export into w2: refused.
  const elsewhere = join(tempDir('ops-cwd'), '.observogram');
  await assert.rejects(exportStore(w2, { dbPath: dbOf(w1), base: elsewhere, out: silent }),
    (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && e.message.includes(`${w2} is not empty`));
  await assert.rejects(exportStore(w2, { dbPath: dbOf(w1), base: w2, out: silent }),
    (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && both(e) && e.message.includes('OBSERVOGRAM_DB'));
  assert.equal(readFileSync(legacy.markerPath(w2), 'utf8'), markerBefore);
  assert.equal(existsSync(join(w2, 'users.json')), false);
  assert.equal(existsSync(join(w2, 'orgs.json')), false);
  assert.equal(existsSync(join(w2, 'orgs')), false);
  assert.ok(existsSync(join(w2, 'packs', 's2.pack.yaml')), 'nothing moved');
  await read(w1, (db) => assert.equal(getOrg(db, 'default').root, '.'));

  // The way out works: w2's own store exports in place; this store's own marker still names it.
  assert.equal((await exportStore(w2, { dbPath: dbOf(w2), base: w2, out: silent })).storeId, idB);
  await start(w2);
  // And this store's own workspace, named from another shell, still points at OBSERVOGRAM_WORKSPACE.
  await assert.rejects(exportStore(w1, { dbPath: dbOf(w1), base: elsewhere, out: silent }),
    (e) => e.message.includes(`OBSERVOGRAM_WORKSPACE=${w1}`));
});

test('export: with the database outside the workspace (the k8s layout) a new directory beside it exports as a plain directory, the database\'s own (non-empty) directory is refused; a directory inside or around the workspace is refused naming the in-place export', async () => {
  const root = tempDir();
  const base = join(root, 'ws');
  const dbDir = join(root, 'db');
  mkdirSync(dbDir);
  const dbPath = join(dbDir, 'observogram.db');
  usersJson(base, ['alice']);
  pack(base, 'p1');
  await start(base, { OBSERVOGRAM_DB: dbPath });
  const hashes = async () => { const db = await openStore({ path: dbPath }); try { return meta.getMeta(db, 'legacy_hashes'); } finally { closeStore(dbPath); } };
  const hashesBefore = await hashes();
  // The directory holding the database is not empty: refused, nothing written beside the database.
  await assert.rejects(exportStore(dbDir, { dbPath, base, out: silent }),
    (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && e.message.includes(`${dbDir} is not empty`));
  assert.equal(existsSync(join(dbDir, 'users.json')), false);
  // A new directory beside the database (the k8s recipe's export-<timestamp>): a plain directory export, the store
  // and the workspace untouched.
  const fresh = join(dbDir, 'export-20260925120000');
  const r = await exportStore(fresh, { dbPath, base, out: silent });
  assert.equal(r.inPlace, false);
  assert.ok(existsSync(join(fresh, 'users.json')));
  assert.equal(existsSync(legacy.markerPath(fresh)), false, 'no marker written by a directory export');
  const hashesAfter = await hashes();
  assert.equal(hashesAfter, hashesBefore, 'legacy_hashes untouched');
  // The real case: a directory inside the workspace, or one holding it. The way out is the in-place export,
  // never a workspace setting that writes legacy files elsewhere.
  const refusedInPlace = (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && e.message.includes(`packc store export ${base}`)
    && !e.message.includes('OBSERVOGRAM_WORKSPACE=');
  await assert.rejects(exportStore(join(base, 'rollback'), { dbPath, base, out: silent }), refusedInPlace);
  await assert.rejects(exportStore(root, { dbPath, base, out: silent }), refusedInPlace);
  assert.equal(existsSync(join(base, 'rollback')), false);
  assert.equal(existsSync(join(root, 'users.json')), false);
  // The workspace itself still exports in place.
  assert.equal((await exportStore(base, { dbPath, base, out: silent })).inPlace, true);
  await start(base, { OBSERVOGRAM_DB: dbPath });   // starts on what the export wrote, no refusal
});

test('export: a directory export writes only into a new or empty directory — a live workspace its marker was lost from (its database in db/, or no flat entry) is refused naming the in-place export, and the way out works', async () => {
  const elsewhere = join(tempDir('ops-cwd'), '.observogram');   // OBSERVOGRAM_WORKSPACE unset, another cwd
  const inPlaceNamed = (ws) => (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED'
    && e.message.includes(`${ws} is not empty`) && e.message.includes('choose an empty or new directory')
    && e.message.includes(`OBSERVOGRAM_WORKSPACE=${ws} packc store export ${ws}`);
  // A: the database in <workspace>/db, org data, no users.json and no marker.
  const d1 = tempDir();
  const db1 = join(d1, 'db', 'observogram.db');
  usersJson(d1, ['alice']);
  pack(d1, 'p');
  await start(d1, { OBSERVOGRAM_DB: db1 });
  { const db = await openStore({ path: db1 }); try { admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'alice', base: d1 }); } finally { closeStore(db1); } }
  rmSync(join(d1, 'users.json'));
  rmSync(legacy.markerPath(d1));
  await assert.rejects(exportStore(d1, { dbPath: db1, base: elsewhere, out: silent }), inPlaceNamed(d1));
  assert.equal(existsSync(join(d1, 'users.json')), false);
  assert.equal(existsSync(join(d1, 'orgs.json')), false);
  // Followed literally: the in-place export, and the next start takes what it wrote.
  assert.equal((await exportStore(d1, { dbPath: db1, base: d1, out: silent })).inPlace, true);
  await start(d1, { OBSERVOGRAM_DB: db1 });

  // B: the database in the workspace root, no flat entry and no org data.
  const d2 = tempDir();
  usersJson(d2, ['alice']);
  await start(d2);
  rmSync(join(d2, 'users.json'));
  rmSync(legacy.markerPath(d2));
  rmSync(join(d2, 'packs'), { recursive: true, force: true });
  await assert.rejects(exportStore(d2, { dbPath: dbOf(d2), base: elsewhere, out: silent }), inPlaceNamed(d2));
  assert.equal(existsSync(join(d2, 'users.json')), false);
  assert.equal(existsSync(join(d2, 'orgs.json')), false);
  assert.equal((await exportStore(d2, { dbPath: dbOf(d2), base: d2, out: silent })).inPlace, true);
  await start(d2);
});

test('export: a directory export into another store\'s markerless workspace is refused — nothing written, its next start passes', async () => {
  const t1 = tempDir();
  usersJson(t1, ['alice']);
  pack(t1, 's1');
  await start(t1);
  const t2 = tempDir();
  usersJson(t2, ['bob']);
  pack(t2, 's2');
  await start(t2);
  rmSync(join(t2, 'users.json'));
  rmSync(legacy.markerPath(t2));
  const elsewhere = join(tempDir('ops-cwd'), '.observogram');
  await assert.rejects(exportStore(t2, { dbPath: dbOf(t1), base: elsewhere, out: silent }),
    (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && e.message.includes(`${t2} is not empty`));
  assert.equal(existsSync(join(t2, 'users.json')), false);
  assert.equal(existsSync(join(t2, 'orgs.json')), false);
  await start(t2);
});

test('export: a directory export targets a new or empty directory only — an empty one and a symlink to an absent or empty one export; a file, a non-empty symlink target and a non-empty directory are refused', { skip: win32Skip(WIN32.symlinks) }, async () => {
  const base = tempDir();
  usersJson(base, ['alice']);
  await start(base);
  const root = tempDir('ops-out');
  const refusedNotEmpty = (p) => (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && e.message.includes(`${p} is not empty`)
    && e.message.includes('choose an empty or new directory');
  // Empty: exports.
  const empty = join(root, 'empty');
  mkdirSync(empty);
  assert.equal((await exportIt(base, empty)).inPlace, false);
  assert.ok(existsSync(join(empty, 'users.json')));
  // Now not empty: refused, never overwritten.
  const before = readFileSync(join(empty, 'users.json'));
  await assert.rejects(exportIt(base, empty), refusedNotEmpty(empty));
  assert.deepEqual(readFileSync(join(empty, 'users.json')), before);
  // A directory with any entry (not only users.json / orgs.json) is refused.
  const other = join(root, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'notes.txt'), 'x');
  await assert.rejects(exportIt(base, other), refusedNotEmpty(other));
  assert.deepEqual(readdirSync(other), ['notes.txt']);
  // A symlink to an empty directory exports into it; to an absent one creates it; to a non-empty one is refused.
  const emptyTarget = join(root, 'empty-target');
  mkdirSync(emptyTarget);
  symlinkSync(emptyTarget, join(root, 'link-empty'));
  await exportIt(base, join(root, 'link-empty'));
  assert.ok(existsSync(join(emptyTarget, 'users.json')));
  symlinkSync(join(root, 'absent-target'), join(root, 'link-absent'));
  await exportIt(base, join(root, 'link-absent'));
  assert.ok(existsSync(join(root, 'absent-target', 'users.json')));
  symlinkSync(other, join(root, 'link-full'));
  await assert.rejects(exportIt(base, join(root, 'link-full')), (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && e.message.includes(other));
  assert.deepEqual(readdirSync(other), ['notes.txt']);
  // A file is refused.
  writeFileSync(join(root, 'file'), 'x');
  await assert.rejects(exportIt(base, join(root, 'file')), (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && /is not a directory/.test(e.message));
});

test('export: users.json holds password hashes — a new one is created 0600, an existing one keeps its mode, no .tmp left behind', { skip: win32Skip(WIN32.modes) }, async () => {
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

// The org's live pack (live/, STORE_PLAN slice 3) is org data: it moves with
// the default org, and a conflicting twin refuses naming it.
function livePack(root, text = 'name: production-live\n') {
  mkdirSync(join(root, 'live'), { recursive: true });
  writeFileSync(join(root, 'live', 'production-live.pack.yaml'), text);
}

test('in place: the default org at . plus a created org — <base>/live moves to orgs/default/live; a conflicting orgs/default/live refuses naming it', async () => {
  const refusedMsg = (re) => (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && re.test(e.message);
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // A conflict first: nothing moves.
  const clash = tempDir();
  usersJson(clash, ['alice']);
  pack(clash, 'p1');
  livePack(clash);
  await start(clash);
  await change(clash, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'alice', base: clash }));
  livePack(join(clash, 'orgs', 'default'), 'name: someone-elses\n');
  await assert.rejects(exportIt(clash), refusedMsg(new RegExp(`already holds ${esc(join(clash, 'orgs', 'default', 'live'))} — nothing was changed`)));
  assert.ok(existsSync(join(clash, 'live', 'production-live.pack.yaml')), 'the default org\'s live pack stays at the base');
  assert.ok(existsSync(join(clash, 'packs', 'p1.pack.yaml')));

  // No conflict: live/ moves with the rest.
  const base = tempDir();
  usersJson(base, ['alice']);
  pack(base, 'p1');
  livePack(base, 'name: the-default-orgs\n');
  await start(base);
  await change(base, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'alice', base }));
  livePack(join(base, 'orgs', 'acme'), 'name: acmes\n');
  const r = await exportIt(base);
  assert.deepEqual(r.move, ['packs', 'live']);
  assert.equal(existsSync(join(base, 'live')), false, 'live moved');
  assert.equal(readFileSync(join(base, 'orgs', 'default', 'live', 'production-live.pack.yaml'), 'utf8'), 'name: the-default-orgs\n');
  assert.equal(readFileSync(join(base, 'orgs', 'acme', 'live', 'production-live.pack.yaml'), 'utf8'), 'name: acmes\n', 'the created org\'s own is untouched');
  // A store build starts on it: nothing left behind.
  const { warns } = await start(base);
  assert.deepEqual(warns.filter((w) => /left behind/.test(w)), []);
});

test('in place: a flat one-org deployment — nothing moves, <base>/live stays at the base', async () => {
  const base = tempDir();
  usersJson(base, ['alice']);
  pack(base, 'p1');
  livePack(base);
  await start(base);
  const r = await exportIt(base);
  assert.deepEqual(r.move, []);
  assert.ok(existsSync(join(base, 'live', 'production-live.pack.yaml')));
  const { warns } = await start(base);
  assert.deepEqual(warns.filter((w) => /left behind/.test(w)), []);
});

test('a <base>/live nothing reads (the default org at orgs/default) is named at the start: left behind, merge it by hand', async () => {
  const base = tempDir();
  usersJson(base, ['alice']);
  pack(base, 'p1');
  await start(base);
  await change(base, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'alice', base }));
  await exportIt(base);
  await read(base, (db) => assert.equal(getOrg(db, 'default').root, 'orgs/default'));
  livePack(base);   // a pre-store round trip, or a hand copy, left one at the base
  const { warns } = await start(base);
  assert.ok(warns.includes(`[store] left behind: ${join(base, 'live')} — nothing reads it (the default org's copy is orgs/default/live); merge it by hand`), warns.join('\n'));
});

test('an empty <base>/live (the default org at orgs/default) is removed at the start, as the empty <base>/packs is — nothing named left behind', async () => {
  const base = tempDir();
  usersJson(base, ['alice']);
  pack(base, 'p1');
  await start(base);
  await change(base, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'alice', base }));
  await exportIt(base);
  await read(base, (db) => assert.equal(getOrg(db, 'default').root, 'orgs/default'));
  mkdirSync(join(base, 'live'));
  const { logs, warns } = await start(base);
  assert.ok(logs.includes(`[store] removed empty leftovers of a pre-store build: ${join(base, 'live')}`), logs.join('\n'));
  assert.equal(existsSync(join(base, 'live')), false, 'the empty leftover is removed');
  assert.deepEqual(warns.filter((w) => /left behind/.test(w)), []);
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

// A store a 0.5.0 build left (import_done set, the pack registry still in
// packs/index.json: packs_imported unset, no pack row) whose only start of
// this build was refused before step 5 — README's rollback drill runs the
// export first: with no rows the reconcile would adopt every file label-null
// and overwrite the labels' only copy.
test('in place: refused while the pack registry is still only in packs/index.json (packs_imported unset) — the file keeps its labels, the next start imports them and the export then passes', async () => {
  const refused = (re) => (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && re.test(e.message);
  const base = tempDir();
  usersJson(base, ['alice']);
  pack(base, 'payments');
  const labelled = JSON.stringify({ payments: { label: 'Payments scan', source: 'upload', createdAt: 1700000000000, lastUsedAt: 1700000000000 } });
  writeFileSync(join(base, 'packs', 'index.json'), labelled);
  await start(base);
  await change(base, (db) => tx(db, () => {     // back to what 0.5.0 leaves: rows gone, the registry never imported
    runWithOrg('default', () => packsRepo.clearPacks(db, 'cli'));
    meta.putMeta(db, 'packs_imported', null);
    meta.putMeta(db, 'pack_index_hashes', null);
  }));
  writeFileSync(join(base, 'packs', 'index.json'), labelled);

  const idx = join(base, 'packs', 'index.json');
  await assert.rejects(exportIt(base), refused(new RegExp(`has not imported its pack registry \\(packs_imported is unset\\): ${idx.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} holds the labels .* Nothing was changed\\. Start the server once`)));
  assert.equal(readFileSync(idx, 'utf8'), labelled, 'the 0.5.0 index is untouched');
  await read(base, (db) => { assert.equal(meta.getMeta(db, 'packs_imported'), null); assert.deepEqual(packRows(db, 'default'), []); });

  await start(base);                             // step 5 takes the registry in, with its label
  await read(base, (db) => assert.deepEqual(packRows(db, 'default'), [['payments', 'Payments scan', 'upload']]));
  await exportIt(base);
  assert.deepEqual(Object.entries(readIndex(idx)).map(([id, e]) => [id, e.label, e.source]), [['payments', 'Payments scan', 'upload']]);
});

test('in place: a markerless workspace holding another store\'s database is refused naming it — nothing moved or written; the ways out it names work', async () => {
  const s1 = tempDir();
  usersJson(s1, ['alice']);
  pack(s1, 's1');
  await start(s1);
  await change(s1, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'alice', base: s1 }));
  const s2 = tempDir();
  usersJson(s2, ['bob']);
  pack(s2, 's2');
  await start(s2);
  rmSync(join(s2, 'users.json'));
  rmSync(legacy.markerPath(s2));
  const idA = await read(s1, (db) => meta.storeId(db));
  const idB = await read(s2, (db) => meta.storeId(db));
  const untouched = async () => {
    assert.ok(existsSync(join(s2, 'packs', 's2.pack.yaml')), 'nothing moved');
    assert.equal(existsSync(join(s2, 'orgs')), false);
    assert.equal(existsSync(join(s2, 'users.json')), false);
    assert.equal(existsSync(join(s2, 'orgs.json')), false);
    assert.equal(existsSync(legacy.markerPath(s2)), false);
    await read(s1, (db) => assert.equal(getOrg(db, 'default').root, '.'));
  };
  // OBSERVOGRAM_WORKSPACE=s2 with OBSERVOGRAM_DB at store A: s2/observogram.db holds store B.
  await assert.rejects(exportStore(s2, { dbPath: dbOf(s1), base: s2, out: silent }),
    (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && e.message.includes(`${dbOf(s2)} holds store ${idB}`) && e.message.includes(idA)
      && e.message.includes(`OBSERVOGRAM_DB=${dbOf(s2)}`) && e.message.includes('choose an empty or new directory'));
  await untouched();
  // Another store's database directly in <base>/db, as a *.db file: refused the same way.
  mkdirSync(join(s2, 'db'));
  copyFileSync(dbOf(s2), join(s2, 'db', 'b.db'));
  const s3 = tempDir();
  usersJson(s3, ['carol']);
  await start(s3);
  rmSync(legacy.markerPath(s3));
  copyFileSync(dbOf(s2), join(s3, 'db-b.db'));   // a *.db at the base that is another store
  await assert.rejects(exportStore(s3, { dbPath: dbOf(s3), base: s3, out: silent }),
    (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && e.message.includes(`${join(s3, 'db-b.db')} holds store ${idB}`));
  rmSync(join(s3, 'db-b.db'));
  // An unreadable *.db is refused naming it; moved out of the workspace, the export runs.
  mkdirSync(join(s3, 'db'));
  writeFileSync(join(s3, 'db', 'junk.db'), 'not a database, not at all, not even a little bit of one');
  await assert.rejects(exportStore(s3, { dbPath: dbOf(s3), base: s3, out: silent }),
    (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && e.message.includes(`${join(s3, 'db', 'junk.db')} cannot be read as a store`)
      && e.message.includes(`Move ${join(s3, 'db', 'junk.db')} out of ${s3}, then run the export again`));
  renameSync(join(s3, 'db', 'junk.db'), join(tempDir('ops-aside'), 'junk.db'));
  // A backup of this store beside it is this store's: no refusal.
  await backupStore(join(s3, 'db', 'mine.db'), { dbPath: dbOf(s3) });
  assert.equal((await exportStore(s3, { dbPath: dbOf(s3), base: s3, out: silent })).inPlace, true);
  await start(s3);
  // The ways out s2's refusal names, followed literally: store B exports in place; store A to a new directory.
  rmSync(join(s2, 'db'), { recursive: true });
  assert.equal((await exportStore(s2, { dbPath: dbOf(s2), base: s2, out: silent })).storeId, idB);
  await start(s2);
  const fresh = join(tempDir('ops-out'), 'export');
  assert.equal((await exportStore(fresh, { dbPath: dbOf(s1), base: s2, out: silent })).storeId, idA);
});

test('in place: a corrupt marker refuses naming it — the directory export\'s way out leads there, and its own way out (move it aside, export again) works', async () => {
  const c1 = tempDir();
  usersJson(c1, ['alice']);
  pack(c1, 'p');
  await start(c1);
  writeFileSync(legacy.markerPath(c1), '{not json');
  const elsewhere = join(tempDir('ops-cwd'), '.observogram');
  // From another shell: the directory export refuses, naming the in-place export.
  await assert.rejects(exportStore(c1, { dbPath: dbOf(c1), base: elsewhere, out: silent }),
    (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && e.message.includes(`OBSERVOGRAM_WORKSPACE=${c1} packc store export ${c1}`));
  // Followed: the corrupt-marker refusal, naming the marker and a way out that works.
  const aside = `${legacy.markerPath(c1)}.corrupt`;
  await assert.rejects(exportStore(c1, { dbPath: dbOf(c1), base: c1, out: silent }),
    (e) => e.code === 'ERR_OBSERVOGRAM_LEGACY_FILE' && e.message.startsWith(`${legacy.markerPath(c1)}: `)
      && e.message.includes(`with the server stopped, move it aside (mv ${legacy.markerPath(c1)} ${aside}), then run the export again`));
  assert.ok(existsSync(join(c1, 'packs', 'p.pack.yaml')), 'nothing moved');
  assert.equal(existsSync(join(c1, 'orgs.json')), false);
  // Followed: the export runs, writes a new marker, and the next start takes it.
  renameSync(legacy.markerPath(c1), aside);
  const r = await exportStore(c1, { dbPath: dbOf(c1), base: c1, out: silent });
  assert.equal(r.inPlace, true);
  assert.equal(legacy.readMarker(c1).storeId, r.storeId);
  await start(c1);
});

test('in place: with no marker, only a workspace holding this store\'s database is exported in place — a directory that does not exist, an unrelated one and a workspace whose database lives outside it are refused, nothing written; the k8s way out (start once, export) works', async () => {
  const root = tempDir('ops-k8s2');
  const ws = join(root, 'workspace');
  const dbDir = join(root, 'db');
  mkdirSync(ws);
  mkdirSync(dbDir);
  const dbPath = join(dbDir, 'observogram.db');
  usersJson(ws, ['alice']);
  pack(ws, 'p');
  const at = async (fn) => { const db = await openStore({ path: dbPath }); try { return fn(db); } finally { closeStore(dbPath); } };
  await start(ws, { OBSERVOGRAM_DB: dbPath });
  const id = await at((db) => meta.storeId(db));
  const hashes = () => at((db) => JSON.stringify(meta.getMetaJson(db, 'legacy_hashes', {})));
  const before = await hashes();
  // A workspace that does not exist.
  const gone = join(root, 'nowhere');
  await assert.rejects(exportStore(gone, { dbPath, base: gone, out: silent }),
    (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && e.message.includes(`the workspace ${gone} does not exist`));
  assert.equal(existsSync(gone), false);
  // An unrelated directory with no marker and no database: not provably this store's.
  const junk = join(root, 'junk');
  mkdirSync(junk);
  writeFileSync(join(junk, 'notes.txt'), 'x');
  await assert.rejects(exportStore(junk, { dbPath, base: junk, out: silent }),
    (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && e.message.includes(`${legacy.markerPath(junk)} is missing and ${dbPath} lives outside ${junk}`));
  assert.deepEqual(readdirSync(junk), ['notes.txt']);
  // This store's own workspace (k8s layout) with its marker lost: refused the same way, nothing written.
  rmSync(legacy.markerPath(ws));
  await assert.rejects(exportStore(ws, { dbPath, base: ws, out: silent }),
    (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED'
      && e.message.includes(`If ${ws} is this store's workspace, start the server once with OBSERVOGRAM_WORKSPACE=${ws} and OBSERVOGRAM_DB=${dbPath}`));
  assert.ok(existsSync(join(ws, 'packs', 'p.pack.yaml')), 'nothing moved');
  assert.equal(await hashes(), before, 'legacy_hashes untouched by the refusals');
  // The way out, followed: one start rewrites the marker; the export then runs in place.
  await start(ws, { OBSERVOGRAM_DB: dbPath });
  assert.equal(legacy.readMarker(ws).storeId, id);
  assert.equal((await exportStore(ws, { dbPath, base: ws, out: silent })).inPlace, true);
});

test('export: with no workspace at the default path, the refusal of a directory holding it names no in-place export there', async () => {
  const root = tempDir('ops-nows');
  const a = join(root, 'A');
  mkdirSync(a);
  usersJson(a, ['alice']);
  await start(a);
  const missing = join(root, 'cwd', '.observogram');
  await assert.rejects(exportStore(root, { dbPath: dbOf(a), base: missing, out: silent }),
    (e) => e.code === 'ERR_OBSERVOGRAM_STORE_REFUSED' && e.message.includes(`holds the workspace ${missing}`)
      && !e.message.includes(`packc store export ${missing}`) && e.message.includes('Choose an empty directory outside the workspace'));
  assert.equal(existsSync(missing), false);
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
      memberships: { added: 1, removed: 0, changed: 0 }, sessionsEnded: 2, rootChanged: false, mode: 'local', packs: { added: 0, relabelled: 0, removed: 0 },
    });
    assert.deepEqual(meta.getMetaJson(db, 'pack_index_hashes'), { 'packs/index.json': indexHashOf(readFileSync(join(base, 'packs', 'index.json'), 'utf8')) }, 'the pack half: the file as it stands');
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
  assert.ok(!logs.some((l) => /packs:/.test(l)) && !again.logs.some((l) => /index\.json/.test(l)), 'nothing to say about the packs');
  await read(base, (db) => assert.equal(actions(db).length, rows));
});

// ---------- the Stale import gate, the pack registry (slice 4) ----------

test('Stale import, the rollback round trip: a rolled-back build registers (with a label) and relabels → the start refuses naming the index and import --replace, which takes the file in (the label kept, pack.update { via }); a rollback that only READS (lastUsedAt) passes with the bookkeeping line; a removal and a RESET refuse until the replace removes on positive evidence', async () => {
  const base = tempDir();
  usersJson(base, ['alice']);
  pack(base, 'p1');
  pack(base, 'p2');
  await start(base);
  await change(base, (db) => relabel(db, 'default', 'p2', 'Second'));
  await exportIt(base);
  const path = join(base, 'packs', 'index.json');
  const id = await read(base, (db) => meta.storeId(db));
  const exported = readIndex(path);

  // The rolled-back build: a register with a label (a new file and its entry), p1 relabelled — and p2's FILE adopted (label null,
  // source workspace, its mtime: the index it was left did not list p2, as after a rollback without a fresh export). The adoption
  // records no decision: the replace takes the register and the relabel in and leaves p2's label alone.
  pack(base, 'c');
  const now = Date.now();
  const p2m = statSync(join(base, 'packs', 'p2.pack.yaml')).mtimeMs;
  writeFileSync(path, JSON.stringify({
    ...exported, p1: { ...exported.p1, label: 'P-one' }, p2: { label: null, source: 'workspace', createdAt: p2m, lastUsedAt: p2m }, c: { label: 'C', source: 'upload', createdAt: now, lastUsedAt: now },
  }, null, 2));
  const e = await refused(base);
  assert.ok(e.message.startsWith(`refusing to start: ${path} changed since store ${id} last imported or exported it: a build before slice 4 registered, relabelled or removed a pack during a rollback (the registry it wrote: 3 entries, the store's: 3).\n`), e.message);
  assert.ok(e.message.includes('  - run `packc store import --replace`: the next start takes the file\'s entries into the store (labels and sources from the file; packs it no longer lists are removed on positive evidence), or\n'), e.message);
  assert.equal(e.nothingMoved, true);
  const before = await read(base, (db) => ({ rows: actions(db).length, packs: packRows(db, 'default') }));
  assert.deepEqual(before.packs, [['p1', null, 'workspace'], ['p2', 'Second', 'workspace']], 'nothing read into the store by the refusal');

  await requestIt(base);
  const first = await start(base);
  assert.ok(first.logs.includes('[store]   packs: default: added c · relabelled p1'), first.logs.join('\n'));
  await read(base, (db) => {
    assert.deepEqual(packRows(db, 'default'), [['p1', 'P-one', 'workspace'], ['p2', 'Second', 'workspace'], ['c', 'C', 'upload']], 'the file\'s labels and sources; c registered under the label the old build gave it');
    assert.deepEqual(actions(db).slice(before.rows), [
      'meta.set:cli:replace_requested',
      'pack.register:system:c', 'service.create:system:c', 'pack.link:system:c',
      'pack.update:system:p1', 'pack.unlink:system:p1', 'service.create:system:p-one', 'pack.link:system:p1',
      `store.replace:system:${id}`,
    ], 'by system: the replace is a boot step; the relabel re-plans the links (the label is the primary with no service binding)');
    assert.deepEqual(listAudit(db, { action: 'pack.update' })[0].detail, { fields: ['label'], via: 'replace' });
    assert.deepEqual(listAudit(db, { action: 'pack.register' })[0].detail, { label: 'C', source: 'upload', via: 'replace' });
    assert.deepEqual(listAudit(db, { action: 'store.replace' })[0].detail.packs, { added: 1, relabelled: 1, removed: 0 });
    assert.deepEqual(meta.getMetaJson(db, 'pack_index_hashes'), { 'packs/index.json': indexHashOf(readFileSync(path, 'utf8')) }, 'the file as it stands');
    assert.deepEqual(Object.keys(meta.getMetaJson(db, 'legacy_hashes')).sort(), ['orgs.json', 'users.json'], 'legacy_hashes untouched by the pack half');
  });
  assert.deepEqual((await start(base)).logs.filter((l) => /index\.json|packs:/.test(l)), [], 'the start after passes');

  // A rollback that only reads: lastUsedAt rewritten, the file re-serialised — one line, nothing refused, nothing written but the raw hash.
  const touched = readIndex(path);
  for (const k of Object.keys(touched)) touched[k].lastUsedAt += 90_000;
  writeFileSync(path, JSON.stringify(touched));
  const rows = await read(base, (db) => actions(db).length);
  const touch = await start(base);
  assert.deepEqual(touch.logs.filter((l) => /index\.json/.test(l)), [`[store] ${path} was rewritten by a build before slice 4 (lastUsedAt only — bookkeeping, not a change); the store's registry stands`]);
  assert.deepEqual((await start(base)).logs.filter((l) => /index\.json/.test(l)), [], 'once');
  await read(base, (db) => assert.equal(actions(db).length, rows, 'a read is not an edit: no row'));

  // A removal on the old build (c's file and entry gone): refused; the replace removes on positive evidence.
  rmSync(join(base, 'packs', 'c.pack.yaml'));
  const { c: _c, ...withoutC } = readIndex(path);
  writeFileSync(path, JSON.stringify(withoutC, null, 2));
  const gone = await refused(base);
  assert.ok(/the registry it wrote: 2 entries, the store's: 3\)/.test(gone.message), gone.message);
  await requestIt(base);
  const second = await start(base);
  assert.ok(second.logs.includes('[store]   packs: default: removed c (file gone)'), second.logs.join('\n'));
  await read(base, (db) => {
    assert.deepEqual(packRows(db, 'default'), [['p1', 'P-one', 'workspace'], ['p2', 'Second', 'workspace']]);
    assert.deepEqual(listAudit(db, { action: 'pack.remove' })[0].detail, { reason: 'file gone', via: 'replace' });
  });

  // A RESET on the old build (every file gone, the index {}): refused — the store's rows stand; the replace removes them all.
  for (const f of readdirSync(join(base, 'packs'))) if (f.endsWith('.pack.yaml')) rmSync(join(base, 'packs', f));
  writeFileSync(path, '{}');
  const reset = await refused(base);
  assert.ok(/the registry it wrote: 0 entries, the store's: 2\)/.test(reset.message), reset.message);
  await requestIt(base);
  const third = await start(base);
  assert.ok(third.logs.includes('[store]   packs: default: removed p1, p2 (file gone)'), third.logs.join('\n'));
  await read(base, (db) => assert.deepEqual(packRows(db, 'default'), []));
  assert.deepEqual((await start(base)).logs.filter((l) => /index\.json|packs:/.test(l)), []);
});

test('Stale import, the 0.5.0 rollback (A1): the 0.5.0 guard loop (fixture) over a slice-4 workspace after an export and a 0.5.0-style index.json rewrite does not refuse — and this build does not either; with the pack key (wrongly) in legacy_hashes the 0.5.0 loop refuses its second start', async () => {
  const base = tempDir();
  usersJson(base, ['alice']);
  pack(base, 'p1');
  await start(base);
  await exportIt(base);
  const path = join(base, 'packs', 'index.json');
  const ctx = { base, dbPath: dbOf(base), memory: false };
  // 0.5.0 reads p1 (lastUsedAt) and re-serialises the file at its flush.
  const idx = readIndex(path);
  writeFileSync(path, JSON.stringify({ p1: { ...idx.p1, lastUsedAt: idx.p1.lastUsedAt + 5_000 } }, null, 2));
  await read(base, (db) => {
    assert.deepEqual(Object.keys(meta.getMetaJson(db, 'legacy_hashes')).sort(), ['orgs.json', 'users.json']);
    assert.deepEqual(guard050(db, ctx), { changed: [], appeared: [], disappeared: [] }, 'the 0.5.0 guard never sees pack_index_hashes: it restarts');
  });
  assert.deepEqual((await start(base)).logs.filter((l) => /index\.json/.test(l)), [`[store] ${path} was rewritten by a build before slice 4 (lastUsedAt only — bookkeeping, not a change); the store's registry stands`]);
  // Had the key gone into legacy_hashes: 0.5.0's own first touch bricks its next start.
  await change(base, (db) => tx(db, () => {
    const hashes = { ...meta.getMetaJson(db, 'legacy_hashes'), 'packs/index.json': legacy.sha256File(path) };
    meta.putMeta(db, 'legacy_hashes', JSON.stringify(hashes));
  }));
  const again = readIndex(path);
  writeFileSync(path, JSON.stringify({ p1: { ...again.p1, lastUsedAt: again.p1.lastUsedAt + 5_000 } }, null, 2));
  await read(base, (db) => assert.throws(() => guard050(db, ctx), (e) => e instanceof BootRefusal050
    && e.message.startsWith(`refusing to start: ${path} changed since store ${meta.storeId(db)} last imported it`)
    && e.message.endsWith('  - or run `packc store import --replace`: the next start re-imports the files as they stand.')));
});

test('the 0.5.0 guard fixture labels the line range it copies: the verbatim block is as long as the range says', () => {
  const src = readFileSync(join(HERE, 'fixtures', 'store-050-guard.mjs'), 'utf8');
  const labels = [...src.matchAll(/lines (\d+)–(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.equal(labels.length, 2, 'the header and the inline marker both name the range');
  assert.deepEqual(labels[0], labels[1], 'both labels name the same range');
  const block = src.split(/\n *\/\/ ---- v0\.5\.0 server\/boot\.mjs lines \d+–\d+, verbatim ----\n/)[1].split(/\n *\/\/ ---- end of the verbatim copy ----/)[0];
  const [from, to] = labels[0];
  assert.equal(block.split('\n').length, to - from + 1, `the copy spans ${to - from + 1} lines, as the label says`);
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
  assert.ok(logs.includes('[store]   packs: acme: added a1'), logs.join('\n'));
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
    // The upload into acme on the old build (no index there: adopted), after the root change, in the one tx().
    assert.deepEqual(actions(db).slice(before.rows), ['org.root:system:default', 'pack.register:system:a1', 'service.create:system:a1', 'pack.link:system:a1', `store.replace:system:${id}`]);
    assert.deepEqual(listAudit(db, { action: 'pack.register' })[0].detail, { label: null, source: 'workspace', via: 'replace', adopted: true });
    assert.deepEqual(packRows(db, 'acme'), [['a1', null, 'workspace']]);
    assert.deepEqual(packRows(db, 'default'), [['p1', null, 'workspace']]);
    assert.deepEqual(listAudit(db, { action: 'org.root' })[0].detail, { from: '.', to: 'orgs/default' });
    assert.equal(meta.getMetaJson(db, 'legacy_hashes')['orgs.json'].sha256, legacy.sha256File(join(base, 'orgs.json')).sha256);
    assert.deepEqual(meta.getMetaJson(db, 'pack_index_hashes'), {
      'orgs/default/packs/index.json': indexHashOf(readFileSync(join(base, 'orgs', 'default', 'packs', 'index.json'), 'utf8')),
      'orgs/acme/packs/index.json': { absent: true },
    }, 'the moved index under its new key, the pre-move key dropped; acme recorded absent');
  });
  const again = await start(base);
  assert.deepEqual(again.warns.filter((w) => /left behind/.test(w)), []);
});

test('Stale import: the default org already moved to orgs/default by an in-place export — the replace removes the empty <base>/packs every pre-store restart leaves', async () => {
  const base = tempDir();
  usersJson(base, ['alice', 'bob']);
  pack(base, 'p1');
  await start(base);
  await change(base, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'bob', base }));
  const r = await exportIt(base);
  assert.deepEqual(r.move, ['packs']);

  // The pre-store build: a restart (its empty <base>/packs), bob's password changed.
  pre.boot(base);
  assert.equal(existsSync(join(base, 'packs')), true);
  const usersPath = join(base, 'users.json');
  const file = readJson(usersPath);
  file.users.bob.password = hashPassword('bob-downgrade-pw');
  legacy.writeUsersFile(file, usersPath);
  await requestIt(base);

  const { logs } = await start(base);
  assert.ok(logs.includes(`[store]   removed empty leftovers of a pre-store build: ${join(base, 'packs')}`), logs.join('\n'));
  assert.ok(!logs.some((l) => /root is now/.test(l)), 'no root change: the root was already orgs/default');
  assert.equal(existsSync(join(base, 'packs')), false, 'the empty leftover is removed');
  assert.deepEqual(pre.packIds(base, 'default'), ['p1']);
  await read(base, (db) => assert.equal(getOrg(db, 'default').root, 'orgs/default'));
});

test('Round trip: export → a pre-store restart (its empty <base>/packs) → a store start with no replace removes the empty leftover and keeps anything with data', async () => {
  const base = tempDir();
  usersJson(base, ['alice', 'bob']);
  pack(base, 'p1');
  await start(base);
  await change(base, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'bob', base }));
  assert.deepEqual((await exportIt(base)).move, ['packs']);

  pre.boot(base);
  assert.equal(existsSync(join(base, 'packs')), true);
  mkdirSync(join(base, 'snapshots'));
  writeFileSync(join(base, 'snapshots', 'kept.json'), '{}');

  const { logs, warns } = await start(base);
  assert.ok(logs.includes(`[store] removed empty leftovers of a pre-store build: ${join(base, 'packs')}`), logs.join('\n'));
  assert.equal(existsSync(join(base, 'packs')), false, 'the empty leftover is removed');
  assert.equal(existsSync(join(base, 'snapshots', 'kept.json')), true, 'data is never removed');
  assert.ok(warns.some((w) => w.startsWith(`[store] left behind: ${join(base, 'snapshots')}`)), warns.join('\n'));
  assert.deepEqual(pre.packIds(base, 'default'), ['p1']);

  // A second start has nothing to remove: no line.
  assert.ok(!(await start(base)).logs.some((l) => /removed empty leftovers/.test(l)));
});

// The real server's start in a child whose fs.rmdirSync fails with EBUSY
// on <base>/packs, as a mount point there does (node:fs named imports are
// synced to the stub): { status, stdout, stderr }.
const INDEX_URL = pathToFileURL(join(HERE, 'index.mjs')).href;
const BUSY_RMDIR_START = `
const fs = (await import('node:fs')).default;
const { syncBuiltinESMExports } = await import('node:module');
const { join } = await import('node:path');
const busy = join(process.env.OBSERVOGRAM_WORKSPACE, 'packs');
const real = fs.rmdirSync;
fs.rmdirSync = (p, ...rest) => {
  if (String(p) === busy) throw Object.assign(new Error(\`EBUSY: resource busy or locked, rmdir '\${p}'\`), { code: 'EBUSY' });
  return real(p, ...rest);
};
syncBuiltinESMExports();
const { start } = await import(${JSON.stringify(INDEX_URL)});
const srv = await start({ port: 0, host: '127.0.0.1' });
process.stdout.write('LISTENING ' + srv.address().port + '\\n');
srv.close();
process.exit(0);
`;

test('Round trip: an empty leftover the start cannot remove (rmdir fails with EBUSY) is one warn line naming it and the code; the server still listens', async () => {
  const base = tempDir();
  usersJson(base, ['alice', 'bob']);
  pack(base, 'p1');
  await start(base);
  await change(base, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'bob', base }));
  assert.deepEqual((await exportIt(base)).move, ['packs']);
  pre.boot(base);
  assert.equal(existsSync(join(base, 'packs')), true);

  const env = { ...process.env };
  for (const k of STRIP) { delete env[`OBSERVOGRAM_${k}`]; delete env[`TOMOGRAPH_${k}`]; }
  env.OBSERVOGRAM_WORKSPACE = base;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', BUSY_RMDIR_START], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^LISTENING \d+$/m, r.stdout + r.stderr);
  const lines = r.stderr.split('\n').filter((l) => l.includes(join(base, 'packs')));
  assert.deepEqual(lines, [`[store] could not remove the empty leftover ${join(base, 'packs')} of a pre-store build (EBUSY): nothing reads it; the start goes on`], r.stderr);
  assert.equal(existsSync(join(base, 'packs')), true, 'the directory it could not remove is still there');
  assert.ok(!/removed empty leftovers/.test(r.stdout), r.stdout);
  assert.deepEqual(pre.packIds(base, 'default'), ['p1']);
});

// The real server's start in a child whose fs.rmSync and fs.rmdirSync fail
// with EBUSY on <base>/packs, as a mount point there does.
const BUSY_RM_START = BUSY_RMDIR_START.replace('fs.rmdirSync = (p, ...rest) => {', `const realRm = fs.rmSync;
fs.rmSync = (p, ...rest) => {
  if (String(p) === busy) throw Object.assign(new Error(\`EBUSY: resource busy or locked, rm '\${p}'\`), { code: 'EBUSY' });
  return realRm(p, ...rest);
};
fs.rmdirSync = (p, ...rest) => {`);

test('Stale import: an empty leftover the replace cannot remove (rm fails with EBUSY) is one warn line naming it and the code; the replace is committed and the server still listens', async () => {
  const base = tempDir();
  usersJson(base, ['alice', 'bob']);
  pack(base, 'p1');
  await start(base);
  await change(base, (db) => admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'bob', base }));
  assert.deepEqual((await exportIt(base)).move, ['packs']);
  pre.boot(base);   // its empty <base>/packs
  const usersPath = join(base, 'users.json');
  const file = readJson(usersPath);
  file.users.bob.password = hashPassword('bob-downgrade-pw');
  legacy.writeUsersFile(file, usersPath);
  await requestIt(base);

  const env = { ...process.env };
  for (const k of STRIP) { delete env[`OBSERVOGRAM_${k}`]; delete env[`TOMOGRAPH_${k}`]; }
  env.OBSERVOGRAM_WORKSPACE = base;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', BUSY_RM_START], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^LISTENING \d+$/m, r.stdout + r.stderr);
  assert.match(r.stdout, /\[store\] replaced from /, r.stdout);
  const lines = r.stderr.split('\n').filter((l) => l.includes(join(base, 'packs')));
  assert.deepEqual(lines, [`[store] could not remove the empty leftover ${join(base, 'packs')} of a pre-store build (EBUSY): nothing reads it; the start goes on`], r.stderr);
  assert.ok(!/removed empty leftovers/.test(r.stdout), r.stdout);
  assert.equal(existsSync(join(base, 'packs')), true, 'the directory it could not remove is still there');
  await read(base, (db) => {
    assert.equal(meta.getMeta(db, 'replace_requested'), null, 'the replace is committed');
    assert.ok(verifyPassword('bob-downgrade-pw', getUserByLogin(db, 'bob').password), 'the edit is in');
  });
  assert.deepEqual(pre.packIds(base, 'default'), ['p1']);
});

test('Stale import: `orgs create acme` on a pre-store build with no restart after it — the replace moves the flat workspace itself (migrateFlatWorkspace): the entries under orgs/default, the root, the journey file rewritten; the start after passes', async () => {
  const base = tempDir();
  usersJson(base, ['alice', 'bob']);
  pack(base, 'p1');
  journey(base, 'nightly', join(base, 'packs', 'p1.pack.yaml'));
  writeFileSync(join(base, 'deploys.jsonl'), '{"at":"2026-01-01T00:00:00.000Z"}\n');
  await start(base);
  await exportIt(base);

  // The pre-store build: npm run orgs -- create acme; add-member acme bob admin — and no restart, so nothing moved yet.
  legacy.writeOrgsFile({ acme: { name: 'Acme', members: { bob: 'admin' } } }, join(base, 'orgs.json'));
  assert.equal(existsSync(join(base, 'orgs', 'default')), false);
  await refused(base);
  await requestIt(base);
  const rows = await read(base, (db) => actions(db).length);

  const { logs, warns } = await start(base);
  const moved = slashed(join(base, 'orgs', 'default', 'packs', 'p1.pack.yaml'));
  for (const f of ['packs', 'deploys.jsonl', 'journeys']) {
    assert.ok(logs.some((l) => l.startsWith('[tenancy] moved ') && l.endsWith(` to ${join('orgs', 'default', f)}`)), `${f} moved\n${logs.join('\n')}`);
  }
  assert.ok(logs.includes(`[store]   the default org's root is now orgs/default — point its CronJobs at OBSERVOGRAM_WORKSPACE=${join(base, 'orgs', 'default')}`), logs.join('\n'));
  assert.ok(logs.includes('[store]   journey file: paths rewritten: nightly.journey.yaml'), logs.join('\n'));
  assert.deepEqual(warns.filter((w) => /left behind/.test(w)), []);
  for (const f of ['packs', 'deploys.jsonl', 'journeys']) assert.equal(existsSync(join(base, f)), false, `${f} is no longer at the base`);
  assert.deepEqual(pre.journeys(base, 'default'), { nightly: { packA: moved, packB: moved } });
  assert.deepEqual(pre.packIds(base, 'default'), ['p1']);
  await read(base, (db) => {
    const id = meta.storeId(db);
    assert.deepEqual(listOrgs(db).map((o) => [o.id, o.root]), [['default', 'orgs/default'], ['acme', 'orgs/acme']]);
    for (const f of [join('packs', 'p1.pack.yaml'), 'deploys.jsonl', join('journeys', 'nightly.journey.yaml')]) {
      assert.ok(existsSync(join(base, getOrg(db, 'default').root, f)), `the default org's ${f} is found`);
    }
    assert.deepEqual(actions(db).slice(rows), ['org.root:system:default', `store.replace:system:${id}`]);
    assert.deepEqual(listAudit(db, { action: 'org.root' })[0].detail, { from: '.', to: 'orgs/default' });
  });
  const again = await start(base);
  assert.deepEqual(again.warns.filter((w) => /left behind/.test(w)), []);
  assert.deepEqual(pre.journeys(base, 'default'), { nightly: { packA: moved, packB: moved } });
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

test('Stale import: orgs.json rewritten on a pre-store build without "default" — the default org is kept (never soft-removed), with its root and memberships; the others follow the file', async () => {
  const base = tempDir();
  usersJson(base, ['alice', 'bob']);
  legacy.writeOrgsFile({
    default: { name: 'Default', members: { alice: 'admin' } },
    beta: { name: 'Beta', members: { bob: 'member' } },
  }, join(base, 'orgs.json'));
  pack(base, 'p1');
  await start(base);
  await exportIt(base);
  assert.deepEqual(Object.keys(readJson(join(base, 'orgs.json'))), ['default', 'beta']);

  pre.boot(base);
  legacy.writeOrgsFile({ beta: { name: 'Beta', members: { bob: 'admin' } } }, join(base, 'orgs.json'));
  await refused(base);
  await requestIt(base);
  const { logs } = await start(base);
  assert.ok(!logs.some((l) => /removed default/.test(l)), logs.join('\n'));
  await read(base, (db) => {
    assert.equal(getOrg(db, 'default').removedAt, null, 'the default org is never soft-removed by a replace');
    assert.equal(getOrg(db, 'default').root, 'orgs/default');
    assert.deepEqual(membersOf(db, 'default'), ['alice:admin']);
    assert.deepEqual(membersOf(db, 'beta'), ['bob:admin']);
    assert.equal(getOrg(db, 'beta').removedAt, null);
  });
  assert.deepEqual(pre.packIds(base, 'default'), ['p1']);
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

// Check D refuses on plan1; the transaction re-asserts the rule for a plan2
// that diverged from it (the files changed between the two reads, §12.3).
test('Stale import: applyReplace re-asserts the owner rule inside its transaction — a plan disabling the last owner rolls back, changing nothing', async () => {
  const base = tempDir();
  usersJson(base, ['alice']);
  await start(base);
  await change(base, (db) => admin.addLocalUser(db, 'cli', { login: 'bob', password: 'bob-passw0rd', role: 'operator' }));
  await exportIt(base);
  await requestIt(base);
  await change(base, (db) => {
    const id = meta.storeId(db);
    const before = { rows: actions(db).length, users: userRows(db) };
    const alice = getUserByLogin(db, 'alice');
    assert.equal(alice.isOwner, true);
    const plan = {
      journeys: [], leftovers: [], rootChange: false, bump: [alice.id],
      orgs: { create: [], rename: [], remove: [] },
      users: { create: [], update: [[alice.id, { disabled: true }]] },
      memberships: { add: [], remove: [], role: [] },
      ownerMode: { mode: 'local' }, ownersBefore: 1,
      meta: { replace_requested: null },
      report: {
        storeId: id, users: { created: [], updated: [], disabled: ['alice'], enabled: [] },
        orgs: { created: [], renamed: [], removed: [] }, memberships: { added: [], removed: [], changed: [] },
        sessionsEnded: ['alice'], rootChanged: false, identityMode: 'local',
      },
    };
    assert.throws(() => applyReplace(db, plan, { now: new Date().toISOString() }),
      { message: `observogram store: the replace would leave store ${id} with no enabled owner — rolled back` });
    assert.deepEqual({ rows: actions(db).length, users: userRows(db) }, before);
    assert.equal(meta.getMeta(db, 'replace_requested'), id, 'the request stays pending');
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

// A flat deployment with two created orgs, acme removed (its files stay); at base, a directory that exists, if given.
async function removedOrgDeployment(base = tempDir()) {
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

test('purge-org: a removed org\'s files deleted, its keys dropped from legacy_hashes (one an older build may hold) and from pack_index_hashes (the slice-4 key), one org.purge row, the marker rewritten; the next start passes and writes no row', async () => {
  const base = await removedOrgDeployment();
  // The org's packs/index.json key: under legacy_hashes as an older build may have left it, and under pack_index_hashes as
  // slice 4 records it (an org removed after the import, trap 14; the live org beta's key stays).
  const indexKey = 'orgs/acme/packs/index.json';
  writeFileSync(join(base, indexKey), '{}\n');
  const before = await change(base, (db) => {
    const hashes = { ...meta.getMetaJson(db, 'legacy_hashes'), [indexKey]: legacy.sha256File(join(base, indexKey)) };
    tx(db, () => meta.putMeta(db, 'legacy_hashes', JSON.stringify(hashes)));
    const packHashes = { ...meta.getMetaJson(db, 'pack_index_hashes'), [indexKey]: indexHashOf('{}\n'), 'orgs/beta/packs/index.json': { absent: true } };
    tx(db, () => meta.putMeta(db, 'pack_index_hashes', JSON.stringify(packHashes)));
    return { rows: actions(db).length, hashes, packHashes };
  });
  const markerBefore = legacy.readMarker(base);

  const r = await purge(base, 'acme');
  assert.deepEqual({ deleted: r.deleted, dropped: r.dropped, droppedPackIndex: r.droppedPackIndex, root: r.root }, { deleted: true, dropped: [indexKey], droppedPackIndex: [indexKey], root: join(base, 'orgs', 'acme') });
  assert.deepEqual(formatPurge(r), [`purged org acme: deleted ${join(base, 'orgs', 'acme')}`, `dropped from legacy_hashes: ${indexKey}`, `dropped from pack_index_hashes: ${indexKey}`, `rewrote ${legacy.markerPath(base)}`]);
  assert.equal(existsSync(join(base, 'orgs', 'acme')), false);
  assert.deepEqual(readdirSync(join(base, 'orgs', 'beta', 'packs')), ['b1.pack.yaml'], 'another org\'s files stay');
  assert.ok(existsSync(join(base, 'packs', 'p1.pack.yaml')), 'the default org\'s files stay');
  const after = await read(base, (db) => {
    assert.deepEqual(actions(db).slice(before.rows), ['org.purge:cli:acme']);
    const [row] = listAudit(db, { action: 'org.purge' });
    assert.equal(row.orgId, null);
    assert.deepEqual(row.detail, { root: 'orgs/acme', deleted: true, legacyHashes: [indexKey], packIndexHashes: [indexKey] });
    const { [indexKey]: _gone, ...rest } = before.hashes;
    assert.deepEqual(meta.getMetaJson(db, 'legacy_hashes'), rest);
    const { [indexKey]: _gone2, ...restPacks } = before.packHashes;
    assert.deepEqual(meta.getMetaJson(db, 'pack_index_hashes'), restPacks, 'the other roots\' keys stay');
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

test('replace and export texts: the CLI confirmation, both usages and the README\'s quoted line name packs/index.json beside users.json / orgs.json', () => {
  // The refusal after a rollback that only registered packs names `packc store import --replace` as
  // the way to take index.json in (§5.6); the command's own confirmation and help must say it does.
  const namesPacks = (text, what) => {
    assert.match(text, /users\.json/, `${what}: names users.json`);
    assert.match(text, /orgs\.json/, `${what}: names orgs.json`);
    assert.match(text, /packs\/index\.json/, `${what}: names packs/index.json`);
  };
  namesPacks(REPLACE_REQUESTED, 'REPLACE_REQUESTED');
  const shell = { ...process.env };
  for (const k of STRIP) { delete shell[`OBSERVOGRAM_${k}`]; delete shell[`TOMOGRAPH_${k}`]; }
  const usage = (args, status) => {
    const r = spawnSync(process.execPath, [PACKC, ...args], { env: shell, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, status, `packc ${args.join(' ')}: exit ${status}`);
    return r.stderr + r.stdout;
  };
  // `packc store` alone is a usage error (2); bare `packc` prints the help and exits 0.
  for (const [args, status, re] of [[['store'], 2, /^\s*packc store (export|import) .*$/gm], [[], 0, /^\s*packc store\s+(export|import) .*$/gm]]) {
    const lines = usage(args, status).match(re) || [];
    assert.equal(lines.length, 2, `packc ${args.join(' ')}: one usage line each for export and import --replace\n${lines.join('\n')}`);
    for (const line of lines) namesPacks(line, `packc ${args.join(' ')} usage: ${line.trim()}`);
  }
  const readme = readFileSync(join(HERE, '..', 'README.md'), 'utf8');
  assert.ok(readme.includes(`\n# ${REPLACE_REQUESTED}\n`), 'the README quotes the confirmation line as the CLI prints it');
});

test('purge-org docs: the README and the k8s note say it cannot be undone, what it deletes, that a store backup holds none of it, and what it refuses before deleting; the README names each users-file refusal\'s way out as purge-org does', () => {
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
    assert.match(text, /users file a pre-store build reads/, `${name}: the users-file refusal`);
    assert.match(text, /mount point is under/, `${name}: the mount-point refusal`);
  }
  // The README names each users-file refusal's way out, as purge-org (server/store/users-file-place.mjs) names it.
  for (const way of [
    'move them out of `orgs/<id>/`, then run the purge again',
    'if the purge then refuses because the users file does not exist, delete `orgs/<id>/` by hand and run the purge again',
    'make it lead there again before you roll back',
    'mount it and run the purge again',
    'delete `orgs/<id>/` by hand and run the purge again',
    'run the purge as a user who can read it',
    'Unmount it, then run the purge again',
    'names the mounts to unmount first, in order, before you unmount it',
    'move it out of `orgs/<id>/` and unmount, then run the purge again',
    'Stop what changes files there, then run the purge again',
  ]) assert.ok(readme.includes(way), `README: ${way}`);
  const place = readFileSync(join(HERE, 'store', 'users-file-place.mjs'), 'utf8').replace(/[`']\s*\+\s*[`']/g, '');
  for (const way of ['out of ${root}, then run purge-org again', 'if it then refuses because ${file} does not exist',
    'make it lead there again before a pre-store build', 'mount it, then run purge-org again',
    'delete ${root} by hand, then run purge-org again', 'Run purge-org as a user who can read', 'Unmount it, then run purge-org again',
    ': first unmount ',
    'out of ${root} and unmount what is mounted there, then run purge-org again', 'Stop what changes files under ${root}, then run purge-org again']) {
    assert.ok(place.includes(way), `purge-org's refusal names the same way out: ${way}`);
  }
});

test('purge-org: refused for a live, default or unknown org, a root that is a symlink, a workspace whose marker names another store, a store in use, no database and :memory: — nothing deleted', async (t) => {
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

  await t.test('a root that is a symlink is refused and never followed', { skip: win32Skip(WIN32.symlinks) }, async () => {
    const elsewhere = tempDir();
    pack(elsewhere, 'x1');
    rmSync(join(base, 'orgs', 'acme'), { recursive: true });
    symlinkSync(elsewhere, join(base, 'orgs', 'acme'), 'dir');
    await assert.rejects(purge(base, 'acme'), refusedOp(/orgs\/acme is not a directory \(a symlink, never followed\)/));
    assert.ok(existsSync(join(elsewhere, 'packs', 'x1.pack.yaml')), 'the link target stays');
    rmSync(join(base, 'orgs', 'acme'));
    pack(join(base, 'orgs', 'acme'), 'a1');
  });
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

// ---------- purge-org: the users file by what deleting the root takes ----------

// The users file a pre-store build reads may have its bytes under the purged root while its path lies outside it —
// through a mount of a directory under the root, reached directly or through a link (realpath never crosses a mount
// back to its source), or as a hard link — and purge-org compared the path alone, so it deleted it. usersFilePlace
// (server/store/users-file-place.mjs) decides by what rmSync(root) would take: these run it over an injected
// filesystem (server/fixtures/mount-fs.mjs) with the mounts a test runner cannot make, on POSIX and Windows paths;
// the real-filesystem cases below run through purgeOrg itself.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ROOT_B = '/ws/orgs/beta';
const betaVolume = (opts) => mountFs(posix, opts).dir(`${ROOT_B}/packs`).file(`${ROOT_B}/packs/b1.pack.yaml`).file(`${ROOT_B}/sub/users.json`)
  .file('/srv/accounts.json');
const placeIn = (vol, file, opts = {}) => usersFilePlace(file, ROOT_B, { fs: vol.fs, path: posix, windows: false, id: 'beta', ...opts });
const underRoot = (file, entries, root = ROOT_B) => `the recorded users file ${file} lies under ${root}: it is ${entries} there — nothing was deleted. `
  + `Move ${entries} out of ${root}, then run purge-org again. If ${file} then no longer leads to the users file, make it lead there `
  + 'again before a pre-store build or the in-place `packc store export` uses it';
// The users file outside the root while an entry under it has its name: through a mount that is down, whose mount point
// holds a file of that name meanwhile, the path leads there once it is mounted again. targets: what a link of that name
// leads to under the root.
const namesake = (file, entries, { targets = [], root = ROOT_B } = {}) => {
  const listed = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
  const them = listed([...entries, ...targets].sort());
  return `the recorded users file ${file} is no file under ${root}, but ${listed(entries)} under it ${entries.length === 1 ? 'has' : 'have'} its name`
    + (targets.length ? `, and ${listed(targets)} ${targets.length === 1 ? 'is' : 'are'} what a link of that name leads to` : '')
    + ': a mount that is down keeps what was written in its mount point meanwhile, and mounted again it may lead the path there — nothing was '
    + `deleted. Move ${them} out of ${root}, then run purge-org again; if it then refuses because ${file} does not exist (the users file `
    + `seen there through a mount that cannot be traced back), delete ${root} by hand, then run purge-org again: it drops org beta's `
    + `records. If the users file is among them, make ${file} lead to it again before a pre-store build or the in-place \`packc store `
    + 'export` uses it';
};
// The users file does not exist, its path leads into a directory under the root (into), and an entry under the root has its
// name: a directory on its path may be the mount point of a mount that is down, and mounted again the path leads there.
const namesakeMissing = (file, into, entries, { targets = [], root = ROOT_B } = {}) => {
  const listed = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
  return `the recorded users file ${file} does not exist, and its path leads into ${into}${into === root ? '' : `, under ${root}`}, but `
    + `${listed(entries)} under it ${entries.length === 1 ? 'has' : 'have'} its name`
    + (targets.length ? `, and ${listed(targets)} ${targets.length === 1 ? 'is' : 'are'} what a link of that name leads to` : '')
    + ': a directory on its path may be the mount point of a mount that is down, and mounted again it may lead the path there — nothing '
    + `was deleted. Move ${listed([...entries, ...targets].sort())} out of ${root}, then run purge-org again. If the users file is among `
    + `them, make ${file} lead to it again before a pre-store build or the in-place \`packc store export\` uses it`;
};
const unknownPlace =(file, nearest, { to = null, root = ROOT_B } = {}) => `the recorded users file ${file} does not exist, and nothing on this host `
  + `tells where its path leads${to ? ` (to ${to})` : ''}: ${nearest === null ? 'no part of it exists' : `the nearest part of it that exists, ${nearest}, is no directory under ${root}`}, `
  + `and a filesystem not mounted now may lead it under ${root} — nothing was deleted. If it lies on a filesystem that is not mounted now, `
  + `mount it, then run purge-org again; if it does not lie under ${root}, delete ${root} by hand, then run purge-org again: it drops org `
  + 'beta\'s records';
const mounted = (what, root = ROOT_B) => `${root} holds a mount point, ${what}: deleting ${root} would take the files of the filesystem mounted there `
  + `(Node 23 and later) or stop part-way at it (Node 22), and a directory mounted from outside ${root} may hold the users file — `
  + 'nothing was deleted. Unmount what is mounted there, then run purge-org again';
// A mount point under the root while the users file lies under it besides: unmounted, its path may lead there no more, so
// the refusal names the entries to move out with the unmounting.
const mountedHolding = (what, file, entries, root = ROOT_B) => `${root} holds a mount point, ${what}: deleting ${root} would take the files of the `
  + `filesystem mounted there (Node 23 and later) or stop part-way at it (Node 22), and a directory mounted from outside ${root} may hold the users `
  + `file; and the recorded users file ${file} lies under ${root}: it is ${entries} there — nothing was deleted. Move ${entries} out of ${root} and `
  + 'unmount what is mounted there, then run purge-org again (unmounted, its path may no longer lead there, and nothing would keep the purge '
  + `from deleting it). If ${file} then no longer leads to the users file, make it lead there again before a pre-store build or the in-place `
  + '`packc store export` uses it';

test('purge-org users file: under the root through a bind mount that is up — by its path there, through a file link and a directory link to it, and as spelled — is refused naming its entry under the root; one outside the root is purged, also when a link under the root leads to it, to its directory or to another filesystem (rmSync deletes the link alone)', () => {
  const vol = betaVolume().dir('/mnt/b').bind(`${ROOT_B}/sub`, '/mnt/b')
    .symlink('/cfg/users.json', '/mnt/b/users.json').symlink('/cfg/d', '/mnt/b');
  for (const file of ['/mnt/b/users.json', '/cfg/users.json', '/cfg/d/users.json', `${ROOT_B}/sub/users.json`]) {
    assert.deepEqual(placeIn(vol, file), { exists: true, refusal: underRoot(file, `${ROOT_B}/sub/users.json`) }, file);
  }
  // The mount is what realpath does not cross: the same device and inode as the entry, by another path.
  assert.deepEqual([vol.fs.statSync('/mnt/b/users.json').ino, vol.fs.statSync('/mnt/b/users.json').dev],
    [vol.fs.statSync(`${ROOT_B}/sub/users.json`).ino, vol.fs.statSync(`${ROOT_B}/sub/users.json`).dev]);
  assert.deepEqual(placeIn(vol, '/srv/accounts.json'), { exists: true, refusal: null }, 'outside the root: purged');
  // A link under the root that leads out — to the users file, to its directory, to a directory on another filesystem — is
  // what rmSync deletes, never what it leads to: the walk does not follow it, so it is neither the users file nor a mount point.
  const links = betaVolume().dir('/srv7', { dev: 7n }).file('/srv7/x.json')
    .symlink(`${ROOT_B}/link.json`, '/srv/accounts.json').symlink(`${ROOT_B}/near`, '/srv').symlink(`${ROOT_B}/sub/far`, '/srv7');
  assert.deepEqual(placeIn(links, '/srv/accounts.json'), { exists: true, refusal: null }, 'links under the root that lead out: purged');
  // The users file a pre-store build reads when none was recorded: <base>/users.json, through a link into the root.
  vol.symlink('/ws/users.json', `${ROOT_B}/sub/users.json`);
  assert.equal(placeIn(vol, '/ws/users.json', { recorded: false }).refusal,
    underRoot('/ws/users.json', `${ROOT_B}/sub/users.json`).replace('the recorded users file /ws/users.json',
      'the users file /ws/users.json (the one a pre-store build reads: OBSERVOGRAM_USERS_FILE was not set at the import)'));
  // The way out, followed: the entry moved out of the root, the record leads nowhere under it.
  vol.rename(`${ROOT_B}/sub/users.json`, '/keep/users.json');
  assert.deepEqual(placeIn(vol, '/keep/users.json'), { exists: true, refusal: null });
});

test('purge-org users file: every hard link under the root is named, so one move clears them all; with none left, the purge passes', () => {
  const vol = betaVolume().hardlink('/srv/accounts.json', `${ROOT_B}/b/u.json`).hardlink('/srv/accounts.json', `${ROOT_B}/a/users.json`).dir('/keep');
  const both = `${ROOT_B}/a/users.json and ${ROOT_B}/b/u.json`;
  assert.deepEqual(placeIn(vol, '/srv/accounts.json'), { exists: true, refusal: underRoot('/srv/accounts.json', both) });
  vol.rename(`${ROOT_B}/a/users.json`, '/keep/1.json').rename(`${ROOT_B}/b/u.json`, '/keep/2.json');
  assert.deepEqual(placeIn(vol, '/srv/accounts.json'), { exists: true, refusal: null }, 'both moved out: purged, and /srv/accounts.json stays');
});

test('purge-org users file: a view through another filesystem — NFS (the inode kept), SMB (100 ns times), overlay (xino, an upper directory under the root, and one outside it), FUSE without inode numbers (whole seconds) — is refused by its size and modification time; another size or time is not; a copy that kept both reads the same (declared); moved out as the refusal says, its path through the NFS or SMB view leads to the directory under the root where nothing of it is left, and the purge passes once no entry under the root has its name, and through a view whose directories show another inode or time it is refused as a users file that does not exist — the second step the first refusal names, deleting the root by hand', () => {
  const T = 1_760_000_123_456_789_123n;
  const vol = betaVolume().file(`${ROOT_B}/sub/users.json`, { size: 117n, mtimeNs: T }).file(`${ROOT_B}/up/users.json`, { size: 90n })
    .file(`${ROOT_B}/packs/same-size.yaml`, { size: 117n, mtimeNs: T + 1_000_000_000n })
    .file(`${ROOT_B}/packs/same-time.yaml`, { size: 118n, mtimeNs: T }).dir('/srv/upper');
  const ino = vol.fs.statSync(`${ROOT_B}/sub/users.json`).ino;
  // An overlay mount with lowerdir=<root>/sub and an upper directory outside the root: its merged directory shows the
  // upper directory's inode and modification time, a file only in the lower its own, on the overlay's device.
  const [sub, upper] = [vol.fs.statSync(`${ROOT_B}/sub`), vol.fs.statSync('/srv/upper')];
  vol.view(`${ROOT_B}/sub`, '/mnt/nfs', { dev: 41n })
    .view(`${ROOT_B}/sub`, '/mnt/smb', { dev: 42n, mtimeNs: (t) => t - (t % 100n) })
    .view(`${ROOT_B}/sub`, '/mnt/ovl', { dev: 43n, ino: (i) => i | (1n << 62n) })
    .view(`${ROOT_B}/up`, '/mnt/upper', { dev: 44n, ino: () => ino + 7n })
    .view(`${ROOT_B}/sub`, '/mnt/sshfs', { dev: 45n, ino: () => 2n, mtimeNs: (t) => t - (t % 1_000_000_000n) })
    .view(`${ROOT_B}/sub`, '/mnt/merged', { dev: 48n, ino: (i) => (i === sub.ino ? upper.ino : i), mtimeNs: (t) => (t === sub.mtimeNs ? upper.mtimeNs : t) });
  for (const [file, entry] of [['/mnt/nfs/users.json', 'sub'], ['/mnt/smb/users.json', 'sub'], ['/mnt/ovl/users.json', 'sub'], ['/mnt/upper/users.json', 'up'],
    ['/mnt/sshfs/users.json', 'sub'], ['/mnt/merged/users.json', 'sub']]) {
    assert.equal(vol.fs.statSync(file).dev === vol.fs.statSync(`${ROOT_B}/${entry}/users.json`).dev, false, `${file} is another device`);
    assert.equal(placeIn(vol, file).refusal, `the recorded users file ${file} lies under ${ROOT_B}: ${ROOT_B}/${entry}/users.json under it has its size `
      + 'and modification time on another filesystem (the users file seen through a network or overlay mount, or a copy that kept '
      + `them) — nothing was deleted. Move ${ROOT_B}/${entry}/users.json out of ${ROOT_B}, then run purge-org again; if it then refuses `
      + `because ${file} does not exist (a mount whose directories show another inode or modification time than theirs under ${ROOT_B}, `
      + `as an overlay mount with an upper directory does, cannot be traced back there), delete ${ROOT_B} by hand, then run purge-org `
      + `again: it drops org beta's records. If ${file} then no longer leads to the users file, make it lead there again before a `
      + 'pre-store build or the in-place `packc store export` uses it', file);
  }
  // A FUSE view that keeps neither the size nor the time is not matched (README: known, not fixed); a view of a directory
  // shows its names, so the entries of the users file's name are refused by it.
  vol.view(`${ROOT_B}/sub`, '/mnt/fuse', { dev: 46n, ino: () => 3n, mtimeNs: () => 0n });
  assert.deepEqual(placeIn(vol, '/mnt/fuse/users.json'),
    { exists: true, refusal: namesake('/mnt/fuse/users.json', [`${ROOT_B}/sub/users.json`, `${ROOT_B}/up/users.json`]) });
  // On another device, another file with the users file's size or its time is not it; one with both reads the same.
  vol.dir('/other', { dev: 47n }).file('/other/accounts.json', { size: 117n, mtimeNs: T + 5n });
  assert.deepEqual(placeIn(vol, '/other/accounts.json'), { exists: true, refusal: null }, 'the same size, another time');
  vol.file('/other/copy.json', { size: 117n, mtimeNs: T });
  assert.match(placeIn(vol, '/other/copy.json').refusal, /^the recorded users file \/other\/copy\.json lies under \/ws\/orgs\/beta: \/ws\/orgs\/beta\/sub\/users\.json under it has its size and modification time on another filesystem/,
    'a copy that kept its size and time (cp -p) on another device is refused: a declared false refusal');
  vol.rename(`${ROOT_B}/sub/users.json`, '/keep-copy.json');
  assert.deepEqual(placeIn(vol, '/other/copy.json'), { exists: true, refusal: null }, 'its way out: moved out of the root, purged');
  // The views' way out, followed: with the users file moved out of the root, its path through the NFS or SMB view leads to
  // that view of <root>/sub — the same directory by its inode and modification time — where nothing of it is left. While
  // another entry under the root has its name (<root>/up/users.json, which the upper view above shows), a mount that is down
  // on its path may lead it there, and it is refused by that name; moved out too, the purge passes.
  for (const file of ['/mnt/nfs/users.json', '/mnt/smb/users.json']) {
    assert.deepEqual(placeIn(vol, file), { exists: false, refusal: namesakeMissing(file, `${ROOT_B}/sub`, [`${ROOT_B}/up/users.json`]) },
      `${file}: moved out, an entry of its name left`);
  }
  vol.rename(`${ROOT_B}/up/users.json`, '/keep-up.json');
  for (const file of ['/mnt/nfs/users.json', '/mnt/smb/users.json']) {
    assert.deepEqual(placeIn(vol, file), { exists: false, refusal: null }, `${file}: moved out, it leads under the root`);
  }
  // Through a view whose directories show another inode or time — the overlay's merged directory (its upper directory's),
  // an xino overlay's, an sshfs one's — nothing traces the path back to <root>/sub: refused as a users file that does not
  // exist, the second step its first refusal names, whose way out is deleting the root by hand (the real-filesystem
  // case below: then purge-org drops the records).
  for (const at of ['/mnt/merged', '/mnt/ovl', '/mnt/sshfs']) {
    assert.deepEqual(placeIn(vol, `${at}/users.json`), { exists: null, refusal: unknownPlace(`${at}/users.json`, at) }, `${at}: moved out`);
  }
});

test('purge-org users file: a mount point under the root — another filesystem, a file mounted there, one directory reached twice, a loop, the root itself, a mount of the same filesystem /proc/self/mountinfo lists (of a directory or a file) — is refused before anything is deleted, and once unmounted the purge passes; with no /proc/self/mountinfo, a same-filesystem bind mount from outside is entered as a directory; a file on another device than its directory that /proc/self/mountinfo does not list (an overlay mount\'s lower layer on another filesystem) is none, nor is a mount it lists that a later mount of another filesystem over a directory above it covers (one of its own filesystem may show the directory it is mounted on: refused, naming what to unmount first), though a mount stacked on / covers none', () => {
  const vol = betaVolume().dir('/srv5', { dev: 7n }).file('/srv5/accounts.json').bind('/srv5', `${ROOT_B}/m`);
  // The reverse of a mount view: a directory from outside mounted under the root, holding the users file.
  assert.deepEqual(placeIn(vol, '/srv5/accounts.json'), { exists: null, refusal: mounted(`${ROOT_B}/m (another filesystem than ${ROOT_B})`) });
  vol.unmount(`${ROOT_B}/m`);
  assert.deepEqual(placeIn(vol, '/srv5/accounts.json'), { exists: true, refusal: null }, 'unmounted: the users file is outside, purged');
  vol.bind('/srv5/accounts.json', `${ROOT_B}/u.json`);
  assert.equal(placeIn(vol, '/srv/accounts.json').refusal, mounted(`${ROOT_B}/u.json (another filesystem than ${ROOT_B})`), 'a file mounted there');
  vol.unmount(`${ROOT_B}/u.json`).bind(`${ROOT_B}/packs`, `${ROOT_B}/z/packs2`);
  assert.equal(placeIn(vol, '/srv/accounts.json').refusal, mounted(`${ROOT_B}/z/packs2 (the directory ${ROOT_B}/packs again)`), 'one directory reached twice');
  vol.unmount(`${ROOT_B}/z/packs2`).bind(ROOT_B, `${ROOT_B}/sub/loop`);
  assert.equal(placeIn(vol, '/srv/accounts.json').refusal, mounted(`${ROOT_B}/sub/loop (the directory ${ROOT_B} again)`), 'a loop ends');
  vol.unmount(`${ROOT_B}/sub/loop`).dir('/vol', { dev: 8n }).file('/vol/packs/b2.pack.yaml').bind('/vol', ROOT_B);
  assert.deepEqual(placeIn(vol, '/srv/accounts.json'), {
    exists: null,
    refusal: `${ROOT_B} (another filesystem than /ws/orgs) is a mount point: deleting it would take the files of the filesystem mounted there and `
      + 'then fail on the mount point itself (Node 23 and later; Node 22 fails at once) — nothing was deleted. Unmount it, then run purge-org '
      + `again: it deletes what is left at ${ROOT_B} and drops org beta's records, and the unmounted filesystem's files stay`,
  }, 'the root itself mounted');
  vol.unmount(ROOT_B);
  assert.deepEqual(placeIn(vol, '/srv/accounts.json'), { exists: true, refusal: null });
  // A bind mount from outside on the root's own filesystem is a directory to lstatSync (the same device). With no
  // /proc/self/mountinfo to list it (off Linux), the walk enters it, and the users file seen through it is named as an entry.
  vol.dir('/srv6').file('/srv6/accounts.json').bind('/srv6', `${ROOT_B}/m6`);
  assert.equal(placeIn(vol, '/srv6/accounts.json').refusal, underRoot('/srv6/accounts.json', `${ROOT_B}/m6/accounts.json`), 'no mountinfo: entered');
  // Linux lists it in /proc/self/mountinfo (a space in its path as \040), and it is refused, holding the users file or not:
  // rmSync deleted the files of the directory mounted there, outside the root (Node 23 and later), then failed on the mount
  // point (Node 22 failed there), and once the users file was moved out of it as the "lies under" refusal said, the purge
  // deleted the rest of it the same way. Unmounted, the purge passes. The root, reached through a link, is compared by its
  // real path, as the kernel lists mount points; the root itself mounted from the same filesystem is refused as a mount point.
  const linux = betaVolume({ proc: true }).dir('/srv6').file('/srv6/accounts.json').file('/srv6/other-data').dir('/srv7').file('/srv7/other-data')
    .bind('/srv6', `${ROOT_B}/m 6`);
  const same = (at, root = ROOT_B) => `${at} (the same filesystem as ${root}, listed in /proc/self/mountinfo)`;
  assert.deepEqual(placeIn(linux, '/srv6/accounts.json'), { exists: null, refusal: mounted(same(`${ROOT_B}/m 6`)) }, 'holding the users file');
  linux.unmount(`${ROOT_B}/m 6`).bind('/srv7', `${ROOT_B}/m7`);
  assert.deepEqual(placeIn(linux, '/srv6/accounts.json'), { exists: null, refusal: mounted(same(`${ROOT_B}/m7`)) }, 'holding other files');
  linux.symlink('/lnk', '/ws');
  assert.equal(usersFilePlace('/srv6/accounts.json', '/lnk/orgs/beta', { fs: linux.fs, path: posix, windows: false, id: 'beta' }).refusal,
    mounted(same('/lnk/orgs/beta/m7', '/lnk/orgs/beta'), '/lnk/orgs/beta'), 'the root through a link');
  linux.unmount(`${ROOT_B}/m7`);
  assert.deepEqual(placeIn(linux, '/srv6/accounts.json'), { exists: true, refusal: null }, 'unmounted: the users file is outside, purged');
  linux.dir('/srv8').file('/srv8/packs/b2.pack.yaml').bind('/srv8', ROOT_B);
  assert.equal(placeIn(linux, '/srv6/accounts.json').refusal, `${same(ROOT_B, '/ws/orgs')} is a mount point: deleting it would take the files of `
    + 'the filesystem mounted there and then fail on the mount point itself (Node 23 and later; Node 22 fails at once) — nothing was deleted. '
    + `Unmount it, then run purge-org again: it deletes what is left at ${ROOT_B} and drops org beta's records, and the unmounted filesystem's `
    + 'files stay', 'the root itself, from the same filesystem');
  linux.unmount(ROOT_B);
  assert.deepEqual(placeIn(linux, '/srv6/accounts.json'), { exists: true, refusal: null });
  // A mount that a later one covers — a filesystem mounted on /ws over a tree that held mounts already (fstab entries
  // mounted out of order, an autofs mount over a directory that holds mounts) — is listed in /proc/self/mountinfo still,
  // on the filesystem now hidden, while its path shows a plain directory of the filesystem mounted above: nothing is
  // mounted there, and the purge passes (it was refused as a mount point, and unmounting, its way out, failed: not
  // mounted). A mount in a covered mount is covered too. One made there on the filesystem above is refused, and once
  // unmounted the purge passes, the covered one listed still; the root itself likewise.
  const covering = (vol) => vol.dir('/fresh', { dev: 70n }).dir('/fresh/x').bind('/fresh', '/ws').file(`${ROOT_B}/packs/b1.pack.yaml`);
  const covered = covering(betaVolume({ proc: true }).dir('/srv6').dir('/srv7').bind('/srv6', `${ROOT_B}/m`).bind('/srv7', `${ROOT_B}/m/n`))
    .dir(`${ROOT_B}/m/n`);
  for (const at of ['m', 'm/n']) {
    assert.ok(covered.fs.readFileSync('/proc/self/mountinfo').includes(` ${ROOT_B}/${at} rw`), `${at}: listed still`);
    assert.equal(covered.fs.lstatSync(`${ROOT_B}/${at}`).dev, 70n, `${at}: a directory of the filesystem above`);
    assert.throws(() => covered.unmount(`${ROOT_B}/${at}`), { code: 'EINVAL' }, `${at}: not mounted`);
  }
  assert.deepEqual(placeIn(covered, '/srv/accounts.json'), { exists: true, refusal: null }, 'covered mounts: none is a mount point, purged');
  covered.bind('/fresh/x', `${ROOT_B}/m`);
  assert.deepEqual(placeIn(covered, '/srv/accounts.json'), { exists: null, refusal: mounted(same(`${ROOT_B}/m`)) }, 'mounted there on the filesystem above');
  covered.unmount(`${ROOT_B}/m`);
  assert.deepEqual(placeIn(covered, '/srv/accounts.json'), { exists: true, refusal: null }, 'unmounted as its refusal says: purged');
  const coveredRoot = covering(betaVolume({ proc: true }).dir('/srv8').bind('/srv8', ROOT_B));
  assert.throws(() => coveredRoot.unmount(ROOT_B), { code: 'EINVAL' }, 'the root: not mounted');
  assert.deepEqual(placeIn(coveredRoot, '/srv/accounts.json'), { exists: true, refusal: null }, 'the root, covered: purged');
  coveredRoot.bind('/fresh/x', ROOT_B);
  assert.ok(placeIn(coveredRoot, '/srv/accounts.json').refusal.startsWith(`${same(ROOT_B, '/ws/orgs')} is a mount point: `), 'the root mounted on the filesystem above');
  coveredRoot.unmount(ROOT_B);
  assert.deepEqual(placeIn(coveredRoot, '/srv/accounts.json'), { exists: true, refusal: null }, 'the root unmounted as its refusal says: purged');
  // Covered by a mount of the filesystem it lies in — /ws bound on itself (an fstab line mounted out of order), a recursive
  // bind of /ws whose copy of the mount at <root>/m was unmounted as its refusal said, or a filesystem mounted on /ws that
  // holds a bind mount of the directory it lies in — the covered mount's path shows the very directory it is mounted on,
  // which rmdir refuses while it is a mount point (rmSync deleted part of the root, then failed there with EBUSY), and
  // unmounting it at its path fails (not mounted). It is refused, naming what to unmount first; followed literally, the
  // purge passes. The root itself likewise.
  const coveredSame = (at, first, root = ROOT_B) => `${at} (the same filesystem as ${root}, listed in /proc/self/mountinfo, covered by a later `
    + `mount through which its path may show what it is mounted on: first unmount ${first})`;
  const selfBound = betaVolume({ proc: true }).dir('/srv6').file('/srv6/other-data').dir(`${ROOT_B}/m`);
  const point = selfBound.fs.lstatSync(`${ROOT_B}/m`).ino;
  selfBound.bind('/srv6', `${ROOT_B}/m`).bind('/ws', '/ws');
  assert.equal(selfBound.fs.lstatSync(`${ROOT_B}/m`).ino, point, '/ws bound on itself: <root>/m shows the directory mounted on');
  assert.throws(() => selfBound.unmount(`${ROOT_B}/m`), { code: 'EINVAL' }, '/ws bound on itself: <root>/m not mounted');
  assert.deepEqual(placeIn(selfBound, '/srv/accounts.json'), { exists: null, refusal: mounted(coveredSame(`${ROOT_B}/m`, '/ws')) }, '/ws bound on itself');
  selfBound.unmount('/ws').unmount(`${ROOT_B}/m`);
  assert.deepEqual(placeIn(selfBound, '/srv/accounts.json'), { exists: true, refusal: null }, '/ws bound on itself: unmounted as its refusal says, purged');
  const rbound = betaVolume({ proc: true }).dir('/srv6').file('/srv6/other-data').bind('/srv6', `${ROOT_B}/m`).bind('/ws', '/ws')
    .bind('/srv6', `${ROOT_B}/m`);
  assert.deepEqual(placeIn(rbound, '/srv/accounts.json'), { exists: null, refusal: mounted(same(`${ROOT_B}/m`)) }, 'a recursive bind: its copy');
  assert.throws(() => rbound.unmount('/ws'), { code: 'EBUSY' }, 'a recursive bind: busy while its copy is mounted');
  rbound.unmount(`${ROOT_B}/m`);
  assert.deepEqual(placeIn(rbound, '/srv/accounts.json'), { exists: null, refusal: mounted(coveredSame(`${ROOT_B}/m`, '/ws')) },
    'a recursive bind, its copy unmounted as its refusal says');
  rbound.unmount('/ws').unmount(`${ROOT_B}/m`);
  assert.deepEqual(placeIn(rbound, '/srv/accounts.json'), { exists: true, refusal: null }, 'a recursive bind: unmounted as its refusal says, purged');
  const inAbove = betaVolume({ proc: true }).dir('/srv6').bind('/srv6', `${ROOT_B}/m`).bind('/ws', '/keep').dir('/fresh', { dev: 70n })
    .bind('/fresh', '/ws').bind('/keep/orgs', '/ws/orgs').unmount('/keep');
  assert.deepEqual(placeIn(inAbove, '/srv/accounts.json'), { exists: null, refusal: mounted(coveredSame(`${ROOT_B}/m`, '/ws/orgs, then /ws')) },
    'a bind mount of the directory it lies in, on the filesystem above');
  inAbove.unmount('/ws/orgs').unmount('/ws').unmount(`${ROOT_B}/m`);
  assert.deepEqual(placeIn(inAbove, '/srv/accounts.json'), { exists: true, refusal: null }, 'on the filesystem above: unmounted as its refusal says, purged');
  const rootBound = betaVolume({ proc: true }).bind(ROOT_B, ROOT_B).bind('/ws', '/ws');
  assert.ok(placeIn(rootBound, '/srv/accounts.json').refusal.startsWith(`${coveredSame(ROOT_B, '/ws', '/ws/orgs')} is a mount point: `),
    'the root bound on itself, /ws bound on itself');
  rootBound.unmount('/ws').unmount(ROOT_B);
  assert.deepEqual(placeIn(rootBound, '/srv/accounts.json'), { exists: true, refusal: null }, 'the root: unmounted as its refusal says, purged');
  // A mount stacked on / itself — a tmpfs mounted on / in a chroot, or `mount --bind / /` — covers nothing: a path is looked
  // up from the process's root, and a lookup never crosses a mount stacked on it, so <root>/m is reached at its path still.
  // It is refused, holding other files or the users file (it was passed over as covered: rmSync failed there with EBUSY, and
  // holding the users file, the "lies under" refusal named <root>/m/accounts.json, in the directory mounted there, to move
  // out), and once unmounted as its refusal says, the purge passes.
  for (const [how, onRoot] of [['a tmpfs mounted on /', (v) => v.dir('/fresh', { dev: 70n }).bind('/fresh', '/')], ['mount --bind / /', (v) => v.bind('/', '/')]]) {
    for (const [source, file] of [['/srv7', '/srv/accounts.json'], ['/srv6', '/srv6/accounts.json']]) {
      const stacked = onRoot(betaVolume({ proc: true }).file('/srv6/accounts.json').file('/srv7/other-data').bind(source, `${ROOT_B}/m`));
      assert.match(stacked.fs.readFileSync('/proc/self/mountinfo'), /^\d+ 21 \S+ \/ \/ /m, `${how}: listed at /, in the root's mount`);
      assert.deepEqual(stacked.fs.readdirSync(`${ROOT_B}/m`), stacked.fs.readdirSync(source), `${how}: <root>/m reached at its path`);
      assert.deepEqual(placeIn(stacked, file), { exists: null, refusal: mounted(same(`${ROOT_B}/m`)) }, `${how}: ${source} mounted there`);
      stacked.unmount(`${ROOT_B}/m`);
      assert.deepEqual(placeIn(stacked, file), { exists: true, refusal: null }, `${how}: ${source} unmounted as its refusal says, purged`);
    }
  }
  // A file on another device than its directory is a mount point only as /proc/self/mountinfo lists it (a file mounted on a
  // file, which Linux alone makes): an overlay mount whose layers lie on different filesystems (xino=off) shows its
  // directories on its own device and a lower layer's files on that layer's, with nothing mounted there, and the purge
  // passes (it was refused as a mount point, and unmounting, its way out, could not be followed). A file from another
  // filesystem mounted on a file under the root is listed, and refused. With no /proc/self/mountinfo to tell, a file on
  // another device is refused as one mounted there (above).
  linux.file(`${ROOT_B}/packs/lower.pack.yaml`, { dev: 60n }).file(`${ROOT_B}/sub/lower.json`, { dev: 60n });
  assert.deepEqual(placeIn(linux, '/srv6/accounts.json'), { exists: true, refusal: null }, 'an overlay\'s lower-layer files: no mount point');
  linux.dir('/srv9', { dev: 9n }).file('/srv9/x.json').bind('/srv9/x.json', `${ROOT_B}/packs/m.json`);
  assert.equal(placeIn(linux, '/srv6/accounts.json').refusal, mounted(`${ROOT_B}/packs/m.json (another filesystem than ${ROOT_B}/packs)`),
    'a file from another filesystem mounted on a file, listed');
  linux.unmount(`${ROOT_B}/packs/m.json`);
  assert.deepEqual(placeIn(linux, '/srv6/accounts.json'), { exists: true, refusal: null });
  // A file of the root's own filesystem mounted on a file under it is a file to lstatSync (the same device), and listed:
  // refused, holding the users file or not. Passed, rmSync failed there with EBUSY, and the users file mounted there was
  // refused as an entry under the root to move out, which fails on a mount point (mv: Device or resource busy). Unmounted
  // as its refusal says, the purge passes.
  linux.file('/srv6/src.json').file(`${ROOT_B}/m.json`).bind('/srv6/src.json', `${ROOT_B}/m.json`);
  for (const file of ['/srv6/accounts.json', '/srv6/src.json']) {
    assert.deepEqual(placeIn(linux, file), { exists: null, refusal: mounted(same(`${ROOT_B}/m.json`)) }, `a file of the same filesystem mounted on a file: ${file}`);
  }
  linux.unmount(`${ROOT_B}/m.json`);
  assert.deepEqual(placeIn(linux, '/srv6/src.json'), { exists: true, refusal: null }, 'unmounted as its refusal says: purged');
  // /proc/self/mountinfo there but unreadable: nothing tells which directory is a mount point, so it is refused.
  const locked = { ...linux.fs, readFileSync: (p) => { throw Object.assign(new Error(`EACCES: ${p}`), { code: 'EACCES' }); } };
  assert.equal(placeIn({ fs: locked }, '/srv6/accounts.json').refusal, `/proc/self/mountinfo cannot be read (EACCES), so purge-org cannot tell what `
    + `deleting ${ROOT_B} takes — nothing was deleted. Run purge-org as a user who can read it; or, if the recorded users file /srv6/accounts.json `
    + `does not lie under ${ROOT_B}, delete ${ROOT_B} by hand as such a user, then run purge-org again: it drops org beta's records`);
});

test('purge-org users file: a directory under the root this user cannot read is refused, nothing deleted, and read by a user who can, the purge passes; one it may list but not search (r--) is refused naming the entry it cannot read; one a stopped FUSE server cannot answer for is refused naming unmounting it', () => {
  const vol = betaVolume().dir(`${ROOT_B}/runs/locked`).file(`${ROOT_B}/runs/locked/r.json`).deny(`${ROOT_B}/runs/locked`);
  assert.deepEqual(placeIn(vol, '/srv/accounts.json'), {
    exists: null,
    refusal: `${ROOT_B}/runs/locked under ${ROOT_B} cannot be read (EACCES), so purge-org cannot tell what deleting ${ROOT_B} takes — nothing `
      + 'was deleted. Run purge-org as a user who can read it; or, if the recorded users file /srv/accounts.json does not lie under '
      + `${ROOT_B}, delete ${ROOT_B} by hand as such a user, then run purge-org again: it drops org beta's records`,
  });
  const reader = betaVolume().dir(`${ROOT_B}/runs/locked`).file(`${ROOT_B}/runs/locked/r.json`);
  assert.deepEqual(placeIn(reader, '/srv/accounts.json'), { exists: true, refusal: null }, 'the way out: a user who can read it');
  // A directory it may list but not search (r--): readdirSync names its entries but lstatSync of each fails (rmSync fails
  // there too) — refused naming the entry it cannot read.
  const listed = betaVolume().file(`${ROOT_B}/runs/listed/r.json`).deny(`${ROOT_B}/runs/listed`, 'EACCES', { list: true });
  assert.deepEqual(placeIn(listed, '/srv/accounts.json'), {
    exists: null,
    refusal: `${ROOT_B}/runs/listed/r.json under ${ROOT_B} cannot be read (EACCES), so purge-org cannot tell what deleting ${ROOT_B} takes — `
      + 'nothing was deleted. Run purge-org as a user who can read it; or, if the recorded users file /srv/accounts.json does not lie under '
      + `${ROOT_B}, delete ${ROOT_B} by hand as such a user, then run purge-org again: it drops org beta's records`,
  });
  // A FUSE mount under the root whose server stopped answering is no permission matter: its way out is to unmount it.
  const stale = betaVolume().dir(`${ROOT_B}/sshfs`).deny(`${ROOT_B}/sshfs`, 'ENOTCONN');
  assert.equal(placeIn(stale, '/srv/accounts.json').refusal, `${ROOT_B}/sshfs under ${ROOT_B} cannot be read (ENOTCONN), so purge-org cannot `
    + `tell what deleting ${ROOT_B} takes — nothing was deleted. If it is a filesystem mounted there that stopped answering, unmount it, then `
    + `run purge-org again; or, if the recorded users file /srv/accounts.json does not lie under ${ROOT_B}, delete ${ROOT_B} by hand, then run `
    + 'purge-org again: it drops org beta\'s records');
});

test('purge-org users file: a directory under the root that changes while the walk reads it — the directory holding the users file renamed from one not read yet into one read already, or into the root — is refused, nothing deleted, and run again with nothing changing it, the walk finds the users file; so is a change that leaves the names as they were (by its change time), and, on a coarse clock, a change that leaves the change time (by the names) and a mount over a directory read already (by its inode)', () => {
  // The users file recorded as /mnt/b/users.json, /mnt/b a bind mount of <root>/z/sub: its bytes lie under the root alone.
  // The walk reads <root>, <root>/a, <root>/packs, <root>/sub, <root>/z; another process acts at the nth lstatSync of a path
  // (the walk's is the first, the second reading's the second).
  const tree = (opts) => betaVolume(opts).dir(`${ROOT_B}/a`).file(`${ROOT_B}/z/sub/users.json`).dir('/mnt/b').bind(`${ROOT_B}/z/sub`, '/mnt/b');
  const during = (vol, file, acts) => {
    const seen = new Map();
    const lstatSync = (p, o) => {
      seen.set(p, (seen.get(p) ?? 0) + 1);
      acts[`${p}#${seen.get(p)}`]?.();
      return vol.fs.lstatSync(p, o);
    };
    return placeIn(vol, file, { fs: { ...vol.fs, lstatSync } });
  };
  const changed = (at) => ({
    exists: null,
    refusal: `${at === ROOT_B ? ROOT_B : `${at} under ${ROOT_B}`} changed while purge-org read ${at === ROOT_B ? 'it' : ROOT_B} (an entry added, `
      + `removed or renamed in it, or a mount over it), so purge-org cannot tell what deleting ${ROOT_B} takes — nothing was deleted. Stop `
      + `what changes files under ${ROOT_B}, then run purge-org again`,
  });
  assert.deepEqual(placeIn(tree(), '/mnt/b/users.json'), { exists: true, refusal: underRoot('/mnt/b/users.json', `${ROOT_B}/z/sub/users.json`) },
    'nothing changing it: refused');
  for (const coarse of [false, true]) {
    // Renamed into <root>/a, read already, before <root>/z is read: in neither listing. Unseen, the purge deleted the users file.
    const vol = tree({ coarse });
    assert.deepEqual(during(vol, '/mnt/b/users.json', { [`${ROOT_B}/packs#1`]: () => vol.rename(`${ROOT_B}/z/sub`, `${ROOT_B}/a/sub`) }),
      changed(`${ROOT_B}/a`), coarse ? 'a coarse clock: by the names' : 'by the change time and the names');
    assert.deepEqual(placeIn(vol, '/mnt/b/users.json'), { exists: true, refusal: underRoot('/mnt/b/users.json', `${ROOT_B}/a/sub/users.json`) },
      'the way out: run again with nothing changing it, the walk finds it');
    const into = tree({ coarse });
    assert.deepEqual(during(into, '/mnt/b/users.json', { [`${ROOT_B}/z#1`]: () => into.rename(`${ROOT_B}/z/sub`, `${ROOT_B}/moved`) }),
      changed(ROOT_B), 'into the root, read already');
  }
  // Renamed into <root>/a while the walk runs, then on into the root, read again already, before <root>/a is read again: <root>/a
  // has the names the walk found, and its change time moved.
  const twice = tree();
  assert.deepEqual(during(twice, '/mnt/b/users.json', {
    [`${ROOT_B}/z#1`]: () => twice.rename(`${ROOT_B}/z/sub`, `${ROOT_B}/a/sub`),
    [`${ROOT_B}/a#2`]: () => twice.rename(`${ROOT_B}/a/sub`, `${ROOT_B}/moved`),
  }), changed(`${ROOT_B}/a`), 'the same names, by the change time');
  // On a coarse clock, a directory from outside the root mounted over <root>/a once it is read, with the same names: another
  // inode. Unseen, it is a mount point under the root the walk did not refuse, and on Node 23 and later rmSync deletes the
  // files of /srv5 through it, the users file among them.
  const over = betaVolume({ coarse: true }).remove(`${ROOT_B}/sub/users.json`).file(`${ROOT_B}/a/users.json`).file('/srv5/users.json');
  assert.deepEqual(placeIn(over, '/srv5/users.json'), { exists: true, refusal: namesake('/srv5/users.json', [`${ROOT_B}/a/users.json`]) },
    'nothing mounted: outside the root, refused by the name <root>/a/users.json has (the same names as /srv5 hold)');
  assert.deepEqual(during(over, '/srv5/users.json', { [`${ROOT_B}/packs#1`]: () => over.bind('/srv5', `${ROOT_B}/a`) }),
    changed(`${ROOT_B}/a`), 'a mount over a directory read already, by its inode');
});

// A root too large to keep in memory entry by entry, made up as each entry is asked for by an injected filesystem that keeps
// none of it, the users file outside: 'files', 150 directories of 1,000 files and one of 100,000, at /ws/orgs/beta; or
// 'directories', one directory of 100,000 empty directories, the root's path 40 characters long. Each entry's stats as
// node:fs gives them with { bigint: true }, eighteen bigints. The child prints the place and how many lstatSync calls it
// answered.
const HUGE_ROOT = `
const { posix } = await import('node:path');
const { usersFilePlace } = await import(${JSON.stringify(pathToFileURL(join(HERE, 'store', 'users-file-place.mjs')).href)});
const DIRECTORIES = process.argv[1] === 'directories';
const ROOT = DIRECTORIES ? '/var/lib/observogram/workspace/orgs/beta' : '/ws/orgs/beta';
const USERS = posix.join(ROOT, '..', '..', 'users.json');
const [DIRS, FILES, WIDE] = DIRECTORIES ? [0, 0, 100_000] : [150, 1000, 100_000];
const [IFMT, IFDIR, IFREG, IFLNK] = [0o170000n, 0o040000n, 0o100000n, 0o120000n];
class BigIntStats {
  constructor(dir, ino) {
    const ns = 1_760_000_000_000_000_000n + ino * 1_000_003n;
    const ms = ns / 1_000_000n;
    Object.assign(this, { dev: 2049n, mode: (dir ? IFDIR : IFREG) | 0o644n, nlink: ino - ino + 1n, uid: ino - ino, gid: ino - ino,
      rdev: ino - ino, blksize: ino - ino + 4096n, ino, size: dir ? ino - ino + 4096n : ino - ino, blocks: ino - ino,
      atimeMs: ms, mtimeMs: ms + 0n, ctimeMs: ms + 1n, birthtimeMs: ms - 1n, atimeNs: ns, mtimeNs: ns + 0n, ctimeNs: ns + 1n, birthtimeNs: ns - 1n });
  }
  isFile() { return (this.mode & IFMT) === IFREG; }
  isDirectory() { return (this.mode & IFMT) === IFDIR; }
  isSymbolicLink() { return (this.mode & IFMT) === IFLNK; }
}
const fail = (code, p) => Object.assign(new Error(code + ': ' + p), { code });
// The root and the directories it lies in ('/', '/ws', '/ws/orgs', '/ws/orgs/beta'), then <root>/wide.
const above = ROOT.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/') || '/');
const dirs = new Map([...above.map((p, i) => [p, BigInt(i + 1)]), [ROOT + '/wide', BigInt(above.length + 1)]]);
const R = new RegExp('^' + ROOT + '/r([0-9]+)(?:/f([0-9]+)[.]json)?$');
const W = new RegExp('^' + ROOT + '/wide/w([0-9]+)' + (DIRECTORIES ? '' : '[.]json') + '$');
const RD = new RegExp('^' + ROOT + '/r[0-9]+$');
let lstats = 0;
const lstatSync = (p) => {
  lstats += 1;
  if (dirs.has(p)) return new BigIntStats(true, dirs.get(p));
  if (p === USERS) return new BigIntStats(false, BigInt(above.length + 2));
  const r = R.exec(p);
  if (r && Number(r[1]) < DIRS && Number(r[2] ?? 0) < FILES) {
    return new BigIntStats(r[2] === undefined, r[2] === undefined ? BigInt(100 + Number(r[1])) : BigInt(1_000_000 + Number(r[1]) * FILES + Number(r[2])));
  }
  const w = W.exec(p);
  if (w && Number(w[1]) < WIDE) return new BigIntStats(DIRECTORIES, BigInt(500_000_000 + Number(w[1])));
  throw fail('ENOENT', p);
};
const names = (n, name) => Array.from({ length: n }, (_, i) => Buffer.from(name(i)));
const fs = {
  lstatSync,
  statSync: lstatSync,
  readdirSync(p) {
    if (p === ROOT) return [...names(DIRS, (i) => 'r' + i), Buffer.from('wide')];
    if (p === ROOT + '/wide') return names(WIDE, (i) => 'w' + i + (DIRECTORIES ? '' : '.json'));
    if (RD.test(p)) return names(FILES, (i) => 'f' + i + '.json');
    if (DIRECTORIES && W.test(p)) return [];
    throw fail('ENOTDIR', p);
  },
  readlinkSync: (p) => { throw fail('EINVAL', p); },
  realpathSync: (p) => p,
  readFileSync: (p) => { throw fail('ENOENT', p); },
};
const place = usersFilePlace(USERS, ROOT, { fs, path: posix, windows: false, id: 'beta' });
console.log(JSON.stringify({ place, lstats }));
`;

test('purge-org users file: the walk keeps nothing of a file it passes, and of a directory\'s entries only the listings of the directories it is in — a root of 250,000 files, 150 directories of 1,000 and one of 100,000, is read in a 32 MB heap, where keeping each entry\'s stats ran out of memory, and one directory of 100,000 empty directories, the root\'s path 40 characters long, in 64 MB; so a users file created, replaced or written while the walk runs is compared with each entry again: refused as lying under the root, as when nothing changes it', () => {
  // Kept, the stats of 250,000 entries take some 175 MB: purge-org died, out of memory, where rmSync of the same tree
  // completed. Each entry is compared with the users file as the walk reaches it, and a directory's entries are taken from
  // its listing one by one as the walk goes, not pushed ahead of it.
  // Of a directory the walk keeps its path, device and inode, times and a digest of its names, and it holds the listing of
  // each directory it is in: one directory of 100,000 empty directories, the root's path 40 characters long, needs more heap
  // than the 250,000 files — 48 MB is too little.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;   // the heap limit is this child's alone
  for (const [shape, heap, entries] of [['files', 32, 250_000], ['directories', 64, 100_000]]) {
    const r = spawnSync(process.execPath, [`--max-old-space-size=${heap}`, '--input-type=module', '-e', HUGE_ROOT, shape], { env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 0, `${shape}: the child ended ${r.signal ?? r.status}: ${r.stderr.split('\n').find((l) => /heap|Error/.test(l)) ?? r.stderr.slice(0, 400)}`);
    const { place, lstats } = JSON.parse(r.stdout);
    assert.deepEqual(place, { exists: true, refusal: null }, `${shape}: the users file outside the root: purged`);
    assert.ok(lstats > entries, `${shape}: every entry read (${lstats} lstatSync calls)`);
  }
  // So the users file is placed before the walk and again after it: one created, replaced or written meanwhile — once the
  // walk has read <root>/packs, before <root>/sub — is compared with each entry again. Written in place, through an NFS view
  // of <root>/sub, within one tick of a coarse clock (its size alone moves) or to the same size (its time alone moves).
  const racing = (vol, file, act, write = null) => {
    const ino = vol.fs.statSync(`${ROOT_B}/sub/users.json`).ino;
    let acted = false;
    const as = (s) => (acted && write && s.ino === ino ? { ...s, ...write(s) } : s);
    const lstatSync = (p, o) => {
      if (!acted && p === `${ROOT_B}/packs`) { acted = true; act(); }
      return as(vol.fs.lstatSync(p, o));
    };
    return placeIn(vol, file, { fs: { ...vol.fs, lstatSync, statSync: (p, o) => as(vol.fs.statSync(p, o)) } });
  };
  const viewed = (file) => new RegExp(`^the recorded users file ${esc(file)} lies under ${esc(ROOT_B)}: ${esc(`${ROOT_B}/sub/users.json`)} under it has `
    + 'its size and modification time on another filesystem');
  // Replaced by a hard link to a file under the root that kept its size and time (cp -p): another inode alone. Its two
  // names under the root are named in the walk's order, as when nothing changes it.
  const replaced = betaVolume();
  const was = replaced.fs.statSync('/srv/accounts.json');
  replaced.file(`${ROOT_B}/sub/users.json`, { mtimeNs: was.mtimeNs }).hardlink(`${ROOT_B}/sub/users.json`, `${ROOT_B}/z.json`);
  const twoNames = { exists: true, refusal: underRoot('/srv/accounts.json', `${ROOT_B}/sub/users.json and ${ROOT_B}/z.json`) };
  assert.deepEqual(racing(replaced, '/srv/accounts.json', () => replaced.remove('/srv/accounts.json').hardlink(`${ROOT_B}/sub/users.json`, '/srv/accounts.json')),
    twoNames, 'replaced by a hard link to a file under the root');
  assert.deepEqual(placeIn(replaced, '/srv/accounts.json'), twoNames, 'nothing changing it');
  // Replaced by a link to a file of another filesystem with the same inode number (one per filesystem), size and time, while
  // a copy under the root kept that size and time: another device alone, and the copy reads as the users file.
  const other = betaVolume();
  const its = other.fs.statSync('/srv/accounts.json');
  other.file(`${ROOT_B}/sub/users.json`, { mtimeNs: its.mtimeNs }).file('/srv9/accounts.json', { mtimeNs: its.mtimeNs })
    .view('/srv9', '/mnt/srv9', { dev: 9n, ino: () => its.ino });
  assert.match(racing(other, '/srv/accounts.json', () => other.remove('/srv/accounts.json').symlink('/srv/accounts.json', '/mnt/srv9/accounts.json')).refusal ?? '',
    viewed('/srv/accounts.json'), 'replaced by a file of another filesystem with the same inode number');
  const created = betaVolume();
  assert.deepEqual(racing(created, '/srv/new.json', () => created.hardlink(`${ROOT_B}/sub/users.json`, '/srv/new.json')),
    { exists: true, refusal: underRoot('/srv/new.json', `${ROOT_B}/sub/users.json`) }, 'created as a hard link to a file under the root');
  for (const [how, write] of [['its size', (s) => ({ size: s.size + 1n })], ['its time', (s) => ({ mtimeNs: s.mtimeNs + 1_000_000_000n })]]) {
    const nfs = betaVolume().view(`${ROOT_B}/sub`, '/mnt/nfs', { dev: 41n });
    assert.match(racing(nfs, '/mnt/nfs/users.json', () => {}, write).refusal ?? '', viewed('/mnt/nfs/users.json'), `written in place, ${how} moved`);
  }
});

test('purge-org users file: a name under the root that is not valid UTF-8 is read as the bytes the filesystem holds — the users file in such a directory, reached through a link, is refused naming it as a POSIX shell\'s $\'…\' spells it (a quote and a backslash escaped), and moved out as that says, the purge passes; below such a name an entry of the users file\'s name, a mount point (also under a root whose path is not ASCII) and a directory it cannot read are refused; with the users file outside, a tree of such names passes', () => {
  // node:fs lists a name that is not valid UTF-8 as a string with U+FFFD in place of each such byte (c\xffd as 'c\ufffdd'), a
  // name no lookup finds: lstatSync of it fails with ENOENT, the walk took that for an entry gone while it ran, and so read
  // nothing of that directory, while rmSync, which lists names as bytes, deleted the users file in it. The fixture spells
  // such a byte 0xNN as U+DCNN.
  const C = `${ROOT_B}/c\udcffd`;
  const shown = (rest = '') => `$'${ROOT_B}/c\\xffd${rest}'`;
  const vol = betaVolume().remove(`${ROOT_B}/sub/users.json`).file(`${C}/users.json`).file(`${ROOT_B}/run\udce9/inner/data.json`)
    .symlink('/cfg/users.json', `${C}/users.json`).dir('/keep');
  assert.deepEqual(vol.fs.readdirSync(ROOT_B), ['c\ufffdd', 'packs', 'run\ufffd', 'sub'], 'listed as a string, as node:fs lists it');
  assert.throws(() => vol.fs.lstatSync(`${ROOT_B}/c\ufffdd`), { code: 'ENOENT' }, 'a name no lookup finds');
  assert.deepEqual(placeIn(vol, '/cfg/users.json'), { exists: true, refusal: underRoot('/cfg/users.json', shown('/users.json')) });
  // The way out, followed (mv $'/ws/orgs/beta/c\xffd/users.json' /keep/ in a shell): the link then leads under the root, where
  // nothing of the users file is left, and the users file outside a tree of such names is purged.
  vol.rename(`${C}/users.json`, '/keep/users.json');
  assert.deepEqual(placeIn(vol, '/cfg/users.json'), { exists: false, refusal: null });
  assert.deepEqual(placeIn(vol, '/keep/users.json'), { exists: true, refusal: null }, 'outside, the tree read again unchanged: purged');
  // A quote or a backslash in such a path is escaped as $'…' takes it (\' and \\), so the path named can be typed as it
  // stands: mv $'/ws/orgs/beta/it\'s\\c\xffd/users.json' /keep/ moves the users file. Unescaped, the quote ended the $'…'.
  const Q = `${ROOT_B}/it's\\c\udcffd`;
  vol.file(`${Q}/users.json`).symlink('/cfg/q.json', `${Q}/users.json`);
  assert.deepEqual(placeIn(vol, '/cfg/q.json'), { exists: true, refusal: underRoot('/cfg/q.json', `$'${ROOT_B}/it\\'s\\\\c\\xffd/users.json'`) },
    'a quote and a backslash escaped');
  vol.rename(`${Q}/users.json`, '/keep/q.json');
  assert.deepEqual(placeIn(vol, '/cfg/q.json'), { exists: false, refusal: null }, 'moved out as that says: purged');
  // Below such a name, an entry of the users file's name: a mount that is down keeps what was written in its mount point
  // meanwhile (the users file recorded as /mnt/b/users.json, /mnt/b a bind mount of <root>/c\xffd that is down, a users.json
  // written there), and mounted again the path leads to that entry. Refused by its name; moved out as that says, the purge
  // passes. Passed, the purge deleted it.
  vol.file('/mnt/b/users.json').file(`${C}/users.json`);
  assert.deepEqual(placeIn(vol, '/mnt/b/users.json'), { exists: true, refusal: namesake('/mnt/b/users.json', [shown('/users.json')]) },
    'an entry of its name below such a name');
  vol.rename(`${C}/users.json`, '/keep/b.json');
  assert.deepEqual(placeIn(vol, '/mnt/b/users.json'), { exists: true, refusal: null }, 'moved out as that says: purged');
  // Below such a name: a directory from another filesystem mounted there, a bind mount of one of the same filesystem that
  // /proc/self/mountinfo lists (the kernel writes the name's bytes, read as UTF-8 as the walk's own path is), a directory it
  // cannot read. Unmounted, the purge passes.
  const mnt = betaVolume({ proc: true }).dir('/srv5', { dev: 7n }).file('/srv5/accounts.json').dir('/srv6').file('/srv6/data.json')
    .dir(`${C}/m`).bind('/srv5', `${C}/m`);
  assert.deepEqual(placeIn(mnt, '/srv5/accounts.json'), { exists: null, refusal: mounted(`${shown('/m')} (another filesystem than ${shown()})`) });
  mnt.unmount(`${C}/m`).bind('/srv6', `${C}/m6`);
  assert.deepEqual(placeIn(mnt, '/srv5/accounts.json'),
    { exists: null, refusal: mounted(`${shown('/m6')} (the same filesystem as ${shown()}, listed in /proc/self/mountinfo)`) });
  mnt.unmount(`${C}/m6`);
  assert.deepEqual(placeIn(mnt, '/srv5/accounts.json'), { exists: true, refusal: null }, 'unmounted: purged');
  // Under a root whose path is not ASCII (a workspace at /srv/données): a path held as bytes is longer than the root's
  // characters, and the bind mount below such a name that /proc/self/mountinfo lists is refused all the same. Missed, the
  // walk entered it as a directory and the purge went on to rmSync, which failed there with EBUSY (Node 22).
  const RU = '/srv/données/orgs/beta';
  const accented = mountFs(posix, { proc: true }).dir(`${RU}/packs`).file('/srv/accounts.json').dir('/srv6').file('/srv6/data.json')
    .dir(`${RU}/c\udcffd/m6`).bind('/srv6', `${RU}/c\udcffd/m6`);
  const placeU = () => usersFilePlace('/srv/accounts.json', RU, { fs: accented.fs, path: posix, windows: false, id: 'beta' });
  assert.deepEqual(placeU(), {
    exists: null,
    refusal: mounted(`$'${RU}/c\\xffd/m6' (the same filesystem as $'${RU}/c\\xffd', listed in /proc/self/mountinfo)`, RU),
  }, 'under a root whose path is not ASCII');
  accented.unmount(`${RU}/c\udcffd/m6`);
  assert.deepEqual(placeU(), { exists: true, refusal: null }, 'unmounted as its refusal says: purged');
  mnt.dir(`${C}/locked`).deny(`${C}/locked`);
  assert.equal(placeIn(mnt, '/srv5/accounts.json').refusal, `${shown('/locked')} under ${ROOT_B} cannot be read (EACCES), so purge-org cannot `
    + `tell what deleting ${ROOT_B} takes — nothing was deleted. Run purge-org as a user who can read it; or, if the recorded users file `
    + `/srv5/accounts.json does not lie under ${ROOT_B}, delete ${ROOT_B} by hand as such a user, then run purge-org again: it drops org beta's records`);
});

test('purge-org users file on Windows paths: through a junction, through a share of a directory under the root (the volume serial\'s low 32 bits, all a share reports), and a volume mounted in a folder under the root', () => {
  const RW = 'C:\\ws\\orgs\\beta';
  const C = 0x1_0000_0007n;   // a local stat may report all 64 bits of the serial; a share only the low 32
  const vol = mountFs(win32, { fold: true, devs: { 'C:\\': C, 'D:\\': 9n } }).file(`${RW}\\sub\\users.json`).file('C:\\out\\accounts.json')
    .symlink('C:\\cfg\\d', `${RW}\\sub`)
    .view(`${RW}\\sub`, '\\\\myhost\\betasub\\', { dev: C & 0xffffffffn, mtimeNs: (t) => t - (t % 100n) });
  const placeW = (file, opts = {}) => usersFilePlace(file, RW, { fs: vol.fs, path: win32, windows: true, id: 'beta', ...opts });
  for (const file of ['C:\\cfg\\d\\users.json', '\\\\myhost\\betasub\\users.json', 'c:\\WS\\orgs\\BETA\\sub\\users.json']) {
    assert.deepEqual(placeW(file), { exists: true, refusal: underRoot(file, `${RW}\\sub\\users.json`, RW) }, `the same volume and file id: ${file}`);
  }
  assert.deepEqual(placeW('C:\\out\\accounts.json'), { exists: true, refusal: null });
  // The share's serial is the volume's: a copy under the root that kept the size and time is another file on it (another id).
  vol.file(`${RW}\\copy\\users.json`, { size: 23n, mtimeNs: vol.fs.statSync('C:\\out\\accounts.json').mtimeNs })
    .view('C:\\out', '\\\\myhost\\out\\', { dev: C & 0xffffffffn });
  assert.deepEqual(placeW('\\\\myhost\\out\\accounts.json'), { exists: true, refusal: null }, 'one volume through the share: compared by file id');
  assert.match(placeW('\\\\myhost\\out\\accounts.json', { windows: false }).refusal, /has its size and modification time on another filesystem/,
    'with all 64 bits compared, the share read as another filesystem and the copy as a view of it');
  vol.file('D:\\v\\x.txt').mountFolder('D:\\v', `${RW}\\mnt`);
  assert.match(placeW('C:\\out\\accounts.json').refusal, /^C:\\ws\\orgs\\beta holds a mount point, C:\\ws\\orgs\\beta\\mnt \(another volume mounted in it\): /);
});

test('purge-org users file that does not exist: through a mount that is down it is refused, failing closed — recorded, or, none recorded, <base>/users.json a link there; mounted again, refused as lying under the root; moved out of the root as that refusal says, the purge passes', () => {
  const vol = betaVolume().dir('/mnt/b').symlink('/cfg/users.json', '/mnt/b/users.json').symlink('/ws/users.json', '/mnt/b/users.json');
  const byDefault = (text) => text.replace('the recorded users file /ws/users.json',
    'the users file /ws/users.json (the one a pre-store build reads: OBSERVOGRAM_USERS_FILE was not set at the import)');
  // The bytes are under the root; the mount that leads there is down, so its mount point is an empty directory.
  for (const [file, to] of [['/mnt/b/users.json', null], ['/cfg/users.json', '/mnt/b/users.json']]) {
    assert.deepEqual(placeIn(vol, file), { exists: null, refusal: unknownPlace(file, '/mnt/b', { to }) }, file);
  }
  // None recorded, <base>/users.json a link through that mount is no absent default: taken for one, the purge deleted
  // <root>/sub/users.json behind the mount that is down.
  assert.deepEqual(placeIn(vol, '/ws/users.json', { recorded: false }),
    { exists: null, refusal: byDefault(unknownPlace('/ws/users.json', '/mnt/b', { to: '/mnt/b/users.json' })) }, '/ws/users.json, none recorded');
  vol.bind(`${ROOT_B}/sub`, '/mnt/b');   // the way out: mount it, then run purge-org again
  assert.deepEqual(placeIn(vol, '/mnt/b/users.json'), { exists: true, refusal: underRoot('/mnt/b/users.json', `${ROOT_B}/sub/users.json`) });
  assert.deepEqual(placeIn(vol, '/ws/users.json', { recorded: false }),
    { exists: true, refusal: byDefault(underRoot('/ws/users.json', `${ROOT_B}/sub/users.json`)) }, '/ws/users.json, none recorded, mounted');
  vol.rename(`${ROOT_B}/sub/users.json`, '/keep/users.json');   // that refusal's way out: move it out, then run purge-org again
  for (const [file, opts] of [['/mnt/b/users.json', {}], ['/cfg/users.json', {}], ['/ws/users.json', { recorded: false }]]) {
    assert.deepEqual(placeIn(vol, file, opts), { exists: false, refusal: null }, `${file} leads under the root, where nothing of it is left`);
  }
});

test('purge-org users file that exists outside the root: through a mount that is down whose mount point holds a file of its name meanwhile, an entry under the root with that name is refused — named directly, through a file link, through a link of another name, in another case or Unicode normalization, and, none recorded, <base>/users.json a link there — and one that is a link names what it leads to under the root too; mounted again, refused as lying under the root; moved out as either refusal says, the purge passes', () => {
  // The users file recorded as /mnt/b/users.json, /mnt/b a bind mount of <root>/sub that is down, and a users.json written
  // in its mount point meanwhile: the path leads to that file now, and to <root>/sub/users.json once mounted again. Taken
  // for a users file outside the root, the purge deleted <root>/sub/users.json.
  const vol = mountFs(posix).dir(`${ROOT_B}/packs`).file(`${ROOT_B}/packs/b1.pack.yaml`).file(`${ROOT_B}/sub/users.json`, { size: 300n })
    .file('/mnt/b/users.json', { size: 40n }).file('/mnt/c/Users.json').symlink('/cfg/users.json', '/mnt/b/users.json')
    .symlink('/cfg/x.json', '/mnt/b/users.json').symlink('/ws/users.json', '/mnt/b/users.json');
  const sub = [`${ROOT_B}/sub/users.json`];
  for (const file of ['/mnt/b/users.json', '/cfg/users.json', '/cfg/x.json', '/mnt/c/Users.json']) {
    assert.deepEqual(placeIn(vol, file), { exists: true, refusal: namesake(file, sub) }, file);
  }
  assert.deepEqual(placeIn(vol, '/ws/users.json', { recorded: false }), {
    exists: true,
    refusal: namesake('/ws/users.json', sub).replace('the recorded users file /ws/users.json',
      'the users file /ws/users.json (the one a pre-store build reads: OBSERVOGRAM_USERS_FILE was not set at the import)'),
  }, '/ws/users.json, none recorded');
  // The same name in another Unicode normalization (macOS writes names decomposed, NFD): a filesystem may look it up as one.
  const nfd = mountFs(posix).dir(`${ROOT_B}/packs`).file(`${ROOT_B}/sub/caf\u00e9.json`).file('/mnt/b/cafe\u0301.json');
  assert.deepEqual(placeIn(nfd, '/mnt/b/cafe\u0301.json'),
    { exists: true, refusal: namesake('/mnt/b/cafe\u0301.json', [`${ROOT_B}/sub/caf\u00e9.json`]) });
  // A link of that name under the root: mounted again, the path leads through it to what it names, which rmSync deletes
  // while the link moves out — named too.
  const linked = mountFs(posix).dir(`${ROOT_B}/packs`).file(`${ROOT_B}/data/real.json`).symlink(`${ROOT_B}/sub/users.json`, '../data/real.json')
    .file('/mnt/b/users.json');
  assert.deepEqual(placeIn(linked, '/mnt/b/users.json'),
    { exists: true, refusal: namesake('/mnt/b/users.json', [`${ROOT_B}/sub/users.json`], { targets: [`${ROOT_B}/data/real.json`] }) });
  // The way out by mounting it: the mount hides the file written in its mount point, and the path leads under the root.
  vol.bind(`${ROOT_B}/sub`, '/mnt/b');
  assert.deepEqual(placeIn(vol, '/mnt/b/users.json'), { exists: true, refusal: underRoot('/mnt/b/users.json', sub[0]) }, 'mounted again');
  // Moved out of the root, as either refusal says: the purge passes, the mount up or down.
  vol.rename(sub[0], '/keep/users.json');
  assert.deepEqual(placeIn(vol, '/mnt/b/users.json'), { exists: false, refusal: null }, 'mounted, moved out: it leads under the root');
  vol.unmount('/mnt/b');
  for (const file of ['/mnt/b/users.json', '/cfg/users.json', '/cfg/x.json', '/mnt/c/Users.json']) {
    assert.deepEqual(placeIn(vol, file), { exists: true, refusal: null }, `${file}, unmounted, moved out`);
  }
  linked.rename(`${ROOT_B}/sub/users.json`, '/keep/users.json').rename(`${ROOT_B}/data/real.json`, '/keep/real.json');
  assert.deepEqual(placeIn(linked, '/mnt/b/users.json'), { exists: true, refusal: null }, 'the link and what it names moved out');
});

test('purge-org users file that does not exist: its path leads into a directory under the root while an entry under the root has its name — the mount point of a bind mount of another directory under the root, holding the users file, that is down — and it is refused naming that entry (for a link of that name, what it leads to too), recorded through a file link, directly or through a directory link; with the mount up it is refused as a mount point, naming the users file under the root to move out with the unmounting, and so it is with a directory from outside the root mounted there whose link of the users file\'s name leads to a file under the root (unmounted as the mount point\'s refusal said, it was purged, the file deleted); moved out as either refusal says, the purge passes, and on the real filesystem through purgeOrg the moved file stays', async () => {
  // <root>/other bind-mounted on <root>/sub/m, and the users file, <root>/other/users.json, recorded through the mount. Up,
  // the mount is refused as a mount point, naming the users file under the root too; unmounted, as that refusal said,
  // <root>/sub/m is an empty directory the walk read, and the purge went on and deleted the users file behind it: the path
  // leads into a directory under the root, which passed without the name check.
  const sub = `${ROOT_B}/sub/m`;
  const behind = `${ROOT_B}/other/users.json`;
  const point = `${sub} (the same filesystem as ${ROOT_B}/sub, listed in /proc/self/mountinfo)`;
  const bound = () => mountFs(posix, { proc: true }).dir(`${ROOT_B}/packs`).file(`${ROOT_B}/packs/b1.pack.yaml`).dir(sub).file(behind)
    .symlink('/cfg/users.json', `${sub}/users.json`).symlink('/cfg/d', sub).bind(`${ROOT_B}/other`, sub);
  const vol = bound();
  const files = ['/cfg/users.json', `${sub}/users.json`, '/cfg/d/users.json'];
  for (const file of files) {
    assert.deepEqual(placeIn(vol, file), { exists: true, refusal: mountedHolding(point, file, behind) }, `${file}, mounted`);
    // Followed literally: moved out and unmounted, the purge passes.
    const followed = bound().rename(behind, '/keep/users.json').unmount(sub);
    assert.deepEqual(placeIn(followed, file), { exists: false, refusal: null }, `${file}: moved out and unmounted as the refusal says`);
  }
  // A directory from outside the root mounted there instead, its users.json a link to a file under the root that holds the
  // users file's bytes (/src bind-mounted on <root>/sub/m, /src/users.json → <root>/x/data.json): no entry under the root has
  // the users file's name, so unmounted as the mount point's refusal said, the path led into the empty mount point and the
  // purge deleted <root>/x/data.json. Up, the refusal names it to move out with the unmounting; followed, the purge passes
  // and the moved file stays. Unmounted before purge-org ever saw the mount up, nothing under the root tells (declared).
  const data = `${ROOT_B}/x/data.json`;
  const outside = () => mountFs(posix, { proc: true }).dir(`${ROOT_B}/packs`).file(`${ROOT_B}/packs/b1.pack.yaml`).dir(sub).file(data)
    .symlink('/src/users.json', data).symlink('/cfg/users.json', `${sub}/users.json`).bind('/src', sub);
  for (const file of [`${sub}/users.json`, '/cfg/users.json']) {
    const up = outside();
    assert.equal(up.fs.statSync(file).ino, up.fs.statSync(data).ino, `${file}: mounted, the record leads to ${data}`);
    assert.deepEqual(placeIn(up, file), { exists: true, refusal: mountedHolding(point, file, data) }, `${file}, mounted from outside`);
    up.rename(data, '/keep/data.json').unmount(sub);
    assert.deepEqual(placeIn(up, file), { exists: false, refusal: null }, `${file}: moved out and unmounted as the refusal says`);
    assert.ok(up.fs.statSync('/keep/data.json').isFile(), `${file}: the moved file stays`);
    assert.deepEqual(placeIn(outside().unmount(sub), file), { exists: false, refusal: null }, `${file}: unmounted first, nothing tells (declared)`);
  }
  vol.unmount(sub);
  for (const file of files) {
    assert.deepEqual(placeIn(vol, file), { exists: false, refusal: namesakeMissing(file, sub, [behind]) }, `${file}, unmounted`);
  }
  // A link of that name under the root names what it leads to there too, which rmSync deletes once the link is moved out.
  const linked = mountFs(posix).dir(`${ROOT_B}/packs`).dir(sub).file(`${ROOT_B}/data/real.json`).symlink(behind, '../data/real.json');
  assert.deepEqual(placeIn(linked, `${sub}/users.json`),
    { exists: false, refusal: namesakeMissing(`${sub}/users.json`, sub, [behind], { targets: [`${ROOT_B}/data/real.json`] }) });
  // Moved out as the refusal says: the path leads into a directory under the root where nothing of it is, and no entry has its name.
  vol.rename(behind, '/keep/users.json');
  for (const file of files) assert.deepEqual(placeIn(vol, file), { exists: false, refusal: null }, `${file}, moved out`);
  linked.rename(behind, '/keep/users.json').rename(`${ROOT_B}/data/real.json`, '/keep/real.json');
  assert.deepEqual(placeIn(linked, `${sub}/users.json`), { exists: false, refusal: null }, 'the link and what it names moved out');

  // On the real filesystem, through purgeOrg — no mount needed: what that mount leaves once it is down, <root>/sub/m an empty
  // directory and the users file at <root>/other/users.json, recorded as <root>/sub/m/users.json and through a directory link.
  const base = await removedOrgDeployment();
  const root = join(base, 'orgs', 'acme');
  const m = join(root, 'sub', 'm');
  const usersAt = join(root, 'other', 'users.json');
  mkdirSync(m, { recursive: true });
  usersJson(base, ['alice'], usersAt);
  const cfg = tempDir('ops-cfg');
  symlinkSync(m, join(cfg, 'd'), 'junction');   // a junction needs no privilege on Windows; a symlink elsewhere
  const filesBefore = readdirSync(root, { recursive: true }).sort();
  for (const usersFile of [join(m, 'users.json'), join(cfg, 'd', 'users.json')]) {
    await change(base, (db) => tx(db, () => meta.putMeta(db, 'users_file', usersFile)));
    await assert.rejects(purge(base, 'acme'), refusedOp(new RegExp(`^${esc(namesakeMissing(usersFile, m, [usersAt], { root }))}$`)), usersFile);
    assert.deepEqual(readdirSync(root, { recursive: true }).sort(), filesBefore, 'nothing deleted');
  }
  const keep = join(tempDir('ops-keep'), 'users.json');
  renameSync(usersAt, keep);
  assert.equal((await purge(base, 'acme')).deleted, true);
  assert.equal(existsSync(root), false);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(keep, 'utf8')).users), ['alice'], 'the moved users file stays');
});

test('purge-org users file that does not exist: recorded under the root and moved out, or reached by a link whose target is gone from the root, or by a chain of 40 links (Linux\'s limit), the purge passes; so does one whose path leads only through directories the root lies in, by its real path, or that its path as named is looked up in (the workspace or its orgs/ reached through a link in a directory the root does not lie in), to one where the rest does not exist (a sibling org\'s directory purged before), while no entry under the root has its name; one whose place lies elsewhere — a file deleted outside the root, a link to a mount that is down (also by a link into the root and on by a link under it, the rest of the path kept after each), a mount point that is down on another filesystem whose directory has the inode number of one under the root but another modification time, a path no part of which exists, a path through a directory neither the root nor its path lies in, or one whose name an entry under the root has — is refused, failing closed; none recorded and <base>/users.json absent, the purge passes', () => {
  const vol = betaVolume().symlink('/cfg/users.json', `${ROOT_B}/sub/users.json`).symlink('/cfg/gone', `${ROOT_B}/gone`)
    .symlink('/cfg/rel', '../ws/orgs/beta/sub/x/..').dir('/mnt/b').symlink('/cfg/m.json', '/mnt/b/users.json')
    .symlink('/ws/s.json', 'orgs/beta2/users.json').symlink('/cfg/s.json', '/ws/orgs/beta2/users.json').symlink('/cfg/d', '/ws/orgs')
    .symlink('/lnk', '/ws').symlink('/cfg/ds', `${ROOT_B}/sub`).symlink(`${ROOT_B}/sub/l`, '/mnt/b');
  // A chain of 40 links, as many as Linux follows in one path, to where the users file lies under the root.
  for (let i = 1; i < 40; i += 1) vol.symlink(`/cfg/hop${i}`, `/cfg/hop${i + 1}`);
  vol.symlink('/cfg/hop40', `${ROOT_B}/sub/users.json`);
  assert.equal(placeIn(vol, `${ROOT_B}/sub/users.json`).refusal, underRoot(`${ROOT_B}/sub/users.json`, `${ROOT_B}/sub/users.json`), 'recorded under the root: refused');
  vol.rename(`${ROOT_B}/sub/users.json`, '/keep/users.json');
  for (const file of [`${ROOT_B}/sub/users.json`, '/cfg/users.json', '/cfg/gone/users.json', `${ROOT_B}/sub/deeper/users.json`, '/cfg/rel/users.json', '/cfg/hop1']) {
    assert.deepEqual(placeIn(vol, file), { exists: false, refusal: null }, `${file}: moved out, it leads under the root`);
  }
  assert.deepEqual(placeIn(vol, '/srv/gone.json'), { exists: null, refusal: unknownPlace('/srv/gone.json', '/srv') }, 'deleted outside the root (declared)');
  assert.deepEqual(placeIn(vol, '/cfg/m.json'), { exists: null, refusal: unknownPlace('/cfg/m.json', '/mnt/b', { to: '/mnt/b/users.json' }) });
  // By a link into the root (/cfg/ds → <root>/sub) and on by a link under it (<root>/sub/l → /mnt/b): the rest of the path
  // is kept after each absolute link, so it leads to the mount that is down, not to <root>/sub.
  assert.deepEqual(placeIn(vol, '/cfg/ds/l/users.json'),
    { exists: null, refusal: unknownPlace('/cfg/ds/l/users.json', '/mnt/b', { to: '/mnt/b/users.json' }) });
  // A mount point that is down on another filesystem than the root's (/data/b, on a disk mounted at /data), its directory
  // with the inode number of <root>/sub — each filesystem numbers its own inodes — but its own modification time: no view
  // of <root>/sub, so nothing tells where the path leads.
  const sub = vol.fs.statSync(`${ROOT_B}/sub`);
  vol.dir('/data', { dev: 50n }).dir('/data/b', { ino: sub.ino });
  const down = vol.fs.statSync('/data/b');
  assert.deepEqual([down.ino === sub.ino, down.dev === sub.dev, down.mtimeNs === sub.mtimeNs], [true, false, false]);
  assert.deepEqual(placeIn(vol, '/data/b/users.json'), { exists: null, refusal: unknownPlace('/data/b/users.json', '/data/b') });
  // Only through directories the root lies in (/, /ws, /ws/orgs), into a sibling org's directory purged before — where the
  // users file was moved out of, as its refusal said — or a file deleted there: a filesystem mounted again on any of them
  // covers the root too. Named through a link to one of them, and with the root named through a link (by its real path).
  for (const file of ['/ws/orgs/beta2/users.json', '/ws/orgs/beta2/sub/users.json', '/ws/gone.json', '/ws/s.json', '/lnk/orgs/beta2/users.json']) {
    assert.deepEqual(placeIn(vol, file), { exists: false, refusal: null }, `${file}: through directories the root lies in`);
    assert.deepEqual(usersFilePlace(file, '/lnk/orgs/beta', { fs: vol.fs, path: posix, windows: false, id: 'beta' }), { exists: false, refusal: null },
      `${file}, the root named through a link`);
  }
  // Through a directory the root does not lie in — a link there, to a file or a directory — a filesystem mounted on it now
  // down may lead the path anywhere.
  assert.deepEqual(placeIn(vol, '/cfg/s.json'), { exists: null, refusal: unknownPlace('/cfg/s.json', '/ws/orgs', { to: '/ws/orgs/beta2/users.json' }) });
  assert.deepEqual(placeIn(vol, '/cfg/d/beta2/users.json'),
    { exists: null, refusal: unknownPlace('/cfg/d/beta2/users.json', '/ws/orgs', { to: '/ws/orgs/beta2/users.json' }) });
  // The root named through a link in a directory it does not lie in — the workspace (/home/u/ws → /ws) or its orgs/
  // (/w2/orgs → /ws/orgs): its path is looked up in that directory and those above it too, and a filesystem mounted again
  // on one of them hides the link the root's own path is reached through. A path looked up only in those and in the
  // directories the root lies in passes. With the root named by its real path, a path through /home/u/ws is looked up in
  // directories its path is not (/home, /home/u), and refused; so is one through /w2/orgs, the root named through /home/u/ws.
  vol.symlink('/home/u/ws', '/ws').symlink('/w2/orgs', '/ws/orgs');
  const placeAt = (file, root) => usersFilePlace(file, root, { fs: vol.fs, path: posix, windows: false, id: 'beta' });
  for (const [root, file] of [['/home/u/ws/orgs/beta', '/home/u/ws/orgs/beta2/users.json'], ['/home/u/ws/orgs/beta', '/home/u/ws/orgs/beta2/sub/users.json'],
    ['/home/u/ws/orgs/beta', '/home/u/ws/gone.json'], ['/home/u/ws/orgs/beta', '/home/u/gone.json'], ['/w2/orgs/beta', '/w2/orgs/beta2/users.json']]) {
    assert.deepEqual(placeAt(file, root), { exists: false, refusal: null }, `${file}, the root named ${root}`);
  }
  assert.deepEqual(placeIn(vol, '/home/u/ws/orgs/beta2/users.json'),
    { exists: null, refusal: unknownPlace('/home/u/ws/orgs/beta2/users.json', '/ws/orgs', { to: '/ws/orgs/beta2/users.json' }) }, 'the root named by its real path');
  assert.deepEqual(placeAt('/w2/orgs/beta2/users.json', '/home/u/ws/orgs/beta'),
    { exists: null, refusal: unknownPlace('/w2/orgs/beta2/users.json', '/ws/orgs', { to: '/ws/orgs/beta2/users.json', root: '/home/u/ws/orgs/beta' }) },
    'through a link the root\'s path does not pass');
  // /ws/orgs a bind mount of <root>/x, down now: the users file written through it is <root>/x/beta2/users.json, and an
  // entry under the root with its name is refused (a directory under the root mounted above it keeps its names).
  vol.file(`${ROOT_B}/x/beta2/users.json`);
  assert.deepEqual(placeIn(vol, '/ws/orgs/beta2/users.json'), { exists: null, refusal: unknownPlace('/ws/orgs/beta2/users.json', '/ws/orgs') });
  assert.deepEqual(placeIn(vol, '/ws/s.json'), { exists: null, refusal: unknownPlace('/ws/s.json', '/ws/orgs', { to: '/ws/orgs/beta2/users.json' }) });
  vol.rename(`${ROOT_B}/x/beta2/users.json`, '/keep/x/users.json');
  assert.deepEqual(placeIn(vol, '/ws/orgs/beta2/users.json'), { exists: false, refusal: null }, 'moved out, no entry of its name');
  assert.deepEqual(placeIn(vol, '/ws/users.json', { recorded: false }), { exists: false, refusal: null }, 'the default nothing records, absent: nothing to keep');
});

test('purge-org users file that cannot be read: a directory on its path this user may not search is refused, and as a user who can the purge passes; a link loop is refused; a part of its path that stops answering once statSync found nothing there is refused', () => {
  const vol = betaVolume().file('/priv/accounts.json').deny('/priv').symlink('/cfg/a', '/cfg/b').symlink('/cfg/b', '/cfg/a');
  assert.deepEqual(placeIn(vol, '/priv/accounts.json'), {
    exists: null,
    refusal: `the recorded users file /priv/accounts.json cannot be read on this host (EACCES), so nothing tells whether it lies under ${ROOT_B} — `
      + 'nothing was deleted. Run purge-org as a user who can read /priv/accounts.json; or, if it does not lie under '
      + `${ROOT_B}, delete ${ROOT_B} by hand, then run purge-org again: it drops org beta's records`,
  });
  const reader = betaVolume().file('/priv/accounts.json');
  assert.deepEqual(placeIn(reader, '/priv/accounts.json'), { exists: true, refusal: null }, 'the way out: a user who can read it');
  assert.equal(placeIn(vol, '/cfg/a').refusal, `the recorded users file /cfg/a cannot be read on this host (ELOOP: a link loop, or a chain of more `
    + `than 40 links), so nothing tells whether it lies under ${ROOT_B} — nothing was deleted. If it does not lie under ${ROOT_B}, delete `
    + `${ROOT_B} by hand, then run purge-org again: it drops org beta's records`);
  assert.match(placeIn(vol, '/priv/accounts.json', { recorded: false }).refusal, /^the users file \/priv\/accounts\.json \(the one a pre-store build reads: OBSERVOGRAM_USERS_FILE was not set at the import\) cannot be read on this host \(EACCES\)/);
  // A part of its path that stops answering once statSync found nothing there (a FUSE server stopping between the two
  // reads): where the path leads cannot be told — refused naming that part, failing closed.
  const stopping = betaVolume().dir('/mnt/f');
  const flaky = {
    ...stopping.fs,
    lstatSync: (p, o) => {
      if (p === '/mnt/f') throw Object.assign(new Error('ENOTCONN: /mnt/f'), { code: 'ENOTCONN' });
      return stopping.fs.lstatSync(p, o);
    },
  };
  assert.deepEqual(placeIn(stopping, '/mnt/f/users.json', { fs: flaky }), {
    exists: null,
    refusal: `the recorded users file /mnt/f/users.json cannot be read on this host (ENOTCONN at /mnt/f), so nothing tells whether it lies under ${ROOT_B} — `
      + `nothing was deleted. If it does not lie under ${ROOT_B}, delete ${ROOT_B} by hand, then run purge-org again: it drops org beta's records`,
  });
});

test('purge-org users file that does not exist, on Windows paths: moved out from under the root, by any spelling or through a junction into it, or in a sibling org\'s directory purged before, by any spelling, the purge passes; through a share whose directory is gone, on a drive that does not exist, deleted outside the root, or through a directory whose name differs from one the root lies in by case alone (case-sensitive), refused', () => {
  const RW = 'C:\\ws\\orgs\\beta';
  const C = 0x1_0000_0007n;
  const vol = mountFs(win32, { fold: true, devs: { 'C:\\': C } }).file(`${RW}\\sub\\users.json`).dir('C:\\out')
    .symlink('C:\\cfg\\d', `${RW}\\sub`).view(`${RW}\\sub`, '\\\\myhost\\betasub\\', { dev: C & 0xffffffffn });
  const placeW = (file) => usersFilePlace(file, RW, { fs: vol.fs, path: win32, windows: true, id: 'beta' });
  vol.rename(`${RW}\\sub\\users.json`, 'C:\\keep\\users.json');
  for (const file of [`${RW}\\sub\\users.json`, 'c:/WS/orgs/BETA/sub/users.json', 'C:\\cfg\\d\\users.json', '\\\\myhost\\betasub\\users.json',
    'C:\\ws\\orgs\\acme\\sub\\users.json', 'c:/WS/orgs/ACME/sub/users.json']) {
    assert.deepEqual(placeW(file), { exists: false, refusal: null }, `${file}: nothing of it under the root`);
  }
  assert.deepEqual(placeW('C:\\out\\users.json'), { exists: null, refusal: unknownPlace('C:\\out\\users.json', 'C:\\out', { root: RW }) });
  assert.deepEqual(placeW('Q:\\users.json'), { exists: null, refusal: unknownPlace('Q:\\users.json', null, { root: RW }) }, 'a drive that does not exist');
  // A directory NTFS keeps case-sensitive (per directory): C:\WS beside C:\ws is another directory, which the root does not lie in.
  const cased = mountFs(win32, { devs: { 'C:\\': C } }).dir(`${RW}\\packs`).dir('C:\\WS\\orgs');
  assert.deepEqual(usersFilePlace('C:\\WS\\orgs\\acme\\users.json', RW, { fs: cased.fs, path: win32, windows: true, id: 'beta' }),
    { exists: null, refusal: unknownPlace('C:\\WS\\orgs\\acme\\users.json', 'C:\\WS\\orgs', { root: RW }) }, 'another directory by case');
});

test('purge-org: a users file recorded outside the root with a hard link under it is refused naming the link, nothing deleted; with the link moved out, the purge passes and the users file stays', async () => {
  const base = await removedOrgDeployment();
  const root = join(base, 'orgs', 'acme');
  const srv = tempDir('ops-users');
  const usersFile = join(srv, 'users.json');
  usersJson(srv, ['alice'], usersFile);
  await change(base, (db) => tx(db, () => meta.putMeta(db, 'users_file', usersFile)));
  linkSync(usersFile, join(root, 'u.json'));
  const filesBefore = readdirSync(root, { recursive: true }).sort();
  await assert.rejects(purge(base, 'acme'), refusedOp(new RegExp(`^the recorded users file ${esc(usersFile)} lies under ${esc(root)}: it is ${esc(join(root, 'u.json'))} there — nothing was deleted\\. Move ${esc(join(root, 'u.json'))} out of ${esc(root)}, then run purge-org again\\.`)));
  assert.deepEqual(readdirSync(root, { recursive: true }).sort(), filesBefore, 'nothing deleted');
  renameSync(join(root, 'u.json'), join(srv, 'moved.json'));
  const r = await purge(base, 'acme');
  assert.equal(r.deleted, true);
  assert.equal(existsSync(root), false);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(usersFile, 'utf8')).users), ['alice'], 'the users file stays');
});

test('purge-org: the recorded users file reached through a directory link into the root is refused naming its entry under the root (by its path, realpath placed it under the root too), nothing deleted; moved out as the refusal says, the purge passes', async () => {
  const base = await removedOrgDeployment();
  const root = join(base, 'orgs', 'acme');
  const cfg = tempDir('ops-cfg');
  usersJson(join(root, 'sub'), ['alice'], join(root, 'sub', 'users.json'));
  symlinkSync(join(root, 'sub'), join(cfg, 'd'), 'junction');   // a junction needs no privilege on Windows; a symlink elsewhere
  const usersFile = join(cfg, 'd', 'users.json');
  await change(base, (db) => tx(db, () => meta.putMeta(db, 'users_file', usersFile)));
  await assert.rejects(purge(base, 'acme'), refusedOp(new RegExp(`^the recorded users file ${esc(usersFile)} lies under ${esc(root)}: it is ${esc(join(root, 'sub', 'users.json'))} there — nothing was deleted`)));
  assert.ok(existsSync(join(root, 'sub', 'users.json')) && existsSync(join(root, 'packs', 'a1.pack.yaml')), 'nothing deleted');
  // The way out, followed: moved out of the root, the record leads through the link to a directory under the root, where
  // nothing of the users file is left.
  const keep = join(tempDir('ops-keep'), 'users.json');
  renameSync(join(root, 'sub', 'users.json'), keep);
  assert.equal((await purge(base, 'acme')).deleted, true);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(keep, 'utf8')).users), ['alice'], 'the moved users file stays');
});

test('purge-org: with no users file recorded, <base>/users.json — the one a pre-store build reads — with a hard link under the root is refused; with the link moved out, the purge passes and <base>/users.json stays', async () => {
  const base = await removedOrgDeployment();
  const root = join(base, 'orgs', 'acme');
  await read(base, (db) => assert.equal(meta.getMeta(db, 'users_file'), null, 'none recorded: OBSERVOGRAM_USERS_FILE was not set at the import'));
  mkdirSync(join(root, 'sub'));
  linkSync(join(base, 'users.json'), join(root, 'sub', 'users.json'));
  const entry = join(root, 'sub', 'users.json');
  await assert.rejects(purge(base, 'acme'), refusedOp(new RegExp(`^the users file ${esc(join(base, 'users.json'))} \\(the one a pre-store build reads: OBSERVOGRAM_USERS_FILE was not set at the import\\) lies under ${esc(root)}: it is ${esc(entry)} there — nothing was deleted\\. Move ${esc(entry)} out of ${esc(root)}, then run purge-org again\\.`)));
  renameSync(entry, join(tempDir('ops-keep'), 'users.json'));
  assert.equal((await purge(base, 'acme')).deleted, true);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(base, 'users.json'), 'utf8')).users), ['alice'], '<base>/users.json stays');
});

test('purge-org: the users file recorded under the root is refused naming it, nothing deleted; moved out of the root as the refusal says, the purge passes — it used to refuse again, and again — and the moved file stays', async () => {
  const base = await removedOrgDeployment();
  const root = join(base, 'orgs', 'acme');
  const usersFile = join(root, 'sub', 'users.json');
  usersJson(base, ['alice'], usersFile);
  await change(base, (db) => tx(db, () => meta.putMeta(db, 'users_file', usersFile)));
  await assert.rejects(purge(base, 'acme'), refusedOp(new RegExp(`^${esc(underRoot(usersFile, usersFile, root))}$`)));
  assert.ok(existsSync(usersFile) && existsSync(join(root, 'packs', 'a1.pack.yaml')), 'nothing deleted');
  const keep = join(tempDir('ops-keep'), 'users.json');
  renameSync(usersFile, keep);
  const r = await purge(base, 'acme');
  assert.equal(r.deleted, true);
  assert.equal(existsSync(root), false);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(keep, 'utf8')).users), ['alice'], 'the moved users file stays');
});

test('purge-org: the users file recorded under one org\'s root and moved out as the refusal says, that org purged, a later purge of another org passes — the record leads into the purged root, which no longer exists, through directories the other root lies in, where a filesystem mounted again covers that root too, and with the workspace or its orgs/ reached through a directory link (a junction on Windows) in a directory the roots do not lie in, through that directory too, where one hides the link the root\'s own path is reached through; it used to be refused as a users file that does not exist, for every org purged afterwards (through such a link, also with only the directories on the root\'s real path) — and the moved file stays', async () => {
  // The workspace named by its real path; through a link to it in a directory the roots do not lie in (<d>/home/u/ws →
  // <d>/data/ws); and with its orgs/ such a link (<d>/data/w2/orgs → <d>/data/orgs).
  const d = tempDir('ops-linked');
  for (const dir of [join(d, 'home', 'u'), join(d, 'data', 'ws'), join(d, 'data', 'w2'), join(d, 'data', 'orgs')]) mkdirSync(dir, { recursive: true });
  symlinkSync(join(d, 'data', 'ws'), join(d, 'home', 'u', 'ws'), 'junction');   // a junction needs no privilege on Windows; a symlink elsewhere
  symlinkSync(join(d, 'data', 'orgs'), join(d, 'data', 'w2', 'orgs'), 'junction');
  for (const at of [undefined, join(d, 'home', 'u', 'ws'), join(d, 'data', 'w2')]) {
    const base = await removedOrgDeployment(at);
    const acme = join(base, 'orgs', 'acme');
    const beta = join(base, 'orgs', 'beta');
    const usersFile = join(acme, 'sub', 'users.json');
    usersJson(base, ['alice'], usersFile);
    await change(base, (db) => tx(db, () => meta.putMeta(db, 'users_file', usersFile)));
    await assert.rejects(purge(base, 'acme'), refusedOp(new RegExp(`^${esc(underRoot(usersFile, usersFile, acme))}$`)), base);
    const keep = join(tempDir('ops-keep'), 'users.json');
    renameSync(usersFile, keep);
    assert.equal((await purge(base, 'acme')).deleted, true, base);
    await change(base, (db) => admin.removeOrgSoft(db, 'cli', 'beta'));
    const r = await purge(base, 'beta');
    assert.equal(r.deleted, true, base);
    assert.equal(existsSync(beta), false, base);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(keep, 'utf8')).users), ['alice'], `${base}: the moved users file stays`);
  }
});

test('purge-org: a recorded users file outside the root that no longer exists is refused (declared), naming where its path leads as this host resolves it — through a directory link, as a temporary directory on macOS is (/var → /private/var), not where it is spelled — nothing deleted; with the root deleted by hand as the refusal says, the purge passes and drops the org\'s records; none recorded and <base>/users.json deleted, the purge passes', async () => {
  const base = await removedOrgDeployment();
  const root = join(base, 'orgs', 'acme');
  const srv = tempDir('ops-users');
  const linked = join(tempDir('ops-link'), 'srv');
  symlinkSync(srv, linked, 'junction');   // a junction needs no privilege on Windows; a symlink elsewhere
  // Where the path leads and its nearest part that exists are named as this host resolves them, every link followed: the
  // real path of the users file's directory. Through a link — on macOS the temporary directory is reached through one —
  // that is not how the path is spelled, and the refusal names the place it leads to.
  for (const usersFile of [join(srv, 'users.json'), join(linked, 'users.json')]) {
    const near = realpathSync(dirname(usersFile));
    const place = join(near, 'users.json');
    await change(base, (db) => tx(db, () => meta.putMeta(db, 'users_file', usersFile)));
    await assert.rejects(purge(base, 'acme'), refusedOp(new RegExp(`^${esc(`the recorded users file ${usersFile} does not exist, and nothing on this host tells where its path leads${place === usersFile ? '' : ` (to ${place})`}: the nearest part of it that exists, ${near}, is no directory under ${root}`)}.* If it lies on a filesystem that is not mounted now, mount it, then run purge-org again; if it does not lie under ${esc(root)}, delete ${esc(root)} by hand, then run purge-org again: it drops org acme's records$`)));
    assert.ok(existsSync(join(root, 'packs', 'a1.pack.yaml')), 'nothing deleted');
  }
  const rows = await read(base, (db) => actions(db).length);
  rmSync(root, { recursive: true });
  const r = await purge(base, 'acme');
  assert.deepEqual(formatPurge(r)[0], `purged org acme: nothing on disk at ${root}`);
  await read(base, (db) => assert.deepEqual(actions(db).slice(rows), ['org.purge:cli:acme']));

  const oidcOnly = await removedOrgDeployment();
  rmSync(join(oidcOnly, 'users.json'));
  assert.equal((await purge(oidcOnly, 'acme')).deleted, true, 'the default users file nothing records, absent: nothing to keep');
});

// ---------- audit: the CLI reader ----------

// A flat deployment with two orgs and planted rows: the deployment's by
// `system` and `cli`, acme's and beta's by their people, in one order.
async function auditedDeployment() {
  const base = tempDir();
  usersJson(base, ['alice']);
  await start(base);
  await change(base, (db) => {
    admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'alice', base });
    admin.createOrgFromAdmin(db, 'cli', { id: 'beta', name: 'Beta', admin: 'alice', base });
    tx(db, () => {
      writeAudit(db, 'olive', { action: 'user.create', targetKind: 'user', targetId: 'oscar', detail: { kind: 'local', isOwner: false } });
      writeAudit(db, 'oscar', { orgId: 'acme', action: 'deploy.run', targetKind: 'deploy', targetId: 'dep_1', detail: { ok: 1, failed: 0, origin: 'https://mcp.acme.test' } });
      writeAudit(db, 'bob', { orgId: 'beta', action: 'pack.register', targetKind: 'pack', targetId: 'p-beta', detail: { label: 'Beta' } });
      writeAudit(db, 'oscar', { orgId: 'acme', action: 'journey.run', targetKind: 'journey', targetId: 'nightly', detail: { outcome: 'pass' } });
      writeAudit(db, 'oscar', { orgId: 'acme', action: 'deploy.verify', targetKind: 'deploy', targetId: 'dep_1', detail: { outcome: 'aligned' } });
    });
  });
  return base;
}

test('packc store audit: one JSON row per line newest first, the store line and `next` on stderr; --org, --deployment, --kind, --actor, --target, --since/--until; --limit + --before page to the end; nothing written', async () => {
  const base = await auditedDeployment();
  const env = cliEnv(base);
  const run = (...args) => spawnSync(process.execPath, [PACKC, 'store', 'audit', ...args], { env, encoding: 'utf8', timeout: 60_000 });
  const rowsOf = (r) => { assert.equal(r.status, 0, r.stderr); return r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)); };
  const all = await read(base, (db) => listAudit(db, { limit: 1000 }));
  const seqs = (rows) => rows.map((x) => x.seq);
  const keyOf = (x) => [x.action, x.actor, x.orgId, x.targetId];

  // Every row, newest first, each the eight fields of the API's row — stdout is the rows and nothing else.
  const every = run();
  const rows = rowsOf(every);
  assert.deepEqual(seqs(rows), seqs(all), 'every row of every org and the deployment, newest first');
  assert.deepEqual(Object.keys(rows[0]), ['seq', 'at', 'orgId', 'actor', 'action', 'targetKind', 'targetId', 'detail']);
  assert.deepEqual(rows.slice(0, 5).map(keyOf), [
    ['deploy.verify', 'oscar', 'acme', 'dep_1'], ['journey.run', 'oscar', 'acme', 'nightly'], ['pack.register', 'bob', 'beta', 'p-beta'],
    ['deploy.run', 'oscar', 'acme', 'dep_1'], ['user.create', 'olive', null, 'oscar'],
  ]);
  assert.deepEqual(rows[0].detail, { outcome: 'aligned' }, 'the detail parsed');
  assert.equal(every.stderr, `store: ${dbOf(base)}\n`, 'one page: the store line only, no next');

  // The scopes: one org's rows; the rows with no org; the same again by --all; the org must exist.
  const acme = rowsOf(run('--org', 'acme'));
  assert.deepEqual(acme.map(keyOf), [
    ['deploy.verify', 'oscar', 'acme', 'dep_1'], ['journey.run', 'oscar', 'acme', 'nightly'], ['deploy.run', 'oscar', 'acme', 'dep_1'], ['membership.add', 'cli', 'acme', 'alice'],
  ], 'acme\'s rows: the planted three and the admin membership its creation wrote; never beta\'s, never a deployment row');
  assert.deepEqual(seqs(acme), seqs(all.filter((x) => x.orgId === 'acme')));
  const dep = rowsOf(run('--deployment'));
  assert.ok(dep.length >= 4 && dep.every((x) => x.orgId === null), 'the deployment: the planted user.create, the two org.create rows and the import');
  assert.deepEqual(dep.slice(0, 3).map(keyOf), [['user.create', 'olive', null, 'oscar'], ['org.create', 'cli', null, 'beta'], ['org.create', 'cli', null, 'acme']]);
  assert.deepEqual(seqs(rowsOf(run('--all'))), seqs(all));
  const none = run('--org', 'nope');
  assert.equal(none.status, 1);
  assert.equal(none.stdout, '');
  assert.equal(none.stderr, `store: ${dbOf(base)}\npackc store audit: no org "nope" in store ${dbOf(base)}\n`);

  // The filters, ANDed with the scope.
  assert.deepEqual(rowsOf(run('--kind', 'deploy')).map(keyOf), [['deploy.verify', 'oscar', 'acme', 'dep_1'], ['deploy.run', 'oscar', 'acme', 'dep_1']]);
  assert.deepEqual(rowsOf(run('--org', 'acme', '--kind', 'journey')).map(keyOf), [['journey.run', 'oscar', 'acme', 'nightly']]);
  assert.deepEqual(rowsOf(run('--actor', 'bob')).map(keyOf), [['pack.register', 'bob', 'beta', 'p-beta']]);
  assert.deepEqual(rowsOf(run('--action', 'deploy.verify', '--target', 'dep_1', '--target-kind', 'deploy')).map(keyOf), [['deploy.verify', 'oscar', 'acme', 'dep_1']]);
  assert.deepEqual(rowsOf(run('--since', '2000-01-01', '--until', '2099-01-01', '--actor', 'bob')).length, 1);
  assert.deepEqual(rowsOf(run('--until', '2000-01-01')), [], 'an empty listing is no row and exit 0');

  // Paging: --limit 2, then --before <next> until no next; the pages concatenate to the whole listing, no row twice.
  const paged = [];
  let before = null;
  for (let page = 0; page < 20; page += 1) {
    const r = run('--limit', '2', ...(before ? ['--before', String(before)] : []));
    const got = rowsOf(r);
    paged.push(...got);
    const m = r.stderr.match(/^next: (\d+)$/m);
    if (!m) { assert.equal(r.stderr, `store: ${dbOf(base)}\n`, 'the last page: no next line'); break; }
    assert.equal(got.length, 2, 'a full page when more exist');
    assert.equal(Number(m[1]), got[1].seq, 'next is the seq of the page\'s last row');
    before = Number(m[1]);
  }
  assert.deepEqual(seqs(paged), seqs(all), 'the pages are the whole listing, in order, no row twice');
  assert.deepEqual(seqs(rowsOf(run('--limit', '2', '--before', String(all[0].seq)))), seqs(all).slice(1, 3));

  // The refusals: the rule's texts spell the flags; usage errors exit 2 and print the usage; a refusal is one line, exit 1.
  for (const [args, text] of [
    [['--limit', '0'], 'packc store audit: --limit must be an integer from 1 to 500'],
    [['--limit', '501'], 'packc store audit: --limit must be an integer from 1 to 500'],
    [['--before', 'x'], 'packc store audit: --before must be a positive integer — the next value of the previous page'],
    [['--since', '2026-02-30'], 'packc store audit: --since must be a date or a UTC time: 2026-10-04 or 2026-10-04T09:00:00Z'],
    [['--since', '2026-10-04', '--until', '2026-10-04'], 'packc store audit: --since must be before --until'],
    [['--action', 'deploy'], 'packc store audit: --action must be <kind>.<verb>, lower case, e.g. deploy.run or mcp_endpoint.create'],
    [['--kind', 'Deploy'], 'packc store audit: --kind must be a lower-case word, e.g. deploy, pack or mcp_endpoint'],
    [['--target-kind', 'x'.repeat(101)], 'packc store audit: --target-kind must be 1–100 characters'],
    [['--target', 'x'.repeat(201)], 'packc store audit: --target must be 1–200 characters'],
  ]) {
    const r = run(...args);
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, '', `${text}\n`], args.join(' '));
  }
  for (const [args, re] of [
    [['--bogus'], /^packc store audit: unknown argument --bogus$/m], [['--org'], /^packc store audit: --org takes an org id$/m],
    [['--org', 'acme', '--all'], /^packc store audit: name one of --org <id>, --deployment or --all/m], [['--actor'], /^packc store audit: --actor takes a value$/m],
    [['--actor', 'a', '--actor', 'b'], /^packc store audit: --actor is given twice$/m], [['acme'], /^packc store audit: unknown argument acme$/m],
  ]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, re);
    assert.match(r.stderr, /packc store audit \[--org <id> \| --deployment \| --all\]/, 'the usage follows');
  }

  // A reader: the listing wrote no row, and the store is as it was.
  assert.deepEqual(await read(base, (db) => listAudit(db, { limit: 1000 })), all, 'no new row after every listing above');
});

test('packc store audit: refused on :memory: and on a missing database (never created), a workspace with un-imported legacy files like its siblings; bare `packc` and `packc store` name it', async () => {
  const base = await auditedDeployment();
  const env = cliEnv(base);
  const run = (vars, ...args) => spawnSync(process.execPath, [PACKC, 'store', 'audit', ...args], { env: { ...env, ...vars }, encoding: 'utf8', timeout: 60_000 });
  const mem = run({ OBSERVOGRAM_DB: ':memory:' });
  assert.deepEqual([mem.status, mem.stdout, mem.stderr], [1, '', 'packc store audit: OBSERVOGRAM_DB is :memory: — a CLI needs the server\'s database file\n']);
  const empty = tempDir();
  const missing = run({ OBSERVOGRAM_WORKSPACE: empty });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /^packc store audit: no database at .* — nothing to list \(this command never creates one; check OBSERVOGRAM_DB and OBSERVOGRAM_WORKSPACE\)\n$/);
  assert.ok(!existsSync(dbOf(empty)), 'a reader creates no database');
  const legacyBase = tempDir();
  usersJson(legacyBase, ['alice']);
  const notImported = run({ OBSERVOGRAM_WORKSPACE: legacyBase });
  assert.equal(notImported.status, 1);
  assert.match(notImported.stderr, /^packc store audit: no database at /, 'a legacy workspace with no store: no database, nothing to list');
  assert.ok(!existsSync(dbOf(legacyBase)));
  // The usages: `packc store` (2) and bare `packc` (0) each have the line.
  for (const [args, status] of [[['store'], 2], [[], 0]]) {
    const r = spawnSync(process.execPath, [PACKC, ...args], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, status);
    assert.match(r.stderr + r.stdout, /packc store +audit/, `packc ${args.join(' ')} names packc store audit`);
  }
  // The direct-rule text of GET /api/audit names the CLI as the way out from a shell (server/authz.mjs).
  const { authzDecision } = await import('./authz.mjs');
  const { routeEntry } = await import('./route-table.mjs');
  const d = authzDecision(routeEntry('GET /api/audit'), {
    principal: { kind: 'local', owner: true, role: 'admin' }, posture: 'open-loopback', direct: false, csrf: false, org: 'default', authOff: false, host: '127.0.0.1', port: 8123,
  });
  assert.equal(d.status, 403);
  assert.match(d.body.error, /— open the studio at http:\/\/127\.0\.0\.1:8123, or list it from this machine with packc store audit$/);
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
