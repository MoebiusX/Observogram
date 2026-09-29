#!/usr/bin/env node
/**
 * server/test-identity-api.mjs — the identity API (docs/STORE_PLAN.md §5,
 * slice 3b), in-process over HTTP on one stand-alone identity server.
 *
 * For every owner route (/api/admin/*): the success path with its exact
 * response and its exact audit rows (action, actor = the caller's login,
 * org, target, detail — each action one the route table lists for it),
 * and every refusal with its status and text and no new row. Plus
 * Revocation (an owner's sign-out everywhere, disable and password reset
 * refuse the user's cookies from the next request; a temporary password
 * is a forced change with no skip), the last-owner rules end to end, the
 * owner flag's round trip (the grant records the role it replaced; the
 * revoke touches no membership and says so), and the join role's confirm.
 *
 * Who may reach these routes in each posture is test-authz's (the AuthZ
 * matrix); this suite is what they do once reached.
 *
 * The fixture is test-authz's identity posture — users.json + orgs.json:
 * default {olive, otto, owen: admin; val: viewer} (olive, otto, owen become
 * owners), acme {ada: admin, oscar: operator, vera, dan, owen: viewer},
 * bravo {bob, mia: admin}; then, as a shell would: otto leaves the default
 * org (an owner with no membership), mia joins acme as a viewer, dan is
 * disabled; eve1 and eve2 share a verified email.
 */

// Hermetic (§0): a developer shell's store or identity variables never
// reach this process's imports. serve-child.mjs imports no server code.
const { STRIP, signIn } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-identity-api-'));
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;
process.env.OBSERVOGRAM_API_TOKEN = 'identity-api-token-0123456789';
process.env.OBSERVOGRAM_API_TOKEN_LABEL = 'ci-bot';

const { hashPassword } = await import('./auth.mjs');
const { writeUsersFile, writeOrgsFile } = await import('./store/legacy-files.mjs');

const pw = (login) => `${login}-passw0rd-api`;
const LOGINS = ['olive', 'otto', 'owen', 'ada', 'oscar', 'vera', 'mia', 'dan', 'bob', 'mallory', 'val', 'eve1', 'eve2'];
writeUsersFile({ users: Object.fromEntries(LOGINS.map((l) => [l, { name: l, createdAt: 'test', password: hashPassword(pw(l)) }])) }, join(WORKSPACE, 'users.json'));
writeOrgsFile({
  default: { name: 'Default', members: { olive: 'admin', otto: 'admin', owen: 'admin', val: 'viewer' } },
  acme: { name: 'Acme', members: { ada: 'admin', oscar: 'operator', vera: 'viewer', dan: 'viewer', owen: 'viewer' } },
  bravo: { name: 'Bravo', members: { bob: 'admin', mia: 'admin' } },
}, join(WORKSPACE, 'orgs.json'));

const { start } = await import('./index.mjs');
const { currentStore, closeStore, prepare } = await import('./store/db.mjs');
const { createUser, getUserByLogin, setDisabled, updateUserProfile } = await import('./store/users.mjs');
const { removeMembership, setRole } = await import('./store/memberships.mjs');
const { getMeta } = await import('./store/meta.mjs');
const { addMemberByLogin, disableUser, removeMemberByLogin } = await import('./identity-admin.mjs');
const { routeEntry } = await import('./route-table.mjs');

const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
const BASE = `http://127.0.0.1:${srv.address().port}`;
const db = currentStore();

after(async () => {
  await new Promise((resolve) => srv.close(resolve));
  closeStore();
  rmSync(WORKSPACE, { recursive: true, force: true });
});

// The shell steps of the fixture (actor cli, as `npm run orgs` / `users` write them).
removeMemberByLogin(db, 'cli', { orgId: 'default', arg: 'otto' });
addMemberByLogin(db, 'cli', { orgId: 'acme', arg: 'mia', role: 'viewer' });
for (const login of ['eve1', 'eve2']) updateUserProfile(db, 'system', getUserByLogin(db, login).id, { email: 'eve@example.test', emailVerified: true });

const idOf = (login) => getUserByLogin(db, login).id;
const cookies = {};
async function signInAs(login, password = pw(login)) {
  const s = await signIn(BASE, login, password);
  assert.equal(s.status, 200, `${login} signs in: ${JSON.stringify(s.json)}`);
  assert.ok(s.session, `${login} gets a session`);
  cookies[login] = s.session;
  return s.session;
}
for (const login of ['olive', 'owen', 'ada', 'oscar', 'vera', 'val']) await signInAs(login);
disableUser(db, 'cli', 'dan');

// ---------- requests and the audit trail ----------

const CSRF = { 'X-Observogram-CSRF': '1' };

// One request as `who` (a login whose cookie is held, or a cookie string,
// or null): { status, json, text, headers }.
async function call(who, method, path, body, extra = {}) {
  const cookie = who === null ? null : (cookies[who] ?? who);
  const headers = { Accept: 'application/json', ...CSRF, ...(cookie ? { Cookie: cookie } : {}), ...extra };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const r = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text, headers: r.headers };
}

const seqNow = () => prepare(db, 'SELECT coalesce(max(seq), 0) AS s FROM audit').get().s;
// The rows after `seq`: [action, actor, org, target, detail].
const rowsAfter = (seq) => prepare(db, 'SELECT org_id, actor, action, target_id, detail FROM audit WHERE seq > ? ORDER BY seq').all(seq)
  .map((r) => [r.action, r.actor, r.org_id, r.target_id, r.detail === null ? null : JSON.parse(r.detail)]);

// A successful call of route `key`: its status, and the rows it wrote —
// each an action the route table lists for the route (exact per build).
async function ok(key, who, path, body, status = 200) {
  const seq = seqNow();
  const r = await call(who, routeEntry(key).method, path, body);
  assert.equal(r.status, status, `${key} as ${who}: ${r.text.slice(0, 300)}`);
  assert.equal(r.json.ok, true);
  const rows = rowsAfter(seq);
  const listed = routeEntry(key).audit;
  assert.deepEqual(rows.map(([action]) => action).filter((a) => !listed.includes(a)), [], `${key}: rows the route table does not list`);
  return { json: r.json, rows };
}

// A refusal: exactly { ok: false, error } at `status`, and no row.
async function refused(key, who, path, body, status, error) {
  const seq = seqNow();
  const r = await call(who, routeEntry(key).method, path, body);
  assert.deepEqual([r.status, r.json], [status, { ok: false, error }], `${key} ${path} ${JSON.stringify(body)}`);
  assert.deepEqual(rowsAfter(seq), [], `${key}: a refusal writes no row`);
}

const VIEW_KEYS = ['id', 'login', 'kind', 'name', 'email', 'emailVerified', 'owner', 'disabled', 'mustChange', 'seededDefault',
  'createdAt', 'lastLoginAt', 'memberships'];
const isView = (u) => assert.deepEqual(Object.keys(u), VIEW_KEYS, `the user view of ${u.login}: named fields only (no password, no session epoch)`);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BAD_IDS = ['abc', '0', '01', '-1', '1.5', '1e3', '12345678901234567'];

// ---------- the reads ----------

test('GET /api/admin/users: every user by id, as the user view — never a password or a session epoch', async () => {
  const { json, rows } = await ok('GET /api/admin/users', 'olive', '/api/admin/users');
  assert.deepEqual(rows, []);
  assert.deepEqual(json.users.map((u) => u.login).sort(), [...LOGINS].sort());
  assert.deepEqual(json.users.map((u) => u.id), json.users.map((u) => u.id).sort((a, b) => a - b), 'by id');
  json.users.forEach(isView);
  const by = Object.fromEntries(json.users.map((u) => [u.login, u]));
  const olive = by.olive;
  assert.ok(ISO.test(olive.createdAt) && ISO.test(olive.lastLoginAt), 'timestamps');
  assert.deepEqual({ ...olive, createdAt: 'T', lastLoginAt: 'T' }, {
    id: idOf('olive'), login: 'olive', kind: 'local', name: 'olive', email: null, emailVerified: false, owner: true, disabled: false,
    mustChange: false, seededDefault: false, createdAt: 'T', lastLoginAt: 'T', memberships: [{ orgId: 'default', role: 'admin' }],
  });
  assert.deepEqual([by.otto.owner, by.otto.memberships], [true, []], 'an owner with no membership');
  assert.deepEqual([by.owen.memberships], [[{ orgId: 'default', role: 'admin' }, { orgId: 'acme', role: 'viewer' }]]);
  assert.deepEqual([by.dan.disabled, by.dan.owner], [true, false]);
  assert.deepEqual([by.eve1.email, by.eve1.emailVerified], ['eve@example.test', true]);
  assert.equal(by.mallory.lastLoginAt, null);
});

test('GET /api/admin/orgs: every org, removed ones too, with its member count; GET /api/admin/join-role', async () => {
  let { json, rows } = await ok('GET /api/admin/orgs', 'olive', '/api/admin/orgs');
  assert.deepEqual(rows, []);
  assert.equal(json.defaultOrg, 'default');
  assert.ok(json.orgs.every((o) => ISO.test(o.createdAt)));
  assert.deepEqual(json.orgs.map((o) => ({ ...o, createdAt: 'T' })), [
    { id: 'default', name: 'Default', root: getMetaRoot('default'), default: true, removedAt: null, createdAt: 'T', members: 3 },
    { id: 'acme', name: 'Acme', root: 'orgs/acme', default: false, removedAt: null, createdAt: 'T', members: 6 },
    { id: 'bravo', name: 'Bravo', root: 'orgs/bravo', default: false, removedAt: null, createdAt: 'T', members: 2 },
  ]);
  ({ json, rows } = await ok('GET /api/admin/join-role', 'olive', '/api/admin/join-role'));
  assert.deepEqual([json, rows], [{ ok: true, role: getMeta(db, 'oidc_join_role'), oidc: false, issuerKey: null }, []]);
});
function getMetaRoot(id) { return prepare(db, 'SELECT root FROM orgs WHERE id = ?').get(id).root; }

// ---------- users ----------

test('POST /api/admin/users: a local user in the org named, its exact rows; it signs in', async () => {
  const { json, rows } = await ok('POST /api/admin/users', 'olive', '/api/admin/users', {
    login: 'nina', password: pw('nina'), name: 'Nina', email: 'nina@example.test', role: 'viewer', orgId: 'acme',
  }, 201);
  isView(json.user);
  assert.deepEqual({ ...json, user: { ...json.user, createdAt: 'T' } }, {
    ok: true,
    user: {
      id: idOf('nina'), login: 'nina', kind: 'local', name: 'Nina', email: 'nina@example.test', emailVerified: false, owner: false,
      disabled: false, mustChange: false, seededDefault: false, createdAt: 'T', lastLoginAt: null, memberships: [{ orgId: 'acme', role: 'viewer' }],
    },
    owner: false, joined: [{ orgId: 'acme', role: 'viewer' }], armed: false, note: null,
  });
  assert.deepEqual(rows, [
    ['user.create', 'olive', null, 'nina', { kind: 'local', isOwner: false, sessionEpoch: 1, disabled: false }],
    ['membership.add', 'olive', 'acme', 'nina', { role: 'viewer' }],
  ]);
  await signInAs('nina');
  const r = await call('nina', 'GET', '/api/orgs');
  assert.deepEqual(r.json.orgs, [{ id: 'acme', name: 'Acme', role: 'viewer', effectiveRole: 'viewer' }]);
  // No role: an operator.
  const second = await ok('POST /api/admin/users', 'owen', '/api/admin/users', { login: 'noah', password: 'noah-passw0rd', orgId: 'bravo' }, 201);
  assert.deepEqual(second.json.joined, [{ orgId: 'bravo', role: 'operator' }]);
  assert.deepEqual(second.rows.map((x) => x.slice(0, 4)), [['user.create', 'owen', null, 'noah'], ['membership.add', 'owen', 'bravo', 'noah']]);
});

test('POST /api/admin/users: every refusal, its status and text, and no row', async () => {
  const K = 'POST /api/admin/users';
  const P = '/api/admin/users';
  const good = { password: 'rita-passw0rd', orgId: 'acme' };
  const SHAPE = 'username must be 2–64 chars of [a-zA-Z0-9._@-]';
  for (const login of [undefined, 'x', 'has space', 42]) await refused(K, 'olive', P, { ...good, login }, 400, SHAPE);
  await refused(K, 'olive', P, '["rita"]', 400, SHAPE);   // not a JSON object: nothing named
  for (const [login, use] of [['system', "the store's automatic grants"], ['cli', 'a shell'], ['local', 'the server without sign-in'],
    ['token', 'the API token'], ['ci-bot', 'the API token']]) {
    await refused(K, 'olive', P, { ...good, login }, 400, `"${login}" is reserved — the audit log uses it for ${use}; choose another username`);
  }
  await refused(K, 'olive', P, { ...good, login: 'rita', role: 'boss' }, 400, 'roles are viewer, operator or admin, not "boss"');
  await refused(K, 'olive', P, { ...good, login: 'rita', role: 'member' }, 400, "roles are viewer, operator or admin ('member' is now 'operator')");
  await refused(K, 'olive', P, { ...good, login: 'dan' }, 409,
    `user exists: dan, disabled — enable it with POST /api/admin/users/${idOf('dan')}/enable (POST /api/admin/users/${idOf('dan')}/password sets a new password)`);
  await refused(K, 'olive', P, { ...good, login: 'vera' }, 409, `user exists: vera — reset its password with POST /api/admin/users/${idOf('vera')}/password`);
  await refused(K, 'olive', P, { ...good, login: 'rita', orgId: 'nope' }, 400, 'no live org "nope"');
  await refused(K, 'olive', P, { login: 'rita', password: 'rita-passw0rd' }, 400, 'this deployment has 3 orgs: name one with "orgId"');
  for (const password of [undefined, '', 'short77', 12345678]) {
    await refused(K, 'olive', P, { login: 'rita', orgId: 'acme', password }, 400, 'a password of at least 8 characters is required');
  }
  await refused(K, 'olive', P, { ...good, login: 'rita', name: 42 }, 400, 'observogram store: name must be a non-empty string of at most 200 characters');
  assert.equal(getUserByLogin(db, 'rita'), null, 'nothing was created');
});

test('POST /api/admin/users/:id/disable and /enable: the rows, the no-ops, the seeded default, your own row; a disabled user is refused', async () => {
  const nina = idOf('nina');
  let { json, rows } = await ok('POST /api/admin/users/:id/disable', 'olive', `/api/admin/users/${nina}/disable`);
  isView(json.user);
  assert.deepEqual([json.user.login, json.user.disabled, json.you], ['nina', true, false]);
  assert.deepEqual(rows, [['user.disable', 'olive', null, 'nina', null]]);
  assert.equal((await call('nina', 'GET', '/api/packs')).status, 401, 'her cookie is refused from the next request');
  const denied = await signIn(BASE, 'nina', pw('nina'));
  assert.deepEqual([denied.status, denied.session], [401, null], 'a disabled user cannot sign in');
  ({ rows } = await ok('POST /api/admin/users/:id/disable', 'olive', `/api/admin/users/${nina}/disable`));
  assert.deepEqual(rows, [], 'already disabled: no row');

  ({ json, rows } = await ok('POST /api/admin/users/:id/enable', 'olive', `/api/admin/users/${nina}/enable`));
  assert.deepEqual(Object.keys(json), ['ok', 'user']);
  assert.equal(json.user.disabled, false);
  assert.deepEqual(rows, [['user.enable', 'olive', null, 'nina', null]]);
  ({ rows } = await ok('POST /api/admin/users/:id/enable', 'olive', `/api/admin/users/${nina}/enable`));
  assert.deepEqual(rows, [], 'not disabled: no row');
  await signInAs('nina');

  // A disabled row still holding the seeded default password: set a temporary one first.
  const seedy = createUser(db, 'system', { login: 'seedy', password: hashPassword('admin'), mustChange: true, seededDefault: true, disabled: true });
  await refused('POST /api/admin/users/:id/enable', 'olive', `/api/admin/users/${seedy.id}/enable`, undefined, 409,
    `seedy still has the seeded default password — set a temporary one first (POST /api/admin/users/${seedy.id}/password)`);
  await ok('POST /api/admin/users/:id/password', 'olive', `/api/admin/users/${seedy.id}/password`, { password: 'seedy-temp-1' });
  ({ rows } = await ok('POST /api/admin/users/:id/enable', 'olive', `/api/admin/users/${seedy.id}/enable`));
  assert.deepEqual(rows, [['user.enable', 'olive', null, 'seedy', null]]);

  // The caller's own row: its session ends.
  ({ json } = await ok('POST /api/admin/users/:id/disable', 'owen', `/api/admin/users/${idOf('owen')}/disable`));
  assert.deepEqual([json.user.disabled, json.you], [true, true]);
  assert.equal((await call('owen', 'GET', '/api/packs')).status, 401);
  await ok('POST /api/admin/users/:id/enable', 'olive', `/api/admin/users/${idOf('owen')}/enable`);
  await signInAs('owen');

  for (const key of ['POST /api/admin/users/:id/disable', 'POST /api/admin/users/:id/enable']) {
    const verb = key.split('/').pop();
    await refused(key, 'olive', `/api/admin/users/999999/${verb}`, undefined, 404, 'no user 999999');
    for (const id of BAD_IDS) await refused(key, 'olive', `/api/admin/users/${id}/${verb}`, undefined, 400, 'user id must be a positive integer');
  }
});

test('POST /api/admin/users/:id/password: a temporary password — every session ends, the next sign-in is a forced change with no skip', async () => {
  const K = 'POST /api/admin/users/:id/password';
  const oscar = idOf('oscar');
  const old = cookies.oscar;
  const { json, rows } = await ok(K, 'olive', `/api/admin/users/${oscar}/password`, { password: 'oscar-temp-pass1' });
  isView(json.user);
  assert.deepEqual([json.mustChange, json.user.mustChange, json.user.seededDefault], [true, true, false]);
  assert.deepEqual(rows, [['user.password', 'olive', null, 'oscar', null]]);
  assert.equal((await call(old, 'GET', '/api/packs')).status, 401, 'his old cookie is refused');
  assert.equal((await signIn(BASE, 'oscar', pw('oscar'))).status, 401, 'his old password is gone');
  const flow = await signIn(BASE, 'oscar', 'oscar-temp-pass1');
  assert.ok(flow.pwflow && !flow.session, 'the temporary password gets the forced change, not a session');
  let r = await fetch(`${BASE}/auth/change-password`, { headers: { Cookie: flow.pwflow }, redirect: 'manual' });
  assert.equal(r.status, 200);
  assert.doesNotMatch(await r.text(), /change-password\/skip/, 'no skip control');
  r = await fetch(`${BASE}/auth/change-password/skip`, { method: 'POST', headers: { Cookie: flow.pwflow, Accept: 'application/json' }, redirect: 'manual' });
  assert.deepEqual([r.status, (await r.json()).error], [403, 'a password change is required for this account']);
  r = await fetch(`${BASE}/auth/change-password`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: flow.pwflow, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(pw('oscar'))}&repeat=${encodeURIComponent(pw('oscar'))}`,
  });
  assert.equal(r.status, 200);
  await signInAs('oscar');

  await refused(K, 'olive', '/api/admin/users/999999/password', { password: 'long-enough-1' }, 404, 'no user 999999');
  for (const id of BAD_IDS) await refused(K, 'olive', `/api/admin/users/${id}/password`, { password: 'long-enough-1' }, 400, 'user id must be a positive integer');
  await refused(K, 'olive', `/api/admin/users/${idOf('olive')}/password`, { password: 'long-enough-1' }, 409,
    'this is your own account — change your password at /auth/change-password');
  const idp = createUser(db, 'system', { kind: 'oidc', login: 'https://idp.example.test#sub-1', issuer: 'https://idp.example.test', sub: 'sub-1' });
  await refused(K, 'olive', `/api/admin/users/${idp.id}/password`, { password: 'long-enough-1' }, 409,
    `https://idp.example.test#sub-1 signs in through the IdP and has no password here — sign them out everywhere (POST /api/admin/users/${idp.id}/signout) or disable them`);
  for (const body of [{}, { password: 'short7' }, { password: 123456789 }]) {
    await refused(K, 'olive', `/api/admin/users/${oscar}/password`, body, 400, 'a temporary password of at least 8 characters is required');
  }
});

test('POST /api/admin/users/:id/signout: sign out everywhere — every cookie of the user is refused from its next request', async () => {
  const K = 'POST /api/admin/users/:id/signout';
  const oscar = idOf('oscar');
  const before = getUserByLogin(db, 'oscar').sessionEpoch;
  let { json, rows } = await ok(K, 'olive', `/api/admin/users/${oscar}/signout`);
  isView(json.user);
  assert.deepEqual([json.sessionEpoch, json.you], [before + 1, false]);
  assert.deepEqual(rows, [['user.signout', 'olive', null, 'oscar', { sessionEpoch: before + 1 }]]);
  assert.equal((await call('oscar', 'GET', '/api/packs')).status, 401, '/api refuses his cookie');
  const me = await (await fetch(`${BASE}/auth/me`, { headers: { Cookie: cookies.oscar } })).json();
  assert.equal(me.authenticated, false, '/auth/me no longer knows him');
  const page = await fetch(`${BASE}/auth/change-password`, { headers: { Cookie: cookies.oscar }, redirect: 'manual' });
  assert.deepEqual([page.status, page.headers.get('location')], [302, '/auth/login'], 'the change-password page sends him to sign in');
  await signInAs('oscar');
  assert.equal((await call('oscar', 'GET', '/api/packs', undefined, { 'X-Observogram-Org': 'acme' })).status, 200, 'a new sign-in works');

  // The caller's own: its session ends too.
  ({ json } = await ok(K, 'olive', `/api/admin/users/${idOf('olive')}/signout`));
  assert.equal(json.you, true);
  assert.equal((await call('olive', 'GET', '/api/packs')).status, 401);
  await signInAs('olive');

  await refused(K, 'olive', '/api/admin/users/999999/signout', undefined, 404, 'no user 999999');
  for (const id of BAD_IDS) await refused(K, 'olive', `/api/admin/users/${id}/signout`, undefined, 400, 'user id must be a positive integer');
});

test('PUT /api/admin/users/:id/owner: the round trip — the grant records the role it replaced, the revoke touches no membership and says so', async () => {
  const K = 'PUT /api/admin/users/:id/owner';
  const val = idOf('val');
  let { json, rows } = await ok(K, 'olive', `/api/admin/users/${val}/owner`, { owner: true });
  isView(json.user);
  assert.deepEqual([json.user.owner, json.changed, json.memberships, json.note], [true, true, [{ orgId: 'default', role: 'admin' }], null]);
  assert.deepEqual(rows, [['owner.grant', 'olive', null, 'val', { via: 'api', match: null, org: 'default', membership: 'raised', from: 'viewer' }]]);
  ({ json, rows } = await ok(K, 'olive', `/api/admin/users/${val}/owner`, { owner: true }));
  assert.deepEqual([json.changed, rows], [false, []], 'already an owner: no row');

  ({ json, rows } = await ok(K, 'olive', `/api/admin/users/${val}/owner`, { owner: false }));
  assert.deepEqual([json.user.owner, json.changed, json.memberships], [false, true, [{ orgId: 'default', role: 'admin' }]]);
  assert.equal(json.note, `val is still an admin of default: an owner grant makes the user an admin of the default org (the grant's audit row records the role before it) `
    + `— change it with PATCH /api/org/members/${val} in org default if that was not their role`);
  assert.deepEqual(rows, [['owner.revoke', 'olive', null, 'val', { via: 'api', org: 'default', role: 'admin' }]]);
  ({ json, rows } = await ok(K, 'olive', `/api/admin/users/${val}/owner`, { owner: false }));
  assert.deepEqual([json.changed, json.note, rows], [false, null, []], 'not an owner: no row, no note');
  setRole(db, 'system', 'default', val, 'viewer');   // back to the fixture

  // A grant to a user with no default-org membership adds one (from: null).
  const nina = idOf('nina');
  ({ rows } = await ok(K, 'olive', `/api/admin/users/${nina}/owner`, { owner: true }));
  assert.deepEqual(rows[0][4], { via: 'api', match: null, org: 'default', membership: 'added', from: null });
  ({ json } = await ok(K, 'olive', `/api/admin/users/${nina}/owner`, { owner: false }));
  assert.deepEqual(json.memberships, [{ orgId: 'acme', role: 'viewer' }, { orgId: 'default', role: 'admin' }]);
  removeMembership(db, 'system', 'default', nina);

  await refused(K, 'olive', `/api/admin/users/${idOf('dan')}/owner`, { owner: true }, 409, `dan is disabled — enable it first (POST /api/admin/users/${idOf('dan')}/enable)`);
  for (const body of [{}, { owner: 'yes' }, { owner: 1 }, { owner: null }]) {
    await refused(K, 'olive', `/api/admin/users/${val}/owner`, body, 400, '"owner" is true or false');
  }
  await refused(K, 'olive', '/api/admin/users/999999/owner', { owner: true }, 404, 'no user 999999');
  for (const id of BAD_IDS) await refused(K, 'olive', `/api/admin/users/${id}/owner`, { owner: true }, 400, 'user id must be a positive integer');
});

// ---------- orgs ----------

test('POST /api/admin/orgs: the creator is its first admin; an occupied directory needs adopt; every refusal', async () => {
  const K = 'POST /api/admin/orgs';
  let { json, rows } = await ok(K, 'olive', '/api/admin/orgs', { id: 'charlie', name: 'Charlie' }, 201);
  assert.ok(ISO.test(json.org.createdAt));
  assert.deepEqual({ ...json, org: { ...json.org, createdAt: 'T' } }, {
    ok: true, org: { id: 'charlie', name: 'Charlie', root: 'orgs/charlie', removedAt: null, createdAt: 'T' }, adopted: false, path: join(WORKSPACE, 'orgs', 'charlie'),
  });
  assert.deepEqual(rows, [
    ['org.create', 'olive', null, 'charlie', { name: 'Charlie', root: 'orgs/charlie' }],
    ['membership.add', 'olive', 'charlie', 'olive', { role: 'admin' }],
  ]);
  const inCharlie = await call('olive', 'GET', '/api/orgs', undefined, { 'X-Observogram-Org': 'charlie' });
  assert.deepEqual(inCharlie.json.orgs.find((o) => o.id === 'charlie'), { id: 'charlie', name: 'Charlie', role: 'admin', effectiveRole: 'admin' });

  // An occupied orgs/<id>/: refused, then taken over with adopt; the name defaults to the id.
  mkdirSync(join(WORKSPACE, 'orgs', 'delta'), { recursive: true });
  writeFileSync(join(WORKSPACE, 'orgs', 'delta', 'left.txt'), 'x');
  await refused(K, 'olive', '/api/admin/orgs', { id: 'delta' }, 409, `${join(WORKSPACE, 'orgs', 'delta')} exists and is not empty — send "adopt": true to take it over`);
  await refused(K, 'olive', '/api/admin/orgs', { id: 'delta', adopt: 'yes' }, 409, `${join(WORKSPACE, 'orgs', 'delta')} exists and is not empty — send "adopt": true to take it over`);
  ({ json, rows } = await ok(K, 'owen', '/api/admin/orgs', { id: 'delta', adopt: true }, 201));
  assert.deepEqual([json.org.name, json.adopted, json.path], ['delta', true, join(WORKSPACE, 'orgs', 'delta')]);
  assert.deepEqual(rows, [
    ['org.create', 'owen', null, 'delta', { name: 'delta', root: 'orgs/delta' }],
    ['org.adopt', 'owen', null, 'delta', { path: join(WORKSPACE, 'orgs', 'delta') }],
    ['membership.add', 'owen', 'delta', 'owen', { role: 'admin' }],
  ]);

  await refused(K, 'olive', '/api/admin/orgs', { id: '!' }, 400, '"!" is not an org id (a slug: lowercase letters, digits, - and _)');
  await refused(K, 'olive', '/api/admin/orgs', { id: 'Echo' }, 400, '"Echo" is not an org id (a slug: lowercase letters, digits, - and _)');
  for (const name of ['', '   ', 'x'.repeat(201), 7]) await refused(K, 'olive', '/api/admin/orgs', { id: 'echo', name }, 400, 'an org name is 1–200 characters');
  await refused(K, 'olive', '/api/admin/orgs', { id: 'acme' }, 409, 'org "acme" exists or existed — a slug is never reused');
});

test('DELETE /api/admin/orgs/:id: a soft removal — the files stay, the org is refused at once, its slug never returns', async () => {
  const K = 'DELETE /api/admin/orgs/:id';
  const { json, rows } = await ok(K, 'olive', '/api/admin/orgs/charlie');
  assert.ok(ISO.test(json.org.removedAt));
  assert.deepEqual({ ...json, org: { ...json.org, createdAt: 'T', removedAt: 'T' } }, {
    ok: true, org: { id: 'charlie', name: 'Charlie', root: 'orgs/charlie', removedAt: 'T', createdAt: 'T' },
    note: `its files under ${join(WORKSPACE, 'orgs', 'charlie')} stay; with the server stopped, packc store purge-org charlie deletes them`,
  });
  assert.deepEqual(rows, [['org.remove', 'olive', null, 'charlie', null]]);
  const r = await call('olive', 'GET', '/api/packs', undefined, { 'X-Observogram-Org': 'charlie' });
  assert.deepEqual([r.status, r.json.denied, r.json.error], [403, 'org', "unknown org 'charlie'"], 'refused from the next request');
  const listed = (await call('olive', 'GET', '/api/admin/orgs')).json.orgs.find((o) => o.id === 'charlie');
  assert.deepEqual([listed.removedAt, listed.members], [json.org.removedAt, 1], 'still listed, removed; the membership row stays');

  await refused(K, 'olive', '/api/admin/orgs/charlie', undefined, 404, 'no live org "charlie"');
  await refused(K, 'olive', '/api/admin/orgs/nope', undefined, 404, 'no live org "nope"');
  await refused(K, 'olive', '/api/admin/orgs/Acme', undefined, 404, 'no live org "Acme"');
  await refused(K, 'olive', '/api/admin/orgs/default', undefined, 409, 'default is the default org and cannot be removed');
  await refused('POST /api/admin/orgs', 'olive', '/api/admin/orgs', { id: 'charlie' }, 409, 'org "charlie" exists or existed — a slug is never reused');
});

// ---------- the join role ----------

test('PUT /api/admin/join-role: viewer, operator, admin (with confirm) or none; one meta.set row { from, to }; unchanged writes nothing', async () => {
  const K = 'PUT /api/admin/join-role';
  const start = getMeta(db, 'oidc_join_role');
  let { json, rows } = await ok(K, 'olive', '/api/admin/join-role', { role: 'viewer' });
  assert.deepEqual([json, rows], [{ ok: true, role: 'viewer', from: start }, [['meta.set', 'olive', null, 'oidc_join_role', { from: start, to: 'viewer' }]]]);
  ({ json, rows } = await ok(K, 'olive', '/api/admin/join-role', { role: 'viewer' }));
  assert.deepEqual([json, rows], [{ ok: true, role: 'viewer', from: 'viewer' }, []], 'unchanged: no row');
  assert.equal((await call('olive', 'GET', '/api/admin/join-role')).json.role, 'viewer');

  const ADMIN = 'every user the IdP lets in would become an admin of default — its name, its members and, from slice 4, its MCP endpoints; '
    + 'to add admins one by one use POST /api/org/members with {"role": "admin"}, or send {"role": "admin", "confirm": true}';
  await refused(K, 'olive', '/api/admin/join-role', { role: 'admin' }, 409, ADMIN);
  await refused(K, 'olive', '/api/admin/join-role', { role: 'admin', confirm: 'true' }, 409, ADMIN);
  ({ json, rows } = await ok(K, 'olive', '/api/admin/join-role', { role: 'admin', confirm: true }));
  assert.deepEqual([json, rows], [{ ok: true, role: 'admin', from: 'viewer' }, [['meta.set', 'olive', null, 'oidc_join_role', { from: 'viewer', to: 'admin' }]]]);
  ({ json, rows } = await ok(K, 'owen', '/api/admin/join-role', { role: 'none' }));
  assert.deepEqual([json, rows], [{ ok: true, role: null, from: 'admin' }, [['meta.set', 'owen', null, 'oidc_join_role', { from: 'admin', to: null }]]]);
  ({ json, rows } = await ok(K, 'owen', '/api/admin/join-role', { role: null }));
  assert.deepEqual([json, rows], [{ ok: true, role: null, from: null }, []]);
  ({ json } = await ok(K, 'owen', '/api/admin/join-role', { role: 'operator' }));
  assert.deepEqual(json, { ok: true, role: 'operator', from: null });
  assert.equal((await call('olive', 'GET', '/api/admin/join-role')).json.role, 'operator');

  const JOIN = 'the join role is viewer, operator, admin, or null for no automatic join — not';
  await refused(K, 'olive', '/api/admin/join-role', {}, 400, `${JOIN} undefined`);
  await refused(K, 'olive', '/api/admin/join-role', { role: 'boss' }, 400, `${JOIN} "boss"`);
  await refused(K, 'olive', '/api/admin/join-role', { role: '' }, 400, `${JOIN} ""`);
  await refused(K, 'olive', '/api/admin/join-role', { role: 3 }, 400, `${JOIN} 3`);
});

// ---------- the owner set ----------

test('the last owner: neither demoted nor disabled — the last enabled owner, then the last who can sign in; with another owner, both answer 200', async () => {
  const K = 'PUT /api/admin/users/:id/owner';
  const [olive, otto, owen] = ['olive', 'otto', 'owen'].map(idOf);
  let { json, rows } = await ok(K, 'olive', `/api/admin/users/${otto}/owner`, { owner: false });
  assert.deepEqual([json.changed, json.memberships, json.note], [true, [], null], 'otto: no membership, so no note');
  assert.deepEqual(rows, [['owner.revoke', 'olive', null, 'otto', { via: 'api', org: 'default', role: null }]]);
  ({ json } = await ok(K, 'olive', `/api/admin/users/${owen}/owner`, { owner: false }));
  assert.equal(json.changed, true);

  const ENABLED = 'olive is the last enabled owner — make another user an owner first (PUT /api/admin/users/<id>/owner with {"owner": true})';
  await refused(K, 'olive', `/api/admin/users/${olive}/owner`, { owner: false }, 409, ENABLED);
  await refused('POST /api/admin/users/:id/disable', 'olive', `/api/admin/users/${olive}/disable`, undefined, 409, ENABLED);

  // Another enabled owner who cannot sign in with a password.
  const keyless = createUser(db, 'system', { login: 'keyless', isOwner: true });
  const SIGN_IN = 'olive is the last owner who can sign in with a local password (this server signs in with local passwords) '
    + '— make another user who signs in that way an owner first (PUT /api/admin/users/<id>/owner with {"owner": true})';
  await refused(K, 'olive', `/api/admin/users/${olive}/owner`, { owner: false }, 409, SIGN_IN);
  await refused('POST /api/admin/users/:id/disable', 'olive', `/api/admin/users/${olive}/disable`, undefined, 409, SIGN_IN);

  // With another owner who signs in: 200.
  ({ rows } = await ok(K, 'olive', `/api/admin/users/${owen}/owner`, { owner: true }));
  assert.deepEqual(rows, [['owner.grant', 'olive', null, 'owen', { via: 'api', match: null, org: 'default', membership: 'kept', from: 'admin' }]]);
  ({ rows } = await ok('POST /api/admin/users/:id/disable', 'owen', `/api/admin/users/${olive}/disable`));
  assert.deepEqual(rows, [['user.disable', 'owen', null, 'olive', null]]);
  await ok('POST /api/admin/users/:id/enable', 'owen', `/api/admin/users/${olive}/enable`);
  ({ json } = await ok(K, 'owen', `/api/admin/users/${olive}/owner`, { owner: false }));
  assert.equal(json.changed, true);
  await ok(K, 'owen', `/api/admin/users/${olive}/owner`, { owner: true });
  await signInAs('olive');

  // Back to the fixture: otto an owner with no membership; keyless gone.
  await ok(K, 'olive', `/api/admin/users/${otto}/owner`, { owner: true });
  removeMembership(db, 'system', 'default', otto);
  setDisabled(db, 'system', keyless.id, true);
  const owners = (await call('olive', 'GET', '/api/admin/users')).json.users.filter((u) => u.owner && !u.disabled).map((u) => u.login);
  assert.deepEqual(owners.sort(), ['olive', 'otto', 'owen']);
});

test('the owner routes answer an owner only: an org admin, a viewer and the bearer are refused, and nothing is written', async () => {
  const seq = seqNow();
  for (const who of ['ada', 'vera']) {
    const r = await call(who, 'POST', '/api/admin/users', { login: 'rita', password: 'rita-passw0rd', orgId: 'acme' }, { 'X-Observogram-Org': 'acme' });
    assert.deepEqual([r.status, r.json.denied, r.json.need], [403, 'role', 'owner'], who);
  }
  const r = await call(null, 'PUT', '/api/admin/join-role', { role: 'admin', confirm: true }, { Authorization: `Bearer ${process.env.OBSERVOGRAM_API_TOKEN}` });
  assert.deepEqual([r.status, r.json.denied], [403, 'role'], 'the bearer');
  assert.deepEqual(rowsAfter(seq), []);
});
