// server/repo-sign-in.mjs — a person signs in to GitHub or Azure DevOps, so
// their repositories read as them without anyone pasting a token.
//
// The host's own web sign-in (OAuth 2.0 authorization code with PKCE), from
// the person's browser:
//   GET  /auth/repo/:kind/start      → the host's sign-in page
//   GET  /auth/repo/:kind/callback   ← the host sends the person back with a
//                                      code, which the server trades for the
//                                      person's access token
//   POST /auth/repo/:kind/sign-out   the person signs out of that host here
// The server keeps nothing. The token goes back to the person's own browser
// sealed (AES-256-GCM under a key derived from the session secret) in an
// HttpOnly cookie that page script cannot read, bound to their login and
// session epoch. A Run reads it from that cookie for that one read
// (server/repo-auth.mjs repositoryCredential). It ends at the host token's
// own expiry or the session's, whichever is first; when the person signs out
// of the host or of Observogram; and with every change of their session epoch
// (a password change, a disable, "sign out my other sessions"). No refresh
// token is asked for or kept: once it ends, the person signs in again.
//
// Configured per host (a host with no client id offers no sign-in):
//   GitHub — an OAuth App, or a GitHub App's user sign-in
//     OBSERVOGRAM_GITHUB_CLIENT_ID, OBSERVOGRAM_GITHUB_CLIENT_SECRET   both
//     OBSERVOGRAM_GITHUB_SCOPE    default 'repo': an OAuth App's only scope
//                                 that reads private repositories. A GitHub
//                                 App ignores it; its own permissions decide
//                                 (Contents: read), on the repositories it is
//                                 installed on.
//   Azure DevOps — a Microsoft Entra ID app registration with the Azure
//   DevOps delegated permission
//     OBSERVOGRAM_ADO_CLIENT_ID; OBSERVOGRAM_ADO_CLIENT_SECRET (optional: a
//     public client); OBSERVOGRAM_ADO_TENANT (default 'organizations')
//     Unset while Observogram's own sign-in is Entra ID
//     (OBSERVOGRAM_OIDC_ISSUER https://login.microsoftonline.com/<tenant>/v2.0):
//     that app registration and tenant.
// The host sends the person back to <studio>/auth/repo/<kind>/callback, the
// address each app registration must allow. <studio> is OBSERVOGRAM_PUBLIC_URL
// when set, else the origin of OBSERVOGRAM_OIDC_REDIRECT_URL, else the
// request's own (http behind a TLS proxy: set OBSERVOGRAM_PUBLIC_URL there).

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { brandEnvFrom } from '../tools/lib/brand-env.mjs';
import { escapeHtml } from '../tools/lib/brand.mjs';
import {
  AUTH_PAGE_STYLE, appendCookie, authEnabled, authPageChrome, derivedKey, dropCookie, requestCookies, signPurpose, verifyPurpose,
} from './auth.mjs';
import { ghFetch } from './github-crawl.mjs';

export const REPO_SIGN_IN_KINDS = Object.freeze(['github', 'ado']);
export const HOST_NAME = Object.freeze({ github: 'GitHub', ado: 'Azure DevOps' });

// Azure DevOps' own resource, and its delegated permission to read code.
export const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
export const ADO_SCOPE = `${ADO_RESOURCE}/vso.code`;
const ENTRA = 'https://login.microsoftonline.com';
const ENTRA_ISSUER = /^https:\/\/login\.microsoftonline\.com\/([A-Za-z0-9.-]{1,100})\/v2\.0\/?$/;
const TENANT = /^[A-Za-z0-9.-]{1,100}$/;

const FLOW_TTL_S = 600;
const LINK_INFO = 'observogram repository sign-in v1';
// A cookie holds at most ~4 KB: a longer sealed token (an Entra ID access
// token can be 2–3 KB) is split over up to four.
const CHUNK = 3800;
const MAX_PARTS = 4;
// A link with no expiry of its own (an OAuth App's GitHub token) behind a
// reverse proxy, where the session has none to borrow.
const LINK_TTL_CAP_MS = 12 * 3600_000;
const HOST_TIMEOUT_MS = 15_000;

const cookieName = (kind) => `observogram_repo_${kind}`;
const flowName = (kind) => `observogram_repoflow_${kind}`;
const partName = (kind, i) => `${cookieName(kind)}_${i}`;

// ---------- configuration ----------

// repoSignInConfig(kind, { env }) → the host's sign-in, or null when it offers none.
export function repoSignInConfig(kind, { env = process.env } = {}) {
  const read = (suffix) => brandEnvFrom(env, suffix);
  if (kind === 'github') {
    const clientId = read('GITHUB_CLIENT_ID');
    const clientSecret = read('GITHUB_CLIENT_SECRET');
    if (!clientId || !clientSecret) return null;
    return {
      kind, clientId, clientSecret, scope: read('GITHUB_SCOPE') || 'repo',
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
    };
  }
  if (kind === 'ado') {
    let clientId = read('ADO_CLIENT_ID');
    let clientSecret = read('ADO_CLIENT_SECRET');
    let tenant = read('ADO_TENANT');
    if (!clientId) {
      // Observogram's own sign-in is Entra ID: its registration and tenant.
      const m = ENTRA_ISSUER.exec(read('OIDC_ISSUER'));
      if (!m || !read('OIDC_CLIENT_ID')) return null;
      clientId = read('OIDC_CLIENT_ID');
      clientSecret = read('OIDC_CLIENT_SECRET');
      tenant = tenant || m[1];
    }
    tenant = tenant || 'organizations';
    if (!TENANT.test(tenant)) return null;
    return {
      kind, clientId, clientSecret: clientSecret || null, scope: ADO_SCOPE, tenant,
      authorizeUrl: `${ENTRA}/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `${ENTRA}/${tenant}/oauth2/v2.0/token`,
    };
  }
  return null;
}

// Where the host sends the person back to.
export function callbackUrl(req, kind, { env = process.env } = {}) {
  const fixed = brandEnvFrom(env, 'PUBLIC_URL') || brandEnvFrom(env, 'OIDC_REDIRECT_URL');
  let origin = null;
  if (fixed) { try { origin = new URL(fixed).origin; } catch { origin = null; } }
  if (!origin) origin = `${req.protocol}://${req.get('host')}`;
  return `${origin}/auth/repo/${kind}/callback`;
}

// The page the person returns to: a path on this server, never another site.
export function safeReturn(value) {
  const s = typeof value === 'string' ? value : '';
  const control = [...s].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || s.length > 500 || control) return '/';
  return s;
}

// ---------- the sealed cookie ----------

function seal(kind, payload) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', derivedKey(LINK_INFO), iv);
  c.setAAD(Buffer.from(cookieName(kind)));
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final(), c.getAuthTag()]);
  return `v1.${iv.toString('base64url')}.${ct.toString('base64url')}`;
}

function unseal(kind, value) {
  const m = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{24,})$/.exec(String(value || ''));
  if (!m) return null;
  try {
    const iv = Buffer.from(m[1], 'base64url');
    const all = Buffer.from(m[2], 'base64url');
    if (iv.length !== 12 || all.length < 17) return null;
    const d = createDecipheriv('aes-256-gcm', derivedKey(LINK_INFO), iv);
    d.setAAD(Buffer.from(cookieName(kind)));
    d.setAuthTag(all.subarray(all.length - 16));
    const text = Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString('utf8');
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' ? obj : null;
  } catch { return null; }
}

// The sealed value as the cookies carry it: one, or `<n>*<part 0>` and parts 1…n-1.
function sealedFrom(cookies, kind) {
  const first = cookies[cookieName(kind)];
  if (!first) return null;
  const m = /^([2-4])\*(.+)$/.exec(first);
  if (!m) return first;
  let out = m[2];
  for (let i = 1; i < Number(m[1]); i++) {
    const part = cookies[partName(kind, i)];
    if (!part) return null;
    out += part;
  }
  return out;
}

function writeLink(res, kind, payload) {
  const sealed = seal(kind, payload);
  const parts = [];
  for (let i = 0; i < sealed.length; i += CHUNK) parts.push(sealed.slice(i, i + CHUNK));
  if (parts.length > MAX_PARTS) return false;
  const maxAge = Math.max(1, Math.floor((payload.exp - Date.now()) / 1000));
  appendCookie(res, cookieName(kind), parts.length === 1 ? parts[0] : `${parts.length}*${parts[0]}`, maxAge);
  for (let i = 1; i < MAX_PARTS; i++) {
    if (i < parts.length) appendCookie(res, partName(kind, i), parts[i], maxAge);
    else dropCookie(res, partName(kind, i));
  }
  return true;
}

export function clearRepoLink(res, kind) {
  dropCookie(res, cookieName(kind));
  for (let i = 1; i < MAX_PARTS; i++) dropCookie(res, partName(kind, i));
}

// Every host's, at sign-out of Observogram.
export function clearRepoLinks(res) {
  for (const kind of REPO_SIGN_IN_KINDS) clearRepoLink(res, kind);
}

// readRepoLink(req, kind, user) → { token, account, scheme, exp } — the
// person's sign-in to that host in this browser, or null. `user` is the
// signed-in store row (the gate's req.observogramUser): a link sealed for
// another login, or at another session epoch, is no one's.
export function readRepoLink(req, kind, user = req?.observogramUser) {
  if (!REPO_SIGN_IN_KINDS.includes(kind) || !user || typeof user.login !== 'string') return null;
  const sealed = sealedFrom(requestCookies(req), kind);
  const p = sealed ? unseal(kind, sealed) : null;
  if (!p || p.purpose !== 'repo-link' || p.kind !== kind) return null;
  if (p.login !== user.login || p.ep !== user.sessionEpoch) return null;
  if (typeof p.exp !== 'number' || Date.now() >= p.exp) return null;
  if (typeof p.token !== 'string' || !p.token) return null;
  return { token: p.token, account: typeof p.account === 'string' ? p.account : null, scheme: kind === 'ado' ? 'bearer' : 'token', exp: p.exp };
}

// What /auth/me says: per host, whether it offers sign-in here, and the
// account this browser is signed in to it as. Never the token.
export function repoSignInStatus(req, user) {
  const out = {};
  for (const kind of REPO_SIGN_IN_KINDS) {
    const available = !!repoSignInConfig(kind);
    const link = available ? readRepoLink(req, kind, user) : null;
    out[kind] = { available, signedIn: !!link, account: link?.account ?? null, expiresAt: link ? new Date(link.exp).toISOString() : null };
  }
  return out;
}

// ---------- the host's answers ----------

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function sameText(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// A host's own words, short and on one line, for a page that quotes them.
const hostWords = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

// The code → the person's token: { token, expiresInS } or throws with the host's words.
export async function exchangeCode(config, { code, verifier, redirectUri }) {
  const form = new URLSearchParams({ client_id: config.clientId, code, redirect_uri: redirectUri, code_verifier: verifier });
  if (config.clientSecret) form.set('client_secret', config.clientSecret);
  if (config.kind === 'ado') { form.set('grant_type', 'authorization_code'); form.set('scope', config.scope); }
  let res;
  try {
    res = await fetch(config.tokenUrl, {
      method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'observogram' },
    });
  } catch (e) { throw new Error(`${HOST_NAME[config.kind]} did not answer (${e?.name === 'TimeoutError' ? 'timed out' : 'unreachable'})`, { cause: e }); }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error || typeof body.access_token !== 'string' || !body.access_token) {
    const why = hostWords(body?.error_description || body?.error || `answered ${res.status}`);
    throw new Error(`${HOST_NAME[config.kind]} refused the sign-in: ${why}`);
  }
  const expiresInS = Number(body.expires_in);
  return { token: body.access_token, expiresInS: Number.isFinite(expiresInS) && expiresInS > 0 ? expiresInS : null };
}

// The account the token belongs to, to name it on screen: GitHub's login
// (GET /user), or the Entra ID token's own user name. Null when not known.
export async function accountOf(kind, token) {
  if (kind === 'github') {
    try {
      const res = await ghFetch('/user', { signal: AbortSignal.timeout(HOST_TIMEOUT_MS) }, { token });
      if (!res.ok) return null;
      const who = await res.json();
      return typeof who?.login === 'string' ? hostWords(who.login) || null : null;
    } catch { return null; }
  }
  try {
    const claims = JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString('utf8'));
    const name = claims?.upn || claims?.unique_name || claims?.preferred_username || claims?.email;
    return typeof name === 'string' ? hostWords(name) || null : null;
  } catch { return null; }
}

// GitHub's grant ended at sign-out, best effort: a token nobody holds any more.
async function revokeGithub(config, token) {
  try {
    await fetch(`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token`, {
      method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
      headers: {
        Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'observogram',
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      },
      body: JSON.stringify({ access_token: token }),
    });
  } catch { /* the cookie is gone either way */ }
}

// ---------- the page the host sends the person back to ----------

// Opened as a window of the studio (`popup`: the id the studio gave this
// sign-in), it tells the studio over a same-origin BroadcastChannel, and
// closes only when the tab that started this sign-in answers for it. When
// none does (a browser that opened the window in the studio's own tab), a
// sign-in that worked goes back to the page it started from, as it does when
// the studio's tab went through the sign-in itself (no `popup`: a redirect).
export const POPUP_ID = /^[A-Za-z0-9_-]{1,32}$/;
export function signInPageHtml({ kind, ok, message, ret = '/', popup = null }, c = authPageChrome()) {
  const host = HOST_NAME[kind] || 'the repository host';
  const rid = typeof popup === 'string' && POPUP_ID.test(popup) ? popup : null;
  const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  const note = json({ type: 'observogram-repo-sign-in', kind: REPO_SIGN_IN_KINDS.includes(kind) ? kind : null, ok: !!ok, rid });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(ok ? `Signed in to ${host}` : `${host} sign-in did not finish`)}</title>
${AUTH_PAGE_STYLE}</head><body>
<form>
  <h1>${c.wordmarkHtml('i')}</h1><p>${escapeHtml(ok ? `Signed in to ${host}` : `${host} sign-in did not finish`)}</p>
  ${ok ? '' : `<div class="err">${escapeHtml(message)}</div>`}
  <p>${ok ? escapeHtml(message) + ' ' : ''}${rid ? 'You can close this window.' : ''}</p>
  <a class="skip" href="${escapeHtml(safeReturn(ret))}">Back to ${escapeHtml(c.name || 'Observogram')}</a>
</form>${rid ? `
<script>
(function () {
  var note = ${note};
  var back = ${json(safeReturn(ret))};
  var ch = null;
  try { ch = new BroadcastChannel('observogram-repo-sign-in'); } catch (e) { ch = null; }
  if (!ch) { try { if (window.opener) window.opener.postMessage(note, location.origin); } catch (e) {} return; }
  var answered = false;
  ch.onmessage = function (ev) {
    var d = ev.data || {};
    if (d.type === 'observogram-repo-sign-in-ack' && d.rid === note.rid) { answered = true; ch.close(); window.close(); }
  };
  ch.postMessage(note);
  if (note.ok) setTimeout(function () { if (!answered) { ch.close(); location.replace(back); } }, 1500);
})();
</script>` : ''}
</body></html>`;
}

function page(res, status, args) {
  res.status(status).set('Cache-Control', 'no-store').type('html').send(signInPageHtml(args));
}

// ---------- routes ----------

// Registered with the sign-in routes (server/auth.mjs registerShared), in
// every mode that has a sign-in; every one is a self route (the caller's
// own session, server/authz.mjs selfGate).
export function initRepoSignIn(app, authorize) {
  app.get('/auth/repo/:kind/start', authorize('GET /auth/repo/:kind/start'), (req, res) => {
    const kind = req.params.kind;
    const config = REPO_SIGN_IN_KINDS.includes(kind) ? repoSignInConfig(kind) : null;
    if (!config) return res.status(404).json({ ok: false, error: `signing in to ${HOST_NAME[kind] || 'that host'} is not set up on this server` });
    const { user } = req.observogramSelf;
    const state = randomBytes(24).toString('base64url');
    const { verifier, challenge } = pkcePair();
    const popup = typeof req.query.popup === 'string' && POPUP_ID.test(req.query.popup) ? req.query.popup : null;
    const ret = safeReturn(req.query.return);
    appendCookie(res, flowName(kind), signPurpose('repo-flow', {
      kind, state, verifier, login: user.login, ep: user.sessionEpoch, ret, popup, exp: Date.now() + FLOW_TTL_S * 1000,
    }), FLOW_TTL_S);
    const url = new URL(config.authorizeUrl);
    const q = { client_id: config.clientId, redirect_uri: callbackUrl(req, kind), scope: config.scope, state, code_challenge: challenge, code_challenge_method: 'S256' };
    if (kind === 'github') q.allow_signup = 'false';
    else { q.response_type = 'code'; q.response_mode = 'query'; }
    for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
    res.set('Cache-Control', 'no-store').redirect(url.href);
  });

  app.get('/auth/repo/:kind/callback', authorize('GET /auth/repo/:kind/callback'), async (req, res) => {
    const kind = req.params.kind;
    const config = REPO_SIGN_IN_KINDS.includes(kind) ? repoSignInConfig(kind) : null;
    if (!config) return res.status(404).json({ ok: false, error: `signing in to ${HOST_NAME[kind] || 'that host'} is not set up on this server` });
    const flow = verifyPurpose('repo-flow', requestCookies(req)[flowName(kind)]);
    dropCookie(res, flowName(kind));
    const { user, session } = req.observogramSelf;
    const host = HOST_NAME[kind];
    if (!flow || flow.kind !== kind || flow.login !== user.login || flow.ep !== user.sessionEpoch) {
      return page(res, 400, { kind, ok: false, message: `This sign-in to ${host} expired or was started somewhere else. Start it again from Observogram.` });
    }
    const back = { kind, ret: flow.ret, popup: typeof flow.popup === 'string' && POPUP_ID.test(flow.popup) ? flow.popup : null };
    if (typeof req.query.error === 'string') {
      return page(res, 400, { ...back, ok: false, message: `${host} did not sign you in: ${hostWords(req.query.error_description || req.query.error)}` });
    }
    if (!sameText(req.query.state, flow.state) || typeof req.query.code !== 'string' || !req.query.code) {
      return page(res, 400, { ...back, ok: false, message: `This answer from ${host} does not belong to the sign-in you started. Start it again from Observogram.` });
    }
    let got;
    try { got = await exchangeCode(config, { code: req.query.code, verifier: flow.verifier, redirectUri: callbackUrl(req, kind) }); }
    catch (e) {
      process.stderr.write(`[repo-sign-in] ${kind}: ${e.message}\n`);
      return page(res, 502, { ...back, ok: false, message: e.message });
    }
    const account = await accountOf(kind, got.token);
    const now = Date.now();
    const ends = [session?.exp, got.expiresInS ? now + got.expiresInS * 1000 : null, now + LINK_TTL_CAP_MS].filter((t) => Number.isFinite(t) && t > now);
    const exp = Math.min(...ends);
    const kept = writeLink(res, kind, { purpose: 'repo-link', kind, login: user.login, ep: user.sessionEpoch, token: got.token, account, exp });
    if (!kept) return page(res, 502, { ...back, ok: false, message: `${host}'s token is too large for this browser to keep. Give your own token on the row instead.` });
    process.stderr.write(`[repo-sign-in] ${user.login} signed in to ${host}${account ? ` as ${account}` : ''}\n`);
    if (!back.popup) return res.set('Cache-Control', 'no-store').redirect(safeReturn(flow.ret));
    return page(res, 200, { ...back, ok: true, message: `Your ${host} repositories now read as ${account || 'you'} in Observogram, until you sign out or the session ends.` });
  });

  app.post('/auth/repo/:kind/sign-out', authorize('POST /auth/repo/:kind/sign-out'), async (req, res) => {
    const kind = req.params.kind;
    if (!REPO_SIGN_IN_KINDS.includes(kind)) return res.status(404).json({ ok: false, error: 'no such repository host' });
    const link = readRepoLink(req, kind, req.observogramSelf.user);
    clearRepoLink(res, kind);
    const config = repoSignInConfig(kind);
    if (link && kind === 'github' && config) await revokeGithub(config, link.token);
    res.json({ ok: true, signedOut: kind });
  });
}

// For the routes that read a repository: whether sign-in is a way to the fix.
export function repoSignInOffered(kind) {
  try { return authEnabled() && !!repoSignInConfig(kind); } catch { return false; }
}
