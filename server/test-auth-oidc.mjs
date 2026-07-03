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
import { createHash, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
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
        iss: issuer, aud: CLIENT_ID, sub: 'user-42',
        email: 'ada@example.test', name: 'Ada Test',
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

const { start } = await import('./index.mjs');
const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
const base = `http://127.0.0.1:${srv.address().port}`;
process.env.OBSERVOGRAM_OIDC_REDIRECT_URL = `${base}/auth/callback`;

const cookieOf = (res, name) =>
  (res.headers.getSetCookie?.() || []).find(c => c.startsWith(`${name}=`))?.split(';')[0] || null;

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
} finally {
  await new Promise(res => srv.close(res));
  await new Promise(res => idp.close(res));
  rmSync(WORKSPACE, { recursive: true, force: true });
}

report('auth-oidc');
