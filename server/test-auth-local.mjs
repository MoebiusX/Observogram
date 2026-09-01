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
process.env.OBSERVOGRAM_USERS_FILE = join(WORKSPACE, 'users.json');

import { createHarness } from '../tools/lib/harness.mjs';
const { assert, failures, report } = createHarness({ indent: '  ', truncate: 200 });

const { hashPassword, writeUsers, verifyPassword, localUsersEnabled } = await import('./auth.mjs');

// Seed one user — the file existing is what arms stand-alone mode.
writeUsers({ users: { carlos: { name: 'Carlos', email: 'carlos@example.test', createdAt: 'test', password: hashPassword('correct-horse-9') } } });
assert(localUsersEnabled() === true, 'users file arms stand-alone mode');
assert(verifyPassword('correct-horse-9', JSON.parse(readFileSync(process.env.OBSERVOGRAM_USERS_FILE, 'utf8')).users.carlos.password), 'scrypt round-trips');
assert(!verifyPassword('wrong', JSON.parse(readFileSync(process.env.OBSERVOGRAM_USERS_FILE, 'utf8')).users.carlos.password), 'scrypt rejects wrong password');

const { start } = await import('./index.mjs');
const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
const base = `http://127.0.0.1:${srv.address().port}`;

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
  const session = getCookie(r, 'observogram_session');

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

  // ---- a session can outlive its users.json record ----
  const withGhost = JSON.parse(readFileSync(process.env.OBSERVOGRAM_USERS_FILE, 'utf8'));
  withGhost.users.ghost = { name: 'Ghost', createdAt: 'test', password: hashPassword('ghost-pass-123') };
  writeUsers(withGhost);
  r = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=ghost&password=ghost-pass-123', redirect: 'manual',
  });
  const ghostSession = getCookie(r, 'observogram_session');
  assert(!!ghostSession, 'ghost signs in before deletion');
  const withoutGhost = JSON.parse(readFileSync(process.env.OBSERVOGRAM_USERS_FILE, 'utf8'));
  delete withoutGhost.users.ghost;
  writeUsers(withoutGhost);
  r = await fetch(`${base}/auth/change-password`, { headers: { Cookie: ghostSession }, redirect: 'manual' });
  assert(r.status === 302 && (r.headers.get('location') || '').includes('/auth/login'),
    'deleted user with a live session: GET change page bounces to login', r.status, 302);
  r = await fetch(`${base}/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Cookie: ghostSession },
    body: 'current=ghost-pass-123&password=whatever-long-1&repeat=whatever-long-1',
  });
  assert(r.status === 401, 'deleted user with a live session: POST answers unknown user', r.status, 401);

  // ---- a normal login clears a leftover pwchange flow cookie ----
  // An abandoned forced change (say admin/admin typed on a shared
  // browser, then closed) must never shadow the account menu's
  // change-password entry point — the change routes check the flow
  // cookie first, so login must clear the stale one.
  const withStale = JSON.parse(readFileSync(process.env.OBSERVOGRAM_USERS_FILE, 'utf8'));
  withStale.users.stale = { name: 'Stale', createdAt: 'test', password: hashPassword('stale-pass-123'), mustChange: true };
  writeUsers(withStale);
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
  const seeded = JSON.parse(readFileSync(join(BOOT_WS, 'users.json'), 'utf8')).users.admin;
  assert(!!seeded && seeded.mustChange === true && seeded.seededDefault === true,
    'first boot seeds admin with a forced-change default', JSON.stringify(seeded));

  let r = await fetch(`${base2}/api/packs`);
  assert(r.status === 401, 'the seeded posture protects the API like any identity mode', r.status, 401);

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

  // The browser path: the form's skip button POSTs without Accept:
  // application/json — success is a 302 home carrying the session.
  r = await fetch(`${base2}/auth/change-password/skip`, {
    method: 'POST', headers: { Cookie: pwflow }, redirect: 'manual',
  });
  assert(r.status === 302 && r.headers.get('location') === '/' && !!getCookie(r, 'observogram_session'),
    'HTML skip redirects home with a session', `${r.status} ${r.headers.get('location')}`);

  const afterSkip = JSON.parse(readFileSync(join(BOOT_WS, 'users.json'), 'utf8')).users.admin;
  assert(afterSkip.mustChange === true && afterSkip.seededDefault === true,
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
  const bootData = JSON.parse(readFileSync(join(BOOT_WS, 'users.json'), 'utf8'));
  bootData.users.temp = { name: 'Temp', createdAt: 'test', password: hashPassword('temp-pass-123'), mustChange: true };
  writeUsers(bootData);
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

  const after = JSON.parse(readFileSync(join(BOOT_WS, 'users.json'), 'utf8')).users.admin;
  assert(!after.mustChange && !after.seededDefault, 'forced-change flags cleared after the change');

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
  assert(!existsSync(join(NET_WS, 'users.json')), 'no default credential is written for a network boot');

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
  assert(!existsSync(join(OFF_WS, 'users.json')), 'no admin is seeded in the open posture');
} finally {
  delete process.env.OBSERVOGRAM_AUTH;
  await new Promise(res => srv4.close(res));
  rmSync(OFF_WS, { recursive: true, force: true });
}

report('auth-local');
