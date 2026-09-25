#!/usr/bin/env node
/**
 * tools/test-store-prestore-live.mjs — the Export gate against a REAL
 * pre-store build (docs/STORE_PLAN.md §8 "Export": a pre-store build boots
 * on an exported workspace, and the same enabled users sign in and see the
 * same packs).
 *
 * The pre-store build is tag v0.4.0 (its server/auth.mjs and
 * server/tenancy.mjs are develop's before STORE_PLAN slice 2 byte for
 * byte), checked out into a worktree with its own `npm ci`, named by
 * PRESTORE_BUILD_DIR — a test-only variable, like test-backend-live.mjs's
 * T4_*, not a product knob:
 *
 *   git fetch --depth 1 origin tag v0.4.0
 *   git worktree add "$RUNNER_TEMP/prestore" v0.4.0 && (cd "$RUNNER_TEMP/prestore" && npm ci)
 *   PRESTORE_BUILD_DIR="$RUNNER_TEMP/prestore" npm run test:store:prestore:strict
 *
 * Each case builds its workspace with THIS build's code, in-process: legacy
 * files and flat data, the import (bootStore()), changes through the
 * management rules, the server stopped, `exportStore` in place. Then it
 * boots the old build as a child (node <worktree>/server/index.mjs, PORT=0,
 * HOST=127.0.0.1, an explicit env; the port read from its "listening on"
 * line) and asks it over HTTP: every enabled user signs in and a disabled
 * one does not; /api/packs lists the same packs per org; the default org's
 * journeys are found; the created org exists. Finally a store build starts
 * again on what the old build left (no refusal).
 *
 * Without PRESTORE_BUILD_DIR it SKIPS loudly; --strict (CI job
 * store-prestore) turns the skip into a failure. The fast in-`npm test`
 * half of the same gate is server/test-store-ops.mjs, over a frozen copy of
 * the old semantics (server/fixtures/pre-store-build.mjs).
 */

// Hermetic (STORE_PLAN slice 2, §0): a developer shell's store or identity
// variables never reach this process's server code or the children.
const STRIP = [
  'DB', 'BOOTSTRAP_ADMIN', 'OIDC_JOIN_ROLE', 'ADMIN_PASSWORD', 'INSECURE_NO_AUTH', 'WORKSPACE', 'USERS_FILE',
  'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'SESSION_SECRET', 'API_TOKEN', 'AUTH',
];
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

const { spawn } = await import('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, resolve } = await import('node:path');
const { createHarness } = await import('./lib/harness.mjs');

const STRICT = process.argv.includes('--strict');
const BUILD = process.env.PRESTORE_BUILD_DIR ? resolve(process.env.PRESTORE_BUILD_DIR) : null;
const { assert, report } = createHarness({ indent: '  ', truncate: 400 });
const eq = (got, want, label) => assert(JSON.stringify(got) === JSON.stringify(want), label, got, want);

function skip(reason) {
  if (STRICT) {
    assert(false, `pre-store build preconditions (--strict): ${reason}`);
    report('store-prestore');
    return;
  }
  process.stdout.write(`store-prestore: SKIPPED — ${reason}\n`);
  process.stdout.write('  (git worktree add <dir> v0.4.0 && (cd <dir> && npm ci), then PRESTORE_BUILD_DIR=<dir> npm run test:store:prestore)\n');
  process.exit(0);
}

if (!BUILD) skip('PRESTORE_BUILD_DIR is not set');
else if (!existsSync(join(BUILD, 'server', 'index.mjs')) || !existsSync(join(BUILD, 'node_modules'))) {
  skip(`${BUILD} is not a pre-store checkout with its dependencies installed (server/index.mjs, node_modules)`);
}

const { closeStore, openStore } = await import('../server/store/db.mjs');
const { writeOrgsFile, writeUsersFile } = await import('../server/store/legacy-files.mjs');
const { exportStore } = await import('../server/store/ops.mjs');
const { bootStore } = await import('../server/boot.mjs');
const { hashPassword } = await import('../server/auth.mjs');
const admin = await import('../server/identity-admin.mjs');

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'observogram-prestore-'));
  tmpDirs.push(d);
  return d;
}

// ---------- building a workspace with this build ----------

const PW = { alice: 'alice-passw0rd', bob: 'bob-passw0rd', carol: 'carol-passw0rd' };
const dbOf = (base) => join(base, 'observogram.db');
const slashed = (p) => p.replaceAll('\\', '/');

function usersJson(base, logins) {
  writeUsersFile({
    users: Object.fromEntries(logins.map((l) => [l, { name: l, createdAt: '2026-01-01T00:00:00.000Z', password: hashPassword(PW[l]) }])),
  }, join(base, 'users.json'));
}
function pack(root, id) {
  mkdirSync(join(root, 'packs'), { recursive: true });
  writeFileSync(join(root, 'packs', `${id}.pack.yaml`), `name: ${id}\n`);
}
function journey(root, name, packFile) {
  mkdirSync(join(root, 'journeys'), { recursive: true });
  writeFileSync(join(root, 'journeys', `${name}.journey.yaml`),
    `packA:\n  file: ${slashed(packFile)}\npackB:\n  file: ${slashed(packFile)}\ngate:\n  minAlignmentPct: 85\n`);
}

async function storeStart(base) {
  process.env.OBSERVOGRAM_WORKSPACE = base;
  try {
    await bootStore({ host: '127.0.0.1' });
  } finally {
    closeStore(dbOf(base));
    delete process.env.OBSERVOGRAM_WORKSPACE;
  }
}
async function change(base, fn) {
  const db = await openStore({ path: dbOf(base) });
  try { fn(db); } finally { closeStore(dbOf(base)); }
}
const exportInPlace = (base) => exportStore(base, { dbPath: dbOf(base), base, out: { write() {} } });

// ---------- the pre-store build, over HTTP ----------

function childEnv(base) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(OBSERVOGRAM|TOMOGRAPH)_/.test(k)) env[k] = v;
  return { ...env, OBSERVOGRAM_WORKSPACE: base, PORT: '0', HOST: '127.0.0.1' };
}

async function preStore(base) {
  const proc = spawn(process.execPath, [join(BUILD, 'server', 'index.mjs')], { cwd: BUILD, env: childEnv(base), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (c) => { stderr += c; });
  const exited = new Promise((res) => proc.on('exit', (code, signal) => res({ code, signal })));
  const port = await new Promise((res, rej) => {
    const t = setTimeout(() => { proc.kill('SIGKILL'); rej(new Error(`no "listening on" in 60 s: ${stderr}`)); }, 60_000);
    proc.stdout.on('data', (c) => {
      stdout += c;
      const m = stdout.match(/listening on http:\/\/[^\s:]+:(\d+)/);
      if (m) { clearTimeout(t); res(Number(m[1])); }
    });
    exited.then((r) => { clearTimeout(t); rej(new Error(`the pre-store build exited (${r.code}/${r.signal}): ${stderr}`)); });
  });
  const url = `http://127.0.0.1:${port}`;
  return {
    stdout: () => stdout,
    async login(username, password) {
      const r = await fetch(`${url}/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('observogram_session='));
      return { status: r.status, cookie: cookie ?? null };
    },
    async get(path, cookie, org) {
      const headers = { cookie };
      if (org) headers['x-observogram-org'] = org;
      const r = await fetch(`${url}${path}`, { headers });
      let body = null;
      try { body = await r.json(); } catch { /* not JSON */ }
      return { status: r.status, body };
    },
    async stop() {
      proc.kill('SIGTERM');
      const t = setTimeout(() => proc.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(t);
    },
  };
}

const uploaded = (res) => (res.body?.packs ?? []).filter((p) => p.source === 'uploaded').map((p) => p.id).sort();

async function signsIn(srv, who, password, label) {
  const r = await srv.login(who, password);
  assert(r.status === 200 && !!r.cookie, label, r.status, 200);
  return r.cookie;
}
async function refused(srv, who, password, label) {
  const r = await srv.login(who, password);
  assert(r.status === 401 && !r.cookie, label, r.status, 401);
}

// ---------- the cases ----------

async function flatDeployment() {
  process.stdout.write('\na flat deployment (users.json, no orgs.json):\n');
  const base = tempDir();
  usersJson(base, ['alice', 'bob', 'carol']);
  pack(base, 'p1');
  pack(base, 'p2');
  journey(base, 'nightly', join(base, 'packs', 'p1.pack.yaml'));
  await storeStart(base);
  await change(base, (db) => {
    admin.setLocalPassword(db, 'cli', 'bob', 'bob-new-passw0rd');
    admin.disableUser(db, 'cli', 'carol');
    admin.addLocalUser(db, 'cli', { login: 'dave', password: 'dave-passw0rd', role: 'operator' });
  });
  const r = await exportInPlace(base);
  eq(r.orgs.path, null, 'the export writes no orgs.json');

  const srv = await preStore(base);
  try {
    const alice = await signsIn(srv, 'alice', PW.alice, 'alice signs in');
    await refused(srv, 'bob', PW.bob, "bob's pre-upgrade password is refused");
    await signsIn(srv, 'bob', 'bob-new-passw0rd', 'bob signs in with the password set in the store');
    await refused(srv, 'carol', PW.carol, 'carol, disabled in the store, does not sign in');
    const dave = await signsIn(srv, 'dave', 'dave-passw0rd', 'dave, added in the store, signs in');
    eq((await srv.get('/api/orgs', alice)).body?.tenancy, false, 'no tenancy on the pre-store build');
    eq(uploaded(await srv.get('/api/packs', alice)), ['p1', 'p2'], "alice sees the workspace's packs");
    eq(uploaded(await srv.get('/api/packs', dave)), ['p1', 'p2'], 'dave sees the same packs');
    const j = (await srv.get('/api/journeys', alice)).body?.journeys ?? [];
    eq(j.map((x) => [x.name, x.packA, x.loadError]), [['nightly', slashed(join(base, 'packs', 'p1.pack.yaml')), null]], 'the journey is found and loads');
  } finally {
    await srv.stop();
  }
  await storeStart(base);
  assert(true, 'a store build starts again on the workspace the pre-store build ran on');
}

async function flatPlusCreatedOrg() {
  process.stdout.write('\na flat default org plus a created org:\n');
  const base = tempDir();
  usersJson(base, ['alice', 'bob']);
  pack(base, 'p1');
  journey(base, 'nightly', join(base, 'packs', 'p1.pack.yaml'));
  await storeStart(base);
  await change(base, (db) => {
    admin.createOrgFromAdmin(db, 'cli', { id: 'acme', name: 'Acme', admin: 'bob', base });
    admin.addLocalUser(db, 'cli', { login: 'erin', password: 'erin-passw0rd', role: 'viewer', orgId: 'acme' });
  });
  pack(join(base, 'orgs', 'acme'), 'a1');
  const r = await exportInPlace(base);
  eq(r.orgs.ids, ['default', 'acme'], 'the export writes orgs.json with both orgs');
  eq(r.move, ['packs', 'journeys'], "the export moves the default org's entries to orgs/default");

  const srv = await preStore(base);
  try {
    assert(!/migrated flat workspace/.test(srv.stdout()), 'the pre-store migration finds nothing to move', srv.stdout(), '(no migration line)');
    const bob = await signsIn(srv, 'bob', PW.bob, 'bob signs in');
    const orgs = (await srv.get('/api/orgs', bob)).body;
    eq([orgs?.tenancy, (orgs?.orgs ?? []).map((o) => o.id)], [true, ['default', 'acme']], 'acme exists, and bob is in both orgs');
    eq(uploaded(await srv.get('/api/packs', bob, 'default')), ['p1'], "the default org's packs are found");
    const j = (await srv.get('/api/journeys', bob, 'default')).body?.journeys ?? [];
    const moved = slashed(join(base, 'orgs', 'default', 'packs', 'p1.pack.yaml'));
    eq(j.map((x) => [x.name, x.packA, x.loadError]), [['nightly', moved, null]], "the default org's journey is found, its file: path rewritten");
    eq(uploaded(await srv.get('/api/packs', bob, 'acme')), ['a1'], "acme's packs");
    const erin = await signsIn(srv, 'erin', 'erin-passw0rd', 'erin signs in');
    eq(uploaded(await srv.get('/api/packs', erin, 'acme')), ['a1'], 'erin sees the same packs in acme');
    eq((await srv.get('/api/packs', erin, 'default')).status, 403, 'erin is not a member of the default org');
  } finally {
    await srv.stop();
  }
  await storeStart(base);
  assert(true, 'a store build starts again on the workspace the pre-store build ran on');
}

async function orgsJsonDeployment() {
  process.stdout.write('\nan orgs.json deployment:\n');
  const base = tempDir();
  usersJson(base, ['alice', 'bob', 'carol']);
  writeOrgsFile({
    default: { name: 'Default', members: { alice: 'admin', bob: 'viewer' } },
    beta: { name: 'Beta', members: { carol: 'member' } },
  }, join(base, 'orgs.json'));
  pack(base, 'p1');
  await storeStart(base);
  await change(base, (db) => admin.disableUser(db, 'cli', 'bob'));
  await exportInPlace(base);

  const srv = await preStore(base);
  try {
    const alice = await signsIn(srv, 'alice', PW.alice, 'alice signs in');
    await refused(srv, 'bob', PW.bob, 'bob, disabled in the store, does not sign in');
    const carol = await signsIn(srv, 'carol', PW.carol, 'carol signs in');
    eq(uploaded(await srv.get('/api/packs', alice, 'default')), ['p1'], "the default org's packs");
    eq(((await srv.get('/api/orgs', carol)).body?.orgs ?? []).map((o) => [o.id, o.role]), [['beta', 'member']], 'carol is a member of beta');
  } finally {
    await srv.stop();
  }
  await storeStart(base);
  assert(true, 'a store build starts again on the workspace the pre-store build ran on');
}

process.stdout.write(`store-prestore: the Export gate against ${BUILD}\n`);
for (const c of [flatDeployment, flatPlusCreatedOrg, orgsJsonDeployment]) {
  try {
    await c();
  } catch (e) {
    assert(false, `${c.name}: ${e.stack || e.message}`);
  }
}
report('store-prestore');
