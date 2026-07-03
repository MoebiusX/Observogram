#!/usr/bin/env node
/**
 * server/test-auth-local.mjs — Stage 1 identity, STAND-ALONE posture
 * (docs/PRODUCTIZATION_PLAN.md): users scrypt-hashed in a plain file,
 * password login page, HMAC cookie sessions, CSRF gate, bearer-token
 * coexistence. Local no-auth mode regression is covered by every other
 * suite (none of them configure identity).
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Environment BEFORE the server module loads — initAuth reads it at import.
const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-auth-local-'));
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;
process.env.OBSERVOGRAM_API_TOKEN = 'ci-token-abcdef-0123456789';
process.env.OBSERVOGRAM_API_TOKEN_LABEL = 'ci-bot';
delete process.env.OBSERVOGRAM_OIDC_ISSUER;
delete process.env.OBSERVOGRAM_SESSION_SECRET;
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

report('auth-local');
