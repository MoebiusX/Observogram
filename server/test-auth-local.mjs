#!/usr/bin/env node
/**
 * server/test-auth-local.mjs — Stage 1 identity, STAND-ALONE posture
 * (docs/PRODUCTIZATION_PLAN.md): users scrypt-hashed in a plain file,
 * password login page, HMAC cookie sessions, CSRF gate, bearer-token
 * coexistence. Local no-auth mode regression is covered by every other
 * suite (none of them configure identity).
 */

import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Environment BEFORE the server module loads — initAuth reads it at import.
const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-auth-local-'));
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;
process.env.OBSERVOGRAM_API_TOKEN = 'ci-token-abcdef-0123456789';
process.env.OBSERVOGRAM_API_TOKEN_LABEL = 'ci-bot';
delete process.env.OBSERVOGRAM_OIDC_ISSUER;
delete process.env.OBSERVOGRAM_SESSION_SECRET;
delete process.env.OBSERVOGRAM_AUTH;
delete process.env.TOMOGRAPH_AUTH;
delete process.env.OBSERVOGRAM_ADMIN_PASSWORD;
// Hermetic store (docs/STORE_PLAN.md slice 2): each block's database lives
// in its own workspace; a shell's OBSERVOGRAM_DB or seed knobs never leak in.
for (const k of ['DB', 'BOOTSTRAP_ADMIN', 'OIDC_JOIN_ROLE', 'ADMIN_PASSWORD', 'INSECURE_NO_AUTH']) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
process.env.OBSERVOGRAM_USERS_FILE = join(WORKSPACE, 'users.json');

import { createHarness } from '../tools/lib/harness.mjs';
const { assert, failures, report } = createHarness({ indent: '  ', truncate: 200 });

const { hashPassword, verifyPassword, localUsersEnabled } = await import('./auth.mjs');
const { writeUsersFile } = await import('./store/legacy-files.mjs');
const { currentStore, prepare } = await import('./store/db.mjs');
const { createUser, setDisabled, bumpSessionEpoch, getUserByLogin, listUsers } = await import('./store/users.mjs');
const { getMeta } = await import('./store/meta.mjs');
const { listMembershipsForUser } = await import('./store/memberships.mjs');
const { listAudit } = await import('./store/audit.mjs');
const { orgChipModel } = await import('../studio/api.mjs');

// A pre-store users.json — the first start imports it (and arms
// stand-alone sign-in). 'John Smith' is a name the pre-store login
// accepts (it trims only the ends): imported as written (A-54).
writeUsersFile({ users: {
  carlos: { name: 'Carlos', email: 'carlos@example.test', createdAt: 'test', password: hashPassword('correct-horse-9') },
  'John Smith': { createdAt: 'test', password: hashPassword('smith-pass-123') },
} }, process.env.OBSERVOGRAM_USERS_FILE);
assert(verifyPassword('correct-horse-9', JSON.parse(readFileSync(process.env.OBSERVOGRAM_USERS_FILE, 'utf8')).users.carlos.password), 'scrypt round-trips');
assert(!verifyPassword('wrong', JSON.parse(readFileSync(process.env.OBSERVOGRAM_USERS_FILE, 'utf8')).users.carlos.password), 'scrypt rejects wrong password');

const { start } = await import('./index.mjs');
const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
const base = `http://127.0.0.1:${srv.address().port}`;

{
  const db = currentStore();
  assert(localUsersEnabled() === true, 'the imported users file arms stand-alone sign-in (identity_armed)');
  assert(getMeta(db, 'identity_armed') === '1', 'identity_armed is set by the import', getMeta(db, 'identity_armed'), '1');
  const carlos = getUserByLogin(db, 'carlos');
  assert(carlos?.kind === 'local' && carlos.sessionEpoch === 0 && carlos.isOwner === true,
    'carlos is imported: local, epoch 0, owner', carlos && { kind: carlos.kind, ep: carlos.sessionEpoch, owner: carlos.isOwner });
  const ms = carlos ? listMembershipsForUser(db, carlos.id) : [];
  assert(JSON.stringify(ms.map(m => [m.orgId, m.role])) === JSON.stringify([['default', 'admin']]),
    'carlos is admin of default', ms);
  assert(!!getMeta(db, 'import_done'), 'import_done is set');
  const marker = JSON.parse(readFileSync(join(WORKSPACE, '.store-imported'), 'utf8'));
  assert(marker.storeId === getMeta(db, 'store_id'), '.store-imported names the store_id', marker.storeId, getMeta(db, 'store_id'));
  assert(getUserByLogin(db, 'John Smith')?.kind === 'local', "'John Smith' is imported as written");
}

const getCookie = (res, name) => {
  for (const c of res.headers.getSetCookie?.() || []) {
    if (c.startsWith(`${name}=`)) return c.split(';')[0];
  }
  return null;
};

try {
  // ---- unauthenticated posture ----
  let r = await fetch(`${base}/auth/me`);
  let j = await r.json();
  assert(j.mode === 'local-users' && j.authenticated === false && j.login === '/auth/login',
    '/auth/me reports stand-alone mode + login pointer', JSON.stringify(j));

  r = await fetch(`${base}/api/packs`);
  j = await r.json();
  assert(r.status === 401 && j.login === '/auth/login', 'API reads require sign-in in identity mode', r.status, 401);

  r = await fetch(`${base}/healthz`);
  assert(r.ok, '/healthz stays open (probes)');

  r = await fetch(`${base}/api/version`);
  j = await r.json();
  assert(r.status === 200 && j.ok === true && typeof j.label === 'string' && 'build' in j,
    '/api/version stays open in identity mode (the footer fills before sign-in)', r.status, 200);
  assert(r.headers.get('cache-control') === 'no-store', '/api/version is no-store in identity mode too', r.headers.get('cache-control'), 'no-store');

  r = await fetch(`${base}/`);
  assert(r.ok, 'studio shell stays open (client redirects to login)');

  r = await fetch(`${base}/auth/login`);
  const page = await r.text();
  assert(r.ok && page.includes('name="password"'), 'login page serves the password form');

  // ---- login ----
  r = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=carlos&password=nope',
    redirect: 'manual',
  });
  assert(r.status === 401, 'wrong password rejected', r.status, 401);

  r = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=carlos&password=correct-horse-9',
    redirect: 'manual',
  });
  assert(r.status === 302, 'correct password redirects home', r.status, 302);
  const setCookie = (r.headers.getSetCookie?.() || []).find(c => c.startsWith('observogram_session='));
  assert(!!setCookie, 'session cookie issued');
  assert(/HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie) && /Path=\//.test(setCookie),
    'session cookie carries HttpOnly + SameSite=Lax + Path=/', setCookie);
  let session = getCookie(r, 'observogram_session');

  // ---- authenticated requests ----
  r = await fetch(`${base}/api/packs`, { headers: { Cookie: session } });
  assert(r.ok, 'API reads work with a session', r.status, 200);

  // Rebrand shim: a session issued pre-rebrand rides the old cookie name —
  // same signed value under tomo_session= must still authenticate.
  r = await fetch(`${base}/api/packs`, {
    headers: { Cookie: session.replace(/^observogram_session=/, 'tomo_session=') },
  });
  assert(r.ok, 'legacy tomo_session cookie is still accepted', r.status, 200);

  r = await fetch(`${base}/auth/me`, { headers: { Cookie: session } });
  j = await r.json();
  assert(j.authenticated === true && j.sub === 'carlos' && j.email === 'carlos@example.test',
    '/auth/me reflects the signed-in user', JSON.stringify(j));
  assert(JSON.stringify(j.orgs) === JSON.stringify([{ id: 'default', name: 'Default', role: 'admin', default: true }]),
    '/auth/me lists the default org membership', JSON.stringify(j.orgs));
  assert(j.user?.owner === true && j.user?.login === 'carlos' && j.user?.kind === 'local', '/auth/me names the store row (owner)', JSON.stringify(j.user));
  assert(orgChipModel(j.orgs).kind === 'none', 'an upgraded flat stand-alone deployment shows no ORG chip', orgChipModel(j.orgs).kind, 'none');

  // A users.json name with an inner space signs in after the upgrade.
  r = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=John+Smith&password=smith-pass-123', redirect: 'manual',
  });
  assert(r.status === 302 && !!getCookie(r, 'observogram_session'), "'John Smith' signs in with his password after the upgrade", r.status, 302);

  // ---- CSRF gate on session-authenticated mutations ----
  r = await fetch(`${base}/api/validate`, {
    method: 'POST', headers: { Cookie: session, 'Content-Type': 'text/yaml' }, body: 'x: 1',
  });
  assert(r.status === 403, 'session mutation WITHOUT the CSRF header → 403', r.status, 403);

  r = await fetch(`${base}/api/validate`, {
    method: 'POST',
    headers: { Cookie: session, 'Content-Type': 'text/yaml', 'X-Observogram-CSRF': '1' },
    body: 'x: 1',
  });
  assert(r.status !== 401 && r.status !== 403, 'session mutation WITH the CSRF header passes auth', r.status, 'not 401/403');

  // Rebrand shim: the pre-rebrand CSRF header spelling still passes.
  r = await fetch(`${base}/api/validate`, {
    method: 'POST',
    headers: { Cookie: session, 'Content-Type': 'text/yaml', 'X-Tomograph-CSRF': '1' },
    body: 'x: 1',
  });
  assert(r.status !== 401 && r.status !== 403, 'legacy X-Tomograph-CSRF header still passes auth', r.status, 'not 401/403');

  // ---- bearer token = service-account path, no CSRF needed ----
  r = await fetch(`${base}/api/validate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OBSERVOGRAM_API_TOKEN}`, 'Content-Type': 'text/yaml' },
    body: 'x: 1',
  });
  assert(r.status !== 401 && r.status !== 403, 'bearer token still works alongside identity', r.status, 'not 401/403');

  // ---- the BUILD journey routes carry the same posture as /api/validate ----
  r = await fetch(`${base}/api/library`);
  j = await r.json();
  assert(r.status === 401 && j.login === '/auth/login', 'GET /api/library requires sign-in in identity mode', r.status, 401);
  r = await fetch(`${base}/api/library/requirements/tier-2`);
  assert(r.status === 401, 'GET /api/library/requirements/:tier requires sign-in in identity mode', r.status, 401);
  r = await fetch(`${base}/api/library/instantiate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: ['kafka'], name: 'orders', tier: 'tier-3' }),
  });
  assert(r.status === 401, 'POST /api/library/instantiate without a session → 401', r.status, 401);
  r = await fetch(`${base}/api/library/instantiate`, {
    method: 'POST', headers: { Cookie: session, 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: ['kafka'], name: 'orders', tier: 'tier-3' }),
  });
  assert(r.status === 403, 'session POST /api/library/instantiate WITHOUT the CSRF header → 403', r.status, 403);
  r = await fetch(`${base}/api/library/instantiate`, {
    method: 'POST', headers: { Cookie: session, 'Content-Type': 'application/json', 'X-Observogram-CSRF': '1' }, body: JSON.stringify({ entries: ['kafka'], name: 'orders', tier: 'tier-3' }),
  });
  j = await r.json();
  assert(r.status === 200 && j.ok === true && j.canonical?.metadata?.name === 'orders', 'session POST /api/library/instantiate WITH the CSRF header answers', r.status, 200);
  r = await fetch(`${base}/api/library`, { headers: { Cookie: session } });
  j = await r.json();
  assert(r.ok && j.entries?.length === 10, 'GET /api/library answers with a session', r.status, 200);

  // ---- signed-in self-service password change (account menu) ----
  r = await fetch(`${base}/auth/change-password`, { headers: { Cookie: session } });
  const changePage = await r.text();
  assert(r.ok && changePage.includes('name="current"') && !changePage.includes('/auth/change-password/skip'),
    'signed-in change page asks for the current password, offers no skip');

  r = await fetch(`${base}/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Cookie: session },
    body: 'current=wrong-guess&password=rotated-horse-10&repeat=rotated-horse-10',
  });
  assert(r.status === 401, 'wrong current password rejected', r.status, 401);

  r = await fetch(`${base}/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Cookie: session },
    body: 'current=correct-horse-9&password=short&repeat=short',
  });
  assert(r.status === 400, 'short replacement rejected on the session path', r.status, 400);

  r = await fetch(`${base}/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Cookie: session },
    body: 'current=correct-horse-9&password=rotated-horse-10&repeat=rotated-horse-10',
  });
  j = await r.json();
  assert(r.ok && j.ok === true, 'session-authenticated change succeeds with the current password', JSON.stringify(j));
  // The change bumps the epoch: this session is re-issued, every other one ends.
  const oldSession = session;
  session = getCookie(r, 'observogram_session');
  assert(!!session && session !== oldSession, 'the change re-issues the session');
  {
    const rows = listAudit(currentStore(), { action: 'user.password', targetId: 'carlos' });
    assert(rows.length === 1 && rows[0].actor === 'carlos', 'the self-service change writes one user.password row with actor carlos', rows.map(x => x.actor));
  }
  r = await fetch(`${base}/api/packs`, { headers: { Cookie: oldSession } });
  assert(r.status === 401, 'the pre-change session is revoked: /api/packs 401', r.status, 401);
  r = await fetch(`${base}/auth/me`, { headers: { Cookie: oldSession } });
  assert((await r.json()).authenticated === false, 'the pre-change session is revoked: /auth/me unauthenticated');
  r = await fetch(`${base}/auth/change-password`, { headers: { Cookie: oldSession }, redirect: 'manual' });
  assert(r.status === 302 && (r.headers.get('location') || '').includes('/auth/login'),
    'the pre-change session is revoked: GET change page bounces to login', r.status, 302);
  r = await fetch(`${base}/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Cookie: oldSession },
    body: 'current=rotated-horse-10&password=never-lands-99&repeat=never-lands-99',
  });
  j = await r.json();
  assert(r.status === 401 && j.error === 'password-change flow expired — sign in again',
    'the pre-change session is revoked: POST change-password 401', [r.status, j.error], 401);

  r = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=carlos&password=correct-horse-9', redirect: 'manual',
  });
  assert(r.status === 401, 'the old password is dead after the self-service change', r.status, 401);

  r = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=carlos&password=rotated-horse-10', redirect: 'manual',
  });
  assert(r.status === 302 && !!getCookie(r, 'observogram_session'), 'the new password signs in', r.status, 302);

  // ---- HTML mode of the session path (the browser form) ----
  r = await fetch(`${base}/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: session },
    body: 'current=wrong-guess&password=rotated-horse-11&repeat=rotated-horse-11',
  });
  const errPage = await r.text();
  assert(r.status === 401 && errPage.includes('name="current"') && !errPage.includes('/auth/change-password/skip'),
    'HTML wrong-current re-renders the self-service form (no skip control)', r.status, 401);

  r = await fetch(`${base}/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: session },
    body: 'current=rotated-horse-10&password=rotated-horse-11&repeat=rotated-horse-11',
    redirect: 'manual',
  });
  assert(r.status === 302 && r.headers.get('location') === '/' && !!getCookie(r, 'observogram_session'),
    'HTML self-service change redirects home with a session', `${r.status} ${r.headers.get('location')}`);
  session = getCookie(r, 'observogram_session');
  assert(listAudit(currentStore(), { action: 'user.password', targetId: 'carlos' }).length === 2, 'each change writes one user.password row');

  // ---- a disabled user: the session ends, sign-in refused ----
  const ghost = createUser(currentStore(), 'test', { login: 'ghost', name: 'Ghost', password: hashPassword('ghost-pass-123') });
  r = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=ghost&password=ghost-pass-123', redirect: 'manual',
  });
  const ghostSession = getCookie(r, 'observogram_session');
  assert(!!ghostSession, 'ghost signs in before being disabled');
  setDisabled(currentStore(), 'test', ghost.id, true);
  r = await fetch(`${base}/auth/change-password`, { headers: { Cookie: ghostSession }, redirect: 'manual' });
  assert(r.status === 302 && (r.headers.get('location') || '').includes('/auth/login'),
    'disabled user with a live session: GET change page bounces to login', r.status, 302);
  r = await fetch(`${base}/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Cookie: ghostSession },
    body: 'current=ghost-pass-123&password=whatever-long-1&repeat=whatever-long-1',
  });
  assert(r.status === 401, 'disabled user with a live session: POST answers 401', r.status, 401);
  r = await fetch(`${base}/api/packs`, { headers: { Cookie: ghostSession } });
  assert(r.status === 401, 'disabled user with a live session: /api/packs 401', r.status, 401);
  r = await fetch(`${base}/auth/me`, { headers: { Cookie: ghostSession } });
  assert((await r.json()).authenticated === false, 'disabled user with a live session: /auth/me unauthenticated');
  r = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=ghost&password=ghost-pass-123', redirect: 'manual',
  });
  assert(r.status === 401, 'a disabled user cannot sign in with the right password', r.status, 401);

  // A disabled user's pre-disable pwflow cookie is refused too.
  const pending = createUser(currentStore(), 'test', { login: 'pending', password: hashPassword('pending-pass-1'), mustChange: true });
  r = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'username=pending&password=pending-pass-1',
  });
  const pendingFlow = getCookie(r, 'observogram_pwflow');
  assert(!!pendingFlow, 'a forced change starts for pending');
  setDisabled(currentStore(), 'test', pending.id, true);
  r = await fetch(`${base}/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Cookie: pendingFlow },
    body: 'password=pending-new-123&repeat=pending-new-123',
  });
  assert(r.status === 401, "a disabled user's pre-disable pwflow is refused", r.status, 401);

  // Each resolver check stands on its own (§7.3/§7.5): setDisabled and
  // setPassword bump the epoch, so these raw row edits leave the epoch
  // where the cookie has it and only the one check under test can refuse.
  const quiet = createUser(currentStore(), 'test', { login: 'quiet', password: hashPassword('quiet-pass-123') });
  r = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=quiet&password=quiet-pass-123', redirect: 'manual',
  });
  const quietSession = getCookie(r, 'observogram_session');
  prepare(currentStore(), 'UPDATE users SET disabled = 1 WHERE id = ?').run(quiet.id);
  r = await fetch(`${base}/auth/me`, { headers: { Cookie: quietSession } });
  assert(!!quietSession && (await r.json()).authenticated === false,
    'a disabled row ends its session even at the same epoch');

  const flowAt = async (login, password) => getCookie(await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: `username=${login}&password=${password}`,
  }), 'observogram_pwflow');
  const changeWith = (flow, pw) => fetch(`${base}/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Cookie: flow },
    body: `password=${pw}&repeat=${pw}`,
  });
  const bumped = createUser(currentStore(), 'test', { login: 'bumped', password: hashPassword('bumped-pass-1'), mustChange: true });
  const bumpedFlow = await flowAt('bumped', 'bumped-pass-1');
  bumpSessionEpoch(currentStore(), 'test', bumped.id);
  r = await changeWith(bumpedFlow, 'bumped-new-123');
  assert(!!bumpedFlow && r.status === 401 && getUserByLogin(currentStore(), 'bumped').mustChange === true,
    'a pwflow from an older epoch is refused while the change is still due', r.status, 401);
  const settled = createUser(currentStore(), 'test', { login: 'settled', password: hashPassword('settled-pass-1'), mustChange: true });
  const settledFlow = await flowAt('settled', 'settled-pass-1');
  prepare(currentStore(), 'UPDATE users SET must_change = 0 WHERE id = ?').run(settled.id);
  r = await changeWith(settledFlow, 'settled-new-123');
  assert(!!settledFlow && r.status === 401, 'a pwflow for a user no longer due a change is refused at the same epoch', r.status, 401);

  // ---- a normal login clears a leftover pwchange flow cookie ----
  // An abandoned forced change (say admin/admin typed on a shared
  // browser, then closed) must never shadow the account menu's
  // change-password entry point — the change routes check the flow
  // cookie first, so login must clear the stale one.
  createUser(currentStore(), 'test', { login: 'stale', name: 'Stale', password: hashPassword('stale-pass-123'), mustChange: true });
  r = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=stale&password=stale-pass-123', redirect: 'manual',
  });
  assert(!!getCookie(r, 'observogram_pwflow'), 'abandoned forced change leaves a flow cookie behind');
  r = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=carlos&password=rotated-horse-11', redirect: 'manual',
  });
  const clearsFlow = (r.headers.getSetCookie?.() || []).find(c => c.startsWith('observogram_pwflow=;'));
  assert(r.status === 302 && !!clearsFlow && /Max-Age=0/.test(clearsFlow),
    'a normal login clears the stale flow cookie so it cannot shadow the session');

  // ---- the login damper covers current-password guesses too ----
  // (LAST carlos exercise in this block: the lockout outlives it.)
  for (let i = 0; i < 5; i++) {
    await fetch(`${base}/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Cookie: session },
      body: `current=guess-${i}&password=long-enough-pw-1&repeat=long-enough-pw-1`,
    });
  }
  r = await fetch(`${base}/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Cookie: session },
    body: 'current=rotated-horse-11&password=long-enough-pw-1&repeat=long-enough-pw-1',
  });
  assert(r.status === 429, '5 wrong current-password guesses lock the change route', r.status, 429);
  r = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=carlos&password=rotated-horse-11', redirect: 'manual',
  });
  assert(r.status === 429, 'the lockout is shared with /auth/login (one damper)', r.status, 429);

  // ---- tamper + expiry ----
  const tampered = session.slice(0, -4) + 'AAAA';
  r = await fetch(`${base}/api/packs`, { headers: { Cookie: tampered } });
  assert(r.status === 401, 'tampered session cookie rejected', r.status, 401);

  // ---- lockout ----
  for (let i = 0; i < 5; i++) {
    await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=evil&password=guess', redirect: 'manual',
    });
  }
  r = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=evil&password=guess', redirect: 'manual',
  });
  assert(r.status === 429, '5 failures lock the user+address for 30s', r.status, 429);

  // ---- logout ----
  r = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Cookie: session } });
  assert(r.status === 204, 'logout clears the session', r.status, 204);
  const clearedSet = r.headers.getSetCookie?.() || [];
  const cleared = clearedSet.find(c => c.startsWith('observogram_session=;'));
  assert(!!cleared && /Max-Age=0/.test(cleared), 'logout Set-Cookie expires the session');
  assert(clearedSet.some(c => c.startsWith('tomo_session=;')), 'logout clears the legacy cookie name too');
} finally {
  await new Promise(res => srv.close(res));
  rmSync(WORKSPACE, { recursive: true, force: true });
}

// ---- Grafana-style first boot: nothing configured → seeded admin ----
// (docs/PRODUCTIZATION_PLAN.md Stage 1 addendum: default admin/admin,
// change forced at first sign-in, never valid beyond loopback.)
const BOOT_WS = mkdtempSync(join(tmpdir(), 'observogram-auth-boot-'));
process.env.OBSERVOGRAM_WORKSPACE = BOOT_WS;
process.env.OBSERVOGRAM_USERS_FILE = join(BOOT_WS, 'users.json');
delete process.env.OBSERVOGRAM_API_TOKEN;         // a configured token suppresses the seed
delete process.env.OBSERVOGRAM_API_TOKEN_LABEL;

const srv2 = await start({ port: 0, host: '127.0.0.1', silent: true });
const base2 = `http://127.0.0.1:${srv2.address().port}`;
try {
  const seeded = getUserByLogin(currentStore(), 'admin');
  assert(!!seeded && seeded.mustChange === true && seeded.seededDefault === true && seeded.isOwner === true && seeded.sessionEpoch === 1,
    'first boot seeds admin with a forced-change default (owner, epoch 1)', seeded && { mustChange: seeded.mustChange, seededDefault: seeded.seededDefault, owner: seeded.isOwner, ep: seeded.sessionEpoch });
  assert(JSON.stringify(listMembershipsForUser(currentStore(), seeded.id).map(m => [m.orgId, m.role])) === JSON.stringify([['default', 'admin']]),
    'the seeded admin is admin of default');
  assert(!existsSync(join(BOOT_WS, 'users.json')), 'the seed writes no users.json');

  let r = await fetch(`${base2}/api/packs`);
  assert(r.status === 401, 'the seeded posture protects the API like any identity mode', r.status, 401);

  r = await fetch(`${base2}/api/version`);
  assert(r.status === 200 && (await r.json()).ok === true, 'auth on, no token, no session: /api/version still answers 200', r.status, 200);

  // The default credential is loopback-only, without exception.
  let guardErr = null;
  await start({ port: 0, host: '0.0.0.0', silent: true }).then(s => s.close(), e => { guardErr = e; });
  assert(!!guardErr && /default admin password/.test(guardErr.message),
    'network bind refused while admin/admin is unchanged', guardErr && guardErr.message);

  // admin/admin → no session yet; a pwchange flow cookie instead.
  r = await fetch(`${base2}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'username=admin&password=admin',
  });
  let j = await r.json();
  assert(r.ok && j.mustChange === true && j.next === '/auth/change-password',
    'default login demands a password change instead of a session', JSON.stringify(j));
  assert(!getCookie(r, 'observogram_session'), 'no session cookie before the change');
  const pwflow = getCookie(r, 'observogram_pwflow');
  assert(!!pwflow, 'pwchange flow cookie issued');

  // ---- "skip for now": session without the change, seeded default only ----
  r = await fetch(`${base2}/auth/change-password`, { headers: { Cookie: pwflow } });
  let pageHtml = await r.text();
  assert(r.ok && pageHtml.includes('/auth/change-password/skip') && !pageHtml.includes('name="current"'),
    'change page offers "skip for now" while the seeded default is active — and never a current-password field');

  r = await fetch(`${base2}/auth/change-password/skip`, {
    method: 'POST', headers: { Accept: 'application/json' },
  });
  assert(r.status === 401, 'skip without the flow cookie rejected', r.status, 401);

  r = await fetch(`${base2}/auth/change-password/skip`, {
    method: 'POST', headers: { Accept: 'application/json', Cookie: pwflow },
  });
  j = await r.json();
  const skipSession = getCookie(r, 'observogram_session');
  assert(r.ok && j.ok === true && j.skipped === true && !!skipSession,
    'skip issues a session without changing the password', JSON.stringify(j));

  r = await fetch(`${base2}/api/packs`, { headers: { Cookie: skipSession } });
  assert(r.ok, 'API works with the skipped session', r.status, 200);
  {
    const me = await (await fetch(`${base2}/auth/me`, { headers: { Cookie: skipSession } })).json();
    assert(orgChipModel(me.orgs).kind === 'none', 'the fresh admin/admin boot shows no ORG chip', JSON.stringify(me.orgs));
  }

  // The browser path: the form's skip button POSTs without Accept:
  // application/json — success is a 302 home carrying the session.
  r = await fetch(`${base2}/auth/change-password/skip`, {
    method: 'POST', headers: { Cookie: pwflow }, redirect: 'manual',
  });
  assert(r.status === 302 && r.headers.get('location') === '/' && !!getCookie(r, 'observogram_session'),
    'HTML skip redirects home with a session', `${r.status} ${r.headers.get('location')}`);

  const afterSkip = getUserByLogin(currentStore(), 'admin');
  assert(afterSkip.mustChange === true && afterSkip.seededDefault === true && afterSkip.sessionEpoch === 1,
    'skip leaves the forced-change flags in place', JSON.stringify(afterSkip));

  let skipGuardErr = null;
  await start({ port: 0, host: '0.0.0.0', silent: true }).then(s => s.close(), e => { skipGuardErr = e; });
  assert(!!skipGuardErr && /default admin password/.test(skipGuardErr.message),
    'network bind still refused after a skip', skipGuardErr && skipGuardErr.message);

  r = await fetch(`${base2}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'username=admin&password=admin',
  });
  j = await r.json();
  assert(r.ok && j.mustChange === true, 'next sign-in asks for the change again after a skip', JSON.stringify(j));

  // Admin-set temporary password (mustChange WITHOUT seededDefault):
  // the change stays forced — no skip control, skip POST refused.
  createUser(currentStore(), 'test', { login: 'temp', name: 'Temp', password: hashPassword('temp-pass-123'), mustChange: true });
  r = await fetch(`${base2}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'username=temp&password=temp-pass-123',
  });
  j = await r.json();
  const tempFlow = getCookie(r, 'observogram_pwflow');
  assert(r.ok && j.mustChange === true && !!tempFlow, 'temporary password demands a change too', JSON.stringify(j));

  r = await fetch(`${base2}/auth/change-password`, { headers: { Cookie: tempFlow } });
  pageHtml = await r.text();
  assert(r.ok && !pageHtml.includes('/auth/change-password/skip'),
    'no skip control for an admin-set temporary password');

  r = await fetch(`${base2}/auth/change-password/skip`, {
    method: 'POST', headers: { Accept: 'application/json', Cookie: tempFlow },
  });
  assert(r.status === 403, 'skip refused for an admin-set temporary password', r.status, 403);

  r = await fetch(`${base2}/auth/change-password/skip`, {
    method: 'POST', headers: { Cookie: tempFlow }, redirect: 'manual',
  });
  pageHtml = await r.text();
  assert(r.status === 403 && !pageHtml.includes('/auth/change-password/skip'),
    'HTML skip refusal re-renders the change form without the skip control', r.status, 403);

  r = await fetch(`${base2}/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Cookie: pwflow },
    body: 'password=short&repeat=short',
  });
  assert(r.status === 400, 'short new password rejected', r.status, 400);

  r = await fetch(`${base2}/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Cookie: pwflow },
    body: 'password=fresh-horse-battery-1&repeat=fresh-horse-battery-1',
  });
  j = await r.json();
  const session2 = getCookie(r, 'observogram_session');
  assert(r.ok && j.ok === true && !!session2, 'password change issues the real session', JSON.stringify(j));

  r = await fetch(`${base2}/api/packs`, { headers: { Cookie: session2 } });
  assert(r.ok, 'API works with the post-change session', r.status, 200);

  const after = getUserByLogin(currentStore(), 'admin');
  assert(!after.mustChange && !after.seededDefault, 'forced-change flags cleared after the change');
  assert(after.sessionEpoch === 2, 'the change bumped the epoch', after.sessionEpoch, 2);
  r = await fetch(`${base2}/auth/change-password/skip`, {
    method: 'POST', headers: { Accept: 'application/json', Cookie: pwflow },
  });
  assert(r.status === 401, 'a pwflow cookie from before the change is refused (skip 401)', r.status, 401);

  r = await fetch(`${base2}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'username=admin&password=admin',
  });
  assert(r.status === 401, 'admin/admin is dead after the change', r.status, 401);
} finally {
  await new Promise(res => srv2.close(res));
  rmSync(BOOT_WS, { recursive: true, force: true });
}

// ---- OBSERVOGRAM_ADMIN_PASSWORD: docker/k8s seed, no forced change ----
const ENV_WS = mkdtempSync(join(tmpdir(), 'observogram-auth-envpw-'));
process.env.OBSERVOGRAM_WORKSPACE = ENV_WS;
process.env.OBSERVOGRAM_USERS_FILE = join(ENV_WS, 'users.json');
process.env.OBSERVOGRAM_ADMIN_PASSWORD = 'from-the-env-9';
const srv3 = await start({ port: 0, host: '127.0.0.1', silent: true });
const base3 = `http://127.0.0.1:${srv3.address().port}`;
try {
  const r = await fetch(`${base3}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'username=admin&password=from-the-env-9',
  });
  const j = await r.json();
  assert(r.ok && j.ok === true && !j.mustChange && !!getCookie(r, 'observogram_session'),
    'OBSERVOGRAM_ADMIN_PASSWORD seeds a ready-to-use admin (no forced change)', JSON.stringify(j));
  const admin = getUserByLogin(currentStore(), 'admin');
  assert(admin?.isOwner === true && admin.mustChange === false, 'the env-seeded admin is an owner, not must_change');
} finally {
  delete process.env.OBSERVOGRAM_ADMIN_PASSWORD;
  await new Promise(res => srv3.close(res));
  rmSync(ENV_WS, { recursive: true, force: true });
}

// ---- exposure semantics: defaults never strand on a network boot ----
const NET_WS = mkdtempSync(join(tmpdir(), 'observogram-auth-net-'));
process.env.OBSERVOGRAM_WORKSPACE = NET_WS;
process.env.OBSERVOGRAM_USERS_FILE = join(NET_WS, 'users.json');
try {
  let netErr = null;
  await start({ port: 0, host: '0.0.0.0', silent: true }).then(s => s.close(), e => { netErr = e; });
  assert(!!netErr && /OBSERVOGRAM_ADMIN_PASSWORD/.test(netErr.message),
    'fresh network boot refuses and names the admin-password option', netErr && netErr.message);
  assert(!existsSync(join(NET_WS, 'users.json')), 'no users.json is written for a network boot');
  assert(!getUserByLogin(currentStore(), 'admin') && !getMeta(currentStore(), 'import_done'),
    'no default credential is written for a network boot (no admin row, nothing imported)');

  // Rescue: seed on loopback (default admin), then boot with
  // OBSERVOGRAM_ADMIN_PASSWORD — the still-default record is replaced.
  const seedSrv = await start({ port: 0, host: '127.0.0.1', silent: true });
  await new Promise(res => seedSrv.close(res));
  process.env.OBSERVOGRAM_ADMIN_PASSWORD = 'rescued-pass-7';
  const srv5 = await start({ port: 0, host: '127.0.0.1', silent: true });
  const base5 = `http://127.0.0.1:${srv5.address().port}`;
  try {
    const r = await fetch(`${base5}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: 'username=admin&password=rescued-pass-7',
    });
    const j = await r.json();
    assert(r.ok && j.ok === true && !j.mustChange,
      'OBSERVOGRAM_ADMIN_PASSWORD replaces a still-default admin (rescue path)', JSON.stringify(j));
  } finally {
    delete process.env.OBSERVOGRAM_ADMIN_PASSWORD;
    await new Promise(res => srv5.close(res));
  }
} finally {
  rmSync(NET_WS, { recursive: true, force: true });
}

// ---- OBSERVOGRAM_AUTH=off: the pre-0.5 open posture, no seeding ----
const OFF_WS = mkdtempSync(join(tmpdir(), 'observogram-auth-off-'));
process.env.OBSERVOGRAM_WORKSPACE = OFF_WS;
process.env.OBSERVOGRAM_USERS_FILE = join(OFF_WS, 'users.json');
process.env.OBSERVOGRAM_AUTH = 'off';
const srv4 = await start({ port: 0, host: '127.0.0.1', silent: true });
const base4 = `http://127.0.0.1:${srv4.address().port}`;
try {
  let r = await fetch(`${base4}/api/packs`);
  assert(r.ok, 'OBSERVOGRAM_AUTH=off keeps the API open with no login', r.status, 200);
  r = await fetch(`${base4}/auth/me`);
  assert(r.status === 404, '/auth/me answers 404 in the open posture (studio local-mode detection)', r.status, 404);
  assert(listUsers(currentStore()).length === 0 && getMeta(currentStore(), 'identity_armed') === null,
    'no admin is seeded in the open posture (no users, identity_armed unset)');
} finally {
  delete process.env.OBSERVOGRAM_AUTH;
  await new Promise(res => srv4.close(res));
  rmSync(OFF_WS, { recursive: true, force: true });
}

report('auth-local');
