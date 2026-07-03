// server/auth.mjs
//
// Stage 1 of docs/PRODUCTIZATION_PLAN.md — identity. This module is the
// ONLY place the openid-client dependency is allowed (the scoped
// exception ratified with the plan); sessions, cookies, password
// hashing and everything else are node: builtins.
//
// Postures (mutually exclusive, detected at boot):
//   - LOCAL (default): no issuer, no users file → this module is inert.
//     Zero behaviour change, zero friction — asserted by the regression
//     suite, not promised.
//   - LOCAL USERS (stand-alone): a users file exists
//     (OBSERVOGRAM_USERS_FILE, default <workspace>/users.json) → a
//     password login page at /auth/login, credentials scrypt-hashed in
//     the file, managed by `npm run users` (tools/user-admin.mjs). No
//     IdP, no network dependency — file-first like everything else.
//     The session secret auto-generates and persists into the
//     workspace, so stand-alone mode is zero-config beyond adding a
//     user.
//   - OIDC (OBSERVOGRAM_OIDC_ISSUER set — wins over a users file):
//     Authorization Code + PKCE against any conformant provider
//     (Entra ID, Google, Okta, Keycloak, dex).
//
// In BOTH authenticated postures the session is the same signed
// (HMAC-SHA256) HttpOnly SameSite=Lax cookie — no session store. ALL
// /api data requires a session (or the bearer token, which remains the
// service-account/CI path); the static studio shell stays open so the
// client can redirect to /auth/login.
//
// Env contract (every knob also honors the legacy TOMOGRAPH_* spelling —
// see tools/lib/brand-env.mjs):
//   OBSERVOGRAM_OIDC_ISSUER        e.g. https://login.example.com/realms/x
//   OBSERVOGRAM_OIDC_CLIENT_ID     registered client id (required w/ issuer)
//   OBSERVOGRAM_OIDC_CLIENT_SECRET optional — omit for a public PKCE client
//   OBSERVOGRAM_OIDC_REDIRECT_URL  optional — defaults to <host>/auth/callback
//   OBSERVOGRAM_USERS_FILE         optional — stand-alone users file path
//   OBSERVOGRAM_SESSION_SECRET     ≥ 32 chars; REQUIRED for OIDC (multi-
//                                  instance correctness); auto-persisted
//                                  under the workspace for local users
//   OBSERVOGRAM_SESSION_TTL_HOURS  optional, default 8
//   OBSERVOGRAM_OIDC_ALLOW_HTTP    '1' permits an http:// issuer (tests,
//                                  dex-in-docker) — never production

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as oidc from 'openid-client';
import { brandEnv, baseWorkspacePath } from '../tools/lib/brand-env.mjs';
import { tenancyEnabled, orgsForUser } from './tenancy.mjs';

const SESSION_COOKIE = 'observogram_session';
// Sessions signed before the rebrand stay valid (same HMAC secret): read
// the old cookie name too, clear both on logout. Drop with the env shim.
const LEGACY_SESSION_COOKIE = 'tomo_session';
const FLOW_COOKIE = 'observogram_flow';
const FLOW_TTL_S = 600;

function workspaceRoot() { return baseWorkspacePath(); }

export function usersFilePath() { return brandEnv('USERS_FILE') || join(workspaceRoot(), 'users.json'); }

export function oidcEnabled() { return !!brandEnv('OIDC_ISSUER'); }

// Stand-alone mode: active when a users file exists (and OIDC doesn't
// win). Creating the file with `npm run users -- add <name>` and
// restarting is the entire setup.
export function localUsersEnabled() { return !oidcEnabled() && existsSync(usersFilePath()); }

export function authEnabled() { return oidcEnabled() || localUsersEnabled(); }

function sessionTtlMs() {
  const h = Number(brandEnv('SESSION_TTL_HOURS') || 8);
  return (Number.isFinite(h) && h > 0 ? h : 8) * 3600_000;
}

// The HMAC key. OIDC requires it via env (instances must share it);
// stand-alone mode auto-generates once and persists it next to the
// users file's workspace so restarts keep sessions valid.
let cachedSecret = null;
function sessionSecret() {
  const fromEnv = brandEnv('SESSION_SECRET');
  if (fromEnv) return fromEnv;
  if (cachedSecret) return cachedSecret;
  const file = join(workspaceRoot(), 'session-secret');
  try {
    cachedSecret = readFileSync(file, 'utf8').trim();
    if (cachedSecret.length >= 32) return cachedSecret;
  } catch (_) { /* generate below */ }
  cachedSecret = randomBytes(32).toString('base64url');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, cachedSecret, { mode: 0o600 });
  return cachedSecret;
}

// ---------- stand-alone users (scrypt, plain file) ----------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return { algo: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'), hash: hash.toString('base64') };
}

export function verifyPassword(password, rec) {
  if (!rec || rec.algo !== 'scrypt') return false;
  const salt = Buffer.from(rec.salt, 'base64');
  const want = Buffer.from(rec.hash, 'base64');
  const got = scryptSync(String(password), salt, want.length, { N: rec.N, r: rec.r, p: rec.p });
  return got.length === want.length && timingSafeEqual(got, want);
}

export function readUsers(file = usersFilePath()) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return (data && typeof data === 'object' && data.users && typeof data.users === 'object') ? data : { users: {} };
  } catch (_) { return { users: {} }; }
}

export function writeUsers(data, file = usersFilePath()) {
  mkdirSync(dirname(file), { recursive: true });
  // Atomic-ish: temp + rename keeps a crash from truncating the file.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  writeFileSync(file, readFileSync(tmp));
  try { writeFileSync(tmp, ''); } catch (_) { /* best effort */ }
}

// Naive brute-force damper: 5 failures per user+address → 30s lockout.
// In-memory on purpose (stand-alone single instance); OIDC delegates
// this problem to the IdP.
const failedLogins = new Map();
function loginLocked(key) {
  const rec = failedLogins.get(key);
  return !!rec && rec.count >= 5 && (Date.now() - rec.at) < 30_000;
}
function noteLoginFailure(key) {
  const rec = failedLogins.get(key) || { count: 0, at: 0 };
  failedLogins.set(key, { count: rec.count + 1, at: Date.now() });
}
function clearLoginFailures(key) { failedLogins.delete(key); }

// ---------- signed-cookie codec (HMAC-SHA256, node:crypto only) ----------

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }

function sign(payloadObj) {
  const payload = b64u(JSON.stringify(payloadObj));
  const mac = createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `v1.${payload}.${mac}`;
}

function verify(value) {
  const m = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(value || ''));
  if (!m) return null;
  const expect = createHmac('sha256', sessionSecret()).update(m[1]).digest();
  const got = Buffer.from(m[2], 'base64url');
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) return null;
  try {
    const obj = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.exp !== 'number' || Date.now() > obj.exp) return null;
    return obj;
  } catch (_) { return null; }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookieFlags(maxAgeS) {
  const secure = brandEnv('OIDC_REDIRECT_URL').startsWith('https://') || brandEnv('OIDC_SECURE_COOKIES') === '1';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure ? '; Secure' : ''}`;
}

function setCookie(res, name, value, maxAgeS) {
  res.append('Set-Cookie', `${name}=${value}; ${cookieFlags(maxAgeS)}`);
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; ${cookieFlags(0)}`);
}

// The session attached to a request, or null. Exported for the auth
// gate in server/index.mjs.
export function readSession(req) {
  const cookies = parseCookies(req);
  return verify(cookies[SESSION_COOKIE] || cookies[LEGACY_SESSION_COOKIE]);
}

// ---------- OIDC client (lazy discovery, cached) ----------

let configPromise = null;
function getConfig() {
  if (!configPromise) {
    configPromise = (async () => {
      const issuer = new URL(brandEnv('OIDC_ISSUER'));
      const clientId = brandEnv('OIDC_CLIENT_ID');
      const secret = brandEnv('OIDC_CLIENT_SECRET');
      const options = {};
      if (issuer.protocol === 'http:') {
        if (brandEnv('OIDC_ALLOW_HTTP') !== '1') {
          throw new Error('OBSERVOGRAM_OIDC_ISSUER uses http:// — set OBSERVOGRAM_OIDC_ALLOW_HTTP=1 only for local test IdPs, never production');
        }
        options.execute = [oidc.allowInsecureRequests];
      }
      return secret
        ? oidc.discovery(issuer, clientId, secret, undefined, options)
        : oidc.discovery(issuer, clientId, undefined, oidc.None(), options);
    })();
    configPromise.catch(() => { configPromise = null; });   // allow retry after a down IdP
  }
  return configPromise;
}

function redirectUri(req) {
  const fixed = brandEnv('OIDC_REDIRECT_URL');
  if (fixed) return fixed;
  return `${req.protocol}://${req.get('host')}/auth/callback`;
}

// ---------- routes ----------

// Validates the env contract and registers /auth/*. Called at module
// load by server/index.mjs; throws (fail closed, clear message) when the
// configuration is incomplete.
export function initAuth(app) {
  if (oidcEnabled()) { initOidc(app); registerShared(app, 'oidc'); return; }
  if (localUsersEnabled()) { initLocalUsers(app); registerShared(app, 'local-users'); return; }
}

function registerShared(app, mode) {
  app.post('/auth/logout', (req, res) => {
    clearCookie(res, SESSION_COOKIE);
    clearCookie(res, LEGACY_SESSION_COOKIE);
    res.status(204).end();
  });
  app.get('/auth/me', (req, res) => {
    const s = readSession(req);
    if (!s) return res.json({ ok: true, mode, authenticated: false, login: '/auth/login' });
    res.json({
      ok: true, mode, authenticated: true, sub: s.sub, email: s.email, name: s.name, expiresAt: s.exp,
      // Stage 2 tenancy: the client needs the user's orgs at boot to pick
      // an active one (X-Observogram-Org) before the first /api call.
      ...(tenancyEnabled() ? { orgs: orgsForUser(s.sub) } : {}),
    });
  });
}

// ---------- stand-alone: password login against the users file ----------

const LOGIN_PAGE = (error = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Observogram — sign in</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1623;color:#e5e8ec;
       font-family:'IBM Plex Sans',system-ui,sans-serif}
  form{background:#18202e;border:1px solid #2a3548;border-radius:10px;padding:32px 36px;min-width:320px}
  h1{font-size:18px;margin:0 0 4px} p{color:#788396;font-size:12px;margin:0 0 20px}
  label{display:block;font-size:11px;letter-spacing:.08em;color:#9aa3ad;margin:14px 0 4px;text-transform:uppercase}
  input{width:100%;box-sizing:border-box;padding:9px 10px;border-radius:5px;border:1px solid #2a3548;
        background:#11192a;color:#e5e8ec;font-size:14px}
  button{margin-top:22px;width:100%;padding:10px;border-radius:5px;border:0;background:#047857;color:#fff;
         font-weight:700;font-size:13px;cursor:pointer}
  .err{background:#2a1414;border:1px solid #7f1d1d;color:#fca5a5;border-radius:5px;padding:8px 10px;
       font-size:12px;margin-bottom:6px}
</style></head><body>
<form method="post" action="/auth/login">
  <h1>Observo<i>gram</i></h1><p>the observability compiler · sign in</p>
  ${error ? `<div class="err">${error}</div>` : ''}
  <label for="u">Username</label><input id="u" name="username" autocomplete="username" autofocus required>
  <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form></body></html>`;

function initLocalUsers(app) {
  // Stand-alone is single-instance by definition — the auto-persisted
  // workspace secret is enough; touching it here surfaces filesystem
  // problems at boot instead of at first login.
  sessionSecret();

  app.get('/auth/login', (req, res) => {
    res.type('html').send(LOGIN_PAGE());
  });

  app.post('/auth/login', (req, res) => {
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const key = `${username}|${req.ip || ''}`;
    const fail = (msg, status = 401) => {
      noteLoginFailure(key);
      const wantsJson = (req.headers.accept || '').includes('application/json');
      return wantsJson
        ? res.status(status).json({ ok: false, error: msg })
        : res.status(status).type('html').send(LOGIN_PAGE(msg));
    };
    if (loginLocked(key)) return fail('too many attempts — wait 30 seconds', 429);
    const rec = readUsers().users[username];
    // Always burn a hash verification so unknown users cost the same as
    // wrong passwords (no username oracle).
    const ok = rec ? verifyPassword(password, rec.password) : (hashPassword('timing-equalizer'), false);
    if (!ok) return fail('invalid username or password');
    clearLoginFailures(key);
    const session = {
      sub: username,
      email: rec.email || null,
      name: rec.name || username,
      iat: Date.now(),
      exp: Date.now() + sessionTtlMs(),
    };
    setCookie(res, SESSION_COOKIE, sign(session), Math.floor(sessionTtlMs() / 1000));
    const wantsJson = (req.headers.accept || '').includes('application/json');
    return wantsJson ? res.json({ ok: true }) : res.redirect('/');
  });
}

// ---------- OIDC ----------

function initOidc(app) {
  const missing = [];
  if (!brandEnv('OIDC_CLIENT_ID')) missing.push('OBSERVOGRAM_OIDC_CLIENT_ID');
  if (brandEnv('SESSION_SECRET').length < 32) missing.push('OBSERVOGRAM_SESSION_SECRET (≥ 32 chars — instances must share it)');
  if (missing.length) {
    throw new Error(`OIDC is configured (OBSERVOGRAM_OIDC_ISSUER set) but incomplete — missing: ${missing.join(', ')}. Refusing to start half-authenticated.`);
  }

  app.get('/auth/login', async (req, res) => {
    try {
      const config = await getConfig();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const verifier = oidc.randomPKCECodeVerifier();
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      setCookie(res, FLOW_COOKIE, sign({ state, nonce, verifier, exp: Date.now() + FLOW_TTL_S * 1000 }), FLOW_TTL_S);
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri(req),
        scope: 'openid profile email',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      res.redirect(url.href);
    } catch (e) {
      res.status(502).json({ ok: false, error: `OIDC login could not start: ${e.message}` });
    }
  });

  app.get('/auth/callback', async (req, res) => {
    const flow = verify(parseCookies(req)[FLOW_COOKIE]);
    clearCookie(res, FLOW_COOKIE);
    if (!flow) return res.status(400).json({ ok: false, error: 'login flow expired or missing — start again at /auth/login' });
    try {
      const config = await getConfig();
      const currentUrl = new URL(req.originalUrl, redirectUri(req));
      const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
      });
      const claims = tokens.claims() || {};
      const session = {
        sub: claims.sub,
        email: claims.email || null,
        name: claims.name || null,
        iat: Date.now(),
        exp: Date.now() + sessionTtlMs(),
      };
      setCookie(res, SESSION_COOKIE, sign(session), Math.floor(sessionTtlMs() / 1000));
      res.redirect('/');
    } catch (e) {
      // openid-client errors carry protocol detail; the message is safe,
      // token material never is.
      res.status(401).json({ ok: false, error: `sign-in failed: ${e.message}` });
    }
  });
}
