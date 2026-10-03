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
 * journeys are found with their labels; the created org exists. Finally a
 * store build starts again on what the old build left (no refusal).
 *
 * The pack registry (STORE_PLAN slice 4, design §12.2's prestore-live row):
 * the export writes each org's packs/index.json back from the store's rows
 * AFTER reconciling the pack files with them, so the old build adopts
 * nothing and the labels travel both ways; the old build's READ of a pack
 * (its lastUsedAt flush) never refuses the re-upgrade; its REGISTER of a
 * pack (POST /api/crawl with a label — the register route v0.4.0 takes a
 * label on; /api/validate takes none) makes the store build refuse naming
 * `packc store import --replace`, after which the pack has a row with the
 * label the old build gave it.
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
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
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
const { exportStore, requestReplace } = await import('../server/store/ops.mjs');
const { bootStore, BootRefusal } = await import('../server/boot.mjs');
const { hashPassword } = await import('../server/auth.mjs');
const admin = await import('../server/identity-admin.mjs');
const packsRepo = await import('../server/store/packs.mjs');
const { runWithOrg } = await import('../server/org-context.mjs');

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

// → the boot's log lines; a BootRefusal is thrown (the caller asserts it).
async function storeStart(base) {
  process.env.OBSERVOGRAM_WORKSPACE = base;
  const logs = [];
  try {
    await bootStore({ host: '127.0.0.1', log: (m) => logs.push(m) });
  } finally {
    closeStore(dbOf(base));
    delete process.env.OBSERVOGRAM_WORKSPACE;
  }
  return logs;
}
async function storeRefuses(base, label) {
  try {
    await storeStart(base);
  } catch (e) {
    assert(e instanceof BootRefusal, label, e.message, 'a BootRefusal');
    return e;
  }
  assert(false, label, 'the start passed', 'a BootRefusal');
  return null;
}
async function change(base, fn) {
  const db = await openStore({ path: dbOf(base) });
  try { return fn(db); } finally { closeStore(dbOf(base)); }
}
const exportInPlace = (base) => exportStore(base, { dbPath: dbOf(base), base, out: { write() {} } });
const requestIt = (base) => requestReplace({ dbPath: dbOf(base), base, out: { write() {} } });
const packRows = (db, org) => runWithOrg(org, () => packsRepo.listPacks(db).map((p) => [p.id, p.label, p.source]));
const relabel = (db, org, id, label) => runWithOrg(org, () => packsRepo.upsertPack(db, 'cli', { id, label, source: packsRepo.getPack(db, id).source }));
const readIndex = (path) => JSON.parse(readFileSync(path, 'utf8'));
// The old build flushes index.json 1.5 s after a read (touchWorkspacePack → scheduleIndexFlush): wait for the bytes to change.
async function indexRewritten(path, before, label) {
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(path) && readFileSync(path, 'utf8') !== before) { assert(true, label); return; }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(false, label, 'index.json unchanged after 10 s', 'a rewrite');
}

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
    // A session-authenticated mutation on the old build: its CSRF header.
    async post(path, body, cookie, org) {
      const headers = { cookie, 'content-type': 'application/json', 'x-observogram-csrf': '1' };
      if (org) headers['x-observogram-org'] = org;
      const r = await fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
      let out = null;
      try { out = await r.json(); } catch { /* not JSON */ }
      return { status: r.status, body: out };
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
// The old build's label for each uploaded pack: the index entry's, or (uploadedMeta's fallback) the pack's name, or its id.
const labelled = (res) => (res.body?.packs ?? []).filter((p) => p.source === 'uploaded').map((p) => [p.id, p.label]).sort();

// A small repository the old build's crawler turns into a valid pack (server/test-smoke.mjs's crawl fixture).
const CRAWL_FILES = {
  'docker-compose.yml': `version: '3.8'\nservices:\n  prometheus:\n    image: prom/prometheus:v2.51.0\n    ports: ["9090:9090"]\n  grafana:\n    image: grafana/grafana:12.0.0\n    ports: ["3000:3000"]\n`,
  'rules.yml': `groups:\n  - name: g\n    rules:\n      - record: smoke:availability:ratio\n        expr: sum(rate(req_total[5m]))\n`,
  'dashboards/svc.json': JSON.stringify({ title: 'svc', uid: 'svc', schemaVersion: 41, version: 1, panels: [{ title: 'p', type: 'stat' }] }),
  'alertmanager.yml': `route:\n  receiver: oncall\nreceivers:\n  - name: oncall\n    msteams_configs:\n      - channel_url: '#oncall'\n`,
};

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
    relabel(db, 'default', 'p2', 'Second');
  });
  const r = await exportInPlace(base);
  eq(r.orgs.path, null, 'the export writes no orgs.json');
  eq(r.indexes.map((i) => [i.org, i.write, i.packs.map((p) => p.id)]), [['default', true, ['p1', 'p2']]], 'the export writes packs/index.json from the rows');

  const srv = await preStore(base);
  try {
    const alice = await signsIn(srv, 'alice', PW.alice, 'alice signs in');
    await refused(srv, 'bob', PW.bob, "bob's pre-upgrade password is refused");
    await signsIn(srv, 'bob', 'bob-new-passw0rd', 'bob signs in with the password set in the store');
    await refused(srv, 'carol', PW.carol, 'carol, disabled in the store, does not sign in');
    const dave = await signsIn(srv, 'dave', 'dave-passw0rd', 'dave, added in the store, signs in');
    eq((await srv.get('/api/orgs', alice)).body?.tenancy, false, 'no tenancy on the pre-store build');
    eq(uploaded(await srv.get('/api/packs', alice)), ['p1', 'p2'], "alice sees the workspace's packs");
    eq(labelled(await srv.get('/api/packs', alice)), [['p1', 'p1'], ['p2', 'Second']], 'with their labels: the one set in the store, the name for the other');
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
  pack(join(base, 'orgs', 'acme'), 'a1');   // copied in after the boot: no row until the export's reconcile adopts it (B1)
  const r = await exportInPlace(base);
  eq(r.orgs.ids, ['default', 'acme'], 'the export writes orgs.json with both orgs');
  eq(r.move, ['packs', 'journeys'], "the export moves the default org's entries to orgs/default");
  eq(r.indexes.map((i) => [i.org, i.adopt.map((a) => a.id), i.packs.map((p) => p.id)]), [['default', [], ['p1']], ['acme', ['a1'], ['a1']]], 'the export adopts a1 before it writes acme\'s index');
  const acmeIdx = join(base, 'orgs', 'acme', 'packs', 'index.json');
  const acmeIdxBefore = readFileSync(acmeIdx, 'utf8');

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
    eq(labelled(await srv.get('/api/packs', bob, 'acme')), [['a1', 'a1']], "acme's packs, a1 listed from the index the export wrote (nothing to adopt)");
    const erin = await signsIn(srv, 'erin', 'erin-passw0rd', 'erin signs in');
    eq(uploaded(await srv.get('/api/packs', erin, 'acme')), ['a1'], 'erin sees the same packs in acme');
    eq((await srv.get('/api/packs', erin, 'default')).status, 403, 'erin is not a member of the default org');
    // (i) the old build READS a1: its touch flushes lastUsedAt into the index — bookkeeping, not a change.
    eq((await srv.get('/api/packs/a1/canonical', bob, 'acme')).status, 200, 'bob reads a1 on the old build');
    await indexRewritten(acmeIdx, acmeIdxBefore, 'the old build rewrote acme\'s index.json (its lastUsedAt flush)');
    eq(Object.keys(readIndex(acmeIdx)), ['a1'], 'the same entries: nothing adopted or pruned by the old build');
  } finally {
    await srv.stop();
  }
  const logs = await storeStart(base);
  assert(true, 'a store build starts again on the workspace the pre-store build ran on — a read is not an edit');
  const indexLines = logs.filter((l) => /index\.json/.test(l));
  assert(indexLines.includes(`[store] ${acmeIdx} was rewritten by a build before slice 4 (lastUsedAt only — bookkeeping, not a change); the store's registry stands`),
    'the bookkeeping line for acme\'s index, no refusal', indexLines, 'the acme line');
  // The old build also touched p1 (the journey load reads it): every line is a bookkeeping one.
  eq(indexLines.filter((l) => !/lastUsedAt only — bookkeeping/.test(l)), [], 'nothing but bookkeeping lines about the indexes');
  await change(base, (db) => eq(packRows(db, 'acme'), [['a1', null, 'workspace']], 'the store\'s registry stands'));
}

// (ii) The old build REGISTERS a pack with a label (POST /api/crawl — the
// register route v0.4.0 takes a label on) and reads another: the store
// build refuses naming `packc store import --replace`; after it the new
// pack has a row with the label the old build gave it, and the next start
// passes.
async function rollbackReadsAndRegisters() {
  process.stdout.write('\na rollback that reads and registers packs:\n');
  const base = tempDir();
  usersJson(base, ['alice']);
  pack(base, 'p1');
  await storeStart(base);
  await change(base, (db) => relabel(db, 'default', 'p1', 'First'));
  await exportInPlace(base);
  const idx = join(base, 'packs', 'index.json');
  const before = readFileSync(idx, 'utf8');

  let registeredId = null;
  const srv = await preStore(base);
  try {
    const alice = await signsIn(srv, 'alice', PW.alice, 'alice signs in');
    eq(labelled(await srv.get('/api/packs', alice)), [['p1', 'First']], 'the label set in the store travels to the old build');
    eq((await srv.get('/api/packs/p1/canonical', alice)).status, 200, 'alice reads p1 (a touch)');
    const crawl = await srv.post('/api/crawl', { repoName: 'rollback-scan', label: 'Rollback scan', files: CRAWL_FILES }, alice);
    registeredId = crawl.body?.registered?.id ?? null;
    assert(crawl.status === 200 && typeof registeredId === 'string' && registeredId.startsWith('uploaded-'), 'the old build registers the crawled pack', crawl.status, 200);
    eq(labelled(await srv.get('/api/packs', alice)), [['p1', 'First'], [registeredId, 'Rollback scan']].sort(), 'the old build lists it with its label');
    await indexRewritten(idx, before, 'the old build wrote the register into index.json');
  } finally {
    await srv.stop();
  }
  // A registered entry differs from what the store would adopt (a label, a source): refused, naming the way out.
  const e = await storeRefuses(base, 'the store build refuses: the old build registered a pack');
  if (e) {
    assert(e.message.startsWith(`refusing to start: ${idx} changed since store `) && /registered, relabelled or removed a pack during a rollback \(the registry it wrote: 2 entries, the store's: 2\)/.test(e.message),
      'the refusal names the index and what the old build did', e.message, '… changed since store … (the registry it wrote: 2 entries, the store\'s: 2)');
    assert(e.message.includes('  - run `packc store import --replace`: the next start takes the file\'s entries into the store'), 'the first way out is import --replace', e.message, 'run `packc store import --replace`');
  }
  await change(base, (db) => eq(packRows(db, 'default'), [['p1', 'First', 'workspace']], 'the refusal read nothing into the store'));
  await requestIt(base);
  const logs = await storeStart(base);
  eq(logs.filter((l) => /packs:/.test(l)), [`[store]   packs: default: added ${registeredId}`], 'the replace takes the register in');
  await change(base, (db) => eq(packRows(db, 'default'), [['p1', 'First', 'workspace'], [registeredId, 'Rollback scan', 'Rollback scan']], 'the row carries the label (and the source) the old build gave it'));
  const again = await storeStart(base);
  eq(again.filter((l) => /index\.json|packs:/.test(l)), [], 'the start after passes');
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
for (const c of [flatDeployment, flatPlusCreatedOrg, orgsJsonDeployment, rollbackReadsAndRegisters]) {
  try {
    await c();
  } catch (e) {
    assert(false, `${c.name}: ${e.stack || e.message}`);
  }
}
report('store-prestore');
