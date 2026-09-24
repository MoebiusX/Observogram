#!/usr/bin/env node
/**
 * server/test-store-boot.mjs — the boot of a store build through start(),
 * in child processes (docs/STORE_PLAN.md §4, §8 gates Boot order, Stale
 * import (the 2a part), CLI, Arming (the CLI half), OIDC upgrade (the boot
 * switches), Journey engine; removed orgs, the every-boot warnings,
 * :memory: and pre-upgrade cookies).
 *
 * Every server is a child: initAuth() decides the posture at import, and a
 * boot must see exactly the env its test gives it. Children get an
 * explicit env — this process's minus every variable a boot reads, plus the
 * test's own — and are spawned as process.execPath with the script, never
 * through npm. The parent inspects each database read-only after the child
 * exits (or while it runs, for the HTTP cases).
 */

// Hermetic (§0): a developer shell's store or identity variables never
// reach a child or this process's own imports.
const STRIP = [
  'DB', 'BOOTSTRAP_ADMIN', 'OIDC_JOIN_ROLE', 'ADMIN_PASSWORD', 'INSECURE_NO_AUTH', 'WORKSPACE', 'USERS_FILE',
  'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URL', 'OIDC_ALLOW_HTTP', 'OIDC_SECURE_COOKIES',
  'SESSION_SECRET', 'API_TOKEN', 'API_TOKEN_LABEL', 'AUTH',
];
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { spawn, spawnSync } = await import('node:child_process');
const { createHmac } = await import('node:crypto');
const {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} = await import('node:fs');
const { tmpdir } = await import('node:os');
const { dirname, join } = await import('node:path');
const { fileURLToPath, pathToFileURL } = await import('node:url');

const { openRaw, prepare } = await import('./store/db.mjs');
const { hashPassword, verifyPassword } = await import('./auth.mjs');
const { writeUsersFile, writeOrgsFile } = await import('./store/legacy-files.mjs');
const { canonIssuer } = await import('./store/identity.mjs');
const { SPEC_DIR } = await import('../tools/lib/validator.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const INDEX_URL = pathToFileURL(join(HERE, 'index.mjs')).href;
const USER_ADMIN = join(ROOT, 'tools', 'user-admin.mjs');
const ORG_ADMIN = join(ROOT, 'tools', 'org-admin.mjs');
const PACKC = join(ROOT, 'tools', 'cli.mjs');

const tmpDirs = [];
function workspace(tag = 'boot') {
  const d = mkdtempSync(join(tmpdir(), `observogram-${tag}-`));
  tmpDirs.push(d);
  return d;
}
process.on('exit', () => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

// ---------- fixtures ----------

const REAL = hashPassword('real-passw0rd');
const SEEDED = hashPassword('admin');
const usersFile = (ws, users) => writeUsersFile({ users }, join(ws, 'users.json'));
const orgsFile = (ws, orgs) => writeOrgsFile(orgs, join(ws, 'orgs.json'));
const flatPack = (ws) => { mkdirSync(join(ws, 'packs'), { recursive: true }); writeFileSync(join(ws, 'packs', 'flat.pack.yaml'), 'name: flat\n'); };
const dbFile = (ws) => join(ws, 'observogram.db');
const removeDb = (path) => { for (const s of ['', '-wal', '-shm']) rmSync(`${path}${s}`, { force: true }); };

const ISSUER = 'http://127.0.0.1:9';        // never contacted: discovery is lazy
const KEY = canonIssuer(ISSUER);
const OIDC_ENV = {
  OBSERVOGRAM_OIDC_ISSUER: ISSUER, OBSERVOGRAM_OIDC_CLIENT_ID: 'studio', OBSERVOGRAM_OIDC_ALLOW_HTTP: '1',
  OBSERVOGRAM_SESSION_SECRET: 'boot-suite-session-secret-0123456789-abc',
};

function childEnv(ws, extra = {}) {
  const env = { ...process.env };
  for (const k of STRIP) { delete env[`OBSERVOGRAM_${k}`]; delete env[`TOMOGRAPH_${k}`]; }
  if (ws) env.OBSERVOGRAM_WORKSPACE = ws;
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}

// ---------- the children ----------

const BOOT_CODE = `
const { start } = await import(${JSON.stringify(INDEX_URL)});
try {
  const srv = await start({ port: 0, host: process.env.BOOT_HOST, silent: process.env.BOOT_SILENT === '1' });
  process.stdout.write('LISTENING ' + srv.address().port + '\\n');
  if (process.env.BOOT_KEEP !== '1') { srv.close(); process.exit(0); }
} catch (e) {
  process.stdout.write('REFUSED ' + JSON.stringify({ message: e.message, code: e.code ?? null, nothingMoved: e.nothingMoved ?? null }) + '\\n');
  process.exit(3);
}
`;

function parseBoot(stdout) {
  const listening = /^LISTENING (\d+)$/m.exec(stdout);
  if (listening) return { listening: true, port: Number(listening[1]) };
  const refused = /^REFUSED (.*)$/m.exec(stdout);
  if (refused) return { listening: false, ...JSON.parse(refused[1]) };
  return { listening: false, message: null };
}

// One boot that exits: { listening, port?, message?, code?, nothingMoved?, stdout, stderr }.
function boot(ws, { host = '127.0.0.1', env = {}, silent = true } = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', BOOT_CODE], {
    env: childEnv(ws, { ...env, BOOT_HOST: host, BOOT_SILENT: silent ? '1' : '0' }), encoding: 'utf8', timeout: 60_000,
  });
  const out = { ...parseBoot(r.stdout), stdout: r.stdout, stderr: r.stderr, status: r.status };
  if (out.message === null) throw new Error(`the boot child printed neither LISTENING nor REFUSED (status ${r.status}): ${r.stderr}`);
  return out;
}

// A server that keeps running: { base, stop() }.
async function serve(ws, { host = '127.0.0.1', env = {} } = {}) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', BOOT_CODE], {
    env: childEnv(ws, { ...env, BOOT_HOST: host, BOOT_SILENT: '1', BOOT_KEEP: '1' }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (c) => { stderr += c; });
  const exited = new Promise((res) => proc.on('exit', (code, signal) => res({ code, signal })));
  const port = await new Promise((res, rej) => {
    const t = setTimeout(() => { proc.kill('SIGKILL'); rej(new Error(`no LISTENING in 60 s: ${stderr}`)); }, 60_000);
    proc.stdout.on('data', (c) => {
      stdout += c;
      const b = parseBoot(stdout);
      if (b.listening) { clearTimeout(t); res(b.port); } else if (b.message !== null) { clearTimeout(t); rej(new Error(`refused: ${b.message}`)); }
    });
    exited.then((r) => { clearTimeout(t); rej(new Error(`the server exited (${r.code}/${r.signal}): ${stderr}`)); });
  });
  return {
    base: `http://127.0.0.1:${port}`,
    stop: async () => {
      proc.kill('SIGTERM');
      const t = setTimeout(() => proc.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(t);
    },
  };
}

// A CLI: process.execPath with the script, an explicit env, input piped.
function cli(script, args, ws, { env = {}, input = '' } = {}) {
  return spawnSync(process.execPath, [script, ...args], { env: childEnv(ws, env), input, encoding: 'utf8', timeout: 60_000 });
}

// ---------- the parent's read-only view of a database ----------

async function inspect(path, fn) {
  const db = await openRaw(path, { readOnly: true });
  try {
    return fn({
      meta: (key) => prepare(db, 'SELECT value FROM schema_meta WHERE key = ?').get(key)?.value ?? null,
      users: () => prepare(db, 'SELECT * FROM users ORDER BY id').all(),
      user: (login) => prepare(db, 'SELECT * FROM users WHERE login = ?').get(login) ?? null,
      roles: (login) => prepare(db, `SELECT m.org_id, m.role FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE u.login = ? ORDER BY m.created_at, m.rowid`).all(login).map((m) => `${m.org_id}:${m.role}`),
      orgs: () => prepare(db, 'SELECT id, root, removed_at FROM orgs ORDER BY created_at, rowid').all(),
      audit: (action) => prepare(db, 'SELECT * FROM audit WHERE action = ? ORDER BY seq').all(action),
      count: (sql) => prepare(db, sql).get().n,
    });
  } finally {
    db.close();
  }
}
const inspectWs = (ws, fn) => inspect(dbFile(ws), fn);
const rowsOf = (v) => JSON.stringify({
  users: v.users().map((u) => [u.login, u.kind, u.disabled, u.is_owner, u.session_epoch, u.password]),
  orgs: v.orgs(),
  memberships: v.count('SELECT count(*) AS n FROM memberships'),
});

const MSG_A = /refusing to bind to 0\.0\.0\.0 without auth/;
const MSG_B = /refusing to bind to 0\.0\.0\.0 while the seeded default admin password is unchanged/;

async function signIn(base, username, password) {
  const r = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
  });
  const cookie = (name) => (r.headers.getSetCookie?.() || []).find((c) => c.startsWith(`${name}=`))?.split(';')[0] ?? null;
  return { status: r.status, json: await r.json().catch(() => null), session: cookie('observogram_session'), pwflow: cookie('observogram_pwflow') };
}

// ====================== the Boot order gate ======================

test('boot order 1: users.json admin with a real password boots with and without OBSERVOGRAM_ADMIN_PASSWORD, on loopback and 0.0.0.0', async () => {
  for (const pw of [null, 'env-passw0rd-1']) {
    for (const host of ['127.0.0.1', '0.0.0.0']) {
      const ws = workspace();
      usersFile(ws, { admin: { name: 'Admin', createdAt: 't', password: REAL }, bob: { createdAt: 't', password: REAL } });
      const r = boot(ws, { host, env: pw ? { OBSERVOGRAM_ADMIN_PASSWORD: pw } : {} });
      assert.ok(r.listening, `${host} ${pw ? 'with' : 'without'} the env password: ${r.message}`);
      await inspectWs(ws, (v) => {
        assert.deepEqual(v.users().map((u) => u.login), ['admin', 'bob'], 'exactly the imported users; no second admin');
        assert.ok(verifyPassword('real-passw0rd', JSON.parse(v.user('admin').password)), 'the real password is kept');
      });
    }
  }
});

test('boot order 2: a still-seeded users.json plus a token on 0.0.0.0 refuses (B); nothing imported or moved', async () => {
  const ws = workspace();
  usersFile(ws, { admin: { name: 'Admin', createdAt: 't', password: SEEDED, mustChange: true, seededDefault: true } });
  flatPack(ws);
  const bytes = readFileSync(join(ws, 'users.json'));
  const r = boot(ws, { host: '0.0.0.0', env: { OBSERVOGRAM_API_TOKEN: 'tok-0123456789' } });
  assert.ok(!r.listening && MSG_B.test(r.message) && r.nothingMoved === true, r.message);
  await inspectWs(ws, (v) => assert.equal(v.meta('import_done'), null));
  assert.ok(readFileSync(join(ws, 'users.json')).equals(bytes) && existsSync(join(ws, 'packs', 'flat.pack.yaml')) && !existsSync(join(ws, 'orgs')));
});

test('boot order 3: a corrupt users.json, and a corrupt orgs.json, abort naming the path; orgs.json byte-identical', async () => {
  const ws = workspace();
  writeFileSync(join(ws, 'users.json'), '{ not json');
  let r = boot(ws);
  assert.ok(!r.listening && r.code === 'ERR_OBSERVOGRAM_LEGACY_FILE' && r.message.includes(join(ws, 'users.json')), r.message);
  await inspectWs(ws, (v) => assert.equal(v.meta('import_done'), null));

  const ws2 = workspace();
  writeFileSync(join(ws2, 'orgs.json'), '{ "acme": [');
  flatPack(ws2);
  const bytes = readFileSync(join(ws2, 'orgs.json'));
  r = boot(ws2);
  assert.ok(!r.listening && r.code === 'ERR_OBSERVOGRAM_LEGACY_FILE' && r.message.includes(join(ws2, 'orgs.json')), r.message);
  assert.ok(readFileSync(join(ws2, 'orgs.json')).equals(bytes) && existsSync(join(ws2, 'packs', 'flat.pack.yaml')));
  await inspectWs(ws2, (v) => assert.equal(v.meta('import_done'), null));
});

test('boot order 4: a fresh workspace on 0.0.0.0 with only OBSERVOGRAM_ADMIN_PASSWORD boots; admin is an owner, not must_change', async () => {
  const ws = workspace();
  const r = boot(ws, { host: '0.0.0.0', env: { OBSERVOGRAM_ADMIN_PASSWORD: 'env-passw0rd-4' } });
  assert.ok(r.listening, r.message);
  await inspectWs(ws, (v) => {
    const admin = v.user('admin');
    assert.ok(admin.is_owner === 1 && admin.must_change === 0 && verifyPassword('env-passw0rd-4', JSON.parse(admin.password)));
    assert.ok(v.meta('import_done'));
  });
});

test('boot order 5: a still-seeded users.json on 0.0.0.0 with OBSERVOGRAM_ADMIN_PASSWORD boots (rescued); with a token it refuses', async () => {
  const ws = workspace();
  usersFile(ws, { admin: { name: 'Admin', createdAt: 't', password: SEEDED, mustChange: true, seededDefault: true } });
  const r = boot(ws, { host: '0.0.0.0', env: { OBSERVOGRAM_ADMIN_PASSWORD: 'rescue-passw0rd' } });
  assert.ok(r.listening, r.message);
  await inspectWs(ws, (v) => {
    const admin = v.user('admin');
    assert.ok(admin.must_change === 0 && admin.seeded_default === 0 && verifyPassword('rescue-passw0rd', JSON.parse(admin.password)));
  });

  const ws2 = workspace();
  usersFile(ws2, { admin: { name: 'Admin', createdAt: 't', password: SEEDED, mustChange: true, seededDefault: true } });
  const r2 = boot(ws2, { host: '0.0.0.0', env: { OBSERVOGRAM_ADMIN_PASSWORD: 'rescue-passw0rd', OBSERVOGRAM_API_TOKEN: 'tok-0123456789' } });
  assert.ok(!r2.listening && MSG_B.test(r2.message) && r2.nothingMoved === true, r2.message);
  await inspectWs(ws2, (v) => assert.equal(v.meta('import_done'), null));
});

test('boot order 6: a store initialised by `users -- add` boots on 0.0.0.0 with no token; no admin is seeded', async () => {
  const ws = workspace();
  const c = cli(USER_ADMIN, ['add', 'alice', '--password-stdin'], ws, { input: 'alice-passw0rd\n' });
  assert.equal(c.status, 0, c.stderr);
  const r = boot(ws, { host: '0.0.0.0' });
  assert.ok(r.listening, r.message);
  await inspectWs(ws, (v) => {
    assert.deepEqual(v.users().map((u) => u.login), ['alice']);
    assert.ok(v.meta('import_done'));
  });
});

test('boot order 7: seeded admin/admin on loopback, rebooted on 0.0.0.0 with OBSERVOGRAM_ADMIN_PASSWORD, boots with the replaced password', async () => {
  const ws = workspace();
  assert.ok(boot(ws).listening);
  await inspectWs(ws, (v) => assert.ok(v.user('admin').seeded_default === 1));
  const r = boot(ws, { host: '0.0.0.0', env: { OBSERVOGRAM_ADMIN_PASSWORD: 'replaced-passw0rd' } });
  assert.ok(r.listening, r.message);
  await inspectWs(ws, (v) => {
    const admin = v.user('admin');
    assert.ok(admin.must_change === 0 && verifyPassword('replaced-passw0rd', JSON.parse(admin.password)) && v.users().length === 1);
  });
});

test('boot order 8: a token-only store rebooted on 0.0.0.0 with only OBSERVOGRAM_ADMIN_PASSWORD seeds admin as owner', async () => {
  const ws = workspace();
  assert.ok(boot(ws, { env: { OBSERVOGRAM_API_TOKEN: 'tok-0123456789' } }).listening);
  await inspectWs(ws, (v) => assert.equal(v.users().length, 0));
  const r = boot(ws, { host: '0.0.0.0', env: { OBSERVOGRAM_ADMIN_PASSWORD: 'late-passw0rd' } });
  assert.ok(r.listening, r.message);
  await inspectWs(ws, (v) => assert.ok(v.user('admin')?.is_owner === 1 && v.meta('identity_armed') === '1'));
});

test('boot order 9: OBSERVOGRAM_AUTH=off on 0.0.0.0 with no token refuses (A) — with OIDC env, and on a CLI-armed store', async () => {
  const ws = workspace();
  let r = boot(ws, { host: '0.0.0.0', env: { ...OIDC_ENV, OBSERVOGRAM_AUTH: 'off' } });
  assert.ok(!r.listening && MSG_A.test(r.message), r.message);
  await inspectWs(ws, (v) => assert.equal(v.meta('import_done'), null));

  const ws2 = workspace();
  assert.equal(cli(USER_ADMIN, ['add', 'alice', '--password-stdin'], ws2, { input: 'alice-passw0rd\n' }).status, 0);
  r = boot(ws2, { host: '0.0.0.0', env: { OBSERVOGRAM_AUTH: 'off' } });
  assert.ok(!r.listening && MSG_A.test(r.message), r.message);
  await inspectWs(ws2, (v) => assert.equal(v.meta('import_done'), null));
});

test('boot order 10: a multi-org orgs.json with no identity refuses (C); a one-org orgs.json with only a bearer boots token-only', async () => {
  const ws = workspace();
  orgsFile(ws, { acme: { members: {} }, bravo: { members: {} } });
  const bytes = readFileSync(join(ws, 'orgs.json'));
  let r = boot(ws);
  assert.ok(!r.listening && /orgs\.json would leave 2 orgs \(acme, bravo\) but no identity/.test(r.message) && r.nothingMoved === true, r.message);
  assert.ok(readFileSync(join(ws, 'orgs.json')).equals(bytes));
  await inspectWs(ws, (v) => assert.equal(v.meta('import_done'), null));

  // One org, but the flat data would add 'default': two orgs.
  const ws2 = workspace();
  orgsFile(ws2, { acme: { members: {} } });
  flatPack(ws2);
  r = boot(ws2);
  assert.ok(!r.listening && /orgs\.json would leave 2 orgs/.test(r.message), r.message);
  assert.ok(existsSync(join(ws2, 'packs', 'flat.pack.yaml')) && !existsSync(join(ws2, 'orgs')), 'nothing moved');
  await inspectWs(ws2, (v) => assert.equal(v.meta('import_done'), null));

  const ws3 = workspace();
  orgsFile(ws3, { acme: { name: 'Acme', members: {} } });
  const s = await serve(ws3, { env: { OBSERVOGRAM_API_TOKEN: 'tok-0123456789' } });
  try {
    let h = await fetch(`${s.base}/api/packs`);
    assert.ok(h.status === 200 && h.headers.get('x-observogram-org') === 'acme', `anonymous GET ${h.status}`);
    h = await fetch(`${s.base}/api/validate`, { method: 'POST', headers: { 'Content-Type': 'text/yaml' }, body: 'x: 1' });
    assert.ok(h.status === 401 && (h.headers.get('www-authenticate') || '').includes('Bearer'), `anonymous POST ${h.status}`);
  } finally {
    await s.stop();
  }
});

// Check C's step-3 text names only ways out that work in this build (A-60):
// every CLI refuses until a first start imports, so the text must not send
// the operator to `npm run users` first. Each named step is run here.
test('boot order 10b: check C (step 3) names a way out that works — trim orgs.json (or move it aside), start once, then users -- add and orgs -- create --adopt', async () => {
  const TOKEN = { OBSERVOGRAM_API_TOKEN: 'tok-0123456789' };
  const addAlice = (ws) => cli(USER_ADMIN, ['add', 'alice', '--password-stdin'], ws, { input: 'correct-horse-9\n' });
  const bravoPack = (ws, id) => { mkdirSync(join(ws, 'orgs', id, 'packs'), { recursive: true }); writeFileSync(join(ws, 'orgs', id, 'packs', 'p.pack.yaml'), 'name: p\n'); };
  const refusedC = (r) => {
    assert.ok(!r.listening && r.nothingMoved === true, r.message);
    for (const step of ['edit orgs.json down to one org', 'move it aside', 'npm run users -- add <login>', 'npm run orgs -- create <id> --adopt']) {
      assert.ok(r.message.includes(step), `check C names "${step}": ${r.message}`);
    }
    assert.ok(!/users\.json \/ npm run users/.test(r.message), 'no way out this build cannot take');
  };

  // Two orgs in orgs.json: the CLIs refuse first; trimming orgs.json to one gets out.
  const ws = workspace();
  orgsFile(ws, { acme: { members: {} }, bravo: { members: {} } });
  bravoPack(ws, 'bravo');
  refusedC(boot(ws, { env: TOKEN }));
  let c = addAlice(ws);
  assert.ok(c.status === 1 && /not imported yet/.test(c.stderr), 'the CLIs refuse before the first start');
  orgsFile(ws, { acme: { members: {} } });
  assert.ok(boot(ws, { env: TOKEN }).listening, 'one org boots with a bearer token');
  c = addAlice(ws);
  assert.equal(c.status, 0, c.stderr);
  c = cli(ORG_ADMIN, ['create', 'bravo', '--adopt', '--admin', 'alice'], ws);
  assert.equal(c.status, 0, c.stderr);
  assert.ok(boot(ws, { env: TOKEN }).listening, 'two orgs boot once identity is armed');
  await inspectWs(ws, (v) => {
    assert.deepEqual(v.orgs().map((o) => [o.id, o.root]), [['acme', 'orgs/acme'], ['bravo', 'orgs/bravo']]);
    assert.deepEqual(v.roles('alice'), ['acme:admin', 'bravo:admin']);
  });

  // One org in orgs.json plus flat data (the second org is 'default'): moving orgs.json aside gets out.
  const ws2 = workspace();
  orgsFile(ws2, { acme: { members: {} } });
  flatPack(ws2);
  bravoPack(ws2, 'acme');
  refusedC(boot(ws2, { env: TOKEN }));
  renameSync(join(ws2, 'orgs.json'), join(ws2, 'orgs.json.aside'));
  assert.ok(boot(ws2, { env: TOKEN }).listening, 'the flat workspace boots as the default org');
  c = addAlice(ws2);
  assert.equal(c.status, 0, c.stderr);
  c = cli(ORG_ADMIN, ['create', 'acme', '--adopt'], ws2);
  assert.equal(c.status, 0, c.stderr);
  assert.ok(boot(ws2, { env: TOKEN }).listening);
  await inspectWs(ws2, (v) => assert.deepEqual(v.orgs().map((o) => [o.id, o.root]), [['default', '.'], ['acme', 'orgs/acme']]));
  assert.ok(existsSync(join(ws2, 'packs', 'flat.pack.yaml')) && existsSync(join(ws2, 'orgs', 'acme', 'packs', 'p.pack.yaml')), 'every file stays where it was');
});

test('boot order 11: an orgs.json-armed workspace whose flat data the migration moved boots a second time, moving nothing', async () => {
  const ws = workspace();
  usersFile(ws, { alice: { createdAt: 't', password: REAL } });
  orgsFile(ws, { acme: { members: { alice: 'admin' } } });
  flatPack(ws);
  assert.ok(boot(ws).listening);
  assert.ok(existsSync(join(ws, 'orgs', 'default', 'packs', 'flat.pack.yaml')) && !existsSync(join(ws, 'packs')));
  const names = (d) => readdirSync(d, { recursive: true }).filter((n) => !/observogram\.db/.test(n)).sort();
  const before = names(ws);
  const r = boot(ws);
  assert.ok(r.listening, r.message);
  assert.deepEqual(names(ws), before);
});

test('boot order 12: every check passed in step 3 passes again in step 4 — the same workspace rebooted with the same env boots', async () => {
  const cases = [
    ['a users.json with a real admin, 0.0.0.0', (ws) => usersFile(ws, { admin: { createdAt: 't', password: REAL } }), { host: '0.0.0.0' }],
    ['a fresh workspace with OBSERVOGRAM_ADMIN_PASSWORD, 0.0.0.0', () => {}, { host: '0.0.0.0', env: { OBSERVOGRAM_ADMIN_PASSWORD: 'env-passw0rd-12' } }],
    ['a one-org orgs.json and a token, 0.0.0.0', (ws) => orgsFile(ws, { solo: { members: {} } }), { host: '0.0.0.0', env: { OBSERVOGRAM_API_TOKEN: 'tok-0123456789' } }],
    ['two orgs with stand-alone identity', (ws) => { usersFile(ws, { alice: { createdAt: 't', password: REAL } }); orgsFile(ws, { acme: { members: { alice: 'admin' } }, bravo: { members: {} } }); }, {}],
    ['a still-seeded admin rescued on 0.0.0.0', (ws) => usersFile(ws, { admin: { createdAt: 't', password: SEEDED, mustChange: true, seededDefault: true } }), { host: '0.0.0.0', env: { OBSERVOGRAM_ADMIN_PASSWORD: 'env-passw0rd-12' } }],
  ];
  for (const [label, fixture, opts] of cases) {
    const ws = workspace();
    fixture(ws);
    const first = boot(ws, opts);
    assert.ok(first.listening, `${label} (import boot): ${first.message}`);
    const second = boot(ws, opts);
    assert.ok(second.listening, `${label} (step 4 only): ${second.message}`);
  }
});

test('boot order 13: a one-org orgs.json with no token and no identity seeds admin/admin on loopback, twice to the same posture; 0.0.0.0 refuses (A)', async () => {
  const ws = workspace();
  orgsFile(ws, { acme: { name: 'Acme', members: {} } });
  let s = await serve(ws);
  try {
    assert.equal((await fetch(`${s.base}/api/packs`)).status, 401, 'anonymous /api 401');
    const r = await signIn(s.base, 'admin', 'admin');
    assert.ok(r.status === 200 && r.json?.mustChange === true && r.pwflow && !r.session, 'admin/admin signs in into the forced change');
  } finally {
    await s.stop();
  }
  await inspectWs(ws, (v) => {
    const admin = v.user('admin');
    assert.ok(admin.is_owner === 1 && admin.seeded_default === 1 && admin.must_change === 1);
    assert.deepEqual(v.roles('admin'), ['acme:admin']);
  });
  s = await serve(ws);
  try {
    assert.equal((await fetch(`${s.base}/api/packs`)).status, 401, 'the second boot: the same posture');
  } finally {
    await s.stop();
  }
  await inspectWs(ws, (v) => assert.equal(v.users().length, 1, 'no second seed'));

  const ws2 = workspace();
  orgsFile(ws2, { acme: { name: 'Acme', members: {} } });
  const r = boot(ws2, { host: '0.0.0.0' });
  assert.ok(!r.listening && MSG_A.test(r.message) && r.nothingMoved === true, r.message);
  await inspectWs(ws2, (v) => { assert.equal(v.meta('import_done'), null); assert.equal(v.users().length, 0); });
});

// ====================== Stale import (2a) ======================

test('stale import: a deleted database refuses (a); so does another OBSERVOGRAM_DB; `packc store restore` of a backup passes', async () => {
  const ws = workspace();
  usersFile(ws, { alice: { createdAt: 't', password: REAL } });
  assert.ok(boot(ws).listening);
  const storeId = await inspectWs(ws, (v) => v.meta('store_id'));
  const backup = join(workspace('boot-bk'), 'bk.db');
  const b = cli(PACKC, ['store', 'backup', backup], ws);
  assert.equal(b.status, 0, b.stderr);

  removeDb(dbFile(ws));
  let r = boot(ws);
  assert.ok(!r.listening && r.message.includes(`were imported into store ${storeId}`) && /a new, empty store/.test(r.message), r.message);
  assert.ok(/Nothing was imported/.test(r.message) && !/import --replace|rekey-issuer/.test(r.message));
  await inspectWs(ws, (v) => { assert.equal(v.meta('import_done'), null); assert.equal(v.users().length, 0); });

  const other = join(workspace('boot-other'), 'other.db');
  r = boot(ws, { env: { OBSERVOGRAM_DB: other } });
  assert.ok(!r.listening && r.message.includes(`were imported into store ${storeId}`), r.message);

  const restore = cli(PACKC, ['store', 'restore', backup], ws);
  assert.equal(restore.status, 0, restore.stderr);
  r = boot(ws);
  assert.ok(r.listening, r.message);
  await inspectWs(ws, (v) => { assert.equal(v.meta('store_id'), storeId); assert.ok(v.user('alice')); });
});

test('stale import: a database moved with its id boots; a deleted marker is rewritten by the repair; a moved-aside marker lets a new store import', async () => {
  const ws = workspace();
  usersFile(ws, { alice: { createdAt: 't', password: REAL } });
  assert.ok(boot(ws).listening);
  const moved = join(ws, 'moved.db');
  renameSync(dbFile(ws), moved);
  let r = boot(ws, { env: { OBSERVOGRAM_DB: moved } });
  assert.ok(r.listening, r.message);

  rmSync(join(ws, '.store-imported'));
  r = boot(ws, { env: { OBSERVOGRAM_DB: moved } });
  assert.ok(r.listening, r.message);
  const marker = JSON.parse(readFileSync(join(ws, '.store-imported'), 'utf8'));
  assert.equal(marker.by, 'repair');

  // A new store, the marker moved aside: the next start imports and says so.
  renameSync(join(ws, '.store-imported'), join(ws, '.store-imported.aside'));
  r = boot(ws, { silent: false });
  assert.ok(r.listening && /\[store\] imported .*users\.json/.test(r.stdout), r.stdout);
});

test('stale import: an edited users.json refuses (d) and changes nothing; put back it passes; moved aside it passes and is recorded absent', async () => {
  const ws = workspace();
  usersFile(ws, { alice: { createdAt: 't', password: REAL } });
  assert.ok(boot(ws).listening);
  const path = join(ws, 'users.json');
  const bytes = readFileSync(path);
  const { recorded, before } = await inspectWs(ws, (v) => ({ recorded: JSON.parse(v.meta('legacy_hashes'))['users.json'].sha256, before: rowsOf(v) }));
  writeFileSync(path, JSON.stringify({ users: { alice: { createdAt: 't', password: REAL }, eve: { createdAt: 't', password: REAL } } }));
  let r = boot(ws);
  assert.ok(!r.listening && r.message.includes(`${path} changed since store`) && r.message.includes(`it was SHA-256 ${recorded}`), r.message);
  assert.ok(r.message.includes(`put ${path} back exactly as it was imported`) && r.message.includes(`move ${path} aside`), r.message);
  assert.ok(!/import --replace|rekey-issuer/.test(r.message), 'no command 2a lacks');
  await inspectWs(ws, (v) => assert.equal(rowsOf(v), before));

  writeFileSync(path, bytes);
  assert.ok(boot(ws).listening, 'the file put back byte for byte passes');

  writeFileSync(path, '{"users":{}}');
  renameSync(path, `${path}.aside`);
  r = boot(ws);
  assert.ok(r.listening, r.message);
  await inspectWs(ws, (v) => {
    assert.deepEqual(JSON.parse(v.meta('legacy_hashes'))['users.json'], { absent: true });
    assert.equal(rowsOf(v), before, 'no user, org or membership row changed');
  });
});

test('stale import: an orgs.json that appeared after a flat import refuses naming "move … aside"', async () => {
  const ws = workspace();
  usersFile(ws, { alice: { createdAt: 't', password: REAL } });
  assert.ok(boot(ws).listening);
  orgsFile(ws, { acme: { members: {} } });
  const r = boot(ws);
  const path = join(ws, 'orgs.json');
  assert.ok(!r.listening && r.message.includes(`${path} appeared since store`) && r.message.includes(`move ${path} aside`), r.message);
});

test('stale import: deleting users.json after the upgrade, or the recorded users_file, boots, records it absent and changes no row', async () => {
  const ws = workspace();
  usersFile(ws, { alice: { createdAt: 't', password: REAL } });
  assert.ok(boot(ws).listening);
  const before = await inspectWs(ws, rowsOf);
  rmSync(join(ws, 'users.json'));
  assert.ok(boot(ws).listening);
  await inspectWs(ws, (v) => {
    assert.deepEqual(JSON.parse(v.meta('legacy_hashes'))['users.json'], { absent: true });
    assert.equal(rowsOf(v), before);
  });

  const ws2 = workspace();
  const outside = join(workspace('boot-users'), 'users.json');
  writeUsersFile({ users: { bob: { createdAt: 't', password: REAL } } }, outside);
  const env = { OBSERVOGRAM_USERS_FILE: outside };
  assert.ok(boot(ws2, { env }).listening);
  const before2 = await inspectWs(ws2, (v) => { assert.equal(v.meta('users_file'), outside); return rowsOf(v); });
  rmSync(outside);
  const r = boot(ws2, { env });
  assert.ok(r.listening, r.message);
  await inspectWs(ws2, (v) => {
    assert.deepEqual(JSON.parse(v.meta('legacy_hashes'))[outside], { absent: true });
    assert.equal(rowsOf(v), before2);
  });
});

test('stale import: with the legacy files moved aside, a lost database still refuses (a) — no admin/admin seeded, the marker keeps naming the real store', async () => {
  const ws = workspace();
  usersFile(ws, { alice: { createdAt: 't', password: REAL } });
  assert.ok(boot(ws).listening);
  const storeId = await inspectWs(ws, (v) => v.meta('store_id'));
  renameSync(join(ws, 'users.json'), join(ws, 'users.json.aside'));
  assert.ok(boot(ws).listening, 'the files moved aside are recorded absent');

  removeDb(dbFile(ws));
  const r = boot(ws);
  assert.ok(!r.listening && r.nothingMoved === true, r.message);
  assert.ok(r.message.includes(`imported into store ${storeId}`) && /a new, empty store/.test(r.message), r.message);
  assert.ok(/Nothing was imported or seeded/.test(r.message) && !/import --replace|rekey-issuer/.test(r.message), r.message);
  assert.equal(JSON.parse(readFileSync(join(ws, '.store-imported'), 'utf8')).storeId, storeId, 'the marker still names the real store');
  await inspectWs(ws, (v) => { assert.equal(v.meta('import_done'), null); assert.equal(v.users().length, 0); });

  // The way out it names: the marker moved aside, the store at OBSERVOGRAM_DB starts as it stands.
  renameSync(join(ws, '.store-imported'), join(ws, '.store-imported.aside'));
  assert.ok(boot(ws).listening);
});

// ====================== removed orgs ======================

test('a removed org is absent to the org middleware, the bearer fallback and the switcher; its files stay', async () => {
  const ws = workspace();
  usersFile(ws, { alice: { createdAt: 't', password: hashPassword('alice-passw0rd') }, bob: { createdAt: 't', password: hashPassword('bob-passw0rd!') } });
  orgsFile(ws, { acme: { members: { alice: 'admin' } }, bravo: { members: { bob: 'admin' } } });
  const token = 'tok-0123456789';
  const s = await serve(ws, { env: { OBSERVOGRAM_API_TOKEN: token } });
  try {
    const alice = (await signIn(s.base, 'alice', 'alice-passw0rd')).session;
    const bob = (await signIn(s.base, 'bob', 'bob-passw0rd!')).session;
    let r = await fetch(`${s.base}/api/validate`, {
      method: 'POST', headers: { Cookie: bob, 'X-Observogram-CSRF': '1', 'Content-Type': 'text/yaml' },
      body: readFileSync(join(ROOT, 'examples', 'demo-skeleton.pack.yaml'), 'utf8'),
    });
    assert.equal(r.status, 200);
    const bravoFiles = readdirSync(join(ws, 'orgs', 'bravo'), { recursive: true }).sort();
    const c = cli(ORG_ADMIN, ['remove', 'bravo'], ws);
    assert.equal(c.status, 0, c.stderr);
    const bearer = { Authorization: `Bearer ${token}` };
    r = await fetch(`${s.base}/api/packs`, { headers: { ...bearer, 'X-Observogram-Org': 'bravo' } });
    assert.equal(r.status, 403, 'the bearer with bravo → 403');
    const orgs = await (await fetch(`${s.base}/api/orgs`, { headers: bearer })).json();
    assert.deepEqual(orgs.orgs.map((o) => o.id), ['acme'], "the bearer's /api/orgs omits bravo");
    const me = await (await fetch(`${s.base}/auth/me`, { headers: { Cookie: bob } })).json();
    assert.deepEqual(me.orgs, [], "bob's /auth/me omits bravo");
    r = await fetch(`${s.base}/api/packs`, { headers: { Cookie: bob } });
    assert.equal(r.status, 403, 'bob: no org membership');
    r = await fetch(`${s.base}/api/packs`, { headers: { Cookie: bob, 'X-Observogram-Org': 'bravo' } });
    assert.equal(r.status, 403, 'bob with bravo → 403');
    r = await fetch(`${s.base}/api/packs`, { headers: { Cookie: alice, 'X-Observogram-Org': 'bravo' } });
    assert.equal(r.status, 403, 'alice (owner) with bravo → 403');
    assert.deepEqual(readdirSync(join(ws, 'orgs', 'bravo'), { recursive: true }).sort(), bravoFiles, 'nothing under orgs/bravo/ was removed');
    const d = cli(ORG_ADMIN, ['remove', 'acme'], ws);
    assert.ok(d.status === 1 && /acme is the default org and cannot be removed/.test(d.stderr), d.stderr);
  } finally {
    await s.stop();
  }
});

// ====================== the every-boot warnings ======================

test('the three every-boot warnings still print on a boot that does not import', async () => {
  const ws = workspace();
  usersFile(ws, { alice: { createdAt: 't', password: REAL } });
  orgsFile(ws, { acme: { members: { alice: 'operator' } } });
  assert.ok(boot(ws, { silent: false }).listening);
  let r = boot(ws, { silent: false });
  assert.ok(r.listening && r.stderr.includes('[store] no owner — run `npm run users -- owner <login>`'), r.stderr);

  const ws2 = workspace();
  usersFile(ws2, { alice: { createdAt: 't', password: REAL } });
  orgsFile(ws2, { default: { members: { alice: 'admin' } } });
  flatPack(ws2);
  mkdirSync(join(ws2, 'orgs', 'default', 'packs'), { recursive: true });
  writeFileSync(join(ws2, 'orgs', 'default', 'packs', 'twin.pack.yaml'), 'name: twin\n');
  assert.ok(boot(ws2, { silent: false }).listening);
  r = boot(ws2, { silent: false });
  assert.ok(r.listening && r.stderr.includes(`[store] left behind: ${join(ws2, 'packs')}`), r.stderr);

  const ws3 = workspace();
  assert.ok(boot(ws3, { env: OIDC_ENV, silent: false }).listening);
  r = boot(ws3, { env: { ...OIDC_ENV, OBSERVOGRAM_OIDC_JOIN_ROLE: 'viewer' }, silent: false });
  assert.ok(r.listening && r.stderr.includes('[store] OBSERVOGRAM_OIDC_JOIN_ROLE is read at the first start only; the store records operator'), r.stderr);
});

// ====================== the CLI gate ======================

test('CLI: on a workspace with legacy files not yet imported, a CLI refuses and creates no database', async () => {
  const ws = workspace();
  usersFile(ws, { alice: { createdAt: 't', password: REAL } });
  for (const [script, args] of [[USER_ADMIN, ['list']], [USER_ADMIN, ['add', 'bob', '--password-stdin']], [ORG_ADMIN, ['create', 'acme']]]) {
    const c = cli(script, args, ws, { input: 'bob-passw0rd\n' });
    assert.ok(c.status === 1 && /not imported yet/.test(c.stderr), c.stderr);
    assert.ok(!existsSync(dbFile(ws)), 'no database file was created');
  }
});

test('CLI: `users -- add` initialises a fresh store from the shell; the later import keeps that row and reports the conflict', async () => {
  const ws = workspace();
  const c = cli(USER_ADMIN, ['add', 'alice', '--password-stdin'], ws, { input: 'cli-passw0rd\n' });
  assert.equal(c.status, 0, c.stderr);
  assert.ok(c.stdout.includes("store initialised from this shell's environment") && c.stdout.includes('stand-alone sign-in is armed'), c.stdout);
  await inspectWs(ws, (v) => {
    assert.equal(v.meta('import_done'), null);
    assert.ok(v.user('alice').is_owner === 1);
    assert.deepEqual(v.roles('alice'), ['default:admin']);
  });
  usersFile(ws, { alice: { createdAt: 't', password: REAL }, bob: { createdAt: 't', password: REAL } });
  assert.ok(boot(ws).listening);
  await inspectWs(ws, (v) => {
    assert.ok(verifyPassword('cli-passw0rd', JSON.parse(v.user('alice').password)), "the CLI's alice is kept");
    assert.ok(v.user('bob'), 'bob imported');
    assert.ok(JSON.parse(v.meta('import_report')).users.conflicts.some((x) => x.login === 'alice'), 'the conflict is reported');
  });
});

test('CLI: the refusal table', async () => {
  let c = cli(USER_ADMIN, ['list'], workspace(), { env: { OBSERVOGRAM_DB: ':memory:' } });
  assert.ok(c.status === 1 && /OBSERVOGRAM_DB is :memory:/.test(c.stderr), c.stderr);

  const ws = workspace();
  assert.equal(cli(USER_ADMIN, ['add', 'alice', '--password-stdin'], ws, { input: 'alice-passw0rd\n' }).status, 0);
  c = cli(USER_ADMIN, ['add', 'carol', '--role', 'member', '--password-stdin'], ws, { input: 'carol-passw0rd\n' });
  assert.ok(c.status === 1 && /'member' is now 'operator'/.test(c.stderr), c.stderr);
  c = cli(USER_ADMIN, ['remove', 'alice'], ws);
  assert.ok(c.status === 1 && /alice is the last enabled owner/.test(c.stderr), c.stderr);

  // A non-empty orgs/<id>/ is refused naming the path; --adopt takes it over.
  mkdirSync(join(ws, 'orgs', 'zeta'), { recursive: true });
  writeFileSync(join(ws, 'orgs', 'zeta', 'note.txt'), 'x');
  c = cli(ORG_ADMIN, ['create', 'zeta'], ws);
  assert.ok(c.status === 1 && c.stderr.includes(`${join(ws, 'orgs', 'zeta')} exists and is not empty`), c.stderr);
  c = cli(ORG_ADMIN, ['create', 'zeta', '--adopt'], ws);
  assert.equal(c.status, 0, c.stderr);
  await inspectWs(ws, (v) => assert.equal(v.audit('org.adopt').length, 1));

  c = cli(USER_ADMIN, ['add', 'dave', '--password-stdin'], ws, { input: 'dave-passw0rd\n' });
  assert.ok(c.status === 1 && /this deployment has 2 orgs: name one with --org/.test(c.stderr), c.stderr);
  assert.equal(cli(ORG_ADMIN, ['remove', 'zeta'], ws).status, 0);
  c = cli(ORG_ADMIN, ['create', 'zeta', '--adopt'], ws);
  assert.ok(c.status === 1 && /never reused/.test(c.stderr), c.stderr);
  c = cli(ORG_ADMIN, ['remove', 'default'], ws);
  assert.ok(c.status === 1 && /default is the default org and cannot be removed/.test(c.stderr), c.stderr);

  // Creating an org needs identity, then an owner.
  const ws2 = workspace();
  assert.ok(boot(ws2, { env: { OBSERVOGRAM_API_TOKEN: 'tok-0123456789' } }).listening);
  c = cli(ORG_ADMIN, ['create', 'acme'], ws2);
  assert.ok(c.status === 1 && /creating a second org needs identity/.test(c.stderr), c.stderr);
  const ws3 = workspace();
  usersFile(ws3, { alice: { createdAt: 't', password: REAL } });
  orgsFile(ws3, { acme: { members: { alice: 'operator' } } });
  assert.ok(boot(ws3).listening);
  c = cli(ORG_ADMIN, ['create', 'bravo'], ws3);
  assert.ok(c.status === 1 && /no owner — run npm run users -- owner <login> first/.test(c.stderr), c.stderr);
});

test('CLI: OIDC logins against the recorded issuer, from a shell with another issuer and from a shell with none', async () => {
  const ws = workspace();
  usersFile(ws, { 'user-42': { createdAt: 't', password: REAL } });   // imported disabled under OIDC
  assert.ok(boot(ws, { env: OIDC_ENV }).listening);
  await inspectWs(ws, (v) => assert.equal(v.meta('oidc_issuer'), KEY));
  const otherShell = { OBSERVOGRAM_OIDC_ISSUER: 'http://127.0.0.1:10' };
  let c = cli(USER_ADMIN, ['owner', 'user-42'], ws, { env: otherShell });
  assert.ok(c.status === 1 && c.stderr.includes(`the store records ${KEY}`), c.stderr);
  c = cli(ORG_ADMIN, ['add-member', 'default', 'user-42'], ws, { env: otherShell });
  assert.ok(c.status === 1 && c.stderr.includes(`the store records ${KEY}`), c.stderr);

  const before = await inspectWs(ws, rowsOf);
  c = cli(USER_ADMIN, ['owner', 'user-42'], ws);
  assert.ok(c.status === 1 && c.stderr.includes(`this store records OIDC issuer ${KEY}`) && c.stderr.includes(`${KEY}#user-42`), c.stderr);
  await inspectWs(ws, (v) => assert.equal(rowsOf(v), before, 'no row created, no owner granted (not even the disabled users.json row)'));
  c = cli(USER_ADMIN, ['owner', `${KEY}#user-42`], ws);
  assert.equal(c.status, 0, c.stderr);
  await inspectWs(ws, (v) => assert.ok(v.user(`${KEY}#user-42`)?.is_owner === 1 && v.user('user-42').is_owner === 0));

  assert.equal(cli(USER_ADMIN, ['add', 'carlos', '--password-stdin'], ws, { input: 'carlos-passw0rd\n' }).status, 0);
  assert.equal(cli(ORG_ADMIN, ['create', 'acme'], ws).status, 0);
  c = cli(ORG_ADMIN, ['add-member', 'acme', 'carlos'], ws);
  assert.equal(c.status, 0, c.stderr);
  await inspectWs(ws, (v) => assert.ok(v.roles('carlos').includes('acme:operator')));
});

// ====================== Arming (the CLI half) ======================

test('arming: removing every removable user never reopens a 0.0.0.0 server; the removed users\' cookies stop working', async () => {
  const ws = workspace();
  usersFile(ws, { alice: { createdAt: 't', password: hashPassword('alice-passw0rd') }, bob: { createdAt: 't', password: hashPassword('bob-passw0rd!') } });
  const s = await serve(ws, { host: '0.0.0.0' });
  try {
    assert.equal(cli(USER_ADMIN, ['add', 'carol', '--password-stdin'], ws, { input: 'carol-passw0rd\n' }).status, 0);
    const bob = (await signIn(s.base, 'bob', 'bob-passw0rd!')).session;
    const carol = (await signIn(s.base, 'carol', 'carol-passw0rd')).session;
    assert.equal((await fetch(`${s.base}/api/packs`, { headers: { Cookie: carol } })).status, 200);
    assert.equal(cli(USER_ADMIN, ['remove', 'carol'], ws).status, 0, 'a non-owner');
    assert.equal(cli(USER_ADMIN, ['remove', 'bob'], ws).status, 0);
    assert.equal(cli(USER_ADMIN, ['remove', 'alice'], ws).status, 1, 'the last enabled owner stays');
    assert.equal((await fetch(`${s.base}/api/packs`)).status, 401, 'anonymous /api → 401');
    assert.equal((await fetch(`${s.base}/api/packs`, { headers: { Cookie: bob } })).status, 401, "bob's cookie → 401");
    assert.equal((await fetch(`${s.base}/api/packs`, { headers: { Cookie: carol } })).status, 401, "carol's cookie → 401");
    // `enable` undoes `remove`; the cookie from before the disable stays refused.
    assert.equal(cli(USER_ADMIN, ['passwd', 'bob', '--password-stdin'], ws, { input: 'bob-new-passw0rd\n' }).stdout
      .includes('updated password for bob (disabled: npm run users -- enable bob lets them sign in)'), true);
    assert.equal((await signIn(s.base, 'bob', 'bob-new-passw0rd')).status, 401, 'still disabled after passwd');
    const en = cli(USER_ADMIN, ['enable', 'bob'], ws);
    assert.ok(en.status === 0 && en.stdout.includes('enabled bob'), en.stderr);
    const back = await signIn(s.base, 'bob', 'bob-new-passw0rd');
    assert.equal(back.status, 200, 'a re-enabled user signs in');
    assert.equal((await fetch(`${s.base}/api/packs`, { headers: { Cookie: back.session } })).status, 200);
    assert.equal((await fetch(`${s.base}/api/packs`, { headers: { Cookie: bob } })).status, 401, "bob's old cookie stays refused");
  } finally {
    await s.stop();
  }
  await inspectWs(ws, (v) => assert.equal(v.meta('identity_armed'), '1'));
});

// ====================== OIDC boot switches ======================

test('OIDC: a stand-alone store switched to OIDC records the key; OIDC unset keeps it; a changed issuer refuses; a re-spelling boots', async () => {
  const ws = workspace();
  usersFile(ws, { alice: { createdAt: 't', password: REAL } });
  assert.ok(boot(ws).listening);
  assert.ok(boot(ws, { env: OIDC_ENV }).listening);
  await inspectWs(ws, (v) => assert.equal(v.meta('oidc_issuer'), KEY));
  assert.ok(boot(ws).listening, 'OIDC unset: boots stand-alone');
  await inspectWs(ws, (v) => assert.equal(v.meta('oidc_issuer'), KEY, 'the record is kept'));

  const before = await inspectWs(ws, (v) => v.count('SELECT count(*) AS n FROM audit'));
  const other = 'http://127.0.0.1:10';
  const r = boot(ws, { env: { ...OIDC_ENV, OBSERVOGRAM_OIDC_ISSUER: other } });
  assert.ok(!r.listening && r.message.includes(`OBSERVOGRAM_OIDC_ISSUER is ${other} (key ${canonIssuer(other)})`) && r.message.includes(`under ${KEY}`), r.message);
  assert.ok(/set OBSERVOGRAM_OIDC_ISSUER back/.test(r.message) && !/rekey-issuer/.test(r.message), r.message);
  await inspectWs(ws, (v) => {
    assert.equal(v.meta('oidc_issuer'), KEY);
    assert.equal(v.count('SELECT count(*) AS n FROM audit'), before, 'nothing written');
  });
  for (const spelling of [`${ISSUER}/.well-known/openid-configuration`, `${ISSUER}/`]) {
    const b = boot(ws, { env: { ...OIDC_ENV, OBSERVOGRAM_OIDC_ISSUER: spelling } });
    assert.ok(b.listening, `${spelling}: ${b.message}`);
  }
});

test('OIDC: a malformed OBSERVOGRAM_BOOTSTRAP_ADMIN or OBSERVOGRAM_OIDC_JOIN_ROLE refuses before anything is written', async () => {
  for (const extra of [{ OBSERVOGRAM_BOOTSTRAP_ADMIN: 'not an email' }, { OBSERVOGRAM_OIDC_JOIN_ROLE: 'boss' }]) {
    const ws = workspace();
    const r = boot(ws, { env: { ...OIDC_ENV, ...extra } });
    assert.ok(!r.listening && /Nothing was written/.test(r.message) && r.message.includes(Object.keys(extra)[0]), r.message);
    assert.ok(!existsSync(dbFile(ws)), 'no database file');
  }
});

// ====================== the journey engine ======================

test('journeys: packc journey run/list open no store; a default-org CronJob still finds its journey after `orgs -- create`', async () => {
  const ws = workspace();
  mkdirSync(join(ws, 'journeys'), { recursive: true });
  const pay = join(ROOT, SPEC_DIR, 'examples', 'payment-service.pack.yaml');
  const cur = join(ROOT, 'examples', 'production-curated.pack.yaml');
  writeFileSync(join(ws, 'journeys', 'nightly.journey.yaml'), [
    'name: nightly', `packA: { file: ${pay} }`, `packB: { file: ${cur} }`, 'gate: { minAlignmentPct: 1 }',
  ].join('\n'));
  let c = cli(PACKC, ['journey', 'run', 'nightly'], ws);
  assert.ok(c.status === 0 || c.status === 1, c.stderr);
  c = cli(PACKC, ['journey', 'list'], ws);
  assert.ok(c.status === 0 && c.stdout.includes('nightly'), c.stdout + c.stderr);
  assert.ok(!existsSync(dbFile(ws)), 'no observogram.db');

  usersFile(ws, { alice: { createdAt: 't', password: REAL } });
  assert.ok(boot(ws).listening);
  assert.equal(cli(ORG_ADMIN, ['create', 'acme'], ws).status, 0);
  c = cli(PACKC, ['journey', 'list'], ws);
  assert.ok(c.status === 0 && c.stdout.includes('nightly'), c.stdout + c.stderr);
});

// ====================== :memory: ======================

test(':memory: prints its warning, writes no marker, and a restart imports again', async () => {
  const ws = workspace();
  usersFile(ws, { alice: { createdAt: 't', password: REAL } });
  const env = { OBSERVOGRAM_DB: ':memory:' };
  let r = boot(ws, { env, silent: false });
  assert.ok(r.listening && r.stderr.includes('[store] OBSERVOGRAM_DB=:memory: — nothing persists'), r.stderr);
  assert.ok(!existsSync(join(ws, '.store-imported')), 'no marker');
  r = boot(ws, { env, silent: false });
  assert.ok(r.listening && /\[store\] imported /.test(r.stdout), r.stdout);
});

// ====================== pre-upgrade cookies ======================

test('pre-upgrade cookies stay valid across the upgrade', async () => {
  const ws = workspace();
  usersFile(ws, { alice: { name: 'Alice', createdAt: 't', password: REAL } });
  const secret = 'pre-store-session-secret-0123456789-abcdefgh';
  writeFileSync(join(ws, 'session-secret'), secret, { mode: 0o600 });
  const body = Buffer.from(JSON.stringify({ sub: 'alice', email: null, name: 'Alice', iat: Date.now(), exp: Date.now() + 3600_000 })).toString('base64url');
  const cookie = `observogram_session=v1.${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
  const s = await serve(ws);
  try {
    assert.equal((await fetch(`${s.base}/api/packs`, { headers: { Cookie: cookie } })).status, 200);
    const me = await (await fetch(`${s.base}/auth/me`, { headers: { Cookie: cookie } })).json();
    assert.ok(me.authenticated === true && me.sub === 'alice', JSON.stringify(me));
  } finally {
    await s.stop();
  }
  assert.ok(statSync(join(ws, 'session-secret')).isFile());
});
