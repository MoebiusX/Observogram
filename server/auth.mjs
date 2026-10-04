// server/auth.mjs
//
// Stage 1 of docs/PRODUCTIZATION_PLAN.md — identity. This module is the
// ONLY place the openid-client dependency is allowed (the scoped
// exception ratified with the plan); sessions, cookies, password
// hashing and everything else are node: builtins.
//
// Users live in the store (docs/STORE_PLAN.md slice 2): server/boot.mjs
// imports a legacy users.json once, seeds the first admin, and the CLIs
// (`npm run users`, `npm run orgs`) write the store directly.
//
// Postures (mutually exclusive; the MODE is env-detected, stand-alone
// ARMING is per-request — identity_armed may be set by start() on a fresh
// install or by `npm run users` while the server runs):
//   - OPEN (OBSERVOGRAM_AUTH=off): the identity system is disabled —
//     no login, no seeding, /auth/* answers 404. The pre-0.5
//     no-friction posture, kept for dev shells, scripts and CI.
//   - LOCAL USERS (stand-alone): the store's identity_armed flag is set
//     (the import of a users file, the seed, the first `npm run users --
//     add`) → a password login page at /auth/login, credentials
//     scrypt-hashed in the store. No IdP, no network dependency. Once
//     armed it stays armed: removing users never reopens a server. The
//     session secret auto-generates and persists into the workspace.
//     First boot with NOTHING configured ships like Grafana: start()
//     seeds admin/admin, the change is asked at every sign-in until it
//     lands (skippable per session for the seeded default only), and the
//     default credential never binds beyond loopback — see
//     server/boot.mjs.
//   - OIDC (OBSERVOGRAM_OIDC_ISSUER set — wins over local users):
//     Authorization Code + PKCE against any conformant provider
//     (Entra ID, Google, Okta, Keycloak, dex). Users are recorded as
//     <issuerKey>#<sub> (the issuer key is canonIssuer() of the variable,
//     never the token's iss).
//   - REVERSE PROXY (OBSERVOGRAM_TRUST_PROXY_AUTH=1 — server/auth-proxy.mjs;
//     wins over local users, refuses to start beside OIDC): the proxy in
//     front of this port sends the caller's identity in headers, and every
//     request resolves them against the store — no cookie, no login page.
//     Users are recorded as proxy://<realm>#<user>, kind 'oidc'.
//
// In BOTH authenticated postures the session is the same signed
// (HMAC-SHA256) HttpOnly SameSite=Lax cookie, carrying the user's login
// and session epoch: every reader resolves it against the store
// (resolveSession), so a password change, a disable or "sign out
// everywhere" revokes the user's cookies. ALL /api data requires a
// session (or the bearer token, which remains the service-account/CI
// path); the static studio shell stays open so the client can redirect
// to /auth/login.
//
// Env contract (every knob also honors the legacy TOMOGRAPH_* spelling —
// see tools/lib/brand-env.mjs):
//   OBSERVOGRAM_OIDC_ISSUER        e.g. https://login.example.com/realms/x
//   OBSERVOGRAM_OIDC_CLIENT_ID     registered client id (required w/ issuer)
//   OBSERVOGRAM_OIDC_CLIENT_SECRET optional — omit for a public PKCE client
//   OBSERVOGRAM_OIDC_REDIRECT_URL  optional — defaults to <host>/auth/callback
//   OBSERVOGRAM_BOOTSTRAP_ADMIN    OIDC: <issuer>#<sub> or a verified email —
//                                  granted owner at sign-in while no owner
//                                  can sign in with OIDC
//   OBSERVOGRAM_USERS_FILE         optional — a legacy users file, imported
//                                  once at the first start of a store build
//   OBSERVOGRAM_AUTH               'off' disables identity entirely (open posture)
//   OBSERVOGRAM_ADMIN_PASSWORD     first-boot seed password for 'admin'; skips
//                                  the forced change (docker/k8s, where the
//                                  loopback first sign-in is impossible)
//   OBSERVOGRAM_SESSION_SECRET     ≥ 32 chars; REQUIRED for OIDC (multi-
//                                  instance correctness); auto-persisted
//                                  under the workspace for local users
//   OBSERVOGRAM_SESSION_TTL_HOURS  optional, default 8
//   OBSERVOGRAM_OIDC_ALLOW_HTTP    '1' permits an http:// issuer (tests,
//                                  dex-in-docker) — never production
//   OBSERVOGRAM_TRUST_PROXY_AUTH   '1' takes identity from a reverse proxy's
//                                  headers (server/auth-proxy.mjs lists the
//                                  PROXY_AUTH_* knobs and the ACK flag)

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as oidc from 'openid-client';
import { brandEnv, baseWorkspacePath, loadBrand } from '../tools/lib/brand-env.mjs';
import { brandChrome, escapeHtml as escapeBrand } from '../tools/lib/brand.mjs';
import { currentStore } from './store/db.mjs';
import { getMeta, isIdentityArmed } from './store/meta.mjs';
import { getOrg } from './store/orgs.mjs';
import { listMembershipsForUser } from './store/memberships.mjs';
import { getUserByLogin, setPassword, touchLogin } from './store/users.mjs';
import {
  canonIssuer, firstSightOidc, oidcLogin, oidcSignIn, parseBootstrapAdmin, preStoreSub, sanitiseClaims,
} from './store/identity.mjs';
// The management rules (the self route's sign-out). identity-admin.mjs
// imports this module too: a cycle ESM resolves because neither module
// calls the other at load, only from functions.
import { signOutEverywhere } from './identity-admin.mjs';
// The reverse-proxy mode (the same kind of cycle: functions only).
import { assertProxyAuthEnv, initProxyAuth, proxyAuthConfig, proxyAuthEnabled, resolveProxySession } from './auth-proxy.mjs';

const SESSION_COOKIE = 'observogram_session';
// Sessions signed before the rebrand stay valid (same HMAC secret): read
// the old cookie name too, clear both on logout. Drop with the env shim.
const LEGACY_SESSION_COOKIE = 'tomo_session';
const FLOW_COOKIE = 'observogram_flow';
const FLOW_TTL_S = 600;
// Forced password change (seeded default / admin-set temporary): the
// verified-but-not-yet-sessioned login rides this signed cookie between
// POST /auth/login and POST /auth/change-password (or its /skip
// sibling, seeded default only).
const PWFLOW_COOKIE = 'observogram_pwflow';
const PWFLOW_TTL_S = 600;

function workspaceRoot() { return baseWorkspacePath(); }

// OBSERVOGRAM_AUTH=off is the one hard switch that disables identity
// entirely (no login, no seeding, /auth/* inert). It beats OIDC config
// and an armed store on purpose: one knob, one meaning. The network
// fail-closed rule in start() still applies — this opens loopback dev,
// not the internet.
export function authDisabled() { return brandEnv('AUTH').toLowerCase() === 'off'; }

export function oidcEnabled() { return !authDisabled() && !!brandEnv('OIDC_ISSUER'); }

// Stand-alone mode: armed by the store's identity_armed flag (and OIDC
// doesn't win). A flag, not a row count and not a file: checked per
// request, so `npm run users -- add` arms a running server, and nothing
// disarms it. Throws when the store is not open — only without start()
// (fail closed).
export function localUsersEnabled() { return !authDisabled() && !oidcEnabled() && !proxyAuthEnabled() && isIdentityArmed(currentStore()); }

export function authEnabled() { return oidcEnabled() || proxyAuthEnabled() || localUsersEnabled(); }

// The issuer key OIDC logins are recorded under: canonIssuer() of the
// variable (never the token's iss), memoised per raw value.
let issuerMemo = { raw: null, key: null };
export function issuerKey() {
  const raw = brandEnv('OIDC_ISSUER') || null;
  if (!raw) return null;
  if (issuerMemo.raw !== raw) issuerMemo = { raw, key: canonIssuer(raw) };
  return issuerMemo.key;
}

function sessionTtlMs() {
  const h = Number(brandEnv('SESSION_TTL_HOURS') || 8);
  return (Number.isFinite(h) && h > 0 ? h : 8) * 3600_000;
}

// The HMAC key. OIDC requires it via env (instances must share it);
// stand-alone mode auto-generates once and persists it in the workspace
// so restarts keep sessions valid.
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

// Stand-alone is single-instance by definition — the auto-persisted
// workspace secret is enough; start() touches it once armed so filesystem
// problems surface at boot instead of at first login (in the open posture
// nothing may be written into the workspace).
export function touchSessionSecret() { sessionSecret(); }

// ---------- passwords (scrypt) ----------

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

// ---------- sessions, resolved against the store ----------
//
// The cookie payload is { sub, login, ep, purpose: 'session', email, name,
// iat, exp }: `sub` stays what a pre-store build knows the user by
// (preStoreSub: the username, or the bare IdP sub), `login` is
// users.login, `ep` the session epoch at issue. A cookie without `login` is pre-upgrade and
// reads as epoch 0 (the epoch the import gives its rows). Every signed
// payload shares the key, so a session must say it is one: a post-upgrade
// payload without `purpose: 'session'`, or any payload whose purpose is
// something else (the pwflow cookie), is refused.

// The session attached to a request, or null — the one algorithm every
// session reader uses. A refused cookie is the same as no cookie. May
// write: the first sight of a pre-upgrade OIDC cookie creates its row.
export function resolveSession(req, { db = currentStore() } = {}) {
  if (!authEnabled()) return null;
  // Behind a reverse proxy the request's headers ARE the session; a cookie
  // carried over from another mode is ignored (server/auth-proxy.mjs).
  if (proxyAuthEnabled()) return resolveProxySession(req, { db });
  const cookies = parseCookies(req);
  const payload = verify(cookies[SESSION_COOKIE] || cookies[LEGACY_SESSION_COOKIE]);
  if (!payload) return null;
  const preUpgrade = typeof payload.login !== 'string';
  if (payload.purpose !== undefined && payload.purpose !== 'session') return null;
  if (!preUpgrade && payload.purpose !== 'session') return null;
  let ep = 0;
  if (!preUpgrade) {
    if (!Number.isSafeInteger(payload.ep) || payload.ep < 0) return null;
    ep = payload.ep;
  }
  const mode = oidcEnabled() ? 'oidc' : 'local';
  let login;
  if (!preUpgrade) login = payload.login;
  else if (typeof payload.sub === 'string' && payload.sub) login = mode === 'oidc' ? oidcLogin(issuerKey(), payload.sub) : payload.sub;
  else return null;
  let user = getUserByLogin(db, login);
  if (mode === 'oidc') {
    const key = issuerKey();
    if (!login.startsWith(`${key}#`)) return null;   // another issuer's cookie, or a local one
    if (!user) {
      if (!preUpgrade) return null;                   // only the callback creates post-upgrade rows
      let claims;
      try {
        claims = sanitiseClaims({ sub: payload.sub, email: payload.email, name: payload.name }, brandEnv('OIDC_ISSUER'));
      } catch { return null; }                        // an unusable sub
      user = firstSightOidc(db, {
        issuerKey: key, issuerDisplay: brandEnv('OIDC_ISSUER'), sub: claims.sub, email: claims.email, name: claims.name,
      });
    }
    if (user.kind !== 'oidc') return null;
  } else if (!user || user.kind !== 'local') {
    return null;                                       // a local cookie with no row
  }
  if (user.disabled) return null;
  if (user.sessionEpoch !== ep) return null;           // a changed password, a disable, "sign out everywhere"
  return {
    user, login: user.login, sub: preStoreSub(user),
    email: user.email ?? payload.email ?? null,
    name: user.name ?? (user.kind === 'local' ? user.login : payload.name ?? null),
    exp: payload.exp, preUpgrade,
  };
}

// The forced-change flow cookie, resolved against the store: the row must
// be the local, enabled, still-must-change user it was issued for, at the
// same epoch (a pre-upgrade flow cookie carries no login or ep: its sub is
// the login and it reads as epoch 0).
export function resolvePwflow(req, db) {
  const flow = verify(parseCookies(req)[PWFLOW_COOKIE]);
  if (!flow || flow.purpose !== 'pwchange') return null;
  const login = typeof flow.login === 'string' ? flow.login : flow.sub;
  if (typeof login !== 'string' || !login) return null;
  const ep = Number.isSafeInteger(flow.ep) ? flow.ep : 0;
  const user = getUserByLogin(db, login);
  if (!user || user.kind !== 'local' || user.disabled || user.sessionEpoch !== ep || !user.mustChange) return null;
  return { user };
}

// Issue the signed session cookie for a store row. Shared by the login
// paths, the forced change, the OIDC callback and "sign out my other
// sessions" — which passes the session's own `exp`: re-issuing a cookie at
// a new epoch never extends it (a sign-in, or the current password, does).
function issueSession(res, db, user, { exp = null } = {}) {
  const now = Date.now();
  const until = exp ?? now + sessionTtlMs();
  const session = {
    sub: preStoreSub(user),
    login: user.login,
    ep: user.sessionEpoch,
    purpose: 'session',
    email: user.email || null,
    name: user.name || (user.kind === 'local' ? user.login : null),
    iat: now,
    exp: until,
  };
  setCookie(res, SESSION_COOKIE, sign(session), Math.max(0, Math.floor((until - now) / 1000)));
}

// The user's live orgs, first membership first; `default: true` marks the
// deployment's default org (only ever on an org the user is in). `role` is
// the membership's; `effectiveRole` the role the route guard applies there
// (an owner is an admin in every live org — server/authz.mjs).
function orgsOf(db, user) {
  const defaultOrg = getMeta(db, 'default_org');
  return listMembershipsForUser(db, user.id).map((m) => {
    const org = getOrg(db, m.orgId);
    return {
      id: m.orgId, name: org?.name || m.orgId, role: m.role, effectiveRole: user.isOwner ? 'admin' : m.role,
      default: m.orgId === defaultOrg,
    };
  });
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
export function initAuth(app, { authorize } = {}) {
  // Every route's first handler is its guard (server/authz.mjs, injected:
  // this module never imports it); the route table classifies each one.
  if (typeof authorize !== 'function') throw new TypeError('initAuth(app, { authorize }): the route guard factory is required');
  if (authDisabled()) return;
  // After the off switch (it wins), before OIDC: the proxy mode's contract,
  // including "not beside OIDC" — else OIDC would silently win.
  assertProxyAuthEnv();
  if (oidcEnabled()) { initOidc(app, authorize); registerShared(app, 'oidc', authorize); return; }
  if (proxyAuthEnabled()) { initProxyAuth(app, authorize); registerShared(app, 'proxy', authorize); return; }
  // Stand-alone routes register unconditionally and gate on
  // identity_armed PER REQUEST: route registration is load-time in
  // Express, but the store is not open yet at import — the flag may be
  // set by start() on first boot or by `npm run users` while the process
  // runs. Posture stays request-time, exactly like the /api gate.
  initLocalUsers(app, authorize);
  registerShared(app, 'local-users', authorize);
}

// 404 while identity is off (open posture, or stand-alone not yet armed)
// — the studio detects "local, no login" by this status code.
export function identityOff(res) {
  return res.status(404).json({ ok: false, error: 'identity not configured' });
}

// A client that asked for JSON (a script, the studio) rather than a page.
export function wantsJson(req) {
  return (req.headers.accept || '').includes('application/json');
}

function registerShared(app, mode, authorize) {
  app.post('/auth/logout', authorize('POST /auth/logout'), (req, res) => {
    if (!authEnabled()) return identityOff(res);
    clearCookie(res, SESSION_COOKIE);
    clearCookie(res, LEGACY_SESSION_COOKIE);
    res.status(204).end();
  });
  app.get('/auth/me', authorize('GET /auth/me'), (req, res) => {
    if (!authEnabled()) return identityOff(res);
    const db = currentStore();
    const s = resolveSession(req, { db });
    if (!s) return res.json({ ok: true, mode, authenticated: false, login: '/auth/login' });
    res.json({
      ok: true, mode, authenticated: true, sub: s.sub, email: s.email, name: s.name, expiresAt: s.exp,
      // Nested: the unauthenticated body's `login` is the login page.
      user: { login: s.user.login, kind: s.user.kind, owner: s.user.isOwner },
      // Tenancy is always on: the client picks an active org
      // (X-Observogram-Org) from these before the first /api call.
      orgs: orgsOf(db, s.user),
      // Proxy mode: where the studio goes after sign-out (the proxy's own
      // session outlives this app's; null when none is configured).
      ...(mode === 'proxy' ? { logoutUrl: proxyAuthConfig()?.logoutUrl ?? null } : {}),
    });
  });
  // Not behind a reverse proxy: there is no session of this app's to end
  // (every request is signed in by its headers), so the route is not
  // registered and the account menu hides the item.
  if (mode === 'proxy') return;
  // "Sign out my other sessions" (the account menu): a self route — the
  // caller's own session, never the pwflow cookie; the CSRF header in
  // every mode (selfGate, server/authz.mjs). The caller's epoch is bumped
  // (one user.signout row, the caller its actor), so every cookie of
  // theirs issued before is refused from its next request, and this
  // browser's is re-issued at the new epoch with its own expiry.
  app.post('/auth/signout-others', authorize('POST /auth/signout-others'), (req, res) => {
    const db = currentStore();
    const { user, session } = req.observogramSelf;
    const { user: updated, sessionEpoch } = signOutEverywhere(db, user.login, user.login, { surface: 'api' });
    issueSession(res, db, updated, { exp: session.exp });
    res.json({ ok: true, sessionEpoch });
  });
}

// ---------- stand-alone: password login against the store ----------

export const AUTH_PAGE_STYLE = `<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1623;color:#e5e8ec;
       font-family:'IBM Plex Sans',system-ui,sans-serif}
  form{background:#18202e;border:1px solid #2a3548;border-radius:10px;padding:32px 36px;min-width:320px}
  h1{font-size:18px;margin:0 0 4px} p{color:#788396;font-size:12px;margin:0 0 20px}
  label{display:block;font-size:11px;letter-spacing:.08em;color:#9aa3ad;margin:14px 0 4px;text-transform:uppercase}
  input{width:100%;box-sizing:border-box;padding:9px 10px;border-radius:5px;border:1px solid #2a3548;
        background:#11192a;color:#e5e8ec;font-size:14px}
  button{margin-top:22px;width:100%;padding:10px;border-radius:5px;border:0;background:#047857;color:#fff;
         font-weight:700;font-size:13px;cursor:pointer}
  .skip{display:block;width:100%;box-sizing:border-box;margin-top:10px;background:none;border:0;
        color:#788396;font-weight:400;font-size:12px;text-decoration:underline;padding:0;
        cursor:pointer;text-align:center}
  .err{background:#2a1414;border:1px solid #7f1d1d;color:#fca5a5;border-radius:5px;padding:8px 10px;
       font-size:12px;margin-bottom:6px}
</style>`;

// The pages' brand (tools/lib/brand.mjs): read at request time through the
// cached loader, so a suite's env lands before the first page and a
// branded deployment names itself on every page. The brand strings are
// escaped here; the error texts are the server's own.
export const authPageChrome = () => brandChrome(loadBrand());

export const loginPageHtml = (error = '', c = authPageChrome()) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeBrand(c.loginTitle)}</title>
${AUTH_PAGE_STYLE}</head><body>
<form method="post" action="/auth/login">
  <h1>${c.wordmarkHtml('i')}</h1><p>${escapeBrand(c.tagline)} · sign in</p>
  ${error ? `<div class="err">${error}</div>` : ''}
  <label for="u">Username</label><input id="u" name="username" autocomplete="username" autofocus required>
  <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form></body></html>`;

export const changePageHtml = (error = '', { canSkip = false, askCurrent = false } = {}, c = authPageChrome()) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeBrand(c.name)} — ${askCurrent ? 'change your password' : 'set a new password'}</title>
${AUTH_PAGE_STYLE}</head><body>
<form method="post" action="/auth/change-password">
  <h1>${c.wordmarkHtml('i')}</h1><p>${askCurrent ? 'change your password' : 'choose a new password to finish signing in'}</p>
  ${error ? `<div class="err">${error}</div>` : ''}
  ${askCurrent ? '<label for="c">Current password</label><input id="c" name="current" type="password" autocomplete="current-password" autofocus required>' : ''}
  <label for="p">New password</label><input id="p" name="password" type="password" autocomplete="new-password" minlength="8"${askCurrent ? '' : ' autofocus'} required>
  <label for="r">Repeat</label><input id="r" name="repeat" type="password" autocomplete="new-password" minlength="8" required>
  <button type="submit">${askCurrent ? 'Change password' : 'Set password &amp; sign in'}</button>
  ${canSkip ? `<button type="submit" class="skip" formaction="/auth/change-password/skip" formnovalidate>Skip for now — ask again next sign-in</button>` : ''}
  ${askCurrent ? '<a class="skip" href="/">Cancel — back to the studio</a>' : ''}
</form></body></html>`;

function initLocalUsers(app, authorize) {
  app.get('/auth/login', authorize('GET /auth/login'), (req, res) => {
    if (!localUsersEnabled()) return identityOff(res);
    res.type('html').send(loginPageHtml());
  });

  app.post('/auth/login', authorize('POST /auth/login'), (req, res) => {
    if (!localUsersEnabled()) return identityOff(res);
    const db = currentStore();
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const key = `${username}|${req.ip || ''}`;
    const json = wantsJson(req);
    const fail = (msg, status = 401) => {
      noteLoginFailure(key);
      return json
        ? res.status(status).json({ ok: false, error: msg })
        : res.status(status).type('html').send(loginPageHtml(msg));
    };
    if (loginLocked(key)) return fail('too many attempts — wait 30 seconds', 429);
    const row = username ? getUserByLogin(db, username) : null;
    // A disabled row answers exactly like an unknown one.
    const rec = row?.kind === 'local' && !row.disabled && row.password ? row : null;
    // Always burn a hash verification so unknown users cost the same as
    // wrong passwords (no username oracle).
    const ok = rec ? verifyPassword(password, rec.password) : (hashPassword('timing-equalizer'), false);
    if (!ok) return fail('invalid username or password');
    clearLoginFailures(key);
    touchLogin(db, rec.id);
    if (rec.mustChange) {
      // Correct password, but it's the seeded default (or an admin-set
      // temporary): no session yet — a short-lived signed flow cookie
      // carries the login and epoch to /auth/change-password, which issues
      // the real session once a new password is set (or, for the seeded
      // default only, once the change is skipped for this session).
      setCookie(res, PWFLOW_COOKIE, sign({
        sub: rec.login, login: rec.login, ep: rec.sessionEpoch, purpose: 'pwchange', exp: Date.now() + PWFLOW_TTL_S * 1000,
      }), PWFLOW_TTL_S);
      return json
        ? res.json({ ok: true, mustChange: true, next: '/auth/change-password' })
        : res.redirect('/auth/change-password');
    }
    // A leftover pwchange flow cookie — an abandoned forced change for a
    // DIFFERENT account on this browser — must never shadow this session
    // on /auth/change-password (the change routes check the flow cookie
    // first, so a stale one would target the other account): clear it
    // the moment a normal session lands.
    clearCookie(res, PWFLOW_COOKIE);
    issueSession(res, db, rec);
    return json ? res.json({ ok: true }) : res.redirect('/');
  });

  // The three change-password routes are `self` routes: their guard
  // (selfGate, server/authz.mjs) answers 404 while stand-alone sign-in is
  // off, resolves the caller once — the pwflow cookie first, else a
  // session — refuses a request with neither, and hands the handler
  // req.observogramSelf: { via: 'pwflow', user } | { via: 'session', user, session }.
  app.get('/auth/change-password', authorize('GET /auth/change-password'), (req, res) => {
    const self = req.observogramSelf;
    if (self.via === 'pwflow') {
      // The skip affordance renders only while the record still holds the
      // seeded default — an admin-set temporary password stays a forced
      // change (see the skip route below for the rationale).
      return res.type('html').send(changePageHtml('', { canSkip: self.user.seededDefault }));
    }
    // Signed-in self-service (the account menu's "change password…"):
    // the same page, with the current password required.
    if (self.user.kind === 'local') {
      return res.type('html').send(changePageHtml('', { askCurrent: true }));
    }
    res.redirect('/auth/login');
  });

  // Two credentials open this route: the signed pwflow cookie (forced
  // change mid-login — it only exists after a correct password, is
  // HMAC-signed, and SameSite=Lax keeps it off cross-site POSTs), or a
  // signed-in session, which must ALSO prove the current password —
  // that knowledge is what makes a forged cross-site POST useless.
  // Neither path needs a separate CSRF token.
  app.post('/auth/change-password', authorize('POST /auth/change-password'), (req, res) => {
    const db = currentStore();
    const json = wantsJson(req);
    const self = req.observogramSelf;
    const inFlow = self.via === 'pwflow';
    const user = inFlow ? self.user : (self.user.kind === 'local' ? self.user : null);
    if (!user) {
      return json
        ? res.status(401).json({ ok: false, error: 'password-change flow expired — sign in again', login: '/auth/login' })
        : res.redirect('/auth/login');
    }
    const body = req.body || {};
    const password = String(body.password || '');
    const canSkip = inFlow && user.seededDefault;
    const bad = (msg, status = 400) => json
      ? res.status(status).json({ ok: false, error: msg })
      : res.status(status).type('html').send(changePageHtml(msg, { canSkip, askCurrent: !inFlow }));
    if (!inFlow) {
      // Same damper as login — current-password guesses from a stolen
      // session cookie must not be free.
      const key = `${user.login}|${req.ip || ''}`;
      if (loginLocked(key)) return bad('too many attempts — wait 30 seconds', 429);
      if (!verifyPassword(String(body.current || ''), user.password)) {
        noteLoginFailure(key);
        return bad('current password is incorrect', 401);
      }
      clearLoginFailures(key);
    }
    if (password.length < 8) return bad('password must be at least 8 characters');
    if (password !== String(body.repeat || '')) return bad('passwords do not match');
    // Bumps the epoch: every other session of this user ends here; this
    // one is re-issued at the new epoch.
    const updated = setPassword(db, user.login, user.id, hashPassword(password), { mustChange: false, seededDefault: false });
    touchLogin(db, updated.id);
    if (inFlow) clearCookie(res, PWFLOW_COOKIE);
    issueSession(res, db, updated);
    return json ? res.json({ ok: true }) : res.redirect('/');
  });

  // "Skip for now" — the first-run affordance on the forced change:
  // issue a session WITHOUT replacing the seeded default. Deliberately
  // narrow on purpose:
  //   - only while the record still holds the seeded default; an
  //     admin-set temporary password (mustChange without seededDefault)
  //     stays a forced change — skipping would defeat the admin's intent.
  //   - the must_change/seeded_default flags stay untouched, so every
  //     subsequent sign-in asks again ("for now", not "never") and the
  //     boot's default-credential check keeps refusing non-loopback
  //     binds — skipping never lets admin/admin reach a network.
  // The flow cookie is the credential, same as the change POST above.
  app.post('/auth/change-password/skip', authorize('POST /auth/change-password/skip'), (req, res) => {
    const db = currentStore();
    const json = wantsJson(req);
    const flow = req.observogramSelf;   // the pwflow cookie only (selfGate)
    if (!flow.user.seededDefault) {
      return json
        ? res.status(403).json({ ok: false, error: 'a password change is required for this account' })
        : res.status(403).type('html').send(changePageHtml('a password change is required for this account'));
    }
    touchLogin(db, flow.user.id);
    clearCookie(res, PWFLOW_COOKIE);
    issueSession(res, db, flow.user);
    return json ? res.json({ ok: true, skipped: true }) : res.redirect('/');
  });
}

// ---------- OIDC ----------

function initOidc(app, authorize) {
  const missing = [];
  if (!brandEnv('OIDC_CLIENT_ID')) missing.push('OBSERVOGRAM_OIDC_CLIENT_ID');
  if (brandEnv('SESSION_SECRET').length < 32) missing.push('OBSERVOGRAM_SESSION_SECRET (≥ 32 chars — instances must share it)');
  if (missing.length) {
    throw new Error(`OIDC is configured (OBSERVOGRAM_OIDC_ISSUER set) but incomplete — missing: ${missing.join(', ')}. Refusing to start half-authenticated.`);
  }

  app.get('/auth/login', authorize('GET /auth/login'), async (req, res) => {
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

  app.get('/auth/callback', authorize('GET /auth/callback'), async (req, res) => {
    const flow = verify(parseCookies(req)[FLOW_COOKIE]);
    clearCookie(res, FLOW_COOKIE);
    if (!flow) return res.status(400).json({ ok: false, error: 'login flow expired or missing — start again at /auth/login' });
    let claims;
    try {
      const config = await getConfig();
      const currentUrl = new URL(req.originalUrl, redirectUri(req));
      const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
      });
      // '' name/email → null; an unusable sub refuses the sign-in.
      claims = sanitiseClaims(tokens.claims() || {}, brandEnv('OIDC_ISSUER'));
    } catch (e) {
      // openid-client errors carry protocol detail; the message is safe,
      // token material never is.
      const message = e?.code === 'ERR_OBSERVOGRAM_UNUSABLE_SUB' ? e.message : `sign-in failed: ${e.message}`;
      return res.status(401).json({ ok: false, error: message });
    }
    const db = currentStore();
    let r;
    try {
      // The bootstrap variable is read per sign-in.
      r = oidcSignIn(db, {
        issuerKey: issuerKey(), issuerDisplay: claims.iss, claims,
        bootstrap: parseBootstrapAdmin(brandEnv('BOOTSTRAP_ADMIN')),
      });
    } catch (e) {
      return res.status(401).json({ ok: false, error: `sign-in failed: ${e.message}` });
    }
    if (r.refused === 'disabled') return res.status(403).json({ ok: false, error: 'this account is disabled — ask an owner' });
    if (r.refused === 'local-login') {
      return res.status(403).json({ ok: false, error: 'this sign-in collides with a local user of the same login — ask an owner' });
    }
    touchLogin(db, r.user.id);
    issueSession(res, db, r.user);
    res.redirect('/');
  });
}
