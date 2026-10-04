#!/usr/bin/env node
/**
 * server/test-auth-proxy.mjs — identity from a reverse proxy
 * (server/auth-proxy.mjs; README "Behind a reverse proxy").
 *
 * Inert by default: a server without OBSERVOGRAM_TRUST_PROXY_AUTH ignores
 * X-Forwarded-User in every posture (open loopback answers as `local` and
 * writes no row; local users answer 401 and write nothing). Refusals: no
 * ACK or a wrong one (text a), OIDC beside it (b), a bad realm / header
 * name / forbidden header / group map / join role / logout URL / short
 * secret (the variable named, the secret never echoed), a non-loopback bind
 * without the shared secret (c, nothingMoved), AUTH=off with the flag (one
 * warn line, headers ignored), loopback without the secret (the warn
 * line). Enabled: the exact rows a first request writes, the second writes
 * nothing, /auth/me, the 401s and the /auth/login explainer, CSRF still
 * enforced, groups authoritative in the configured org (raise, lower,
 * remove, absent → untouched), the owner grant once and never revoked, a
 * disabled row refused with no re-enable, a local row holding the login,
 * the malformed headers (duplicate raw lines, over 2000 chars, a control
 * character), a carried-over cookie ignored, the bearer winning, the shared
 * secret on an exposed bind (absent / wrong / right; never in any output),
 * and the CLI spelling proxy://<realm>#<user>. Every server is a child with
 * an explicit env (server/fixtures/serve-child.mjs); the parsers are also
 * exercised in-process against plain env objects.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, serve, cli, childEnv, STRIP } from './fixtures/serve-child.mjs';

// Hermetic (§0): a developer shell's store or identity variables never reach
// this process's imports — the children's STRIP list, both spellings, before
// any server module loads; hence the dynamic imports (a static one is
// hoisted above this line). server/test-hermetic-suites.mjs guards the shape.
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

const { ACK_REFUSAL, EXPOSED_REFUSAL, OIDC_REFUSAL, PROXY_ACK, PROXY_AUTH_ENV, duplicatedHeader, parseProxyAuthEnv, rolesOf } = await import('./auth-proxy.mjs');
const { hashPassword } = await import('./auth.mjs');
const { openRaw, prepare } = await import('./store/db.mjs');
const { isProxyIssuerKey, proxyIssuerKey } = await import('./store/identity.mjs');
const { resolveLogin, serverSignInMode } = await import('./identity-admin.mjs');
const { writeUsersFile } = await import('./store/legacy-files.mjs');

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const USERS_CLI = join(ROOT, 'tools', 'user-admin.mjs');
const PACK_YAML = readFileSync(join(ROOT, 'examples', 'demo-skeleton.pack.yaml'), 'utf8');

const TMP = mkdtempSync(join(tmpdir(), 'observogram-auth-proxy-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
// The open postures register no /auth/me: the static fallback answers it.
let n = 0;
const workspace = () => join(TMP, `ws-${++n}`);

const ACK = { OBSERVOGRAM_TRUST_PROXY_AUTH: '1', OBSERVOGRAM_TRUST_PROXY_AUTH_ACK: PROXY_ACK };
const GROUPS = {
  ...ACK, OBSERVOGRAM_PROXY_AUTH_GROUPS_HEADER: 'X-Forwarded-Groups',
  OBSERVOGRAM_PROXY_AUTH_GROUP_ROLES: 'sre=admin,dev=operator,*=viewer', OBSERVOGRAM_PROXY_AUTH_OWNERS: 'root',
};
const SECRET = 'proxy-shared-secret-0123456789-abcdefghij';
const CSRF = { 'X-Observogram-CSRF': '1' };
const alice = { 'X-Forwarded-User': 'alice', 'X-Forwarded-Email': 'alice@example.test' };

// ---------- helpers ----------

async function call(base, method, path, { headers = {}, body } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (body !== undefined) h['Content-Type'] ??= 'application/json';
  const r = await fetch(`${base}${path}`, { method, headers: h, body, redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text, type: r.headers.get('content-type') || '', location: r.headers.get('location') };
}
const get = (base, path, headers) => call(base, 'GET', path, { headers });

// A request whose header lines are given raw (an array), so a name may
// repeat — fetch() would join the values into one. (An array sends exactly
// these lines: Host is ours to add.)
function rawCall(base, method, path, headerLines) {
  return new Promise((resolveP, reject) => {
    const req = httpRequest(`${base}${path}`, { method, headers: ['Host', new URL(base).host, 'Accept', 'application/json', ...headerLines] }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolveP({ status: res.statusCode, json, text }); });
    });
    req.on('error', reject);
    req.end();
  });
}

// The parent's read-only view of a child's database.
async function inspect(ws, fn) {
  const db = await openRaw(join(ws, 'observogram.db'), { readOnly: true });
  try {
    return fn({
      users: () => prepare(db, 'SELECT login, kind, issuer, sub, email, email_verified, name, is_owner, disabled, session_epoch FROM users ORDER BY id').all().map((r) => ({ ...r })),
      roles: (login) => prepare(db, `SELECT m.org_id, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.login = ? ORDER BY m.created_at, m.rowid`).all(login).map((m) => `${m.org_id}:${m.role}`),
      audit: () => prepare(db, 'SELECT seq, actor, org_id, action, target_id, detail FROM audit ORDER BY seq').all()
        .map((r) => [r.action, r.actor, r.org_id, r.target_id, r.detail === null ? null : JSON.parse(r.detail)]),
      seq: () => prepare(db, 'SELECT coalesce(max(seq), 0) AS s FROM audit').get().s,
      meta: (key) => prepare(db, 'SELECT value FROM schema_meta WHERE key = ?').get(key)?.value ?? null,
    });
  } finally {
    db.close();
  }
}
const auditAfter = async (ws, seq) => inspect(ws, (v) => v.audit().filter((row, i) => i + 1 > seq));
const rowsOf = (rows) => rows.map((r) => [r[0], r[1], r[2], r[3]]);

// ---------- the pure parsers ----------

test('parseProxyAuthEnv: off without the flag; the defaults; every knob; the legacy spelling; the modern name wins', () => {
  assert.equal(parseProxyAuthEnv({}), null);
  assert.equal(parseProxyAuthEnv({ OBSERVOGRAM_TRUST_PROXY_AUTH: 'yes', OBSERVOGRAM_TRUST_PROXY_AUTH_ACK: PROXY_ACK }), null, "only '1' enables");
  const d = parseProxyAuthEnv(ACK);
  assert.deepEqual(d, {
    realm: 'proxy', issuerKey: 'proxy://proxy', userHeader: 'X-Forwarded-User', emailHeader: 'X-Forwarded-Email', nameHeader: null, groupsHeader: null,
    secretHeader: 'X-Proxy-Auth-Secret', groupRoles: {}, org: null, joinRole: null, owners: [], secret: null, logoutUrl: null,
  });
  const full = parseProxyAuthEnv({
    ...GROUPS, OBSERVOGRAM_PROXY_AUTH_REALM: 'corp.sso-1', OBSERVOGRAM_PROXY_AUTH_USER_HEADER: 'X-Auth-User', OBSERVOGRAM_PROXY_AUTH_EMAIL_HEADER: 'X-Auth-Email',
    OBSERVOGRAM_PROXY_AUTH_NAME_HEADER: 'X-Auth-Name', OBSERVOGRAM_PROXY_AUTH_ORG: 'acme', OBSERVOGRAM_PROXY_AUTH_JOIN_ROLE: 'viewer',
    OBSERVOGRAM_PROXY_AUTH_OWNERS: ' root, ops ,', OBSERVOGRAM_PROXY_AUTH_SHARED_SECRET: SECRET, OBSERVOGRAM_PROXY_AUTH_SECRET_HEADER: 'X-Gate',
    OBSERVOGRAM_PROXY_AUTH_LOGOUT_URL: 'https://sso.example.test/logout?rd=/',
  });
  assert.deepEqual(full, {
    realm: 'corp.sso-1', issuerKey: 'proxy://corp.sso-1', userHeader: 'X-Auth-User', emailHeader: 'X-Auth-Email', nameHeader: 'X-Auth-Name',
    groupsHeader: 'X-Forwarded-Groups', secretHeader: 'X-Gate', groupRoles: { sre: 'admin', dev: 'operator', '*': 'viewer' }, org: 'acme',
    joinRole: 'viewer', owners: ['root', 'ops'], secret: SECRET, logoutUrl: 'https://sso.example.test/logout?rd=/',
  });
  assert.equal(parseProxyAuthEnv({ TOMOGRAPH_TRUST_PROXY_AUTH: '1', TOMOGRAPH_TRUST_PROXY_AUTH_ACK: PROXY_ACK, TOMOGRAPH_PROXY_AUTH_REALM: 'old' }).realm, 'old');
  assert.equal(parseProxyAuthEnv({ ...ACK, OBSERVOGRAM_PROXY_AUTH_REALM: 'new', TOMOGRAPH_PROXY_AUTH_REALM: 'old' }).realm, 'new');
  assert.equal(parseProxyAuthEnv({ ...ACK, OBSERVOGRAM_PROXY_AUTH_JOIN_ROLE: 'none' }).joinRole, null);
  assert.deepEqual(PROXY_AUTH_ENV.filter((k) => !STRIP.includes(k)), [], 'every variable the mode reads is on the children\'s STRIP list');
});

test('parseProxyAuthEnv refuses: no ACK (a), a wrong ACK, OIDC beside it (b), a bad realm, header names, the forbidden ones, twins, the group map, the join role, the org, the secret, the logout URL — naming the variable, never the secret', () => {
  const refuses = (env, message) => assert.throws(() => parseProxyAuthEnv({ OBSERVOGRAM_TRUST_PROXY_AUTH: '1', ...env }), (e) => {
    assert.ok(e instanceof TypeError, 'a TypeError');
    if (message instanceof RegExp) assert.match(e.message, message); else assert.equal(e.message, message);
    assert.ok(!e.message.includes(SECRET), 'the secret is never echoed');
    return true;
  });
  const a = ACK_REFUSAL({ userHeader: 'X-Forwarded-User', emailHeader: 'X-Forwarded-Email', groupsHeader: null });
  assert.equal(a, 'OBSERVOGRAM_TRUST_PROXY_AUTH=1 trusts identity headers from a reverse proxy, which is safe only when clients cannot reach this port — '
    + 'set OBSERVOGRAM_TRUST_PROXY_AUTH_ACK=only-the-proxy-reaches-this-port once the proxy strips X-Forwarded-User, X-Forwarded-Email from every client request, '
    + 'or unset OBSERVOGRAM_TRUST_PROXY_AUTH');
  refuses({}, a);
  refuses({ OBSERVOGRAM_TRUST_PROXY_AUTH_ACK: '1' }, a);
  refuses({ OBSERVOGRAM_TRUST_PROXY_AUTH_ACK: 'yes' }, a);
  refuses({ OBSERVOGRAM_PROXY_AUTH_GROUPS_HEADER: 'X-Groups' }, a.replace('X-Forwarded-Email from', 'X-Forwarded-Email, X-Groups from'), 'the ACK names the groups header too');
  refuses({ OBSERVOGRAM_TRUST_PROXY_AUTH_ACK: PROXY_ACK, OBSERVOGRAM_OIDC_ISSUER: 'https://idp.example' }, OIDC_REFUSAL);
  assert.equal(OIDC_REFUSAL, 'OBSERVOGRAM_TRUST_PROXY_AUTH=1 and OBSERVOGRAM_OIDC_ISSUER are both set: one sign-in mode per server — unset one');
  const ok = { OBSERVOGRAM_TRUST_PROXY_AUTH_ACK: PROXY_ACK };
  refuses({ ...ok, OBSERVOGRAM_PROXY_AUTH_REALM: 'Corp' }, 'OBSERVOGRAM_PROXY_AUTH_REALM is 1–64 characters of [a-z0-9._-]');
  refuses({ ...ok, OBSERVOGRAM_PROXY_AUTH_REALM: 'a'.repeat(65) }, 'OBSERVOGRAM_PROXY_AUTH_REALM is 1–64 characters of [a-z0-9._-]');
  refuses({ ...ok, OBSERVOGRAM_PROXY_AUTH_USER_HEADER: 'X Forwarded User' }, 'OBSERVOGRAM_PROXY_AUTH_USER_HEADER is not a header name (RFC 7230 token characters only)');
  refuses({ ...ok, OBSERVOGRAM_PROXY_AUTH_EMAIL_HEADER: 'X-Mail:' }, 'OBSERVOGRAM_PROXY_AUTH_EMAIL_HEADER is not a header name (RFC 7230 token characters only)');
  for (const [k, v] of [['USER', 'Authorization'], ['USER', 'cookie'], ['EMAIL', 'Host'], ['NAME', 'Content-Length'], ['GROUPS', 'Transfer-Encoding'], ['USER', 'X-Observogram-CSRF'], ['SECRET', 'x-tomograph-csrf']]) {
    refuses({ ...ok, [`OBSERVOGRAM_PROXY_AUTH_${k}_HEADER`]: v }, `OBSERVOGRAM_PROXY_AUTH_${k}_HEADER must not name ${v}: it is never an identity header`);
  }
  refuses({ ...ok, OBSERVOGRAM_PROXY_AUTH_EMAIL_HEADER: 'x-forwarded-user' }, 'OBSERVOGRAM_PROXY_AUTH_EMAIL_HEADER names the same header as OBSERVOGRAM_PROXY_AUTH_USER_HEADER (x-forwarded-user)');
  refuses({ ...ok, OBSERVOGRAM_PROXY_AUTH_GROUPS_HEADER: 'X-G', OBSERVOGRAM_PROXY_AUTH_GROUP_ROLES: 'sre' }, 'OBSERVOGRAM_PROXY_AUTH_GROUP_ROLES is a comma list of <group>=<role> (viewer, operator, admin or owner), not "sre"');
  refuses({ ...ok, OBSERVOGRAM_PROXY_AUTH_GROUPS_HEADER: 'X-G', OBSERVOGRAM_PROXY_AUTH_GROUP_ROLES: 'sre=root' }, 'OBSERVOGRAM_PROXY_AUTH_GROUP_ROLES is a comma list of <group>=<role> (viewer, operator, admin or owner), not "sre=root"');
  refuses({ ...ok, OBSERVOGRAM_PROXY_AUTH_GROUPS_HEADER: 'X-G', OBSERVOGRAM_PROXY_AUTH_GROUP_ROLES: 'sre=admin,sre=viewer' }, 'OBSERVOGRAM_PROXY_AUTH_GROUP_ROLES names the group "sre" twice');
  refuses({ ...ok, OBSERVOGRAM_PROXY_AUTH_GROUP_ROLES: 'sre=admin' }, 'OBSERVOGRAM_PROXY_AUTH_GROUP_ROLES needs OBSERVOGRAM_PROXY_AUTH_GROUPS_HEADER: without a groups header no group reaches the server');
  refuses({ ...ok, OBSERVOGRAM_PROXY_AUTH_JOIN_ROLE: 'owner' }, 'OBSERVOGRAM_PROXY_AUTH_JOIN_ROLE is one of viewer, operator, admin or none, not "owner"');
  refuses({ ...ok, OBSERVOGRAM_PROXY_AUTH_ORG: 'Not An Org' }, 'OBSERVOGRAM_PROXY_AUTH_ORG is not an org id');
  refuses({ ...ok, OBSERVOGRAM_PROXY_AUTH_SHARED_SECRET: 'short' }, 'OBSERVOGRAM_PROXY_AUTH_SHARED_SECRET is at least 32 characters');
  refuses({ ...ok, OBSERVOGRAM_PROXY_AUTH_LOGOUT_URL: 'sso.example.test/logout' }, 'OBSERVOGRAM_PROXY_AUTH_LOGOUT_URL is not a URL');
  refuses({ ...ok, OBSERVOGRAM_PROXY_AUTH_LOGOUT_URL: 'javascript:alert(1)' }, 'OBSERVOGRAM_PROXY_AUTH_LOGOUT_URL is an http(s) URL, not javascript:');
});

test('rolesOf: the top rank wins, * covers every user the header names, owner is the flag plus admin, no match is no membership; duplicatedHeader counts raw lines', () => {
  const map = { sre: 'admin', dev: 'operator', '*': 'viewer', boss: 'owner' };
  assert.deepEqual(rolesOf(['dev'], map), { membershipRole: 'operator', owner: false });
  assert.deepEqual(rolesOf(['dev', 'sre'], map), { membershipRole: 'admin', owner: false });
  assert.deepEqual(rolesOf([], map), { membershipRole: 'viewer', owner: false });
  assert.deepEqual(rolesOf(['nobody-knows'], map), { membershipRole: 'viewer', owner: false });
  assert.deepEqual(rolesOf(['boss'], map), { membershipRole: 'admin', owner: true });
  assert.deepEqual(rolesOf(['dev'], { sre: 'admin' }), { membershipRole: null, owner: false });
  assert.deepEqual(rolesOf([], {}), { membershipRole: null, owner: false });
  const req = { rawHeaders: ['Host', 'x', 'X-Forwarded-User', 'alice', 'Accept', '*/*', 'x-forwarded-user', 'root'] };
  assert.equal(duplicatedHeader(req, ['X-Forwarded-User', 'X-Forwarded-Email']), 'x-forwarded-user');
  assert.equal(duplicatedHeader({ rawHeaders: ['X-Forwarded-User', 'alice', 'Accept', 'a', 'Accept', 'b'] }, ['X-Forwarded-User']), null, 'another header may repeat');
  assert.equal(duplicatedHeader({}, ['X-Forwarded-User']), null);
  assert.equal(proxyIssuerKey('proxy'), 'proxy://proxy');
  assert.deepEqual(['proxy://proxy', 'proxy://a.b-c_1', 'https://idp.example/', 'proxy://Bad', 'proxy://'].map(isProxyIssuerKey), [true, true, false, false, false]);
});

// ---------- inert by default ----------

test('inert: without the flag an open-loopback server answers X-Forwarded-User as `local` and writes no row; /auth/me is not a route', async () => {
  const ws = workspace();
  const s = await serve(ws, { env: { OBSERVOGRAM_AUTH: 'off' } });
  let seq;
  try {
    seq = await inspect(ws, (v) => v.seq());
    const r = await get(s.base, '/api/packs', { ...alice, 'X-Forwarded-Groups': 'sre' });
    assert.equal(r.status, 200);
    const me = await get(s.base, '/auth/me', alice);
    assert.ok(me.json === null || me.json.mode !== 'proxy', 'no /auth/me route in the open posture (the static fallback answers), never a proxy answer');
    // RESET writes its row with the open posture's actor: the header named nobody.
    const reset = await call(s.base, 'DELETE', '/api/uploads', { headers: alice });
    assert.equal(reset.status, 200);
  } finally { await s.stop(); }
  await inspect(ws, (v) => {
    assert.deepEqual(v.users(), [], 'no row');
    assert.deepEqual(rowsOf(v.audit().slice(seq)), [['pack.clear', 'local', 'default', null]], 'the one row names the open posture\'s actor');
  });
});

test('inert: a local-users server answers the same headers 401 denied auth, writes no row and no audit; a session cookie still signs in', async () => {
  const ws = workspace();
  writeUsersFile({ users: { bob: { name: 'Bob', createdAt: 't', password: hashPassword('bob-passw0rd') } } }, join(ws, 'users.json'));
  const s = await serve(ws);
  let seq;
  try {
    seq = await inspect(ws, (v) => v.seq());
    const r = await get(s.base, '/api/packs', { ...alice, 'X-Forwarded-Groups': 'sre' });
    assert.deepEqual([r.status, r.json], [401, { ok: false, error: 'unauthorized: sign in required', login: '/auth/login', denied: 'auth' }]);
    const me = await get(s.base, '/auth/me', alice);
    assert.deepEqual([me.status, me.json], [200, { ok: true, mode: 'local-users', authenticated: false, login: '/auth/login' }]);
    const login = await fetch(`${s.base}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: 'username=bob&password=bob-passw0rd',
    });
    const cookie = (login.headers.getSetCookie?.() || []).find((c) => c.startsWith('observogram_session='))?.split(';')[0];
    assert.ok(cookie, 'bob signs in');
    assert.equal((await get(s.base, '/api/packs', { Cookie: cookie, ...alice })).status, 200, 'the cookie signs in; the header is noise');
  } finally { await s.stop(); }
  await inspect(ws, (v) => {
    assert.deepEqual(v.users().map((u) => u.login), ['bob'], 'no proxy row');
    assert.deepEqual(v.audit().slice(seq).filter((r) => !['user.login'].includes(r[0])), [], 'nothing but bob\'s own sign-in');
  });
});

// ---------- refusals ----------

test('refusals: no ACK or a wrong one (a), OIDC beside it (b), a bad knob names its variable; the secret never reaches stdout or stderr', () => {
  const a = ACK_REFUSAL({ userHeader: 'X-Forwarded-User', emailHeader: 'X-Forwarded-Email', groupsHeader: null });
  let r = boot(workspace(), { env: { OBSERVOGRAM_TRUST_PROXY_AUTH: '1' } });
  assert.deepEqual([r.listening, r.message], [false, a]);
  r = boot(workspace(), { env: { OBSERVOGRAM_TRUST_PROXY_AUTH: '1', OBSERVOGRAM_TRUST_PROXY_AUTH_ACK: '1' } });
  assert.deepEqual([r.listening, r.message], [false, a]);
  r = boot(workspace(), { env: { ...ACK, OBSERVOGRAM_OIDC_ISSUER: 'http://127.0.0.1:9', OBSERVOGRAM_OIDC_CLIENT_ID: 'studio', OBSERVOGRAM_OIDC_ALLOW_HTTP: '1' } });
  assert.deepEqual([r.listening, r.message], [false, OIDC_REFUSAL], 'OIDC does not silently win');
  r = boot(workspace(), { env: { ...ACK, OBSERVOGRAM_PROXY_AUTH_REALM: 'Corp' } });
  assert.deepEqual([r.listening, r.message], [false, 'OBSERVOGRAM_PROXY_AUTH_REALM is 1–64 characters of [a-z0-9._-]']);
  r = boot(workspace(), { env: { ...ACK, OBSERVOGRAM_PROXY_AUTH_SHARED_SECRET: 'tooshort' }, silent: false });
  assert.deepEqual([r.listening, r.message], [false, 'OBSERVOGRAM_PROXY_AUTH_SHARED_SECRET is at least 32 characters']);
  assert.ok(!`${r.stdout}${r.stderr}`.includes('tooshort'), 'the secret is never printed');
  r = boot(workspace(), { env: { ...ACK, OBSERVOGRAM_PROXY_AUTH_ORG: 'ghost' } });
  assert.equal(r.listening, false);
  assert.equal(r.message, "refusing to start: OBSERVOGRAM_PROXY_AUTH_ORG names org 'ghost', which this store does not hold (or it is removed). "
    + 'Create it first with npm run orgs -- create <id>, or unset the variable to rule the default org. Nothing was written.');
  assert.equal(r.nothingMoved, true);
});

test('refusals: a bind beyond loopback without the shared secret (c), nothingMoved; with the secret it boots', () => {
  const r = boot(workspace(), { host: '0.0.0.0', env: ACK });
  assert.deepEqual([r.listening, r.message, r.nothingMoved], [false, EXPOSED_REFUSAL({ host: '0.0.0.0', userHeader: 'X-Forwarded-User', secretHeader: 'X-Proxy-Auth-Secret' }), true]);
  assert.equal(r.message, 'refusing to bind to 0.0.0.0 with OBSERVOGRAM_TRUST_PROXY_AUTH=1 and no OBSERVOGRAM_PROXY_AUTH_SHARED_SECRET: beyond loopback any client '
    + 'could set X-Forwarded-User. Set the shared secret (the proxy sends it in X-Proxy-Auth-Secret), or bind to loopback (HOST=127.0.0.1) next to the proxy');
  const ok = boot(workspace(), { host: '0.0.0.0', env: { ...ACK, OBSERVOGRAM_PROXY_AUTH_SHARED_SECRET: SECRET }, silent: false });
  assert.equal(ok.listening, true, ok.message);
  assert.ok(!`${ok.stdout}${ok.stderr}`.includes(SECRET), 'the secret is never printed');
  assert.ok(ok.stdout.includes('[studio] identity from the reverse proxy: realm proxy (key proxy://proxy); headers X-Forwarded-User, X-Forwarded-Email; shared secret required in X-Proxy-Auth-Secret; join role none'));
  assert.ok(!ok.stderr.includes('on loopback without'), 'no loopback warning on an exposed bind');
});

test('AUTH=off wins over the flag: one warn line, the headers are not read, the server is open; loopback without the secret warns once; a silent boot prints neither', async () => {
  const ws = workspace();
  const off = boot(ws, { env: { ...GROUPS, OBSERVOGRAM_AUTH: 'off' }, silent: false });
  assert.equal(off.listening, true);
  assert.deepEqual(off.stderr.split('\n').filter((l) => l.includes('TRUST_PROXY_AUTH')), ['[store] OBSERVOGRAM_TRUST_PROXY_AUTH=1 is ignored with OBSERVOGRAM_AUTH=off — headers are not read']);
  assert.ok(!off.stdout.includes('identity from the reverse proxy'));
  const s = await serve(ws, { env: { ...GROUPS, OBSERVOGRAM_AUTH: 'off' } });
  try {
    assert.equal((await get(s.base, '/api/packs', { 'X-Forwarded-User': 'root', 'X-Forwarded-Groups': 'sre' })).status, 200);
    const me = await get(s.base, '/auth/me', { 'X-Forwarded-User': 'root' });
    assert.ok(me.json === null || me.json.mode !== 'proxy', 'no /auth/me route with AUTH=off, never a proxy answer');
  } finally { await s.stop(); }
  await inspect(ws, (v) => { assert.deepEqual(v.users(), []); assert.equal(v.meta('identity_mode'), 'off'); });

  const loop = boot(workspace(), { env: ACK, silent: false });
  assert.equal(loop.listening, true);
  assert.deepEqual(loop.stderr.split('\n').filter((l) => l.includes('TRUST_PROXY_AUTH')),
    ['[store] OBSERVOGRAM_TRUST_PROXY_AUTH=1 on loopback without OBSERVOGRAM_PROXY_AUTH_SHARED_SECRET: every process that reaches this port on 127.0.0.1 is trusted as the proxy']);
  assert.ok(loop.stderr.includes('[store] no owner who can sign in through the reverse proxy — set OBSERVOGRAM_PROXY_AUTH_OWNERS=<user> (or map a group to owner in '
    + 'OBSERVOGRAM_PROXY_AUTH_GROUP_ROLES) and send a request, or run `npm run users -- owner proxy://proxy#<user>`'), loop.stderr);
  const quiet = boot(workspace(), { env: ACK });
  assert.equal(quiet.listening, true);
  assert.ok(!quiet.stdout.includes('proxy') && !quiet.stderr.includes('proxy'), 'a silent boot says nothing');
});

// ---------- enabled ----------

test('enabled: no header → 401; /auth/login is the 401 explainer (html and JSON); alice\'s first request writes its exact rows, the second writes nothing; /auth/me; CSRF still enforced; the actor', async () => {
  const ws = workspace();
  const s = await serve(ws, { env: { ...GROUPS, OBSERVOGRAM_PROXY_AUTH_LOGOUT_URL: 'https://sso.example.test/logout' } });
  try {
    let r = await get(s.base, '/api/packs');
    assert.deepEqual([r.status, r.json], [401, { ok: false, error: 'unauthorized: sign in required', login: '/auth/login', denied: 'auth' }]);
    r = await call(s.base, 'GET', '/auth/login', { headers: { Accept: 'text/html' } });
    assert.equal(r.status, 401);
    assert.match(r.type, /text\/html/);
    assert.ok(r.text.includes('no sign-in page: this server takes identity from its reverse proxy, and this request carried no X-Forwarded-User'), r.text);
    r = await get(s.base, '/auth/login');
    assert.deepEqual([r.status, r.json], [401, { ok: false, error: 'no sign-in page: this server takes identity from its reverse proxy, and this request carried no X-Forwarded-User', denied: 'auth' }]);
    r = await get(s.base, '/auth/login', { ...alice, 'X-Forwarded-Groups': 'dev' });
    assert.deepEqual([r.status, r.location], [302, '/'], 'a request whose headers resolve is sent to the studio');
    r = await get(s.base, '/auth/me');
    assert.deepEqual([r.status, r.json], [200, { ok: true, mode: 'proxy', authenticated: false, login: '/auth/login' }]);

    const dev = { ...alice, 'X-Forwarded-Groups': 'dev' };
    r = await get(s.base, '/api/packs', dev);
    assert.equal(r.status, 200);
    await inspect(ws, (v) => {
      assert.deepEqual(v.users(), [{
        login: 'proxy://proxy#alice', kind: 'oidc', issuer: 'proxy://proxy', sub: 'alice', email: 'alice@example.test', email_verified: 1, name: null,
        is_owner: 0, disabled: 0, session_epoch: 1,
      }]);
      assert.deepEqual(v.roles('proxy://proxy#alice'), ['default:operator']);
      assert.deepEqual(v.audit().filter((row) => row[3] === 'proxy://proxy#alice'), [
        ['user.jit', 'system', null, 'proxy://proxy#alice', { via: 'proxy', sessionEpoch: 1 }],
        ['membership.jit', 'system', 'default', 'proxy://proxy#alice', { role: 'operator', via: 'proxy-groups' }],
      ]);
    });
    const seq = await inspect(ws, (v) => v.seq());
    r = await get(s.base, '/auth/me', dev);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      ok: true, mode: 'proxy', authenticated: true, sub: 'alice', email: 'alice@example.test', name: null, expiresAt: null,
      user: { login: 'proxy://proxy#alice', kind: 'oidc', owner: false },
      orgs: [{ id: 'default', name: 'Default', role: 'operator', effectiveRole: 'operator', default: true }],
      logoutUrl: 'https://sso.example.test/logout',
    });
    assert.equal((await get(s.base, '/api/packs', dev)).status, 200);
    assert.equal(await inspect(ws, (v) => v.seq()), seq, 'the second and third requests wrote nothing (the gate and /auth/me share one sign-in)');

    // The headers are ambient like a cookie: a session mutation still needs the CSRF header.
    r = await call(s.base, 'POST', '/api/validate', { headers: { ...dev, 'Content-Type': 'application/x-yaml' }, body: PACK_YAML });
    assert.deepEqual([r.status, r.json.denied], [403, 'csrf']);
    assert.equal(await inspect(ws, (v) => v.seq()), seq, 'the refused mutation wrote nothing');
    r = await call(s.base, 'POST', '/api/validate', { headers: { ...dev, ...CSRF, 'Content-Type': 'application/x-yaml' }, body: PACK_YAML });
    assert.equal(r.json?.ok, true, r.text.slice(0, 200));
    const rows = await auditAfter(ws, seq);
    assert.deepEqual(rows[0].slice(0, 3), ['pack.register', 'proxy://proxy#alice', 'default'], 'the actor is the principal\'s login, as in every session mode');

    // Sign-out: 204, nothing written; "sign out my other sessions" is not a route here.
    r = await call(s.base, 'POST', '/auth/logout', { headers: dev });
    assert.equal(r.status, 204);
    r = await call(s.base, 'POST', '/auth/signout-others', { headers: { ...dev, ...CSRF } });
    assert.equal(r.status, 404);
    // The admin UI's join-role answer says what rules first-sight roles here.
    r = await get(s.base, '/api/admin/join-role', { 'X-Forwarded-User': 'root' });
    assert.deepEqual([r.status, r.json], [200, { ok: true, role: null, oidc: false, issuerKey: null, mode: 'proxy', proxy: { joinRole: null, groupsConfigured: true, org: null } }]);
  } finally { await s.stop(); }
  await inspect(ws, (v) => assert.equal(v.meta('identity_mode'), 'proxy:proxy://proxy'));
});

test('groups are authoritative in the configured org: raised, lowered, removed (then 403 no org membership), untouched when the header is absent; the profile syncs; the owner grant once and never revoked', async () => {
  const ws = workspace();
  const s = await serve(ws, { env: GROUPS });
  try {
    const as = (groups, extra = {}) => ({ ...alice, ...extra, ...(groups === undefined ? {} : { 'X-Forwarded-Groups': groups }) });
    assert.equal((await get(s.base, '/api/packs', as('dev'))).status, 200);
    const seq0 = await inspect(ws, (v) => v.seq());
    assert.equal((await get(s.base, '/api/packs', as('dev, sre'))).status, 200);
    assert.deepEqual(await auditAfter(ws, seq0), [['membership.role', 'system', 'default', 'proxy://proxy#alice', { from: 'operator', to: 'admin', via: 'proxy-groups' }]]);
    assert.equal((await get(s.base, '/api/org/members', as('sre'))).status, 200, 'an admin now');
    assert.equal((await get(s.base, '/api/packs', as(undefined))).status, 200);
    assert.deepEqual(await inspect(ws, (v) => v.roles('proxy://proxy#alice')), ['default:admin'], 'no groups header: the membership stays');
    assert.equal((await get(s.base, '/api/packs', as('dev'))).status, 200);
    assert.deepEqual(await inspect(ws, (v) => v.roles('proxy://proxy#alice')), ['default:operator'], 'lowered');
    const seq1 = await inspect(ws, (v) => v.seq());
    assert.equal((await get(s.base, '/api/packs', as('nobody'))).status, 200, '* keeps every named user a viewer');
    assert.deepEqual(await inspect(ws, (v) => v.roles('proxy://proxy#alice')), ['default:viewer']);
    assert.equal((await call(s.base, 'DELETE', '/api/uploads', { headers: { ...as('nobody'), ...CSRF } })).status, 403, 'a viewer may not reset');
    assert.deepEqual(rowsOf(await auditAfter(ws, seq1)), [['membership.role', 'system', 'default', 'proxy://proxy#alice']]);

    // An empty groups header is a statement: no groups — and with no * the user has no membership.
    await s.stop();
    const s2 = await serve(ws, { env: { ...GROUPS, OBSERVOGRAM_PROXY_AUTH_GROUP_ROLES: 'sre=admin,dev=operator' } });
    try {
      const seq2 = await inspect(ws, (v) => v.seq());
      let r = await get(s2.base, '/api/packs', as(''));
      assert.deepEqual([r.status, r.json], [403, { ok: false, error: 'no org membership — ask an admin to add you', denied: 'org' }]);
      assert.deepEqual(await auditAfter(ws, seq2), [['membership.remove', 'system', 'default', 'proxy://proxy#alice', { role: 'viewer', via: 'proxy-groups' }]]);
      assert.deepEqual(await inspect(ws, (v) => v.roles('proxy://proxy#alice')), []);
      r = await get(s2.base, '/auth/me', as(''));
      assert.deepEqual([r.json.authenticated, r.json.orgs], [true, []], 'signed in, in no org');
      // The profile follows the headers: a new email is one user.update row.
      const seq3 = await inspect(ws, (v) => v.seq());
      assert.equal((await get(s2.base, '/auth/me', as('dev', { 'X-Forwarded-Email': 'alice.b@example.test' }))).status, 200);
      assert.deepEqual(rowsOf(await auditAfter(ws, seq3)), [
        ['user.update', 'system', null, 'proxy://proxy#alice'],
        ['membership.jit', 'system', 'default', 'proxy://proxy#alice'],
      ]);
      assert.deepEqual((await auditAfter(ws, seq3))[0][4], { fields: ['email'] });
      assert.equal((await inspect(ws, (v) => v.users()))[0].email, 'alice.b@example.test');

      // root: owner.grant once across three requests; dropping the group revokes nothing.
      const seq4 = await inspect(ws, (v) => v.seq());
      for (const g of ['sre', 'sre', '']) assert.equal((await get(s2.base, '/api/admin/users', { 'X-Forwarded-User': 'root', 'X-Forwarded-Groups': g })).status, 200, `root with groups ${JSON.stringify(g)}`);
      const rootRows = (await auditAfter(ws, seq4)).filter((row) => row[3] === 'proxy://proxy#root');
      assert.deepEqual(rootRows, [
        ['user.jit', 'system', null, 'proxy://proxy#root', { via: 'proxy', sessionEpoch: 1 }],
        ['membership.jit', 'system', 'default', 'proxy://proxy#root', { role: 'admin', via: 'proxy-groups' }],
        ['owner.grant', 'system', null, 'proxy://proxy#root', { via: 'proxy', match: null, org: 'default', membership: 'kept', from: 'admin' }],
        ['membership.remove', 'system', 'default', 'proxy://proxy#root', { role: 'admin', via: 'proxy-groups' }],
      ]);
      const root = (await inspect(ws, (v) => v.users())).find((u) => u.login === 'proxy://proxy#root');
      assert.equal(root.is_owner, 1, 'still an owner after the groups dropped');
      assert.equal((await get(s2.base, '/api/admin/users', { 'X-Forwarded-User': 'root' })).status, 200, 'an owner acts as admin everywhere, membership or not');
    } finally { await s2.stop(); }
  } catch (e) {
    await s.stop().catch(() => {});
    throw e;
  }
});

test('a group mapped to owner grants it; PROXY_AUTH_JOIN_ROLE rules the first sight when no groups header is configured, and only then', async () => {
  const ws = workspace();
  const s = await serve(ws, { env: { ...ACK, OBSERVOGRAM_PROXY_AUTH_JOIN_ROLE: 'viewer' } });
  try {
    assert.equal((await get(s.base, '/api/packs', alice)).status, 200);
    assert.deepEqual(await inspect(ws, (v) => v.roles('proxy://proxy#alice')), ['default:viewer']);
    assert.deepEqual(rowsOf(await inspect(ws, (v) => v.audit())).filter((r) => r[3] === 'proxy://proxy#alice'), [
      ['user.jit', 'system', null, 'proxy://proxy#alice'], ['membership.jit', 'system', 'default', 'proxy://proxy#alice'],
    ]);
    assert.deepEqual((await inspect(ws, (v) => v.audit())).find((r) => r[0] === 'membership.jit')[4], { role: 'viewer' }, 'the join rule, not the groups rule');
    const r = await get(s.base, '/api/packs', { 'X-Forwarded-User': 'carol' });
    assert.equal(r.status, 200, 'no email is fine');
  } finally { await s.stop(); }
  const s2 = await serve(ws, { env: { ...GROUPS, OBSERVOGRAM_PROXY_AUTH_GROUP_ROLES: 'boss=owner', OBSERVOGRAM_PROXY_AUTH_OWNERS: '' } });
  try {
    assert.equal((await get(s2.base, '/api/admin/orgs', { 'X-Forwarded-User': 'dana', 'X-Forwarded-Groups': 'boss' })).status, 200);
    const dana = (await inspect(ws, (v) => v.users())).find((u) => u.login === 'proxy://proxy#dana');
    assert.equal(dana.is_owner, 1);
    assert.deepEqual(await inspect(ws, (v) => v.roles('proxy://proxy#dana')), ['default:admin']);
  } finally { await s2.stop(); }
});

test('refused identities: a disabled row (no re-enable), a local row holding the login, duplicate raw header lines, 2001 characters, a control character — 401, no row, nothing written; a carried-over cookie is ignored; the bearer wins', async () => {
  const ws = workspace();
  // A local row named like a proxy user would be: the CLI cannot create one
  // (its login shape), so the import does — alice holds the login.
  writeUsersFile({ users: { 'proxy://proxy#alice': { name: 'Impostor', createdAt: 't', password: hashPassword('x-passw0rd') } } }, join(ws, 'users.json'));
  let s = await serve(ws, { env: { ...GROUPS, OBSERVOGRAM_API_TOKEN: 'tok-0123456789', OBSERVOGRAM_API_TOKEN_LABEL: 'ci-bot' } });
  try {
    const imported = await inspect(ws, (v) => v.users());
    assert.deepEqual(imported.map((u) => [u.login, u.kind]), [['proxy://proxy#alice', 'local']]);
    const seq = await inspect(ws, (v) => v.seq());
    let r = await get(s.base, '/api/packs', { ...alice, 'X-Forwarded-Groups': 'dev' });
    assert.deepEqual([r.status, r.json.denied], [401, 'auth'], 'a local row holds the login');
    r = await get(s.base, '/auth/login', alice);
    assert.deepEqual([r.status, r.json.error], [401, 'no sign-in page: this server takes identity from its reverse proxy, and this request\'s X-Forwarded-User was refused (a disabled or local user, a duplicated header)']);
    // bob is created, then disabled from the shell by the proxy spelling: refused from the next request, never re-enabled.
    assert.equal((await get(s.base, '/api/packs', { 'X-Forwarded-User': 'bob', 'X-Forwarded-Groups': 'dev' })).status, 200);
    const removed = cli(USERS_CLI, ['remove', 'proxy://proxy#bob'], ws);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(removed.stdout.trim().split('\n').pop(), 'disabled proxy://proxy#bob (users are never deleted: the audit references them)');
    r = await get(s.base, '/api/packs', { 'X-Forwarded-User': 'bob', 'X-Forwarded-Groups': 'sre' });
    assert.deepEqual([r.status, r.json.denied], [401, 'auth']);
    const after = await inspect(ws, (v) => v.seq());
    // Duplicate raw lines (fetch would join them into 'carol, root').
    r = await rawCall(s.base, 'GET', '/api/packs', ['X-Forwarded-User', 'carol', 'X-Forwarded-User', 'root']);
    assert.deepEqual([r.status, r.json.denied], [401, 'auth'], 'two user lines');
    r = await rawCall(s.base, 'GET', '/api/packs', ['X-Forwarded-User', 'carol', 'X-Forwarded-Groups', 'dev', 'x-forwarded-groups', 'sre']);
    assert.deepEqual([r.status, r.json.denied], [401, 'auth'], 'two groups lines');
    r = await get(s.base, '/api/packs', { 'X-Forwarded-User': 'c'.repeat(2001) });
    assert.deepEqual([r.status, r.json.denied], [401, 'auth'], '2001 characters');
    r = await get(s.base, '/api/packs', { 'X-Forwarded-User': 'c'.repeat(2000), 'X-Forwarded-Groups': 'dev' });
    assert.equal(r.status, 200, '2000 characters is a user');
    // HTTP itself refuses most control characters in a header; a tab is the
    // one it lets through — and the one a forged `users -- list` line needs.
    r = await rawCall(s.base, 'GET', '/api/packs', ['X-Forwarded-User', 'car\tol']);
    assert.deepEqual([r.status, r.json.denied], [401, 'auth'], 'a control character');
    r = await get(s.base, '/api/packs', { 'X-Forwarded-User': '   ' });
    assert.deepEqual([r.status, r.json.denied], [401, 'auth'], 'empty after trim');
    r = await rawCall(s.base, 'GET', '/api/packs', ['X-Forwarded-User', 'carol', 'X-Forwarded-Email', 'bad\tmail@example.test']);
    assert.deepEqual([r.status, r.json.denied], [401, 'auth'], 'a control character in the email refuses the request');
    const users = await inspect(ws, (v) => v.users());
    assert.deepEqual(users.map((u) => u.login).filter((l) => /carol|root|c{10}/.test(l) === false || l === `proxy://proxy#${'c'.repeat(2000)}`),
      ['proxy://proxy#alice', 'proxy://proxy#bob', `proxy://proxy#${'c'.repeat(2000)}`], 'no carol, no root');
    assert.deepEqual(rowsOf(await auditAfter(ws, after)).filter((row) => !row[3]?.startsWith('proxy://proxy#ccc')), [], 'the refused requests wrote nothing');
    assert.equal(users.find((u) => u.login === 'proxy://proxy#bob').disabled, 1, 'bob stays disabled');
    // A session cookie from another mode: ignored (the headers are the session).
    r = await get(s.base, '/api/packs', { Cookie: 'observogram_session=v1.eyJ4IjoxfQ.YWJj' });
    assert.deepEqual([r.status, r.json.denied], [401, 'auth']);
    // The bearer wins over a refused proxy header, and acts as ci-bot.
    r = await call(s.base, 'DELETE', '/api/uploads', { headers: { Authorization: 'Bearer tok-0123456789', ...alice } });
    assert.equal(r.status, 200);
    assert.deepEqual(rowsOf(await auditAfter(ws, await inspect(ws, (v) => v.seq()) - 1)), [['pack.clear', 'ci-bot', 'default', null]]);
    assert.ok(seq >= 0);
  } finally { await s.stop(); }

  // Hermetic: a child without the variables never inherits this process's.
  process.env.OBSERVOGRAM_TRUST_PROXY_AUTH = '1';
  process.env.TOMOGRAPH_TRUST_PROXY_AUTH_ACK = PROXY_ACK;
  try {
    assert.equal(childEnv(null).OBSERVOGRAM_TRUST_PROXY_AUTH, undefined);
    assert.equal(childEnv(null).TOMOGRAPH_TRUST_PROXY_AUTH_ACK, undefined);
    const ws2 = workspace();
    s = await serve(ws2, { env: { OBSERVOGRAM_AUTH: 'off' } });
    try {
      const me = await get(s.base, '/auth/me', alice);
      assert.ok(me.json === null || me.json.mode !== 'proxy', 'the child runs open: the parent\'s flag did not reach it');
      assert.equal((await get(s.base, '/api/packs', alice)).status, 200);
    } finally { await s.stop(); }
    await inspect(ws2, (v) => { assert.deepEqual(v.users(), []); assert.equal(v.meta('identity_mode'), 'off'); });
  } finally {
    delete process.env.OBSERVOGRAM_TRUST_PROXY_AUTH;
    delete process.env.TOMOGRAPH_TRUST_PROXY_AUTH_ACK;
  }
});

test('the shared secret on an exposed bind: headers without it → 401, a wrong one → 401, the right one → 200; the secret is in no output and no row', async () => {
  const ws = workspace();
  const env = { ...GROUPS, OBSERVOGRAM_PROXY_AUTH_SHARED_SECRET: SECRET };
  const s = await serve(ws, { host: '0.0.0.0', env });
  try {
    let r = await get(s.base, '/api/packs', { ...alice, 'X-Forwarded-Groups': 'dev' });
    assert.deepEqual([r.status, r.json.denied], [401, 'auth'], 'no secret');
    r = await get(s.base, '/api/packs', { ...alice, 'X-Forwarded-Groups': 'dev', 'X-Proxy-Auth-Secret': `${SECRET.slice(0, -1)}X` });
    assert.deepEqual([r.status, r.json.denied], [401, 'auth'], 'a wrong secret');
    r = await get(s.base, '/auth/login', { ...alice, 'X-Proxy-Auth-Secret': 'nope' });
    assert.equal(r.json.error, 'no sign-in page: this server takes identity from its reverse proxy, and this request\'s X-Forwarded-User was refused (a disabled or local user, a duplicated header, or a missing or wrong X-Proxy-Auth-Secret)');
    assert.deepEqual(await inspect(ws, (v) => v.users()), [], 'no row');
    r = await rawCall(s.base, 'GET', '/api/packs', ['X-Forwarded-User', 'alice', 'X-Proxy-Auth-Secret', SECRET, 'X-Proxy-Auth-Secret', SECRET]);
    assert.deepEqual([r.status, r.json.denied], [401, 'auth'], 'a duplicated secret header');
    r = await get(s.base, '/api/packs', { ...alice, 'X-Forwarded-Groups': 'dev', 'X-Proxy-Auth-Secret': SECRET });
    assert.equal(r.status, 200, 'the right secret');
    r = await get(s.base, '/auth/me', { ...alice, 'X-Proxy-Auth-Secret': SECRET });
    assert.equal(r.json.user.login, 'proxy://proxy#alice');
  } finally { await s.stop(); }
  await inspect(ws, (v) => {
    const everything = JSON.stringify([v.users(), v.audit()]);
    assert.ok(!everything.includes(SECRET), 'the secret is in no row');
  });
});

// ---------- the CLIs ----------

test('resolveLogin accepts proxy://<realm>#<user> whatever issuer the store records; serverSignInMode reads identity_mode proxy:<key>; the owner CLI creates the row', async () => {
  const ws = workspace();
  const s = await serve(ws, { env: ACK });
  await s.stop();
  const db = await openRaw(join(ws, 'observogram.db'));
  try {
    assert.equal(prepare(db, "SELECT value FROM schema_meta WHERE key = 'identity_mode'").get().value, 'proxy:proxy://proxy');
    const t = resolveLogin(db, 'proxy://proxy#alice');
    assert.deepEqual([t.kind, t.login, t.sub, t.issuerKey, t.row], ['oidc', 'proxy://proxy#alice', 'alice', 'proxy://proxy', null]);
    assert.deepEqual(resolveLogin(db, 'proxy://other.realm#a#b').login, 'proxy://other.realm#a#b', 'the sub may hold a #');
    assert.throws(() => resolveLogin(db, 'proxy://proxy#'), { message: /proxy:\/\/proxy# is not proxy:\/\/<realm>#<user>/ });
    assert.throws(() => resolveLogin(db, 'proxy://Bad#alice'), { message: /is not <issuer>#<sub>/ }, 'a bad realm is not the proxy spelling, and not a URL');
    const m = serverSignInMode(db);
    assert.deepEqual(m, { kind: 'oidc', issuerKey: 'proxy://proxy', why: 'the server last started behind a reverse proxy (identity key proxy://proxy)' });
    // With an OIDC issuer recorded (a store that moved from OIDC), the proxy spelling still resolves.
    prepare(db, "INSERT INTO schema_meta (key, value) VALUES ('oidc_issuer', 'https://idp.example/')").run();
    assert.equal(resolveLogin(db, 'proxy://proxy#alice').kind, 'oidc');
    assert.throws(() => resolveLogin(db, 'alice'), { message: /this store records OIDC issuer/ }, 'a bare login from a plain shell keeps refusing (identity-admin step 4)');
    prepare(db, "DELETE FROM schema_meta WHERE key = 'oidc_issuer'").run();
  } finally { db.close(); }
  const owner = cli(USERS_CLI, ['owner', 'proxy://proxy#root'], ws);
  assert.equal(owner.status, 0, owner.stderr);
  const s2 = await serve(ws, { env: ACK });
  try {
    const r = await get(s2.base, '/auth/me', { 'X-Forwarded-User': 'root', 'X-Forwarded-Email': 'root@example.test' });
    assert.deepEqual([r.json.user.owner, r.json.user.login, r.json.email], [true, 'proxy://proxy#root', 'root@example.test'], 'the CLI\'s row signs in, the profile syncs');
    assert.equal((await get(s2.base, '/api/admin/users', { 'X-Forwarded-User': 'root' })).status, 200);
  } finally { await s2.stop(); }
  const list = cli(USERS_CLI, ['list'], ws);
  assert.ok(list.stdout.split('\n').some((l) => l.startsWith('proxy://proxy#root\toidc\t') && l.includes('\towner\tenabled\t')), list.stdout);
});
