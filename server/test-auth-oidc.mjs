#!/usr/bin/env node
/**
 * server/test-auth-oidc.mjs — Stage 1 identity, OIDC posture
 * (docs/PRODUCTIZATION_PLAN.md): the full Authorization Code + PKCE flow
 * against an in-process mock IdP that signs real RS256 id_tokens and
 * serves JWKS — so openid-client's signature / nonce / audience
 * validation genuinely executes. Conformance against a real IdP (dex in
 * docker) can ride the backend-live job later; this suite runs on every
 * `npm test`.
 */

import { createServer } from 'node:http';
import { createHash, createHmac, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHarness } from '../tools/lib/harness.mjs';
const { assert, failures, report } = createHarness({ indent: '  ', truncate: 240 });

const b64u = (x) => Buffer.from(x).toString('base64url');

// ---------- mock IdP: discovery + JWKS + authorize + token ----------

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const CLIENT_ID = 'observogram-studio';
const authCodes = new Map();   // code → { nonce, code_challenge, redirect_uri }
let issuer;
// The claims the next /token response signs (signIn() sets them).
const DEFAULT_CLAIMS = { sub: 'user-42', email: 'ada@example.test', name: 'Ada Test' };
let nextClaims = DEFAULT_CLAIMS;

function signIdToken(claims) {
  const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }));
  const payload = b64u(JSON.stringify(claims));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`;
}

const idp = createServer(async (req, res) => {
  const url = new URL(req.url, issuer);
  const send = (code, obj, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type });
    res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
  };
  if (url.pathname === '/.well-known/openid-configuration') {
    return send(200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  }
  if (url.pathname === '/jwks') {
    const jwk = publicKey.export({ format: 'jwk' });
    return send(200, { keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] });
  }
  if (url.pathname === '/authorize') {
    // The "user" is already signed in at the IdP — immediately bounce
    // back with a code bound to nonce + PKCE challenge.
    const q = url.searchParams;
    const code = randomUUID();
    authCodes.set(code, {
      nonce: q.get('nonce'),
      code_challenge: q.get('code_challenge'),
      redirect_uri: q.get('redirect_uri'),
    });
    const back = new URL(q.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state'));
    res.writeHead(302, { Location: back.href });
    return res.end();
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    let raw = '';
    req.setEncoding('utf8');
    for await (const c of req) raw += c;
    const form = new URLSearchParams(raw);
    const rec = authCodes.get(form.get('code'));
    if (!rec) return send(400, { error: 'invalid_grant' });
    const challenge = createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
    if (challenge !== rec.code_challenge) return send(400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
    authCodes.delete(form.get('code'));
    const now = Math.floor(Date.now() / 1000);
    return send(200, {
      access_token: randomUUID(),
      token_type: 'bearer',
      expires_in: 3600,
      id_token: signIdToken({
        iss: issuer, aud: CLIENT_ID, ...nextClaims,
        iat: now, exp: now + 3600, nonce: rec.nonce,
      }),
    });
  }
  send(404, { error: 'not found' });
});
await new Promise(r => idp.listen(0, '127.0.0.1', r));
issuer = `http://127.0.0.1:${idp.address().port}`;

// ---------- boot the server in OIDC posture ----------

const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-auth-oidc-'));
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;
process.env.OBSERVOGRAM_OIDC_ISSUER = issuer;
process.env.OBSERVOGRAM_OIDC_CLIENT_ID = CLIENT_ID;
process.env.OBSERVOGRAM_OIDC_ALLOW_HTTP = '1';
process.env.OBSERVOGRAM_SESSION_SECRET = 'test-session-secret-0123456789-abcdef-XYZ';
delete process.env.OBSERVOGRAM_OIDC_CLIENT_SECRET;
delete process.env.OBSERVOGRAM_API_TOKEN;
delete process.env.OBSERVOGRAM_USERS_FILE;
delete process.env.OBSERVOGRAM_AUTH;
delete process.env.TOMOGRAPH_AUTH;
// Hermetic store (docs/STORE_PLAN.md slice 2): each block's database lives
// in its own workspace.
for (const k of ['DB', 'BOOTSTRAP_ADMIN', 'OIDC_JOIN_ROLE', 'ADMIN_PASSWORD', 'INSECURE_NO_AUTH']) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

const { start } = await import('./index.mjs');
const { currentStore } = await import('./store/db.mjs');
const { getUserByLogin, listUsers, setDisabled } = await import('./store/users.mjs');
const { listMembershipsForUser } = await import('./store/memberships.mjs');
const { getMeta } = await import('./store/meta.mjs');
const { listAudit } = await import('./store/audit.mjs');
const { writeUsersFile, writeOrgsFile } = await import('./store/legacy-files.mjs');
const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
const base = `http://127.0.0.1:${srv.address().port}`;
process.env.OBSERVOGRAM_OIDC_REDIRECT_URL = `${base}/auth/callback`;

const cookieOf = (res, name) =>
  (res.headers.getSetCookie?.() || []).find(c => c.startsWith(`${name}=`))?.split(';')[0] || null;

// The three hops (login → IdP → callback) for an ID token carrying `claims`.
async function signIn(root, claims) {
  nextClaims = claims;
  try {
    const r = await fetch(`${root}/auth/login`, { redirect: 'manual' });
    const flow = cookieOf(r, 'observogram_flow');
    const hop = await fetch(new URL(r.headers.get('location')), { redirect: 'manual' });
    const cb = await fetch(new URL(hop.headers.get('location')), { redirect: 'manual', headers: { Cookie: flow } });
    const body = cb.status === 302 ? null : await cb.json();
    return { status: cb.status, session: cookieOf(cb, 'observogram_session'), body };
  } finally {
    nextClaims = DEFAULT_CLAIMS;
  }
}

// A session cookie in the pre-store payload shape ({ sub, email, name,
// iat, exp }), signed with the suite's session secret.
function preUpgradeCookie(payload) {
  const body = b64u(JSON.stringify({ iat: Date.now(), exp: Date.now() + 3600_000, ...payload }));
  const mac = createHmac('sha256', process.env.OBSERVOGRAM_SESSION_SECRET).update(body).digest('base64url');
  return `observogram_session=v1.${body}.${mac}`;
}

const KEY = `${issuer}/`;   // canonIssuer of the env value: the bare origin's slash
const loginOf = (sub) => `${KEY}#${sub}`;
const rolesOf = (db, user) => listMembershipsForUser(db, user.id).map(m => `${m.orgId}:${m.role}`);

try {
  // ---- unauthenticated ----
  let r = await fetch(`${base}/api/packs`);
  assert(r.status === 401, 'API requires sign-in in OIDC mode', r.status, 401);
  r = await fetch(`${base}/auth/me`);
  let j = await r.json();
  assert(j.mode === 'oidc' && j.authenticated === false, '/auth/me reports oidc mode');

  // ---- the full code + PKCE flow ----
  r = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  assert(r.status === 302, '/auth/login redirects to the IdP', r.status, 302);
  const authUrl = new URL(r.headers.get('location'));
  assert(authUrl.origin === issuer, 'redirect targets the configured issuer', authUrl.origin, issuer);
  assert(authUrl.searchParams.get('code_challenge_method') === 'S256', 'PKCE S256 challenge present');
  assert(!!authUrl.searchParams.get('state') && !!authUrl.searchParams.get('nonce'), 'state + nonce present');
  const flowCookie = cookieOf(r, 'observogram_flow');
  assert(!!flowCookie, 'flow cookie issued for the round trip');

  const idpHop = await fetch(authUrl, { redirect: 'manual' });
  assert(idpHop.status === 302, 'mock IdP issues the code');
  const cbUrl = new URL(idpHop.headers.get('location'));

  r = await fetch(cbUrl, { redirect: 'manual', headers: { Cookie: flowCookie } });
  assert(r.status === 302 && r.headers.get('location') === '/', 'callback exchanges the code and lands home', `${r.status} → ${r.headers.get('location')}`);
  const session = cookieOf(r, 'observogram_session');
  assert(!!session, 'session cookie issued after token validation (RS256 + nonce + aud verified by openid-client)');

  // ---- authenticated ----
  r = await fetch(`${base}/api/packs`, { headers: { Cookie: session } });
  assert(r.ok, 'API reads work with the OIDC session', r.status, 200);
  r = await fetch(`${base}/auth/me`, { headers: { Cookie: session } });
  j = await r.json();
  assert(j.authenticated === true && j.sub === 'user-42' && j.email === 'ada@example.test',
    '/auth/me carries the IdP claims', JSON.stringify(j));

  // ---- CSRF still applies to session mutations ----
  r = await fetch(`${base}/api/validate`, {
    method: 'POST', headers: { Cookie: session, 'Content-Type': 'text/yaml' }, body: 'x: 1',
  });
  assert(r.status === 403, 'OIDC session mutation without CSRF header → 403', r.status, 403);

  // ---- replaying the callback (stale flow) is rejected ----
  r = await fetch(cbUrl, { redirect: 'manual', headers: { Cookie: flowCookie } });
  assert(r.status === 401, 'replayed code rejected (single-use at the IdP)', r.status, 401);

  // ---- callback without a flow cookie is rejected ----
  r = await fetch(`${base}/auth/callback?code=zzz&state=zzz`, { redirect: 'manual' });
  assert(r.status === 400, 'callback without a login flow → 400', r.status, 400);

  // ---- the rows (the empty workspace's import set oidc_join_role = operator) ----
  const db = currentStore();
  const ada = getUserByLogin(db, loginOf('user-42'));
  assert(ada?.kind === 'oidc' && ada.sessionEpoch === 1 && ada.isOwner === false,
    `${loginOf('user-42')}: kind oidc, epoch 1, not an owner`, ada && { kind: ada.kind, ep: ada.sessionEpoch, owner: ada.isOwner });
  assert(JSON.stringify(rolesOf(db, ada)) === JSON.stringify(['default:operator']), 'user-42 joined default as operator', rolesOf(db, ada));
  const jit = listAudit(db, { action: 'user.jit', targetId: ada.login });
  const mjit = listAudit(db, { action: 'membership.jit', targetId: ada.login });
  assert(jit.length === 1 && mjit.length === 1 && jit[0].actor === 'system' && mjit[0].actor === 'system',
    'one user.jit and one membership.jit row, actor system', [jit.length, mjit.length]);
  assert(getMeta(db, 'oidc_issuer') === KEY && getMeta(db, 'oidc_join_role') === 'operator',
    'oidc_issuer records the key; oidc_join_role is operator', [getMeta(db, 'oidc_issuer'), getMeta(db, 'oidc_join_role')]);

  // ---- pre-upgrade cookies: rows on first sight, at epoch 0 ----
  for (const sub of ['user-50', 'user-51']) {
    r = await fetch(`${base}/api/packs`, { headers: { Cookie: preUpgradeCookie({ sub, email: `${sub}@example.test`, name: '  ' }) } });
    const row = getUserByLogin(db, loginOf(sub));
    assert(r.status === 200 && row?.sessionEpoch === 0 && JSON.stringify(rolesOf(db, row)) === JSON.stringify(['default:operator']),
      `a pre-upgrade cookie for never-seen ${sub} → 200, row at epoch 0, operator`, [r.status, row?.sessionEpoch]);
  }
  r = await fetch(`${base}/api/packs`, { headers: { Cookie: preUpgradeCookie({ sub: 'user-42', email: 'ada@example.test' }) } });
  assert(r.status === 401, 'a pre-upgrade cookie for user-42 (row at epoch 1) → 401', r.status, 401);

  // ---- a disabled row: 403 at the callback, no session cookie ----
  setDisabled(db, 'test', getUserByLogin(db, loginOf('user-51')).id, true);
  const off = await signIn(base, { sub: 'user-51', email: 'user-51@example.test' });
  assert(off.status === 403 && !off.session && /disabled/.test(off.body?.error || ''), 'a disabled OIDC row signs in → 403, no session cookie', [off.status, off.body]);

  // ---- OBSERVOGRAM_BOOTSTRAP_ADMIN by a verified email ----
  process.env.OBSERVOGRAM_BOOTSTRAP_ADMIN = 'boss@example.test';
  for (const [label, extra] of [['no email_verified', {}], ['email_verified false', { email_verified: false }], ['email_verified "true"', { email_verified: 'true' }]]) {
    const got = await signIn(base, { sub: 'boss', email: 'boss@example.test', name: 'Boss', ...extra });
    assert(got.status === 302 && getUserByLogin(db, loginOf('boss'))?.isOwner === false, `bootstrap by email, ${label} → signed in, not an owner`, got.status);
  }
  let got = await signIn(base, { sub: 'boss', email: 'Boss@Example.test', name: 'Boss', email_verified: true });
  const boss = getUserByLogin(db, loginOf('boss'));
  assert(got.status === 302 && boss.isOwner === true && rolesOf(db, boss).includes('default:admin'),
    'bootstrap by email, email_verified true → owner and admin of default', rolesOf(db, boss));
  assert(listAudit(db, { action: 'owner.bootstrap' }).length === 1, 'one owner.bootstrap row');
  process.env.OBSERVOGRAM_BOOTSTRAP_ADMIN = `${issuer}#user-42`;
  got = await signIn(base, DEFAULT_CLAIMS);
  assert(got.status === 302 && getUserByLogin(db, loginOf('user-42')).isOwner === false && listAudit(db, { action: 'owner.bootstrap' }).length === 1,
    'once an owner exists, a sub-form match grants nothing');
  delete process.env.OBSERVOGRAM_BOOTSTRAP_ADMIN;
} finally {
  delete process.env.OBSERVOGRAM_BOOTSTRAP_ADMIN;
  await new Promise(res => srv.close(res));
  rmSync(WORKSPACE, { recursive: true, force: true });
}

// A fresh workspace booted in-process; the redirect URL re-pointed at its server.
async function bootBlock(ws, { env = {} } = {}) {
  process.env.OBSERVOGRAM_WORKSPACE = ws;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const s = await start({ port: 0, host: '127.0.0.1', silent: true });
  for (const k of Object.keys(env)) delete process.env[k];
  const root = `http://127.0.0.1:${s.address().port}`;
  process.env.OBSERVOGRAM_OIDC_REDIRECT_URL = `${root}/auth/callback`;
  return { srv: s, root };
}

// ---- block 2: a user who signed in before the variable was set ----
{
  const WS = mkdtempSync(join(tmpdir(), 'observogram-auth-oidc-b2-'));
  const { srv: s, root } = await bootBlock(WS);
  try {
    let got = await signIn(root, { sub: 'user-60', email: 'u60@example.test' });
    assert(got.status === 302 && getUserByLogin(currentStore(), loginOf('user-60'))?.isOwner === false, 'user-60 signs in: not an owner');
    // The sub form in another spelling of the same issuer (the env has no slash).
    process.env.OBSERVOGRAM_BOOTSTRAP_ADMIN = `${issuer}/.well-known/openid-configuration#user-60`;
    got = await signIn(root, { sub: 'user-60', email: 'u60@example.test' });
    assert(got.status === 302 && getUserByLogin(currentStore(), loginOf('user-60'))?.isOwner === true,
      'the next sign-in grants owner (the bootstrap spelled with the well-known suffix)');
    assert(listAudit(currentStore(), { action: 'owner.bootstrap' }).length === 1, 'one owner.bootstrap row');
  } finally {
    delete process.env.OBSERVOGRAM_BOOTSTRAP_ADMIN;
    await new Promise(res => s.close(res));
    rmSync(WS, { recursive: true, force: true });
  }
}

// ---- block 3: OBSERVOGRAM_OIDC_JOIN_ROLE=none keeps the deployment closed ----
{
  const WS = mkdtempSync(join(tmpdir(), 'observogram-auth-oidc-b3-'));
  const { srv: s, root } = await bootBlock(WS, { env: { OBSERVOGRAM_OIDC_JOIN_ROLE: 'none' } });
  try {
    const got = await signIn(root, { sub: 'user-70' });
    let r = await fetch(`${root}/api/packs`, { headers: { Cookie: got.session } });
    const j = await r.json();
    assert(r.status === 403 && /ask an admin/.test(j.error || ''), 'no join role: /api/packs 403 "ask an admin"', [r.status, j.error]);
    r = await fetch(`${root}/auth/me`, { headers: { Cookie: got.session } });
    const me = await r.json();
    assert(me.authenticated === true && Array.isArray(me.orgs) && me.orgs.length === 0, 'no join role: /auth/me orgs []', me.orgs);
  } finally {
    await new Promise(res => s.close(res));
    rmSync(WS, { recursive: true, force: true });
  }
}

// ---- block 4: an orgs.json member keeps its role across two spellings of the issuer ----
{
  const WS = mkdtempSync(join(tmpdir(), 'observogram-auth-oidc-b4-'));
  writeOrgsFile({ acme: { name: 'Acme', members: { 'user-42': 'viewer', alice: 'admin' } } }, join(WS, 'orgs.json'));
  writeUsersFile({ users: { alice: { createdAt: 'test', password: { algo: 'scrypt', N: 16384, r: 8, p: 1, salt: 'AA==', hash: 'AA==' } } } }, join(WS, 'users.json'));
  let booted = await bootBlock(WS);
  try {
    const db = currentStore();
    const local = getUserByLogin(db, 'alice');
    const oidcAlice = getUserByLogin(db, loginOf('alice'));
    assert(local?.kind === 'local' && local.disabled === true && local.isOwner === false, 'boot 1: the users.json alice is imported disabled, not an owner');
    assert(oidcAlice?.kind === 'oidc' && oidcAlice.isOwner === true && JSON.stringify(rolesOf(db, oidcAlice)) === JSON.stringify(['acme:admin']),
      'boot 1: the OIDC alice is an owner and admin of acme', oidcAlice && rolesOf(db, oidcAlice));
  } finally {
    await new Promise(res => booted.srv.close(res));
  }
  // Boot 2 of the same workspace with the issuer spelled with a trailing slash.
  process.env.OBSERVOGRAM_OIDC_ISSUER = `${issuer}/`;
  let refused = null;
  try { booted = await bootBlock(WS); } catch (e) { refused = e; }
  assert(refused === null, 'boot 2 with the other spelling does not refuse at step 2 (b)', refused?.message);
  try {
    let r = await fetch(`${booted.root}/api/orgs`, { headers: { Cookie: preUpgradeCookie({ sub: 'user-42' }) } });
    const j = await r.json();
    assert(r.status === 200 && JSON.stringify(j.orgs) === JSON.stringify([{ id: 'acme', name: 'Acme', role: 'viewer' }]),
      "boot 2: user-42's pre-upgrade cookie → /api/orgs [acme, viewer]", j.orgs);
    const got = await signIn(booted.root, DEFAULT_CLAIMS);
    assert(got.status === 302 && listUsers(currentStore()).filter(u => u.sub === 'user-42').length === 1,
      'boot 2: a fresh sign-in reuses the single user-42 row (no duplicate login)', got.status);
    r = await fetch(`${booted.root}/api/packs`, { headers: { Cookie: got.session } });
    assert(r.status === 200 && r.headers.get('x-observogram-org') === 'acme', 'boot 2: the signed-in user-42 lands in acme', r.status, 200);
  } finally {
    process.env.OBSERVOGRAM_OIDC_ISSUER = issuer;
    if (booted?.srv) await new Promise(res => booted.srv.close(res));
    rmSync(WS, { recursive: true, force: true });
  }
}

await new Promise(res => idp.close(res));

report('auth-oidc');
