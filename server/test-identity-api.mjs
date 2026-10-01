#!/usr/bin/env node
/**
 * server/test-identity-api.mjs — the identity API (docs/STORE_PLAN.md §5,
 * slice 3b), in-process over HTTP on one stand-alone identity server.
 *
 * For every owner route (/api/admin/*), every admin route (/api/org*,
 * the request's org) and the self route POST /auth/signout-others: the
 * success path with its exact response and its exact audit rows (action,
 * actor = the caller's login, org, target, detail — each action one the
 * route table lists for it), and every refusal with its status and text
 * and no new row. Plus Revocation (an owner's sign-out everywhere, disable
 * and password reset refuse the user's cookies from the next request; a
 * temporary password is a forced change with no skip; "sign out my other
 * sessions" refuses the caller's other cookies and re-issues its own at
 * the new epoch, its expiry kept), the last-owner rules end to end, the
 * owner flag's round trip (the grant records the role it replaced; the
 * revoke touches no membership and says so; the org's admin sets the role
 * back), the join role's confirm, the org's last admin on all three paths
 * that can demote or remove one (an owner may, and so may the shell), and
 * what a member-add refusal reveals (to an org admin, no one, a disabled
 * user and several are one 404; an owner gets the detail).
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
const { STRIP, cli, signIn } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

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
const { getMembership, removeMembership } = await import('./store/memberships.mjs');
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

// A successful call of route `key` (`extra`: more headers, such as the
// org): its status, and the rows it wrote — each an action the route table
// lists for the route (exact per build); its response headers too.
async function ok(key, who, path, body, status = 200, extra = {}) {
  const seq = seqNow();
  const r = await call(who, routeEntry(key).method, path, body, extra);
  assert.equal(r.status, status, `${key} as ${who}: ${r.text.slice(0, 300)}`);
  assert.equal(r.json.ok, true);
  const rows = rowsAfter(seq);
  const listed = routeEntry(key).audit;
  assert.deepEqual(rows.map(([action]) => action).filter((a) => !listed.includes(a)), [], `${key}: rows the route table does not list`);
  return { json: r.json, rows, headers: r.headers };
}

// A refusal: exactly { ok: false, error } at `status`, and no row.
async function refused(key, who, path, body, status, error, extra = {}) {
  const seq = seqNow();
  const r = await call(who, routeEntry(key).method, path, body, extra);
  assert.deepEqual([r.status, r.json], [status, { ok: false, error }], `${key} ${path} ${JSON.stringify(body)}`);
  assert.deepEqual(rowsAfter(seq), [], `${key}: a refusal writes no row`);
}

const VIEW_KEYS = ['id', 'login', 'kind', 'name', 'email', 'emailVerified', 'owner', 'disabled', 'mustChange', 'seededDefault',
  'createdAt', 'lastLoginAt', 'memberships'];
const isView = (u) => assert.deepEqual(Object.keys(u), VIEW_KEYS, `the user view of ${u.login}: named fields only (no password, no session epoch)`);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// A 16-digit id past 2^53 - 1 is refused too: bound as a number it would
// round, and a refusal would name an id the caller never sent.
const BAD_IDS = ['abc', '0', '01', '-1', '1.5', '1e3', '12345678901234567', '9007199254740992', '9007199254740993', '9999999999999999'];

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
    await refused(key, 'olive', `/api/admin/users/9007199254740991/${verb}`, undefined, 404, 'no user 9007199254740991');
    for (const id of BAD_IDS) await refused(key, 'olive', `/api/admin/users/${id}/${verb}`, undefined, 400, 'user id must be a positive integer, at most 9007199254740991');
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
  for (const id of BAD_IDS) await refused(K, 'olive', `/api/admin/users/${id}/password`, { password: 'long-enough-1' }, 400, 'user id must be a positive integer, at most 9007199254740991');
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
  for (const id of BAD_IDS) await refused(K, 'olive', `/api/admin/users/${id}/signout`, undefined, 400, 'user id must be a positive integer, at most 9007199254740991');
});

// A session cookie's signed payload ({ login, ep, exp, … }).
const payloadOf = (cookie) => JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[1], 'base64url').toString('utf8'));

test('POST /auth/signout-others: sign out my other sessions — every other cookie of the caller is refused from its next request; this one is re-issued at the new epoch, its expiry kept', async () => {
  const K = 'POST /auth/signout-others';
  const P = '/auth/signout-others';
  const mine = cookies.vera;
  const other = (await signIn(BASE, 'vera', pw('vera'))).session;   // vera's second browser
  for (const c of [mine, other]) assert.equal((await call(c, 'GET', '/api/packs')).status, 200, 'both of vera\'s cookies work');
  const before = getUserByLogin(db, 'vera').sessionEpoch;

  // Refused, and nothing written: no CSRF header; no session at all.
  let seq = seqNow();
  let r = await fetch(`${BASE}${P}`, { method: 'POST', headers: { Cookie: mine, Accept: 'application/json' } });
  assert.deepEqual([r.status, (await r.json()).denied], [403, 'csrf'], 'without the CSRF header');
  const NO_SESSION = { ok: false, error: 'unauthorized: sign in required', login: '/auth/login', denied: 'auth' };
  for (const [label, extra] of [['anonymous', {}], ['the bearer', { Authorization: `Bearer ${process.env.OBSERVOGRAM_API_TOKEN}` }]]) {
    r = await call(null, 'POST', P, undefined, extra);
    assert.deepEqual([r.status, r.json], [401, NO_SESSION], label);
  }
  assert.deepEqual(rowsAfter(seq), []);
  assert.equal(getUserByLogin(db, 'vera').sessionEpoch, before, 'nothing bumped');

  const t0 = Date.now();
  const { json, rows, headers } = await ok(K, mine, P);
  assert.deepEqual(json, { ok: true, sessionEpoch: before + 1 });
  assert.deepEqual(rows, [['user.signout', 'vera', null, 'vera', { sessionEpoch: before + 1 }]], 'one row, vera its actor');
  const set = headers.getSetCookie().find((c) => c.startsWith('observogram_session='));
  assert.ok(set, 'the response re-issues this browser\'s cookie');
  const reissued = set.split(';')[0];
  assert.deepEqual([payloadOf(reissued).login, payloadOf(reissued).ep], ['vera', before + 1], 'at the new epoch');
  assert.equal(payloadOf(reissued).exp, payloadOf(mine).exp, 'its expiry kept: signing out elsewhere never extends a session');
  const maxAge = Number(set.match(/Max-Age=(\d+)/)[1]);
  assert.ok(maxAge > 0 && maxAge <= Math.floor((payloadOf(mine).exp - t0) / 1000), `Max-Age ${maxAge}: what remains of the session`);

  for (const [label, c] of [['the other browser', other], ['this browser\'s cookie before the re-issue', mine]]) {
    assert.equal((await call(c, 'GET', '/api/packs')).status, 401, `${label}: /api refuses it`);
    const me = await (await fetch(`${BASE}/auth/me`, { headers: { Cookie: c } })).json();
    assert.equal(me.authenticated, false, `${label}: /auth/me no longer knows it`);
    seq = seqNow();
    r = await call(c, 'POST', P);
    assert.deepEqual([r.status, r.json], [401, NO_SESSION], `${label}: it signs out nothing`);
    assert.deepEqual(rowsAfter(seq), []);
  }
  cookies.vera = reissued;
  assert.equal((await call('vera', 'GET', '/api/packs')).status, 200, 'the re-issued cookie works');
  const me = await (await fetch(`${BASE}/auth/me`, { headers: { Cookie: reissued } })).json();
  assert.deepEqual([me.authenticated, me.user.login], [true, 'vera']);
  assert.equal(getUserByLogin(db, 'vera').sessionEpoch, before + 1);
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
  // The way the note names: the default org's admin sets the role back.
  ({ json, rows } = await ok('PATCH /api/org/members/:userId', 'olive', `/api/org/members/${val}`, { role: 'viewer' }, 200, { 'X-Observogram-Org': 'default' }));
  assert.deepEqual([json.member.login, json.member.role, json.changed], ['val', 'viewer', { from: 'admin', to: 'viewer' }]);
  assert.deepEqual(rows, [['membership.role', 'olive', 'default', 'val', { from: 'admin', to: 'viewer' }]]);

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
  for (const id of BAD_IDS) await refused(K, 'olive', `/api/admin/users/${id}/owner`, { owner: true }, 400, 'user id must be a positive integer, at most 9007199254740991');
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

// ---------- the request's org: its name and its members ----------
//
// The admin routes act on the org the request is in (the org middleware
// resolved it: ada lands in acme, her one membership; an owner names it).

const ACME = Object.freeze({ 'X-Observogram-Org': 'acme' });
const MEMBER_KEYS = ['userId', 'login', 'kind', 'name', 'email', 'role', 'disabled', 'since'];
const isMember = (m) => assert.deepEqual(Object.keys(m), MEMBER_KEYS, `the member view of ${m.login}: named fields only (no password, no session epoch)`);
const userCount = () => prepare(db, 'SELECT count(*) AS n FROM users').get().n;
const ORG_ADMIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'org-admin.mjs');

test('GET /api/org/members: the request\'s org and its members, as the member view — an admin\'s own org, any org an owner names', async () => {
  const K = 'GET /api/org/members';
  let { json, rows } = await ok(K, 'ada', '/api/org/members');
  assert.deepEqual(rows, []);
  assert.deepEqual(Object.keys(json), ['ok', 'org', 'members']);
  assert.deepEqual(json.org, { id: 'acme', name: 'Acme', default: false });
  json.members.forEach(isMember);
  assert.ok(json.members.every((m) => ISO.test(m.since)), 'since: when the membership began');
  assert.deepEqual({ ...json.members[0], since: 'T' }, {
    userId: idOf('ada'), login: 'ada', kind: 'local', name: 'ada', email: null, role: 'admin', disabled: false, since: 'T',
  });
  const ACME_MEMBERS = [['ada', 'admin', false], ['oscar', 'operator', false], ['vera', 'viewer', false], ['dan', 'viewer', true],
    ['owen', 'viewer', false], ['mia', 'viewer', false], ['nina', 'viewer', false]];
  assert.deepEqual(json.members.map((m) => [m.login, m.role, m.disabled]), ACME_MEMBERS, 'first member first; a disabled member listed');
  // An owner reaches any org it names: owen (a viewer member of acme) and
  // olive (no membership there) read the same list.
  for (const who of ['owen', 'olive']) {
    ({ json } = await ok(K, who, '/api/org/members', undefined, 200, ACME));
    assert.deepEqual(json.members.map((m) => [m.login, m.role, m.disabled]), ACME_MEMBERS, who);
  }
  // With no org named, olive lands in her first membership: the default org.
  ({ json } = await ok(K, 'olive', '/api/org/members'));
  assert.deepEqual(json.org, { id: 'default', name: 'Default', default: true });
  assert.deepEqual(json.members.map((m) => [m.login, m.role]), [['olive', 'admin'], ['owen', 'admin'], ['val', 'viewer']]);
});

test('PATCH /api/org: the request\'s org renamed — org.rename { from, to } on the org; unchanged writes nothing', async () => {
  const K = 'PATCH /api/org';
  let { json, rows } = await ok(K, 'ada', '/api/org', { name: 'Acme Corp' });
  assert.deepEqual(json, { ok: true, org: { id: 'acme', name: 'Acme Corp', default: false } });
  assert.deepEqual(rows, [['org.rename', 'ada', 'acme', 'acme', { from: 'Acme', to: 'Acme Corp' }]]);
  assert.deepEqual((await call('ada', 'GET', '/api/orgs')).json.orgs, [{ id: 'acme', name: 'Acme Corp', role: 'admin', effectiveRole: 'admin' }]);
  ({ json, rows } = await ok(K, 'ada', '/api/org', { name: 'Acme Corp' }));
  assert.deepEqual([json.org.name, rows], ['Acme Corp', []], 'unchanged: no row');
  for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(201) }, { name: 7 }, '["Acme"]']) {
    await refused(K, 'ada', '/api/org', body, 400, 'an org name is 1–200 characters');
  }
  // An owner renames the org it names — here, back.
  ({ rows } = await ok(K, 'owen', '/api/org', { name: 'Acme' }, 200, ACME));
  assert.deepEqual(rows, [['org.rename', 'owen', 'acme', 'acme', { from: 'Acme Corp', to: 'Acme' }]]);
});

test('POST /api/org/members: an existing user, by exact login or by a verified email — 201 added, 200 the upsert; never a new user', async () => {
  const K = 'POST /api/org/members';
  const users = userCount();
  // By login, at the default role: operator.
  let { json, rows } = await ok(K, 'ada', '/api/org/members', { login: 'eve1' }, 201);
  isMember(json.member);
  assert.ok(ISO.test(json.member.since));
  assert.deepEqual({ ...json, member: { ...json.member, since: 'T' } }, {
    ok: true, added: true,
    member: { userId: idOf('eve1'), login: 'eve1', kind: 'local', name: 'eve1', email: 'eve@example.test', role: 'operator', disabled: false, since: 'T' },
  });
  assert.deepEqual(Object.keys(json), ['ok', 'member', 'added']);
  assert.deepEqual(rows, [['membership.add', 'ada', 'acme', 'eve1', { role: 'operator' }]]);
  // The upsert: a member at another role gets it (membership.role); at the same role, nothing.
  ({ json, rows } = await ok(K, 'ada', '/api/org/members', { login: 'eve1', role: 'viewer' }));
  assert.deepEqual(Object.keys(json), ['ok', 'member', 'added', 'changed']);
  assert.deepEqual([json.added, json.changed, json.member.role], [false, { from: 'operator', to: 'viewer' }, 'viewer']);
  assert.deepEqual(rows, [['membership.role', 'ada', 'acme', 'eve1', { from: 'operator', to: 'viewer' }]]);
  ({ json, rows } = await ok(K, 'ada', '/api/org/members', { login: 'eve1', role: 'viewer' }));
  assert.deepEqual([json.added, json.changed, rows], [false, null, []], 'unchanged: no row');

  // By the one enabled user whose sign-in verified the email, compared
  // without case; the answer's login says whom it matched.
  updateUserProfile(db, 'system', idOf('mallory'), { email: 'mallory@example.test', emailVerified: true });
  ({ json, rows } = await ok(K, 'ada', '/api/org/members', { email: 'Mallory@Example.TEST', role: 'viewer' }, 201));
  assert.deepEqual([json.member.login, json.member.email, json.member.role], ['mallory', 'mallory@example.test', 'viewer']);
  assert.deepEqual(rows, [['membership.add', 'ada', 'acme', 'mallory', { role: 'viewer' }]]);
  // An IdP user, by its exact login.
  ({ json, rows } = await ok(K, 'ada', '/api/org/members', { login: 'https://idp.example.test#sub-1', role: 'viewer' }, 201));
  assert.deepEqual([json.member.kind, json.member.login], ['oidc', 'https://idp.example.test#sub-1']);
  assert.deepEqual(rows, [['membership.add', 'ada', 'acme', 'https://idp.example.test#sub-1', { role: 'viewer' }]]);
  assert.equal(userCount(), users, 'no user was created');
});

test('POST /api/org/members: what a refusal reveals — to an org admin, no one, a disabled user and several are one 404; an owner gets the detail', async () => {
  const K = 'POST /api/org/members';
  const P = '/api/org/members';
  const users = userCount();
  const NAME = 'name the user with "login" (the exact login) or "email" (a verified email)';
  for (const body of [{}, { login: 'eve2', email: 'eve@example.test' }, { login: 42 }, { login: '' }, { email: '' }, { email: 7 }, '["eve2"]']) {
    await refused(K, 'ada', P, body, 400, NAME);
  }
  await refused(K, 'ada', P, { login: 'eve2', role: 'member' }, 400, "roles are viewer, operator or admin ('member' is now 'operator')");
  // The role is read before anyone is looked up: one answer, whoever is named.
  for (const login of ['eve2', 'dan', 'nobody']) await refused(K, 'ada', P, { login, role: 'boss' }, 400, 'roles are viewer, operator or admin, not "boss"');

  // To an org admin: absent and disabled are one text by login; none,
  // several, disabled and unverified are one text by email.
  updateUserProfile(db, 'system', idOf('dan'), { email: 'dan@example.test', emailVerified: true });
  const byLogin = (x) => `no enabled user "${x}" — an owner creates local users and re-enables disabled ones; an IdP user can be added after their first sign-in`;
  const byEmail = (x) => `no single enabled user has the verified email ${x} (an email counts only when the sign-in verified it) — `
    + 'add them by login; an IdP user can be added after their first sign-in';
  for (const login of ['dan', 'nobody']) await refused(K, 'ada', P, { login }, 404, byLogin(login));
  for (const email of ['eve@example.test', 'dan@example.test', 'nobody@example.test', 'nina@example.test']) {
    await refused(K, 'ada', P, { email }, 404, byEmail(email));
  }

  // An owner (olive, in acme) learns which.
  const DISABLED = `dan is disabled — enable it first (POST /api/admin/users/${idOf('dan')}/enable)`;
  await refused(K, 'olive', P, { login: 'dan' }, 409, DISABLED, ACME);
  await refused(K, 'olive', P, { login: 'nobody' }, 404,
    'no user "nobody" — create a local user with POST /api/admin/users; an IdP user exists after their first sign-in', ACME);
  await refused(K, 'olive', P, { email: 'eve@example.test' }, 409, '2 users have the verified email eve@example.test — add one by login', ACME);
  await refused(K, 'olive', P, { email: 'dan@example.test' }, 409, DISABLED, ACME);
  await refused(K, 'olive', P, { email: 'nina@example.test' }, 404,
    'no user has the verified email nina@example.test — an email counts only when the sign-in verified it; add them by login', ACME);
  assert.equal(userCount(), users, 'no user was created');
});

test('PATCH /api/org/members/:userId: a member\'s role — membership.role { from, to }; no member, whether or not the id is a user, is one 404', async () => {
  const K = 'PATCH /api/org/members/:userId';
  const oscar = idOf('oscar');
  let { json, rows } = await ok(K, 'ada', `/api/org/members/${oscar}`, { role: 'viewer' });
  isMember(json.member);
  assert.deepEqual(Object.keys(json), ['ok', 'member', 'changed']);
  assert.deepEqual([json.member.login, json.member.role, json.changed], ['oscar', 'viewer', { from: 'operator', to: 'viewer' }]);
  assert.deepEqual(rows, [['membership.role', 'ada', 'acme', 'oscar', { from: 'operator', to: 'viewer' }]]);
  const r = await call('oscar', 'POST', '/api/validate', {});
  assert.deepEqual([r.status, r.json.denied, r.json.role], [403, 'role', 'viewer'], 'oscar is a viewer from his next request');
  ({ json, rows } = await ok(K, 'ada', `/api/org/members/${oscar}`, { role: 'viewer' }));
  assert.deepEqual([json.changed, rows], [null, []], 'unchanged: no row');
  ({ rows } = await ok(K, 'ada', `/api/org/members/${oscar}`, { role: 'operator' }));
  assert.deepEqual(rows, [['membership.role', 'ada', 'acme', 'oscar', { from: 'viewer', to: 'operator' }]]);

  // bob is in bravo, otto in no org, 999999 no one: one answer — nothing
  // outside acme is told apart.
  for (const id of [idOf('bob'), idOf('otto'), 999999, Number.MAX_SAFE_INTEGER]) {
    await refused(K, 'ada', `/api/org/members/${id}`, { role: 'viewer' }, 404, `user ${id} is not a member of acme`);
  }
  for (const id of BAD_IDS) await refused(K, 'ada', `/api/org/members/${id}`, { role: 'viewer' }, 400, 'user id must be a positive integer, at most 9007199254740991');
  for (const body of [{}, { role: null }]) await refused(K, 'ada', `/api/org/members/${oscar}`, body, 400, 'a role is required: viewer, operator or admin');
  await refused(K, 'ada', `/api/org/members/${oscar}`, { role: 'boss' }, 400, 'roles are viewer, operator or admin, not "boss"');
  await refused(K, 'ada', `/api/org/members/${oscar}`, { role: 'member' }, 400, "roles are viewer, operator or admin ('member' is now 'operator')");
});

test('DELETE /api/org/members/:userId: a member removed — membership.remove { role }; refused from the next request', async () => {
  const K = 'DELETE /api/org/members/:userId';
  const mallory = idOf('mallory');
  let { json, rows } = await ok(K, 'ada', `/api/org/members/${mallory}`);
  assert.deepEqual(Object.keys(json), ['ok', 'removed']);
  isMember(json.removed);
  assert.deepEqual([json.removed.login, json.removed.role], ['mallory', 'viewer']);
  assert.deepEqual(rows, [['membership.remove', 'ada', 'acme', 'mallory', { role: 'viewer' }]]);
  await refused(K, 'ada', `/api/org/members/${mallory}`, undefined, 404, `user ${mallory} is not a member of acme`);

  // eve1 works in acme until she is removed; then she has no org.
  await signInAs('eve1');
  assert.equal((await call('eve1', 'GET', '/api/packs')).status, 200);
  ({ rows } = await ok(K, 'ada', `/api/org/members/${idOf('eve1')}`));
  assert.deepEqual(rows, [['membership.remove', 'ada', 'acme', 'eve1', { role: 'viewer' }]]);
  const r = await call('eve1', 'GET', '/api/packs');
  assert.deepEqual([r.status, r.json.denied], [403, 'org'], 'eve1: no org membership from her next request');
  // An owner removes a member of the org it names.
  const idp = idOf('https://idp.example.test#sub-1');
  ({ rows } = await ok(K, 'owen', `/api/org/members/${idp}`, undefined, 200, ACME));
  assert.deepEqual(rows, [['membership.remove', 'owen', 'acme', 'https://idp.example.test#sub-1', { role: 'viewer' }]]);

  for (const id of [idOf('bob'), 999999]) await refused(K, 'ada', `/api/org/members/${id}`, undefined, 404, `user ${id} is not a member of acme`);
  for (const id of BAD_IDS) await refused(K, 'ada', `/api/org/members/${id}`, undefined, 400, 'user id must be a positive integer, at most 9007199254740991');
});

test('the last admin: acme\'s only admin is neither demoted nor removed by an admin — through PATCH, DELETE or the upsert; an owner may, and so may the shell', async () => {
  const [ada, oscar, dan] = ['ada', 'oscar', 'dan'].map(idOf);
  const last = (login) => `${login} is the last admin of acme: only an owner can demote or remove them — `
    + 'make another member an admin first (PATCH /api/org/members/<id> with {"role": "admin"})';
  const PATCH = 'PATCH /api/org/members/:userId';
  const DELETE = 'DELETE /api/org/members/:userId';
  const POST = 'POST /api/org/members';
  for (const role of ['viewer', 'operator']) await refused(PATCH, 'ada', `/api/org/members/${ada}`, { role }, 409, last('ada'));
  await refused(DELETE, 'ada', `/api/org/members/${ada}`, undefined, 409, last('ada'));
  await refused(POST, 'ada', '/api/org/members', { login: 'ada', role: 'viewer' }, 409, last('ada'));
  await refused(POST, 'ada', '/api/org/members', { login: 'ada' }, 409, last('ada'));   // no role: operator, a demotion too
  let { json, rows } = await ok(POST, 'ada', '/api/org/members', { login: 'ada', role: 'admin' });
  assert.deepEqual([json.added, json.changed, rows], [false, null, []], 'her own role again is no demotion');

  // A disabled admin does not count: dan, made an admin by an owner, leaves ada the last.
  await ok(PATCH, 'olive', `/api/org/members/${dan}`, { role: 'admin' }, 200, ACME);
  await refused(DELETE, 'ada', `/api/org/members/${ada}`, undefined, 409, last('ada'));
  await ok(PATCH, 'olive', `/api/org/members/${dan}`, { role: 'viewer' }, 200, ACME);

  // An owner may, on all three paths, each time with ada acme's only
  // enabled admin: olive demotes her through the upsert, then back through
  // PATCH; demotes her through PATCH, then back; removes her through
  // DELETE, then adds her back through the upsert.
  ({ json, rows } = await ok(POST, 'olive', '/api/org/members', { login: 'ada', role: 'viewer' }, 200, ACME));
  assert.deepEqual([json.added, json.changed], [false, { from: 'admin', to: 'viewer' }]);
  assert.deepEqual(rows, [['membership.role', 'olive', 'acme', 'ada', { from: 'admin', to: 'viewer' }]]);
  ({ rows } = await ok(PATCH, 'olive', `/api/org/members/${ada}`, { role: 'admin' }, 200, ACME));
  assert.deepEqual(rows, [['membership.role', 'olive', 'acme', 'ada', { from: 'viewer', to: 'admin' }]]);
  ({ json, rows } = await ok(PATCH, 'olive', `/api/org/members/${ada}`, { role: 'viewer' }, 200, ACME));
  assert.deepEqual([json.member.role, json.changed], ['viewer', { from: 'admin', to: 'viewer' }]);
  assert.deepEqual(rows, [['membership.role', 'olive', 'acme', 'ada', { from: 'admin', to: 'viewer' }]]);
  await ok(PATCH, 'olive', `/api/org/members/${ada}`, { role: 'admin' }, 200, ACME);
  ({ json, rows } = await ok(DELETE, 'olive', `/api/org/members/${ada}`, undefined, 200, ACME));
  assert.deepEqual([json.removed.login, json.removed.role], ['ada', 'admin']);
  assert.deepEqual(rows, [['membership.remove', 'olive', 'acme', 'ada', { role: 'admin' }]]);
  assert.equal(getMembership(db, 'acme', ada), null);
  ({ json, rows } = await ok(POST, 'olive', '/api/org/members', { login: 'ada', role: 'admin' }, 201, ACME));
  assert.deepEqual([json.added, json.member.role], [true, 'admin']);
  assert.deepEqual(rows, [['membership.add', 'olive', 'acme', 'ada', { role: 'admin' }]]);

  // With another enabled admin, ada may step down; oscar is then the last.
  await ok(PATCH, 'ada', `/api/org/members/${oscar}`, { role: 'admin' });
  ({ rows } = await ok(PATCH, 'ada', `/api/org/members/${ada}`, { role: 'operator' }));
  assert.deepEqual(rows, [['membership.role', 'ada', 'acme', 'ada', { from: 'admin', to: 'operator' }]]);
  await refused(PATCH, 'oscar', `/api/org/members/${oscar}`, { role: 'operator' }, 409, last('oscar'));
  await refused(DELETE, 'oscar', `/api/org/members/${oscar}`, undefined, 409, last('oscar'));
  await ok(PATCH, 'oscar', `/api/org/members/${ada}`, { role: 'admin' });
  await ok(PATCH, 'oscar', `/api/org/members/${oscar}`, { role: 'operator' });
  assert.deepEqual([getMembership(db, 'acme', ada).role, getMembership(db, 'acme', oscar).role], ['admin', 'operator']);

  // The shell is owner-equivalent: npm run orgs -- add-member and
  // remove-member of the last admin succeed (actor cli), as before.
  const seq = seqNow();
  for (const args of [['add-member', 'acme', 'ada', '--role', 'viewer'], ['add-member', 'acme', 'ada', '--role', 'admin'],
    ['remove-member', 'acme', 'ada'], ['add-member', 'acme', 'ada', '--role', 'admin']]) {
    const c = cli(ORG_ADMIN, args, WORKSPACE);
    assert.equal(c.status, 0, `npm run orgs -- ${args.join(' ')}: ${c.stderr}`);
  }
  assert.deepEqual(rowsAfter(seq), [
    ['membership.role', 'cli', 'acme', 'ada', { from: 'admin', to: 'viewer' }],
    ['membership.role', 'cli', 'acme', 'ada', { from: 'viewer', to: 'admin' }],
    ['membership.remove', 'cli', 'acme', 'ada', { role: 'admin' }],
    ['membership.add', 'cli', 'acme', 'ada', { role: 'admin' }],
  ]);
  assert.equal(getMembership(db, 'acme', ada).role, 'admin');
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

test('the admin routes answer the org\'s admins and the owners: an operator, a viewer and the bearer are refused, and nothing is written', async () => {
  const seq = seqNow();
  const bearer = { Authorization: `Bearer ${process.env.OBSERVOGRAM_API_TOKEN}`, ...ACME };
  for (const [who, extra, role] of [['oscar', ACME, 'operator'], ['vera', ACME, 'viewer'], [null, bearer, 'operator']]) {
    for (const [method, path, body] of [['PATCH', '/api/org', { name: 'Taken' }], ['GET', '/api/org/members'],
      ['POST', '/api/org/members', { login: 'eve2', role: 'admin' }], ['PATCH', `/api/org/members/${idOf(who ?? 'oscar')}`, { role: 'admin' }],
      ['DELETE', `/api/org/members/${idOf('ada')}`]]) {
      const r = await call(who, method, path, body, extra);
      assert.deepEqual([r.status, r.json.denied, r.json.need, r.json.role], [403, 'role', 'admin', role], `${who ?? 'the bearer'} ${method} ${path}`);
    }
  }
  assert.deepEqual(rowsAfter(seq), []);
  assert.equal(getMembership(db, 'acme', idOf('eve2')), null);
});
